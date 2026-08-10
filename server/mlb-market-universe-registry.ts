import type { MlbMarketType } from "./mlb-market-contract";

export const MLB_MARKET_UNIVERSE_REGISTRY_VERSION = "courtedge-p0-mlb-market-universe-registry.v1" as const;
export const MLB_MARKET_UNIVERSE_VERIFIED_AT = "2026-08-10" as const;

export type MlbRegistryDocumentationClass =
  | "MLB_FEATURED"
  | "GENERAL_ADDITIONAL"
  | "BASEBALL_PERIOD"
  | "MLB_PLAYER_PROP"
  | "MLB_PLAYER_PROP_ALTERNATE";

export type MlbRegistryApplicability = "MLB_EXPLICIT" | "LIVE_DISCOVERY_REQUIRED";
export type MlbRegistryAcquisition = "SPORT_ODDS_OR_EVENT_ODDS" | "EVENT_ODDS_ONLY";
export type MlbRegistryPeriod = "FULL_GAME" | "FIRST_1" | "FIRST_3" | "FIRST_5" | "FIRST_7" | "PLAYER";
export type MlbRegistryFamily =
  | "MONEYLINE"
  | "RUN_LINE"
  | "TOTAL"
  | "TEAM_TOTAL"
  | "BATTER_PROP"
  | "PITCHER_PROP";
export type MlbRegistryQuoteShape =
  | "TEAM_TWO_WAY"
  | "TEAM_THREE_WAY"
  | "OVER_UNDER"
  | "PLAYER_OVER_UNDER"
  | "PLAYER_YES_NO";
export type MlbHardRockEvidenceStatus =
  | "EXACT_FIRST_PARTY_PRODUCT_EVIDENCE"
  | "CATEGORY_ONLY_FIRST_PARTY_EVIDENCE"
  | "NOT_VERIFIED";
export type MlbModelIntegrationStatus = "SUPPORTED" | "NOT_IMPLEMENTED" | "CONTRACT_MISMATCH";

export interface MlbMarketRegistryEntry {
  providerMarketKey: string;
  displayName: string;
  documentationClass: MlbRegistryDocumentationClass;
  providerApplicability: MlbRegistryApplicability;
  acquisition: MlbRegistryAcquisition;
  period: MlbRegistryPeriod;
  family: MlbRegistryFamily;
  quoteShape: MlbRegistryQuoteShape;
  canonicalMarketTypes: readonly MlbMarketType[];
  modelIntegrationStatus: MlbModelIntegrationStatus;
  hardRockEvidenceStatus: MlbHardRockEvidenceStatus;
  hardRockEvidenceSourceIds: readonly string[];
  liveHardRockFloridaDiscoveryRequired: true;
  notes: readonly string[];
}

export interface MlbCanonicalMarketGap {
  marketType: MlbMarketType;
  providerMarketKey: null;
  reason: string;
  liveDiscoveryMayResolve: boolean;
}

/**
 * Source provenance frozen for Registry v1.
 * These identifiers deliberately distinguish official provider documentation from
 * first-party sportsbook product evidence. Neither class is treated as proof that a
 * specific Hard Rock Florida quote is currently open for a specific MLB event.
 */
