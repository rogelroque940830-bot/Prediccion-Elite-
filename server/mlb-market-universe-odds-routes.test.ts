import test from "node:test";
import assert from "node:assert/strict";
import {
  MLB_P1_M6A2_BOOKMAKERS,
  MLB_P1_M6A2_ENDPOINT,
  MlbP1M6a2MarketOddsService,
  buildMlbP1M6a2EventOddsUrl,
  eventFloridaDate,
  normalizeRequestedFloridaDate,
} from "./mlb-market-universe-odds-routes";
import { MLB_P1_M6A2_PROVIDER_MARKETS } from "./mlb-market-odds-normalizer";

const NOW = new Date("2026-08-07T13:30:00.000Z");

function response(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("event odds URL requests the documented universe and explicit books without region ambiguity", () => {
  const url = new URL(buildMlbP1M6a2EventOddsUrl("event/with space", "secret key"));
  assert.equal(url.pathname, "/v4/sports/baseball_mlb/events/event%2Fwith%20space/odds/");
  assert.equal(url.searchParams.get("apiKey"), "secret key");
  assert.equal(url.searchParams.get("bookmakers"), MLB_P1_M6A2_BOOKMAKERS.join(","));
  assert.equal(url.searchParams.get("markets"), MLB_P1_M6A2_PROVIDER_MARKETS.join(","));
  assert.equal(url.searchParams.has("regions"), false);
  assert.equal(url.searchParams.get("oddsFormat"), "american");
  assert.ok(url.searchParams.get("markets")?.includes("h2h_1st_3_innings"));
  assert.ok(url.searchParams.get("markets")?.includes("spreads_1st_5_innings"));
  assert.ok(url.searchParams.get("markets")?.includes("h2h_3_way_1st_3_innings"));
  assert.ok(url.searchParams.get("markets")?.includes("team_totals"));
});

test("Florida date normalization is deterministic and rejects impossible dates", () => {
  assert.equal(normalizeRequestedFloridaDate(undefined, NOW), "2026-08-07");
  assert.equal(normalizeRequestedFloridaDate("2026-08-08", NOW), "2026-08-08");
  assert.throws(() => normalizeRequestedFloridaDate("08/07/2026", NOW), /INVALID_DATE/);
  assert.throws(() => normalizeRequestedFloridaDate("2026-02-31", NOW), /INVALID_DATE/);
  assert.equal(eventFloridaDate("2026-08-08T02:30:00Z"), "2026-08-07");
});

test("service fetches only the requested Florida slate, reports complete coverage and caches it for one minute", async () => {
  const calls: string[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/events/?")) {
      return response([
        { id: "today", commence_time: "2026-08-07T23:10:00Z" },
        { id: "tomorrow", commence_time: "2026-08-08T23:10:00Z" },
      ]);
    }
    if (url.includes("/events/today/odds/")) {
      return response({
        id: "today",
        home_team: "Home Club",
        away_team: "Away Club",
        commence_time: "2026-08-07T23:10:00Z",
        bookmakers: [],
      }, 200, {
        "x-requests-last": "8",
        "x-requests-remaining": "992",
        "x-requests-used": "108",
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const service = new MlbP1M6a2MarketOddsService({
    fetchFn,
    now: () => NOW,
    cacheTtlMs: 60_000,
  });
  const first = await service.load("2026-08-07", "key");
  const second = await service.load("2026-08-07", "key");
  assert.equal(first.games.length, 1);
  assert.equal(first.games[0].eventId, "today");
  assert.deepEqual(first.coverage, {
    eligibleEvents: 1,
    fetchedGames: 1,
    failedEvents: [],
    complete: true,
  });
  assert.equal(first.providerUsage.totalReportedCost, 8);
  assert.equal(first.providerUsage.minimumReportedRemaining, 992);
  assert.deepEqual(first.providerUsage.samples, [{
    eventId: "today",
    requestsLast: 8,
    requestsRemaining: 992,
    requestsUsed: 108,
  }]);
  assert.equal(first.policy.bookmakerRegionEquivalents, 1);
  assert.equal(first.policy.referenceQuotesExecutable, false);
  assert.equal(first.policy.undocumentedMarketsInvented, false);
  assert.equal(first.policy.threeWayCoercedToTwoWay, false);
  assert.equal(first.policy.partialSlateCached, false);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((url) => url.includes("/events/today/odds/")));
  assert.equal(calls.some((url) => url.includes("/events/tomorrow/odds/")), false);
});

test("partial provider coverage is visible and never cached as a complete daily universe", async () => {
  let eventsCalls = 0;
  let goodEventCalls = 0;
  let failedEventCalls = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/events/?")) {
      eventsCalls += 1;
      return response([
        { id: "good", commence_time: "2026-08-07T22:10:00Z" },
        { id: "bad", commence_time: "2026-08-07T23:10:00Z" },
      ]);
    }
    if (url.includes("/events/good/odds/")) {
      goodEventCalls += 1;
      return response({
        id: "good",
        home_team: "Home Club",
        away_team: "Away Club",
        commence_time: "2026-08-07T22:10:00Z",
        bookmakers: [],
      });
    }
    failedEventCalls += 1;
    return response({ message: "temporary", error_code: "TEMP" }, 503);
  };
  const service = new MlbP1M6a2MarketOddsService({ fetchFn, now: () => NOW });
  const first = await service.load("2026-08-07", "key");
  const second = await service.load("2026-08-07", "key");
  assert.equal(first.coverage.complete, false);
  assert.equal(first.coverage.eligibleEvents, 2);
  assert.equal(first.coverage.fetchedGames, 1);
  assert.deepEqual(first.coverage.failedEvents, [{ eventId: "bad", code: "TEMP" }]);
  assert.equal(second.coverage.complete, false);
  assert.equal(eventsCalls, 2);
  assert.equal(goodEventCalls, 2);
  assert.equal(failedEventCalls, 2);
});

test("all event-provider failures remain retryable and are never cached as an empty slate", async () => {
  let eventsCalls = 0;
  let eventOddsCalls = 0;
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/events/?")) {
      eventsCalls += 1;
      return response([{ id: "today", commence_time: "2026-08-07T23:10:00Z" }]);
    }
    eventOddsCalls += 1;
    return response({ message: "provider temporarily unavailable", error_code: "TEMP" }, 503);
  };
  const service = new MlbP1M6a2MarketOddsService({ fetchFn, now: () => NOW });
  await assert.rejects(() => service.load("2026-08-07", "key"), /ALL_EVENT_ODDS_REQUESTS_FAILED/);
  await assert.rejects(() => service.load("2026-08-07", "key"), /ALL_EVENT_ODDS_REQUESTS_FAILED/);
  assert.equal(eventsCalls, 2);
  assert.equal(eventOddsCalls, 2);
});

test("invalid dates fail before any provider request", async () => {
  let calls = 0;
  const service = new MlbP1M6a2MarketOddsService({
    fetchFn: async () => {
      calls += 1;
      return response([]);
    },
    now: () => NOW,
  });
  await assert.rejects(() => service.load("not-a-date", "key"), /INVALID_DATE/);
  assert.equal(calls, 0);
  assert.equal(MLB_P1_M6A2_ENDPOINT, "/api/mlb/p1/v1/market-universe-odds");
});
