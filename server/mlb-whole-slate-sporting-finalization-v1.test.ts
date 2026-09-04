import assert from "node:assert/strict";
import test from "node:test";
import type { MlbDailyOpportunityEntry } from "./mlb-daily-opportunity-context-v1";
import type { MlbUnifiedEliteVisibleDailyBestPick } from "./mlb-unified-elite-visible-daily-best-pick-v1";
import { finalizeMlbWholeSlateSportingAuthority } from "./mlb-whole-slate-sporting-finalization-v1";

function opportunity(input: {
  gamePk: number;
  rank: number;
  stage: "FINAL" | "PROVISIONAL";
  eligible?: boolean;
  missing?: readonly ("STATCAST_QUALITY" | "DISCIPLINE_SPEED" | "SOS")[];
}): MlbDailyOpportunityEntry {
  const missing = input.missing ?? [];
  const certified = ["STATCAST_QUALITY", "DISCIPLINE_SPEED", "SOS"]
    .filter((component) => !missing.includes(component as any)) as Array<"STATCAST_QUALITY" | "DISCIPLINE_SPEED" | "SOS">;
  return {
    gamePk: input.gamePk,
    officialDate: "2026-09-03",
    startTime: "2026-09-03T23:00:00.000Z",
    awayTeam: `Away ${input.gamePk}`,
    homeTeam: `Home ${input.gamePk}`,
    inputStage: input.stage,
    contextRank: input.rank,
    intrinsicClassification: input.eligible ? "GAME_ELITE_RESEARCH_CANDIDATE" : "INTRINSIC_WATCH",
    eligibleSportingOpportunity: input.eligible ?? false,
    evidenceCoverage: {
      coreState: missing.length === 0 ? "COMPLETE" : certified.length === 0 ? "UNAVAILABLE" : "PARTIAL",
      qualificationDisposition: input.eligible ? "QUALIFIED_SIGNAL" : missing.length > 0 ? "PENDING_EVIDENCE" : "QUALIFIED_SIGNAL",
      pending: missing.length > 0,
      certifiedCoreComponents: certified,
      signalCoreComponents: certified,
      neutralCoreComponents: [],
      unavailableCoreComponents: [...missing],
      missingDataCountsAsNegativeEvidence: false,
    },
    context: {
      thesisKinds: [],
      thesisStructures: [],
      supportingComponents: [],
      fullGameElite: false,
      earlyWindowElite: false,
      maxAbsoluteNativeRunSignal: 0.1,
    },
    probability: {
      stage: input.stage === "FINAL" ? "CONFIRMED_V16" : "PROVISIONAL_V16",
      selectedSide: "HOME",
      selectedSideProbability: 0.58,
      lineupUncertaintyP95: input.stage === "PROVISIONAL" ? 0.0533 : 0,
      robustSelectedSideProbability: input.stage === "PROVISIONAL" ? 0.5267 : 0.58,
    },
  };
}

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

function parentPick(input: { gamePk: number; tier: "A_PLUS" | "PREMIUM"; rank: number }): MlbUnifiedEliteVisibleDailyBestPick {
  return {
    schemaVersion: "courtedge-mlb-daily-best-pick-ui.v1",
    decision: "BEST_PICK",
    pick: {
      gamePk: input.gamePk,
      awayTeam: `Away ${input.gamePk}`,
      homeTeam: `Home ${input.gamePk}`,
      market: "FULL_GAME_ML",
      side: "HOME",
      route: input.tier === "A_PLUS"
        ? "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1"
        : "PREMIUM_A_HOME_ML",
      tier: input.tier,
      prepriceRank: input.rank - 1,
    },
    audit: {
      readyAPlusEvaluations: input.tier === "A_PLUS" ? 1 : 0,
      readyPremiumEvaluations: input.tier === "PREMIUM" ? 1 : 0,
      provisionalRowsSkipped: 0,
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

test("whole-slate provisional leader is visible even when researchEliteCandidate would be false", () => {
  const result = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: noPlay(),
    rankedOpportunities: [opportunity({ gamePk: 10, rank: 1, stage: "PROVISIONAL", eligible: false })],
    parentPrepricePopulationSize: 1,
  });

  assert.equal(result.state, "WAIT_FOR_PROVISIONAL_COMPETITOR");
  assert.equal(result.sportingSlateLeader?.gamePk, 10);
  assert.equal(result.sportingSlateLeader?.researchEligibilityIgnoredAsProductionGate, true);
  assert.deepEqual(result.unresolvedProvisionalGamePks, [10]);
  assert.deepEqual(result.rankedGamePks, [10]);
  assert.equal(
    result.policy.shortlistQualificationRule,
    "NONZERO_SIGNAL_OR_PENDING_CORE_EVIDENCE",
  );
});

test("ranked game identities preserve context-rank order for slate exclusion auditing", () => {
  const result = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: noPlay(),
    rankedOpportunities: [
      opportunity({ gamePk: 30, rank: 3, stage: "PROVISIONAL" }),
      opportunity({ gamePk: 10, rank: 1, stage: "PROVISIONAL" }),
      opportunity({ gamePk: 20, rank: 2, stage: "PROVISIONAL" }),
    ],
    parentPrepricePopulationSize: 3,
  });

  assert.deepEqual(result.rankedGamePks, [10, 20, 30]);
  assert.equal(result.wholeSlateEvaluatedGames, 3);
});