export const MLB_MARKET_REGISTRY_EVIDENCE = Object.freeze({
  THE_ODDS_API_MLB: {
    authority: "The Odds API",
    sourcePath: "/sports/mlb-odds.html",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "MLB featured markets and statement that innings/player markets are covered",
  },
  THE_ODDS_API_MARKETS: {
    authority: "The Odds API",
    sourcePath: "/sports-odds-data/betting-markets.html",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "documented market keys, including baseball periods and MLB player props",
  },
  THE_ODDS_API_V4: {
    authority: "The Odds API",
    sourcePath: "/liveapi/guides/v4/",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "events/event-odds/event-markets endpoint behavior and quota semantics",
  },
  THE_ODDS_API_BOOKMAKERS: {
    authority: "The Odds API",
    sourcePath: "/sports-odds-data/bookmaker-apis.html",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "hardrockbet_fl bookmaker key in region us2",
  },
  HARD_ROCK_MLB_GUIDE_20260807: {
    authority: "Hard Rock Bet",
    sourcePath: "/sportsbook/baseball/mlb",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "MLB moneyline/winner, run line/spread, total, inning props, player prop categories",
  },
  HARD_ROCK_F5_TOTAL_ML_20260701: {
    authority: "Hard Rock Bet",
    sourcePath: "/news/mlb-best-bets-picks-predictions-for-wednesday-july-1-fantasypros/",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "First 5 innings total and First 5 innings moneyline product evidence",
  },
  HARD_ROCK_F5_RUN_LINE_20260421: {
    authority: "Hard Rock Bet",
    sourcePath: "/news/fantasypros-leading-off-mlb-best-bets-for-tuesday-april-21/",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "First 5 innings run line product evidence",
  },
  HARD_ROCK_NRFI_YRFI_20260728: {
    authority: "Hard Rock Bet",
    sourcePath: "/news/nrfi-best-bets-today-mlb-no-run-first-inning-predictions-picks-for-july-28/",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "NRFI and YRFI product evidence",
  },
  HARD_ROCK_TEAM_TOTALS_20260714: {
    authority: "Hard Rock Bet",
    sourcePath: "/news/2026-mlb-all-star-game-betting-guide-odds-specials-event-info/",
    verifiedAt: MLB_MARKET_UNIVERSE_VERIFIED_AT,
    scope: "team totals and multiple alternate team-total lines",
  },
} as const);

export const MLB_MARKET_DISCOVERY_POLICY = Object.freeze({
  sportKey: "baseball_mlb",
  executionBookmakerKey: "hardrockbet_fl",
  executionBookmakerRegion: "us2",
  registryPerformsNetworkRequests: false,
  registryConsumesProviderCredits: false,
  eventsEndpointReportedQuotaCost: 0,
  eventMarketsEndpointReportedQuotaCost: 1,
  eventMarketsIsComprehensiveCatalog: false,
  eventMarketsReflectsRecentlySeenBookmakerMarkets: true,
  queryEventMarketsOnlyAfterShortlist: true,
  quoteAvailabilityMustBeVerifiedPerEvent: true,
  providerDocumentationNeverImpliesHardRockFloridaExecution: true,
} as const);

const HARD_ROCK_EXACT_EVIDENCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  h2h: ["HARD_ROCK_MLB_GUIDE_20260807"],
  spreads: ["HARD_ROCK_MLB_GUIDE_20260807"],
  totals: ["HARD_ROCK_MLB_GUIDE_20260807"],
  alternate_totals: ["HARD_ROCK_TEAM_TOTALS_20260714"],
  team_totals: ["HARD_ROCK_TEAM_TOTALS_20260714"],
  alternate_team_totals: ["HARD_ROCK_TEAM_TOTALS_20260714"],
  h2h_1st_1_innings: ["HARD_ROCK_MLB_GUIDE_20260807"],
  h2h_1st_5_innings: ["HARD_ROCK_F5_TOTAL_ML_20260701"],
  spreads_1st_5_innings: ["HARD_ROCK_F5_RUN_LINE_20260421"],
  totals_1st_5_innings: ["HARD_ROCK_F5_TOTAL_ML_20260701"],
  totals_1st_1_innings: ["HARD_ROCK_NRFI_YRFI_20260728"],
  batter_home_runs: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_hits: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_total_bases: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_rbis: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_runs_scored: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_singles: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_doubles: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_triples: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_strikeouts: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_stolen_bases: ["HARD_ROCK_MLB_GUIDE_20260807"],
  pitcher_strikeouts: ["HARD_ROCK_MLB_GUIDE_20260807"],
  pitcher_hits_allowed: ["HARD_ROCK_MLB_GUIDE_20260807"],
  pitcher_walks: ["HARD_ROCK_MLB_GUIDE_20260807"],
  pitcher_earned_runs: ["HARD_ROCK_MLB_GUIDE_20260807"],
  pitcher_outs: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_home_runs_alternate: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_runs_scored_alternate: ["HARD_ROCK_MLB_GUIDE_20260807"],
});

