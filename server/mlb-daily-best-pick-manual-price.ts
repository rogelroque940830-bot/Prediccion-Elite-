import { normalizeStandardAmericanOdds } from "./american-odds";
import {
  buildMlbMarketProbabilityAssessmentDigest,
  type MlbMarketProbabilityAssessment,
} from "./mlb-market-edge";
import { MLB_P1_M6A2_MAX_QUOTE_AGE_MS } from "./mlb-market-odds-normalizer";
import { mlbP1M4aAmericanToDecimal } from "./mlb-p1-economic-decision-contract";
import {
  MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
  type MlbDailyBestPickPriceView,
} from "./mlb-daily-best-pick-price-view";
import {
  MLB_DAILY_BEST_PICK_UI_SCHEMA,
  type MlbDailyBestPickUiView,
} from "./mlb-daily-best-pick-ui-view";
import {
  MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA,
  type MlbUnifiedPricedV16RunnerResult,
} from "./mlb-unified-priced-v16-runner";

export const MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA =
  "courtedge-mlb-daily-best-pick-manual-price-context.v1" as const;
export const MLB_DAILY_BEST_PICK_MANUAL_PRICE_VIEW_SCHEMA =
  "courtedge-mlb-daily-best-pick-manual-price-view.v1" as const;

/**
 * Manual price custody expires on the same horizon already used for executable
 * provider quotes. This introduces no second freshness threshold.
 */
export const MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_TTL_MS = MLB_P1_M6A2_MAX_QUOTE_AGE_MS;

export type MlbDailyBestPickManualPriceAvailabilityReason =
  | "READY_FOR_MANUAL_PRICE"
  | "NO_DAILY_BEST_PICK"
  | "AUTOMATIC_PRICE_AVAILABLE"
  | "AUTOMATIC_PRICE_TRUST_MISMATCH"
  | "EXACT_MODEL_ASSESSMENT_UNAVAILABLE";

export interface MlbDailyBestPickManualPriceAvailability {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA;
  status: "AVAILABLE" | "NOT_AVAILABLE";
  reason: MlbDailyBestPickManualPriceAvailabilityReason;
  runId: string | null;
  expiresAt: string | null;
  policy: {
    providerOrFreshCachePricePrecedesManual: true;
    manualPriceMayChangeSportingSelection: false;
    exactDailyBestPickIdentityRequired: true;
    trustedV16ModelAssessmentRequired: true;
    quoteFreshnessUsesExistingFiveMinuteBoundary: true;
    callsTheOddsApi: false;
    theOddsApiCreditsConsumed: 0;
    betEliteProduced: false;
    stakeCalculated: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export interface MlbDailyBestPickManualPriceContext {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA;
  runId: string;
  date: string;
  createdAt: string;
  expiresAt: string;
  pick: {
    gamePk: number;
    market: "FIRST_5_ML" | "FULL_GAME_ML";
    canonicalMarketType: "F5_ML" | "ML";
    side: "HOME";
    route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" | "PREMIUM_A_HOME_ML";
    tier: "A_PLUS" | "PREMIUM";
    prepriceRank: number;
  };
  model: {
    sourcePolicy: "ML_F5_EDGE_CONFIDENCE_V2";
    modelVersion: string;
    generatedAt: string;
    modelInputDigest: string;
    winProbability: number;
    pushProbability: number;
    lossProbability: number;
  };
  policy: MlbDailyBestPickManualPriceAvailability["policy"];
}

export interface MlbDailyBestPickManualPriceRequest {
  runId: string;
  date: string;
  gamePk: number;
  market: "FIRST_5_ML" | "FULL_GAME_ML";
  side: "HOME";
  oddsAmerican: number;
}

export interface MlbDailyBestPickManualPriceView {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_MANUAL_PRICE_VIEW_SCHEMA;
  decision: "MANUAL_PRICE_POSITIVE_EV" | "MANUAL_PRICE_NO_POSITIVE_EV";
  priceSource: "MANUAL_PRICE";
  pick: MlbDailyBestPickManualPriceContext["pick"];
  execution: {
    bookKey: "hardrockbet_fl";
    bookTitle: "Hard Rock Bet (manual entry)";
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
  blockers: readonly [];
  warnings: readonly ["MANUAL_PRICE_NOT_PROVIDER_VERIFIED"];
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
}

export class MlbDailyBestPickManualPriceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MlbDailyBestPickManualPriceError";
    this.code = code;
  }
}

function round(value: number, digits = 10): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function canonicalMarketType(market: "FIRST_5_ML" | "FULL_GAME_ML"): "F5_ML" | "ML" {
  return market === "FIRST_5_ML" ? "F5_ML" : "ML";
}

function policy(): MlbDailyBestPickManualPriceAvailability["policy"] {
  return Object.freeze({
    providerOrFreshCachePricePrecedesManual: true as const,
    manualPriceMayChangeSportingSelection: false as const,
    exactDailyBestPickIdentityRequired: true as const,
    trustedV16ModelAssessmentRequired: true as const,
    quoteFreshnessUsesExistingFiveMinuteBoundary: true as const,
    callsTheOddsApi: false as const,
    theOddsApiCreditsConsumed: 0 as const,
    betEliteProduced: false as const,
    stakeCalculated: false as const,
    automaticBetPlacement: false as const,
    realFinancialExposure: 0 as const,
  });
}

function unavailable(reason: Exclude<MlbDailyBestPickManualPriceAvailabilityReason, "READY_FOR_MANUAL_PRICE">): {
  availability: MlbDailyBestPickManualPriceAvailability;
  context: null;
} {
  return {
    availability: Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA,
      status: "NOT_AVAILABLE" as const,
      reason,
      runId: null,
      expiresAt: null,
      policy: policy(),
    }),
    context: null,
  };
}

