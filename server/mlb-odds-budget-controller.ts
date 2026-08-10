export const MLB_ODDS_BUDGET_CONTROLLER_VERSION = "courtedge-p0-mlb-odds-budget-controller.v1" as const;

export const MLB_ODDS_ENDPOINT_REPORTED_COSTS = Object.freeze({
  EVENTS: 0,
  EVENT_MARKETS: 1,
} as const);

export type MlbOddsBudgetStatus = "UNPROBED" | "ACTIVE" | "BLOCKED";
export type MlbOddsPaidEndpoint = "EVENT_MARKETS" | "EVENT_ODDS" | "SPORT_ODDS";
export type MlbOddsBudgetBlockReason =
  | "PROVIDER_USAGE_HEADERS_INVALID"
  | "ZERO_COST_PROBE_REPORTED_NONZERO_COST"
  | "PROVIDER_COST_EXCEEDED_AUTHORIZATION"
  | "PROVIDER_USAGE_INCONSISTENT"
  | "RUN_BUDGET_EXCEEDED"
  | "PROVIDER_RESERVE_BREACHED";

export type MlbOddsBudgetDenialCode =
  | "PROVIDER_QUOTA_NOT_PROBED"
  | "BUDGET_CONTROLLER_BLOCKED"
  | "INVALID_OPERATION_ID"
  | "INVALID_OPERATION_PLAN"
  | "DUPLICATE_OPERATION_ID"
  | "RUN_BUDGET_INSUFFICIENT"
  | "PROVIDER_REMAINING_INSUFFICIENT";

export interface HeaderReader {
  get(name: string): string | null;
}

export interface MlbOddsProviderUsageSnapshot {
  requestsRemaining: number;
  requestsUsed: number;
  requestsLast: number;
}

export type MlbOddsUsageHeaderParseResult =
  | { ok: true; value: MlbOddsProviderUsageSnapshot }
  | {
      ok: false;
      code: "MISSING_USAGE_HEADER" | "INVALID_USAGE_HEADER";
      header: "x-requests-remaining" | "x-requests-used" | "x-requests-last";
      raw: string | null;
    };

export interface MlbOddsBudgetConfig {
  runId: string;
  maxRunCredits: number;
  reserveCredits: number;
}

export type MlbOddsBudgetOperationPlan =
  | {
      operationId: string;
      endpoint: "EVENT_MARKETS";
    }
  | {
      operationId: string;
      endpoint: "EVENT_ODDS" | "SPORT_ODDS";
      marketKeys: readonly string[];
      bookmakerCount: number;
    };

export interface MlbOddsBudgetReservation {
  operationId: string;
  endpoint: MlbOddsPaidEndpoint;
  worstCaseCredits: number;
}

export type MlbOddsBudgetAuthorization =
  | { ok: true; reservation: MlbOddsBudgetReservation }
  | { ok: false; code: MlbOddsBudgetDenialCode; detail: string };

export interface MlbOddsBudgetOperationRecord {
  operationId: string;
  endpoint: MlbOddsPaidEndpoint;
  worstCaseCredits: number;
  status: "RESERVED" | "SETTLED" | "RELEASED";
  chargedCredits: number | null;
  accounting: "PROVIDER_HEADER" | "CONSERVATIVE_WORST_CASE" | "NONE";
}

export interface MlbOddsBudgetSnapshot {
  version: typeof MLB_ODDS_BUDGET_CONTROLLER_VERSION;
  runId: string;
  status: MlbOddsBudgetStatus;
  blockReason: MlbOddsBudgetBlockReason | null;
  maxRunCredits: number;
  reserveCredits: number;
  runCreditsCharged: number;
  outstandingWorstCaseCredits: number;
  runCreditsAvailableForNewReservations: number;
  providerQuotaKnown: boolean;
  providerRequestsRemaining: number | null;
  providerRequestsUsed: number | null;
  providerRequestsLast: number | null;
  providerCreditsAvailableAboveReserve: number | null;
  operations: readonly MlbOddsBudgetOperationRecord[];
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function usageHeader(
  headers: HeaderReader,
  name: "x-requests-remaining" | "x-requests-used" | "x-requests-last",
): MlbOddsUsageHeaderParseResult {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === "") {
    return { ok: false, code: "MISSING_USAGE_HEADER", header: name, raw };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, code: "INVALID_USAGE_HEADER", header: name, raw };
  }
  return {
    ok: true,
    value: {
      requestsRemaining: name === "x-requests-remaining" ? parsed : -1,
      requestsUsed: name === "x-requests-used" ? parsed : -1,
      requestsLast: name === "x-requests-last" ? parsed : -1,
    },
  };
}

