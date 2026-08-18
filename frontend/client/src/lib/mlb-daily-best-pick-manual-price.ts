export const MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA =
  "courtedge-mlb-daily-best-pick-manual-price-context.v1" as const;
export const MLB_DAILY_BEST_PICK_MANUAL_PRICE_VIEW_SCHEMA =
  "courtedge-mlb-daily-best-pick-manual-price-view.v1" as const;

export type MlbDailyBestPickManualPriceAvailability = {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA;
  status: "AVAILABLE" | "NOT_AVAILABLE";
  reason: string;
  runId: string | null;
  expiresAt: string | null;
};

export type MlbDailyBestPickManualPriceView = {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_MANUAL_PRICE_VIEW_SCHEMA;
  decision: "MANUAL_PRICE_POSITIVE_EV" | "MANUAL_PRICE_NO_POSITIVE_EV";
  priceSource: "MANUAL_PRICE";
  pick: {
    gamePk: number;
    market: "FIRST_5_ML" | "FULL_GAME_ML";
    canonicalMarketType: "F5_ML" | "ML";
    side: "HOME";
    route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" | "PREMIUM_A_HOME_ML";
    tier: "A_PLUS" | "PREMIUM";
    prepriceRank: number;
  };
  execution: {
    bookKey: "hardrockbet_fl";
    bookTitle: string;
    oddsAmerican: number;
    capturedAt: string;
    providerLastUpdate: null;
    provenance: "USER_REPORTED_HARD_ROCK";
  };
  economics: {
    modelWinProbability: number;
    modelPushProbability: number;
    currentBreakEvenWinProbability: number;
    expectedValuePerUnit: number;
    executionEdgePp: number;
  };
  blockers: readonly string[];
  warnings: readonly string[];
  policy: {
    providerOrFreshCachePricePrecedesManual: true;
    manualFallbackOnlyAfterAutomaticExecutionUnavailable: true;
    exactDailyBestPickIdentityRequired: true;
    userReportedPriceCannotCreateOrRerankPick: true;
    serverReceiptTimeIsQuoteTimestamp: true;
    pushAwareEconomicsPreserved: true;
    fixedEvThresholdAdded: false;
    operatingEnvelopeClassificationProduced: false;
    betEliteProduced: false;
    finalBetRecommendationProduced: false;
    stakeCalculated: false;
    callsTheOddsApi: false;
    theOddsApiCreditsConsumed: 0;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseMlbDailyBestPickManualPriceAvailability(value: unknown): MlbDailyBestPickManualPriceAvailability | null {
  if (!record(value) || value.schemaVersion !== MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA) return null;
  if (value.status !== "AVAILABLE" && value.status !== "NOT_AVAILABLE") return null;
  if (typeof value.reason !== "string" || !value.reason) return null;
  if (value.status === "AVAILABLE") {
    if (typeof value.runId !== "string" || !value.runId.trim() || !validIso(value.expiresAt)) return null;
  } else if (value.runId !== null || value.expiresAt !== null) return null;
  if (!record(value.policy)
    || value.policy.providerOrFreshCachePricePrecedesManual !== true
    || value.policy.manualPriceMayChangeSportingSelection !== false
    || value.policy.exactDailyBestPickIdentityRequired !== true
    || value.policy.trustedV16ModelAssessmentRequired !== true
    || value.policy.quoteFreshnessUsesExistingFiveMinuteBoundary !== true
    || value.policy.callsTheOddsApi !== false
    || value.policy.theOddsApiCreditsConsumed !== 0
    || value.policy.betEliteProduced !== false
    || value.policy.stakeCalculated !== false
    || value.policy.automaticBetPlacement !== false
    || value.policy.realFinancialExposure !== 0) return null;
  return value as unknown as MlbDailyBestPickManualPriceAvailability;
}

export function parseMlbDailyBestPickManualPriceView(value: unknown): MlbDailyBestPickManualPriceView | null {
  if (!record(value)
    || value.schemaVersion !== MLB_DAILY_BEST_PICK_MANUAL_PRICE_VIEW_SCHEMA
    || (value.decision !== "MANUAL_PRICE_POSITIVE_EV" && value.decision !== "MANUAL_PRICE_NO_POSITIVE_EV")
    || value.priceSource !== "MANUAL_PRICE"
    || !record(value.pick)
    || !record(value.execution)
    || !record(value.economics)
    || !record(value.policy)
    || !Array.isArray(value.blockers)
    || !Array.isArray(value.warnings)) return null;

  const pick = value.pick;
  if (!nonNegativeInteger(pick.gamePk) || pick.gamePk === 0
    || !nonNegativeInteger(pick.prepriceRank)
    || pick.side !== "HOME"
    || (pick.market !== "FIRST_5_ML" && pick.market !== "FULL_GAME_ML")
    || pick.canonicalMarketType !== (pick.market === "FIRST_5_ML" ? "F5_ML" : "ML")) return null;
  if (pick.route === "PREMIUM_A_HOME_ML") {
    if (pick.tier !== "PREMIUM" || pick.market !== "FULL_GAME_ML") return null;
  } else if (pick.route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1") {
    if (pick.tier !== "A_PLUS") return null;
  } else return null;

  const execution = value.execution;
  if (execution.bookKey !== "hardrockbet_fl"
    || execution.provenance !== "USER_REPORTED_HARD_ROCK"
    || typeof execution.bookTitle !== "string" || !execution.bookTitle.trim()
    || !finite(execution.oddsAmerican)
    || !validIso(execution.capturedAt)
    || execution.providerLastUpdate !== null) return null;

  const economics = value.economics;
  for (const key of ["modelWinProbability", "modelPushProbability", "currentBreakEvenWinProbability", "expectedValuePerUnit", "executionEdgePp"] as const) {
    if (!finite(economics[key])) return null;
  }
  if (economics.modelWinProbability <= 0 || economics.modelWinProbability >= 1
    || economics.modelPushProbability < 0 || economics.modelPushProbability > 1
    || economics.currentBreakEvenWinProbability <= 0 || economics.currentBreakEvenWinProbability >= 1) return null;
  if (value.decision === "MANUAL_PRICE_POSITIVE_EV" && economics.expectedValuePerUnit <= 0) return null;
  if (value.decision === "MANUAL_PRICE_NO_POSITIVE_EV" && economics.expectedValuePerUnit > 0) return null;
  if (value.blockers.length !== 0 || !value.warnings.includes("MANUAL_PRICE_NOT_PROVIDER_VERIFIED")) return null;

  const policy = value.policy;
  if (policy.providerOrFreshCachePricePrecedesManual !== true
    || policy.manualFallbackOnlyAfterAutomaticExecutionUnavailable !== true
    || policy.exactDailyBestPickIdentityRequired !== true
    || policy.userReportedPriceCannotCreateOrRerankPick !== true
    || policy.serverReceiptTimeIsQuoteTimestamp !== true
    || policy.pushAwareEconomicsPreserved !== true
    || policy.fixedEvThresholdAdded !== false
    || policy.operatingEnvelopeClassificationProduced !== false
    || policy.betEliteProduced !== false
    || policy.finalBetRecommendationProduced !== false
    || policy.stakeCalculated !== false
    || policy.callsTheOddsApi !== false
    || policy.theOddsApiCreditsConsumed !== 0
    || policy.automaticBetPlacement !== false
    || policy.realFinancialExposure !== 0) return null;

  return value as unknown as MlbDailyBestPickManualPriceView;
}

export function formatManualAmericanOdds(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