function samePick(
  daily: NonNullable<MlbDailyBestPickUiView["pick"]>,
  price: NonNullable<MlbDailyBestPickPriceView["pick"]>,
): boolean {
  return daily.gamePk === price.gamePk
    && daily.market === price.market
    && daily.side === price.side
    && daily.route === price.route
    && daily.tier === price.tier
    && daily.prepriceRank === price.prepriceRank
    && price.canonicalMarketType === canonicalMarketType(daily.market);
}

function validateTrustedInputs(input: {
  priced: MlbUnifiedPricedV16RunnerResult;
  dailyBestPick: MlbDailyBestPickUiView;
  automaticPrice: MlbDailyBestPickPriceView;
}): void {
  if (input.priced.schemaVersion !== MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA) {
    throw new MlbDailyBestPickManualPriceError("UNTRUSTED_PRICED_RUNTIME", "priced runtime schema mismatch");
  }
  if (input.priced.runId !== input.priced.preprice.runId || input.priced.date !== input.priced.preprice.date) {
    throw new MlbDailyBestPickManualPriceError("PRICED_RUNTIME_IDENTITY_MISMATCH", "priced runtime identity mismatch");
  }
  if (input.dailyBestPick.schemaVersion !== MLB_DAILY_BEST_PICK_UI_SCHEMA) {
    throw new MlbDailyBestPickManualPriceError("UNTRUSTED_DAILY_BEST_PICK", "Daily BEST PICK schema mismatch");
  }
  if (input.automaticPrice.schemaVersion !== MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA) {
    throw new MlbDailyBestPickManualPriceError("UNTRUSTED_AUTOMATIC_PRICE_VIEW", "automatic price schema mismatch");
  }
  if (input.priced.policy.v16PriceIndependent !== true
    || input.priced.policy.priceCanCreateIntrinsicThesis !== false
    || input.priced.policy.betEliteProduced !== false
    || input.priced.policy.automaticBetPlacement !== false
    || input.priced.policy.realFinancialExposure !== 0) {
    throw new MlbDailyBestPickManualPriceError("PRICED_RUNTIME_POLICY_VIOLATION", "priced runtime safety policy mismatch");
  }
}

