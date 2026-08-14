import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_FROZEN_CLASSIFIER_FEATURE_NAMES,
  classifyMlbFrozenAPlusAndF5,
} from "./mlb-frozen-a-plus-classifier";
import {
  MLB_FULL13_FEATURE_NAMES,
  buildMlbFull13LiveFeatures,
  type MlbFull13LivePregameInput,
  type MlbFull13PriorPitcherLine,
} from "./mlb-full13-live-feature-builder";

function teamHistory(
  teamId: number,
  runsFor: number[],
  runsAgainst: number[],
) {
  return runsFor.map((value, index) => ({
    officialDate: `2026-04-0${index + 1}`,
    gamePk: teamId * 100 + index,
    runsFor: value,
    runsAgainst: runsAgainst[index],
  }));
}

function priorLineups(teamId: number, order: number[]) {
  return Array.from({ length: 5 }, (_, index) => ({
    officialDate: `2026-04-0${index + 1}`,
    gamePk: teamId * 100 + index,
    battingOrder: [...order],
  }));
}

function pitcherLine(input: {
  gamePk: number;
  pitcherId: number;
  battersFaced: number;
  strikeOuts: number;
  baseOnBalls: number;
  earnedRuns: number | null;
  homeRuns: number | null;
}): MlbFull13PriorPitcherLine {
  return {
    officialDate: "2026-04-03",
    ...input,
  };
}

function fixture(): MlbFull13LivePregameInput {
  const homeOld = Array.from({ length: 9 }, (_, index) => 1_000 + index);
  const awayOld = Array.from({ length: 9 }, (_, index) => 2_000 + index);
  const homeCurrent = [...homeOld.slice(0, 8), 9_999];
  const awayCurrent = [...awayOld.slice(0, 7), 8_998, 8_999];
  const homeStarter = pitcherLine({
    gamePk: 7001,
    pitcherId: 501,
    battersFaced: 20,
    strikeOuts: 8,
    baseOnBalls: 2,
    earnedRuns: 2,
    homeRuns: 1,
  });
  const awayStarter = pitcherLine({
    gamePk: 7002,
    pitcherId: 502,
    battersFaced: 24,
    strikeOuts: 5,
    baseOnBalls: 4,
    earnedRuns: 5,
    homeRuns: 2,
  });
  const leagueOther = pitcherLine({
    gamePk: 7003,
    pitcherId: 503,
    battersFaced: 22,
    strikeOuts: 6,
    baseOnBalls: 2,
    earnedRuns: 3,
    homeRuns: 1,
  });

  return {
    officialDate: "2026-04-10",
    gamePk: 999001,
    homeTeamId: 10,
    awayTeamId: 20,
    homeTeamHistory: teamHistory(10, [5, 6, 4, 7, 3], [2, 3, 5, 1, 2]),
    awayTeamHistory: teamHistory(20, [2, 3, 4, 2, 5], [4, 5, 6, 3, 4]),
    leagueStarterHistory: [homeStarter, awayStarter, leagueOther],
    homeStarterHistory: [homeStarter],
    awayStarterHistory: [awayStarter],
    homeStarterId: 501,
    awayStarterId: 502,
    homePriorLineups: priorLineups(10, homeOld),
    awayPriorLineups: priorLineups(20, awayOld),
    homeBattingOrder: homeCurrent,
    awayBattingOrder: awayCurrent,
  };
}

function close(actual: number | null, expected: number, tolerance = 1e-12) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${actual} != ${expected}`);
}

test("FULL13 builder reproduces the frozen Step12V formula contract for all 13 classifier inputs", () => {
  const input = fixture();
  const assessment = buildMlbFull13LiveFeatures(input);

  assert.deepEqual(MLB_FULL13_FEATURE_NAMES, MLB_FROZEN_CLASSIFIER_FEATURE_NAMES);
  assert.equal(assessment.builderVersion, "mlb-full13-live-canonical-v1");
  assert.equal(assessment.priceIndependent, true);
  assert.equal(assessment.sameDateHistoryAllowed, false);
  assert.equal(assessment.seasonResetHistory, true);
  assert.equal(assessment.diagnostics.starterShrinkagePriorBattersFaced, 72);
  assert.equal(assessment.diagnostics.canonicalStep12VFormulaContractFrozen, true);

  close(assessment.featureVector.team_rd10_diff, 3.6);
  close(assessment.featureVector.team_win10_diff, 0.6);
  close(assessment.featureVector.team_ra10_adv, 1.8);
  close(assessment.featureVector.team_rs10_diff, 1.8);
  close(assessment.featureVector.combined_team_rs10, 8.2);
  close(assessment.featureVector.combined_team_ra10, 7.0);
  close(assessment.featureVector.lineup_exposure_rate_adv, 1 / 9);
  close(assessment.featureVector.lineup_continuity_rate_adv, 1 / 9);

  const leagueErbf = 10 / 66;
  const leagueKbb = 11 / 66;
  const leagueHrbf = 4 / 66;
  const homeErbf = (2 + 72 * leagueErbf) / 92;
  const awayErbf = (5 + 72 * leagueErbf) / 96;
  const homeKbb = (6 + 72 * leagueKbb) / 92;
  const awayKbb = (1 + 72 * leagueKbb) / 96;
  const homeHrbf = (1 + 72 * leagueHrbf) / 92;
  const awayHrbf = (2 + 72 * leagueHrbf) / 96;

  close(assessment.featureVector.starter_runrisk_adv, awayErbf - homeErbf);
  close(assessment.featureVector.starter_kbb_adv, homeKbb - awayKbb);
  close(assessment.featureVector.starter_hr_adv, awayHrbf - homeHrbf);
  close(assessment.featureVector.min_probable_prior_bf, 20);
  close(assessment.featureVector.combined_starter_kbb, homeKbb + awayKbb);

  for (const value of Object.values(assessment.featureVector)) {
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
  }

  const classified = classifyMlbFrozenAPlusAndF5(assessment.featureVector);
  assert.equal(classified.version, "mlb-frozen-a-plus-classifier.v1");
  for (const value of Object.values(classified.probabilities)) {
    assert.ok(value > 0 && value < 1);
  }
});

test("FULL13 fails closed when official starter ER/HR custody is absent while BF is positive", () => {
  const input = fixture();
  input.homeStarterHistory[0] = { ...input.homeStarterHistory[0], earnedRuns: null };
  assert.throws(
    () => buildMlbFull13LiveFeatures(input),
    /FULL13_PITCHER_EARNED_RUNS_REQUIRED:home/,
  );
});
