import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import {
  createStatcastCertifierSourceAlignedFetch,
  createStatcastCertifierSourceAlignedRouteService,
  registerMlbStatcastCertifierSourceAlignmentMiddleware,
  rewriteStatcastCertifierSavantUrl,
} from "./mlb-statcast-certifier-source-alignment-routes";

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  } as Response;
}

test("legacy batter Savant request is rewritten to the shared inclusive official source", () => {
  const legacy = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true";
  const rewritten = new URL(rewriteStatcastCertifierSavantUrl(legacy));

  assert.equal(rewritten.searchParams.get("type"), "batter");
  assert.equal(rewritten.searchParams.get("year"), "2026");
  assert.equal(rewritten.searchParams.get("min"), "1");
  assert.equal(rewritten.searchParams.get("minPitches"), "1");
  assert.equal(rewritten.searchParams.get("pitchType"), "");
  assert.equal(rewritten.searchParams.has("min_pa"), false);
  assert.equal(rewritten.searchParams.has("min_pitches"), false);
  assert.equal(rewritten.searchParams.has("pitch_type"), false);
});

test("legacy pitcher Savant request is rewritten to the shared Qualified official source", () => {
  const legacy = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true";
  const rewritten = new URL(rewriteStatcastCertifierSavantUrl(legacy));

  assert.equal(rewritten.searchParams.get("type"), "pitcher");
  assert.equal(rewritten.searchParams.get("min"), "1");
  assert.equal(rewritten.searchParams.get("minPitches"), "q");
  assert.equal(rewritten.searchParams.get("pitchType"), "");
});

test("non-Savant traffic is preserved byte-for-byte and malformed Savant season fails closed", async () => {
  const seen: string[] = [];
  const aligned = createStatcastCertifierSourceAlignedFetch(async (input) => {
    seen.push(urlOf(input));
    return response({ ok: true });
  });

  const mlb = "https://statsapi.mlb.com/api/v1/teams/10/roster?rosterType=active";
  await aligned(mlb);
  assert.deepEqual(seen, [mlb]);

  assert.throws(
    () => rewriteStatcastCertifierSavantUrl("https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&year=bad"),
    /STATCAST_CERTIFIER_SAVANT_YEAR_INVALID/,
  );
});

test("route service gives the unchanged strict certifier an aligned Savant fetch", async () => {
  const seen: string[] = [];
  const baseFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    seen.push(url);
    if (url.includes("statsapi.mlb.com/api/v1.1/game/777/feed/live")) {
      return response({
        gameData: {
          datetime: { officialDate: "2026-08-08" },
          teams: {
            home: { id: 10, abbreviation: "HOM" },
            away: { id: 20, abbreviation: "AWY" },
          },
          probablePitchers: {
            home: { id: 101, fullName: "Home Starter" },
            away: { id: 202, fullName: "Away Starter" },
          },
        },
      });
    }
    if (url.includes("baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats")) return response("csv");
    throw new Error(`unexpected fetch: ${url}`);
  };

  const service = createStatcastCertifierSourceAlignedRouteService(baseFetch, {
    identityEngine: (async () => ({
      homeRunsDelta: -0.25,
      awayRunsDelta: 0.15,
      homeLineupVsAwaySP: { perBatter: [] },
      awayLineupVsHomeSP: { perBatter: [] },
    })) as any,
    certifier: (async (input: any) => {
      await input.fetchImpl("https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true");
      await input.fetchImpl("https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true");
      return {
        sourceStatus: "CERTIFIED",
        generatedAt: "2026-08-08T18:00:00.000Z",
        provenance: { status: "CERTIFIED", generatedAt: "2026-08-08T18:00:00.000Z" },
      } as any;
    }) as any,
  });

  const result = await service.review(777);
  assert.equal(result.homeRunsDelta, -0.25, "source alignment must not mutate engine numbers");
  assert.equal(result.awayRunsDelta, 0.15, "source alignment must not mutate engine numbers");
  assert.equal(result.sourceStatus, "CERTIFIED");
  assert.equal(result.generatedAt, "2026-08-08T18:00:00.000Z");

  const savant = seen.filter((url) => url.includes("baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats"));
  assert.equal(savant.length, 2);
  const batter = new URL(savant.find((url) => new URL(url).searchParams.get("type") === "batter")!);
  const pitcher = new URL(savant.find((url) => new URL(url).searchParams.get("type") === "pitcher")!);
  assert.equal(batter.searchParams.get("minPitches"), "1");
  assert.equal(pitcher.searchParams.get("minPitches"), "q");
});

test("successor middleware owns GET first but preserves non-GET fallthrough", async () => {
  const uses = new Map<string, any>();
  const app = { use(path: string, handler: any) { uses.set(path, handler); } } as unknown as Express;
  const calls: number[] = [];
  registerMlbStatcastCertifierSourceAlignmentMiddleware(app, {
    async review(gamePk: number) { calls.push(gamePk); return { sourceStatus: "DEGRADED" }; },
  });

  const handler = uses.get("/api/mlb/statcast-matchup/:gamePk");
  assert.ok(handler);
  let body: any = null;
  await handler(
    { method: "GET", params: { gamePk: "777" } },
    { status() { return this; }, json(value: any) { body = value; return value; } },
    () => { throw new Error("GET successor must not fall through"); },
  );
  assert.equal(body.sourceStatus, "DEGRADED");
  assert.deepEqual(calls, [777]);

  let fellThrough = false;
  await handler(
    { method: "POST", params: { gamePk: "777" } },
    { status() { return this; }, json(value: any) { return value; } },
    () => { fellThrough = true; },
  );
  assert.equal(fellThrough, true);
  assert.deepEqual(calls, [777]);
});