export function readMlbOddsProviderUsageHeaders(headers: HeaderReader): MlbOddsUsageHeaderParseResult {
  const remaining = usageHeader(headers, "x-requests-remaining");
  if (!remaining.ok) return remaining;
  const used = usageHeader(headers, "x-requests-used");
  if (!used.ok) return used;
  const last = usageHeader(headers, "x-requests-last");
  if (!last.ok) return last;
  return {
    ok: true,
    value: {
      requestsRemaining: remaining.value.requestsRemaining,
      requestsUsed: used.value.requestsUsed,
      requestsLast: last.value.requestsLast,
    },
  };
}

export function bookmakerRegionEquivalents(bookmakerCount: number): number {
  positiveInteger(bookmakerCount, "bookmakerCount");
  return Math.ceil(bookmakerCount / 10);
}

function uniqueMarketCount(marketKeys: readonly string[]): number {
  if (!Array.isArray(marketKeys)) throw new Error("marketKeys must be an array");
  const keys = new Set(marketKeys.map((key) => String(key).trim()).filter(Boolean));
  if (keys.size === 0) throw new Error("at least one market key is required");
  return keys.size;
}

/**
 * Event odds are charged by unique markets actually returned and bookmaker-region
 * equivalents. Requested unique markets therefore form a conservative authorization
 * ceiling before the response exists.
 */
export function estimateMlbEventOddsWorstCaseCredits(
  marketKeys: readonly string[],
  bookmakerCount: number,
): number {
  return uniqueMarketCount(marketKeys) * bookmakerRegionEquivalents(bookmakerCount);
}

/**
 * Featured sport odds are charged by markets specified and bookmaker-region
 * equivalents, so the requested unique market count is the pre-request cost ceiling.
 */
export function estimateMlbSportOddsCredits(
  marketKeys: readonly string[],
  bookmakerCount: number,
): number {
  return uniqueMarketCount(marketKeys) * bookmakerRegionEquivalents(bookmakerCount);
}

export function estimateMlbOperationWorstCaseCredits(plan: MlbOddsBudgetOperationPlan): number {
  if (plan.endpoint === "EVENT_MARKETS") return MLB_ODDS_ENDPOINT_REPORTED_COSTS.EVENT_MARKETS;
  if (plan.endpoint === "EVENT_ODDS") {
    return estimateMlbEventOddsWorstCaseCredits(plan.marketKeys, plan.bookmakerCount);
  }
  if (plan.endpoint === "SPORT_ODDS") {
    return estimateMlbSportOddsCredits(plan.marketKeys, plan.bookmakerCount);
  }
  throw new Error(`unsupported paid odds endpoint: ${String((plan as any)?.endpoint ?? "")}`);
}

export class MlbOddsRunBudgetController {
  private readonly runId: string;
  private readonly maxRunCredits: number;
  private readonly reserveCredits: number;
  private status: MlbOddsBudgetStatus = "UNPROBED";
  private blockReason: MlbOddsBudgetBlockReason | null = null;
  private runCreditsCharged = 0;
  private providerUsage: MlbOddsProviderUsageSnapshot | null = null;
  private readonly operations = new Map<string, MlbOddsBudgetOperationRecord>();

  constructor(config: MlbOddsBudgetConfig) {
    const runId = String(config.runId ?? "").trim();
    if (!runId) throw new Error("runId is required");
    this.runId = runId;
    this.maxRunCredits = nonNegativeInteger(config.maxRunCredits, "maxRunCredits");
    this.reserveCredits = nonNegativeInteger(config.reserveCredits, "reserveCredits");
  }

