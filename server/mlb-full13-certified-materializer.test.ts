import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  MLB_FROZEN_CLASSIFIER_FEATURE_NAMES,
  classifyMlbFrozenAPlusAndF5,
} from "./mlb-frozen-a-plus-classifier";
import { MLB_FULL13_FEATURE_NAMES } from "./mlb-full13-live-feature-builder";

const TARGET_GAME_PK = 998001;
const TARGET_DATE = "2026-05-10";
const HOME_TEAM_ID = 31;
const AWAY_TEAM_ID = 42;
const HOME_STARTER_ID = 9301;
const AWAY_STARTER_ID = 9302;
const HOME_ORDER = Array.from({ length: 9 }, (_, index) => 1101 + index);
const AWAY_ORDER = Array.from({ length: 9 }, (_, index) => 2101 + index);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function pitcherPlayer(input: {
  pitcherId: number;
  strikeOuts: number;
  baseOnBalls: number;
  battersFaced?: number;
  earnedRuns?: number;
  homeRuns?: number;
}) {
  return {
    [`ID${input.pitcherId}`]: {
      stats: {
        pitching: {
          strikeOuts: input.strikeOuts,
          baseOnBalls: input.baseOnBalls,
          battersFaced: input.battersFaced ?? 21,
          earnedRuns: input.earnedRuns ?? 2,
          homeRuns: input.homeRuns ?? 1,
        },
      },
    },
  };
}

function historicalFeed(input: {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeRuns: number;
  awayRuns: number;
  homeStarterId: number;
  awayStarterId: number;
  homeOrder: number[];
  awayOrder: number[];
  homeEr?: number;
  awayEr?: number;
  homeHr?: number;
  awayHr?: number;
}) {
  return {
    gamePk: input.gamePk,
    gameData: {
      game: { pk: input.gamePk },
      datetime: { officialDate: input.officialDate },
      status: { abstractGameState: "Final", detailedState: "Final" },
      teams: {
        home: { id: input.homeTeamId },
        away: { id: input.awayTeamId },
      },
    },
    liveData: {
      linescore: {
        teams: {
          home: { runs: input.homeRuns },
          away: { runs: input.awayRuns },
        },
      },
      boxscore: {
        teams: {
          home: {
            battingOrder: input.homeOrder,
            pitchers: [input.homeStarterId],
            players: pitcherPlayer({
              pitcherId: input.homeStarterId,
              strikeOuts: 7,
              baseOnBalls: 2,
              earnedRuns: input.homeEr ?? 2,
              homeRuns: input.homeHr ?? 1,
            }),
          },
          away: {
            battingOrder: input.awayOrder,
            pitchers: [input.awayStarterId],
            players: pitcherPlayer({
              pitcherId: input.awayStarterId,
              strikeOuts: 5,
              baseOnBalls: 3,
              earnedRuns: input.awayEr ?? 4,
              homeRuns: input.awayHr ?? 2,
            }),
          },
        },
      },
    },
  };
}

function targetFeed() {
  return {
    gamePk: TARGET_GAME_PK,
    gameData: {
      game: { pk: TARGET_GAME_PK },
      datetime: { officialDate: TARGET_DATE },
      status: { abstractGameState: "Preview", detailedState: "Pre-Game" },
      teams: {
        home: { id: HOME_TEAM_ID },
        away: { id: AWAY_TEAM_ID },
      },
      probablePitchers: {
        home: { id: HOME_STARTER_ID },
        away: { id: AWAY_STARTER_ID },
      },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: HOME_ORDER },
          away: { battingOrder: AWAY_ORDER },
        },
      },
    },
  };
}

function targetGame(): MlbP1SlateGame {
  return {
    gamePk: TARGET_GAME_PK,
    startTime: "2026-05-10T23:10:00.000Z",
    officialDate: TARGET_DATE,
    venue: "FULL13 Test Park",
    state: "PREGAME",
    detailedState: "Pre-Game",
    homeTeam: { id: HOME_TEAM_ID, name: "Home" },
    awayTeam: { id: AWAY_TEAM_ID, name: "Away" },
    homePitcher: { id: HOME_STARTER_ID, name: "Home SP", hand: "R", confirmed: true },
    awayPitcher: { id: AWAY_STARTER_ID, name: "Away SP", hand: "L", confirmed: true },
    lineupState: "CONFIRMED",
    homeLineupCount: 9,
    awayLineupCount: 9,
    readiness: "READY_TO_ANALYZE",
    analysisStage: "FINAL",
    analysisAllowed: true,
    blockers: [],
    source: {
      name: "MLB_STATS_API",
      fetchedAt: "2026-05-10T20:00:00.000Z",
      quality: "AUTHORITATIVE",
    },
  };
}

