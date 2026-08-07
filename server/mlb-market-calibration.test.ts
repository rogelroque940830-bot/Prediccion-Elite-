import test from "node:test";
import assert from "node:assert/strict";
import { buildMlbCalibrationReport } from "./mlb-market-calibration";

const perfect = [
  { id: "1", probabilities: { WIN: 1, PUSH: 0, LOSS: 0 }, outcome: "WIN" as const },
  { id: "2", probabilities: { WIN: 0, PUSH: 1, LOSS: 0 }, outcome: "PUSH" as const },
  { id: "3", probabilities: { WIN: 0, PUSH: 0, LOSS: 1 }, outcome: "LOSS" as const },
];

test("perfect multiclass forecasts have zero proper-score loss and zero calibration gap", () => {
  const report = buildMlbCalibrationReport(perfect, { binCount: 5 });
  assert.equal(report.n, 3);
  assert.equal(report.multiclassBrier, 0);
  assert.equal(report.logLoss, 0);
  assert.equal(report.macroEce, 0);
  assert.deepEqual(report.classCounts, { WIN: 1, PUSH: 1, LOSS: 1 });
  assert.ok(report.pushRate != null && Math.abs(report.pushRate - (1 / 3)) < 1e-8);
  assert.ok(report.reliabilityBins.length > 0);
  assert.ok(report.reliabilityBins.every((bin) => bin.empiricalWilson95.lower >= 0 && bin.empiricalWilson95.upper <= 1));
});

test("A3A cannot self-certify even when metrics satisfy an explicit policy", () => {
  const report = buildMlbCalibrationReport(perfect, {
    policy: {
      policyVersion: "test-policy.v1",
      minimumSamples: 3,
      maximumMulticlassBrier: 0.01,
      maximumLogLoss: 0.01,
      maximumMacroEce: 0.01,
    },
  });
  assert.equal(report.calibrationGate.status, "CALIBRATION_PASS_CANDIDATE");
  assert.equal(report.calibrationGate.metricsPassed, true);
  assert.equal(report.calibrationGate.actionabilityAllowed, false);
  assert.ok(report.calibrationGate.blockers.includes("A3B_OUT_OF_SAMPLE_CERTIFICATION_REQUIRED"));
});

test("without a versioned A3B policy the calibration gate is always closed", () => {
  const report = buildMlbCalibrationReport(perfect);
  assert.equal(report.calibrationGate.status, "POLICY_UNSET");
  assert.equal(report.calibrationGate.metricsPassed, false);
  assert.equal(report.calibrationGate.actionabilityAllowed, false);
  assert.deepEqual(report.calibrationGate.blockers, ["P1_M6A3B_VERSIONED_CALIBRATION_POLICY_REQUIRED"]);
});

test("sample floor blocks certification before metric thresholds are considered", () => {
  const report = buildMlbCalibrationReport(perfect, {
    policy: {
      policyVersion: "historical-policy.v1",
      minimumSamples: 100,
      maximumMulticlassBrier: 1,
      maximumLogLoss: 10,
      maximumMacroEce: 1,
    },
  });
  assert.equal(report.calibrationGate.status, "INSUFFICIENT_SAMPLE");
  assert.equal(report.calibrationGate.actionabilityAllowed, false);
});

test("badly overconfident forecasts are penalized by Brier, log loss and reliability gap", () => {
  const report = buildMlbCalibrationReport([
    { id: "a", probabilities: { WIN: 0.98, PUSH: 0.01, LOSS: 0.01 }, outcome: "LOSS" },
    { id: "b", probabilities: { WIN: 0.98, PUSH: 0.01, LOSS: 0.01 }, outcome: "LOSS" },
    { id: "c", probabilities: { WIN: 0.98, PUSH: 0.01, LOSS: 0.01 }, outcome: "WIN" },
  ]);
  assert.ok((report.multiclassBrier ?? 0) > 1);
  assert.ok((report.logLoss ?? 0) > 2);
  assert.ok((report.macroEce ?? 0) > 0.2);
});

test("invalid probability vectors and invalid policies are rejected", () => {
  assert.throws(() => buildMlbCalibrationReport([
    { id: "bad", probabilities: { WIN: 0.7, PUSH: 0.2, LOSS: 0.2 }, outcome: "WIN" },
  ]), /P1_M6A3A_FORECAST_PROBABILITIES_MUST_SUM_TO_ONE/);

  assert.throws(() => buildMlbCalibrationReport(perfect, {
    policy: {
      policyVersion: "",
      minimumSamples: 3,
      maximumMulticlassBrier: 1,
      maximumLogLoss: 1,
      maximumMacroEce: 1,
    },
  }), /P1_M6A3A_INVALID_CALIBRATION_POLICY/);
});
