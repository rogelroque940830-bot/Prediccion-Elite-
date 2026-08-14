import assert from "node:assert/strict";
import test from "node:test";
import { MLB_FULL13_FEATURE_NAMES, type MlbFull13FeatureVector } from "./mlb-full13-live-feature-builder";
import {
  assessMlbTeamTotalLine,
  MLB_TEAM_TOTAL_V20_CUSTODY,
  scoreMlbTeamTotalExpectedRuns,
} from "./mlb-team-total-count-model";

function nullVector(): MlbFull13FeatureVector {
  return Object.fromEntries(MLB_FULL13_FEATURE_NAMES.map((feature) => [feature, null])) as MlbFull13FeatureVector;
}

function approx(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} within ${tolerance}`);
}

test("V21 custody is pinned to the certified V20 artifact", () => {
  assert.equal(MLB_TEAM_TOTAL_V20_CUSTODY.workflowRunId, 31838474790);
  assert.equal(MLB_TEAM_TOTAL_V20_CUSTODY.artifactId, 9233422245);
  assert.equal(
    MLB_TEAM_TOTAL_V20_CUSTODY.artifactDigest,
    "sha256:5ef2e6525ccb67a27227b18422401db8672e5a74bf682af5c1e00c229570b43d",
  );
  assert.equal(MLB_TEAM_TOTAL_V20_CUSTODY.sourceClassification, "PROSPECTIVE_TEAM_TOTAL_PRICE_CAPTURE_CANDIDATE");
  assert.equal(MLB_TEAM_TOTAL_V20_CUSTODY.historicalTeamTotalPricesUsed, false);
});

test("all-null FULL13 uses the frozen 2022 medians and reproduces V20 expected runs", () => {
  const features = nullVector();
  const home = scoreMlbTeamTotalExpectedRuns(features, "HOME");
  const away = scoreMlbTeamTotalExpectedRuns(features, "AWAY");
  approx(home.meanRuns, 4.269983212379327, 1e-12);
  approx(away.meanRuns, 4.2283696648772215, 1e-12);
  approx(home.nb2Dispersion, 0.24430097249578325, 1e-15);
  approx(away.nb2Dispersion, 0.29295531185235457, 1e-15);
});

test("half-run Team Total probabilities reproduce the frozen V20 NB2 distribution without push", () => {
  const home = assessMlbTeamTotalLine({
    gamePk: 777001,
    generatedAt: "2026-08-14T20:00:00.000Z",
    teamSide: "HOME",
    line: 4.5,
    features: nullVector(),
  });
  approx(home.meanRuns, 4.269983212379327, 1e-12);
  approx(home.over.winProbability, 0.40001973049938144, 1e-12);
  approx(home.under.winProbability, 0.5999802695006186, 1e-12);
  assert.equal(home.over.pushProbability, 0);
  assert.equal(home.under.pushProbability, 0);
  approx(home.over.winProbability + home.over.lossProbability, 1, 1e-12);
  assert.equal(home.priceIndependent, true);
  assert.equal(home.positiveEvEstablished, false);
  assert.equal(home.recommendsBet, false);
  assert.equal(home.realFinancialExposure, 0);
});

test("integer Team Total line exposes exact push probability and unconditional settlement", () => {
  const away = assessMlbTeamTotalLine({
    gamePk: 777002,
    generatedAt: "2026-08-14T20:00:00.000Z",
    teamSide: "AWAY",
    line: 4,
    features: nullVector(),
  });
  approx(away.meanRuns, 4.2283696648772215, 1e-12);
  approx(away.over.winProbability, 0.3906790008732983, 1e-12);
  approx(away.over.pushProbability, 0.13047097706830244, 1e-12);
  approx(away.over.lossProbability, 0.4788500220583997, 1e-12);
  approx(away.under.winProbability, 0.4788500220583997, 1e-12);
  approx(away.under.pushProbability, 0.13047097706830244, 1e-12);
  approx(away.under.lossProbability, 0.3906790008732983, 1e-12);
  approx(away.over.winProbability + away.over.pushProbability + away.over.lossProbability, 1, 1e-12);
  approx(away.under.winProbability + away.under.pushProbability + away.under.lossProbability, 1, 1e-12);
});

test("model input digest is exact and changes with side, line, or feature values", () => {
  const features = nullVector();
  const base = assessMlbTeamTotalLine({ gamePk: 777003, generatedAt: "2026-08-14T20:00:00.000Z", teamSide: "HOME", line: 4.5, features });
  const replay = assessMlbTeamTotalLine({ gamePk: 777003, generatedAt: "2026-08-14T20:01:00.000Z", teamSide: "HOME", line: 4.5, features });
  assert.equal(base.modelInputDigest, replay.modelInputDigest);

  const changedFeatures = { ...features, team_win10_diff: 0.2 };
  const changedFeature = assessMlbTeamTotalLine({ gamePk: 777003, generatedAt: "2026-08-14T20:00:00.000Z", teamSide: "HOME", line: 4.5, features: changedFeatures });
  const changedLine = assessMlbTeamTotalLine({ gamePk: 777003, generatedAt: "2026-08-14T20:00:00.000Z", teamSide: "HOME", line: 5.5, features });
  const changedSide = assessMlbTeamTotalLine({ gamePk: 777003, generatedAt: "2026-08-14T20:00:00.000Z", teamSide: "AWAY", line: 4.5, features });
  assert.notEqual(base.modelInputDigest, changedFeature.modelInputDigest);
  assert.notEqual(base.modelInputDigest, changedLine.modelInputDigest);
  assert.notEqual(base.modelInputDigest, changedSide.modelInputDigest);
});

test("invalid game, time, or line fails closed", () => {
  const features = nullVector();
  assert.throws(() => assessMlbTeamTotalLine({ gamePk: 0, generatedAt: "2026-08-14T20:00:00.000Z", teamSide: "HOME", line: 4.5, features }), /GAME_PK_INVALID/);
  assert.throws(() => assessMlbTeamTotalLine({ gamePk: 1, generatedAt: "not-a-date", teamSide: "HOME", line: 4.5, features }), /GENERATED_AT_INVALID/);
  assert.throws(() => assessMlbTeamTotalLine({ gamePk: 1, generatedAt: "2026-08-14T20:00:00.000Z", teamSide: "HOME", line: -0.5, features }), /LINE_INVALID/);
});
