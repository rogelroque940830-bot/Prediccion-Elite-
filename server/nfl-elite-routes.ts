import type { Express } from "express";
import { getNflEliteIntegrationStatus } from "./nfl-elite-integration-gate";

export function registerNflEliteRoutes(app: Express): void {
  app.get("/api/nfl/elite/status", (_req, res) => {
    const status = getNflEliteIntegrationStatus();
    return res.status(status.state === "READY" ? 200 : 503).json({
      success: status.state === "READY",
      data: status,
      code: status.state === "READY" ? "NFL_ELITE_READY" : "NFL_ELITE_FAIL_CLOSED",
    });
  });
}
