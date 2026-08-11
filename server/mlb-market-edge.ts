import { createHash } from "node:crypto";
import {
  MLB_P1_M6A2_MAX_QUOTE_AGE_MS,
  type MlbCanonicalMarketAvailability,
  type MlbNormalizedBookQuote,
  type MlbReferenceConsensusQuote,
  type MlbSelectionSide,
} from "./mlb-market-odds-normalizer";
import { getMlbMarketContract, type MlbMarketType } from "./mlb-market-contract";
import {
  mlbP1M4aAmericanToDecimal,
  mlbP1M4aAmericanToImpliedProbability,
} from "./mlb-p1-economic-decision-contract";
import type {
  MlbSelectiveOddsAcquisitionResult,
  MlbSelectiveOddsGameResult,
  MlbSelectiveOddsMarketThesis,
} from "./mlb-selective-odds-acquisition";

export const MLB_MARKET_EDGE_SCHEMA = "courtedge-p0-mlb-market-edge.v1" as const;
export const MLB_MARKET_EDGE_MAX_QUOTE_AGE_MS = MLB_P1_M6A2_MAX_QUOTE_AGE_MS;

export const MLB_MARKET_EDGE_SUPPORTED_MARKETS = [
  "ML",
  "F5_ML",
  "RUN_LINE",
  "TOTAL",
  "F5_TOTAL",
] as const;

export type MlbMarketEdgeSupportedMarket = typeof MLB_MARKET_EDGE_SUPPORTED_MARKETS[number];
export type MlbMarketEdgeModelPolicy =
  | "ML_F5_EDGE_CONFIDENCE_V2"
  | "RUN_LINE_COVER_PROBABILITY_V1"
  | "TOTAL_RUN_DIFFERENTIAL_V1"
  | "F5_TOTAL_RUN_DIFFERENTIAL_V1";
export type MlbMarketEdgeAssessmentStatus = "READY" | "UNAVAILABLE";
export type MlbMarketEdgeClassification =
  | "POSITIVE_EV"
  | "NO_POSITIVE_EV"
  | "MODEL_UNAVAILABLE"
  | "MODEL_INVALID"
  | "PUSH_PROBABILITY_REQUIRED"
  | "PRICE_UNUSABLE"
  | "QUOTE_STALE"
  | "THESIS_AMBIGUOUS"
  | "CONTRACT_BLOCKED";
export type MlbMarketEdgeReferenceAgreement =
  | "SUPPORTS_MODEL_EDGE"
  | "OPPOSES_MODEL_EDGE"
  | "NEUTRAL"
  | "UNAVAILABLE";

export interface MlbMarketProbabilityAssessment {
  gamePk: number;
  marketType: MlbMarketEdgeSupportedMarket;
  side: Extract<MlbSelectionSide, "HOME" | "AWAY" | "OVER" | "UNDER">;
  line: number | null;
  status: MlbMarketEdgeAssessmentStatus;
  sourcePolicy: MlbMarketEdgeModelPolicy;
  modelVersion: string;
  generatedAt: string;
  modelInputDigest: string;
  probabilitySemantics: "UNCONDITIONAL_SETTLEMENT";
  winProbability: number | null;
  pushProbability: number | null;
  unavailableReason: string | null;
}

export interface MlbMarketEdgePriceSnapshot {
  bookKey: string;
  bookTitle: string;
  selectedSide: Extract<MlbSelectionSide, "HOME" | "AWAY" | "OVER" | "UNDER">;
  selectedSelection: string;
  line: number | null;
  selectedOddsAmerican: number;
  oppositeOddsAmerican: number;
  selectedImpliedProbability: number;
  oppositeImpliedProbability: number;
  noVigDecisiveProbability: number;
  capturedAt: string;
  providerLastUpdate: string | null;
}

export interface MlbMarketEdgeFairPrice {
  decimal: number;
  american: number;
  modelWinProbability: number;
  modelPushProbability: number;
}

