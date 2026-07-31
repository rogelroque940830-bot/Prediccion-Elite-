import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WnbaShadowService } from "./wnba-s6c-shadow-service";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture() {
  let now = new Date("2026-07-30T21:00:00.000Z");
  let homeOdds = 120;
  let awayOdds = -140;
  let finalScore: { home: number; away: number } | null = null;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wnba-s6c-"));

  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/api/wnba/games")) {
      return json({
        success: true,
        source: "espn-readonly-fallback",
        data: [{
          gameId: "401000001",
          gameTimeUTC: "2026-07-30T23:00:00.000Z",
          homeTeam: { id: 1, name: "New York Liberty", tricode: "NYL" },
          awayTeam: { id: 2, name: "Los Angeles Sparks", tricode: "LAS" },
        }],
      });
    }
    if (url.includes("/api/odds/wnba")) {
      return json({
        success: true,
        source: "Hard Rock Bet",
        games: [{
          homeTeam: "New York Liberty",
          awayTeam: "Los Angeles Sparks",
          commence: "2026-07-30T23:00:00.000Z",
          source: "Hard Rock Bet",
          ml: { home: homeOdds, away: awayOdds },
        }],
      });
    }
    if (url.endsWith("/api/wnba/all")) {
      return json({ success: true, source: "production-readonly-fallback", data: [
        { teamId: 1, teamName: "New York Liberty", netRtg: 8, offRtg: 112, defRtg: 104, pace: 97, recentNetRtg: 9, recentOffRtg: 114, recentDefRtg: 105, recentPace: 98, winPct: 0.75, recentWinPct: 0.8 },
        { teamId: 2, teamName: "Los Angeles Sparks", netRtg: -4, offRtg: 102, defRtg: 106, pace: 99, recentNetRtg: -2, recentOffRtg: 104, recentDefRtg: 106, recentPace: 100, winPct: 0.4, recentWinPct: 0.5 },
      ] });
    }
    if (url.endsWith("/api/wnba/fatigue")) {
      return json({ success: true, source: "integration-local-cache", data: [
        { teamId: 1, daysRest: 2, isB2B: false, b2bWasRoad: false, gamesLast7Days: 2, streak: 3 },
        { teamId: 2, daysRest: 1, isB2B: false, b2bWasRoad: false, gamesLast7Days: 3, streak: -1 },
      ] });
    }
    if (url.endsWith("/api/wnba/sos")) {
      return json({ success: true, source: "production-readonly-fallback", data: [
        { teamId: 1, oppAvgNetRtg: 1.2, sosLabel: "Agenda promedio" },
        { teamId: 2, oppAvgNetRtg: 3.1, sosLabel: "Agenda dificil" },
      ] });
    }
    if (url.endsWith("/api/wnba/players")) {
      return json({ success: true, source: "production-readonly-fallback", data: {
        "1": [{ playerId: 11, name: "Liberty Star", min: 31, ppg: 21, apg: 5, rpg: 6 }],
        "2": [{ playerId: 22, name: "Sparks Star", min: 30, ppg: 19, apg: 4, rpg: 5 }],
      } });
    }
    if (url.endsWith("/api/wnba/injuries")) {
      return json({ success: true, data: [
        { teamName: "New York Liberty", injuries: [] },
        { teamName: "Los Angeles Sparks", injuries: [{ name: "Bench Player", statusDesc: "Questionable", severityTier: "QUESTIONABLE", daysOut: 1 }] },
      ] });
    }
    if (url.includes("site.api.espn.com")) {
      if (!finalScore) return json({ events: [] });
      return json({ events: [{
        id: "401000001",
        competitions: [{
          id: "401000001",
          status: { type: { completed: true, state: "post" } },
          competitors: [
            { homeAway: "home", score: String(finalScore.home), team: { displayName: "New York Liberty" } },
            { homeAway: "away", score: String(finalScore.away), team: { displayName: "Los Angeles Sparks" } },
          ],
        }],
      }] });
    }
    return json({ success: false, error: `Unhandled test URL: ${url}` }, 500);
  };

  const service = new WnbaShadowService({
    enabled: true,
    root,
    selfBaseUrl: "http://test.local",
    deploymentCommit: "test-sha",
    environment: "p0-integration",
    intervalMs: 300_000,
    initialDelayMs: 10_000,
    finalWindowMinutes: 45,
    settlementLookbackDays: 2,
    now: () => new Date(now),
    fetcher: fetcher as typeof fetch,
  });

  return {
    root,
    service,
    setNow(value: string) { now = new Date(value); },
    setOdds(home: number, away: number) { homeOdds = home; awayOdds = away; },
    setFinal(home: number, away: number) { finalScore = { home, away }; },
  };
}

