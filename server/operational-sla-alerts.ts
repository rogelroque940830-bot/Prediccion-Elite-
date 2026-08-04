import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMlbLedgerStore } from "./mlb-ledger";
import {
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import {
  buildOperationalIncidentCenter,
  type OperationalIncident,
  type OperationalIncidentCenterReport,
  type OperationalLeague,
  type OperationalWorkerSnapshot,
} from "./operational-incident-center";
import { getUserPickFileStore } from "./picks-v2-multiuser";
import { startWnbaShadowWorker } from "./wnba-s6c-shadow-service";

export const OPERATIONAL_SLA_ALERT_VERSION = "courtedge-operational-sla-alert.v1" as const;
export const OPERATIONAL_SLA_POLICY_VERSION = "courtedge-operational-sla-policy.v1" as const;

export type OperationalSlaSeverity = "WARNING" | "CRITICAL";
export type OperationalSlaEventType = "OPENED" | "ESCALATED" | "REMINDER" | "RESOLVED";
export type OperationalSlaSourceType = "INCIDENT" | "WORKER";

export interface OperationalSlaMeasurement {
  policyCode: string;
  targetMinutes: number;
  observedMinutes: number;
  breachedByMinutes: number;
  deadlineAt: string | null;
}

export interface OperationalSlaAlertEvent {
  schemaVersion: typeof OPERATIONAL_SLA_ALERT_VERSION;
  policyVersion: typeof OPERATIONAL_SLA_POLICY_VERSION;
  eventId: string;
  ownerUserId: number;
  emittedAt: string;
  emittedAtMs: number;
  eventType: OperationalSlaEventType;
  alertKey: string;
  severity: OperationalSlaSeverity;
  sourceType: OperationalSlaSourceType;
  league: OperationalLeague | "SYSTEM";
  incidentId: string | null;
  workerId: string | null;
  gameId: string | null;
  gameDate: string | null;
  commenceTime: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  state: string;
  reasonCode: string;
  summary: string;
  nextAction: string;
  evidenceConfidence: "AUTHORITATIVE" | "LIMITED" | "SYSTEM";
  sla: OperationalSlaMeasurement;
  fingerprint: string;
  delivered: {
    console: true;
    webhook: boolean;
    webhookError?: string;
  };
}

export interface OperationalSlaCandidate {
  alertKey: string;
  severity: OperationalSlaSeverity;
  sourceType: OperationalSlaSourceType;
  league: OperationalLeague | "SYSTEM";
  incidentId: string | null;
  workerId: string | null;
  gameId: string | null;
  gameDate: string | null;
  commenceTime: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  state: string;
  reasonCode: string;
  summary: string;
  nextAction: string;
  evidenceConfidence: "AUTHORITATIVE" | "LIMITED" | "SYSTEM";
  sla: OperationalSlaMeasurement;
}

export interface OperationalSlaEvaluation {
  schemaVersion: typeof OPERATIONAL_SLA_POLICY_VERSION;
  evaluatedAt: string;
  ownerUserId: number;
  incidentReportGeneratedAt: string;
  candidates: number;
  emitted: OperationalSlaAlertEvent[];
  suppressed: {
    cooldown: number;
    limitedEvidence: number;
    nonActionable: number;
    manualOrUninstrumentedWorkers: number;
  };
  active: OperationalSlaAlertEvent[];
  safety: OperationalSlaSafety;
}

export interface OperationalSlaSafety {
  mode: "OBSERVE_ONLY";
  readOnly: true;
  realFinancialExposure: 0;
  automaticBetPlacement: false;
  automaticSettlementRetry: false;
  historicalLedgerMutation: false;
  automaticModelChangesAllowed: false;
  automaticPromotionAllowed: false;
}

interface RuntimeState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastIncidentReportGeneratedAt: string | null;
  lastCandidateCount: number;
  lastEmittedCount: number;
  lastSuppressedLimitedEvidence: number;
}

interface CandidateBuildResult {
  candidates: OperationalSlaCandidate[];
  suppressed: {
    limitedEvidence: number;
    nonActionable: number;
    manualOrUninstrumentedWorkers: number;
  };
}

export type OperationalIncidentCenterProvider = (
  ownerUserId: number,
) => OperationalIncidentCenterReport | Promise<OperationalIncidentCenterReport>;

