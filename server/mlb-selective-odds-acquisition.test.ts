import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MlbSelectiveOddsAcquisitionService,
  MlbSelectiveOddsPlanError,
  MLB_SELECTIVE_ODDS_BOOKMAKERS,
  MLB_SELECTIVE_ODDS_CACHE_TTL_MS,
  MLB_SELECTIVE_ODDS_EVENT_MATCH_MAX_START_DELTA_MS,
  MLB_SELECTIVE_ODDS_IDEMPOTENCY_TTL_MS,
  MLB_SELECTIVE_ODDS_MAX_SHARED_EVENT_CACHE_ENTRIES,
  MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES,
  MLB_SELECTIVE_ODDS_REQUEST_TIMEOUT_MS,
  matchMlbDiscoveryGameToProviderEvent,
  type MlbSelectiveOddsAcquisitionResult,
  type MlbSelectiveOddsExecutionInput,
  type MlbSelectiveOddsSharedCoordinator,
  type MlbSelectiveOddsSharedEventCache,
  type MlbSelectiveOddsSharedEventPrunePolicy,
  type MlbSelectiveOddsSharedRunAdmission,
  type MlbSelectiveOddsSharedRunAdmissionPolicy,
  type MlbSelectiveOddsSharedRunCompleted,
  type MlbSelectiveOddsSharedRunRecord,
} from "./mlb-selective-odds-acquisition";
import {
  MLB_MARKET_DISCOVERY_SCHEMA,
  type MlbMarketDiscoveryGamePlan,
  type MlbMarketDiscoveryPlannedMarket,
  type MlbMarketDiscoveryResult,
} from "./mlb-market-discovery";

const BASE_NOW = "2026-08-10T20:00:00.000Z";
const ACCOUNT_SCOPE = "the-odds-api-primary-account";

class InMemorySharedCoordinator implements MlbSelectiveOddsSharedCoordinator {
  readonly coordinationScope = "PROVIDER_ACCOUNT_SHARED" as const;
  readonly trace: string[] = [];
  failEventCacheWrite = false;
  failCompletionWrite = false;

  private readonly tails = new Map<string, Promise<void>>();
  private readonly journals = new Map<string, Map<string, MlbSelectiveOddsSharedRunRecord>>();
  private readonly caches = new Map<string, Map<string, MlbSelectiveOddsSharedEventCache>>();

  private journal(account: string): Map<string, MlbSelectiveOddsSharedRunRecord> {
    let value = this.journals.get(account);
    if (!value) { value = new Map(); this.journals.set(account, value); }
    return value;
  }

  private cache(account: string): Map<string, MlbSelectiveOddsSharedEventCache> {
    let value = this.caches.get(account);
    if (!value) { value = new Map(); this.caches.set(account, value); }
    return value;
  }

  async runExclusive<T>(accountKey: string, work: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(accountKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => gate);
    this.tails.set(accountKey, tail);
    await prior;
    this.trace.push(`lock:${accountKey}`);
    try { return await work(); }
    finally {
      release();
      if (this.tails.get(accountKey) === tail) this.tails.delete(accountKey);
    }
  }

  async beginRun(
    accountKey: string,
    runId: string,
    fingerprint: string,
    policy: MlbSelectiveOddsSharedRunAdmissionPolicy,
  ): Promise<MlbSelectiveOddsSharedRunAdmission> {
    const journal = this.journal(accountKey);
    for (const [key, record] of journal) {
      if (record.expiresAtMs <= policy.nowMs) journal.delete(key);
    }
    const existing = journal.get(runId);
    if (existing) {
      this.trace.push(`begin-existing:${runId}:${existing.state}`);
      return existing.state === "COMPLETED"
        ? { status: "COMPLETED", record: structuredClone(existing) }
        : { status: "IN_PROGRESS", record: structuredClone(existing) };
    }
    if (journal.size >= policy.maxRunEntries) {
      this.trace.push(`begin-capacity:${runId}`);
      return { status: "CAPACITY_EXHAUSTED", record: null };
    }
    const record = {
      state: "IN_PROGRESS" as const,
      fingerprint,
      admittedAtMs: policy.nowMs,
      expiresAtMs: policy.expiresAtMs,
    };
    journal.set(runId, structuredClone(record));
    this.trace.push(`begin-admitted:${runId}`);
    return { status: "ADMITTED", record: structuredClone(record) };
  }

  async completeRun(
    accountKey: string,
    runId: string,
    fingerprint: string,
    completed: MlbSelectiveOddsSharedRunCompleted,
  ): Promise<void> {
    if (this.failCompletionWrite) throw new Error("test completion persistence failure");
    const current = this.journal(accountKey).get(runId);
    if (!current || current.state !== "IN_PROGRESS" || current.fingerprint !== fingerprint) {
      throw new Error("invalid journal transition");
    }
    this.journal(accountKey).set(runId, structuredClone(completed));
    this.trace.push(`complete:${runId}`);
  }

  async getEventCache(accountKey: string, eventId: string): Promise<MlbSelectiveOddsSharedEventCache | null> {
    const value = this.cache(accountKey).get(eventId);
    return value ? structuredClone(value) : null;
  }

  async putEventCache(accountKey: string, eventId: string, entry: MlbSelectiveOddsSharedEventCache): Promise<void> {
    if (this.failEventCacheWrite) throw new Error("test event-cache persistence failure");
    this.cache(accountKey).set(eventId, structuredClone(entry));
    this.trace.push(`cache:${eventId}`);
  }

