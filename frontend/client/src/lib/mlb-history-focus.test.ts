import assert from "node:assert/strict";
import test from "node:test";
import {
  americanOddsToImpliedPct,
  auditMlbHistoryMarketIntegrity,
  buildMlbHistoryFocus,
  isMlbHistoryEconomicallyActionable,
  isMlbHistoryWaitingForFinal,
  isStandardAmericanOdds,
  type MlbHistoryFocusPick,
} from "./mlb-history-focus";

const NOW = Date.parse("2026-07-31T18:00:00-04:00");

function pick(overrides: Partial<MlbHistoryFocusPick> = {}): MlbHistoryFocusPick {
  return {
    id: "pick-1",
    recordedAt: "2026-07-31T21:15:00.000Z",
    gameDate: "2026-07-31",
    commenceTime: "2026-08-01T02:10:00.000Z",
    gamePk: 1001,
    homeTeam: "Cincinnati Reds",
    awayTeam: "Pittsburgh Pirates",
    marketType: "F5_ML",
    marketLabel: "F5",
    selection: "Pittsburgh Pirates",
    line: null,
    oddsAmerican: -145,
    book: "fanduel, draftkings, betmgm",
    modelProbabilityPct: 65.7,
    marketImpliedProbabilityPct: 59.18,
    edgePp: 6.52,
    signal: "BET_FUERTE",
    confidenceLabel: "PREMIUM",
    analysisStage: "FINAL",
    economicLayerSchemaVersion: "courtedge-p1-m4b-economic-decision-adapter.v1",
    economicLayerStatus: "ADAPTED",
    economicSourceSignal: "BET_FUERTE",
    economicEffectiveDecision: "BET",
    economicActionability: "ACTIONABLE_FINAL",
    economicAnalyticalUnits: 0.5,
    economicReasons: ["POSITIVE_EXPECTED_VALUE"],
    result: "PENDING",
    settlementResult: null,
    settledAt: null,
    profitUnits: 0,
    closingOddsAmerican: null,
    clvPp: null,
    finalScore: null,
    analyticalDuplicate: false,
    ...overrides,
  };
}

test("American odds gate accepts standard prices and rejects synthetic near-zero prices", () => {
  assert.equal(isStandardAmericanOdds(-145), true);
  assert.equal(isStandardAmericanOdds(120), true);
  assert.equal(isStandardAmericanOdds(-100), true);
  assert.equal(isStandardAmericanOdds(100), true);
  assert.equal(isStandardAmericanOdds(-5), false);
  assert.equal(isStandardAmericanOdds(0), false);
  assert.equal(isStandardAmericanOdds(99), false);
});

test("American implied probability remains deterministic", () => {
  assert.ok(Math.abs((americanOddsToImpliedPct(-145) ?? 0) - 59.1836734694) < 1e-6);
  assert.ok(Math.abs((americanOddsToImpliedPct(120) ?? 0) - 45.4545454545) < 1e-6);
});

test("valid Pittsburgh F5 record passes structural integrity", () => {
  const audit = auditMlbHistoryMarketIntegrity(pick());
  assert.equal(audit.status, "PASS");
  assert.equal(audit.issues.length, 0);
  assert.ok(Math.abs((audit.recomputedEdgePp ?? 0) - 6.5163265306) < 1e-6);
});

test("synthetic -5 F5 total is rejected even when stored arithmetic is internally consistent", () => {
  const audit = auditMlbHistoryMarketIntegrity(pick({
    id: "invalid-total",
    gamePk: 1002,
    marketType: "F5_TOTAL",
    marketLabel: "F5 O/U",
    selection: "UNDER 6",
    line: 6,
    oddsAmerican: -5,
    modelProbabilityPct: 61.1,
    marketImpliedProbabilityPct: 4.76,
    edgePp: 56.34,
    signal: "LEAN",
    confidenceLabel: "HIGH",
  }));
  assert.equal(audit.status, "REJECT");
  assert.ok(audit.issues.some((entry) => entry.code === "INVALID_AMERICAN_ODDS"));
  assert.ok(!audit.issues.some((entry) => entry.code === "EDGE_ARITHMETIC_MISMATCH"));
});

test("valid -120 price with 22.85 pp edge is separated for review", () => {
  const audit = auditMlbHistoryMarketIntegrity(pick({
    id: "edge-outlier",
    gamePk: 1003,
    homeTeam: "Baltimore Orioles",
    awayTeam: "Philadelphia Phillies",
    selection: "Baltimore Orioles",
    oddsAmerican: -120,
    modelProbabilityPct: 77.4,
    marketImpliedProbabilityPct: 54.55,
    edgePp: 22.85,
    signal: "LEAN",
    confidenceLabel: "HIGH",
  }));
  assert.equal(audit.status, "REVIEW");
  assert.ok(audit.issues.some((entry) => entry.code === "EDGE_OUTLIER"));
});

test("arithmetic mismatch is rejected", () => {
  const audit = auditMlbHistoryMarketIntegrity(pick({
    marketImpliedProbabilityPct: 10,
    edgePp: 55.7,
  }));
  assert.equal(audit.status, "REJECT");
  assert.ok(audit.issues.some((entry) => entry.code === "IMPLIED_PROBABILITY_MISMATCH"));
  assert.ok(audit.issues.some((entry) => entry.code === "EDGE_ARITHMETIC_MISMATCH"));
});

