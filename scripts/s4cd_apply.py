from pathlib import Path
import json

ROOT = Path('.')
SERVER = ROOT / 'server'
DOCS = ROOT / 'docs'

def write_new(path: Path, content: str):
    if path.exists():
        raise SystemExit(f'Refusing to overwrite {path}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')

observability = r'''import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";

interface RouteMetric {
  requests: number;
  errors4xx: number;
  errors5xx: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

export interface OperationalMetricsSnapshot {
  schemaVersion: "courtedge-metrics.v1";
  startedAt: string;
  uptimeSeconds: number;
  requests: {
    total: number;
    success2xx: number;
    redirects3xx: number;
    clientErrors4xx: number;
    serverErrors5xx: number;
    averageLatencyMs: number;
    maxLatencyMs: number;
    active: number;
  };
  eventLoop: { meanLagMs: number; p95LagMs: number; maxLagMs: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };
  routes: Array<{ route: string; requests: number; errors4xx: number; errors5xx: number; averageLatencyMs: number; maxLatencyMs: number }>;
  recentErrors: Array<{ at: string; method: string; route: string; status: number; message: string }>;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mb(bytes: number): number { return round(bytes / 1024 / 1024, 1); }

export function normalizeOperationalRoute(rawPath: string): string {
  const clean = rawPath.split("?")[0] || "/";
  return clean.split("/").map((segment) => {
    if (!segment) return segment;
    if (/^\d+$/.test(segment)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(segment)) return ":id";
    if (/^[A-Za-z0-9._:-]{32,}$/.test(segment)) return ":id";
    return segment.slice(0, 80);
  }).join("/");
}

export class OperationalObservabilityService {
  private readonly startedAtMs = Date.now();
  private readonly routes = new Map<string, RouteMetric>();
  private readonly errors: OperationalMetricsSnapshot["recentErrors"] = [];
  private total = 0;
  private success2xx = 0;
  private redirects3xx = 0;
  private errors4xx = 0;
  private errors5xx = 0;
  private totalLatencyMs = 0;
  private maxLatencyMs = 0;
  private active = 0;
  private readonly eventLoop: IntervalHistogram;

  constructor(private readonly maxRoutes = 100, private readonly maxErrors = 40) {
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoop.enable();
  }

  close(): void { this.eventLoop.disable(); }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const started = process.hrtime.bigint();
      this.active += 1;
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        this.active = Math.max(0, this.active - 1);
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const routePath = typeof req.route?.path === "string"
          ? `${req.baseUrl || ""}${req.route.path}`
          : req.path;
        this.recordRequest(req.method, routePath, res.statusCode, durationMs);
      };
      res.once("finish", finish);
      res.once("close", finish);
      next();
    };
  }

  recordRequest(method: string, rawPath: string, status: number, durationMs: number): void {
    const route = `${method.toUpperCase()} ${normalizeOperationalRoute(rawPath)}`;
    this.total += 1;
    this.totalLatencyMs += durationMs;
    this.maxLatencyMs = Math.max(this.maxLatencyMs, durationMs);
    if (status >= 500) this.errors5xx += 1;
    else if (status >= 400) this.errors4xx += 1;
    else if (status >= 300) this.redirects3xx += 1;
    else if (status >= 200) this.success2xx += 1;

    let metric = this.routes.get(route);
    if (!metric) {
      if (this.routes.size >= this.maxRoutes) {
        const least = [...this.routes.entries()].sort((a, b) => a[1].requests - b[1].requests)[0];
        if (least) this.routes.delete(least[0]);
      }
      metric = { requests: 0, errors4xx: 0, errors5xx: 0, totalLatencyMs: 0, maxLatencyMs: 0 };
      this.routes.set(route, metric);
    }
    metric.requests += 1;
    metric.totalLatencyMs += durationMs;
    metric.maxLatencyMs = Math.max(metric.maxLatencyMs, durationMs);
    if (status >= 500) metric.errors5xx += 1;
    else if (status >= 400) metric.errors4xx += 1;
  }

  recordError(method: string, rawPath: string, status: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    this.errors.push({
      at: new Date().toISOString(),
      method: method.toUpperCase(),
      route: normalizeOperationalRoute(rawPath),
      status,
      message: message.slice(0, 300),
    });
    if (this.errors.length > this.maxErrors) this.errors.splice(0, this.errors.length - this.maxErrors);
  }

  snapshot(): OperationalMetricsSnapshot {
    const memory = process.memoryUsage();
    const nanosecondsToMs = (value: number): number => Number.isFinite(value) ? round(value / 1_000_000, 2) : 0;
    const routes = [...this.routes.entries()]
      .map(([route, metric]) => ({
        route,
        requests: metric.requests,
        errors4xx: metric.errors4xx,
        errors5xx: metric.errors5xx,
        averageLatencyMs: round(metric.totalLatencyMs / Math.max(1, metric.requests), 1),
        maxLatencyMs: round(metric.maxLatencyMs, 1),
      }))
      .sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route));
    return {
      schemaVersion: "courtedge-metrics.v1",
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeSeconds: round((Date.now() - this.startedAtMs) / 1000, 1),
      requests: {
        total: this.total,
        success2xx: this.success2xx,
        redirects3xx: this.redirects3xx,
        clientErrors4xx: this.errors4xx,
        serverErrors5xx: this.errors5xx,
        averageLatencyMs: round(this.totalLatencyMs / Math.max(1, this.total), 1),
        maxLatencyMs: round(this.maxLatencyMs, 1),
        active: this.active,
      },
      eventLoop: {
        meanLagMs: nanosecondsToMs(this.eventLoop.mean),
        p95LagMs: nanosecondsToMs(this.eventLoop.percentile(95)),
        maxLagMs: nanosecondsToMs(this.eventLoop.max),
      },
      memory: { rssMb: mb(memory.rss), heapUsedMb: mb(memory.heapUsed), heapTotalMb: mb(memory.heapTotal), externalMb: mb(memory.external) },
      routes,
      recentErrors: [...this.errors].reverse(),
    };
  }
}

let singleton: OperationalObservabilityService | null = null;
export function getOperationalObservabilityService(): OperationalObservabilityService {
  if (!singleton) singleton = new OperationalObservabilityService();
  return singleton;
}
'''
write_new(SERVER / 'operational-observability.ts', observability)

