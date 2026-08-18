export const MLB_DAILY_BEST_PICK_SELECTOR_SCHEMA = "courtedge-mlb-daily-best-pick-selector.v1" as const;

export type MlbDailyBestPickEvaluationState =
  | "READY"
  | "PROVISIONAL"
  | "BLOCKED"
  | "UNEVALUATED";

export type MlbDailyBestPickMarket = "FIRST_5_ML" | "FULL_GAME_ML";
export type MlbDailyBestPickSide = "HOME" | "AWAY";
export type MlbDailyBestPickTier = "A_PLUS" | "PREMIUM";

export type MlbDailyBestPickExecutableRoute =
  | "A_PLUS_V68_AGREE_D1_ROUTER"
  | "A_PLUS_D1_ROUTER"
  | "PREMIUM_A_V68_AGREE_ROUTE_SWITCH"
  | "PREMIUM_A_ROUTE_SWITCH";

export interface MlbDailyBestPickRuntimeEvaluation {
  officialDate: string;
  gamePk: number;
  market: MlbDailyBestPickMarket;
  side: MlbDailyBestPickSide;
  route: string;
  evaluationState: MlbDailyBestPickEvaluationState;
  frozenPriority: number | null;
  consensusScore: number | null;
  classifierScore: number | null;
  sourceEvaluationId?: string | null;
}

export type MlbDailyBestPickRejectionReason =
  | "NOT_READY"
  | "ROUTE_NOT_EXECUTABLE"
  | "DATE_MISMATCH"
  | "INVALID_GAME_PK";

export interface MlbDailyBestPickSelected {
  officialDate: string;
  gamePk: number;
  market: MlbDailyBestPickMarket;
  side: MlbDailyBestPickSide;
  route: MlbDailyBestPickExecutableRoute;
  tier: MlbDailyBestPickTier;
  evaluationState: "READY";
  frozenPriority: number | null;
  consensusScore: number | null;
  classifierScore: number | null;
  sourceEvaluationId: string | null;
}

