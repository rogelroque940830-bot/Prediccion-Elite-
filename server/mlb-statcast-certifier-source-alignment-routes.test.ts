import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import {
  createStatcastCertifierSourceAlignedFetch,
  createStatcastCertifierSourceAlignedRouteService,
  maskInclusiveBatterCsvForQualifiedTeamProxy,
  registerMlbStatcastCertifierSourceAlignmentMiddleware,
  rewriteStatcastCertifierSavantUrl,
} from "./mlb-statcast-certifier-source-alignment-routes";

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function response(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": typeof body === "string" ? "text/csv; charset=utf-8" : "application/json" },
  });
}

const CSV_HEADER = "player_id,team_name_alt,pitch_type,pitches,pa,est_woba,woba,whiff_percent,run_value_per_100";
const INCLUSIVE_CSV = [
  CSV_HEADER,
  "101,AAA,FF,120,55,0.301,0.294,22.1,1.2",
  "202,AAA,FF,42,21,0.322,0.315,19.8,0.8",
  "303,BBB,SL,35,18,0.280,0.275,30.0,-0.4",
].join("\n") + "\n";
const QUALIFIED_CSV = [
  CSV_HEADER,
  "101,AAA,FF,120,55,0.301,0.294,22.1,1.2",
].join("\n") + "\n";

function csvRows(csv: string): string[][] {
  return csv.trim().split(/\r?\n/).slice(1).map((line) => line.split(","));
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

test("explicit Qualified batter rewrite uses the same official source constructor", () => {
  const legacy = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true";
  const rewritten = new URL(rewriteStatcastCertifierSavantUrl(legacy, "QUALIFIED"));
  assert.equal(rewritten.searchParams.get("type"), "batter");
  assert.equal(rewritten.searchParams.get("min"), "1");
  assert.equal(rewritten.searchParams.get("minPitches"), "q");
});

test("legacy pitcher Savant request is rewritten to the shared Qualified official source", () => {
  const legacy = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true";
  const rewritten = new URL(rewriteStatcastCertifierSavantUrl(legacy));

  assert.equal(rewritten.searchParams.get("type"), "pitcher");
  assert.equal(rewritten.searchParams.get("min"), "1");
  assert.equal(rewritten.searchParams.get("minPitches"), "q");
  assert.equal(rewritten.searchParams.get("pitchType"), "");
});

test("Inclusive-only batter rows remain available for DIRECT but lose TEAM_PROXY eligibility", () => {
  const masked = maskInclusiveBatterCsvForQualifiedTeamProxy(INCLUSIVE_CSV, QUALIFIED_CSV);
  const rows = csvRows(masked);
  assert.equal(rows.length, 3, "Inclusive rows must remain present for DIRECT evidence");
  assert.equal(rows[0][0], "101");
  assert.equal(rows[0][1], "AAA", "Qualified overlap must preserve team eligibility");
  assert.equal(rows[1][0], "202");
  assert.equal(rows[1][1], "", "Inclusive-only row must be excluded from TEAM_PROXY aggregation");
  assert.equal(rows[1][5], "0.322", "masking eligibility must not mutate xwOBA");
  assert.equal(rows[2][0], "303");
  assert.equal(rows[2][1], "", "every Inclusive-only row must lose team eligibility");
});

test("aligned batter fetch retrieves Inclusive and Qualified sources then returns a masked Inclusive CSV", async () => {
  const seen: string[] = [];
  const aligned = createStatcastCertifierSourceAlignedFetch(async (input) => {
    const url = urlOf(input);
    seen.push(url);
    const parsed = new URL(url);
    return response(parsed.searchParams.get("minPitches") === "q" ? QUALIFIED_CSV : INCLUSIVE_CSV);
  });

  const legacy = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true";
  const result = await aligned(legacy);
  assert.equal(result.ok, true);
  const rows = csvRows(await result.text());
  assert.equal(rows.length, 3);
  assert.equal(rows[0][1], "AAA");
  assert.equal(rows[1][1], "");
  assert.equal(rows[2][1], "");

  const savant = seen.map((url) => new URL(url));
  assert.equal(savant.length, 2);
  assert.deepEqual(savant.map((url) => url.searchParams.get("minPitches")).sort(), ["1", "q"]);
});

test("Qualified batter source failure fails closed instead of treating Inclusive-only rows as proxy eligible", async () => {
  const aligned = createStatcastCertifierSourceAlignedFetch(async (input) => {
    const parsed = new URL(urlOf(input));
    return parsed.searchParams.get("minPitches") === "q"
      ? response("qualified unavailable", 503)
      : response(INCLUSIVE_CSV);
  });
  const legacy = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&year=2026";
  const result = await aligned(legacy);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
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

test("route service gives the unchanged strict certifier split Savant semantics without mutating engine numbers", async () => {
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
    if (url.includes("baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats")) {
      const parsed = new URL(url);
      if (parsed.searchParams.get("type") === "pitcher") return response(QUALIFIED_CSV);
      return response(parsed.searchParams.get("minPitches") === "q" ? QUALIFIED_CSV : INCLUSIVE_CSV);
    }
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
      const batterResponse = await input.fetchImpl("https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitch_type=ALL&min_pa=q&min_pitches=q&year=2026&team=&csv=true");
      const batterRows = csvRows(await batterResponse.text());
      assert.equal(batterRows[0][1], "AAA");
      assert.equal(batterRows[1][1], "");
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
  assert.equal(savant.length, 3, "one batter certifier call becomes Inclusive + Qualified, pitcher remains one Qualified call");
  const minPitches = savant.map((url) => new URL(url).searchParams.get("minPitches"));
  assert.equal(minPitches.filter((value) => value === "1").length, 1);
  assert.equal(minPitches.filter((value) => value === "q").length, 2);
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
