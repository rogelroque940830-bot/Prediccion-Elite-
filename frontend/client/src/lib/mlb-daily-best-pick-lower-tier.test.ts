import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA,
  presentMlbDailyBestPick,
} from "./mlb-daily-best-pick";

const audit = {
  readyAPlusEvaluations: 0,
  readyPremiumEvaluations: 0,
  provisionalRowsSkipped: 0,
  frozenRouteMatchesOutsideRankedPreprice: 0,
};

const policy = {
  parentAPlusPremiumNoPlayRequired: true,
  aPlusAlwaysPrecedesPremium: true,
  premiumAlwaysPrecedesLowerTiers: true,
  ppHorizonPrecedesFullModular: true,
  fullModularFallbackAfterPpNoPlayAllowed: true,
  lowerTierSelectionUsesSportsbookPrice: false,
  v68ScientificContractChanged: false,
  v80ScientificContractChanged: false,
  ppHorizonProspectiveCustodyChanged: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
} as const;

test("presents PP_HORIZON as a visible Daily BEST PICK", () => {
  const display = presentMlbDailyBestPick({
    schemaVersion: MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA,
    decision: "BEST_PICK",
    pick: {
      gamePk: 9001,
      awayTeam: "Away",
      homeTeam: "Home",
      market: "FG_RL_HOME_PLUS_1_5",
      horizon: "FG",
      side: "AWAY",
      selectedLine: -1.5,
      route: "PP_HORIZON_FROZEN_LIVE_V1",
      tier: "PP_HORIZON",
    },
    audit,
    lowerTierSourceStatus: "CERTIFIED_OPERATIONAL_LOWER_TIER_LIVE_V1:10",
    policy,
  });

  assert.equal(display.state, "BEST_PICK");
  if (display.state !== "BEST_PICK") return;
  assert.equal(display.tierLabel, "PP Horizon");
  assert.equal(display.selectedTeam, "Away");
  assert.equal(display.sideLabel, "AWAY");
  assert.equal(display.marketLabel, "Full Game Run Line -1.5");
});

test("presents Full Modular as the final visible lower-tier fallback", () => {
  const display = presentMlbDailyBestPick({
    schemaVersion: MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA,
    decision: "BEST_PICK",
    pick: {
      gamePk: 9002,
      awayTeam: "Away",
      homeTeam: "Home",
      market: "F5_ML",
      horizon: "F5",
      side: "HOME",
      selectedLine: null,
      route: "FULL_MODULAR_FROZEN_LIVE_V1",
      tier: "FULL_MODULAR",
    },
    audit,
    lowerTierSourceStatus: "CERTIFIED_OPERATIONAL_LOWER_TIER_LIVE_V1:8",
    policy,
  });

  assert.equal(display.state, "BEST_PICK");
  if (display.state !== "BEST_PICK") return;
  assert.equal(display.tierLabel, "Full Modular");
  assert.equal(display.selectedTeam, "Home");
  assert.equal(display.marketLabel, "First 5 ML");
});