test("focus view never places rejected or review records in Priority or Waiting", () => {
  const valid = pick({ id: "valid", gamePk: 2001 });
  const invalid = pick({
    id: "invalid",
    gamePk: 2002,
    marketType: "F5_TOTAL",
    marketLabel: "F5 O/U",
    selection: "UNDER 6",
    line: 6,
    oddsAmerican: -5,
    modelProbabilityPct: 61.1,
    marketImpliedProbabilityPct: 4.76,
    edgePp: 56.34,
    signal: "LEAN",
    confidenceLabel: "HIGH",
  });
  const outlier = pick({
    id: "outlier",
    gamePk: 2003,
    homeTeam: "Baltimore Orioles",
    awayTeam: "Philadelphia Phillies",
    selection: "Baltimore Orioles",
    oddsAmerican: -120,
    modelProbabilityPct: 77.4,
    marketImpliedProbabilityPct: 54.55,
    edgePp: 22.85,
    signal: "LEAN",
    confidenceLabel: "HIGH",
  });

  const focus = buildMlbHistoryFocus([valid, invalid, outlier], NOW);
  assert.deepEqual(focus.priority.map((entry) => entry.id), ["valid"]);
  assert.equal(focus.priority[0].signal, "EFECTIVA_BET");
  assert.equal(focus.waiting.length, 0);
  assert.equal(focus.verifyTotal, 2);
  assert.deepEqual(new Set(focus.verify.map((entry) => entry.pick.id)), new Set(["invalid", "outlier"]));
  assert.equal(focus.verify.find((entry) => entry.pick.id === "invalid")?.audit.status, "REJECT");
  assert.equal(focus.verify.find((entry) => entry.pick.id === "outlier")?.audit.status, "REVIEW");
});

test("missing book prevents local fallback from becoming a priority recommendation", () => {
  const focus = buildMlbHistoryFocus([pick({ id: "local", book: null, analysisStage: "LOCAL" })], NOW);
  assert.equal(focus.priority.length, 0);
  assert.equal(focus.waiting.length, 0);
  assert.equal(focus.verifyTotal, 1);
  assert.ok(focus.verify[0].audit.issues.some((entry) => entry.code === "MISSING_BOOK"));
});

test("legacy BET_FUERTE without P1-M4 layer is hidden instead of presented as playable", () => {
  const legacy = pick({
    id: "legacy-strong",
    economicLayerSchemaVersion: null,
    economicLayerStatus: null,
    economicEffectiveDecision: null,
    economicActionability: null,
    economicAnalyticalUnits: 0,
  });
  const focus = buildMlbHistoryFocus([legacy], NOW);
  assert.equal(isMlbHistoryEconomicallyActionable(legacy), false);
  assert.equal(focus.priority.length, 0);
  assert.equal(focus.waiting.length, 0);
  assert.equal(focus.hiddenStudyRecords, 1);
});

test("provisional source BET remains waiting when P1-M4 says WAIT_FOR_FINAL", () => {
  const provisional = pick({
    id: "provisional-bet",
    analysisStage: "PROVISIONAL",
    economicEffectiveDecision: "LEAN",
    economicActionability: "WAIT_FOR_FINAL",
    economicAnalyticalUnits: 0,
  });
  const focus = buildMlbHistoryFocus([provisional], NOW);
  assert.equal(isMlbHistoryEconomicallyActionable(provisional), false);
  assert.equal(isMlbHistoryWaitingForFinal(provisional), true);
  assert.equal(focus.priority.length, 0);
  assert.deepEqual(focus.waiting.map((entry) => entry.id), ["provisional-bet"]);
  assert.equal(focus.waiting[0].signal, "EFECTIVA_LEAN");
  assert.equal(focus.waiting[0].economicSourceSignal, "BET_FUERTE");
});

test("FINAL source BET downgraded to effective PASS is hidden", () => {
  const downgraded = pick({
    id: "effective-pass",
    economicEffectiveDecision: "PASS",
    economicActionability: "OBSERVE_ONLY",
    economicAnalyticalUnits: 0,
  });
  const focus = buildMlbHistoryFocus([downgraded], NOW);
  assert.equal(isMlbHistoryEconomicallyActionable(downgraded), false);
  assert.equal(focus.priority.length, 0);
  assert.equal(focus.waiting.length, 0);
});

test("only FINAL effective BET with ACTIONABLE_FINAL and positive units is high priority", () => {
  const zeroUnits = pick({ id: "zero-units", economicAnalyticalUnits: 0 });
  const blocked = pick({ id: "blocked", economicActionability: "BLOCKED" });
  const actionable = pick({ id: "actionable" });
  const focus = buildMlbHistoryFocus([zeroUnits, blocked, actionable], NOW);
  assert.equal(isMlbHistoryEconomicallyActionable(actionable), true);
  assert.deepEqual(focus.priority.map((entry) => entry.id), ["actionable"]);
  assert.equal(focus.priority[0].signal, "EFECTIVA_BET");
  assert.equal(focus.priority[0].economicSourceSignal, "BET_FUERTE");
});

test("results contains every unique settled decision instead of an eight-item preview", () => {
  const settled = Array.from({ length: 18 }, (_, index) => pick({
    id: `settled-${index}`,
    gamePk: 3000 + index,
    result: index % 2 === 0 ? "W" : "L",
    settlementResult: index % 2 === 0 ? "WIN" : "LOSS",
    settledAt: new Date(NOW - index * 60_000).toISOString(),
  }));

  const focus = buildMlbHistoryFocus(settled, NOW);
  assert.equal(focus.results.length, 18);
  assert.equal(focus.results[0].id, "settled-0");
  assert.equal(focus.results[17].id, "settled-17");
});
