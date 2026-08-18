import type { MlbDailyBestPickUiView } from "./mlb-daily-best-pick-ui-view";
import type { MlbMarketEdgeMarketResult } from "./mlb-market-edge";
import type { MlbOperatingEnvelopeClassification, MlbOperatingEnvelopeMarketResult } from "./mlb-operating-envelope";
import {
  MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA,
  type MlbUnifiedPricedV16RunnerResult,
} from "./mlb-unified-priced-v16-runner";

export const MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA = "courtedge-mlb-daily-best-pick-price-view.v1" as const;

export type MlbDailyBestPickPriceDecision =
  | MlbOperatingEnvelopeClassification
  | "PRICE_EVIDENCE_UNAVAILABLE"
  | "NOT_APPLICABLE";

export interface MlbDailyBestPickPriceView {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA;
  decision: MlbDailyBestPickPriceDecision;
  pick: null | {
    gamePk: number;
    market: "FIRST_5_ML" | "FULL_GAME_ML";
    canonicalMarketType: "F5_ML" | "ML";
    side: "HOME" | "AWAY";
    route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" | "PREMIUM_A_HOME_ML";
    tier: "A_PLUS" | "PREMIUM";
    prepriceRank: number;
  };
  execution: null | {
    bookKey: string;
    bookTitle: string;
    oddsAmerican: number;
    capturedAt: string;
    providerLastUpdate: string | null;
  };
  economics: null | {
    modelWinProbability: number | null;
    modelPushProbability: number | null;
    expectedValuePerUnit: number | null;
    executionEdgePp: number | null;
    executionNoVigEdgePp: number | null;
    referenceNoVigEdgePp: number | null;
    referenceAgreement: MlbOperatingEnvelopeMarketResult["referenceAgreement"];
  };
  blockers: readonly string[];
  warnings: readonly string[];
  audit: {
    exactEnvelopeMarketMatches: number;
    exactMarketEdgeMatches: number;
    otherGameMarketsIgnored: number;
    otherSelectedGameMarketsIgnored: number;
  };
  policy: {
    trustedPricedV16RuntimeOnly: true;
    exactDailyBestPickIdentityOnly: true;
    sportingSelectionChangedByPrice: false;
    fallbackToAnotherGameAllowed: false;
    fallbackToAnotherMarketAllowed: false;
    newThresholdAdded: false;
    fixedEvThresholdAdded: false;
    fixedProbabilityThresholdAdded: false;
    betEliteLabelProduced: false;
    finalBetRecommendationProduced: false;
    stakeCalculated: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function canonicalMarketType(market: "FIRST_5_ML" | "FULL_GAME_ML"): "F5_ML" | "ML" {
  return market === "FIRST_5_ML" ? "F5_ML" : "ML";
}

function sameLine(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right;
  return Object.is(left, right) || left === right;
}

function assertTrustedPricedRuntime(result: MlbUnifiedPricedV16RunnerResult): void {
  if (result.schemaVersion !== MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA) {
    throw new Error("MLB_DAILY_BEST_PICK_PRICE_UNTRUSTED_RUNNER_SCHEMA");
  }
  if (result.preprice.runId !== result.runId) {
    throw new Error("MLB_DAILY_BEST_PICK_PRICE_PREPRICE_RUN_ID_MISMATCH");
  }
  if (result.marketEdge.sourceRunId !== result.runId || result.operatingEnvelope.sourceRunId !== result.runId) {
    throw new Error("MLB_DAILY_BEST_PICK_PRICE_PRICED_RUN_ID_MISMATCH");
  }

  const policy = result.policy;
  if (policy.v16PriceIndependent !== true
    || policy.discoveryPlanMutatedBeforeOddsAcquisition !== false
    || policy.priceCanCreateIntrinsicThesis !== false
    || policy.additionalEliteFilterApplied !== false
    || policy.betEliteProduced !== false
    || policy.finalBetRecommendationProduced !== false
    || policy.stakeCalculated !== false
    || policy.automaticBetPlacement !== false
    || policy.realFinancialExposure !== 0) {
    throw new Error("MLB_DAILY_BEST_PICK_PRICE_RUNNER_POLICY_VIOLATION");
  }

  const envelopePolicy = result.operatingEnvelope.policy;
  if (envelopePolicy.fixedEvThresholdApplied !== false
    || envelopePolicy.fixedProbabilityThresholdApplied !== false
    || envelopePolicy.marketRankingProduced !== false
    || envelopePolicy.numericEliteScoreProduced !== false
    || envelopePolicy.finalBetRecommendationProduced !== false
    || envelopePolicy.betEliteLabelProduced !== false
    || envelopePolicy.stakeCalculated !== false
    || envelopePolicy.automaticBetPlacement !== false
    || envelopePolicy.realFinancialExposure !== 0) {
    throw new Error("MLB_DAILY_BEST_PICK_PRICE_ENVELOPE_POLICY_VIOLATION");
  }
}

function publicPick(pick: NonNullable<MlbDailyBestPickUiView["pick"]>): NonNullable<MlbDailyBestPickPriceView["pick"]> {
  return Object.freeze({
    gamePk: pick.gamePk,
    market: pick.market,
    canonicalMarketType: canonicalMarketType(pick.market),
    side: pick.side,
    route: pick.route,
    tier: pick.tier,
    prepriceRank: pick.prepriceRank,
  });
}

function exactEnvelopeMarkets(
  result: MlbUnifiedPricedV16RunnerResult,
  pick: NonNullable<MlbDailyBestPickUiView["pick"]>,
): MlbOperatingEnvelopeMarketResult[] {
  const targetMarket = canonicalMarketType(pick.market);
  const gameRows = result.operatingEnvelope.games.filter((game) => game.gamePk === pick.gamePk);
  if (gameRows.length > 1) throw new Error(`MLB_DAILY_BEST_PICK_PRICE_DUPLICATE_ENVELOPE_GAME:${pick.gamePk}`);
  const game = gameRows[0];
  if (!game) return [];
  return game.markets.filter((market) =>
    market.marketType === targetMarket
    && market.selectedSide === pick.side
    && market.selectedLine === null,
  );
}

function exactEdgeMarkets(
  result: MlbUnifiedPricedV16RunnerResult,
  pick: NonNullable<MlbDailyBestPickUiView["pick"]>,
  envelope: MlbOperatingEnvelopeMarketResult,
): MlbMarketEdgeMarketResult[] {
  const targetMarket = canonicalMarketType(pick.market);
  const gameRows = result.marketEdge.games.filter((game) => game.gamePk === pick.gamePk);
  if (gameRows.length > 1) throw new Error(`MLB_DAILY_BEST_PICK_PRICE_DUPLICATE_EDGE_GAME:${pick.gamePk}`);
  const game = gameRows[0];
  if (!game) return [];
  return game.markets.filter((market) =>
    market.marketType === targetMarket
    && market.providerMarketKey === envelope.providerMarketKey
    && market.selectedSide === pick.side
    && sameLine(market.selectedLine, envelope.selectedLine),
  );
}

export function buildMlbDailyBestPickPriceView(input: {
  priced: MlbUnifiedPricedV16RunnerResult;
  dailyBestPick: MlbDailyBestPickUiView;
}): MlbDailyBestPickPriceView {
  assertTrustedPricedRuntime(input.priced);

  if (input.dailyBestPick.decision === "NO_PLAY") {
    if (input.dailyBestPick.pick !== null) {
      throw new Error("MLB_DAILY_BEST_PICK_PRICE_NO_PLAY_WITH_PICK");
    }
    return Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
      decision: "NOT_APPLICABLE",
      pick: null,
      execution: null,
      economics: null,
      blockers: Object.freeze([]),
      warnings: Object.freeze([]),
      audit: Object.freeze({
        exactEnvelopeMarketMatches: 0,
        exactMarketEdgeMatches: 0,
        otherGameMarketsIgnored: input.priced.operatingEnvelope.games.reduce((sum, game) => sum + game.markets.length, 0),
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

  const pick = input.dailyBestPick.pick;
  if (!pick) throw new Error("MLB_DAILY_BEST_PICK_PRICE_BEST_PICK_MISSING");
  const targetMarket = canonicalMarketType(pick.market);
  const allEnvelopeMarkets = input.priced.operatingEnvelope.games.flatMap((game) => game.markets);
  const selectedEnvelopeGame = input.priced.operatingEnvelope.games.find((game) => game.gamePk === pick.gamePk);
  const otherGameMarketsIgnored = input.priced.operatingEnvelope.games
    .filter((game) => game.gamePk !== pick.gamePk)
    .reduce((sum, game) => sum + game.markets.length, 0);
  const otherSelectedGameMarketsIgnored = selectedEnvelopeGame
    ? selectedEnvelopeGame.markets.filter((market) => !(
      market.marketType === targetMarket
      && market.selectedSide === pick.side
      && market.selectedLine === null
    )).length
    : 0;

  const envelopeMatches = exactEnvelopeMarkets(input.priced, pick);
  if (envelopeMatches.length > 1) {
    throw new Error(`MLB_DAILY_BEST_PICK_PRICE_AMBIGUOUS_ENVELOPE_MARKET:${pick.gamePk}:${targetMarket}:${pick.side}`);
  }

  const policy = Object.freeze({
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
  });

  if (envelopeMatches.length === 0) {
    return Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
      decision: "PRICE_EVIDENCE_UNAVAILABLE",
      pick: publicPick(pick),
      execution: null,
      economics: null,
      blockers: Object.freeze(["EXACT_DAILY_BEST_PICK_MARKET_NOT_IN_OPERATING_ENVELOPE"]),
      warnings: Object.freeze([]),
      audit: Object.freeze({
        exactEnvelopeMarketMatches: 0,
        exactMarketEdgeMatches: 0,
        otherGameMarketsIgnored,
        otherSelectedGameMarketsIgnored,
      }),
      policy,
    });
  }

  const envelope = envelopeMatches[0];
  const edgeMatches = exactEdgeMarkets(input.priced, pick, envelope);
  if (edgeMatches.length !== 1) {
    throw new Error(`MLB_DAILY_BEST_PICK_PRICE_EDGE_IDENTITY_MISMATCH:${pick.gamePk}:${targetMarket}:${pick.side}:${edgeMatches.length}`);
  }
  const edge = edgeMatches[0];

  const execution = edge.execution
    ? Object.freeze({
      bookKey: edge.execution.bookKey,
      bookTitle: edge.execution.bookTitle,
      oddsAmerican: edge.execution.selectedOddsAmerican,
      capturedAt: edge.execution.capturedAt,
      providerLastUpdate: edge.execution.providerLastUpdate,
    })
    : null;

  return Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
    decision: envelope.classification,
    pick: publicPick(pick),
    execution,
    economics: Object.freeze({
      modelWinProbability: envelope.modelWinProbability,
      modelPushProbability: envelope.modelPushProbability,
      expectedValuePerUnit: envelope.expectedValuePerUnit,
      executionEdgePp: envelope.executionEdgePp,
      executionNoVigEdgePp: envelope.executionNoVigEdgePp,
      referenceNoVigEdgePp: envelope.referenceNoVigEdgePp,
      referenceAgreement: envelope.referenceAgreement,
    }),
    blockers: Object.freeze([...envelope.blockers]),
    warnings: Object.freeze([...envelope.warnings]),
    audit: Object.freeze({
      exactEnvelopeMarketMatches: envelopeMatches.length,
      exactMarketEdgeMatches: edgeMatches.length,
      otherGameMarketsIgnored,
      otherSelectedGameMarketsIgnored,
    }),
    policy,
  });
}
