import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getMlbLedgerStore,
} from "./mlb-ledger";
import {
  appendOwnedPrediction,
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import {
  mlbPredictionInputSchema,
  type LedgerPrediction,
  type LedgerRecord,
  type MlbPredictionInput,
} from "./mlb-ledger-store";
import { activeMlbLedgerRecords, supersessionChainIntegrity } from "./mlb-active-records";
import {
  createOperationalIncidentCenterProvider,
  type OperationalIncidentCenterProvider,
} from "./operational-sla-alerts";
import type { OperationalIncident } from "./operational-incident-center";

const MLB_API = "https://statsapi.mlb.com/api";
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TARGETS = 50;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const CONFIRMATION_PHRASE = "APPEND_SUPERSEDING_MLB_EVIDENCE";
const MARKET_TYPES = new Set([
  "ML",
  "F5_ML",
  "RUN_LINE",
  "TOTAL",
  "F5_TOTAL",
  "TEAM_TOTAL",
  "TT_OVER_15_F5",
  "TT_UNDER_25_F5",
  "INNING_1_ML",
  "NRFI",
  "YRFI",
  "OTHER",
]);

export const O31_INSPECTION_VERSION = "courtedge-o31-evidence-inspection.v1" as const;
export const O31_PLAN_VERSION = "courtedge-o31-evidence-repair-plan.v1" as const;
export const O31_EXECUTION_VERSION = "courtedge-o31-evidence-repair-execution.v1" as const;
export const O31_AUDIT_VERSION = "courtedge-o31-evidence-repair-audit.v1" as const;
export const O31_STATUS_VERSION = "courtedge-o31-evidence-repair-status.v1" as const;

export type EvidenceIssueCode =
  | "INVALID_ODDS_AMERICAN"
  | "MISSING_HOME_TEAM"
  | "MISSING_AWAY_TEAM"
  | "MISSING_MARKET_TYPE"
  | "MISSING_SELECTION"
  | "MISSING_GAME_PK"
  | "INVALID_GAME_DATE"
  | "OFFICIAL_GAME_ID_MISMATCH"
  | "OFFICIAL_DATE_MISMATCH"
  | "OFFICIAL_HOME_TEAM_MISMATCH"
  | "OFFICIAL_AWAY_TEAM_MISMATCH"
  | "NON_FINAL_PREDICTION"
  | "SUPERSESSION_CHAIN_INVALID";

export type EvidenceRepairField =
  | "gamePk"
  | "gameDate"
  | "homeTeam"
  | "awayTeam"
  | "marketType"
  | "selection"
  | "oddsAmerican";

export interface OfficialMlbEvidence {
  gamePk: number;
  gameDate: string;
  commenceTime: string | null;
  homeTeam: string;
  awayTeam: string;
  final: boolean;
  detailedState: string;
  finalScore: { home: number; away: number } | null;
  inningsDigest: string | null;
  fetchedAt: string;
  source: "MLB_STATS_API";
}

export interface EvidenceIssue {
  predictionId: string;
  code: EvidenceIssueCode;
  field: EvidenceRepairField | "analysisStage" | "supersession";
  severity: "BLOCKING";
  currentValue: unknown;
  officialValue: unknown;
  repairMode: "AUTO_FROM_OFFICIAL" | "MANUAL_EVIDENCE_REQUIRED" | "NOT_REPAIRABLE_HERE";
  message: string;
}

export interface EvidenceRecordSnapshot {
  predictionId: string;
  payloadSha256: string;
  supersedesId: string | null;
  analysisStage: string;
  game: LedgerPrediction["game"];
  market: LedgerPrediction["market"];
  issues: EvidenceIssue[];
}

export interface EvidenceInspection {
  schemaVersion: typeof O31_INSPECTION_VERSION;
  inspectionId: string;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  incident: Pick<OperationalIncident, "id" | "league" | "gameId" | "gameDate" | "commenceTime" | "homeTeam" | "awayTeam" | "state" | "evidenceConfidence">;
  officialEvidence: OfficialMlbEvidence | null;
  records: EvidenceRecordSnapshot[];
  blockers: string[];
  warnings: string[];
  inspectionDigest: string;
  safety: EvidenceRepairSafety;
}

export interface EvidenceManualPatch {
  predictionId: string;
  marketType?: string;
  selection?: string;
  oddsAmerican?: number;
  gamePk?: number;
  gameDate?: string;
  homeTeam?: string;
  awayTeam?: string;
}

export interface EvidenceRepairSource {
  sourceName: string;
  evidenceReference: string;
  capturedAt: string;
  note: string;
}

export interface EvidenceRepairTarget {
  predictionId: string;
  originalPayloadSha256: string;
  proposedInput: MlbPredictionInput;
  proposedPayloadSha256: string;
  repairedFields: EvidenceRepairField[];
}

export interface EvidenceRepairPlan {
  schemaVersion: typeof O31_PLAN_VERSION;
  planId: string;
  inspectionId: string;
  inspectionDigest: string;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  state: "READY" | "BLOCKED";
  incidentId: string;
  gameId: string;
  officialEvidence: OfficialMlbEvidence | null;
  repairSource: EvidenceRepairSource;
  targets: EvidenceRepairTarget[];
  blockers: string[];
  warnings: string[];
  preconditionDigest: string;
  planDigest: string;
  confirmationPhrase: typeof CONFIRMATION_PHRASE;
  safety: EvidenceRepairSafety;
}

export interface EvidenceRepairExecution {
  schemaVersion: typeof O31_EXECUTION_VERSION;
  executionId: string;
  planId: string;
  planDigest: string;
  ownerUserId: number;
  idempotencyKey: string;
  requestDigest: string;
  startedAt: string;
  completedAt: string;
  state: "COMPLETED" | "IDEMPOTENT_REPLAY" | "PARTIAL_FAILURE" | "BLOCKED";
  appended: number;
  idempotent: number;
  verified: number;
  supersedingPredictionIds: string[];
  failed: Array<{ predictionId: string; error: string }>;
  safety: EvidenceRepairSafety;
}

export interface EvidenceRepairAuditEvent {
  schemaVersion: typeof O31_AUDIT_VERSION;
  eventId: string;
  ownerUserId: number;
  recordedAt: string;
  recordedAtMs: number;
  eventType:
    | "INSPECTION_CREATED"
    | "INSPECTION_BLOCKED"
    | "PLAN_CREATED"
    | "PLAN_BLOCKED"
    | "EXECUTION_STARTED"
    | "SUPERSEDING_PREDICTION_APPENDED"
    | "SUPERSEDING_PREDICTION_IDEMPOTENT"
    | "EXECUTION_COMPLETED"
    | "EXECUTION_FAILED"
    | "EXECUTION_BLOCKED";
  inspectionId: string | null;
  planId: string | null;
  executionId: string | null;
  incidentId: string;
  predictionId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  previousDigest: string | null;
  eventDigest: string;
}

export interface EvidenceRepairSafety {
  mode: "SHADOW_EVIDENCE_REPAIR";
  shadowOnly: true;
  realFinancialExposure: 0;
  automaticRepair: false;
  requiresExplicitInspection: true;
  requiresSealedPlan: true;
  requiresAdminExecution: true;
  requiresConfirmationPhrase: true;
  singleGameOnly: true;
  appendOnlySupersedingPredictions: true;
  historicalLedgerMutation: false;
  settlementExecution: false;
  automaticBetPlacement: false;
  automaticModelChangesAllowed: false;
  automaticPromotionAllowed: false;
  supportedLeagues: ["MLB"];
}

export interface EvidenceRepairStatus {
  schemaVersion: typeof O31_STATUS_VERSION;
  ownerUserId: number;
  inspections: number;
  plans: number;
  readyPlans: number;
  blockedPlans: number;
  executions: number;
  completedExecutions: number;
  latestInspectionAt: string | null;
  latestExecutionAt: string | null;
  confirmationPhrase: typeof CONFIRMATION_PHRASE;
  ttlMs: number;
  maxTargets: number;
  safety: EvidenceRepairSafety;
}

export interface EvidenceRepairDependencies {
  rootDir: string;
  incidentProvider: OperationalIncidentCenterProvider;
  recordsProvider: (ownerUserId: number) => LedgerRecord[];
  officialEvidenceProvider: (prediction: LedgerPrediction) => Promise<OfficialMlbEvidence | null>;
  appendSupersedingPrediction: (
    ownerUserId: number,
    raw: MlbPredictionInput,
  ) => { data: LedgerPrediction; idempotent: boolean };
  now?: () => Date;
  ttlMs?: number;
}

const SAFETY: EvidenceRepairSafety = {
  mode: "SHADOW_EVIDENCE_REPAIR",
  shadowOnly: true,
  realFinancialExposure: 0,
  automaticRepair: false,
  requiresExplicitInspection: true,
  requiresSealedPlan: true,
  requiresAdminExecution: true,
  requiresConfirmationPhrase: true,
  singleGameOnly: true,
  appendOnlySupersedingPredictions: true,
  historicalLedgerMutation: false,
  settlementExecution: false,
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
    throw Object.assign(new Error("Invalid O3.1 owner user id"), { status: 400 });
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
  const a = normalize(left);
  const b = normalize(right);
  return a === b || teamAlias(a) === teamAlias(b);
}

function validAmericanOdds(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value !== 0
    && Math.abs(value) >= 100
    && Math.abs(value) <= 100000;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
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

function listJson<T>(directory: string): T[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson<T>(path.join(directory, name)));
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "CourtEdge-O31-Evidence-Repair/1.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`MLB API ${response.status}: ${url}`);
  return response.json();
}

function evidenceFromFeed(gamePk: number, payload: any, fetchedAt: string): OfficialMlbEvidence {
  const status = payload?.gameData?.status;
  const final =
    status?.abstractGameState === "Final"
    || status?.codedGameState === "F"
    || status?.detailedState === "Final";
  const linescore = payload?.liveData?.linescore;
  const innings = (linescore?.innings ?? [])
    .map((inning: any) => ({
      num: Number(inning.num),
      home: Number(inning.home?.runs ?? 0),
      away: Number(inning.away?.runs ?? 0),
    }))
    .filter((inning: { num: number; home: number; away: number }) => (
      Number.isFinite(inning.num) && Number.isFinite(inning.home) && Number.isFinite(inning.away)
    ));
  const homeScore = Number(linescore?.teams?.home?.runs);
  const awayScore = Number(linescore?.teams?.away?.runs);
  return {
    gamePk,
    gameDate: String(
      payload?.gameData?.datetime?.officialDate
      || payload?.gameData?.datetime?.dateTime
      || "",
    ).slice(0, 10),
    commenceTime: payload?.gameData?.datetime?.dateTime || null,
    homeTeam: payload?.gameData?.teams?.home?.name || "",
    awayTeam: payload?.gameData?.teams?.away?.name || "",
    final,
    detailedState: String(status?.detailedState || status?.abstractGameState || "Unknown"),
    finalScore: final && Number.isFinite(homeScore) && Number.isFinite(awayScore)
      ? { home: homeScore, away: awayScore }
      : null,
    inningsDigest: innings.length ? sha256(canonicalJson(innings)) : null,
    fetchedAt,
    source: "MLB_STATS_API",
  };
}

export async function officialEvidenceForPrediction(
  prediction: LedgerPrediction,
): Promise<OfficialMlbEvidence | null> {
  let gamePk = prediction.game.gamePk;
  if (!gamePk) {
    if (!validDate(prediction.game.gameDate)) return null;
    const payload = await fetchJson(
      `${MLB_API}/v1/schedule?sportId=1&date=${encodeURIComponent(prediction.game.gameDate)}`,
    );
    const games = (payload?.dates ?? []).flatMap((entry: any) => entry.games ?? []);
    const candidates = games.filter((game: any) => {
      const officialHome = String(game?.teams?.home?.team?.name || "");
      const officialAway = String(game?.teams?.away?.team?.name || "");
      return sameTeam(officialHome, prediction.game.homeTeam)
        && sameTeam(officialAway, prediction.game.awayTeam);
    });
    if (candidates.length === 1) {
      gamePk = Number(candidates[0]?.gamePk) || null;
    } else if (candidates.length > 1 && prediction.game.commenceTime) {
      const expected = Date.parse(prediction.game.commenceTime);
      const ranked = candidates
        .map((game: any) => ({
          gamePk: Number(game?.gamePk) || 0,
          distance: Math.abs(Date.parse(game?.gameDate || "") - expected),
        }))
        .filter((entry: { gamePk: number; distance: number }) => entry.gamePk > 0 && Number.isFinite(entry.distance))
        .sort((a: { distance: number }, b: { distance: number }) => a.distance - b.distance);
      if (ranked.length && !(ranked.length > 1 && ranked[0].distance === ranked[1].distance)) {
        gamePk = ranked[0].gamePk;
      }
    }
  }
  if (!gamePk) return null;
  const fetchedAt = new Date().toISOString();
  const payload = await fetchJson(`${MLB_API}/v1.1/game/${gamePk}/feed/live`);
  return evidenceFromFeed(gamePk, payload, fetchedAt);
}

function matchesIncident(record: LedgerRecord, incident: OperationalIncident): boolean {
  if (record.prediction.game.gamePk && /^\d+$/.test(incident.gameId)) {
    return String(record.prediction.game.gamePk) === incident.gameId;
  }
  return record.prediction.game.gameDate === incident.gameDate
    && normalize(record.prediction.game.homeTeam) === normalize(incident.homeTeam)
    && normalize(record.prediction.game.awayTeam) === normalize(incident.awayTeam);
}

function issue(
  predictionId: string,
  code: EvidenceIssueCode,
  field: EvidenceIssue["field"],
  currentValue: unknown,
  officialValue: unknown,
  repairMode: EvidenceIssue["repairMode"],
  message: string,
): EvidenceIssue {
  return {
    predictionId,
    code,
    field,
    severity: "BLOCKING",
    currentValue,
    officialValue,
    repairMode,
    message,
  };
}

function inspectRecord(
  record: LedgerRecord,
  official: OfficialMlbEvidence | null,
): EvidenceIssue[] {
  const prediction = record.prediction;
  const issues: EvidenceIssue[] = [];
  if (!validAmericanOdds(prediction.market.oddsAmerican)) {
    issues.push(issue(
      prediction.id,
      "INVALID_ODDS_AMERICAN",
      "oddsAmerican",
      prediction.market.oddsAmerican,
      null,
      "MANUAL_EVIDENCE_REQUIRED",
      "La cuota americana debe ser un entero con valor absoluto mínimo de 100.",
    ));
  }
  if (!String(prediction.game.homeTeam || "").trim()) {
    issues.push(issue(prediction.id, "MISSING_HOME_TEAM", "homeTeam", prediction.game.homeTeam, official?.homeTeam ?? null, official ? "AUTO_FROM_OFFICIAL" : "MANUAL_EVIDENCE_REQUIRED", "Falta el equipo local."));
  }
  if (!String(prediction.game.awayTeam || "").trim()) {
    issues.push(issue(prediction.id, "MISSING_AWAY_TEAM", "awayTeam", prediction.game.awayTeam, official?.awayTeam ?? null, official ? "AUTO_FROM_OFFICIAL" : "MANUAL_EVIDENCE_REQUIRED", "Falta el equipo visitante."));
  }
  if (!String(prediction.market.type || "").trim() || !MARKET_TYPES.has(prediction.market.type)) {
    issues.push(issue(prediction.id, "MISSING_MARKET_TYPE", "marketType", prediction.market.type, null, "MANUAL_EVIDENCE_REQUIRED", "Falta un tipo de mercado MLB válido."));
  }
  if (!String(prediction.market.selection || "").trim()) {
    issues.push(issue(prediction.id, "MISSING_SELECTION", "selection", prediction.market.selection, null, "MANUAL_EVIDENCE_REQUIRED", "Falta la selección del mercado."));
  }
  if (!prediction.game.gamePk) {
    issues.push(issue(prediction.id, "MISSING_GAME_PK", "gamePk", prediction.game.gamePk, official?.gamePk ?? null, official ? "AUTO_FROM_OFFICIAL" : "MANUAL_EVIDENCE_REQUIRED", "Falta el identificador oficial gamePk."));
  }
  if (!validDate(prediction.game.gameDate)) {
    issues.push(issue(prediction.id, "INVALID_GAME_DATE", "gameDate", prediction.game.gameDate, official?.gameDate ?? null, official ? "AUTO_FROM_OFFICIAL" : "MANUAL_EVIDENCE_REQUIRED", "La fecha del juego no es válida."));
  }
  if (prediction.analysisStage !== "FINAL") {
    issues.push(issue(prediction.id, "NON_FINAL_PREDICTION", "analysisStage", prediction.analysisStage, "FINAL", "NOT_REPAIRABLE_HERE", "O3.1 no convierte análisis provisionales en FINAL."));
  }
  if (official) {
    if (prediction.game.gamePk && prediction.game.gamePk !== official.gamePk) {
      issues.push(issue(prediction.id, "OFFICIAL_GAME_ID_MISMATCH", "gamePk", prediction.game.gamePk, official.gamePk, "AUTO_FROM_OFFICIAL", "El gamePk no coincide con MLB Stats API."));
    }
    if (validDate(prediction.game.gameDate) && prediction.game.gameDate !== official.gameDate) {
      issues.push(issue(prediction.id, "OFFICIAL_DATE_MISMATCH", "gameDate", prediction.game.gameDate, official.gameDate, "AUTO_FROM_OFFICIAL", "La fecha no coincide con MLB Stats API."));
    }
    if (prediction.game.homeTeam && !sameTeam(prediction.game.homeTeam, official.homeTeam)) {
      issues.push(issue(prediction.id, "OFFICIAL_HOME_TEAM_MISMATCH", "homeTeam", prediction.game.homeTeam, official.homeTeam, "AUTO_FROM_OFFICIAL", "El equipo local no coincide con MLB Stats API."));
    }
    if (prediction.game.awayTeam && !sameTeam(prediction.game.awayTeam, official.awayTeam)) {
      issues.push(issue(prediction.id, "OFFICIAL_AWAY_TEAM_MISMATCH", "awayTeam", prediction.game.awayTeam, official.awayTeam, "AUTO_FROM_OFFICIAL", "El equipo visitante no coincide con MLB Stats API."));
    }
  }
  return issues;
}

function snapshotIncident(incident: OperationalIncident): EvidenceInspection["incident"] {
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

function sourceInput(raw: unknown): EvidenceRepairSource {
  const input = raw as Partial<EvidenceRepairSource> | null | undefined;
  const sourceName = String(input?.sourceName ?? "").trim();
  const evidenceReference = String(input?.evidenceReference ?? "").trim();
  const capturedAt = String(input?.capturedAt ?? "").trim();
  const note = String(input?.note ?? "").trim();
  if (sourceName.length < 2 || sourceName.length > 120) throw Object.assign(new Error("Evidence sourceName must contain 2 to 120 characters"), { status: 400 });
  if (evidenceReference.length < 3 || evidenceReference.length > 500) throw Object.assign(new Error("Evidence reference must contain 3 to 500 characters"), { status: 400 });
  if (!Number.isFinite(Date.parse(capturedAt))) throw Object.assign(new Error("Evidence capturedAt must be an ISO datetime"), { status: 400 });
  if (note.length < 10 || note.length > 1000) throw Object.assign(new Error("Evidence note must contain 10 to 1000 characters"), { status: 400 });
  return { sourceName, evidenceReference, capturedAt: new Date(capturedAt).toISOString(), note };
}

function manualPatchMap(raw: unknown): Map<string, EvidenceManualPatch> {
  if (!Array.isArray(raw)) throw Object.assign(new Error("O3.1 patches must be an array"), { status: 400 });
  const map = new Map<string, EvidenceManualPatch>();
  for (const entry of raw) {
    const patch = entry as EvidenceManualPatch;
    const predictionId = safeId(patch?.predictionId, "prediction id");
    if (map.has(predictionId)) throw Object.assign(new Error("Duplicate O3.1 patch predictionId"), { status: 400 });
    map.set(predictionId, { ...patch, predictionId });
  }
  return map;
}

function repairInput(
  record: LedgerRecord,
  issues: EvidenceIssue[],
  official: OfficialMlbEvidence | null,
  patch: EvidenceManualPatch | undefined,
  source: EvidenceRepairSource,
  planId: string,
): { input: MlbPredictionInput; repairedFields: EvidenceRepairField[]; blockers: string[] } {
  const original = record.prediction.payload as MlbPredictionInput;
  const repairedFields = new Set<EvidenceRepairField>();
  const blockers: string[] = [];
  const nextGame = { ...original.game };
  const nextMarket = { ...original.market };

  for (const current of issues) {
    if (current.repairMode === "NOT_REPAIRABLE_HERE") {
      blockers.push(`${current.code}:${record.prediction.id}`);
      continue;
    }
    if (current.field === "gamePk") {
      const value = official?.gamePk ?? patch?.gamePk;
      if (!Number.isInteger(value) || Number(value) <= 0) blockers.push(`GAME_PK_REQUIRED:${record.prediction.id}`);
      else { nextGame.gamePk = Number(value); repairedFields.add("gamePk"); }
    }
    if (current.field === "gameDate") {
      const value = official?.gameDate ?? patch?.gameDate;
      if (!validDate(value)) blockers.push(`GAME_DATE_REQUIRED:${record.prediction.id}`);
      else { nextGame.gameDate = value; repairedFields.add("gameDate"); }
    }
    if (current.field === "homeTeam") {
      const value = official?.homeTeam ?? patch?.homeTeam;
      if (!String(value ?? "").trim()) blockers.push(`HOME_TEAM_REQUIRED:${record.prediction.id}`);
      else { nextGame.homeTeam = String(value).trim(); repairedFields.add("homeTeam"); }
    }
    if (current.field === "awayTeam") {
      const value = official?.awayTeam ?? patch?.awayTeam;
      if (!String(value ?? "").trim()) blockers.push(`AWAY_TEAM_REQUIRED:${record.prediction.id}`);
      else { nextGame.awayTeam = String(value).trim(); repairedFields.add("awayTeam"); }
    }
    if (current.field === "marketType") {
      const value = String(patch?.marketType ?? "").trim().toUpperCase();
      if (!MARKET_TYPES.has(value)) blockers.push(`MARKET_TYPE_REQUIRED:${record.prediction.id}`);
      else { nextMarket.type = value as MlbPredictionInput["market"]["type"]; repairedFields.add("marketType"); }
    }
    if (current.field === "selection") {
      const value = String(patch?.selection ?? "").trim();
      if (!value) blockers.push(`SELECTION_REQUIRED:${record.prediction.id}`);
      else { nextMarket.selection = value; repairedFields.add("selection"); }
    }
    if (current.field === "oddsAmerican") {
      const value = patch?.oddsAmerican;
      if (!validAmericanOdds(value)) blockers.push(`VALID_AMERICAN_ODDS_REQUIRED:${record.prediction.id}`);
      else { nextMarket.oddsAmerican = value; repairedFields.add("oddsAmerican"); }
    }
  }

  if (official) {
    if (nextGame.gamePk !== official.gamePk) blockers.push(`OFFICIAL_GAME_PK_MISMATCH:${record.prediction.id}`);
    if (nextGame.gameDate !== official.gameDate) blockers.push(`OFFICIAL_GAME_DATE_MISMATCH:${record.prediction.id}`);
    if (!sameTeam(nextGame.homeTeam, official.homeTeam)) blockers.push(`OFFICIAL_HOME_TEAM_MISMATCH:${record.prediction.id}`);
    if (!sameTeam(nextGame.awayTeam, official.awayTeam)) blockers.push(`OFFICIAL_AWAY_TEAM_MISMATCH:${record.prediction.id}`);
  }

  const repairMetadata = {
    phase: "O3.1",
    planId,
    supersedesId: record.prediction.id,
    originalPayloadSha256: record.prediction.payloadSha256,
    repairedFields: Array.from(repairedFields).sort(),
    officialEvidence: official,
    manualEvidence: source,
  };
  const analysis = {
    ...original.analysis,
    warnings: Array.from(new Set([
      ...(original.analysis.warnings ?? []),
      `O3.1 append-only evidence repair superseding ${record.prediction.id}`,
    ])),
    sources: [
      ...(original.analysis.sources ?? []),
      {
        name: official ? "MLB Stats API O3.1 verification" : source.sourceName,
        status: official ? "VERIFIED" as const : "MANUAL" as const,
        fetchedAt: official?.fetchedAt ?? source.capturedAt,
        asOf: official?.gameDate ?? source.capturedAt,
        metadata: repairMetadata,
      },
    ],
    rawInputs: {
      original: original.analysis.rawInputs,
      o31EvidenceRepair: repairMetadata,
    },
  };
  const input: MlbPredictionInput = {
    ...original,
    clientRequestId: `o31:${planId}:${record.prediction.id}`,
    source: "manual",
    supersedesId: record.prediction.id,
    game: nextGame,
    market: nextMarket,
    analysis,
  };
  try {
    mlbPredictionInputSchema.parse(input);
  } catch (error) {
    blockers.push(`REPAIRED_INPUT_SCHEMA_INVALID:${record.prediction.id}:${error instanceof Error ? error.message : String(error)}`);
  }
  return { input, repairedFields: Array.from(repairedFields).sort(), blockers };
}

export class OperationalEvidenceRepairService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly running = new Set<string>();

  constructor(private readonly deps: EvidenceRepairDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.ttlMs = typeof deps.ttlMs === "number" && Number.isFinite(deps.ttlMs) && deps.ttlMs >= 60_000
      ? deps.ttlMs
      : DEFAULT_TTL_MS;
    fs.mkdirSync(this.deps.rootDir, { recursive: true });
  }

  private ownerRoot(ownerUserId: number): string {
    return path.join(this.deps.rootDir, `owner-${positiveOwner(ownerUserId)}`);
  }

  private inspectionPath(ownerUserId: number, inspectionId: string): string {
    return path.join(this.ownerRoot(ownerUserId), "inspections", `${safeId(inspectionId, "inspection id")}.json`);
  }

  private planPath(ownerUserId: number, planId: string): string {
    return path.join(this.ownerRoot(ownerUserId), "plans", `${safeId(planId, "plan id")}.json`);
  }

  private executionPath(ownerUserId: number, idempotencyKey: string): string {
    return path.join(this.ownerRoot(ownerUserId), "executions", `${sha256(safeId(idempotencyKey, "idempotency key")).slice(0, 32)}.json`);
  }

  private auditPath(ownerUserId: number): string {
    return path.join(this.ownerRoot(ownerUserId), "audit.jsonl");
  }

  private auditEvents(ownerUserId: number): EvidenceRepairAuditEvent[] {
    const filePath = this.auditPath(ownerUserId);
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EvidenceRepairAuditEvent);
  }

  private appendAudit(input: Omit<EvidenceRepairAuditEvent, "schemaVersion" | "eventId" | "recordedAt" | "recordedAtMs" | "previousDigest" | "eventDigest">): EvidenceRepairAuditEvent {
    const events = this.auditEvents(input.ownerUserId);
    const previousDigest = events.at(-1)?.eventDigest ?? null;
    const recordedAtMs = this.now().getTime();
    const base = {
      schemaVersion: O31_AUDIT_VERSION,
      eventId: generatedId("o31-audit"),
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      previousDigest,
      ...input,
    };
    const event: EvidenceRepairAuditEvent = {
      ...base,
      eventDigest: sha256(canonicalJson(base)),
    };
    fs.mkdirSync(path.dirname(this.auditPath(input.ownerUserId)), { recursive: true });
    fs.appendFileSync(this.auditPath(input.ownerUserId), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  audit(ownerUserId: number, limit = 250): EvidenceRepairAuditEvent[] {
    return this.auditEvents(positiveOwner(ownerUserId))
      .sort((a, b) => b.recordedAtMs - a.recordedAtMs)
      .slice(0, Math.min(1000, Math.max(1, Math.floor(limit))));
  }

  getInspection(ownerUserId: number, inspectionId: string): EvidenceInspection {
    const filePath = this.inspectionPath(ownerUserId, inspectionId);
    if (!fs.existsSync(filePath)) throw Object.assign(new Error("O3.1 inspection not found"), { status: 404 });
    const inspection = readJson<EvidenceInspection>(filePath);
    const { inspectionDigest, ...withoutDigest } = inspection;
    if (inspection.ownerUserId !== positiveOwner(ownerUserId) || sha256(canonicalJson(withoutDigest)) !== inspectionDigest) {
      throw Object.assign(new Error("O3.1 inspection integrity mismatch"), { status: 409 });
    }
    return inspection;
  }

  getPlan(ownerUserId: number, planId: string): EvidenceRepairPlan {
    const filePath = this.planPath(ownerUserId, planId);
    if (!fs.existsSync(filePath)) throw Object.assign(new Error("O3.1 repair plan not found"), { status: 404 });
    const plan = readJson<EvidenceRepairPlan>(filePath);
    const { planDigest, ...withoutDigest } = plan;
    if (plan.ownerUserId !== positiveOwner(ownerUserId) || sha256(canonicalJson(withoutDigest)) !== planDigest) {
      throw Object.assign(new Error("O3.1 plan integrity mismatch"), { status: 409 });
    }
    return plan;
  }

  status(ownerUserId: number): EvidenceRepairStatus {
    const owner = positiveOwner(ownerUserId);
    const inspections = listJson<EvidenceInspection>(path.join(this.ownerRoot(owner), "inspections"));
    const plans = listJson<EvidenceRepairPlan>(path.join(this.ownerRoot(owner), "plans"));
    const executions = listJson<EvidenceRepairExecution>(path.join(this.ownerRoot(owner), "executions"));
    const latestInspection = inspections.map((entry) => Date.parse(entry.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const latestExecution = executions.map((entry) => Date.parse(entry.completedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
    return {
      schemaVersion: O31_STATUS_VERSION,
      ownerUserId: owner,
      inspections: inspections.length,
      plans: plans.length,
      readyPlans: plans.filter((entry) => entry.state === "READY").length,
      blockedPlans: plans.filter((entry) => entry.state === "BLOCKED").length,
      executions: executions.length,
      completedExecutions: executions.filter((entry) => entry.state === "COMPLETED" || entry.state === "IDEMPOTENT_REPLAY").length,
      latestInspectionAt: Number.isFinite(latestInspection) ? new Date(latestInspection).toISOString() : null,
      latestExecutionAt: Number.isFinite(latestExecution) ? new Date(latestExecution).toISOString() : null,
      confirmationPhrase: CONFIRMATION_PHRASE,
      ttlMs: this.ttlMs,
      maxTargets: MAX_TARGETS,
      safety: SAFETY,
    };
  }

  async inspect(ownerUserId: number, raw: { incidentId?: unknown }): Promise<EvidenceInspection> {
    const owner = positiveOwner(ownerUserId);
    const incidentId = safeId(raw.incidentId, "incident id");
    const report = await this.deps.incidentProvider(owner);
    const incident = report.incidents.find((entry) => entry.id === incidentId);
    if (!incident) throw Object.assign(new Error("Operational incident not found"), { status: 404 });

    const blockers: string[] = [];
    const warnings: string[] = [];
    if (incident.league !== "MLB") blockers.push("UNSUPPORTED_LEAGUE");
    if (incident.state !== "DATA_QUALITY_REVIEW") blockers.push("INCIDENT_NOT_IN_DATA_QUALITY_REVIEW");
    if (incident.evidenceConfidence !== "AUTHORITATIVE") blockers.push("AUTHORITATIVE_LEDGER_REQUIRED");

    const allRecords = this.deps.recordsProvider(owner);
    const chain = supersessionChainIntegrity(allRecords);
    if (!chain.valid) blockers.push("SUPERSESSION_CHAIN_INVALID");
    const records = activeMlbLedgerRecords(allRecords).filter((record) => matchesIncident(record, incident));
    if (!records.length) blockers.push("NO_ACTIVE_OWNED_RECORDS");
    if (records.length > MAX_TARGETS) blockers.push("TARGET_LIMIT_EXCEEDED");

    let officialEvidence: OfficialMlbEvidence | null = null;
    if (records[0]) {
      try {
        officialEvidence = await this.deps.officialEvidenceProvider(records[0].prediction);
        if (!officialEvidence) blockers.push("OFFICIAL_GAME_NOT_IDENTIFIED");
        else if (!officialEvidence.final) blockers.push("OFFICIAL_GAME_NOT_FINAL");
      } catch (error) {
        blockers.push("OFFICIAL_SOURCE_ERROR");
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }

    const snapshots = records.slice(0, MAX_TARGETS).map((record) => ({
      predictionId: record.prediction.id,
      payloadSha256: record.prediction.payloadSha256,
      supersedesId: record.prediction.supersedesId,
      analysisStage: record.prediction.analysisStage,
      game: record.prediction.game,
      market: record.prediction.market,
      issues: inspectRecord(record, officialEvidence),
    }));
    if (snapshots.every((entry) => entry.issues.length === 0)) blockers.push("NO_REPAIRABLE_DATA_QUALITY_ISSUES");

    const now = this.now();
    const inspectionId = generatedId("o31-inspection");
    const withoutDigest: Omit<EvidenceInspection, "inspectionDigest"> = {
      schemaVersion: O31_INSPECTION_VERSION,
      inspectionId,
      ownerUserId: owner,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      incident: snapshotIncident(incident),
      officialEvidence,
      records: snapshots,
      blockers,
      warnings,
      safety: SAFETY,
    };
    const inspection: EvidenceInspection = {
      ...withoutDigest,
      inspectionDigest: sha256(canonicalJson(withoutDigest)),
    };
    writeExclusive(this.inspectionPath(owner, inspectionId), inspection);
    this.appendAudit({
      ownerUserId: owner,
      eventType: blockers.length ? "INSPECTION_BLOCKED" : "INSPECTION_CREATED",
      inspectionId,
      planId: null,
      executionId: null,
      incidentId,
      predictionId: null,
      message: blockers.length ? `O3.1 inspection blocked: ${blockers.join(", ")}` : `O3.1 inspection created for ${snapshots.length} active records`,
      metadata: { blockers, warnings, records: snapshots.length, inspectionDigest: inspection.inspectionDigest },
    });
    return inspection;
  }

  createPlan(ownerUserId: number, raw: {
    inspectionId?: unknown;
    inspectionDigest?: unknown;
    patches?: unknown;
    repairSource?: unknown;
  }): EvidenceRepairPlan {
    const owner = positiveOwner(ownerUserId);
    const inspectionId = safeId(raw.inspectionId, "inspection id");
    const inspection = this.getInspection(owner, inspectionId);
    if (inspection.inspectionDigest !== String(raw.inspectionDigest ?? "").trim()) {
      throw Object.assign(new Error("O3.1 inspection digest mismatch"), { status: 409 });
    }
    if (Date.parse(inspection.expiresAt) <= this.now().getTime()) {
      throw Object.assign(new Error("O3.1 inspection expired"), { status: 409 });
    }
    const source = sourceInput(raw.repairSource);
    const patches = manualPatchMap(raw.patches);
    const blockers = [...inspection.blockers];
    const warnings = [...inspection.warnings];
    const currentRecords = activeMlbLedgerRecords(this.deps.recordsProvider(owner));
    const byId = new Map(currentRecords.map((record) => [record.prediction.id, record]));
    const planId = generatedId("o31-plan");
    const targets: EvidenceRepairTarget[] = [];

    for (const snapshot of inspection.records) {
      const record = byId.get(snapshot.predictionId);
      if (!record || record.prediction.payloadSha256 !== snapshot.payloadSha256) {
        blockers.push(`TARGET_IDENTITY_DRIFT:${snapshot.predictionId}`);
        continue;
      }
      const built = repairInput(record, snapshot.issues, inspection.officialEvidence, patches.get(snapshot.predictionId), source, planId);
      blockers.push(...built.blockers);
      const parsed = mlbPredictionInputSchema.safeParse(built.input);
      if (!parsed.success) continue;
      targets.push({
        predictionId: snapshot.predictionId,
        originalPayloadSha256: snapshot.payloadSha256,
        proposedInput: parsed.data,
        proposedPayloadSha256: sha256(canonicalJson(parsed.data)),
        repairedFields: built.repairedFields,
      });
    }
    if (targets.length !== inspection.records.length) blockers.push("INCOMPLETE_REPAIR_PLAN");
    if (targets.some((target) => target.repairedFields.length === 0)) blockers.push("EMPTY_REPAIR_TARGET");

    const now = this.now();
    const preconditionDigest = sha256(canonicalJson({
      inspectionDigest: inspection.inspectionDigest,
      officialEvidence: inspection.officialEvidence,
      targets: targets.map((target) => ({
        predictionId: target.predictionId,
        originalPayloadSha256: target.originalPayloadSha256,
        proposedPayloadSha256: target.proposedPayloadSha256,
        repairedFields: target.repairedFields,
      })),
    }));
    const withoutDigest: Omit<EvidenceRepairPlan, "planDigest"> = {
      schemaVersion: O31_PLAN_VERSION,
      planId,
      inspectionId,
      inspectionDigest: inspection.inspectionDigest,
      ownerUserId: owner,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      state: blockers.length ? "BLOCKED" : "READY",
      incidentId: inspection.incident.id,
      gameId: inspection.incident.gameId,
      officialEvidence: inspection.officialEvidence,
      repairSource: source,
      targets,
      blockers: Array.from(new Set(blockers)),
      warnings,
      preconditionDigest,
      confirmationPhrase: CONFIRMATION_PHRASE,
      safety: SAFETY,
    };
    const plan: EvidenceRepairPlan = {
      ...withoutDigest,
      planDigest: sha256(canonicalJson(withoutDigest)),
    };
    writeExclusive(this.planPath(owner, planId), plan);
    this.appendAudit({
      ownerUserId: owner,
      eventType: plan.state === "READY" ? "PLAN_CREATED" : "PLAN_BLOCKED",
      inspectionId,
      planId,
      executionId: null,
      incidentId: plan.incidentId,
      predictionId: null,
      message: plan.state === "READY" ? `O3.1 repair plan created for ${targets.length} records` : `O3.1 repair plan blocked: ${plan.blockers.join(", ")}`,
      metadata: { targets: targets.length, blockers: plan.blockers, planDigest: plan.planDigest, preconditionDigest },
    });
    return plan;
  }

  execute(ownerUserId: number, raw: {
    planId?: unknown;
    planDigest?: unknown;
    idempotencyKey?: unknown;
    confirmation?: unknown;
    reason?: unknown;
  }): EvidenceRepairExecution {
    const owner = positiveOwner(ownerUserId);
    const planId = safeId(raw.planId, "plan id");
    const planDigest = String(raw.planDigest ?? "").trim();
    const idempotencyKey = safeId(raw.idempotencyKey, "idempotency key");
    const confirmation = String(raw.confirmation ?? "").trim();
    const reason = String(raw.reason ?? "").trim();
    if (confirmation !== CONFIRMATION_PHRASE) throw Object.assign(new Error("Exact O3.1 confirmation phrase required"), { status: 400 });
    if (reason.length < 10 || reason.length > 500) throw Object.assign(new Error("O3.1 execution reason must contain 10 to 500 characters"), { status: 400 });

    const requestDigest = sha256(canonicalJson({ planId, planDigest, idempotencyKey, confirmation, reason }));
    const executionPath = this.executionPath(owner, idempotencyKey);
    if (fs.existsSync(executionPath)) {
      const existing = readJson<EvidenceRepairExecution>(executionPath);
      if (existing.requestDigest !== requestDigest) throw Object.assign(new Error("O3.1 idempotency key already used with another request"), { status: 409 });
      return { ...existing, state: "IDEMPOTENT_REPLAY" };
    }
    const lockKey = `${owner}:${planId}`;
    if (this.running.has(lockKey)) throw Object.assign(new Error("O3.1 execution already running"), { status: 409 });
    this.running.add(lockKey);
    const executionId = generatedId("o31-exec");
    const startedAt = this.now().toISOString();
    let incidentId = "unknown";
    try {
      const plan = this.getPlan(owner, planId);
      incidentId = plan.incidentId;
      if (plan.planDigest !== planDigest) throw Object.assign(new Error("O3.1 supplied plan digest does not match"), { status: 409 });
      if (plan.state !== "READY") throw Object.assign(new Error(`O3.1 plan is ${plan.state}`), { status: 409 });
      if (Date.parse(plan.expiresAt) <= this.now().getTime()) throw Object.assign(new Error("O3.1 plan expired"), { status: 409 });

      const current = activeMlbLedgerRecords(this.deps.recordsProvider(owner));
      const byId = new Map(current.map((record) => [record.prediction.id, record]));
      for (const target of plan.targets) {
        const record = byId.get(target.predictionId);
        if (!record || record.prediction.payloadSha256 !== target.originalPayloadSha256) {
          throw Object.assign(new Error(`O3.1 target identity drift: ${target.predictionId}`), { status: 409 });
        }
        const parsed = mlbPredictionInputSchema.parse(target.proposedInput);
        if (sha256(canonicalJson(parsed)) !== target.proposedPayloadSha256) {
          throw Object.assign(new Error(`O3.1 proposed payload digest mismatch: ${target.predictionId}`), { status: 409 });
        }
      }

      this.appendAudit({
        ownerUserId: owner,
        eventType: "EXECUTION_STARTED",
        inspectionId: plan.inspectionId,
        planId,
        executionId,
        incidentId,
        predictionId: null,
        message: `O3.1 append-only evidence repair started: ${reason}`,
        metadata: { requestDigest, idempotencyKey, targets: plan.targets.length },
      });

      let appended = 0;
      let idempotent = 0;
      let verified = 0;
      const supersedingPredictionIds: string[] = [];
      const failed: Array<{ predictionId: string; error: string }> = [];
      for (const target of plan.targets) {
        try {
          const written = this.deps.appendSupersedingPrediction(owner, target.proposedInput);
          const verifyRecords = this.deps.recordsProvider(owner);
          const writtenRecord = verifyRecords.find((record) => record.prediction.id === written.data.id);
          if (!writtenRecord
            || writtenRecord.prediction.supersedesId !== target.predictionId
            || writtenRecord.prediction.payloadSha256 !== target.proposedPayloadSha256) {
            throw new Error("POST_WRITE_VERIFICATION_FAILED");
          }
          if (written.idempotent) idempotent += 1;
          else appended += 1;
          verified += 1;
          supersedingPredictionIds.push(written.data.id);
          this.appendAudit({
            ownerUserId: owner,
            eventType: written.idempotent ? "SUPERSEDING_PREDICTION_IDEMPOTENT" : "SUPERSEDING_PREDICTION_APPENDED",
            inspectionId: plan.inspectionId,
            planId,
            executionId,
            incidentId,
            predictionId: target.predictionId,
            message: written.idempotent ? "Existing O3.1 superseding prediction verified idempotently" : "O3.1 superseding prediction appended and verified",
            metadata: {
              supersedingPredictionId: written.data.id,
              originalPayloadSha256: target.originalPayloadSha256,
              proposedPayloadSha256: target.proposedPayloadSha256,
              repairedFields: target.repairedFields,
            },
          });
        } catch (error) {
          failed.push({ predictionId: target.predictionId, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const completedAt = this.now().toISOString();
      const state: EvidenceRepairExecution["state"] = failed.length === 0
        ? "COMPLETED"
        : appended + idempotent > 0
          ? "PARTIAL_FAILURE"
          : "BLOCKED";
      const execution: EvidenceRepairExecution = {
        schemaVersion: O31_EXECUTION_VERSION,
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
        supersedingPredictionIds,
        failed,
        safety: SAFETY,
      };
      writeExclusive(executionPath, execution);
      this.appendAudit({
        ownerUserId: owner,
        eventType: state === "COMPLETED" ? "EXECUTION_COMPLETED" : "EXECUTION_FAILED",
        inspectionId: plan.inspectionId,
        planId,
        executionId,
        incidentId,
        predictionId: null,
        message: state === "COMPLETED" ? `O3.1 completed with ${verified} verified superseding predictions` : `O3.1 ended in ${state}`,
        metadata: { appended, idempotent, verified, failed, supersedingPredictionIds },
      });
      return execution;
    } catch (error) {
      this.appendAudit({
        ownerUserId: owner,
        eventType: "EXECUTION_BLOCKED",
        inspectionId: null,
        planId,
        executionId,
        incidentId,
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

export function createOperationalEvidenceRepairService(
  systemOwnerUserId: number,
  dataRoot: string,
): OperationalEvidenceRepairService {
  const ledger = getMlbLedgerStore();
  const ownership = getMlbLedgerOwnershipStore();
  return new OperationalEvidenceRepairService({
    rootDir: path.join(dataRoot, "operational-evidence-repair-v1"),
    incidentProvider: createOperationalIncidentCenterProvider(systemOwnerUserId),
    recordsProvider: (ownerUserId) => ownedRecordsForUser(ledger, ownership, ownerUserId, { limit: 10_000 }),
    officialEvidenceProvider: officialEvidenceForPrediction,
    appendSupersedingPrediction: (ownerUserId, raw) => appendOwnedPrediction(ledger, ownership, raw, ownerUserId, "repair"),
  });
}

export const O31_CONFIRMATION_PHRASE = CONFIRMATION_PHRASE;
