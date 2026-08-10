import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  MLB_P1_BOUNDED_F5_BOOKS,
  registerMlbP1BoundedF5OddsRoutes,
  selectMlbP1BoundedF5ProviderEvent,
} from "./mlb-p1-bounded-f5-odds-routes";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function event(id: string, home: string, away: string, commence: string) {
  return { id, home_team: home, away_team: away, commence_time: commence };
}

function eventOdds(id: string, home: string, away: string, commence: string) {
  return {
    ...event(id, home, away, commence),
    bookmakers: [{
      key: "fanduel",
      title: "FanDuel",
      last_update: "2026-08-10T18:59:00.000Z",
      markets: [{
        key: "h2h_1st_5_innings",
        outcomes: [{ name: home, price: -120 }, { name: away, price: 105 }],
      }],
    }],
  };
}

async function withServer(
  fetchImpl: typeof fetch,
  now: () => number,
  run: (base: string) => Promise<void>,
) {
  const app = express();
  registerMlbP1BoundedF5OddsRoutes(app, { fetchImpl, apiKey: "test-key", now });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function get(base: string, path: string) {
  const result = await fetch(`${base}${path}`);
  return { status: result.status, body: await result.json() as any };
}

test("bounded selector requires exact teams and uses official start to disambiguate a doubleheader", () => {
  const events = [
    event("a", "Chicago Cubs", "St. Louis Cardinals", "2026-08-10T17:10:00.000Z"),
    event("b", "Chicago Cubs", "St. Louis Cardinals", "2026-08-10T23:10:00.000Z"),
    event("c", "New York Mets", "Miami Marlins", "2026-08-10T23:10:00.000Z"),
  ];
  const selected = selectMlbP1BoundedF5ProviderEvent({
    events,
    date: "2026-08-10",
    homeTeam: "Chicago Cubs",
    awayTeam: "St. Louis Cardinals",
    startTime: "2026-08-10T23:05:00.000Z",
  });
  assert.equal(selected.event?.id, "b");
  assert.equal(selected.candidateCount, 2);
  assert.equal(selected.conflict, null);

  const ambiguous = selectMlbP1BoundedF5ProviderEvent({
    events,
    date: "2026-08-10",
    homeTeam: "Chicago Cubs",
    awayTeam: "St. Louis Cardinals",
  });
  assert.equal(ambiguous.event, null);
  assert.equal(ambiguous.conflict, "AMBIGUOUS_MATCHUP_WITHOUT_START_TIME");
});

test("bounded selector never crosses matchup identity", () => {
  const selected = selectMlbP1BoundedF5ProviderEvent({
    events: [event("x", "Chicago White Sox", "St. Louis Cardinals", "2026-08-10T23:10:00.000Z")],
    date: "2026-08-10",
    homeTeam: "Chicago Cubs",
    awayTeam: "St. Louis Cardinals",
    startTime: "2026-08-10T23:10:00.000Z",
  });
  assert.equal(selected.event, null);
  assert.equal(selected.candidateCount, 0);
  assert.equal(selected.conflict, null);
});

test("single-game route spends two provider calls first, zero on repeat, and one for a second shortlisted game", async () => {
  const slate = [
    event("one", "Chicago Cubs", "St. Louis Cardinals", "2026-08-10T23:10:00.000Z"),
    event("two", "Miami Marlins", "New York Mets", "2026-08-10T22:40:00.000Z"),
  ];
  let providerCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    providerCalls += 1;
    if (url.includes("/events/?")) return response(slate);
    if (url.includes("/events/one/odds/?")) return response(eventOdds("one", "Chicago Cubs", "St. Louis Cardinals", "2026-08-10T23:10:00.000Z"));
    if (url.includes("/events/two/odds/?")) return response(eventOdds("two", "Miami Marlins", "New York Mets", "2026-08-10T22:40:00.000Z"));
    throw new Error(`unexpected provider URL ${url}`);
  }) as typeof fetch;
  let nowMs = Date.parse("2026-08-10T19:00:00.000Z");

  await withServer(fetchImpl, () => nowMs, async (base) => {
    const first = await get(base, "/api/mlb/p1/v1/bounded-f5-odds?date=2026-08-10&home=Chicago%20Cubs&away=St.%20Louis%20Cardinals&start=2026-08-10T23%3A10%3A00.000Z");
    assert.equal(first.status, 200);
    assert.equal(first.body.success, true);
    assert.equal(first.body.games.length, 1);
    assert.equal(first.body.acquisition.providerRequests, 2);
    assert.equal(first.body.acquisition.eventListCacheHit, false);
    assert.equal(providerCalls, 2);

    nowMs += 60_000;
    const repeat = await get(base, "/api/mlb/p1/v1/bounded-f5-odds?date=2026-08-10&home=Chicago%20Cubs&away=St.%20Louis%20Cardinals&start=2026-08-10T23%3A10%3A00.000Z");
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.acquisition.providerRequests, 0);
    assert.equal(repeat.body.acquisition.quoteCacheHit, true);
    assert.equal(providerCalls, 2);

    const second = await get(base, "/api/mlb/p1/v1/bounded-f5-odds?date=2026-08-10&home=Miami%20Marlins&away=New%20York%20Mets&start=2026-08-10T22%3A40%3A00.000Z");
    assert.equal(second.status, 200);
    assert.equal(second.body.games.length, 1);
    assert.equal(second.body.acquisition.providerRequests, 1);
    assert.equal(second.body.acquisition.eventListCacheHit, true);
    assert.equal(providerCalls, 3);
  });
});

test("provider quota failure is explicit and does not fabricate a game", async () => {
  let providerCalls = 0;
  const fetchImpl = (async () => {
    providerCalls += 1;
    return response({ error_code: "OUT_OF_USAGE_CREDITS", message: "quota exhausted" }, 429);
  }) as typeof fetch;
  await withServer(fetchImpl, () => Date.parse("2026-08-10T19:00:00.000Z"), async (base) => {
    const result = await get(base, "/api/mlb/p1/v1/bounded-f5-odds?date=2026-08-10&home=Chicago%20Cubs&away=St.%20Louis%20Cardinals&start=2026-08-10T23%3A10%3A00.000Z");
    assert.equal(result.status, 503);
    assert.equal(result.body.success, false);
    assert.equal(result.body.code, "OUT_OF_USAGE_CREDITS");
    assert.equal(result.body.games.length, 0);
    assert.equal(providerCalls, 1);
  });
});

test("bounded route keeps the certified F5 source universe", () => {
  assert.deepEqual([...MLB_P1_BOUNDED_F5_BOOKS], ["fanduel", "betmgm", "draftkings"]);
});
