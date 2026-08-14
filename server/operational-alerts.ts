import crypto from "node:crypto";
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
