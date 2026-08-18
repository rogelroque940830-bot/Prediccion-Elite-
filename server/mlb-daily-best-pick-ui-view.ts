import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import type { MlbUnifiedRunnerResult } from "./mlb-unified-runner";
import { selectMlbDailyBestPickFromUnifiedPreprice } from "./mlb-daily-best-pick-runtime-adapter";

export const MLB_DAILY_BEST_PICK_UI_SCHEMA = "courtedge-mlb-daily-best-pick-ui.v1" as const;

export interface MlbDailyBestPickUiView {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_UI_SCHEMA;
  decision: "BEST_PICK" | "NO_PLAY";
  pick: null | {
    gamePk: number;
    awayTeam: string;
    homeTeam: string;
    market: "FIRST_5_ML" | "FULL_GAME_ML";
    side: "HOME" | "AWAY";
    route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" | "PREMIUM_A_HOME_ML";
    tier: "A_PLUS" | "PREMIUM";
    prepriceRank: number;
  };
  audit: {
    readyAPlusEvaluations: number;
    readyPremiumEvaluations: number;
    provisionalRowsSkipped: number;
    frozenRouteMatchesOutsideRankedPreprice: number;
  };
  policy: {
    trustedUnifiedPrepriceRuntimeOnly: true;
    finalFrozenInputsOnly: true;
    aPlusAlwaysPrecedesPremium: true;
    existingPrepriceRankPreservedWithinTier: true;
    generalV68FallbackAllowed: false;
    v80Read: false;
    v80Changed: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

/**
 * Browser-safe projection of Daily BEST PICK.
 *
 * The browser never supplies route evaluations. The view is derived only from the
 * trusted server-side Step11c preprice result and strips internal observation IDs.
 */
export function buildMlbDailyBestPickUiView(input: {
  preprice: MlbUnifiedRunnerResult;
  slate: MlbP1DailySlate;
}): MlbDailyBestPickUiView {
  if (input.preprice.date !== input.slate.date) {
    throw new Error("MLB_DAILY_BEST_PICK_UI_DATE_MISMATCH");
  }

  const selected = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: input.preprice,
    officialDate: input.slate.date,
  });
  const pick = selected.selection.pick;

  let publicPick: MlbDailyBestPickUiView["pick"] = null;
  if (pick) {
    const game = input.slate.games.find((row) => row.gamePk === pick.gamePk);
    if (!game || game.officialDate !== input.slate.date) {
      throw new Error(`MLB_DAILY_BEST_PICK_UI_GAME_NOT_IN_SLATE:${pick.gamePk}`);
    }
    publicPick = Object.freeze({
      gamePk: pick.gamePk,
      awayTeam: game.awayTeam.name,
      homeTeam: game.homeTeam.name,
      market: pick.market,
      side: pick.side,
      route: pick.route,
      tier: pick.tier,
      prepriceRank: pick.prepriceRank,
    });
  }

  return Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_UI_SCHEMA,
    decision: selected.selection.decision,
    pick: publicPick,
    audit: Object.freeze({
      readyAPlusEvaluations: selected.audit.readyAPlusEvaluations,
      readyPremiumEvaluations: selected.audit.readyPremiumEvaluations,
      provisionalRowsSkipped: selected.audit.provisionalRowsSkipped,
      frozenRouteMatchesOutsideRankedPreprice: selected.audit.frozenRouteMatchesOutsideRankedPreprice,
    }),
    policy: Object.freeze({
      trustedUnifiedPrepriceRuntimeOnly: true as const,
      finalFrozenInputsOnly: true as const,
      aPlusAlwaysPrecedesPremium: true as const,
      existingPrepriceRankPreservedWithinTier: true as const,
      generalV68FallbackAllowed: false as const,
      v80Read: false as const,
      v80Changed: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