export interface MlbMarketEdgeMarketResult {
  marketType: MlbMarketEdgeSupportedMarket;
  providerMarketKey: string;
  intrinsicProjectionScope: MlbSelectiveOddsMarketThesis["intrinsicProjectionScope"];
  intrinsicThesisKinds: readonly MlbSelectiveOddsMarketThesis["intrinsicThesisKinds"][number][];
  supportingComponents: readonly MlbSelectiveOddsMarketThesis["supportingComponents"][number][];
  selectedSide: Extract<MlbSelectionSide, "HOME" | "AWAY" | "OVER" | "UNDER"> | null;
  selectedLine: number | null;
  classification: MlbMarketEdgeClassification;
  eligibleForOperatingEnvelope: boolean;
  model: {
    status: MlbMarketEdgeAssessmentStatus | "MISSING";
    sourcePolicy: MlbMarketEdgeModelPolicy | null;
    modelVersion: string | null;
    generatedAt: string | null;
    modelInputDigest: string | null;
    winProbability: number | null;
    pushProbability: number | null;
    lossProbability: number | null;
    decisiveWinProbability: number | null;
    pushProbabilityDerivedAsZero: boolean;
  };
  execution: MlbMarketEdgePriceSnapshot | null;
  reference: MlbMarketEdgePriceSnapshot | null;
  economics: {
    fairPrice: MlbMarketEdgeFairPrice | null;
    currentBreakEvenWinProbability: number | null;
    executionEdgePp: number | null;
    executionNoVigEdgePp: number | null;
    referenceNoVigEdgePp: number | null;
    expectedValuePerUnit: number | null;
    referenceAgreement: MlbMarketEdgeReferenceAgreement;
  };
  blockers: string[];
  warnings: string[];
}

export interface MlbMarketEdgeGameResult {
  gamePk: number;
  intrinsicRank: number;
  homeTeam: MlbSelectiveOddsGameResult["homeTeam"];
  awayTeam: MlbSelectiveOddsGameResult["awayTeam"];
  acquisitionStatus: MlbSelectiveOddsGameResult["status"];
  markets: readonly MlbMarketEdgeMarketResult[];
  summary: {
    thesisMarkets: number;
    positiveEvMarkets: number;
    noPositiveEvMarkets: number;
    blockedOrUnavailableMarkets: number;
    operatingEnvelopeEligibleMarkets: number;
  };
}

export interface MlbMarketEdgeResult {
  schemaVersion: typeof MLB_MARKET_EDGE_SCHEMA;
  generatedAt: string;
  sourceSelectiveOddsSchemaVersion: MlbSelectiveOddsAcquisitionResult["schemaVersion"];
  sourceRunId: string;
  games: readonly MlbMarketEdgeGameResult[];
  summary: {
    games: number;
    thesisMarkets: number;
    positiveEvMarkets: number;
    noPositiveEvMarkets: number;
    blockedOrUnavailableMarkets: number;
    operatingEnvelopeEligibleMarkets: number;
  };
  policy: {
    marketSpecificProbabilityRequired: true;
    probabilitySemanticsMustBeUnconditionalSettlement: true;
    pushAwareEconomicsRequired: true;
    pushProbabilityMayBeDerivedAsZeroOnlyWhenSettlementCannotPushAtQuotedLine: true;
    legacyBinaryEvAppliedToPushCapableMarkets: false;
    fixedEdgeFloorApplied: false;
    legacyM4aBetLeanThresholdsApplied: false;
    priceCanCreateIntrinsicThesis: false;
    intrinsicThesisDirectionPreserved: true;
    exactExecutionLineMustMatchModelAssessment: true;
    executionBookMustBeFreshAndExecutable: true;
    executionQuoteIdentityRevalidated: true;
    referenceBooksCanSubstituteExecution: false;
    referenceConsensusIsDiagnosticOnly: true;
    quoteFreshnessRecheckedAtEvaluation: true;
    providerLastUpdateFreshnessRecheckedAtEvaluation: true;
    modelInputDigestRecomputedBeforeEconomics: true;
    missingModelProvenanceFailsClosedWithoutThrow: true;
    marketRankingProduced: false;
    operatingEnvelopeApplied: false;
    eliteLabelProduced: false;
    recommendsBet: false;
    stakeCalculated: false;
    callsTheOddsApi: false;
    theOddsApiCreditsConsumed: 0;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
  safety: MlbSelectiveOddsAcquisitionResult["safety"];
}

export class MlbMarketEdgeInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MlbMarketEdgeInputError";
    this.code = code;
  }
}

