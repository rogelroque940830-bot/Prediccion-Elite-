import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import type { MlbS5eCoverageService, S5eConsensusObservation } from "./mlb-s5e-coverage-service";
import {
  MLB_S6I_CLEAN_COHORT_CUTOFF,
  MLB_S6I_REQUIRED_CONSENSUS_METHOD,
} from "./mlb-s6i-postfix-certification";
import {
  gradeMlbPrediction,
  type OfficialMlbGame,
} from "./mlb-settlement-worker";

export const MLB_S6J_FIRST_CYCLE_VERSION = "mlb-s6j-first-clean-cycle.v1" as const;

const CUTOFF_MS = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);
const FINAL_CAPTURE_GRACE_MS = 60_000;
const SETTLEMENT_OVERDUE_MS = 12 * 60 * 60 * 1000;
const CLOSING_CORRECTION_GRACE_MS = 2 * 60 * 60 * 1000;
const ARITHMETIC_TOLERANCE_PP = 0.05;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type S6jOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  now?: () => Date;
  fetcher?: FetchLike;
  deploymentCommit?: string;
  environment?: string;
};

export type S6jState =
  | "WAITING_FOR_TARGET"
  | "WAITING_FOR_FINAL"
  | "WAITING_FOR_SETTLEMENT"
  | "WAITING_FOR_OFFICIAL_VERIFICATION"
  | "WAITING_FOR_CLOSING"
  | "CERTIFIED"
  | "ACTION_REQUIRED";

export type S6jIssueCode =
  | "TARGET_NOT_FOUND"
  | "TARGET_CHAIN_CROSSES_CUTOFF"
  | "TARGET_CHAIN_BRANCH"
  | "BROKEN_SUPERSESSION"
  | "IDENTITY_CHANGED"
  | "NO_PROVISIONAL_STAGE"
  | "FINAL_MISSING_AFTER_START"
  | "FINAL_CAPTURED_AFTER_START"
  | "FINAL_LINEUP_EVIDENCE_INCOMPLETE"
  | "INVALID_AMERICAN_ODDS"
  | "PRICE_PROVENANCE_INVALID"
  | "SETTLEMENT_OVERDUE"
  | "SETTLEMENT_SOURCE_INVALID"
  | "SETTLEMENT_RESULT_MISMATCH"
  | "SETTLEMENT_OUTCOME_MISMATCH"
  | "FINAL_SCORE_MISMATCH"
  | "SHADOW_PROFIT_NONZERO"
  | "OFFICIAL_GAME_UNAVAILABLE"
  | "OFFICIAL_GRADE_UNSUPPORTED"
  | "COMPARABLE_CLOSING_MISSING"
  | "CLOSING_PRICE_MISMATCH"
  | "CLOSING_LINE_MISMATCH"
  | "CLV_ARITHMETIC_MISMATCH"
  | "PERSISTENCE_COUNT_REGRESSION";

export type S6jIssue = {
  code: S6jIssueCode;
  severity: "INFO" | "WARNING" | "CRITICAL";
  message: string;
};

