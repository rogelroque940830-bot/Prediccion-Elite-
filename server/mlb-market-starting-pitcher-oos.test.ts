import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMlbPitcherStrengthSnapshot,
  buildMlbStartingPitcherOosReport,
  predictMlbTeamPlusPitcherRunMeans,
  selectMlbPitcherHyperparametersNested,
} from "./mlb-market-starting-pitcher-oos";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
import type {
  MlbHistoricalStartingPitcherGame,
  MlbHistoricalStartingPitcherLine,
} from "./mlb-market-starting-pitcher-history";

function starterLine(options: {
  gamePk: number;
  date: string;
  side: "home" | "away";
  teamId: number;
  opponentTeamId: number;
  pitcherId: number;
  runs: number;
  outs?: number;
}): MlbHistoricalStartingPitcherLine {
  const outs = options.outs ?? 15;
  const whole = Math.floor(outs / 3);
  const partial = outs % 3;
  return {
    gamePk: options.gamePk,
    officialDate: options.date,
    side: options.side,
    teamId: options.teamId,
    opponentTeamId: options.opponentTeamId,
    pitcherId: options.pitcherId,
    pitcherName: `P${options.pitcherId}`,
    identityMethod: "GAME_STARTED_FLAG_AND_ORDER",
    outsRecorded: outs,
    inningsPitched: `${whole}.${partial}`,
    battersFaced: 20,
    runs: options.runs,
    earnedRuns: options.runs,
    hits: Math.max(1, options.runs + 2),
    baseOnBalls: 1,
    strikeOuts: 5,
    homeRuns: options.runs > 3 ? 2 : 0,
    hitByPitch: 0,
    numberOfPitches: 80,
    strikes: 52,
  };
}

function starterGame(options: {
  gamePk: number;
  date: string;
  homeStarterId: number;
  awayStarterId: number;
  homeRunsAllowed?: number;
  awayRunsAllowed?: number;
  homeOuts?: number;
  awayOuts?: number;
  homeTeamId?: number;
  awayTeamId?: number;
}): MlbHistoricalStartingPitcherGame {
  const homeTeamId = options.homeTeamId ?? 10;
  const awayTeamId = options.awayTeamId ?? 20;
  return {
    gamePk: options.gamePk,
    officialDate: options.date,
    homeTeamId,
    awayTeamId,
    homeStarter: starterLine({
      gamePk: options.gamePk,
      date: options.date,
      side: "home",
      teamId: homeTeamId,
      opponentTeamId: awayTeamId,
      pitcherId: options.homeStarterId,
      runs: options.homeRunsAllowed ?? 1,
      outs: options.homeOuts,
    }),
    awayStarter: starterLine({
      gamePk: options.gamePk,
      date: options.date,
      side: "away",
      teamId: awayTeamId,
      opponentTeamId: homeTeamId,
      pitcherId: options.awayStarterId,
      runs: options.awayRunsAllowed ?? 4,
      outs: options.awayOuts,
    }),
    boxscoreSourceDigest: `${options.gamePk}`.padStart(64, "a").slice(-64),
  };
}

function row(gamePk: number, date: string, homeRuns: number, awayRuns: number, horizon: "FIRST_INNING" | "FIRST_3" | "FIRST_5" | "FULL_GAME" = "FULL_GAME"): MlbHistoricalHorizonObservation {
  return {
    schemaVersion: "courtedge-p1-m6a3b1-historical-dataset.v1",
    source: "MLB_STATS_API_OFFICIAL",
    gamePk,
    officialDate: date,
    season: 2025,
    horizon,
    homeTeamId: 10,
    homeTeam: "Home",
    awayTeamId: 20,
    awayTeam: "Away",
    homeRuns,
    awayRuns,
    totalRuns: homeRuns + awayRuns,
    homeMinusAway: homeRuns - awayRuns,
    nrfi: horizon === "FIRST_INNING" ? homeRuns + awayRuns === 0 : null,
    sourceVersion: "fixture.v1",
    sourceDigest: "f".repeat(64),
  };
}

