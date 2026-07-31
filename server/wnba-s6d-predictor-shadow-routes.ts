import type { Express } from "express";
import type { WnbaPredictorShadowService } from "./wnba-s6d-predictor-shadow-service";

function integerQuery(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

type StatusSnapshot = ReturnType<WnbaPredictorShadowService["status"]>;

export function buildPublicWnbaPredictorShadowHealth(status: StatusSnapshot): Record<string, unknown> {
  const latest = status.latest;
  const healthy = !status.enabled || Boolean(status.lastSuccessAt && !status.lastError);
  const degraded = Boolean(latest?.errors?.length);
  return {
    status: healthy ? (degraded ? "degraded" : "healthy") : "starting",
    commit: latest?.deploymentCommit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
    environment: latest?.environment ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
    schemaVersion: status.schemaVersion,
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    initialDelayMs: status.initialDelayMs,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    cutoverAt: status.cutoverAt,
    records: status.records,
    latest: latest ? {
      sourceOutputsDiscovered: latest.sourceOutputsDiscovered,
      modernOutputs: latest.modernOutputs,
      legacyOutputs: latest.legacyOutputs,
      preCutoverIgnored: latest.preCutoverIgnored,
      newSourceOutputs: latest.newSourceOutputs,
      recordsCreated: latest.recordsCreated,
      idempotentOutputs: latest.idempotentOutputs,
      supersedingRecords: latest.supersedingRecords,
      baselineLinked: latest.baselineLinked,
      baselineAmbiguous: latest.baselineAmbiguous,
      explicitModelProbability: latest.explicitModelProbability,
      missingModelProbability: latest.missingModelProbability,
      errors: latest.errors.length,
    } : null,
    report: {
      terminalDecisions: status.report.terminalDecisions,
      baselineLinkCoveragePct: status.report.baselineLinkCoveragePct,
      explicitModelProbabilityCoveragePct: status.report.explicitModelProbabilityCoveragePct,
      acceptedStatusCoveragePct: status.report.acceptedStatusCoveragePct,
      comparableEdgeTerminal: status.report.comparableEdgeTerminal,
    },
    safety: status.report.safety,
  };
}

export function registerWnbaPredictorShadowRoutes(app: Express, service: WnbaPredictorShadowService): void {
  app.get("/health/s6d-wnba-predictor-shadow", (_req, res) => {
    const payload = buildPublicWnbaPredictorShadowHealth(service.status());
    res.status(payload.status === "starting" ? 503 : 200).json(payload);
  });

  app.get("/api/wnba/predictor-shadow/v1/status", (_req, res) => {
    res.json({ success: true, data: service.status() });
  });

  app.get("/api/wnba/predictor-shadow/v1/latest", (_req, res) => {
    res.json({ success: true, data: service.readLatest() });
  });

  app.get("/api/wnba/predictor-shadow/v1/records", (req, res) => {
    const limit = integerQuery(req.query.limit, 100, 1000);
    const records = service.readRecords();
    res.json({ success: true, data: records.slice(Math.max(0, records.length - limit)) });
  });

  app.get("/api/wnba/predictor-shadow/v1/report", (_req, res) => {
    res.json({ success: true, data: service.readReport() });
  });
}
