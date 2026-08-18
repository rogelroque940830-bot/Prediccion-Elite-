import type { MlbDailyBestPickUiView } from "./mlb-daily-best-pick-ui-view";
import {
  MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
  buildMlbDailyBestPickPriceView,
  type MlbDailyBestPickPriceView,
} from "./mlb-daily-best-pick-price-view";
import type { MlbUnifiedPricedV16RunnerResult } from "./mlb-unified-priced-v16-runner";

export const MLB_DAILY_BEST_PICK_PRICE_TRUST_REJECTED = "PRICE_VIEW_TRUST_BOUNDARY_REJECTED" as const;

function failClosedView(): MlbDailyBestPickPriceView {
  return Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
    decision: "PRICE_EVIDENCE_UNAVAILABLE",
    pick: null,
    execution: null,
    economics: null,
    blockers: Object.freeze([MLB_DAILY_BEST_PICK_PRICE_TRUST_REJECTED]),
    warnings: Object.freeze([]),
    audit: Object.freeze({
      exactEnvelopeMarketMatches: 0,
      exactMarketEdgeMatches: 0,
      otherGameMarketsIgnored: 0,
      otherSelectedGameMarketsIgnored: 0,
    }),
    policy: Object.freeze({
      trustedPricedV16RuntimeOnly: true as const,
      exactDailyBestPickIdentityOnly: true as const,
      sportingSelectionChangedByPrice: false as const,
      fallbackToAnotherGameAllowed: false as const,
      fallbackToAnotherMarketAllowed: false as const,
      newThresholdAdded: false as const,
      fixedEvThresholdAdded: false as const,
      fixedProbabilityThresholdAdded: false as const,
      betEliteLabelProduced: false as const,
      finalBetRecommendationProduced: false as const,
      stakeCalculated: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}

function assertSemanticPriceView(view: MlbDailyBestPickPriceView): void {
  if (view.decision === "ELITE_EVIDENCE_CANDIDATE") {
    if (!view.pick || !view.execution || !view.economics) {
      throw new Error("MLB_DAILY_BEST_PICK_PRICE_ELITE_EXECUTION_REQUIRED");
    }
    if (!Number.isFinite(view.economics.expectedValuePerUnit)
      || (view.economics.expectedValuePerUnit ?? 0) <= 0
      || view.blockers.length !== 0) {
      throw new Error("MLB_DAILY_BEST_PICK_PRICE_ELITE_ECONOMICS_INVALID");
    }
  }

  if (view.decision === "NO_POSITIVE_EV") {
    if (!view.pick || !view.execution || !view.economics
      || !Number.isFinite(view.economics.expectedValuePerUnit)
      || (view.economics.expectedValuePerUnit ?? 1) > 0) {
      throw new Error("MLB_DAILY_BEST_PICK_PRICE_NO_POSITIVE_EV_INVARIANT_INVALID");
    }
  }

  if (view.decision === "POSITIVE_EV_ENVELOPE_BLOCKED") {
    if (!view.pick || !view.execution || !view.economics
      || !Number.isFinite(view.economics.expectedValuePerUnit)
      || (view.economics.expectedValuePerUnit ?? 0) <= 0) {
      throw new Error("MLB_DAILY_BEST_PICK_PRICE_POSITIVE_EV_BLOCK_INVARIANT_INVALID");
    }
  }
}

/**
 * Browser-facing safety wrapper. A rejected or corrupted priced runtime may hide price
 * visibility, but it can never mutate the already-frozen sporting BEST PICK.
 */
export function buildMlbDailyBestPickPriceViewFailClosed(input: {
  priced: MlbUnifiedPricedV16RunnerResult;
  dailyBestPick: MlbDailyBestPickUiView;
  onRejected?: (error: unknown) => void;
}): MlbDailyBestPickPriceView {
  try {
    const view = buildMlbDailyBestPickPriceView({
      priced: input.priced,
      dailyBestPick: input.dailyBestPick,
    });
    assertSemanticPriceView(view);
    return view;
  } catch (error) {
    input.onRejected?.(error);
    return failClosedView();
  }
}
