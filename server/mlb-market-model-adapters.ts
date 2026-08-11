import { createHash } from "node:crypto";
import {
  buildMlbMarketProbabilityAssessmentDigest,
  type MlbMarketEdgeModelPolicy,
  type MlbMarketEdgeSupportedMarket,
  type MlbMarketProbabilityAssessment,
} from "./mlb-market-edge";

export const MLB_MARKET_MODEL_ADAPTER_SCHEMA = "courtedge-p0-mlb-market-model-adapters.v1" as const;
export const MLB_MARKET_MODEL_ADAPTER_VERSION = "mlb-current-predictor-model-adapter.v1" as const;
export const MLB_CURRENT_PREDICTOR_MODEL_VERSION = "predictor-full-snapshot-v2" as const;
export const MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS = 3.5 as const;

export const MLB_MARKET_MODEL_ADAPTER_MARKETS = [
  "ML",
  "F5_ML",
  "RUN_LINE",
  "TOTAL",
  "F5_TOTAL",
] as const satisfies readonly MlbMarketEdgeSupportedMarket[];

export const MLB_CURRENT_PREDICTOR_PROBABILITY_METRICS = [
  "ML_FINAL_SELECTED_PROBABILITY",
  "F5_ML_FINAL_SELECTED_PROBABILITY",
  "RUN_LINE_COVER_PROBABILITY",
  "TOTAL_MODEL_HIT_PROBABILITY",
  "F5_TOTAL_MODEL_HIT_PROBABILITY",
] as const;

export type MlbCurrentPredictorProbabilityMetric = typeof MLB_CURRENT_PREDICTOR_PROBABILITY_METRICS[number];
export type MlbMarketModelAdapterStatus = "READY" | "UNAVAILABLE" | "INVALID_EVIDENCE";

export interface MlbCurrentPredictorProbabilityEvidence {
  gamePk: number;
  marketType: MlbMarketEdgeSupportedMarket;
  side: "HOME" | "AWAY" | "OVER" | "UNDER";
  line: number | null;
  metric: MlbCurrentPredictorProbabilityMetric;
  /** Source-reported pure probability. Step 10 recomputes TOTAL/F5_TOTAL and requires parity. */
  probability: number | null;
  /** Required for TOTAL/F5_TOTAL parity; null for currently blocked side markets. */
  projectedRuns: number | null;
  probabilityUsesSportsbookPrice: boolean;
  modelVersion: string;
  generatedAt: string;
  /** SHA-256 of an exact type-tagged serialization of this envelope excluding sourceEvidenceDigest. */
  sourceEvidenceDigest: string;
}