test("pitcher snapshot is strictly bounded by asOfMaxDate and cold-start remains neutral", () => {
  const games = [
    starterGame({ gamePk: 1, date: "2025-05-01", homeStarterId: 101, awayStarterId: 201, homeRunsAllowed: 0, awayRunsAllowed: 6 }),
    starterGame({ gamePk: 2, date: "2025-05-02", homeStarterId: 101, awayStarterId: 201, homeRunsAllowed: 1, awayRunsAllowed: 5 }),
    starterGame({ gamePk: 3, date: "2025-05-10", homeStarterId: 101, awayStarterId: 201, homeRunsAllowed: 9, awayRunsAllowed: 0 }),
  ];
  const snapshot = buildMlbPitcherStrengthSnapshot(games, { asOfMaxDate: "2025-05-02", priorStarts: 1 });
  assert.equal(snapshot.historyGames, 2);
  assert.equal(snapshot.pitchers["101"].starts, 2);
  assert.equal(snapshot.pitchers["201"].starts, 2);
  assert.ok(snapshot.pitchers["101"].runRateFactor < 1);
  assert.ok(snapshot.pitchers["201"].runRateFactor > 1);

  const cold = predictMlbTeamPlusPitcherRunMeans(
    { homeMeanRuns: 4, awayMeanRuns: 4 },
    snapshot,
    { gamePk: 9, officialDate: "2025-05-11", homeTeamId: 10, awayTeamId: 20, homeStarterId: 999, awayStarterId: 998 },
    "FULL_GAME",
    1,
  );
  assert.equal(cold.homeMeanRuns, 4);
  assert.equal(cold.awayMeanRuns, 4);
  assert.equal(cold.homeStarterPriorStarts, 0);
  assert.equal(cold.awayStarterPriorStarts, 0);
});

test("poor opposing starter raises expected runs and strong opposing starter lowers them", () => {
  const games = [
    starterGame({ gamePk: 1, date: "2025-05-01", homeStarterId: 101, awayStarterId: 201, homeRunsAllowed: 0, awayRunsAllowed: 7 }),
    starterGame({ gamePk: 2, date: "2025-05-02", homeStarterId: 101, awayStarterId: 201, homeRunsAllowed: 0, awayRunsAllowed: 6 }),
  ];
  const snapshot = buildMlbPitcherStrengthSnapshot(games, { asOfMaxDate: "2025-05-02", priorStarts: 1 });
  const prediction = predictMlbTeamPlusPitcherRunMeans(
    { homeMeanRuns: 4, awayMeanRuns: 4 },
    snapshot,
    { gamePk: 3, officialDate: "2025-05-03", homeTeamId: 10, awayTeamId: 20, homeStarterId: 101, awayStarterId: 201 },
    "FIRST_5",
    1,
  );
  assert.ok(prediction.homeMeanRuns > 4, "home offense should rise against the poor away starter");
  assert.ok(prediction.awayMeanRuns < 4, "away offense should fall against the strong home starter");
  assert.equal(prediction.homeStarterSeen, true);
  assert.equal(prediction.awayStarterSeen, true);
});

test("starter workload attenuates full-game effect relative to F5", () => {
  const games = [
    starterGame({ gamePk: 1, date: "2025-05-01", homeStarterId: 101, awayStarterId: 201, awayRunsAllowed: 7, awayOuts: 9 }),
    starterGame({ gamePk: 2, date: "2025-05-02", homeStarterId: 101, awayStarterId: 201, awayRunsAllowed: 6, awayOuts: 9 }),
  ];
  const snapshot = buildMlbPitcherStrengthSnapshot(games, { asOfMaxDate: "2025-05-02", priorStarts: 1 });
  const identity = { gamePk: 3, officialDate: "2025-05-03", homeTeamId: 10, awayTeamId: 20, homeStarterId: 101, awayStarterId: 201 };
  const f5 = predictMlbTeamPlusPitcherRunMeans({ homeMeanRuns: 4, awayMeanRuns: 4 }, snapshot, identity, "FIRST_5", 1);
  const full = predictMlbTeamPlusPitcherRunMeans({ homeMeanRuns: 4, awayMeanRuns: 4 }, snapshot, identity, "FULL_GAME", 1);
  assert.ok(Math.abs(f5.homeMeanRuns - 4) > Math.abs(full.homeMeanRuns - 4));
  assert.ok(f5.awayStarterExposure > full.awayStarterExposure);
});