function round(value: number, digits = 10): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validIso(value: unknown): boolean {
  return Number.isFinite(Date.parse(String(value ?? "")));
}

function sameLine(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right;
  return Math.abs(left - right) <= 1e-9;
}

function lineKey(line: number | null): string {
  return line == null ? "null" : round(line, 9).toFixed(9);
}

function assessmentKey(input: {
  gamePk: number;
  marketType: MlbMarketEdgeSupportedMarket;
  side: string;
  line: number | null;
}): string {
  return `${input.gamePk}:${input.marketType}:${input.side}:${lineKey(input.line)}`;
}

function expectedModelPolicy(market: MlbMarketEdgeSupportedMarket): MlbMarketEdgeModelPolicy {
  if (market === "ML" || market === "F5_ML") return "ML_F5_EDGE_CONFIDENCE_V2";
  if (market === "RUN_LINE") return "RUN_LINE_COVER_PROBABILITY_V1";
  if (market === "TOTAL") return "TOTAL_RUN_DIFFERENTIAL_V1";
  return "F5_TOTAL_RUN_DIFFERENTIAL_V1";
}

function thesisSide(thesis: MlbSelectiveOddsMarketThesis): Extract<MlbSelectionSide, "HOME" | "AWAY" | "OVER" | "UNDER"> | null {
  const sides = new Set<Extract<MlbSelectionSide, "HOME" | "AWAY" | "OVER" | "UNDER">>();
  for (const kind of thesis.intrinsicThesisKinds) {
    if (kind === "HOME_SIDE") sides.add("HOME");
    else if (kind === "AWAY_SIDE") sides.add("AWAY");
    else if (kind === "TOTAL_OVER") sides.add("OVER");
    else if (kind === "TOTAL_UNDER") sides.add("UNDER");
  }
  return sides.size === 1 ? [...sides][0] : null;
}

function timestampStillFresh(value: string | null, now: Date, futureToleranceMs: number): boolean {
  if (!value) return false;
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) return false;
  const ageMs = now.getTime() - timestampMs;
  return ageMs >= -futureToleranceMs && ageMs <= MLB_MARKET_EDGE_MAX_QUOTE_AGE_MS;
}

function quoteStillFresh(
  quote: MlbNormalizedBookQuote | MlbReferenceConsensusQuote,
  now: Date,
): boolean {
  return timestampStillFresh(quote.capturedAt, now, 60_000)
    && timestampStillFresh(quote.providerLastUpdate, now, 120_000);
}

function findSelectionPair(
  quote: MlbNormalizedBookQuote | MlbReferenceConsensusQuote,
  side: Extract<MlbSelectionSide, "HOME" | "AWAY" | "OVER" | "UNDER">,
): { selected: MlbNormalizedBookQuote["selections"][number]; opposite: MlbNormalizedBookQuote["selections"][number] } | null {
  const selected = quote.selections.find((entry) => entry.side === side);
  const opposite = quote.selections.find((entry) => entry.side !== side);
  return selected && opposite ? { selected, opposite } : null;
}

