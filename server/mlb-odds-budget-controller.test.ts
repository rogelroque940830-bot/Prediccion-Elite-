import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MLB_ODDS_ENDPOINT_REPORTED_COSTS,
  MlbOddsRunBudgetController,
  bookmakerRegionEquivalents,
  estimateMlbEventOddsWorstCaseCredits,
  estimateMlbOperationWorstCaseCredits,
  estimateMlbSportOddsCredits,
  readMlbOddsProviderUsageHeaders,
  type HeaderReader,
  type MlbOddsBudgetOperationPlan,
} from "./mlb-odds-budget-controller";

function usageHeaders(remaining: number | string, used: number | string, last: number | string): HeaderReader {
  const values = new Map<string, string>([
    ["x-requests-remaining", String(remaining)],
    ["x-requests-used", String(used)],
    ["x-requests-last", String(last)],
  ]);
  return { get: (name: string) => values.get(name.toLowerCase()) ?? null };
}

function missingHeader(nameToOmit: string): HeaderReader {
  const base = new Map<string, string>([
    ["x-requests-remaining", "100"],
    ["x-requests-used", "25"],
    ["x-requests-last", "0"],
  ]);
  base.delete(nameToOmit);
  return { get: (name: string) => base.get(name.toLowerCase()) ?? null };
}

function eventMarketsPlan(operationId: string): MlbOddsBudgetOperationPlan {
  return { operationId, endpoint: "EVENT_MARKETS" };
}

function eventOddsPlan(
  operationId: string,
  marketKeys: readonly string[],
  bookmakerCount = 1,
): MlbOddsBudgetOperationPlan {
  return { operationId, endpoint: "EVENT_ODDS", marketKeys, bookmakerCount };
}

test("official endpoint cost primitives preserve zero-cost probe and one-credit event-market discovery", () => {
  assert.equal(MLB_ODDS_ENDPOINT_REPORTED_COSTS.EVENTS, 0);
  assert.equal(MLB_ODDS_ENDPOINT_REPORTED_COSTS.EVENT_MARKETS, 1);
  assert.equal(estimateMlbOperationWorstCaseCredits(eventMarketsPlan("markets")), 1);
});

test("usage headers are strict non-negative integers and all three are required", () => {
  const parsed = readMlbOddsProviderUsageHeaders(usageHeaders(742, 258, 3));
  assert.deepEqual(parsed, {
    ok: true,
    value: { requestsRemaining: 742, requestsUsed: 258, requestsLast: 3 },
  });

  for (const name of ["x-requests-remaining", "x-requests-used", "x-requests-last"]) {
    const missing = readMlbOddsProviderUsageHeaders(missingHeader(name));
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.code, "MISSING_USAGE_HEADER");
      assert.equal(missing.header, name);
    }
  }

  for (const value of ["-1", "1.5", "NaN", "Infinity", "not-a-number"]) {
    const invalid = readMlbOddsProviderUsageHeaders(usageHeaders(value, 1, 0));
    assert.equal(invalid.ok, false, `expected invalid remaining header for ${value}`);
  }
});

test("bookmaker groups and market de-duplication produce a conservative event-odds upper bound", () => {
  assert.equal(bookmakerRegionEquivalents(1), 1);
  assert.equal(bookmakerRegionEquivalents(10), 1);
  assert.equal(bookmakerRegionEquivalents(11), 2);
  assert.equal(bookmakerRegionEquivalents(20), 2);
  assert.equal(bookmakerRegionEquivalents(21), 3);
  assert.throws(() => bookmakerRegionEquivalents(0));

  assert.equal(
    estimateMlbEventOddsWorstCaseCredits(["h2h", "h2h", "totals", "spreads"], 4),
    3,
  );
  assert.equal(
    estimateMlbEventOddsWorstCaseCredits(["h2h", "totals"], 11),
    4,
  );
  assert.equal(
    estimateMlbSportOddsCredits(["h2h", "totals", "totals"], 1),
    2,
  );
  assert.throws(() => estimateMlbEventOddsWorstCaseCredits([], 1));
});

