// Post-patcher v3 revalidation trigger only; runtime logic is unchanged by this commit.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { registerMlbF5OddsProtectionRoutes } from "./mlb-f5-odds-routes";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function providerEvent(id: string, date: string, home = "Home Team", away = "Away Team") {
  return {
    id,
    sport_key: "baseball_mlb",
    commence_time: `${date}T23:00:00.000Z`,
    home_team: home,
    away_team: away,
  };
}

function providerEventOdds(id: string, date: string, home = "Home Team", away = "Away Team") {
  return {
    ...providerEvent(id, date, home, away),
    bookmakers: [{
      key: "fanduel",
      title: "FanDuel",
      last_update: `${date}T18:55:00.000Z`,
      markets: [{
        key: "h2h_1st_5_innings",
        outcomes: [
          { name: home, price: -110 },
          { name: away, price: 100 },
        ],
      }],
    }],
  };
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  registerMlbF5OddsProtectionRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function localGet(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${baseUrl}${path}`, { headers: { accept: "application/json" } }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(raw) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

test("static quota policy disables legacy polling, makes S5C/S5E cache-only, and keeps all F5 cache reuse inside five minutes", () => {
  const legacy = fs.readFileSync("server/legacy-picks-routes.ts", "utf8");
  const s5c = fs.readFileSync("server/mlb-s5c-shadow-ingestion.ts", "utf8");
  const s5e = fs.readFileSync("server/mlb-s5e-coverage-service.ts", "utf8");
  const f5 = fs.readFileSync("server/mlb-f5-odds-routes.ts", "utf8");

  assert.match(legacy, /LEGACY_ODDS_BACKGROUND_POLLING/);
  assert.match(legacy, /LEGACY_ODDS_BACKGROUND_POLLING \? requireSecret\("ODDS_API_KEY"\) : null/);
  assert.match(legacy, /if \(LEGACY_ODDS_BACKGROUND_POLLING\)/);
  assert.match(legacy, /legacy background polling disabled/);
  assert.ok(
    legacy.indexOf("if (LEGACY_ODDS_BACKGROUND_POLLING)") < legacy.indexOf("const bootPoll = setTimeout"),
    "legacy boot poll must live inside the explicit opt-in gate",
  );

  assert.match(s5c, /hasPregameGame/);
  assert.match(s5c, /background=cache-only/);
  assert.ok(
    s5c.indexOf("const schedule = await fetchJson") < s5c.indexOf("background=cache-only"),
    "S5C must inspect the schedule before requesting cached F5 odds",
  );
  assert.match(s5e, /background=cache-only/);

  assert.match(f5, /F5_BACKGROUND_CACHE_TTL_MS = 5 \* 60 \* 1000/);
  assert.doesNotMatch(f5, /F5_BACKGROUND_CACHE_TTL_MS = 30 \* 60 \* 1000/);
  assert.match(f5, /const cacheFresh = Boolean/);
  assert.doesNotMatch(f5, /withCache\(cacheKey/);
  assert.match(f5, /BACKGROUND_CACHE_MISS/);
  assert.match(f5, /F5_EVENT_ODDS_PROVIDER_FAILURE/);
  assert.match(f5, /providerFailureCount/);
  assert.match(f5, /providerErrorCodes/);
});

test("F5 quota-conservation route is fail-closed, background never refreshes, and foreground refreshes only after five minutes", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const previousKey = process.env.ODDS_API_KEY;
  process.env.ODDS_API_KEY = "quota-test-key";

  try {
    {
      let providerCalls = 0;
      globalThis.fetch = (async () => {
        providerCalls += 1;
        throw new Error("provider should not be called on cache-only miss");
      }) as typeof fetch;
      await withServer(async (baseUrl) => {
        const response = await localGet(baseUrl, "/api/odds/mlb/f5?date=2026-09-01&background=cache-only");
        assert.equal(response.status, 200);
        assert.equal(response.body.success, false);
        assert.equal(response.body.code, "BACKGROUND_CACHE_MISS");
        assert.equal(response.body.backgroundCacheOnly, true);
      });
      assert.equal(providerCalls, 0);
    }

    {
      const date = "2026-09-02";
      let providerCalls = 0;
      let fakeNow = 1_800_000_000_000;
      Date.now = () => fakeNow;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        providerCalls += 1;
        if (url.includes("/sports/baseball_mlb/events/?")) {
          return jsonResponse([providerEvent("event-cache", date)]);
        }
        if (url.includes("/events/event-cache/odds/?")) {
          return jsonResponse(providerEventOdds("event-cache", date));
        }
        throw new Error(`Unexpected provider URL ${url}`);
      }) as typeof fetch;

      await withServer(async (baseUrl) => {
        const firstForeground = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}`);
        assert.equal(firstForeground.status, 200);
        assert.equal(firstForeground.body.success, true);
        assert.equal(firstForeground.body.games.length, 1);
        assert.equal(firstForeground.body.coverageStatus, "COMPLETE");
        assert.equal(providerCalls, 2);

        const firstFetchAt = fakeNow;
        fakeNow = firstFetchAt + (4 * 60 * 1000);
        const freshForeground = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}`);
        assert.equal(freshForeground.status, 200);
        assert.equal(freshForeground.body.success, true);
        assert.equal(providerCalls, 2, "foreground must reuse provider data while it is younger than five minutes");

        const freshBackground = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}&background=cache-only`);
        assert.equal(freshBackground.status, 200);
        assert.equal(freshBackground.body.success, true);
        assert.equal(freshBackground.body.backgroundCacheOnly, true);
        assert.equal(freshBackground.body.games.length, 1);
        assert.equal(providerCalls, 2, "background must never spend quota while fresh cache exists");

        fakeNow = firstFetchAt + (5 * 60 * 1000) + 1;
        const staleBackground = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}&background=cache-only`);
        assert.equal(staleBackground.status, 200);
        assert.equal(staleBackground.body.success, false);
        assert.equal(staleBackground.body.code, "BACKGROUND_CACHE_MISS");
        assert.equal(providerCalls, 2, "stale background request must not refresh provider");

        const refreshedForeground = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}`);
        assert.equal(refreshedForeground.status, 200);
        assert.equal(refreshedForeground.body.success, true);
        assert.equal(refreshedForeground.body.games.length, 1);
        assert.equal(providerCalls, 4, "foreground must refresh provider after five-minute expiry");
      });
      Date.now = originalNow;
    }

    {
      const date = "2026-09-03";
      let providerCalls = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        providerCalls += 1;
        if (url.includes("/sports/baseball_mlb/events/?")) {
          return jsonResponse([providerEvent("event-quota", date)]);
        }
        if (url.includes("/events/event-quota/odds/?")) {
          return jsonResponse({
            error_code: "OUT_OF_USAGE_CREDITS",
            message: "Monthly usage quota exhausted",
          }, 429);
        }
        throw new Error(`Unexpected provider URL ${url}`);
      }) as typeof fetch;

      await withServer(async (baseUrl) => {
        const response = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.success, false);
        assert.equal(response.body.code, "OUT_OF_USAGE_CREDITS");
        assert.equal(Array.isArray(response.body.games) ? response.body.games.length : 0, 0);
      });
      assert.equal(providerCalls, 2);
    }

    {
      const date = "2026-09-04";
      let providerCalls = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        providerCalls += 1;
        if (url.includes("/sports/baseball_mlb/events/?")) {
          return jsonResponse([
            providerEvent("event-good", date, "Good Home", "Good Away"),
            providerEvent("event-bad", date, "Bad Home", "Bad Away"),
          ]);
        }
        if (url.includes("/events/event-good/odds/?")) {
          return jsonResponse(providerEventOdds("event-good", date, "Good Home", "Good Away"));
        }
        if (url.includes("/events/event-bad/odds/?")) {
          return jsonResponse({ error_code: "UPSTREAM_FAILURE", message: "event unavailable" }, 503);
        }
        throw new Error(`Unexpected provider URL ${url}`);
      }) as typeof fetch;

      await withServer(async (baseUrl) => {
        const response = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}`);
        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.games.length, 1);
        assert.equal(response.body.coverageStatus, "PARTIAL");
        assert.equal(response.body.eligibleEventCount, 2);
        assert.equal(response.body.providerFailureCount, 1);
        assert.deepEqual(response.body.providerErrorCodes, ["UPSTREAM_FAILURE"]);
      });
      assert.equal(providerCalls, 3);
    }
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    if (previousKey == null) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = previousKey;
  }
});