test("provisional missing evidence remains unresolved even when its observed rank is below a FINAL A+", () => {
  const result = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: parentPick({ gamePk: 20, tier: "A_PLUS", rank: 1 }),
    rankedOpportunities: [
      opportunity({ gamePk: 20, rank: 1, stage: "FINAL" }),
      opportunity({ gamePk: 10, rank: 7, stage: "PROVISIONAL", missing: ["SOS"] }),
    ],
    parentPrepricePopulationSize: 8,
  });

  assert.equal(result.state, "WAIT_FOR_PROVISIONAL_COMPETITOR");
  assert.equal(result.reason, "PROVISIONAL_CORE_EVIDENCE_INCOMPLETE");
  assert.deepEqual(result.unresolvedProvisionalGamePks, [10]);
  assert.deepEqual(result.provisionalEvidencePendingGamePks, [10]);
  assert.equal(result.evidencePendingGames[0].gamePk, 10);
  assert.deepEqual(result.evidencePendingGames[0].unavailableCoreComponents, ["SOS"]);
  assert.equal(result.policy.missingDataCountsAsNegativeEvidence, false);
  assert.equal(result.policy.incompleteProvisionalEvidenceMayFinalizeAsInferior, false);
});

test("a FINAL A+ pick waits only for a better-ranked provisional competitor when core evidence is complete", () => {
  const blocked = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: parentPick({ gamePk: 20, tier: "A_PLUS", rank: 2 }),
    rankedOpportunities: [
      opportunity({ gamePk: 10, rank: 1, stage: "PROVISIONAL" }),
      opportunity({ gamePk: 20, rank: 2, stage: "FINAL" }),
      opportunity({ gamePk: 30, rank: 9, stage: "PROVISIONAL" }),
    ],
    parentPrepricePopulationSize: 8,
  });
  assert.equal(blocked.state, "WAIT_FOR_PROVISIONAL_COMPETITOR");
  assert.deepEqual(blocked.unresolvedProvisionalGamePks, [10]);
  assert.deepEqual(blocked.rankedGamePks, [10, 20, 30]);

  const resolved = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: parentPick({ gamePk: 20, tier: "A_PLUS", rank: 1 }),
    rankedOpportunities: [
      opportunity({ gamePk: 20, rank: 1, stage: "FINAL" }),
      opportunity({ gamePk: 10, rank: 2, stage: "PROVISIONAL" }),
      opportunity({ gamePk: 30, rank: 9, stage: "PROVISIONAL" }),
    ],
    parentPrepricePopulationSize: 8,
  });
  assert.equal(resolved.state, "FINAL_SPORTING_PICK");
  assert.equal(resolved.sportingSlateLeader?.gamePk, 20);
});

test("a FINAL Premium pick waits for any complete-evidence provisional game still inside the frozen parent population", () => {
  const blocked = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: parentPick({ gamePk: 20, tier: "PREMIUM", rank: 1 }),
    rankedOpportunities: [
      opportunity({ gamePk: 20, rank: 1, stage: "FINAL" }),
      opportunity({ gamePk: 10, rank: 2, stage: "PROVISIONAL" }),
    ],
    parentPrepricePopulationSize: 8,
  });
  assert.equal(blocked.state, "WAIT_FOR_PROVISIONAL_COMPETITOR");
  assert.deepEqual(blocked.unresolvedProvisionalGamePks, [10]);

  const outsideOnly = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: parentPick({ gamePk: 20, tier: "PREMIUM", rank: 1 }),
    rankedOpportunities: [
      opportunity({ gamePk: 20, rank: 1, stage: "FINAL" }),
      opportunity({ gamePk: 90, rank: 9, stage: "PROVISIONAL" }),
    ],
    parentPrepricePopulationSize: 8,
  });
  assert.equal(outsideOnly.state, "FINAL_SPORTING_PICK");
});

test("whole slate resolves to sporting NO PLAY only after no provisional games remain", () => {
  const result = finalizeMlbWholeSlateSportingAuthority({
    dailyBestPick: noPlay(),
    rankedOpportunities: [opportunity({ gamePk: 20, rank: 1, stage: "FINAL" })],
    parentPrepricePopulationSize: 1,
  });
  assert.equal(result.state, "SPORTING_NO_PLAY");
  assert.equal(result.sportingSlateLeader, null);
  assert.deepEqual(result.rankedGamePks, [20]);
});
