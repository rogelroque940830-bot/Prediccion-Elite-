import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY,
  MLB_MARKET_MODEL_ADAPTER_SCHEMA,
  adaptMlbCurrentPredictorProbability,
  buildMlbCurrentPredictorProbabilityEvidenceDigest,
  type MlbCurrentPredictorProbabilityEvidence,
} from "./mlb-market-model-adapters";
import { buildMlbMarketProbabilityAssessmentDigest } from "./mlb-market-edge";

function evidence(
  overrides: Partial<MlbCurrentPredictorProbabilityEvidence> = {},
): MlbCurrentPredictorProbabilityEvidence {
  const base: Omit<MlbCurrentPredictorProbabilityEvidence, "sourceEvidenceDigest"> = {
    gamePk: 900001,
    marketType: "TOTAL",
    side: "OVER",
    line: 8.5,
    metric: "TOTAL_MODEL_HIT_PROBABILITY",
    probability: 0.563,
    probabilityUsesSportsbookPrice: false,
    modelVersion: "predictor-full-snapshot-v2",
    generatedAt: "2026-08-11T13:55:00.000Z",
  };
  const { sourceEvidenceDigest: suppliedDigest, ...rest } = overrides;
  const payload = { ...base, ...rest } as Omit<MlbCurrentPredictorProbabilityEvidence, "sourceEvidenceDigest">;
  return {
    ...payload,
    sourceEvidenceDigest: suppliedDigest ?? buildMlbCurrentPredictorProbabilityEvidenceDigest(payload),
  };
}

function assertDigestValid(result: ReturnType<typeof adaptMlbCurrentPredictorProbability>): void {
  const { modelInputDigest, ...payload } = result.assessment;
  assert.equal(modelInputDigest, buildMlbMarketProbabilityAssessmentDigest(payload));
}

test("full-game total pure modelHitProb adapts only on an exact half-run line", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence());
  assert.equal(result.schemaVersion, MLB_MARKET_MODEL_ADAPTER_SCHEMA);
  assert.equal(result.assessment.status, "READY");
  assert.equal(result.assessment.marketType, "TOTAL");
  assert.equal(result.assessment.sourcePolicy, "TOTAL_RUN_DIFFERENTIAL_V1");
  assert.equal(result.assessment.winProbability, 0.563);
  assert.equal(result.assessment.pushProbability, null);
  assert.equal(result.assessment.probabilitySemantics, "UNCONDITIONAL_SETTLEMENT");
  assert.equal(result.blockers.length, 0);
  assertDigestValid(result);
});

test("F5 total has an independent pure-model half-run adapter", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "F5_TOTAL",
    side: "UNDER",
    line: 4.5,
    metric: "F5_TOTAL_MODEL_HIT_PROBABILITY",
    probability: 0.541,
  }));
  assert.equal(result.assessment.status, "READY");
  assert.equal(result.assessment.sourcePolicy, "F5_TOTAL_RUN_DIFFERENTIAL_V1");
  assert.equal(result.assessment.side, "UNDER");
  assert.equal(result.assessment.winProbability, 0.541);
  assertDigestValid(result);
});

test("a market-regressed total probability is rejected even when numerically attractive", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    probability: 0.72,
    probabilityUsesSportsbookPrice: true,
  }));
  assert.equal(result.assessment.status, "UNAVAILABLE");
  assert.equal(result.assessment.unavailableReason, "MARKET_REGRESSED_PROBABILITY_REJECTED");
  assert.equal(result.assessment.winProbability, null);
});

test("integer totals fail closed because the current continuous model cannot supply push mass", () => {
  for (const [marketType, metric, line] of [
    ["TOTAL", "TOTAL_MODEL_HIT_PROBABILITY", 8],
    ["F5_TOTAL", "F5_TOTAL_MODEL_HIT_PROBABILITY", 4],
  ] as const) {
    const result = adaptMlbCurrentPredictorProbability(evidence({ marketType, metric, line }));
    assert.equal(result.assessment.status, "UNAVAILABLE");
    assert.equal(result.assessment.unavailableReason, "INTEGER_LINE_REQUIRES_DISCRETE_PUSH_MODEL");
  }
});

test("quarter-run and other non-half lines are not silently treated as no-push markets", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({ line: 8.25 }));
  assert.equal(result.assessment.status, "UNAVAILABLE");
  assert.equal(result.assessment.unavailableReason, "NON_HALF_RUN_LINE_REQUIRES_EXPLICIT_SETTLEMENT_MODEL");
});

test("current full-game ML remains unavailable instead of reusing the market-regressed UI probability", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "ML",
    side: "HOME",
    line: null,
    metric: "ML_FINAL_SELECTED_PROBABILITY",
    probability: 0.61,
    probabilityUsesSportsbookPrice: true,
  }));
  assert.equal(result.assessment.status, "UNAVAILABLE");
  assert.equal(result.assessment.unavailableReason, MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.ML);
});

