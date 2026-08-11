import { createHash } from "node:crypto";
import {
  MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS,
  type MlbMarketDiscoveryGamePlan,
  type MlbMarketDiscoveryPlannedMarket,
  type MlbMarketDiscoveryResult,
} from "./mlb-market-discovery";
import { MLB_MARKET_UNIVERSE_REGISTRY } from "./mlb-market-universe-registry";
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

export const MLB_SELECTIVE_ODDS_ACQUISITION_SCHEMA = "courtedge-p0-mlb-selective-odds-acquisition.v6" as const;
export const MLB_SELECTIVE_ODDS_CACHE_TTL_MS = MLB_P1_M6A2_MAX_QUOTE_AGE_MS;
export const MLB_SELECTIVE_ODDS_REQUEST_TIMEOUT_MS = 15_000;
export const MLB_SELECTIVE_ODDS_EVENT_MATCH_MAX_START_DELTA_MS = 90 * 60 * 1000;
export const MLB_SELECTIVE_ODDS_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MLB_SELECTIVE_ODDS_MAX_SHARED_EVENT_CACHE_ENTRIES = 128;
export const MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES = 1024;

export const MLB_SELECTIVE_ODDS_BOOKMAKERS = [
  ...MLB_EXECUTION_BOOK_PRIORITY,
  ...MLB_REFERENCE_BOOKS,
] as const;

export type MlbSelectiveOddsRunStatus = "NO_PAID_WORK" | "COMPLETED" | "PARTIAL" | "BLOCKED";
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
export type MlbSelectiveOddsEventMatchStatus = "NOT_ATTEMPTED" | "MATCHED" | "NOT_FOUND" | "AMBIGUOUS";
export type MlbSelectiveOddsStopReason =
  | "SHARED_COORDINATOR_REQUIRED"
  | "PROVIDER_ACCOUNT_SCOPE_REQUIRED"
  | "ODDS_API_KEY_REQUIRED"
  | "DURABLE_RUN_RECOVERY_REQUIRED"
  | "SHARED_RUN_JOURNAL_CAPACITY_EXHAUSTED"
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
  providerCalls: { zeroCostEventsProbe: number; paidEventOdds: number; eventMarkets: 0; sportOdds: 0 };
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
    registryBackedPlanValidation: true;
    thesisDirectionMustExistInScopedDiscoveryEvidence: true;
    exactDiscoveryMarketKeysOnly: true;
    duplicateMarketKeysAllowed: false;
    immutableExecutionSnapshot: true;
    fingerprintCoversCompleteExecutionSnapshot: true;
    rawApiKeyExcludedFromFingerprint: true;
    returnedResultsAreDeepFrozen: true;
    onePaidRequestPerGameMaximum: true;
    paidRequestsSequentialByIntrinsicRank: true;
    sharedCoordinatorRequiredForPaidWork: true;
    stableProviderAccountScopeRequiredForPaidWork: true;
    providerAccountScopeDerivedFromApiKey: false;
    processLocalStateCanAuthorizePaidWork: false;
    crossProcessLockDelegatedToSharedCoordinator: true;
    crossProcessIdempotencyDelegatedToSharedCoordinator: true;
    crossProcessMarketCacheDelegatedToSharedCoordinator: true;
    durableRunJournalBeforeAnyProviderAccess: true;
    unresolvedRunCanRetryProvider: false;
    runJournalCapacityReservedBeforeProvider: true;
    unexpiredRunJournalRecordsEvictedForAdmission: false;
    lowerRankCannotBypassBudgetDeniedHigherRank: true;
    eventMarketsDiscoveryCalls: 0;
    sportOddsCalls: 0;
    executionAndReferenceBooksShareOneRequest: true;
    providerBookmakerCount: number;
    cacheTtlMs: number;
    cacheTtlIsRefreshPolicyNotPolling: true;
    negativeMarketAvailabilityCachedWithinTtl: true;
    idempotencyWindowMs: number;
    sameRunIdReplayConsumesPaidCreditsWithinIdempotencyWindow: false;
    runIdPlanMutationAllowed: false;
    sharedEventCacheMaxEntries: number;
    sharedRunJournalMaxEntries: number;
    sharedStatePruningRequired: true;
    providerRequestTimeoutMs: number;
    automaticProviderRetries: false;
    eventMatchMaxStartDeltaMs: number;
    paidPayloadMustMatchProbedCommenceTime: true;
    ambiguousEventIdentityCanSpendCredits: false;
    staleOrMissingExecutionQuoteCanBeRecommended: false;
    calculatesMarketEdge: false;
    recommendsBet: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
  safety: MlbMarketDiscoveryResult["safety"];
}

export interface MlbSelectiveOddsSharedEventCache {
  eventId: string;
  providerEvent: any;
  marketFetchedAtMs: Record<string, number>;
  updatedAtMs: number;
}

export interface MlbSelectiveOddsSharedRunInProgress {
  state: "IN_PROGRESS";
  fingerprint: string;
  admittedAtMs: number;
  expiresAtMs: number;
}

export interface MlbSelectiveOddsSharedRunCompleted {
  state: "COMPLETED";
  fingerprint: string;
  expiresAtMs: number;
  result: MlbSelectiveOddsAcquisitionResult;
}