test("nested selection is conservative when pitcher identities contain no reusable signal", () => {
  const rows: MlbHistoricalHorizonObservation[] = [];
  const games: MlbHistoricalStartingPitcherGame[] = [];
  for (let day = 1; day <= 8; day += 1) {
    const date = `2025-05-${String(day).padStart(2, "0")}`;
    rows.push(row(1000 + day, date, 4, 3));
    games.push(starterGame({
      gamePk: 1000 + day,
      date,
      homeStarterId: 10_000 + day,
      awayStarterId: 20_000 + day,
      homeRunsAllowed: 3,
      awayRunsAllowed: 4,
    }));
  }
  const selection = selectMlbPitcherHyperparametersNested(rows, games, {
    selectedTeamPriorGames: 20,
    pitcherPriorStartsGrid: [1, 4],
    betaGrid: [0, 1],
    innerValidationDateCount: 2,
    minimumInnerHistoryDates: 4,
  });
  assert.equal(selection.selectedBeta, 0);
  assert.equal(selection.selectedPriorStarts, 4, "ties prefer stronger shrinkage");
  assert.equal(selection.leakageFree, true);
  assert.ok(selection.innerHistoryMaxDate < selection.innerValidationMinDate);
});

test("full OOS report preserves block-level as-of boundary and exposes cold starts", () => {
  const observations: MlbHistoricalHorizonObservation[] = [];
  const games: MlbHistoricalStartingPitcherGame[] = [];
  for (let day = 1; day <= 12; day += 1) {
    const date = `2025-06-${String(day).padStart(2, "0")}`;
    const gamePk = 2000 + day;
    for (const horizon of ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"] as const) {
      observations.push(row(gamePk, date, horizon === "FIRST_INNING" ? 0 : 3, horizon === "FIRST_INNING" ? 0 : 2, horizon));
    }
    games.push(starterGame({
      gamePk,
      date,
      homeStarterId: day <= 6 ? 501 : 5000 + day,
      awayStarterId: day <= 6 ? 601 : 6000 + day,
      homeRunsAllowed: 2,
      awayRunsAllowed: 3,
    }));
  }
  const report = buildMlbStartingPitcherOosReport(observations, games, {
    minimumTrainingDates: 6,
    validationDateCount: 2,
    stepDateCount: 2,
    minimumTotalValidationGames: 2,
    teamPriorGamesGrid: [20],
    pitcherPriorStartsGrid: [2],
    betaGrid: [0, 0.5],
    innerValidationDateCount: 2,
    minimumInnerHistoryDates: 3,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(report.allFoldsLeakageFree, true);
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
  for (const horizon of report.horizons) {
    assert.ok(horizon.validationGames >= 2);
    assert.ok(horizon.coldStartStarterLines > 0);
    for (const fold of horizon.folds) {
      assert.ok(fold.trainingMaxDate < fold.validationMinDate);
      assert.ok(fold.pitcherNestedSelection.innerHistoryMaxDate < fold.pitcherNestedSelection.innerValidationMinDate);
    }
  }
});

test("game/date/team mismatch fails closed before fitting", () => {
  const observations = [row(3001, "2025-07-01", 4, 2)];
  const games = [starterGame({ gamePk: 3001, date: "2025-07-02", homeStarterId: 1, awayStarterId: 2 })];
  assert.throws(
    () => buildMlbStartingPitcherOosReport(observations, games, { minimumTrainingDates: 1, validationDateCount: 1, stepDateCount: 1 }),
    /STARTER_IDENTITY_MISMATCH/,
  );
});
