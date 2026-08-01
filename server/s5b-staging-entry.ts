import "./staging-entry";
import { app } from "./index";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import { resolveSystemOwnerUserId } from "./user-data-context";
import { startMlbShadowCollectionWorker } from "./mlb-shadow-collection-worker";
import { startMlbS5cShadowIngestionWorker } from "./mlb-s5c-shadow-ingestion";
import { startMlbS5dGateMonitorWorker } from "./mlb-s5d-gate-monitor";
import { startMlbS5eCoverageWorker } from "./mlb-s5e-coverage-service";
import { startMlbS5fCertificationWorker } from "./mlb-s5f-certification-service";
import { startMlbS6iPostfixCertificationWorker } from "./mlb-s6i-postfix-certification";

const ledgerStore = getMlbLedgerStore();
const ownershipStore = getMlbLedgerOwnershipStore();
const systemOwnerUserId = resolveSystemOwnerUserId();
const shadowCollection = startMlbShadowCollectionWorker(ledgerStore);
const s5cIngestion = startMlbS5cShadowIngestionWorker(
  ledgerStore,
  ownershipStore,
  { ownerUserId: systemOwnerUserId },
);
const s5dGateMonitor = startMlbS5dGateMonitorWorker(ledgerStore);
const s5eCoverage = startMlbS5eCoverageWorker(
  ledgerStore,
  ownershipStore,
  s5cIngestion.service,
  { ownerUserId: systemOwnerUserId },
);
const s5fCertification = startMlbS5fCertificationWorker(
  ledgerStore,
  ownershipStore,
  s5eCoverage.service,
  s5dGateMonitor.service,
  { ownerUserId: systemOwnerUserId },
);
const s6iPostfixCertification = startMlbS6iPostfixCertificationWorker(
  ledgerStore,
  ownershipStore,
  { ownerUserId: systemOwnerUserId },
);

app.get("/health/shadow-collection", (_req, res) => {
  const status = shadowCollection.service.status();
  const ready = status.enabled
    && Boolean(status.lastSuccessAt)
    && status.snapshots >= 1
    && status.lastError == null;
  res.status(ready ? 200 : 503).json({
    status: ready ? "healthy" : "pending",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
    schemaVersion: status.schemaVersion,
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    retentionDays: status.retentionDays,
    maxSnapshots: status.maxSnapshots,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    snapshots: status.snapshots,
    lastError: status.lastError,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
    },
  });
});

app.get("/health/s5c-ingestion", (_req, res) => {
  const status = s5cIngestion.service.status();
  const latest = status.latest;
  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null;
  res.status(ready ? 200 : 503).json({
    status: ready ? "healthy" : "pending",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
    schemaVersion: status.schemaVersion,
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    initialDelayMs: status.initialDelayMs,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    latest: latest ? {
      gameDate: latest.gameDate,
      gamesDiscovered: latest.gamesDiscovered,
      gamesEligible: latest.gamesEligible,
      gamesAnalyzed: latest.gamesAnalyzed,
      pricedDecisions: latest.pricedDecisions,
      unpricedDecisions: latest.unpricedDecisions,
      recordsCreated: latest.recordsCreated,
      idempotentSkips: latest.idempotentSkips,
      skippedGames: latest.skippedGames,
      errorCount: latest.errors.length,
    } : null,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      syntheticOdds: false,
    },
  });
});

app.get("/health/s5d-gate", (_req, res) => {
  const status = s5dGateMonitor.service.status();
  const latest = status.latest;
  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);
  res.status(ready ? 200 : 503).json({
    status: ready ? "healthy" : "pending",
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
    transitions: status.transitions,
    reviewPackages: status.reviewPackages,
    latest: latest ? {
      gateStatus: latest.gate.status,
      settled: latest.progress.settled,
      marketImpliedCoverage: latest.progress.marketImpliedCoverage,
      closingCoverage: latest.progress.closingCoverage,
      finalSnapshotCoverage: latest.progress.finalSnapshotCoverage,
      humanReviewRequired: latest.humanReview.required,
      automaticPromotion: latest.humanReview.automaticPromotion,
    } : null,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  });
});

