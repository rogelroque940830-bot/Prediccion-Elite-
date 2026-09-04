import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNflCrossSportReadiness,
  evaluateGlobalRankerEligibility,
} from "./nfl-cross-sport-readiness";

function baseSnapshot(overrides: Record<string, unknown> = {}): any {
  return {
    schemaVersion: "courtedge-nfl-full-elite-operational-2026.v1",
    sport: "NFL",
    season: 2026,
    generatedAt: "2026-08-25T15:00:00.000Z",
    state: "READY",
    cards: [],
    safety: {
      pregameOnly: true,
      sameGameOutcomeUsed: false,
      targetGamedayUpdatesAllowed: false,
      marketDataUsedAsModelFeature: false,
      automaticBetPlacement: false,
    },
    lateDown: {
      enabled: true,
      rowsRead: 100,
      processedCompletedGames: 3663,
      artifactPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING",
    },
    ...overrides,
  };
}

function card(overrides: Record<string, unknown> = {}): any {
  return {
    gameId: "2026_01_DAL_PHI",
    season: 2026,
    week: 1,
    gameday: "2026-09-10",
    homeTeam: "PHI",
    awayTeam: "DAL",
    state: "NFL_ELITE",
    modelDecision: "NFL_ELITE",
    predictedTeam: "PHI",
    predictedSide: "HOME",
    predictedSideProbability: 0.71,
    eliteRoute: "R5H8_CORE",
    lateDownScore: null,
    score: { decision: "NFL_ELITE" },
    ...overrides,
  };
}

test("global ranker gate rejects an uncalibrated sport even after its Elite gate passes", () => {
  assert.deepEqual(evaluateGlobalRankerEligibility({
    sportEliteGatePassed: true,
    calibrationStatus: "UNCALIBRATED",
    calibrationArtifactDigest: null,
    calibratedProbability: null,
  }), {
    eligible: false,
    reason: "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED",
  });

  assert.deepEqual(evaluateGlobalRankerEligibility({
    sportEliteGatePassed: true,
    calibrationStatus: "CERTIFIED",
    calibrationArtifactDigest: "sha256:fixture",
    calibratedProbability: 0.74,
  }), {
    eligible: true,
    reason: null,
  });
});

test("NFL Late Down combined Elite preserves its own route signal while core NO_ELITE is not mistaken for the final decision", () => {
  const snapshot = baseSnapshot({
    cards: [card({
      eliteRoute: "LATE_DOWN",
      modelDecision: "NFL_ELITE",
      score: { decision: "NO_ELITE" },
      lateDownScore: {
        thresholdOnlySelected: true,
        predictedSide: "HOME",
        lateDownProbability: 0.82,
        supportScore: 1.12,
      },
    })],
  });

  const readiness = buildNflCrossSportReadiness(snapshot);
  assert.equal(readiness.candidates.length, 1);
  assert.equal(readiness.candidates[0].sportEliteGate.route, "LATE_DOWN");
  assert.equal(readiness.candidates[0].sportEliteGate.decision, "NFL_ELITE");
  assert.equal(readiness.candidates[0].routeModelProbability, 0.82);
  assert.equal(readiness.candidates[0].routeSupportScore, 1.12);
  assert.equal(readiness.candidates[0].crossSportCalibration.status, "UNCALIBRATED");
  assert.equal(readiness.candidates[0].crossSportCalibration.calibratedProbability, null);
  assert.equal(readiness.candidates[0].globalRanker.eligible, false);
  assert.equal(readiness.globalRankerCandidates.length, 0);
  assert.equal(readiness.globalRankerEligible, false);
  assert.equal(readiness.candidates[0].safety.historicalAccuracyUsedAsGameProbability, false);
  assert.equal("historicalAccuracy" in readiness.candidates[0], false);
});

test("Late Down away-side readiness converts the home probability into the selected-side raw route probability", () => {
  const snapshot = baseSnapshot({
    cards: [card({
      predictedTeam: "DAL",
      predictedSide: "AWAY",
      predictedSideProbability: 0.68,
      eliteRoute: "LATE_DOWN",
      score: { decision: "NO_ELITE" },
      lateDownScore: {
        thresholdOnlySelected: true,
        predictedSide: "AWAY",
        lateDownProbability: 0.21,
        supportScore: 1.31,
      },
    })],
  });
  const readiness = buildNflCrossSportReadiness(snapshot);
  assert.equal(readiness.candidates.length, 1);
  assert.ok(Math.abs(readiness.candidates[0].routeModelProbability - 0.79) < 1e-12);
  assert.equal(readiness.candidates[0].routeSupportScore, 1.31);
});

test("NFL NO_ELITE and malformed Elite cards do not become cross-sport candidates", () => {
  const snapshot = baseSnapshot({
    cards: [
      card({ gameId: "no-elite", state: "NO_ELITE", modelDecision: "NO_ELITE", eliteRoute: null }),
      card({ gameId: "missing-route", eliteRoute: null }),
      card({ gameId: "missing-probability", predictedSideProbability: null }),
    ],
  });
  const readiness = buildNflCrossSportReadiness(snapshot);
  assert.equal(readiness.candidates.length, 0);
  assert.equal(readiness.globalRankerCandidates.length, 0);
  assert.equal(readiness.rejectedEliteCards, 2);
});

test("blocked or safety-invalid NFL snapshots fail closed before cross-sport candidate emission", () => {
  const blocked = buildNflCrossSportReadiness(baseSnapshot({ state: "BLOCKED", cards: [card()] }));
  assert.equal(blocked.candidates.length, 0);
  assert.match(blocked.reasons.join(" "), /NFL_OPERATIONAL_SNAPSHOT_BLOCKED/);

  const unsafe = buildNflCrossSportReadiness(baseSnapshot({
    cards: [card()],
    safety: {
      pregameOnly: true,
      sameGameOutcomeUsed: false,
      targetGamedayUpdatesAllowed: false,
      marketDataUsedAsModelFeature: true,
      automaticBetPlacement: false,
    },
  }));
  assert.equal(unsafe.candidates.length, 0);
  assert.match(unsafe.reasons.join(" "), /NFL_SAFETY_CONTRACT_FAILED/);
});
