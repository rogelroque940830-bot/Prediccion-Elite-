import assert from "node:assert/strict";
import test from "node:test";
import {
  CROSS_SPORT_CALIBRATION_SCHEMA,
  applyPlatt,
  calibrationMetrics,
  fitPlattCalibrator,
  validateCalibrationObservation,
  walkForwardPlatt,
  type CalibrationObservation,
} from "./cross-sport-calibration";
import { getCrossSportCalibrationReadiness } from "./cross-sport-calibration-readiness";

function row(season: number, index: number, rawSignal: number, outcome: 0 | 1, family = "FIXTURE"): CalibrationObservation {
  return {
    schemaVersion: CROSS_SPORT_CALIBRATION_SCHEMA,
    sport: "NFL",
    candidateId: `${season}-${index}`,
    gameId: `game-${season}-${index}`,
    eventDate: `${season}-10-01`,
    season,
    signalFamily: family,
    rawSignal,
    outcome,
    capturedAt: `${season}-10-01T12:00:00.000Z`,
    pregameCutoffAt: `${season}-10-01T20:00:00.000Z`,
    candidatePolicyDigest: "sha256:policy-fixture",
    sourceArtifactDigest: "sha256:artifact-fixture",
    sportEliteGatePassed: true,
    safety: {
      pregameOnly: true,
      sameGameOutcomeUsedAtDecisionTime: false,
      targetSeasonRankingOrCapUsed: false,
      historicalAccuracyUsedAsGameProbability: false,
    },
  };
}

test("calibration observation contract rejects temporal leakage and invalid raw signals", () => {
  const invalid = row(2024, 1, 0.7, 1);
  invalid.rawSignal = 1;
  invalid.capturedAt = "2024-10-02T00:00:00.000Z";
  assert.deepEqual(validateCalibrationObservation(invalid).sort(), [
    "pregame temporal custody invalid",
    "rawSignal must be in (0,1)",
  ]);
});

test("Platt calibrator is deterministic and emits finite probabilities", () => {
  const rows = Array.from({ length: 80 }, (_, index) => {
    const raw = 0.52 + (index % 20) * 0.02;
    const outcome = (index % 10) < Math.round(raw * 10) ? 1 : 0;
    return row(2023 + Math.floor(index / 40), index, Math.min(0.94, raw), outcome as 0 | 1);
  });
  const first = fitPlattCalibrator(rows, "FIXTURE");
  const second = fitPlattCalibrator(rows, "FIXTURE");
  assert.deepEqual(first, second);
  const calibrated = applyPlatt(first, 0.72);
  assert.ok(Number.isFinite(calibrated) && calibrated > 0 && calibrated < 1);
});

test("walk-forward uses only seasons strictly earlier than each target season", () => {
  const rows: CalibrationObservation[] = [];
  for (const season of [2021, 2022, 2023, 2024, 2025]) {
    for (let index = 0; index < 30; index += 1) {
      const raw = 0.55 + (index % 10) * 0.035;
      const outcome = (index % 10) < 7 ? 1 : 0;
      rows.push(row(season, index, raw, outcome as 0 | 1));
    }
  }
  const folds = walkForwardPlatt(rows, "FIXTURE");
  assert.ok(folds.length >= 4);
  for (const fold of folds) {
    assert.ok(fold.trainingSeasons.every((season) => season < fold.targetSeason));
    assert.ok(fold.trainingObservations >= 20);
    assert.equal(fold.testObservations, 30);
  }
});

test("proper scoring metrics never infer probability from aggregate hit rate", () => {
  const metrics = calibrationMetrics([0.6, 0.7, 0.8], [1, 0, 1]);
  assert.equal(metrics.observations, 3);
  assert.ok(metrics.brier !== null && metrics.logLoss !== null && metrics.ece10 !== null);
});

test("current cross-sport calibration remains fail-closed until every sport has labeled OOS rowsets", () => {
  const status = getCrossSportCalibrationReadiness();
  assert.equal(status.state, "BLOCKED");
  assert.equal(status.globalRankerCalibrationCertified, false);
  assert.equal(status.sports.MLB.state, "PROSPECTIVE_LABELED_ONLY");
  assert.equal(status.sports.WNBA.state, "PREGAME_SIGNAL_WITHOUT_OUTCOME_CUSTODY");
  assert.equal(status.sports.NBA.state, "CANDIDATE_CUSTODY_MISSING");
  assert.equal(status.sports.NHL.state, "CANDIDATE_CUSTODY_MISSING");
  assert.equal(status.sports.NFL.state, "CERTIFIED_AGGREGATES_WITHOUT_CALIBRATION_ROWSET");
  assert.equal(status.protocol.method, "PLATT_LOGIT_1D");
  assert.equal(status.protocol.minimumTargetSeasonsWhenApplicable, 5);
  assert.equal(status.protocol.aggregateHitRateAcceptedAsGameProbability, false);
  assert.equal(status.safety.automaticPromotion, false);
});