test("controller derives paid-operation cost itself instead of trusting a caller-supplied credit number", () => {
  const plan = eventOddsPlan("derived-cost", ["h2h", "totals", "spreads", "h2h"], 11);
  assert.equal(estimateMlbOperationWorstCaseCredits(plan), 6);

  const budget = new MlbOddsRunBudgetController({ runId: "run-derived", maxRunCredits: 10, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  const auth = budget.authorizePaidOperation(plan);
  assert.equal(auth.ok, true);
  if (auth.ok) assert.equal(auth.reservation.worstCaseCredits, 6);
});

test("invalid operation ids and malformed cost plans are denied before reservation", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-invalid-plan", maxRunCredits: 10, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));

  const missingId = budget.authorizePaidOperation({
    operationId: "",
    endpoint: "EVENT_MARKETS",
  });
  assert.equal(missingId.ok, false);
  if (!missingId.ok) assert.equal(missingId.code, "INVALID_OPERATION_ID");

  const malformed = budget.authorizePaidOperation({
    operationId: "bad-odds-plan",
    endpoint: "EVENT_ODDS",
    marketKeys: [],
    bookmakerCount: 1,
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.code, "INVALID_OPERATION_PLAN");
});

test("paid work is impossible until a zero-cost quota probe establishes provider remaining", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-unprobed", maxRunCredits: 5, reserveCredits: 20 });
  const denied = budget.authorizePaidOperation(eventMarketsPlan("event-1-markets"));
  assert.deepEqual(denied, {
    ok: false,
    code: "PROVIDER_QUOTA_NOT_PROBED",
    detail: "zero-cost provider quota probe required before paid work",
  });
  assert.equal(budget.snapshot().runCreditsCharged, 0);
});

test("zero-cost probe must itself prove x-requests-last=0 or controller blocks", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-probe", maxRunCredits: 5, reserveCredits: 10 });
  const state = budget.ingestZeroCostProbe(usageHeaders(100, 50, 1));
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.blockReason, "ZERO_COST_PROBE_REPORTED_NONZERO_COST");
  const denied = budget.authorizePaidOperation(eventMarketsPlan("later"));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "BUDGET_CONTROLLER_BLOCKED");
});

test("missing usage headers on the zero-cost probe fail closed before any paid call", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-bad-probe", maxRunCredits: 5, reserveCredits: 10 });
  const state = budget.ingestZeroCostProbe(missingHeader("x-requests-remaining"));
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.blockReason, "PROVIDER_USAGE_HEADERS_INVALID");
  assert.equal(state.providerQuotaKnown, false);
});

test("run budget and provider reserve both account for concurrent outstanding reservations", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-reservations", maxRunCredits: 5, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(20, 80, 0));

  const first = budget.authorizePaidOperation(eventOddsPlan("odds-a", ["h2h", "totals", "spreads"]));
  assert.equal(first.ok, true);
  const second = budget.authorizePaidOperation(eventOddsPlan("odds-b", ["h2h", "totals"]));
  assert.equal(second.ok, true);

  const state = budget.snapshot();
  assert.equal(state.outstandingWorstCaseCredits, 5);
  assert.equal(state.runCreditsAvailableForNewReservations, 0);
  assert.equal(state.providerCreditsAvailableAboveReserve, 5);

  const third = budget.authorizePaidOperation(eventOddsPlan("odds-c", ["h2h"]));
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.code, "RUN_BUDGET_INSUFFICIENT");
});

test("provider reserve can deny an operation even when the per-run budget still has room", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-reserve", maxRunCredits: 10, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(12, 88, 0));
  const denied = budget.authorizePaidOperation(eventOddsPlan("needs-3", ["h2h", "totals", "spreads"]));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "PROVIDER_REMAINING_INSUFFICIENT");
  assert.equal(budget.snapshot().runCreditsCharged, 0);
});

