import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import type { MlbDailyBestPickUiView } from "./mlb-daily-best-pick-ui-view";
import {
  MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE,
  routeUnifiedEliteBoth,
  type EliteSelectionInput,
  type PpHorizonDecision,
  type StandardTierDecision,
  type UnifiedEliteRouterResult,
} from "./mlb-unified-elite-router-v1";

export const MLB_UNIFIED_ELITE_SHADOW_SCHEMA =
  "courtedge-mlb-unified-elite-shadow.v1" as const;

export const MLB_UNIFIED_ELITE_LOWER_TIER_PROMOTION_STATUS =
  "PROSPECTIVE_EMBARGO_SHADOW_ONLY" as const;

export interface MlbUnifiedEliteLowerTierShadowDecisions {
  ppHorizon: PpHorizonDecision;
  fullModular: StandardTierDecision;
  sourceStatus?: string;
}

export interface MlbUnifiedEliteLowerTierShadowContext {
  officialDate: string;
  slate: MlbP1DailySlate;
  now: Date;
}

export type MlbUnifiedEliteLowerTierShadowProvider = (
  context: MlbUnifiedEliteLowerTierShadowContext,
) => Promise<MlbUnifiedEliteLowerTierShadowDecisions>;

export interface MlbUnifiedEliteShadowView {
  schemaVersion: typeof MLB_UNIFIED_ELITE_SHADOW_SCHEMA;
  officialDate: string;
  firstProspectiveEligibleOfficialDate: typeof MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE;
  lowerTierPromotionStatus: typeof MLB_UNIFIED_ELITE_LOWER_TIER_PROMOTION_STATUS;
  visibleDailyBestPickPreserved: true;
  visibleRecommendationChanged: false;
  lowerTierRecommendationVisible: false;
  outcomesRead: false;
  performanceMetricsRead: false;
  stakeCalculated: false;
  automaticBetPlacement: false;
  realFinancialExposure: 0;
  lowerTierSourceStatus: string;
  router: UnifiedEliteRouterResult;
}

function visibleSelection(pick: NonNullable<MlbDailyBestPickUiView["pick"]>): EliteSelectionInput {
  return Object.freeze({
    officialDate: "",
    gamePk: pick.gamePk,
    market: pick.market,
    horizon: pick.market === "FIRST_5_ML" ? "F5" : "FG",
    side: pick.side,
    selectedLine: null,
  });
}

function parentTierDecisions(
  officialDate: string,
  dailyBestPick: MlbDailyBestPickUiView,
): { aPlus: StandardTierDecision; premium: StandardTierDecision } {
  if (dailyBestPick.decision !== "BEST_PICK" || !dailyBestPick.pick) {
    return {
      aPlus: { status: "NO_PLAY", reason: "VISIBLE_A_PLUS_NO_PLAY" },
      premium: { status: "NO_PLAY", reason: "VISIBLE_PREMIUM_NO_PLAY" },
    };
  }

  const selection = { ...visibleSelection(dailyBestPick.pick), officialDate };
  if (dailyBestPick.pick.tier === "A_PLUS") {
    return {
      aPlus: { status: "SELECTION", selection },
      premium: { status: "NO_PLAY", reason: "A_PLUS_SELECTED_HIGHER_TIER" },
    };
  }
  return {
    aPlus: { status: "NO_PLAY", reason: "VISIBLE_A_PLUS_NO_PLAY" },
    premium: { status: "SELECTION", selection },
  };
}

export function unavailableLowerTierShadowDecisions(
  sourceStatus = "LOWER_TIER_LIVE_SOURCE_NOT_MATERIALIZED",
): MlbUnifiedEliteLowerTierShadowDecisions {
  return Object.freeze({
    ppHorizon: Object.freeze({
      status: "TECHNICAL_UNAVAILABLE" as const,
      reason: "PP_PREGAME_SOURCE_UNAVAILABLE" as const,
    }),
    fullModular: Object.freeze({
      status: "NO_PLAY" as const,
      reason: "FULL_MODULAR_PREGAME_SOURCE_UNAVAILABLE",
    }),
    sourceStatus,
  });
}

export function buildMlbUnifiedEliteShadowView(input: {
  officialDate: string;
  dailyBestPick: MlbDailyBestPickUiView;
  lowerTier?: MlbUnifiedEliteLowerTierShadowDecisions | null;
}): MlbUnifiedEliteShadowView {
  const parent = parentTierDecisions(input.officialDate, input.dailyBestPick);
  const lower = input.lowerTier ?? unavailableLowerTierShadowDecisions();
  const router = routeUnifiedEliteBoth({
    officialDate: input.officialDate,
    aPlus: parent.aPlus,
    premium: parent.premium,
    ppHorizon: lower.ppHorizon,
    fullModular: lower.fullModular,
  });

  return Object.freeze({
    schemaVersion: MLB_UNIFIED_ELITE_SHADOW_SCHEMA,
    officialDate: input.officialDate,
    firstProspectiveEligibleOfficialDate: MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE,
    lowerTierPromotionStatus: MLB_UNIFIED_ELITE_LOWER_TIER_PROMOTION_STATUS,
    visibleDailyBestPickPreserved: true,
    visibleRecommendationChanged: false,
    lowerTierRecommendationVisible: false,
    outcomesRead: false,
    performanceMetricsRead: false,
    stakeCalculated: false,
    automaticBetPlacement: false,
    realFinancialExposure: 0,
    lowerTierSourceStatus: lower.sourceStatus ?? "PROVIDER_SUPPLIED",
    router,
  });
}