function priceSnapshot(
  quote: MlbNormalizedBookQuote | MlbReferenceConsensusQuote,
  side: Extract<MlbSelectionSide, "HOME" | "AWAY" | "OVER" | "UNDER">,
): MlbMarketEdgePriceSnapshot | null {
  const pair = findSelectionPair(quote, side);
  if (!pair) return null;
  const selectedImplied = mlbP1M4aAmericanToImpliedProbability(pair.selected.oddsAmerican);
  const oppositeImplied = mlbP1M4aAmericanToImpliedProbability(pair.opposite.oddsAmerican);
  if (selectedImplied == null || oppositeImplied == null || selectedImplied + oppositeImplied <= 0) return null;
  return {
    bookKey: quote.bookKey,
    bookTitle: quote.bookTitle,
    selectedSide: side,
    selectedSelection: pair.selected.selection,
    line: pair.selected.line,
    selectedOddsAmerican: pair.selected.oddsAmerican,
    oppositeOddsAmerican: pair.opposite.oddsAmerican,
    selectedImpliedProbability: round(selectedImplied, 12),
    oppositeImpliedProbability: round(oppositeImplied, 12),
    noVigDecisiveProbability: round(selectedImplied / (selectedImplied + oppositeImplied), 12),
    capturedAt: quote.capturedAt,
    providerLastUpdate: quote.providerLastUpdate,
  };
}

function marketCanPushAtLine(marketType: MlbMarketEdgeSupportedMarket, line: number | null): boolean {
  const contract = getMlbMarketContract(marketType as MlbMarketType);
  if (contract.settlementRule === "TWO_WAY_PUSH_ON_TIE") return true;
  if (contract.settlementRule === "RUN_LINE" || contract.settlementRule === "TOTAL" || contract.settlementRule === "TEAM_TOTAL") {
    return line != null && Math.abs(line - Math.round(line)) <= 1e-9;
  }
  return false;
}

function americanFromDecimal(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  return decimal >= 2
    ? round((decimal - 1) * 100, 6)
    : round(-100 / (decimal - 1), 6);
}

function fairPrice(winProbability: number, pushProbability: number): MlbMarketEdgeFairPrice | null {
  const nonPushProbability = 1 - pushProbability;
  if (winProbability <= 0 || nonPushProbability <= 0 || winProbability >= nonPushProbability) return null;
  const decimal = nonPushProbability / winProbability;
  const american = americanFromDecimal(decimal);
  if (american == null) return null;
  return {
    decimal: round(decimal, 8),
    american,
    modelWinProbability: round(winProbability, 12),
    modelPushProbability: round(pushProbability, 12),
  };
}

function expectedValuePerUnit(winProbability: number, pushProbability: number, oddsAmerican: number): number | null {
  const decimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  if (decimal == null) return null;
  const lossProbability = 1 - winProbability - pushProbability;
  if (lossProbability < -1e-10) return null;
  return round(winProbability * (decimal - 1) - Math.max(0, lossProbability), 10);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  if (typeof value === "number") return Number.isFinite(value) ? round(value, 12) : null;
  if (value === undefined) return null;
  return value;
}

export function buildMlbMarketProbabilityAssessmentDigest(input: Omit<MlbMarketProbabilityAssessment, "modelInputDigest">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}

