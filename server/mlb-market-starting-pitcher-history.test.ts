import test from "node:test";
import assert from "node:assert/strict";
import {
  digestMlbStartingPitcherBoxscoreProvenance,
  digestMlbStartingPitcherHistory,
  mlbInningsPitchedToOuts,
  parseMlbHistoricalStartingPitcherBoxscore,
} from "./mlb-market-starting-pitcher-history";
import type { MlbHistoricalOfficialGame } from "./mlb-market-historical-dataset";

function officialGame(overrides: Partial<MlbHistoricalOfficialGame> = {}): MlbHistoricalOfficialGame {
  return {
    gamePk: 700001,
    officialDate: "2025-06-01",
    season: 2025,
    gameType: "R",
    finalState: "Final",
    homeTeamId: 10,
    homeTeam: "Home",
    awayTeamId: 20,
    awayTeam: "Away",
    homeFinalRuns: 4,
    awayFinalRuns: 2,
    innings: [
      { num: 1, awayRuns: 0, homeRuns: 1 },
      { num: 2, awayRuns: 0, homeRuns: 0 },
      { num: 3, awayRuns: 1, homeRuns: 0 },
      { num: 4, awayRuns: 0, homeRuns: 2 },
      { num: 5, awayRuns: 0, homeRuns: 0 },
      { num: 6, awayRuns: 1, homeRuns: 1 },
    ],
    sourceVersion: "fixture.v1",
    sourceDigest: "a".repeat(64),
    ...overrides,
  };
}

function pitchingLine(overrides: Record<string, unknown> = {}) {
  return {
    gamesStarted: 1,
    inningsPitched: "5.2",
    battersFaced: 23,
    runs: 2,
    earnedRuns: 2,
    hits: 5,
    baseOnBalls: 2,
    strikeOuts: 7,
    homeRuns: 1,
    hitByPitch: 0,
    numberOfPitches: 91,
    strikes: 61,
    ...overrides,
  };
}

function boxscore(options: { explicitStarterFlags?: boolean; conflict?: boolean } = {}) {
  const explicit = options.explicitStarterFlags ?? true;
  const awayStarterId = 101;
  const homeStarterId = 201;
  const awayFlagId = options.conflict ? 102 : awayStarterId;
  return {
    teams: {
      away: {
        team: { id: 20, name: "Away" },
        pitchers: [awayStarterId, 103],
        players: {
          [`ID${awayStarterId}`]: {
            person: { id: awayStarterId, fullName: "Away Starter" },
            stats: { pitching: pitchingLine({ gamesStarted: explicit && awayFlagId === awayStarterId ? 1 : 0 }) },
          },
          ID102: {
            person: { id: 102, fullName: "Conflict Starter" },
            stats: { pitching: pitchingLine({ gamesStarted: explicit && awayFlagId === 102 ? 1 : 0, inningsPitched: "0.1" }) },
          },
          ID103: {
            person: { id: 103, fullName: "Away Reliever" },
            stats: { pitching: pitchingLine({ gamesStarted: 0, inningsPitched: "3.1" }) },
          },
        },
      },
      home: {
        team: { id: 10, name: "Home" },
        pitchers: [homeStarterId, 203],
        players: {
          [`ID${homeStarterId}`]: {
            person: { id: homeStarterId, fullName: "Home Starter" },
            stats: { pitching: pitchingLine({ gamesStarted: explicit ? 1 : 0, inningsPitched: "6.0", earnedRuns: 1, runs: 1 }) },
          },
          ID203: {
            person: { id: 203, fullName: "Home Reliever" },
            stats: { pitching: pitchingLine({ gamesStarted: 0, inningsPitched: "3.0" }) },
          },
        },
      },
    },
  };
}

