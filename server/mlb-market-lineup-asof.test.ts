import test from "node:test";
import assert from "node:assert/strict";
import {
  MLB_P1_M6A3B1_DATASET_SCHEMA,
  MLB_P1_M6A3B1_SOURCE,
  type MlbHistoricalHorizonObservation,
} from "./mlb-market-historical-dataset";
import {
  MLB_P1_M6A3B2C1_SOURCE_VERSION,
  type MlbHistoricalPregameLineupSnapshot,
} from "./mlb-market-pregame-lineup-history";
import { buildMlbTeamStrengthSnapshot, predictMlbTeamRunMeans } from "./mlb-market-team-strength";
import {
  buildMlbLineupAsOfSnapshot,
  buildMlbLineupOosReport,
  predictMlbTeamPlusLineupRunMeans,
  selectMlbLineupHyperparametersNested,
} from "./mlb-market-lineup-asof";

function dateAt(index: number): string {
  return `2025-04-${String(index + 1).padStart(2, "0")}`;
}

function row(index: number, horizon: "FIRST_5" = "FIRST_5"): MlbHistoricalHorizonObservation {
  const homeRuns = [1, 4, 2, 6, 3, 5, 1, 7, 2, 5, 3, 6, 2, 4][index % 14];
  const awayRuns = [3, 1, 5, 2, 4, 1, 6, 2, 4, 3, 5, 2, 1, 5][index % 14];
  return {
    schemaVersion: MLB_P1_M6A3B1_DATASET_SCHEMA,
    source: MLB_P1_M6A3B1_SOURCE,
    gamePk: 900000 + index,
    officialDate: dateAt(index),
    season: 2025,
    horizon,
    homeTeamId: index % 2 === 0 ? 101 : 102,
    homeTeam: index % 2 === 0 ? "Home A" : "Home B",
    awayTeamId: index % 2 === 0 ? 102 : 101,
    awayTeam: index % 2 === 0 ? "Away B" : "Away A",
    homeRuns,
    awayRuns,
    totalRuns: homeRuns + awayRuns,
    homeMinusAway: homeRuns - awayRuns,
    nrfi: null,
    sourceVersion: "synthetic",
    sourceDigest: `outcome-${index}`,
  };
}

function order(seed: number): number[] {
  return Array.from({ length: 9 }, (_, index) => seed + index);
}

function lineup(index: number, options: {
  complete?: boolean;
  homeTeamId?: number;
  home?: number[];
  away?: number[];
} = {}): MlbHistoricalPregameLineupSnapshot {
  const target = row(index);
  const complete = options.complete ?? true;
  return {
    sourceVersion: MLB_P1_M6A3B2C1_SOURCE_VERSION,
    gamePk: target.gamePk,
    officialDate: target.officialDate,
    scheduledStart: `${target.officialDate}T19:10:00.000Z`,
    scheduleResolution: "DIRECT",
    cutoffAt: `${target.officialDate}T19:05:00.000Z`,
    requestedTimecode: target.officialDate.replaceAll("-", "") + "_190500",
    sourceMetadataTimecode: target.officialDate.replaceAll("-", "") + "_190459",
    homeTeamId: options.homeTeamId ?? target.homeTeamId,
    awayTeamId: target.awayTeamId,
    gameState: { abstractGameState: "Preview", codedGameState: "P", detailedState: "Pre-Game" },
    homeBattingOrder: options.home ?? order(1000 + (index % 2) * 100),
    awayBattingOrder: options.away ?? order(1100 - (index % 2) * 100),
    availability: complete ? "COMPLETE" : "BOTH_INCOMPLETE",
    complete,
    sourceDigest: `lineup-${index}`,
  };
}

const rows = Array.from({ length: 14 }, (_, index) => row(index));
const lineups = Array.from({ length: 14 }, (_, index) => lineup(index));

test("lineup as-of snapshot uses only certified history strictly before the cutoff", () => {
  const snapshot = buildMlbLineupAsOfSnapshot(rows, lineups, dateAt(8), 10, 10);
  assert.equal(snapshot.cutoffDateExclusive, dateAt(8));
  assert.equal(snapshot.eligibleOutcomeGames, 8);
  assert.equal(snapshot.eligibleLineupGames, 8);
  assert.equal(snapshot.historyMaxDate, dateAt(7));
  assert.ok(snapshot.historyMaxDate < snapshot.cutoffDateExclusive);
  assert.ok(Object.keys(snapshot.players).length >= 18);
  assert.ok(Object.values(snapshot.players).every((player) => player.historyMaxDate < dateAt(8)));
});

test("uncertified historical lineup is missing evidence and is never fabricated", () => {
  const history = lineups.map((value, index) => index === 3 ? lineup(index, { complete: false, home: [], away: [] }) : value);
  const snapshot = buildMlbLineupAsOfSnapshot(rows, history, dateAt(8), 10, 10);
  assert.equal(snapshot.eligibleOutcomeGames, 8);
  assert.equal(snapshot.eligibleLineupGames, 7);
});

