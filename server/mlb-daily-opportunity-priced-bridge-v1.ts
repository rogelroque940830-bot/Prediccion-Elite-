import { adaptMlbV16SettlementEvidence } from "./mlb-pure-settlement-evidence-adapter";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";
import {
  buildMlbMarketDiscovery,
  type MlbMarketDiscoveryGamePlan,
  type MlbMarketDiscoveryResult,
} from "./mlb-market-discovery";
import { estimateMlbEventOddsWorstCaseCredits } from "./mlb-odds-budget-controller";
import {
  type MlbSelectiveOddsAcquisitionResult,
  type MlbSelectiveOddsAcquisitionService,
} from "./mlb-selective-odds-acquisition";
import { evaluateMlbMarketEdges, type MlbMarketEdgeResult } from "./mlb-market-edge";
import { buildMlbOperatingEnvelope, type MlbOperatingEnvelopeResult } from "./mlb-operating-envelope";
import type { MlbDailyOpportunityLiveResult } from "./mlb-daily-opportunity-live-v1";
import {
  MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS,
  type MlbDailyOpportunityPriceShortlistEntry,
} from "./mlb-daily-opportunity-price-shortlist-v1";
import type { MlbUnifiedV16AssembledRunnerInput } from "./mlb-unified-v16-live-input-assembler";

export const MLB_DAILY_OPPORTUNITY_PRICED_BRIDGE_SCHEMA =
  "courtedge-mlb-daily-opportunity-priced-bridge.v1" as const;

export type MlbDailyOpportunityPricedAction = "PLAY" | "WAIT" | "NO_PLAY";

export interface MlbDailyOpportunityFinalRecommendation {
  gamePk: number;
  contextRank: number;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selectedSide: string;
  selectedLine: number | null;
  modelWinProbability: number;
  expectedValuePerUnit: number;
}

export interface MlbDailyOpportunityPricedDecision {
  action: MlbDailyOpportunityPricedAction;
  reason:
    | "NO_SPORTING_SHORTLIST"
    | "PROVISIONAL_FRONTIER_REMAINS"
    | "PRICE_ACQUISITION_INCOMPLETE"
    | "UNRESOLVED_ECONOMIC_EVIDENCE"
    | "NO_POSITIVE_EV"
    | "MULTIPLE_NONDOMINATED_PRICE_OPPORTUNITIES"
    | "UNIQUE_NONDOMINATED_PRICE_OPPORTUNITY";
  recommendation: MlbDailyOpportunityFinalRecommendation | null;
}

