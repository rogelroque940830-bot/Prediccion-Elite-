import type { Express } from "express";
import type {
  MultisportReadinessService,
  ReadinessSport,
} from "./multisport-readiness-service";
import { getNflFullElite2026Snapshot } from "./nfl-full-elite-operational-2026";
import { buildNflCrossSportReadiness } from "./nfl-cross-sport-readiness";

export function registerMultisportReadinessRoutes(
  app: Express,
  service: MultisportReadinessService,
): void {
  app.get("/health/s6a-readiness", (_req, res) => {
    const status = service.status();
    const latest = status.latest;
    const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);
    const sportSummary = latest ? Object.fromEntries(
      (Object.keys(latest.sports) as ReadinessSport[]).map((sport) => {
        const value = latest.sports[sport];
        return [sport, {
          state: value.state,
          gamesScheduled: value.gamesScheduled,
          requiredHealthy: value.requiredHealthy,
          requiredTotal: value.requiredTotal,
          degradedSources: value.degradedSources,
          failedSources: value.failedSources,
        }];
      }),
    ) : null;

    res.status(ready ? 200 : 503).json({
      status: ready ? (latest?.summary.blocked ? "degraded" : "healthy") : "pending",
      commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
      environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
      schemaVersion: status.schemaVersion,
      enabled: status.enabled,
      intervalMs: status.intervalMs,
      initialDelayMs: status.initialDelayMs,
      lastRunAt: status.lastRunAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
      snapshots: status.snapshots,
      latest: latest ? {
        auditDate: latest.auditDate,
        summary: latest.summary,
        sports: sportSummary,
      } : null,
      safety: {
        mode: "READ_ONLY_AUDIT",
        predictionsCreated: 0,
        realFinancialExposure: 0,
        sportsbookIntegration: false,
        automaticBetPlacement: false,
        productionWrites: false,
        automaticPromotion: false,
        formulasChanged: false,
        filtersChanged: false,
        marketsChanged: false,
        thresholdsChanged: false,
        stakePolicyChanged: false,
      },
    });
  });

  app.get("/api/multisport/readiness/v1/status", (_req, res) => {
    res.json({ success: true, data: service.status() });
  });

  app.get("/api/multisport/readiness/v1/latest", (_req, res) => {
    const latest = service.readLatest();
    if (!latest) {
      res.status(404).json({ success: false, error: "No S6A multisport readiness audit has completed yet" });
      return;
    }
    res.json({ success: true, data: latest });
  });

  app.get("/api/multisport/readiness/v1/sports/:sport", (req, res) => {
    const sport = String(req.params.sport ?? "").toUpperCase() as ReadinessSport;
    if (sport !== "NBA" && sport !== "WNBA" && sport !== "NHL" && sport !== "NFL") {
      res.status(400).json({ success: false, error: "Sport must be NBA, WNBA, NHL, or NFL" });
      return;
    }
    const latest = service.readLatest();
    if (!latest) {
      res.status(404).json({ success: false, error: "No S6A multisport readiness audit has completed yet" });
      return;
    }
    res.json({ success: true, data: latest.sports[sport] });
  });

  app.get("/api/multisport/readiness/v1/nfl-cross-sport", async (_req, res) => {
    try {
      const snapshot = await getNflFullElite2026Snapshot();
      const readiness = buildNflCrossSportReadiness(snapshot);
      const operational = snapshot.state !== "BLOCKED";
      return res.status(operational ? 200 : 503).json({
        success: operational,
        data: readiness,
        code: operational
          ? "NFL_CROSS_SPORT_UNCALIBRATED"
          : "NFL_CROSS_SPORT_SOURCE_BLOCKED",
      });
    } catch (error) {
      return res.status(503).json({
        success: false,
        data: null,
        code: "NFL_CROSS_SPORT_SOURCE_FAILURE",
        error: error instanceof Error ? error.message : "Unknown NFL cross-sport readiness error",
      });
    }
  });
}
