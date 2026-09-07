import test from "node:test";
import assert from "node:assert/strict";
import {
  materializeR1bV16HistoricalBatch,
  MLB_R1B_V16_HISTORICAL_BATCH_POLICY,
} from "./mlb-r1b-v16-historical-batch-materializer";
import { materializeR1bV16HistoricalTarget } from "./mlb-r1b-v16-historical-target-bridge";
import type { MlbR1bV16HistoricalTargetInput } from "./mlb-r1b-v16-historical-target-bridge";

const API = "https://statsapi.mlb.com/api";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

function finalFeed(gamePk: number, officialDate: string, homeRuns: number, awayRuns: number, homePitcher = 501, awayPitcher = 601) {
  return {
    gamePk,
    gameData: {
      game: { pk: gamePk },
      datetime: { officialDate },
      status: { abstractGameState: "Final", detailedState: "Final" },
      teams: { home: { id: 1 }, away: { id: 2 } },
    },
    liveData: {
      linescore: { teams: { home: { runs: homeRuns }, away: { runs: awayRuns } } },
      boxscore: {
        teams: {
          home: {
            battingOrder: [101, 102, 103, 104, 105, 106, 107, 108, 109],
            pitchers: [homePitcher],
            players: {
              [`ID${homePitcher}`]: { stats: { pitching: { battersFaced: 25, strikeOuts: 7, baseOnBalls: 2, earnedRuns: 2, homeRuns: 1 } } },
            },
          },
          away: {
            battingOrder: [201, 202, 203, 204, 205, 206, 207, 208, 209],
            pitchers: [awayPitcher],
            players: {
              [`ID${awayPitcher}`]: { stats: { pitching: { battersFaced: 24, strikeOuts: 5, baseOnBalls: 3, earnedRuns: 3, homeRuns: 1 } } },
            },
          },
        },
      },
    },
  };
}

const historicalFeeds = new Map<number, any>([
  [1001, finalFeed(1001, "2026-06-10", 5, 3)],
  [1002, finalFeed(1002, "2026-06-11", 4, 2)],
  [1003, finalFeed(1003, "2026-06-12", 6, 5)],
  [1004, finalFeed(1004, "2026-06-13", 3, 1)],
  [1005, finalFeed(1005, "2026-06-14", 7, 4)],
  [2001, finalFeed(2001, "2026-06-15", 2, 6)],
]);

function target(gamePk: number, officialDate: string, requestedTimecode: string): MlbR1bV16HistoricalTargetInput {
  return {
    lineupArtifactSchema: "courtedge-p0-step12m-cohort-pregame-lineups.v1",
    lineupArtifactSha256: HEX_A,
    starterArtifactSchema: "courtedge-p0-step12v60-pregame-starter-hands.v1",
    starterArtifactSha256: HEX_B,
    lineup: {
      sourceVersion: "test-frozen-t5",
      gamePk,
      officialDate,
      scheduledStart: null,
      requestedTimecode,
      sourceMetadataTimecode: requestedTimecode,
      homeTeamId: 1,
      awayTeamId: 2,
      availability: "COMPLETE",
      complete: true,
      homeBattingOrder: [101, 102, 103, 104, 105, 106, 107, 108, 109],
      awayBattingOrder: [201, 202, 203, 204, 205, 206, 207, 208, 209],
      sourceDigest: HEX_A,
    },
    starter: {
      gamePk,
      officialDate,
      homeTeamId: 1,
      awayTeamId: 2,
      homePitcherId: 501,
      awayPitcherId: 601,
      requestedTimecode,
      sourceMetadataTimecode: requestedTimecode,
      usable: true,
      reason: null,
      sourceDigest: HEX_B,
    },
  };
}

