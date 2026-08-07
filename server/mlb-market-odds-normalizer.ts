import {
  consensusAmericanOdds,
  isStandardAmericanOdds,
  medianFinite,
  normalizeStandardAmericanOdds,
} from "./american-odds";
import {
  getMlbMarketContract,
  type MlbMarketType,
  type MlbQuoteContract,
} from "./mlb-market-contract";

export const MLB_P1_M6A2_SCHEMA = "courtedge-p1-m6a2-mlb-market-odds-universe.v1" as const;
export const MLB_P1_M6A2_CONSENSUS_METHOD = "exact_line_median_implied_probability" as const;
export const MLB_P1_M6A2_MAX_QUOTE_AGE_MS = 5 * 60 * 1000;

export const MLB_EXECUTION_BOOK_PRIORITY = [
  "hardrockbet_fl",
] as const;

export const MLB_REFERENCE_BOOKS = ["draftkings", "fanduel", "betmgm"] as const;

export const MLB_P1_M6A2_PROVIDER_MARKETS = [
  "h2h",
  "spreads",
  "totals",
  "team_totals",
  "h2h_1st_5_innings",
  "spreads_1st_5_innings",
  "totals_1st_5_innings",
  "h2h_1st_3_innings",
  "spreads_1st_3_innings",
  "totals_1st_3_innings",
  "h2h_1st_1_innings",
  "totals_1st_1_innings",
  "h2h_3_way_1st_1_innings",
  "h2h_3_way_1st_3_innings",
  "h2h_3_way_1st_5_innings",
] as const;

export type MlbQuoteFreshness = "FRESH" | "STALE" | "UNKNOWN";
export type MlbQuoteSourceStatus = "FRESH" | "STALE" | "UNKNOWN" | "INVALID" | "MISSING";
export type MlbMarketAvailability =
  | "EXECUTABLE"
  | "REFERENCE_ONLY"
  | "STALE_ONLY"
  | "CONTRACT_MISMATCH"
  | "INVALID_PRICE_OR_STRUCTURE"
  | "UNAVAILABLE_FROM_PROVIDER";

export type MlbMarketVariant = "HOME" | "AWAY" | "NRFI" | "YRFI" | null;
export type MlbSelectionSide = "HOME" | "AWAY" | "OVER" | "UNDER" | "NRFI" | "YRFI";

export interface MlbNormalizedSelectionPrice {
  side: MlbSelectionSide;
  selection: string;
  line: number | null;
  oddsAmerican: number;
}

export interface MlbNormalizedBookQuote {
  bookKey: string;
  bookTitle: string;
  providerMarketKey: string;
  providerLastUpdate: string | null;
  capturedAt: string;
  freshness: MlbQuoteFreshness;
  ageMs: number | null;
  selections: [MlbNormalizedSelectionPrice, MlbNormalizedSelectionPrice];
}

export interface MlbReferenceConsensusQuote {
  bookKey: "reference_consensus";
  bookTitle: "Reference consensus";
  providerMarketKey: string;
  providerLastUpdate: string | null;
  capturedAt: string;
  freshness: MlbQuoteFreshness;
  ageMs: number | null;
  selections: [MlbNormalizedSelectionPrice, MlbNormalizedSelectionPrice];
  contributingBooks: string[];
  n: number;
  consensusMethod: typeof MLB_P1_M6A2_CONSENSUS_METHOD;
}

export interface MlbMarketQuoteSourceState<TQuote> {
  status: MlbQuoteSourceStatus;
  quote: TQuote | null;
  presentBooks: string[];
  invalidBooks: string[];
}

export interface MlbCanonicalMarketAvailability {
  canonicalKey: string;
  marketType: MlbMarketType;
  variant: MlbMarketVariant;
  period: ReturnType<typeof getMlbMarketContract>["period"];
  family: ReturnType<typeof getMlbMarketContract>["family"];
  expectedQuoteContract: MlbQuoteContract;
  providerMarketKey: string | null;
  providerSupport: "DOCUMENTED" | "NOT_DOCUMENTED";
  availability: MlbMarketAvailability;
  execution: MlbMarketQuoteSourceState<MlbNormalizedBookQuote>;
  reference: MlbMarketQuoteSourceState<MlbReferenceConsensusQuote>;
  alternateContractBooks: string[];
  blockers: string[];
}

