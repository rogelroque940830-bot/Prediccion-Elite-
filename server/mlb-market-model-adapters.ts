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
  probability: number | null;
  projectedRuns: number | null;
  probabilityUsesSportsbookPrice: boolean;
  modelVersion: string;
  generatedAt: string;
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
    evidenceDigestRecursiveTraversalAllowed: false;
    exactEnvelopeFieldSetRequired: true;
    envelopeFieldsSnapshottedExactlyOnce: true;
    rawEnvelopeNotReadAfterSnapshot: true;
    exactCurrentPredictorProvenanceRequired: true;
    exactHalfRunIdentityRequired: true;
    positiveTotalLineRequired: true;
    priceDependenceFlagMustBeBoolean: true;
    malformedEnvelopeCanThrow: false;
    processingFailuresFailClosed: true;
    unsupportedMarketCanProduceAssessment: false;
    totalProbabilityRecomputedFromProjection: true;
    totalProbabilitySigmaRuns: typeof MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS;
    sourceReportedProbabilityMustMatchRecomputation: true;
    sourceReportedProbabilityMustMatchBitExactly: true;
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
const SIDES = ["HOME", "AWAY", "OVER", "UNDER"] as const;
const EVIDENCE_DIGEST_FIELDS = [
  "gamePk",
  "marketType",
  "side",
  "line",
  "metric",
  "probability",
  "projectedRuns",
  "probabilityUsesSportsbookPrice",
  "modelVersion",
  "generatedAt",
] as const;
const EVIDENCE_ENVELOPE_FIELDS = [...EVIDENCE_DIGEST_FIELDS, "sourceEvidenceDigest"] as const;
type EvidenceEnvelopeField = typeof EVIDENCE_ENVELOPE_FIELDS[number];
type EvidenceEnvelopeSnapshot = Readonly<Record<EvidenceEnvelopeField, unknown>>;

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

function hasExactEvidenceEnvelopeFields(value: Record<string, unknown>): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = (keys as string[]).sort();
  const expected = [...EVIDENCE_ENVELOPE_FIELDS].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function snapshotEvidenceEnvelope(value: Record<string, unknown>): EvidenceEnvelopeSnapshot {
  const snapshot = Object.create(null) as Record<EvidenceEnvelopeField, unknown>;
  for (const key of EVIDENCE_ENVELOPE_FIELDS) snapshot[key] = value[key];
  return Object.freeze(snapshot);
}

function exactScalarEvidence(value: unknown): string {
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
  return `unsupported:${typeof value};`;
}

