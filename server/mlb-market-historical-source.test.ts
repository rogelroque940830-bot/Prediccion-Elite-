import test from "node:test";
import assert from "node:assert/strict";
import {
  extractMlbScheduleGamePks,
  fetchMlbHistoricalOfficialGames,
  parseMlbHistoricalOfficialFeed,
} from "./mlb-market-historical-source";

function feed(overrides: any = {}) {
  return {
    gameData: {
      status: { abstractGameState: "Final", codedGameState: "F", detailedState: "Final" },
      datetime: { officialDate: "2025-06-01" },
      game: { season: "2025", type: "R" },
      teams: {
        home: { id: 10, name: "Home Club" },
        away: { id: 20, name: "Away Club" },
      },
      ...overrides.gameData,
    },
    liveData: {
      linescore: {
        innings: [
          { num: 1, away: { runs: 0 }, home: { runs: 1 } },
          { num: 2, away: { runs: 1 }, home: { runs: 0 } },
          { num: 3, away: { runs: 0 }, home: { runs: 1 } },
          { num: 4, away: { runs: 0 }, home: { runs: 0 } },
          { num: 5, away: { runs: 1 }, home: { runs: 1 } },
        ],
        teams: { home: { runs: 3 }, away: { runs: 2 } },
        ...overrides.linescore,
      },
    },
  };
}

test("parses official feed and preserves missing half-inning as null", () => {
  const payload = feed({
    linescore: {
      innings: [
        { num: 1, away: { runs: 0 }, home: { runs: 0 } },
        { num: 2, away: { runs: 0 }, home: { runs: 1 } },
        { num: 3, away: { runs: 0 }, home: { runs: 0 } },
        { num: 4, away: { runs: 0 }, home: { runs: 0 } },
        { num: 5, away: { runs: 0 }, home: {} },
      ],
      teams: { home: { runs: 1 }, away: { runs: 0 } },
    },
  });
  const game = parseMlbHistoricalOfficialFeed(123, payload);
  assert.equal(game?.gamePk, 123);
  assert.equal(game?.innings[4].homeRuns, null);
  assert.equal(game?.innings[4].awayRuns, 0);
  assert.match(game?.sourceDigest ?? "", /^[a-f0-9]{64}$/);
});

test("non-final feed does not become historical outcome evidence", () => {
  const payload = feed({ gameData: { status: { abstractGameState: "Live", detailedState: "In Progress" } } });
  assert.equal(parseMlbHistoricalOfficialFeed(123, payload), null);
});

test("schedule parser deduplicates and orders valid gamePks", () => {
  assert.deepEqual(extractMlbScheduleGamePks({
    dates: [
      { games: [{ gamePk: 3 }, { gamePk: 1 }, { gamePk: "bad" }] },
      { games: [{ gamePk: 3 }, { gamePk: 2 }] },
    ],
  }), [1, 2, 3]);
});

test("fetch report uses schedule then official feeds with bounded concurrency", async () => {
  const responses = new Map<string, any>();
  responses.set("schedule", { dates: [{ games: [{ gamePk: 101 }, { gamePk: 102 }] }] });
  responses.set("101", feed());
  responses.set("102", feed({ gameData: { status: { abstractGameState: "Live", detailedState: "In Progress" } } }));

  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    const key = url.includes("/schedule?") ? "schedule" : url.includes("/101/") ? "101" : "102";
    return new Response(JSON.stringify(responses.get(key)), { status: 200, headers: { "content-type": "application/json" } });
  };

  const report = await fetchMlbHistoricalOfficialGames({
    startDate: "2025-06-01",
    endDate: "2025-06-02",
    concurrency: 2,
    retryBaseDelayMs: 0,
    fetchImpl,
  });
  assert.equal(report.scheduleGames, 2);
  assert.equal(report.officialFinalGames, 1);
  assert.equal(report.games[0].gamePk, 101);
  assert.equal(report.excluded.NOT_OFFICIAL_FINAL, 1);
  assert.equal(report.failures.length, 0);
  assert.equal(report.actionabilityAllowed, false);
});

test("transient schedule and feed failures are retried but still use official final evidence only", async () => {
  let scheduleCalls = 0;
  let feedCalls = 0;
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/schedule?")) {
      scheduleCalls += 1;
      if (scheduleCalls === 1) return new Response("temporary", { status: 503 });
      return new Response(JSON.stringify({ dates: [{ games: [{ gamePk: 201 }] }] }), { status: 200 });
    }
    feedCalls += 1;
    if (feedCalls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify(feed()), { status: 200 });
  };

  const report = await fetchMlbHistoricalOfficialGames({
    startDate: "2025-06-01",
    endDate: "2025-06-01",
    retryBaseDelayMs: 0,
    fetchImpl,
  });
  assert.equal(scheduleCalls, 2);
  assert.equal(feedCalls, 2);
  assert.equal(report.officialFinalGames, 1);
  assert.equal(report.failures.length, 0);
});

test("persistent transient feed failure is recorded after bounded retries instead of becoming partial evidence", async () => {
  let feedCalls = 0;
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/schedule?")) {
      return new Response(JSON.stringify({ dates: [{ games: [{ gamePk: 301 }] }] }), { status: 200 });
    }
    feedCalls += 1;
    return new Response("unavailable", { status: 503 });
  };

  const report = await fetchMlbHistoricalOfficialGames({
    startDate: "2025-06-01",
    endDate: "2025-06-01",
    retryBaseDelayMs: 0,
    fetchImpl,
  });
  assert.equal(feedCalls, 3);
  assert.equal(report.officialFinalGames, 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].gamePk, 301);
  assert.equal(report.failures[0].error, "MLB_STATS_API_HTTP_503");
});

test("non-transient HTTP failure is not retried", async () => {
  let scheduleCalls = 0;
  const fetchImpl = async (): Promise<Response> => {
    scheduleCalls += 1;
    return new Response("not found", { status: 404 });
  };
  await assert.rejects(() => fetchMlbHistoricalOfficialGames({
    startDate: "2025-06-01",
    endDate: "2025-06-01",
    retryBaseDelayMs: 0,
    fetchImpl,
  }), /MLB_STATS_API_HTTP_404/);
  assert.equal(scheduleCalls, 1);
});

test("range, concurrency and retry-delay guards fail before research acquisition", async () => {
  await assert.rejects(() => fetchMlbHistoricalOfficialGames({
    startDate: "2024-01-01",
    endDate: "2025-12-31",
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }), /P1_M6A3B1_DATE_RANGE_TOO_LARGE/);

  await assert.rejects(() => fetchMlbHistoricalOfficialGames({
    startDate: "2025-06-01",
    endDate: "2025-06-02",
    concurrency: 20,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }), /P1_M6A3B1_INVALID_CONCURRENCY/);

  await assert.rejects(() => fetchMlbHistoricalOfficialGames({
    startDate: "2025-06-01",
    endDate: "2025-06-02",
    retryBaseDelayMs: 20_000,
    fetchImpl: async () => new Response("{}", { status: 200 }),
  }), /P1_M6A3B1_INVALID_RETRY_DELAY/);
});
