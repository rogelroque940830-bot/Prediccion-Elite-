import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_DATES,
  MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_OBSERVATIONS,
  buildMlbOperatingEnvelopeCalibration,
  type MlbOperatingEnvelopeCalibrationObservation,
} from "./mlb-operating-envelope-calibration";

function row(index: number, overrides: Partial<MlbOperatingEnvelopeCalibrationObservation> = {}): MlbOperatingEnvelopeCalibrationObservation {
  const day = String((index % 30) + 1).padStart(2, "0");
  return {
    predictionId: `p-${index}`,
    gameDate: `2026-07-${day}`,
    gamePk: 100000 + index,
    marketType: index % 2 === 0 ? "TOTAL" : "F5_TOTAL",
    expectedValuePerUnit: index % 4 === 0 ? 0.12 : 0.04,
    executionNoVigEdgePp: index % 4 === 0 ? 7 : 2,
    modelWinProbability: 0.56,
    referenceAgreement: index % 3 === 0 ? "SUPPORTS_MODEL_EDGE" : "NEUTRAL",
    outcome: index % 5 === 0 ? "LOSS" : "WIN",
    realizedProfitUnits: index % 5 === 0 ? -1 : 0.9,
    ...overrides,
  };
}

test("11B keeps prior P1-M3E evidence minimums as research sufficiency only", () => {
  assert.equal(MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_OBSERVATIONS, 80);
  assert.equal(MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_DATES, 30);
  const report = buildMlbOperatingEnvelopeCalibration({
    observations: [row(1), row(2)],
    rules: [{ ruleKey: "ev-positive", atoms: [{ kind: "MIN_EXPECTED_VALUE", value: 0.01 }] }],
  });
  assert.equal(report.state, "INSUFFICIENT_SAMPLE");
  assert.equal(report.policy.minimumSampleRequirementsAreResearchOnly, true);
  assert.equal(report.policy.minimumSampleRequirementsAreLivePickFilters, false);
  assert.equal(report.policy.researchSufficiencyUsesDecisiveOutcomesOnly, true);
  assert.equal(report.policy.liveOperatingEnvelopeChanged, false);
});

test("baseline represents all current Step 11A candidates and preserves 100 percent pick volume", () => {
  const observations = Array.from({ length: 10 }, (_, index) => row(index));
  const report = buildMlbOperatingEnvelopeCalibration({ observations, rules: [] });
  assert.equal(report.baseline.observations, 10);
  assert.equal(report.baseline.retentionPctOfBaselineCandidates, 100);
  assert.equal(report.baseline.activeDateCoveragePct, 100);
  assert.equal(report.baseline.noPickDates, 0);
  assert.equal(report.baseline.noPickDatePct, 0);
});

test("every candidate rule reports quality and exact pick-volume loss side by side", () => {
  const observations = Array.from({ length: 20 }, (_, index) => row(index));
  const report = buildMlbOperatingEnvelopeCalibration({
    observations,
    rules: [{ ruleKey: "ev-12pct", atoms: [{ kind: "MIN_EXPECTED_VALUE", value: 0.12 }] }],
  });
  const result = report.rules[0];
  assert.equal(result.metrics.observations, 5);
  assert.equal(result.metrics.retentionPctOfBaselineCandidates, 25);
  assert.ok(result.metrics.activeDateCoveragePct < 100);
  assert.ok(result.metrics.noPickDates > 0);
  assert.ok(result.metrics.flatStakeRoiPct != null);
  assert.ok(result.metrics.meanBrierScore != null);
  assert.ok(result.metrics.meanLogLoss != null);
});

test("a rule that kills every pick is exposed explicitly instead of looking elite by absence", () => {
  const observations = Array.from({ length: 12 }, (_, index) => row(index));
  const report = buildMlbOperatingEnvelopeCalibration({
    observations,
    rules: [{ ruleKey: "impossible", atoms: [{ kind: "MIN_EXPECTED_VALUE", value: 99 }] }],
  });
  const metrics = report.rules[0].metrics;
  assert.equal(metrics.observations, 0);
  assert.equal(metrics.retentionPctOfBaselineCandidates, 0);
  assert.equal(metrics.activeDateCoveragePct, 0);
  assert.equal(metrics.noPickDatePct, 100);
  assert.equal(metrics.flatStakeRoiPct, null);
});

test("pushes are excluded from all binary calibration metrics but remain settlement-neutral in ROI", () => {
  const observations = [
    row(1, { predictionId: "decisive-win", modelWinProbability: 0.6, outcome: "WIN", realizedProfitUnits: 0.9 }),
    row(2, { predictionId: "decisive-loss", modelWinProbability: 0.4, outcome: "LOSS", realizedProfitUnits: -1 }),
    row(3, { predictionId: "push-only", modelWinProbability: 0.99, outcome: "PUSH", realizedProfitUnits: 0 }),
  ];
  const report = buildMlbOperatingEnvelopeCalibration({ observations, rules: [] });
  assert.equal(report.baseline.pushes, 1);
  assert.equal(report.baseline.decisiveWinRate, 0.5);
  assert.equal(report.baseline.meanModelWinProbability, 0.5);
  assert.equal(report.baseline.calibrationGap, 0);
  assert.ok(Math.abs(report.baseline.meanBrierScore! - 0.16) < 1e-12);
  assert.ok(Math.abs(report.baseline.flatStakeRoiPct! - ((0.9 - 1 + 0) / 3) * 100) < 1e-12);
});