  async pruneEventCache(accountKey: string, policy: MlbSelectiveOddsSharedEventPrunePolicy): Promise<void> {
    const cache = this.cache(accountKey);
    for (const [eventId, entry] of cache) {
      if (policy.nowMs - entry.updatedAtMs >= policy.eventCacheTtlMs) cache.delete(eventId);
    }
    const ordered = [...cache.entries()].sort((a, b) =>
      a[1].updatedAtMs - b[1].updatedAtMs || a[0].localeCompare(b[0]));
    while (cache.size > policy.maxEventEntries && ordered.length) {
      const [eventId] = ordered.shift()!;
      cache.delete(eventId);
    }
    this.trace.push("prune-cache");
  }

  seedRun(accountKey: string, runId: string, record: MlbSelectiveOddsSharedRunRecord): void {
    this.journal(accountKey).set(runId, structuredClone(record));
  }

  seedEventCache(accountKey: string, eventId: string, entry: MlbSelectiveOddsSharedEventCache): void {
    this.cache(accountKey).set(eventId, structuredClone(entry));
  }

  journalSize(accountKey = ACCOUNT_SCOPE): number { return this.journal(accountKey).size; }
  eventCacheSize(accountKey = ACCOUNT_SCOPE): number { return this.cache(accountKey).size; }
  getRun(accountKey: string, runId: string): MlbSelectiveOddsSharedRunRecord | undefined {
    const value = this.journal(accountKey).get(runId);
    return value ? structuredClone(value) : undefined;
  }
}

function usageHeaders(remaining: number, used: number, last: number): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-requests-remaining": String(remaining),
    "x-requests-used": String(used),
    "x-requests-last": String(last),
  });
}

function jsonResponse(payload: any, remaining: number, used: number, last: number, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: usageHeaders(remaining, used, last) });
}

function plannedMarket(input: {
  providerMarketKey: string;
  canonicalMarketType: MlbMarketDiscoveryPlannedMarket["canonicalMarketType"];
  scope: MlbMarketDiscoveryPlannedMarket["intrinsicProjectionScope"];
  thesis: MlbMarketDiscoveryPlannedMarket["intrinsicThesisKinds"][number];
}): MlbMarketDiscoveryPlannedMarket {
  const total = input.canonicalMarketType === "TOTAL" || input.canonicalMarketType === "F5_TOTAL";
  return {
    providerMarketKey: input.providerMarketKey,
    displayName: input.canonicalMarketType,
    canonicalMarketType: input.canonicalMarketType,
    period: input.scope === "EARLY_WINDOW" ? "FIRST_5" : "FULL_GAME",
    family: total ? "TOTAL" : input.canonicalMarketType === "RUN_LINE" ? "RUN_LINE" : "MONEYLINE",
    quoteShape: total ? "OVER_UNDER" : input.canonicalMarketType === "RUN_LINE" ? "TEAM_SPREAD" : "TEAM_TWO_WAY",
    acquisition: input.scope === "EARLY_WINDOW" ? "EVENT_ODDS_ONLY" : "SPORT_ODDS_OR_EVENT_ODDS",
    intrinsicProjectionScope: input.scope,
    thesisIntent: total ? "TOTAL" : "SIDE",
    intrinsicThesisKinds: [input.thesis],
    supportingComponents: total ? ["STATCAST_QUALITY", "ADVANCED_CONTEXT"] : ["STATCAST_QUALITY", "DISCIPLINE_SPEED"],
    supportingComponentCount: 2,
    hardRockEvidenceStatus: "EXACT_FIRST_PARTY_PRODUCT_EVIDENCE",
    liveHardRockFloridaDiscoveryRequired: true,
  };
}

const H2H = () => plannedMarket({ providerMarketKey: "h2h", canonicalMarketType: "ML", scope: "FULL_GAME", thesis: "HOME_SIDE" });
const SPREADS = () => plannedMarket({ providerMarketKey: "spreads", canonicalMarketType: "RUN_LINE", scope: "FULL_GAME", thesis: "HOME_SIDE" });
const TOTALS = () => plannedMarket({ providerMarketKey: "totals", canonicalMarketType: "TOTAL", scope: "FULL_GAME", thesis: "TOTAL_OVER" });
const F5_H2H = () => plannedMarket({ providerMarketKey: "h2h_1st_5_innings", canonicalMarketType: "F5_ML", scope: "EARLY_WINDOW", thesis: "HOME_SIDE" });
const F5_TOTALS = () => plannedMarket({ providerMarketKey: "totals_1st_5_innings", canonicalMarketType: "F5_TOTAL", scope: "EARLY_WINDOW", thesis: "TOTAL_OVER" });

