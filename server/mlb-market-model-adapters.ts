import {
  buildMlbMarketProbabilityAssessmentDigest,
  type MlbMarketEdgeModelPolicy,
  type MlbMarketEdgeSupportedMarket,
  type MlbMarketProbabilityAssessment,
} from "./mlb-market-edge";

export const MLB_MARKET_MODEL_ADAPTER_SCHEMA = "courtedge-p0-mlb-market-model-adapters.v1" as const;
export const MLB_MARKET_MODEL_ADAPTER_VERSION = "mlb-current-predictor-model-adapter.v1" as const;

export const MLB_MARKET_MODEL_ADAPTER_MARKETS = [
  "ML",
  "F5_ML",
  "RUN_LINE",
  "TOTAL",
  "F5_TOTAL",
] as const satisfies readonly MlbMarketEdgeSupportedMarket[];

export type MlbCurrentPredictorProbabilityMetric =
  | "ML_FINAL_SELECTED_PROBABILITY"
  | "F5_ML_FINAL_SELECTED_PROBABILITY"
  | "RUN_LINE_COVER_PROBABILITY"
  | "TOTAL_MODEL_HIT_PROBABILITY"
  | "F5_TOTAL_MODEL_HIT_PROBABILITY";

export interface MlbCurrentPredictorProbabilityEvidence {
  gamePk: number;
  marketType: MlbMarketEdgeSupportedMarket;
  side: "HOME" | "AWAY" | "OVER" | "UNDER";
  line: number | null;
  metric: MlbCurrentPredictorProbabilityMetric;
  probability: number | null;
  probabilityUsesSportsbookPrice: boolean;
  modelVersion: string;
  generatedAt: string;
  sourcePayloadDigest: string;
}

