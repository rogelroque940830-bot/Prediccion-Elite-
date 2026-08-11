import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_CURRENT_PREDICTOR_MODEL_VERSION,
  MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS,
  MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY,
  MLB_MARKET_MODEL_ADAPTER_SCHEMA,
  adaptMlbCurrentPredictorProbability,
  buildMlbCurrentPredictorProbabilityEvidenceDigest,
  reproduceMlbCurrentPredictorTotalModelHitProbability,
  type MlbCurrentPredictorProbabilityEvidence,
  type MlbMarketModelAdapterResult,
} from "./mlb-market-model-adapters";
import {
  buildMlbMarketProbabilityAssessmentDigest,
  type MlbMarketProbabilityAssessment,
} from "./mlb-market-edge";

function evidence(
  overrides: Partial<MlbCurrentPredictorProbabilityEvidence> = {},
): MlbCurrentPredictorProbabilityEvidence {
  const base: Omit<MlbCurrentPredictorProbabilityEvidence, "sourceEvidenceDigest"> = {
    gamePk: 900001,
    marketType: "TOTAL",
    side: "OVER",
    line: 8.5,
    metric: "TOTAL_MODEL_HIT_PROBABILITY",
    probability: 0.579259804182259,
    projectedRuns: 9.2,
    probabilityUsesSportsbookPrice: false,
    modelVersion: MLB_CURRENT_PREDICTOR_MODEL_VERSION,
    generatedAt: "2026-08-11T13:55:00.000Z",
  };
  const { sourceEvidenceDigest: suppliedDigest, ...rest } = overrides;
  const payload = { ...base, ...rest } as Omit<MlbCurrentPredictorProbabilityEvidence, "sourceEvidenceDigest">;
  return {
    ...payload,
    sourceEvidenceDigest: suppliedDigest ?? buildMlbCurrentPredictorProbabilityEvidenceDigest(payload),
  };
}

function assessment(result: MlbMarketModelAdapterResult): MlbMarketProbabilityAssessment {
  assert.notEqual(result.assessment, null);
  return result.assessment as MlbMarketProbabilityAssessment;
}

function assertDigestValid(result: MlbMarketModelAdapterResult): void {
  const current = assessment(result);
  const { modelInputDigest, ...payload } = current;
  assert.equal(modelInputDigest, buildMlbMarketProbabilityAssessmentDigest(payload));
}

test("full-game total reproduces the current pure modelHitProb before adapting a half-run line", () => {
  const reproduced = reproduceMlbCurrentPredictorTotalModelHitProbability(9.2, 8.5);
  assert.deepEqual(reproduced, { side: "OVER", probability: 0.579259804182259 });
  const result = adaptMlbCurrentPredictorProbability(evidence());
  const current = assessment(result);
  assert.equal(result.schemaVersion, MLB_MARKET_MODEL_ADAPTER_SCHEMA);
  assert.equal(result.adapterStatus, "READY");
  assert.equal(current.status, "READY");
  assert.equal(current.marketType, "TOTAL");
  assert.equal(current.sourcePolicy, "TOTAL_RUN_DIFFERENTIAL_V1");
  assert.equal(current.winProbability, 0.579259804182259);
  assert.equal(current.pushProbability, null);
  assert.equal(current.probabilitySemantics, "UNCONDITIONAL_SETTLEMENT");
  assert.equal(result.blockers.length, 0);
  assertDigestValid(result);
});

test("F5 total independently reproduces the same current pure Normal-CDF contract", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "F5_TOTAL",
    side: "UNDER",
    line: 4.5,
    metric: "F5_TOTAL_MODEL_HIT_PROBABILITY",
    probability: 0.5454945259558179,
    projectedRuns: 4.1,
  }));
  const current = assessment(result);
  assert.equal(result.adapterStatus, "READY");
  assert.equal(current.sourcePolicy, "F5_TOTAL_RUN_DIFFERENTIAL_V1");
  assert.equal(current.side, "UNDER");
  assert.equal(current.winProbability, 0.5454945259558179);
  assertDigestValid(result);
});

