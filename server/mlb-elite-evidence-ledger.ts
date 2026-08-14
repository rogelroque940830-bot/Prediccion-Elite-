import { createHash } from "node:crypto";
import type {
  MlbMarketEdgeMarketResult,
  MlbMarketEdgeResult,
} from "./mlb-market-edge";
import type {
  MlbOperatingEnvelopeMarketResult,
  MlbOperatingEnvelopeResult,
} from "./mlb-operating-envelope";
import type {
  MlbOperatingEnvelopeCalibrationObservation,
  MlbCalibrationOutcome,
  MlbCalibrationMarket,
  MlbCalibrationReferenceAgreement,
} from "./mlb-operating-envelope-calibration";

export const MLB_ELITE_EVIDENCE_LEDGER_SCHEMA = "courtedge-p0-mlb-elite-evidence-ledger.v1" as const;

export type MlbEliteEvidenceSettlementStatus = "PENDING" | "SETTLED";

export interface MlbEliteEvidenceCandidateSnapshot {
  sourceRunId: string;
  gameDate: string;
  gamePk: number;
  marketType: MlbOperatingEnvelopeMarketResult["marketType"];
  providerMarketKey: string;
  selectedSide: Exclude<MlbOperatingEnvelopeMarketResult["selectedSide"], null>;
  selectedLine: number | null;
  intrinsicProjectionScope: MlbOperatingEnvelopeMarketResult["intrinsicProjectionScope"];
  intrinsicThesisKinds: readonly string[];
  supportingComponents: readonly string[];
  modelWinProbability: number;
  modelPushProbability: number;
  modelVersion: string;
  modelInputDigest: string;
  expectedValuePerUnit: number;
  executionEdgePp: number;
  executionNoVigEdgePp: number;
  referenceNoVigEdgePp: number | null;
  referenceAgreement: MlbOperatingEnvelopeMarketResult["referenceAgreement"];
  executionBookKey: string;
  executionBookTitle: string;
  executionOddsAmerican: number;
  executionCapturedAt: string;
  executionProviderLastUpdate: string | null;
  capturedAt: string;
}

export interface MlbEliteEvidenceSettlement {
  status: "SETTLED";
  outcome: MlbCalibrationOutcome;
  settledAt: string;
  realizedProfitUnits: number;
  officialEvidenceId: string;
}

export interface MlbEliteEvidenceLedgerEntry {
  schemaVersion: typeof MLB_ELITE_EVIDENCE_LEDGER_SCHEMA;
  predictionId: string;
  candidate: MlbEliteEvidenceCandidateSnapshot;
  settlementStatus: MlbEliteEvidenceSettlementStatus;
  settlement: MlbEliteEvidenceSettlement | null;
}