export interface MlbMarketModelAdapterResult {
  schemaVersion: typeof MLB_MARKET_MODEL_ADAPTER_SCHEMA;
  adapterVersion: typeof MLB_MARKET_MODEL_ADAPTER_VERSION;
  assessment: MlbMarketProbabilityAssessment;
  source: {
    metric: MlbCurrentPredictorProbabilityMetric;
    modelVersion: string;
    generatedAt: string;
    sourcePayloadDigest: string;
    probabilityUsesSportsbookPrice: boolean;
  };
  blockers: readonly string[];
  warnings: readonly string[];
  policy: {
    currentReadyMarkets: readonly ["TOTAL", "F5_TOTAL"];
    currentMoneylineReady: false;
    currentRunLineReady: false;
    currentTotalHalfRunReady: true;
    currentF5TotalHalfRunReady: true;
    legacyMarketRegressedProbabilityAccepted: false;
    integerLinePushMayBeInvented: false;
    a3aExactSettlementMathAvailable: true;
    a3aExperimentalShadowCanBecomeReady: false;
    unsupportedChallengersCanBePromoted: false;
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
}

const HEX_64 = /^[a-f0-9]{64}$/i;
const EPS = 1e-9;

const EXPECTED_METRIC: Readonly<Record<MlbMarketEdgeSupportedMarket, MlbCurrentPredictorProbabilityMetric>> = Object.freeze({
  ML: "ML_FINAL_SELECTED_PROBABILITY",
  F5_ML: "F5_ML_FINAL_SELECTED_PROBABILITY",
  RUN_LINE: "RUN_LINE_COVER_PROBABILITY",
  TOTAL: "TOTAL_MODEL_HIT_PROBABILITY",
  F5_TOTAL: "F5_TOTAL_MODEL_HIT_PROBABILITY",
});

const POLICY: Readonly<Record<MlbMarketEdgeSupportedMarket, MlbMarketEdgeModelPolicy>> = Object.freeze({
  ML: "ML_F5_EDGE_CONFIDENCE_V2",
  F5_ML: "ML_F5_EDGE_CONFIDENCE_V2",
  RUN_LINE: "RUN_LINE_COVER_PROBABILITY_V1",
  TOTAL: "TOTAL_RUN_DIFFERENTIAL_V1",
  F5_TOTAL: "F5_TOTAL_RUN_DIFFERENTIAL_V1",
});

export const MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY = Object.freeze({
  ML: "CURRENT_ML_PROBABILITY_MARKET_REGRESSED_AND_PUSH_VECTOR_UNAVAILABLE",
  F5_ML: "CURRENT_F5_ML_PROBABILITY_MARKET_REGRESSED_AND_PUSH_VECTOR_UNAVAILABLE",
  RUN_LINE: "CURRENT_RUN_LINE_PROBABILITY_DERIVED_FROM_MARKET_REGRESSED_ML",
  TOTAL: "PURE_MODEL_HALF_RUN_ONLY",
  F5_TOTAL: "PURE_MODEL_HALF_RUN_ONLY",
} as const);

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function sideValid(market: MlbMarketEdgeSupportedMarket, side: MlbCurrentPredictorProbabilityEvidence["side"]): boolean {
  if (market === "TOTAL" || market === "F5_TOTAL") return side === "OVER" || side === "UNDER";
  return side === "HOME" || side === "AWAY";
}

function lineIdentityValid(market: MlbMarketEdgeSupportedMarket, line: number | null): boolean {
  if (market === "ML" || market === "F5_ML") return line == null;
  return typeof line === "number" && Number.isFinite(line);
}

function isIntegerLine(line: number): boolean {
  return Math.abs(line - Math.round(line)) <= EPS;
}

function isExactHalfRunLine(line: number): boolean {
  return !isIntegerLine(line) && Math.abs(line * 2 - Math.round(line * 2)) <= EPS;
}

function assessmentWithDigest(
  input: Omit<MlbMarketProbabilityAssessment, "modelInputDigest">,
): MlbMarketProbabilityAssessment {
  return {
    ...input,
    modelInputDigest: buildMlbMarketProbabilityAssessmentDigest(input),
  };
}

function unavailable(
  evidence: MlbCurrentPredictorProbabilityEvidence,
  reason: string,
): MlbMarketProbabilityAssessment {
  return assessmentWithDigest({
    gamePk: evidence.gamePk,
    marketType: evidence.marketType,
    side: evidence.side,
    line: evidence.line,
    status: "UNAVAILABLE",
    sourcePolicy: POLICY[evidence.marketType],
    modelVersion: String(evidence.modelVersion ?? ""),
    generatedAt: String(evidence.generatedAt ?? ""),
    probabilitySemantics: "UNCONDITIONAL_SETTLEMENT",
    winProbability: null,
    pushProbability: null,
    unavailableReason: reason,
  });
}

function policy(): MlbMarketModelAdapterResult["policy"] {
  return {
    currentReadyMarkets: ["TOTAL", "F5_TOTAL"],
    currentMoneylineReady: false,
    currentRunLineReady: false,
    currentTotalHalfRunReady: true,
    currentF5TotalHalfRunReady: true,
    legacyMarketRegressedProbabilityAccepted: false,
    integerLinePushMayBeInvented: false,
    a3aExactSettlementMathAvailable: true,
    a3aExperimentalShadowCanBecomeReady: false,
    unsupportedChallengersCanBePromoted: false,
    marketRankingProduced: false,
    operatingEnvelopeApplied: false,
    eliteLabelProduced: false,
    recommendsBet: false,
    stakeCalculated: false,
    callsTheOddsApi: false,
    theOddsApiCreditsConsumed: 0,
    automaticBetPlacement: false,
    realFinancialExposure: 0,
  };
}

function result(
  evidence: MlbCurrentPredictorProbabilityEvidence,
  assessment: MlbMarketProbabilityAssessment,
  blockers: string[] = [],
  warnings: string[] = [],
): MlbMarketModelAdapterResult {
  return {
    schemaVersion: MLB_MARKET_MODEL_ADAPTER_SCHEMA,
    adapterVersion: MLB_MARKET_MODEL_ADAPTER_VERSION,
    assessment,
    source: {
      metric: evidence.metric,
      modelVersion: String(evidence.modelVersion ?? ""),
      generatedAt: String(evidence.generatedAt ?? ""),
      sourcePayloadDigest: String(evidence.sourcePayloadDigest ?? ""),
      probabilityUsesSportsbookPrice: evidence.probabilityUsesSportsbookPrice === true,
    },
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    policy: policy(),
  };
}

/**
 * Step 10 is an adapter, not a new sporting model.
 *
 * Current CourtEdge evidence audit (2026-08-11):
 * - ML/F5 ML final selected probabilities are market-regressed; F5 also needs
 *   explicit tie/push mass that the binary current model does not estimate.
 * - Run Line is derived from the already market-regressed full-game ML output.
 * - Total/F5 Total expose a pre-market modelHitProb. That probability may be
 *   adapted only on exact half-run lines, where an integer run total cannot push.
 * - The A3A discrete distribution has exact settlement math but is explicitly
 *   EXPERIMENTAL_SHADOW/actionabilityAllowed=false and cannot be promoted here.
 */
export function adaptMlbCurrentPredictorProbability(
  evidence: MlbCurrentPredictorProbabilityEvidence,
): MlbMarketModelAdapterResult {
  if (!Number.isInteger(evidence.gamePk) || evidence.gamePk <= 0) {
    const reason = "MODEL_EVIDENCE_GAME_ID_INVALID";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (!sideValid(evidence.marketType, evidence.side)) {
    const reason = "MODEL_EVIDENCE_SIDE_MARKET_MISMATCH";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (!lineIdentityValid(evidence.marketType, evidence.line)) {
    const reason = "MODEL_EVIDENCE_LINE_MARKET_MISMATCH";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (evidence.metric !== EXPECTED_METRIC[evidence.marketType]) {
    const reason = "MODEL_EVIDENCE_METRIC_MARKET_MISMATCH";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (
    typeof evidence.modelVersion !== "string"
    || !evidence.modelVersion.trim()
    || !validIso(evidence.generatedAt)
    || typeof evidence.sourcePayloadDigest !== "string"
    || !HEX_64.test(evidence.sourcePayloadDigest)
  ) {
    const reason = "MODEL_EVIDENCE_PROVENANCE_INVALID";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }

  if (evidence.marketType === "ML") {
    const reason = MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.ML;
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (evidence.marketType === "F5_ML") {
    const reason = MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.F5_ML;
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (evidence.marketType === "RUN_LINE") {
    const reason = MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.RUN_LINE;
    return result(evidence, unavailable(evidence, reason), [reason]);
  }

  if (evidence.probabilityUsesSportsbookPrice) {
    const reason = "MARKET_REGRESSED_PROBABILITY_REJECTED";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (!finiteProbability(evidence.probability)) {
    const reason = "PURE_MODEL_PROBABILITY_INVALID";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }

  const line = evidence.line as number;
  if (isIntegerLine(line)) {
    const reason = "INTEGER_LINE_REQUIRES_DISCRETE_PUSH_MODEL";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (!isExactHalfRunLine(line)) {
    const reason = "NON_HALF_RUN_LINE_REQUIRES_EXPLICIT_SETTLEMENT_MODEL";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }

  const assessment = assessmentWithDigest({
    gamePk: evidence.gamePk,
    marketType: evidence.marketType,
    side: evidence.side,
    line,
    status: "READY",
    sourcePolicy: POLICY[evidence.marketType],
    modelVersion: `${evidence.modelVersion}:${evidence.metric}`,
    generatedAt: evidence.generatedAt,
    probabilitySemantics: "UNCONDITIONAL_SETTLEMENT",
    winProbability: evidence.probability,
    pushProbability: null,
    unavailableReason: null,
  });

  return result(evidence, assessment, [], [
    "RAW_MODEL_EDGE_ONLY_OPERATING_ENVELOPE_STILL_REQUIRED",
    "PUSH_DERIVED_AS_ZERO_ONLY_BECAUSE_EXACT_HALF_RUN_LINE_CANNOT_PUSH",
  ]);
}
