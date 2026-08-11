import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbMarketProbabilityAssessmentDigest,
  buildMlbMarketProbabilityAssessmentIdentityKey,
  type MlbMarketProbabilityAssessment,
} from "./mlb-market-edge";

function assessmentInput(
  overrides: Partial<Omit<MlbMarketProbabilityAssessment, "modelInputDigest">> = {},
): Omit<MlbMarketProbabilityAssessment, "modelInputDigest"> {
  return {
    gamePk: 900001,
    marketType: "TOTAL",
    side: "OVER",
    line: 8.5,
    status: "READY",
    sourcePolicy: "TOTAL_RUN_DIFFERENTIAL_V1",
    modelVersion: "predictor-full-snapshot-v2:TOTAL_MODEL_HIT_PROBABILITY:normal-sigma-3.5",
    generatedAt: "2026-08-11T15:10:00.000Z",
    probabilitySemantics: "UNCONDITIONAL_SETTLEMENT",
    winProbability: 0.579259804182259,
    pushProbability: null,
    unavailableReason: null,
    ...overrides,
  };
}

test("assessment identity key is lossless for exact quote-line matching", () => {
  const exact = buildMlbMarketProbabilityAssessmentIdentityKey({
    gamePk: 900001,
    marketType: "TOTAL",
    side: "OVER",
    line: 8.5,
  });
  for (const line of [8.5000000001, 8.4999999999, 8.500000001, 8.499999999]) {
    const near = buildMlbMarketProbabilityAssessmentIdentityKey({
      gamePk: 900001,
      marketType: "TOTAL",
      side: "OVER",
      line,
    });
    assert.notEqual(near, exact);
  }
  assert.notEqual(
    buildMlbMarketProbabilityAssessmentIdentityKey({ gamePk: 900001, marketType: "TOTAL", side: "OVER", line: -0 }),
    buildMlbMarketProbabilityAssessmentIdentityKey({ gamePk: 900001, marketType: "TOTAL", side: "OVER", line: 0 }),
  );
});

test("assessment digest changes for sub-12-decimal probability mutations", () => {
  const base = assessmentInput();
  const baseDigest = buildMlbMarketProbabilityAssessmentDigest(base);

  for (const delta of [1e-13, -1e-13, 5e-14]) {
    const changed = assessmentInput({ winProbability: (base.winProbability as number) + delta });
    assert.notEqual(buildMlbMarketProbabilityAssessmentDigest(changed), baseDigest);
  }
});

test("assessment digest binds exact numeric line identity", () => {
  const exact = buildMlbMarketProbabilityAssessmentDigest(assessmentInput({ line: 8.5 }));
  for (const line of [8.5000000001, 8.4999999999, 8.500000000001]) {
    assert.notEqual(buildMlbMarketProbabilityAssessmentDigest(assessmentInput({ line })), exact);
  }
});

test("same semantic assessment with different object insertion order has the same digest", () => {
  const input = assessmentInput();
  const reordered = {
    unavailableReason: input.unavailableReason,
    pushProbability: input.pushProbability,
    winProbability: input.winProbability,
    probabilitySemantics: input.probabilitySemantics,
    generatedAt: input.generatedAt,
    modelVersion: input.modelVersion,
    sourcePolicy: input.sourcePolicy,
    status: input.status,
    line: input.line,
    side: input.side,
    marketType: input.marketType,
    gamePk: input.gamePk,
  } satisfies Omit<MlbMarketProbabilityAssessment, "modelInputDigest">;

  assert.equal(
    buildMlbMarketProbabilityAssessmentDigest(reordered),
    buildMlbMarketProbabilityAssessmentDigest(input),
  );
});
