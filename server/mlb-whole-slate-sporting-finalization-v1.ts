import type { MlbDailyOpportunityEntry } from "./mlb-daily-opportunity-context-v1";
import type { MlbUnifiedEliteVisibleDailyBestPick } from "./mlb-unified-elite-visible-daily-best-pick-v1";

export const MLB_WHOLE_SLATE_SPORTING_FINALIZATION_SCHEMA =
  "courtedge-mlb-whole-slate-sporting-finalization.v1" as const;

export type MlbWholeSlateSportingFinalizationState =
  | "WAIT_FOR_PROVISIONAL_COMPETITOR"
  | "FINAL_SPORTING_PICK"
  | "SPORTING_NO_PLAY";

export interface MlbWholeSlateSportingLeaderView {
  gamePk: number;
  awayTeam: string;
  homeTeam: string;
  inputStage: "FINAL" | "PROVISIONAL";
  contextRank: number;
  selectedSide: "HOME" | "AWAY" | null;
  selectedSideProbability: number | null;
  robustSelectedSideProbability: number | null;
  probabilityStage: MlbDailyOpportunityEntry["probability"]["stage"];
  researchClassification: MlbDailyOpportunityEntry["intrinsicClassification"];
  researchEligibilityIgnoredAsProductionGate: true;
}