export type S6jFirstCycleReport = {
  schemaVersion: typeof MLB_S6J_FIRST_CYCLE_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6jState;
  cohort: {
    cutoff: typeof MLB_S6I_CLEAN_COHORT_CUTOFF;
    requiredConsensusMethod: typeof MLB_S6I_REQUIRED_CONSENSUS_METHOD;
  };
  target: {
    rootPredictionId: string | null;
    terminalPredictionId: string | null;
    gamePk: number | null;
    gameDate: string | null;
    awayTeam: string | null;
    homeTeam: string | null;
    marketType: string | null;
    selection: string | null;
    line: number | null;
    commenceTime: string | null;
  };
  lifecycle: {
    chainLength: number;
    provisionalStages: number;
    finalStages: number;
    terminalStage: string | null;
    terminalRecordedAt: string | null;
    finalBeforeStart: boolean | null;
    lineupsConfirmed: boolean | null;
    settled: boolean;
    settlementSource: string | null;
    settlementResult: string | null;
    officialGradeResult: string | null;
    comparableClosingCaptured: boolean;
    clvCaptured: boolean;
  };
  checks: {
    purePostFixChain: boolean | null;
    linearSupersession: boolean | null;
    identityStable: boolean | null;
    provisionalToFinalComplete: boolean | null;
    validMarketPrice: boolean | null;
    validPriceProvenance: boolean | null;
    settlementMatchesOfficialGrade: boolean | null;
    officialFinalScoreMatches: boolean | null;
    comparableClosingMatchesSettlement: boolean | null;
    clvArithmeticValid: boolean | null;
    persistenceMonotonic: boolean;
  };
  settlement: {
    eventId: string | null;
    settledAt: string | null;
    source: string | null;
    correctionOfEventId: string | null;
    result: string | null;
    outcomeValue: number | null;
    finalScore: { home: number; away: number } | null;
    profitUnits: number | null;
    closingOddsAmerican: number | null;
    closingLine: number | null;
    clvPp: number | null;
  };
  officialVerification: {
    gameAvailable: boolean;
    gameFinal: boolean;
    gamePk: number | null;
    finalScore: { home: number; away: number } | null;
    gradedResult: string | null;
    gradedOutcomeValue: number | null;
    note: string | null;
  };
  closing: {
    observationId: string | null;
    capturedAt: string | null;
    classification: string | null;
    comparable: boolean;
    closingOddsAmerican: number | null;
    closingLine: number | null;
    sourceBooks: string[];
  };
  persistence: {
    ledgerImmutable: true;
    previousOwnedLedgerRecords: number | null;
    currentOwnedLedgerRecords: number;
    countMonotonic: boolean;
  };
  issues: S6jIssue[];
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    historicalLedgerMutation: false;
    automaticPromotion: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type S6jStatus = {
  schemaVersion: typeof MLB_S6J_FIRST_CYCLE_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: S6jFirstCycleReport | null;
};

type TargetPointer = {
  schemaVersion: typeof MLB_S6J_FIRST_CYCLE_VERSION;
  selectedAt: string;
  rootPredictionId: string;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function sameOptionalNumber(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return Math.abs(left - right) < 1e-9;
}

function validIso(value: unknown): string | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isStandardAmericanOdds(value: unknown): boolean {
  const odds = finite(value);
  return odds != null && Number.isInteger(odds) && Math.abs(odds) >= 100 && Math.abs(odds) <= 100_000;
}

function impliedProbability(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function isS5cRecord(record: LedgerRecord): boolean {
  return (record.prediction.payload as any)?.analysis?.layers?.s5c?.schemaVersion === "mlb-s5c-shadow-ingestion.v1";
}

function priceEvidence(record: LedgerRecord) {
  const payload = record.prediction.payload as any;
  const integrity = payload?.analysis?.layers?.marketPriceIntegrity ?? {};
  const capture = payload?.analysis?.rawInputs?.priceCapture ?? {};
  const provenance = payload?.analysis?.rawInputs?.marketProvenance ?? {};
  const capturedAt = validIso(payload?.market?.capturedAt ?? capture?.capturedAt);
  const consensusMethod = String(
    capture?.consensusMethod
      ?? provenance?.consensusMethod
      ?? integrity?.consensusMethod
      ?? "",
  ).trim() || null;
  const books = Array.isArray(provenance?.contributingBooks)
    ? [...new Set(provenance.contributingBooks.map((entry: unknown) => String(entry ?? "").trim().toLowerCase()).filter(Boolean))].sort()
    : [];
  const lineupCounts = payload?.analysis?.layers?.s5c?.lineupCounts ?? {};
  return {
    capturedAt,
    consensusMethod,
    books,
    validated: integrity?.standardAmericanOddsValidated === true,
    lineupHome: finite(lineupCounts?.home),
    lineupAway: finite(lineupCounts?.away),
  };
}

function issue(code: S6jIssueCode, severity: S6jIssue["severity"], message: string): S6jIssue {
  return { code, severity, message };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function stableDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S6J_FIRST_CYCLE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6J_FIRST_CYCLE_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6j-first-clean-cycle");
}

function rootIdFor(record: LedgerRecord, byId: Map<string, LedgerRecord>): string {
  const visited = new Set<string>();
  let current = record;
  while (current.prediction.supersedesId && !visited.has(current.prediction.id)) {
    visited.add(current.prediction.id);
    const parent = byId.get(current.prediction.supersedesId);
    if (!parent) break;
    current = parent;
  }
  return current.prediction.id;
}

function groupS5cChains(records: LedgerRecord[]): Map<string, LedgerRecord[]> {
  const s5c = records.filter(isS5cRecord);
  const byId = new Map(s5c.map((record) => [record.prediction.id, record]));
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of s5c) {
    const rootId = rootIdFor(record, byId);
    const chain = groups.get(rootId) ?? [];
    chain.push(record);
    groups.set(rootId, chain);
  }
  for (const chain of groups.values()) {
    chain.sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs || left.prediction.id.localeCompare(right.prediction.id));
  }
  return groups;
}

export function selectFirstCleanCycleTarget(records: LedgerRecord[]): string | null {
  const groups = groupS5cChains(records);
  const candidates = [...groups.entries()]
    .filter(([, chain]) => chain.length > 0)
    .filter(([, chain]) => chain.every((record) => record.prediction.recordedAtMs >= CUTOFF_MS))
    .filter(([, chain]) => chain.some((record) => record.prediction.analysisStage === "PROVISIONAL"))
    .sort((left, right) => {
      const leftStart = Date.parse(String(left[1][0]?.prediction.game.commenceTime ?? ""));
      const rightStart = Date.parse(String(right[1][0]?.prediction.game.commenceTime ?? ""));
      const startOrder = (Number.isFinite(leftStart) ? leftStart : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(rightStart) ? rightStart : Number.MAX_SAFE_INTEGER);
      if (startOrder !== 0) return startOrder;
      const recordedOrder = (left[1][0]?.prediction.recordedAtMs ?? 0) - (right[1][0]?.prediction.recordedAtMs ?? 0);
      if (recordedOrder !== 0) return recordedOrder;
      return left[0].localeCompare(right[0]);
    });
  return candidates[0]?.[0] ?? null;
}

function linearTerminal(chain: LedgerRecord[]): { terminal: LedgerRecord | null; branch: boolean; broken: boolean } {
  if (!chain.length) return { terminal: null, branch: false, broken: false };
  const byId = new Map(chain.map((record) => [record.prediction.id, record]));
  const children = new Map<string, LedgerRecord[]>();
  let broken = false;
  for (const record of chain) {
    const parentId = record.prediction.supersedesId;
    if (!parentId) continue;
    if (!byId.has(parentId)) broken = true;
    const values = children.get(parentId) ?? [];
    values.push(record);
    children.set(parentId, values);
  }
  const branch = [...children.values()].some((values) => values.length > 1);
  const terminals = chain.filter((record) => !(children.get(record.prediction.id)?.length));
  terminals.sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs || left.prediction.id.localeCompare(right.prediction.id));
  return { terminal: terminals[terminals.length - 1] ?? null, branch: branch || terminals.length > 1, broken };
}

