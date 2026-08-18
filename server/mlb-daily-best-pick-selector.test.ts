import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_DAILY_BEST_PICK_SELECTOR_SCHEMA,
  selectMlbDailyBestPick,
  type MlbDailyBestPickRuntimeEvaluation,
} from "./mlb-daily-best-pick-selector";

const DATE = "2026-08-17";

function evaluation(
  overrides: Partial<MlbDailyBestPickRuntimeEvaluation> = {},
): MlbDailyBestPickRuntimeEvaluation {
  return {
    officialDate: DATE,
    gamePk: 100001,
    market: "FULL_GAME_ML",
    side: "HOME",
    route: "PREMIUM_A_ROUTE_SWITCH",
    evaluationState: "READY",
    frozenPriority: 3,
    consensusScore: 0.62,
    classifierScore: 0.71,
    sourceEvaluationId: "eval-1",
    ...overrides,
  };
}

test("A+ always precedes Premium even when Premium has stronger numeric tie-breakers", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({
        gamePk: 200002,
        route: "PREMIUM_A_V68_AGREE_ROUTE_SWITCH",
        frozenPriority: 0,
        consensusScore: 0.99,
        classifierScore: 0.99,
      }),
      evaluation({
        gamePk: 300003,
        route: "A_PLUS_D1_ROUTER",
        frozenPriority: 99,
        consensusScore: 0.51,
        classifierScore: 0.51,
      }),
    ],
  });

  assert.equal(result.schemaVersion, MLB_DAILY_BEST_PICK_SELECTOR_SCHEMA);
  assert.equal(result.decision, "BEST_PICK");
  assert.equal(result.pick?.tier, "A_PLUS");
  assert.equal(result.pick?.route, "A_PLUS_D1_ROUTER");
  assert.equal(result.pick?.gamePk, 300003);
  assert.equal(result.policy.aPlusAlwaysPrecedesPremium, true);
  assert.equal(result.policy.numericEligibilityThresholdAdded, false);
});

test("within A+ the frozen V68-agree route precedes the base A+ route", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({
        gamePk: 100010,
        route: "A_PLUS_D1_ROUTER",
        frozenPriority: 0,
        classifierScore: 0.99,
      }),
      evaluation({
        gamePk: 100020,
        route: "A_PLUS_V68_AGREE_D1_ROUTER",
        frozenPriority: 999,
        classifierScore: 0.50,
      }),
    ],
  });

  assert.equal(result.pick?.route, "A_PLUS_V68_AGREE_D1_ROUTER");
  assert.equal(result.pick?.gamePk, 100020);
});

test("Premium is selected only when there is no executable READY A+ evaluation", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({
        gamePk: 100030,
        route: "A_PLUS_D1_ROUTER",
        evaluationState: "PROVISIONAL",
      }),
      evaluation({
        gamePk: 100040,
        route: "PREMIUM_A_ROUTE_SWITCH",
        evaluationState: "READY",
      }),
    ],
  });

  assert.equal(result.decision, "BEST_PICK");
  assert.equal(result.pick?.tier, "PREMIUM");
  assert.equal(result.pick?.gamePk, 100040);
  assert.equal(result.summary.rejectionCounts.NOT_READY, 1);
});

test("PROVISIONAL, BLOCKED and UNEVALUATED candidates can never become Daily BEST PICK", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({ gamePk: 100050, route: "A_PLUS_D1_ROUTER", evaluationState: "PROVISIONAL" }),
      evaluation({ gamePk: 100051, route: "A_PLUS_D1_ROUTER", evaluationState: "BLOCKED" }),
      evaluation({ gamePk: 100052, route: "PREMIUM_A_ROUTE_SWITCH", evaluationState: "UNEVALUATED" }),
    ],
  });

  assert.equal(result.decision, "NO_PLAY");
  assert.equal(result.pick, null);
  assert.equal(result.summary.executableReadyEvaluations, 0);
  assert.equal(result.summary.rejectionCounts.NOT_READY, 3);
});

test("General V16/V68 consensus fallback is rejected even when marked READY", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({
        gamePk: 100060,
        route: "V16_V68_CONSENSUS_T0.550",
        evaluationState: "READY",
        consensusScore: 0.95,
      }),
    ],
  });

  assert.equal(result.decision, "NO_PLAY");
  assert.equal(result.pick, null);
  assert.equal(result.summary.readyEvaluations, 1);
  assert.equal(result.summary.executableReadyEvaluations, 0);
  assert.equal(result.summary.rejectionCounts.ROUTE_NOT_EXECUTABLE, 1);
  assert.equal(result.policy.generalV68FallbackAllowed, false);
});

test("unknown or future fallback routes are fail-closed instead of being inferred", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({ route: "PREMIUM_FUTURE_ROUTE", evaluationState: "READY" }),
      evaluation({ gamePk: 100071, route: "V68_GENERAL_FALLBACK", evaluationState: "READY" }),
    ],
  });

  assert.equal(result.decision, "NO_PLAY");
  assert.equal(result.summary.rejectionCounts.ROUTE_NOT_EXECUTABLE, 2);
});

test("wrong-date and invalid-game evaluations are rejected before selection", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({ officialDate: "2026-08-16", route: "A_PLUS_D1_ROUTER" }),
      evaluation({ gamePk: 0, route: "A_PLUS_D1_ROUTER" }),
      evaluation({ gamePk: 100082, route: "PREMIUM_A_ROUTE_SWITCH" }),
    ],
  });

  assert.equal(result.pick?.gamePk, 100082);
  assert.equal(result.summary.rejectionCounts.DATE_MISMATCH, 1);
  assert.equal(result.summary.rejectionCounts.INVALID_GAME_PK, 1);
});

test("same-route ties use frozen priority, then frozen scores, then gamePk deterministically", () => {
  const result = selectMlbDailyBestPick({
    officialDate: DATE,
    evaluations: [
      evaluation({
        gamePk: 100093,
        route: "A_PLUS_D1_ROUTER",
        frozenPriority: 2,
        consensusScore: 0.99,
        classifierScore: 0.99,
      }),
      evaluation({
        gamePk: 100092,
        route: "A_PLUS_D1_ROUTER",
        frozenPriority: 1,
        consensusScore: 0.60,
        classifierScore: 0.60,
      }),
      evaluation({
        gamePk: 100091,
        route: "A_PLUS_D1_ROUTER",
        frozenPriority: 1,
        consensusScore: 0.60,
        classifierScore: 0.60,
      }),
    ],
  });

  assert.equal(result.pick?.gamePk, 100091);
});

test("empty slate produces explicit NO_PLAY and preserves zero-exposure policy", () => {
  const result = selectMlbDailyBestPick({ officialDate: DATE, evaluations: [] });

  assert.equal(result.decision, "NO_PLAY");
  assert.equal(result.pick, null);
  assert.equal(result.summary.inputEvaluations, 0);
  assert.equal(result.policy.v80MutationAllowed, false);
  assert.equal(result.policy.routingMutationAllowed, false);
  assert.equal(result.policy.stakingChanged, false);
  assert.equal(result.policy.automaticBetPlacement, false);
  assert.equal(result.policy.realFinancialExposure, 0);
});

test("invalid requested date fails closed", () => {
  assert.throws(
    () => selectMlbDailyBestPick({ officialDate: "2026-02-31", evaluations: [] }),
    /MLB_DAILY_BEST_PICK_INVALID_DATE/,
  );
});