const SAFETY: OperationalSlaSafety = {
  mode: "OBSERVE_ONLY",
  readOnly: true,
  realFinancialExposure: 0,
  automaticBetPlacement: false,
  automaticSettlementRetry: false,
  historicalLedgerMutation: false,
  automaticModelChangesAllowed: false,
  automaticPromotionAllowed: false,
};

const WARNING_REMINDER_MS = positiveMs(
  process.env.COURTEDGE_O2_WARNING_REMINDER_MS,
  60 * 60 * 1000,
);
const CRITICAL_REMINDER_MS = positiveMs(
  process.env.COURTEDGE_O2_CRITICAL_REMINDER_MS,
  30 * 60 * 1000,
);
const FINAL_CAPTURE_WARNING_MINUTES = positiveNumber(
  process.env.COURTEDGE_O2_FINAL_CAPTURE_WARNING_MINUTES,
  45,
);
const FINAL_CAPTURE_CRITICAL_MINUTES = positiveNumber(
  process.env.COURTEDGE_O2_FINAL_CAPTURE_CRITICAL_MINUTES,
  10,
);
const SETTLEMENT_CRITICAL_AFTER_MINUTES = positiveNumber(
  process.env.COURTEDGE_O2_SETTLEMENT_CRITICAL_AFTER_MINUTES,
  6 * 60,
);
const READY_FOR_SETTLEMENT_CRITICAL_AFTER_MINUTES = positiveNumber(
  process.env.COURTEDGE_O2_READY_CRITICAL_AFTER_MINUTES,
  60,
);

function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeOwnerUserId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Invalid O2 owner user id");
  return parsed;
}

function roundedMinutes(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

function parsedTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: number | null): string | null {
  return value == null || !Number.isFinite(value) ? null : new Date(value).toISOString();
}

function severityRank(value: OperationalSlaSeverity): number {
  return value === "CRITICAL" ? 2 : 1;
}