test("baseball innings-pitched notation converts to outs without decimal error", () => {
  assert.equal(mlbInningsPitchedToOuts("0.0"), 0);
  assert.equal(mlbInningsPitchedToOuts("5.2"), 17);
  assert.equal(mlbInningsPitchedToOuts("7.1"), 22);
  assert.throws(() => mlbInningsPitchedToOuts("5.3"), /INVALID_INNINGS_PITCHED/);
  assert.throws(() => mlbInningsPitchedToOuts("5.67"), /INVALID_INNINGS_PITCHED/);
});

test("explicit gamesStarted flag must agree with first pitcher in official pitching order", () => {
  const parsed = parseMlbHistoricalStartingPitcherBoxscore(officialGame(), boxscore());
  assert.equal(parsed.awayStarter.pitcherId, 101);
  assert.equal(parsed.homeStarter.pitcherId, 201);
  assert.equal(parsed.awayStarter.identityMethod, "GAME_STARTED_FLAG_AND_ORDER");
  assert.equal(parsed.homeStarter.identityMethod, "GAME_STARTED_FLAG_AND_ORDER");
  assert.equal(parsed.awayStarter.outsRecorded, 17);
  assert.equal(parsed.homeStarter.outsRecorded, 18);
  assert.equal(parsed.awayStarter.strikeOuts, 7);
  assert.match(parsed.boxscoreSourceDigest, /^[a-f0-9]{64}$/);
});

test("falls back to official pitching order only when game-started flag is absent", () => {
  const parsed = parseMlbHistoricalStartingPitcherBoxscore(
    officialGame(),
    boxscore({ explicitStarterFlags: false }),
  );
  assert.equal(parsed.awayStarter.pitcherId, 101);
  assert.equal(parsed.homeStarter.pitcherId, 201);
  assert.equal(parsed.awayStarter.identityMethod, "PITCHING_ORDER_FIRST");
  assert.equal(parsed.homeStarter.identityMethod, "PITCHING_ORDER_FIRST");
});

test("starter identity disagreement fails closed", () => {
  assert.throws(
    () => parseMlbHistoricalStartingPitcherBoxscore(officialGame(), boxscore({ conflict: true })),
    /STARTER_ORDER_CONFLICT:away/,
  );
});

test("team identity mismatch and malformed starter line fail closed", () => {
  const wrongTeam = boxscore();
  wrongTeam.teams.home.team.id = 999;
  assert.throws(() => parseMlbHistoricalStartingPitcherBoxscore(officialGame(), wrongTeam), /TEAM_ID_MISMATCH:home/);

  const malformed = boxscore();
  malformed.teams.away.players.ID101.stats.pitching.inningsPitched = "4.8";
  assert.throws(() => parseMlbHistoricalStartingPitcherBoxscore(officialGame(), malformed), /INVALID_INNINGS_PITCHED/);
});

test("starter-history digest is deterministic and sports-stat sensitive", () => {
  const parsed = parseMlbHistoricalStartingPitcherBoxscore(officialGame(), boxscore());
  const same = { ...parsed, boxscoreSourceDigest: "f".repeat(64) };
  assert.equal(digestMlbStartingPitcherHistory([parsed]), digestMlbStartingPitcherHistory([same]));
  assert.notEqual(
    digestMlbStartingPitcherBoxscoreProvenance([parsed]),
    digestMlbStartingPitcherBoxscoreProvenance([same]),
  );

  const changed = {
    ...parsed,
    awayStarter: { ...parsed.awayStarter, earnedRuns: parsed.awayStarter.earnedRuns + 1 },
  };
  assert.notEqual(digestMlbStartingPitcherHistory([parsed]), digestMlbStartingPitcherHistory([changed]));
});

test("pitcher display-name correction does not redefine statistical history identity", () => {
  const parsed = parseMlbHistoricalStartingPitcherBoxscore(officialGame(), boxscore());
  const renamed = {
    ...parsed,
    homeStarter: { ...parsed.homeStarter, pitcherName: "Corrected Display Name" },
  };
  assert.equal(digestMlbStartingPitcherHistory([parsed]), digestMlbStartingPitcherHistory([renamed]));
});