diagnostics = r'''import type { OperationalMetricsSnapshot } from "./operational-observability";

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
'''
write_new(SERVER / 'operational-diagnostics.ts', diagnostics)

alerts = r'''import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OperationalDiagnosticsReport, OperationalDiagnosticsService } from "./operational-diagnostics";

export interface OperationalAlert {
  schemaVersion: "courtedge-alert.v1";
  alertId: string;
  emittedAt: string;
  emittedAtMs: number;
  severity: "WARN" | "CRITICAL";
  fingerprint: string;
  summary: string;
  checks: Array<{ code: string; status: "WARN" | "CRITICAL"; message: string }>;
  delivered: { console: true; webhook: boolean; webhookError?: string };
}

function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000 ? Math.floor(parsed) : fallback;
}

function fingerprint(report: OperationalDiagnosticsReport): string {
  const content = report.checks
    .filter((check) => check.status !== "HEALTHY")
    .map((check) => `${check.code}:${check.status}`)
    .sort()
    .join("|");
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 24);
}

export class OperationalAlertService {
  private readonly file: string;
  constructor(
    private readonly diagnostics: OperationalDiagnosticsService,
    root: string,
    private readonly cooldownMs = positiveMs(process.env.COURTEDGE_ALERT_COOLDOWN_MS, 60 * 60 * 1000),
  ) {
    this.file = path.join(root, "operational-alerts.jsonl");
  }

  list(limit = 100): OperationalAlert[] {
    if (!fs.existsSync(this.file)) return [];
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    return fs.readFileSync(this.file, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as OperationalAlert]; } catch { return []; }
    }).slice(-safeLimit).reverse();
  }

  status() {
    const alerts = this.list(1_000);
    const latest = alerts[0] || null;
    return {
      alerts: alerts.length,
      latestAlertAt: latest?.emittedAt || null,
      latestSeverity: latest?.severity || null,
      latestFingerprint: latest?.fingerprint || null,
      webhookConfigured: Boolean(process.env.COURTEDGE_ALERT_WEBHOOK_URL),
      cooldownMs: this.cooldownMs,
    };
  }

  async evaluate(): Promise<{ emitted: boolean; report: OperationalDiagnosticsReport; alert: OperationalAlert | null; reason?: string }> {
    const report = this.diagnostics.evaluate();
    if (report.status === "HEALTHY") return { emitted: false, report, alert: null, reason: "healthy" };
    const fp = fingerprint(report);
    const previous = this.list(1_000).find((alert) => alert.fingerprint === fp);
    const now = Date.now();
    if (previous && now - previous.emittedAtMs < this.cooldownMs) {
      return { emitted: false, report, alert: previous, reason: "cooldown" };
    }

    const failed = report.checks.filter((check): check is typeof check & { status: "WARN" | "CRITICAL" } => check.status !== "HEALTHY");
    const severity = report.status as "WARN" | "CRITICAL";
    const alert: OperationalAlert = {
      schemaVersion: "courtedge-alert.v1",
      alertId: `ops-alert-${now}-${crypto.randomBytes(4).toString("hex")}`,
      emittedAt: new Date(now).toISOString(),
      emittedAtMs: now,
      severity,
      fingerprint: fp,
      summary: failed.map((check) => `${check.code}: ${check.message}`).join("; ").slice(0, 2_000),
      checks: failed.map((check) => ({ code: check.code, status: check.status, message: check.message })),
      delivered: { console: true, webhook: false },
    };

    const writer = severity === "CRITICAL" ? console.error : console.warn;
    writer(`[s4-alert] ${severity} ${alert.summary}`);
    const webhook = (process.env.COURTEDGE_ALERT_WEBHOOK_URL || "").trim();
    if (webhook) {
      try {
        const response = await fetch(webhook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alert, diagnostics: report }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
        alert.delivered.webhook = true;
      } catch (error: any) {
        alert.delivered.webhookError = String(error?.message || error).slice(0, 300);
      }
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(alert)}\n`, "utf-8");
    return { emitted: true, report, alert };
  }
}
'''
write_new(SERVER / 'operational-alerts.ts', alerts)

