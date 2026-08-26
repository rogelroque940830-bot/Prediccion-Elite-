import assert from "node:assert/strict";
import test from "node:test";
import type {
  MlbDailyOpportunityContextResult,
  MlbDailyOpportunityEntry,
} from "./mlb-daily-opportunity-context-v1";
import {
  MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS,
  buildMlbDailyOpportunityPriceShortlist,
} from "./mlb-daily-opportunity-price-shortlist-v1";

const date = "2026-08-26";

function entry(input: {
  gamePk: number;
  rank: number;
  stage: "FINAL" | "PROVISIONAL";
  robust: number | null;
}): MlbDailyOpportunityEntry {
  return {
    gamePk: input.gamePk,
    officialDate: date,
    startTime: `2026-08-26T${String(12 + input.gamePk).padStart(2, "0")}:00:00.000Z`,
    awayTeam: `Away ${input.gamePk}`,
    homeTeam: `Home ${input.gamePk}`,
    inputStage: input.stage,
    contextRank: input.rank,
    intrinsicClassification: "GAME_ELITE_RESEARCH_CANDIDATE",
    eligibleSportingOpportunity: true,
    context: {
      thesisKinds: ["HOME_SIDE"],
      thesisStructures: ["TWO_SIDED_SEPARATION"],
      supportingComponents: ["STATCAST_QUALITY", "SOS"],
      fullGameElite: true,
      earlyWindowElite: false,
      maxAbsoluteNativeRunSignal: 0.4,
    },
    probability: {
      stage: input.stage === "FINAL" ? "CONFIRMED_V16" : "PROVISIONAL_V16",
      selectedSide: "HOME",
      selectedSideProbability: input.robust == null ? null : input.robust + (input.stage === "PROVISIONAL" ? 0.0533 : 0),
      lineupUncertaintyP95: input.stage === "PROVISIONAL" ? 0.0533 : 0,
      robustSelectedSideProbability: input.robust,
    },
  };
}

function opportunity(frontier: readonly MlbDailyOpportunityEntry[], evaluated = 15): MlbDailyOpportunityContextResult {
  return {
    schemaVersion: "courtedge-mlb-daily-opportunity-context.v1",
    date,
    generatedAt: "2026-08-26T14:00:00.000Z",
    action: frontier.some((row) => row.inputStage === "PROVISIONAL") ? "WAIT" : frontier.length ? "PLAY_NOW_CANDIDATE" : "NO_PLAY",
    primaryOpportunity: frontier[0] ?? null,
    nonDominatedFrontier: frontier,
    rankedOpportunities: frontier,
    summary: {
      intrinsicEvaluatedGames: evaluated,
      eligibleSportingOpportunities: frontier.length,
      provisionalEligibleOpportunities: frontier.filter((row) => row.inputStage === "PROVISIONAL").length,
      finalEligibleOpportunities: frontier.filter((row) => row.inputStage === "FINAL").length,
      frontierSize: frontier.length,
    },
    decisionReason: frontier.length === 0
      ? "NO_CONTEXT_QUALIFIED_OPPORTUNITY"
      : frontier.some((row) => row.inputStage === "PROVISIONAL")
        ? "PROVISIONAL_OPPORTUNITY_REMAINS_NON_DOMINATED"
        : "BEST_NON_DOMINATED_OPPORTUNITY_IS_FINAL",
    policy: {
      outcomesRead: false,
      marketPricesRead: false,
      oneUniversalWeightedScoreUsed: false,
      contextRankUsesExistingIntrinsicEngine: true,
      wholeQualifiedIntrinsicPopulationRanked: true,
      marketDiscoveryCapMayHideDailyOpportunity: false,
      finalInputStatusAffectsContextRank: false,
      gameStartTimeAffectsContextRank: false,
      provisionalGamesMayLeadDailyOpportunity: true,
      empiricalLineupUncertaintyAppliedToProvisionalV16Only: true,
      probabilityThresholdCreatesOpportunityEligibility: false,
      confirmationMayDowngradeToNoPlay: true,
      v68Changed: false,
      v80Changed: false,
      productionDailyBestPickChanged: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}

test("fifteen-game sporting analysis can produce at most three possible price consultations", () => {
  const frontier = [
    entry({ gamePk: 1, rank: 1, stage: "FINAL", robust: 0.69 }),
    entry({ gamePk: 2, rank: 2, stage: "PROVISIONAL", robust: 0.77 }),
    entry({ gamePk: 3, rank: 3, stage: "FINAL", robust: 0.73 }),
    entry({ gamePk: 4, rank: 4, stage: "FINAL", robust: 0.75 }),
    entry({ gamePk: 5, rank: 5, stage: "PROVISIONAL", robust: 0.76 }),
  ];
  const result = buildMlbDailyOpportunityPriceShortlist(opportunity(frontier, 15));

  assert.equal(result.summary.wholeSlateSportingOpportunitiesEvaluated, 15);
  assert.equal(result.entries.length, MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS);
  assert.equal(result.entries.length <= 3, true);
  assert.equal(result.entries.some((row) => row.gamePk === 1), true, "best context anchor must survive");
  assert.equal(result.entries.some((row) => row.gamePk === 2), true, "best robust probability anchor must survive");
  assert.equal(result.policy.wholeSlateAnalysisDoesNotExpandPriceQuota, true);
  assert.equal(result.policy.paidOddsCalled, false);
});

test("provisional opportunity can stay shortlisted but is deferred from paid price readiness", () => {
  const result = buildMlbDailyOpportunityPriceShortlist(opportunity([
    entry({ gamePk: 7, rank: 1, stage: "PROVISIONAL", robust: 0.80 }),
    entry({ gamePk: 8, rank: 2, stage: "FINAL", robust: 0.74 }),
  ]));

  const provisional = result.entries.find((row) => row.gamePk === 7);
  const final = result.entries.find((row) => row.gamePk === 8);
  assert.equal(provisional?.priceTiming, "DEFER_UNTIL_FINAL_INPUTS");
  assert.equal(final?.priceTiming, "READY_IF_PRICE_LAYER_INVOKED");
  assert.equal(result.summary.deferredProvisionalCandidates, 1);
  assert.equal(result.summary.readyFinalCandidates, 1);
});

test("no sporting opportunity means no price consultation candidate", () => {
  const result = buildMlbDailyOpportunityPriceShortlist(opportunity([], 15));
  assert.equal(result.entries.length, 0);
  assert.equal(result.summary.shortlistedForPossiblePriceConsultation, 0);
  assert.equal(result.summary.readyFinalCandidates, 0);
});
