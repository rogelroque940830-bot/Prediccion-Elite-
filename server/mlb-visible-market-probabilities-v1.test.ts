import assert from "node:assert/strict";
import test from "node:test";
import type { MlbDailyOpportunityEntry } from "./mlb-daily-opportunity-context-v1";
import type { MlbUnifiedEliteVisibleDailyBestPick } from "./mlb-unified-elite-visible-daily-best-pick-v1";
import { finalizeMlbWholeSlateSportingAuthority } from "./mlb-whole-slate-sporting-finalization-v1";

function noPlay(): MlbUnifiedEliteVisibleDailyBestPick {
  return {
    schemaVersion: "courtedge-mlb-daily-best-pick-ui.v1",
    decision: "NO_PLAY",
    pick: null,
    audit: {
      readyAPlusEvaluations: 0,
      readyPremiumEvaluations: 0,
      provisionalRowsSkipped: 1,
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
  };
}

function provisionalLeader(): MlbDailyOpportunityEntry {
  return {
    gamePk: 777,
    officialDate: "2026-09-04",
    startTime: "2026-09-04T23:05:00.000Z",
    awayTeam: "Away",
    homeTeam: "Home",
    inputStage: "PROVISIONAL",
    contextRank: 1,
    intrinsicClassification: "INTRINSIC_WATCH",
    eligibleSportingOpportunity: false,
    context: {
      thesisKinds: [],
      thesisStructures: [],
      supportingComponents: [],
      fullGameElite: false,
      earlyWindowElite: false,
      maxAbsoluteNativeRunSignal: 0.22,
    },
    probability: {
      stage: "PROVISIONAL_V16",
      selectedSide: "HOME",
      selectedSideProbability: 0.558,
      lineupUncertaintyP95: 0.0533,
      robustSelectedSideProbability: 0.5047,
      marketProbabilities: {
        ml: {
          homeWinProbability: 0.558,
          awayWinProbability: 0.442,
        },
        f5Ml: {
          homeWinProbability: 0.487,
          awayWinProbability: 0.431,
          pushProbability: 0.082,
        },
      },
    },
  };
}

test("whole-slate visible leader preserves price-independent ML and F5 probability vectors", () => {
  const result = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: noPlay(),
    rankedOpportunities: [provisionalLeader()],
    parentPrepricePopulationSize: 1,
  });

  assert.equal(result.state, "WAIT_FOR_PROVISIONAL_COMPETITOR");
  assert.equal(result.sportingSlateLeader?.gamePk, 777);
  assert.equal(result.sportingSlateLeader?.marketProbabilities?.ml.homeWinProbability, 0.558);
  assert.equal(result.sportingSlateLeader?.marketProbabilities?.ml.awayWinProbability, 0.442);
  assert.equal(result.sportingSlateLeader?.marketProbabilities?.f5Ml?.homeWinProbability, 0.487);
  assert.equal(result.sportingSlateLeader?.marketProbabilities?.f5Ml?.awayWinProbability, 0.431);
  assert.equal(result.sportingSlateLeader?.marketProbabilities?.f5Ml?.pushProbability, 0.082);
  assert.equal(result.policy.oddsRead, false);
  assert.equal(result.policy.priceMayCreateSportingPick, false);
});