export interface MlbDailyBestPickSelectorResult {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_SELECTOR_SCHEMA;
  officialDate: string;
  decision: "BEST_PICK" | "NO_PLAY";
  pick: MlbDailyBestPickSelected | null;
  summary: {
    inputEvaluations: number;
    readyEvaluations: number;
    executableReadyEvaluations: number;
    rejectedEvaluations: number;
    rejectionCounts: Record<MlbDailyBestPickRejectionReason, number>;
  };
  policy: {
    readyEvaluationsOnly: true;
    aPlusAlwaysPrecedesPremium: true;
    provisionalAllowed: false;
    unevaluatedAllowed: false;
    generalV68FallbackAllowed: false;
    numericEligibilityThresholdAdded: false;
    v80MutationAllowed: false;
    rankingMutationAllowed: false;
    routingMutationAllowed: false;
    stakingChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

const ROUTE_ORDER: readonly MlbDailyBestPickExecutableRoute[] = [
  "A_PLUS_V68_AGREE_D1_ROUTER",
  "A_PLUS_D1_ROUTER",
  "PREMIUM_A_V68_AGREE_ROUTE_SWITCH",
  "PREMIUM_A_ROUTE_SWITCH",
] as const;

const ROUTE_ORDER_INDEX = new Map<string, number>(ROUTE_ORDER.map((route, index) => [route, index]));

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function executableRoute(route: string): route is MlbDailyBestPickExecutableRoute {
  return ROUTE_ORDER_INDEX.has(route);
}

function tier(route: MlbDailyBestPickExecutableRoute): MlbDailyBestPickTier {
  return route.startsWith("A_PLUS_") ? "A_PLUS" : "PREMIUM";
}

function finiteOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareFiniteNullableDescending(left: number | null, right: number | null): number {
  const leftValue = finiteOrNull(left);
  const rightValue = finiteOrNull(right);
  if (leftValue == null && rightValue == null) return 0;
  if (leftValue == null) return 1;
  if (rightValue == null) return -1;
  return rightValue - leftValue;
}

function frozenPriority(value: number | null): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : Number.MAX_SAFE_INTEGER;
}

function compareReadyExecutable(
  left: MlbDailyBestPickRuntimeEvaluation & { route: MlbDailyBestPickExecutableRoute },
  right: MlbDailyBestPickRuntimeEvaluation & { route: MlbDailyBestPickExecutableRoute },
): number {
  // Tier/route order is fixed here so a Premium candidate can never jump ahead of A+.
  const routeDelta = ROUTE_ORDER_INDEX.get(left.route)! - ROUTE_ORDER_INDEX.get(right.route)!;
  if (routeDelta !== 0) return routeDelta;

  // Frozen priority and frozen scores are tie-breakers only inside the exact same authorized route.
  const priorityDelta = frozenPriority(left.frozenPriority) - frozenPriority(right.frozenPriority);
  if (priorityDelta !== 0) return priorityDelta;

  const consensusDelta = compareFiniteNullableDescending(left.consensusScore, right.consensusScore);
  if (consensusDelta !== 0) return consensusDelta;

  const classifierDelta = compareFiniteNullableDescending(left.classifierScore, right.classifierScore);
  if (classifierDelta !== 0) return classifierDelta;

  if (left.gamePk !== right.gamePk) return left.gamePk - right.gamePk;
  if (left.market !== right.market) return left.market.localeCompare(right.market);
  if (left.side !== right.side) return left.side.localeCompare(right.side);
  return String(left.sourceEvaluationId ?? "").localeCompare(String(right.sourceEvaluationId ?? ""));
}

function emptyRejectionCounts(): Record<MlbDailyBestPickRejectionReason, number> {
  return {
    NOT_READY: 0,
    ROUTE_NOT_EXECUTABLE: 0,
    DATE_MISMATCH: 0,
    INVALID_GAME_PK: 0,
  };
}

export function selectMlbDailyBestPick(input: {
  officialDate: string;
  evaluations: readonly MlbDailyBestPickRuntimeEvaluation[];
}): MlbDailyBestPickSelectorResult {
  if (!validDate(input.officialDate)) throw new Error("MLB_DAILY_BEST_PICK_INVALID_DATE");

  const rejectionCounts = emptyRejectionCounts();
  let readyEvaluations = 0;
  const eligible: Array<MlbDailyBestPickRuntimeEvaluation & { route: MlbDailyBestPickExecutableRoute }> = [];

  for (const evaluation of input.evaluations) {
    if (evaluation.evaluationState === "READY") readyEvaluations += 1;

    if (evaluation.officialDate !== input.officialDate) {
      rejectionCounts.DATE_MISMATCH += 1;
      continue;
    }
    if (!Number.isInteger(evaluation.gamePk) || evaluation.gamePk <= 0) {
      rejectionCounts.INVALID_GAME_PK += 1;
      continue;
    }
    if (evaluation.evaluationState !== "READY") {
      rejectionCounts.NOT_READY += 1;
      continue;
    }
    if (!executableRoute(evaluation.route)) {
      // This intentionally excludes V16_V68_CONSENSUS_T0.550 and every other
      // General/V68 fallback route. A route must already be an A+ or Premium route.
      rejectionCounts.ROUTE_NOT_EXECUTABLE += 1;
      continue;
    }
    eligible.push({ ...evaluation, route: evaluation.route });
  }

  eligible.sort(compareReadyExecutable);
  const winner = eligible[0] ?? null;
  const rejectedEvaluations = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0);

  const pick: MlbDailyBestPickSelected | null = winner
    ? Object.freeze({
        officialDate: winner.officialDate,
        gamePk: winner.gamePk,
        market: winner.market,
        side: winner.side,
        route: winner.route,
        tier: tier(winner.route),
        evaluationState: "READY" as const,
        frozenPriority: finiteOrNull(winner.frozenPriority),
        consensusScore: finiteOrNull(winner.consensusScore),
        classifierScore: finiteOrNull(winner.classifierScore),
        sourceEvaluationId: winner.sourceEvaluationId ?? null,
      })
    : null;

  return Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_SELECTOR_SCHEMA,
    officialDate: input.officialDate,
    decision: pick ? "BEST_PICK" as const : "NO_PLAY" as const,
    pick,
    summary: Object.freeze({
      inputEvaluations: input.evaluations.length,
      readyEvaluations,
      executableReadyEvaluations: eligible.length,
      rejectedEvaluations,
      rejectionCounts: Object.freeze({ ...rejectionCounts }),
    }),
    policy: Object.freeze({
      readyEvaluationsOnly: true as const,
      aPlusAlwaysPrecedesPremium: true as const,
      provisionalAllowed: false as const,
      unevaluatedAllowed: false as const,
      generalV68FallbackAllowed: false as const,
      numericEligibilityThresholdAdded: false as const,
      v80MutationAllowed: false as const,
      rankingMutationAllowed: false as const,
      routingMutationAllowed: false as const,
      stakingChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
