import type { MlbP1M2aMarket } from "./mlb-p1-pregame-readiness-contract";
import type { MlbMarketType } from "./mlb-market-contract";
import {
  MLB_MARKET_DISCOVERY_POLICY,
  MLB_MARKET_UNIVERSE_REGISTRY,
  type MlbHardRockEvidenceStatus,
  type MlbMarketRegistryEntry,
  type MlbModelIntegrationStatus,
  type MlbRegistryAcquisition,
  type MlbRegistryFamily,
  type MlbRegistryPeriod,
  type MlbRegistryQuoteShape,
} from "./mlb-market-universe-registry";
import { estimateMlbEventOddsWorstCaseCredits } from "./mlb-odds-budget-controller";
import type {
  MlbShortlistCandidate,
  MlbShortlistComponent,
  MlbShortlistResult,
} from "./mlb-shortlist";

export const MLB_MARKET_DISCOVERY_SCHEMA = "courtedge-p0-mlb-market-discovery.v1" as const;

/**
 * These are the only market families currently accepted by the existing P1-M2A
 * pregame-readiness contract. This is an analytical-maturity gate, not a market
 * preference. F3, F5 run line, first-inning and team-total contracts remain visible
 * as research-only until an equivalent analytical path exists.
 */
export const MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS = [
  "ML",
  "F5_ML",
  "RUN_LINE",
  "TOTAL",
  "F5_TOTAL",
] as const satisfies readonly MlbP1M2aMarket[];

export type MlbMarketDiscoveryCatalogStatus =
  | "CURRENT_PREGAME_PATH"
  | "RESEARCH_ONLY_ANALYTICAL_PATH_MISSING"
  | "BLOCKED_CONTRACT_MISMATCH"
  | "CATALOG_ONLY_NOT_IMPLEMENTED";

export type MlbMarketDiscoveryBlockReason =
  | "CURRENT_PREGAME_ANALYTICAL_PATH"
  | "ANALYTICAL_PATH_NOT_YET_IMPLEMENTED"
  | "THREE_WAY_CONTRACT_MISMATCH"
  | "PLAYER_PROP_REQUIRES_DEDICATED_MODEL"
  | "MARKET_MODEL_NOT_IMPLEMENTED";

export interface MlbMarketDiscoveryCatalogEntry {
  providerMarketKey: string;
  displayName: string;
  period: MlbRegistryPeriod;
  family: MlbRegistryFamily;
  quoteShape: MlbRegistryQuoteShape;
  acquisition: MlbRegistryAcquisition;
  canonicalMarketTypes: readonly MlbMarketType[];
  modelIntegrationStatus: MlbModelIntegrationStatus;
  catalogStatus: MlbMarketDiscoveryCatalogStatus;
  reasonCode: MlbMarketDiscoveryBlockReason;
  hardRockEvidenceStatus: MlbHardRockEvidenceStatus;
  liveHardRockFloridaDiscoveryRequired: true;
}

export interface MlbMarketDiscoveryPlannedMarket {
  providerMarketKey: string;
  displayName: string;
  canonicalMarketType: MlbP1M2aMarket;
  period: MlbRegistryPeriod;
  family: MlbRegistryFamily;
  quoteShape: MlbRegistryQuoteShape;
  acquisition: MlbRegistryAcquisition;
  supportingComponents: readonly MlbShortlistComponent[];
  independentSupportingComponentCount: number;
  hardRockEvidenceStatus: MlbHardRockEvidenceStatus;
  liveHardRockFloridaDiscoveryRequired: true;
}