test("calibration gap is absolute so overconfidence cannot look artificially better", () => {
  const observations = [
    row(1, { predictionId: "overconfident-win", modelWinProbability: 0.8, outcome: "WIN", realizedProfitUnits: 0.9 }),
    row(2, { predictionId: "overconfident-loss-1", modelWinProbability: 0.8, outcome: "LOSS", realizedProfitUnits: -1 }),
    row(3, { predictionId: "overconfident-loss-2", modelWinProbability: 0.8, outcome: "LOSS", realizedProfitUnits: -1 }),
    row(4, { predictionId: "overconfident-loss-3", modelWinProbability: 0.8, outcome: "LOSS", realizedProfitUnits: -1 }),
    row(5, { predictionId: "overconfident-loss-4", modelWinProbability: 0.8, outcome: "LOSS", realizedProfitUnits: -1 }),
  ];
  const report = buildMlbOperatingEnvelopeCalibration({ observations, rules: [] });
  assert.ok(Math.abs(report.baseline.decisiveWinRate! - 0.2) < 1e-12);
  assert.ok(Math.abs(report.baseline.meanModelWinProbability! - 0.8) < 1e-12);
  assert.ok(Math.abs(report.baseline.calibrationGap! - 0.6) < 1e-12);
  assert.ok(report.baseline.calibrationGap! >= 0);
});

test("push-heavy cohorts cannot satisfy the 80 observation 30 date research gate", () => {
  const observations = Array.from({ length: 80 }, (_, index) => row(index, {
    outcome: index === 0 ? "WIN" : "PUSH",
    realizedProfitUnits: index === 0 ? 0.9 : 0,
  }));
  const report = buildMlbOperatingEnvelopeCalibration({ observations, rules: [] });
  assert.equal(report.baseline.observations, 80);
  assert.equal(report.baseline.pushes, 79);
  assert.equal(report.cohort.observations, 1);
  assert.equal(report.cohort.dates, 1);
  assert.equal(report.state, "INSUFFICIENT_SAMPLE");
  assert.ok(report.blockers.includes("MINIMUM_OBSERVATIONS_NOT_REACHED"));
  assert.ok(report.blockers.includes("MINIMUM_DATES_NOT_REACHED"));
});

test("settlement-inconsistent outcomes or profit values fail closed", () => {
  assert.throws(() => buildMlbOperatingEnvelopeCalibration({
    observations: [row(1, { outcome: "PUSH", realizedProfitUnits: 1 })],
    rules: [],
  }), /MLB_OPERATING_ENVELOPE_CALIBRATION_SETTLEMENT_PROFIT_INVALID/);
  assert.throws(() => buildMlbOperatingEnvelopeCalibration({
    observations: [row(2, { outcome: "LOSS", realizedProfitUnits: 0.5 })],
    rules: [],
  }), /MLB_OPERATING_ENVELOPE_CALIBRATION_SETTLEMENT_PROFIT_INVALID/);
  assert.throws(() => buildMlbOperatingEnvelopeCalibration({
    observations: [row(3, { outcome: "WIN", realizedProfitUnits: 0 })],
    rules: [],
  }), /MLB_OPERATING_ENVELOPE_CALIBRATION_SETTLEMENT_PROFIT_INVALID/);
  assert.throws(() => buildMlbOperatingEnvelopeCalibration({
    observations: [row(4, { outcome: "VOID" as any, realizedProfitUnits: 0 })],
    rules: [],
  }), /MLB_OPERATING_ENVELOPE_CALIBRATION_OUTCOME_INVALID/);
});

test("impossible calendar dates fail closed and cannot satisfy research date sufficiency", () => {
  assert.throws(() => buildMlbOperatingEnvelopeCalibration({
    observations: [row(1, { gameDate: "2026-02-30" })],
    rules: [],
  }), /MLB_OPERATING_ENVELOPE_CALIBRATION_IDENTITY_INVALID/);
});

test("runtime does not hard-code a winning rule or auto-promote point estimates", () => {
  const observations = Array.from({ length: 90 }, (_, index) => row(index));
  const report = buildMlbOperatingEnvelopeCalibration({
    observations,
    rules: [
      { ruleKey: "ev-4", atoms: [{ kind: "MIN_EXPECTED_VALUE", value: 0.04 }] },
      { ruleKey: "ev-12-and-support", atoms: [
        { kind: "MIN_EXPECTED_VALUE", value: 0.12 },
        { kind: "REFERENCE_IS", value: "SUPPORTS_MODEL_EDGE" },
      ] },
    ],
  });
  assert.equal(report.state, "RESEARCH_METRICS_READY");
  assert.equal(report.rules.length, 2);
  assert.equal(report.policy.ruleThresholdsHardCodedByRuntime, false);
  assert.equal(report.policy.automaticBestRuleSelection, false);
  assert.equal(report.policy.pointEstimateCanPromoteBetElite, false);
  assert.equal(report.policy.betEliteLabelProduced, false);
  assert.equal(report.policy.stakeCalculated, false);
  assert.equal(report.policy.automaticBetPlacement, false);
});

test("duplicate prediction identity and malformed numeric evidence fail closed", () => {
  assert.throws(() => buildMlbOperatingEnvelopeCalibration({
    observations: [row(1), row(1)],
    rules: [],
  }), /MLB_OPERATING_ENVELOPE_CALIBRATION_DUPLICATE/);
  assert.throws(() => buildMlbOperatingEnvelopeCalibration({
    observations: [row(2, { expectedValuePerUnit: Number.NaN })],
    rules: [],
  }), /MLB_OPERATING_ENVELOPE_CALIBRATION_NUMERIC_INPUT_INVALID/);
});
