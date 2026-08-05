import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M2A_CONTRACT_SCHEMA,
  MLB_P1_M2B_READINESS_SCHEMA,
  buildMlbPregameCertifiedLinePatch,
  buildMlbPregameManualOddsParams,
  buildMlbPregameReadinessUrl,
  mlbPregameSafetyValid,
  toMlbPregameGateSnapshot,
  validateMlbPregameModelQuote,
  type MlbPregameEvidence,
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

function marketEvidence(details: Record<string, unknown>): MlbPregameEvidence {
  return {
    field: "MARKET_ODDS",
    required: true,
    state: "FRESH",
    sourceIds: ["market"],
    endpoints: ["/api/odds/mlb"],
    authority: "MARKET",
    fetchedAt: capturedAt,
    observedAt: capturedAt,
    ageSeconds: 0,
    maxAgeSeconds: 300,
    sourceStatus: "EXPLICIT_PROVIDER_TIME",
    quality: "MARKET_PROVENANCE",
    details,
    errors: [],
  };
}

function report(overrides: Partial<MlbPregameReadinessReport> = {}): MlbPregameReadinessReport {
  return {
    schemaVersion: MLB_P1_M2B_READINESS_SCHEMA,
    contractSchemaVersion: MLB_P1_M2A_CONTRACT_SCHEMA,
    generatedAt: capturedAt,
    market: "F5_ML",
    game: {
      gamePk: 824158,
      officialDate: "2026-08-05",
      state: "SCHEDULED",
      detailedState: "Scheduled",
      startTime: "2026-08-06T00:10:00.000Z",
      homeTeam: { id: 117, name: "Houston Astros" },
      awayTeam: { id: 141, name: "Toronto Blue Jays" },
    },
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

test("P1-M2C requires the model ML pair to equal the certified quote", () => {
  const ready = report({ market: "ML", evidence: [marketEvidence({ quote: { home: -125, away: 115 } })] });
  assert.equal(validateMlbPregameModelQuote(ready, lines).matches, true);
  const mismatch = validateMlbPregameModelQuote(ready, { ...lines, mlAway: "+120" });
  assert.equal(mismatch.matches, false);
  assert.deepEqual(mismatch.reasons, ["MODEL_AWAY_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE"]);
});

test("P1-M2C requires run line and total inputs to equal their certified quotes", () => {
  const runLineReport = report({
    market: "RUN_LINE",
    evidence: [marketEvidence({ quote: { line: -1.5, homeOdds: 135, awayOdds: -155 } })],
  });
  assert.equal(validateMlbPregameModelQuote(runLineReport, lines).matches, true);
  assert.equal(validateMlbPregameModelQuote(runLineReport, { ...lines, runLine: "-2.5" }).matches, false);

  const totalReport = report({
    market: "TOTAL",
    evidence: [marketEvidence({ quote: { line: 8.5, overOdds: -110, underOdds: -110 } })],
  });
  assert.equal(validateMlbPregameModelQuote(totalReport, lines).matches, true);
  assert.equal(validateMlbPregameModelQuote(totalReport, { ...lines, overOdds: "+100" }).matches, false);
});

test("P1-M2C accepts manual and automatic F5 ML shapes but blocks F5 Total without exact prices", () => {
  const manualF5 = report({
    market: "F5_ML",
    evidence: [marketEvidence({ homeOdds: -120, awayOdds: 105 })],
  });
  assert.equal(validateMlbPregameModelQuote(manualF5, lines).matches, true);

  const automaticF5 = report({
    market: "F5_ML",
    evidence: [marketEvidence({ quote: { home: -120, away: 105, n: 3 } })],
  });
  assert.equal(validateMlbPregameModelQuote(automaticF5, lines).matches, true);

  const f5Total = report({
    market: "F5_TOTAL",
    evidence: [marketEvidence({ quote: { line: 4.5, overOdds: -110, underOdds: -110 } })],
  });
  const result = validateMlbPregameModelQuote(f5Total, lines);
  assert.equal(result.matches, false);
  assert.deepEqual(result.reasons, ["F5_TOTAL_EXACT_PRICES_NOT_CAPTURED"]);
});

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


test("P1-M2C.2 maps each certified quote only into its matching model fields", () => {
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("ML", { home: -150, away: 130 }), {
    mlHome: "-150",
    mlAway: "130",
  });
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("F5_ML", { homeOdds: -125, awayOdds: 110 }), {
    f5MlHome: "-125",
    f5MlAway: "110",
    f5OddsSource: "consenso",
  });
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("RUN_LINE", { line: -1.5, homeOdds: 145, awayOdds: -165 }), {
    runLine: "-1.5",
    runLineHomeOdds: "145",
    runLineAwayOdds: "-165",
  });
  assert.deepEqual(buildMlbPregameCertifiedLinePatch("TOTAL", { line: 8.5, overOdds: -105, underOdds: -115 }), {
    totalLine: "8.5",
    overOdds: "-105",
    underOdds: "-115",
  });
});

test("P1-M2C.2 refuses incomplete or unsupported certified quotes", () => {
  assert.equal(buildMlbPregameCertifiedLinePatch("ML", { home: -150 }), null);
  assert.equal(buildMlbPregameCertifiedLinePatch("TOTAL", { line: 8.5, overOdds: -110 }), null);
  assert.equal(buildMlbPregameCertifiedLinePatch("F5_TOTAL", { line: 4.5, overOdds: -110, underOdds: -110 }), null);
});
