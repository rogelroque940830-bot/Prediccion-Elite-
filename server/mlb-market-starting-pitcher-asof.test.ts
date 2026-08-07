import test from "node:test";
import assert from "node:assert/strict";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
import type {
  MlbHistoricalStartingPitcherGame,
  MlbHistoricalStartingPitcherLine,
  MlbPitcherSide,
} from "./mlb-market-starting-pitcher-history";
import {
  buildMlbPitcherAsOfSnapshot,
  buildMlbStartingPitcherOosReport,
  predictMlbTeamPlusPitcherRunMeans,
  selectMlbStartingPitcherHyperparametersNested,
} from "./mlb-market-starting-pitcher-asof";

function isoDay(index: number): string {
  return new Date(Date.UTC(2025, 2, 1 + index)).toISOString().slice(0, 10);
}

function starterLine(options: {
  gamePk: number;
  date: string;
  side: MlbPitcherSide;
  teamId: number;
  opponentTeamId: number;
  pitcherId: number;
  earnedRuns: number;
  battersFaced?: number;
}): MlbHistoricalStartingPitcherLine {
  const bf = options.battersFaced ?? 18;
  return {
    gamePk: options.gamePk,
    officialDate: options.date,
    side: options.side,
    teamId: options.teamId,
    opponentTeamId: options.opponentTeamId,
    pitcherId: options.pitcherId,
    pitcherName: `Pitcher ${options.pitcherId}`,
    identityMethod: "GAME_STARTED_FLAG_AND_ORDER",
    outsRecorded: 15,
    inningsPitched: "5.0",
    battersFaced: bf,
    runs: options.earnedRuns,
    earnedRuns: options.earnedRuns,
    hits: options.earnedRuns + 2,
    baseOnBalls: 1,
    strikeOuts: 5,
    homeRuns: Math.min(1, options.earnedRuns),
    hitByPitch: 0,
    numberOfPitches: 75,
    strikes: 50,
  };
}

function starterGame(options: {
  gamePk: number;
  date: string;
  homeStarterId: number;
  awayStarterId: number;
  homeStarterEr: number;
  awayStarterEr: number;
}): MlbHistoricalStartingPitcherGame {
  return {
    gamePk: options.gamePk,
    officialDate: options.date,
    homeTeamId: 10,
    awayTeamId: 20,
    homeStarter: starterLine({
      gamePk: options.gamePk,
      date: options.date,
      side: "home",
      teamId: 10,
      opponentTeamId: 20,
      pitcherId: options.homeStarterId,
      earnedRuns: options.homeStarterEr,
    }),
    awayStarter: starterLine({
      gamePk: options.gamePk,
      date: options.date,
      side: "away",
      teamId: 20,
      opponentTeamId: 10,
      pitcherId: options.awayStarterId,
      earnedRuns: options.awayStarterEr,
    }),
    boxscoreSourceDigest: "a".repeat(64),
  };
}

function observation(options: {
  gamePk: number;
  date: string;
  homeRuns: number;
  awayRuns: number;
  horizon?: "FIRST_INNING" | "FIRST_3" | "FIRST_5" | "FULL_GAME";
}): MlbHistoricalHorizonObservation {
  const horizon = options.horizon ?? "FIRST_3";
  return {
    schemaVersion: "courtedge-p1-m6a3b1-historical-dataset.v1",
    source: "MLB_STATS_API_OFFICIAL",
    gamePk: options.gamePk,
    officialDate: options.date,
    season: 2025,
    horizon,
    homeTeamId: 10,
    homeTeam: "Home",
    awayTeamId: 20,
    awayTeam: "Away",
    homeRuns: options.homeRuns,
    awayRuns: options.awayRuns,
    totalRuns: options.homeRuns + options.awayRuns,
    homeMinusAway: options.homeRuns - options.awayRuns,
    nrfi: horizon === "FIRST_INNING" ? options.homeRuns + options.awayRuns === 0 : null,
    sourceVersion: "fixture.v1",
    sourceDigest: "b".repeat(64),
  };
}

function signalSample(days = 100): {
  observations: MlbHistoricalHorizonObservation[];
  starterGames: MlbHistoricalStartingPitcherGame[];
} {
  const observations: MlbHistoricalHorizonObservation[] = [];
  const starterGames: MlbHistoricalStartingPitcherGame[] = [];
  for (let index = 0; index < days; index += 1) {
    const date = isoDay(index);
    const gamePk = 800000 + index;
    const homeGood = index % 2 === 0;
    const homeStarterId = homeGood ? 1001 : 1002;
    const awayStarterId = homeGood ? 2002 : 2001;
    const homeStarterEr = homeGood ? 0 : 6;
    const awayStarterEr = homeGood ? 6 : 0;
    const homeRuns = awayStarterEr === 6 ? 5 : 1;
    const awayRuns = homeStarterEr === 6 ? 5 : 1;
    starterGames.push(starterGame({
      gamePk,
      date,
      homeStarterId,
      awayStarterId,
      homeStarterEr,
      awayStarterEr,
    }));
    observations.push(observation({ gamePk, date, homeRuns, awayRuns }));
  }
  return { observations, starterGames };
}

