import assert from "node:assert/strict";
import test from "node:test";
import { OperationalDiagnosticsService } from "./operational-diagnostics";

function metrics(overrides: any = {}) {
  return {
    schemaVersion: "courtedge-metrics.v1", startedAt: new Date().toISOString(), uptimeSeconds: 1,
    requests: { total: 100, success2xx: 100, redirects3xx: 0, clientErrors4xx: 0, serverErrors5xx: 0, averageLatencyMs: 10, maxLatencyMs: 20, active: 0 },
    eventLoop: { meanLagMs: 1, p95LagMs: 2, maxLagMs: 3 },
    memory: { rssMb: 100, heapUsedMb: 30, heapTotalMb: 50, externalMb: 2 }, routes: [], recentErrors: [],
    ...overrides,
  } as any;
}

function providers(overrides: any = {}) {
  const now = new Date().toISOString();
  return {
    backup: () => ({ enabled: true, latestBackupAt: now, latestBackupId: "backup-1", latestVerified: true, latestAgeHours: 1 }),
    restoreDrill: () => ({ latestValid: true, latestDrillAt: now, latestBackupId: "backup-1" }),
    ledger: () => ({ immutable: true, journalMode: "wal", predictions: 6, settlementEvents: 4 }),
    ownership: () => ({ unownedPredictions: 0, immutable: true }),
    picks: () => ({ unowned: 0, records: 3 }),
    metrics: () => metrics(),
    ...overrides,
  };
}

test("S4C reports HEALTHY when resilience invariants hold", () => {
  const report = new OperationalDiagnosticsService(providers()).evaluate();
  assert.equal(report.status, "HEALTHY");
  assert.equal(report.counts.critical, 0);
});

test("S4C reports WARN when no restore drill exists", () => {
  const report = new OperationalDiagnosticsService(providers({ restoreDrill: () => ({ latestValid: null, latestDrillAt: null }) })).evaluate();
  assert.equal(report.status, "WARN");
  assert.ok(report.checks.some((check) => check.code === "RESTORE_DRILL_MISSING"));
});

test("S4C reports CRITICAL for unowned immutable-ledger records", () => {
  const report = new OperationalDiagnosticsService(providers({ ownership: () => ({ unownedPredictions: 2, immutable: true }) })).evaluate();
  assert.equal(report.status, "CRITICAL");
  assert.ok(report.checks.some((check) => check.code === "LEDGER_OWNERSHIP" && check.status === "CRITICAL"));
});
