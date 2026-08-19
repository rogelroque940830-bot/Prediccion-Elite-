import assert from "node:assert/strict";
import { test } from "node:test";
import { MlbC4CertifiedMaterializer } from "../server/mlb-c4-certified-materializer";
import { MlbV15BullpenD1Materializer } from "../server/mlb-v15-bullpen-d1-materializer";
import { getBullpenStatus, resetMlbBullpenCachesForTests } from "../server/mlb-bullpen";
import type { MlbP1SlateGame } from "../server/mlb-p1-daily-slate";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function finalFeed(input: {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeStarterId: number;
  awayStarterId: number;
  homeLineup: number[];
  awayLineup: number[];
}): any {
  const pitcherStats = {
    battersFaced: 24,
    strikeOuts: 6,
    baseOnBalls: 2,
    earnedRuns: 2,
    homeRuns: 1,
  };
  return {
    gamePk: input.gamePk,
    gameData: {
      game: { pk: input.gamePk },
      datetime: { officialDate: input.officialDate },
      status: { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" },
      teams: { home: { id: input.homeTeamId }, away: { id: input.awayTeamId } },
      probablePitchers: { home: { id: input.homeStarterId }, away: { id: input.awayStarterId } },
    },
    liveData: {
      linescore: { teams: { home: { runs: 4 }, away: { runs: 3 } } },
      boxscore: {
        teams: {
          home: {
            team: { id: input.homeTeamId },
            battingOrder: input.homeLineup,
            pitchers: [input.homeStarterId],
            players: { [`ID${input.homeStarterId}`]: { stats: { pitching: pitcherStats } } },
          },
          away: {
            team: { id: input.awayTeamId },
            battingOrder: input.awayLineup,
            pitchers: [input.awayStarterId],
            players: { [`ID${input.awayStarterId}`]: { stats: { pitching: pitcherStats } } },
          },
        },
      },
    },
  };
}

test("C4 quarantines schedule-final rows whose live feed is not final", async () => {
  const targetPk = 9000;
  const validPk = 8000;
  const stalePk = 8001;
  const homeLineup = [101, 102, 103, 104, 105, 106, 107, 108, 109];
  const awayLineup = [201, 202, 203, 204, 205, 206, 207, 208, 209];
  const valid = finalFeed({
    gamePk: validPk,
    officialDate: "2026-08-18",
    homeTeamId: 1,
    awayTeamId: 2,
    homeStarterId: 301,
    awayStarterId: 401,
    homeLineup,
    awayLineup,
  });
  const target = finalFeed({
    gamePk: targetPk,
    officialDate: "2026-08-19",
    homeTeamId: 1,
    awayTeamId: 2,
    homeStarterId: 301,
    awayStarterId: 401,
    homeLineup,
    awayLineup,
  });
  target.gameData.status = { abstractGameState: "Preview", detailedState: "Pre-Game", codedGameState: "P" };
  const stale = {
    gamePk: stalePk,
    gameData: {
      game: { pk: stalePk },
      datetime: { officialDate: "2026-08-17" },
      status: { abstractGameState: "Preview", detailedState: "Scheduled", codedGameState: "S" },
    },
  };

  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("/v1/schedule?")) {
      return jsonResponse({
        dates: [
          {
            date: "2026-08-17",
            games: [{ gamePk: stalePk, officialDate: "2026-08-17", status: { abstractGameState: "Final" } }],
          },
          {
            date: "2026-08-18",
            games: [{ gamePk: validPk, officialDate: "2026-08-18", status: { abstractGameState: "Final" } }],
          },
        ],
      });
    }
    if (url.includes(`/game/${validPk}/feed/live`)) return jsonResponse(valid);
    if (url.includes(`/game/${stalePk}/feed/live`)) return jsonResponse(stale);
    if (url.includes(`/game/${targetPk}/feed/live`)) return jsonResponse(target);
    throw new Error(`unexpected URL: ${url}`);
  };

  const game: MlbP1SlateGame = {
    gamePk: targetPk,
    startTime: "2026-08-19T23:00:00.000Z",
    officialDate: "2026-08-19",
    venue: "Test Park",
    state: "PREGAME",
    detailedState: "Pre-Game",
    homeTeam: { id: 1, name: "Home" },
    awayTeam: { id: 2, name: "Away" },
    homePitcher: { id: 301, name: "Home SP", hand: "R", confirmed: true },
    awayPitcher: { id: 401, name: "Away SP", hand: "L", confirmed: true },
    lineupState: "CONFIRMED",
    homeLineupCount: 9,
    awayLineupCount: 9,
    readiness: "READY_TO_ANALYZE",
    analysisStage: "FINAL",
    analysisAllowed: true,
    blockers: [],
    source: { name: "MLB_STATS_API", fetchedAt: "2026-08-19T20:00:00.000Z", quality: "AUTHORITATIVE" },
  };

  const materializer = new MlbC4CertifiedMaterializer({ fetchImpl, apiBaseUrl: "https://mlb.test/api" });
  const input = await materializer.materializeFull13PregameInput(game);
  assert.equal(input.homeTeamHistory.length, 1);
  assert.equal(input.awayTeamHistory.length, 1);
  assert.equal(input.leagueStarterHistory.length, 2);
  assert.equal(input.homeTeamHistory[0]?.gamePk, validPk);
});

