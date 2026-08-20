import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";

const TARGET_GAME_PK = 999_001;
const TARGET_DATE = "2026-04-10";
const HOME_TEAM_ID = 10;
const AWAY_TEAM_ID = 20;
const HOME_STARTER_ID = 9_001;
const AWAY_STARTER_ID = 9_002;
const HOME_ORDER = Array.from({ length: 9 }, (_, index) => 1_001 + index);
const AWAY_ORDER = Array.from({ length: 9 }, (_, index) => 2_001 + index);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function pitcherPlayer(pitcherId: number, strikeOuts: number, baseOnBalls: number, battersFaced = 21) {
  return {
    [`ID${pitcherId}`]: {
      stats: {
        pitching: { strikeOuts, baseOnBalls, battersFaced },
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
  homeOrder: number[] | null;
  awayOrder: number[] | null;
  homeK?: number;
  homeBb?: number;
  awayK?: number;
  awayBb?: number;
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
            players: pitcherPlayer(input.homeStarterId, input.homeK ?? 6, input.homeBb ?? 2),
          },
          away: {
            battingOrder: input.awayOrder,
            pitchers: [input.awayStarterId],
            players: pitcherPlayer(input.awayStarterId, input.awayK ?? 5, input.awayBb ?? 2),
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
    startTime: "2026-04-10T23:10:00.000Z",
    officialDate: TARGET_DATE,
    venue: "Certified Test Park",
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
      fetchedAt: "2026-04-10T20:00:00.000Z",
      quality: "AUTHORITATIVE",
    },
  };
}

function fixtures(options: { missingHomeLineupGamePk?: number } = {}) {
  const feeds = new Map<number, any>();
  const scheduleDates: Array<{ date: string; games: any[] }> = [];

  for (let index = 0; index < 5; index += 1) {
    const day = String(index + 1).padStart(2, "0");
    const officialDate = `2026-04-${day}`;
    const homeHistoryPk = 810_000 + index;
    const awayHistoryPk = 820_000 + index;
    const homeDummyTeam = 110 + index;
    const awayDummyTeam = 210 + index;

    scheduleDates.push({
      date: officialDate,
      games: [
        { gamePk: homeHistoryPk, officialDate, status: { abstractGameState: "Final", detailedState: "Final" } },
        { gamePk: awayHistoryPk, officialDate, status: { abstractGameState: "Final", detailedState: "Final" } },
      ],
    });

    feeds.set(homeHistoryPk, historicalFeed({
      gamePk: homeHistoryPk,
      officialDate,
      homeTeamId: HOME_TEAM_ID,
      awayTeamId: homeDummyTeam,
      homeRuns: 5 + index,
      awayRuns: 2 + (index % 2),
      homeStarterId: HOME_STARTER_ID,
      awayStarterId: 7_100 + index,
      homeOrder: options.missingHomeLineupGamePk === homeHistoryPk ? null : [...HOME_ORDER],
      awayOrder: Array.from({ length: 9 }, (_, playerIndex) => 3_000 + index * 20 + playerIndex),
      homeK: 7,
      homeBb: 1,
      awayK: 4,
      awayBb: 2,
    }));

    feeds.set(awayHistoryPk, historicalFeed({
      gamePk: awayHistoryPk,
      officialDate,
      homeTeamId: awayDummyTeam,
      awayTeamId: AWAY_TEAM_ID,
      homeRuns: 3 + (index % 2),
      awayRuns: 4 + index,
      homeStarterId: 7_200 + index,
      awayStarterId: AWAY_STARTER_ID,
      homeOrder: Array.from({ length: 9 }, (_, playerIndex) => 4_000 + index * 20 + playerIndex),
      awayOrder: [...AWAY_ORDER],
      homeK: 5,
      homeBb: 2,
      awayK: 4,
      awayBb: 3,
    }));
  }

  const sameDatePk = 899_999;
  scheduleDates.push({
    date: TARGET_DATE,
    games: [{
      gamePk: sameDatePk,
      officialDate: TARGET_DATE,
      status: { abstractGameState: "Final", detailedState: "Final" },
    }],
  });
  feeds.set(TARGET_GAME_PK, targetFeed());

  return { feeds, scheduleDates, sameDatePk };
}

function fixtureFetch(options: { missingHomeLineupGamePk?: number } = {}) {
  const { feeds, scheduleDates, sameDatePk } = fixtures(options);
  const calls: string[] = [];
  const fetchImpl = async (input: string): Promise<Response> => {
    calls.push(input);
    if (input.includes("/v1/schedule?")) return jsonResponse({ dates: scheduleDates });
    const match = input.match(/\/v1\.1\/game\/(\d+)\/feed\/live/);
    if (!match) return new Response("not found", { status: 404 });
    const gamePk = Number(match[1]);
    const feed = feeds.get(gamePk);
    if (!feed) return new Response("not found", { status: 404 });
    return jsonResponse(feed);
  };
  return { fetchImpl, calls, sameDatePk };
}

test("certified materializer uses strict prior official evidence and hands a complete C4 vector to V16", async () => {
  const fixture = fixtureFetch();
  const materializer = new MlbC4CertifiedMaterializer({
    fetchImpl: fixture.fetchImpl,
    apiBaseUrl: "https://statsapi.test/api",
    maxConcurrency: 3,
  });

  const assessment = await materializer.assessGame(targetGame());
  assert.equal(assessment.builderVersion, "mlb-c4-live-canonical-v1");
  assert.equal(assessment.priceIndependent, true);
  assert.equal(assessment.sameDateHistoryAllowed, false);
  assert.equal(assessment.seasonResetHistory, true);
  assert.equal(assessment.diagnostics.homePriorGames, 5);
  assert.equal(assessment.diagnostics.awayPriorGames, 5);
  assert.equal(assessment.diagnostics.homePriorCompleteLineups, 5);
  assert.equal(assessment.diagnostics.awayPriorCompleteLineups, 5);
  assert.ok(assessment.diagnostics.leaguePriorStarterBattersFaced > 0);
  for (const value of Object.values(assessment.featureVector)) {
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
  }
  assert.equal(fixture.calls.some((url) => url.includes(`/game/${fixture.sameDatePk}/`)), false);
  assert.equal(
    (materializer as any).feedCache.size,
    1,
    "raw historical live feeds must not remain pinned after compact history is materialized",
  );

  const evidence = scoreMlbV16SettlementEvidence(
    TARGET_GAME_PK,
    "2026-04-10T20:01:00.000Z",
    assessment,
  );
  assert.equal(evidence.gamePk, TARGET_GAME_PK);
  assert.equal(evidence.priceIndependent, true);
  assert.ok(evidence.fullGame.homeWinProbability > 0 && evidence.fullGame.homeWinProbability < 1);
  assert.ok(Math.abs(
    evidence.first5.homeWinProbability
      + evidence.first5.awayWinProbability
      + evidence.first5.pushProbability
      - 1,
  ) < 1e-12);

  const callsAfterFirstAssessment = fixture.calls.length;
  await materializer.assessGame(targetGame());
  assert.equal(fixture.calls.length, callsAfterFirstAssessment, "compact prior evidence and the current target feed should be cached");
  assert.equal((materializer as any).feedCache.size, 1);
});

test("certified materializer fails closed instead of imputing a missing historical official lineup", async () => {
  const missingGamePk = 810_002;
  const fixture = fixtureFetch({ missingHomeLineupGamePk: missingGamePk });
  const materializer = new MlbC4CertifiedMaterializer({
    fetchImpl: fixture.fetchImpl,
    apiBaseUrl: "https://statsapi.test/api",
  });

  await assert.rejects(
    () => materializer.assessGame(targetGame()),
    /C4_CERTIFIED_HOME_LINEUP_HISTORY_INCOMPLETE:999001:4:5/,
  );
});
