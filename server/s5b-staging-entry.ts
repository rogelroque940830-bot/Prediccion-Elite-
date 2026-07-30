import "./staging-entry";
import { app } from "./index";
import { getMlbLedgerStore } from "./mlb-ledger";
import { getMlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import { resolveSystemOwnerUserId } from "./user-data-context";
import { startMlbShadowCollectionWorker } from "./mlb-shadow-collection-worker";
import { startMlbS5cShadowIngestionWorker } from "./mlb-s5c-shadow-ingestion";
import { startMlbS5dGateMonitorWorker } from "./mlb-s5d-gate-monitor";

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
