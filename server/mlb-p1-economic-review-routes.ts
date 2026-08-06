import type { Express, Request } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import {
  MLB_P1_M3D_ENDPOINT,
  MlbP1EconomicReviewService,
} from "./mlb-p1-economic-review";
import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";
import { getRequestIdentity } from "./user-data-context";

function authenticatedIdentity(req: Request) {
  const session = (req as Request & { session?: Record<string, unknown> }).session;
  if (session?.courtEdgeAuthenticated !== true) return null;
  return getRequestIdentity(req);
}

export function registerMlbP1EconomicReviewRoutes(
  app: Express,
  service = new MlbP1EconomicReviewService(
    getMlbLedgerStore(),
    getMlbLedgerOwnershipStore(),
  ),
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
