import type { Express, Request } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import { buildMlbP1M3dEconomicReview } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3e5LiveFrozenEnvelope,
  MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED,
  type MlbP1M3e5Report,
} from "./mlb-p1-operating-envelope-frozen-live";
import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";
import { getRequestIdentity } from "./user-data-context";

export const MLB_P1_M3E5_ENDPOINT = "/api/mlb/p1/v1/operating-envelope-frozen" as const;
export const MLB_P1_M3E5_SCIENTIFIC_INTEGRITY_FAILURE = "P1_M3E5_SCIENTIFIC_INTEGRITY_FAILURE" as const;

interface MlbP1FrozenOperatingEnvelopeReader {
  review(userId: number): MlbP1M3e5Report;
}

function authenticatedIdentity(req: Request) {
  const session = (req as Request & { session?: Record<string, unknown> }).session;
  if (session?.courtEdgeAuthenticated !== true) return null;
  return getRequestIdentity(req);
}

function scientificIntegrityFailure(error: Error): boolean {
  return error.message === MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED
    || error.message === "P1_M3E5_INVALID_SOURCE_SUMMARY"
    || error.message.startsWith("P1_M3E3_")
    || error.message.startsWith("P1_M3E4_");
}

export function createCompleteOwnedFrozenOperatingEnvelopeReader(): MlbP1FrozenOperatingEnvelopeReader {
  const store = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  return {
    review(userId: number): MlbP1M3e5Report {
      const records = ownershipStore.listPredictionIds(userId).flatMap((predictionId) => {
        const record = store.getRecord(predictionId);
        return record ? [record] : [];
      });
      const economicReview = buildMlbP1M3dEconomicReview(records);
      return buildMlbP1M3e5LiveFrozenEnvelope(economicReview.rows, {
        ownedLedgerRecords: economicReview.sample.ownedLedgerRecords,
        uniqueAnalyticalDecisions: economicReview.sample.uniqueAnalyticalDecisions,
      });
    },
  };
}

export function registerMlbP1FrozenOperatingEnvelopeRoutes(
  app: Express,
  service: MlbP1FrozenOperatingEnvelopeReader = createCompleteOwnedFrozenOperatingEnvelopeReader(),
): void {
  app.get(
    MLB_P1_M3E5_ENDPOINT,
    requireInteractiveMlbCaptureSession,
    (req, res) => {
      const identity = authenticatedIdentity(req);
      if (!identity) {
        return res.status(401).json({
          success: false,
          error: "Authenticated user session required for frozen MLB operating-envelope review.",
          code: "INTERACTIVE_SESSION_REQUIRED",
        });
      }

      try {
        const data = service.review(identity.id);
        return res.status(200).json({
          success: true,
          data,
          endpoint: MLB_P1_M3E5_ENDPOINT,
        });
      } catch (error: unknown) {
        if (error instanceof Error && scientificIntegrityFailure(error)) {
          return res.status(409).json({
            success: false,
            error: "Frozen operating-envelope integrity checks failed closed; no research conclusion is available.",
            code: error.message === MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED
              ? MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED
              : MLB_P1_M3E5_SCIENTIFIC_INTEGRITY_FAILURE,
          });
        }
        console.error("P1-M3E.5 frozen MLB operating-envelope review error:", error);
        return res.status(500).json({
          success: false,
          error: "Unable to build the frozen MLB operating-envelope review.",
          code: "P1_M3E5_INTERNAL_ERROR",
        });
      }
    },
  );
}