function makeFetch(counter: Map<string, number>) {
  return async (input: string): Promise<Response> => {
    counter.set(input, (counter.get(input) ?? 0) + 1);
    const url = new URL(input);
    if (url.pathname === "/api/v1/schedule") {
      const endDate = url.searchParams.get("endDate") ?? "";
      const rows = [...historicalFeeds.entries()]
        .map(([gamePk, feed]) => ({ gamePk, officialDate: feed.gameData.datetime.officialDate }))
        .filter((row) => row.officialDate <= endDate)
        .sort((a, b) => a.officialDate.localeCompare(b.officialDate));
      const dates = rows.map((row) => ({
        date: row.officialDate,
        games: [{ gamePk: row.gamePk, officialDate: row.officialDate, status: { abstractGameState: "Final", detailedState: "Final" } }],
      }));
      return new Response(JSON.stringify({ dates }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const match = url.pathname.match(/^\/api\/v1\.1\/game\/(\d+)\/feed\/live$/);
    if (match) {
      const feed = historicalFeeds.get(Number(match[1]));
      if (!feed) return new Response("missing", { status: 404 });
      return new Response(JSON.stringify(feed), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("unexpected", { status: 500 });
  };
}

test("batch current-semantics C4/V16 output matches certified per-target bridge and fetches each prior final feed once", async () => {
  const t1 = target(2001, "2026-06-15", "20260615_180000");
  const t2 = target(2002, "2026-06-16", "20260616_180000");
  const batchCalls = new Map<string, number>();
  const batch = await materializeR1bV16HistoricalBatch({
    season: 2026,
    targets: [t1, t2],
    fetchImpl: makeFetch(batchCalls),
    apiBaseUrl: API,
    maxConcurrency: 4,
    timeoutMs: 5_000,
  });

  assert.equal(batch.targets.length, 2);
  assert.equal(batch.source.scheduleFetchedOnce, true);
  assert.equal(batch.source.priorFinalFeedCount, 6);
  assert.equal(batch.source.priorFinalFeedsFetchedOnceEach, true);
  assert.equal(MLB_R1B_V16_HISTORICAL_BATCH_POLICY.sameDateHistoryAllowed, false);

  const scheduleCalls = [...batchCalls.entries()].filter(([url]) => new URL(url).pathname === "/api/v1/schedule");
  assert.equal(scheduleCalls.length, 1);
  assert.equal(scheduleCalls[0][1], 1);
  const feedCalls = [...batchCalls.entries()].filter(([url]) => /\/api\/v1\.1\/game\/\d+\/feed\/live$/.test(new URL(url).pathname));
  assert.equal(feedCalls.length, 6);
  for (const [, count] of feedCalls) assert.equal(count, 1);
  assert.equal([...batchCalls.keys()].some((url) => url.includes("/game/2002/feed/live")), false);

  for (const frozen of [t1, t2]) {
    const bridgeCalls = new Map<string, number>();
    const bridge = await materializeR1bV16HistoricalTarget({
      frozen,
      fetchImpl: makeFetch(bridgeCalls),
      apiBaseUrl: API,
      maxConcurrency: 4,
      timeoutMs: 5_000,
    });
    const fromBatch = batch.targets.find((row) => row.gamePk === frozen.lineup.gamePk);
    assert.ok(fromBatch);
    assert.deepEqual(fromBatch.assessment.featureVector, bridge.assessment.featureVector);
    assert.deepEqual(fromBatch.assessment.diagnostics, bridge.assessment.diagnostics);
    assert.deepEqual(fromBatch.rows, bridge.rows);
  }
});

test("batch remains strictly prior-date and never consumes same-date final results", async () => {
  const sameDateFeed = finalFeed(2999, "2026-06-16", 20, 0);
  historicalFeeds.set(2999, sameDateFeed);
  try {
    const calls = new Map<string, number>();
    const batch = await materializeR1bV16HistoricalBatch({
      season: 2026,
      targets: [target(2002, "2026-06-16", "20260616_180000")],
      fetchImpl: makeFetch(calls),
      apiBaseUrl: API,
      maxConcurrency: 4,
      timeoutMs: 5_000,
    });
    assert.equal(batch.targets[0].assessment.diagnostics.homePriorGames, 6);
    assert.equal([...calls.keys()].some((url) => url.includes("/game/2999/feed/live")), false);
  } finally {
    historicalFeeds.delete(2999);
  }
});