function identityStable(chain: LedgerRecord[]): boolean {
  if (!chain.length) return false;
  const first = chain[0].prediction;
  return chain.every(({ prediction }) => {
    const sameGame = first.game.gamePk != null && prediction.game.gamePk != null
      ? first.game.gamePk === prediction.game.gamePk
      : first.game.gameDate === prediction.game.gameDate
        && normalize(first.game.homeTeam) === normalize(prediction.game.homeTeam)
        && normalize(first.game.awayTeam) === normalize(prediction.game.awayTeam);
    return sameGame
      && first.market.type === prediction.market.type
      && normalize(first.market.selection) === normalize(prediction.market.selection)
      && sameOptionalNumber(first.market.line, prediction.market.line);
  });
}

function latestComparableObservation(observations: S5eConsensusObservation[]): S5eConsensusObservation | null {
  return observations
    .filter((observation) => observation.comparable && observation.closingOddsAmerican != null)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .at(-1) ?? null;
}

function parseOfficialGame(gamePk: number, payload: any): OfficialMlbGame | null {
  const status = payload?.gameData?.status;
  const final = status?.abstractGameState === "Final"
    || status?.codedGameState === "F"
    || status?.detailedState === "Final";
  if (!final) return null;
  const innings = (payload?.liveData?.linescore?.innings ?? [])
    .map((inning: any) => ({
      num: Number(inning?.num),
      home: Number(inning?.home?.runs ?? 0),
      away: Number(inning?.away?.runs ?? 0),
    }))
    .filter((inning: { num: number }) => Number.isFinite(inning.num));
  const homeScore = Number(
    payload?.liveData?.linescore?.teams?.home?.runs
      ?? innings.reduce((sum: number, inning: { home: number }) => sum + inning.home, 0),
  );
  const awayScore = Number(
    payload?.liveData?.linescore?.teams?.away?.runs
      ?? innings.reduce((sum: number, inning: { away: number }) => sum + inning.away, 0),
  );
  return {
    gamePk,
    gameDate: String(payload?.gameData?.datetime?.officialDate ?? "").slice(0, 10),
    final,
    homeTeam: String(payload?.gameData?.teams?.home?.name ?? "Home"),
    awayTeam: String(payload?.gameData?.teams?.away?.name ?? "Away"),
    homeScore,
    awayScore,
    innings,
  };
}

