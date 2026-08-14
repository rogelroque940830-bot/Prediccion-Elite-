import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getMlbClosingLineStore, getMlbLedgerStore } from "./mlb-ledger";
import {
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import type {
  LedgerPrediction,
  LedgerRecord,
  LedgerSettlement,
  MlbSettlementInput,
} from "./mlb-ledger-store";
import {
  gradeMlbPrediction,
  type OfficialMlbGame,
} from "./mlb-settlement-worker";
import {
  createOperationalIncidentCenterProvider,
  type OperationalIncidentCenterProvider,
} from "./operational-sla-alerts";
import type {
  OperationalIncident,
  OperationalLeague,
} from "./operational-incident-center";

const MLB_API = "https://statsapi.mlb.com/api";
const DEFAULT_PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_TARGETS_PER_PLAN = 50;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const CONFIRMATION_PHRASE = "REPROCESS_ONE_MLB_GAME";

export const OPERATIONAL_REPROCESSING_PLAN_VERSION =
  "courtedge-operational-reprocessing-plan.v1" as const;
export const OPERATIONAL_REPROCESSING_AUDIT_VERSION =
  "courtedge-operational-reprocessing-audit.v1" as const;
export const OPERATIONAL_REPROCESSING_STATUS_VERSION =
  "courtedge-operational-reprocessing-status.v1" as const;

export type OperationalReprocessingPlanState = "READY" | "BLOCKED";
export type OperationalReprocessingExecutionState =
  | "COMPLETED"
  | "IDEMPOTENT_REPLAY"
  | "PARTIAL_FAILURE"
  | "BLOCKED";
export type OperationalReprocessingAuditType =
  | "PREVIEW_CREATED"
  | "PREVIEW_BLOCKED"
  | "EXECUTION_STARTED"
  | "SETTLEMENT_APPENDED"
  | "SETTLEMENT_IDEMPOTENT"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_BLOCKED"
  | "EXECUTION_FAILED";

export interface OperationalReprocessingSafety {
  mode: "SHADOW_CONTROLLED_REPROCESSING";
  shadowOnly: true;
  realFinancialExposure: 0;
  automaticExecution: false;
  requiresExplicitPreview: true;
  requiresPlanDigest: true;
  requiresAdminExecution: true;
  requiresConfirmationPhrase: true;
  singleGameOnly: true;
  appendOnlySettlementEvents: true;
  historicalLedgerMutation: false;
  automaticSettlementRetry: false;
  automaticBetPlacement: false;
  automaticModelChangesAllowed: false;
  automaticPromotionAllowed: false;
  supportedLeagues: ["MLB"];
}

export interface OperationalReprocessingTarget {
  predictionId: string;
  payloadSha256: string;
  analysisStage: string;
  marketType: string;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  currentSettlementEventId: string | null;
}

export interface OperationalReprocessingProposal {
  predictionId: string;
  result: MlbSettlementInput["result"];
  outcomeValue: number;
  finalScore: { home: number; away: number };
  notes: string;
  closingOddsAmerican: number | null;
  closingLine: number | null;
}

export interface OperationalReprocessingPlan {
  schemaVersion: typeof OPERATIONAL_REPROCESSING_PLAN_VERSION;
  planId: string;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  state: OperationalReprocessingPlanState;
  incident: {
    id: string;
    league: OperationalLeague;
    gameId: string;
    gameDate: string | null;
    commenceTime: string | null;
    homeTeam: string;
    awayTeam: string;
    state: string;
    evidenceConfidence: string;
  };
  officialEvidence: {
    gamePk: number;
    gameDate: string;
    homeTeam: string;
    awayTeam: string;
    finalScore: { home: number; away: number };
    inningsDigest: string;
  } | null;
  targets: OperationalReprocessingTarget[];
  proposals: OperationalReprocessingProposal[];
  blockers: string[];
  warnings: string[];
  preconditionDigest: string;
  planDigest: string;
  confirmationPhrase: typeof CONFIRMATION_PHRASE;
  safety: OperationalReprocessingSafety;
}

export interface OperationalReprocessingExecution {
  schemaVersion: "courtedge-operational-reprocessing-execution.v1";
  executionId: string;
  planId: string;
  planDigest: string;
  ownerUserId: number;
  idempotencyKey: string;
  requestDigest: string;
  startedAt: string;
  completedAt: string;
  state: OperationalReprocessingExecutionState;
  appended: number;
  idempotent: number;
  verified: number;
  failed: Array<{ predictionId: string; error: string }>;
  settlementEventIds: string[];
  safety: OperationalReprocessingSafety;
}

export interface OperationalReprocessingAuditEvent {
  schemaVersion: typeof OPERATIONAL_REPROCESSING_AUDIT_VERSION;
  eventId: string;
  ownerUserId: number;
  recordedAt: string;
  recordedAtMs: number;
  eventType: OperationalReprocessingAuditType;
  planId: string;
  executionId: string | null;
  incidentId: string;
  gameId: string;
  predictionId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  previousDigest: string | null;
  eventDigest: string;
}

export interface OperationalReprocessingStatus {
  schemaVersion: typeof OPERATIONAL_REPROCESSING_STATUS_VERSION;
  ownerUserId: number;
  plans: number;
  readyPlans: number;
  blockedPlans: number;
  executions: number;
  completedExecutions: number;
  partialFailures: number;
  latestPlanAt: string | null;
  latestExecutionAt: string | null;
  confirmationPhrase: typeof CONFIRMATION_PHRASE;
  planTtlMs: number;
  maxTargetsPerPlan: number;
  supportedLeagues: ["MLB"];
  safety: OperationalReprocessingSafety;
}

export interface OperationalReprocessingDependencies {
  rootDir: string;
  incidentProvider: OperationalIncidentCenterProvider;
  recordsProvider: (ownerUserId: number) => LedgerRecord[];
  officialGameProvider: (prediction: LedgerPrediction) => Promise<OfficialMlbGame | null>;
  appendSettlement: (
    predictionId: string,
    input: MlbSettlementInput,
  ) => { data: LedgerSettlement; idempotent: boolean };
  latestSettlement: (predictionId: string) => LedgerSettlement | null;
  closingProvider?: (
    predictionId: string,
    commenceTime: string | null,
  ) => { oddsAmerican: number; line: number | null; matchMode: string; comparable: boolean } | null;
  now?: () => Date;
  planTtlMs?: number;
}

const SAFETY: OperationalReprocessingSafety = {
  mode: "SHADOW_CONTROLLED_REPROCESSING",
  shadowOnly: true,
  realFinancialExposure: 0,
  automaticExecution: false,
  requiresExplicitPreview: true,
  requiresPlanDigest: true,
  requiresAdminExecution: true,
  requiresConfirmationPhrase: true,
  singleGameOnly: true,
  appendOnlySettlementEvents: true,
  historicalLedgerMutation: false,
  automaticSettlementRetry: false,
  automaticBetPlacement: false,
  automaticModelChangesAllowed: false,
  automaticPromotionAllowed: false,
  supportedLeagues: ["MLB"],
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function generatedId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function positiveOwner(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error("Invalid O3 owner user id"), { status: 400 });
  }
  return parsed;
}

