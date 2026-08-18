import {
  MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA,
  type MlbFrozenResearchRouteLedgerEntry,
} from "./mlb-frozen-research-route-ledger";
import {
  MLB_UNIFIED_RUNNER_SCHEMA,
  type MlbUnifiedRunnerResult,
} from "./mlb-unified-runner";
import {
  selectMlbDailyBestPick,
  type MlbDailyBestPickRuntimeEvaluation,
  type MlbDailyBestPickSelectorResult,
} from "./mlb-daily-best-pick-selector";

export const MLB_DAILY_BEST_PICK_RUNTIME_ADAPTER_SCHEMA =
  "courtedge-mlb-daily-best-pick-runtime-adapter.v1" as const;

export interface MlbDailyBestPickRuntimeAdapterResult {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_RUNTIME_ADAPTER_SCHEMA;
  officialDate: string;
  sourceRunId: string;
  evaluations: readonly MlbDailyBestPickRuntimeEvaluation[];
  selection: MlbDailyBestPickSelectorResult;
  audit: {
    rankedPrepriceGames: number;
    finalFrozenRowsInRankedPreprice: number;
    provisionalRowsSkipped: number;
    noAPlusOrPremiumRouteSkipped: number;
    readyAPlusEvaluations: number;
    readyPremiumEvaluations: number;
    frozenRouteMatchesOutsideRankedPreprice: number;
  };
  policy: {
    trustedUnifiedPrepriceRuntimeOnly: true;
    finalFrozenInputsOnly: true;
    existingPrepricePopulationPreserved: true;
    existingPrepriceRankPreservedWithinTier: true;
    aPlusRouterPreserved: true;
    premiumFrozenFullGameRoutePreserved: true;
    generalV68FallbackAllowed: false;
    v80Read: false;
    v80Changed: false;
    priceBoundaryCrossed: false;
    newThresholdAdded: false;
    rankingFormulaAdded: false;
    stakingChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function assertRuntimeBoundary(runtime: MlbUnifiedRunnerResult): void {
  if (runtime.schemaVersion !== MLB_UNIFIED_RUNNER_SCHEMA) {
    throw new Error("MLB_DAILY_BEST_PICK_UNIFIED_RUNTIME_SCHEMA_INVALID");
  }
  if (runtime.frozenRouteLedger.schemaVersion !== MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA) {
    throw new Error("MLB_DAILY_BEST_PICK_FROZEN_LEDGER_SCHEMA_INVALID");
  }
  if (runtime.frozenRouteLedger.sourceRunId !== runtime.runId) {
    throw new Error("MLB_DAILY_BEST_PICK_SOURCE_RUN_MISMATCH");
  }
  if (runtime.policy.priceBoundaryCrossed !== false
    || runtime.policy.callsTheOddsApi !== false
    || runtime.policy.originalStep11cPopulationChanged !== false
    || runtime.policy.frozenRouteLedgerChangesRecommendation !== false
    || runtime.policy.frozenRouterDecisionChangesRecommendation !== false
    || runtime.policy.automaticBetPlacement !== false
    || runtime.policy.realFinancialExposure !== 0) {
    throw new Error("MLB_DAILY_BEST_PICK_PREPRICE_POLICY_BOUNDARY_INVALID");
  }
  const ledgerPolicy = runtime.frozenRouteLedger.policy;
  if (ledgerPolicy.outcomeMayAffectPregameAssessment !== false
    || ledgerPolicy.liveFilterChangeAllowed !== false
    || ledgerPolicy.rankingChangeAllowed !== false
    || ledgerPolicy.stakeChangeAllowed !== false
    || ledgerPolicy.automaticBetPlacement !== false
    || ledgerPolicy.realFinancialExposure !== 0) {
    throw new Error("MLB_DAILY_BEST_PICK_FROZEN_POLICY_BOUNDARY_INVALID");
  }
}

function assertEntryShape(entry: MlbFrozenResearchRouteLedgerEntry): void {
  const premium = entry.routes.PREMIUM_A_HOME_ML;
  const aPlus = entry.routes.A_PLUS_HOME_ML;
  const router = entry.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1;

  if (!entry.finalInputs) {
    if (premium !== "NOT_EVALUATED" || aPlus !== "NOT_EVALUATED" || router !== "NOT_EVALUATED") {
      throw new Error(`MLB_DAILY_BEST_PICK_PROVISIONAL_ROUTE_EVALUATED:${entry.gamePk}`);
    }
    return;
  }

  if (premium === "NOT_EVALUATED" || aPlus === "NOT_EVALUATED" || router === "NOT_EVALUATED") {
    throw new Error(`MLB_DAILY_BEST_PICK_FINAL_ROUTE_NOT_EVALUATED:${entry.gamePk}`);
  }
  if (aPlus === "MATCH" && premium !== "MATCH") {
    throw new Error(`MLB_DAILY_BEST_PICK_APLUS_WITHOUT_PREMIUM:${entry.gamePk}`);
  }
  if (aPlus === "MATCH" && router !== "FIRST_5_HOME" && router !== "FULL_GAME_HOME") {
    throw new Error(`MLB_DAILY_BEST_PICK_APLUS_ROUTER_INVALID:${entry.gamePk}`);
  }
  if (aPlus !== "MATCH" && router !== "NOT_APPLICABLE") {
    throw new Error(`MLB_DAILY_BEST_PICK_NON_APLUS_ROUTER_INVALID:${entry.gamePk}`);
  }
}

function hasFrozenTargetRoute(entry: MlbFrozenResearchRouteLedgerEntry): boolean {
  return entry.finalInputs
    && (entry.routes.A_PLUS_HOME_ML === "MATCH" || entry.routes.PREMIUM_A_HOME_ML === "MATCH");
}

function evaluationFromEntry(
  entry: MlbFrozenResearchRouteLedgerEntry,
  prepriceRank: number,
): MlbDailyBestPickRuntimeEvaluation | null {
  if (!entry.finalInputs) return null;

  if (entry.routes.A_PLUS_HOME_ML === "MATCH") {
    const router = entry.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1;
    if (router !== "FIRST_5_HOME" && router !== "FULL_GAME_HOME") {
      throw new Error(`MLB_DAILY_BEST_PICK_APLUS_ROUTER_MISSING:${entry.gamePk}`);
    }
    return Object.freeze({
      officialDate: entry.gameDate,
      gamePk: entry.gamePk,
      market: router === "FIRST_5_HOME" ? "FIRST_5_ML" as const : "FULL_GAME_ML" as const,
      side: "HOME" as const,
      route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" as const,
      evaluationState: "READY" as const,
      prepriceRank,
      sourceEvaluationId: entry.observationId,
    });
  }

  if (entry.routes.PREMIUM_A_HOME_ML === "MATCH") {
    return Object.freeze({
      officialDate: entry.gameDate,
      gamePk: entry.gamePk,
      market: "FULL_GAME_ML" as const,
      side: "HOME" as const,
      route: "PREMIUM_A_HOME_ML" as const,
      evaluationState: "READY" as const,
      prepriceRank,
      sourceEvaluationId: entry.observationId,
    });
  }

  return null;
}

/**
 * Trust boundary for Daily BEST PICK.
 *
 * It consumes the server-internal Step11c unified preprice result, never arbitrary
 * client rows. Only final frozen route evaluations inside the already-ranked
 * preprice population can become READY. No V68/General/V80 fallback is created.
 */
export function selectMlbDailyBestPickFromUnifiedPreprice(input: {
  runtime: MlbUnifiedRunnerResult;
  officialDate?: string;
}): MlbDailyBestPickRuntimeAdapterResult {
  const { runtime } = input;
  assertRuntimeBoundary(runtime);

  const officialDate = input.officialDate ?? runtime.date;
  if (officialDate !== runtime.date) {
    throw new Error("MLB_DAILY_BEST_PICK_RUNTIME_DATE_MISMATCH");
  }

  const entryByGame = new Map<number, MlbFrozenResearchRouteLedgerEntry>();
  for (const entry of runtime.frozenRouteLedger.entries) {
    if (entry.gameDate !== runtime.date) {
      throw new Error(`MLB_DAILY_BEST_PICK_LEDGER_DATE_MISMATCH:${entry.gamePk}`);
    }
    if (entryByGame.has(entry.gamePk)) {
      throw new Error(`MLB_DAILY_BEST_PICK_DUPLICATE_LEDGER_GAME:${entry.gamePk}`);
    }
    assertEntryShape(entry);
    entryByGame.set(entry.gamePk, entry);
  }

  const rankedPks = new Set<number>();
  const evaluations: MlbDailyBestPickRuntimeEvaluation[] = [];
  let finalFrozenRowsInRankedPreprice = 0;
  let provisionalRowsSkipped = 0;
  let noAPlusOrPremiumRouteSkipped = 0;
  let readyAPlusEvaluations = 0;
  let readyPremiumEvaluations = 0;

  runtime.intrinsic.rankedGames.forEach((game, prepriceRank) => {
    if (game.officialDate !== runtime.date) {
      throw new Error(`MLB_DAILY_BEST_PICK_PREPRICE_DATE_MISMATCH:${game.gamePk}`);
    }
    if (rankedPks.has(game.gamePk)) {
      throw new Error(`MLB_DAILY_BEST_PICK_DUPLICATE_PREPRICE_GAME:${game.gamePk}`);
    }
    rankedPks.add(game.gamePk);

    const entry = entryByGame.get(game.gamePk);
    if (!entry) {
      throw new Error(`MLB_DAILY_BEST_PICK_PREPRICE_LEDGER_ROW_REQUIRED:${game.gamePk}`);
    }
    if (!entry.finalInputs) {
      provisionalRowsSkipped += 1;
      return;
    }
    finalFrozenRowsInRankedPreprice += 1;

    const evaluation = evaluationFromEntry(entry, prepriceRank);
    if (!evaluation) {
      noAPlusOrPremiumRouteSkipped += 1;
      return;
    }
    evaluations.push(evaluation);
    if (evaluation.route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1") readyAPlusEvaluations += 1;
    else readyPremiumEvaluations += 1;
  });

  const frozenRouteMatchesOutsideRankedPreprice = runtime.frozenRouteLedger.entries.filter(
    (entry) => !rankedPks.has(entry.gamePk) && hasFrozenTargetRoute(entry),
  ).length;

  const frozenEvaluations = Object.freeze([...evaluations]);
  const selection = selectMlbDailyBestPick({ officialDate, evaluations: frozenEvaluations });

  return Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_RUNTIME_ADAPTER_SCHEMA,
    officialDate,
    sourceRunId: runtime.runId,
    evaluations: frozenEvaluations,
    selection,
    audit: Object.freeze({
      rankedPrepriceGames: runtime.intrinsic.rankedGames.length,
      finalFrozenRowsInRankedPreprice,
      provisionalRowsSkipped,
      noAPlusOrPremiumRouteSkipped,
      readyAPlusEvaluations,
      readyPremiumEvaluations,
      frozenRouteMatchesOutsideRankedPreprice,
    }),
    policy: Object.freeze({
      trustedUnifiedPrepriceRuntimeOnly: true as const,
      finalFrozenInputsOnly: true as const,
      existingPrepricePopulationPreserved: true as const,
      existingPrepriceRankPreservedWithinTier: true as const,
      aPlusRouterPreserved: true as const,
      premiumFrozenFullGameRoutePreserved: true as const,
      generalV68FallbackAllowed: false as const,
      v80Read: false as const,
      v80Changed: false as const,
      priceBoundaryCrossed: false as const,
      newThresholdAdded: false as const,
      rankingFormulaAdded: false as const,
      stakingChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
