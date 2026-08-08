import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import { PARK_FACTORS } from "./mlb-advanced";
import { invalidateCache } from "./route-runtime";
import { registerMarketSupportRoutes } from "./market-support-routes";

type RouteHandler = (req: any, res: any) => unknown | Promise<unknown>;

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function captureApp(): { app: Express; get: Map<string, RouteHandler> } {
  const get = new Map<string, RouteHandler>();
  const app = {
    get(path: string, ...handlers: RouteHandler[]) {
      get.set(path, handlers.at(-1) as RouteHandler);
    },
    post() {},
  } as unknown as Express;
  return { app, get };
}

test("shadowed duplicate park-factor keys are removed without changing effective runtime values", () => {
  assert.equal(PARK_FACTORS[19]?.name, "Coors Field");
  assert.equal(PARK_FACTORS[19]?.runs, 115);
  assert.equal(PARK_FACTORS[32]?.name, "American Family Fld");
  assert.equal(PARK_FACTORS[32]?.runs, 100);
});

test("MLB advanced route retains doubleheader-safe metadata and dynamic season after S3 extraction", async () => {
  process.env.ODDS_API_KEY = "test-odds-key";
  const gamePk = 998877;
  invalidateCache(`mlb-adv-${gamePk}`);
  const { app, get } = captureApp();
  registerMarketSupportRoutes(app);
  const handler = get.get("/api/mlb/advanced/:gamePk");
  assert.ok(handler, "advanced route must be registered");

  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith(`/api/v1.1/game/${gamePk}/feed/live`)) {
      return response({
        gameData: {
          datetime: { dateTime: "2026-08-08T23:10:00Z" },
          venue: { id: 1, name: "Test Park" },
          weather: { temp: 82, wind: "7 mph, Out To CF", condition: "Clear" },
          teams: { home: { id: 10 }, away: { id: 20 } },
          probablePitchers: { home: { id: 101 }, away: { id: 202 } },
          players: {
            ID101: { fullName: "Home Starter", pitchHand: { code: "R" } },
            ID202: { fullName: "Away Starter", pitchHand: { code: "L" } },
          },
        },
        liveData: { boxscore: { teams: { home: { battingOrder: [] }, away: { battingOrder: [] } } } },
      });
    }
    if (url.includes("/api/v1/venues/1?hydrate=fieldInfo")) {
      return response({ venues: [{ fieldInfo: { roofType: "Open" } }] });
    }
    if (url.includes("/api/v1/people/101/stats?")) {
      return response({ stats: [{ splits: [{ stat: { gamesStarted: 20, gamesPlayed: 20, inningsPitched: "120.0" } }] }] });
    }
    if (url.includes("/api/v1/people/202/stats?")) {
      return response({ stats: [{ splits: [{ stat: { gamesStarted: 19, gamesPlayed: 19, inningsPitched: "111.2" } }] }] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  let payload: any;
  try {
    await handler(
      { params: { gamePk: String(gamePk) } },
      { json(value: unknown) { payload = value; return value; } },
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.ODDS_API_KEY;
    invalidateCache(`mlb-adv-${gamePk}`);
  }

  assert.equal(payload?.success, true, JSON.stringify(payload));
  assert.equal(payload?.homePitcher?.name, "Home Starter");
  assert.equal(payload?.awayPitcher?.name, "Away Starter");
  assert.ok(seen.some((url) => url.endsWith(`/api/v1.1/game/${gamePk}/feed/live`)), "must use feed/live by gamePk");
  const season = String(new Date().getFullYear());
  assert.ok(seen.some((url) => url.includes(`/api/v1/people/101/stats?`) && url.includes(`season=${season}`)));
  assert.ok(seen.some((url) => url.includes(`/api/v1/people/202/stats?`) && url.includes(`season=${season}`)));
  assert.ok(!String(payload?.error || "").includes("getGameMeta"));
  assert.ok(!String(payload?.error || "").includes("MLB_SEASON_CURRENT"));
});
