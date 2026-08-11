import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMlbStep12Pocket,
  validateMlbStep12PilotEvidence,
  type MlbStep12PocketRuleEvidence,
  type MlbStep12PocketTargetEvidence,
} from "./mlb-step12-pocket-validation";

function metrics(rate: number, decisiveRows: number, uniqueDates = 25) {
  const hits = Math.round(rate * decisiveRows);
  return {
    decisiveHitRate: hits / decisiveRows,
    decisiveRows,
    hits,
    losses: decisiveRows - hits,
    pushes: 0,
    selectedRows: decisiveRows,
    uniqueDates,
    retentionPct: 4,
    noPickDatePct: 55,
  };
}

function target(rule: MlbStep12PocketRuleEvidence, baseline = 0.53): MlbStep12PocketTargetEvidence {
  return {
    horizon: "FULL_GAME",
    attemptedRules: 1500,
    topK: 10,
    holdoutBaselineHomeDecisiveHitRate: baseline,
    rules: [rule],
  };
}

function rule(overrides: Partial<MlbStep12PocketRuleEvidence> = {}): MlbStep12PocketRuleEvidence {
  return {
    ruleKey: "abc123",
    side: "HOME",
    discovery: metrics(0.79, 62, 49),
    discoveryWilsonLower95: 0.67,
    holdout: metrics(25 / 30, 30, 25),
    holdoutOneSidedPValueVsBaseline: 0.0005,
    holdoutBonferroniPValueTopK: 0.005,
    ...overrides,
  };
}

test("classifies a strong frozen holdout pocket as OOS-supported without producing BET_ELITE", () => {
  const result = validateMlbStep12Pocket(target(rule()), rule());
  assert.equal(result.status, "OOS_SUPPORTED_HYPOTHESIS");
  assert.equal(result.descriptiveHitRateBand, "EXCEPTIONAL_80_PLUS");
  assert.equal(result.policy.betEliteLabelProduced, false);
  assert.equal(result.policy.livePickFiltersChanged, false);
  assert.equal(result.policy.historicalPricesRequiredForSportingSupport, false);
  assert.equal(result.policy.historicalPricesRequiredForHistoricalEvClaim, true);
});

test("does not reject stable 70-80 percent pockets merely for being below 80", () => {
  const evidence = rule({
    discovery: metrics(0.76, 90, 55),
    holdout: metrics(0.72, 60, 40),
    holdoutOneSidedPValueVsBaseline: 0.003,
    holdoutBonferroniPValueTopK: 0.03,
  });
  const result = validateMlbStep12Pocket(target(evidence), evidence);
  assert.equal(result.status, "OOS_SUPPORTED_HYPOTHESIS");
  assert.equal(result.descriptiveHitRateBand, "STRONG_70_TO_80");
  assert.equal(result.policy.lowerHitRateStableSignalsRemainResearchEligible, true);
});

test("labels a tiny 90 percent pocket insufficient instead of promoting it", () => {
  const evidence = rule({
    discovery: metrics(0.92, 25, 18),
    holdout: metrics(0.90, 10, 8),
    holdoutOneSidedPValueVsBaseline: 0.01,
    holdoutBonferroniPValueTopK: 0.04,
  });
  const result = validateMlbStep12Pocket(target(evidence), evidence);
  assert.equal(result.status, "INSUFFICIENT_HOLDOUT_SAMPLE");
  assert.equal(result.descriptiveHitRateBand, "EXCEPTIONAL_80_PLUS");
});

test("requires family-wise support for OOS_SUPPORTED_HYPOTHESIS", () => {
  const evidence = rule({
    holdout: metrics(0.75, 40, 28),
    holdoutOneSidedPValueVsBaseline: 0.02,
    holdoutBonferroniPValueTopK: 0.20,
  });
  const result = validateMlbStep12Pocket(target(evidence), evidence);
  assert.equal(result.status, "PROMISING_NOT_FAMILYWISE_SUPPORTED");
  assert.ok(result.reasons.includes("RAW_P_LE_0_05_BUT_FAMILYWISE_NOT_SUPPORTED"));
});

test("flags a large discovery-to-holdout collapse as unstable even if holdout remains above baseline", () => {
  const evidence = rule({
    discovery: metrics(0.90, 70, 50),
    holdout: metrics(0.68, 50, 35),
    holdoutOneSidedPValueVsBaseline: 0.02,
    holdoutBonferroniPValueTopK: 0.04,
  });
  const result = validateMlbStep12Pocket(target(evidence), evidence);
  assert.equal(result.status, "UNSTABLE_HOLDOUT");
  assert.ok(result.reasons.includes("DISCOVERY_HOLDOUT_DRIFT_GT_15PP"));
});

test("flags no positive holdout lift as unstable", () => {
  const evidence = rule({
    discovery: metrics(0.75, 70, 45),
    holdout: metrics(0.50, 40, 30),
    holdoutOneSidedPValueVsBaseline: 0.9,
    holdoutBonferroniPValueTopK: 1,
  });
  const result = validateMlbStep12Pocket(target(evidence), evidence);
  assert.equal(result.status, "UNSTABLE_HOLDOUT");
  assert.ok(result.reasons.includes("NO_POSITIVE_HOLDOUT_LIFT"));
});

test("fails closed on internally inconsistent metrics", () => {
  const broken = rule({
    holdout: {
      decisiveHitRate: 0.9,
      decisiveRows: 30,
      hits: 20,
      losses: 10,
      pushes: 0,
      selectedRows: 30,
      uniqueDates: 25,
      retentionPct: 4,
      noPickDatePct: 55,
    },
  });
  const result = validateMlbStep12Pocket(target(broken), broken);
  assert.equal(result.status, "INVALID_EVIDENCE");
  assert.ok(result.reasons.includes("HOLDOUT_METRICS_INVALID"));
});

test("fails closed if adjusted p-value is smaller than raw p-value", () => {
  const broken = rule({
    holdoutOneSidedPValueVsBaseline: 0.02,
    holdoutBonferroniPValueTopK: 0.01,
  });
  const result = validateMlbStep12Pocket(target(broken), broken);
  assert.equal(result.status, "INVALID_EVIDENCE");
  assert.ok(result.reasons.includes("ADJUSTED_P_VALUE_LT_RAW_P_VALUE"));
});

test("pilot boundary rejects historical EV claims or live filtering", () => {
  const evidence = rule();
  assert.throws(() => validateMlbStep12PilotEvidence({
    schemaVersion: "courtedge-p0-step12-pocket-pilot.v1",
    evidenceStatus: "PILOT_RESEARCH_ONLY_NOT_BET_ELITE",
    policy: {
      historicalPricesUsed: false,
      historicalEvClaimProduced: true,
      holdoutThresholdTuningAllowed: false,
      automaticBestRulePromotion: false,
      livePickFiltersChanged: false,
      betEliteProduced: false,
    },
    targets: [target(evidence)],
  }), /STEP12C_RESEARCH_BOUNDARY_VIOLATION/);
});