export type MlbSelectiveOddsSharedRunRecord = MlbSelectiveOddsSharedRunInProgress | MlbSelectiveOddsSharedRunCompleted;

export type MlbSelectiveOddsSharedRunAdmission =
  | { status: "ADMITTED"; record: MlbSelectiveOddsSharedRunInProgress }
  | { status: "IN_PROGRESS"; record: MlbSelectiveOddsSharedRunInProgress }
  | { status: "COMPLETED"; record: MlbSelectiveOddsSharedRunCompleted }
  | { status: "CAPACITY_EXHAUSTED"; record: null };

export interface MlbSelectiveOddsSharedRunAdmissionPolicy {
  nowMs: number;
  expiresAtMs: number;
  maxRunEntries: number;
}

export interface MlbSelectiveOddsSharedEventPrunePolicy {
  nowMs: number;
  eventCacheTtlMs: number;
  maxEventEntries: number;
}

/**
 * Production implementations MUST make beginRun admission atomic with the
 * provider-account lock and durable across all processes/replicas that can use
 * the same The Odds API quota account. Unexpired run records may not be evicted
 * to create capacity for a new run.
 */
export interface MlbSelectiveOddsSharedCoordinator {
  readonly coordinationScope: "PROVIDER_ACCOUNT_SHARED";
  runExclusive<T>(providerAccountScopeKey: string, work: () => Promise<T>): Promise<T>;
  beginRun(
    providerAccountScopeKey: string,
    runId: string,
    fingerprint: string,
    policy: MlbSelectiveOddsSharedRunAdmissionPolicy,
  ): Promise<MlbSelectiveOddsSharedRunAdmission>;
  completeRun(
    providerAccountScopeKey: string,
    runId: string,
    fingerprint: string,
    completed: MlbSelectiveOddsSharedRunCompleted,
  ): Promise<void>;
  getEventCache(providerAccountScopeKey: string, eventId: string): Promise<MlbSelectiveOddsSharedEventCache | null>;
  putEventCache(providerAccountScopeKey: string, eventId: string, entry: MlbSelectiveOddsSharedEventCache): Promise<void>;
  pruneEventCache(providerAccountScopeKey: string, policy: MlbSelectiveOddsSharedEventPrunePolicy): Promise<void>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ServiceOptions = {
  fetchFn?: FetchLike;
  now?: () => Date;
  cacheTtlMs?: number;
  requestTimeoutMs?: number;
  idempotencyTtlMs?: number;
  coordinator?: MlbSelectiveOddsSharedCoordinator;
};
type EventMatchResult =
  | { status: "MATCHED"; event: any; eventId: string }
  | { status: "NOT_FOUND" | "AMBIGUOUS"; event: null; eventId: null };
export type MlbSelectiveOddsExecutionInput = {
  runId: string;
  providerAccountScopeKey: string;
  discovery: MlbMarketDiscoveryResult;
  maxRunCredits: number;
  reserveCredits: number;
  apiKey: string;
};
type ProviderCalls = { zeroCostEventsProbe: number; paidEventOdds: number; eventMarkets: 0; sportOdds: 0 };
type LocalInFlight = { fingerprint: string; promise: Promise<MlbSelectiveOddsAcquisitionResult> };

export class MlbSelectiveOddsPlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MlbSelectiveOddsPlanError";
    this.code = code;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function cloneFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function hasDuplicateStrings(values: readonly string[]): boolean {
  const normalized = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  return new Set(normalized).size !== normalized.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedUnique(left);
  const b = sortedUnique(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const CURRENT_ANALYTICAL_SET = new Set<string>(MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS);
const CURRENT_REGISTRY_PAIR = new Map<string, string>();
for (const market of MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS) {
  const matches = MLB_MARKET_UNIVERSE_REGISTRY.filter((entry) =>
    entry.modelIntegrationStatus === "SUPPORTED" && entry.canonicalMarketTypes.includes(market));
  if (matches.length !== 1) throw new Error(`MLB_SELECTIVE_ODDS_REGISTRY_MAPPING_INVALID:${market}:${matches.length}`);
  CURRENT_REGISTRY_PAIR.set(market, matches[0].providerMarketKey);
}

function expectedScopeForMarket(market: MlbMarketDiscoveryPlannedMarket["canonicalMarketType"]): "FULL_GAME" | "EARLY_WINDOW" {
  return market === "F5_ML" || market === "F5_TOTAL" ? "EARLY_WINDOW" : "FULL_GAME";
}

function expectedIntentForMarket(market: MlbMarketDiscoveryPlannedMarket["canonicalMarketType"]): "SIDE" | "TOTAL" {
  return market === "TOTAL" || market === "F5_TOTAL" ? "TOTAL" : "SIDE";
}

function validatePlannedMarket(game: MlbMarketDiscoveryGamePlan, market: MlbMarketDiscoveryPlannedMarket): void {
  if (!CURRENT_ANALYTICAL_SET.has(market.canonicalMarketType)) {
    throw new MlbSelectiveOddsPlanError("UNAUTHORIZED_ANALYTICAL_MARKET", `game ${game.gamePk} market ${market.canonicalMarketType} is not paid-authorized`);
  }
  const expectedProviderKey = CURRENT_REGISTRY_PAIR.get(market.canonicalMarketType);
  if (!expectedProviderKey || market.providerMarketKey !== expectedProviderKey) {
    throw new MlbSelectiveOddsPlanError(
      "REGISTRY_MARKET_MAPPING_MISMATCH",
      `game ${game.gamePk} ${market.canonicalMarketType} must map to ${expectedProviderKey ?? "<missing>"}, not ${market.providerMarketKey}`,
    );
  }
  const expectedScope = expectedScopeForMarket(market.canonicalMarketType);
  if (market.intrinsicProjectionScope !== expectedScope) {
    throw new MlbSelectiveOddsPlanError("MARKET_HORIZON_MISMATCH", `game ${game.gamePk} ${market.canonicalMarketType} must use ${expectedScope}`);
  }
  const expectedIntent = expectedIntentForMarket(market.canonicalMarketType);
  if (market.thesisIntent !== expectedIntent) {
    throw new MlbSelectiveOddsPlanError("MARKET_THESIS_INTENT_MISMATCH", `game ${game.gamePk} ${market.canonicalMarketType} must use ${expectedIntent}`);
  }
  if (market.intrinsicThesisKinds.length === 0 || market.supportingComponents.length === 0) {
    throw new MlbSelectiveOddsPlanError("MARKET_THESIS_EVIDENCE_MISSING", `game ${game.gamePk} ${market.canonicalMarketType} lacks thesis evidence`);
  }
  const allowedKinds = expectedIntent === "SIDE"
    ? new Set(["HOME_SIDE", "AWAY_SIDE"])
    : new Set(["TOTAL_OVER", "TOTAL_UNDER"]);
  if (market.intrinsicThesisKinds.some((kind) => !allowedKinds.has(kind))) {
    throw new MlbSelectiveOddsPlanError("MARKET_THESIS_DIRECTION_MISMATCH", `game ${game.gamePk} ${market.canonicalMarketType} has incompatible thesis direction`);
  }
  const scopedKinds = market.intrinsicProjectionScope === "FULL_GAME"
    ? game.researchEliteThesisKindsByScope.fullGame
    : game.researchEliteThesisKindsByScope.earlyWindow;
  if (market.intrinsicThesisKinds.some((kind) => !scopedKinds.includes(kind))) {
    throw new MlbSelectiveOddsPlanError(
      "MARKET_THESIS_NOT_AUTHORIZED_BY_SCOPE",
      `game ${game.gamePk} ${market.canonicalMarketType} contains a thesis direction not present in scoped discovery evidence`,
    );
  }
}

function assertValidDiscoveryPlan(discovery: MlbMarketDiscoveryResult): void {
  if (discovery.games.length > MLB_SHORTLIST_MAX_CANDIDATES) {
    throw new MlbSelectiveOddsPlanError("DISCOVERY_GAME_CAP_EXCEEDED", `market discovery produced ${discovery.games.length} games; max ${MLB_SHORTLIST_MAX_CANDIDATES}`);
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
      throw new MlbSelectiveOddsPlanError("INTRINSIC_RANK_ORDER_INVALID", "games must be ordered by ascending intrinsic rank");
    }
    seenRanks.add(game.intrinsicRank);
    previousRank = game.intrinsicRank;

    const objectKeys = game.plannedMarkets.map((market) => market.providerMarketKey);
    const canonicalMarkets = game.plannedMarkets.map((market) => market.canonicalMarketType);
    if (
      hasDuplicateStrings(objectKeys)
      || hasDuplicateStrings(canonicalMarkets)
      || hasDuplicateStrings(game.plannedProviderMarketKeys)
      || hasDuplicateStrings(game.providerMarketKeysToRequestNow)
    ) {
      throw new MlbSelectiveOddsPlanError("DUPLICATE_MARKET_KEY", `game ${game.gamePk} contains duplicate market identity`);
    }
    for (const market of game.plannedMarkets) validatePlannedMarket(game, market);
    if (!sameStringSet(objectKeys, game.plannedProviderMarketKeys)) {
      throw new MlbSelectiveOddsPlanError("PLANNED_MARKET_KEY_MISMATCH", `game ${game.gamePk} market objects and key list disagree`);
    }
    if (game.providerMarketKeysToRequestNow.length > 0) {
      if (!game.paidLookupEligibleNow || game.inputStage !== "FINAL" || game.paidLookupHoldReason != null) {
        throw new MlbSelectiveOddsPlanError("PAID_LOOKUP_AUTHORIZATION_INVALID", `game ${game.gamePk} exposes paid keys without FINAL authorization`);
      }
      if (!sameStringSet(game.providerMarketKeysToRequestNow, game.plannedProviderMarketKeys)) {
        throw new MlbSelectiveOddsPlanError("PAID_MARKET_KEY_MUTATION", `game ${game.gamePk} paid keys differ from discovery plan`);
      }
    } else if (game.paidLookupEligibleNow) {
      throw new MlbSelectiveOddsPlanError("EMPTY_PAID_LOOKUP_PLAN", `game ${game.gamePk} is paid-eligible with no market keys`);
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

function stablePlanFingerprint(input: MlbSelectiveOddsExecutionInput): string {
  const { apiKey: _secret, ...safeSnapshot } = input;
  return createHash("sha256")
    .update(JSON.stringify({ bookmakers: [...MLB_SELECTIVE_ODDS_BOOKMAKERS], snapshot: safeSnapshot }))
    .digest("hex");
}

export function buildMlbSelectiveEventsProbeUrl(apiKey: string): string {
  const params = new URLSearchParams({ apiKey, dateFormat: "iso" });
  return `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?${params.toString()}`;
}

export function buildMlbSelectiveEventOddsUrl(eventId: string, apiKey: string, marketKeys: readonly string[]): string {
  const markets = sortedUnique(marketKeys);
  if (!markets.length) throw new MlbSelectiveOddsPlanError("EMPTY_PAID_MARKET_SET", "paid event odds requires a market key");
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
  const targetMs = Date.parse(String(game.startTime ?? ""));
  if (!Number.isFinite(targetMs)) return { status: "AMBIGUOUS", event: null, eventId: null };
  const teamMatches = providerEvents.filter((event) => {
    const id = String(event?.id ?? "").trim();
    return Boolean(id)
      && providerTeamEquivalent(game.homeTeam.name, event?.home_team)
      && providerTeamEquivalent(game.awayTeam.name, event?.away_team);
  });
  if (teamMatches.length === 0) return { status: "NOT_FOUND", event: null, eventId: null };
  if (teamMatches.some((event) => !Number.isFinite(Date.parse(String(event?.commence_time ?? ""))))) {
    return { status: "AMBIGUOUS", event: null, eventId: null };
  }
  const datedMatches = teamMatches.filter((event) => floridaDateFromIso(event.commence_time) === game.officialDate);
  if (datedMatches.length === 0) return { status: "NOT_FOUND", event: null, eventId: null };
  const withinWindow = datedMatches
    .map((event) => ({ event, eventId: String(event.id), deltaMs: Math.abs(Date.parse(String(event.commence_time)) - targetMs) }))
    .filter((entry) => entry.deltaMs <= MLB_SELECTIVE_ODDS_EVENT_MATCH_MAX_START_DELTA_MS)
    .sort((left, right) => left.deltaMs - right.deltaMs || left.eventId.localeCompare(right.eventId));
  if (!withinWindow[0]) return { status: "AMBIGUOUS", event: null, eventId: null };
  if (withinWindow[1] && withinWindow[0].deltaMs === withinWindow[1].deltaMs) {
    return { status: "AMBIGUOUS", event: null, eventId: null };
  }
  return { status: "MATCHED", event: withinWindow[0].event, eventId: withinWindow[0].eventId };
}

async function safeJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return null; }
}

function providerErrorCode(payload: any, fallback: string): string {
  return String(payload?.error_code ?? payload?.code ?? fallback).trim() || fallback;
}

function mergeProviderEvent(existing: any | null, incoming: any, fetchedMarketKeys: readonly string[]): any {
  const fetched = new Set(sortedUnique(fetchedMarketKeys));
  const oldBooks = new Map<string, any>();
  const newBooks = new Map<string, any>();
  for (const book of Array.isArray(existing?.bookmakers) ? existing.bookmakers : []) {
    const key = String(book?.key ?? "").trim();
    if (key) oldBooks.set(key, book);
  }
  for (const book of Array.isArray(incoming?.bookmakers) ? incoming.bookmakers : []) {
    const key = String(book?.key ?? "").trim();
    if (key) newBooks.set(key, book);
  }
  const bookmakers = sortedUnique([...oldBooks.keys(), ...newBooks.keys()]).map((bookKey) => {
    const oldBook = oldBooks.get(bookKey) ?? {};
    const newBook = newBooks.get(bookKey) ?? {};
    const preserved = (Array.isArray(oldBook.markets) ? oldBook.markets : []).filter((market: any) => !fetched.has(String(market?.key ?? "")));
    const replacement = (Array.isArray(newBook.markets) ? newBook.markets : []).filter((market: any) => fetched.has(String(market?.key ?? "")));
    return { ...oldBook, ...newBook, key: bookKey, markets: [...preserved, ...replacement] };
  });
  return { ...(existing ?? {}), ...incoming, bookmakers };
}

function gameResultBase(game: MlbMarketDiscoveryGamePlan): Omit<MlbSelectiveOddsGameResult,
  "status" | "eventMatchStatus" | "providerEventId" | "cacheHitMarketKeys" | "paidMarketKeysRequested" | "quoteMarkets" | "budgetDenialCode" | "providerErrorCode" | "usableForMarketEdge"
> {
  return {
    gamePk: game.gamePk,
    intrinsicRank: game.intrinsicRank,
    homeTeam: { ...game.homeTeam },
    awayTeam: { ...game.awayTeam },
    officialDate: game.officialDate,
    startTime: game.startTime,
    inputStage: game.inputStage,
    holdReason: game.paidLookupHoldReason,
    requestedMarketKeys: [...game.providerMarketKeysToRequestNow],
    marketTheses: game.plannedMarkets.map(marketThesis),
  };
}

function filterNormalizedMarkets(game: MlbMarketDiscoveryGamePlan, providerEvent: any, capturedAt: string): MlbCanonicalMarketAvailability[] {
  const requestedPairs = new Set(game.plannedMarkets.map((market) => `${market.providerMarketKey}:${market.canonicalMarketType}`));
  return buildMlbMarketOddsUniverseGame(providerEvent, capturedAt, MLB_SELECTIVE_ODDS_CACHE_TTL_MS)
    .markets
    .filter((market) => market.providerMarketKey != null && requestedPairs.has(`${market.providerMarketKey}:${market.marketType}`));
}

function usableQuoteCount(markets: readonly MlbCanonicalMarketAvailability[]): number {
  return markets.filter((market) => market.availability === "EXECUTABLE").length;
}

function pendingResult(
  game: MlbMarketDiscoveryGamePlan,
  status: MlbSelectiveOddsGameStatus,
  providerErrorCodeValue: string | null,
  options: Partial<Pick<MlbSelectiveOddsGameResult,
    "eventMatchStatus" | "providerEventId" | "cacheHitMarketKeys" | "paidMarketKeysRequested" | "budgetDenialCode"
  >> = {},
): MlbSelectiveOddsGameResult {
  return {
    ...gameResultBase(game),
    status,
    eventMatchStatus: options.eventMatchStatus ?? "NOT_ATTEMPTED",
    providerEventId: options.providerEventId ?? null,
    cacheHitMarketKeys: options.cacheHitMarketKeys ?? [],
    paidMarketKeysRequested: options.paidMarketKeysRequested ?? [],
    quoteMarkets: [],
    budgetDenialCode: options.budgetDenialCode ?? null,
    providerErrorCode: providerErrorCodeValue,
    usableForMarketEdge: false,
  };
}

export class MlbSelectiveOddsAcquisitionService {
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly requestTimeoutMs: number;
  private readonly idempotencyTtlMs: number;
  private readonly coordinator?: MlbSelectiveOddsSharedCoordinator;
  private readonly inFlightRuns = new Map<string, LocalInFlight>();

  constructor(options: ServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? MLB_SELECTIVE_ODDS_CACHE_TTL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? MLB_SELECTIVE_ODDS_REQUEST_TIMEOUT_MS;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? MLB_SELECTIVE_ODDS_IDEMPOTENCY_TTL_MS;
    this.coordinator = options.coordinator;
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs <= 0) throw new Error("cacheTtlMs must be positive");
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) throw new Error("requestTimeoutMs must be positive");
    if (!Number.isFinite(this.idempotencyTtlMs) || this.idempotencyTtlMs <= 0) throw new Error("idempotencyTtlMs must be positive");
  }

  acquire(input: MlbSelectiveOddsExecutionInput): Promise<MlbSelectiveOddsAcquisitionResult> {
    let snapshot: MlbSelectiveOddsExecutionInput;
    try {
      snapshot = cloneFreeze({
        runId: String(input.runId ?? "").trim(),
        providerAccountScopeKey: String(input.providerAccountScopeKey ?? "").trim(),
        discovery: input.discovery,
        maxRunCredits: input.maxRunCredits,
        reserveCredits: input.reserveCredits,
        apiKey: String(input.apiKey ?? "").trim(),
      });
      if (!snapshot.runId) throw new MlbSelectiveOddsPlanError("RUN_ID_REQUIRED", "runId is required");
      assertValidDiscoveryPlan(snapshot.discovery);
    } catch (error) {
      return Promise.reject(error);
    }

    const eligibleGames = snapshot.discovery.games.filter((game) => game.providerMarketKeysToRequestNow.length > 0);
    if (eligibleGames.length === 0) {
      return this.execute(snapshot, null, null).then((result) => cloneFreeze(result));
    }
    if (!this.coordinator || this.coordinator.coordinationScope !== "PROVIDER_ACCOUNT_SHARED") {
      return Promise.resolve(cloneFreeze(this.blockBeforeProvider(snapshot, "SHARED_COORDINATOR_REQUIRED")));
    }
    if (!snapshot.providerAccountScopeKey) {
      return Promise.resolve(cloneFreeze(this.blockBeforeProvider(snapshot, "PROVIDER_ACCOUNT_SCOPE_REQUIRED")));
    }
    if (!snapshot.apiKey) {
      return Promise.resolve(cloneFreeze(this.blockBeforeProvider(snapshot, "ODDS_API_KEY_REQUIRED")));
    }

    const accountKey = snapshot.providerAccountScopeKey;
    const fingerprint = stablePlanFingerprint(snapshot);
    const localKey = `${accountKey}:${snapshot.runId}`;
    const inFlight = this.inFlightRuns.get(localKey);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return Promise.reject(new MlbSelectiveOddsPlanError("RUN_ID_REUSED_WITH_DIFFERENT_PLAN", `runId ${snapshot.runId} is executing another plan`));
      }
      return inFlight.promise;
    }