const HARD_ROCK_CATEGORY_ONLY_EVIDENCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  batter_first_home_run: ["HARD_ROCK_MLB_GUIDE_20260807"],
  batter_hits_alternate: ["HARD_ROCK_MLB_GUIDE_20260807"],
});

const CANONICAL_BY_PROVIDER_KEY: Readonly<Record<string, readonly MlbMarketType[]>> = Object.freeze({
  h2h: ["ML"],
  spreads: ["RUN_LINE"],
  totals: ["TOTAL"],
  team_totals: ["TEAM_TOTAL"],
  h2h_1st_5_innings: ["F5_ML"],
  spreads_1st_5_innings: ["F5_RUN_LINE"],
  totals_1st_5_innings: ["F5_TOTAL"],
  h2h_1st_3_innings: ["F3_ML"],
  spreads_1st_3_innings: ["F3_RUN_LINE"],
  totals_1st_3_innings: ["F3_TOTAL"],
  h2h_1st_1_innings: ["INNING_1_ML"],
  totals_1st_1_innings: ["NRFI", "YRFI"],
});

const CONTRACT_MISMATCH_KEYS = new Set([
  "h2h_3_way",
  "h2h_3_way_1st_1_innings",
  "h2h_3_way_1st_3_innings",
  "h2h_3_way_1st_5_innings",
  "h2h_3_way_1st_7_innings",
]);

function hardRockEvidence(providerMarketKey: string): {
  status: MlbHardRockEvidenceStatus;
  sourceIds: readonly string[];
} {
  const exact = HARD_ROCK_EXACT_EVIDENCE[providerMarketKey];
  if (exact) return { status: "EXACT_FIRST_PARTY_PRODUCT_EVIDENCE", sourceIds: exact };
  const category = HARD_ROCK_CATEGORY_ONLY_EVIDENCE[providerMarketKey];
  if (category) return { status: "CATEGORY_ONLY_FIRST_PARTY_EVIDENCE", sourceIds: category };
  return { status: "NOT_VERIFIED", sourceIds: [] };
}

function periodFromInnings(innings: number): MlbRegistryPeriod {
  if (innings === 1) return "FIRST_1";
  if (innings === 3) return "FIRST_3";
  if (innings === 5) return "FIRST_5";
  return "FIRST_7";
}

function entry(input: {
  providerMarketKey: string;
  displayName: string;
  documentationClass: MlbRegistryDocumentationClass;
  providerApplicability: MlbRegistryApplicability;
  acquisition: MlbRegistryAcquisition;
  period: MlbRegistryPeriod;
  family: MlbRegistryFamily;
  quoteShape: MlbRegistryQuoteShape;
  notes?: readonly string[];
}): MlbMarketRegistryEntry {
  const evidence = hardRockEvidence(input.providerMarketKey);
  const canonicalMarketTypes = CANONICAL_BY_PROVIDER_KEY[input.providerMarketKey] ?? [];
  const modelIntegrationStatus: MlbModelIntegrationStatus = CONTRACT_MISMATCH_KEYS.has(input.providerMarketKey)
    ? "CONTRACT_MISMATCH"
    : canonicalMarketTypes.length > 0
      ? "SUPPORTED"
      : "NOT_IMPLEMENTED";
  return Object.freeze({
    ...input,
    canonicalMarketTypes,
    modelIntegrationStatus,
    hardRockEvidenceStatus: evidence.status,
    hardRockEvidenceSourceIds: evidence.sourceIds,
    liveHardRockFloridaDiscoveryRequired: true as const,
    notes: input.notes ?? [],
  });
}

