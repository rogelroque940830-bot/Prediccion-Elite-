import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_DAILY_BEST_PICK_PRICE_TRUST_REJECTED,
  buildMlbDailyBestPickPriceViewFailClosed,
} from "./mlb-daily-best-pick-price-safe-view";

function dailyBestPick() {
  return {
    schemaVersion: "courtedge-mlb-daily-best-pick-ui.v1",
    decision: "BEST_PICK",
    pick: {
      gamePk: 123,
      awayTeam: "Away",
      homeTeam: "Home",
      market: "FIRST_5_ML",
      side: "HOME",
      route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1",
      tier: "A_PLUS",
      prepriceRank: 0,
    },
    audit: {
      readyAPlusEvaluations: 1,
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
  } as any;
}

function corruptedPricedRuntime() {
  return {
    schemaVersion: "courtedge-p0-mlb-unified-priced-v16-runner.v1",
    runId: "run-1",
    preprice: { runId: "run-1" },
    marketEdge: { sourceRunId: "wrong-run", games: [], policy: {} },
    operatingEnvelope: { sourceRunId: "wrong-run", games: [], policy: {} },
    policy: {},
  } as any;
}

test("corrupted priced evidence fails closed without mutating or fabricating a pick", () => {
  let rejected: unknown = null;
  const view = buildMlbDailyBestPickPriceViewFailClosed({
    priced: corruptedPricedRuntime(),
    dailyBestPick: dailyBestPick(),
    onRejected: (error) => { rejected = error; },
  });

  assert.ok(rejected instanceof Error);
  assert.equal(view.decision, "PRICE_EVIDENCE_UNAVAILABLE");
  assert.equal(view.pick, null);
  assert.equal(view.execution, null);
  assert.equal(view.economics, null);
  assert.deepEqual(view.blockers, [MLB_DAILY_BEST_PICK_PRICE_TRUST_REJECTED]);
  assert.equal(view.policy.sportingSelectionChangedByPrice, false);
  assert.equal(view.policy.fallbackToAnotherGameAllowed, false);
  assert.equal(view.policy.betEliteLabelProduced, false);
  assert.equal(view.policy.automaticBetPlacement, false);
  assert.equal(view.policy.realFinancialExposure, 0);
});
