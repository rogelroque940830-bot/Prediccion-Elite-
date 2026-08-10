import assert from "node:assert/strict";
import test from "node:test";
import {
  MlbOddsRunBudgetController,
  type HeaderReader,
} from "./mlb-odds-budget-controller";

function usageHeaders(remaining: number, used: number, last: number): HeaderReader {
  const values = new Map<string, string>([
    ["x-requests-remaining", String(remaining)],
    ["x-requests-used", String(used)],
    ["x-requests-last", String(last)],
  ]);
  return { get: (name: string) => values.get(name.toLowerCase()) ?? null };
}

test("the zero-cost quota probe initializes a run only once and cannot inflate budget mid-run", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "single-probe", maxRunCredits: 10, reserveCredits: 10 });
  const initial = budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  assert.equal(initial.status, "ACTIVE");
  assert.equal(initial.providerRequestsRemaining, 100);
  assert.equal(initial.providerRequestsUsed, 200);

  const ignored = budget.ingestZeroCostProbe(usageHeaders(999, 1, 0));
  assert.equal(ignored.status, "ACTIVE");
  assert.equal(ignored.providerRequestsRemaining, 100);
  assert.equal(ignored.providerRequestsUsed, 200);
});

test("out-of-order paid responses cannot raise provider remaining or roll usage backwards", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "out-of-order", maxRunCredits: 5, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));

  const first = budget.authorizePaidOperation({ operationId: "a", endpoint: "EVENT_MARKETS" });
  const second = budget.authorizePaidOperation({ operationId: "b", endpoint: "EVENT_MARKETS" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const newerArrivesFirst = budget.settlePaidOperation("b", usageHeaders(98, 202, 1));
  assert.equal(newerArrivesFirst.status, "ACTIVE");
  assert.equal(newerArrivesFirst.providerRequestsRemaining, 98);
  assert.equal(newerArrivesFirst.providerRequestsUsed, 202);
  assert.equal(newerArrivesFirst.outstandingWorstCaseCredits, 1);

  const olderArrivesSecond = budget.settlePaidOperation("a", usageHeaders(99, 201, 1));
  assert.equal(olderArrivesSecond.status, "ACTIVE");
  assert.equal(olderArrivesSecond.providerRequestsRemaining, 98);
  assert.equal(olderArrivesSecond.providerRequestsUsed, 202);
  assert.equal(olderArrivesSecond.runCreditsCharged, 2);
  assert.equal(olderArrivesSecond.outstandingWorstCaseCredits, 0);
});

test("a reset-like older snapshot is treated conservatively during the same run", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "reset-like", maxRunCredits: 5, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  budget.authorizePaidOperation({ operationId: "first", endpoint: "EVENT_MARKETS" });
  budget.authorizePaidOperation({ operationId: "second", endpoint: "EVENT_MARKETS" });

  budget.settlePaidOperation("first", usageHeaders(99, 201, 1));
  const state = budget.settlePaidOperation("second", usageHeaders(500, 2, 1));

  assert.equal(state.status, "ACTIVE");
  assert.equal(state.providerRequestsRemaining, 99);
  assert.equal(state.providerRequestsUsed, 201);
  assert.equal(state.runCreditsCharged, 2);
});

test("internally contradictory quota movement blocks further paid work and preserves the conservative balance", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "inconsistent", maxRunCredits: 5, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  budget.authorizePaidOperation({ operationId: "first", endpoint: "EVENT_MARKETS" });
  budget.authorizePaidOperation({ operationId: "second", endpoint: "EVENT_MARKETS" });

  budget.settlePaidOperation("first", usageHeaders(98, 202, 1));
  const state = budget.settlePaidOperation("second", usageHeaders(99, 203, 1));

  assert.equal(state.status, "BLOCKED");
  assert.equal(state.blockReason, "PROVIDER_USAGE_INCONSISTENT");
  assert.equal(state.providerRequestsRemaining, 98);
  assert.equal(state.providerRequestsUsed, 203);
  assert.equal(state.runCreditsCharged, 2);

  const denied = budget.authorizePaidOperation({ operationId: "third", endpoint: "EVENT_MARKETS" });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "BUDGET_CONTROLLER_BLOCKED");
});