function game(input: {
  gamePk: number;
  rank: number;
  home?: string;
  away?: string;
  startTime?: string;
  final?: boolean;
  markets?: MlbMarketDiscoveryPlannedMarket[];
}): MlbMarketDiscoveryGamePlan {
  const final = input.final ?? true;
  const markets = input.markets ?? [H2H()];
  const keys = markets.map((market) => market.providerMarketKey);
  const paid = final && keys.length > 0;
  return {
    gamePk: input.gamePk,
    officialDate: "2026-08-10",
    startTime: input.startTime ?? "2026-08-10T23:10:00.000Z",
    homeTeam: { id: input.gamePk * 10 + 1, name: input.home ?? `Home ${input.gamePk}` },
    awayTeam: { id: input.gamePk * 10 + 2, name: input.away ?? `Away ${input.gamePk}` },
    inputStage: final ? "FINAL" : "PROVISIONAL",
    intrinsicRank: input.rank,
    intrinsicResearchClassification: "GAME_ELITE_RESEARCH_CANDIDATE",
    intrinsicResearchEliteCandidate: true,
    researchEliteThesisKindsByScope: {
      fullGame: markets.filter((market) => market.intrinsicProjectionScope === "FULL_GAME").flatMap((market) => market.intrinsicThesisKinds),
      earlyWindow: markets.filter((market) => market.intrinsicProjectionScope === "EARLY_WINDOW").flatMap((market) => market.intrinsicThesisKinds),
    },
    plannedMarkets: markets,
    plannedProviderMarketKeys: keys,
    paidLookupEligibleNow: paid,
    paidLookupHoldReason: paid ? null : final ? "NO_STRONG_INTRINSIC_MARKET_THESIS" : "OFFICIAL_FINAL_INPUTS_REQUIRED",
    providerMarketKeysToRequestNow: paid ? keys : [],
    worstCaseCreditsPerOneBookmakerRegionEquivalentNow: paid ? keys.length : 0,
  };
}

function discovery(games: MlbMarketDiscoveryGamePlan[]): MlbMarketDiscoveryResult {
  return {
    schemaVersion: MLB_MARKET_DISCOVERY_SCHEMA,
    generatedAt: BASE_NOW,
    date: "2026-08-10",
    sourceIntrinsicEdgeSchemaVersion: "courtedge-p0-mlb-intrinsic-edge.v3",
    sourceShortlistSchemaVersion: "courtedge-p0-mlb-shortlist.v1",
    games,
    catalog: { currentPregamePath: [], researchOnly: [], blockedContractMismatch: [], catalogOnlyNotImplemented: [] },
    summary: {
      intrinsicGames: games.length,
      researchEliteCandidates: games.length,
      gamesWithDiscoveryPlan: games.filter((entry) => entry.plannedMarkets.length > 0).length,
      gamesPaidLookupEligibleNow: games.filter((entry) => entry.paidLookupEligibleNow).length,
      gamesHeldForFinalInputs: games.filter((entry) => entry.paidLookupHoldReason === "OFFICIAL_FINAL_INPUTS_REQUIRED").length,
      gamesWithNoStrongIntrinsicMarketThesis: games.filter((entry) => entry.paidLookupHoldReason === "NO_STRONG_INTRINSIC_MARKET_THESIS").length,
      providerMarketsPlannedNow: games.reduce((sum, entry) => sum + entry.providerMarketKeysToRequestNow.length, 0),
      worstCaseCreditsPerOneBookmakerRegionEquivalentNow: games.reduce((sum, entry) => sum + entry.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0),
    },
    policy: {
      marketNeutral: true,
      firstThreeInningsPriority: false,
      marketOrderCarriesPreference: false,
      currentAnalyticalPathDefinesPaidEligibility: true,
      intrinsicThesisRequiredForPaidLookup: true,
      intrinsicThesisDirectionPreserved: true,
      intrinsicRankPreservedAcrossInputStage: true,
      horizonScopedMarketThesisPlanning: true,
      lateBullpenCanAuthorizeFirstFiveLookup: false,
      researchOnlyMarketsConsumeProviderCredits: false,
      playerPropsQueryEligible: false,
      threeWayCoercionAllowed: false,
      onlyFinalInputsMayAuthorizePaidLookup: true,
      quoteAvailabilityMustBeVerifiedPerEvent: true,
      hardRockFloridaAvailabilityAssumed: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      recommendsBet: false,
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function event(input: { id: string; home: string; away: string; commence?: string }): any {
  return {
    id: input.id,
    sport_key: "baseball_mlb",
    commence_time: input.commence ?? "2026-08-10T23:10:00.000Z",
    home_team: input.home,
    away_team: input.away,
  };
}

function marketPayload(input: { providerEvent: any; marketKeys: string[]; lastUpdate?: string; omitHardRock?: boolean; commence?: string }): any {
  const lastUpdate = input.lastUpdate ?? "2026-08-10T19:59:00.000Z";
  const marketFor = (key: string) => {
    if (key === "h2h" || key === "h2h_1st_5_innings") return { key, last_update: lastUpdate, outcomes: [
      { name: input.providerEvent.home_team, price: -120 }, { name: input.providerEvent.away_team, price: 105 },
    ] };
    if (key === "spreads") return { key, last_update: lastUpdate, outcomes: [
      { name: input.providerEvent.home_team, price: 125, point: -1.5 }, { name: input.providerEvent.away_team, price: -145, point: 1.5 },
    ] };
    if (key === "totals" || key === "totals_1st_5_innings") {
      const point = key === "totals" ? 8.5 : 4.5;
      return { key, last_update: lastUpdate, outcomes: [
        { name: "Over", price: -110, point }, { name: "Under", price: -110, point },
      ] };
    }
    throw new Error(`test market not implemented: ${key}`);
  };
  return {
    ...input.providerEvent,
    commence_time: input.commence ?? input.providerEvent.commence_time,
    bookmakers: MLB_SELECTIVE_ODDS_BOOKMAKERS
      .filter((key) => !(input.omitHardRock && key === "hardrockbet_fl"))
      .map((key) => ({ key, title: key, last_update: lastUpdate, markets: input.marketKeys.map(marketFor) })),
  };
}

function inputFor(runId: string, plan: MlbMarketDiscoveryResult, apiKey = "secret", scope = ACCOUNT_SCOPE): MlbSelectiveOddsExecutionInput {
  return { runId, providerAccountScopeKey: scope, discovery: plan, maxRunCredits: 8, reserveCredits: 10, apiKey };
}

function standardFetch(providerGame: any, options: { omitHardRock?: boolean; paidCommence?: string } = {}) {
  let remaining = 100;
  let used = 10;
  let paidCalls = 0;
  let probeCalls = 0;
  const fetchFn = async (request: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.ok(init?.signal instanceof AbortSignal);
    const url = String(request);
    if (url.includes("/events/?")) {
      probeCalls += 1;
      return jsonResponse([providerGame], remaining, used, 0);
    }
    paidCalls += 1;
    const markets = new URL(url).searchParams.get("markets")?.split(",") ?? [];
    remaining -= markets.length;
    used += markets.length;
    return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: markets, omitHardRock: options.omitHardRock, commence: options.paidCommence }), remaining, used, markets.length);
  };
  return { fetchFn, paidCalls: () => paidCalls, probeCalls: () => probeCalls };
}