export function buildMlbS6jFirstCycleCertification(
  records: LedgerRecord[],
  options: {
    targetRootId: string | null;
    observations?: S5eConsensusObservation[];
    officialGame?: OfficialMlbGame | null;
    officialFetchError?: string | null;
    now?: Date;
    trigger?: string;
    previousOwnedLedgerRecords?: number | null;
    deploymentCommit?: string;
    environment?: string;
  },
): S6jFirstCycleReport {
  const now = options.now ?? new Date();
  const groups = groupS5cChains(records);
  const targetRootId = options.targetRootId;
  const chain = targetRootId ? groups.get(targetRootId) ?? [] : [];
  const terminalResult = linearTerminal(chain);
  const terminal = terminalResult.terminal;
  const observations = terminal
    ? (options.observations ?? []).filter((item) => item.predictionId === terminal.prediction.id)
    : [];
  const closing = latestComparableObservation(observations);
  const issues: S6jIssue[] = [];
  const previousCount = options.previousOwnedLedgerRecords ?? null;
  const countMonotonic = previousCount == null || records.length >= previousCount;

  if (!countMonotonic) {
    issues.push(issue("PERSISTENCE_COUNT_REGRESSION", "CRITICAL", `Owned ledger count decreased from ${previousCount} to ${records.length}.`));
  }
  if (!targetRootId || !chain.length || !terminal) {
    issues.push(issue("TARGET_NOT_FOUND", "INFO", "No pure post-fix PROVISIONAL decision chain is available yet."));
  }

  const purePostFixChain = chain.length ? chain.every((record) => record.prediction.recordedAtMs >= CUTOFF_MS) : null;
  if (purePostFixChain === false) {
    issues.push(issue("TARGET_CHAIN_CROSSES_CUTOFF", "CRITICAL", "The selected lifecycle chain contains a pre-fix record."));
  }
  if (terminalResult.branch) {
    issues.push(issue("TARGET_CHAIN_BRANCH", "CRITICAL", "The selected lifecycle has multiple terminal descendants."));
  }
  if (terminalResult.broken) {
    issues.push(issue("BROKEN_SUPERSESSION", "CRITICAL", "A supersedesId in the selected lifecycle does not resolve inside the chain."));
  }

  const stableIdentity = chain.length ? identityStable(chain) : null;
  if (stableIdentity === false) {
    issues.push(issue("IDENTITY_CHANGED", "CRITICAL", "Game, market, selection, or line changed inside the lifecycle chain."));
  }

  const provisionalStages = chain.filter((record) => record.prediction.analysisStage === "PROVISIONAL").length;
  const finalStages = chain.filter((record) => record.prediction.analysisStage === "FINAL").length;
  if (chain.length && provisionalStages === 0) {
    issues.push(issue("NO_PROVISIONAL_STAGE", "CRITICAL", "The target lifecycle does not contain an initial PROVISIONAL stage."));
  }

  const commenceMs = terminal ? Date.parse(String(terminal.prediction.game.commenceTime ?? "")) : NaN;
  const started = Number.isFinite(commenceMs) && commenceMs <= now.getTime();
  const terminalIsFinal = terminal?.prediction.analysisStage === "FINAL";
  if (terminal && started && !terminalIsFinal) {
    issues.push(issue("FINAL_MISSING_AFTER_START", "CRITICAL", "The game started without a terminal FINAL snapshot."));
  }

  const terminalPrice = terminal ? priceEvidence(terminal) : null;
  const finalCaptureMs = terminalPrice?.capturedAt ? Date.parse(terminalPrice.capturedAt) : terminal?.prediction.recordedAtMs ?? NaN;
  const finalBeforeStart = terminalIsFinal && Number.isFinite(commenceMs) && Number.isFinite(finalCaptureMs)
    ? finalCaptureMs <= commenceMs + FINAL_CAPTURE_GRACE_MS
    : terminalIsFinal ? null : null;
  if (terminalIsFinal && finalBeforeStart === false) {
    issues.push(issue("FINAL_CAPTURED_AFTER_START", "CRITICAL", "The FINAL market snapshot was captured after the permitted game-start grace period."));
  }

  const lineupsConfirmed = terminalIsFinal && terminalPrice
    ? (terminalPrice.lineupHome ?? 0) >= 9 && (terminalPrice.lineupAway ?? 0) >= 9
    : terminalIsFinal ? false : null;
  if (terminalIsFinal && lineupsConfirmed === false) {
    issues.push(issue("FINAL_LINEUP_EVIDENCE_INCOMPLETE", "CRITICAL", "The FINAL snapshot does not contain two confirmed nine-player batting orders."));
  }

  const validMarketPrice = terminal ? isStandardAmericanOdds(terminal.prediction.market.oddsAmerican) : null;
  if (validMarketPrice === false) {
    issues.push(issue("INVALID_AMERICAN_ODDS", "CRITICAL", `Terminal American odds ${terminal?.prediction.market.oddsAmerican} are non-standard.`));
  }
  const validPriceProvenance = terminalPrice
    ? terminalPrice.validated
      && terminalPrice.capturedAt != null
      && terminalPrice.consensusMethod === MLB_S6I_REQUIRED_CONSENSUS_METHOD
      && terminalPrice.books.length > 0
    : null;
  if (validPriceProvenance === false) {
    issues.push(issue("PRICE_PROVENANCE_INVALID", "CRITICAL", "Terminal price capture time, consensus method, books, or validation flag is incomplete."));
  }

  const settlement = terminal?.settlement ?? null;
  if (terminalIsFinal && !settlement && Number.isFinite(commenceMs) && commenceMs + SETTLEMENT_OVERDUE_MS <= now.getTime()) {
    issues.push(issue("SETTLEMENT_OVERDUE", "CRITICAL", "The FINAL target remains unsettled more than 12 hours after scheduled start."));
  }
  const settlementSourceValid = settlement
    ? settlement.source === "official" || (settlement.source === "correction" && settlement.correctionOfEventId != null)
    : null;
  if (settlementSourceValid === false) {
    issues.push(issue("SETTLEMENT_SOURCE_INVALID", "CRITICAL", `Settlement source ${settlement?.source} is not an official event or append-only correction.`));
  }
  if (settlement && Math.abs(Number(settlement.profitUnits ?? 0)) > 1e-9) {
    issues.push(issue("SHADOW_PROFIT_NONZERO", "CRITICAL", `Shadow settlement profit must remain 0 units, received ${settlement.profitUnits}.`));
  }

  const officialGame = options.officialGame ?? null;
  const officialGrade = terminal && officialGame ? gradeMlbPrediction(terminal.prediction, officialGame) : null;
  if (options.officialFetchError) {
    issues.push(issue("OFFICIAL_GAME_UNAVAILABLE", "WARNING", options.officialFetchError));
  }
  if (settlement && officialGame && !officialGrade) {
    issues.push(issue("OFFICIAL_GRADE_UNSUPPORTED", "CRITICAL", "The official final feed could not independently grade the terminal market."));
  }

  const settlementResultMatches = settlement && officialGrade
    ? settlement.result === officialGrade.result
    : settlement ? null : null;
  if (settlementResultMatches === false) {
    issues.push(issue("SETTLEMENT_RESULT_MISMATCH", "CRITICAL", `Stored result ${settlement?.result} differs from independent official grade ${officialGrade?.result}.`));
  }
  const settlementOutcomeMatches = settlement && officialGrade && settlement.outcomeValue != null
    ? Math.abs(settlement.outcomeValue - officialGrade.outcomeValue) <= 1e-9
    : settlement && officialGrade ? false : null;
  if (settlementOutcomeMatches === false) {
    issues.push(issue("SETTLEMENT_OUTCOME_MISMATCH", "CRITICAL", "Stored outcomeValue differs from the independent official grade."));
  }
  const officialFinalScoreMatches = settlement && officialGame && settlement.finalScore
    ? settlement.finalScore.home === officialGame.homeScore && settlement.finalScore.away === officialGame.awayScore
    : settlement && officialGame ? false : null;
  if (officialFinalScoreMatches === false) {
    issues.push(issue("FINAL_SCORE_MISMATCH", "CRITICAL", "Stored final score differs from the official MLB final feed."));
  }

  const comparableClosingMatches = settlement && closing
    ? settlement.closingOddsAmerican === closing.closingOddsAmerican
      && (terminal?.prediction.market.type !== "F5_TOTAL" || sameOptionalNumber(settlement.closingLine, closing.closingLine))
    : settlement ? null : null;
  if (settlement && closing && settlement.closingOddsAmerican !== closing.closingOddsAmerican) {
    issues.push(issue("CLOSING_PRICE_MISMATCH", "CRITICAL", "Settlement closing price does not match the comparable S5E consensus observation."));
  }
  if (settlement && closing && terminal?.prediction.market.type === "F5_TOTAL" && !sameOptionalNumber(settlement.closingLine, closing.closingLine)) {
    issues.push(issue("CLOSING_LINE_MISMATCH", "CRITICAL", "Settlement closing line does not match the comparable S5E consensus observation."));
  }

  const expectedClvPp = terminal && settlement?.closingOddsAmerican != null
    ? (impliedProbability(settlement.closingOddsAmerican) - terminal.prediction.probabilities.marketImplied) * 100
    : null;
  const clvArithmeticValid = expectedClvPp != null && settlement?.clvPp != null
    ? Math.abs(expectedClvPp - settlement.clvPp) <= ARITHMETIC_TOLERANCE_PP
    : settlement ? null : null;
  if (clvArithmeticValid === false) {
    issues.push(issue("CLV_ARITHMETIC_MISMATCH", "CRITICAL", `Stored CLV ${settlement?.clvPp} pp differs from formula ${round(expectedClvPp ?? 0)} pp.`));
  }

  const settledAtMs = settlement?.settledAt ? Date.parse(settlement.settledAt) : NaN;
  const closingGraceExpired = Number.isFinite(settledAtMs) && settledAtMs + CLOSING_CORRECTION_GRACE_MS <= now.getTime();
  if (settlement && (!closing || settlement.closingOddsAmerican == null || settlement.clvPp == null) && closingGraceExpired) {
    issues.push(issue("COMPARABLE_CLOSING_MISSING", "CRITICAL", "Comparable closing evidence and CLV were not attached within two hours of settlement."));
  }

  const critical = issues.some((entry) => entry.severity === "CRITICAL");
  let state: S6jState;
  if (critical) state = "ACTION_REQUIRED";
  else if (!terminal) state = "WAITING_FOR_TARGET";
  else if (!terminalIsFinal) state = "WAITING_FOR_FINAL";
  else if (!settlement) state = "WAITING_FOR_SETTLEMENT";
  else if (!officialGame || !officialGrade) state = "WAITING_FOR_OFFICIAL_VERIFICATION";
  else if (!closing || settlement.closingOddsAmerican == null || settlement.clvPp == null || comparableClosingMatches !== true || clvArithmeticValid !== true) state = "WAITING_FOR_CLOSING";
  else state = "CERTIFIED";

  const provisionalToFinalComplete = terminal
    ? provisionalStages > 0 && terminalIsFinal && finalBeforeStart === true && lineupsConfirmed === true
    : null;

  return {
    schemaVersion: MLB_S6J_FIRST_CYCLE_VERSION,
    generatedAt: now.toISOString(),
    trigger: options.trigger ?? "manual",
    deploymentCommit: options.deploymentCommit ?? "unknown",
    environment: options.environment ?? "unknown",
    state,
    cohort: {
      cutoff: MLB_S6I_CLEAN_COHORT_CUTOFF,
      requiredConsensusMethod: MLB_S6I_REQUIRED_CONSENSUS_METHOD,
    },
    target: {
      rootPredictionId: targetRootId,
      terminalPredictionId: terminal?.prediction.id ?? null,
      gamePk: terminal?.prediction.game.gamePk ?? null,
      gameDate: terminal?.prediction.game.gameDate ?? null,
      awayTeam: terminal?.prediction.game.awayTeam ?? null,
      homeTeam: terminal?.prediction.game.homeTeam ?? null,
      marketType: terminal?.prediction.market.type ?? null,
      selection: terminal?.prediction.market.selection ?? null,
      line: terminal?.prediction.market.line ?? null,
      commenceTime: terminal?.prediction.game.commenceTime ?? null,
    },
    lifecycle: {
      chainLength: chain.length,
      provisionalStages,
      finalStages,
      terminalStage: terminal?.prediction.analysisStage ?? null,
      terminalRecordedAt: terminal?.prediction.recordedAt ?? null,
      finalBeforeStart,
      lineupsConfirmed,
      settled: settlement != null,
      settlementSource: settlement?.source ?? null,
      settlementResult: settlement?.result ?? null,
      officialGradeResult: officialGrade?.result ?? null,
      comparableClosingCaptured: closing != null,
      clvCaptured: settlement?.clvPp != null,
    },
    checks: {
      purePostFixChain,
      linearSupersession: chain.length ? !terminalResult.branch && !terminalResult.broken : null,
      identityStable: stableIdentity,
      provisionalToFinalComplete,
      validMarketPrice,
      validPriceProvenance,
      settlementMatchesOfficialGrade: settlementResultMatches,
      officialFinalScoreMatches,
      comparableClosingMatchesSettlement: comparableClosingMatches,
      clvArithmeticValid,
      persistenceMonotonic: countMonotonic,
    },
    settlement: {
      eventId: settlement?.eventId ?? null,
      settledAt: settlement?.settledAt ?? null,
      source: settlement?.source ?? null,
      correctionOfEventId: settlement?.correctionOfEventId ?? null,
      result: settlement?.result ?? null,
      outcomeValue: settlement?.outcomeValue ?? null,
      finalScore: settlement?.finalScore ?? null,
      profitUnits: settlement?.profitUnits ?? null,
      closingOddsAmerican: settlement?.closingOddsAmerican ?? null,
      closingLine: settlement?.closingLine ?? null,
      clvPp: settlement?.clvPp ?? null,
    },
    officialVerification: {
      gameAvailable: officialGame != null,
      gameFinal: officialGame?.final ?? false,
      gamePk: officialGame?.gamePk ?? terminal?.prediction.game.gamePk ?? null,
      finalScore: officialGame ? { home: officialGame.homeScore, away: officialGame.awayScore } : null,
      gradedResult: officialGrade?.result ?? null,
      gradedOutcomeValue: officialGrade?.outcomeValue ?? null,
      note: officialGrade?.notes ?? options.officialFetchError ?? null,
    },
    closing: {
      observationId: closing?.observationId ?? null,
      capturedAt: closing?.capturedAt ?? null,
      classification: closing?.classification ?? null,
      comparable: closing?.comparable ?? false,
      closingOddsAmerican: closing?.closingOddsAmerican ?? null,
      closingLine: closing?.closingLine ?? null,
      sourceBooks: closing?.closingSourceBooks ?? [],
    },
    persistence: {
      ledgerImmutable: true,
      previousOwnedLedgerRecords: previousCount,
      currentOwnedLedgerRecords: records.length,
      countMonotonic,
    },
    issues,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      historicalLedgerMutation: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  };
}

