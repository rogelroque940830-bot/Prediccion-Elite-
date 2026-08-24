import type { Express } from "express";
import { getNflEliteIntegrationStatus } from "./nfl-elite-integration-gate";

export function registerNflEliteRoutes(app: Express): void {
  app.get("/api/nfl/elite/status", (_req, res) => {
    const status = getNflEliteIntegrationStatus();
    const success = status.state !== "BLOCKED";
    const code = status.state === "FULL_READY"
      ? "NFL_ELITE_FULL_READY"
      : status.state === "CORE_READY"
        ? "NFL_ELITE_CORE_READY"
        : "NFL_ELITE_FAIL_CLOSED";
    return res.status(success ? 200 : 503).json({ success, data: status, code });
  });
}