test("zero paid work needs no coordinator and makes zero provider calls", async () => {
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({ fetchFn: async () => { calls += 1; throw new Error("unexpected"); }, now: () => new Date(BASE_NOW) });
  const result = await service.acquire(inputFor("no-paid", discovery([game({ gamePk: 1, rank: 1, final: false })]), "", ""));
  assert.equal(result.status, "NO_PAID_WORK");
  assert.deepEqual(result.providerCalls, { zeroCostEventsProbe: 0, paidEventOdds: 0, eventMarkets: 0, sportOdds: 0 });
  assert.equal(calls, 0);
});

test("paid work without shared coordinator fails closed before provider", async () => {
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({ fetchFn: async () => { calls += 1; throw new Error("unexpected"); }, now: () => new Date(BASE_NOW) });
  const result = await service.acquire(inputFor("no-coordinator", discovery([game({ gamePk: 2, rank: 1 })])));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stopReason, "SHARED_COORDINATOR_REQUIRED");
  assert.equal(calls, 0);
});

test("missing stable provider account scope fails closed before provider", async () => {
  let calls = 0;
  const coordinator = new InMemorySharedCoordinator();
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, fetchFn: async () => { calls += 1; throw new Error("unexpected"); }, now: () => new Date(BASE_NOW) });
  const result = await service.acquire(inputFor("missing-scope", discovery([game({ gamePk: 3, rank: 1 })]), "secret", ""));
  assert.equal(result.stopReason, "PROVIDER_ACCOUNT_SCOPE_REQUIRED");
  assert.equal(calls, 0);
});

test("missing API key fails closed before provider", async () => {
  let calls = 0;
  const coordinator = new InMemorySharedCoordinator();
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, fetchFn: async () => { calls += 1; throw new Error("unexpected"); }, now: () => new Date(BASE_NOW) });
  const result = await service.acquire(inputFor("missing-key", discovery([game({ gamePk: 4, rank: 1 })]), ""));
  assert.equal(result.stopReason, "ODDS_API_KEY_REQUIRED");
  assert.equal(calls, 0);
});

test("durable IN_PROGRESS journal is admitted before even the zero-cost provider probe", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-order", home: "New York Mets", away: "Atlanta Braves" });
  const fetch = standardFetch(providerGame);
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: async (...args) => {
    coordinator.trace.push("provider-fetch");
    return fetch.fetchFn(...args);
  } });
  await service.acquire(inputFor("journal-before-provider", discovery([game({ gamePk: 11, rank: 1, home: "New York Mets", away: "Atlanta Braves" })])));
  const admitted = coordinator.trace.indexOf("begin-admitted:journal-before-provider");
  const provider = coordinator.trace.indexOf("provider-fetch");
  assert.ok(admitted >= 0 && provider > admitted);
  assert.equal(coordinator.getRun(ACCOUNT_SCOPE, "journal-before-provider")?.state, "COMPLETED");
});

test("exact finalist plan fetches all five currently authorized mappings in one event request", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const markets = [H2H(), SPREADS(), TOTALS(), F5_H2H(), F5_TOTALS()];
  const g = game({ gamePk: 12, rank: 1, home: "New York Mets", away: "Atlanta Braves", markets });
  const providerGame = event({ id: "evt-all-five", home: "New York Mets", away: "Atlanta Braves" });
  const seenPaidMarkets: string[][] = [];
  const service = new MlbSelectiveOddsAcquisitionService({
    coordinator,
    now: () => new Date(BASE_NOW),
    fetchFn: async (request, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      const url = String(request);
      if (url.includes("/events/?")) return jsonResponse([providerGame], 100, 20, 0);
      const parsed = new URL(url);
      const requested = parsed.searchParams.get("markets")?.split(",") ?? [];
      seenPaidMarkets.push(requested);
      assert.deepEqual(parsed.searchParams.get("bookmakers")?.split(","), [...MLB_SELECTIVE_ODDS_BOOKMAKERS]);
      return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: requested }), 95, 25, 5);
    },
  });
  const execution = inputFor("all-five", discovery([g]));
  execution.maxRunCredits = 5;
  const result = await service.acquire(execution);
  assert.deepEqual(seenPaidMarkets, [["h2h", "h2h_1st_5_innings", "spreads", "totals", "totals_1st_5_innings"]]);
  assert.equal(result.games[0].status, "FETCHED");
  assert.equal(result.games[0].quoteMarkets.length, 5);
  assert.equal(result.policy.providerRequestTimeoutMs, MLB_SELECTIVE_ODDS_REQUEST_TIMEOUT_MS);
  assert.equal(result.policy.onePaidRequestPerGameMaximum, true);
});