test("S6C captures a zero-stake provisional market baseline and deduplicates identical retries", async () => {
  const f = fixture();
  try {
    const first = await f.service.run("test");
    assert.equal(first.recordsCreated, 1);
    assert.equal(first.provisionalCreated, 1);
    assert.equal(first.finalCreated, 0);
    assert.equal(first.safety.realFinancialExposure, 0);

    const records = f.service.readRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].analysisStage, "PROVISIONAL");
    assert.equal(records[0].decision.signal, "OBSERVE");
    assert.equal(records[0].decision.stakeUnits, 0);
    assert.equal(records[0].baseline.edgePp, 0);
    assert.equal(round(records[0].baseline.homeWinProbability + records[0].baseline.awayWinProbability), 1);
    assert.ok(records[0].context.degradedSources.length >= 1);

    const second = await f.service.run("retry");
    assert.equal(second.recordsCreated, 0);
    assert.equal(second.idempotentRecords, 1);
    assert.equal(f.service.readRecords().length, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("S6C appends an immutable superseding revision when market evidence changes", async () => {
  const f = fixture();
  try {
    await f.service.run("opening");
    f.setOdds(105, -125);
    const changed = await f.service.run("market-change");
    assert.equal(changed.recordsCreated, 1);
    const records = f.service.readRecords();
    assert.equal(records.length, 2);
    assert.equal(records[1].supersedesId, records[0].id);
    assert.notEqual(records[1].fingerprint, records[0].fingerprint);
    assert.equal(f.service.buildReport().terminalGames, 1);
    assert.equal(f.service.buildReport().supersededRecords, 1);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("S6C creates a FINAL revision inside the configured pregame window", async () => {
  const f = fixture();
  try {
    await f.service.run("opening");
    f.setNow("2026-07-30T22:30:00.000Z");
    const final = await f.service.run("final-window");
    assert.equal(final.finalCreated, 1);
    const records = f.service.readRecords();
    assert.equal(records.length, 2);
    assert.equal(records[1].analysisStage, "FINAL");
    assert.equal(records[1].supersedesId, records[0].id);
    assert.equal(f.service.buildReport().finalCoveragePct, 100);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("S6C settles the terminal record from an official final score and calculates proper scores", async () => {
  const f = fixture();
  try {
    await f.service.run("opening");
    f.setNow("2026-07-30T22:30:00.000Z");
    await f.service.run("final-window");
    f.setNow("2026-07-31T01:00:00.000Z");
    f.setFinal(88, 80);
    const settled = await f.service.run("settlement");
    assert.equal(settled.settlementsCreated, 1);
    const events = f.service.readSettlements();
    assert.equal(events.length, 1);
    assert.equal(events[0].result, "HOME_WIN");
    assert.ok(events[0].brierScore >= 0);
    assert.ok(events[0].logLoss > 0);
    const report = f.service.buildReport();
    assert.equal(report.settled, 1);
    assert.equal(report.pending, 0);
    assert.equal(report.settlementCoveragePct, 100);
    assert.notEqual(report.averageBrierScore, null);
    assert.notEqual(report.averageLogLoss, null);
    assert.equal(report.safety.realFinancialExposure, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