function assessmentValidation(
  assessment: MlbMarketProbabilityAssessment,
  market: MlbMarketEdgeSupportedMarket,
  selectedLine: number | null,
): { ok: true; pushProbability: number; derivedZero: boolean; lossProbability: number } | { ok: false; classification: MlbMarketEdgeClassification; blocker: string } {
  if (assessment.status !== "READY") {
    return { ok: false, classification: "MODEL_UNAVAILABLE", blocker: assessment.unavailableReason || "MODEL_ASSESSMENT_UNAVAILABLE" };
  }
  if (assessment.sourcePolicy !== expectedModelPolicy(market)) {
    return { ok: false, classification: "MODEL_INVALID", blocker: "MODEL_SOURCE_POLICY_MISMATCH" };
  }
  if (assessment.probabilitySemantics !== "UNCONDITIONAL_SETTLEMENT") {
    return { ok: false, classification: "MODEL_INVALID", blocker: "MODEL_PROBABILITY_SEMANTICS_INVALID" };
  }
  if (
    typeof assessment.modelVersion !== "string"
    || !assessment.modelVersion.trim()
    || !validIso(assessment.generatedAt)
    || typeof assessment.modelInputDigest !== "string"
    || !/^[a-f0-9]{64}$/i.test(assessment.modelInputDigest)
  ) {
    return { ok: false, classification: "MODEL_INVALID", blocker: "MODEL_PROVENANCE_INVALID" };
  }
  const { modelInputDigest: _suppliedDigest, ...digestInput } = assessment;
  const expectedDigest = buildMlbMarketProbabilityAssessmentDigest(digestInput);
  if (assessment.modelInputDigest.toLowerCase() !== expectedDigest) {
    return { ok: false, classification: "MODEL_INVALID", blocker: "MODEL_INPUT_DIGEST_MISMATCH" };
  }
  if (!finiteProbability(assessment.winProbability) || assessment.winProbability <= 0 || assessment.winProbability >= 1) {
    return { ok: false, classification: "MODEL_INVALID", blocker: "MODEL_WIN_PROBABILITY_INVALID" };
  }
  const canPush = marketCanPushAtLine(market, selectedLine);
  if (!canPush) {
    if (assessment.pushProbability != null && Math.abs(assessment.pushProbability) > 1e-12) {
      return { ok: false, classification: "MODEL_INVALID", blocker: "MODEL_PUSH_PROBABILITY_NONZERO_FOR_NO_PUSH_CONTRACT" };
    }
    return {
      ok: true,
      pushProbability: 0,
      derivedZero: assessment.pushProbability == null,
      lossProbability: 1 - assessment.winProbability,
    };
  }
  if (!finiteProbability(assessment.pushProbability)) {
    return { ok: false, classification: "PUSH_PROBABILITY_REQUIRED", blocker: "MODEL_PUSH_PROBABILITY_REQUIRED" };
  }
  const lossProbability = 1 - assessment.winProbability - assessment.pushProbability;
  if (lossProbability < -1e-10 || assessment.winProbability + assessment.pushProbability >= 1) {
    return { ok: false, classification: "MODEL_INVALID", blocker: "MODEL_SETTLEMENT_PROBABILITIES_INVALID" };
  }
  return {
    ok: true,
    pushProbability: assessment.pushProbability,
    derivedZero: false,
    lossProbability: Math.max(0, lossProbability),
  };
}

function unavailableModel(): MlbMarketEdgeMarketResult["model"] {
  return {
    status: "MISSING",
    sourcePolicy: null,
    modelVersion: null,
    generatedAt: null,
    modelInputDigest: null,
    winProbability: null,
    pushProbability: null,
    lossProbability: null,
    decisiveWinProbability: null,
    pushProbabilityDerivedAsZero: false,
  };
}

function emptyEconomics(): MlbMarketEdgeMarketResult["economics"] {
  return {
    fairPrice: null,
    currentBreakEvenWinProbability: null,
    executionEdgePp: null,
    executionNoVigEdgePp: null,
    referenceNoVigEdgePp: null,
    expectedValuePerUnit: null,
    referenceAgreement: "UNAVAILABLE",
  };
}

function blockedMarket(
  thesis: MlbSelectiveOddsMarketThesis,
  classification: MlbMarketEdgeClassification,
  side: MlbMarketEdgeMarketResult["selectedSide"],
  line: number | null,
  blocker: string,
  model: MlbMarketEdgeMarketResult["model"] = unavailableModel(),
): MlbMarketEdgeMarketResult {
  return {
    marketType: thesis.canonicalMarketType,
    providerMarketKey: thesis.providerMarketKey,
    intrinsicProjectionScope: thesis.intrinsicProjectionScope,
    intrinsicThesisKinds: [...thesis.intrinsicThesisKinds],
    supportingComponents: [...thesis.supportingComponents],
    selectedSide: side,
    selectedLine: line,
    classification,
    eligibleForOperatingEnvelope: false,
    model,
    execution: null,
    reference: null,
    economics: emptyEconomics(),
    blockers: [blocker],
    warnings: [],
  };
}

function findMarketQuote(
  game: MlbSelectiveOddsGameResult,
  thesis: MlbSelectiveOddsMarketThesis,
): MlbCanonicalMarketAvailability | null {
  const matches = game.quoteMarkets.filter((market) =>
    market.marketType === thesis.canonicalMarketType && market.providerMarketKey === thesis.providerMarketKey);
  return matches.length === 1 ? matches[0] : null;
}

