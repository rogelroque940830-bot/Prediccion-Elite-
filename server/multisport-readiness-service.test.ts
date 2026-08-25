import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MultisportReadinessService } from "./multisport-readiness-service";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fixture(fetcher: (url: string) => Response | Promise<Response>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s6a-readiness-"));
  const service = new MultisportReadinessService({
    enabled: true,
    root,
    selfBaseUrl: "http://fixture",
    deploymentCommit: "test-sha",
    environment: "p0-integration",
    now: () => new Date("2026-07-30T21:00:00.000Z"),
    fetcher: async (input) => fetcher(String(input)),
  });
  return { root, service };
}

function supportPayload(url: string): Response {
  if (url.includes("/api/wnba/injuries")) return json({ success: true, data: [] });
  if (url.includes("/api/wnba/fatigue")) return json({ success: true, data: [{ teamId: 1 }] });
  if (url.includes("/api/wnba/sos")) return json({ success: true, data: [{ teamId: 1 }] });
  if (url.includes("/api/wnba/players")) return json({ success: true, data: [{ playerId: 1 }] });
  throw new Error(`Unexpected support URL ${url}`);
}

function nflEmptyPayload(url: string): Response {
  if (url.includes("/api/nfl/games")) return json({ success: true, data: [], source: "ESPN NFL scoreboard" });
  if (url.includes("/api/nfl/context")) {
    return json({ success: true, data: Array.from({ length: 32 }, (_, id) => ({ id: String(id + 1) })), source: "ESPN NFL team directory" });
  }
  if (url.includes("/api/nfl/elite/cards")) {
    return json({ success: true, data: { state: "NO_GAMES", cards: [] }, code: "NFL_ELITE_NO_GAMES" });
  }
  throw new Error(`Unexpected NFL URL ${url}`);
}

test("S6A classifies active NBA, degraded WNBA fallback, naturally empty NHL, and empty NFL", async () => {
  const { service } = fixture((url) => {
    if (url.includes("/api/nba/schedule")) return json({ success: true, data: [{ gameId: "nba-1" }] });
    if (url.includes("/api/nba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/nba")) return json({ success: true, games: [{ gameKey: "nba-1" }], source: "Hard Rock Bet" });
    if (url.includes("/api/wnba/games")) return json({ success: true, data: [{ gameId: "wnba-1" }] });
    if (url.includes("/api/wnba/all")) return json({ success: true, data: [{ teamId: 1 }], source: "production-readonly-fallback" });
    if (url.includes("/api/odds/wnba")) return json({ success: true, games: [{ gameKey: "wnba-1" }], source: "DraftKings" });
    if (url.includes("/api/wnba/")) return supportPayload(url);
    if (url.includes("/api/nhl/all")) return json({ success: true, data: { games: [], teams: [{ id: 1 }] } });
    if (url.includes("/api/odds/nhl")) return json({ success: true, games: [], source: "n/a" });
    if (url.includes("/api/nfl/")) return nflEmptyPayload(url);
    throw new Error(`Unexpected URL ${url}`);
  });

  const audit = await service.run("test-active");
  assert.equal(audit.sports.NBA.state, "READY");
  assert.equal(audit.sports.NBA.gamesScheduled, 1);
  assert.equal(audit.sports.WNBA.state, "DEGRADED");
  assert.equal(audit.sports.WNBA.degradedSources, 1);
  assert.equal(audit.sports.NHL.state, "NO_GAMES");
  assert.equal(audit.sports.NFL.state, "NO_GAMES");
  assert.equal(audit.summary.ready, 1);
  assert.equal(audit.summary.noGames, 2);
  assert.equal(audit.summary.degraded, 1);
  assert.equal(audit.summary.blocked, 0);
  assert.equal(audit.safety.predictionsCreated, 0);
  assert.equal(audit.safety.realFinancialExposure, 0);
});

test("S6A does not call an empty schedule an outage when odds are unavailable", async () => {
  const { service } = fixture((url) => {
    if (url.includes("/api/nba/schedule")) return json({ success: true, data: [] });
    if (url.includes("/api/nba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/nba")) return json({ success: false, error: "OUT_OF_USAGE_CREDITS", code: "OUT_OF_USAGE_CREDITS" });
    if (url.includes("/api/wnba/games")) return json({ success: true, data: [] });
    if (url.includes("/api/wnba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/wnba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/")) return supportPayload(url);
    if (url.includes("/api/nhl/all")) return json({ success: true, data: { games: [], teams: [{ id: 1 }] } });
    if (url.includes("/api/odds/nhl")) return json({ success: false, error: "quota unavailable" });
    if (url.includes("/api/nfl/")) return nflEmptyPayload(url);
    throw new Error(`Unexpected URL ${url}`);
  });

  const audit = await service.run("test-empty");
  assert.equal(audit.sports.NBA.state, "NO_GAMES");
  assert.equal(audit.sports.WNBA.state, "NO_GAMES");
  assert.equal(audit.sports.NHL.state, "NO_GAMES");
  assert.equal(audit.sports.NFL.state, "NO_GAMES");
  assert.equal(audit.summary.blocked, 0);
});

