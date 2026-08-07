import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbP1M2bPregameReadiness } from "./mlb-p1-pregame-readiness-service";

const NOW = new Date("2026-08-07T16:00:00.000Z");
const GAME_PK = 888001;
const DATE = "2026-08-07";
const BASE = "http://internal.test";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function slate() {
  return {
    success: true,
    data: {
      schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
      date: DATE,
      generatedAt: NOW.toISOString(),
      games: [{
        gamePk: GAME_PK,
        officialDate: DATE,
        startTime: "2026-08-07T23:10:00.000Z",
        state: "SCHEDULED",
        detailedState: "Scheduled",
        homeTeam: { id: 112, name: "Chicago Cubs" },
        awayTeam: { id: 116, name: "Detroit Tigers" },
        homePitcher: { id: 11, name: "Home Starter", hand: "R", confirmed: true },
        awayPitcher: { id: 22, name: "Away Starter", hand: "L", confirmed: true },
        lineupState: "CONFIRMED",
        homeLineupCount: 9,
        awayLineupCount: 9,
        source: {
          name: "MLB_STATS_API",
          fetchedAt: NOW.toISOString(),
          quality: "AUTHORITATIVE",
        },
      }],
    },
  };
}

function analysisPayload() {
  const injuryFeed = {
    status: "VERIFIED",
    fetchedAt: NOW.toISOString(),
    stale: false,
    count: 0,
    officialValidationStatus: "VERIFIED",
    sourceErrors: [],
  };
  return {
    games: [{
      gameId: GAME_PK,
      homeTeam: { name: "Chicago Cubs", tricode: "CHC" },
      awayTeam: { name: "Detroit Tigers", tricode: "DET" },
      homeInjuries: [],
      awayInjuries: [],
      homeInjuryData: injuryFeed,
      awayInjuryData: injuryFeed,
    }],
  };
}

function manualOdds() {
  return {
    mode: "MANUAL" as const,
    book: "Hard Rock",
    capturedAt: NOW.toISOString(),
    homeOdds: -115,
    awayOdds: -105,
  };
}

function mockFetch(options: { timedBullpen: boolean }) {
  return async (url: string): Promise<Response> => {
    if (url.includes("/api/mlb/p1/v1/slate")) return json(slate());
    if (url.includes("/api/mlb/all")) return json(analysisPayload());
    if (url.includes("/api/mlb/bullpen-status/")) {
      return json(options.timedBullpen
        ? {
            home: { sourceStatus: "CERTIFIED", generatedAt: NOW.toISOString() },
            away: { sourceStatus: "CERTIFIED", generatedAt: NOW.toISOString() },
          }
        : { home: {}, away: {} });
    }
    if (
      url.includes("/api/mlb/quality/")
      || url.includes("/api/mlb/statcast-matchup/")
      || url.includes("/api/mlb/discipline-speed/")
      || url.includes("/api/mlb/sos/")
      || url.includes("/api/mlb/advanced/")
    ) {
      return json({ success: true, generatedAt: NOW.toISOString() });
    }
    return json({ error: `unexpected ${url}` }, 404);
  };
}

test("certified timed bullpen evidence removes the structural ML FINAL blocker", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "ML",
    dateHint: DATE,
    manualOdds: manualOdds(),
    fetchImpl: mockFetch({ timedBullpen: true }),
    baseUrl: BASE,
    now: NOW,
  });

  const bullpen = report.evidence.find((item) => item.field === "BULLPEN");
  assert.equal(bullpen?.state, "FRESH");
  assert.equal(bullpen?.observedAt, NOW.toISOString());
  assert.equal(bullpen?.quality, "DERIVED_EXPLICIT_TIMESTAMP");
  assert.equal(report.gate.status, "READY_FINAL");
  assert.equal(report.gate.analysisStage, "FINAL");
  assert.equal(report.warnings.includes("BULLPEN_DEGRADED"), false);
});

test("untimed bullpen evidence remains provisional; the readiness gate is not relaxed", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "ML",
    dateHint: DATE,
    manualOdds: manualOdds(),
    fetchImpl: mockFetch({ timedBullpen: false }),
    baseUrl: BASE,
    now: NOW,
  });

  const bullpen = report.evidence.find((item) => item.field === "BULLPEN");
  assert.equal(bullpen?.state, "DEGRADED");
  assert.equal(bullpen?.observedAt, null);
  assert.equal(bullpen?.quality, "DERIVED_WITHOUT_EXPLICIT_TIMESTAMP");
  assert.equal(report.gate.status, "READY_PROVISIONAL");
  assert.equal(report.warnings.includes("BULLPEN_DEGRADED"), true);
});