app.get("/health/s5e-coverage", (_req, res) => {
  const status = s5eCoverage.service.status();
  const latest = status.latest;
  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);
  res.status(ready ? 200 : 503).json({
    status: ready ? "healthy" : "pending",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
    schemaVersion: status.schemaVersion,
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    initialDelayMs: status.initialDelayMs,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    observationCount: status.observationCount,
    latest: latest ? {
      terminalPredictions: latest.terminalPredictions,
      finalization: latest.finalization,
      closing: latest.closing,
      settlement: latest.settlement,
      diagnosticCounts: {
        sourceSetChanged: latest.diagnostics.sourceSetChanged,
        lineMoved: latest.diagnostics.lineMoved,
        noPrice: latest.diagnostics.noPrice,
        noOddsMatch: latest.diagnostics.noOddsMatch,
        errors: latest.diagnostics.errors.length,
      },
    } : null,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      automaticPromotion: false,
      syntheticOdds: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  });
});

app.get("/health/s5f-certification", (_req, res) => {
  const status = s5fCertification.service.status();
  const latest = status.latest;
  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);
  const severityCounts = latest?.alerts.reduce((counts, item) => {
    counts[item.severity] = (counts[item.severity] ?? 0) + 1;
    return counts;
  }, { INFO: 0, WARNING: 0, CRITICAL: 0 } as Record<string, number>) ?? null;
  res.status(ready ? 200 : 503).json({
    status: ready ? "healthy" : "pending",
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
      terminalPredictions: latest.source.terminalPredictions,
      supersededPredictions: latest.source.supersededPredictions,
      dashboardCounts: latest.dashboard.counts,
      alertCounts: severityCounts,
      actionableAlerts: latest.alerts.filter((item) => item.actionable).length,
      gateStatus: latest.reviewPackage.gate.status,
      partialReviewPackage: latest.reviewPackage.partial,
      humanReviewRequired: latest.reviewPackage.humanReview.required,
      automaticPromotion: latest.reviewPackage.humanReview.automaticPromotion,
    } : null,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  });
});

app.get("/health/s6i-postfix-certification", (_req, res) => {
  const status = s6iPostfixCertification.service.status();
  const latest = status.latest;
  const ready = status.enabled && Boolean(status.lastSuccessAt) && status.lastError == null && Boolean(latest);
  res.status(ready ? 200 : 503).json({
    status: ready ? "healthy" : "pending",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown",
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown",
    schemaVersion: status.schemaVersion,
    enabled: status.enabled,
    intervalMs: status.intervalMs,
    initialDelayMs: status.initialDelayMs,
    lastRunAt: status.lastRunAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    latest: latest ? {
      state: latest.state,
      cohort: latest.cohort,
      summary: latest.summary,
      coverage: latest.coverage,
      persistence: latest.persistence,
      readiness: latest.readiness,
      issueCounts: latest.issues.reduce((counts, entry) => {
        counts[entry.code] = (counts[entry.code] ?? 0) + 1;
        return counts;
      }, {} as Record<string, number>),
    } : null,
    safety: latest?.safety ?? {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      historicalLedgerMutation: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  });
});

app.get("/api/mlb/ledger/v1/shadow-collection/status", (_req, res) => {
  res.json({ success: true, data: shadowCollection.service.status() });
});

app.get("/api/mlb/ledger/v1/shadow-collection/latest", (_req, res) => {
  const latest = shadowCollection.service.readLatest();
  if (!latest) {
    res.status(404).json({
      success: false,
      error: "No S5B shadow collection has completed yet",
    });
    return;
  }
  res.json({ success: true, data: latest });
});

app.get("/api/mlb/ledger/v1/s5c-ingestion/status", (_req, res) => {
  res.json({ success: true, data: s5cIngestion.service.status() });
});

app.get("/api/mlb/ledger/v1/s5c-ingestion/latest", (_req, res) => {
  const latest = s5cIngestion.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S5C ingestion run has completed yet" });
    return;
  }
  res.json({ success: true, data: latest });
});

app.get("/api/mlb/ledger/v1/s5d-gate/status", (_req, res) => {
  res.json({ success: true, data: s5dGateMonitor.service.status() });
});

app.get("/api/mlb/ledger/v1/s5d-gate/latest", (_req, res) => {
  const latest = s5dGateMonitor.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S5D gate evaluation has completed yet" });
    return;
  }
  res.json({ success: true, data: latest });
});

