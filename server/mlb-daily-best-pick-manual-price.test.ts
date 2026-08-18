import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbMarketProbabilityAssessmentDigest, type MlbMarketProbabilityAssessment } from "./mlb-market-edge";
import {
  buildMlbDailyBestPickManualPriceContext,
  evaluateMlbDailyBestPickManualPrice,
  MlbDailyBestPickManualPriceError,
} from "./mlb-daily-best-pick-manual-price";
import { MlbDailyBestPickManualPriceStore } from "./mlb-daily-best-pick-manual-price-store";
import { MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA, type MlbDailyBestPickPriceView } from "./mlb-daily-best-pick-price-view";
import { MLB_DAILY_BEST_PICK_UI_SCHEMA, type MlbDailyBestPickUiView } from "./mlb-daily-best-pick-ui-view";
import { MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA, type MlbUnifiedPricedV16RunnerResult } from "./mlb-unified-priced-v16-runner";

const NOW = new Date("2026-08-17T23:10:00.000-04:00");
const DATE = "2026-08-17";
const RUN_ID = "manual-price-test-run";

function assessment(): MlbMarketProbabilityAssessment {
  const base: Omit<MlbMarketProbabilityAssessment, "modelInputDigest"> = {
    gamePk: 1001,
    marketType: "ML",
    side: "HOME",
    line: null,
    status: "READY",
    sourcePolicy: "ML_F5_EDGE_CONFIDENCE_V2",
    modelVersion: "v16-test",
    generatedAt: NOW.toISOString(),
    probabilitySemantics: "UNCONDITIONAL_SETTLEMENT",
    winProbability: 0.6,
    pushProbability: 0,
    unavailableReason: null,
  };
  return { ...base, modelInputDigest: buildMlbMarketProbabilityAssessmentDigest(base) };
}