export interface MlbMarketDiscoveryGamePlan {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  homeTeam: MlbShortlistCandidate["homeTeam"];
  awayTeam: MlbShortlistCandidate["awayTeam"];
  finalInputsAvailable: boolean;
  shortlistSignalComponents: readonly MlbShortlistComponent[];
  plannedMarkets: readonly MlbMarketDiscoveryPlannedMarket[];
  plannedProviderMarketKeys: readonly string[];
  paidLookupEligibleNow: boolean;
  paidLookupHoldReason: "OFFICIAL_FINAL_INPUTS_REQUIRED" | "NO_RELEVANT_CURRENT_ANALYTICAL_MARKET" | null;
  providerMarketKeysToRequestNow: readonly string[];
  worstCaseCreditsPerOneBookmakerRegionEquivalentNow: number;
}

export interface MlbMarketDiscoveryResult {
  schemaVersion: typeof MLB_MARKET_DISCOVERY_SCHEMA;
  generatedAt: string;
  date: string;
  sourceShortlistSchemaVersion: MlbShortlistResult["schemaVersion"];
  games: readonly MlbMarketDiscoveryGamePlan[];
  catalog: {
    currentPregamePath: readonly MlbMarketDiscoveryCatalogEntry[];
    researchOnly: readonly MlbMarketDiscoveryCatalogEntry[];
    blockedContractMismatch: readonly MlbMarketDiscoveryCatalogEntry[];
    catalogOnlyNotImplemented: readonly MlbMarketDiscoveryCatalogEntry[];
  };
  summary: {
    shortlistedGames: number;
    gamesWithDiscoveryPlan: number;
    gamesPaidLookupEligibleNow: number;
    gamesHeldForFinalInputs: number;
    gamesWithNoRelevantCurrentAnalyticalMarket: number;
    providerMarketsPlannedNow: number;
    worstCaseCreditsPerOneBookmakerRegionEquivalentNow: number;
  };
  policy: {
    marketNeutral: true;
    firstThreeInningsPriority: false;
    marketOrderCarriesPreference: false;
    currentAnalyticalPathDefinesPaidEligibility: true;
    researchOnlyMarketsConsumeProviderCredits: false;
    playerPropsQueryEligible: false;
    threeWayCoercionAllowed: false;
    onlyFinalInputsMayAuthorizePaidLookup: true;
    quoteAvailabilityMustBeVerifiedPerEvent: true;
    hardRockFloridaAvailabilityAssumed: false;
    callsTheOddsApi: false;
    theOddsApiCreditsConsumed: 0;
    predictsWinner: false;
    recommendsBet: false;
  };
  safety: MlbShortlistResult["safety"];
}

const CURRENT_ANALYTICAL_SET = new Set<MlbMarketType>(MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS);
const NON_TOTAL_SIGNAL_COMPONENTS = new Set<MlbShortlistComponent>([
  "STATCAST_QUALITY",
  "DISCIPLINE_SPEED",
  "SOS",
]);

function catalogStatus(entry: MlbMarketRegistryEntry): Pick<
  MlbMarketDiscoveryCatalogEntry,
  "catalogStatus" | "reasonCode"
> {
  if (entry.canonicalMarketTypes.some((market) => CURRENT_ANALYTICAL_SET.has(market))) {
    return {
      catalogStatus: "CURRENT_PREGAME_PATH",
      reasonCode: "CURRENT_PREGAME_ANALYTICAL_PATH",
    };
  }
  if (entry.modelIntegrationStatus === "SUPPORTED") {
    return {
      catalogStatus: "RESEARCH_ONLY_ANALYTICAL_PATH_MISSING",
      reasonCode: "ANALYTICAL_PATH_NOT_YET_IMPLEMENTED",
    };
  }
  if (entry.modelIntegrationStatus === "CONTRACT_MISMATCH") {
    return {
      catalogStatus: "BLOCKED_CONTRACT_MISMATCH",
      reasonCode: "THREE_WAY_CONTRACT_MISMATCH",
    };
  }
  return {
    catalogStatus: "CATALOG_ONLY_NOT_IMPLEMENTED",
    reasonCode: entry.period === "PLAYER"
      ? "PLAYER_PROP_REQUIRES_DEDICATED_MODEL"
      : "MARKET_MODEL_NOT_IMPLEMENTED",
  };
}