function safeId(value: unknown, label: string): string {
  const text = String(value ?? "").trim();
  if (!ID_PATTERN.test(text)) {
    throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  }
  return text;
}

function normalize(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function teamAlias(value: string): string {
  return value
    .replace(/^oakland/, "")
    .replace(/^athletics/, "")
    .replace(/^theathletics/, "");
}

function sameTeam(left: string, right: string): boolean {
  return left === right || teamAlias(left) === teamAlias(right);
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "CourtEdge-O3-Controlled-Reprocessing/1.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`MLB API ${response.status}: ${url}`);
  return response.json();
}

function gameFromFeed(gamePk: number, payload: any): OfficialMlbGame | null {
  const status = payload?.gameData?.status;
  const final =
    status?.abstractGameState === "Final" ||
    status?.codedGameState === "F" ||
    status?.detailedState === "Final";
  if (!final) return null;

  const linescore = payload?.liveData?.linescore;
  const innings = (linescore?.innings ?? [])
    .map((inning: any) => ({
      num: Number(inning.num),
      home: Number(inning.home?.runs ?? 0),
      away: Number(inning.away?.runs ?? 0),
    }))
    .filter((inning: { num: number }) => Number.isFinite(inning.num));

  const homeScore = Number(
    linescore?.teams?.home?.runs ??
      innings.reduce((sum: number, inning: { home: number }) => sum + inning.home, 0),
  );
  const awayScore = Number(
    linescore?.teams?.away?.runs ??
      innings.reduce((sum: number, inning: { away: number }) => sum + inning.away, 0),
  );

  return {
    gamePk,
    gameDate: String(
      payload?.gameData?.datetime?.officialDate ||
        payload?.gameData?.datetime?.dateTime ||
        "",
    ).slice(0, 10),
    final,
    homeTeam: payload?.gameData?.teams?.home?.name || "Home",
    awayTeam: payload?.gameData?.teams?.away?.name || "Away",
    homeScore,
    awayScore,
    innings,
  };
}

async function officialGameForPrediction(
  prediction: LedgerPrediction,
): Promise<OfficialMlbGame | null> {
  let gamePk = prediction.game.gamePk;
  if (!gamePk) {
    const payload = await fetchJson(
      `${MLB_API}/v1/schedule?sportId=1&date=${encodeURIComponent(prediction.game.gameDate)}`,
    );
    const games = (payload?.dates ?? []).flatMap((entry: any) => entry.games ?? []);
    const expectedHome = normalize(prediction.game.homeTeam);
    const expectedAway = normalize(prediction.game.awayTeam);
    const candidates = games.filter((game: any) => {
      const officialHome = normalize(game?.teams?.home?.team?.name || "");
      const officialAway = normalize(game?.teams?.away?.team?.name || "");
      return (
        (sameTeam(officialHome, expectedHome) && sameTeam(officialAway, expectedAway)) ||
        (sameTeam(officialHome, expectedAway) && sameTeam(officialAway, expectedHome))
      );
    });

    if (candidates.length === 1) {
      gamePk = Number(candidates[0]?.gamePk) || null;
    } else if (candidates.length > 1 && prediction.game.commenceTime) {
      const expectedStart = Date.parse(prediction.game.commenceTime);
      const ranked = candidates
        .map((game: any) => ({
          gamePk: Number(game?.gamePk) || 0,
          distance: Math.abs(Date.parse(game?.gameDate || "") - expectedStart),
        }))
        .filter((entry: { gamePk: number; distance: number }) => (
          entry.gamePk > 0 && Number.isFinite(entry.distance)
        ))
        .sort((left: { distance: number }, right: { distance: number }) => (
          left.distance - right.distance
        ));
      if (
        ranked.length > 0 &&
        !(ranked.length > 1 && ranked[0].distance === ranked[1].distance)
      ) {
        gamePk = ranked[0].gamePk;
      }
    }
  }

  if (!gamePk) return null;
  const payload = await fetchJson(`${MLB_API}/v1.1/game/${gamePk}/feed/live`);
  return gameFromFeed(gamePk, payload);
}

function incidentSnapshot(incident: OperationalIncident): OperationalReprocessingPlan["incident"] {
  return {
    id: incident.id,
    league: incident.league,
    gameId: incident.gameId,
    gameDate: incident.gameDate,
    commenceTime: incident.commenceTime,
    homeTeam: incident.homeTeam,
    awayTeam: incident.awayTeam,
    state: incident.state,
    evidenceConfidence: incident.evidenceConfidence,
  };
}

function recordMatchesIncident(record: LedgerRecord, incident: OperationalIncident): boolean {
  if (record.prediction.game.gamePk && /^\d+$/.test(incident.gameId)) {
    return String(record.prediction.game.gamePk) === incident.gameId;
  }
  return (
    record.prediction.game.gameDate === incident.gameDate &&
    normalize(record.prediction.game.homeTeam) === normalize(incident.homeTeam) &&
    normalize(record.prediction.game.awayTeam) === normalize(incident.awayTeam)
  );
}

function targetFromRecord(record: LedgerRecord): OperationalReprocessingTarget {
  return {
    predictionId: record.prediction.id,
    payloadSha256: record.prediction.payloadSha256,
    analysisStage: record.prediction.analysisStage,
    marketType: record.prediction.market.type,
    selection: record.prediction.market.selection,
    line: record.prediction.market.line,
    oddsAmerican: record.prediction.market.oddsAmerican,
    currentSettlementEventId: record.settlement?.eventId ?? null,
  };
}

function planDigestPayload(plan: Omit<OperationalReprocessingPlan, "planDigest">): unknown {
  return plan;
}

function requestDigestPayload(input: {
  planId: string;
  planDigest: string;
  idempotencyKey: string;
  confirmation: string;
  reason: string;
}): unknown {
  return {
    planId: input.planId,
    planDigest: input.planDigest,
    idempotencyKey: input.idempotencyKey,
    confirmation: input.confirmation,
    reason: input.reason,
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeExclusive(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function listJsonFiles<T>(directory: string): T[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<T>(path.join(directory, name)));
}

export class OperationalReprocessingService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly running = new Set<string>();

  constructor(private readonly deps: OperationalReprocessingDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = typeof deps.planTtlMs === "number"
      && Number.isFinite(deps.planTtlMs)
      && deps.planTtlMs >= 60_000
      ? deps.planTtlMs
      : DEFAULT_PLAN_TTL_MS;
    fs.mkdirSync(this.deps.rootDir, { recursive: true });
  }

  private ownerRoot(ownerUserId: number): string {
    return path.join(this.deps.rootDir, `owner-${positiveOwner(ownerUserId)}`);
  }

  private planPath(ownerUserId: number, planId: string): string {
    return path.join(this.ownerRoot(ownerUserId), "plans", `${safeId(planId, "plan id")}.json`);
  }

  private executionPath(ownerUserId: number, idempotencyKey: string): string {
    const key = safeId(idempotencyKey, "idempotency key");
    return path.join(this.ownerRoot(ownerUserId), "executions", `${sha256(key).slice(0, 32)}.json`);
  }

  private auditPath(ownerUserId: number): string {
    return path.join(this.ownerRoot(ownerUserId), "audit.jsonl");
  }

  private auditEvents(ownerUserId: number): OperationalReprocessingAuditEvent[] {
    const filePath = this.auditPath(ownerUserId);
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OperationalReprocessingAuditEvent);
  }

  private appendAudit(input: Omit<
    OperationalReprocessingAuditEvent,
    "schemaVersion" | "eventId" | "recordedAt" | "recordedAtMs" | "previousDigest" | "eventDigest"
  >): OperationalReprocessingAuditEvent {
    const events = this.auditEvents(input.ownerUserId);
    const previousDigest = events.at(-1)?.eventDigest ?? null;
    const recordedAtMs = this.now().getTime();
    const base = {
      schemaVersion: OPERATIONAL_REPROCESSING_AUDIT_VERSION,
      eventId: generatedId("o3-audit"),
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      previousDigest,
      ...input,
    };
    const eventDigest = sha256(canonicalJson(base));
    const event: OperationalReprocessingAuditEvent = { ...base, eventDigest };
    const filePath = this.auditPath(input.ownerUserId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  audit(ownerUserId: number, limit = 250): OperationalReprocessingAuditEvent[] {
    const bounded = Math.min(1_000, Math.max(1, Math.floor(limit)));
    return this.auditEvents(positiveOwner(ownerUserId))
      .sort((left, right) => right.recordedAtMs - left.recordedAtMs)
      .slice(0, bounded);
  }

  getPlan(ownerUserId: number, planId: string): OperationalReprocessingPlan {
    const filePath = this.planPath(ownerUserId, planId);
    if (!fs.existsSync(filePath)) {
      throw Object.assign(new Error("O3 reprocessing plan not found"), { status: 404 });
    }
    const plan = readJson<OperationalReprocessingPlan>(filePath);
    if (plan.ownerUserId !== positiveOwner(ownerUserId)) {
      throw Object.assign(new Error("O3 plan ownership mismatch"), { status: 403 });
    }
    const { planDigest, ...withoutDigest } = plan;
    const expected = sha256(canonicalJson(planDigestPayload(withoutDigest)));
    if (expected !== planDigest) {
      throw Object.assign(new Error("O3 plan digest mismatch"), { status: 409 });
    }
    return plan;
  }

  status(ownerUserId: number): OperationalReprocessingStatus {
    const owner = positiveOwner(ownerUserId);
    const plans = listJsonFiles<OperationalReprocessingPlan>(
      path.join(this.ownerRoot(owner), "plans"),
    );
    const executions = listJsonFiles<OperationalReprocessingExecution>(
      path.join(this.ownerRoot(owner), "executions"),
    );
    const latestPlanAt = plans
      .map((plan) => Date.parse(plan.createdAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    const latestExecutionAt = executions
      .map((execution) => Date.parse(execution.completedAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];

    return {
      schemaVersion: OPERATIONAL_REPROCESSING_STATUS_VERSION,
      ownerUserId: owner,
      plans: plans.length,
      readyPlans: plans.filter((plan) => plan.state === "READY").length,
      blockedPlans: plans.filter((plan) => plan.state === "BLOCKED").length,
      executions: executions.length,
      completedExecutions: executions.filter((entry) => (
        entry.state === "COMPLETED" || entry.state === "IDEMPOTENT_REPLAY"
      )).length,
      partialFailures: executions.filter((entry) => entry.state === "PARTIAL_FAILURE").length,
      latestPlanAt: Number.isFinite(latestPlanAt)
        ? new Date(latestPlanAt).toISOString()
        : null,
      latestExecutionAt: Number.isFinite(latestExecutionAt)
        ? new Date(latestExecutionAt).toISOString()
        : null,
      confirmationPhrase: CONFIRMATION_PHRASE,
      planTtlMs: this.ttlMs,
      maxTargetsPerPlan: MAX_TARGETS_PER_PLAN,
      supportedLeagues: ["MLB"],
      safety: SAFETY,
    };
  }

  async preview(
    ownerUserId: number,
    raw: { incidentId?: unknown; league?: unknown },
  ): Promise<OperationalReprocessingPlan> {
    const owner = positiveOwner(ownerUserId);
    const incidentId = safeId(raw.incidentId, "incident id");
    if (raw.league != null && String(raw.league).toUpperCase() !== "MLB") {
      throw Object.assign(new Error("O3 currently supports MLB only"), { status: 400 });
    }

    const report = await this.deps.incidentProvider(owner);
    const incident = report.incidents.find((entry) => entry.id === incidentId);
    if (!incident) {
      throw Object.assign(new Error("Operational incident not found"), { status: 404 });
    }

    const blockers: string[] = [];
    const warnings: string[] = [];
    if (incident.league !== "MLB") blockers.push("UNSUPPORTED_LEAGUE");
    if (incident.evidenceConfidence !== "AUTHORITATIVE") {
      blockers.push("AUTHORITATIVE_EVIDENCE_REQUIRED");
    }
    if (!["READY_FOR_SETTLEMENT", "SETTLEMENT_OVERDUE"].includes(incident.state)) {
      blockers.push("INCIDENT_NOT_ELIGIBLE_FOR_REPROCESSING");
    }

    const records = this.deps.recordsProvider(owner)
      .filter((record) => recordMatchesIncident(record, incident));
    const unsettled = records.filter((record) => !record.settlement);
    if (unsettled.length === 0) blockers.push("NO_UNSETTLED_OWNED_RECORDS");
    if (unsettled.length > MAX_TARGETS_PER_PLAN) blockers.push("TARGET_LIMIT_EXCEEDED");
    if (unsettled.some((record) => record.prediction.analysisStage !== "FINAL")) {
      blockers.push("NON_FINAL_PREDICTION_PRESENT");
    }

    const targets = unsettled.slice(0, MAX_TARGETS_PER_PLAN).map(targetFromRecord);
    let officialGame: OfficialMlbGame | null = null;
    const proposals: OperationalReprocessingProposal[] = [];

    if (blockers.length === 0 && unsettled[0]) {
      try {
        officialGame = await this.deps.officialGameProvider(unsettled[0].prediction);
        if (!officialGame?.final) {
          blockers.push("OFFICIAL_FINAL_NOT_AVAILABLE");
        } else {
          for (const record of unsettled) {
            const graded = gradeMlbPrediction(record.prediction, officialGame);
            if (!graded) {
              blockers.push(`UNSUPPORTED_OR_AMBIGUOUS_MARKET:${record.prediction.id}`);
              continue;
            }
            const closing = this.deps.closingProvider?.(
              record.prediction.id,
              record.prediction.game.commenceTime,
            );
            const exactClosing = closing?.matchMode === "EXACT_BOOK" && closing.comparable
              ? closing
              : null;
            proposals.push({
              predictionId: record.prediction.id,
              result: graded.result,
              outcomeValue: graded.outcomeValue,
              finalScore: {
                home: officialGame.homeScore,
                away: officialGame.awayScore,
              },
              notes: `${graded.notes} · MLB gamePk ${officialGame.gamePk} · O3 controlled preview`,
              closingOddsAmerican: exactClosing?.oddsAmerican ?? null,
              closingLine: exactClosing?.line ?? null,
            });
          }
        }
      } catch (error) {
        blockers.push("OFFICIAL_SOURCE_ERROR");
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (proposals.length !== targets.length && blockers.length === 0) {
      blockers.push("INCOMPLETE_SETTLEMENT_PLAN");
    }

    const now = this.now();
    const planId = generatedId("o3-plan");
    const officialEvidence = officialGame
      ? {
          gamePk: officialGame.gamePk,
          gameDate: officialGame.gameDate,
          homeTeam: officialGame.homeTeam,
          awayTeam: officialGame.awayTeam,
          finalScore: {
            home: officialGame.homeScore,
            away: officialGame.awayScore,
          },
          inningsDigest: sha256(canonicalJson(officialGame.innings)),
        }
      : null;
    const preconditionDigest = sha256(canonicalJson({
      incident: incidentSnapshot(incident),
      targets,
      officialEvidence,
      proposals,
    }));
    const withoutDigest: Omit<OperationalReprocessingPlan, "planDigest"> = {
      schemaVersion: OPERATIONAL_REPROCESSING_PLAN_VERSION,
      planId,
      ownerUserId: owner,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      state: blockers.length === 0 ? "READY" : "BLOCKED",
      incident: incidentSnapshot(incident),
      officialEvidence,
      targets,
      proposals,
      blockers,
      warnings,
      preconditionDigest,
      confirmationPhrase: CONFIRMATION_PHRASE,
      safety: SAFETY,
    };
    const plan: OperationalReprocessingPlan = {
      ...withoutDigest,
      planDigest: sha256(canonicalJson(planDigestPayload(withoutDigest))),
    };

    writeExclusive(this.planPath(owner, planId), plan);
    this.appendAudit({
      ownerUserId: owner,
      eventType: plan.state === "READY" ? "PREVIEW_CREATED" : "PREVIEW_BLOCKED",
      planId,
      executionId: null,
      incidentId: incident.id,
      gameId: incident.gameId,
      predictionId: null,
      message: plan.state === "READY"
        ? `O3 preview created for ${targets.length} settlement targets`
        : `O3 preview blocked: ${blockers.join(", ")}`,
      metadata: {
        targets: targets.length,
        proposals: proposals.length,
        blockers,
        preconditionDigest,
        planDigest: plan.planDigest,
      },
    });
    return plan;
  }

  async execute(
    ownerUserId: number,
    raw: {
      planId?: unknown;
      planDigest?: unknown;
      idempotencyKey?: unknown;
      confirmation?: unknown;
      reason?: unknown;
    },
  ): Promise<OperationalReprocessingExecution> {
    const owner = positiveOwner(ownerUserId);
    const planId = safeId(raw.planId, "plan id");
    const suppliedPlanDigest = String(raw.planDigest ?? "").trim();
    const idempotencyKey = safeId(raw.idempotencyKey, "idempotency key");
    const confirmation = String(raw.confirmation ?? "").trim();
    const reason = String(raw.reason ?? "").trim();

    if (confirmation !== CONFIRMATION_PHRASE) {
      throw Object.assign(new Error("Exact O3 confirmation phrase required"), { status: 400 });
    }
    if (reason.length < 10 || reason.length > 500) {
      throw Object.assign(new Error("O3 execution reason must contain 10 to 500 characters"), {
        status: 400,
      });
    }

    const requestDigest = sha256(canonicalJson(requestDigestPayload({
      planId,
      planDigest: suppliedPlanDigest,
      idempotencyKey,
      confirmation,
      reason,
    })));
    const existingPath = this.executionPath(owner, idempotencyKey);
    if (fs.existsSync(existingPath)) {
      const existing = readJson<OperationalReprocessingExecution>(existingPath);
      if (existing.requestDigest !== requestDigest) {
        throw Object.assign(new Error("O3 idempotency key already used with another request"), {
          status: 409,
        });
      }
      return { ...existing, state: "IDEMPOTENT_REPLAY" };
    }

    const lockKey = `${owner}:${planId}`;
    if (this.running.has(lockKey)) {
      throw Object.assign(new Error("O3 execution already running for this plan"), { status: 409 });
    }
    this.running.add(lockKey);

    const executionId = generatedId("o3-exec");
    const startedAt = this.now().toISOString();
    let incidentId = "unknown";
    let gameId = "unknown";

    try {
      const plan = this.getPlan(owner, planId);
      incidentId = plan.incident.id;
      gameId = plan.incident.gameId;
      if (plan.planDigest !== suppliedPlanDigest) {
        throw Object.assign(new Error("O3 supplied plan digest does not match"), { status: 409 });
      }
      if (plan.state !== "READY") {
        throw Object.assign(new Error(`O3 plan is ${plan.state}`), { status: 409 });
      }
      if (Date.parse(plan.expiresAt) <= this.now().getTime()) {
        throw Object.assign(new Error("O3 plan expired; create a new preview"), { status: 409 });
      }
      if (
        plan.incident.league !== "MLB" ||
        !["READY_FOR_SETTLEMENT", "SETTLEMENT_OVERDUE"].includes(plan.incident.state)
      ) {
        throw Object.assign(new Error("O3 plan is outside the approved MLB incident scope"), {
          status: 409,
        });
      }

      this.appendAudit({
        ownerUserId: owner,
        eventType: "EXECUTION_STARTED",
        planId,
        executionId,
        incidentId,
        gameId,
        predictionId: null,
        message: `O3 controlled execution started: ${reason}`,
        metadata: { requestDigest, idempotencyKey, targets: plan.targets.length },
      });

      const currentRecords = this.deps.recordsProvider(owner);
      const recordById = new Map(currentRecords.map((record) => [record.prediction.id, record]));
      const firstRecord = recordById.get(plan.targets[0]?.predictionId ?? "");
      if (!firstRecord) {
        throw Object.assign(new Error("O3 target records are no longer available"), { status: 409 });
      }
      const officialGame = await this.deps.officialGameProvider(firstRecord.prediction);
      if (!officialGame?.final) {
        throw Object.assign(new Error("Official MLB final is unavailable during execution"), {
          status: 409,
        });
      }

      const appendedEventIds: string[] = [];
      let appended = 0;
      let idempotent = 0;
      let verified = 0;
      const failed: Array<{ predictionId: string; error: string }> = [];

      for (const target of plan.targets) {
        const record = recordById.get(target.predictionId);
        if (!record || record.prediction.payloadSha256 !== target.payloadSha256) {
          failed.push({
            predictionId: target.predictionId,
            error: "TARGET_IDENTITY_DRIFT",
          });
          continue;
        }

        const deterministicRequestId = `o3:${plan.planId}:${target.predictionId}:official-v1`;
        const currentSettlement = this.deps.latestSettlement(target.predictionId);
        if (currentSettlement) {
          if (currentSettlement.clientRequestId === deterministicRequestId) {
            idempotent++;
            verified++;
            appendedEventIds.push(currentSettlement.eventId);
            this.appendAudit({
              ownerUserId: owner,
              eventType: "SETTLEMENT_IDEMPOTENT",
              planId,
              executionId,
              incidentId,
              gameId,
              predictionId: target.predictionId,
              message: "Existing O3 settlement verified idempotently",
              metadata: { settlementEventId: currentSettlement.eventId },
            });
            continue;
          }
          failed.push({
            predictionId: target.predictionId,
            error: "SETTLED_BY_DIFFERENT_EVENT_AFTER_PREVIEW",
          });
          continue;
        }

        const proposal = plan.proposals.find((item) => item.predictionId === target.predictionId);
        const graded = gradeMlbPrediction(record.prediction, officialGame);
        if (!proposal || !graded) {
          failed.push({
            predictionId: target.predictionId,
            error: "EXECUTION_GRADE_UNAVAILABLE",
          });
          continue;
        }
        if (
          graded.result !== proposal.result ||
          graded.outcomeValue !== proposal.outcomeValue ||
          officialGame.homeScore !== proposal.finalScore.home ||
          officialGame.awayScore !== proposal.finalScore.away
        ) {
          failed.push({
            predictionId: target.predictionId,
            error: "OFFICIAL_EVIDENCE_CHANGED_AFTER_PREVIEW",
          });
          continue;
        }

        try {
          const written = this.deps.appendSettlement(target.predictionId, {
            clientRequestId: deterministicRequestId,
            result: proposal.result,
            closingOddsAmerican: proposal.closingOddsAmerican ?? undefined,
            closingLine: proposal.closingLine ?? undefined,
            outcomeValue: proposal.outcomeValue,
            finalScore: proposal.finalScore,
            source: "official",
            notes: `${proposal.notes} · operator reason: ${reason}`,
          });
          const latest = this.deps.latestSettlement(target.predictionId);
          if (
            !latest ||
            latest.eventId !== written.data.eventId ||
            latest.result !== proposal.result ||
            latest.finalScore?.home !== proposal.finalScore.home ||
            latest.finalScore?.away !== proposal.finalScore.away
          ) {
            throw new Error("POST_WRITE_VERIFICATION_FAILED");
          }
          if (written.idempotent) idempotent++;
          else appended++;
          verified++;
          appendedEventIds.push(written.data.eventId);
          this.appendAudit({
            ownerUserId: owner,
            eventType: written.idempotent
              ? "SETTLEMENT_IDEMPOTENT"
              : "SETTLEMENT_APPENDED",
            planId,
            executionId,
            incidentId,
            gameId,
            predictionId: target.predictionId,
            message: written.idempotent
              ? "O3 settlement replay was idempotent"
              : "O3 append-only settlement event created and verified",
            metadata: {
              settlementEventId: written.data.eventId,
              result: written.data.result,
              finalScore: written.data.finalScore,
              payloadSha256: written.data.payloadSha256,
            },
          });
        } catch (error) {
          failed.push({
            predictionId: target.predictionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const completedAt = this.now().toISOString();
      const state: OperationalReprocessingExecutionState = failed.length === 0
        ? "COMPLETED"
        : appended + idempotent > 0
          ? "PARTIAL_FAILURE"
          : "BLOCKED";
      const execution: OperationalReprocessingExecution = {
        schemaVersion: "courtedge-operational-reprocessing-execution.v1",
        executionId,
        planId,
        planDigest: plan.planDigest,
        ownerUserId: owner,
        idempotencyKey,
        requestDigest,
        startedAt,
        completedAt,
        state,
        appended,
        idempotent,
        verified,
        failed,
        settlementEventIds: appendedEventIds,
        safety: SAFETY,
      };
      writeExclusive(existingPath, execution);
      this.appendAudit({
        ownerUserId: owner,
        eventType: state === "COMPLETED"
          ? "EXECUTION_COMPLETED"
          : state === "PARTIAL_FAILURE"
            ? "EXECUTION_FAILED"
            : "EXECUTION_BLOCKED",
        planId,
        executionId,
        incidentId,
        gameId,
        predictionId: null,
        message: state === "COMPLETED"
          ? `O3 execution completed with ${verified} verified settlements`
          : `O3 execution ended in ${state}`,
        metadata: { appended, idempotent, verified, failed },
      });
      return execution;
    } catch (error) {
      this.appendAudit({
        ownerUserId: owner,
        eventType: "EXECUTION_BLOCKED",
        planId,
        executionId,
        incidentId,
        gameId,
        predictionId: null,
        message: error instanceof Error ? error.message : String(error),
        metadata: { requestDigest, idempotencyKey },
      });
      throw error;
    } finally {
      this.running.delete(lockKey);
    }
  }
}

export function createOperationalReprocessingService(
  systemOwnerUserId: number,
  dataRoot: string,
): OperationalReprocessingService {
  const ledger = getMlbLedgerStore();
  const ownership = getMlbLedgerOwnershipStore();
  const closing = getMlbClosingLineStore();
  return new OperationalReprocessingService({
    rootDir: path.join(dataRoot, "operational-reprocessing-v1"),
    incidentProvider: createOperationalIncidentCenterProvider(systemOwnerUserId),
    recordsProvider: (ownerUserId) => ownedRecordsForUser(
      ledger,
      ownership,
      ownerUserId,
    ),
    officialGameProvider: officialGameForPrediction,
    appendSettlement: (predictionId, input) => ledger.appendSettlement(predictionId, input),
    latestSettlement: (predictionId) => ledger.latestSettlement(predictionId),
    closingProvider: (predictionId, commenceTime) => {
      const observation = closing.latestBeforeCommence(predictionId, commenceTime);
      return observation
        ? {
            oddsAmerican: observation.oddsAmerican,
            line: observation.line,
            matchMode: observation.matchMode,
            comparable: observation.comparable,
          }
        : null;
    },
  });
}

export const O3_CONFIRMATION_PHRASE = CONFIRMATION_PHRASE;
