import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbP1M2bPregameReadiness } from "./mlb-p1-pregame-readiness-service";

const NOW = new Date("2026-08-07T20:00:00.000Z");
const GAME_PK = 765432;
const DATE = "2026-08-07";
const BASE = "http://internal.test";
const ADVANCED_PATHS = [
  "/api/mlb/quality/",
  "/api/mlb/statcast-matchup/",
  "/api/mlb/discipline-speed/",
  "/api/mlb/sos/",
  "/api/mlb/advanced/",
] as const;

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
        startTime: "2026-08-08T00:10:00.000Z",
        state: "PREGAME",
        detailedState: "Warmup",
        homeTeam: { id: 112, name: "Chicago Cubs" },
        awayTeam: { id: 116, name: "Detroit Tigers" },
        homePitcher: { id: 11, name: "Home Starter", hand: "R", confirmed: true },
        awayPitcher: { id: 22, name: "Away Starter", hand: "L", confirmed: true },
        lineupState: "CONFIRMED",
        homeLineupCount: 9,
        awayLineupCount: 9,
        source: { fetchedAt: NOW.toISOString(), quality: "AUTHORITATIVE" },
      }],
    },
  };
}

function analysisPayload() {
  const injury = {
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
      homeInjuryData: injury,
      awayInjuryData: injury,
    }],
  };
}

function manualMlOdds() {
  return {
    mode: "MANUAL" as const,
    book: "Hard Rock",
    capturedAt: NOW.toISOString(),
    homeOdds: -115,
    awayOdds: -105,
  };
}

interface ComponentOverride {
  path: string;
  generatedAt?: string | null;
  sourceStatus?: string | null;
}

function mockFetch(overrides: ComponentOverride[] = []) {
  return async (url: string): Promise<Response> => {
    if (url.includes("/api/mlb/p1/v1/slate")) return json(slate());
    if (url.includes("/api/mlb/all")) return json(analysisPayload());
    if (url.includes("/api/mlb/bullpen-status/")) {
      return json({
        sourceStatus: "CERTIFIED",
        generatedAt: NOW.toISOString(),
        provenance: { schemaVersion: "courtedge-mlb-bullpen-evidence.v1", sourceStatus: "CERTIFIED" },
        home: {},
        away: {},
      });
    }
    const path = ADVANCED_PATHS.find((candidate) => url.includes(candidate));
    if (path) {
      const override = overrides.find((item) => item.path === path);
      const generatedAt = override?.generatedAt === undefined ? NOW.toISOString() : override.generatedAt;
      const sourceStatus = override?.sourceStatus === undefined ? "CERTIFIED" : override.sourceStatus;
      const payload: Record<string, unknown> = {
        success: true,
        sourceStatus,
        provenance: {
          schemaVersion: "courtedge-mlb-advanced-factor-evidence.test.v1",
          sourceStatus,
        },
        data: { preservedModelOutput: true },
      };
      if (generatedAt) {
        payload.generatedAt = generatedAt;
        (payload.provenance as Record<string, unknown>).generatedAt = generatedAt;
      }
      return json(payload);
    }
    return json({ error: `unexpected ${url}` }, 404);
  };
}

async function build(overrides: ComponentOverride[] = []) {
  return buildMlbP1M2bPregameReadiness({
    gamePk: GAME_PK,
    market: "ML",
    dateHint: DATE,
    manualOdds: manualMlOdds(),
    fetchImpl: mockFetch(overrides),
    baseUrl: BASE,
    now: NOW,
  });
}

function advanced(report: Awaited<ReturnType<typeof buildMlbP1M2bPregameReadiness>>) {
  const item = report.evidence.find((candidate) => candidate.field === "ADVANCED_FACTORS");
  assert.ok(item, "ADVANCED_FACTORS evidence missing");
  return item;
}

test("five individually certified advanced components can support FINAL and use the oldest component time", async () => {
  const oldest = "2026-08-07T18:30:00.000Z";
  const report = await build([{ path: "/api/mlb/statcast-matchup/", generatedAt: oldest }]);
  const item = advanced(report);

  assert.equal(item.state, "FRESH");
  assert.equal(item.observedAt, oldest);
  assert.equal(item.maxAgeSeconds, 21_600);
  assert.equal(item.quality, "CERTIFIED_COMPONENT_SET");
  assert.equal(report.gate.status, "READY_FINAL");
  assert.equal(report.gate.analysisStage, "FINAL");
});

test("one untimed advanced component cannot hide behind four fresh timestamps", async () => {
  const report = await build([{ path: "/api/mlb/sos/", generatedAt: null }]);
  const item = advanced(report);

  assert.equal(item.state, "DEGRADED");
  assert.equal(item.quality, "ADVANCED_COMPONENT_WITHOUT_EXPLICIT_TIMESTAMP");
  assert.equal(report.gate.status, "READY_PROVISIONAL");
  assert.match(item.errors.join(","), /ADVANCED_COMPONENT_UNTIMED/);
});

test("one stale advanced component makes the aggregate stale instead of using a newer sibling", async () => {
  const stale = "2026-08-07T13:00:00.000Z";
  const report = await build([{ path: "/api/mlb/quality/", generatedAt: stale }]);
  const item = advanced(report);

  assert.equal(item.observedAt, stale);
  assert.equal(item.maxAgeSeconds, 21_600);
  assert.equal(item.state, "STALE");
  assert.equal(item.quality, "CERTIFIED_COMPONENT_SET_STALE");
  assert.equal(report.gate.status, "READY_PROVISIONAL");
});

test("a timestamp alone cannot certify an advanced component", async () => {
  const report = await build([{ path: "/api/mlb/discipline-speed/", sourceStatus: "DEGRADED" }]);
  const item = advanced(report);

  assert.equal(item.state, "DEGRADED");
  assert.equal(item.quality, "ADVANCED_COMPONENT_NOT_CERTIFIED");
  assert.equal(report.gate.status, "READY_PROVISIONAL");
  assert.match(item.errors.join(","), /ADVANCED_COMPONENT_UNCERTIFIED/);
});

test("advanced detailed factors do not inherit the 600-second aggregate /api/mlb/all freshness bound", async () => {
  const thirteenMinutesOld = "2026-08-07T19:47:00.000Z";
  const report = await build(ADVANCED_PATHS.map((path) => ({ path, generatedAt: thirteenMinutesOld })));
  const item = advanced(report);

  assert.equal(item.maxAgeSeconds, 21_600);
  assert.equal(item.state, "FRESH");
  assert.equal(report.gate.status, "READY_FINAL");
});