test("source-reported total probability and selected side must match deterministic recomputation", () => {
  const wrongProbability = adaptMlbCurrentPredictorProbability(evidence({ probability: 0.60 }));
  assert.equal(assessment(wrongProbability).unavailableReason, "PURE_MODEL_PROBABILITY_PARITY_MISMATCH");

  const wrongSide = adaptMlbCurrentPredictorProbability(evidence({ side: "UNDER" }));
  assert.equal(assessment(wrongSide).unavailableReason, "PURE_MODEL_SELECTED_SIDE_MISMATCH");
});

test("evidence digest is lossless for tiny numeric mutations below the old 12-decimal rounding boundary", () => {
  const input = evidence();
  input.probability += 1e-13;
  const result = adaptMlbCurrentPredictorProbability(input);
  assert.equal(result.adapterStatus, "UNAVAILABLE");
  assert.equal(assessment(result).unavailableReason, "MODEL_EVIDENCE_DIGEST_MISMATCH");

  const projectionInput = evidence();
  projectionInput.projectedRuns += 1e-13;
  const projectionResult = adaptMlbCurrentPredictorProbability(projectionInput);
  assert.equal(projectionResult.adapterStatus, "UNAVAILABLE");
  assert.equal(assessment(projectionResult).unavailableReason, "MODEL_EVIDENCE_DIGEST_MISMATCH");
});

test("only the recognized current predictor model version can produce READY evidence", () => {
  for (const modelVersion of [
    "P1-M6A3A-EXPERIMENTAL_SHADOW",
    "team-strength-challenger",
    "starting-pitcher-challenger",
    "lineup-t5-challenger",
    "predictor-full-snapshot-v3",
  ]) {
    const result = adaptMlbCurrentPredictorProbability(evidence({ modelVersion }));
    assert.equal(result.adapterStatus, "UNAVAILABLE");
    assert.equal(assessment(result).unavailableReason, "MODEL_EVIDENCE_NOT_CURRENT_PREDICTOR");
  }
});

test("a market-regressed total probability is rejected before numerical attractiveness matters", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    probability: 0.72,
    probabilityUsesSportsbookPrice: true,
  }));
  const current = assessment(result);
  assert.equal(result.adapterStatus, "UNAVAILABLE");
  assert.equal(current.unavailableReason, "MARKET_REGRESSED_PROBABILITY_REJECTED");
  assert.equal(current.winProbability, null);
});

test("integer totals fail closed because the current continuous model cannot supply push mass", () => {
  for (const [marketType, metric, line] of [
    ["TOTAL", "TOTAL_MODEL_HIT_PROBABILITY", 8],
    ["TOTAL", "TOTAL_MODEL_HIT_PROBABILITY", 9],
    ["F5_TOTAL", "F5_TOTAL_MODEL_HIT_PROBABILITY", 4],
  ] as const) {
    const result = adaptMlbCurrentPredictorProbability(evidence({ marketType, metric, line }));
    assert.equal(assessment(result).unavailableReason, "INTEGER_LINE_REQUIRES_DISCRETE_PUSH_MODEL");
  }
});

test("only exact half-run identities are accepted; quarter, near-half and near-integer lines fail closed", () => {
  for (const line of [8.25, 8.5000000001, 8.4999999999, 8.0000000001, 7.9999999999]) {
    const result = adaptMlbCurrentPredictorProbability(evidence({ line }));
    assert.equal(result.adapterStatus, "UNAVAILABLE");
    assert.equal(assessment(result).unavailableReason, "NON_HALF_RUN_LINE_REQUIRES_EXPLICIT_SETTLEMENT_MODEL");
  }

  assert.equal(adaptMlbCurrentPredictorProbability(evidence({ line: 8.5 })).adapterStatus, "READY");
  const f5 = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "F5_TOTAL",
    side: "UNDER",
    line: 4.5,
    metric: "F5_TOTAL_MODEL_HIT_PROBABILITY",
    probability: 0.5454945259558179,
    projectedRuns: 4.1,
  }));
  assert.equal(f5.adapterStatus, "READY");
});

