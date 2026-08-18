import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_DAILY_BEST_PICK_UI_SCHEMA,
  parseMlbDailyBestPickUiView,
  presentMlbDailyBestPick,
} from "./mlb-daily-best-pick";

const policy = {
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

const audit = {
  readyAPlusEvaluations: 1,
  readyPremiumEvaluations: 2,
  provisionalRowsSkipped: 3,
  frozenRouteMatchesOutsideRankedPreprice: 1,
};

function aPlus(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
    decision: "BEST_PICK",
    pick: {
      gamePk: 1001,
      awayTeam: "Away Club",
      homeTeam: "Home Club",
      market: "FIRST_5_ML",
      side: "HOME",
      route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1",
      tier: "A_PLUS",
      prepriceRank: 1,
    },
    audit,
    policy,
    ...overrides,
  };
}

test("presents a frozen A+ First 5 BEST PICK without price or stake semantics", () => {
  const display = presentMlbDailyBestPick(aPlus());
  assert.equal(display.state, "BEST_PICK");
  if (display.state !== "BEST_PICK") return;
  assert.equal(display.selectedTeam, "Home Club");
  assert.equal(display.marketLabel, "First 5 ML");
  assert.equal(display.tierLabel, "A+");
  assert.equal(display.rankLabel, "#2");
  assert.equal(display.route, "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1");
  assert.match(display.message, /cuota no participa/i);
  assert.match(display.message, /no calcula stake/i);
});

test("presents the frozen Premium route only as Full Game ML", () => {
  const display = presentMlbDailyBestPick({
    schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
    decision: "BEST_PICK",
    pick: {
      gamePk: 2002,
      awayTeam: "Away Premium",
      homeTeam: "Home Premium",
      market: "FULL_GAME_ML",
      side: "HOME",
      route: "PREMIUM_A_HOME_ML",
      tier: "PREMIUM",
      prepriceRank: 0,
    },
    audit,
    policy,
  });
  assert.equal(display.state, "BEST_PICK");
  if (display.state !== "BEST_PICK") return;
  assert.equal(display.tierLabel, "Premium");
  assert.equal(display.marketLabel, "Full Game ML");
  assert.equal(display.selectedTeam, "Home Premium");
});

test("presents explicit pre-price NO PLAY and never fabricates a pick", () => {
  const display = presentMlbDailyBestPick({
    schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
    decision: "NO_PLAY",
    pick: null,
    audit: { ...audit, readyAPlusEvaluations: 0, readyPremiumEvaluations: 0 },
    policy,
  });
  assert.equal(display.state, "NO_PLAY");
  if (display.state !== "NO_PLAY") return;
  assert.match(display.message, /no fuerza una jugada/i);
  assert.equal(display.audit.readyAPlusEvaluations, 0);
  assert.equal(display.audit.readyPremiumEvaluations, 0);
});

test("fails closed when schema version is not the frozen UI contract", () => {
  const display = presentMlbDailyBestPick(aPlus({ schemaVersion: "future-schema" }));
  assert.equal(display.state, "UNAVAILABLE");
  assert.equal(parseMlbDailyBestPickUiView(aPlus({ schemaVersion: "future-schema" })), null);
});

test("fails closed if General/V68 fallback is enabled", () => {
  const display = presentMlbDailyBestPick(aPlus({
    policy: { ...policy, generalV68FallbackAllowed: true },
  }));
  assert.equal(display.state, "UNAVAILABLE");
});

test("fails closed if V80 is read or changed", () => {
  assert.equal(presentMlbDailyBestPick(aPlus({ policy: { ...policy, v80Read: true } })).state, "UNAVAILABLE");
  assert.equal(presentMlbDailyBestPick(aPlus({ policy: { ...policy, v80Changed: true } })).state, "UNAVAILABLE");
});

test("fails closed if automatic betting or financial exposure appears", () => {
  assert.equal(
    presentMlbDailyBestPick(aPlus({ policy: { ...policy, automaticBetPlacement: true } })).state,
    "UNAVAILABLE",
  );
  assert.equal(
    presentMlbDailyBestPick(aPlus({ policy: { ...policy, realFinancialExposure: 1 } })).state,
    "UNAVAILABLE",
  );
});

test("fails closed on route and tier corruption", () => {
  const corrupted = aPlus();
  corrupted.pick = { ...corrupted.pick, tier: "PREMIUM" } as typeof corrupted.pick;
  assert.equal(presentMlbDailyBestPick(corrupted).state, "UNAVAILABLE");
});

test("fails closed if Premium is presented as First 5", () => {
  const display = presentMlbDailyBestPick({
    schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
    decision: "BEST_PICK",
    pick: {
      gamePk: 2003,
      awayTeam: "Away",
      homeTeam: "Home",
      market: "FIRST_5_ML",
      side: "HOME",
      route: "PREMIUM_A_HOME_ML",
      tier: "PREMIUM",
      prepriceRank: 0,
    },
    audit,
    policy,
  });
  assert.equal(display.state, "UNAVAILABLE");
});

test("fails closed if a home-only frozen route is exposed as AWAY", () => {
  const corrupted = aPlus();
  corrupted.pick = { ...corrupted.pick, side: "AWAY" } as typeof corrupted.pick;
  assert.equal(presentMlbDailyBestPick(corrupted).state, "UNAVAILABLE");
});

test("decision and pick must agree", () => {
  assert.equal(presentMlbDailyBestPick(aPlus({ decision: "NO_PLAY" })).state, "UNAVAILABLE");
  assert.equal(presentMlbDailyBestPick(aPlus({ pick: null })).state, "UNAVAILABLE");
});

test("rank and audit counters must be non-negative integers", () => {
  const badRank = aPlus();
  badRank.pick = { ...badRank.pick, prepriceRank: -1 };
  assert.equal(presentMlbDailyBestPick(badRank).state, "UNAVAILABLE");
  assert.equal(
    presentMlbDailyBestPick(aPlus({ audit: { ...audit, provisionalRowsSkipped: -1 } })).state,
    "UNAVAILABLE",
  );
});