export interface MlbDailyOpportunityPricedBridgeResult {
  schemaVersion: typeof MLB_DAILY_OPPORTUNITY_PRICED_BRIDGE_SCHEMA;
  generatedAt: string;
  sourceRunId: string;
  priceRunId: string | null;
  decision: MlbDailyOpportunityPricedDecision;
  priceDiscovery: MlbMarketDiscoveryResult | null;
  acquisition: MlbSelectiveOddsAcquisitionResult | null;
  marketEdge: MlbMarketEdgeResult | null;
  operatingEnvelope: MlbOperatingEnvelopeResult | null;
  summary: {
    wholeSlateSportingOpportunitiesEvaluated: number;
    shortlistedForPossiblePriceConsultation: number;
    deferredProvisionalCandidates: number;
    readyFinalCandidates: number;
    gamesExposedToOddsService: number;
    paidEventOddsCalls: number;
    eliteEvidenceCandidates: number;
  };
  policy: {
    wholeSlateAnalysisPrecedesPrice: true;
    maximumPriceConsultationCandidates: typeof MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS;
    provisionalCandidateBlocksPriceBoundary: true;
    onlyShortlistedFinalGamesReachOddsService: true;
    discoveryBuiltFromWholeSlateIntrinsicPopulation: true;
    ninthOrLaterWholeSlateGameMayReachPriceWhenShortlisted: true;
    unsupportedV16MarketsRemovedBeforeProviderAccess: true;
    supportedPricedMarkets: readonly ["ML", "F5_ML"];
    oneUniversalWeightedScoreUsed: false;
    finalSelectionUsesParetoDominance: true;
    outcomesRead: false;
    v68Changed: false;
    v80Changed: false;
    stakeCalculated: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export interface MlbDailyOpportunityPriceRuntime {
  providerAccountScopeKey: string;
  apiKey: string;
  maxRunCredits: number;
  reserveCredits: number;
}

export interface MlbDailyOpportunityPricedBridgeDependencies {
  oddsService: Pick<MlbSelectiveOddsAcquisitionService, "acquire">;
  evaluateMarketEdges?: typeof evaluateMlbMarketEdges;
  buildOperatingEnvelope?: typeof buildMlbOperatingEnvelope;
  now?: () => Date;
}

const SUPPORTED_PRICED_MARKETS = new Set(["ML", "F5_ML"]);

function readyEntries(live: MlbDailyOpportunityLiveResult): readonly MlbDailyOpportunityPriceShortlistEntry[] {
  return live.priceConsultationShortlist.entries.filter(
    (entry) => entry.priceTiming === "READY_IF_PRICE_LAYER_INVOKED",
  );
}

function deferredEntries(live: MlbDailyOpportunityLiveResult): readonly MlbDailyOpportunityPriceShortlistEntry[] {
  return live.priceConsultationShortlist.entries.filter(
    (entry) => entry.priceTiming === "DEFER_UNTIL_FINAL_INPUTS",
  );
}

function validateShortlist(live: MlbDailyOpportunityLiveResult): void {
  const entries = live.priceConsultationShortlist.entries;
  if (entries.length > MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS) {
    throw new Error(`MLB_DAILY_OPPORTUNITY_PRICE_SHORTLIST_CAP_EXCEEDED:${entries.length}`);
  }
  const seen = new Set<number>();
  for (const entry of entries) {
    if (seen.has(entry.gamePk)) throw new Error(`MLB_DAILY_OPPORTUNITY_PRICE_SHORTLIST_DUPLICATE:${entry.gamePk}`);
    seen.add(entry.gamePk);
    if (entry.inputStage === "PROVISIONAL" && entry.priceTiming !== "DEFER_UNTIL_FINAL_INPUTS") {
      throw new Error(`MLB_DAILY_OPPORTUNITY_PROVISIONAL_PRICE_READY_FORBIDDEN:${entry.gamePk}`);
    }
    if (entry.inputStage === "FINAL" && entry.priceTiming !== "READY_IF_PRICE_LAYER_INVOKED") {
      throw new Error(`MLB_DAILY_OPPORTUNITY_FINAL_PRICE_TIMING_INVALID:${entry.gamePk}`);
    }
  }
}

function restrictedGamePlan(game: MlbMarketDiscoveryGamePlan): MlbMarketDiscoveryGamePlan {
  const plannedMarkets = game.plannedMarkets.filter((market) => SUPPORTED_PRICED_MARKETS.has(market.canonicalMarketType));
  const plannedProviderMarketKeys = plannedMarkets.map((market) => market.providerMarketKey);
  const paidLookupEligibleNow = game.inputStage === "FINAL" && plannedMarkets.length > 0;
  const paidLookupHoldReason = plannedMarkets.length === 0
    ? "NO_STRONG_INTRINSIC_MARKET_THESIS" as const
    : game.inputStage !== "FINAL"
      ? "OFFICIAL_FINAL_INPUTS_REQUIRED" as const
      : null;
  const providerMarketKeysToRequestNow = paidLookupEligibleNow ? plannedProviderMarketKeys : [];
  return Object.freeze({
    ...game,
    plannedMarkets: Object.freeze([...plannedMarkets]),
    plannedProviderMarketKeys: Object.freeze([...plannedProviderMarketKeys]),
    paidLookupEligibleNow,
    paidLookupHoldReason,
    providerMarketKeysToRequestNow: Object.freeze([...providerMarketKeysToRequestNow]),
    worstCaseCreditsPerOneBookmakerRegionEquivalentNow: providerMarketKeysToRequestNow.length
      ? estimateMlbEventOddsWorstCaseCredits(providerMarketKeysToRequestNow, 1)
      : 0,
  });
}

export function buildMlbDailyOpportunityPriceDiscovery(input: {
  live: MlbDailyOpportunityLiveResult;
}): MlbMarketDiscoveryResult {
  const ready = [...readyEntries(input.live)].sort(
    (left, right) => left.contextRank - right.contextRank || left.gamePk - right.gamePk,
  );
  if (ready.length > MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS) {
    throw new Error(`MLB_DAILY_OPPORTUNITY_READY_PRICE_CAP_EXCEEDED:${ready.length}`);
  }

  const byPk = new Map(input.live.preprice.intrinsic.games.map((game) => [game.gamePk, game]));
  const selectedProfiles = ready.map((entry) => {
    const game = byPk.get(entry.gamePk);
    if (!game) throw new Error(`MLB_DAILY_OPPORTUNITY_PRICE_PROFILE_MISSING:${entry.gamePk}`);
    if (game.inputStage !== "FINAL") {
      throw new Error(`MLB_DAILY_OPPORTUNITY_PRICE_PROFILE_NOT_FINAL:${entry.gamePk}`);
    }
    return game;
  });

  const subsetIntrinsic = {
    ...input.live.preprice.intrinsic,
    rankedGames: Object.freeze(selectedProfiles),
    summary: {
      ...input.live.preprice.intrinsic.summary,
      researchEliteCandidates: selectedProfiles.filter((game) => game.researchEliteCandidate).length,
      finalInputResearchEliteCandidates: selectedProfiles.filter((game) => game.researchEliteCandidate).length,
      provisionalResearchEliteCandidates: 0,
      selectedForMarketDiscovery: selectedProfiles.length,
      overflowAfterIntrinsicRanking: 0,
    },
  };
  const raw = buildMlbMarketDiscovery({ intrinsic: subsetIntrinsic });
  const games = Object.freeze(raw.games.map(restrictedGamePlan));
  return Object.freeze({
    ...raw,
    games,
    summary: Object.freeze({
      intrinsicGames: games.length,
      researchEliteCandidates: games.filter((game) => game.intrinsicResearchEliteCandidate).length,
      gamesWithDiscoveryPlan: games.filter((game) => game.plannedMarkets.length > 0).length,
      gamesPaidLookupEligibleNow: games.filter((game) => game.paidLookupEligibleNow).length,
      gamesHeldForFinalInputs: 0,
      gamesWithNoStrongIntrinsicMarketThesis: games.filter(
        (game) => game.paidLookupHoldReason === "NO_STRONG_INTRINSIC_MARKET_THESIS",
      ).length,
      providerMarketsPlannedNow: games.reduce((sum, game) => sum + game.providerMarketKeysToRequestNow.length, 0),
      worstCaseCreditsPerOneBookmakerRegionEquivalentNow: games.reduce(
        (sum, game) => sum + game.worstCaseCreditsPerOneBookmakerRegionEquivalentNow,
        0,
      ),
    }),
  });
}

function buildSelectedModelAssessments(input: {
  assembled: MlbUnifiedV16AssembledRunnerInput;
  live: MlbDailyOpportunityLiveResult;
}) {
  return readyEntries(input.live).flatMap((entry) => {
    const c4 = input.assembled.c4ByGame[entry.gamePk];
    if (!c4) throw new Error(`MLB_DAILY_OPPORTUNITY_PRICE_C4_REQUIRED:${entry.gamePk}`);
    const evidence = scoreMlbV16SettlementEvidence(entry.gamePk, input.live.generatedAt, c4);
    return adaptMlbV16SettlementEvidence(evidence);
  });
}

type FinalCandidate = {
  gamePk: number;
  contextRank: number;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selectedSide: string;
  selectedLine: number | null;
  modelWinProbability: number;
  expectedValuePerUnit: number;
};

function dominates(left: FinalCandidate, right: FinalCandidate): boolean {
  const noWorse = left.contextRank <= right.contextRank
    && left.expectedValuePerUnit >= right.expectedValuePerUnit
    && left.modelWinProbability >= right.modelWinProbability;
  const strictlyBetter = left.contextRank < right.contextRank
    || left.expectedValuePerUnit > right.expectedValuePerUnit
    || left.modelWinProbability > right.modelWinProbability;
  return noWorse && strictlyBetter;
}

function pricedDecision(input: {
  live: MlbDailyOpportunityLiveResult;
  acquisition: MlbSelectiveOddsAcquisitionResult;
  operatingEnvelope: MlbOperatingEnvelopeResult;
}): MlbDailyOpportunityPricedDecision {
  if (input.live.priceConsultationShortlist.entries.length === 0) {
    return Object.freeze({ action: "NO_PLAY", reason: "NO_SPORTING_SHORTLIST", recommendation: null });
  }
  if (deferredEntries(input.live).length > 0) {
    return Object.freeze({ action: "WAIT", reason: "PROVISIONAL_FRONTIER_REMAINS", recommendation: null });
  }
  if (input.acquisition.status === "BLOCKED" || input.acquisition.status === "PARTIAL") {
    return Object.freeze({ action: "WAIT", reason: "PRICE_ACQUISITION_INCOMPLETE", recommendation: null });
  }

  const contextByPk = new Map(input.live.priceConsultationShortlist.entries.map((entry) => [entry.gamePk, entry.contextRank]));
  const candidates: FinalCandidate[] = [];
  let unresolved = false;
  for (const game of input.operatingEnvelope.games) {
    for (const market of game.markets) {
      if (market.classification === "UPSTREAM_BLOCKED" || market.classification === "POSITIVE_EV_ENVELOPE_BLOCKED") {
        unresolved = true;
      }
      if (!market.eliteEvidenceCandidate) continue;
      if (
        market.selectedSide == null
        || market.modelWinProbability == null
        || market.expectedValuePerUnit == null
        || !Number.isFinite(market.modelWinProbability)
        || !Number.isFinite(market.expectedValuePerUnit)
      ) continue;
      candidates.push({
        gamePk: game.gamePk,
        contextRank: contextByPk.get(game.gamePk) ?? Number.MAX_SAFE_INTEGER,
        homeTeam: String(game.homeTeam?.name ?? ""),
        awayTeam: String(game.awayTeam?.name ?? ""),
        marketType: market.marketType,
        selectedSide: market.selectedSide,
        selectedLine: market.selectedLine,
        modelWinProbability: market.modelWinProbability,
        expectedValuePerUnit: market.expectedValuePerUnit,
      });
    }
  }

  if (unresolved) {
    return Object.freeze({ action: "WAIT", reason: "UNRESOLVED_ECONOMIC_EVIDENCE", recommendation: null });
  }
  if (candidates.length === 0) {
    return Object.freeze({ action: "NO_PLAY", reason: "NO_POSITIVE_EV", recommendation: null });
  }

  const frontier = candidates.filter((candidate) =>
    !candidates.some((other) => other !== candidate && dominates(other, candidate)),
  );
  if (frontier.length !== 1) {
    return Object.freeze({
      action: "WAIT",
      reason: "MULTIPLE_NONDOMINATED_PRICE_OPPORTUNITIES",
      recommendation: null,
    });
  }

  const winner = frontier[0];
  return Object.freeze({
    action: "PLAY",
    reason: "UNIQUE_NONDOMINATED_PRICE_OPPORTUNITY",
    recommendation: Object.freeze({ ...winner }),
  });
}

function prePriceDecision(live: MlbDailyOpportunityLiveResult): MlbDailyOpportunityPricedDecision | null {
  if (live.priceConsultationShortlist.entries.length === 0) {
    return Object.freeze({ action: "NO_PLAY", reason: "NO_SPORTING_SHORTLIST", recommendation: null });
  }
  if (deferredEntries(live).length > 0) {
    return Object.freeze({ action: "WAIT", reason: "PROVISIONAL_FRONTIER_REMAINS", recommendation: null });
  }
  return null;
}

export async function runMlbDailyOpportunityPricedBridge(input: {
  assembled: MlbUnifiedV16AssembledRunnerInput;
  live: MlbDailyOpportunityLiveResult;
  runtime: MlbDailyOpportunityPriceRuntime;
  dependencies: MlbDailyOpportunityPricedBridgeDependencies;
}): Promise<MlbDailyOpportunityPricedBridgeResult> {
  validateShortlist(input.live);
  const ready = readyEntries(input.live);
  const deferred = deferredEntries(input.live);
  const earlyDecision = prePriceDecision(input.live);
  if (earlyDecision) {
    return Object.freeze({
      schemaVersion: MLB_DAILY_OPPORTUNITY_PRICED_BRIDGE_SCHEMA,
      generatedAt: input.live.generatedAt,
      sourceRunId: input.live.preprice.runId,
      priceRunId: null,
      decision: earlyDecision,
      priceDiscovery: null,
      acquisition: null,
      marketEdge: null,
      operatingEnvelope: null,
      summary: Object.freeze({
        wholeSlateSportingOpportunitiesEvaluated: input.live.dailyOpportunity.summary.intrinsicEvaluatedGames,
        shortlistedForPossiblePriceConsultation: input.live.priceConsultationShortlist.entries.length,
        deferredProvisionalCandidates: deferred.length,
        readyFinalCandidates: ready.length,
        gamesExposedToOddsService: 0,
        paidEventOddsCalls: 0,
        eliteEvidenceCandidates: 0,
      }),
      policy: Object.freeze({
        wholeSlateAnalysisPrecedesPrice: true as const,
        maximumPriceConsultationCandidates: MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS,
        provisionalCandidateBlocksPriceBoundary: true as const,
        onlyShortlistedFinalGamesReachOddsService: true as const,
        discoveryBuiltFromWholeSlateIntrinsicPopulation: true as const,
        ninthOrLaterWholeSlateGameMayReachPriceWhenShortlisted: true as const,
        unsupportedV16MarketsRemovedBeforeProviderAccess: true as const,
        supportedPricedMarkets: Object.freeze(["ML", "F5_ML"] as const),
        oneUniversalWeightedScoreUsed: false as const,
        finalSelectionUsesParetoDominance: true as const,
        outcomesRead: false as const,
        v68Changed: false as const,
        v80Changed: false as const,
        stakeCalculated: false as const,
        automaticBetPlacement: false as const,
        realFinancialExposure: 0 as const,
      }),
    });
  }

  const priceDiscovery = buildMlbDailyOpportunityPriceDiscovery({ live: input.live });
  if (priceDiscovery.games.length > MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS) {
    throw new Error(`MLB_DAILY_OPPORTUNITY_ODDS_EXPOSURE_CAP_EXCEEDED:${priceDiscovery.games.length}`);
  }
  const priceRunId = `${input.live.preprice.runId}:daily-opportunity-price`;
  const acquisition = await input.dependencies.oddsService.acquire({
    runId: priceRunId,
    providerAccountScopeKey: input.runtime.providerAccountScopeKey,
    discovery: priceDiscovery,
    maxRunCredits: input.runtime.maxRunCredits,
    reserveCredits: input.runtime.reserveCredits,
    apiKey: input.runtime.apiKey,
  });
  const modelAssessments = buildSelectedModelAssessments({ assembled: input.assembled, live: input.live });
  const economicNow = input.dependencies.now?.() ?? new Date();
  if (!Number.isFinite(economicNow.getTime())) {
    throw new Error("MLB_DAILY_OPPORTUNITY_ECONOMIC_NOW_INVALID");
  }
  const marketEdge = (input.dependencies.evaluateMarketEdges ?? evaluateMlbMarketEdges)({
    acquisition,
    modelAssessments,
    now: economicNow,
  });
  const operatingEnvelope = (input.dependencies.buildOperatingEnvelope ?? buildMlbOperatingEnvelope)({ marketEdge });
  const decision = pricedDecision({ live: input.live, acquisition, operatingEnvelope });

  return Object.freeze({
    schemaVersion: MLB_DAILY_OPPORTUNITY_PRICED_BRIDGE_SCHEMA,
    generatedAt: input.live.generatedAt,
    sourceRunId: input.live.preprice.runId,
    priceRunId,
    decision,
    priceDiscovery,
    acquisition,
    marketEdge,
    operatingEnvelope,
    summary: Object.freeze({
      wholeSlateSportingOpportunitiesEvaluated: input.live.dailyOpportunity.summary.intrinsicEvaluatedGames,
      shortlistedForPossiblePriceConsultation: input.live.priceConsultationShortlist.entries.length,
      deferredProvisionalCandidates: deferred.length,
      readyFinalCandidates: ready.length,
      gamesExposedToOddsService: priceDiscovery.games.length,
      paidEventOddsCalls: acquisition.providerCalls.paidEventOdds,
      eliteEvidenceCandidates: operatingEnvelope.summary.eliteEvidenceCandidates,
    }),
    policy: Object.freeze({
      wholeSlateAnalysisPrecedesPrice: true as const,
      maximumPriceConsultationCandidates: MLB_DAILY_OPPORTUNITY_MAX_PRICE_CONSULTATIONS,
      provisionalCandidateBlocksPriceBoundary: true as const,
      onlyShortlistedFinalGamesReachOddsService: true as const,
      discoveryBuiltFromWholeSlateIntrinsicPopulation: true as const,
      ninthOrLaterWholeSlateGameMayReachPriceWhenShortlisted: true as const,
      unsupportedV16MarketsRemovedBeforeProviderAccess: true as const,
      supportedPricedMarkets: Object.freeze(["ML", "F5_ML"] as const),
      oneUniversalWeightedScoreUsed: false as const,
      finalSelectionUsesParetoDominance: true as const,
      outcomesRead: false as const,
      v68Changed: false as const,
      v80Changed: false as const,
      stakeCalculated: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
