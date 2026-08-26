import type {
  MlbDailyOpportunityContextResult,
  MlbDailyOpportunityEntry,
} from "./mlb-daily-opportunity-context-v1";

export const MLB_DAILY_OPPORTUNITY_PRICE_SHORTLIST_SCHEMA =
  "courtedge-mlb-daily-opportunity-price-shortlist.v1" as const;

export const MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS = 3 as const;

export type MlbDailyOpportunityPriceTiming =
  | "READY_IF_PRICE_LAYER_INVOKED"
  | "DEFER_UNTIL_FINAL_INPUTS";

export interface MlbDailyOpportunityPriceShortlistEntry {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  awayTeam: string;
  homeTeam: string;
  inputStage: "FINAL" | "PROVISIONAL";
  contextRank: number;
  selectedSide: "HOME" | "AWAY" | null;
  selectedSideProbability: number | null;
  robustSelectedSideProbability: number | null;
  priceTiming: MlbDailyOpportunityPriceTiming;
  selectionBasis: readonly (
    | "BEST_CONTEXT"
    | "BEST_ROBUST_PROBABILITY"
    | "FRONTIER_DEPTH"
  )[];
}

export interface MlbDailyOpportunityPriceShortlist {
  schemaVersion: typeof MLB_DAILY_OPPORTUNITY_PRICE_SHORTLIST_SCHEMA;
  entries: readonly MlbDailyOpportunityPriceShortlistEntry[];
  summary: {
    wholeSlateSportingOpportunitiesEvaluated: number;
    nonDominatedFrontierSize: number;
    shortlistedForPossiblePriceConsultation: number;
    readyFinalCandidates: number;
    deferredProvisionalCandidates: number;
  };
  policy: {
    wholeSlateAnalysisAllowed: true;
    maximumPriceConsultationCandidates: typeof MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS;
    wholeSlateAnalysisDoesNotExpandPriceQuota: true;
    shortlistUsesOnlyNonDominatedSportingFrontier: true;
    noUniversalWeightedScoreIntroduced: true;
    provisionalCandidateMayRemainInSportingShortlist: true;
    provisionalCandidateCannotBeMarkedPriceReady: true;
    marketPricesRead: false;
    paidOddsCalled: false;
    theOddsApiCreditsConsumed: 0;
    v68Changed: false;
    v80Changed: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function robustProbability(entry: MlbDailyOpportunityEntry): number {
  return entry.probability.robustSelectedSideProbability ?? Number.NEGATIVE_INFINITY;
}

function chooseUnique(
  selected: MlbDailyOpportunityEntry[],
  candidate: MlbDailyOpportunityEntry | undefined,
): void {
  if (!candidate) return;
  if (selected.some((entry) => entry.gamePk === candidate.gamePk)) return;
  if (selected.length >= MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS) return;
  selected.push(candidate);
}

function selectionBases(
  entry: MlbDailyOpportunityEntry,
  bestContextGamePk: number | null,
  bestProbabilityGamePk: number | null,
): MlbDailyOpportunityPriceShortlistEntry["selectionBasis"] {
  const output: Array<"BEST_CONTEXT" | "BEST_ROBUST_PROBABILITY" | "FRONTIER_DEPTH"> = [];
  if (entry.gamePk === bestContextGamePk) output.push("BEST_CONTEXT");
  if (entry.gamePk === bestProbabilityGamePk) output.push("BEST_ROBUST_PROBABILITY");
  if (output.length === 0) output.push("FRONTIER_DEPTH");
  return Object.freeze(output);
}

/**
 * Economic-boundary shortlist only. The sporting engine is allowed to evaluate the full slate,
 * while this selector preserves the original operational intent of consulting prices for only
 * one to three serious opportunities. It does not call an odds provider.
 *
 * To avoid inventing a universal weighted score, the selector preserves two Pareto-frontier
 * anchors first: best sporting-context rank and best robust V16 probability. If room remains,
 * it fills by existing context rank. Provisional candidates may remain visible as future
 * opportunities but are never marked ready for a paid price lookup until FINAL inputs exist.
 */
export function buildMlbDailyOpportunityPriceShortlist(
  opportunity: MlbDailyOpportunityContextResult,
): MlbDailyOpportunityPriceShortlist {
  const frontier = [...opportunity.nonDominatedFrontier];
  const bestContext = frontier
    .slice()
    .sort((left, right) => left.contextRank - right.contextRank || left.gamePk - right.gamePk)[0];
  const probabilityCandidates = frontier.filter((entry) =>
    entry.probability.robustSelectedSideProbability !== null,
  );
  const bestProbability = probabilityCandidates
    .slice()
    .sort((left, right) =>
      robustProbability(right) - robustProbability(left)
      || left.contextRank - right.contextRank
      || left.gamePk - right.gamePk,
    )[0];

  const selected: MlbDailyOpportunityEntry[] = [];
  chooseUnique(selected, bestContext);
  chooseUnique(selected, bestProbability);

  for (const entry of frontier
    .slice()
    .sort((left, right) =>
      left.contextRank - right.contextRank
      || robustProbability(right) - robustProbability(left)
      || left.gamePk - right.gamePk,
    )) {
    chooseUnique(selected, entry);
  }

  const entries = Object.freeze(selected.map((entry) => Object.freeze({
    gamePk: entry.gamePk,
    officialDate: entry.officialDate,
    startTime: entry.startTime,
    awayTeam: entry.awayTeam,
    homeTeam: entry.homeTeam,
    inputStage: entry.inputStage,
    contextRank: entry.contextRank,
    selectedSide: entry.probability.selectedSide,
    selectedSideProbability: entry.probability.selectedSideProbability,
    robustSelectedSideProbability: entry.probability.robustSelectedSideProbability,
    priceTiming: entry.inputStage === "FINAL"
      ? "READY_IF_PRICE_LAYER_INVOKED" as const
      : "DEFER_UNTIL_FINAL_INPUTS" as const,
    selectionBasis: selectionBases(
      entry,
      bestContext?.gamePk ?? null,
      bestProbability?.gamePk ?? null,
    ),
  })));

  return Object.freeze({
    schemaVersion: MLB_DAILY_OPPORTUNITY_PRICE_SHORTLIST_SCHEMA,
    entries,
    summary: Object.freeze({
      wholeSlateSportingOpportunitiesEvaluated: opportunity.summary.intrinsicEvaluatedGames,
      nonDominatedFrontierSize: frontier.length,
      shortlistedForPossiblePriceConsultation: entries.length,
      readyFinalCandidates: entries.filter((entry) => entry.priceTiming === "READY_IF_PRICE_LAYER_INVOKED").length,
      deferredProvisionalCandidates: entries.filter((entry) => entry.priceTiming === "DEFER_UNTIL_FINAL_INPUTS").length,
    }),
    policy: Object.freeze({
      wholeSlateAnalysisAllowed: true as const,
      maximumPriceConsultationCandidates: MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS,
      wholeSlateAnalysisDoesNotExpandPriceQuota: true as const,
      shortlistUsesOnlyNonDominatedSportingFrontier: true as const,
      noUniversalWeightedScoreIntroduced: true as const,
      provisionalCandidateMayRemainInSportingShortlist: true as const,
      provisionalCandidateCannotBeMarkedPriceReady: true as const,
      marketPricesRead: false as const,
      paidOddsCalled: false as const,
      theOddsApiCreditsConsumed: 0 as const,
      v68Changed: false as const,
      v80Changed: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
