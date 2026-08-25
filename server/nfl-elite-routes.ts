import type { Express } from "express";
import { getNflEliteIntegrationStatus } from "./nfl-elite-integration-gate";
import { getNflFullElite2026Snapshot } from "./nfl-full-elite-operational-2026";

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

  app.get("/api/nfl/elite/cards", async (_req, res) => {
    try {
      const snapshot = await getNflFullElite2026Snapshot();
      const success = snapshot.state !== "BLOCKED";
      const code = snapshot.state === "READY"
        ? "NFL_ELITE_CARDS_READY"
        : snapshot.state === "NO_GAMES"
          ? "NFL_ELITE_NO_GAMES"
          : "NFL_ELITE_CARDS_BLOCKED";
      return res.status(success ? 200 : 503).json({ success, data: snapshot, code });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown NFL operational error";
      return res.status(503).json({
        success: false,
        data: null,
        code: "NFL_ELITE_CARDS_SOURCE_FAILURE",
        error: message,
      });
    }
  });
}
