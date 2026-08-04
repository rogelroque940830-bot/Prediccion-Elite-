import type { Express } from "express";
import { getMlbLedgerStore } from "./mlb-ledger";
import type { LedgerRecord } from "./mlb-ledger-store";
import {
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import {
  getUserPickFileStore,
  type StoredPickV2,
} from "./picks-v2-multiuser";
import {
  startWnbaShadowWorker,
  type WnbaShadowRecord,
  type WnbaShadowSettlement,
  type WnbaShadowStatus,
} from "./wnba-s6c-shadow-service";
import {
  resolveRequestUserId,
  resolveSystemOwnerUserId,
} from "./user-data-context";

export const OPERATIONAL_INCIDENT_CENTER_VERSION = "courtedge-operational-incident-center.v1" as const;

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
  schemaVersion: typeof OPERATIONAL_INCIDENT_CENTER_VERSION;
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

export interface IncidentCenterInput {
  now?: Date;
  mlbRecords?: LedgerRecord[];
  wnbaRecords?: WnbaShadowRecord[];
  wnbaSettlements?: WnbaShadowSettlement[];
  wnbaStatus?: WnbaShadowStatus | null;
  manualPicks?: StoredPickV2[];
  ledgerStatus?: Record<string, unknown> | null;
  includeResolved?: boolean;
}

const ALL_STATES: OperationalIncidentState[] = [
  "WAITING_FOR_PREGAME_DATA",
  "WAITING_FOR_FINAL_CAPTURE",
  "GAME_IN_PROGRESS",
  "WAITING_FOR_OFFICIAL_FINAL",
  "READY_FOR_SETTLEMENT",
  "SETTLEMENT_OVERDUE",
  "DATA_QUALITY_REVIEW",
  "CORRECTION_REQUIRED",
  "RESOLVED",
];

function floridaDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function roundedMinutes(value: number): number {
  return Math.max(0, Math.round(value * 10) / 10);
}

function latestIso(values: Array<string | null | undefined>): string | null {
  const parsed = values
    .map((value) => value ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  return parsed.length ? new Date(Math.max(...parsed)).toISOString() : null;
}

function ageMinutes(now: Date, updatedAt: string | null): number | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? roundedMinutes((now.getTime() - parsed) / 60_000) : null;
}

function standardAmericanOdds(value: unknown): boolean {
  return typeof value === "number"
    && Number.isInteger(value)
    && value !== 0
    && Math.abs(value) >= 100;
}

function timingState(input: {
  now: Date;
  gameDate: string | null;
  commenceTime: string | null;
  finalCapture: boolean;
}): OperationalIncidentState {
  const commence = input.commenceTime ? Date.parse(input.commenceTime) : NaN;
  if (Number.isFinite(commence)) {
    const hoursSinceStart = (input.now.getTime() - commence) / 3_600_000;
    if (hoursSinceStart < 0) {
      return input.finalCapture ? "WAITING_FOR_PREGAME_DATA" : "WAITING_FOR_FINAL_CAPTURE";
    }
    if (hoursSinceStart <= 8) return "GAME_IN_PROGRESS";
    if (hoursSinceStart <= 18) return "WAITING_FOR_OFFICIAL_FINAL";
    return "SETTLEMENT_OVERDUE";
  }

  if (!input.gameDate) return "DATA_QUALITY_REVIEW";
  const today = floridaDate(input.now);
  if (input.gameDate > today) {
    return input.finalCapture ? "WAITING_FOR_PREGAME_DATA" : "WAITING_FOR_FINAL_CAPTURE";
  }
  if (input.gameDate === today) return "WAITING_FOR_OFFICIAL_FINAL";
  return "SETTLEMENT_OVERDUE";
}

function statePresentation(state: OperationalIncidentState): {
  severity: OperationalIncidentSeverity;
  reasonCode: string;
  message: string;
  nextAction: string;
} {
  switch (state) {
    case "WAITING_FOR_PREGAME_DATA":
      return {
        severity: "INFO",
        reasonCode: "PREGAME_TRACKING_ACTIVE",
        message: "El partido está en seguimiento pregame y todavía no corresponde liquidarlo.",
        nextAction: "Esperar la siguiente captura programada.",
      };
    case "WAITING_FOR_FINAL_CAPTURE":
      return {
        severity: "WARNING",
        reasonCode: "FINAL_CAPTURE_PENDING",
        message: "Existe evidencia provisional, pero falta la captura FINAL prepartido.",
        nextAction: "Verificar lineups, mercado y ejecución del worker FINAL.",
      };
    case "GAME_IN_PROGRESS":
      return {
        severity: "INFO",
        reasonCode: "GAME_ACTIVE",
        message: "El juego comenzó y se encuentra dentro de la ventana normal de actividad.",
        nextAction: "No liquidar todavía; esperar marcador oficial final.",
      };
    case "WAITING_FOR_OFFICIAL_FINAL":
      return {
        severity: "INFO",
        reasonCode: "OFFICIAL_FINAL_PENDING",
        message: "El juego ya debería estar avanzado o terminado, pero falta confirmación oficial final.",
        nextAction: "Volver a consultar la fuente oficial en el próximo ciclo.",
      };
    case "READY_FOR_SETTLEMENT":
      return {
        severity: "WARNING",
        reasonCode: "OFFICIAL_FINAL_AVAILABLE",
        message: "El marcador oficial final está disponible y la decisión puede liquidarse.",
        nextAction: "Ejecutar el settlement seguro e idempotente.",
      };
    case "SETTLEMENT_OVERDUE":
      return {
        severity: "WARNING",
        reasonCode: "SETTLEMENT_SLA_EXCEEDED",
        message: "La decisión continúa sin resolver después de la ventana normal de settlement.",
        nextAction: "Revisar identidad del juego, fuente oficial y worker responsable.",
      };
    case "DATA_QUALITY_REVIEW":
      return {
        severity: "CRITICAL",
        reasonCode: "DATA_QUALITY_BLOCK",
        message: "La evidencia contiene datos incompletos o incompatibles y no debe liquidarse automáticamente.",
        nextAction: "Abrir la evidencia original y corregir la fuente, sin reescribir el historial.",
      };
    case "CORRECTION_REQUIRED":
      return {
        severity: "CRITICAL",
        reasonCode: "SETTLEMENT_CORRECTION_LINK_REQUIRED",
        message: "La liquidación requiere una corrección explícitamente vinculada al evento original.",
        nextAction: "Crear una corrección append-only con correctionOfEventId válido.",
      };
    case "RESOLVED":
      return {
        severity: "INFO",
        reasonCode: "CYCLE_RESOLVED",
        message: "El ciclo tiene resultado registrado y no requiere acción operativa.",
        nextAction: "Ninguna acción requerida.",
      };
  }
}

function gameKey(input: {
  league: OperationalLeague;
  gameId?: string | number | null;
  gameDate?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
}): string {
  if (input.gameId != null && String(input.gameId).trim()) {
    return `${input.league}:${String(input.gameId).trim()}`;
  }
  return [
    input.league,
    input.gameDate ?? "unknown-date",
    String(input.awayTeam ?? "away").trim().toLowerCase(),
    String(input.homeTeam ?? "home").trim().toLowerCase(),
  ].join(":");
}

function buildMlbIncidents(records: LedgerRecord[], now: Date): OperationalIncident[] {
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of records) {
    const key = gameKey({
      league: "MLB",
      gameId: record.prediction.game.gamePk,
      gameDate: record.prediction.game.gameDate,
      homeTeam: record.prediction.game.homeTeam,
      awayTeam: record.prediction.game.awayTeam,
    });
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  return Array.from(groups.entries()).map(([key, group]) => {
    const latest = [...group].sort((a, b) => b.prediction.recordedAtMs - a.prediction.recordedAtMs)[0];
    const unsettled = group.filter((record) => !record.settlement);
    const invalidCorrection = group.some((record) => (
      record.settlement?.source === "correction" && !record.settlement.correctionOfEventId
    ));
    const invalidData = group.some((record) => (
      !standardAmericanOdds(record.prediction.market.oddsAmerican)
      || !record.prediction.game.homeTeam
      || !record.prediction.game.awayTeam
      || !record.prediction.market.type
    ));

    let state: OperationalIncidentState;
    if (invalidCorrection) state = "CORRECTION_REQUIRED";
    else if (invalidData) state = "DATA_QUALITY_REVIEW";
    else if (unsettled.length === 0) state = "RESOLVED";
    else {
      state = timingState({
        now,
        gameDate: latest.prediction.game.gameDate,
        commenceTime: latest.prediction.game.commenceTime,
        finalCapture: unsettled.every((record) => record.prediction.analysisStage === "FINAL"),
      });
    }

    const presentation = statePresentation(state);
    const lastUpdatedAt = latestIso(group.flatMap((record) => [
      record.prediction.recordedAt,
      record.settlement?.recordedAt,
    ]));
    return {
      id: `ops-${key}`,
      league: "MLB",
      gameId: latest.prediction.game.gamePk
        ? String(latest.prediction.game.gamePk)
        : key,
      gameDate: latest.prediction.game.gameDate,
      commenceTime: latest.prediction.game.commenceTime,
      homeTeam: latest.prediction.game.homeTeam,
      awayTeam: latest.prediction.game.awayTeam,
      state,
      ...presentation,
      worker: "mlb-auto-settlement",
      source: "MLB_LEDGER",
      evidenceConfidence: "AUTHORITATIVE",
      lastUpdatedAt,
      ageMinutes: ageMinutes(now, lastUpdatedAt),
      details: {
        records: group.length,
        pendingRecords: unsettled.length,
        finalPendingRecords: unsettled.filter((record) => record.prediction.analysisStage === "FINAL").length,
        markets: Array.from(new Set(group.map((record) => record.prediction.market.type))),
        settlementEvents: group.filter((record) => record.settlement).length,
      },
    };
  });
}

function buildWnbaIncidents(
  records: WnbaShadowRecord[],
  settlements: WnbaShadowSettlement[],
  now: Date,
): OperationalIncident[] {
  const latestByGame = new Map<string, WnbaShadowRecord>();
  for (const record of records) {
    const current = latestByGame.get(record.game.gameId);
    if (!current || record.recordedAtMs > current.recordedAtMs) {
      latestByGame.set(record.game.gameId, record);
    }
  }
  const settlementByPrediction = new Map(settlements.map((event) => [event.predictionId, event]));

  return Array.from(latestByGame.values()).map((record) => {
    const settlement = settlementByPrediction.get(record.id) ?? null;
    let state: OperationalIncidentState;
    if (!standardAmericanOdds(record.market.homeOddsAmerican)
      || !standardAmericanOdds(record.market.awayOddsAmerican)) {
      state = "DATA_QUALITY_REVIEW";
    } else if (settlement) {
      state = "RESOLVED";
    } else {
      state = timingState({
        now,
        gameDate: record.game.gameDate,
        commenceTime: record.game.commenceTime,
        finalCapture: record.analysisStage === "FINAL",
      });
    }
    const presentation = statePresentation(state);
    const lastUpdatedAt = latestIso([record.recordedAt, settlement?.settledAt]);
    return {
      id: `ops-WNBA:${record.game.gameId}`,
      league: "WNBA",
      gameId: record.game.gameId,
      gameDate: record.game.gameDate,
      commenceTime: record.game.commenceTime,
      homeTeam: record.game.homeTeam,
      awayTeam: record.game.awayTeam,
      state,
      ...presentation,
      worker: "wnba-shadow-settlement",
      source: "WNBA_SHADOW",
      evidenceConfidence: "AUTHORITATIVE",
      lastUpdatedAt,
      ageMinutes: ageMinutes(now, lastUpdatedAt),
      details: {
        analysisStage: record.analysisStage,
        dataQualityPct: record.dataQuality.coveragePct,
        degradedSources: record.context.degradedSources,
        settled: Boolean(settlement),
      },
    };
  });
}

function terminalManualResult(result: unknown): boolean {
  const value = String(result ?? "").trim().toUpperCase();
  return ["W", "L", "WIN", "LOSS", "PUSH", "VOID", "HALF_WIN", "HALF_LOSS", "½W", "½L"].includes(value);
}

function pickDate(pick: StoredPickV2): string | null {
  const raw = String(pick.date ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = raw ? Date.parse(raw) : NaN;
  if (Number.isFinite(parsed)) return floridaDate(new Date(parsed));
  if (Number.isFinite(pick.ts)) return floridaDate(new Date(pick.ts));
  return null;
}

function buildManualPickIncidents(picks: StoredPickV2[], now: Date): OperationalIncident[] {
  const supported = picks.filter((pick) => pick.sport === "nba" || pick.sport === "nhl");
  const groups = new Map<string, StoredPickV2[]>();
  for (const pick of supported) {
    const league = pick.sport.toUpperCase() as "NBA" | "NHL";
    const date = pickDate(pick);
    const key = gameKey({
      league,
      gameDate: date,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
    });
    const group = groups.get(key) ?? [];
    group.push(pick);
    groups.set(key, group);
  }

  return Array.from(groups.entries()).map(([key, group]) => {
    const latest = [...group].sort((a, b) => b.ts - a.ts)[0];
    const league = latest.sport.toUpperCase() as "NBA" | "NHL";
    const date = pickDate(latest);
    const unresolved = group.filter((pick) => !terminalManualResult(pick.result));
    let state: OperationalIncidentState;
    if (!date || !latest.homeTeam || !latest.awayTeam) state = "DATA_QUALITY_REVIEW";
    else if (unresolved.length === 0) state = "RESOLVED";
    else state = timingState({ now, gameDate: date, commenceTime: null, finalCapture: true });
    const presentation = statePresentation(state);
    const lastUpdatedAt = new Date(latest.ts).toISOString();
    return {
      id: `ops-${key}`,
      league,
      gameId: key,
      gameDate: date,
      commenceTime: null,
      homeTeam: latest.homeTeam,
      awayTeam: latest.awayTeam,
      state,
      ...presentation,
      worker: `${latest.sport}-manual-result-entry`,
      source: "MANUAL_PICKS",
      evidenceConfidence: "LIMITED",
      lastUpdatedAt,
      ageMinutes: ageMinutes(now, lastUpdatedAt),
      details: {
        picks: group.length,
        unresolvedPicks: unresolved.length,
        markets: Array.from(new Set(group.map((pick) => pick.pickType))),
        note: "El historial manual no contiene una fuente oficial de estado en vivo ni hora exacta de inicio.",
      },
    };
  });
}

function workerFromStatus(
  id: string,
  league: OperationalLeague | "SYSTEM",
  label: string,
  status: {
    enabled?: boolean;
    intervalMs?: number;
    lastRunAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
  } | null | undefined,
  now: Date,
): OperationalWorkerSnapshot {
  const enabled = typeof status?.enabled === "boolean" ? status.enabled : null;
  const intervalMs = typeof status?.intervalMs === "number" && Number.isFinite(status.intervalMs)
    ? status.intervalMs
    : null;
  const lastRunAt = status?.lastRunAt ?? null;
  const lastSuccessAt = status?.lastSuccessAt ?? null;
  const lastError = status?.lastError ?? null;
  const successMs = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
  const lagMinutes = Number.isFinite(successMs)
    ? roundedMinutes((now.getTime() - successMs) / 60_000)
    : null;

  let state: OperationalWorkerState;
  let message: string;
  if (enabled === false) {
    state = "DISABLED";
    message = "Worker deshabilitado por configuración.";
  } else if (lastError) {
    state = "ERROR";
    message = "La última ejecución terminó con error.";
  } else if (!lastSuccessAt) {
    state = "STARTING";
    message = "Todavía no existe una ejecución exitosa registrada.";
  } else {
    const staleAfterMinutes = Math.max(30, ((intervalMs ?? 15 * 60_000) * 2) / 60_000 + 5);
    if ((lagMinutes ?? 0) > staleAfterMinutes) {
      state = "STALE";
      message = `El último éxito supera el SLA operativo de ${Math.round(staleAfterMinutes)} minutos.`;
    } else {
      state = "HEALTHY";
      message = "Heartbeat dentro del SLA esperado.";
    }
  }

  return {
    id,
    league,
    label,
    state,
    enabled,
    intervalMs,
    lastRunAt,
    lastSuccessAt,
    lastError,
    lagMinutes,
    message,
  };
}

function fixedWorker(
  id: string,
  league: OperationalLeague,
  label: string,
  state: "UNINSTRUMENTED" | "MANUAL_ONLY",
  message: string,
): OperationalWorkerSnapshot {
  return {
    id,
    league,
    label,
    state,
    enabled: null,
    intervalMs: null,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lagMinutes: null,
    message,
  };
}

export function buildOperationalIncidentCenter(input: IncidentCenterInput = {}): OperationalIncidentCenterReport {
  const now = input.now ?? new Date();
  const incidents = [
    ...buildMlbIncidents(input.mlbRecords ?? [], now),
    ...buildWnbaIncidents(input.wnbaRecords ?? [], input.wnbaSettlements ?? [], now),
    ...buildManualPickIncidents(input.manualPicks ?? [], now),
  ]
    .filter((incident) => input.includeResolved || incident.state !== "RESOLVED")
    .sort((a, b) => {
      const severityRank = { CRITICAL: 3, WARNING: 2, INFO: 1 } as const;
      const severity = severityRank[b.severity] - severityRank[a.severity];
      if (severity !== 0) return severity;
      return (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1);
    });

  const byState = Object.fromEntries(ALL_STATES.map((state) => [state, 0])) as Record<OperationalIncidentState, number>;
  const byLeague: Record<OperationalLeague, number> = { MLB: 0, WNBA: 0, NBA: 0, NHL: 0 };
  for (const incident of incidents) {
    byState[incident.state] += 1;
    byLeague[incident.league] += 1;
  }

  const workers: OperationalWorkerSnapshot[] = [
    fixedWorker(
      "mlb-auto-settlement",
      "MLB",
      "MLB settlement oficial",
      "UNINSTRUMENTED",
      "El worker existe, pero todavía no publica heartbeat estructurado; O1 muestra sus casos desde el ledger.",
    ),
    workerFromStatus(
      "wnba-shadow-settlement",
      "WNBA",
      "WNBA shadow y settlement",
      input.wnbaStatus,
      now,
    ),
    fixedWorker(
      "nba-manual-result-entry",
      "NBA",
      "Resultados NBA del historial",
      "MANUAL_ONLY",
      "El historial NBA depende de resultado manual y no expone un worker oficial de settlement.",
    ),
    fixedWorker(
      "nhl-manual-result-entry",
      "NHL",
      "Resultados NHL del historial",
      "MANUAL_ONLY",
      "El historial NHL depende de resultado manual y no expone un worker oficial de settlement.",
    ),
  ];

  return {
    schemaVersion: OPERATIONAL_INCIDENT_CENTER_VERSION,
    generatedAt: now.toISOString(),
    incidents,
    workers,
    summary: {
      total: incidents.length,
      unresolved: incidents.filter((incident) => incident.state !== "RESOLVED").length,
      critical: incidents.filter((incident) => incident.severity === "CRITICAL").length,
      warnings: incidents.filter((incident) => incident.severity === "WARNING").length,
      byLeague,
      byState,
    },
    coverage: {
      MLB: {
        source: "immutable MLB ledger",
        evidenceConfidence: "AUTHORITATIVE",
        settlementAutomationObserved: true,
        note: "Estados construidos desde predicciones y settlement events append-only.",
      },
      WNBA: {
        source: "WNBA shadow records and settlement events",
        evidenceConfidence: "AUTHORITATIVE",
        settlementAutomationObserved: true,
        note: "Estados construidos desde el pipeline S6C y su scoreboard oficial.",
      },
      NBA: {
        source: "manual picks history",
        evidenceConfidence: "LIMITED",
        settlementAutomationObserved: false,
        note: "Sin feed oficial de estado ni hora exacta; los vencimientos son orientativos.",
      },
      NHL: {
        source: "manual picks history",
        evidenceConfidence: "LIMITED",
        settlementAutomationObserved: false,
        note: "Sin feed oficial de estado ni hora exacta; los vencimientos son orientativos.",
      },
    },
    safety: {
      mode: "OBSERVE_ONLY",
      readOnly: true,
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
      historicalLedgerMutation: false,
      automaticSettlementRetry: false,
    },
  };
}

function boundedLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.min(1_000, Math.floor(parsed));
}

export function registerOperationalIncidentCenterRoutes(app: Express): void {
  const ledgerStore = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  const pickStore = getUserPickFileStore();
  const defaultOwnerUserId = resolveSystemOwnerUserId();
  const wnbaService = startWnbaShadowWorker().service;

  app.get("/api/ops/v1/incident-center", (req, res) => {
    const userId = resolveRequestUserId(req);
    const limit = boundedLimit(req.query.limit);
    const includeResolved = req.query.includeResolved === "true";
    const mlbRecords = ownedRecordsForUser(
      ledgerStore,
      ownershipStore,
      userId,
      { limit: 10_000 },
    );
    const manualPicks = pickStore.listForUser(userId, defaultOwnerUserId);
    const report = buildOperationalIncidentCenter({
      mlbRecords,
      wnbaRecords: wnbaService.readRecords(),
      wnbaSettlements: wnbaService.readSettlements(),
      wnbaStatus: wnbaService.status(),
      manualPicks,
      ledgerStatus: ledgerStore.status(),
      includeResolved,
    });
    res.json({
      success: true,
      data: {
        ...report,
        incidents: report.incidents.slice(0, limit),
      },
      userId,
    });
  });
}