function daily(): MlbDailyBestPickUiView {
  return {
    schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
    decision: "BEST_PICK",
    pick: {
      gamePk: 1001,
      awayTeam: "Away",
      homeTeam: "Home",
      market: "FULL_GAME_ML",
      side: "HOME",
      route: "PREMIUM_A_HOME_ML",
      tier: "PREMIUM",
      prepriceRank: 0,
    },
    audit: {
      readyAPlusEvaluations: 0,
      readyPremiumEvaluations: 1,
      provisionalRowsSkipped: 0,
      frozenRouteMatchesOutsideRankedPreprice: 0,
    },
    policy: {
      trustedUnifiedPrepriceRuntimeOnly: true,
      finalFrozenInputsOnly: true,
      aPlusAlwaysPrecedesPremium: true,
      existingPrepriceRankPreservedWithinTier: true,
      generalV68FallbackAllowed: false,
      v80Read: false,
      v80Changed: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}

function automaticPrice(execution: MlbDailyBestPickPriceView["execution"] = null): MlbDailyBestPickPriceView {
  return {
    schemaVersion: MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
    decision: execution ? "NO_POSITIVE_EV" : "UPSTREAM_BLOCKED",
    pick: {
      gamePk: 1001,
      market: "FULL_GAME_ML",
      canonicalMarketType: "ML",
      side: "HOME",
      route: "PREMIUM_A_HOME_ML",
      tier: "PREMIUM",
      prepriceRank: 0,
    },
    execution,
    economics: execution ? {
      modelWinProbability: 0.6,
      modelPushProbability: 0,
      expectedValuePerUnit: -0.1,
      executionEdgePp: -6.66666667,
      executionNoVigEdgePp: 0,
      referenceNoVigEdgePp: null,
      referenceAgreement: "UNAVAILABLE",
    } : {
      modelWinProbability: null,
      modelPushProbability: null,
      expectedValuePerUnit: null,
      executionEdgePp: null,
      executionNoVigEdgePp: null,
      referenceNoVigEdgePp: null,
      referenceAgreement: "UNAVAILABLE",
    },
    blockers: execution ? [] : ["FRESH_EXECUTABLE_HARDROCK_QUOTE_REQUIRED"],
    warnings: [],
    audit: {
      exactEnvelopeMarketMatches: 1,
      exactMarketEdgeMatches: 1,
      otherGameMarketsIgnored: 0,
      otherSelectedGameMarketsIgnored: 0,
    },
    policy: {
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
    },
  };
}

function priced(): MlbUnifiedPricedV16RunnerResult {
  return {
    schemaVersion: MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA,
    runId: RUN_ID,
    date: DATE,
    preprice: { runId: RUN_ID, date: DATE } as any,
    modelAssessments: [assessment()],
    policy: {
      explicitInvocationRequired: true,
      automaticPolling: false,
      v16PriceIndependent: true,
      provisionalGamesScoredByV16: false,
      missingFinalC4FailsClosed: true,
      nonMlF5MarketsRemainFailClosedWithoutAnotherValidatedAdapter: true,
      discoveryPlanMutatedBeforeOddsAcquisition: false,
      priceCanCreateIntrinsicThesis: false,
      additionalEliteFilterApplied: false,
      betEliteProduced: false,
      finalBetRecommendationProduced: false,
      stakeCalculated: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  } as MlbUnifiedPricedV16RunnerResult;
}

function readyContext() {
  const built = buildMlbDailyBestPickManualPriceContext({
    priced: priced(),
    dailyBestPick: daily(),
    automaticPrice: automaticPrice(),
    now: NOW,
  });
  assert.equal(built.availability.status, "AVAILABLE");
  assert.ok(built.context);
  return built.context;
}

test("manual continuity is available only after automatic execution price is unavailable", () => {
  const built = buildMlbDailyBestPickManualPriceContext({
    priced: priced(),
    dailyBestPick: daily(),
    automaticPrice: automaticPrice(),
    now: NOW,
  });
  assert.equal(built.availability.status, "AVAILABLE");
  assert.equal(built.availability.reason, "READY_FOR_MANUAL_PRICE");
  assert.equal(built.context?.pick.gamePk, 1001);
  assert.equal(built.context?.model.winProbability, 0.6);

  const automatic = buildMlbDailyBestPickManualPriceContext({
    priced: priced(),
    dailyBestPick: daily(),
    automaticPrice: automaticPrice({
      bookKey: "hardrockbet_fl",
      bookTitle: "Hard Rock Bet",
      oddsAmerican: -110,
      capturedAt: NOW.toISOString(),
      providerLastUpdate: NOW.toISOString(),
    }),
    now: NOW,
  });
  assert.equal(automatic.availability.status, "NOT_AVAILABLE");
  assert.equal(automatic.availability.reason, "AUTOMATIC_PRICE_AVAILABLE");
  assert.equal(automatic.context, null);
});

test("manual Hard Rock quote preserves the frozen pick and computes push-aware EV", () => {
  const context = readyContext();
  const view = evaluateMlbDailyBestPickManualPrice({
    context,
    request: {
      runId: RUN_ID,
      date: DATE,
      gamePk: 1001,
      market: "FULL_GAME_ML",
      side: "HOME",
      oddsAmerican: -110,
    },
    now: new Date(NOW.getTime() + 30_000),
  });

  assert.equal(view.decision, "MANUAL_PRICE_POSITIVE_EV");
  assert.equal(view.priceSource, "MANUAL_PRICE");
  assert.equal(view.pick.gamePk, 1001);
  assert.equal(view.pick.market, "FULL_GAME_ML");
  assert.equal(view.execution.bookKey, "hardrockbet_fl");
  assert.equal(view.execution.provenance, "USER_REPORTED_HARD_ROCK");
  assert.equal(view.execution.oddsAmerican, -110);
  assert.ok(view.economics.expectedValuePerUnit > 0);
  assert.equal(view.policy.userReportedPriceCannotCreateOrRerankPick, true);
  assert.equal(view.policy.theOddsApiCreditsConsumed, 0);
  assert.equal(view.policy.betEliteProduced, false);
});

test("manual price reports no positive EV without changing the sporting selection", () => {
  const context = readyContext();
  const view = evaluateMlbDailyBestPickManualPrice({
    context,
    request: {
      runId: RUN_ID,
      date: DATE,
      gamePk: 1001,
      market: "FULL_GAME_ML",
      side: "HOME",
      oddsAmerican: -200,
    },
    now: new Date(NOW.getTime() + 30_000),
  });
  assert.equal(view.decision, "MANUAL_PRICE_NO_POSITIVE_EV");
  assert.equal(view.pick.gamePk, 1001);
  assert.ok(view.economics.expectedValuePerUnit < 0);
});

test("wrong game, market, side or expired context fails closed", () => {
  const context = readyContext();
  assert.throws(
    () => evaluateMlbDailyBestPickManualPrice({
      context,
      request: {
        runId: RUN_ID,
        date: DATE,
        gamePk: 9999,
        market: "FULL_GAME_ML",
        side: "HOME",
        oddsAmerican: -110,
      },
      now: NOW,
    }),
    (error: unknown) => error instanceof MlbDailyBestPickManualPriceError && error.code === "PICK_IDENTITY_MISMATCH",
  );

  assert.throws(
    () => evaluateMlbDailyBestPickManualPrice({
      context,
      request: {
        runId: RUN_ID,
        date: DATE,
        gamePk: 1001,
        market: "FULL_GAME_ML",
        side: "HOME",
        oddsAmerican: -110,
      },
      now: new Date(Date.parse(context.expiresAt) + 1),
    }),
    (error: unknown) => error instanceof MlbDailyBestPickManualPriceError && error.code === "CONTEXT_EXPIRED",
  );
});

test("invalid American odds fail closed", () => {
  const context = readyContext();
  assert.throws(
    () => evaluateMlbDailyBestPickManualPrice({
      context,
      request: {
        runId: RUN_ID,
        date: DATE,
        gamePk: 1001,
        market: "FULL_GAME_ML",
        side: "HOME",
        oddsAmerican: 50,
      },
      now: NOW,
    }),
    (error: unknown) => error instanceof MlbDailyBestPickManualPriceError && error.code === "AMERICAN_ODDS_INVALID",
  );
});

test("SQLite custody stores only validated context and expires fail closed", () => {
  const store = new MlbDailyBestPickManualPriceStore({ filename: ":memory:" });
  try {
    const context = readyContext();
    store.put(context);
    assert.equal(store.get(RUN_ID, NOW.getTime())?.pick.gamePk, 1001);
    assert.equal(store.get(RUN_ID, Date.parse(context.expiresAt) + 1), null);
  } finally {
    store.close();
  }
});
