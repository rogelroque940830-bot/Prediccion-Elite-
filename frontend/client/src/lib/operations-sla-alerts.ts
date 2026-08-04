import type { OperationalLeague } from "./operations-incident-center";

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
  schemaVersion: "courtedge-operational-sla-alert.v1";
  policyVersion: "courtedge-operational-sla-policy.v1";
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

export interface OperationalSlaStatus {
  schemaVersion: "courtedge-operational-sla-policy.v1";
  ownerUserId: number;
  events: number;
  active: number;
  activeCritical: number;
  activeWarnings: number;
  latestEventAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastIncidentReportGeneratedAt: string | null;
  lastCandidateCount: number;
  lastEmittedCount: number;
  lastSuppressedLimitedEvidence: number;
  webhookConfigured: boolean;
  warningReminderMs: number;
  criticalReminderMs: number;
  policy: {
    finalCaptureWarningMinutes: number;
    finalCaptureCriticalMinutes: number;
    settlementCriticalAfterMinutes: number;
    readyForSettlementCriticalAfterMinutes: number;
    limitedEvidenceTimedAlerts: false;
  };
  safety: OperationalSlaSafety;
}

export interface OperationalSlaAlertEnvelope {
  success: boolean;
  data: OperationalSlaAlertEvent[];
  status: OperationalSlaStatus;
  ownerUserId: number;
}

export interface OperationalSlaFilters {
  mode: "ACTIVE" | "HISTORY";
  league: OperationalLeague | "SYSTEM" | "ALL";
  severity: OperationalSlaSeverity | "ALL";
  search: string;
}

export const SLA_EVENT_LABELS: Record<OperationalSlaEventType, string> = {
  OPENED: "Abierta",
  ESCALATED: "Escalada",
  REMINDER: "Recordatorio",
  RESOLVED: "Resuelta",
};

export function latestOperationalSlaEvents(
  events: OperationalSlaAlertEvent[],
): OperationalSlaAlertEvent[] {
  const latest = new Map<string, OperationalSlaAlertEvent>();
  for (const event of [...events].sort((left, right) => right.emittedAtMs - left.emittedAtMs)) {
    if (!latest.has(event.alertKey)) latest.set(event.alertKey, event);
  }
  return [...latest.values()].sort((left, right) => {
    const severity = (right.severity === "CRITICAL" ? 2 : 1) - (left.severity === "CRITICAL" ? 2 : 1);
    if (severity !== 0) return severity;
    return right.sla.breachedByMinutes - left.sla.breachedByMinutes;
  });
}

export function activeOperationalSlaAlerts(
  events: OperationalSlaAlertEvent[],
): OperationalSlaAlertEvent[] {
  return latestOperationalSlaEvents(events).filter((event) => event.eventType !== "RESOLVED");
}

export function filterOperationalSlaEvents(
  events: OperationalSlaAlertEvent[],
  filters: OperationalSlaFilters,
): OperationalSlaAlertEvent[] {
  const source = filters.mode === "ACTIVE" ? activeOperationalSlaAlerts(events) : events;
  const search = filters.search.trim().toLowerCase();
  return source.filter((event) => {
    if (filters.league !== "ALL" && event.league !== filters.league) return false;
    if (filters.severity !== "ALL" && event.severity !== filters.severity) return false;
    if (!search) return true;
    return [
      event.homeTeam,
      event.awayTeam,
      event.gameId,
      event.workerId,
      event.alertKey,
      event.reasonCode,
      event.summary,
      event.nextAction,
      event.sla.policyCode,
    ].filter(Boolean).join(" ").toLowerCase().includes(search);
  });
}

export function slaEventTypeLabel(eventType: OperationalSlaEventType): string {
  return SLA_EVENT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}

export function slaDurationLabel(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return "Sin medición";
  if (minutes < 1) return "Menos de 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  const days = hours / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)} d`;
}

export function operationalSlaSafetyValid(
  safety: OperationalSlaSafety | null | undefined,
): boolean {
  return Boolean(
    safety
    && safety.mode === "OBSERVE_ONLY"
    && safety.readOnly === true
    && safety.realFinancialExposure === 0
    && safety.automaticBetPlacement === false
    && safety.automaticSettlementRetry === false
    && safety.historicalLedgerMutation === false
    && safety.automaticModelChangesAllowed === false
    && safety.automaticPromotionAllowed === false
  );
}