test("same runId replay survives API-key rotation inside the same stable account scope", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-rotate", home: "Seattle Mariners", away: "Texas Rangers" });
  const fetch = standardFetch(providerGame);
  const serviceA = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const plan = discovery([game({ gamePk: 20, rank: 1, home: "Seattle Mariners", away: "Texas Rangers" })]);
  const first = await serviceA.acquire(inputFor("rotate-run", plan, "old-key"));
  const callsAfterFirst = fetch.probeCalls() + fetch.paidCalls();
  const serviceB = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const replay = await serviceB.acquire(inputFor("rotate-run", plan, "new-key"));
  assert.deepEqual(replay, first);
  assert.equal(fetch.probeCalls() + fetch.paidCalls(), callsAfterFirst);
  assert.equal(replay.policy.providerAccountScopeDerivedFromApiKey, false);
});

test("same runId with changed team IDs rejects without provider access", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-ids", home: "San Diego Padres", away: "San Francisco Giants" });
  const fetch = standardFetch(providerGame);
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const original = discovery([game({ gamePk: 21, rank: 1, home: "San Diego Padres", away: "San Francisco Giants" })]);
  await service.acquire(inputFor("id-bound", original));
  const changed = structuredClone(original);
  (changed.games[0].homeTeam as any).id += 999;
  const calls = fetch.probeCalls() + fetch.paidCalls();
  await assert.rejects(
    () => service.acquire(inputFor("id-bound", changed)),
    (error: any) => error instanceof MlbSelectiveOddsPlanError && error.code === "RUN_ID_REUSED_WITH_DIFFERENT_PLAN",
  );
  assert.equal(fetch.probeCalls() + fetch.paidCalls(), calls);
});

test("caller mutation after acquire cannot alter the immutable queued execution snapshot", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-mutation", home: "Chicago Cubs", away: "St. Louis Cardinals" });
  const requested: string[][] = [];
  const service = new MlbSelectiveOddsAcquisitionService({
    coordinator,
    now: () => new Date(BASE_NOW),
    fetchFn: async (request) => {
      const url = String(request);
      if (url.includes("/events/?")) return jsonResponse([providerGame], 100, 10, 0);
      const markets = new URL(url).searchParams.get("markets")?.split(",") ?? [];
      requested.push(markets);
      return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: markets }), 99, 11, 1);
    },
  });
  const plan = discovery([game({ gamePk: 22, rank: 1, home: "Chicago Cubs", away: "St. Louis Cardinals" })]);
  const execution = inputFor("immutable-input", plan);
  const promise = service.acquire(execution);
  (execution.discovery.games[0].providerMarketKeysToRequestNow as string[]).push("totals");
  (execution.discovery.games[0].homeTeam as any).id = 999999;
  const result = await promise;
  assert.deepEqual(requested, [["h2h"]]);
  assert.notEqual(result.games[0].homeTeam.id, 999999);
});

test("returned completed result is deeply frozen and cannot poison replay", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-frozen", home: "Houston Astros", away: "Los Angeles Angels" });
  const fetch = standardFetch(providerGame);
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const plan = discovery([game({ gamePk: 23, rank: 1, home: "Houston Astros", away: "Los Angeles Angels" })]);
  const first = await service.acquire(inputFor("frozen-run", plan));
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.games));
  assert.ok(Object.isFrozen(first.games[0]));
  assert.throws(() => { (first.games[0] as any).status = "BROKEN"; });
  const replay = await service.acquire(inputFor("frozen-run", plan));
  assert.equal(replay.games[0].status, "FETCHED");
});

test("provider success followed by cache persistence failure leaves IN_PROGRESS and retry performs zero provider calls", async () => {
  const coordinator = new InMemorySharedCoordinator();
  coordinator.failEventCacheWrite = true;
  const providerGame = event({ id: "evt-crash", home: "Boston Red Sox", away: "New York Yankees" });
  const fetch = standardFetch(providerGame);
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const execution = inputFor("crash-barrier", discovery([game({ gamePk: 24, rank: 1, home: "Boston Red Sox", away: "New York Yankees" })]));
  await assert.rejects(() => service.acquire(execution), /event-cache persistence failure/);
  assert.equal(fetch.paidCalls(), 1);
  assert.equal(coordinator.getRun(ACCOUNT_SCOPE, "crash-barrier")?.state, "IN_PROGRESS");
  coordinator.failEventCacheWrite = false;
  const calls = fetch.probeCalls() + fetch.paidCalls();
  const retry = await service.acquire(execution);
  assert.equal(retry.status, "BLOCKED");
  assert.equal(retry.stopReason, "DURABLE_RUN_RECOVERY_REQUIRED");
  assert.equal(fetch.probeCalls() + fetch.paidCalls(), calls);
});

test("journal capacity exhaustion blocks before any provider call and never evicts unexpired records", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const nowMs = Date.parse(BASE_NOW);
  for (let i = 0; i < MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES; i += 1) {
    coordinator.seedRun(ACCOUNT_SCOPE, `occupied-${i}`, {
      state: "IN_PROGRESS",
      fingerprint: `fp-${i}`,
      admittedAtMs: nowMs,
      expiresAtMs: nowMs + MLB_SELECTIVE_ODDS_IDEMPOTENCY_TTL_MS,
    });
  }
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: async () => { calls += 1; throw new Error("unexpected"); } });
  const result = await service.acquire(inputFor("capacity-new", discovery([game({ gamePk: 25, rank: 1 })])));
  assert.equal(result.stopReason, "SHARED_RUN_JOURNAL_CAPACITY_EXHAUSTED");
  assert.equal(calls, 0);
  assert.equal(coordinator.journalSize(), MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES);
});

