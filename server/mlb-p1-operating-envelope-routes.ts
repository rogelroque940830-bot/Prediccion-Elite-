import type { Express, Request } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import { buildMlbP1M3dEconomicReview } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3eOperatingEnvelope,
  type MlbP1M3eReport,
} from "./mlb-p1-operating-envelope";
import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";
import { getRequestIdentity } from "./user-data-context";

export const MLB_P1_M3E_ENDPOINT = "/api/mlb/p1/v1/operating-envelope" as const;
export const MLB_P1_M3E_SOURCE_WINDOW_TRUNCATED = "P1_M3E_SOURCE_WINDOW_TRUNCATED" as const;

interface MlbP1OperatingEnvelopeReader {
  review(userId: number): MlbP1M3eReport;
}

function authenticatedIdentity(req: Request) {
  const session = (req as Request & { session?: Record<string, unknown> }).session;
  if (session?.courtEdgeAuthenticated !== true) return null;
  return getRequestIdentity(req);
}

export function createCompleteOwnedOperatingEnvelopeReader(): MlbP1OperatingEnvelopeReader {
  const store = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  return {
    review(userId: number): MlbP1M3eReport {
      const records = ownershipStore.listPredictionIds(userId).flatMap((predictionId) => {
        const record = store.getRecord(predictionId);
        return record ? [record] : [];
      });
      const economicReview = buildMlbP1M3dEconomicReview(records);
      if (economicReview.sample.uniqueAnalyticalDecisions > economicReview.rows.length) {
        throw new Error(MLB_P1_M3E_SOURCE_WINDOW_TRUNCATED);
      }
      return buildMlbP1M3eOperatingEnvelope(economicReview.rows);
    },
  };
}

export function registerMlbP1OperatingEnvelopeRoutes(
  app: Express,
  service: MlbP1OperatingEnvelopeReader = createCompleteOwnedOperatingEnvelopeReader(),
): void {
  app.get(
    "/api/mlb/p1/v1/operating-envelope",
    requireInteractiveMlbCaptureSession,
    (req, res) => {
      const identity = authenticatedIdentity(req);
      if (!identity) {
        return res.status(401).json({
          success: false,
          error: "Authenticated user session required for MLB operating-envelope review.",
          code: "INTERACTIVE_SESSION_REQUIRED",
        });
      }

      try {
        const data = service.review(identity.id);
        return res.status(200).json({
          success: true,
          data,
          endpoint: MLB_P1_M3E_ENDPOINT,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === MLB_P1_M3E_SOURCE_WINDOW_TRUNCATED) {
          return res.status(409).json({
            success: false,
            error: "The upstream economic-review row window is truncated; refusing to infer an operating envelope from an incomplete cohort.",
            code: MLB_P1_M3E_SOURCE_WINDOW_TRUNCATED,
          });
        }
        console.error("P1-M3E MLB operating-envelope review error:", error);
        return res.status(500).json({
          success: false,
          error: "Unable to build the MLB operating-envelope review.",
          code: "P1_M3E_INTERNAL_ERROR",
        });
      }
    },
  );
}