    const promise = this.coordinator.runExclusive(accountKey, async () => {
      const nowMs = this.now().getTime();
      await this.coordinator!.pruneEventCache(accountKey, {
        nowMs,
        eventCacheTtlMs: this.cacheTtlMs,
        maxEventEntries: MLB_SELECTIVE_ODDS_MAX_SHARED_EVENT_CACHE_ENTRIES,
      });

      const admission = await this.coordinator!.beginRun(accountKey, snapshot.runId, fingerprint, {
        nowMs,
        expiresAtMs: nowMs + this.idempotencyTtlMs,
        maxRunEntries: MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES,
      });

      if (admission.status === "CAPACITY_EXHAUSTED") {
        return cloneFreeze(this.blockBeforeProvider(snapshot, "SHARED_RUN_JOURNAL_CAPACITY_EXHAUSTED"));
      }
      if (admission.record.fingerprint !== fingerprint) {
        throw new MlbSelectiveOddsPlanError("RUN_ID_REUSED_WITH_DIFFERENT_PLAN", `runId ${snapshot.runId} is bound to another immutable plan`);
      }
      if (admission.status === "COMPLETED") return cloneFreeze(admission.record.result);
      if (admission.status === "IN_PROGRESS") {
        return cloneFreeze(this.blockBeforeProvider(snapshot, "DURABLE_RUN_RECOVERY_REQUIRED"));
      }

      const result = cloneFreeze(await this.execute(snapshot, this.coordinator!, accountKey));
      const completed: MlbSelectiveOddsSharedRunCompleted = {
        state: "COMPLETED",
        fingerprint,
        expiresAtMs: nowMs + this.idempotencyTtlMs,
        result,
      };
      try {
        await this.coordinator!.completeRun(accountKey, snapshot.runId, fingerprint, completed);
      } catch (error) {
        throw new MlbSelectiveOddsPlanError(
          "SHARED_RUN_COMPLETION_PERSIST_FAILED",
          `runId ${snapshot.runId} completion could not be durably persisted; IN_PROGRESS recovery barrier must remain`,
        );
      }
      return result;
    });