function fixtureFetch() {
  const feeds = new Map<number, any>();
  const dates: Array<{ date: string; games: any[] }> = [];

  for (let index = 0; index < 5; index += 1) {
    const day = String(index + 1).padStart(2, "0");
    const officialDate = `2026-05-${day}`;
    const homePk = 831000 + index;
    const awayPk = 842000 + index;
    const homeDummy = 131 + index;
    const awayDummy = 242 + index;
    dates.push({
      date: officialDate,
      games: [
        { gamePk: homePk, officialDate, status: { abstractGameState: "Final", detailedState: "Final" } },
        { gamePk: awayPk, officialDate, status: { abstractGameState: "Final", detailedState: "Final" } },
      ],
    });
    feeds.set(homePk, historicalFeed({
      gamePk: homePk,
      officialDate,
      homeTeamId: HOME_TEAM_ID,
      awayTeamId: homeDummy,
      homeRuns: 5 + index,
      awayRuns: 2 + (index % 2),
      homeStarterId: HOME_STARTER_ID,
      awayStarterId: 7100 + index,
      homeOrder: [...HOME_ORDER],
      awayOrder: Array.from({ length: 9 }, (_, playerIndex) => 3000 + index * 20 + playerIndex),
      homeEr: 1 + (index % 2),
      awayEr: 3,
      homeHr: index % 2,
      awayHr: 1,
    }));
    feeds.set(awayPk, historicalFeed({
      gamePk: awayPk,
      officialDate,
      homeTeamId: awayDummy,
      awayTeamId: AWAY_TEAM_ID,
      homeRuns: 4 + (index % 2),
      awayRuns: 3 + index,
      homeStarterId: 7200 + index,
      awayStarterId: AWAY_STARTER_ID,
      homeOrder: Array.from({ length: 9 }, (_, playerIndex) => 4000 + index * 20 + playerIndex),
      awayOrder: [...AWAY_ORDER],
      homeEr: 3,
      awayEr: 2 + (index % 2),
      homeHr: 1,
      awayHr: index % 2,
    }));
  }

  const sameDatePk = 899998;
  dates.push({
    date: TARGET_DATE,
    games: [{ gamePk: sameDatePk, officialDate: TARGET_DATE, status: { abstractGameState: "Final", detailedState: "Final" } }],
  });
  feeds.set(TARGET_GAME_PK, targetFeed());
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input);
    if (input.includes("/v1/schedule?")) return jsonResponse({ dates });
    const match = input.match(/\/v1\.1\/game\/(\d+)\/feed\/live/);
    if (!match) return new Response("not found", { status: 404 });
    const feed = feeds.get(Number(match[1]));
    return feed ? jsonResponse(feed) : new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls, sameDatePk };
}

test("certified materializer reuses official MLB custody to produce all 13 frozen classifier features", async () => {
  const fixture = fixtureFetch();
  const materializer = new MlbC4CertifiedMaterializer({
    fetchImpl: fixture.fetchImpl,
    apiBaseUrl: "https://statsapi.test/api",
    maxConcurrency: 4,
  });

  const full13 = await materializer.assessFull13Game(targetGame());
  assert.deepEqual(MLB_FULL13_FEATURE_NAMES, MLB_FROZEN_CLASSIFIER_FEATURE_NAMES);
  assert.equal(full13.builderVersion, "mlb-full13-live-canonical-v1");
  assert.equal(full13.priceIndependent, true);
  assert.equal(full13.sameDateHistoryAllowed, false);
  assert.equal(full13.seasonResetHistory, true);
  assert.equal(full13.diagnostics.homePriorGames, 5);
  assert.equal(full13.diagnostics.awayPriorGames, 5);
  assert.equal(fixture.calls.some((url) => url.includes(`/game/${fixture.sameDatePk}/`)), false);
  for (const value of Object.values(full13.featureVector)) {
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
  }

  const classification = classifyMlbFrozenAPlusAndF5(full13.featureVector);
  assert.equal(classification.version, "mlb-frozen-a-plus-classifier.v1");

  const callsAfterFull13 = fixture.calls.length;
  const c4 = await materializer.assessGame(targetGame());
  assert.deepEqual(c4.featureVector, full13.c4Assessment.featureVector);
  assert.equal(fixture.calls.length, callsAfterFull13, "FULL13 and C4 must share cached official MLB custody");
});