function evaluateMarket(
  game: MlbSelectiveOddsGameResult,
  thesis: MlbSelectiveOddsMarketThesis,
  assessments: ReadonlyMap<string, MlbMarketProbabilityAssessment>,
  now: Date,
): MlbMarketEdgeMarketResult {
  const marketType = thesis.canonicalMarketType;
  if (!MLB_MARKET_EDGE_SUPPORTED_MARKETS.includes(marketType)) {
    return blockedMarket(thesis, "CONTRACT_BLOCKED", null, null, "MARKET_NOT_SUPPORTED_BY_EDGE_V1");
  }
  const side = thesisSide(thesis);
  if (!side) return blockedMarket(thesis, "THESIS_AMBIGUOUS", null, null, "INTRINSIC_THESIS_DIRECTION_AMBIGUOUS");

  const marketQuote = findMarketQuote(game, thesis);
  if (!marketQuote || marketQuote.availability !== "EXECUTABLE" || marketQuote.execution.status !== "FRESH" || !marketQuote.execution.quote) {
    return blockedMarket(thesis, "PRICE_UNUSABLE", side, null, "FRESH_EXECUTABLE_HARDROCK_QUOTE_REQUIRED");
  }
  const executionQuote = marketQuote.execution.quote;
  if (executionQuote.bookKey !== "hardrockbet_fl" || executionQuote.providerMarketKey !== thesis.providerMarketKey) {
    return blockedMarket(thesis, "PRICE_UNUSABLE", side, null, "EXECUTION_QUOTE_IDENTITY_MISMATCH");
  }
  if (!quoteStillFresh(executionQuote, now)) {
    return blockedMarket(thesis, "QUOTE_STALE", side, null, "EXECUTION_QUOTE_EXPIRED_AT_MARKET_EDGE_EVALUATION");
  }
  const execution = priceSnapshot(executionQuote, side);
  if (!execution) return blockedMarket(thesis, "PRICE_UNUSABLE", side, null, "EXECUTION_BILATERAL_PAIR_INVALID");

  const assessment = assessments.get(assessmentKey({ gamePk: game.gamePk, marketType, side, line: execution.line }));
  if (!assessment) return blockedMarket(thesis, "MODEL_UNAVAILABLE", side, execution.line, "EXACT_MARKET_MODEL_ASSESSMENT_REQUIRED");
  const validation = assessmentValidation(assessment, marketType, execution.line);
  const modelBase: MlbMarketEdgeMarketResult["model"] = {
    status: assessment.status,
    sourcePolicy: assessment.sourcePolicy,
    modelVersion: typeof assessment.modelVersion === "string" ? assessment.modelVersion : null,
    generatedAt: typeof assessment.generatedAt === "string" ? assessment.generatedAt : null,
    modelInputDigest: typeof assessment.modelInputDigest === "string" ? assessment.modelInputDigest : null,
    winProbability: assessment.winProbability,
    pushProbability: assessment.pushProbability,
    lossProbability: null,
    decisiveWinProbability: null,
    pushProbabilityDerivedAsZero: false,
  };
  if (!validation.ok) return blockedMarket(thesis, validation.classification, side, execution.line, validation.blocker, modelBase);

  const winProbability = assessment.winProbability!;
  const pushProbability = validation.pushProbability;
  const lossProbability = validation.lossProbability;
  const decisiveDenominator = 1 - pushProbability;
  const decisiveWinProbability = decisiveDenominator > 0 ? winProbability / decisiveDenominator : Number.NaN;
  if (!Number.isFinite(decisiveWinProbability) || decisiveWinProbability <= 0 || decisiveWinProbability >= 1) {
    return blockedMarket(thesis, "MODEL_INVALID", side, execution.line, "MODEL_DECISIVE_PROBABILITY_INVALID", modelBase);
  }

  const currentDecimal = mlbP1M4aAmericanToDecimal(execution.selectedOddsAmerican);
  if (currentDecimal == null) return blockedMarket(thesis, "PRICE_UNUSABLE", side, execution.line, "EXECUTION_PRICE_INVALID", modelBase);
  const ev = expectedValuePerUnit(winProbability, pushProbability, execution.selectedOddsAmerican);
  if (ev == null) return blockedMarket(thesis, "MODEL_INVALID", side, execution.line, "PUSH_AWARE_EV_UNAVAILABLE", modelBase);
  const currentBreakEvenWinProbability = (1 - pushProbability) / currentDecimal;
  const executionEdgePp = (winProbability - currentBreakEvenWinProbability) * 100;
  const executionNoVigEdgePp = (decisiveWinProbability - execution.noVigDecisiveProbability) * 100;

  let reference: MlbMarketEdgePriceSnapshot | null = null;
  let referenceNoVigEdgePp: number | null = null;
  const warnings: string[] = [];
  const referenceQuote = marketQuote.reference.quote;
  if (
    marketQuote.reference.status === "FRESH"
    && referenceQuote
    && referenceQuote.providerMarketKey === thesis.providerMarketKey
    && quoteStillFresh(referenceQuote, now)
  ) {
    reference = priceSnapshot(referenceQuote, side);
    if (reference && sameLine(reference.line, execution.line)) {
      referenceNoVigEdgePp = (decisiveWinProbability - reference.noVigDecisiveProbability) * 100;
    } else {
      reference = null;
      warnings.push("REFERENCE_CONSENSUS_LINE_OR_PAIR_MISMATCH");
    }
  } else {
    warnings.push("REFERENCE_CONSENSUS_IDENTITY_OR_FRESHNESS_INVALID");
  }

  let referenceAgreement: MlbMarketEdgeReferenceAgreement = "UNAVAILABLE";
  if (referenceNoVigEdgePp != null) {
    if (referenceNoVigEdgePp > 1e-12) referenceAgreement = "SUPPORTS_MODEL_EDGE";
    else if (referenceNoVigEdgePp < -1e-12) referenceAgreement = "OPPOSES_MODEL_EDGE";
    else referenceAgreement = "NEUTRAL";
  }

  const model: MlbMarketEdgeMarketResult["model"] = {
    ...modelBase,
    pushProbability: round(pushProbability, 12),
    lossProbability: round(lossProbability, 12),
    decisiveWinProbability: round(decisiveWinProbability, 12),
    pushProbabilityDerivedAsZero: validation.derivedZero,
  };
  const classification: MlbMarketEdgeClassification = ev > 0 ? "POSITIVE_EV" : "NO_POSITIVE_EV";
  return {
    marketType,
    providerMarketKey: thesis.providerMarketKey,
    intrinsicProjectionScope: thesis.intrinsicProjectionScope,
    intrinsicThesisKinds: [...thesis.intrinsicThesisKinds],
    supportingComponents: [...thesis.supportingComponents],
    selectedSide: side,
    selectedLine: execution.line,
    classification,
    eligibleForOperatingEnvelope: classification === "POSITIVE_EV",
    model,
    execution,
    reference,
    economics: {
      fairPrice: fairPrice(winProbability, pushProbability),
      currentBreakEvenWinProbability: round(currentBreakEvenWinProbability, 12),
      executionEdgePp: round(executionEdgePp, 8),
      executionNoVigEdgePp: round(executionNoVigEdgePp, 8),
      referenceNoVigEdgePp: referenceNoVigEdgePp == null ? null : round(referenceNoVigEdgePp, 8),
      expectedValuePerUnit: ev,
      referenceAgreement,
    },
    blockers: [],
    warnings,
  };
}