test("expired journal records are pruned by atomic admission and allow a new run", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const nowMs = Date.parse(BASE_NOW);
  for (let i = 0; i < MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES; i += 1) {
    coordinator.seedRun(ACCOUNT_SCOPE, `expired-${i}`, {
      state: "IN_PROGRESS",
      fingerprint: `expired-fp-${i}`,
      admittedAtMs: nowMs - MLB_SELECTIVE_ODDS_IDEMPOTENCY_TTL_MS - 10,
      expiresAtMs: nowMs - 1,
    });
  }
  const providerGame = event({ id: "evt-expired", home: "Home 26", away: "Away 26" });
  const fetch = standardFetch(providerGame);
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const result = await service.acquire(inputFor("after-expiry", discovery([game({ gamePk: 26, rank: 1 })])));
  assert.equal(result.status, "COMPLETED");
  assert.equal(coordinator.journalSize(), 1);
  assert.equal(fetch.paidCalls(), 1);
});

test("shared coordinator serializes distinct service instances and coalesces market cache misses", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-shared-cache", home: "Pittsburgh Pirates", away: "Cincinnati Reds" });
  let remaining = 100;
  let used = 30;
  let probeCalls = 0;
  let paidCalls = 0;
  const fetchFn = async (request: string | URL | Request): Promise<Response> => {
    const url = String(request);
    if (url.includes("/events/?")) { probeCalls += 1; return jsonResponse([providerGame], remaining, used, 0); }
    paidCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    remaining -= 1; used += 1;
    return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: ["h2h"] }), remaining, used, 1);
  };
  const serviceA = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn });
  const serviceB = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn });
  const plan = discovery([game({ gamePk: 27, rank: 1, home: "Pittsburgh Pirates", away: "Cincinnati Reds" })]);
  const [a, b] = await Promise.all([
    serviceA.acquire(inputFor("shared-a", plan)),
    serviceB.acquire(inputFor("shared-b", plan)),
  ]);
  assert.equal(paidCalls, 1);
  assert.equal(probeCalls, 2);
  assert.deepEqual([a.games[0].status, b.games[0].status], ["FETCHED", "CACHE_HIT"]);
});

test("distinct runs re-probe provider balance after prior run and preserve reserve", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const eventA = event({ id: "evt-reserve-a", home: "Milwaukee Brewers", away: "Chicago White Sox" });
  const eventB = event({ id: "evt-reserve-b", home: "Washington Nationals", away: "Miami Marlins" });
  let remaining = 13;
  let used = 100;
  let paidCalls = 0;
  const fetchFn = async (request: string | URL | Request): Promise<Response> => {
    const url = String(request);
    if (url.includes("/events/?")) return jsonResponse([eventA, eventB], remaining, used, 0);
    paidCalls += 1;
    const markets = new URL(url).searchParams.get("markets")?.split(",") ?? [];
    remaining -= markets.length; used += markets.length;
    const providerEvent = url.includes("evt-reserve-a") ? eventA : eventB;
    return jsonResponse(marketPayload({ providerEvent, marketKeys: markets }), remaining, used, markets.length);
  };
  const serviceA = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn });
  const serviceB = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn });
  const planA = discovery([game({ gamePk: 28, rank: 1, home: "Milwaukee Brewers", away: "Chicago White Sox", markets: [H2H(), TOTALS()] })]);
  const planB = discovery([game({ gamePk: 29, rank: 1, home: "Washington Nationals", away: "Miami Marlins", markets: [H2H(), TOTALS()] })]);
  const a = inputFor("reserve-a", planA); a.maxRunCredits = 2; a.reserveCredits = 10;
  const b = inputFor("reserve-b", planB); b.maxRunCredits = 2; b.reserveCredits = 10;
  const [first, second] = await Promise.all([serviceA.acquire(a), serviceB.acquire(b)]);
  assert.equal(first.status, "COMPLETED");
  assert.equal(second.status, "BLOCKED");
  assert.equal(second.games[0].budgetDenialCode, "PROVIDER_REMAINING_INSUFFICIENT");
  assert.equal(paidCalls, 1);
  assert.equal(remaining, 11);
});

test("budget denial at the highest intrinsic rank stops all lower-ranked paid work", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const top = game({ gamePk: 30, rank: 1, home: "Top Home", away: "Top Away", markets: [H2H(), SPREADS(), TOTALS()] });
  const lower = game({ gamePk: 31, rank: 2, home: "Lower Home", away: "Lower Away" });
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    coordinator,
    now: () => new Date(BASE_NOW),
    fetchFn: async () => {
      calls += 1;
      return jsonResponse([
        event({ id: "evt-top", home: "Top Home", away: "Top Away" }),
        event({ id: "evt-lower", home: "Lower Home", away: "Lower Away" }),
      ], 100, 10, 0);
    },
  });
  const execution = inputFor("budget-stop", discovery([top, lower])); execution.maxRunCredits = 2;
  const result = await service.acquire(execution);
  assert.equal(calls, 1);
  assert.equal(result.stopReason, "RUN_BUDGET_DENIED_AT_HIGHER_RANK");
  assert.equal(result.games[0].status, "BUDGET_DENIED");
  assert.equal(result.games[1].status, "NOT_REACHED_AFTER_BLOCK");
});