worker = r'''import type { OperationalAlertService } from "./operational-alerts";

function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}

export function startOperationalAlertWorker(service: OperationalAlertService): NodeJS.Timeout | null {
  if (process.env.COURTEDGE_ALERTS_ENABLED === "false") return null;
  const intervalMs = positiveMs(process.env.COURTEDGE_ALERT_INTERVAL_MS, 5 * 60 * 1000);
  const run = () => service.evaluate().catch((error) => console.error("[s4] alert evaluation failed", error));
  const initial = setTimeout(run, 90_000);
  initial.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
'''
write_new(SERVER / 'operational-alert-worker.ts', worker)

routes = r'''import type { Express } from "express";
import { requireGlobalWorkerRole } from "./user-data-context";
import type { OperationalObservabilityService } from "./operational-observability";
import type { OperationalDiagnosticsService } from "./operational-diagnostics";
import type { OperationalAlertService } from "./operational-alerts";

export function registerOperationalObservabilityRoutes(
  app: Express,
  metrics: OperationalObservabilityService,
  diagnostics: OperationalDiagnosticsService,
  alerts: OperationalAlertService,
): void {
  app.get("/api/ops/v1/metrics", (_req, res) => {
    res.json({ success: true, data: metrics.snapshot() });
  });

  app.get("/api/ops/v1/diagnostics", (_req, res) => {
    const data = diagnostics.evaluate();
    res.status(data.status === "CRITICAL" ? 503 : 200).json({ success: data.status !== "CRITICAL", data });
  });

  app.get("/api/ops/v1/alerts", (req, res) => {
    const limit = Number(req.query.limit || 100);
    res.json({ success: true, data: alerts.list(Number.isFinite(limit) ? limit : 100), status: alerts.status() });
  });

  app.post("/api/ops/v1/alerts/evaluate", requireGlobalWorkerRole, async (_req, res) => {
    try {
      const data = await alerts.evaluate();
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Alert evaluation failed" });
    }
  });
}
'''
write_new(SERVER / 'operational-observability-routes.ts', routes)