function catalogEntry(entry: MlbMarketRegistryEntry): MlbMarketDiscoveryCatalogEntry {
  const status = catalogStatus(entry);
  return {
    providerMarketKey: entry.providerMarketKey,
    displayName: entry.displayName,
    period: entry.period,
    family: entry.family,
    quoteShape: entry.quoteShape,
    acquisition: entry.acquisition,
    canonicalMarketTypes: entry.canonicalMarketTypes,
    modelIntegrationStatus: entry.modelIntegrationStatus,
    catalogStatus: status.catalogStatus,
    reasonCode: status.reasonCode,
    hardRockEvidenceStatus: entry.hardRockEvidenceStatus,
    liveHardRockFloridaDiscoveryRequired: true,
  };
}

function buildCatalog() {
  const classified = MLB_MARKET_UNIVERSE_REGISTRY.map(catalogEntry);
  const byKey = (left: MlbMarketDiscoveryCatalogEntry, right: MlbMarketDiscoveryCatalogEntry) =>
    left.providerMarketKey.localeCompare(right.providerMarketKey);
  return {
    currentPregamePath: classified.filter((entry) => entry.catalogStatus === "CURRENT_PREGAME_PATH").sort(byKey),
    researchOnly: classified.filter((entry) => entry.catalogStatus === "RESEARCH_ONLY_ANALYTICAL_PATH_MISSING").sort(byKey),
    blockedContractMismatch: classified.filter((entry) => entry.catalogStatus === "BLOCKED_CONTRACT_MISMATCH").sort(byKey),
    catalogOnlyNotImplemented: classified.filter((entry) => entry.catalogStatus === "CATALOG_ONLY_NOT_IMPLEMENTED").sort(byKey),
  } as const;
}

function currentEntryForMarket(market: MlbP1M2aMarket): MlbMarketRegistryEntry {
  const matches = MLB_MARKET_UNIVERSE_REGISTRY.filter((entry) =>
    entry.modelIntegrationStatus === "SUPPORTED"
    && entry.canonicalMarketTypes.includes(market),
  );
  if (matches.length !== 1) {
    throw new Error(`MLB_MARKET_DISCOVERY_CURRENT_MARKET_MAPPING_INVALID:${market}:${matches.length}`);
  }
  return matches[0];
}

function activeSignalComponents(candidate: MlbShortlistCandidate): MlbShortlistComponent[] {
  return [...new Set(candidate.signals.map((signal) => signal.component))]
    .sort((left, right) => left.localeCompare(right));
}

function supportingComponents(
  candidate: MlbShortlistCandidate,
  market: MlbP1M2aMarket,
): MlbShortlistComponent[] {
  const active = activeSignalComponents(candidate);
  if (market === "TOTAL" || market === "F5_TOTAL") return active;
  return active.filter((component) => NON_TOTAL_SIGNAL_COMPONENTS.has(component));
}

function plannedMarket(
  candidate: MlbShortlistCandidate,
  market: MlbP1M2aMarket,
): MlbMarketDiscoveryPlannedMarket | null {
  const support = supportingComponents(candidate, market);
  if (support.length === 0) return null;
  const entry = currentEntryForMarket(market);
  return {
    providerMarketKey: entry.providerMarketKey,
    displayName: entry.displayName,
    canonicalMarketType: market,
    period: entry.period,
    family: entry.family,
    quoteShape: entry.quoteShape,
    acquisition: entry.acquisition,
    supportingComponents: support,
    independentSupportingComponentCount: support.length,
    hardRockEvidenceStatus: entry.hardRockEvidenceStatus,
    liveHardRockFloridaDiscoveryRequired: true,
  };
}