export class MlbS6jFirstCycleCertificationService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly ownerUserId: number;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly fetcher: FetchLike;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    private readonly s5eCoverage: MlbS5eCoverageService,
    options: S6jOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6J_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6J_INITIAL_DELAY_MS, 150_000, 10_000);
    this.ownerUserId = options.ownerUserId;
    this.root = options.root ?? defaultRoot();
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetcher ?? fetch;
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.lastSuccessAt = this.readLatest()?.generatedAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): S6jFirstCycleReport | null {
    return readJson<S6jFirstCycleReport>(path.join(this.root, "latest.json"));
  }
  readTarget(): TargetPointer | null {
    const target = readJson<TargetPointer>(path.join(this.root, "target.json"));
    return target?.schemaVersion === MLB_S6J_FIRST_CYCLE_VERSION ? target : null;
  }
  status(): S6jStatus {
    return {
      schemaVersion: MLB_S6J_FIRST_CYCLE_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
    };
  }

  private records(): LedgerRecord[] {
    return ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
  }

  private ensureTarget(records: LedgerRecord[], now: Date): TargetPointer | null {
    const existing = this.readTarget();
    if (existing) return existing;
    const rootPredictionId = selectFirstCleanCycleTarget(records);
    if (!rootPredictionId) return null;
    const target: TargetPointer = {
      schemaVersion: MLB_S6J_FIRST_CYCLE_VERSION,
      selectedAt: now.toISOString(),
      rootPredictionId,
    };
    atomicWriteJson(path.join(this.root, "target.json"), target);
    return target;
  }

  private async officialGameFor(records: LedgerRecord[], targetRootId: string | null): Promise<{ game: OfficialMlbGame | null; error: string | null }> {
    if (!targetRootId) return { game: null, error: null };
    const chain = groupS5cChains(records).get(targetRootId) ?? [];
    const terminal = linearTerminal(chain).terminal;
    if (!terminal?.settlement || !terminal.prediction.game.gamePk) return { game: null, error: null };
    try {
      const url = `https://statsapi.mlb.com/api/v1.1/game/${terminal.prediction.game.gamePk}/feed/live`;
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": "CourtEdge-S6J/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return { game: null, error: `Official MLB feed returned HTTP ${response.status}.` };
      const payload = await response.json();
      return { game: parseOfficialGame(terminal.prediction.game.gamePk, payload), error: null };
    } catch (error) {
      return { game: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async run(trigger = "scheduled"): Promise<S6jFirstCycleReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = this.records();
      const target = this.ensureTarget(records, now);
      const official = await this.officialGameFor(records, target?.rootPredictionId ?? null);
      const report = buildMlbS6jFirstCycleCertification(records, {
        targetRootId: target?.rootPredictionId ?? null,
        observations: this.s5eCoverage.readObservations(),
        officialGame: official.game,
        officialFetchError: official.error,
        now,
        trigger,
        previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
      });
      atomicWriteJson(path.join(this.root, "latest.json"), report);
      const previousDigest = previous ? stableDigest({ ...previous, generatedAt: undefined, trigger: undefined }) : null;
      const currentDigest = stableDigest({ ...report, generatedAt: undefined, trigger: undefined });
      if (currentDigest !== previousDigest) {
        atomicWriteJson(
          path.join(this.root, "snapshots", `${report.generatedAt.replace(/[:.]/g, "-")}-${currentDigest.slice(0, 12)}.json`),
          report,
        );
      }
      this.lastSuccessAt = report.generatedAt;
      this.lastError = null;
      return report;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function startMlbS6jFirstCycleCertificationWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s5eCoverage: MlbS5eCoverageService,
  options: S6jOptions,
): { service: MlbS6jFirstCycleCertificationService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6jFirstCycleCertificationService(store, ownershipStore, s5eCoverage, options);
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6j] first clean cycle certification failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
