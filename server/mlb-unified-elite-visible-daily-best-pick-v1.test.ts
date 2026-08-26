import assert from "node:assert/strict";
import test from "node:test";
import { MLB_DAILY_BEST_PICK_UI_SCHEMA, type MlbDailyBestPickUiView } from "./mlb-daily-best-pick-ui-view";
import {
  MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA,
  buildMlbUnifiedEliteVisibleDailyBestPick,
} from "./mlb-unified-elite-visible-daily-best-pick-v1";

const officialDate = "2026-08-26";
const audit = {
  readyAPlusEvaluations: 0,
  readyPremiumEvaluations: 0,
  provisionalRowsSkipped: 0,
  frozenRouteMatchesOutsideRankedPreprice: 0,
};
const parentPolicy = {
  trustedUnifiedPrepriceRuntimeOnly: true,
  finalFrozenInputsOnly: true,
  aPlusAlwaysPrecedesPremium: true,
  existingPrepriceRankPreservedWithinTier: true,
  generalV68FallbackAllowed: false,
  v80Read: false,
  v80Changed: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
} as const;
const parentNoPlay: MlbDailyBestPickUiView = {
  schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
  decision: "NO_PLAY",
  pick: null,
  audit,
  policy: parentPolicy,
};
const parentAPlus: MlbDailyBestPickUiView = {
  schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
  decision: "BEST_PICK",
  pick: {
    gamePk: 1,
    awayTeam: "Away One",
    homeTeam: "Home One",
    market: "FULL_GAME_ML",
    side: "HOME",
    route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1",
    tier: "A_PLUS",
    prepriceRank: 0,
  },
  audit,
  policy: parentPolicy,
};
const slate = {
  date: officialDate,
  games: [
    { gamePk: 1, officialDate, awayTeam: { name: "Away One" }, homeTeam: { name: "Home One" } },
    { gamePk: 2, officialDate, awayTeam: { name: "Away Two" }, homeTeam: { name: "Home Two" } },
    { gamePk: 3, officialDate, awayTeam: { name: "Away Three" }, homeTeam: { name: "Home Three" } },
  ],
} as any;

test("A+ or Premium visible parent always keeps priority over lower tiers", () => {
  const result = buildMlbUnifiedEliteVisibleDailyBestPick({
    officialDate,
    slate,
    parentDailyBestPick: parentAPlus,
    lowerTier: {
      ppHorizon: { status: "SELECTION", selection: { officialDate, gamePk: 2, market: "FG_ML", horizon: "FG", side: "AWAY" } },
      fullModular: { status: "SELECTION", selection: { officialDate, gamePk: 3, market: "F5_ML", horizon: "F5", side: "HOME" } },
    },
  });
  assert.equal(result.schemaVersion, MLB_DAILY_BEST_PICK_UI_SCHEMA);
  assert.equal(result.decision, "BEST_PICK");
  assert.equal(result.pick?.gamePk, 1);
});

test("PP_HORIZON becomes visible after parent A+/Premium NO_PLAY", () => {
  const result = buildMlbUnifiedEliteVisibleDailyBestPick({
    officialDate,
    slate,
    parentDailyBestPick: parentNoPlay,
    lowerTier: {
      ppHorizon: { status: "SELECTION", selection: { officialDate, gamePk: 2, market: "FG_RL_HOME_PLUS_1_5", horizon: "FG", side: "AWAY", selectedLine: -1.5 } },
      fullModular: { status: "SELECTION", selection: { officialDate, gamePk: 3, market: "F5_ML", horizon: "F5", side: "HOME" } },
      sourceStatus: "CERTIFIED_OPERATIONAL_LOWER_TIER_LIVE_V1",
    },
  });
  assert.equal(result.schemaVersion, MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA);
  assert.equal(result.decision, "BEST_PICK");
  assert.equal(result.pick?.gamePk, 2);
  assert.equal((result as any).pick.tier, "PP_HORIZON");
});

test("Full Modular is visible when PP_HORIZON returns genuine NO_PLAY", () => {
  const result = buildMlbUnifiedEliteVisibleDailyBestPick({
    officialDate,
    slate,
    parentDailyBestPick: parentNoPlay,
    lowerTier: {
      ppHorizon: { status: "NO_PLAY", reason: "PP_HORIZON_NO_SELECTION" },
      fullModular: { status: "SELECTION", selection: { officialDate, gamePk: 3, market: "F5_ML", horizon: "F5", side: "HOME" } },
      sourceStatus: "CERTIFIED_OPERATIONAL_LOWER_TIER_LIVE_V1",
    },
  });
  assert.equal(result.schemaVersion, MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA);
  assert.equal(result.decision, "BEST_PICK");
  assert.equal(result.pick?.gamePk, 3);
  assert.equal((result as any).pick.tier, "FULL_MODULAR");
});

test("invalid lower-tier identity fails closed back to parent NO_PLAY", () => {
  const result = buildMlbUnifiedEliteVisibleDailyBestPick({
    officialDate,
    slate,
    parentDailyBestPick: parentNoPlay,
    lowerTier: {
      ppHorizon: { status: "SELECTION", selection: { officialDate: "2026-08-25", gamePk: 2, market: "FG_ML", horizon: "FG", side: "HOME" } },
      fullModular: { status: "NO_PLAY", reason: "NO_SELECTION" },
    },
  });
  assert.equal(result.schemaVersion, MLB_DAILY_BEST_PICK_UI_SCHEMA);
  assert.equal(result.decision, "NO_PLAY");
});