test("as-of pitcher snapshot excludes target-date and future pitching lines", () => {
  const games = [
    starterGame({
      gamePk: 1,
      date: "2025-04-01",
      homeStarterId: 1001,
      awayStarterId: 2001,
      homeStarterEr: 0,
      awayStarterEr: 4,
    }),
    starterGame({
      gamePk: 2,
      date: "2025-04-10",
      homeStarterId: 1001,
      awayStarterId: 2001,
      homeStarterEr: 12,
      awayStarterEr: 12,
    }),
    starterGame({
      gamePk: 3,
      date: "2025-04-11",
      homeStarterId: 1001,
      awayStarterId: 2001,
      homeStarterEr: 12,
      awayStarterEr: 12,
    }),
  ];
  const snapshot = buildMlbPitcherAsOfSnapshot(games, "2025-04-10", 36);
  assert.equal(snapshot.eligibleStarterLines, 2);
  assert.equal(snapshot.historyMaxDate, "2025-04-01");
  assert.equal(snapshot.pitchers["1001"].earnedRuns, 0);
  assert.equal(snapshot.pitchers["2001"].earnedRuns, 4);
  assert.equal(snapshot.actionabilityAllowed, false);
});

test("pitcher multiplier moves only the opponent scoring mean and unseen pitcher remains neutral", () => {
  const history = [
    starterGame({
      gamePk: 1,
      date: "2025-04-01",
      homeStarterId: 1001,
      awayStarterId: 2001,
      homeStarterEr: 0,
      awayStarterEr: 6,
    }),
    starterGame({
      gamePk: 2,
      date: "2025-04-02",
      homeStarterId: 1001,
      awayStarterId: 2001,
      homeStarterEr: 0,
      awayStarterEr: 6,
    }),
  ];
  const snapshot = buildMlbPitcherAsOfSnapshot(history, "2025-04-03", 18);
  const target = starterGame({
    gamePk: 3,
    date: "2025-04-03",
    homeStarterId: 1001,
    awayStarterId: 9999,
    homeStarterEr: 0,
    awayStarterEr: 0,
  });
  const weighted = predictMlbTeamPlusPitcherRunMeans(
    { homeMeanRuns: 3, awayMeanRuns: 3 },
    snapshot,
    target,
    1,
  );
  assert.equal(weighted.homeStarterSeen, true);
  assert.equal(weighted.awayStarterSeen, false);
  assert.equal(weighted.homeStarterRiskFactor < 1, true);
  assert.equal(weighted.awayStarterRiskFactor, 1);
  assert.equal(weighted.homeMeanRuns, 3);
  assert.equal(weighted.awayMeanRuns < 3, true);

  const nullEffect = predictMlbTeamPlusPitcherRunMeans(
    { homeMeanRuns: 3, awayMeanRuns: 4 },
    snapshot,
    target,
    0,
  );
  assert.equal(nullEffect.homeMeanRuns, 3);
  assert.equal(nullEffect.awayMeanRuns, 4);
});

test("nested selection uses only earlier pitcher history and finds pitcher signal when deliberately strong", () => {
  const sample = signalSample(70);
  const selection = selectMlbStartingPitcherHyperparametersNested(
    sample.observations,
    sample.starterGames,
    {
      teamPriorGamesGrid: [20],
      pitcherPriorBattersGrid: [18, 72],
      pitcherEffectWeightGrid: [0, 0.5, 1],
      innerValidationDateCount: 10,
      minimumInnerHistoryDates: 30,
    },
  );
  assert.equal(selection.leakageFree, true);
  assert.equal(selection.innerHistoryMaxDate < selection.innerValidationMinDate, true);
  assert.equal(selection.pitcherSnapshotHistoryMaxDate < selection.innerValidationMinDate, true);
  assert.equal(selection.selectedPitcherEffectWeight > 0, true);
});

test("rolling-origin pitcher report preserves as-of boundaries and compares against both team and league", () => {
  const sample = signalSample(100);
  const report = buildMlbStartingPitcherOosReport(sample.observations, sample.starterGames, {
    minimumTrainingDates: 50,
    validationDateCount: 10,
    stepDateCount: 10,
    minimumTotalValidationGames: 20,
    teamPriorGamesGrid: [20],
    pitcherPriorBattersGrid: [18, 72],
    pitcherEffectWeightGrid: [0, 0.5, 1],
    innerValidationDateCount: 10,
    minimumInnerHistoryDates: 30,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  const first3 = report.horizons.find((entry) => entry.horizon === "FIRST_3");
  assert.ok(first3);
  assert.equal(first3.status, "PITCHER_OOS_IMPROVEMENT_OVER_TEAM");
  assert.equal((first3.teamMinusPitcherCountNll ?? 0) > 0, true);
  assert.equal((first3.leagueMinusPitcherCountNll ?? 0) > 0, true);
  assert.equal(first3.validationGames > 0, true);
  assert.equal(first3.pairedRows.length, first3.validationGames);
  assert.equal(first3.folds.every((fold) =>
    fold.trainingMaxDate < fold.validationMinDate
    && fold.pitcherSnapshotHistoryMaxDate < fold.validationMinDate
    && fold.nestedSelection.pitcherSnapshotHistoryMaxDate < fold.nestedSelection.innerValidationMinDate), true);
  assert.equal(report.allFoldsLeakageFree, true);
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
});

test("target starter identity mismatch fails closed", () => {
  const sample = signalSample(70);
  const corrupted = sample.starterGames.map((game, index) => index === 65
    ? { ...game, homeTeamId: 999 }
    : game);
  assert.throws(
    () => selectMlbStartingPitcherHyperparametersNested(
      sample.observations,
      corrupted,
      {
        teamPriorGamesGrid: [20],
        pitcherPriorBattersGrid: [36],
        pitcherEffectWeightGrid: [0, 1],
        innerValidationDateCount: 10,
        minimumInnerHistoryDates: 30,
      },
    ),
    /TARGET_STARTER_IDENTITY_MISMATCH/,
  );
});
