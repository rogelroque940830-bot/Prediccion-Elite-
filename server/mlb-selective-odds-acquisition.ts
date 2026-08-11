import { createHash } from "node:crypto";
import type {
  MlbMarketDiscoveryGamePlan,
  MlbMarketDiscoveryPlannedMarket,
  MlbMarketDiscoveryResult,
} from "./mlb-market-discovery";
import {
  MLB_EXECUTION_BOOK_PRIORITY,
  MLB_P1_M6A2_MAX_QUOTE_AGE_MS,
  MLB_REFERENCE_BOOKS,
  buildMlbMarketOddsUniverseGame,
  type MlbCanonicalMarketAvailability,
} from "./mlb-market-odds-normalizer";
import {
  MlbOddsRunBudgetController,
  type MlbOddsBudgetDenialCode,
  type MlbOddsBudgetSnapshot,
} from "./mlb-odds-budget-controller";
import { MLB_SHORTLIST_MAX_CANDIDATES } from "./mlb-shortlist";
import { FL_TZ } from "./route-runtime";

export const MLB_SELECTIVE_ODDS_ACQUISITION_SCHEMA = "courtedge-p0-mlb-selective-odds-acquisition.v1" as const;
export const MLB_SELECTIVE_ODDS_CACHE_TTL_MS = MLB_P1_M6A2_MAX_QUOTE_AGE_MS;

export const MLB_SELECTIVE_ODDS_BOOKMAKERS = [
  ...MLB_EXECUTION_BOOK_PRIORITY,
  ...MLB_REFERENCE_BOOKS,
] as const;

export type MlbSelectiveOddsRunStatus =
  | "NO_PAID_WORK"
  | "COMPLETED"
  | "PARTIAL"
  | "BLOCKED";

export type MlbSelectiveOddsGameStatus =
  | "HELD_BY_DISCOVERY"
  | "CACHE_HIT"
  | "FETCHED"
  | "EVENT_NOT_FOUND"
  | "EVENT_MATCH_AMBIGUOUS"
  | "BUDGET_DENIED"
  | "PROVIDER_FAILED"
  | "PROVIDER_ACCOUNTING_BLOCKED"
  | "NOT_REACHED_AFTER_BLOCK";

export type MlbSelectiveOddsEventMatchStatus =
  | "NOT_ATTEMPTED"
  | "MATCHED"
  | "NOT_FOUND"
  | "AMBIGUOUS";

export type MlbSelectiveOddsStopReason =
  | "ODDS_API_KEY_REQUIRED"
  | "ZERO_COST_EVENTS_PROBE_FAILED"
  | "ZERO_COST_EVENTS_PROBE_PAYLOAD_INVALID"
  | "QUOTA_PROBE_BLOCKED"
  | "RUN_BUDGET_DENIED_AT_HIGHER_RANK"
  | "PAID_PROVIDER_REQUEST_FAILED"
  | "PAID_PROVIDER_PAYLOAD_INVALID"
  | "PAID_PROVIDER_IDENTITY_MISMATCH"
  | "PROVIDER_ACCOUNTING_BLOCKED";

export interface MlbSelectiveOddsMarketThesis {
  providerMarketKey: string;
  canonicalMarketType: MlbMarketDiscoveryPlannedMarket["canonicalMarketType"];
  intrinsicProjectionScope: MlbMarketDiscoveryPlannedMarket["intrinsicProjectionScope"];
  thesisIntent: MlbMarketDiscoveryPlannedMarket["thesisIntent"];
  intrinsicThesisKinds: readonly MlbMarketDiscoveryPlannedMarket["intrinsicThesisKinds"][number][];
  supportingComponents: readonly MlbMarketDiscoveryPlannedMarket["supportingComponents"][number][];
}

export interface MlbSelectiveOddsGameResult {
  gamePk: number;
  intrinsicRank: number;
  homeTeam: MlbMarketDiscoveryGamePlan["homeTeam"];
  awayTeam: MlbMarketDiscoveryGamePlan["awayTeam"];
  officialDate: string;
  startTime: string | null;
  inputStage: MlbMarketDiscoveryGamePlan["inputStage"];
  status: MlbSelectiveOddsGameStatus;
  holdReason: MlbMarketDiscoveryGamePlan["paidLookupHoldReason"];
  eventMatchStatus: MlbSelectiveOddsEventMatchStatus;
  providerEventId: string | null;
  requestedMarketKeys: readonly string[];
  cacheHitMarketKeys: readonly string[];
  paidMarketKeysRequested: readonly string[];
  marketTheses: readonly MlbSelectiveOddsMarketThesis[];
  quoteMarkets: readonly MlbCanonicalMarketAvailability[];
  budgetDenialCode: MlbOddsBudgetDenialCode | null;
  providerErrorCode: string | null;
  usableForMarketEdge: boolean;
}