obs_test = r'''import assert from "node:assert/strict";
import test from "node:test";
import { OperationalObservabilityService, normalizeOperationalRoute } from "./operational-observability";

test("S4C normalizes high-cardinality route identifiers", () => {
  assert.equal(normalizeOperationalRoute("/api/mlb/ledger/v1/predictions/123456"), "/api/mlb/ledger/v1/predictions/:id");
  assert.equal(normalizeOperationalRoute("/api/items/abcdef0123456789abcdef0123456789"), "/api/items/:id");
});

test("S4C records bounded request, latency and error metrics", () => {
  const service = new OperationalObservabilityService(2, 2);
  try {
    service.recordRequest("GET", "/api/a/1", 200, 10);
    service.recordRequest("GET", "/api/a/2", 500, 30);
    service.recordRequest("POST", "/api/b", 401, 5);
    service.recordError("GET", "/api/a/2", 500, new Error("provider failed"));
    const snapshot = service.snapshot();
    assert.equal(snapshot.requests.total, 3);
    assert.equal(snapshot.requests.success2xx, 1);
    assert.equal(snapshot.requests.serverErrors5xx, 1);
    assert.equal(snapshot.requests.clientErrors4xx, 1);
    assert.equal(snapshot.requests.maxLatencyMs, 30);
    assert.ok(snapshot.routes.length <= 2);
    assert.equal(snapshot.recentErrors[0].message, "provider failed");
  } finally { service.close(); }
});
'''
write_new(SERVER / 'operational-observability.test.ts', obs_test)

diag_test = r'''import assert from "node:assert/strict";
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
'''
write_new(SERVER / 'operational-diagnostics.test.ts', diag_test)

alert_test = r'''import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationalAlertService } from "./operational-alerts";

function diagnostic(status: "HEALTHY" | "WARN" | "CRITICAL") {
  return {
    evaluate: () => ({
      schemaVersion: "courtedge-diagnostics.v1",
      checkedAt: new Date().toISOString(),
      status,
      checks: status === "HEALTHY" ? [{ code: "OK", status: "HEALTHY", message: "ok" }] : [{ code: "BACKUP_MISSING", status, message: "backup missing" }],
      counts: { healthy: status === "HEALTHY" ? 1 : 0, warnings: status === "WARN" ? 1 : 0, critical: status === "CRITICAL" ? 1 : 0 },
    }),
  } as any;
}

test("S4D appends alerts and deduplicates the same fingerprint during cooldown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s4d-"));
  try {
    const service = new OperationalAlertService(diagnostic("WARN"), root, 60_000);
    const first = await service.evaluate();
    const second = await service.evaluate();
    assert.equal(first.emitted, true);
    assert.equal(second.emitted, false);
    assert.equal(second.reason, "cooldown");
    assert.equal(service.list().length, 1);
    const lines = fs.readFileSync(path.join(root, "operational-alerts.jsonl"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("S4D emits no alert for healthy diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s4d-ok-"));
  try {
    const service = new OperationalAlertService(diagnostic("HEALTHY"), root, 60_000);
    const result = await service.evaluate();
    assert.equal(result.emitted, false);
    assert.equal(result.reason, "healthy");
    assert.equal(service.list().length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
'''
write_new(SERVER / 'operational-alerts.test.ts', alert_test)

