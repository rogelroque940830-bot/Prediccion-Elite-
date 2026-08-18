export const MLB_DAILY_BEST_PICK_SELECTOR_SCHEMA = "courtedge-mlb-daily-best-pick-selector.v2" as const;

export type MlbDailyBestPickEvaluationState =
  | "READY"
  | "PROVISIONAL"
  | "BLOCKED"
  | "UNEVALUATED";

export type MlbDailyBestPickMarket = "FIRST_5_ML" | "FULL_GAME_ML";
export type MlbDailyBestPickSide = "HOME" | "AWAY";
export type MlbDailyBestPickTier = "A_PLUS" | "PREMIUM";

/**
 * Only routes that already exist in the frozen runtime are executable here.
 * V68/General/V80 route names are deliberately absent: this selector must not
 * manufacture a fallback or import an experimental portfolio into production.
 */
export type MlbDailyBestPickExecutableRoute =
  | "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1"
  | "PREMIUM_A_HOME_ML";

export interface MlbDailyBestPickRuntimeEvaluation {
  officialDate: string;
  gamePk: number;
  market: MlbDailyBestPickMarket;
  side: MlbDailyBestPickSide;
  route: string;
  evaluationState: MlbDailyBestPickEvaluationState;
  /** Existing zero-based order from the preprice runtime. No new score is created. */
  prepriceRank: number | null;
  sourceEvaluationId?: string | null;
}

export type MlbDailyBestPickRejectionReason =
  | "NOT_READY"
  | "ROUTE_NOT_EXECUTABLE"
  | "DATE_MISMATCH"
  | "INVALID_GAME_PK"
  | "INVALID_PREPRICE_RANK";

export interface MlbDailyBestPickSelected {
  officialDate: string;
  gamePk: number;
  market: MlbDailyBestPickMarket;
  side: MlbDailyBestPickSide;
  route: MlbDailyBestPickExecutableRoute;
  tier: MlbDailyBestPickTier;
  evaluationState: "READY";
  prepriceRank: number;
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
    existingPrepriceRankPreservedWithinTier: true;
    provisionalAllowed: false;
    unevaluatedAllowed: false;
    generalV68FallbackAllowed: false;
    v80DependencyAllowed: false;
    numericEligibilityThresholdAdded: false;
    rankingFormulaAdded: false;
    frozenRoutingChanged: false;
    stakingChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

const TIER_ORDER: Readonly<Record<MlbDailyBestPickExecutableRoute, number>> = Object.freeze({
  A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1: 0,
  PREMIUM_A_HOME_ML: 1,
});

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function executableRoute(route: string): route is MlbDailyBestPickExecutableRoute {
  return route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" || route === "PREMIUM_A_HOME_ML";
}

function tier(route: MlbDailyBestPickExecutableRoute): MlbDailyBestPickTier {
  return route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" ? "A_PLUS" : "PREMIUM";
}

function validPrepriceRank(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function compareReadyExecutable(
  left: MlbDailyBestPickRuntimeEvaluation & { route: MlbDailyBestPickExecutableRoute; prepriceRank: number },
  right: MlbDailyBestPickRuntimeEvaluation & { route: MlbDailyBestPickExecutableRoute; prepriceRank: number },
): number {
  // Fixed tier boundary: Premium can never outrank A+.
  const tierDelta = TIER_ORDER[left.route] - TIER_ORDER[right.route];
  if (tierDelta !== 0) return tierDelta;

  // Inside the same tier, preserve the existing preprice order exactly.
  if (left.prepriceRank !== right.prepriceRank) return left.prepriceRank - right.prepriceRank;

  // Identity-only deterministic fallback; it carries no scientific weight.
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
    INVALID_PREPRICE_RANK: 0,
  };
}

export function selectMlbDailyBestPick(input: {
  officialDate: string;
  evaluations: readonly MlbDailyBestPickRuntimeEvaluation[];
}): MlbDailyBestPickSelectorResult {
  if (!validDate(input.officialDate)) throw new Error("MLB_DAILY_BEST_PICK_INVALID_DATE");

  const rejectionCounts = emptyRejectionCounts();
  let readyEvaluations = 0;
  const eligible: Array<MlbDailyBestPickRuntimeEvaluation & {
    route: MlbDailyBestPickExecutableRoute;
    prepriceRank: number;
  }> = [];

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
      rejectionCounts.ROUTE_NOT_EXECUTABLE += 1;
      continue;
    }
    if (!validPrepriceRank(evaluation.prepriceRank)) {
      rejectionCounts.INVALID_PREPRICE_RANK += 1;
      continue;
    }
    eligible.push({
      ...evaluation,
      route: evaluation.route,
      prepriceRank: evaluation.prepriceRank,
    });
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
        prepriceRank: winner.prepriceRank,
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
      existingPrepriceRankPreservedWithinTier: true as const,
      provisionalAllowed: false as const,
      unevaluatedAllowed: false as const,
      generalV68FallbackAllowed: false as const,
      v80DependencyAllowed: false as const,
      numericEligibilityThresholdAdded: false as const,
      rankingFormulaAdded: false as const,
      frozenRoutingChanged: false as const,
      stakingChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