test("current F5 ML remains unavailable because market regression and tie mass cannot be ignored", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "F5_ML",
    side: "AWAY",
    line: null,
    metric: "F5_ML_FINAL_SELECTED_PROBABILITY",
    probability: 0.58,
    probabilityUsesSportsbookPrice: true,
  }));
  assert.equal(result.assessment.status, "UNAVAILABLE");
  assert.equal(result.assessment.unavailableReason, MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.F5_ML);
});

test("current Run Line remains unavailable because its source probability inherits market-regressed ML", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "RUN_LINE",
    side: "HOME",
    line: -1.5,
    metric: "RUN_LINE_COVER_PROBABILITY",
    probability: 0.60,
    probabilityUsesSportsbookPrice: true,
  }));
  assert.equal(result.assessment.status, "UNAVAILABLE");
  assert.equal(result.assessment.unavailableReason, MLB_MARKET_MODEL_ADAPTER_CURRENT_BOUNDARY.RUN_LINE);
});

test("metric substitution across market families fails closed", () => {
  const result = adaptMlbCurrentPredictorProbability(evidence({
    marketType: "F5_TOTAL",
    line: 4.5,
    metric: "TOTAL_MODEL_HIT_PROBABILITY",
  }));
  assert.equal(result.assessment.status, "UNAVAILABLE");
  assert.equal(result.assessment.unavailableReason, "MODEL_EVIDENCE_METRIC_MARKET_MISMATCH");
});

test("side and line identity mismatches fail closed before probability adaptation", () => {
  const wrongSide = adaptMlbCurrentPredictorProbability(evidence({ side: "HOME" }));
  assert.equal(wrongSide.assessment.status, "UNAVAILABLE");
  assert.equal(wrongSide.assessment.unavailableReason, "MODEL_EVIDENCE_SIDE_MARKET_MISMATCH");

  const missingLine = adaptMlbCurrentPredictorProbability(evidence({ line: null }));
  assert.equal(missingLine.assessment.status, "UNAVAILABLE");
  assert.equal(missingLine.assessment.unavailableReason, "MODEL_EVIDENCE_LINE_MARKET_MISMATCH");
});

test("invalid provenance, tampering or invalid pure probability never reaches READY", () => {
  const malformedDigest = adaptMlbCurrentPredictorProbability(evidence({ sourceEvidenceDigest: "not-a-digest" }));
  assert.equal(malformedDigest.assessment.status, "UNAVAILABLE");
  assert.equal(malformedDigest.assessment.unavailableReason, "MODEL_EVIDENCE_PROVENANCE_INVALID");

  const arbitraryDigest = adaptMlbCurrentPredictorProbability(evidence({ sourceEvidenceDigest: "b".repeat(64) }));
  assert.equal(arbitraryDigest.assessment.status, "UNAVAILABLE");
  assert.equal(arbitraryDigest.assessment.unavailableReason, "MODEL_EVIDENCE_DIGEST_MISMATCH");

  const tampered = evidence();
  tampered.probability = 0.73;
  const tamperedResult = adaptMlbCurrentPredictorProbability(tampered);
  assert.equal(tamperedResult.assessment.status, "UNAVAILABLE");
  assert.equal(tamperedResult.assessment.unavailableReason, "MODEL_EVIDENCE_DIGEST_MISMATCH");

  const badProbability = adaptMlbCurrentPredictorProbability(evidence({ probability: 1.2 }));
  assert.equal(badProbability.assessment.status, "UNAVAILABLE");
  assert.equal(badProbability.assessment.unavailableReason, "PURE_MODEL_PROBABILITY_INVALID");
});

test("malformed price-dependence flag cannot masquerade as pure model evidence", () => {
  const input = evidence() as any;
  input.probabilityUsesSportsbookPrice = "false";
  const result = adaptMlbCurrentPredictorProbability(input);
  assert.equal(result.assessment.status, "UNAVAILABLE");
  assert.equal(result.assessment.unavailableReason, "MODEL_EVIDENCE_PRICE_DEPENDENCE_FLAG_INVALID");
});

test("same evidence is deterministic and does not depend on market price, ranking or stake", () => {
  const input = evidence();
  const first = adaptMlbCurrentPredictorProbability(input);
  const second = adaptMlbCurrentPredictorProbability({ ...input });
  assert.deepEqual(first, second);
  assert.equal(first.policy.currentReadyMarkets.join(","), "TOTAL,F5_TOTAL");
  assert.equal(first.policy.legacyMarketRegressedProbabilityAccepted, false);
  assert.equal(first.policy.integerLinePushMayBeInvented, false);
  assert.equal(first.policy.evidenceDigestRecomputedBeforeReady, true);
  assert.equal(first.policy.priceDependenceFlagMustBeBoolean, true);
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