test("current full-game ML remains unavailable instead of reusing the market-regressed UI probability", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "ML",
    side: "HOME",
    line: null,
    metric: "ML_FINAL_SELECTED_PROBABILITY",
    probability: 0.61,
    projectedRuns: null,
    probabilityUsesSportsbookPrice: true,
  }));
  assert.equal(assessment(result).unavailableReason, MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.ML);
});

test("current F5 ML remains unavailable because market regression and tie mass cannot be ignored", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "F5_ML",
    side: "AWAY",
    line: null,
    metric: "F5_ML_FINAL_SELECTED_PROBABILITY",
    probability: 0.58,
    projectedRuns: null,
    probabilityUsesSportsbookPrice: true,
  }));
  assert.equal(assessment(result).unavailableReason, MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.F5_ML);
});

test("current Run Line remains unavailable because its source probability inherits market-regressed ML", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "RUN_LINE",
    side: "HOME",
    line: -1.5,
    metric: "RUN_LINE_COVER_PROBABILITY",
    probability: 0.60,
    projectedRuns: null,
    probabilityUsesSportsbookPrice: true,
  }));
  assert.equal(assessment(result).unavailableReason, MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.RUN_LINE);
});

test("metric substitution across valid market families fails closed", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "F5_TOTAL",
    line: 4.5,
    metric: "TOTAL_MODEL_HIT_PROBABILITY",
  }));
  assert.equal(assessment(result).unavailableReason, "MODEL_EVIDENCE_METRIC_MARKET_MISMATCH");
});

test("malformed envelope, unsupported market or unsupported metric returns INVALID_EVIDENCE without throwing", () => {
  for (const input of [null, undefined, 7, "bad", []]) {
    const result = adaptMlbCurrentPredictorProbability(input);
    assert.equal(result.adapterStatus, "INVALID_EVIDENCE");
    assert.equal(result.assessment, null);
    assert.equal(result.blockers.includes("MODEL_EVIDENCE_ENVELOPE_INVALID"), true);
  }

  const unsupportedMarket = adaptMlbCurrentPredictorProbability({ ...evidence(), marketType: "OTHER" });
  assert.equal(unsupportedMarket.adapterStatus, "INVALID_EVIDENCE");
  assert.equal(unsupportedMarket.assessment, null);
  assert.equal(unsupportedMarket.blockers.includes("MODEL_EVIDENCE_MARKET_UNSUPPORTED"), true);

  const unsupportedMetric = adaptMlbCurrentPredictorProbability({ ...evidence(), metric: undefined });
  assert.equal(unsupportedMetric.adapterStatus, "INVALID_EVIDENCE");
  assert.equal(unsupportedMetric.assessment, null);
  assert.equal(unsupportedMetric.blockers.includes("MODEL_EVIDENCE_METRIC_UNSUPPORTED"), true);
});

test("basic identity corruption returns INVALID_EVIDENCE before policy maps are used", () => {
  const badSide = adaptMlbCurrentPredictorProbability({ ...evidence(), side: "DRAW" });
  assert.equal(badSide.adapterStatus, "INVALID_EVIDENCE");
  assert.equal(badSide.assessment, null);
  assert.equal(badSide.blockers.includes("MODEL_EVIDENCE_SIDE_INVALID"), true);

  const missingLine = adaptMlbCurrentPredictorProbability({ ...evidence(), line: null });
  assert.equal(missingLine.adapterStatus, "INVALID_EVIDENCE");
  assert.equal(missingLine.assessment, null);
  assert.equal(missingLine.blockers.includes("MODEL_EVIDENCE_LINE_MARKET_MISMATCH"), true);

  const badGame = adaptMlbCurrentPredictorProbability({ ...evidence(), gamePk: 0 });
  assert.equal(badGame.adapterStatus, "INVALID_EVIDENCE");
  assert.equal(badGame.assessment, null);
});