test("ambiguous or far doubleheader identity spends zero paid credits", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const target = game({ gamePk: 32, rank: 1, home: "Detroit Tigers", away: "Cleveland Guardians", startTime: "2026-08-10T20:00:00.000Z" });
  const first = event({ id: "dh-a", home: "Detroit Tigers", away: "Cleveland Guardians", commence: "2026-08-10T19:00:00.000Z" });
  const second = event({ id: "dh-b", home: "Detroit Tigers", away: "Cleveland Guardians", commence: "2026-08-10T21:00:00.000Z" });
  assert.equal(matchMlbDiscoveryGameToProviderEvent(target, [first, second]).status, "AMBIGUOUS");
  const far = event({ id: "dh-far", home: "Detroit Tigers", away: "Cleveland Guardians", commence: "2026-08-10T23:10:00.000Z" });
  assert.equal(matchMlbDiscoveryGameToProviderEvent(target, [far]).status, "AMBIGUOUS");
  assert.equal(MLB_SELECTIVE_ODDS_EVENT_MATCH_MAX_START_DELTA_MS, 90 * 60 * 1000);
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: async () => { calls += 1; return jsonResponse([first, second], 100, 10, 0); } });
  const result = await service.acquire(inputFor("doubleheader", discovery([target])));
  assert.equal(calls, 1);
  assert.equal(result.providerCalls.paidEventOdds, 0);
  assert.equal(result.games[0].status, "EVENT_MATCH_AMBIGUOUS");
});

test("fresh per-market cache tops up only missing keys and negative-cache avoids re-buy", async () => {
  const coordinator = new InMemorySharedCoordinator();
  let nowMs = Date.parse(BASE_NOW);
  const providerGame = event({ id: "evt-cache", home: "Seattle Mariners", away: "Texas Rangers" });
  const paidMarkets: string[][] = [];
  let remaining = 100; let used = 20;
  const fetchFn = async (request: string | URL | Request): Promise<Response> => {
    const url = String(request);
    if (url.includes("/events/?")) return jsonResponse([providerGame], remaining, used, 0);
    const markets = new URL(url).searchParams.get("markets")?.split(",") ?? [];
    paidMarkets.push(markets);
    remaining -= markets.length; used += markets.length;
    const payload = markets.includes("totals")
      ? { ...providerGame, bookmakers: [] }
      : marketPayload({ providerEvent: providerGame, marketKeys: markets });
    return jsonResponse(payload, remaining, used, markets.length);
  };
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(nowMs), fetchFn });
  const firstPlan = discovery([game({ gamePk: 33, rank: 1, home: "Seattle Mariners", away: "Texas Rangers", markets: [H2H()] })]);
  await service.acquire(inputFor("cache-1", firstPlan));
  nowMs += 30_000;
  const expanded = discovery([game({ gamePk: 33, rank: 1, home: "Seattle Mariners", away: "Texas Rangers", markets: [H2H(), TOTALS()] })]);
  const second = await service.acquire(inputFor("cache-2", expanded));
  assert.deepEqual(second.games[0].cacheHitMarketKeys, ["h2h"]);
  assert.deepEqual(second.games[0].paidMarketKeysRequested, ["totals"]);
  nowMs += 30_000;
  const third = await service.acquire(inputFor("cache-3", expanded));
  assert.equal(third.games[0].status, "CACHE_HIT");
  assert.deepEqual(paidMarkets, [["h2h"], ["totals"]]);
  assert.equal(third.games[0].usableForMarketEdge, true);
});

test("reference-only quotes never become executable market-edge input", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-reference", home: "Arizona Diamondbacks", away: "Colorado Rockies" });
  const fetch = standardFetch(providerGame, { omitHardRock: true });
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const result = await service.acquire(inputFor("reference-only", discovery([game({ gamePk: 34, rank: 1, home: "Arizona Diamondbacks", away: "Colorado Rockies" })])));
  assert.equal(result.games[0].usableForMarketEdge, false);
  assert.ok(result.games[0].quoteMarkets.every((market) => market.availability !== "EXECUTABLE"));
});

test("paid payload commence time must exactly match the event selected by the probe", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const providerGame = event({ id: "evt-time", home: "Toronto Blue Jays", away: "Baltimore Orioles" });
  const fetch = standardFetch(providerGame, { paidCommence: "2026-08-10T23:20:00.000Z" });
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: fetch.fetchFn });
  const result = await service.acquire(inputFor("paid-time", discovery([game({ gamePk: 35, rank: 1, home: "Toronto Blue Jays", away: "Baltimore Orioles" })])));
  assert.equal(result.stopReason, "PAID_PROVIDER_IDENTITY_MISMATCH");
  assert.equal(result.games[0].usableForMarketEdge, false);
});

