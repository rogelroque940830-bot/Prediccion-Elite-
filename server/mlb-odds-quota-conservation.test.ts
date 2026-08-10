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

test("static quota policy disables legacy polling, makes S5C/S5E cache-only, and keeps background freshness at five minutes", () => {
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
  assert.match(f5, /BACKGROUND_CACHE_MISS/);
  assert.match(f5, /F5_EVENT_ODDS_PROVIDER_FAILURE/);
  assert.match(f5, /providerFailureCount/);
  assert.match(f5, /providerErrorCodes/);
});

test("F5 quota-conservation route behavior is fail-closed and does not spend provider quota for background cache-only reads", async () => {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.ODDS_API_KEY;
  process.env.ODDS_API_KEY = "quota-test-key";

  try {
    // A cache-only miss must not execute even one provider fetch.
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

    // One foreground load may spend provider quota; a subsequent cache-only read must reuse
    // the recent five-minute cache without any additional provider call.
    {
      const date = "2026-09-02";
      let providerCalls = 0;
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
        const foreground = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}`);
        assert.equal(foreground.status, 200);
        assert.equal(foreground.body.success, true);
        assert.equal(foreground.body.games.length, 1);
        assert.equal(foreground.body.coverageStatus, "COMPLETE");
        assert.equal(providerCalls, 2, "one events call + one event-odds call expected");

        const background = await localGet(baseUrl, `/api/odds/mlb/f5?date=${date}&background=cache-only`);
        assert.equal(background.status, 200);
        assert.equal(background.body.success, true);
        assert.equal(background.body.backgroundCacheOnly, true);
        assert.equal(background.body.games.length, 1);
        assert.equal(providerCalls, 2, "cache-only read must not create another provider request");
      });
    }

    // When every eligible event fails because quota is exhausted, top-level F5 must surface
    // the provider code rather than masquerading as success:true with an empty slate.
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

    // A partially available provider slate remains usable but must expose degraded coverage.
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
      assert.equal(providerCalls, 3, "one events call + two event-odds calls expected");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey == null) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = previousKey;
  }
});