export interface MlbWholeSlateSportingFinalizationResult {
  schemaVersion: typeof MLB_WHOLE_SLATE_SPORTING_FINALIZATION_SCHEMA;
  state: MlbWholeSlateSportingFinalizationState;
  reason:
    | "NO_FINAL_SPORTING_PICK_WHILE_PROVISIONAL_GAMES_REMAIN"
    | "PROVISIONAL_GAME_CAN_STILL_OUTRANK_FINAL_A_PLUS"
    | "PROVISIONAL_GAME_CAN_STILL_PROMOTE_ABOVE_FINAL_LOWER_TIER"
    | "FINAL_SPORTING_HIERARCHY_RESOLVED"
    | "WHOLE_SLATE_RESOLVED_NO_SPORTING_PICK";
  sportingSlateLeader: MlbWholeSlateSportingLeaderView | null;
  unresolvedProvisionalGamePks: readonly number[];
  wholeSlateEvaluatedGames: number;
  provisionalGamesEvaluated: number;
  finalGamesEvaluated: number;
  policy: {
    wholeSlateRankRead: true;
    researchEliteCandidateIsProductionHardGate: false;
    finalSportingAuthorityUsesFrozenHierarchy: true;
    aPlusPrecedesPremium: true;
    premiumPrecedesPpHorizon: true;
    ppHorizonPrecedesFullModular: true;
    provisionalMayDelayFinalization: true;
    provisionalMayBecomeOfficialPick: false;
    priceMayCreateSportingPick: false;
    oddsRead: false;
    modelThresholdChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function leaderView(entry: MlbDailyOpportunityEntry | undefined): MlbWholeSlateSportingLeaderView | null {
  if (!entry) return null;
  return Object.freeze({
    gamePk: entry.gamePk,
    awayTeam: entry.awayTeam,
    homeTeam: entry.homeTeam,
    inputStage: entry.inputStage,
    contextRank: entry.contextRank,
    selectedSide: entry.probability.selectedSide,
    selectedSideProbability: entry.probability.selectedSideProbability,
    robustSelectedSideProbability: entry.probability.robustSelectedSideProbability,
    probabilityStage: entry.probability.stage,
    researchClassification: entry.intrinsicClassification,
    researchEligibilityIgnoredAsProductionGate: true as const,
  });
}

function pickTier(
  dailyBestPick: MlbUnifiedEliteVisibleDailyBestPick,
): "A_PLUS" | "PREMIUM" | "PP_HORIZON" | "FULL_MODULAR" | null {
  if (dailyBestPick.decision !== "BEST_PICK" || !dailyBestPick.pick) return null;
  return dailyBestPick.pick.tier;
}

function pickGamePk(dailyBestPick: MlbUnifiedEliteVisibleDailyBestPick): number | null {
  return dailyBestPick.decision === "BEST_PICK" && dailyBestPick.pick
    ? dailyBestPick.pick.gamePk
    : null;
}

/**
 * Resolve whether the frozen sporting hierarchy can be finalized while some games
 * are still provisional.
 *
 * This deliberately separates two concepts:
 * - whole-slate context ranking is used to expose unresolved competitors;
 * - only the existing FINAL frozen hierarchy can create the official Daily BEST PICK.
 *
 * The research-only `researchEliteCandidate` flag is never consulted as an eligibility
 * gate here. It may influence the already-existing intrinsic ordering, but it cannot
 * erase a game from the whole-slate competition by itself.
 */
export function finalizeMlbWholeSlateSportingAuthority(input: {
  dailyBestPick: MlbUnifiedEliteVisibleDailyBestPick;
  rankedOpportunities: readonly MlbDailyOpportunityEntry[];
  parentPrepricePopulationSize: number;
}): MlbWholeSlateSportingFinalizationResult {
  const ranked = [...input.rankedOpportunities].sort((left, right) =>
    left.contextRank - right.contextRank || left.gamePk - right.gamePk,
  );
  const provisional = ranked.filter((entry) => entry.inputStage === "PROVISIONAL");
  const final = ranked.filter((entry) => entry.inputStage === "FINAL");
  const parentPopulationSize = Math.max(0, Math.trunc(input.parentPrepricePopulationSize));
  const provisionalInsideParentPopulation = provisional.filter(
    (entry) => entry.contextRank <= parentPopulationSize,
  );

  const selectedGamePk = pickGamePk(input.dailyBestPick);
  const tier = pickTier(input.dailyBestPick);
  const selectedEntry = selectedGamePk == null
    ? undefined
    : ranked.find((entry) => entry.gamePk === selectedGamePk);

  let state: MlbWholeSlateSportingFinalizationState;
  let reason: MlbWholeSlateSportingFinalizationResult["reason"];
  let blockers: MlbDailyOpportunityEntry[] = [];

  if (selectedGamePk == null || tier == null) {
    if (provisional.length > 0) {
      state = "WAIT_FOR_PROVISIONAL_COMPETITOR";
      reason = "NO_FINAL_SPORTING_PICK_WHILE_PROVISIONAL_GAMES_REMAIN";
      blockers = provisional;
    } else {
      state = "SPORTING_NO_PLAY";
      reason = "WHOLE_SLATE_RESOLVED_NO_SPORTING_PICK";
    }
  } else if (tier === "A_PLUS") {
    const selectedRank = selectedEntry?.contextRank ?? Number.POSITIVE_INFINITY;
    blockers = provisionalInsideParentPopulation.filter(
      (entry) => entry.contextRank < selectedRank,
    );
    if (blockers.length > 0) {
      state = "WAIT_FOR_PROVISIONAL_COMPETITOR";
      reason = "PROVISIONAL_GAME_CAN_STILL_OUTRANK_FINAL_A_PLUS";
    } else {
      state = "FINAL_SPORTING_PICK";
      reason = "FINAL_SPORTING_HIERARCHY_RESOLVED";
    }
  } else if (tier === "PREMIUM") {
    // Any still-provisional game inside the frozen parent population can later
    // certify as A+ and therefore outrank an already-FINAL Premium candidate.
    blockers = provisionalInsideParentPopulation;
    if (blockers.length > 0) {
      state = "WAIT_FOR_PROVISIONAL_COMPETITOR";
      reason = "PROVISIONAL_GAME_CAN_STILL_PROMOTE_ABOVE_FINAL_LOWER_TIER";
    } else {
      state = "FINAL_SPORTING_PICK";
      reason = "FINAL_SPORTING_HIERARCHY_RESOLVED";
    }
  } else {
    // PP_HORIZON and Full Modular sit below both parent tiers and themselves require
    // FINAL/T-5 evidence. Any provisional game can still enter a higher tier later.
    blockers = provisional;
    if (blockers.length > 0) {
      state = "WAIT_FOR_PROVISIONAL_COMPETITOR";
      reason = "PROVISIONAL_GAME_CAN_STILL_PROMOTE_ABOVE_FINAL_LOWER_TIER";
    } else {
      state = "FINAL_SPORTING_PICK";
      reason = "FINAL_SPORTING_HIERARCHY_RESOLVED";
    }
  }

  const leaderEntry = state === "WAIT_FOR_PROVISIONAL_COMPETITOR"
    ? blockers[0]
    : state === "FINAL_SPORTING_PICK"
      ? selectedEntry
      : undefined;

  return Object.freeze({
    schemaVersion: MLB_WHOLE_SLATE_SPORTING_FINALIZATION_SCHEMA,
    state,
    reason,
    sportingSlateLeader: leaderView(leaderEntry),
    unresolvedProvisionalGamePks: Object.freeze(blockers.map((entry) => entry.gamePk)),
    wholeSlateEvaluatedGames: ranked.length,
    provisionalGamesEvaluated: provisional.length,
    finalGamesEvaluated: final.length,
    policy: Object.freeze({
      wholeSlateRankRead: true as const,
      researchEliteCandidateIsProductionHardGate: false as const,
      finalSportingAuthorityUsesFrozenHierarchy: true as const,
      aPlusPrecedesPremium: true as const,
      premiumPrecedesPpHorizon: true as const,
      ppHorizonPrecedesFullModular: true as const,
      provisionalMayDelayFinalization: true as const,
      provisionalMayBecomeOfficialPick: false as const,
      priceMayCreateSportingPick: false as const,
      oddsRead: false as const,
      modelThresholdChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
