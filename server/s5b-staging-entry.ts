import "./staging-entry";
import { app } from "./index";
import { getMlbLedgerStore } from "./mlb-ledger";
import { startMlbShadowCollectionWorker } from "./mlb-shadow-collection-worker";

const shadowCollection = startMlbShadowCollectionWorker(getMlbLedgerStore());

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
