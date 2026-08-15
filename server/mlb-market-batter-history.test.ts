import assert from "node:assert/strict";
import test from "node:test";
import {
  digestMlbBatterHistory,
  parseMlbHistoricalBatterBoxscore,
} from "./mlb-market-batter-history";

const game = {
  gamePk: 999001,
  officialDate: "2026-08-01",
  homeTeamId: 10,
  awayTeamId: 20,
} as any;

function batterStats(overrides: Record<string, number> = {}) {
  return {
    atBats: 4,
    runs: 1,
    hits: 2,
    doubles: 1,
    triples: 0,
    homeRuns: 0,
    rbi: 1,
    baseOnBalls: 1,
    strikeOuts: 1,
    plateAppearances: 5,
    totalBases: 3,
    stolenBases: 0,
    caughtStealing: 0,
    intentionalWalks: 0,
    hitByPitch: 0,
    sacBunts: 0,
    sacFlies: 0,
    groundIntoDoublePlay: 0,
    leftOnBase: 1,
    ...overrides,
  };
}

function teamBox(teamId: number, batterId: number, batterName: string, stats = batterStats()) {
  return {
    team: { id: teamId },
    batters: [batterId],
    players: {
      [`ID${batterId}`]: {
        person: { id: batterId, fullName: batterName },
        battingOrder: "100",
        stats: { batting: { ...stats } },
      },
    },
    teamStats: { batting: { ...stats } },
  };
}

function boxscore() {
  return {
    teams: {
      home: teamBox(10, 101, "Home Batter"),
      away: teamBox(20, 202, "Away Batter", batterStats({ hits: 1, doubles: 0, totalBases: 1, runs: 0, rbi: 0 })),
    },
  };
}

test("parses direct batter outcomes and labels deterministic derived fields", () => {
  const parsed = parseMlbHistoricalBatterBoxscore(game, boxscore());
  assert.equal(parsed.homeBatters.length, 1);
  assert.equal(parsed.awayBatters.length, 1);
  const home = parsed.homeBatters[0];
  assert.equal(home.batterId, 101);
  assert.equal(home.hits, 2);
  assert.equal(home.totalBases, 3);
  assert.equal(home.singlesDerived, 1);
  assert.equal(home.hitsRunsRbisDerived, 4);
  assert.match(parsed.boxscoreSourceDigest, /^[a-f0-9]{64}$/);
});

test("excludes MLB roster participants with completely empty batting payloads", () => {
  const source = boxscore();
  source.teams.home.batters.push(303);
  source.teams.home.players.ID303 = {
    person: { id: 303, fullName: "Pitcher Without Batting Line" },
    battingOrder: null,
    stats: { batting: {} },
  };
  const parsed = parseMlbHistoricalBatterBoxscore(game, source);
  assert.deepEqual(parsed.homeBatters.map((line) => line.batterId), [101]);
  assert.equal(parsed.homeBatters[0].atBats, 4);
});

test("history digest is deterministic regardless of game input order", () => {
  const first = parseMlbHistoricalBatterBoxscore(game, boxscore());
  const second = parseMlbHistoricalBatterBoxscore({ ...game, gamePk: 999002, officialDate: "2026-08-02" }, boxscore());
  assert.equal(digestMlbBatterHistory([first, second]), digestMlbBatterHistory([second, first]));
});

test("fails closed when direct total bases violates arithmetic custody", () => {
  const bad = boxscore();
  bad.teams.home.players.ID101.stats.batting.totalBases = 4;
  assert.throws(() => parseMlbHistoricalBatterBoxscore(game, bad), /BATTER_HISTORY_TOTAL_BASES_MISMATCH/);
});

test("fails closed when player sums do not reconcile to official team batting totals", () => {
  const bad = boxscore();
  bad.teams.home.teamStats.batting.hits = 3;
  assert.throws(() => parseMlbHistoricalBatterBoxscore(game, bad), /BATTER_HISTORY_TEAM_RECONCILIATION_MISMATCH:home:hits/);
});

test("fails closed on team identity mismatch", () => {
  const bad = boxscore();
  bad.teams.home.team.id = 11;
  assert.throws(() => parseMlbHistoricalBatterBoxscore(game, bad), /BATTER_HISTORY_TEAM_ID_MISMATCH:home/);
});