export interface MlbSelectiveOddsAcquisitionResult {
  schemaVersion: typeof MLB_SELECTIVE_ODDS_ACQUISITION_SCHEMA;
  generatedAt: string;
  runId: string;
  date: string;
  sourceMarketDiscoverySchemaVersion: MlbMarketDiscoveryResult["schemaVersion"];
  status: MlbSelectiveOddsRunStatus;
  stopReason: MlbSelectiveOddsStopReason | null;
  games: readonly MlbSelectiveOddsGameResult[];
  budget: MlbOddsBudgetSnapshot | null;
  providerCalls: {
    zeroCostEventsProbe: number;
    paidEventOdds: number;
    eventMarkets: 0;
    sportOdds: 0;
  };
  summary: {
    discoveryGames: number;
    paidLookupEligibleGames: number;
    fetchedGames: number;
    cacheOnlyGames: number;
    unresolvedEventGames: number;
    heldGames: number;
    blockedGames: number;
    requestedPaidMarketKeys: number;
    reusedFreshMarketKeys: number;
    usableMarketQuotes: number;
  };
  policy: {
    explicitInvocationRequired: true;
    publicRouteRegistered: false;
    backgroundPolling: false;
    timers: false;
    finalistGamesOnly: true;
    exactDiscoveryMarketKeysOnly: true;
    onePaidRequestPerGameMaximum: true;
    paidRequestsSequentialByIntrinsicRank: true;
    lowerRankCannotBypassBudgetDeniedHigherRank: true;
    eventMarketsDiscoveryCalls: 0;
    sportOddsCalls: 0;
    executionAndReferenceBooksShareOneRequest: true;
    providerBookmakerCount: typeof MLB_SELECTIVE_ODDS_BOOKMAKERS.length;
    cacheTtlMs: typeof MLB_SELECTIVE_ODDS_CACHE_TTL_MS;
    cacheTtlIsRefreshPolicyNotPolling: true;
    negativeMarketAvailabilityCachedWithinTtl: true;
    sameRunIdReplayConsumesPaidCredits: false;
    runIdPlanMutationAllowed: false;
    staleOrMissingExecutionQuoteCanBeRecommended: false;
    calculatesMarketEdge: false;
    recommendsBet: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
  safety: MlbMarketDiscoveryResult["safety"];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ServiceOptions = {
  fetchFn?: FetchLike;
  now?: () => Date;
  cacheTtlMs?: number;
};

type ProviderEventCacheEntry = {
  eventId: string;
  providerEvent: any;
  marketFetchedAtMs: Map<string, number>;
};

type RunMemoEntry = {
  fingerprint: string;
  result: MlbSelectiveOddsAcquisitionResult;
};

type RunInFlightEntry = {
  fingerprint: string;
  promise: Promise<MlbSelectiveOddsAcquisitionResult>;
};

type EventMatchResult =
  | { status: "MATCHED"; event: any; eventId: string }
  | { status: "NOT_FOUND" | "AMBIGUOUS"; event: null; eventId: null };

export class MlbSelectiveOddsPlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MlbSelectiveOddsPlanError";
    this.code = code;
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertValidDiscoveryPlan(discovery: MlbMarketDiscoveryResult): void {
  if (discovery.games.length > MLB_SHORTLIST_MAX_CANDIDATES) {
    throw new MlbSelectiveOddsPlanError(
      "DISCOVERY_GAME_CAP_EXCEEDED",
      `market discovery produced ${discovery.games.length} games; hard maximum is ${MLB_SHORTLIST_MAX_CANDIDATES}`,
    );
  }
  const seenGamePks = new Set<number>();
  const seenRanks = new Set<number>();
  let previousRank = 0;
  for (const game of discovery.games) {
    if (!Number.isInteger(game.gamePk) || game.gamePk <= 0 || seenGamePks.has(game.gamePk)) {
      throw new MlbSelectiveOddsPlanError("INVALID_OR_DUPLICATE_GAME_PK", `invalid or duplicate gamePk ${game.gamePk}`);
    }
    seenGamePks.add(game.gamePk);
    if (!Number.isInteger(game.intrinsicRank) || game.intrinsicRank <= 0 || seenRanks.has(game.intrinsicRank)) {
      throw new MlbSelectiveOddsPlanError("INVALID_OR_DUPLICATE_INTRINSIC_RANK", `invalid or duplicate intrinsic rank ${game.intrinsicRank}`);
    }
    if (game.intrinsicRank <= previousRank) {
      throw new MlbSelectiveOddsPlanError("INTRINSIC_RANK_ORDER_INVALID", "discovery games must already be ordered by ascending intrinsic rank");
    }
    seenRanks.add(game.intrinsicRank);
    previousRank = game.intrinsicRank;

    const plannedKeysFromMarkets = game.plannedMarkets.map((market) => market.providerMarketKey);
    if (!sameStringSet(plannedKeysFromMarkets, game.plannedProviderMarketKeys)) {
      throw new MlbSelectiveOddsPlanError(
        "PLANNED_MARKET_KEY_MISMATCH",
        `game ${game.gamePk} planned market objects and planned provider keys disagree`,
      );
    }
    if (game.providerMarketKeysToRequestNow.length > 0) {
      if (!game.paidLookupEligibleNow || game.inputStage !== "FINAL" || game.paidLookupHoldReason != null) {
        throw new MlbSelectiveOddsPlanError(
          "PAID_LOOKUP_AUTHORIZATION_INVALID",
          `game ${game.gamePk} exposes paid keys without FINAL discovery authorization`,
        );
      }
      if (!sameStringSet(game.providerMarketKeysToRequestNow, game.plannedProviderMarketKeys)) {
        throw new MlbSelectiveOddsPlanError(
          "PAID_MARKET_KEY_MUTATION",
          `game ${game.gamePk} paid keys must equal the exact discovery plan`,
        );
      }
    } else if (game.paidLookupEligibleNow) {
      throw new MlbSelectiveOddsPlanError(
        "EMPTY_PAID_LOOKUP_PLAN",
        `game ${game.gamePk} is marked paid-eligible with no provider market keys`,
      );
    }
  }
}

function marketThesis(market: MlbMarketDiscoveryPlannedMarket): MlbSelectiveOddsMarketThesis {
  return {
    providerMarketKey: market.providerMarketKey,
    canonicalMarketType: market.canonicalMarketType,
    intrinsicProjectionScope: market.intrinsicProjectionScope,
    thesisIntent: market.thesisIntent,
    intrinsicThesisKinds: [...market.intrinsicThesisKinds],
    supportingComponents: [...market.supportingComponents],
  };
}

function stablePlanFingerprint(input: {
  runId: string;
  discovery: MlbMarketDiscoveryResult;
  maxRunCredits: number;
  reserveCredits: number;
}): string {
  const payload = {
    runId: String(input.runId ?? "").trim(),
    date: input.discovery.date,
    sourceSchema: input.discovery.schemaVersion,
    maxRunCredits: input.maxRunCredits,
    reserveCredits: input.reserveCredits,
    bookmakers: [...MLB_SELECTIVE_ODDS_BOOKMAKERS],
    games: input.discovery.games.map((game) => ({
      gamePk: game.gamePk,
      intrinsicRank: game.intrinsicRank,
      officialDate: game.officialDate,
      startTime: game.startTime,
      homeTeam: game.homeTeam.name,
      awayTeam: game.awayTeam.name,
      inputStage: game.inputStage,
      paidLookupEligibleNow: game.paidLookupEligibleNow,
      holdReason: game.paidLookupHoldReason,
      keys: sortedUnique(game.providerMarketKeysToRequestNow),
      theses: game.plannedMarkets.map((market) => ({
        key: market.providerMarketKey,
        market: market.canonicalMarketType,
        scope: market.intrinsicProjectionScope,
        kinds: [...market.intrinsicThesisKinds].sort(),
      })).sort((left, right) => left.key.localeCompare(right.key)),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildMlbSelectiveEventsProbeUrl(apiKey: string): string {
  const params = new URLSearchParams({ apiKey, dateFormat: "iso" });
  return `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?${params.toString()}`;
}

export function buildMlbSelectiveEventOddsUrl(
  eventId: string,
  apiKey: string,
  marketKeys: readonly string[],
): string {
  const markets = sortedUnique(marketKeys);
  if (!markets.length) throw new MlbSelectiveOddsPlanError("EMPTY_PAID_MARKET_SET", "paid event-odds request requires at least one market key");
  const params = new URLSearchParams({
    apiKey,
    bookmakers: MLB_SELECTIVE_ODDS_BOOKMAKERS.join(","),
    markets: markets.join(","),
    oddsFormat: "american",
    dateFormat: "iso",
  });
  return `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${encodeURIComponent(eventId)}/odds/?${params.toString()}`;
}

export function normalizeMlbProviderTeamName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function providerTeamEquivalent(leftInput: unknown, rightInput: unknown): boolean {
  const left = normalizeMlbProviderTeamName(leftInput);
  const right = normalizeMlbProviderTeamName(rightInput);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.replace(/\s/g, "").length < 5) return false;
  return longer.endsWith(` ${shorter}`);
}

function floridaDateFromIso(value: unknown): string {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return "";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: FL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(parsed)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function matchMlbDiscoveryGameToProviderEvent(
  game: Pick<MlbMarketDiscoveryGamePlan, "officialDate" | "startTime" | "homeTeam" | "awayTeam">,
  providerEvents: readonly any[],
): EventMatchResult {
  const matches = providerEvents.filter((event) => {
    const eventId = String(event?.id ?? "").trim();
    if (!eventId) return false;
    if (floridaDateFromIso(event?.commence_time) !== game.officialDate) return false;
    return providerTeamEquivalent(game.homeTeam.name, event?.home_team)
      && providerTeamEquivalent(game.awayTeam.name, event?.away_team);
  });
  if (matches.length === 0) return { status: "NOT_FOUND", event: null, eventId: null };
  if (matches.length === 1) {
    return { status: "MATCHED", event: matches[0], eventId: String(matches[0].id) };
  }

  const targetMs = Date.parse(String(game.startTime ?? ""));
  if (!Number.isFinite(targetMs)) return { status: "AMBIGUOUS", event: null, eventId: null };
  const ranked = matches
    .map((event) => ({ event, eventId: String(event.id), deltaMs: Math.abs(Date.parse(String(event?.commence_time ?? "")) - targetMs) }))
    .filter((entry) => Number.isFinite(entry.deltaMs))
    .sort((left, right) => left.deltaMs - right.deltaMs || left.eventId.localeCompare(right.eventId));
  if (!ranked.length || (ranked[1] && ranked[0].deltaMs === ranked[1].deltaMs)) {
    return { status: "AMBIGUOUS", event: null, eventId: null };
  }
  return { status: "MATCHED", event: ranked[0].event, eventId: ranked[0].eventId };
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function providerErrorCode(payload: any, fallback: string): string {
  return String(payload?.error_code ?? payload?.code ?? fallback).trim() || fallback;
}

function mergeProviderEvent(
  existing: any | null,
  incoming: any,
  fetchedMarketKeys: readonly string[],
): any {
  const fetched = new Set(sortedUnique(fetchedMarketKeys));
  const existingBooks = new Map<string, any>();
  for (const book of Array.isArray(existing?.bookmakers) ? existing.bookmakers : []) {
    const key = String(book?.key ?? "").trim();
    if (key) existingBooks.set(key, book);
  }
  const incomingBooks = new Map<string, any>();
  for (const book of Array.isArray(incoming?.bookmakers) ? incoming.bookmakers : []) {
    const key = String(book?.key ?? "").trim();
    if (key) incomingBooks.set(key, book);
  }
  const bookKeys = sortedUnique([...existingBooks.keys(), ...incomingBooks.keys()]);
  const bookmakers = bookKeys.map((bookKey) => {
    const oldBook = existingBooks.get(bookKey) ?? {};
    const newBook = incomingBooks.get(bookKey) ?? {};
    const preserved = (Array.isArray(oldBook?.markets) ? oldBook.markets : [])
      .filter((market: any) => !fetched.has(String(market?.key ?? "")));
    const replacement = (Array.isArray(newBook?.markets) ? newBook.markets : [])
      .filter((market: any) => fetched.has(String(market?.key ?? "")));
    return {
      ...oldBook,
      ...newBook,
      key: bookKey,
      markets: [...preserved, ...replacement],
    };
  });
  return {
    ...(existing ?? {}),
    ...incoming,
    bookmakers,
  };
}

function gameResultBase(game: MlbMarketDiscoveryGamePlan): Omit<MlbSelectiveOddsGameResult,
  "status" | "eventMatchStatus" | "providerEventId" | "cacheHitMarketKeys" | "paidMarketKeysRequested" | "quoteMarkets" | "budgetDenialCode" | "providerErrorCode" | "usableForMarketEdge"
> {
  return {
    gamePk: game.gamePk,
    intrinsicRank: game.intrinsicRank,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    officialDate: game.officialDate,
    startTime: game.startTime,
    inputStage: game.inputStage,
    holdReason: game.paidLookupHoldReason,
    requestedMarketKeys: sortedUnique(game.providerMarketKeysToRequestNow),
    marketTheses: game.plannedMarkets.map(marketThesis),
  };
}

function filterNormalizedMarkets(
  game: MlbMarketDiscoveryGamePlan,
  providerEvent: any,
  capturedAt: string,
): MlbCanonicalMarketAvailability[] {
  const requested = new Set(sortedUnique(game.providerMarketKeysToRequestNow));
  const canonicalTypes = new Set(game.plannedMarkets.map((market) => market.canonicalMarketType));
  return buildMlbMarketOddsUniverseGame(providerEvent, capturedAt, MLB_SELECTIVE_ODDS_CACHE_TTL_MS)
    .markets
    .filter((market) => market.providerMarketKey != null
      && requested.has(market.providerMarketKey)
      && canonicalTypes.has(market.marketType as MlbMarketDiscoveryPlannedMarket["canonicalMarketType"]));
}

function usableQuoteCount(markets: readonly MlbCanonicalMarketAvailability[]): number {
  return markets.filter((market) => market.availability === "EXECUTABLE").length;
}

export class MlbSelectiveOddsAcquisitionService {
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly eventCache = new Map<string, ProviderEventCacheEntry>();
  private readonly completedRuns = new Map<string, RunMemoEntry>();
  private readonly inFlightRuns = new Map<string, RunInFlightEntry>();

  constructor(options: ServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? MLB_SELECTIVE_ODDS_CACHE_TTL_MS;
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs <= 0) {
      throw new Error("cacheTtlMs must be a positive finite number");
    }
  }

  acquire(input: {
    runId: string;
    discovery: MlbMarketDiscoveryResult;
    maxRunCredits: number;
    reserveCredits: number;
    apiKey: string;
  }): Promise<MlbSelectiveOddsAcquisitionResult> {
    assertValidDiscoveryPlan(input.discovery);
    const runId = String(input.runId ?? "").trim();
    if (!runId) throw new MlbSelectiveOddsPlanError("RUN_ID_REQUIRED", "runId is required");
    const fingerprint = stablePlanFingerprint({
      runId,
      discovery: input.discovery,
      maxRunCredits: input.maxRunCredits,
      reserveCredits: input.reserveCredits,
    });
    const completed = this.completedRuns.get(runId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new MlbSelectiveOddsPlanError(
          "RUN_ID_REUSED_WITH_DIFFERENT_PLAN",
          `runId ${runId} is already bound to a different immutable acquisition plan`,
        );
      }
      return Promise.resolve(completed.result);
    }
    const inFlight = this.inFlightRuns.get(runId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw new MlbSelectiveOddsPlanError(
          "RUN_ID_REUSED_WITH_DIFFERENT_PLAN",
          `runId ${runId} is already executing a different immutable acquisition plan`,
        );
      }
      return inFlight.promise;
    }

    const promise = this.execute({ ...input, runId })
      .then((result) => {
        this.completedRuns.set(runId, { fingerprint, result });
        return result;
      })
      .finally(() => {
        this.inFlightRuns.delete(runId);
      });
    this.inFlightRuns.set(runId, { fingerprint, promise });
    return promise;
  }

  private async execute(input: {
    runId: string;
    discovery: MlbMarketDiscoveryResult;
    maxRunCredits: number;
    reserveCredits: number;
    apiKey: string;
  }): Promise<MlbSelectiveOddsAcquisitionResult> {
    const generatedAt = this.now().toISOString();
    const eligibleGames = input.discovery.games.filter((game) => game.providerMarketKeysToRequestNow.length > 0);
    const providerCalls = { zeroCostEventsProbe: 0, paidEventOdds: 0, eventMarkets: 0 as const, sportOdds: 0 as const };
    const results = new Map<number, MlbSelectiveOddsGameResult>();

    for (const game of input.discovery.games.filter((entry) => entry.providerMarketKeysToRequestNow.length === 0)) {
      results.set(game.gamePk, {
        ...gameResultBase(game),
        status: "HELD_BY_DISCOVERY",
        eventMatchStatus: "NOT_ATTEMPTED",
        providerEventId: null,
        cacheHitMarketKeys: [],
        paidMarketKeysRequested: [],
        quoteMarkets: [],
        budgetDenialCode: null,
        providerErrorCode: null,
        usableForMarketEdge: false,
      });
    }

    if (eligibleGames.length === 0) {
      return this.finish({
        input,
        generatedAt,
        status: "NO_PAID_WORK",
        stopReason: null,
        results,
        budget: null,
        providerCalls,
      });
    }

    const apiKey = String(input.apiKey ?? "").trim();
    if (!apiKey) {
      for (const game of eligibleGames) {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "NOT_REACHED_AFTER_BLOCK",
          eventMatchStatus: "NOT_ATTEMPTED",
          providerEventId: null,
          cacheHitMarketKeys: [],
          paidMarketKeysRequested: [],
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: "ODDS_API_KEY_REQUIRED",
          usableForMarketEdge: false,
        });
      }
      return this.finish({
        input,
        generatedAt,
        status: "BLOCKED",
        stopReason: "ODDS_API_KEY_REQUIRED",
        results,
        budget: null,
        providerCalls,
      });
    }

    const budget = new MlbOddsRunBudgetController({
      runId: input.runId,
      maxRunCredits: input.maxRunCredits,
      reserveCredits: input.reserveCredits,
    });

    let eventsResponse: Response;
    let providerEvents: any;
    try {
      providerCalls.zeroCostEventsProbe += 1;
      eventsResponse = await this.fetchFn(buildMlbSelectiveEventsProbeUrl(apiKey));
      const budgetAfterProbe = budget.ingestZeroCostProbe(eventsResponse.headers);
      providerEvents = await safeJson(eventsResponse);
      if (!eventsResponse.ok) {
        for (const game of eligibleGames) {
          results.set(game.gamePk, {
            ...gameResultBase(game),
            status: "NOT_REACHED_AFTER_BLOCK",
            eventMatchStatus: "NOT_ATTEMPTED",
            providerEventId: null,
            cacheHitMarketKeys: [],
            paidMarketKeysRequested: [],
            quoteMarkets: [],
            budgetDenialCode: null,
            providerErrorCode: providerErrorCode(providerEvents, `ODDS_EVENTS_HTTP_${eventsResponse.status}`),
            usableForMarketEdge: false,
          });
        }
        return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "ZERO_COST_EVENTS_PROBE_FAILED", results, budget: budgetAfterProbe, providerCalls });
      }
      if (!Array.isArray(providerEvents)) {
        for (const game of eligibleGames) {
          results.set(game.gamePk, {
            ...gameResultBase(game),
            status: "NOT_REACHED_AFTER_BLOCK",
            eventMatchStatus: "NOT_ATTEMPTED",
            providerEventId: null,
            cacheHitMarketKeys: [],
            paidMarketKeysRequested: [],
            quoteMarkets: [],
            budgetDenialCode: null,
            providerErrorCode: "ODDS_EVENTS_PAYLOAD_NOT_ARRAY",
            usableForMarketEdge: false,
          });
        }
        return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "ZERO_COST_EVENTS_PROBE_PAYLOAD_INVALID", results, budget: budget.snapshot(), providerCalls });
      }
      if (budgetAfterProbe.status !== "ACTIVE") {
        for (const game of eligibleGames) {
          results.set(game.gamePk, {
            ...gameResultBase(game),
            status: "NOT_REACHED_AFTER_BLOCK",
            eventMatchStatus: "NOT_ATTEMPTED",
            providerEventId: null,
            cacheHitMarketKeys: [],
            paidMarketKeysRequested: [],
            quoteMarkets: [],
            budgetDenialCode: "BUDGET_CONTROLLER_BLOCKED",
            providerErrorCode: budgetAfterProbe.blockReason,
            usableForMarketEdge: false,
          });
        }
        return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "QUOTA_PROBE_BLOCKED", results, budget: budgetAfterProbe, providerCalls });
      }
    } catch (error: any) {
      for (const game of eligibleGames) {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "NOT_REACHED_AFTER_BLOCK",
          eventMatchStatus: "NOT_ATTEMPTED",
          providerEventId: null,
          cacheHitMarketKeys: [],
          paidMarketKeysRequested: [],
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: String(error?.code ?? "ZERO_COST_EVENTS_PROBE_FAILED"),
          usableForMarketEdge: false,
        });
      }
      return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "ZERO_COST_EVENTS_PROBE_FAILED", results, budget: budget.snapshot(), providerCalls });
    }

    let stopReason: MlbSelectiveOddsStopReason | null = null;
    for (const game of eligibleGames) {
      if (stopReason) {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "NOT_REACHED_AFTER_BLOCK",
          eventMatchStatus: "NOT_ATTEMPTED",
          providerEventId: null,
          cacheHitMarketKeys: [],
          paidMarketKeysRequested: [],
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: stopReason,
          usableForMarketEdge: false,
        });
        continue;
      }

      const matched = matchMlbDiscoveryGameToProviderEvent(game, providerEvents);
      if (matched.status !== "MATCHED") {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: matched.status === "NOT_FOUND" ? "EVENT_NOT_FOUND" : "EVENT_MATCH_AMBIGUOUS",
          eventMatchStatus: matched.status,
          providerEventId: null,
          cacheHitMarketKeys: [],
          paidMarketKeysRequested: [],
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: null,
          usableForMarketEdge: false,
        });
        continue;
      }

      const nowMs = this.now().getTime();
      const requestedKeys = sortedUnique(game.providerMarketKeysToRequestNow);
      const cacheEntry = this.eventCache.get(matched.eventId);
      const cacheHitKeys = requestedKeys.filter((key) => {
        const fetchedAt = cacheEntry?.marketFetchedAtMs.get(key);
        return fetchedAt != null && nowMs - fetchedAt < this.cacheTtlMs;
      });
      const paidKeys = requestedKeys.filter((key) => !cacheHitKeys.includes(key));

      if (paidKeys.length === 0 && cacheEntry) {
        const quoteMarkets = filterNormalizedMarkets(game, cacheEntry.providerEvent, this.now().toISOString());
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "CACHE_HIT",
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: [],
          quoteMarkets,
          budgetDenialCode: null,
          providerErrorCode: null,
          usableForMarketEdge: usableQuoteCount(quoteMarkets) > 0,
        });
        continue;
      }

      const operationId = `${input.runId}:game:${game.gamePk}:${createHash("sha256").update(paidKeys.join(",")).digest("hex").slice(0, 16)}`;
      const authorization = budget.authorizePaidOperation({
        operationId,
        endpoint: "EVENT_ODDS",
        marketKeys: paidKeys,
        bookmakerCount: MLB_SELECTIVE_ODDS_BOOKMAKERS.length,
      });
      if (!authorization.ok) {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "BUDGET_DENIED",
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: [],
          quoteMarkets: [],
          budgetDenialCode: authorization.code,
          providerErrorCode: null,
          usableForMarketEdge: false,
        });
        stopReason = "RUN_BUDGET_DENIED_AT_HIGHER_RANK";
        continue;
      }

      let paidResponse: Response;
      try {
        providerCalls.paidEventOdds += 1;
        paidResponse = await this.fetchFn(buildMlbSelectiveEventOddsUrl(matched.eventId, apiKey, paidKeys));
      } catch (error: any) {
        budget.settlePaidOperation(operationId, { get: () => null });
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "PROVIDER_FAILED",
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: paidKeys,
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: String(error?.code ?? "PAID_PROVIDER_NETWORK_FAILURE"),
          usableForMarketEdge: false,
        });
        stopReason = "PAID_PROVIDER_REQUEST_FAILED";
        continue;
      }

      const paidPayload = await safeJson(paidResponse);
      const budgetAfterPaid = budget.settlePaidOperation(operationId, paidResponse.headers);
      if (!paidResponse.ok) {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "PROVIDER_FAILED",
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: paidKeys,
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: providerErrorCode(paidPayload, `ODDS_EVENT_HTTP_${paidResponse.status}`),
          usableForMarketEdge: false,
        });
        stopReason = "PAID_PROVIDER_REQUEST_FAILED";
        continue;
      }
      if (!paidPayload || typeof paidPayload !== "object" || Array.isArray(paidPayload)) {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "PROVIDER_FAILED",
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: paidKeys,
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: "ODDS_EVENT_PAYLOAD_INVALID",
          usableForMarketEdge: false,
        });
        stopReason = "PAID_PROVIDER_PAYLOAD_INVALID";
        continue;
      }
      const payloadEventId = String(paidPayload?.id ?? "").trim();
      const identityMatches = payloadEventId === matched.eventId
        && providerTeamEquivalent(game.homeTeam.name, paidPayload?.home_team)
        && providerTeamEquivalent(game.awayTeam.name, paidPayload?.away_team);
      if (!identityMatches) {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "PROVIDER_FAILED",
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: paidKeys,
          quoteMarkets: [],
          budgetDenialCode: null,
          providerErrorCode: "ODDS_EVENT_IDENTITY_MISMATCH",
          usableForMarketEdge: false,
        });
        stopReason = "PAID_PROVIDER_IDENTITY_MISMATCH";
        continue;
      }

      const merged = mergeProviderEvent(cacheEntry?.providerEvent ?? null, paidPayload, paidKeys);
      const marketFetchedAtMs = new Map(cacheEntry?.marketFetchedAtMs ?? []);
      for (const key of paidKeys) marketFetchedAtMs.set(key, nowMs);
      this.eventCache.set(matched.eventId, {
        eventId: matched.eventId,
        providerEvent: merged,
        marketFetchedAtMs,
      });

      if (budgetAfterPaid.status !== "ACTIVE") {
        results.set(game.gamePk, {
          ...gameResultBase(game),
          status: "PROVIDER_ACCOUNTING_BLOCKED",
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: paidKeys,
          quoteMarkets: [],
          budgetDenialCode: "BUDGET_CONTROLLER_BLOCKED",
          providerErrorCode: budgetAfterPaid.blockReason,
          usableForMarketEdge: false,
        });
        stopReason = "PROVIDER_ACCOUNTING_BLOCKED";
        continue;
      }

      const quoteMarkets = filterNormalizedMarkets(game, merged, this.now().toISOString());
      results.set(game.gamePk, {
        ...gameResultBase(game),
        status: "FETCHED",
        eventMatchStatus: "MATCHED",
        providerEventId: matched.eventId,
        cacheHitMarketKeys: cacheHitKeys,
        paidMarketKeysRequested: paidKeys,
        quoteMarkets,
        budgetDenialCode: null,
        providerErrorCode: null,
        usableForMarketEdge: usableQuoteCount(quoteMarkets) > 0,
      });
    }

    const orderedResults = input.discovery.games.map((game) => results.get(game.gamePk)).filter((game): game is MlbSelectiveOddsGameResult => game != null);
    const hasBlockingStatus = orderedResults.some((game) => [
      "BUDGET_DENIED",
      "PROVIDER_FAILED",
      "PROVIDER_ACCOUNTING_BLOCKED",
      "NOT_REACHED_AFTER_BLOCK",
    ].includes(game.status));
    const hasUnresolved = orderedResults.some((game) => game.status === "EVENT_NOT_FOUND" || game.status === "EVENT_MATCH_AMBIGUOUS");
    const status: MlbSelectiveOddsRunStatus = hasBlockingStatus ? "BLOCKED" : hasUnresolved ? "PARTIAL" : "COMPLETED";
    return this.finish({
      input,
      generatedAt,
      status,
      stopReason,
      results,
      budget: budget.snapshot(),
      providerCalls,
    });
  }

  private finish(input: {
    input: {
      runId: string;
      discovery: MlbMarketDiscoveryResult;
      maxRunCredits: number;
      reserveCredits: number;
      apiKey: string;
    };
    generatedAt: string;
    status: MlbSelectiveOddsRunStatus;
    stopReason: MlbSelectiveOddsStopReason | null;
    results: Map<number, MlbSelectiveOddsGameResult>;
    budget: MlbOddsBudgetSnapshot | null;
    providerCalls: {
      zeroCostEventsProbe: number;
      paidEventOdds: number;
      eventMarkets: 0;
      sportOdds: 0;
    };
  }): MlbSelectiveOddsAcquisitionResult {
    const games = input.input.discovery.games
      .map((game) => input.results.get(game.gamePk))
      .filter((game): game is MlbSelectiveOddsGameResult => game != null);
    return {
      schemaVersion: MLB_SELECTIVE_ODDS_ACQUISITION_SCHEMA,
      generatedAt: input.generatedAt,
      runId: input.input.runId,
      date: input.input.discovery.date,
      sourceMarketDiscoverySchemaVersion: input.input.discovery.schemaVersion,
      status: input.status,
      stopReason: input.stopReason,
      games,
      budget: input.budget,
      providerCalls: input.providerCalls,
      summary: {
        discoveryGames: input.input.discovery.games.length,
        paidLookupEligibleGames: input.input.discovery.games.filter((game) => game.providerMarketKeysToRequestNow.length > 0).length,
        fetchedGames: games.filter((game) => game.status === "FETCHED").length,
        cacheOnlyGames: games.filter((game) => game.status === "CACHE_HIT").length,
        unresolvedEventGames: games.filter((game) => game.status === "EVENT_NOT_FOUND" || game.status === "EVENT_MATCH_AMBIGUOUS").length,
        heldGames: games.filter((game) => game.status === "HELD_BY_DISCOVERY").length,
        blockedGames: games.filter((game) => ["BUDGET_DENIED", "PROVIDER_FAILED", "PROVIDER_ACCOUNTING_BLOCKED", "NOT_REACHED_AFTER_BLOCK"].includes(game.status)).length,
        requestedPaidMarketKeys: games.reduce((sum, game) => sum + game.paidMarketKeysRequested.length, 0),
        reusedFreshMarketKeys: games.reduce((sum, game) => sum + game.cacheHitMarketKeys.length, 0),
        usableMarketQuotes: games.reduce((sum, game) => sum + usableQuoteCount(game.quoteMarkets), 0),
      },
      policy: {
        explicitInvocationRequired: true,
        publicRouteRegistered: false,
        backgroundPolling: false,
        timers: false,
        finalistGamesOnly: true,
        exactDiscoveryMarketKeysOnly: true,
        onePaidRequestPerGameMaximum: true,
        paidRequestsSequentialByIntrinsicRank: true,
        lowerRankCannotBypassBudgetDeniedHigherRank: true,
        eventMarketsDiscoveryCalls: 0,
        sportOddsCalls: 0,
        executionAndReferenceBooksShareOneRequest: true,
        providerBookmakerCount: MLB_SELECTIVE_ODDS_BOOKMAKERS.length,
        cacheTtlMs: MLB_SELECTIVE_ODDS_CACHE_TTL_MS,
        cacheTtlIsRefreshPolicyNotPolling: true,
        negativeMarketAvailabilityCachedWithinTtl: true,
        sameRunIdReplayConsumesPaidCredits: false,
        runIdPlanMutationAllowed: false,
        staleOrMissingExecutionQuoteCanBeRecommended: false,
        calculatesMarketEdge: false,
        recommendsBet: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
      safety: input.input.discovery.safety,
    };
  }
}