export interface MlbMarketOddsUniverseGame {
  schemaVersion: typeof MLB_P1_M6A2_SCHEMA;
  eventId: string | null;
  gameKey: string;
  homeTeam: string;
  awayTeam: string;
  commence: string;
  capturedAt: string;
  maxQuoteAgeMs: number;
  markets: MlbCanonicalMarketAvailability[];
  safety: {
    readOnly: true;
    ledgerWrites: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

type PairCollection = {
  quotes: MlbNormalizedBookQuote[];
  presentBooks: string[];
  invalidBooks: string[];
};

type PairBuilder = (
  book: any,
  market: any,
  context: BuildContext,
) => [MlbNormalizedSelectionPrice, MlbNormalizedSelectionPrice] | null;

type BuildContext = {
  homeTeam: string;
  awayTeam: string;
  capturedAt: string;
  maxQuoteAgeMs: number;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function quoteFreshness(
  providerLastUpdate: string | null,
  capturedAt: string,
  maxQuoteAgeMs: number,
): { freshness: MlbQuoteFreshness; ageMs: number | null } {
  const capturedMs = Date.parse(capturedAt);
  const updatedMs = providerLastUpdate == null ? Number.NaN : Date.parse(providerLastUpdate);
  if (!Number.isFinite(capturedMs) || !Number.isFinite(updatedMs)) {
    return { freshness: "UNKNOWN", ageMs: null };
  }
  const signedAge = capturedMs - updatedMs;
  if (signedAge < -120_000) {
    return { freshness: "UNKNOWN", ageMs: null };
  }
  const ageMs = Math.max(0, signedAge);
  return {
    freshness: ageMs <= maxQuoteAgeMs ? "FRESH" : "STALE",
    ageMs,
  };
}

function providerLastUpdate(book: any, market: any): string | null {
  return isoOrNull(market?.last_update) ?? isoOrNull(book?.last_update);
}

function normalizedPrice(value: unknown): number | null {
  return normalizeStandardAmericanOdds(value);
}

function teamPair(
  book: any,
  market: any,
  context: BuildContext,
): [MlbNormalizedSelectionPrice, MlbNormalizedSelectionPrice] | null {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  const home = outcomes.find((outcome: any) => outcome?.name === context.homeTeam);
  const away = outcomes.find((outcome: any) => outcome?.name === context.awayTeam);
  const otherPriced = outcomes.filter((outcome: any) =>
    outcome !== home && outcome !== away && isStandardAmericanOdds(outcome?.price));
  const homePrice = normalizedPrice(home?.price);
  const awayPrice = normalizedPrice(away?.price);
  if (homePrice == null || awayPrice == null || otherPriced.length > 0) return null;
  return [
    { side: "HOME", selection: context.homeTeam, line: null, oddsAmerican: homePrice },
    { side: "AWAY", selection: context.awayTeam, line: null, oddsAmerican: awayPrice },
  ];
}

function spreadPair(
  book: any,
  market: any,
  context: BuildContext,
): [MlbNormalizedSelectionPrice, MlbNormalizedSelectionPrice] | null {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  const home = outcomes.find((outcome: any) => outcome?.name === context.homeTeam);
  const away = outcomes.find((outcome: any) => outcome?.name === context.awayTeam);
  const homePrice = normalizedPrice(home?.price);
  const awayPrice = normalizedPrice(away?.price);
  const homeLine = finite(home?.point);
  const awayLine = finite(away?.point);
  if (
    homePrice == null
    || awayPrice == null
    || homeLine == null
    || awayLine == null
    || Math.abs(homeLine + awayLine) > 1e-9
  ) return null;
  return [
    { side: "HOME", selection: context.homeTeam, line: homeLine, oddsAmerican: homePrice },
    { side: "AWAY", selection: context.awayTeam, line: awayLine, oddsAmerican: awayPrice },
  ];
}

function totalPair(
  _book: any,
  market: any,
  _context: BuildContext,
): [MlbNormalizedSelectionPrice, MlbNormalizedSelectionPrice] | null {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  const over = outcomes.find((outcome: any) => String(outcome?.name ?? "").toLowerCase() === "over");
  const under = outcomes.find((outcome: any) => String(outcome?.name ?? "").toLowerCase() === "under");
  const overPrice = normalizedPrice(over?.price);
  const underPrice = normalizedPrice(under?.price);
  const overLine = finite(over?.point);
  const underLine = finite(under?.point);
  if (
    overPrice == null
    || underPrice == null
    || overLine == null
    || underLine == null
    || Math.abs(overLine - underLine) > 1e-9
  ) return null;
  return [
    { side: "OVER", selection: "Over", line: overLine, oddsAmerican: overPrice },
    { side: "UNDER", selection: "Under", line: underLine, oddsAmerican: underPrice },
  ];
}

function teamTotalPair(team: "HOME" | "AWAY"): PairBuilder {
  return (_book, market, context) => {
    const teamName = team === "HOME" ? context.homeTeam : context.awayTeam;
    const outcomes = (Array.isArray(market?.outcomes) ? market.outcomes : [])
      .filter((outcome: any) => String(outcome?.description ?? "").trim() === teamName);
    const over = outcomes.find((outcome: any) => String(outcome?.name ?? "").toLowerCase() === "over");
    const under = outcomes.find((outcome: any) => String(outcome?.name ?? "").toLowerCase() === "under");
    const overPrice = normalizedPrice(over?.price);
    const underPrice = normalizedPrice(under?.price);
    const overLine = finite(over?.point);
    const underLine = finite(under?.point);
    if (
      overPrice == null
      || underPrice == null
      || overLine == null
      || underLine == null
      || Math.abs(overLine - underLine) > 1e-9
    ) return null;
    return [
      { side: "OVER", selection: `${teamName} Over`, line: overLine, oddsAmerican: overPrice },
      { side: "UNDER", selection: `${teamName} Under`, line: underLine, oddsAmerican: underPrice },
    ];
  };
}

function exactFirstInningTotalHalfPair(
  book: any,
  market: any,
  context: BuildContext,
): [MlbNormalizedSelectionPrice, MlbNormalizedSelectionPrice] | null {
  const pair = totalPair(book, market, context);
  if (!pair || pair[0].line !== 0.5 || pair[1].line !== 0.5) return null;
  return pair;
}

function collectPairs(
  providerEvent: any,
  providerMarketKey: string,
  builder: PairBuilder,
  context: BuildContext,
): PairCollection {
  const quotes: MlbNormalizedBookQuote[] = [];
  const presentBooks = new Set<string>();
  const invalidBooks = new Set<string>();
  for (const book of Array.isArray(providerEvent?.bookmakers) ? providerEvent.bookmakers : []) {
    const bookKey = String(book?.key ?? "").trim();
    if (!bookKey) continue;
    const market = (Array.isArray(book?.markets) ? book.markets : [])
      .find((entry: any) => entry?.key === providerMarketKey);
    if (!market) continue;
    presentBooks.add(bookKey);
    const selections = builder(book, market, context);
    if (!selections) {
      invalidBooks.add(bookKey);
      continue;
    }
    const lastUpdate = providerLastUpdate(book, market);
    const freshness = quoteFreshness(lastUpdate, context.capturedAt, context.maxQuoteAgeMs);
    quotes.push({
      bookKey,
      bookTitle: String(book?.title ?? bookKey),
      providerMarketKey,
      providerLastUpdate: lastUpdate,
      capturedAt: context.capturedAt,
      freshness: freshness.freshness,
      ageMs: freshness.ageMs,
      selections,
    });
  }
  return {
    quotes,
    presentBooks: [...presentBooks].sort(),
    invalidBooks: [...invalidBooks].sort(),
  };
}

function newest(values: Array<string | null>): string | null {
  return values
    .filter((value): value is string => value != null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function lineIdentity(quote: MlbNormalizedBookQuote): string {
  return quote.selections.map((selection) => selection.line == null ? "null" : selection.line.toString()).join("|");
}

function selectedExactLineQuotes(quotes: MlbNormalizedBookQuote[]): MlbNormalizedBookQuote[] {
  if (!quotes.length) return [];
  const groups = new Map<string, MlbNormalizedBookQuote[]>();
  for (const quote of quotes) {
    const key = lineIdentity(quote);
    groups.set(key, [...(groups.get(key) ?? []), quote]);
  }
  const medianLine = medianFinite(quotes.map((quote) => quote.selections[0].line).filter((line) => line != null)) ?? 0;
  return [...groups.values()].sort((left, right) => {
    const leftLine = left[0]?.selections[0].line ?? 0;
    const rightLine = right[0]?.selections[0].line ?? 0;
    return right.length - left.length
      || Math.abs(leftLine - medianLine) - Math.abs(rightLine - medianLine)
      || leftLine - rightLine;
  })[0] ?? [];
}

function referenceConsensus(
  quotes: MlbNormalizedBookQuote[],
  capturedAt: string,
): MlbReferenceConsensusQuote | null {
  const selected = selectedExactLineQuotes(quotes);
  if (!selected.length) return null;
  const first = selected[0];
  const firstPrice = consensusAmericanOdds(selected.map((quote) => quote.selections[0].oddsAmerican));
  const secondPrice = consensusAmericanOdds(selected.map((quote) => quote.selections[1].oddsAmerican));
  if (firstPrice == null || secondPrice == null) return null;
  const lastUpdate = newest(selected.map((quote) => quote.providerLastUpdate));
  const age = quoteFreshness(lastUpdate, capturedAt, MLB_P1_M6A2_MAX_QUOTE_AGE_MS);
  return {
    bookKey: "reference_consensus",
    bookTitle: "Reference consensus",
    providerMarketKey: first.providerMarketKey,
    providerLastUpdate: lastUpdate,
    capturedAt,
    freshness: age.freshness,
    ageMs: age.ageMs,
    selections: [
      { ...first.selections[0], oddsAmerican: firstPrice },
      { ...first.selections[1], oddsAmerican: secondPrice },
    ],
    contributingBooks: selected.map((quote) => quote.bookKey).sort(),
    n: selected.length,
    consensusMethod: MLB_P1_M6A2_CONSENSUS_METHOD,
  };
}

function sourceInvalidBooks(collection: PairCollection, books: readonly string[]): string[] {
  return collection.invalidBooks.filter((key) => books.includes(key));
}

function sourcePresentBooks(collection: PairCollection, books: readonly string[]): string[] {
  return collection.presentBooks.filter((key) => books.includes(key));
}

function executionState(collection: PairCollection): MlbMarketQuoteSourceState<MlbNormalizedBookQuote> {
  const candidateQuotes = collection.quotes
    .filter((quote) => MLB_EXECUTION_BOOK_PRIORITY.includes(quote.bookKey as any))
    .sort((left, right) =>
      MLB_EXECUTION_BOOK_PRIORITY.indexOf(left.bookKey as any) - MLB_EXECUTION_BOOK_PRIORITY.indexOf(right.bookKey as any));
  const fresh = candidateQuotes.find((quote) => quote.freshness === "FRESH");
  const stale = candidateQuotes.find((quote) => quote.freshness === "STALE");
  const unknown = candidateQuotes.find((quote) => quote.freshness === "UNKNOWN");
  const invalidBooks = sourceInvalidBooks(collection, MLB_EXECUTION_BOOK_PRIORITY);
  const presentBooks = sourcePresentBooks(collection, MLB_EXECUTION_BOOK_PRIORITY);
  if (fresh) return { status: "FRESH", quote: fresh, presentBooks, invalidBooks };
  if (stale) return { status: "STALE", quote: stale, presentBooks, invalidBooks };
  if (unknown) return { status: "UNKNOWN", quote: unknown, presentBooks, invalidBooks };
  if (invalidBooks.length) return { status: "INVALID", quote: null, presentBooks, invalidBooks };
  return { status: "MISSING", quote: null, presentBooks, invalidBooks };
}

function referenceState(
  collection: PairCollection,
  capturedAt: string,
): MlbMarketQuoteSourceState<MlbReferenceConsensusQuote> {
  const all = collection.quotes.filter((quote) => MLB_REFERENCE_BOOKS.includes(quote.bookKey as any));
  const fresh = all.filter((quote) => quote.freshness === "FRESH");
  const stale = all.filter((quote) => quote.freshness === "STALE");
  const unknown = all.filter((quote) => quote.freshness === "UNKNOWN");
  const invalidBooks = sourceInvalidBooks(collection, MLB_REFERENCE_BOOKS);
  const presentBooks = sourcePresentBooks(collection, MLB_REFERENCE_BOOKS);
  const freshQuote = referenceConsensus(fresh, capturedAt);
  if (freshQuote) return { status: "FRESH", quote: freshQuote, presentBooks, invalidBooks };
  const staleQuote = referenceConsensus(stale, capturedAt);
  if (staleQuote) return { status: "STALE", quote: staleQuote, presentBooks, invalidBooks };
  const unknownQuote = referenceConsensus(unknown, capturedAt);
  if (unknownQuote) return { status: "UNKNOWN", quote: unknownQuote, presentBooks, invalidBooks };
  if (invalidBooks.length) return { status: "INVALID", quote: null, presentBooks, invalidBooks };
  return { status: "MISSING", quote: null, presentBooks, invalidBooks };
}

function booksWithMarket(providerEvent: any, key: string): string[] {
  return (Array.isArray(providerEvent?.bookmakers) ? providerEvent.bookmakers : [])
    .filter((book: any) => (Array.isArray(book?.markets) ? book.markets : []).some((market: any) => market?.key === key))
    .map((book: any) => String(book?.key ?? ""))
    .filter(Boolean)
    .sort();
}

function unavailableMarket(
  marketType: MlbMarketType,
  variant: MlbMarketVariant,
  blocker: string,
): MlbCanonicalMarketAvailability {
  const contract = getMlbMarketContract(marketType);
  return {
    canonicalKey: `${marketType}:${variant ?? "DEFAULT"}`,
    marketType,
    variant,
    period: contract.period,
    family: contract.family,
    expectedQuoteContract: contract.quoteContract,
    providerMarketKey: null,
    providerSupport: "NOT_DOCUMENTED",
    availability: "UNAVAILABLE_FROM_PROVIDER",
    execution: { status: "MISSING", quote: null, presentBooks: [], invalidBooks: [] },
    reference: { status: "MISSING", quote: null, presentBooks: [], invalidBooks: [] },
    alternateContractBooks: [],
    blockers: [blocker],
  };
}

function canonicalMarket(input: {
  providerEvent: any;
  context: BuildContext;
  marketType: MlbMarketType;
  variant?: MlbMarketVariant;
  providerMarketKey: string;
  builder: PairBuilder;
  alternateContractKey?: string;
  contractMismatchWhenPresentButNoValidPair?: boolean;
}): MlbCanonicalMarketAvailability {
  const variant = input.variant ?? null;
  const contract = getMlbMarketContract(input.marketType);
  const collection = collectPairs(input.providerEvent, input.providerMarketKey, input.builder, input.context);
  const execution = executionState(collection);
  const reference = referenceState(collection, input.context.capturedAt);
  const alternateContractBooks = input.alternateContractKey
    ? booksWithMarket(input.providerEvent, input.alternateContractKey)
    : [];
  let availability: MlbMarketAvailability;
  const blockers: string[] = [];

  if (execution.status === "FRESH") {
    availability = "EXECUTABLE";
  } else if (reference.status === "FRESH") {
    availability = "REFERENCE_ONLY";
    blockers.push("FRESH_EXECUTION_BOOK_QUOTE_REQUIRED");
  } else if (
    alternateContractBooks.length > 0
    || (input.contractMismatchWhenPresentButNoValidPair && collection.presentBooks.length > 0 && collection.quotes.length === 0)
  ) {
    availability = "CONTRACT_MISMATCH";
    blockers.push("QUOTE_CONTRACT_MISMATCH");
  } else if (execution.status === "INVALID" || reference.status === "INVALID") {
    availability = "INVALID_PRICE_OR_STRUCTURE";
    blockers.push("VALID_PAIRED_AMERICAN_ODDS_REQUIRED");
  } else if (
    execution.status === "STALE"
    || reference.status === "STALE"
    || execution.status === "UNKNOWN"
    || reference.status === "UNKNOWN"
  ) {
    availability = "STALE_ONLY";
    blockers.push("FRESH_QUOTE_REQUIRED");
  } else {
    availability = "UNAVAILABLE_FROM_PROVIDER";
    blockers.push("PROVIDER_MARKET_NOT_AVAILABLE");
  }

  if (execution.status !== "FRESH") blockers.push("NOT_EXECUTABLE_AT_CURRENT_HARD_ROCK_PRICE");
  if (alternateContractBooks.length) blockers.push("ALTERNATE_THREE_WAY_CONTRACT_PRESENT");

  return {
    canonicalKey: `${input.marketType}:${variant ?? "DEFAULT"}`,
    marketType: input.marketType,
    variant,
    period: contract.period,
    family: contract.family,
    expectedQuoteContract: contract.quoteContract,
    providerMarketKey: input.providerMarketKey,
    providerSupport: "DOCUMENTED",
    availability,
    execution,
    reference,
    alternateContractBooks,
    blockers: [...new Set(blockers)],
  };
}

function transformFirstInningRuns(
  market: MlbCanonicalMarketAvailability,
  selected: "NRFI" | "YRFI",
): MlbCanonicalMarketAvailability {
  const transformBookQuote = (quote: MlbNormalizedBookQuote | null): MlbNormalizedBookQuote | null => {
    if (!quote) return null;
    const over = quote.selections.find((entry) => entry.side === "OVER");
    const under = quote.selections.find((entry) => entry.side === "UNDER");
    if (!over || !under) return null;
    const nrfi = { ...under, side: "NRFI" as const, selection: "NRFI" };
    const yrfi = { ...over, side: "YRFI" as const, selection: "YRFI" };
    return { ...quote, selections: selected === "NRFI" ? [nrfi, yrfi] : [yrfi, nrfi] };
  };
  const transformReferenceQuote = (quote: MlbReferenceConsensusQuote | null): MlbReferenceConsensusQuote | null => {
    if (!quote) return null;
    const transformed = transformBookQuote(quote as unknown as MlbNormalizedBookQuote);
    return transformed ? { ...quote, selections: transformed.selections } : null;
  };
  const contract = getMlbMarketContract(selected);
  return {
    ...market,
    canonicalKey: `${selected}:${selected}`,
    marketType: selected,
    variant: selected,
    period: contract.period,
    family: contract.family,
    expectedQuoteContract: contract.quoteContract,
    execution: { ...market.execution, quote: transformBookQuote(market.execution.quote) },
    reference: { ...market.reference, quote: transformReferenceQuote(market.reference.quote) },
  };
}

export function buildMlbMarketOddsUniverseGame(
  providerEvent: any,
  capturedAtInput?: string,
  maxQuoteAgeMs = MLB_P1_M6A2_MAX_QUOTE_AGE_MS,
): MlbMarketOddsUniverseGame {
  const capturedAt = isoOrNull(capturedAtInput) ?? new Date().toISOString();
  const homeTeam = String(providerEvent?.home_team ?? "").trim();
  const awayTeam = String(providerEvent?.away_team ?? "").trim();
  const commence = String(providerEvent?.commence_time ?? "").trim();
  const context: BuildContext = {
    homeTeam,
    awayTeam,
    capturedAt,
    maxQuoteAgeMs,
  };

  const firstInningHalf = canonicalMarket({
    providerEvent,
    context,
    marketType: "TOTAL",
    providerMarketKey: "totals_1st_1_innings",
    builder: exactFirstInningTotalHalfPair,
    contractMismatchWhenPresentButNoValidPair: true,
  });

  const markets: MlbCanonicalMarketAvailability[] = [
    canonicalMarket({ providerEvent, context, marketType: "ML", providerMarketKey: "h2h", builder: teamPair }),
    canonicalMarket({ providerEvent, context, marketType: "RUN_LINE", providerMarketKey: "spreads", builder: spreadPair }),
    canonicalMarket({ providerEvent, context, marketType: "TOTAL", providerMarketKey: "totals", builder: totalPair }),
    canonicalMarket({ providerEvent, context, marketType: "TEAM_TOTAL", variant: "HOME", providerMarketKey: "team_totals", builder: teamTotalPair("HOME") }),
    canonicalMarket({ providerEvent, context, marketType: "TEAM_TOTAL", variant: "AWAY", providerMarketKey: "team_totals", builder: teamTotalPair("AWAY") }),

    canonicalMarket({ providerEvent, context, marketType: "F5_ML", providerMarketKey: "h2h_1st_5_innings", builder: teamPair, alternateContractKey: "h2h_3_way_1st_5_innings" }),
    canonicalMarket({ providerEvent, context, marketType: "F5_RUN_LINE", providerMarketKey: "spreads_1st_5_innings", builder: spreadPair }),
    canonicalMarket({ providerEvent, context, marketType: "F5_TOTAL", providerMarketKey: "totals_1st_5_innings", builder: totalPair }),
    unavailableMarket("F5_TEAM_TOTAL", "HOME", "F5_TEAM_TOTAL_NOT_DOCUMENTED_BY_PROVIDER"),
    unavailableMarket("F5_TEAM_TOTAL", "AWAY", "F5_TEAM_TOTAL_NOT_DOCUMENTED_BY_PROVIDER"),

    canonicalMarket({ providerEvent, context, marketType: "F3_ML", providerMarketKey: "h2h_1st_3_innings", builder: teamPair, alternateContractKey: "h2h_3_way_1st_3_innings" }),
    canonicalMarket({ providerEvent, context, marketType: "F3_RUN_LINE", providerMarketKey: "spreads_1st_3_innings", builder: spreadPair }),
    canonicalMarket({ providerEvent, context, marketType: "F3_TOTAL", providerMarketKey: "totals_1st_3_innings", builder: totalPair }),
    unavailableMarket("F3_TEAM_TOTAL", "HOME", "F3_TEAM_TOTAL_NOT_DOCUMENTED_BY_PROVIDER"),
    unavailableMarket("F3_TEAM_TOTAL", "AWAY", "F3_TEAM_TOTAL_NOT_DOCUMENTED_BY_PROVIDER"),

    canonicalMarket({ providerEvent, context, marketType: "INNING_1_ML", providerMarketKey: "h2h_1st_1_innings", builder: teamPair, alternateContractKey: "h2h_3_way_1st_1_innings" }),
    transformFirstInningRuns(firstInningHalf, "NRFI"),
    transformFirstInningRuns(firstInningHalf, "YRFI"),
  ];

  return {
    schemaVersion: MLB_P1_M6A2_SCHEMA,
    eventId: String(providerEvent?.id ?? "").trim() || null,
    gameKey: `${awayTeam}@${homeTeam}@${commence}`,
    homeTeam,
    awayTeam,
    commence,
    capturedAt,
    maxQuoteAgeMs,
    markets,
    safety: {
      readOnly: true,
      ledgerWrites: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}