function exactModelAssessment(
  priced: MlbUnifiedPricedV16RunnerResult,
  pick: NonNullable<MlbDailyBestPickUiView["pick"]>,
): MlbMarketProbabilityAssessment | null {
  const marketType = canonicalMarketType(pick.market);
  const matches = priced.modelAssessments.filter((assessment) =>
    assessment.gamePk === pick.gamePk
    && assessment.marketType === marketType
    && assessment.side === pick.side
    && assessment.line === null,
  );
  return matches.length === 1 ? matches[0] : null;
}

function validatedModel(assessment: MlbMarketProbabilityAssessment, market: "F5_ML" | "ML"): MlbDailyBestPickManualPriceContext["model"] | null {
  if (assessment.status !== "READY"
    || assessment.sourcePolicy !== "ML_F5_EDGE_CONFIDENCE_V2"
    || assessment.probabilitySemantics !== "UNCONDITIONAL_SETTLEMENT"
    || assessment.line !== null
    || !validIso(assessment.generatedAt)
    || typeof assessment.modelVersion !== "string"
    || !assessment.modelVersion.trim()
    || typeof assessment.modelInputDigest !== "string"
    || !/^[a-f0-9]{64}$/i.test(assessment.modelInputDigest)
    || !finiteProbability(assessment.winProbability)
    || assessment.winProbability <= 0
    || assessment.winProbability >= 1) {
    return null;
  }

  const { modelInputDigest: _digest, ...digestInput } = assessment;
  if (buildMlbMarketProbabilityAssessmentDigest(digestInput).toLowerCase() !== assessment.modelInputDigest.toLowerCase()) {
    return null;
  }

  let pushProbability: number;
  if (market === "ML") {
    if (assessment.pushProbability != null && (!finiteProbability(assessment.pushProbability) || Math.abs(assessment.pushProbability) > 1e-12)) {
      return null;
    }
    pushProbability = 0;
  } else {
    if (!finiteProbability(assessment.pushProbability)) return null;
    pushProbability = assessment.pushProbability;
  }

  const lossProbability = 1 - assessment.winProbability - pushProbability;
  if (!Number.isFinite(lossProbability) || lossProbability < -1e-10) return null;

  return Object.freeze({
    sourcePolicy: "ML_F5_EDGE_CONFIDENCE_V2" as const,
    modelVersion: assessment.modelVersion,
    generatedAt: assessment.generatedAt,
    modelInputDigest: assessment.modelInputDigest,
    winProbability: round(assessment.winProbability, 12),
    pushProbability: round(pushProbability, 12),
    lossProbability: round(Math.max(0, lossProbability), 12),
  });
}