test("S6A blocks an active slate when a required provider fails", async () => {
  const { service } = fixture((url) => {
    if (url.includes("/api/nba/schedule")) return json({ success: true, data: [{ gameId: "nba-1" }] });
    if (url.includes("/api/nba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/nba")) return json({ success: false, error: "quota exhausted", code: "OUT_OF_USAGE_CREDITS" });
    if (url.includes("/api/wnba/games")) return json({ success: true, data: [] });
    if (url.includes("/api/wnba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/wnba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/")) return supportPayload(url);
    if (url.includes("/api/nhl/all")) return json({ success: true, data: { games: [], teams: [{ id: 1 }] } });
    if (url.includes("/api/odds/nhl")) return json({ success: true, games: [] });
    if (url.includes("/api/nfl/")) return nflEmptyPayload(url);
    throw new Error(`Unexpected URL ${url}`);
  });

  const audit = await service.run("test-provider-failure");
  assert.equal(audit.sports.NBA.state, "BLOCKED");
  assert.equal(audit.sports.NBA.failedSources, 1);
  assert.match(audit.sports.NBA.reasons.join(" "), /quota exhausted/i);
});

test("S6A deduplicates unchanged material snapshots", async () => {
  const { service } = fixture((url) => {
    if (url.includes("/api/nba/schedule")) return json({ success: true, data: [] });
    if (url.includes("/api/nba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/nba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/games")) return json({ success: true, data: [] });
    if (url.includes("/api/wnba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/wnba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/")) return supportPayload(url);
    if (url.includes("/api/nhl/all")) return json({ success: true, data: { games: [], teams: [{ id: 1 }] } });
    if (url.includes("/api/odds/nhl")) return json({ success: true, games: [] });
    if (url.includes("/api/nfl/")) return nflEmptyPayload(url);
    throw new Error(`Unexpected URL ${url}`);
  });

  const first = await service.run("first");
  const second = await service.run("second");
  assert.equal(first.snapshotCreated, true);
  assert.equal(second.snapshotCreated, false);
  assert.equal(service.status().snapshots, 1);
});

test("S6A marks an active NFL slate READY from schedule, context, and certified Elite cards without requiring NFL odds", async () => {
  const urls: string[] = [];
  const { service } = fixture((url) => {
    urls.push(url);
    if (url.includes("/api/nba/schedule")) return json({ success: true, data: [] });
    if (url.includes("/api/nba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/nba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/games")) return json({ success: true, data: [] });
    if (url.includes("/api/wnba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/wnba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/")) return supportPayload(url);
    if (url.includes("/api/nhl/all")) return json({ success: true, data: { games: [], teams: [{ id: 1 }] } });
    if (url.includes("/api/odds/nhl")) return json({ success: true, games: [] });
    if (url.includes("/api/nfl/games")) return json({ success: true, data: [{ gameId: "nfl-1" }], source: "ESPN NFL scoreboard" });
    if (url.includes("/api/nfl/context")) return nflEmptyPayload(url);
    if (url.includes("/api/nfl/elite/cards")) return json({ success: true, data: { state: "READY", cards: [{ gameId: "nfl-1" }] }, code: "NFL_ELITE_CARDS_READY" });
    throw new Error(`Unexpected URL ${url}`);
  });

  const audit = await service.run("test-nfl-active");
  assert.equal(audit.sports.NFL.state, "READY");
  assert.equal(audit.sports.NFL.gamesScheduled, 1);
  assert.equal(audit.sports.NFL.requiredTotal, 3);
  assert.equal(audit.sports.NFL.requiredHealthy, 3);
  assert.equal(urls.some((url) => url.includes("/api/odds/nfl")), false);
  assert.match(audit.sports.NFL.reasons.join(" "), /model and context sources/i);
});

test("S6A blocks an active NFL slate when the certified Elite operational route fails closed", async () => {
  const { service } = fixture((url) => {
    if (url.includes("/api/nba/schedule")) return json({ success: true, data: [] });
    if (url.includes("/api/nba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/nba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/games")) return json({ success: true, data: [] });
    if (url.includes("/api/wnba/all")) return json({ success: true, data: [{ teamId: 1 }] });
    if (url.includes("/api/odds/wnba")) return json({ success: true, games: [] });
    if (url.includes("/api/wnba/")) return supportPayload(url);
    if (url.includes("/api/nhl/all")) return json({ success: true, data: { games: [], teams: [{ id: 1 }] } });
    if (url.includes("/api/odds/nhl")) return json({ success: true, games: [] });
    if (url.includes("/api/nfl/games")) return json({ success: true, data: [{ gameId: "nfl-1" }] });
    if (url.includes("/api/nfl/context")) return nflEmptyPayload(url);
    if (url.includes("/api/nfl/elite/cards")) return json({ success: false, error: "NFL Elite gate blocked", code: "NFL_ELITE_CARDS_BLOCKED" }, 503);
    throw new Error(`Unexpected URL ${url}`);
  });

  const audit = await service.run("test-nfl-blocked");
  assert.equal(audit.sports.NFL.state, "BLOCKED");
  assert.equal(audit.sports.NFL.failedSources, 1);
  assert.match(audit.sports.NFL.reasons.join(" "), /NFL Elite gate blocked/i);
});