function eventFingerprint(input: {
  alertKey: string;
  eventType: OperationalSlaEventType;
  severity: OperationalSlaSeverity;
  policyCode: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(`${input.alertKey}|${input.eventType}|${input.severity}|${input.policyCode}`)
    .digest("hex")
    .slice(0, 24);
}

function incidentMeasurement(
  incident: OperationalIncident,
  nowMs: number,
  policyCode: string,
  deadlineMs: number | null,
  targetMinutes: number,
): OperationalSlaMeasurement {
  const observedMinutes = incident.ageMinutes ?? 0;
  const breachedByMinutes = deadlineMs == null
    ? observedMinutes
    : roundedMinutes((nowMs - deadlineMs) / 60_000);
  return {
    policyCode,
    targetMinutes,
    observedMinutes: roundedMinutes(observedMinutes),
    breachedByMinutes,
    deadlineAt: iso(deadlineMs),
  };
}

function incidentCandidate(
  incident: OperationalIncident,
  nowMs: number,
): { candidate: OperationalSlaCandidate | null; limitedEvidenceSuppressed: boolean; nonActionable: boolean } {
  const base = {
    sourceType: "INCIDENT" as const,
    league: incident.league,
    incidentId: incident.id,
    workerId: null,
    gameId: incident.gameId,
    gameDate: incident.gameDate,
    commenceTime: incident.commenceTime,
    homeTeam: incident.homeTeam,
    awayTeam: incident.awayTeam,
    state: incident.state,
    evidenceConfidence: incident.evidenceConfidence,
  };

  if (incident.state === "DATA_QUALITY_REVIEW") {
    return {
      candidate: {
        ...base,
        alertKey: `INCIDENT:${incident.id}:DATA_QUALITY`,
        severity: "CRITICAL",
        reasonCode: "O2_DATA_QUALITY_BLOCK",
        summary: `${incident.awayTeam} vs ${incident.homeTeam}: evidencia bloqueada por calidad de datos.`,
        nextAction: incident.nextAction,
        sla: incidentMeasurement(incident, nowMs, "DATA_QUALITY_IMMEDIATE", nowMs, 0),
      },
      limitedEvidenceSuppressed: false,
      nonActionable: false,
    };
  }

  if (incident.state === "CORRECTION_REQUIRED") {
    return {
      candidate: {
        ...base,
        alertKey: `INCIDENT:${incident.id}:CORRECTION_REQUIRED`,
        severity: "CRITICAL",
        reasonCode: "O2_APPEND_ONLY_CORRECTION_REQUIRED",
        summary: `${incident.awayTeam} vs ${incident.homeTeam}: la corrección debe vincularse al evento original.`,
        nextAction: incident.nextAction,
        sla: incidentMeasurement(incident, nowMs, "CORRECTION_IMMEDIATE", nowMs, 0),
      },
      limitedEvidenceSuppressed: false,
      nonActionable: false,
    };
  }

  if (incident.evidenceConfidence === "LIMITED") {
    const potentiallyTimed = [
      "WAITING_FOR_FINAL_CAPTURE",
      "READY_FOR_SETTLEMENT",
      "SETTLEMENT_OVERDUE",
    ].includes(incident.state);
    return {
      candidate: null,
      limitedEvidenceSuppressed: potentiallyTimed,
      nonActionable: !potentiallyTimed,
    };
  }

  const commenceMs = parsedTime(incident.commenceTime);
  if (incident.state === "WAITING_FOR_FINAL_CAPTURE") {
    if (commenceMs == null) {
      return {
        candidate: null,
        limitedEvidenceSuppressed: false,
        nonActionable: true,
      };
    }
    const warningDeadline = commenceMs - FINAL_CAPTURE_WARNING_MINUTES * 60_000;
    if (nowMs < warningDeadline) {
      return {
        candidate: null,
        limitedEvidenceSuppressed: false,
        nonActionable: true,
      };
    }
    const criticalDeadline = commenceMs - FINAL_CAPTURE_CRITICAL_MINUTES * 60_000;
    const severity: OperationalSlaSeverity = nowMs >= criticalDeadline ? "CRITICAL" : "WARNING";
    return {
      candidate: {
        ...base,
        alertKey: `INCIDENT:${incident.id}:FINAL_CAPTURE_DUE`,
        severity,
        reasonCode: severity === "CRITICAL"
          ? "O2_FINAL_CAPTURE_CRITICAL_WINDOW"
          : "O2_FINAL_CAPTURE_WARNING_WINDOW",
        summary: `${incident.awayTeam} vs ${incident.homeTeam}: falta captura FINAL cerca del inicio.`,
        nextAction: incident.nextAction,
        sla: incidentMeasurement(
          incident,
          nowMs,
          "FINAL_CAPTURE_BEFORE_TIP",
          warningDeadline,
          FINAL_CAPTURE_WARNING_MINUTES,
        ),
      },
      limitedEvidenceSuppressed: false,
      nonActionable: false,
    };
  }

  if (incident.state === "READY_FOR_SETTLEMENT") {
    const observed = incident.ageMinutes ?? 0;
    const severity: OperationalSlaSeverity = observed >= READY_FOR_SETTLEMENT_CRITICAL_AFTER_MINUTES
      ? "CRITICAL"
      : "WARNING";
    const deadlineMs = parsedTime(incident.lastUpdatedAt);
    return {
      candidate: {
        ...base,
        alertKey: `INCIDENT:${incident.id}:READY_FOR_SETTLEMENT`,
        severity,
        reasonCode: severity === "CRITICAL"
          ? "O2_READY_FOR_SETTLEMENT_CRITICAL"
          : "O2_READY_FOR_SETTLEMENT_PENDING",
        summary: `${incident.awayTeam} vs ${incident.homeTeam}: existe final oficial pendiente de settlement seguro.`,
        nextAction: incident.nextAction,
        sla: incidentMeasurement(
          incident,
          nowMs,
          "READY_FOR_SETTLEMENT",
          deadlineMs,
          READY_FOR_SETTLEMENT_CRITICAL_AFTER_MINUTES,
        ),
      },
      limitedEvidenceSuppressed: false,
      nonActionable: false,
    };
  }

  if (incident.state === "SETTLEMENT_OVERDUE") {
    const settlementDeadline = commenceMs == null ? null : commenceMs + 18 * 60 * 60 * 1000;
    const overdueMinutes = settlementDeadline == null
      ? incident.ageMinutes ?? 0
      : roundedMinutes((nowMs - settlementDeadline) / 60_000);
    const severity: OperationalSlaSeverity = overdueMinutes >= SETTLEMENT_CRITICAL_AFTER_MINUTES
      ? "CRITICAL"
      : "WARNING";
    return {
      candidate: {
        ...base,
        alertKey: `INCIDENT:${incident.id}:SETTLEMENT_OVERDUE`,
        severity,
        reasonCode: severity === "CRITICAL"
          ? "O2_SETTLEMENT_CRITICALLY_OVERDUE"
          : "O2_SETTLEMENT_SLA_BREACH",
        summary: `${incident.awayTeam} vs ${incident.homeTeam}: settlement vencido fuera del SLA operativo.`,
        nextAction: incident.nextAction,
        sla: {
          policyCode: "SETTLEMENT_AFTER_OFFICIAL_FINAL_WINDOW",
          targetMinutes: 18 * 60,
          observedMinutes: incident.ageMinutes ?? overdueMinutes,
          breachedByMinutes: overdueMinutes,
          deadlineAt: iso(settlementDeadline),
        },
      },
      limitedEvidenceSuppressed: false,
      nonActionable: false,
    };
  }

  return {
    candidate: null,
    limitedEvidenceSuppressed: false,
    nonActionable: true,
  };
}

function workerCandidate(
  worker: OperationalWorkerSnapshot,
  report: OperationalIncidentCenterReport,
): { candidate: OperationalSlaCandidate | null; manualOrUninstrumented: boolean; nonActionable: boolean } {
  if (worker.state === "MANUAL_ONLY" || worker.state === "UNINSTRUMENTED") {
    return { candidate: null, manualOrUninstrumented: true, nonActionable: false };
  }
  if (worker.state === "HEALTHY" || worker.state === "STARTING") {
    return { candidate: null, manualOrUninstrumented: false, nonActionable: true };
  }

  const leagueIncidents = worker.league === "SYSTEM"
    ? report.incidents
    : report.incidents.filter((incident) => incident.league === worker.league);
  if (worker.state === "DISABLED" && leagueIncidents.length === 0) {
    return { candidate: null, manualOrUninstrumented: false, nonActionable: true };
  }

  const intervalMinutes = worker.intervalMs == null ? 15 : worker.intervalMs / 60_000;
  const staleTarget = Math.max(30, intervalMinutes * 2 + 5);
  const lagMinutes = worker.lagMinutes ?? 0;
  let severity: OperationalSlaSeverity;
  let policyCode: string;
  if (worker.state === "ERROR") {
    severity = "CRITICAL";
    policyCode = "WORKER_ERROR_IMMEDIATE";
  } else if (worker.state === "DISABLED") {
    severity = leagueIncidents.some((incident) => incident.severity === "CRITICAL")
      ? "CRITICAL"
      : "WARNING";
    policyCode = "WORKER_DISABLED_WITH_OPEN_INCIDENTS";
  } else {
    severity = lagMinutes >= Math.max(120, staleTarget * 4) ? "CRITICAL" : "WARNING";
    policyCode = "WORKER_HEARTBEAT_STALE";
  }

  return {
    candidate: {
      alertKey: `WORKER:${worker.id}`,
      severity,
      sourceType: "WORKER",
      league: worker.league,
      incidentId: null,
      workerId: worker.id,
      gameId: null,
      gameDate: null,
      commenceTime: null,
      homeTeam: null,
      awayTeam: null,
      state: worker.state,
      reasonCode: `O2_${worker.state}`,
      summary: `${worker.label}: ${worker.message}`,
      nextAction: worker.state === "ERROR"
        ? "Revisar el último error y confirmar una ejecución exitosa antes de cualquier intervención."
        : worker.state === "DISABLED"
          ? "Confirmar la configuración del worker y los incidentes abiertos de la liga."
          : "Revisar heartbeat, conectividad y última ejecución exitosa.",
      evidenceConfidence: "SYSTEM",
      sla: {
        policyCode,
        targetMinutes: staleTarget,
        observedMinutes: lagMinutes,
        breachedByMinutes: roundedMinutes(Math.max(0, lagMinutes - staleTarget)),
        deadlineAt: worker.lastSuccessAt
          ? iso((parsedTime(worker.lastSuccessAt) ?? 0) + staleTarget * 60_000)
          : null,
      },
    },
    manualOrUninstrumented: false,
    nonActionable: false,
  };
}

export function buildOperationalSlaCandidates(
  report: OperationalIncidentCenterReport,
  now: Date = new Date(report.generatedAt),
): CandidateBuildResult {
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const candidates: OperationalSlaCandidate[] = [];
  let limitedEvidence = 0;
  let nonActionable = 0;
  let manualOrUninstrumentedWorkers = 0;

  for (const incident of report.incidents) {
    const result = incidentCandidate(incident, nowMs);
    if (result.candidate) candidates.push(result.candidate);
    if (result.limitedEvidenceSuppressed) limitedEvidence += 1;
    if (result.nonActionable) nonActionable += 1;
  }

  for (const worker of report.workers) {
    const result = workerCandidate(worker, report);
    if (result.candidate) candidates.push(result.candidate);
    if (result.manualOrUninstrumented) manualOrUninstrumentedWorkers += 1;
    if (result.nonActionable) nonActionable += 1;
  }

  candidates.sort((left, right) => (
    severityRank(right.severity) - severityRank(left.severity)
    || right.sla.breachedByMinutes - left.sla.breachedByMinutes
    || left.alertKey.localeCompare(right.alertKey)
  ));

  return {
    candidates,
    suppressed: {
      limitedEvidence,
      nonActionable,
      manualOrUninstrumentedWorkers,
    },
  };
}

function runtimeInitial(): RuntimeState {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastIncidentReportGeneratedAt: null,
    lastCandidateCount: 0,
    lastEmittedCount: 0,
    lastSuppressedLimitedEvidence: 0,
  };
}

