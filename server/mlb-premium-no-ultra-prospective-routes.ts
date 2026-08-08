import type { Express, Request } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import { buildMlbP1M3dEconomicReview } from "./mlb-p1-economic-review";
import {
  buildMlbPremiumNoUltraProspective,
  type MlbPremiumNoUltraReport,
} from "./mlb-premium-no-ultra-prospective";
import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";
import { getRequestIdentity } from "./user-data-context";

export const MLB_PREMIUM_NO_ULTRA_ENDPOINT = "/api/mlb/p1/v1/premium-no-ultra-prospective" as const;
export const MLB_PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED = "PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED" as const;

export interface MlbPremiumNoUltraReader {
  review(userId: number): MlbPremiumNoUltraReport;
}

function authenticatedIdentity(req: Request) {
  const session = (req as Request & { session?: Record<string, unknown> }).session;
  if (session?.courtEdgeAuthenticated !== true) return null;
  return getRequestIdentity(req);
}

export function createCompleteOwnedPremiumNoUltraReader(): MlbPremiumNoUltraReader {
  const store = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  return {
    review(userId: number): MlbPremiumNoUltraReport {
      const records = ownershipStore.listPredictionIds(userId).flatMap((predictionId) => {
        const record = store.getRecord(predictionId);
        return record ? [record] : [];
      });
      const economicReview = buildMlbP1M3dEconomicReview(records);
      if (economicReview.sample.uniqueAnalyticalDecisions > economicReview.rows.length) {
        throw new Error(MLB_PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED);
      }
      return buildMlbPremiumNoUltraProspective(economicReview.rows, records);
    },
  };
}

export function registerMlbPremiumNoUltraProspectiveRoutes(
  app: Express,
  service: MlbPremiumNoUltraReader = createCompleteOwnedPremiumNoUltraReader(),
): void {
  app.get(
    "/api/mlb/p1/v1/premium-no-ultra-prospective",
    requireInteractiveMlbCaptureSession,
    (req, res) => {
      const identity = authenticatedIdentity(req);
      if (!identity) {
        return res.status(401).json({
          success: false,
          error: "Authenticated user session required for PREMIUM no-ULTRA prospective review.",
          code: "INTERACTIVE_SESSION_REQUIRED",
        });
      }

      try {
        const data = service.review(identity.id);
        return res.status(200).json({
          success: true,
          data,
          endpoint: MLB_PREMIUM_NO_ULTRA_ENDPOINT,
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === MLB_PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED) {
          return res.status(409).json({
            success: false,
            error: "The upstream economic-review row window is truncated; refusing to evaluate the prospective hypothesis from an incomplete cohort.",
            code: MLB_PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED,
          });
        }
        console.error("PREMIUM no-ULTRA prospective review error:", error);
        return res.status(500).json({
          success: false,
          error: "Unable to build the PREMIUM no-ULTRA prospective review.",
          code: "PREMIUM_NO_ULTRA_INTERNAL_ERROR",
        });
      }
    },
  );
}