app.get("/api/mlb/ledger/v1/s5d-gate/transitions", (req, res) => {
  const parsed = Number(req.query.limit);
  const limit = Number.isFinite(parsed) ? parsed : 100;
  res.json({ success: true, data: s5dGateMonitor.service.readTransitions(limit) });
});

app.get("/api/mlb/ledger/v1/s5e-coverage/status", (_req, res) => {
  res.json({ success: true, data: s5eCoverage.service.status() });
});

app.get("/api/mlb/ledger/v1/s5e-coverage/latest", (_req, res) => {
  const latest = s5eCoverage.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S5E coverage audit has completed yet" });
    return;
  }
  res.json({ success: true, data: latest });
});

app.get("/api/mlb/ledger/v1/s5e-coverage/observations", (req, res) => {
  const predictionId = typeof req.query.predictionId === "string" ? req.query.predictionId : undefined;
  const parsed = Number(req.query.limit);
  const limit = Number.isFinite(parsed) ? Math.min(500, Math.max(1, Math.floor(parsed))) : 100;
  const observations = s5eCoverage.service.readObservations(predictionId);
  res.json({ success: true, data: observations.slice(-limit) });
});

app.get("/api/mlb/ledger/v1/s5f-certification/status", (_req, res) => {
  res.json({ success: true, data: s5fCertification.service.status() });
});

app.get("/api/mlb/ledger/v1/s5f-certification/dashboard", (_req, res) => {
  const dashboard = s5fCertification.service.readDashboard();
  if (!dashboard) {
    res.status(404).json({ success: false, error: "No S5F certification dashboard has completed yet" });
    return;
  }
  res.json({ success: true, data: dashboard });
});

app.get("/api/mlb/ledger/v1/s5f-certification/review-package", (_req, res) => {
  const reviewPackage = s5fCertification.service.readReviewPackage();
  if (!reviewPackage) {
    res.status(404).json({ success: false, error: "No S5F scientific review package has completed yet" });
    return;
  }
  res.json({ success: true, data: reviewPackage });
});

app.get("/api/mlb/ledger/v1/s5f-certification/alerts", (req, res) => {
  const severity = typeof req.query.severity === "string" ? req.query.severity.toUpperCase() : null;
  const actionable = req.query.actionable === "true" ? true : req.query.actionable === "false" ? false : null;
  const parsed = Number(req.query.limit);
  const limit = Number.isFinite(parsed) ? Math.min(1_000, Math.max(1, Math.floor(parsed))) : 200;
  const alerts = s5fCertification.service.readAlerts()
    .filter((item) => !severity || item.severity === severity)
    .filter((item) => actionable == null || item.actionable === actionable)
    .slice(0, limit);
  res.json({ success: true, data: alerts });
});

app.get("/api/mlb/ledger/v1/s6i-postfix-certification/status", (_req, res) => {
  const status = s6iPostfixCertification.service.status();
  res.json({
    success: true,
    data: {
      schemaVersion: status.schemaVersion,
      enabled: status.enabled,
      intervalMs: status.intervalMs,
      initialDelayMs: status.initialDelayMs,
      lastRunAt: status.lastRunAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError,
      latest: status.latest ? {
        generatedAt: status.latest.generatedAt,
        state: status.latest.state,
        cohort: status.latest.cohort,
        summary: status.latest.summary,
        coverage: status.latest.coverage,
        persistence: status.latest.persistence,
        performanceObservation: status.latest.performanceObservation,
        marketBreakdowns: status.latest.marketBreakdowns,
        readiness: status.latest.readiness,
        safety: status.latest.safety,
      } : null,
    },
  });
});

app.get("/api/mlb/ledger/v1/s6i-postfix-certification/issues", (req, res) => {
  const latest = s6iPostfixCertification.service.readLatest();
  if (!latest) {
    res.status(404).json({ success: false, error: "No S6I post-fix certification report has completed yet" });
    return;
  }
  const severity = typeof req.query.severity === "string" ? req.query.severity.toUpperCase() : null;
  const parsed = Number(req.query.limit);
  const limit = Number.isFinite(parsed) ? Math.min(500, Math.max(1, Math.floor(parsed))) : 100;
  const issues = latest.issues
    .filter((entry) => !severity || entry.severity === severity)
    .slice(0, limit);
  res.json({ success: true, data: issues });
});
