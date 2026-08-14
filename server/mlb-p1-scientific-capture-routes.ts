import type { Express, NextFunction, Request, Response } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import {
  MLB_P1_M3B_ENDPOINT,
  MlbP1ScientificCaptureService,
  isMlbP1M3bCaptureError,
} from "./mlb-p1-scientific-capture-service";
import { getRequestIdentity, requireOwnDataWriteRole } from "./user-data-context";

function hasAuthenticatedInteractiveSession(req: Request): boolean {
  const session = (req as Request & { session?: Record<string, unknown> }).session;
  return session?.courtEdgeAuthenticated === true && Boolean(getRequestIdentity(req));
}

export function requireInteractiveMlbCaptureSession(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (hasAuthenticatedInteractiveSession(req)) {
    next();
    return;
  }
  res.status(401).json({
    success: false,
    error: "Authenticated user session required for interactive MLB capture.",
    code: "INTERACTIVE_SESSION_REQUIRED",
  });
}

export function registerMlbP1ScientificCaptureRoutes(
  app: Express,
  service = new MlbP1ScientificCaptureService(
    getMlbLedgerStore(),
    getMlbLedgerOwnershipStore(),
  ),
): void {
  app.post(
    "/api/mlb/p1/v1/scientific-captures",
    requireInteractiveMlbCaptureSession,
    requireOwnDataWriteRole,
    async (req, res) => {
      const identity = hasAuthenticatedInteractiveSession(req) ? getRequestIdentity(req) : null;
      if (!identity) {
        return res.status(401).json({
          success: false,
          error: "Authenticated user session required for interactive MLB capture.",
          code: "INTERACTIVE_SESSION_REQUIRED",
        });
      }

      try {
        const data = await service.capture(req.body, identity.id);
        return res.status(data.idempotent ? 200 : 201).json({
          success: true,
          data,
          endpoint: MLB_P1_M3B_ENDPOINT,
        });
      } catch (error: unknown) {
        if (isMlbP1M3bCaptureError(error)) {
          return res.status(error.status).json({
            success: false,
            error: error.message,
            code: error.code,
            details: error.details,
          });
        }
        console.error("P1-M3B MLB scientific capture error:", error);
        return res.status(500).json({
          success: false,
          error: "Unable to append the MLB scientific capture.",
          code: "P1_M3B_INTERNAL_ERROR",
        });
      }
    },
  );
}
