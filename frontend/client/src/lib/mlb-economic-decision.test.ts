import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M4A_SCHEMA,
  MLB_P1_M4B_SCHEMA,
  formatMlbAmericanOdds,
  formatMlbPercent,
  parseMlbEconomicAdapterResult,
} from "./mlb-economic-decision";

function fixture() {
  return {
    schemaVersion: MLB_P1_M4B_SCHEMA,
    adapterVersion: "mlb-p1m3a-to-p1m4a-adapter.v1",
    status: "ADAPTED",
    sourceDigest: "a".repeat(64),
    economicInputDigest: "b".repeat(64),
    source: {
      captureSchemaVersion: "courtedge-p1-m3a-scientific-capture-contract.v1",
      captureStatus: "READY_TO_APPEND",
      captureAllowed: true,
      captureIdentity: {
        lifecycleKey: "c".repeat(64),
        semanticFingerprint: "d".repeat(64),
        clientRequestId: "p1m3a:test",
      },
      market: "ML",
      side: "HOME",
      selection: "Baltimore Orioles ML",
      line: null,
      modelProbability: 0.72,
      marketImpliedProbability: 0.55,
      noVigProbability: 0.53,
      sourceSignal: "BET",
      sourceCategory: "PREMIUM",
      sourceRecommendedStakeUnits: 1,
      sourcePolicy: "ML_F5_EDGE_CONFIDENCE_V2",
    },
    economicDecision: {
      schemaVersion: MLB_P1_M4A_SCHEMA,
      policyVersion: "mlb-economic-policy-v1-existing-signal-parity",
      market: "ML",
      stage: "FINAL",
      modelSignal: "BET",
      decision: "BET",
      actionability: "ACTIONABLE_FINAL",
      fairPrice: { probability: 0.72, decimal: 1.388889, american: -257 },
      minimumPrices: {
        lean: { requiredEdgePp: 3, oddsAmerican: -222, oddsDecimal: 1.45045, maximumImpliedProbability: 0.69 },
        bet: { requiredEdgePp: 8, oddsAmerican: -177, oddsDecimal: 1.564972, maximumImpliedProbability: 0.64 },
        active: { requiredEdgePp: 8, oddsAmerican: -177, oddsDecimal: 1.564972, maximumImpliedProbability: 0.64 },
      },
      currentPrice: {
        oddsAmerican: -120,
        oddsDecimal: 1.833333,
        impliedProbability: 0.545454545455,
        meetsLeanMinimum: true,
        meetsBetMinimum: true,
      },
      economics: {
        edgePp: 17.45454545,
        noVigEdgePp: 19,
        expectedValuePerUnit: 0.32,
        fullKellyFraction: 0.384,
        quarterKellyFraction: 0.096,
      },
      stake: { analyticalUnits: 1, maximumUnits: 1, realFinancialExposure: 0 },
      reasons: [],
      warnings: [],
      safety: {
        mode: "SHADOW_DECISION_SUPPORT",
        automaticBetPlacement: false,
        sportsbookIntegration: false,
        automaticModelChangesAllowed: false,
        automaticPromotionAllowed: false,
      },
    },
    effectiveDecision: {
      decision: "BET",
      actionability: "ACTIONABLE_FINAL",
      analyticalUnits: 1,
      sourceSignalCeilingApplied: false,
      reasons: [],
    },
    signalCompatibility: {
      sourceSignal: "BET",
      sourceSignalNormalized: "BET",
      economicModelSignal: "BET",
      relation: "MATCH",
      sourcePolicy: "ML_F5_EDGE_CONFIDENCE_V2",
      policyDifferenceExpected: false,
      originalDecisionPreserved: true,
    },
    errors: [],
    warnings: [],
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      sportsbookIntegration: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
      originalModelOutputMutated: false,
      ledgerWritePerformed: false,
    },
  };
}

test("P1-M4C accepts the complete authenticated P1-M4B response", () => {
  const parsed = parseMlbEconomicAdapterResult(fixture());
  assert.ok(parsed);
  assert.equal(parsed.effectiveDecision.decision, "BET");
  assert.equal(parsed.effectiveDecision.actionability, "ACTIONABLE_FINAL");
  assert.equal(parsed.economicDecision.minimumPrices.active?.oddsAmerican, -177);
});

test("P1-M4C rejects an adapter response that weakens SHADOW safety", () => {
  const value = fixture();
  value.safety.realFinancialExposure = 1 as 0;
  assert.equal(parseMlbEconomicAdapterResult(value), null);
});

test("P1-M4C rejects incomplete economic price evidence", () => {
  const value = fixture();
  delete (value.economicDecision.currentPrice as any).meetsBetMinimum;
  assert.equal(parseMlbEconomicAdapterResult(value), null);
});

test("P1-M4C formats American prices and probabilities consistently", () => {
  assert.equal(formatMlbAmericanOdds(105), "+105");
  assert.equal(formatMlbAmericanOdds(-120), "-120");
  assert.equal(formatMlbAmericanOdds(null), "—");
  assert.equal(formatMlbPercent(0.574), "57.4%");
});
