import assert from "node:assert/strict";
import test from "node:test";
import { presentMlbDailyBestPickPriceFailClosed } from "./mlb-daily-best-pick-price-safe";

const policy = {
  trustedPricedV16RuntimeOnly: true,
  exactDailyBestPickIdentityOnly: true,
  sportingSelectionChangedByPrice: false,
  fallbackToAnotherGameAllowed: false,
  fallbackToAnotherMarketAllowed: false,
  newThresholdAdded: false,
  fixedEvThresholdAdded: false,
  fixedProbabilityThresholdAdded: false,
  betEliteLabelProduced: false,
  finalBetRecommendationProduced: false,
  stakeCalculated: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
};

const pick = {
  gamePk: 1001,
  market: "FULL_GAME_ML",
  canonicalMarketType: "ML",
  side: "HOME",
  route: "PREMIUM_A_HOME_ML",
  tier: "PREMIUM",
  prepriceRank: 0,
};

const audit = {
  exactEnvelopeMarketMatches: 1,
  exactMarketEdgeMatches: 1,
  otherGameMarketsIgnored: 0,
  otherSelectedGameMarketsIgnored: 0,
};

test("semantic guard rejects Elite payload without executable price", () => {
  const display = presentMlbDailyBestPickPriceFailClosed({
    schemaVersion: "courtedge-mlb-daily-best-pick-price-view.v1",
    decision: "ELITE_EVIDENCE_CANDIDATE",
    pick,
    execution: null,
    economics: {
      modelWinProbability: 0.6,
      modelPushProbability: 0,
      expectedValuePerUnit: 0.1,
      executionEdgePp: 5,
      executionNoVigEdgePp: 2,
      referenceNoVigEdgePp: null,
      referenceAgreement: "UNAVAILABLE",
    },
    blockers: [],
    warnings: [],
    audit,
    policy,
  });
  assert.equal(display.state, "UNAVAILABLE");
});

test("semantic guard rejects Elite payload with non-positive EV or blockers", () => {
  const base = {
    schemaVersion: "courtedge-mlb-daily-best-pick-price-view.v1",
    decision: "ELITE_EVIDENCE_CANDIDATE",
    pick,
    execution: {
      bookKey: "hardrockbet_fl",
      bookTitle: "Hard Rock Bet",
      oddsAmerican: -110,
      capturedAt: "2026-08-18T03:20:00.000Z",
      providerLastUpdate: "2026-08-18T03:20:00.000Z",
    },
    economics: {
      modelWinProbability: 0.6,
      modelPushProbability: 0,
      expectedValuePerUnit: 0.1,
      executionEdgePp: 5,
      executionNoVigEdgePp: 2,
      referenceNoVigEdgePp: null,
      referenceAgreement: "UNAVAILABLE",
    },
    blockers: [],
    warnings: [],
    audit,
    policy,
  };

  assert.equal(presentMlbDailyBestPickPriceFailClosed({
    ...base,
    economics: { ...base.economics, expectedValuePerUnit: 0 },
  }).state, "UNAVAILABLE");
  assert.equal(presentMlbDailyBestPickPriceFailClosed({
    ...base,
    blockers: ["CORRUPT_BLOCKER"],
  }).state, "UNAVAILABLE");
});

test("valid Elite payload remains visible as PRICE PASS", () => {
  const display = presentMlbDailyBestPickPriceFailClosed({
    schemaVersion: "courtedge-mlb-daily-best-pick-price-view.v1",
    decision: "ELITE_EVIDENCE_CANDIDATE",
    pick,
    execution: {
      bookKey: "hardrockbet_fl",
      bookTitle: "Hard Rock Bet",
      oddsAmerican: -110,
      capturedAt: "2026-08-18T03:20:00.000Z",
      providerLastUpdate: "2026-08-18T03:20:00.000Z",
    },
    economics: {
      modelWinProbability: 0.6,
      modelPushProbability: 0,
      expectedValuePerUnit: 0.1,
      executionEdgePp: 5,
      executionNoVigEdgePp: 2,
      referenceNoVigEdgePp: null,
      referenceAgreement: "UNAVAILABLE",
    },
    blockers: [],
    warnings: [],
    audit,
    policy,
  });
  assert.equal(display.state, "ELITE_EVIDENCE_CANDIDATE");
  assert.equal(display.badge, "PRICE PASS");
});