  ingestZeroCostProbe(headers: HeaderReader): MlbOddsBudgetSnapshot {
    if (this.status !== "UNPROBED") return this.snapshot();
    const parsed = readMlbOddsProviderUsageHeaders(headers);
    if (!parsed.ok) {
      this.block("PROVIDER_USAGE_HEADERS_INVALID");
      return this.snapshot();
    }
    if (parsed.value.requestsLast !== MLB_ODDS_ENDPOINT_REPORTED_COSTS.EVENTS) {
      this.providerUsage = parsed.value;
      this.block("ZERO_COST_PROBE_REPORTED_NONZERO_COST");
      return this.snapshot();
    }
    this.providerUsage = parsed.value;
    this.status = "ACTIVE";
    return this.snapshot();
  }

  authorizePaidOperation(input: MlbOddsBudgetOperationPlan): MlbOddsBudgetAuthorization {
    const operationId = String((input as any)?.operationId ?? "").trim();
    if (!operationId) {
      return { ok: false, code: "INVALID_OPERATION_ID", detail: "operationId is required" };
    }
    if (this.operations.has(operationId)) {
      return { ok: false, code: "DUPLICATE_OPERATION_ID", detail: `operation ${operationId} already exists` };
    }
    if (this.status === "BLOCKED") {
      return { ok: false, code: "BUDGET_CONTROLLER_BLOCKED", detail: String(this.blockReason ?? "blocked") };
    }
    if (this.status !== "ACTIVE" || this.providerUsage == null) {
      return { ok: false, code: "PROVIDER_QUOTA_NOT_PROBED", detail: "zero-cost provider quota probe required before paid work" };
    }

    let worstCaseCredits: number;
    try {
      worstCaseCredits = estimateMlbOperationWorstCaseCredits(input);
    } catch (error: any) {
      return {
        ok: false,
        code: "INVALID_OPERATION_PLAN",
        detail: String(error?.message ?? "invalid odds operation plan"),
      };
    }

    const outstanding = this.outstandingWorstCaseCredits();
    if (this.runCreditsCharged + outstanding + worstCaseCredits > this.maxRunCredits) {
      return {
        ok: false,
        code: "RUN_BUDGET_INSUFFICIENT",
        detail: "operation would exceed the explicit per-run credit budget",
      };
    }

    const spendableProviderCredits = this.providerUsage.requestsRemaining - this.reserveCredits - outstanding;
    if (spendableProviderCredits < worstCaseCredits) {
      return {
        ok: false,
        code: "PROVIDER_REMAINING_INSUFFICIENT",
        detail: "operation cannot be proven safe above the protected provider reserve",
      };
    }

    const reservation: MlbOddsBudgetOperationRecord = {
      operationId,
      endpoint: input.endpoint,
      worstCaseCredits,
      status: "RESERVED",
      chargedCredits: null,
      accounting: "NONE",
    };
    this.operations.set(operationId, reservation);
    return {
      ok: true,
      reservation: {
        operationId,
        endpoint: input.endpoint,
        worstCaseCredits,
      },
    };
  }

  releaseUnissuedOperation(operationIdInput: string): MlbOddsBudgetSnapshot {
    const operationId = String(operationIdInput ?? "").trim();
    const record = this.operations.get(operationId);
    if (!record || record.status !== "RESERVED") {
      throw new Error(`operation ${operationId || "<empty>"} is not an outstanding reservation`);
    }
    this.operations.set(operationId, {
      ...record,
      status: "RELEASED",
      chargedCredits: 0,
      accounting: "NONE",
    });
    return this.snapshot();
  }

