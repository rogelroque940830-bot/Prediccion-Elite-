import type { Express, Request } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import {
  MLB_P1_M3D_ENDPOINT,
  buildMlbP1M3dEconomicReview,
  type MlbP1M3dReport,
} from "./mlb-p1-economic-review";
import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";
import { getRequestIdentity } from "./user-data-context";

interface MlbP1EconomicReviewReader {
  review(userId: number): MlbP1M3dReport;
}

function authenticatedIdentity(req: Request) {
  const session = (req as Request & { session?: Record<string, unknown> }).session;
  if (session?.courtEdgeAuthenticated !== true) return null;
  return getRequestIdentity(req);
}

function createCompleteOwnedReviewReader(): MlbP1EconomicReviewReader {
  const store = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  return {
    review(userId: number): MlbP1M3dReport {
      const records = ownershipStore.listPredictionIds(userId).flatMap((predictionId) => {
        const record = store.getRecord(predictionId);
        return record ? [record] : [];
      });
      return buildMlbP1M3dEconomicReview(records);
    },
  };
}

export function registerMlbP1EconomicReviewRoutes(
  app: Express,
  service: MlbP1EconomicReviewReader = createCompleteOwnedReviewReader(),
): void {
  app.get(
    "/api/mlb/p1/v1/economic-review",
    requireInteractiveMlbCaptureSession,
    (req, res) => {
      const identity = authenticatedIdentity(req);
      if (!identity) {
        return res.status(401).json({
          success: false,
          error: "Authenticated user session required for interactive MLB economic review.",
          code: "INTERACTIVE_SESSION_REQUIRED",
        });
      }

      try {
        const data = service.review(identity.id);
        return res.status(200).json({
          success: true,
          data,
          endpoint: MLB_P1_M3D_ENDPOINT,
        });
      } catch (error: unknown) {
        console.error("P1-M3D MLB economic review error:", error);
        return res.status(500).json({
          success: false,
          error: "Unable to build the interactive MLB economic review.",
          code: "P1_M3D_INTERNAL_ERROR",
        });
      }
    },
  );
}
