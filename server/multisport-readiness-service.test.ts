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

test("S6A classifies active NBA, degraded WNBA fallback, and naturally empty NHL", async () => {
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
    throw new Error(`Unexpected URL ${url}`);
  });

  const audit = await service.run("test-active");
  assert.equal(audit.sports.NBA.state, "READY");
  assert.equal(audit.sports.NBA.gamesScheduled, 1);
  assert.equal(audit.sports.WNBA.state, "DEGRADED");
  assert.equal(audit.sports.WNBA.degradedSources, 1);
  assert.equal(audit.sports.NHL.state, "NO_GAMES");
  assert.equal(audit.summary.ready, 1);
  assert.equal(audit.summary.noGames, 1);
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
    throw new Error(`Unexpected URL ${url}`);
  });

  const audit = await service.run("test-empty");
  assert.equal(audit.sports.NBA.state, "NO_GAMES");
  assert.equal(audit.sports.WNBA.state, "NO_GAMES");
  assert.equal(audit.sports.NHL.state, "NO_GAMES");
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
    throw new Error(`Unexpected URL ${url}`);
  });

  const first = await service.run("first");
  const second = await service.run("second");
  assert.equal(first.snapshotCreated, true);
  assert.equal(second.snapshotCreated, false);
  assert.equal(service.status().snapshots, 1);
});