export function buildMlbDailyBestPickManualPriceContext(input: {
  priced: MlbUnifiedPricedV16RunnerResult;
  dailyBestPick: MlbDailyBestPickUiView;
  automaticPrice: MlbDailyBestPickPriceView;
  now?: Date;
}): {
  availability: MlbDailyBestPickManualPriceAvailability;
  context: MlbDailyBestPickManualPriceContext | null;
} {
  validateTrustedInputs(input);

  if (input.dailyBestPick.decision !== "BEST_PICK" || !input.dailyBestPick.pick) {
    return unavailable("NO_DAILY_BEST_PICK");
  }
  const pick = input.dailyBestPick.pick;

  if (input.automaticPrice.execution) {
    return unavailable("AUTOMATIC_PRICE_AVAILABLE");
  }
  if (!input.automaticPrice.pick || !samePick(pick, input.automaticPrice.pick)) {
    return unavailable("AUTOMATIC_PRICE_TRUST_MISMATCH");
  }

  const assessment = exactModelAssessment(input.priced, pick);
  if (!assessment) return unavailable("EXACT_MODEL_ASSESSMENT_UNAVAILABLE");
  const model = validatedModel(assessment, canonicalMarketType(pick.market));
  if (!model) return unavailable("EXACT_MODEL_ASSESSMENT_UNAVAILABLE");

  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new MlbDailyBestPickManualPriceError("NOW_INVALID", "manual price context time is invalid");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_TTL_MS).toISOString();
  const sharedPolicy = policy();
  const context: MlbDailyBestPickManualPriceContext = Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA,
    runId: input.priced.runId,
    date: input.priced.date,
    createdAt,
    expiresAt,
    pick: Object.freeze({
      gamePk: pick.gamePk,
      market: pick.market,
      canonicalMarketType: canonicalMarketType(pick.market),
      side: "HOME" as const,
      route: pick.route,
      tier: pick.tier,
      prepriceRank: pick.prepriceRank,
    }),
    model,
    policy: sharedPolicy,
  });

  return {
    availability: Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA,
      status: "AVAILABLE" as const,
      reason: "READY_FOR_MANUAL_PRICE" as const,
      runId: context.runId,
      expiresAt: context.expiresAt,
      policy: sharedPolicy,
    }),
    context,
  };
}

export function parseMlbDailyBestPickManualPriceContext(value: unknown): MlbDailyBestPickManualPriceContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const context = value as Partial<MlbDailyBestPickManualPriceContext>;
  if (context.schemaVersion !== MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA
    || typeof context.runId !== "string" || !context.runId.trim()
    || !validDate(context.date)
    || !validIso(context.createdAt)
    || !validIso(context.expiresAt)
    || !context.pick || !context.model || !context.policy) return null;
  if (!Number.isInteger(context.pick.gamePk) || context.pick.gamePk! <= 0
    || (context.pick.market !== "FIRST_5_ML" && context.pick.market !== "FULL_GAME_ML")
    || context.pick.canonicalMarketType !== canonicalMarketType(context.pick.market)
    || context.pick.side !== "HOME"
    || !Number.isInteger(context.pick.prepriceRank) || context.pick.prepriceRank! < 0) return null;
  if (context.pick.route === "PREMIUM_A_HOME_ML") {
    if (context.pick.tier !== "PREMIUM" || context.pick.market !== "FULL_GAME_ML") return null;
  } else if (context.pick.route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1") {
    if (context.pick.tier !== "A_PLUS") return null;
  } else return null;
  if (context.model.sourcePolicy !== "ML_F5_EDGE_CONFIDENCE_V2"
    || typeof context.model.modelVersion !== "string" || !context.model.modelVersion.trim()
    || !validIso(context.model.generatedAt)
    || typeof context.model.modelInputDigest !== "string" || !/^[a-f0-9]{64}$/i.test(context.model.modelInputDigest)
    || !finiteProbability(context.model.winProbability) || context.model.winProbability <= 0 || context.model.winProbability >= 1
    || !finiteProbability(context.model.pushProbability)
    || !finiteProbability(context.model.lossProbability)
    || Math.abs(context.model.winProbability + context.model.pushProbability + context.model.lossProbability - 1) > 1e-8) return null;
  const p = context.policy;
  if (p.providerOrFreshCachePricePrecedesManual !== true
    || p.manualPriceMayChangeSportingSelection !== false
    || p.exactDailyBestPickIdentityRequired !== true
    || p.trustedV16ModelAssessmentRequired !== true
    || p.quoteFreshnessUsesExistingFiveMinuteBoundary !== true
    || p.callsTheOddsApi !== false
    || p.theOddsApiCreditsConsumed !== 0
    || p.betEliteProduced !== false
    || p.stakeCalculated !== false
    || p.automaticBetPlacement !== false
    || p.realFinancialExposure !== 0) return null;
  return context as MlbDailyBestPickManualPriceContext;
}