export interface MlbMarketModelAdapterResult {
  schemaVersion: typeof MLB_MARKET_MODEL_ADAPTER_SCHEMA;
  adapterVersion: typeof MLB_MARKET_MODEL_ADAPTER_VERSION;
  adapterStatus: MlbMarketModelAdapterStatus;
  assessment: MlbMarketProbabilityAssessment | null;
  source: {
    metric: string | null;
    modelVersion: string | null;
    generatedAt: string | null;
    sourceEvidenceDigest: string | null;
    probabilityUsesSportsbookPrice: boolean | null;
    projectedRuns: number | null;
  };
  blockers: readonly string[];
  warnings: readonly string[];
  policy: {
    currentReadyMarkets: readonly ["TOTAL", "F5_TOTAL"];
    currentPredictorModelVersion: typeof MLB_CURRENT_PREDICTOR_MODEL_VERSION;
    currentMoneylineReady: false;
    currentRunLineReady: false;
    currentTotalHalfRunReady: true;
    currentF5TotalHalfRunReady: true;
    legacyMarketRegressedProbabilityAccepted: false;
    integerLinePushMayBeInvented: false;
    evidenceDigestRecomputedBeforeReady: true;
    evidenceDigestUsesLosslessNumericSerialization: true;
    exactCurrentPredictorProvenanceRequired: true;
    exactHalfRunIdentityRequired: true;
    priceDependenceFlagMustBeBoolean: true;
    malformedEnvelopeCanThrow: false;
    unsupportedMarketCanProduceAssessment: false;
    totalProbabilityRecomputedFromProjection: true;
    totalProbabilitySigmaRuns: typeof MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS;
    sourceReportedProbabilityMustMatchRecomputation: true;
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
const PROBABILITY_PARITY_TOLERANCE = 1e-10;
const SIDES = ["HOME", "AWAY", "OVER", "UNDER"] as const;

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

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSupportedMarket(value: unknown): value is MlbMarketEdgeSupportedMarket {
  return typeof value === "string" && (MLB_MARKET_MODEL_ADAPTER_MARKETS as readonly string[]).includes(value);
}

function isSupportedMetric(value: unknown): value is MlbCurrentPredictorProbabilityMetric {
  return typeof value === "string" && (MLB_CURRENT_PREDICTOR_PROBABILITY_METRICS as readonly string[]).includes(value);
}

function isSide(value: unknown): value is MlbCurrentPredictorProbabilityEvidence["side"] {
  return typeof value === "string" && (SIDES as readonly string[]).includes(value);
}

function exactCanonicalEvidence(value: unknown): string {
  if (value === null) return "null;";
  if (value === undefined) return "undefined;";
  if (typeof value === "boolean") return value ? "bool:1;" : "bool:0;";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN;";
    if (value === Number.POSITIVE_INFINITY) return "number:+Infinity;";
    if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity;";
    if (Object.is(value, -0)) return "number:-0;";
    return `number:${value.toString()};`;
  }
  if (typeof value === "string") return `string:${JSON.stringify(value)};`;
  if (Array.isArray(value)) return `array:[${value.map(exactCanonicalEvidence).join("")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `object:{${entries.map(([key, child]) => `${JSON.stringify(key)}=${exactCanonicalEvidence(child)}`).join("")}}`;
  }
  return `unsupported:${typeof value}:${JSON.stringify(String(value))};`;
}

export function buildMlbCurrentPredictorProbabilityEvidenceDigest(
  input: Omit<MlbCurrentPredictorProbabilityEvidence, "sourceEvidenceDigest">,
): string {
  return createHash("sha256").update(exactCanonicalEvidence(input)).digest("hex");
}

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

function lineIdentityValid(market: MlbMarketEdgeSupportedMarket, line: unknown): line is number | null {
  if (market === "ML" || market === "F5_ML") return line == null;
  return typeof line === "number" && Number.isFinite(line);
}

function isIntegerLine(line: number): boolean {
  return Number.isInteger(line);
}

function isExactHalfRunLine(line: number): boolean {
  return Number.isSafeInteger(line * 2) && !Number.isInteger(line);
}

function currentPredictorNormalCdf(x: number, mean: number, std: number): number {
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export function reproduceMlbCurrentPredictorTotalModelHitProbability(
  projectedRuns: number,
  line: number,
): { side: "OVER" | "UNDER"; probability: number } | null {
  if (!Number.isFinite(projectedRuns) || projectedRuns < 0 || !Number.isFinite(line)) return null;
  const side: "OVER" | "UNDER" = projectedRuns - line > 0 ? "OVER" : "UNDER";
  const modelOverProbability = 1 - currentPredictorNormalCdf(line, projectedRuns, MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS);
  const probability = side === "OVER" ? modelOverProbability : 1 - modelOverProbability;
  if (!finiteProbability(probability)) return null;
  return { side, probability };
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
    currentPredictorModelVersion: MLB_CURRENT_PREDICTOR_MODEL_VERSION,
    currentMoneylineReady: false,
    currentRunLineReady: false,
    currentTotalHalfRunReady: true,
    currentF5TotalHalfRunReady: true,
    legacyMarketRegressedProbabilityAccepted: false,
    integerLinePushMayBeInvented: false,
    evidenceDigestRecomputedBeforeReady: true,
    evidenceDigestUsesLosslessNumericSerialization: true,
    exactCurrentPredictorProvenanceRequired: true,
    exactHalfRunIdentityRequired: true,
    priceDependenceFlagMustBeBoolean: true,
    malformedEnvelopeCanThrow: false,
    unsupportedMarketCanProduceAssessment: false,
    totalProbabilityRecomputedFromProjection: true,
    totalProbabilitySigmaRuns: MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS,
    sourceReportedProbabilityMustMatchRecomputation: true,
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

function sourceSummary(input: unknown): MlbMarketModelAdapterResult["source"] {
  const value = record(input) ?? {};
  return {
    metric: typeof value.metric === "string" ? value.metric : null,
    modelVersion: typeof value.modelVersion === "string" ? value.modelVersion : null,
    generatedAt: typeof value.generatedAt === "string" ? value.generatedAt : null,
    sourceEvidenceDigest: typeof value.sourceEvidenceDigest === "string" ? value.sourceEvidenceDigest : null,
    probabilityUsesSportsbookPrice: typeof value.probabilityUsesSportsbookPrice === "boolean" ? value.probabilityUsesSportsbookPrice : null,
    projectedRuns: typeof value.projectedRuns === "number" && Number.isFinite(value.projectedRuns) ? value.projectedRuns : null,
  };
}

function invalidResult(input: unknown, reason: string): MlbMarketModelAdapterResult {
  return {
    schemaVersion: MLB_MARKET_MODEL_ADAPTER_SCHEMA,
    adapterVersion: MLB_MARKET_MODEL_ADAPTER_VERSION,
    adapterStatus: "INVALID_EVIDENCE",
    assessment: null,
    source: sourceSummary(input),
    blockers: [reason],
    warnings: [],
    policy: policy(),
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
    adapterStatus: assessment.status === "READY" ? "READY" : "UNAVAILABLE",
    assessment,
    source: sourceSummary(evidence),
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    policy: policy(),
  };
}

/** Step 10 adapts only the explicitly recognized current predictor; it never promotes challengers. */
export function adaptMlbCurrentPredictorProbability(input: unknown): MlbMarketModelAdapterResult {
  const raw = record(input);
  if (!raw) return invalidResult(input, "MODEL_EVIDENCE_ENVELOPE_INVALID");
  if (!isSupportedMarket(raw.marketType)) return invalidResult(input, "MODEL_EVIDENCE_MARKET_UNSUPPORTED");
  if (!isSupportedMetric(raw.metric)) return invalidResult(input, "MODEL_EVIDENCE_METRIC_UNSUPPORTED");
  if (!isSide(raw.side)) return invalidResult(input, "MODEL_EVIDENCE_SIDE_INVALID");
  if (!Number.isInteger(raw.gamePk) || Number(raw.gamePk) <= 0) return invalidResult(input, "MODEL_EVIDENCE_GAME_ID_INVALID");
  if (!lineIdentityValid(raw.marketType, raw.line)) return invalidResult(input, "MODEL_EVIDENCE_LINE_MARKET_MISMATCH");

  const evidence = raw as unknown as MlbCurrentPredictorProbabilityEvidence;
  if (!sideValid(evidence.marketType, evidence.side)) {
    const reason = "MODEL_EVIDENCE_SIDE_MARKET_MISMATCH";
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
    || typeof evidence.sourceEvidenceDigest !== "string"
    || !HEX_64.test(evidence.sourceEvidenceDigest)
  ) {
    const reason = "MODEL_EVIDENCE_PROVENANCE_INVALID";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (typeof evidence.probabilityUsesSportsbookPrice !== "boolean") {
    const reason = "MODEL_EVIDENCE_PRICE_DEPENDENCE_FLAG_INVALID";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  const { sourceEvidenceDigest: suppliedDigest, ...digestInput } = evidence;
  const expectedDigest = buildMlbCurrentPredictorProbabilityEvidenceDigest(digestInput);
  if (suppliedDigest.toLowerCase() !== expectedDigest) {
    const reason = "MODEL_EVIDENCE_DIGEST_MISMATCH";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (evidence.modelVersion !== MLB_CURRENT_PREDICTOR_MODEL_VERSION) {
    const reason = "MODEL_EVIDENCE_NOT_CURRENT_PREDICTOR";
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

  if (evidence.probabilityUsesSportsbookPrice !== false) {
    const reason = "MARKET_REGRESSED_PROBABILITY_REJECTED";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (!finiteProbability(evidence.probability)) {
    const reason = "PURE_MODEL_PROBABILITY_INVALID";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (typeof evidence.projectedRuns !== "number" || !Number.isFinite(evidence.projectedRuns) || evidence.projectedRuns < 0) {
    const reason = "PURE_MODEL_RUN_PROJECTION_INVALID";
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

  const reproduced = reproduceMlbCurrentPredictorTotalModelHitProbability(evidence.projectedRuns, line);
  if (!reproduced) {
    const reason = "PURE_MODEL_PROBABILITY_RECOMPUTATION_FAILED";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (reproduced.side !== evidence.side) {
    const reason = "PURE_MODEL_SELECTED_SIDE_MISMATCH";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (Math.abs(reproduced.probability - evidence.probability) > PROBABILITY_PARITY_TOLERANCE) {
    const reason = "PURE_MODEL_PROBABILITY_PARITY_MISMATCH";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }

  const assessment = assessmentWithDigest({
    gamePk: evidence.gamePk,
    marketType: evidence.marketType,
    side: evidence.side,
    line,
    status: "READY",
    sourcePolicy: POLICY[evidence.marketType],
    modelVersion: `${MLB_CURRENT_PREDICTOR_MODEL_VERSION}:${evidence.metric}:normal-sigma-${MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS}`,
    generatedAt: evidence.generatedAt,
    probabilitySemantics: "UNCONDITIONAL_SETTLEMENT",
    winProbability: reproduced.probability,
    pushProbability: null,
    unavailableReason: null,
  });

  return result(evidence, assessment, [], [
    "RAW_MODEL_EDGE_ONLY_OPERATING_ENVELOPE_STILL_REQUIRED",
    "PUSH_DERIVED_AS_ZERO_ONLY_BECAUSE_EXACT_HALF_RUN_LINE_CANNOT_PUSH",
  ]);
}
