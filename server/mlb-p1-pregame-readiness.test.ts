import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M2B_SCHEMA,
  buildMlbP1M2bPregameReadiness,
  validateMlbP1M2bManualOdds,
} from "./mlb-p1-pregame-readiness-service";

const NOW = new Date("2026-08-05T15:00:00.000Z");
const GAME_PK = 123456;
const DATE = "2026-08-05";
const BASE = "http://internal.test";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function slate(options: {
  state?: string;
  pitchers?: boolean;
  lineupState?: string;
  homeLineupCount?: number;
  awayLineupCount?: number;
} = {}) {
  return {
    success: true,
    data: {
      schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
      date: DATE,
      generatedAt: NOW.toISOString(),
      games: [{
        gamePk: GAME_PK,
        officialDate: DATE,
        startTime: "2026-08-05T23:10:00.000Z",
        state: options.state ?? "SCHEDULED",
        detailedState: options.state ?? "Scheduled",
        homeTeam: { id: 112, name: "Chicago Cubs" },
        awayTeam: { id: 116, name: "Detroit Tigers" },
        homePitcher: options.pitchers === false
          ? { id: null, name: null, hand: null, confirmed: false }
          : { id: 11, name: "Home Starter", hand: "R", confirmed: true },
        awayPitcher: { id: 22, name: "Away Starter", hand: "L", confirmed: true },
        lineupState: options.lineupState ?? "CONFIRMED",
        homeLineupCount: options.homeLineupCount ?? 9,
        awayLineupCount: options.awayLineupCount ?? 9,
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
  const feed = {
    status: "VERIFIED",
    fetchedAt: NOW.toISOString(),
    stale: false,
    count: 2,
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
      homeInjuryData: feed,
      awayInjuryData: feed,
    }],
  };
}

function manualOdds(capturedAt = NOW.toISOString()) {
  return {
    mode: "MANUAL" as const,
    book: "Hard Rock",
    capturedAt,
    homeOdds: -115,
    awayOdds: -105,
  };
}

function mockFetch(options: {
  slatePayload?: any;
  factorTimestamp?: boolean;
  failLineup?: boolean;
} = {}) {
  return async (url: string): Promise<Response> => {
    if (url.includes("/api/mlb/p1/v1/slate")) return json(options.slatePayload ?? slate());
    if (url.includes("/api/mlb/all")) return json(analysisPayload());
    if (url.includes("/api/mlb/pitcher-form/")) {
      return json(options.factorTimestamp ? { generatedAt: NOW.toISOString(), home: {}, away: {} } : { home: {}, away: {} });
    }
    if (url.includes("/api/mlb/pitcher-recent/")) {
      return json(options.factorTimestamp ? { generatedAt: NOW.toISOString(), home: {}, away: {} } : { home: {}, away: {} });
    }
    if (url.includes("/api/mlb/lineup-matchup/")) {
      if (options.failLineup) return json({ error: "unavailable" }, 503);
      return json(options.factorTimestamp ? { generatedAt: NOW.toISOString(), home: [], away: [] } : { home: [], away: [] });
    }
    return json({ error: `unexpected ${url}` }, 404);
  };
}

test("manual odds validation is market-aware", () => {
  assert.deepEqual(validateMlbP1M2bManualOdds("F5_ML", manualOdds()), []);
  assert.deepEqual(
    validateMlbP1M2bManualOdds("F5_TOTAL", {
      mode: "MANUAL",
      book: "Hard Rock",
      capturedAt: NOW.toISOString(),
      line: 4.5,
      overOdds: -110,
      underOdds: -110,
    }),
    [],
  );
  assert.match(
    validateMlbP1M2bManualOdds("RUN_LINE", {
      mode: "MANUAL",
      book: "",
      capturedAt: "invalid",
    }).join(","),
    /MANUAL_BOOK_REQUIRED/,
  );
});

test("returns READY_FINAL when all F5 ML evidence is fresh and explicit", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "F5_ML",
    dateHint: DATE,
    manualOdds: manualOdds(),
    fetchImpl: mockFetch({ factorTimestamp: true }),
    baseUrl: BASE,
    now: NOW,
  });

  assert.equal(report.schemaVersion, MLB_P1_M2B_SCHEMA);
  assert.equal(report.gate.status, "READY_FINAL");
  assert.equal(report.gate.analysisStage, "FINAL");
  assert.equal(report.summary.degraded, 0);
  assert.equal(report.summary.missing, 0);
  assert.equal(report.safety.realFinancialExposure, 0);
});

test("successful untimed factor endpoints are visible as degraded and only provisional", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "F5_ML",
    dateHint: DATE,
    manualOdds: manualOdds(),
    fetchImpl: mockFetch({ factorTimestamp: false }),
    baseUrl: BASE,
    now: NOW,
  });

  assert.equal(report.gate.status, "READY_PROVISIONAL");
  assert.equal(report.gate.analysisAllowed, true);
  assert.equal(report.evidence.find((item) => item.field === "PITCHER_FORM")?.state, "DEGRADED");
  assert.equal(report.evidence.find((item) => item.field === "LINEUP_MATCHUP")?.state, "DEGRADED");
  assert.match(report.warnings.join(","), /PITCHER_FORM_DEGRADED/);
});

test("stale manual odds are a hard blocker", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "F5_ML",
    dateHint: DATE,
    manualOdds: manualOdds("2026-08-05T14:40:00.000Z"),
    fetchImpl: mockFetch({ factorTimestamp: true }),
    baseUrl: BASE,
    now: NOW,
  });

  assert.equal(report.gate.status, "BLOCKED");
  assert.equal(report.gate.analysisAllowed, false);
  assert.match(report.gate.blockers.join(","), /MARKET_ODDS_STALE/);
});

test("missing probable pitcher blocks before prediction", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "F5_ML",
    dateHint: DATE,
    manualOdds: manualOdds(),
    fetchImpl: mockFetch({
      factorTimestamp: true,
      slatePayload: slate({ pitchers: false }),
    }),
    baseUrl: BASE,
    now: NOW,
  });

  assert.equal(report.gate.status, "BLOCKED");
  assert.match(report.gate.blockers.join(","), /PITCHERS_MISSING/);
});

test("started game is blocked even when every source is fresh", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "F5_ML",
    dateHint: DATE,
    manualOdds: manualOdds(),
    fetchImpl: mockFetch({
      factorTimestamp: true,
      slatePayload: slate({ state: "IN_PROGRESS" }),
    }),
    baseUrl: BASE,
    now: NOW,
  });

  assert.equal(report.game.state, "IN_PROGRESS");
  assert.equal(report.gate.status, "BLOCKED");
  assert.match(report.gate.blockers.join(","), /GAME_STATE_IN_PROGRESS/);
});

test("partial source failure is surfaced instead of silently becoming zero impact", async () => {
  const report = await buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "F5_ML",
    dateHint: DATE,
    manualOdds: manualOdds(),
    fetchImpl: mockFetch({ factorTimestamp: true, failLineup: true }),
    baseUrl: BASE,
    now: NOW,
  });

  const lineup = report.evidence.find((item) => item.field === "LINEUP_MATCHUP");
  assert.equal(lineup?.state, "MISSING");
  assert.equal(report.gate.status, "READY_PROVISIONAL");
  assert.match(lineup?.errors.join(",") ?? "", /unavailable/);
});
