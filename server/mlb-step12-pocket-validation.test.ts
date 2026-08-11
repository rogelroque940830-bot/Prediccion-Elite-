import test from "node:test";
import assert from "node:assert/strict";
import {
  exactOneSidedBinomialTail,
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

function withPValues(
  evidence: Omit<MlbStep12PocketRuleEvidence, "holdoutOneSidedPValueVsBaseline" | "holdoutBonferroniPValueTopK">,
  baseline = 0.53,
  topK = 10,
): MlbStep12PocketRuleEvidence {
  const selectedBaseline = evidence.side === "HOME" ? baseline : 1 - baseline;
  const raw = exactOneSidedBinomialTail(evidence.holdout.hits, evidence.holdout.decisiveRows, selectedBaseline);
  return {
    ...evidence,
    holdoutOneSidedPValueVsBaseline: raw,
    holdoutBonferroniPValueTopK: Math.min(1, raw * topK),
  };
}

function rule(overrides: Partial<Omit<MlbStep12PocketRuleEvidence, "holdoutOneSidedPValueVsBaseline" | "holdoutBonferroniPValueTopK">> = {}, baseline = 0.53): MlbStep12PocketRuleEvidence {
  return withPValues({
    ruleKey: "abc123",
    side: "HOME",
    discovery: metrics(0.79, 62, 49),
    discoveryWilsonLower95: 0.67,
    holdout: metrics(25 / 30, 30, 25),
    ...overrides,
  }, baseline);
}

function target(rules: MlbStep12PocketRuleEvidence[], baseline = 0.53, topK = 10): MlbStep12PocketTargetEvidence {
  return {
    horizon: "FULL_GAME",
    attemptedRules: 1500,
    topK,
    holdoutBaselineHomeDecisiveHitRate: baseline,
    rules,
  };
}

test("classifies a strong frozen holdout pocket as OOS-supported without producing BET_ELITE", () => {
  const evidence = rule();
  const result = validateMlbStep12Pocket(target([evidence]), evidence);
  assert.equal(result.status, "OOS_SUPPORTED_HYPOTHESIS");
  assert.equal(result.descriptiveHitRateBand, "EXCEPTIONAL_80_PLUS");
  assert.equal(result.policy.exactHoldoutPValueRecomputedFromCounts, true);
  assert.equal(result.policy.bonferroniParityRecomputedFromTopK, true);
  assert.equal(result.policy.betEliteLabelProduced, false);
  assert.equal(result.policy.livePickFiltersChanged, false);
});

test("does not reject stable 70-80 percent pockets merely for being below 80", () => {
  const evidence = rule({ discovery: metrics(0.76, 90, 55), holdout: metrics(0.75, 60, 40) });
  const result = validateMlbStep12Pocket(target([evidence]), evidence);
  assert.equal(result.status, "OOS_SUPPORTED_HYPOTHESIS");
  assert.equal(result.descriptiveHitRateBand, "STRONG_70_TO_80");
  assert.equal(result.policy.lowerHitRateStableSignalsRemainResearchEligible, true);
});

test("labels a tiny 90 percent pocket insufficient instead of promoting it", () => {
  const evidence = rule({ discovery: metrics(0.92, 25, 18), holdout: metrics(0.90, 10, 8) });
  const result = validateMlbStep12Pocket(target([evidence]), evidence);
  assert.equal(result.status, "INSUFFICIENT_HOLDOUT_SAMPLE");
  assert.equal(result.descriptiveHitRateBand, "EXCEPTIONAL_80_PLUS");
});

test("keeps raw significance that fails Bonferroni as promising, not supported", () => {
  const evidence = rule({ discovery: metrics(0.74, 80, 45), holdout: metrics(0.70, 40, 28) });
  const result = validateMlbStep12Pocket(target([evidence]), evidence);
  assert.ok((result.rawPValue as number) <= 0.05);
  assert.ok((result.familywiseAdjustedPValue as number) > 0.05);
  assert.equal(result.status, "PROMISING_NOT_FAMILYWISE_SUPPORTED");
});

test("flags a large discovery-to-holdout collapse as unstable even if holdout remains above baseline", () => {
  const evidence = rule({ discovery: metrics(0.90, 70, 50), holdout: metrics(0.68, 50, 35) });
  const result = validateMlbStep12Pocket(target([evidence]), evidence);
  assert.equal(result.status, "UNSTABLE_HOLDOUT");
  assert.ok(result.reasons.includes("DISCOVERY_HOLDOUT_DRIFT_GT_15PP"));
});

test("flags no positive holdout lift as unstable", () => {
  const evidence = rule({ discovery: metrics(0.65, 70, 45), holdout: metrics(0.50, 40, 30) });
  const result = validateMlbStep12Pocket(target([evidence]), evidence);
  assert.equal(result.status, "UNSTABLE_HOLDOUT");
  assert.ok(result.reasons.includes("NO_POSITIVE_HOLDOUT_LIFT"));
});

test("fails closed on internally inconsistent metrics", () => {
  const valid = rule();
  const broken = {
    ...valid,
    holdout: { ...valid.holdout, decisiveHitRate: 0.9 },
  };
  const result = validateMlbStep12Pocket(target([broken]), broken);
  assert.equal(result.status, "INVALID_EVIDENCE");
  assert.ok(result.reasons.includes("HOLDOUT_METRICS_INVALID"));
});

test("fails closed when stored raw p-value does not match hits n and baseline", () => {
  const valid = rule();
  const broken = { ...valid, holdoutOneSidedPValueVsBaseline: Math.min(1, (valid.holdoutOneSidedPValueVsBaseline as number) + 0.01) };
  const result = validateMlbStep12Pocket(target([broken]), broken);
  assert.equal(result.status, "INVALID_EVIDENCE");
  assert.ok(result.reasons.includes("RAW_P_VALUE_PARITY_FAILURE"));
});

test("fails closed when stored Bonferroni value is not raw p times frozen topK", () => {
  const valid = rule();
  const broken = { ...valid, holdoutBonferroniPValueTopK: valid.holdoutOneSidedPValueVsBaseline };
  const result = validateMlbStep12Pocket(target([broken]), broken);
  assert.equal(result.status, "INVALID_EVIDENCE");
  assert.ok(result.reasons.includes("BONFERRONI_PARITY_FAILURE"));
});

test("pilot validation requires exact topK cardinality and unique frozen rule keys", () => {
  const evidence = rule();
  const pilotBase = {
    schemaVersion: "courtedge-p0-step12-pocket-pilot.v1",
    evidenceStatus: "PILOT_RESEARCH_ONLY_NOT_BET_ELITE",
    policy: {
      historicalPricesUsed: false,
      historicalEvClaimProduced: false,
      holdoutThresholdTuningAllowed: false,
      automaticBestRulePromotion: false,
      livePickFiltersChanged: false,
      betEliteProduced: false,
    },
  } as const;
  assert.throws(() => validateMlbStep12PilotEvidence({ ...pilotBase, targets: [target([evidence], 0.53, 10)] }), /STEP12C_TOPK_CARDINALITY_MISMATCH/);

  const ten = Array.from({ length: 10 }, (_, index) => rule({ ruleKey: `rule-${index}` }));
  ten[9] = { ...ten[9], ruleKey: ten[0].ruleKey };
  assert.throws(() => validateMlbStep12PilotEvidence({ ...pilotBase, targets: [target(ten)] }), /STEP12C_DUPLICATE_RULE_KEY/);
});

test("pilot boundary rejects historical EV claims or live filtering", () => {
  const ten = Array.from({ length: 10 }, (_, index) => rule({ ruleKey: `rule-${index}` }));
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
    targets: [target(ten)],
  }), /STEP12C_RESEARCH_BOUNDARY_VIOLATION/);
});
