import assert from "node:assert/strict";
import test from "node:test";
import { buildC4LiveFeatures, C4_STARTER_SHRINKAGE_PRIOR_BF } from "./mlb-c4-live-feature-builder";

const date = "2026-08-13";

function teamGames(teamBasePk: number, rows: Array<[string, number, number]>) {
  return rows.map(([officialDate, runsFor, runsAgainst], i) => ({
    officialDate,
    gamePk: teamBasePk + i,
    runsFor,
    runsAgainst,
  }));
}

function pitcher(officialDate: string, gamePk: number, pitcherId: number, bf: number, k: number, bb: number) {
  return { officialDate, gamePk, pitcherId, battersFaced: bf, strikeOuts: k, baseOnBalls: bb };
}

function lineup(officialDate: string, gamePk: number, battingOrder: number[]) {
  return { officialDate, gamePk, battingOrder };
}

test("reproduces the frozen C4 formulas without any market input", () => {
  const homeHistory = teamGames(100, [
    ["2026-08-01", 5, 2], ["2026-08-02", 4, 3], ["2026-08-03", 6, 1],
    ["2026-08-04", 2, 5], ["2026-08-05", 8, 4], ["2026-08-06", 3, 2],
  ]);
  const awayHistory = teamGames(200, [
    ["2026-08-01", 2, 4], ["2026-08-02", 3, 5], ["2026-08-03", 1, 2],
    ["2026-08-04", 5, 3], ["2026-08-05", 4, 6], ["2026-08-06", 2, 1],
  ]);
  const league = [
    pitcher("2026-08-01", 300, 10, 20, 5, 1),
    pitcher("2026-08-02", 301, 11, 30, 6, 3),
  ];
  const homeStarterHistory = [pitcher("2026-08-03", 302, 50, 25, 8, 2)];
  const awayStarterHistory = [pitcher("2026-08-03", 303, 60, 25, 4, 3)];
  const homeOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const awayOrder = [11, 12, 13, 14, 15, 16, 17, 18, 19];
  const result = buildC4LiveFeatures({
    officialDate: date,
    gamePk: 999,
    homeTeamId: 1,
    awayTeamId: 2,
    homeTeamHistory: homeHistory,
    awayTeamHistory: awayHistory,
    leagueStarterHistory: league,
    homeStarterHistory,
    awayStarterHistory,
    homeStarterId: 50,
    awayStarterId: 60,
    homePriorLineups: [
      lineup("2026-08-01", 100, homeOrder),
      lineup("2026-08-02", 101, [1, 2, 3, 4, 5, 6, 7, 8, 20]),
    ],
    awayPriorLineups: [lineup("2026-08-01", 200, awayOrder)],
    homeBattingOrder: homeOrder,
    awayBattingOrder: awayOrder,
  });

  const homeRs = (5 + 4 + 6 + 2 + 8 + 3) / 6;
  const awayRs = (2 + 3 + 1 + 5 + 4 + 2) / 6;
  const homeRd = ((5 - 2) + (4 - 3) + (6 - 1) + (2 - 5) + (8 - 4) + (3 - 2)) / 6;
  const awayRd = ((2 - 4) + (3 - 5) + (1 - 2) + (5 - 3) + (4 - 6) + (2 - 1)) / 6;
  assert.equal(result.featureVector.combined_team_rs10, homeRs + awayRs);
  assert.equal(result.featureVector.team_rd10_diff, homeRd - awayRd);

  const leagueKbb = ((5 - 1) + (6 - 3)) / 50;
  const homeKbb = ((8 - 2) + C4_STARTER_SHRINKAGE_PRIOR_BF * leagueKbb) / (25 + C4_STARTER_SHRINKAGE_PRIOR_BF);
  const awayKbb = ((4 - 3) + C4_STARTER_SHRINKAGE_PRIOR_BF * leagueKbb) / (25 + C4_STARTER_SHRINKAGE_PRIOR_BF);
  assert.equal(result.featureVector.starter_kbb_adv, homeKbb - awayKbb);

  const expectedHomeExposure = ((2 / 6) * 8 + 1 / 6) / 9;
  const expectedAwayExposure = ((1 / 6) * 9) / 9;
  assert.equal(result.featureVector.lineup_exposure_rate_adv, expectedHomeExposure - expectedAwayExposure);
  assert.equal(result.priceIndependent, true);
  assert.equal(result.sameDateHistoryAllowed, false);
});

test("fails closed if any history row is from the target date", () => {
  assert.throws(
    () => buildC4LiveFeatures({
      officialDate: date,
      gamePk: 999,
      homeTeamId: 1,
      awayTeamId: 2,
      homeTeamHistory: [{ officialDate: date, gamePk: 1, runsFor: 1, runsAgainst: 0 }],
      awayTeamHistory: [],
      leagueStarterHistory: [],
      homeStarterHistory: [],
      awayStarterHistory: [],
      homeStarterId: null,
      awayStarterId: null,
      homePriorLineups: [],
      awayPriorLineups: [],
      homeBattingOrder: null,
      awayBattingOrder: null,
    }),
    /C4_HISTORY_NOT_STRICTLY_PREGAME/,
  );
});

test("fails closed on cross-season history", () => {
  assert.throws(
    () => buildC4LiveFeatures({
      officialDate: date,
      gamePk: 999,
      homeTeamId: 1,
      awayTeamId: 2,
      homeTeamHistory: [{ officialDate: "2025-09-28", gamePk: 1, runsFor: 1, runsAgainst: 0 }],
      awayTeamHistory: [],
      leagueStarterHistory: [],
      homeStarterHistory: [],
      awayStarterHistory: [],
      homeStarterId: null,
      awayStarterId: null,
      homePriorLineups: [],
      awayPriorLineups: [],
      homeBattingOrder: null,
      awayBattingOrder: null,
    }),
    /C4_CROSS_SEASON_HISTORY_FORBIDDEN/,
  );
});