export interface MlbEliteEvidenceLedger {
  schemaVersion: typeof MLB_ELITE_EVIDENCE_LEDGER_SCHEMA;
  sourceRunId: string;
  capturedAt: string;
  entries: readonly MlbEliteEvidenceLedgerEntry[];
  summary: {
    step11aEliteCandidates: number;
    capturedCandidates: number;
    pending: number;
    settled: number;
    captureRetentionPct: number;
  };
  policy: {
    capturesEveryStep11aEliteCandidate: true;
    additionalEligibilityFilterApplied: false;
    silentCandidateDropAllowed: false;
    step11aSummaryCountMustMatchRows: true;
    exactStep9EvidenceParityRequired: true;
    immutablePregameSnapshot: true;
    settlementMutatesPregameSnapshot: false;
    settlementOutcomeWhitelistRequired: true;
    missingClosingLineBlocksCapture: false;
    missingClosingLineBlocksSettlement: false;
    closingLineRequiredForCalibration: false;
    flatOneUnitSettlementOnly: true;
    stakeCalculated: false;
    betEliteLabelProduced: false;
    finalBetRecommendationProduced: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export interface MlbEliteEvidenceSettlementInput {
  predictionId: string;
  outcome: MlbCalibrationOutcome;
  settledAt: string;
  officialEvidenceId: string;
}

function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteProbability(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function validAmericanOdds(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && (value <= -100 || value >= 100);
}

function isCalibrationMarket(value: unknown): value is MlbCalibrationMarket {
  return value === "ML" || value === "F5_ML" || value === "RUN_LINE" || value === "TOTAL" || value === "F5_TOTAL";
}

function isCalibrationReferenceAgreement(value: unknown): value is MlbCalibrationReferenceAgreement {
  return value === "SUPPORTS_MODEL_EDGE" || value === "OPPOSES_MODEL_EDGE" || value === "NEUTRAL" || value === "UNAVAILABLE";
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function exactNumber(value: number | null): string {
  if (value === null) return "null";
  if (Object.is(value, -0)) return "-0";
  return value.toString();
}

function sameLine(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Object.is(left, right) || left === right;
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Object.is(left, right) || left === right;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSettlementOutcome(value: unknown): value is MlbCalibrationOutcome {
  return value === "WIN" || value === "LOSS" || value === "PUSH";
}

function americanToDecimal(american: number): number {
  if (!validAmericanOdds(american)) throw new Error("MLB_ELITE_LEDGER_EXECUTION_ODDS_INVALID");
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function pushAwareExpectedValue(winProbability: number, pushProbability: number, americanOdds: number): number | null {
  if (!finiteProbability(winProbability) || !finiteProbability(pushProbability)) return null;
  const lossProbability = 1 - winProbability - pushProbability;
  if (lossProbability <= 0) return null;
  const decimal = americanToDecimal(americanOdds);
  return round(winProbability * (decimal - 1) - Math.max(0, lossProbability), 10);
}

function referenceAgreementMatches(edgePp: number | null, agreement: MlbCalibrationReferenceAgreement): boolean {
  if (agreement === "UNAVAILABLE") return edgePp === null;
  if (!finite(edgePp)) return false;
  if (edgePp > 1e-12) return agreement === "SUPPORTS_MODEL_EDGE";
  if (edgePp < -1e-12) return agreement === "OPPOSES_MODEL_EDGE";
  return agreement === "NEUTRAL";
}

function predictionIdentity(snapshot: Omit<MlbEliteEvidenceCandidateSnapshot, "capturedAt">): string {
  const raw = [
    snapshot.sourceRunId,
    snapshot.gamePk,
    snapshot.marketType,
    snapshot.providerMarketKey,
    snapshot.selectedSide,
    exactNumber(snapshot.selectedLine),
  ].join("|");
  return `mlb-elite-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

function exactMarketMatch(
  candidate: MlbOperatingEnvelopeMarketResult,
  edge: MlbMarketEdgeMarketResult,
): boolean {
  return candidate.marketType === edge.marketType
    && candidate.providerMarketKey === edge.providerMarketKey
    && candidate.selectedSide === edge.selectedSide
    && sameLine(candidate.selectedLine, edge.selectedLine);
}

function requireEdgeEvidence(candidate: MlbOperatingEnvelopeMarketResult, edge: MlbMarketEdgeMarketResult): void {
  if (candidate.classification !== "ELITE_EVIDENCE_CANDIDATE" || candidate.eliteEvidenceCandidate !== true) {
    throw new Error("MLB_ELITE_LEDGER_SOURCE_NOT_ELITE_CANDIDATE");
  }
  if (edge.classification !== "POSITIVE_EV" || edge.eligibleForOperatingEnvelope !== true) {
    throw new Error("MLB_ELITE_LEDGER_UPSTREAM_EDGE_IDENTITY_INVALID");
  }
  if (edge.model.status !== "READY" || !edge.execution) throw new Error("MLB_ELITE_LEDGER_REQUIRED_PREGAME_EVIDENCE_MISSING");
  if (!candidate.selectedSide || !finiteProbability(candidate.modelWinProbability)
    || !finiteProbability(candidate.modelPushProbability)
    || candidate.modelWinProbability + candidate.modelPushProbability >= 1
    || !finite(candidate.expectedValuePerUnit) || candidate.expectedValuePerUnit <= 0
    || !finite(candidate.executionEdgePp) || !finite(candidate.executionNoVigEdgePp)
    || !edge.model.modelVersion || !edge.model.modelInputDigest
    || !validAmericanOdds(edge.execution.selectedOddsAmerican) || !validIso(edge.execution.capturedAt)
    || !isCalibrationReferenceAgreement(candidate.referenceAgreement)
    || !referenceAgreementMatches(candidate.referenceNoVigEdgePp, candidate.referenceAgreement)) {
    throw new Error("MLB_ELITE_LEDGER_REQUIRED_PREGAME_EVIDENCE_INVALID");
  }

  const recomputedEv = pushAwareExpectedValue(
    candidate.modelWinProbability,
    candidate.modelPushProbability,
    edge.execution.selectedOddsAmerican,
  );
  if (recomputedEv === null
    || candidate.expectedValuePerUnit !== recomputedEv
    || edge.economics.expectedValuePerUnit !== recomputedEv) {
    throw new Error("MLB_ELITE_LEDGER_PUSH_AWARE_EV_MISMATCH");
  }
  if (!isCalibrationReferenceAgreement(edge.economics.referenceAgreement)
    || !referenceAgreementMatches(edge.economics.referenceNoVigEdgePp, edge.economics.referenceAgreement)) {
    throw new Error("MLB_ELITE_LEDGER_REFERENCE_EVIDENCE_INVALID");
  }

  const parity = candidate.intrinsicProjectionScope === edge.intrinsicProjectionScope
    && sameStringArray(candidate.intrinsicThesisKinds, edge.intrinsicThesisKinds)
    && sameStringArray(candidate.supportingComponents, edge.supportingComponents)
    && sameNullableNumber(candidate.modelWinProbability, edge.model.winProbability)
    && sameNullableNumber(candidate.modelPushProbability, edge.model.pushProbability)
    && sameNullableNumber(candidate.expectedValuePerUnit, edge.economics.expectedValuePerUnit)
    && sameNullableNumber(candidate.executionEdgePp, edge.economics.executionEdgePp)
    && sameNullableNumber(candidate.executionNoVigEdgePp, edge.economics.executionNoVigEdgePp)
    && sameNullableNumber(candidate.referenceNoVigEdgePp, edge.economics.referenceNoVigEdgePp)
    && candidate.referenceAgreement === edge.economics.referenceAgreement
    && edge.execution.selectedSide === candidate.selectedSide
    && sameLine(edge.execution.line, candidate.selectedLine);
  if (!parity) throw new Error("MLB_ELITE_LEDGER_STEP9_EVIDENCE_PARITY_MISMATCH");
}

function freezeCandidateSnapshot(snapshot: MlbEliteEvidenceCandidateSnapshot): MlbEliteEvidenceCandidateSnapshot {
  return Object.freeze({
    ...snapshot,
    intrinsicThesisKinds: Object.freeze([...snapshot.intrinsicThesisKinds]),
    supportingComponents: Object.freeze([...snapshot.supportingComponents]),
  });
}

function freezeLedgerEntry(entry: MlbEliteEvidenceLedgerEntry): MlbEliteEvidenceLedgerEntry {
  return Object.freeze({
    ...entry,
    candidate: freezeCandidateSnapshot(entry.candidate),
    settlement: entry.settlement ? Object.freeze({ ...entry.settlement }) : null,
  });
}

export function captureMlbEliteEvidenceLedger(input: {
  operatingEnvelope: MlbOperatingEnvelopeResult;
  marketEdge: MlbMarketEdgeResult;
  capturedAt: string;
  gameDateByGamePk: Readonly<Record<number, string>>;
}): MlbEliteEvidenceLedger {
  if (!validIso(input.capturedAt)) throw new Error("MLB_ELITE_LEDGER_CAPTURE_TIME_INVALID");
  if (input.operatingEnvelope.sourceRunId !== input.marketEdge.sourceRunId) {
    throw new Error("MLB_ELITE_LEDGER_SOURCE_RUN_MISMATCH");
  }
  if (input.operatingEnvelope.sourceMarketEdgeSchemaVersion !== input.marketEdge.schemaVersion) {
    throw new Error("MLB_ELITE_LEDGER_SOURCE_EDGE_SCHEMA_MISMATCH");
  }

  const candidates = input.operatingEnvelope.games.flatMap((game) => {
    const gameCandidates = game.markets.filter((market) =>
      market.classification === "ELITE_EVIDENCE_CANDIDATE" || market.eliteEvidenceCandidate === true);
    if (gameCandidates.length !== game.summary.eliteEvidenceCandidates) {
      throw new Error(`MLB_ELITE_LEDGER_STEP11A_GAME_SUMMARY_MISMATCH:${game.gamePk}`);
    }
    return gameCandidates.map((market) => ({ game, market }));
  });
  if (candidates.length !== input.operatingEnvelope.summary.eliteEvidenceCandidates) {
    throw new Error("MLB_ELITE_LEDGER_STEP11A_TOP_LEVEL_SUMMARY_MISMATCH");
  }

  const entries: MlbEliteEvidenceLedgerEntry[] = [];
  const seen = new Set<string>();

  for (const { game, market } of candidates) {
    if (market.classification !== "ELITE_EVIDENCE_CANDIDATE" || market.eliteEvidenceCandidate !== true) {
      throw new Error("MLB_ELITE_LEDGER_INCONSISTENT_STEP11A_CANDIDATE");
    }
    const edgeGames = input.marketEdge.games.filter((row) => row.gamePk === game.gamePk);
    if (edgeGames.length === 0) throw new Error("MLB_ELITE_LEDGER_EXACT_UPSTREAM_MARKET_NOT_FOUND");
    if (edgeGames.length !== 1) throw new Error(`MLB_ELITE_LEDGER_STEP9_GAME_IDENTITY_AMBIGUOUS:${game.gamePk}`);
    const edgeMatches = edgeGames[0].markets.filter((row) => exactMarketMatch(market, row));
    if (edgeMatches.length === 0) throw new Error("MLB_ELITE_LEDGER_EXACT_UPSTREAM_MARKET_NOT_FOUND");
    if (edgeMatches.length !== 1) throw new Error(`MLB_ELITE_LEDGER_STEP9_MARKET_IDENTITY_AMBIGUOUS:${game.gamePk}:${market.providerMarketKey}`);
    const edge = edgeMatches[0];
    requireEdgeEvidence(market, edge);

    const gameDate = input.gameDateByGamePk[game.gamePk];
    if (!gameDate || !validDate(gameDate)) throw new Error("MLB_ELITE_LEDGER_GAME_DATE_MISSING_OR_INVALID");

    const snapshotWithoutCapture: Omit<MlbEliteEvidenceCandidateSnapshot, "capturedAt"> = {
      sourceRunId: input.operatingEnvelope.sourceRunId,
      gameDate,
      gamePk: game.gamePk,
      marketType: market.marketType,
      providerMarketKey: market.providerMarketKey,
      selectedSide: market.selectedSide!,
      selectedLine: market.selectedLine,
      intrinsicProjectionScope: market.intrinsicProjectionScope,
      intrinsicThesisKinds: [...market.intrinsicThesisKinds],
      supportingComponents: [...market.supportingComponents],
      modelWinProbability: market.modelWinProbability!,
      modelPushProbability: market.modelPushProbability!,
      modelVersion: edge.model.modelVersion!,
      modelInputDigest: edge.model.modelInputDigest!,
      expectedValuePerUnit: market.expectedValuePerUnit!,
      executionEdgePp: market.executionEdgePp!,
      executionNoVigEdgePp: market.executionNoVigEdgePp!,
      referenceNoVigEdgePp: market.referenceNoVigEdgePp,
      referenceAgreement: market.referenceAgreement,
      executionBookKey: edge.execution!.bookKey,
      executionBookTitle: edge.execution!.bookTitle,
      executionOddsAmerican: edge.execution!.selectedOddsAmerican,
      executionCapturedAt: edge.execution!.capturedAt,
      executionProviderLastUpdate: edge.execution!.providerLastUpdate,
    };
    const predictionId = predictionIdentity(snapshotWithoutCapture);
    if (seen.has(predictionId)) throw new Error(`MLB_ELITE_LEDGER_DUPLICATE_CANDIDATE:${predictionId}`);
    seen.add(predictionId);

    entries.push({
      schemaVersion: MLB_ELITE_EVIDENCE_LEDGER_SCHEMA,
      predictionId,
      candidate: { ...snapshotWithoutCapture, capturedAt: input.capturedAt },
      settlementStatus: "PENDING",
      settlement: null,
    });
  }

  if (entries.length !== candidates.length) throw new Error("MLB_ELITE_LEDGER_SILENT_CANDIDATE_DROP_DETECTED");

  return buildLedger(input.operatingEnvelope.sourceRunId, input.capturedAt, entries, candidates.length);
}

function realizedProfitUnits(outcome: MlbCalibrationOutcome, americanOdds: number): number {
  if (outcome === "PUSH") return 0;
  if (outcome === "LOSS") return -1;
  return americanToDecimal(americanOdds) - 1;
}

function buildLedger(
  sourceRunId: string,
  capturedAt: string,
  entries: readonly MlbEliteEvidenceLedgerEntry[],
  baselineCandidates: number,
): MlbEliteEvidenceLedger {
  const immutableEntries = Object.freeze(entries.map((entry) => freezeLedgerEntry(entry)));
  const pending = immutableEntries.filter((entry) => entry.settlementStatus === "PENDING").length;
  const settled = immutableEntries.filter((entry) => entry.settlementStatus === "SETTLED").length;
  const summary = Object.freeze({
    step11aEliteCandidates: baselineCandidates,
    capturedCandidates: immutableEntries.length,
    pending,
    settled,
    captureRetentionPct: baselineCandidates > 0 ? (immutableEntries.length / baselineCandidates) * 100 : 100,
  });
  const policy = Object.freeze({
    capturesEveryStep11aEliteCandidate: true as const,
    additionalEligibilityFilterApplied: false as const,
    silentCandidateDropAllowed: false as const,
    step11aSummaryCountMustMatchRows: true as const,
    exactStep9EvidenceParityRequired: true as const,
    immutablePregameSnapshot: true as const,
    settlementMutatesPregameSnapshot: false as const,
    settlementOutcomeWhitelistRequired: true as const,
    missingClosingLineBlocksCapture: false as const,
    missingClosingLineBlocksSettlement: false as const,
    closingLineRequiredForCalibration: false as const,
    flatOneUnitSettlementOnly: true as const,
    stakeCalculated: false as const,
    betEliteLabelProduced: false as const,
    finalBetRecommendationProduced: false as const,
    automaticBetPlacement: false as const,
    realFinancialExposure: 0 as const,
  });
  return Object.freeze({
    schemaVersion: MLB_ELITE_EVIDENCE_LEDGER_SCHEMA,
    sourceRunId,
    capturedAt,
    entries: immutableEntries,
    summary,
    policy,
  });
}

export function settleMlbEliteEvidenceLedger(input: {
  ledger: MlbEliteEvidenceLedger;
  settlements: readonly MlbEliteEvidenceSettlementInput[];
}): MlbEliteEvidenceLedger {
  const requested = new Map<string, MlbEliteEvidenceSettlementInput>();
  for (const settlement of input.settlements) {
    if (!settlement.predictionId || !isSettlementOutcome((settlement as { outcome?: unknown }).outcome)
      || !validIso(settlement.settledAt) || !settlement.officialEvidenceId) {
      throw new Error("MLB_ELITE_LEDGER_SETTLEMENT_INPUT_INVALID");
    }
    if (requested.has(settlement.predictionId)) throw new Error(`MLB_ELITE_LEDGER_DUPLICATE_SETTLEMENT:${settlement.predictionId}`);
    requested.set(settlement.predictionId, settlement);
  }

  for (const predictionId of requested.keys()) {
    if (!input.ledger.entries.some((entry) => entry.predictionId === predictionId)) {
      throw new Error(`MLB_ELITE_LEDGER_UNKNOWN_SETTLEMENT:${predictionId}`);
    }
  }

  const entries = input.ledger.entries.map((entry) => {
    const settlementInput = requested.get(entry.predictionId);
    if (!settlementInput) return entry;
    if (entry.settlementStatus === "SETTLED") {
      if (entry.settlement?.outcome === settlementInput.outcome
        && entry.settlement.settledAt === settlementInput.settledAt
        && entry.settlement.officialEvidenceId === settlementInput.officialEvidenceId) return entry;
      throw new Error(`MLB_ELITE_LEDGER_CONFLICTING_SETTLEMENT:${entry.predictionId}`);
    }
    return {
      ...entry,
      settlementStatus: "SETTLED" as const,
      settlement: {
        status: "SETTLED" as const,
        outcome: settlementInput.outcome,
        settledAt: settlementInput.settledAt,
        realizedProfitUnits: realizedProfitUnits(settlementInput.outcome, entry.candidate.executionOddsAmerican),
        officialEvidenceId: settlementInput.officialEvidenceId,
      },
    };
  });

  return buildLedger(input.ledger.sourceRunId, input.ledger.capturedAt, entries, input.ledger.summary.step11aEliteCandidates);
}

function validatePersistedLedgerEntry(entry: MlbEliteEvidenceLedgerEntry, ledger: MlbEliteEvidenceLedger): void {
  if (entry.schemaVersion !== MLB_ELITE_EVIDENCE_LEDGER_SCHEMA || !entry.predictionId) {
    throw new Error("MLB_ELITE_LEDGER_PERSISTED_ENTRY_INVALID");
  }
  const candidate = entry.candidate;
  if (!candidate || candidate.sourceRunId !== ledger.sourceRunId || !validDate(candidate.gameDate)
    || !Number.isInteger(candidate.gamePk) || candidate.gamePk <= 0
    || !isCalibrationMarket((candidate as { marketType?: unknown }).marketType)
    || !candidate.providerMarketKey || !candidate.selectedSide
    || !finiteProbability(candidate.modelWinProbability) || candidate.modelWinProbability <= 0 || candidate.modelWinProbability >= 1
    || !finiteProbability(candidate.modelPushProbability)
    || candidate.modelWinProbability + candidate.modelPushProbability >= 1
    || !candidate.modelVersion || !candidate.modelInputDigest
    || !finite(candidate.expectedValuePerUnit) || candidate.expectedValuePerUnit <= 0
    || !finite(candidate.executionNoVigEdgePp) || !validAmericanOdds(candidate.executionOddsAmerican)
    || !isCalibrationReferenceAgreement((candidate as { referenceAgreement?: unknown }).referenceAgreement)
    || !referenceAgreementMatches(candidate.referenceNoVigEdgePp, candidate.referenceAgreement)
    || !validIso(candidate.executionCapturedAt) || !validIso(candidate.capturedAt)
    || candidate.capturedAt !== ledger.capturedAt) {
    throw new Error(`MLB_ELITE_LEDGER_PERSISTED_CANDIDATE_INVALID:${entry.predictionId}`);
  }
  const recomputedEv = pushAwareExpectedValue(
    candidate.modelWinProbability,
    candidate.modelPushProbability,
    candidate.executionOddsAmerican,
  );
  if (recomputedEv === null || candidate.expectedValuePerUnit !== recomputedEv) {
    throw new Error(`MLB_ELITE_LEDGER_PERSISTED_EV_INVALID:${entry.predictionId}`);
  }
  const { capturedAt: _capturedAt, ...identitySnapshot } = candidate;
  if (predictionIdentity(identitySnapshot) !== entry.predictionId) {
    throw new Error(`MLB_ELITE_LEDGER_PERSISTED_IDENTITY_MISMATCH:${entry.predictionId}`);
  }
  if (entry.settlementStatus !== "PENDING" && entry.settlementStatus !== "SETTLED") {
    throw new Error(`MLB_ELITE_LEDGER_SETTLEMENT_STATE_INVALID:${entry.predictionId}`);
  }
  if (entry.settlementStatus === "PENDING") {
    if (entry.settlement !== null) throw new Error(`MLB_ELITE_LEDGER_SETTLEMENT_STATE_INVALID:${entry.predictionId}`);
    return;
  }
  const settlement = entry.settlement;
  if (!settlement || settlement.status !== "SETTLED"
    || !isSettlementOutcome((settlement as { outcome?: unknown }).outcome)
    || !validIso(settlement.settledAt) || !settlement.officialEvidenceId
    || Date.parse(settlement.settledAt) < Date.parse(candidate.capturedAt)
    || !finite(settlement.realizedProfitUnits)) {
    throw new Error(`MLB_ELITE_LEDGER_SETTLEMENT_STATE_INVALID:${entry.predictionId}`);
  }
  const expectedProfit = realizedProfitUnits(settlement.outcome, candidate.executionOddsAmerican);
  if (Math.abs(settlement.realizedProfitUnits - expectedProfit) > 1e-12) {
    throw new Error(`MLB_ELITE_LEDGER_SETTLEMENT_PROFIT_INVALID:${entry.predictionId}`);
  }
}

function validatePersistedLedger(ledger: MlbEliteEvidenceLedger): void {
  if (ledger.schemaVersion !== MLB_ELITE_EVIDENCE_LEDGER_SCHEMA || !ledger.sourceRunId || !validIso(ledger.capturedAt)) {
    throw new Error("MLB_ELITE_LEDGER_PERSISTED_LEDGER_INVALID");
  }
  const seen = new Set<string>();
  for (const entry of ledger.entries) {
    if (seen.has(entry.predictionId)) throw new Error(`MLB_ELITE_LEDGER_DUPLICATE_CANDIDATE:${entry.predictionId}`);
    seen.add(entry.predictionId);
    validatePersistedLedgerEntry(entry, ledger);
  }
  const pending = ledger.entries.filter((entry) => entry.settlementStatus === "PENDING").length;
  const settled = ledger.entries.filter((entry) => entry.settlementStatus === "SETTLED").length;
  if (ledger.summary.step11aEliteCandidates !== ledger.entries.length
    || ledger.summary.capturedCandidates !== ledger.entries.length
    || ledger.summary.pending !== pending || ledger.summary.settled !== settled
    || ledger.summary.captureRetentionPct !== 100) {
    throw new Error("MLB_ELITE_LEDGER_PERSISTED_SUMMARY_INVALID");
  }
}

export function toMlbOperatingEnvelopeCalibrationObservations(
  ledger: MlbEliteEvidenceLedger,
): MlbOperatingEnvelopeCalibrationObservation[] {
  validatePersistedLedger(ledger);
  return ledger.entries
    .filter((entry): entry is MlbEliteEvidenceLedgerEntry & { settlement: MlbEliteEvidenceSettlement } => entry.settlementStatus === "SETTLED")
    .map((entry) => ({
      predictionId: entry.predictionId,
      gameDate: entry.candidate.gameDate,
      gamePk: entry.candidate.gamePk,
      marketType: entry.candidate.marketType,
      expectedValuePerUnit: entry.candidate.expectedValuePerUnit,
      executionNoVigEdgePp: entry.candidate.executionNoVigEdgePp,
      modelWinProbability: entry.candidate.modelWinProbability,
      referenceAgreement: entry.candidate.referenceAgreement,
      outcome: entry.settlement.outcome,
      realizedProfitUnits: entry.settlement.realizedProfitUnits,
    }));
}
