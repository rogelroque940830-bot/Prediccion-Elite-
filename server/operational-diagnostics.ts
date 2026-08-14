import type { OperationalMetricsSnapshot } from "./operational-observability";

export type OperationalCheckStatus = "HEALTHY" | "WARN" | "CRITICAL";

export interface OperationalDiagnosticCheck {
  code: string;
  status: OperationalCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface OperationalDiagnosticsReport {
  schemaVersion: "courtedge-diagnostics.v1";
  checkedAt: string;
  status: OperationalCheckStatus;
  checks: OperationalDiagnosticCheck[];
  counts: { healthy: number; warnings: number; critical: number };
}

export interface OperationalDiagnosticProviders {
  backup: () => any;
  restoreDrill: () => any;
  ledger: () => any;
  ownership: () => any;
  picks: () => any;
  metrics: () => OperationalMetricsSnapshot;
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rank(status: OperationalCheckStatus): number {
  return status === "CRITICAL" ? 2 : status === "WARN" ? 1 : 0;
}

export class OperationalDiagnosticsService {
  constructor(private readonly providers: OperationalDiagnosticProviders) {}

  evaluate(): OperationalDiagnosticsReport {
    const checks: OperationalDiagnosticCheck[] = [];
    const backup = this.providers.backup();
    const restore = this.providers.restoreDrill();
    const ledger = this.providers.ledger();
    const ownership = this.providers.ownership();
    const picks = this.providers.picks();
    const metrics = this.providers.metrics();

    if (backup.enabled === false) {
      checks.push({ code: "BACKUP_DISABLED", status: "CRITICAL", message: "Operational backups are disabled" });
    } else if (!backup.latestBackupAt) {
      checks.push({ code: "BACKUP_MISSING", status: "WARN", message: "No operational backup has completed yet" });
    } else if (!backup.latestVerified) {
      checks.push({ code: "BACKUP_UNVERIFIED", status: "CRITICAL", message: "Latest operational backup did not verify", details: { backupId: backup.latestBackupId } });
    } else {
      const maxAge = numberEnv("COURTEDGE_BACKUP_MAX_AGE_HOURS", 36);
      const age = Number(backup.latestAgeHours || 0);
      checks.push({
        code: "BACKUP_FRESHNESS",
        status: age > maxAge * 2 ? "CRITICAL" : age > maxAge ? "WARN" : "HEALTHY",
        message: age > maxAge ? `Latest backup is ${age} hours old` : "Latest backup is verified and fresh",
        details: { backupId: backup.latestBackupId, ageHours: age, maxAgeHours: maxAge },
      });
    }

    if (restore.latestValid === false) {
      checks.push({ code: "RESTORE_DRILL_FAILED", status: "CRITICAL", message: "Latest restore drill failed", details: { backupId: restore.latestBackupId } });
    } else if (!restore.latestDrillAt) {
      checks.push({ code: "RESTORE_DRILL_MISSING", status: "WARN", message: "No isolated restore drill has completed yet" });
    } else {
      const maxAgeDays = numberEnv("COURTEDGE_RESTORE_DRILL_MAX_AGE_DAYS", 7);
      const ageDays = (Date.now() - Date.parse(restore.latestDrillAt)) / 86_400_000;
      checks.push({
        code: "RESTORE_DRILL_FRESHNESS",
        status: ageDays > maxAgeDays * 2 ? "CRITICAL" : ageDays > maxAgeDays ? "WARN" : "HEALTHY",
        message: ageDays > maxAgeDays ? `Latest restore drill is ${Math.round(ageDays * 10) / 10} days old` : "Latest restore drill passed",
        details: { backupId: restore.latestBackupId, ageDays: Math.round(ageDays * 10) / 10, maxAgeDays },
      });
    }

    checks.push({
      code: "LEDGER_IMMUTABILITY",
      status: ledger.immutable === true && String(ledger.journalMode).toLowerCase() === "wal" ? "HEALTHY" : "CRITICAL",
      message: ledger.immutable === true && String(ledger.journalMode).toLowerCase() === "wal" ? "Ledger is immutable and using WAL" : "Ledger immutability or WAL mode is not confirmed",
      details: { predictions: ledger.predictions, settlementEvents: ledger.settlementEvents, journalMode: ledger.journalMode },
    });

    checks.push({
      code: "LEDGER_OWNERSHIP",
      status: Number(ownership.unownedPredictions || 0) === 0 && ownership.immutable === true ? "HEALTHY" : "CRITICAL",
      message: Number(ownership.unownedPredictions || 0) === 0 ? "Every ledger prediction has immutable ownership" : `${ownership.unownedPredictions} ledger predictions are unowned`,
      details: ownership,
    });

    checks.push({
      code: "PICK_OWNERSHIP",
      status: Number(picks.unowned || 0) === 0 ? "HEALTHY" : "CRITICAL",
      message: Number(picks.unowned || 0) === 0 ? "Every visible pick has an owner" : `${picks.unowned} picks are unowned`,
      details: picks,
    });

    const requestTotal = metrics.requests.total;
    const errorRate = requestTotal > 0 ? metrics.requests.serverErrors5xx / requestTotal : 0;
    const warnErrorRate = numberEnv("COURTEDGE_ERROR_RATE_WARN_PCT", 5) / 100;
    const criticalErrorRate = numberEnv("COURTEDGE_ERROR_RATE_CRITICAL_PCT", 20) / 100;
    const errorStatus: OperationalCheckStatus = requestTotal < 20 ? "HEALTHY" : errorRate >= criticalErrorRate ? "CRITICAL" : errorRate >= warnErrorRate ? "WARN" : "HEALTHY";
    checks.push({
      code: "HTTP_ERROR_RATE",
      status: errorStatus,
      message: requestTotal < 20 ? "Insufficient traffic for error-rate alerting" : `HTTP 5xx rate is ${(errorRate * 100).toFixed(1)}%`,
      details: { requests: requestTotal, serverErrors5xx: metrics.requests.serverErrors5xx, ratePct: Math.round(errorRate * 10_000) / 100 },
    });

    const lag = metrics.eventLoop.p95LagMs;
    checks.push({
      code: "EVENT_LOOP_LAG",
      status: lag >= 500 ? "CRITICAL" : lag >= 100 ? "WARN" : "HEALTHY",
      message: `Event-loop p95 lag is ${lag} ms`,
      details: metrics.eventLoop,
    });

    const rssWarn = numberEnv("COURTEDGE_RSS_WARN_MB", 768);
    const rss = metrics.memory.rssMb;
    checks.push({
      code: "MEMORY_RSS",
      status: rss >= rssWarn * 1.5 ? "CRITICAL" : rss >= rssWarn ? "WARN" : "HEALTHY",
      message: `Process RSS is ${rss} MB`,
      details: { ...metrics.memory, warningThresholdMb: rssWarn },
    });

    const critical = checks.filter((check) => check.status === "CRITICAL").length;
    const warnings = checks.filter((check) => check.status === "WARN").length;
    const healthy = checks.length - critical - warnings;
    const status = checks.reduce<OperationalCheckStatus>((current, check) => rank(check.status) > rank(current) ? check.status : current, "HEALTHY");
    return {
      schemaVersion: "courtedge-diagnostics.v1",
      checkedAt: new Date().toISOString(),
      status,
      checks,
      counts: { healthy, warnings, critical },
    };
  }
}