export function buildMlbCurrentPredictorProbabilityEvidenceDigest(
  input: Omit<MlbCurrentPredictorProbabilityEvidence, "sourceEvidenceDigest">,
): string {
  const value = record(input) ?? {};
  const material = EVIDENCE_DIGEST_FIELDS
    .map((key) => `${key}=${exactScalarEvidence(value[key])}`)
    .join("|");
  return createHash("sha256").update(material).digest("hex");
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function nullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function sideValid(market: MlbMarketEdgeSupportedMarket, side: MlbCurrentPredictorProbabilityEvidence["side"]): boolean {
  if (market === "TOTAL" || market === "F5_TOTAL") return side === "OVER" || side === "UNDER";
  return side === "HOME" || side === "AWAY";
}

function lineIdentityValid(market: MlbMarketEdgeSupportedMarket, line: unknown): line is number | null {
  if (market === "ML" || market === "F5_ML") return line == null;
  return typeof line === "number" && Number.isFinite(line);
}

function totalLineIsPositive(market: MlbMarketEdgeSupportedMarket, line: number | null): boolean {
  return (market !== "TOTAL" && market !== "F5_TOTAL") || (line != null && line > 0);
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
  if (!Number.isFinite(projectedRuns) || projectedRuns < 0 || !Number.isFinite(line) || line <= 0) return null;
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
    modelVersion: evidence.modelVersion,
    generatedAt: evidence.generatedAt,
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
    evidenceDigestRecursiveTraversalAllowed: false,
    exactEnvelopeFieldSetRequired: true,
    envelopeFieldsSnapshottedExactlyOnce: true,
    rawEnvelopeNotReadAfterSnapshot: true,
    exactCurrentPredictorProvenanceRequired: true,
    exactHalfRunIdentityRequired: true,
    positiveTotalLineRequired: true,
    priceDependenceFlagMustBeBoolean: true,
    malformedEnvelopeCanThrow: false,
    processingFailuresFailClosed: true,
    unsupportedMarketCanProduceAssessment: false,
    totalProbabilityRecomputedFromProjection: true,
    totalProbabilitySigmaRuns: MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS,
    sourceReportedProbabilityMustMatchRecomputation: true,
    sourceReportedProbabilityMustMatchBitExactly: true,
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

function safeInvalidResult(reason: string): MlbMarketModelAdapterResult {
  return {
    schemaVersion: MLB_MARKET_MODEL_ADAPTER_SCHEMA,
    adapterVersion: MLB_MARKET_MODEL_ADAPTER_VERSION,
    adapterStatus: "INVALID_EVIDENCE",
    assessment: null,
    source: {
      metric: null,
      modelVersion: null,
      generatedAt: null,
      sourceEvidenceDigest: null,
      probabilityUsesSportsbookPrice: null,
      projectedRuns: null,
    },
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

function adaptValidatedMlbCurrentPredictorProbability(input: unknown): MlbMarketModelAdapterResult {
  const raw = record(input);
  if (!raw) return invalidResult(input, "MODEL_EVIDENCE_ENVELOPE_INVALID");
  if (!hasExactEvidenceEnvelopeFields(raw)) return safeInvalidResult("MODEL_EVIDENCE_FIELDS_INVALID");

  // This is the only read of caller-controlled field values. Everything below uses this frozen plain snapshot.
  const snapshot = snapshotEvidenceEnvelope(raw);
  if (!isSupportedMarket(snapshot.marketType)) return invalidResult(snapshot, "MODEL_EVIDENCE_MARKET_UNSUPPORTED");
  if (!isSupportedMetric(snapshot.metric)) return invalidResult(snapshot, "MODEL_EVIDENCE_METRIC_UNSUPPORTED");
  if (!isSide(snapshot.side)) return invalidResult(snapshot, "MODEL_EVIDENCE_SIDE_INVALID");
  if (!Number.isInteger(snapshot.gamePk) || Number(snapshot.gamePk) <= 0) return invalidResult(snapshot, "MODEL_EVIDENCE_GAME_ID_INVALID");
  if (!lineIdentityValid(snapshot.marketType, snapshot.line)) return invalidResult(snapshot, "MODEL_EVIDENCE_LINE_MARKET_MISMATCH");
  if (!totalLineIsPositive(snapshot.marketType, snapshot.line as number | null)) return invalidResult(snapshot, "MODEL_EVIDENCE_TOTAL_LINE_INVALID");
  if (!nullableFiniteNumber(snapshot.probability)) return invalidResult(snapshot, "MODEL_EVIDENCE_PROBABILITY_FIELD_INVALID");
  if (!nullableFiniteNumber(snapshot.projectedRuns)) return invalidResult(snapshot, "MODEL_EVIDENCE_PROJECTED_RUNS_FIELD_INVALID");
  if (typeof snapshot.probabilityUsesSportsbookPrice !== "boolean") return invalidResult(snapshot, "MODEL_EVIDENCE_PRICE_DEPENDENCE_FLAG_INVALID");
  if (
    typeof snapshot.modelVersion !== "string"
    || !snapshot.modelVersion.trim()
    || !validIso(snapshot.generatedAt)
    || typeof snapshot.sourceEvidenceDigest !== "string"
    || !HEX_64.test(snapshot.sourceEvidenceDigest)
  ) {
    return invalidResult(snapshot, "MODEL_EVIDENCE_PROVENANCE_INVALID");
  }

  const evidence: MlbCurrentPredictorProbabilityEvidence = {
    gamePk: snapshot.gamePk as number,
    marketType: snapshot.marketType,
    side: snapshot.side,
    line: snapshot.line as number | null,
    metric: snapshot.metric,
    probability: snapshot.probability as number | null,
    projectedRuns: snapshot.projectedRuns as number | null,
    probabilityUsesSportsbookPrice: snapshot.probabilityUsesSportsbookPrice,
    modelVersion: snapshot.modelVersion,
    generatedAt: snapshot.generatedAt as string,
    sourceEvidenceDigest: snapshot.sourceEvidenceDigest,
  };

  if (!sideValid(evidence.marketType, evidence.side)) {
    const reason = "MODEL_EVIDENCE_SIDE_MARKET_MISMATCH";
    return result(evidence, unavailable(evidence, reason), [reason]);
  }
  if (evidence.metric !== EXPECTED_METRIC[evidence.marketType]) {
    const reason = "MODEL_EVIDENCE_METRIC_MARKET_MISMATCH";
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
  if (evidence.projectedRuns == null || evidence.projectedRuns < 0) {
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
  if (reproduced.probability !== evidence.probability) {
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

export function adaptMlbCurrentPredictorProbability(input: unknown): MlbMarketModelAdapterResult {
  try {
    return adaptValidatedMlbCurrentPredictorProbability(input);
  } catch {
    return safeInvalidResult("MODEL_EVIDENCE_PROCESSING_FAILED");
  }
}
