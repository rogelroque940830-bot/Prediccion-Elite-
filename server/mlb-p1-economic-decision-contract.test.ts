import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M4A_AUDIT_FINDINGS,
  MLB_P1_M4A_BET_EDGE_FLOOR_PP,
  MLB_P1_M4A_LEAN_EDGE_FLOOR_PP,
  MLB_P1_M4A_MAX_SHADOW_STAKE_UNITS,
  MLB_P1_M4A_SCHEMA,
  evaluateMlbP1M4aEconomicDecision,
  mlbP1M4aAmericanToDecimal,
  mlbP1M4aAmericanToImpliedProbability,
  mlbP1M4aExpectedValuePerUnit,
  mlbP1M4aFairPrice,
  mlbP1M4aKellyFractions,
  mlbP1M4aMinimumAcceptablePrice,
  mlbP1M4aPriceMeetsMinimum,
  type MlbP1M4aDecisionInput,
} from "./mlb-p1-economic-decision-contract";

function input(overrides: Partial<MlbP1M4aDecisionInput> = {}): MlbP1M4aDecisionInput {
  return {
    market: "ML",
    stage: "FINAL",
    gateStatus: "READY_FINAL",
    blockers: [],
    warnings: [],
    modelProbability: 0.72,
    currentOddsAmerican: -110,
    noVigProbability: 0.50,
    quoteIntegrity: {
      certifiedQuoteMatch: true,
      certifiedLineMatch: true,
      fresh: true,
      bilateral: true,
    },
    ...overrides,
  };
}

test("American prices are converted in payout space, not compared numerically", () => {
  assert.equal(mlbP1M4aAmericanToDecimal(-110), 1 + 100 / 110);
  assert.equal(mlbP1M4aAmericanToDecimal(110), 2.1);
  assert.equal(mlbP1M4aAmericanToImpliedProbability(-110), 110 / 210);
  assert.equal(mlbP1M4aAmericanToImpliedProbability(110), 100 / 210);
  assert.equal(mlbP1M4aAmericanToDecimal(-99), null);
  assert.equal(mlbP1M4aAmericanToDecimal(0), null);
});

test("fair price is the break-even price for the selected-side model probability", () => {
  assert.deepEqual(mlbP1M4aFairPrice(0.60), {
    probability: 0.60,
    decimal: 1.666667,
    american: -150,
  });
  assert.deepEqual(mlbP1M4aFairPrice(0.40), {
    probability: 0.40,
    decimal: 2.5,
    american: 150,
  });
  assert.equal(mlbP1M4aFairPrice(1), null);
});

test("minimum acceptable price preserves the existing strict edge floors", () => {
  const lean57 = mlbP1M4aMinimumAcceptablePrice(0.57, MLB_P1_M4A_LEAN_EDGE_FLOOR_PP);
  const bet57 = mlbP1M4aMinimumAcceptablePrice(0.57, MLB_P1_M4A_BET_EDGE_FLOOR_PP);
  const lean60 = mlbP1M4aMinimumAcceptablePrice(0.60, MLB_P1_M4A_LEAN_EDGE_FLOOR_PP);
  const bet60 = mlbP1M4aMinimumAcceptablePrice(0.60, MLB_P1_M4A_BET_EDGE_FLOOR_PP);

  assert.equal(lean57.oddsAmerican, -117);
  assert.equal(bet57.oddsAmerican, 105);
  assert.equal(lean60.oddsAmerican, -132);
  assert.equal(bet60.oddsAmerican, -108);

  assert.equal(mlbP1M4aPriceMeetsMinimum(-118, lean57.oddsAmerican), false);
  assert.equal(mlbP1M4aPriceMeetsMinimum(-117, lean57.oddsAmerican), true);
  assert.equal(mlbP1M4aPriceMeetsMinimum(104, bet57.oddsAmerican), false);
  assert.equal(mlbP1M4aPriceMeetsMinimum(105, bet57.oddsAmerican), true);
});

test("EV and Kelly are deterministic and never create a negative analytical stake", () => {
  assert.equal(mlbP1M4aExpectedValuePerUnit(0.55, 100), 0.10);
  assert.equal(mlbP1M4aExpectedValuePerUnit(0.45, -110), -0.14090909);
  assert.deepEqual(mlbP1M4aKellyFractions(0.45, -110), { full: 0, quarter: 0 });

  const positive = mlbP1M4aKellyFractions(0.72, -110);
  assert.equal(positive.full > 0, true);
  assert.equal(positive.quarter, Math.round(positive.full * 0.25 * 1e8) / 1e8);
});

test("a FINAL high-confidence edge becomes an actionable SHADOW BET capped at one unit", () => {
  const decision = evaluateMlbP1M4aEconomicDecision(input());
  assert.equal(decision.schemaVersion, MLB_P1_M4A_SCHEMA);
  assert.equal(decision.modelSignal, "BET");
  assert.equal(decision.decision, "BET");
  assert.equal(decision.actionability, "ACTIONABLE_FINAL");
  assert.equal(decision.economics.edgePp, 19.61904762);
  assert.equal(decision.economics.expectedValuePerUnit, 0.37454545);
  assert.equal(decision.currentPrice.meetsBetMinimum, true);
  assert.equal(decision.stake.analyticalUnits, 1);
  assert.equal(decision.stake.maximumUnits, MLB_P1_M4A_MAX_SHADOW_STAKE_UNITS);
  assert.equal(decision.stake.realFinancialExposure, 0);
  assert.equal(decision.safety.automaticBetPlacement, false);
  assert.equal(decision.safety.sportsbookIntegration, false);
});