runbook = r'''# CourtEdge S4 Operations Runbook

## Objective

Protect the immutable MLB ledger, authentication database, user-owned picks and market history. S4 provides verified backups, isolated restore drills, diagnostics and deduplicated alerts. It does **not** expose a web endpoint that overwrites active data.

## Routine checks

1. Confirm `/health` returns the expected commit and preserves `ledgerOwnership.immutable=true` with `unownedPredictions=0`.
2. Authenticate as an administrator and inspect:
   - `GET /api/ops/v1/status`
   - `GET /api/ops/v1/backups`
   - `GET /api/ops/v1/metrics`
   - `GET /api/ops/v1/diagnostics`
   - `GET /api/ops/v1/alerts`
3. A healthy backup should be verified and no older than `COURTEDGE_BACKUP_MAX_AGE_HOURS` (default 36 hours).
4. A restore drill should pass at least every `COURTEDGE_RESTORE_DRILL_MAX_AGE_DAYS` (default 7 days).

## Manual backup and validation

1. `POST /api/ops/v1/backups` with administrator session + CSRF or the service token.
2. Record the returned `backupId`.
3. `POST /api/ops/v1/backups/{backupId}/verify`.
4. Confirm every present asset reports `integrity=OK`, has a SHA-256 hash and the overall result is valid.

## Isolated restore drill

1. Select a verified backup.
2. `POST /api/ops/v1/backups/{backupId}/restore-drill`.
3. Confirm `valid=true` and `sourceUntouched=true`.
4. Compare restored SQLite table counts with the expected ledger/auth counts.
5. The drill directory is temporary and is deleted automatically. Results remain append-only in `restore-drills.jsonl`.

## Actual disaster restoration

Actual replacement is intentionally an offline maintenance procedure:

1. Declare a maintenance window and stop the backend so SQLite writers and WAL workers are closed.
2. Preserve the damaged volume and create a final forensic copy when readable.
3. Select a backup that passed both verification and an isolated restore drill.
4. Copy restored files to new temporary destination names on the persistent volume.
5. Run `PRAGMA integrity_check` on both SQLite files and parse every JSON asset.
6. Atomically rename the temporary files into their configured source paths.
7. Remove stale `-wal` and `-shm` files only while the application is stopped and only after the restored main SQLite files are in place.
8. After an auth database restoration, delete expired sessions or require fresh login if the incident involved credential/session uncertainty.
9. Start the backend and verify:
   - deployed commit;
   - ledger immutable and WAL;
   - prediction and settlement counts;
   - ownership assignments equal prediction count;
   - zero unowned predictions and zero unowned picks;
   - backup worker and alert worker enabled.
10. Run a new backup and a new isolated restore drill after recovery.

## Rollback

If post-restore validation fails, stop the backend immediately, restore the pre-maintenance volume snapshot, and keep the failed restored files for analysis. Never modify or delete immutable ledger rows to reconcile counts; corrections must remain append-only settlement events.

## Alert interpretation

- `WARN`: resilience is degraded but active data invariants remain intact, such as a missing/stale drill.
- `CRITICAL`: ledger/ownership invariant failed, backup verification failed, backup is severely stale, restore drill failed, or runtime resource/error thresholds are exceeded.
- Identical alerts are deduplicated during `COURTEDGE_ALERT_COOLDOWN_MS` (default 1 hour).
- `COURTEDGE_ALERT_WEBHOOK_URL` is optional. Alerts always remain in `operational-alerts.jsonl` and backend logs even without a webhook.

## Recovery objectives

With daily backups, the default recovery point objective is at most 24 hours for persisted operational assets. Recovery time depends on volume replacement and verification; target an operator-led restoration within 60 minutes after a valid backup is selected.
'''
write_new(DOCS / 'S4-OPERATIONS-RUNBOOK.md', runbook)