export class OperationalSlaAlertService {
  private readonly runtime = new Map<number, RuntimeState>();

  constructor(
    private readonly provider: OperationalIncidentCenterProvider,
    private readonly root: string,
    private readonly warningReminderMs = WARNING_REMINDER_MS,
    private readonly criticalReminderMs = CRITICAL_REMINDER_MS,
  ) {}

  private file(ownerUserId: number): string {
    const owner = safeOwnerUserId(ownerUserId);
    return path.join(this.root, `operational-sla-alerts-user-${owner}.jsonl`);
  }

  private runtimeFor(ownerUserId: number): RuntimeState {
    const owner = safeOwnerUserId(ownerUserId);
    const current = this.runtime.get(owner) ?? runtimeInitial();
    this.runtime.set(owner, current);
    return current;
  }

  list(ownerUserId: number, limit = 250): OperationalSlaAlertEvent[] {
    const filename = this.file(ownerUserId);
    if (!fs.existsSync(filename)) return [];
    const safeLimit = Math.max(1, Math.min(10_000, Math.floor(limit)));
    return fs
      .readFileSync(filename, "utf-8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as OperationalSlaAlertEvent;
          return parsed?.schemaVersion === OPERATIONAL_SLA_ALERT_VERSION ? [parsed] : [];
        } catch {
          return [];
        }
      })
      .slice(-safeLimit)
      .reverse();
  }

  active(ownerUserId: number): OperationalSlaAlertEvent[] {
    const latestByKey = new Map<string, OperationalSlaAlertEvent>();
    for (const event of this.list(ownerUserId, 10_000)) {
      if (!latestByKey.has(event.alertKey)) latestByKey.set(event.alertKey, event);
    }
    return [...latestByKey.values()]
      .filter((event) => event.eventType !== "RESOLVED")
      .sort((left, right) => (
        severityRank(right.severity) - severityRank(left.severity)
        || right.sla.breachedByMinutes - left.sla.breachedByMinutes
      ));
  }

  status(ownerUserId: number) {
    const runtime = this.runtimeFor(ownerUserId);
    const events = this.list(ownerUserId, 10_000);
    const active = this.active(ownerUserId);
    return {
      schemaVersion: OPERATIONAL_SLA_POLICY_VERSION,
      ownerUserId: safeOwnerUserId(ownerUserId),
      events: events.length,
      active: active.length,
      activeCritical: active.filter((event) => event.severity === "CRITICAL").length,
      activeWarnings: active.filter((event) => event.severity === "WARNING").length,
      latestEventAt: events[0]?.emittedAt ?? null,
      lastRunAt: runtime.lastRunAt,
      lastSuccessAt: runtime.lastSuccessAt,
      lastError: runtime.lastError,
      lastIncidentReportGeneratedAt: runtime.lastIncidentReportGeneratedAt,
      lastCandidateCount: runtime.lastCandidateCount,
      lastEmittedCount: runtime.lastEmittedCount,
      lastSuppressedLimitedEvidence: runtime.lastSuppressedLimitedEvidence,
      webhookConfigured: Boolean(
        process.env.COURTEDGE_O2_ALERT_WEBHOOK_URL
        || process.env.COURTEDGE_ALERT_WEBHOOK_URL,
      ),
      warningReminderMs: this.warningReminderMs,
      criticalReminderMs: this.criticalReminderMs,
      policy: {
        finalCaptureWarningMinutes: FINAL_CAPTURE_WARNING_MINUTES,
        finalCaptureCriticalMinutes: FINAL_CAPTURE_CRITICAL_MINUTES,
        settlementCriticalAfterMinutes: SETTLEMENT_CRITICAL_AFTER_MINUTES,
        readyForSettlementCriticalAfterMinutes: READY_FOR_SETTLEMENT_CRITICAL_AFTER_MINUTES,
        limitedEvidenceTimedAlerts: false,
      },
      safety: SAFETY,
    };
  }

  private latestByKey(ownerUserId: number): Map<string, OperationalSlaAlertEvent> {
    const result = new Map<string, OperationalSlaAlertEvent>();
    for (const event of this.list(ownerUserId, 10_000)) {
      if (!result.has(event.alertKey)) result.set(event.alertKey, event);
    }
    return result;
  }

  private async deliver(event: OperationalSlaAlertEvent): Promise<void> {
    if (event.eventType === "RESOLVED") {
      console.info(`[o2-sla] RESOLVED ${event.alertKey} ${event.summary}`);
    } else if (event.severity === "CRITICAL") {
      console.error(`[o2-sla] ${event.eventType} CRITICAL ${event.alertKey} ${event.summary}`);
    } else {
      console.warn(`[o2-sla] ${event.eventType} WARNING ${event.alertKey} ${event.summary}`);
    }

    const webhook = (
      process.env.COURTEDGE_O2_ALERT_WEBHOOK_URL
      || process.env.COURTEDGE_ALERT_WEBHOOK_URL
      || ""
    ).trim();
    if (!webhook) return;
    try {
      const response = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, safety: SAFETY }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
      event.delivered.webhook = true;
    } catch (error) {
      event.delivered.webhookError = String(
        error instanceof Error ? error.message : error,
      ).slice(0, 300);
    }
  }

  private async appendEvent(
    ownerUserId: number,
    input: OperationalSlaCandidate,
    eventType: OperationalSlaEventType,
    now: Date,
  ): Promise<OperationalSlaAlertEvent> {
    const owner = safeOwnerUserId(ownerUserId);
    const emittedAtMs = now.getTime();
    const event: OperationalSlaAlertEvent = {
      schemaVersion: OPERATIONAL_SLA_ALERT_VERSION,
      policyVersion: OPERATIONAL_SLA_POLICY_VERSION,
      eventId: `o2-sla-${emittedAtMs}-${crypto.randomBytes(5).toString("hex")}`,
      ownerUserId: owner,
      emittedAt: now.toISOString(),
      emittedAtMs,
      eventType,
      alertKey: input.alertKey,
      severity: input.severity,
      sourceType: input.sourceType,
      league: input.league,
      incidentId: input.incidentId,
      workerId: input.workerId,
      gameId: input.gameId,
      gameDate: input.gameDate,
      commenceTime: input.commenceTime,
      homeTeam: input.homeTeam,
      awayTeam: input.awayTeam,
      state: input.state,
      reasonCode: input.reasonCode,
      summary: eventType === "RESOLVED"
        ? `Resuelta: ${input.summary}`
        : input.summary,
      nextAction: eventType === "RESOLVED"
        ? "Ninguna acción operativa pendiente."
        : input.nextAction,
      evidenceConfidence: input.evidenceConfidence,
      sla: input.sla,
      fingerprint: eventFingerprint({
        alertKey: input.alertKey,
        eventType,
        severity: input.severity,
        policyCode: input.sla.policyCode,
      }),
      delivered: { console: true, webhook: false },
    };
    await this.deliver(event);
    const filename = this.file(owner);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.appendFileSync(filename, `${JSON.stringify(event)}\n`, "utf-8");
    return event;
  }

  async evaluate(
    ownerUserId: number,
    reportOverride?: OperationalIncidentCenterReport,
    nowOverride?: Date,
  ): Promise<OperationalSlaEvaluation> {
    const owner = safeOwnerUserId(ownerUserId);
    const runtime = this.runtimeFor(owner);
    const startedAt = nowOverride ?? new Date();
    runtime.lastRunAt = startedAt.toISOString();

    try {
      const report = reportOverride ?? await this.provider(owner);
      if (report.schemaVersion !== "courtedge-operational-incident-center.v1") {
        throw new Error("O2 received an incompatible incident-center report");
      }
      const evaluatedAt = nowOverride ?? new Date(report.generatedAt);
      const now = Number.isFinite(evaluatedAt.getTime()) ? evaluatedAt : startedAt;
      const built = buildOperationalSlaCandidates(report, now);
      const latest = this.latestByKey(owner);
      const candidateByKey = new Map(built.candidates.map((candidate) => [candidate.alertKey, candidate]));
      const emitted: OperationalSlaAlertEvent[] = [];
      let cooldown = 0;

      for (const candidate of built.candidates) {
        const previous = latest.get(candidate.alertKey);
        let eventType: OperationalSlaEventType | null = null;
        if (!previous || previous.eventType === "RESOLVED") {
          eventType = "OPENED";
        } else if (severityRank(candidate.severity) > severityRank(previous.severity)) {
          eventType = "ESCALATED";
        } else {
          const reminderMs = candidate.severity === "CRITICAL"
            ? this.criticalReminderMs
            : this.warningReminderMs;
          if (now.getTime() - previous.emittedAtMs >= reminderMs) eventType = "REMINDER";
          else cooldown += 1;
        }
        if (eventType) {
          const event = await this.appendEvent(owner, candidate, eventType, now);
          emitted.push(event);
          latest.set(candidate.alertKey, event);
        }
      }

      for (const previous of latest.values()) {
        if (previous.eventType === "RESOLVED" || candidateByKey.has(previous.alertKey)) continue;
        const resolutionCandidate: OperationalSlaCandidate = {
          alertKey: previous.alertKey,
          severity: previous.severity,
          sourceType: previous.sourceType,
          league: previous.league,
          incidentId: previous.incidentId,
          workerId: previous.workerId,
          gameId: previous.gameId,
          gameDate: previous.gameDate,
          commenceTime: previous.commenceTime,
          homeTeam: previous.homeTeam,
          awayTeam: previous.awayTeam,
          state: "RESOLVED",
          reasonCode: "O2_ALERT_CONDITION_CLEARED",
          summary: previous.summary.replace(/^Resuelta:\s*/i, ""),
          nextAction: "Ninguna acción operativa pendiente.",
          evidenceConfidence: previous.evidenceConfidence,
          sla: previous.sla,
        };
        emitted.push(await this.appendEvent(owner, resolutionCandidate, "RESOLVED", now));
      }

      runtime.lastSuccessAt = now.toISOString();
      runtime.lastError = null;
      runtime.lastIncidentReportGeneratedAt = report.generatedAt;
      runtime.lastCandidateCount = built.candidates.length;
      runtime.lastEmittedCount = emitted.length;
      runtime.lastSuppressedLimitedEvidence = built.suppressed.limitedEvidence;

      return {
        schemaVersion: OPERATIONAL_SLA_POLICY_VERSION,
        evaluatedAt: now.toISOString(),
        ownerUserId: owner,
        incidentReportGeneratedAt: report.generatedAt,
        candidates: built.candidates.length,
        emitted,
        suppressed: {
          cooldown,
          limitedEvidence: built.suppressed.limitedEvidence,
          nonActionable: built.suppressed.nonActionable,
          manualOrUninstrumentedWorkers: built.suppressed.manualOrUninstrumentedWorkers,
        },
        active: this.active(owner),
        safety: SAFETY,
      };
    } catch (error) {
      runtime.lastError = String(error instanceof Error ? error.message : error).slice(0, 500);
      throw error;
    }
  }
}

export function createOperationalIncidentCenterProvider(
  defaultOwnerUserId: number,
): OperationalIncidentCenterProvider {
  const ledgerStore = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  const pickStore = getUserPickFileStore();
  const wnbaService = startWnbaShadowWorker().service;
  const defaultOwner = safeOwnerUserId(defaultOwnerUserId);

  return (ownerUserId: number) => {
    const owner = safeOwnerUserId(ownerUserId);
    return buildOperationalIncidentCenter({
      mlbRecords: ownedRecordsForUser(
        ledgerStore,
        ownershipStore,
        owner,
        { limit: 10_000 },
      ),
      wnbaRecords: wnbaService.readRecords(),
      wnbaSettlements: wnbaService.readSettlements(),
      wnbaStatus: wnbaService.status(),
      manualPicks: pickStore.listForUser(owner, defaultOwner),
      ledgerStatus: ledgerStore.status(),
      includeResolved: false,
    });
  };
}
