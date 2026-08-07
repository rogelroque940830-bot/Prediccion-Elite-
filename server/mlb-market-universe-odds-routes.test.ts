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

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
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

test("service fetches only the requested Florida slate and caches it for one minute", async () => {
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
  assert.equal(first.policy.referenceQuotesExecutable, false);
  assert.equal(first.policy.undocumentedMarketsInvented, false);
  assert.equal(first.policy.threeWayCoercedToTwoWay, false);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.ok(calls.some((url) => url.includes("/events/today/odds/")));
  assert.equal(calls.some((url) => url.includes("/events/tomorrow/odds/")), false);
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
