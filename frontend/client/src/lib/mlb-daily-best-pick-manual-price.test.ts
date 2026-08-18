import assert from "node:assert/strict";
import test from "node:test";
import {
  parseMlbDailyBestPickManualPriceAvailability,
  parseMlbDailyBestPickManualPriceView,
} from "./mlb-daily-best-pick-manual-price";

const policy = {
  providerOrFreshCachePricePrecedesManual: true,
  manualPriceMayChangeSportingSelection: false,
  exactDailyBestPickIdentityRequired: true,
  trustedV16ModelAssessmentRequired: true,
  quoteFreshnessUsesExistingFiveMinuteBoundary: true,
  callsTheOddsApi: false,
  theOddsApiCreditsConsumed: 0,
  betEliteProduced: false,
  stakeCalculated: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
};

test("manual continuity availability parser accepts only intact safety policy", () => {
  const valid = {
    schemaVersion: "courtedge-mlb-daily-best-pick-manual-price-context.v1",
    status: "AVAILABLE",
    reason: "READY_FOR_MANUAL_PRICE",
    runId: "run-1",
    expiresAt: "2026-08-18T03:15:00.000Z",
    policy,
  };
  assert.equal(parseMlbDailyBestPickManualPriceAvailability(valid)?.status, "AVAILABLE");
  assert.equal(parseMlbDailyBestPickManualPriceAvailability({ ...valid, policy: { ...policy, callsTheOddsApi: true } }), null);
});

test("manual price parser requires explicit provenance and decision-consistent EV", () => {
  const valid = {
    schemaVersion: "courtedge-mlb-daily-best-pick-manual-price-view.v1",
    decision: "MANUAL_PRICE_POSITIVE_EV",
    priceSource: "MANUAL_PRICE",
    pick: {
      gamePk: 1001,
      market: "FULL_GAME_ML",
      canonicalMarketType: "ML",
      side: "HOME",
      route: "PREMIUM_A_HOME_ML",
      tier: "PREMIUM",
      prepriceRank: 0,
    },
    execution: {
      bookKey: "hardrockbet_fl",
      bookTitle: "Hard Rock Bet (manual entry)",
      oddsAmerican: -110,
      capturedAt: "2026-08-18T03:10:00.000Z",
      providerLastUpdate: null,
      provenance: "USER_REPORTED_HARD_ROCK",
    },
    economics: {
      modelWinProbability: 0.6,
      modelPushProbability: 0,
      currentBreakEvenWinProbability: 0.5238095238,
      expectedValuePerUnit: 0.1454545455,
      executionEdgePp: 7.61904762,
    },
    blockers: [],
    warnings: ["MANUAL_PRICE_NOT_PROVIDER_VERIFIED"],
    policy: {
      providerOrFreshCachePricePrecedesManual: true,
      manualFallbackOnlyAfterAutomaticExecutionUnavailable: true,
      exactDailyBestPickIdentityRequired: true,
      userReportedPriceCannotCreateOrRerankPick: true,
      serverReceiptTimeIsQuoteTimestamp: true,
      pushAwareEconomicsPreserved: true,
      fixedEvThresholdAdded: false,
      operatingEnvelopeClassificationProduced: false,
      betEliteProduced: false,
      finalBetRecommendationProduced: false,
      stakeCalculated: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
  assert.equal(parseMlbDailyBestPickManualPriceView(valid)?.decision, "MANUAL_PRICE_POSITIVE_EV");
  assert.equal(parseMlbDailyBestPickManualPriceView({ ...valid, execution: { ...valid.execution, provenance: "PROVIDER" } }), null);
  assert.equal(parseMlbDailyBestPickManualPriceView({ ...valid, economics: { ...valid.economics, expectedValuePerUnit: -0.01 } }), null);
});
