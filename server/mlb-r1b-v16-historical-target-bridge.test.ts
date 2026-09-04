import assert from "node:assert/strict";
import test from "node:test";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";
import {
  materializeR1bV16HistoricalTarget,
  type MlbR1bV16HistoricalTargetInput,
} from "./mlb-r1b-v16-historical-target-bridge";

const TARGET_GAME_PK = 999_101;
const TARGET_DATE = "2026-04-10";
const HOME_TEAM_ID = 10;
const AWAY_TEAM_ID = 20;
const HOME_STARTER_ID = 9_101;
const AWAY_STARTER_ID = 9_102;
const HOME_ORDER = Array.from({ length: 9 }, (_, index) => 1_101 + index);
const AWAY_ORDER = Array.from({ length: 9 }, (_, index) => 2_101 + index);

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
  homeOrder: number[];
  awayOrder: number[];
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

function frozenTarget(): MlbR1bV16HistoricalTargetInput {
  return {
    lineupArtifactSchema: "courtedge-p0-step12m-cohort-pregame-lineups.v1",
    lineupArtifactSha256: "1".repeat(64),
    starterArtifactSchema: "courtedge-p0-step12v60-pregame-starter-hands.v1",
    starterArtifactSha256: "2".repeat(64),
    lineup: {
      sourceVersion: "statsapi.mlb.com-v1.1-timecode-pregame-lineup.v4",
      gamePk: TARGET_GAME_PK,
      officialDate: TARGET_DATE,
      scheduledStart: "2026-04-10T23:10:00.000Z",
      requestedTimecode: "20260410_230500",
      sourceMetadataTimecode: "20260410_230500",
      homeTeamId: HOME_TEAM_ID,
      awayTeamId: AWAY_TEAM_ID,
      availability: "COMPLETE",
      complete: true,
      homeBattingOrder: HOME_ORDER,
      awayBattingOrder: AWAY_ORDER,
      sourceDigest: "3".repeat(64),
    },
    starter: {
      gamePk: TARGET_GAME_PK,
      officialDate: TARGET_DATE,
      homeTeamId: HOME_TEAM_ID,
      awayTeamId: AWAY_TEAM_ID,
      homePitcherId: HOME_STARTER_ID,
      awayPitcherId: AWAY_STARTER_ID,
      requestedTimecode: "20260410_230500",
      sourceMetadataTimecode: "20260410_230500",
      usable: true,
      reason: null,
      sourceDigest: "4".repeat(64),
    },
  };
}

function fixtureFetch() {
  const feeds = new Map<number, unknown>();
  const scheduleDates: Array<{ date: string; games: unknown[] }> = [];

  for (let index = 0; index < 5; index += 1) {
    const day = String(index + 1).padStart(2, "0");
    const officialDate = `2026-04-${day}`;
    const homeHistoryPk = 830_000 + index;
    const awayHistoryPk = 840_000 + index;
    const homeDummyTeam = 310 + index;
    const awayDummyTeam = 410 + index;

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
      awayStarterId: 7_300 + index,
      homeOrder: [...HOME_ORDER],
      awayOrder: Array.from({ length: 9 }, (_, playerIndex) => 3_100 + index * 20 + playerIndex),
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
      homeStarterId: 7_400 + index,
      awayStarterId: AWAY_STARTER_ID,
      homeOrder: Array.from({ length: 9 }, (_, playerIndex) => 4_100 + index * 20 + playerIndex),
      awayOrder: [...AWAY_ORDER],
      homeK: 5,
      homeBb: 2,
      awayK: 4,
      awayBb: 3,
    }));
  }

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
  return { fetchImpl, calls };
}