    this.inFlightRuns.set(localKey, { fingerprint, promise });
    void promise.finally(() => this.inFlightRuns.delete(localKey)).catch(() => undefined);
    return promise;
  }

  private blockBeforeProvider(
    input: MlbSelectiveOddsExecutionInput,
    reason: "SHARED_COORDINATOR_REQUIRED" | "PROVIDER_ACCOUNT_SCOPE_REQUIRED" | "ODDS_API_KEY_REQUIRED" | "DURABLE_RUN_RECOVERY_REQUIRED" | "SHARED_RUN_JOURNAL_CAPACITY_EXHAUSTED",
  ): MlbSelectiveOddsAcquisitionResult {
    const generatedAt = this.now().toISOString();
    const results = new Map<number, MlbSelectiveOddsGameResult>();
    for (const game of input.discovery.games) {
      results.set(game.gamePk, game.providerMarketKeysToRequestNow.length > 0
        ? pendingResult(game, "NOT_REACHED_AFTER_BLOCK", reason)
        : pendingResult(game, "HELD_BY_DISCOVERY", null));
    }
    return this.finish({
      input,
      generatedAt,
      status: "BLOCKED",
      stopReason: reason,
      results,
      budget: null,
      providerCalls: { zeroCostEventsProbe: 0, paidEventOdds: 0, eventMarkets: 0, sportOdds: 0 },
    });
  }

  private providerRequest(url: string): Promise<Response> {
    return this.fetchFn(url, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
  }

  private async execute(
    input: MlbSelectiveOddsExecutionInput,
    coordinator: MlbSelectiveOddsSharedCoordinator | null,
    accountKey: string | null,
  ): Promise<MlbSelectiveOddsAcquisitionResult> {
    const generatedAt = this.now().toISOString();
    const eligibleGames = input.discovery.games.filter((game) => game.providerMarketKeysToRequestNow.length > 0);
    const providerCalls: ProviderCalls = { zeroCostEventsProbe: 0, paidEventOdds: 0, eventMarkets: 0, sportOdds: 0 };
    const results = new Map<number, MlbSelectiveOddsGameResult>();
    for (const game of input.discovery.games.filter((entry) => entry.providerMarketKeysToRequestNow.length === 0)) {
      results.set(game.gamePk, pendingResult(game, "HELD_BY_DISCOVERY", null));
    }
    if (eligibleGames.length === 0) {
      return this.finish({ input, generatedAt, status: "NO_PAID_WORK", stopReason: null, results, budget: null, providerCalls });
    }
    if (!coordinator || !accountKey) return this.blockBeforeProvider(input, "SHARED_COORDINATOR_REQUIRED");

    const budget = new MlbOddsRunBudgetController({ runId: input.runId, maxRunCredits: input.maxRunCredits, reserveCredits: input.reserveCredits });
    let providerEvents: any;
    try {
      providerCalls.zeroCostEventsProbe += 1;
      const response = await this.providerRequest(buildMlbSelectiveEventsProbeUrl(input.apiKey));
      const budgetAfterProbe = budget.ingestZeroCostProbe(response.headers);
      providerEvents = await safeJson(response);
      if (!response.ok) {
        const code = providerErrorCode(providerEvents, `ODDS_EVENTS_HTTP_${response.status}`);
        for (const game of eligibleGames) results.set(game.gamePk, pendingResult(game, "NOT_REACHED_AFTER_BLOCK", code));
        return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "ZERO_COST_EVENTS_PROBE_FAILED", results, budget: budgetAfterProbe, providerCalls });
      }
      if (!Array.isArray(providerEvents)) {
        for (const game of eligibleGames) results.set(game.gamePk, pendingResult(game, "NOT_REACHED_AFTER_BLOCK", "ODDS_EVENTS_PAYLOAD_NOT_ARRAY"));
        return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "ZERO_COST_EVENTS_PROBE_PAYLOAD_INVALID", results, budget: budget.snapshot(), providerCalls });
      }
      if (budgetAfterProbe.status !== "ACTIVE") {
        for (const game of eligibleGames) {
          results.set(game.gamePk, pendingResult(game, "NOT_REACHED_AFTER_BLOCK", budgetAfterProbe.blockReason, { budgetDenialCode: "BUDGET_CONTROLLER_BLOCKED" }));
        }
        return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "QUOTA_PROBE_BLOCKED", results, budget: budgetAfterProbe, providerCalls });
      }
    } catch (error: any) {
      const code = String(error?.name === "TimeoutError" ? "PROVIDER_REQUEST_TIMEOUT" : error?.code ?? "ZERO_COST_EVENTS_PROBE_FAILED");
      for (const game of eligibleGames) results.set(game.gamePk, pendingResult(game, "NOT_REACHED_AFTER_BLOCK", code));
      return this.finish({ input, generatedAt, status: "BLOCKED", stopReason: "ZERO_COST_EVENTS_PROBE_FAILED", results, budget: budget.snapshot(), providerCalls });
    }

    let stopReason: MlbSelectiveOddsStopReason | null = null;
    for (const game of eligibleGames) {
      if (stopReason) {
        results.set(game.gamePk, pendingResult(game, "NOT_REACHED_AFTER_BLOCK", stopReason));
        continue;
      }
      const matched = matchMlbDiscoveryGameToProviderEvent(game, providerEvents);
      if (matched.status !== "MATCHED") {
        results.set(game.gamePk, pendingResult(
          game,
          matched.status === "NOT_FOUND" ? "EVENT_NOT_FOUND" : "EVENT_MATCH_AMBIGUOUS",
          null,
          { eventMatchStatus: matched.status },
        ));
        continue;
      }

      const nowMs = this.now().getTime();
      const requestedKeys = [...game.providerMarketKeysToRequestNow];
      const cacheEntry = await coordinator.getEventCache(accountKey, matched.eventId);
      const cacheHitKeys = requestedKeys.filter((key) => {
        const fetchedAt = cacheEntry?.marketFetchedAtMs?.[key];
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
      if (authorization.ok === false) {
        results.set(game.gamePk, pendingResult(game, "BUDGET_DENIED", null, {
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          budgetDenialCode: authorization.code,
        }));
        stopReason = "RUN_BUDGET_DENIED_AT_HIGHER_RANK";
        continue;
      }

      let paidResponse: Response;
      try {
        providerCalls.paidEventOdds += 1;
        paidResponse = await this.providerRequest(buildMlbSelectiveEventOddsUrl(matched.eventId, input.apiKey, paidKeys));
      } catch (error: any) {
        budget.settlePaidOperation(operationId, { get: () => null });
        const code = String(error?.name === "TimeoutError" ? "PROVIDER_REQUEST_TIMEOUT" : error?.code ?? "PAID_PROVIDER_NETWORK_FAILURE");
        results.set(game.gamePk, pendingResult(game, "PROVIDER_FAILED", code, {
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: paidKeys,
        }));
        stopReason = "PAID_PROVIDER_REQUEST_FAILED";
        continue;
      }

      const paidPayload = await safeJson(paidResponse);
      const budgetAfterPaid = budget.settlePaidOperation(operationId, paidResponse.headers);
      if (!paidResponse.ok) {
        results.set(game.gamePk, pendingResult(game, "PROVIDER_FAILED", providerErrorCode(paidPayload, `ODDS_EVENT_HTTP_${paidResponse.status}`), {
          eventMatchStatus: "MATCHED", providerEventId: matched.eventId, cacheHitMarketKeys: cacheHitKeys, paidMarketKeysRequested: paidKeys,
        }));
        stopReason = "PAID_PROVIDER_REQUEST_FAILED";
        continue;
      }
      if (!paidPayload || typeof paidPayload !== "object" || Array.isArray(paidPayload)) {
        results.set(game.gamePk, pendingResult(game, "PROVIDER_FAILED", "ODDS_EVENT_PAYLOAD_INVALID", {
          eventMatchStatus: "MATCHED", providerEventId: matched.eventId, cacheHitMarketKeys: cacheHitKeys, paidMarketKeysRequested: paidKeys,
        }));
        stopReason = "PAID_PROVIDER_PAYLOAD_INVALID";
        continue;
      }
      const paidStartMs = Date.parse(String(paidPayload.commence_time ?? ""));
      const matchedStartMs = Date.parse(String(matched.event?.commence_time ?? ""));
      const targetStartMs = Date.parse(String(game.startTime ?? ""));
      const identityMatches = String(paidPayload.id ?? "").trim() === matched.eventId
        && providerTeamEquivalent(game.homeTeam.name, paidPayload.home_team)
        && providerTeamEquivalent(game.awayTeam.name, paidPayload.away_team)
        && floridaDateFromIso(paidPayload.commence_time) === game.officialDate
        && Number.isFinite(paidStartMs)
        && Number.isFinite(matchedStartMs)
        && Number.isFinite(targetStartMs)
        && paidStartMs === matchedStartMs
        && Math.abs(paidStartMs - targetStartMs) <= MLB_SELECTIVE_ODDS_EVENT_MATCH_MAX_START_DELTA_MS;
      if (!identityMatches) {
        results.set(game.gamePk, pendingResult(game, "PROVIDER_FAILED", "ODDS_EVENT_IDENTITY_MISMATCH", {
          eventMatchStatus: "MATCHED", providerEventId: matched.eventId, cacheHitMarketKeys: cacheHitKeys, paidMarketKeysRequested: paidKeys,
        }));
        stopReason = "PAID_PROVIDER_IDENTITY_MISMATCH";
        continue;
      }

      const merged = mergeProviderEvent(cacheEntry?.providerEvent ?? null, paidPayload, paidKeys);
      const marketFetchedAtMs = { ...(cacheEntry?.marketFetchedAtMs ?? {}) };
      for (const key of paidKeys) marketFetchedAtMs[key] = nowMs;
      await coordinator.putEventCache(accountKey, matched.eventId, {
        eventId: matched.eventId,
        providerEvent: structuredClone(merged),
        marketFetchedAtMs,
        updatedAtMs: nowMs,
      });

      if (budgetAfterPaid.status !== "ACTIVE") {
        results.set(game.gamePk, pendingResult(game, "PROVIDER_ACCOUNTING_BLOCKED", budgetAfterPaid.blockReason, {
          eventMatchStatus: "MATCHED",
          providerEventId: matched.eventId,
          cacheHitMarketKeys: cacheHitKeys,
          paidMarketKeysRequested: paidKeys,
          budgetDenialCode: "BUDGET_CONTROLLER_BLOCKED",
        }));
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

    const ordered = input.discovery.games.map((game) => results.get(game.gamePk)).filter((game): game is MlbSelectiveOddsGameResult => game != null);
    const hasBlock = ordered.some((game) => ["BUDGET_DENIED", "PROVIDER_FAILED", "PROVIDER_ACCOUNTING_BLOCKED", "NOT_REACHED_AFTER_BLOCK"].includes(game.status));
    const hasUnresolved = ordered.some((game) => game.status === "EVENT_NOT_FOUND" || game.status === "EVENT_MATCH_AMBIGUOUS");
    return this.finish({
      input,
      generatedAt,
      status: hasBlock ? "BLOCKED" : hasUnresolved ? "PARTIAL" : "COMPLETED",
      stopReason,
      results,
      budget: budget.snapshot(),
      providerCalls,
    });
  }

  private finish(input: {
    input: MlbSelectiveOddsExecutionInput;
    generatedAt: string;
    status: MlbSelectiveOddsRunStatus;
    stopReason: MlbSelectiveOddsStopReason | null;
    results: Map<number, MlbSelectiveOddsGameResult>;
    budget: MlbOddsBudgetSnapshot | null;
    providerCalls: ProviderCalls;
  }): MlbSelectiveOddsAcquisitionResult {
    const games = input.input.discovery.games.map((game) => input.results.get(game.gamePk)).filter((game): game is MlbSelectiveOddsGameResult => game != null);
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
        registryBackedPlanValidation: true,
        thesisDirectionMustExistInScopedDiscoveryEvidence: true,
        exactDiscoveryMarketKeysOnly: true,
        duplicateMarketKeysAllowed: false,
        immutableExecutionSnapshot: true,
        fingerprintCoversCompleteExecutionSnapshot: true,
        rawApiKeyExcludedFromFingerprint: true,
        returnedResultsAreDeepFrozen: true,
        onePaidRequestPerGameMaximum: true,
        paidRequestsSequentialByIntrinsicRank: true,
        sharedCoordinatorRequiredForPaidWork: true,
        stableProviderAccountScopeRequiredForPaidWork: true,
        providerAccountScopeDerivedFromApiKey: false,
        processLocalStateCanAuthorizePaidWork: false,
        crossProcessLockDelegatedToSharedCoordinator: true,
        crossProcessIdempotencyDelegatedToSharedCoordinator: true,
        crossProcessMarketCacheDelegatedToSharedCoordinator: true,
        durableRunJournalBeforeAnyProviderAccess: true,
        unresolvedRunCanRetryProvider: false,
        runJournalCapacityReservedBeforeProvider: true,
        unexpiredRunJournalRecordsEvictedForAdmission: false,
        lowerRankCannotBypassBudgetDeniedHigherRank: true,
        eventMarketsDiscoveryCalls: 0,
        sportOddsCalls: 0,
        executionAndReferenceBooksShareOneRequest: true,
        providerBookmakerCount: MLB_SELECTIVE_ODDS_BOOKMAKERS.length,
        cacheTtlMs: this.cacheTtlMs,
        cacheTtlIsRefreshPolicyNotPolling: true,
        negativeMarketAvailabilityCachedWithinTtl: true,
        idempotencyWindowMs: this.idempotencyTtlMs,
        sameRunIdReplayConsumesPaidCreditsWithinIdempotencyWindow: false,
        runIdPlanMutationAllowed: false,
        sharedEventCacheMaxEntries: MLB_SELECTIVE_ODDS_MAX_SHARED_EVENT_CACHE_ENTRIES,
        sharedRunJournalMaxEntries: MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES,
        sharedStatePruningRequired: true,
        providerRequestTimeoutMs: this.requestTimeoutMs,
        automaticProviderRetries: false,
        eventMatchMaxStartDeltaMs: MLB_SELECTIVE_ODDS_EVENT_MATCH_MAX_START_DELTA_MS,
        paidPayloadMustMatchProbedCommenceTime: true,
        ambiguousEventIdentityCanSpendCredits: false,
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
