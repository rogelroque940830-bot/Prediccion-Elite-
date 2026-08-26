import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import type { MlbDailyBestPickUiView } from "./mlb-daily-best-pick-ui-view";
import type { MlbUnifiedEliteLowerTierShadowDecisions } from "./mlb-unified-elite-shadow-v1";
import type { EliteSelectionInput } from "./mlb-unified-elite-router-v1";

export const MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA =
  "courtedge-mlb-unified-elite-visible-daily-best-pick.v1" as const;

export type MlbUnifiedEliteVisibleLowerTier = "PP_HORIZON" | "FULL_MODULAR";

export interface MlbUnifiedEliteVisibleLowerTierPickView {
  schemaVersion: typeof MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA;
  decision: "BEST_PICK";
  pick: {
    gamePk: number;
    awayTeam: string;
    homeTeam: string;
    market: string;
    horizon: string;
    side: "HOME" | "AWAY";
    selectedLine: number | null;
    route: "PP_HORIZON_FROZEN_LIVE_V1" | "FULL_MODULAR_FROZEN_LIVE_V1";
    tier: MlbUnifiedEliteVisibleLowerTier;
  };
  audit: MlbDailyBestPickUiView["audit"];
  lowerTierSourceStatus: string;
  policy: {
    parentAPlusPremiumNoPlayRequired: true;
    aPlusAlwaysPrecedesPremium: true;
    premiumAlwaysPrecedesLowerTiers: true;
    ppHorizonPrecedesFullModular: true;
    fullModularFallbackAfterPpNoPlayAllowed: true;
    lowerTierSelectionUsesSportsbookPrice: false;
    v68ScientificContractChanged: false;
    v80ScientificContractChanged: false;
    ppHorizonProspectiveCustodyChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export type MlbUnifiedEliteVisibleDailyBestPick =
  | MlbDailyBestPickUiView
  | MlbUnifiedEliteVisibleLowerTierPickView;

function validSelection(selection: EliteSelectionInput, officialDate: string): boolean {
  return selection.officialDate === officialDate
    && Number.isInteger(selection.gamePk)
    && selection.gamePk > 0
    && typeof selection.market === "string"
    && selection.market.trim().length > 0
    && typeof selection.horizon === "string"
    && selection.horizon.trim().length > 0
    && (selection.side === "HOME" || selection.side === "AWAY")
    && (selection.selectedLine == null || Number.isFinite(selection.selectedLine));
}

function lowerTierView(input: {
  officialDate: string;
  slate: MlbP1DailySlate;
  parent: MlbDailyBestPickUiView;
  lowerTier: MlbUnifiedEliteLowerTierShadowDecisions;
  tier: MlbUnifiedEliteVisibleLowerTier;
  selection: EliteSelectionInput;
}): MlbUnifiedEliteVisibleLowerTierPickView | null {
  if (!validSelection(input.selection, input.officialDate)) return null;
  const game = input.slate.games.find((row) =>
    row.gamePk === input.selection.gamePk && row.officialDate === input.officialDate,
  );
  if (!game) return null;
  const side: "HOME" | "AWAY" = input.selection.side === "AWAY" ? "AWAY" : "HOME";

  return Object.freeze({
    schemaVersion: MLB_UNIFIED_ELITE_VISIBLE_DAILY_BEST_PICK_SCHEMA,
    decision: "BEST_PICK" as const,
    pick: Object.freeze({
      gamePk: input.selection.gamePk,
      awayTeam: game.awayTeam.name,
      homeTeam: game.homeTeam.name,
      market: input.selection.market.trim(),
      horizon: input.selection.horizon.trim(),
      side,
      selectedLine: input.selection.selectedLine ?? null,
      route: input.tier === "PP_HORIZON"
        ? "PP_HORIZON_FROZEN_LIVE_V1" as const
        : "FULL_MODULAR_FROZEN_LIVE_V1" as const,
      tier: input.tier,
    }),
    audit: input.parent.audit,
    lowerTierSourceStatus: input.lowerTier.sourceStatus ?? "PROVIDER_SUPPLIED",
    policy: Object.freeze({
      parentAPlusPremiumNoPlayRequired: true as const,
      aPlusAlwaysPrecedesPremium: true as const,
      premiumAlwaysPrecedesLowerTiers: true as const,
      ppHorizonPrecedesFullModular: true as const,
      fullModularFallbackAfterPpNoPlayAllowed: true as const,
      lowerTierSelectionUsesSportsbookPrice: false as const,
      v68ScientificContractChanged: false as const,
      v80ScientificContractChanged: false as const,
      ppHorizonProspectiveCustodyChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}

/**
 * Visible sporting-selection overlay only.
 *
 * The frozen A+/Premium selector retains priority. Lower tiers are evaluated only when
 * the parent selector returns NO_PLAY. PP_HORIZON is tried first; Full Modular is the
 * final sporting fallback even when PP_HORIZON returns a genuine NO_PLAY. This does
 * not modify V68/V80 scientific workflows, PP prospective custody, price eligibility,
 * staking, BET_ELITE or automatic wagering.
 */
export function buildMlbUnifiedEliteVisibleDailyBestPick(input: {
  officialDate: string;
  slate: MlbP1DailySlate;
  parentDailyBestPick: MlbDailyBestPickUiView;
  lowerTier: MlbUnifiedEliteLowerTierShadowDecisions;
}): MlbUnifiedEliteVisibleDailyBestPick {
  if (input.parentDailyBestPick.decision === "BEST_PICK") {
    return input.parentDailyBestPick;
  }

  if (input.lowerTier.ppHorizon.status === "SELECTION") {
    return lowerTierView({
      officialDate: input.officialDate,
      slate: input.slate,
      parent: input.parentDailyBestPick,
      lowerTier: input.lowerTier,
      tier: "PP_HORIZON",
      selection: input.lowerTier.ppHorizon.selection,
    }) ?? input.parentDailyBestPick;
  }

  if (input.lowerTier.fullModular.status === "SELECTION") {
    return lowerTierView({
      officialDate: input.officialDate,
      slate: input.slate,
      parent: input.parentDailyBestPick,
      lowerTier: input.lowerTier,
      tier: "FULL_MODULAR",
      selection: input.lowerTier.fullModular.selection,
    }) ?? input.parentDailyBestPick;
  }

  return input.parentDailyBestPick;
}