test("invalid projection, provenance, tampering or probability never reaches READY", () => {
  const badProjection = adaptMlbCurrentPredictorProbability(evidence({ projectedRuns: -1 }));
  assert.equal(assessment(badProjection).unavailableReason, "PURE_MODEL_RUN_PROJECTION_INVALID");

  const malformedDigest = adaptMlbCurrentPredictorProbability(evidence({ sourceEvidenceDigest: "not-a-digest" }));
  assert.equal(assessment(malformedDigest).unavailableReason, "MODEL_EVIDENCE_PROVENANCE_INVALID");

  const arbitraryDigest = adaptMlbCurrentPredictorProbability(evidence({ sourceEvidenceDigest: "b".repeat(64) }));
  assert.equal(assessment(arbitraryDigest).unavailableReason, "MODEL_EVIDENCE_DIGEST_MISMATCH");

  const tampered = evidence();
  tampered.projectedRuns = 11.2;
  const tamperedResult = adaptMlbCurrentPredictorProbability(tampered);
  assert.equal(assessment(tamperedResult).unavailableReason, "MODEL_EVIDENCE_DIGEST_MISMATCH");

  const badProbability = adaptMlbCurrentPredictorProbability(evidence({ probability: 1.2 }));
  assert.equal(assessment(badProbability).unavailableReason, "PURE_MODEL_PROBABILITY_INVALID");
});

test("price-dependence flag must be explicitly boolean false for a READY total", () => {
  for (const malformed of [undefined, null, "false", 0, {}]) {
    const input = { ...evidence(), probabilityUsesSportsbookPrice: malformed };
    const result = adaptMlbCurrentPredictorProbability(input);
    assert.equal(result.adapterStatus, "UNAVAILABLE");
    assert.equal(assessment(result).unavailableReason, "MODEL_EVIDENCE_PRICE_DEPENDENCE_FLAG_INVALID");
  }
});

test("same evidence is deterministic and carries no ranking, envelope, stake or provider behavior", () => {
  const input = evidence();
  const first = adaptMlbCurrentPredictorProbability(input);
  const second = adaptMlbCurrentPredictorProbability({ ...input });
  assert.deepEqual(first, second);
  assert.equal(first.policy.currentReadyMarkets.join(","), "TOTAL,F5_TOTAL");
  assert.equal(first.policy.currentPredictorModelVersion, MLB_CURRENT_PREDICTOR_MODEL_VERSION);
  assert.equal(first.policy.legacyMarketRegressedProbabilityAccepted, false);
  assert.equal(first.policy.integerLinePushMayBeInvented, false);
  assert.equal(first.policy.evidenceDigestRecomputedBeforeReady, true);
  assert.equal(first.policy.evidenceDigestUsesLosslessNumericSerialization, true);
  assert.equal(first.policy.exactCurrentPredictorProvenanceRequired, true);
  assert.equal(first.policy.exactHalfRunIdentityRequired, true);
  assert.equal(first.policy.priceDependenceFlagMustBeBoolean, true);
  assert.equal(first.policy.malformedEnvelopeCanThrow, false);
  assert.equal(first.policy.unsupportedMarketCanProduceAssessment, false);
  assert.equal(first.policy.totalProbabilityRecomputedFromProjection, true);
  assert.equal(first.policy.totalProbabilitySigmaRuns, MLB_CURRENT_TOTAL_MODEL_SIGMA_RUNS);
  assert.equal(first.policy.sourceReportedProbabilityMustMatchRecomputation, true);
  assert.equal(first.policy.a3aExactSettlementMathAvailable, true);
  assert.equal(first.policy.a3aExperimentalShadowCanBecomeReady, false);
  assert.equal(first.policy.unsupportedChallengersCanBePromoted, false);
  assert.equal(first.policy.marketRankingProduced, false);
  assert.equal(first.policy.operatingEnvelopeApplied, false);
  assert.equal(first.policy.eliteLabelProduced, false);
  assert.equal(first.policy.recommendsBet, false);
  assert.equal(first.policy.stakeCalculated, false);
  assert.equal(first.policy.callsTheOddsApi, false);
  assert.equal(first.policy.theOddsApiCreditsConsumed, 0);
  assert.equal(first.policy.automaticBetPlacement, false);
  assert.equal(first.policy.realFinancialExposure, 0);
});