test("Registry mapping and scoped thesis direction cannot be forged", async () => {
  const coordinator = new InMemorySharedCoordinator();
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({ coordinator, now: () => new Date(BASE_NOW), fetchFn: async () => { calls += 1; throw new Error("unexpected"); } });
  const forgedKey = discovery([game({ gamePk: 36, rank: 1 })]);
  (forgedKey.games[0].plannedMarkets[0] as any).providerMarketKey = "pitcher_strikeouts";
  (forgedKey.games[0].plannedProviderMarketKeys as string[])[0] = "pitcher_strikeouts";
  (forgedKey.games[0].providerMarketKeysToRequestNow as string[])[0] = "pitcher_strikeouts";
  await assert.rejects(() => service.acquire(inputFor("forged-key", forgedKey)), (error: any) => error.code === "REGISTRY_MARKET_MAPPING_MISMATCH");

  const forgedDirection = discovery([game({ gamePk: 37, rank: 1 })]);
  (forgedDirection.games[0].plannedMarkets[0].intrinsicThesisKinds as any)[0] = "AWAY_SIDE";
  await assert.rejects(() => service.acquire(inputFor("forged-direction", forgedDirection)), (error: any) => error.code === "MARKET_THESIS_NOT_AUTHORIZED_BY_SCOPE");
  assert.equal(calls, 0);
});

test("paid network failure is conservatively charged and blocks lower rank", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const top = game({ gamePk: 38, rank: 1, home: "Houston Astros", away: "Los Angeles Angels", markets: [H2H(), TOTALS()] });
  const lower = game({ gamePk: 39, rank: 2, home: "Minnesota Twins", away: "Kansas City Royals" });
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    coordinator,
    now: () => new Date(BASE_NOW),
    fetchFn: async (request) => {
      calls += 1;
      if (String(request).includes("/events/?")) return jsonResponse([
        event({ id: "evt-network-1", home: "Houston Astros", away: "Los Angeles Angels" }),
        event({ id: "evt-network-2", home: "Minnesota Twins", away: "Kansas City Royals" }),
      ], 100, 50, 0);
      throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    },
  });
  const result = await service.acquire(inputFor("network-fail", discovery([top, lower])));
  assert.equal(calls, 2);
  assert.equal(result.stopReason, "PAID_PROVIDER_REQUEST_FAILED");
  assert.equal(result.games[1].status, "NOT_REACHED_AFTER_BLOCK");
  assert.equal(result.budget?.runCreditsCharged, 2);
  assert.equal(result.budget?.operations[0]?.accounting, "CONSERVATIVE_WORST_CASE");
});

test("event cache pruning enforces TTL and deterministic max entries", async () => {
  const coordinator = new InMemorySharedCoordinator();
  const nowMs = Date.parse(BASE_NOW);
  for (let i = 0; i < 4; i += 1) {
    coordinator.seedEventCache(ACCOUNT_SCOPE, `cache-${i}`, {
      eventId: `cache-${i}`,
      providerEvent: {},
      marketFetchedAtMs: { h2h: nowMs - i * 1000 },
      updatedAtMs: nowMs - i * 1000,
    });
  }
  await coordinator.pruneEventCache(ACCOUNT_SCOPE, { nowMs, eventCacheTtlMs: MLB_SELECTIVE_ODDS_CACHE_TTL_MS, maxEventEntries: 2 });
  assert.equal(coordinator.eventCacheSize(), 2);
  coordinator.seedEventCache(ACCOUNT_SCOPE, "expired-cache", {
    eventId: "expired-cache", providerEvent: {}, marketFetchedAtMs: { h2h: nowMs - MLB_SELECTIVE_ODDS_CACHE_TTL_MS - 1 }, updatedAtMs: nowMs - MLB_SELECTIVE_ODDS_CACHE_TTL_MS - 1,
  });
  await coordinator.pruneEventCache(ACCOUNT_SCOPE, { nowMs, eventCacheTtlMs: MLB_SELECTIVE_ODDS_CACHE_TTL_MS, maxEventEntries: MLB_SELECTIVE_ODDS_MAX_SHARED_EVENT_CACHE_ENTRIES });
  assert.equal((await coordinator.getEventCache(ACCOUNT_SCOPE, "expired-cache")), null);
});

test("source remains internal, explicit, no polling/retries/env-secret reads, and exposes v6 safety policy", () => {
  const source = fs.readFileSync(new URL("./mlb-selective-odds-acquisition.ts", import.meta.url), "utf8");
  for (const forbidden of ["setInterval(", "setTimeout(", "process.env", "app.get(", "app.post(", "router.get(", "router.post(", "private static providerTail", "private static readonly eventCache", "providerAccountKey(apiKey"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  for (const required of [
    "MlbSelectiveOddsSharedCoordinator",
    'coordinationScope: "PROVIDER_ACCOUNT_SHARED"',
    "providerAccountScopeKey",
    'state: "IN_PROGRESS"',
    'state: "COMPLETED"',
    "beginRun(",
    "completeRun(",
    '"DURABLE_RUN_RECOVERY_REQUIRED"',
    '"SHARED_RUN_JOURNAL_CAPACITY_EXHAUSTED"',
    "durableRunJournalBeforeAnyProviderAccess: true",
    "stableProviderAccountScopeRequiredForPaidWork: true",
    "providerAccountScopeDerivedFromApiKey: false",
    "runJournalCapacityReservedBeforeProvider: true",
    "unexpiredRunJournalRecordsEvictedForAdmission: false",
    "immutableExecutionSnapshot: true",
    "fingerprintCoversCompleteExecutionSnapshot: true",
    "rawApiKeyExcludedFromFingerprint: true",
    "returnedResultsAreDeepFrozen: true",
    "sameRunIdReplayConsumesPaidCreditsWithinIdempotencyWindow: false",
  ]) assert.equal(source.includes(required), true, required);
  assert.equal(MLB_SELECTIVE_ODDS_IDEMPOTENCY_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(MLB_SELECTIVE_ODDS_MAX_SHARED_RUN_JOURNAL_ENTRIES, 1024);
});