const FEATURED_MARKETS: readonly MlbMarketRegistryEntry[] = [
  entry({ providerMarketKey: "h2h", displayName: "Moneyline", documentationClass: "MLB_FEATURED", providerApplicability: "MLB_EXPLICIT", acquisition: "SPORT_ODDS_OR_EVENT_ODDS", period: "FULL_GAME", family: "MONEYLINE", quoteShape: "TEAM_TWO_WAY" }),
  entry({ providerMarketKey: "spreads", displayName: "Run line / spread", documentationClass: "MLB_FEATURED", providerApplicability: "MLB_EXPLICIT", acquisition: "SPORT_ODDS_OR_EVENT_ODDS", period: "FULL_GAME", family: "RUN_LINE", quoteShape: "OVER_UNDER", notes: ["Canonical normalizer requires opposite team lines and paired prices."] }),
  entry({ providerMarketKey: "totals", displayName: "Game total", documentationClass: "MLB_FEATURED", providerApplicability: "MLB_EXPLICIT", acquisition: "SPORT_ODDS_OR_EVENT_ODDS", period: "FULL_GAME", family: "TOTAL", quoteShape: "OVER_UNDER" }),
];

const GENERAL_ADDITIONAL_MARKETS: readonly MlbMarketRegistryEntry[] = [
  entry({ providerMarketKey: "alternate_spreads", displayName: "Alternate run lines / spreads", documentationClass: "GENERAL_ADDITIONAL", providerApplicability: "LIVE_DISCOVERY_REQUIRED", acquisition: "EVENT_ODDS_ONLY", period: "FULL_GAME", family: "RUN_LINE", quoteShape: "OVER_UNDER", notes: ["Provider documents this as a general additional market; MLB availability must be discovered live."] }),
  entry({ providerMarketKey: "alternate_totals", displayName: "Alternate game totals", documentationClass: "GENERAL_ADDITIONAL", providerApplicability: "LIVE_DISCOVERY_REQUIRED", acquisition: "EVENT_ODDS_ONLY", period: "FULL_GAME", family: "TOTAL", quoteShape: "OVER_UNDER", notes: ["Provider documents this as a general additional market; Hard Rock first-party MLB content shows alternate run totals, but per-event Florida availability is still required."] }),
  entry({ providerMarketKey: "h2h_3_way", displayName: "Three-way moneyline", documentationClass: "GENERAL_ADDITIONAL", providerApplicability: "LIVE_DISCOVERY_REQUIRED", acquisition: "EVENT_ODDS_ONLY", period: "FULL_GAME", family: "MONEYLINE", quoteShape: "TEAM_THREE_WAY", notes: ["No MLB-specific provider applicability is asserted; live discovery is mandatory.", "Must never be coerced into the two-way MLB moneyline contract."] }),
  entry({ providerMarketKey: "team_totals", displayName: "Team totals", documentationClass: "GENERAL_ADDITIONAL", providerApplicability: "LIVE_DISCOVERY_REQUIRED", acquisition: "EVENT_ODDS_ONLY", period: "FULL_GAME", family: "TEAM_TOTAL", quoteShape: "OVER_UNDER", notes: ["Hard Rock first-party baseball content confirms team totals; exact Florida event availability still requires live discovery."] }),
  entry({ providerMarketKey: "alternate_team_totals", displayName: "Alternate team totals", documentationClass: "GENERAL_ADDITIONAL", providerApplicability: "LIVE_DISCOVERY_REQUIRED", acquisition: "EVENT_ODDS_ONLY", period: "FULL_GAME", family: "TEAM_TOTAL", quoteShape: "OVER_UNDER", notes: ["Hard Rock first-party baseball content shows multiple team-total lines; exact provider key availability still requires live discovery."] }),
];

const BASEBALL_PERIOD_FAMILIES = [
  { prefix: "h2h", label: "Moneyline", family: "MONEYLINE" as const, quoteShape: "TEAM_TWO_WAY" as const },
  { prefix: "h2h_3_way", label: "Three-way moneyline", family: "MONEYLINE" as const, quoteShape: "TEAM_THREE_WAY" as const },
  { prefix: "spreads", label: "Run line / spread", family: "RUN_LINE" as const, quoteShape: "OVER_UNDER" as const },
  { prefix: "alternate_spreads", label: "Alternate run lines / spreads", family: "RUN_LINE" as const, quoteShape: "OVER_UNDER" as const },
  { prefix: "totals", label: "Total", family: "TOTAL" as const, quoteShape: "OVER_UNDER" as const },
  { prefix: "alternate_totals", label: "Alternate totals", family: "TOTAL" as const, quoteShape: "OVER_UNDER" as const },
] as const;