function v15Boxscore(gamePk: number, missingHomePitchCount = false): any {
  const homeReliever = 6000 + gamePk;
  const awayReliever = 7000 + gamePk;
  return {
    teams: {
      home: {
        team: { id: 1 },
        pitchers: [5001, homeReliever],
        players: {
          [`ID${homeReliever}`]: { stats: { pitching: missingHomePitchCount ? { battersFaced: 4, inningsPitched: "1.0" } : { pitchesThrown: 11 } } },
        },
      },
      away: {
        team: { id: 2 },
        pitchers: [5002, awayReliever],
        players: {
          [`ID${awayReliever}`]: { stats: { pitching: { pitchesThrown: 13 } } },
        },
      },
    },
  };
}

test("V15 recovers a missing boxscore pitch count from the official live feed", async () => {
  const priorGames = [
    { gamePk: 1001, date: "2026-08-16" },
    { gamePk: 1002, date: "2026-08-17" },
    { gamePk: 1003, date: "2026-08-18" },
  ];
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("/schedule?")) {
      return jsonResponse({
        dates: priorGames.map((game) => ({
          date: game.date,
          games: [{ gamePk: game.gamePk, status: { abstractGameState: "Final", codedGameState: "F" } }],
        })),
      });
    }
    const boxscoreMatch = url.match(/\/game\/(\d+)\/boxscore/);
    if (boxscoreMatch) {
      const gamePk = Number(boxscoreMatch[1]);
      return jsonResponse(v15Boxscore(gamePk, gamePk === 1003));
    }
    const feedMatch = url.match(/\/game\/(\d+)\/feed\/live/);
    if (feedMatch) {
      const gamePk = Number(feedMatch[1]);
      const homeReliever = 6000 + gamePk;
      return jsonResponse({
        liveData: {
          boxscore: {
            teams: {
              home: { players: { [`ID${homeReliever}`]: { stats: { pitching: { pitchesThrown: 17 } } } } },
              away: { players: {} },
            },
          },
          plays: { allPlays: [] },
        },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const materializer = new MlbV15BullpenD1Materializer({
    fetchImpl,
    apiBaseUrl: "https://mlb.test/api/v1",
  });
  const evidence = await materializer.assessGame({
    gamePk: 2000,
    officialDate: "2026-08-19",
    homeTeamId: 1,
    awayTeamId: 2,
    now: new Date("2026-08-19T20:00:00.000Z"),
  });
  assert.equal(evidence.eligible, true);
  assert.equal(evidence.home.pitches1d, 17);
  assert.equal(evidence.away.pitches1d, 13);
  assert.equal(evidence.bullpenPitches1dAdv, -4);
});

test("bullpen role evidence uses an official career fallback when both season lines are absent", async () => {
  resetMlbBullpenCachesForTests();
  const roster = [
    { person: { id: 11, fullName: "Closer" }, position: { code: "1" } },
    { person: { id: 12, fullName: "Setup" }, position: { code: "1" } },
    { person: { id: 13, fullName: "Veteran Return" }, position: { code: "1" } },
  ];
  const seasonStats: Record<number, any> = {
    11: { saves: 20, holds: 0, gamesPlayed: 40, inningsPitched: "39.0", era: "2.50", whip: "1.00", strikeoutsPer9Inn: "10.0", gamesStarted: 0 },
    12: { saves: 1, holds: 12, gamesPlayed: 35, inningsPitched: "34.0", era: "3.00", whip: "1.10", strikeoutsPer9Inn: "9.0", gamesStarted: 0 },
  };
  const careerStats = { saves: 0, holds: 5, gamesPlayed: 60, inningsPitched: "70.0", era: "3.80", whip: "1.25", strikeoutsPer9Inn: "8.0", gamesStarted: 0 };

  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("/roster?rosterType=Active")) return jsonResponse({ roster });
    const seasonMatch = url.match(/\/people\/(\d+)\/stats\?stats=season&group=pitching&season=(\d+)/);
    if (seasonMatch) {
      const pitcherId = Number(seasonMatch[1]);
      const stat = seasonStats[pitcherId] ?? null;
      return jsonResponse(stat ? { stats: [{ splits: [{ stat }] }] } : { stats: [{ splits: [] }] });
    }
    const careerMatch = url.match(/\/people\/(\d+)\/stats\?stats=career&group=pitching/);
    if (careerMatch) {
      const pitcherId = Number(careerMatch[1]);
      return jsonResponse(pitcherId === 13 ? { stats: [{ splits: [{ stat: careerStats }] }] } : { stats: [{ splits: [] }] });
    }
    if (url.includes("/schedule?")) return jsonResponse({ dates: [] });
    throw new Error(`unexpected URL: ${url}`);
  };

  const status = await getBullpenStatus(1, "Test Team", {
    fetchImpl,
    now: () => new Date("2026-08-19T20:00:00.000Z"),
  });
  assert.equal(status.sourceStatus, "CERTIFIED");
  assert.equal(status.provenance.seasonStats.source, "MLB_STATS_SEASON_WITH_PRIOR_AND_CAREER_FALLBACK");
  assert.equal(status.provenance.seasonStats.currentSeasonLines, 2);
  assert.equal(status.provenance.seasonStats.previousSeasonFallbacks, 0);
  assert.equal(status.provenance.seasonStats.careerFallbacks, 1);
  assert.equal(status.provenance.seasonStats.pitchersVerified, 3);
  resetMlbBullpenCachesForTests();
});
