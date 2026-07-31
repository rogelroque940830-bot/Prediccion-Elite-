import type { Express } from "express";
import type { WnbaShadowService } from "./wnba-s6c-shadow-service";

function integerQuery(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

export function registerWnbaShadowRoutes(app: Express, service: WnbaShadowService): void {
  app.get("/health/s6c-wnba-shadow", (_req, res) => {
    const status = service.status();
    const latest = status.latest;
    const healthy = !status.enabled || Boolean(status.lastSuccessAt && !status.lastError);
    const degraded = Boolean(latest?.errors?.length);
    res.status(healthy ? 200 : 503).json({
      status: healthy ? (degraded ? "degraded" : "healthy") : "starting",
      commit: latest?.deploymentCommit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
      environment: latest?.environment ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
      schemaVersion: status.schemaVersion,
      enabled: status.enabled,
      intervalMs: status.intervalMs,
      initialDelayMs: status.initialDelayMs,
      finalWindowMinutes: status.finalWindowMinutes,
      lastRunAt: status.lastRunAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
      records: status.records,
      settlements: status.settlements,
      latest: latest ? {
        gameDate: latest.gameDate,
        discoveredGames: latest.discoveredGames,
        pricedGames: latest.pricedGames,
        recordsCreated: latest.recordsCreated,
        idempotentRecords: latest.idempotentRecords,
        provisionalCreated: latest.provisionalCreated,
        finalCreated: latest.finalCreated,
        settlementsCreated: latest.settlementsCreated,
        errors: latest.errors.length,
      } : null,
      report: {
        terminalGames: status.report.terminalGames,
        finalCoveragePct: status.report.finalCoveragePct,
        settled: status.report.settled,
        settlementCoveragePct: status.report.settlementCoveragePct,
        marketCoveragePct: status.report.marketCoveragePct,
        averageDataQualityPct: status.report.averageDataQualityPct,
        degradedSourceTerminalRecords: status.report.degradedSourceTerminalRecords,
      },
      safety: status.report.safety,
    });
  });

  app.get("/api/wnba/shadow/v1/status", (_req, res) => {
    res.json({ success: true, data: service.status() });
  });

  app.get("/api/wnba/shadow/v1/latest", (_req, res) => {
    res.json({ success: true, data: service.readLatest() });
  });

  app.get("/api/wnba/shadow/v1/records", (req, res) => {
    const limit = integerQuery(req.query.limit, 100, 1000);
    const records = service.readRecords();
    res.json({ success: true, data: records.slice(Math.max(0, records.length - limit)) });
  });

  app.get("/api/wnba/shadow/v1/settlements", (req, res) => {
    const limit = integerQuery(req.query.limit, 100, 1000);
    const settlements = service.readSettlements();
    res.json({ success: true, data: settlements.slice(Math.max(0, settlements.length - limit)) });
  });

  app.get("/api/wnba/shadow/v1/report", (_req, res) => {
    res.json({ success: true, data: service.readReport() });
  });
}