const BASEBALL_PERIOD_MARKETS: readonly MlbMarketRegistryEntry[] = BASEBALL_PERIOD_FAMILIES.flatMap((descriptor) =>
  ([1, 3, 5, 7] as const).map((innings) => entry({
    providerMarketKey: `${descriptor.prefix}_1st_${innings}_innings`,
    displayName: `${descriptor.label} first ${innings} inning${innings === 1 ? "" : "s"}`,
    documentationClass: "BASEBALL_PERIOD",
    providerApplicability: "MLB_EXPLICIT",
    acquisition: "EVENT_ODDS_ONLY",
    period: periodFromInnings(innings),
    family: descriptor.family,
    quoteShape: descriptor.quoteShape,
    notes: descriptor.prefix === "totals" && innings === 1
      ? ["NRFI/YRFI canonical mapping is valid only when the returned first-inning total line is exactly 0.5."]
      : descriptor.prefix === "h2h_3_way"
        ? ["Three-way period markets are a different quote contract and must fail closed against two-way canonical moneylines."]
        : [],
  })),
);

const MLB_PLAYER_PROP_MARKETS: readonly MlbMarketRegistryEntry[] = [
  ["batter_home_runs", "Batter home runs", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_first_home_run", "Batter first home run", "BATTER_PROP", "PLAYER_YES_NO"],
  ["batter_hits", "Batter hits", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_total_bases", "Batter total bases", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_rbis", "Batter RBIs", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_runs_scored", "Batter runs scored", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_hits_runs_rbis", "Batter hits + runs + RBIs", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_singles", "Batter singles", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_doubles", "Batter doubles", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_triples", "Batter triples", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_walks", "Batter walks", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_strikeouts", "Batter strikeouts", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_stolen_bases", "Batter stolen bases", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["batter_fantasy_score", "Batter fantasy score", "BATTER_PROP", "PLAYER_OVER_UNDER"],
  ["pitcher_strikeouts", "Pitcher strikeouts", "PITCHER_PROP", "PLAYER_OVER_UNDER"],
  ["pitcher_record_a_win", "Pitcher to record a win", "PITCHER_PROP", "PLAYER_YES_NO"],
  ["pitcher_hits_allowed", "Pitcher hits allowed", "PITCHER_PROP", "PLAYER_OVER_UNDER"],
  ["pitcher_walks", "Pitcher walks", "PITCHER_PROP", "PLAYER_OVER_UNDER"],
  ["pitcher_earned_runs", "Pitcher earned runs", "PITCHER_PROP", "PLAYER_OVER_UNDER"],
  ["pitcher_outs", "Pitcher outs", "PITCHER_PROP", "PLAYER_OVER_UNDER"],
].map(([providerMarketKey, displayName, family, quoteShape]) => entry({
  providerMarketKey,
  displayName,
  documentationClass: "MLB_PLAYER_PROP",
  providerApplicability: "MLB_EXPLICIT",
  acquisition: "EVENT_ODDS_ONLY",
  period: "PLAYER",
  family: family as MlbRegistryFamily,
  quoteShape: quoteShape as MlbRegistryQuoteShape,
  notes: providerMarketKey === "batter_fantasy_score"
    ? ["Provider labels this market as DFS-only; it is cataloged but not treated as a sportsbook execution assumption."]
    : [],
}));

const MLB_ALTERNATE_PLAYER_PROP_MARKETS: readonly MlbMarketRegistryEntry[] = [
  ["batter_total_bases_alternate", "Alternate batter total bases", "BATTER_PROP"],
  ["batter_home_runs_alternate", "Alternate batter home runs", "BATTER_PROP"],
  ["batter_hits_alternate", "Alternate batter hits", "BATTER_PROP"],
  ["batter_rbis_alternate", "Alternate batter RBIs", "BATTER_PROP"],
  ["batter_walks_alternate", "Alternate batter walks", "BATTER_PROP"],
  ["batter_strikeouts_alternate", "Alternate batter strikeouts", "BATTER_PROP"],
  ["batter_runs_scored_alternate", "Alternate batter runs scored", "BATTER_PROP"],
  ["batter_hits_runs_rbis_alternate", "Alternate batter hits + runs + RBIs", "BATTER_PROP"],
  ["batter_singles_alternate", "Alternate batter singles", "BATTER_PROP"],
  ["batter_doubles_alternate", "Alternate batter doubles", "BATTER_PROP"],
  ["batter_triples_alternate", "Alternate batter triples", "BATTER_PROP"],
  ["batter_fantasy_score_alternate", "Alternate batter fantasy score", "BATTER_PROP"],
  ["pitcher_hits_allowed_alternate", "Alternate pitcher hits allowed", "PITCHER_PROP"],
  ["pitcher_walks_alternate", "Alternate pitcher walks", "PITCHER_PROP"],
  ["pitcher_earned_runs_alternate", "Alternate pitcher earned runs", "PITCHER_PROP"],
  ["pitcher_strikeouts_alternate", "Alternate pitcher strikeouts", "PITCHER_PROP"],
  ["pitcher_outs_alternate", "Alternate pitcher outs", "PITCHER_PROP"],
].map(([providerMarketKey, displayName, family]) => entry({
  providerMarketKey,
  displayName,
  documentationClass: "MLB_PLAYER_PROP_ALTERNATE",
  providerApplicability: "MLB_EXPLICIT",
  acquisition: "EVENT_ODDS_ONLY",
  period: "PLAYER",
  family: family as MlbRegistryFamily,
  quoteShape: "PLAYER_OVER_UNDER",
  notes: providerMarketKey === "batter_fantasy_score_alternate"
    ? ["Provider labels the underlying fantasy-score market as DFS-only; cataloging does not make it sportsbook-executable."]
    : [],
}));

export const MLB_MARKET_UNIVERSE_REGISTRY: readonly MlbMarketRegistryEntry[] = Object.freeze([
  ...FEATURED_MARKETS,
  ...GENERAL_ADDITIONAL_MARKETS,
  ...BASEBALL_PERIOD_MARKETS,
  ...MLB_PLAYER_PROP_MARKETS,
  ...MLB_ALTERNATE_PLAYER_PROP_MARKETS,
]);

export const MLB_CANONICAL_MARKET_GAPS: readonly MlbCanonicalMarketGap[] = Object.freeze([
  { marketType: "F5_TEAM_TOTAL", providerMarketKey: null, reason: "No first-5 baseball team-total provider market key is documented in the verified provider market catalog.", liveDiscoveryMayResolve: true },
  { marketType: "F3_TEAM_TOTAL", providerMarketKey: null, reason: "No first-3 baseball team-total provider market key is documented in the verified provider market catalog.", liveDiscoveryMayResolve: true },
  { marketType: "TT_OVER_15_F5", providerMarketKey: null, reason: "Legacy canonical alias depends on first-5 team-total pricing, which has no verified provider key in Registry v1.", liveDiscoveryMayResolve: true },
  { marketType: "TT_UNDER_25_F5", providerMarketKey: null, reason: "Legacy canonical alias depends on first-5 team-total pricing, which has no verified provider key in Registry v1.", liveDiscoveryMayResolve: true },
]);

export function getMlbMarketRegistryEntry(providerMarketKey: string): MlbMarketRegistryEntry | null {
  return MLB_MARKET_UNIVERSE_REGISTRY.find((entry) => entry.providerMarketKey === providerMarketKey) ?? null;
}

export function getMlbRegistryKeysForLiveDiscovery(): readonly string[] {
  return MLB_MARKET_UNIVERSE_REGISTRY.map((entry) => entry.providerMarketKey);
}

export function intersectMlbDiscoveredMarketKeys(discoveredKeys: readonly string[]): readonly MlbMarketRegistryEntry[] {
  const discovered = new Set(discoveredKeys);
  return MLB_MARKET_UNIVERSE_REGISTRY.filter((entry) => discovered.has(entry.providerMarketKey));
}
