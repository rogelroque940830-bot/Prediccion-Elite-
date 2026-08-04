export type OperationalLeague = "MLB" | "WNBA" | "NBA" | "NHL";
export type OperationalIncidentState =
  | "WAITING_FOR_PREGAME_DATA"
  | "WAITING_FOR_FINAL_CAPTURE"
  | "GAME_IN_PROGRESS"
  | "WAITING_FOR_OFFICIAL_FINAL"
  | "READY_FOR_SETTLEMENT"
  | "SETTLEMENT_OVERDUE"
  | "DATA_QUALITY_REVIEW"
  | "CORRECTION_REQUIRED"
  | "RESOLVED";
export type OperationalIncidentSeverity = "INFO" | "WARNING" | "CRITICAL";
export type OperationalWorkerState =
  | "HEALTHY"
  | "STARTING"
  | "STALE"
  | "ERROR"
  | "DISABLED"
  | "UNINSTRUMENTED"
  | "MANUAL_ONLY";

export interface OperationalIncident {
  id: string;
  league: OperationalLeague;
  gameId: string;
  gameDate: string | null;
  commenceTime: string | null;
  homeTeam: string;
  awayTeam: string;
  state: OperationalIncidentState;
  severity: OperationalIncidentSeverity;
  reasonCode: string;
  message: string;
  nextAction: string;
  worker: string;
  source: "MLB_LEDGER" | "WNBA_SHADOW" | "MANUAL_PICKS";
  evidenceConfidence: "AUTHORITATIVE" | "LIMITED";
  lastUpdatedAt: string | null;
  ageMinutes: number | null;
  details: Record<string, unknown>;
}

export interface OperationalWorkerSnapshot {
  id: string;
  league: OperationalLeague | "SYSTEM";
  label: string;
  state: OperationalWorkerState;
  enabled: boolean | null;
  intervalMs: number | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lagMinutes: number | null;
  message: string;
}

export interface OperationalIncidentCenterReport {
  schemaVersion: "courtedge-operational-incident-center.v1";
  generatedAt: string;
  incidents: OperationalIncident[];
  workers: OperationalWorkerSnapshot[];
  summary: {
    total: number;
    unresolved: number;
    critical: number;
    warnings: number;
    byLeague: Record<OperationalLeague, number>;
    byState: Record<OperationalIncidentState, number>;
  };
  coverage: Record<OperationalLeague, {
    source: string;
    evidenceConfidence: "AUTHORITATIVE" | "LIMITED";
    settlementAutomationObserved: boolean;
    note: string;
  }>;
  safety: {
    mode: "OBSERVE_ONLY";
    readOnly: true;
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
    historicalLedgerMutation: false;
    automaticSettlementRetry: false;
  };
}

export interface IncidentCenterEnvelope {
  success: boolean;
  data: OperationalIncidentCenterReport;
  userId: number;
}

export interface IncidentFilters {
  league: OperationalLeague | "ALL";
  state: OperationalIncidentState | "ALL";
  severity: OperationalIncidentSeverity | "ALL";
  search: string;
}

export const INCIDENT_STATE_LABELS: Record<OperationalIncidentState, string> = {
  WAITING_FOR_PREGAME_DATA: "Seguimiento pregame",
  WAITING_FOR_FINAL_CAPTURE: "Falta captura FINAL",
  GAME_IN_PROGRESS: "Juego en progreso",
  WAITING_FOR_OFFICIAL_FINAL: "Esperando final oficial",
  READY_FOR_SETTLEMENT: "Listo para liquidar",
  SETTLEMENT_OVERDUE: "Settlement vencido",
  DATA_QUALITY_REVIEW: "Revisar calidad de datos",
  CORRECTION_REQUIRED: "Corrección requerida",
  RESOLVED: "Resuelto",
};

export const WORKER_STATE_LABELS: Record<OperationalWorkerState, string> = {
  HEALTHY: "Saludable",
  STARTING: "Iniciando",
  STALE: "Atrasado",
  ERROR: "Error",
  DISABLED: "Deshabilitado",
  UNINSTRUMENTED: "Sin heartbeat",
  MANUAL_ONLY: "Flujo manual",
};

export function filterOperationalIncidents(
  incidents: OperationalIncident[],
  filters: IncidentFilters,
): OperationalIncident[] {
  const search = filters.search.trim().toLowerCase();
  return incidents.filter((incident) => {
    if (filters.league !== "ALL" && incident.league !== filters.league) return false;
    if (filters.state !== "ALL" && incident.state !== filters.state) return false;
    if (filters.severity !== "ALL" && incident.severity !== filters.severity) return false;
    if (!search) return true;
    const haystack = [
      incident.homeTeam,
      incident.awayTeam,
      incident.gameId,
      incident.reasonCode,
      incident.worker,
      incident.message,
      incident.nextAction,
    ].join(" ").toLowerCase();
    return haystack.includes(search);
  });
}

export function incidentStateLabel(state: OperationalIncidentState): string {
  return INCIDENT_STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

export function workerStateLabel(state: OperationalWorkerState): string {
  return WORKER_STATE_LABELS[state] ?? state.replace(/_/g, " ");
}

export function operationalAgeLabel(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "Sin hora verificable";
  if (minutes < 1) return "Actualizado ahora";
  if (minutes < 60) return `Hace ${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `Hace ${hours.toFixed(hours < 10 ? 1 : 0)} h`;
  const days = hours / 24;
  return `Hace ${days.toFixed(days < 10 ? 1 : 0)} d`;
}

export function formatOperationalDate(raw: string | null): string {
  if (!raw) return "Fecha no disponible";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return raw;
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: raw.includes("T") ? "numeric" : undefined,
    minute: raw.includes("T") ? "2-digit" : undefined,
  }).format(new Date(parsed));
}

export function operationalSafetyValid(
  safety: OperationalIncidentCenterReport["safety"] | null | undefined,
): boolean {
  return Boolean(safety
    && safety.mode === "OBSERVE_ONLY"
    && safety.readOnly === true
    && safety.realFinancialExposure === 0
    && safety.automaticBetPlacement === false
    && safety.automaticModelChangesAllowed === false
    && safety.automaticPromotionAllowed === false
    && safety.historicalLedgerMutation === false
    && safety.automaticSettlementRetry === false);
}
