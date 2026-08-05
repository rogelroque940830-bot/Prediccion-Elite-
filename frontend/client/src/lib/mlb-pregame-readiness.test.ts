import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M2A_CONTRACT_SCHEMA,
  MLB_P1_M2B_READINESS_SCHEMA,
  buildMlbPregameManualOddsParams,
  buildMlbPregameReadinessUrl,
  mlbPregameSafetyValid,
  toMlbPregameGateSnapshot,
  type MlbPregameLineInputs,
  type MlbPregameReadinessReport,
} from "./mlb-pregame-readiness";

const lines: MlbPregameLineInputs = {
  mlHome: "-125",
  mlAway: "+115",
  runLine: "-1.5",
  runLineHomeOdds: "+135",
  runLineAwayOdds: "-155",
  totalLine: "8.5",
  overOdds: "-110",
  underOdds: "-110",
  f5MlHome: "-120",
  f5MlAway: "+105",
  f5TotalLine: "4.5",
  f5OddsSource: "manual",
};

const capturedAt = "2026-08-05T15:30:00.000Z";

test("P1-M2C does not manufacture freshness from seeded full-game form values", () => {
  for (const market of ["ML", "RUN_LINE", "TOTAL"] as const) {
    assert.equal(buildMlbPregameManualOddsParams(market, lines, capturedAt), null);
    const request = buildMlbPregameReadinessUrl({
      gamePk: "824158",
      date: "2026-08-05",
      market,
      lines,
      capturedAt,
    });
    assert.equal(request.oddsMode, "automatic");
    assert.doesNotMatch(request.url, /oddsMode=manual/);
  }
});

test("P1-M2C sends a bilateral F5 quote only after an explicit manual edit", () => {
  const params = buildMlbPregameManualOddsParams("F5_ML", lines, capturedAt);
  assert.ok(params);
  assert.equal(params.get("manualHomeOdds"), "-120");
  assert.equal(params.get("manualAwayOdds"), "105");
  assert.equal(params.get("manualCapturedAt"), capturedAt);
  assert.equal(params.get("manualBook"), "Hard Rock F5 formulario");
});

test("P1-M2C preserves automatic provider timestamps for F5 consensus", () => {
  const request = buildMlbPregameReadinessUrl({
    gamePk: "824158",
    date: "2026-08-05",
    market: "F5_ML",
    lines: { ...lines, f5OddsSource: "consenso" },
    capturedAt,
  });
  assert.equal(request.oddsMode, "automatic");
  assert.doesNotMatch(request.url, /oddsMode=manual/);
});

test("P1-M2C never reuses full-game total prices for F5 total", () => {
  assert.equal(buildMlbPregameManualOddsParams("F5_TOTAL", lines, capturedAt), null);
  const request = buildMlbPregameReadinessUrl({
    gamePk: "824158",
    date: "2026-08-05",
    market: "F5_TOTAL",
    lines,
    capturedAt,
  });
  assert.equal(request.oddsMode, "automatic");
  assert.doesNotMatch(request.url, /oddsMode=manual/);
});

test("P1-M2C falls back to automatic odds when a manual F5 pair is incomplete", () => {
  const request = buildMlbPregameReadinessUrl({
    gamePk: "824158",
    date: "2026-08-05",
    market: "F5_ML",
    lines: { ...lines, f5MlAway: "" },
    capturedAt,
  });
  assert.equal(request.oddsMode, "automatic");
  assert.match(request.url, /market=F5_ML/);
});

function report(overrides: Partial<MlbPregameReadinessReport> = {}): MlbPregameReadinessReport {
  return {
    schemaVersion: MLB_P1_M2B_READINESS_SCHEMA,
    contractSchemaVersion: MLB_P1_M2A_CONTRACT_SCHEMA,
    generatedAt: capturedAt,
    game: {
      gamePk: 824158,
      date: "2026-08-05",
      state: "SCHEDULED",
      startTime: "2026-08-06T00:10:00.000Z",
      homeTeam: { name: "Houston Astros" },
      awayTeam: { name: "Toronto Blue Jays" },
    },
    market: "F5_ML",
    gate: {
      schemaVersion: MLB_P1_M2A_CONTRACT_SCHEMA,
      status: "READY_PROVISIONAL",
      analysisAllowed: true,
      analysisStage: "PROVISIONAL",
      blockers: [],
      warnings: ["LINEUPS_MISSING"],
      requiredFields: ["GAME_IDENTITY", "PITCHERS", "MARKET_ODDS", "LINEUPS"],
    },
    summary: { requiredFields: [], fresh: 3, stale: 0, degraded: 0, missing: 1, conflict: 0, unknown: 0 },
    evidence: [],
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
    ...overrides,
  };
}

test("P1-M2C accepts only the exact P1-M2B SHADOW safety envelope", () => {
  assert.equal(mlbPregameSafetyValid(report()), true);
  assert.equal(mlbPregameSafetyValid(report({ safety: { ...report().safety, realFinancialExposure: 1 } })), false);
  assert.equal(mlbPregameSafetyValid(report({ schemaVersion: "wrong" as any })), false);
});

test("P1-M2C snapshot preserves FINAL, PROVISIONAL and BLOCKED authority", () => {
  const provisional = toMlbPregameGateSnapshot(report());
  assert.equal(provisional.status, "READY_PROVISIONAL");
  assert.equal(provisional.analysisAllowed, true);

  const blocked = toMlbPregameGateSnapshot(report({
    gate: {
      ...report().gate,
      status: "BLOCKED",
      analysisAllowed: false,
      analysisStage: "BLOCKED",
      blockers: ["MARKET_ODDS_STALE"],
    },
  }));
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.analysisAllowed, false);
});