  settlePaidOperation(operationIdInput: string, headers: HeaderReader): MlbOddsBudgetSnapshot {
    const operationId = String(operationIdInput ?? "").trim();
    const record = this.operations.get(operationId);
    if (!record || record.status !== "RESERVED") {
      throw new Error(`operation ${operationId || "<empty>"} is not an outstanding reservation`);
    }

    const parsed = readMlbOddsProviderUsageHeaders(headers);
    if (!parsed.ok) {
      this.runCreditsCharged += record.worstCaseCredits;
      this.operations.set(operationId, {
        ...record,
        status: "SETTLED",
        chargedCredits: record.worstCaseCredits,
        accounting: "CONSERVATIVE_WORST_CASE",
      });
      this.providerUsage = null;
      this.block("PROVIDER_USAGE_HEADERS_INVALID");
      return this.snapshot();
    }

    const actualCredits = parsed.value.requestsLast;
    const reconciliation = this.reconcileProviderUsage(parsed.value);
    this.runCreditsCharged += actualCredits;
    this.providerUsage = reconciliation.usage;
    this.operations.set(operationId, {
      ...record,
      status: "SETTLED",
      chargedCredits: actualCredits,
      accounting: "PROVIDER_HEADER",
    });

    if (actualCredits > record.worstCaseCredits) {
      this.block("PROVIDER_COST_EXCEEDED_AUTHORIZATION");
      return this.snapshot();
    }
    if (this.runCreditsCharged > this.maxRunCredits) {
      this.block("RUN_BUDGET_EXCEEDED");
      return this.snapshot();
    }
    if (reconciliation.inconsistent) {
      this.block("PROVIDER_USAGE_INCONSISTENT");
      return this.snapshot();
    }
    if (this.providerUsage.requestsRemaining < this.reserveCredits) {
      this.block("PROVIDER_RESERVE_BREACHED");
      return this.snapshot();
    }
    return this.snapshot();
  }

  snapshot(): MlbOddsBudgetSnapshot {
    const outstandingWorstCaseCredits = this.outstandingWorstCaseCredits();
    const runCreditsAvailableForNewReservations = Math.max(
      0,
      this.maxRunCredits - this.runCreditsCharged - outstandingWorstCaseCredits,
    );
    const providerCreditsAvailableAboveReserve = this.providerUsage == null
      ? null
      : Math.max(0, this.providerUsage.requestsRemaining - this.reserveCredits - outstandingWorstCaseCredits);
    return {
      version: MLB_ODDS_BUDGET_CONTROLLER_VERSION,
      runId: this.runId,
      status: this.status,
      blockReason: this.blockReason,
      maxRunCredits: this.maxRunCredits,
      reserveCredits: this.reserveCredits,
      runCreditsCharged: this.runCreditsCharged,
      outstandingWorstCaseCredits,
      runCreditsAvailableForNewReservations,
      providerQuotaKnown: this.providerUsage != null,
      providerRequestsRemaining: this.providerUsage?.requestsRemaining ?? null,
      providerRequestsUsed: this.providerUsage?.requestsUsed ?? null,
      providerRequestsLast: this.providerUsage?.requestsLast ?? null,
      providerCreditsAvailableAboveReserve,
      operations: [...this.operations.values()].map((record) => ({ ...record })),
    };
  }

  private outstandingWorstCaseCredits(): number {
    let total = 0;
    for (const record of this.operations.values()) {
      if (record.status === "RESERVED") total += record.worstCaseCredits;
    }
    return total;
  }

  private reconcileProviderUsage(next: MlbOddsProviderUsageSnapshot): {
    usage: MlbOddsProviderUsageSnapshot;
    inconsistent: boolean;
  } {
    const current = this.providerUsage;
    if (current == null) return { usage: next, inconsistent: false };

    const usedMovesForward = next.requestsUsed >= current.requestsUsed;
    const remainingMovesDown = next.requestsRemaining <= current.requestsRemaining;
    if (usedMovesForward && remainingMovesDown) {
      return { usage: next, inconsistent: false };
    }

    const looksOlderOrReset = next.requestsUsed <= current.requestsUsed
      && next.requestsRemaining >= current.requestsRemaining;
    if (looksOlderOrReset) {
      return { usage: current, inconsistent: false };
    }

    return {
      usage: {
        requestsRemaining: Math.min(current.requestsRemaining, next.requestsRemaining),
        requestsUsed: Math.max(current.requestsUsed, next.requestsUsed),
        requestsLast: next.requestsLast,
      },
      inconsistent: true,
    };
  }

  private block(reason: MlbOddsBudgetBlockReason): void {
    this.status = "BLOCKED";
    this.blockReason = reason;
  }
}