test("bridges frozen T-minus-5 identity to exact C4 and locked V16 rows without an external target feed read", async () => {
  const fixture = fixtureFetch();
  const result = await materializeR1bV16HistoricalTarget({
    frozen: frozenTarget(),
    fetchImpl: fixture.fetchImpl,
    apiBaseUrl: "https://statsapi.test/api",
    maxConcurrency: 3,
  });

  assert.equal(result.schemaVersion, "courtedge-mlb-r1b-v16-historical-target-bridge.v1");
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map((row) => [row.market, row.side, row.horizon]), [
    ["FG_ML", "HOME", "FULL_GAME"],
    ["FG_ML", "AWAY", "FULL_GAME"],
    ["F5_ML", "HOME", "EARLY_WINDOW"],
    ["F5_ML", "AWAY", "EARLY_WINDOW"],
  ]);
  assert.equal(result.provenance.generatedAt, "2026-04-10T23:05:00.000Z");
  assert.equal(result.provenance.targetFeedSource, "FROZEN_SYNTHETIC_IDENTITY_ONLY");
  assert.equal(result.provenance.externalTargetFeedRead, false);
  assert.equal(result.provenance.outcomeFieldsRead, false);
  assert.equal(result.provenance.marketPricesRead, false);
  assert.equal(
    fixture.calls.some((url) => url.includes(`/game/${TARGET_GAME_PK}/feed/live`)),
    false,
    "the caller fetch must never see the historical target game",
  );

  const expected = scoreMlbV16SettlementEvidence(
    TARGET_GAME_PK,
    result.provenance.generatedAt,
    result.assessment,
  );
  assert.equal(result.rows[0].probability, expected.fullGame.homeWinProbability);
  assert.equal(result.rows[1].probability, expected.fullGame.awayWinProbability);
  assert.equal(result.rows[2].probability, expected.first5.homeWinProbability);
  assert.equal(result.rows[3].probability, expected.first5.awayWinProbability);
  assert.equal(result.rows[2].pushProbability, expected.first5.pushProbability);
  assert.equal(result.rows[3].pushProbability, expected.first5.pushProbability);
  assert.ok(result.rows.every((row) => row.inputStage === "FINAL"));
});

test("fails closed before network access when Step12M and V60 frozen identities disagree", async () => {
  const fixture = fixtureFetch();
  const frozen = frozenTarget();
  frozen.starter = { ...frozen.starter, gamePk: TARGET_GAME_PK + 1 };
  await assert.rejects(
    () => materializeR1bV16HistoricalTarget({
      frozen,
      fetchImpl: fixture.fetchImpl,
      apiBaseUrl: "https://statsapi.test/api",
    }),
    /MLB_R1B_V16_HISTORICAL_FROZEN_IDENTITY_MISMATCH/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("fails closed when a frozen source timestamp is later than the requested pregame timecode", async () => {
  const fixture = fixtureFetch();
  const frozen = frozenTarget();
  frozen.lineup = { ...frozen.lineup, sourceMetadataTimecode: "20260410_230501" };
  await assert.rejects(
    () => materializeR1bV16HistoricalTarget({
      frozen,
      fetchImpl: fixture.fetchImpl,
      apiBaseUrl: "https://statsapi.test/api",
    }),
    /MLB_R1B_V16_HISTORICAL_SOURCE_AFTER_REQUESTED_TIMECODE/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("fails closed on duplicate or incomplete frozen batting orders", async () => {
  const fixture = fixtureFetch();
  const frozen = frozenTarget();
  frozen.lineup = {
    ...frozen.lineup,
    homeBattingOrder: [HOME_ORDER[0], HOME_ORDER[0], ...HOME_ORDER.slice(2)],
  };
  await assert.rejects(
    () => materializeR1bV16HistoricalTarget({
      frozen,
      fetchImpl: fixture.fetchImpl,
      apiBaseUrl: "https://statsapi.test/api",
    }),
    /MLB_R1B_V16_HISTORICAL_HOME_LINEUP_INVALID/,
  );
  assert.equal(fixture.calls.length, 0);
});

test("fails closed when V60 classified the frozen probable-starter identity unusable", async () => {
  const fixture = fixtureFetch();
  const frozen = frozenTarget();
  frozen.starter = { ...frozen.starter, usable: false, reason: "FROZEN_T5_PROBABLE_STARTER_ID_MISSING" };
  await assert.rejects(
    () => materializeR1bV16HistoricalTarget({
      frozen,
      fetchImpl: fixture.fetchImpl,
      apiBaseUrl: "https://statsapi.test/api",
    }),
    /MLB_R1B_V16_HISTORICAL_STARTER_NOT_USABLE/,
  );
  assert.equal(fixture.calls.length, 0);
});
