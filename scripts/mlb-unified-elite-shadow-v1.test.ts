import assert from "node:assert/strict";
import type { MlbDailyBestPickUiView } from "../server/mlb-daily-best-pick-ui-view";
import {
  MLB_UNIFIED_ELITE_LOWER_TIER_PROMOTION_STATUS,
  buildMlbUnifiedEliteShadowView,
  unavailableLowerTierShadowDecisions,
} from "../server/mlb-unified-elite-shadow-v1";

const DATE = "2026-08-19";

function noPlay(): MlbDailyBestPickUiView {
  return {
    schemaVersion: "courtedge-mlb-daily-best-pick-ui.v1",
    decision: "NO_PLAY",
    pick: null,
    audit: {
      readyAPlusEvaluations: 0,
      readyPremiumEvaluations: 0,
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

function visible(tier: "A_PLUS" | "PREMIUM", gamePk: number, market: "FIRST_5_ML" | "FULL_GAME_ML"): MlbDailyBestPickUiView {
  const x = noPlay();
  return {
    ...x,
    decision: "BEST_PICK",
    pick: {
      gamePk,
      awayTeam: "Away",
      homeTeam: "Home",
      market,
      side: "HOME",
      route: tier === "A_PLUS" ? "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" : "PREMIUM_A_HOME_ML",
      tier,
      prepriceRank: 0,
    },
  };
}

function lowerSelection(gamePk: number) {
  return {
    officialDate: DATE,
    gamePk,
    market: "FG_RL_HOME_PLUS_1_5",
    horizon: "FG",
    side: "HOME",
    selectedLine: 1.5,
  };
}

{
  const view = buildMlbUnifiedEliteShadowView({ officialDate: DATE, dailyBestPick: visible("A_PLUS", 1001, "FIRST_5_ML") });
  assert.equal(view.router.control.status, "SELECTION");
  assert.equal(view.router.challenger.status, "SELECTION");
  if (view.router.control.status === "SELECTION") assert.equal(view.router.control.selectedTier, "A_PLUS");
  if (view.router.challenger.status === "SELECTION") assert.equal(view.router.challenger.selectedTier, "A_PLUS");
  assert.equal(view.visibleRecommendationChanged, false);
  assert.equal(view.lowerTierRecommendationVisible, false);
}

{
  const view = buildMlbUnifiedEliteShadowView({ officialDate: DATE, dailyBestPick: visible("PREMIUM", 1002, "FULL_GAME_ML") });
  assert.equal(view.router.control.status, "SELECTION");
  assert.equal(view.router.challenger.status, "SELECTION");
  if (view.router.control.status === "SELECTION") assert.equal(view.router.control.selectedTier, "PREMIUM");
  if (view.router.challenger.status === "SELECTION") assert.equal(view.router.challenger.selectedTier, "PREMIUM");
}

{
  const view = buildMlbUnifiedEliteShadowView({
    officialDate: DATE,
    dailyBestPick: noPlay(),
    lowerTier: {
      ppHorizon: { status: "SELECTION", selection: { ...lowerSelection(2001), market: "F5_ML", horizon: "F5", selectedLine: null } },
      fullModular: { status: "SELECTION", selection: lowerSelection(2002) },
      sourceStatus: "CERTIFIED_TEST_SOURCE",
    },
  });
  assert.equal(view.router.control.status, "SELECTION");
  assert.equal(view.router.challenger.status, "SELECTION");
  if (view.router.control.status === "SELECTION") assert.equal(view.router.control.selectedTier, "FULL_MODULAR");
  if (view.router.challenger.status === "SELECTION") assert.equal(view.router.challenger.selectedTier, "PP_HORIZON");
  assert.equal(view.lowerTierPromotionStatus, MLB_UNIFIED_ELITE_LOWER_TIER_PROMOTION_STATUS);
  assert.equal(view.lowerTierRecommendationVisible, false);
  assert.equal(view.outcomesRead, false);
  assert.equal(view.performanceMetricsRead, false);
}

{
  const view = buildMlbUnifiedEliteShadowView({
    officialDate: DATE,
    dailyBestPick: noPlay(),
    lowerTier: {
      ppHorizon: { status: "NO_PLAY", reason: "NO_PP_SELECTION" },
      fullModular: { status: "SELECTION", selection: lowerSelection(3001) },
      sourceStatus: "CERTIFIED_TEST_SOURCE",
    },
  });
  assert.equal(view.router.control.status, "SELECTION");
  assert.equal(view.router.challenger.status, "NO_PLAY");
  if (view.router.challenger.status === "NO_PLAY") assert.equal(view.router.challenger.reason, "PP_HORIZON_NO_PLAY");
}

{
  const view = buildMlbUnifiedEliteShadowView({
    officialDate: DATE,
    dailyBestPick: noPlay(),
    lowerTier: {
      ppHorizon: { status: "TECHNICAL_UNAVAILABLE", reason: "PP_RUNTIME_INTEGRITY_FAILED" },
      fullModular: { status: "SELECTION", selection: lowerSelection(4001) },
      sourceStatus: "CERTIFIED_TEST_SOURCE",
    },
  });
  assert.equal(view.router.control.status, "SELECTION");
  assert.equal(view.router.challenger.status, "SELECTION");
  if (view.router.challenger.status === "SELECTION") assert.equal(view.router.challenger.selectedTier, "FULL_MODULAR");
}

{
  const lower = unavailableLowerTierShadowDecisions();
  const view = buildMlbUnifiedEliteShadowView({ officialDate: DATE, dailyBestPick: noPlay(), lowerTier: lower });
  assert.equal(view.router.control.status, "NO_PLAY");
  assert.equal(view.router.challenger.status, "NO_PLAY");
  assert.equal(view.lowerTierSourceStatus, "LOWER_TIER_LIVE_SOURCE_NOT_MATERIALIZED");
  assert.equal(view.stakeCalculated, false);
  assert.equal(view.automaticBetPlacement, false);
  assert.equal(view.realFinancialExposure, 0);
}

{
  const view = buildMlbUnifiedEliteShadowView({ officialDate: "2026-08-18", dailyBestPick: visible("A_PLUS", 5001, "FULL_GAME_ML") });
  assert.equal(view.router.control.status, "NO_PLAY");
  assert.equal(view.router.challenger.status, "NO_PLAY");
  if (view.router.control.status === "NO_PLAY") assert.equal(view.router.control.reason, "BEFORE_FROZEN_PROSPECTIVE_BOUNDARY");
  assert.equal(view.visibleDailyBestPickPreserved, true);
}

console.log("MLB_UNIFIED_ELITE_SHADOW_V1_TESTS_PASSED");