export function evaluateMlbDailyBestPickManualPrice(input: {
  context: MlbDailyBestPickManualPriceContext;
  request: MlbDailyBestPickManualPriceRequest;
  now?: Date;
}): MlbDailyBestPickManualPriceView {
  const context = parseMlbDailyBestPickManualPriceContext(input.context);
  if (!context) throw new MlbDailyBestPickManualPriceError("CONTEXT_INVALID", "manual price context failed validation");

  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new MlbDailyBestPickManualPriceError("NOW_INVALID", "manual quote time is invalid");
  if (now.getTime() > Date.parse(context.expiresAt)) {
    throw new MlbDailyBestPickManualPriceError("CONTEXT_EXPIRED", "manual price context expired");
  }

  const request = input.request;
  if (String(request.runId ?? "").trim() !== context.runId
    || request.date !== context.date
    || request.gamePk !== context.pick.gamePk
    || request.market !== context.pick.market
    || request.side !== context.pick.side) {
    throw new MlbDailyBestPickManualPriceError("PICK_IDENTITY_MISMATCH", "manual price does not match the frozen Daily BEST PICK identity");
  }

  const oddsAmerican = normalizeStandardAmericanOdds(request.oddsAmerican);
  if (oddsAmerican == null) {
    throw new MlbDailyBestPickManualPriceError("AMERICAN_ODDS_INVALID", "manual Hard Rock price must be valid American odds");
  }
  const decimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  if (decimal == null) throw new MlbDailyBestPickManualPriceError("AMERICAN_ODDS_INVALID", "manual Hard Rock price cannot be converted");

  const winProbability = context.model.winProbability;
  const pushProbability = context.model.pushProbability;
  const lossProbability = context.model.lossProbability;
  const currentBreakEvenWinProbability = (1 - pushProbability) / decimal;
  const expectedValuePerUnit = winProbability * (decimal - 1) - lossProbability;
  const executionEdgePp = (winProbability - currentBreakEvenWinProbability) * 100;
  const capturedAt = now.toISOString();

  return Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_MANUAL_PRICE_VIEW_SCHEMA,
    decision: expectedValuePerUnit > 0 ? "MANUAL_PRICE_POSITIVE_EV" as const : "MANUAL_PRICE_NO_POSITIVE_EV" as const,
    priceSource: "MANUAL_PRICE" as const,
    pick: Object.freeze({ ...context.pick }),
    execution: Object.freeze({
      bookKey: "hardrockbet_fl" as const,
      bookTitle: "Hard Rock Bet (manual entry)" as const,
      oddsAmerican,
      capturedAt,
      providerLastUpdate: null,
      provenance: "USER_REPORTED_HARD_ROCK" as const,
    }),
    economics: Object.freeze({
      modelWinProbability: round(winProbability, 12),
      modelPushProbability: round(pushProbability, 12),
      currentBreakEvenWinProbability: round(currentBreakEvenWinProbability, 12),
      expectedValuePerUnit: round(expectedValuePerUnit, 10),
      executionEdgePp: round(executionEdgePp, 8),
    }),
    blockers: Object.freeze([]) as readonly [],
    warnings: Object.freeze(["MANUAL_PRICE_NOT_PROVIDER_VERIFIED"] as const),
    policy: Object.freeze({
      providerOrFreshCachePricePrecedesManual: true as const,
      manualFallbackOnlyAfterAutomaticExecutionUnavailable: true as const,
      exactDailyBestPickIdentityRequired: true as const,
      userReportedPriceCannotCreateOrRerankPick: true as const,
      serverReceiptTimeIsQuoteTimestamp: true as const,
      pushAwareEconomicsPreserved: true as const,
      fixedEvThresholdAdded: false as const,
      operatingEnvelopeClassificationProduced: false as const,
      betEliteProduced: false as const,
      finalBetRecommendationProduced: false as const,
      stakeCalculated: false as const,
      callsTheOddsApi: false as const,
      theOddsApiCreditsConsumed: 0 as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