# Patch index
index_path = SERVER / 'index.ts'
index = index_path.read_text(encoding='utf-8')
anchor = 'import { registerOperationalRestoreDrillRoutes } from "./operational-restore-routes";\n'
addition = anchor + '''import { getOperationalObservabilityService } from "./operational-observability";
import { OperationalDiagnosticsService } from "./operational-diagnostics";
import { OperationalAlertService } from "./operational-alerts";
import { startOperationalAlertWorker } from "./operational-alert-worker";
import { registerOperationalObservabilityRoutes } from "./operational-observability-routes";
'''
if index.count(anchor) != 1: raise SystemExit('S4CD index import anchor changed')
index = index.replace(anchor, addition, 1)
anchor2 = 'const operationalRestoreDrillService = getOperationalRestoreDrillService(operationalBackupService);\n'
addition2 = anchor2 + '''const operationalObservability = getOperationalObservabilityService();
const operationalDiagnostics = new OperationalDiagnosticsService({
  backup: () => operationalBackupService.status(),
  restoreDrill: () => operationalRestoreDrillService.status(),
  ledger: () => mlbLedgerStore.status(),
  ownership: () => mlbOwnershipStore.status(),
  picks: () => userPickStore.migrationStatus(systemOwnerUserId),
  metrics: () => operationalObservability.snapshot(),
});
const operationalAlerts = new OperationalAlertService(
  operationalDiagnostics,
  operationalBackupService.getRoot(),
);
'''
if index.count(anchor2) != 1: raise SystemExit('S4CD service anchor changed')
index = index.replace(anchor2, addition2, 1)
anchor3 = 'app.use(createSessionMiddleware(authDatabase));\n'
if index.count(anchor3) != 1: raise SystemExit('S4CD middleware anchor changed')
index = index.replace(anchor3, anchor3 + 'app.use(operationalObservability.middleware());\n', 1)
anchor4 = '    operationalRestoreDrill: operationalRestoreDrillService.status(),\n'
index = index.replace(anchor4, anchor4 + '    operationalDiagnostics: (() => { const report = operationalDiagnostics.evaluate(); return { status: report.status, checkedAt: report.checkedAt, counts: report.counts }; })(),\n    operationalAlerts: operationalAlerts.status(),\n', 1)
anchor5 = '  registerOperationalRestoreDrillRoutes(app, operationalRestoreDrillService);\n'
index = index.replace(anchor5, anchor5 + '  registerOperationalObservabilityRoutes(app, operationalObservability, operationalDiagnostics, operationalAlerts);\n', 1)
anchor6 = '  startOperationalBackupWorker(operationalBackupService);\n'
index = index.replace(anchor6, anchor6 + '  startOperationalAlertWorker(operationalAlerts);\n', 1)
old_error = '    console.error("Request error:", err);\n'
index = index.replace(old_error, old_error + '    operationalObservability.recordError(_req.method, _req.path, status, err);\n', 1)
for token in ['operationalObservability.middleware()', 'operationalDiagnostics:', 'startOperationalAlertWorker', 'recordError(_req.method']:
    if token not in index: raise SystemExit(f'S4CD index patch missing {token}')
index_path.write_text(index, encoding='utf-8')

# Package and typecheck
package_path = ROOT / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package['scripts']['test:s4-operations'] = 'tsx --test server/operational-backup.test.ts server/operational-restore-drill.test.ts server/operational-observability.test.ts server/operational-diagnostics.test.ts server/operational-alerts.test.ts'
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

config_path = ROOT / 'tsconfig.s4-operations.json'
config = json.loads(config_path.read_text(encoding='utf-8'))
for item in [
  'server/operational-observability.ts','server/operational-diagnostics.ts','server/operational-alerts.ts','server/operational-alert-worker.ts','server/operational-observability-routes.ts',
  'server/operational-observability.test.ts','server/operational-diagnostics.test.ts','server/operational-alerts.test.ts'
]:
    if item not in config['include']: config['include'].append(item)
config_path.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')

# Contract additions
contract_path = SERVER / 'route-contract.snapshot.json'
contract = json.loads(contract_path.read_text(encoding='utf-8'))
entries = [
  {'method':'GET','path':'/api/ops/v1/metrics','registrations':1},
  {'method':'GET','path':'/api/ops/v1/diagnostics','registrations':1},
  {'method':'GET','path':'/api/ops/v1/alerts','registrations':1},
  {'method':'POST','path':'/api/ops/v1/alerts/evaluate','registrations':1},
]
existing = {(item['method'], item['path']) for item in contract}
for entry in entries:
    key = (entry['method'], entry['path'])
    if key in existing: raise SystemExit(f'S4CD route already present: {key}')
    contract.append(entry)
contract.sort(key=lambda item: (item['method'], item['path']))
contract_path.write_text(json.dumps(contract, indent=2) + '\n', encoding='utf-8')