test("lineup weight zero reproduces team-only means exactly", () => {
  const historyRows = rows.slice(0, 8);
  const teamSnapshot = buildMlbTeamStrengthSnapshot(historyRows, 10);
  const lineupSnapshot = buildMlbLineupAsOfSnapshot(rows, lineups, dateAt(8), 10, 10);
  const targetRow = rows[8];
  const teamPrediction = predictMlbTeamRunMeans(teamSnapshot, targetRow);
  const prediction = predictMlbTeamPlusLineupRunMeans(teamPrediction, lineupSnapshot, lineups[8], 0);
  assert.equal(prediction.homeMeanRuns, teamPrediction.homeMeanRuns);
  assert.equal(prediction.awayMeanRuns, teamPrediction.awayMeanRuns);
});

test("unseen target batters are neutral rather than assigned future information", () => {
  const historyRows = rows.slice(0, 8);
  const teamSnapshot = buildMlbTeamStrengthSnapshot(historyRows, 10);
  const lineupSnapshot = buildMlbLineupAsOfSnapshot(rows, lineups, dateAt(8), 10, 10);
  const targetRow = rows[8];
  const target = lineup(8, { home: order(5000), away: order(6000) });
  const teamPrediction = predictMlbTeamRunMeans(teamSnapshot, targetRow);
  const prediction = predictMlbTeamPlusLineupRunMeans(teamPrediction, lineupSnapshot, target, 1);
  assert.equal(prediction.homeSeenBatters, 0);
  assert.equal(prediction.awaySeenBatters, 0);
  assert.equal(prediction.homeLineupFactor, 1);
  assert.equal(prediction.awayLineupFactor, 1);
  assert.equal(prediction.homeMeanRuns, teamPrediction.homeMeanRuns);
  assert.equal(prediction.awayMeanRuns, teamPrediction.awayMeanRuns);
});

test("target lineup identity drift fails closed", () => {
  const drift = lineups.map((value, index) => index === 8 ? lineup(index, { homeTeamId: 999 }) : value);
  assert.throws(
    () => buildMlbLineupOosReport(rows, drift, {
      minimumTrainingDates: 8,
      validationDateCount: 2,
      stepDateCount: 2,
      minimumTotalValidationGames: 1,
      teamPriorGamesGrid: [10],
      playerPriorGamesGrid: [10],
      lineupEffectWeightGrid: [0],
      innerValidationDateCount: 2,
      minimumInnerHistoryDates: 4,
    }),
    /LINEUP_IDENTITY_MISMATCH/,
  );
});

test("nested selection is leakage-free and may choose no lineup effect", () => {
  const selection = selectMlbLineupHyperparametersNested(rows.slice(0, 10), lineups, {
    teamPriorGamesGrid: [10],
    playerPriorGamesGrid: [10],
    lineupEffectWeightGrid: [0],
    innerValidationDateCount: 2,
    minimumInnerHistoryDates: 4,
  });
  assert.equal(selection.selectedLineupEffectWeight, 0);
  assert.equal(selection.leakageFree, true);
  assert.ok(selection.innerHistoryMaxDate < selection.innerValidationMinDate);
  assert.ok(selection.lineupSnapshotHistoryMaxDate < selection.innerValidationMinDate);
});

test("OOS report pairs team and lineup on the same certified validation games and excludes missing lineups", () => {
  const history = lineups.map((value, index) => index === 9 ? lineup(index, { complete: false, home: [], away: [] }) : value);
  const report = buildMlbLineupOosReport(rows, history, {
    minimumTrainingDates: 8,
    validationDateCount: 2,
    stepDateCount: 2,
    minimumTotalValidationGames: 1,
    teamPriorGamesGrid: [10],
    playerPriorGamesGrid: [10],
    lineupEffectWeightGrid: [0],
    innerValidationDateCount: 2,
    minimumInnerHistoryDates: 4,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  const first5 = report.horizons.find((entry) => entry.horizon === "FIRST_5");
  assert.ok(first5);
  assert.equal(report.allFoldsLeakageFree, true);
  assert.equal(first5.validationGamesExcludedForLineup, 1);
  assert.ok(first5.validationGames > 0);
  assert.equal(first5.pairedRows.length, first5.validationGames);
  assert.ok(first5.pairedRows.every((paired) => Math.abs(paired.teamMinusLineupCountNll) < 2e-7));
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
});

test("duplicate lineup game identity fails closed", () => {
  assert.throws(
    () => buildMlbLineupAsOfSnapshot(rows, [...lineups, lineups[0]], dateAt(8), 10, 10),
    /DUPLICATE_LINEUP_GAME/,
  );
});