test("a modest positive edge remains LEAN and receives zero stake", () => {
  const decision = evaluateMlbP1M4aEconomicDecision(input({
    modelProbability: 0.57,
    currentOddsAmerican: -110,
  }));
  assert.equal(decision.modelSignal, "LEAN");
  assert.equal(decision.decision, "LEAN");
  assert.equal(decision.actionability, "OBSERVE_ONLY");
  assert.equal(decision.currentPrice.meetsLeanMinimum, true);
  assert.equal(decision.stake.analyticalUnits, 0);
});

test("an edge below the LEAN floor is PASS even when EV is slightly positive", () => {
  const decision = evaluateMlbP1M4aEconomicDecision(input({
    modelProbability: 0.57,
    currentOddsAmerican: -125,
  }));
  assert.equal(decision.modelSignal, "PASS");
  assert.equal(decision.decision, "PASS");
  assert.equal(decision.actionability, "OBSERVE_ONLY");
  assert.equal(decision.reasons.includes("EDGE_BELOW_LEAN_FLOOR"), true);
  assert.equal(decision.stake.analyticalUnits, 0);
});

test("edge above eight points without seventy-percent confidence stays LEAN", () => {
  const decision = evaluateMlbP1M4aEconomicDecision(input({
    modelProbability: 0.60,
    currentOddsAmerican: -108,
  }));
  assert.equal((decision.economics.edgePp ?? 0) > 8, true);
  assert.equal(decision.modelSignal, "LEAN");
  assert.equal(decision.decision, "LEAN");
  assert.equal(decision.reasons.includes("BET_CONFIDENCE_BELOW_FLOOR"), true);
  assert.equal(decision.stake.analyticalUnits, 0);
});

test("PROVISIONAL preserves the observed model signal but cannot be actionable", () => {
  const decision = evaluateMlbP1M4aEconomicDecision(input({
    stage: "PROVISIONAL",
    gateStatus: "READY_PROVISIONAL",
    warnings: ["LINEUPS_PENDING"],
  }));
  assert.equal(decision.modelSignal, "BET");
  assert.equal(decision.decision, "LEAN");
  assert.equal(decision.actionability, "WAIT_FOR_FINAL");
  assert.equal(decision.reasons.includes("PROVISIONAL_REQUIRES_FINAL_CONFIRMATION"), true);
  assert.deepEqual(decision.warnings, ["LINEUPS_PENDING"]);
  assert.equal(decision.stake.analyticalUnits, 0);
});

test("readiness, quote, line, freshness and bilateral integrity fail closed", () => {
  const decision = evaluateMlbP1M4aEconomicDecision(input({
    blockers: ["MARKET_ODDS_STALE"],
    quoteIntegrity: {
      certifiedQuoteMatch: false,
      certifiedLineMatch: false,
      fresh: false,
      bilateral: false,
    },
  }));
  assert.equal(decision.decision, "PASS");
  assert.equal(decision.actionability, "BLOCKED");
  assert.equal(decision.reasons.includes("READINESS_HAS_BLOCKERS"), true);
  assert.equal(decision.reasons.includes("CERTIFIED_QUOTE_MISMATCH"), true);
  assert.equal(decision.reasons.includes("CERTIFIED_LINE_MISMATCH"), true);
  assert.equal(decision.reasons.includes("MARKET_QUOTE_STALE"), true);
  assert.equal(decision.reasons.includes("BILATERAL_PRICE_REQUIRED"), true);
  assert.equal(decision.stake.analyticalUnits, 0);
});

test("gate/stage mismatch and invalid market inputs are blocked", () => {
  const decision = evaluateMlbP1M4aEconomicDecision(input({
    stage: "FINAL",
    gateStatus: "READY_PROVISIONAL",
    modelProbability: 1.2,
    currentOddsAmerican: -4,
  }));
  assert.equal(decision.decision, "PASS");
  assert.equal(decision.actionability, "BLOCKED");
  assert.equal(decision.reasons.includes("GATE_STATUS_STAGE_MISMATCH"), true);
  assert.equal(decision.reasons.includes("MODEL_PROBABILITY_INVALID"), true);
  assert.equal(decision.reasons.includes("CURRENT_ODDS_INVALID"), true);
  assert.equal(decision.fairPrice, null);
});

test("audit findings preserve the known economic gaps for later P1-M4B/C", () => {
  const codes = new Set(MLB_P1_M4A_AUDIT_FINDINGS.map((finding) => finding.code));
  assert.equal(codes.has("SIGNAL_HAS_NO_VERSIONED_PRICE_FLOOR"), true);
  assert.equal(codes.has("AMERICAN_ODDS_ORDER_IS_ECONOMICALLY_AMBIGUOUS"), true);
  assert.equal(codes.has("EXPECTED_VALUE_NOT_FIRST_CLASS"), true);
  assert.equal(codes.has("PROVISIONAL_ACTIONABILITY_NOT_CONTRACTED"), true);
  assert.equal(codes.has("KELLY_CAP_NOT_VERSIONED_AS_POLICY"), true);
});