function planForCandidate(candidate: MlbShortlistCandidate): MlbMarketDiscoveryGamePlan {
  const plannedMarkets = MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS
    .map((market) => plannedMarket(candidate, market))
    .filter((market): market is MlbMarketDiscoveryPlannedMarket => market != null)
    .sort((left, right) => left.providerMarketKey.localeCompare(right.providerMarketKey));
  const plannedProviderMarketKeys = plannedMarkets.map((market) => market.providerMarketKey);

  const hasMarkets = plannedProviderMarketKeys.length > 0;
  const paidLookupEligibleNow = candidate.finalInputsAvailable && hasMarkets;
  const paidLookupHoldReason = !hasMarkets
    ? "NO_RELEVANT_CURRENT_ANALYTICAL_MARKET" as const
    : !candidate.finalInputsAvailable
      ? "OFFICIAL_FINAL_INPUTS_REQUIRED" as const
      : null;
  const providerMarketKeysToRequestNow = paidLookupEligibleNow ? plannedProviderMarketKeys : [];
  const worstCaseCreditsPerOneBookmakerRegionEquivalentNow = providerMarketKeysToRequestNow.length > 0
    ? estimateMlbEventOddsWorstCaseCredits(providerMarketKeysToRequestNow, 1)
    : 0;

  return {
    gamePk: candidate.gamePk,
    officialDate: candidate.officialDate,
    startTime: candidate.startTime,
    homeTeam: candidate.homeTeam,
    awayTeam: candidate.awayTeam,
    finalInputsAvailable: candidate.finalInputsAvailable,
    shortlistSignalComponents: activeSignalComponents(candidate),
    plannedMarkets,
    plannedProviderMarketKeys,
    paidLookupEligibleNow,
    paidLookupHoldReason,
    providerMarketKeysToRequestNow,
    worstCaseCreditsPerOneBookmakerRegionEquivalentNow,
  };
}

export function buildMlbMarketDiscovery(input: {
  shortlist: MlbShortlistResult;
}): MlbMarketDiscoveryResult {
  const games = input.shortlist.selected.map(planForCandidate);
  const catalog = buildCatalog();
  return {
    schemaVersion: MLB_MARKET_DISCOVERY_SCHEMA,
    generatedAt: new Date().toISOString(),
    date: input.shortlist.date,
    sourceShortlistSchemaVersion: input.shortlist.schemaVersion,
    games,
    catalog,
    summary: {
      shortlistedGames: input.shortlist.selected.length,
      gamesWithDiscoveryPlan: games.filter((game) => game.plannedMarkets.length > 0).length,
      gamesPaidLookupEligibleNow: games.filter((game) => game.paidLookupEligibleNow).length,
      gamesHeldForFinalInputs: games.filter((game) => game.paidLookupHoldReason === "OFFICIAL_FINAL_INPUTS_REQUIRED").length,
      gamesWithNoRelevantCurrentAnalyticalMarket: games.filter((game) => game.paidLookupHoldReason === "NO_RELEVANT_CURRENT_ANALYTICAL_MARKET").length,
      providerMarketsPlannedNow: games.reduce((sum, game) => sum + game.providerMarketKeysToRequestNow.length, 0),
      worstCaseCreditsPerOneBookmakerRegionEquivalentNow: games.reduce(
        (sum, game) => sum + game.worstCaseCreditsPerOneBookmakerRegionEquivalentNow,
        0,
      ),
    },
    policy: {
      marketNeutral: true,
      firstThreeInningsPriority: false,
      marketOrderCarriesPreference: false,
      currentAnalyticalPathDefinesPaidEligibility: true,
      researchOnlyMarketsConsumeProviderCredits: false,
      playerPropsQueryEligible: false,
      threeWayCoercionAllowed: false,
      onlyFinalInputsMayAuthorizePaidLookup: true,
      quoteAvailabilityMustBeVerifiedPerEvent: MLB_MARKET_DISCOVERY_POLICY.quoteAvailabilityMustBeVerifiedPerEvent,
      hardRockFloridaAvailabilityAssumed: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      predictsWinner: false,
      recommendsBet: false,
    },
    safety: input.shortlist.safety,
  };
}