function validateAssessments(assessments: readonly MlbMarketProbabilityAssessment[]): Map<string, MlbMarketProbabilityAssessment> {
  const map = new Map<string, MlbMarketProbabilityAssessment>();
  for (const assessment of assessments) {
    if (!Number.isInteger(assessment.gamePk) || assessment.gamePk <= 0) {
      throw new MlbMarketEdgeInputError("MODEL_GAME_PK_INVALID", `invalid model gamePk ${assessment.gamePk}`);
    }
    if (!MLB_MARKET_EDGE_SUPPORTED_MARKETS.includes(assessment.marketType)) {
      throw new MlbMarketEdgeInputError("MODEL_MARKET_UNSUPPORTED", `unsupported model market ${assessment.marketType}`);
    }
    const key = assessmentKey(assessment);
    if (map.has(key)) throw new MlbMarketEdgeInputError("DUPLICATE_MODEL_ASSESSMENT", `duplicate model assessment ${key}`);
    map.set(key, assessment);
  }
  return map;
}

export function evaluateMlbMarketEdges(input: {
  acquisition: MlbSelectiveOddsAcquisitionResult;
  modelAssessments: readonly MlbMarketProbabilityAssessment[];
  now?: Date;
}): MlbMarketEdgeResult {
  const now = input.now ?? new Date();
  const assessmentMap = validateAssessments(input.modelAssessments);
  const games = input.acquisition.games.map<MlbMarketEdgeGameResult>((game) => {
    const markets = game.marketTheses.map((marketThesis) => evaluateMarket(game, marketThesis, assessmentMap, now));
    return {
      gamePk: game.gamePk,
      intrinsicRank: game.intrinsicRank,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      acquisitionStatus: game.status,
      markets,
      summary: {
        thesisMarkets: markets.length,
        positiveEvMarkets: markets.filter((market) => market.classification === "POSITIVE_EV").length,
        noPositiveEvMarkets: markets.filter((market) => market.classification === "NO_POSITIVE_EV").length,
        blockedOrUnavailableMarkets: markets.filter((market) => !["POSITIVE_EV", "NO_POSITIVE_EV"].includes(market.classification)).length,
        operatingEnvelopeEligibleMarkets: markets.filter((market) => market.eligibleForOperatingEnvelope).length,
      },
    };
  });
  const allMarkets = games.flatMap((game) => game.markets);
  return {
    schemaVersion: MLB_MARKET_EDGE_SCHEMA,
    generatedAt: now.toISOString(),
    sourceSelectiveOddsSchemaVersion: input.acquisition.schemaVersion,
    sourceRunId: input.acquisition.runId,
    games,
    summary: {
      games: games.length,
      thesisMarkets: allMarkets.length,
      positiveEvMarkets: allMarkets.filter((market) => market.classification === "POSITIVE_EV").length,
      noPositiveEvMarkets: allMarkets.filter((market) => market.classification === "NO_POSITIVE_EV").length,
      blockedOrUnavailableMarkets: allMarkets.filter((market) => !["POSITIVE_EV", "NO_POSITIVE_EV"].includes(market.classification)).length,
      operatingEnvelopeEligibleMarkets: allMarkets.filter((market) => market.eligibleForOperatingEnvelope).length,
    },
    policy: {
      marketSpecificProbabilityRequired: true,
      probabilitySemanticsMustBeUnconditionalSettlement: true,
      pushAwareEconomicsRequired: true,
      pushProbabilityMayBeDerivedAsZeroOnlyWhenSettlementCannotPushAtQuotedLine: true,
      legacyBinaryEvAppliedToPushCapableMarkets: false,
      fixedEdgeFloorApplied: false,
      legacyM4aBetLeanThresholdsApplied: false,
      priceCanCreateIntrinsicThesis: false,
      intrinsicThesisDirectionPreserved: true,
      exactExecutionLineMustMatchModelAssessment: true,
      executionBookMustBeFreshAndExecutable: true,
      executionQuoteIdentityRevalidated: true,
      referenceBooksCanSubstituteExecution: false,
      referenceConsensusIsDiagnosticOnly: true,
      quoteFreshnessRecheckedAtEvaluation: true,
      providerLastUpdateFreshnessRecheckedAtEvaluation: true,
      modelInputDigestRecomputedBeforeEconomics: true,
      missingModelProvenanceFailsClosedWithoutThrow: true,
      marketRankingProduced: false,
      operatingEnvelopeApplied: false,
      eliteLabelProduced: false,
      recommendsBet: false,
      stakeCalculated: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
    safety: input.acquisition.safety,
  };
}