test("settlement charges the provider-reported actual cost, not the reserved upper bound", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-settle", maxRunCredits: 8, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  const auth = budget.authorizePaidOperation(eventOddsPlan(
    "event-odds",
    ["h2h", "totals", "spreads", "h2h_1st_5_innings", "totals_1st_5_innings"],
  ));
  assert.equal(auth.ok, true);
  if (auth.ok) assert.equal(auth.reservation.worstCaseCredits, 5);

  const settled = budget.settlePaidOperation("event-odds", usageHeaders(98, 202, 2));
  assert.equal(settled.status, "ACTIVE");
  assert.equal(settled.runCreditsCharged, 2);
  assert.equal(settled.outstandingWorstCaseCredits, 0);
  assert.equal(settled.runCreditsAvailableForNewReservations, 6);
  assert.equal(settled.providerRequestsRemaining, 98);
  assert.equal(settled.operations[0]?.chargedCredits, 2);
  assert.equal(settled.operations[0]?.accounting, "PROVIDER_HEADER");
});

test("empty-data or otherwise zero-cost event-odds response can settle at x-requests-last=0", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-zero-result", maxRunCredits: 2, reserveCredits: 5 });
  budget.ingestZeroCostProbe(usageHeaders(50, 50, 0));
  budget.authorizePaidOperation(eventOddsPlan("event-odds-empty", ["h2h", "totals"]));
  const settled = budget.settlePaidOperation("event-odds-empty", usageHeaders(50, 50, 0));
  assert.equal(settled.status, "ACTIVE");
  assert.equal(settled.runCreditsCharged, 0);
  assert.equal(settled.runCreditsAvailableForNewReservations, 2);
});

test("missing post-call usage headers charge the authorized worst case conservatively and block further spend", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-missing-after", maxRunCredits: 6, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  budget.authorizePaidOperation(eventMarketsPlan("event-markets"));

  const state = budget.settlePaidOperation("event-markets", missingHeader("x-requests-last"));
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.blockReason, "PROVIDER_USAGE_HEADERS_INVALID");
  assert.equal(state.runCreditsCharged, 1);
  assert.equal(state.providerQuotaKnown, false);
  assert.equal(state.operations[0]?.accounting, "CONSERVATIVE_WORST_CASE");
  assert.equal(state.operations[0]?.chargedCredits, 1);
});

test("provider cost above the controller-derived authorization is recorded and permanently blocks the run", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-cost-violation", maxRunCredits: 10, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  budget.authorizePaidOperation(eventMarketsPlan("event-markets"));
  const state = budget.settlePaidOperation("event-markets", usageHeaders(98, 202, 2));
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.blockReason, "PROVIDER_COST_EXCEEDED_AUTHORIZATION");
  assert.equal(state.runCreditsCharged, 2);
});

test("provider reserve breach after settlement blocks the run even if actual charge was authorized", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-reserve-breach", maxRunCredits: 10, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(12, 88, 0));
  budget.authorizePaidOperation(eventMarketsPlan("event-markets"));
  const state = budget.settlePaidOperation("event-markets", usageHeaders(9, 91, 1));
  assert.equal(state.status, "BLOCKED");
  assert.equal(state.blockReason, "PROVIDER_RESERVE_BREACHED");
});

test("released reservations cost zero but their operation ids cannot be reused", () => {
  const budget = new MlbOddsRunBudgetController({ runId: "run-release", maxRunCredits: 4, reserveCredits: 10 });
  budget.ingestZeroCostProbe(usageHeaders(100, 200, 0));
  budget.authorizePaidOperation(eventOddsPlan("candidate-a", ["h2h", "totals", "spreads"]));
  const released = budget.releaseUnissuedOperation("candidate-a");
  assert.equal(released.runCreditsCharged, 0);
  assert.equal(released.outstandingWorstCaseCredits, 0);
  assert.equal(released.operations[0]?.status, "RELEASED");

  const duplicate = budget.authorizePaidOperation(eventOddsPlan("candidate-a", ["h2h"]));
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, "DUPLICATE_OPERATION_ID");
});

test("controller source is pure budget accounting: no provider request, secret, timer, or invented default credit cap", () => {
  const source = fs.readFileSync("server/mlb-odds-budget-controller.ts", "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /ODDS_API_KEY|process\.env/);
  assert.doesNotMatch(source, /setInterval|setTimeout/);
  assert.doesNotMatch(source, /DEFAULT.*CREDIT|CREDIT.*DEFAULT/);
  assert.match(source, /maxRunCredits: number/);
  assert.match(source, /reserveCredits: number/);
  assert.match(source, /estimateMlbOperationWorstCaseCredits\(input\)/);
});
