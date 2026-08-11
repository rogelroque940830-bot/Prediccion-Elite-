import assert from "node:assert/strict";
import test from "node:test";
import {
  MlbSelectiveOddsAcquisitionService,
  MlbSelectiveOddsPlanError,
  MLB_SELECTIVE_ODDS_BOOKMAKERS,
  MLB_SELECTIVE_ODDS_CACHE_TTL_MS,
  buildMlbSelectiveEventOddsUrl,
  matchMlbDiscoveryGameToProviderEvent,
} from "./mlb-selective-odds-acquisition";
import {
  MLB_MARKET_DISCOVERY_SCHEMA,
  type MlbMarketDiscoveryGamePlan,
  type MlbMarketDiscoveryPlannedMarket,
  type MlbMarketDiscoveryResult,
} from "./mlb-market-discovery";

const BASE_NOW = "2026-08-10T20:00:00.000Z";

function usageHeaders(remaining: number, used: number, last: number): Headers {
  return new Headers({
    "content-type": "application/json",
    "x-requests-remaining": String(remaining),
    "x-requests-used": String(used),
    "x-requests-last": String(last),
  });
}

function jsonResponse(payload: any, remaining: number, used: number, last: number, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: usageHeaders(remaining, used, last),
  });
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

const H2H = () => plannedMarket({
  providerMarketKey: "h2h",
  canonicalMarketType: "ML",
  scope: "FULL_GAME",
  thesis: "HOME_SIDE",
});
const SPREADS = () => plannedMarket({
  providerMarketKey: "spreads",
  canonicalMarketType: "RUN_LINE",
  scope: "FULL_GAME",
  thesis: "HOME_SIDE",
});
const TOTALS = () => plannedMarket({
  providerMarketKey: "totals",
  canonicalMarketType: "TOTAL",
  scope: "FULL_GAME",
  thesis: "TOTAL_OVER",
});
const F5_H2H = () => plannedMarket({
  providerMarketKey: "h2h_1st_5_innings",
  canonicalMarketType: "F5_ML",
  scope: "EARLY_WINDOW",
  thesis: "HOME_SIDE",
});

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
  const keys = markets.map((market) => market.providerMarketKey).sort();
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
    catalog: {
      currentPregamePath: [],
      researchOnly: [],
      blockedContractMismatch: [],
      catalogOnlyNotImplemented: [],
    },
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

function event(input: {
  id: string;
  home: string;
  away: string;
  commence?: string;
}): any {
  return {
    id: input.id,
    sport_key: "baseball_mlb",
    commence_time: input.commence ?? "2026-08-10T23:10:00.000Z",
    home_team: input.home,
    away_team: input.away,
  };
}

function marketPayload(input: {
  providerEvent: any;
  marketKeys: string[];
  lastUpdate?: string;
  omitHardRock?: boolean;
}): any {
  const lastUpdate = input.lastUpdate ?? "2026-08-10T19:59:00.000Z";
  const marketFor = (key: string) => {
    if (key === "h2h" || key === "h2h_1st_5_innings") {
      return {
        key,
        last_update: lastUpdate,
        outcomes: [
          { name: input.providerEvent.home_team, price: -120 },
          { name: input.providerEvent.away_team, price: 105 },
        ],
      };
    }
    if (key === "spreads") {
      return {
        key,
        last_update: lastUpdate,
        outcomes: [
          { name: input.providerEvent.home_team, price: 125, point: -1.5 },
          { name: input.providerEvent.away_team, price: -145, point: 1.5 },
        ],
      };
    }
    if (key === "totals") {
      return {
        key,
        last_update: lastUpdate,
        outcomes: [
          { name: "Over", price: -110, point: 8.5 },
          { name: "Under", price: -110, point: 8.5 },
        ],
      };
    }
    throw new Error(`test market not implemented: ${key}`);
  };
  const books = MLB_SELECTIVE_ODDS_BOOKMAKERS
    .filter((key) => !(input.omitHardRock && key === "hardrockbet_fl"))
    .map((key) => ({
      key,
      title: key,
      last_update: lastUpdate,
      markets: input.marketKeys.map(marketFor),
    }));
  return {
    ...input.providerEvent,
    bookmakers: books,
  };
}

test("zero paid-eligible games cause zero provider calls, even with no API key", async () => {
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    fetchFn: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
    now: () => new Date(BASE_NOW),
  });
  const result = await service.acquire({
    runId: "no-paid-work",
    discovery: discovery([game({ gamePk: 1, rank: 1, final: false })]),
    maxRunCredits: 0,
    reserveCredits: 100,
    apiKey: "",
  });
  assert.equal(result.status, "NO_PAID_WORK");
  assert.equal(result.providerCalls.zeroCostEventsProbe, 0);
  assert.equal(result.providerCalls.paidEventOdds, 0);
  assert.equal(calls, 0);
  assert.equal(result.games[0].status, "HELD_BY_DISCOVERY");
});

test("finalist-only acquisition sends one event request with exactly the thesis-backed market keys", async () => {
  const g1 = game({ gamePk: 11, rank: 1, home: "New York Mets", away: "Atlanta Braves", markets: [H2H(), F5_H2H()] });
  const g2 = game({ gamePk: 12, rank: 2, home: "Chicago Cubs", away: "St. Louis Cardinals", final: false, markets: [H2H()] });
  const providerGame = event({ id: "evt-11", home: "New York Mets", away: "Atlanta Braves" });
  const unrelated = event({ id: "evt-x", home: "Boston Red Sox", away: "Toronto Blue Jays" });
  const urls: string[] = [];
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(BASE_NOW),
    fetchFn: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/events/?")) return jsonResponse([providerGame, unrelated], 100, 50, 0);
      const parsed = new URL(url);
      assert.equal(parsed.pathname.includes("/events/evt-11/odds/"), true);
      assert.deepEqual(parsed.searchParams.get("markets")?.split(","), ["h2h", "h2h_1st_5_innings"]);
      assert.deepEqual(parsed.searchParams.get("bookmakers")?.split(","), [...MLB_SELECTIVE_ODDS_BOOKMAKERS]);
      assert.equal(parsed.searchParams.has("regions"), false);
      return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: ["h2h", "h2h_1st_5_innings"] }), 98, 52, 2);
    },
  });

  const result = await service.acquire({
    runId: "exact-finalist",
    discovery: discovery([g1, g2]),
    maxRunCredits: 4,
    reserveCredits: 20,
    apiKey: "secret",
  });
  assert.equal(urls.length, 2);
  assert.equal(result.providerCalls.zeroCostEventsProbe, 1);
  assert.equal(result.providerCalls.paidEventOdds, 1);
  assert.equal(result.providerCalls.eventMarkets, 0);
  assert.equal(result.providerCalls.sportOdds, 0);
  assert.equal(result.games[0].status, "FETCHED");
  assert.equal(result.games[0].providerEventId, "evt-11");
  assert.deepEqual(result.games[0].paidMarketKeysRequested, ["h2h", "h2h_1st_5_innings"]);
  assert.equal(result.games[0].marketTheses.some((entry) => entry.intrinsicThesisKinds.includes("HOME_SIDE")), true);
  assert.equal(result.games[0].quoteMarkets.length, 2);
  assert.equal(result.games[0].quoteMarkets.every((market) => market.availability === "EXECUTABLE"), true);
  assert.equal(result.games[0].usableForMarketEdge, true);
  assert.equal(result.games[1].status, "HELD_BY_DISCOVERY");
  assert.equal(result.budget?.runCreditsCharged, 2);
});

test("budget denial at a higher intrinsic rank stops lower-ranked paid work instead of shopping around the budget", async () => {
  const top = game({ gamePk: 21, rank: 1, home: "Top Home", away: "Top Away", markets: [H2H(), SPREADS(), TOTALS()] });
  const lower = game({ gamePk: 22, rank: 2, home: "Lower Home", away: "Lower Away", markets: [H2H()] });
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(BASE_NOW),
    fetchFn: async () => {
      calls += 1;
      return jsonResponse([
        event({ id: "evt-21", home: "Top Home", away: "Top Away" }),
        event({ id: "evt-22", home: "Lower Home", away: "Lower Away" }),
      ], 100, 10, 0);
    },
  });
  const result = await service.acquire({
    runId: "budget-stop",
    discovery: discovery([top, lower]),
    maxRunCredits: 2,
    reserveCredits: 10,
    apiKey: "secret",
  });
  assert.equal(calls, 1);
  assert.equal(result.providerCalls.paidEventOdds, 0);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stopReason, "RUN_BUDGET_DENIED_AT_HIGHER_RANK");
  assert.equal(result.games[0].status, "BUDGET_DENIED");
  assert.equal(result.games[0].budgetDenialCode, "RUN_BUDGET_INSUFFICIENT");
  assert.equal(result.games[1].status, "NOT_REACHED_AFTER_BLOCK");
});

test("ambiguous same-day doubleheader identity fails closed before any paid request", async () => {
  const target = game({
    gamePk: 31,
    rank: 1,
    home: "Detroit Tigers",
    away: "Cleveland Guardians",
    startTime: "2026-08-10T20:00:00.000Z",
  });
  const first = event({ id: "dh-a", home: "Detroit Tigers", away: "Cleveland Guardians", commence: "2026-08-10T19:00:00.000Z" });
  const second = event({ id: "dh-b", home: "Detroit Tigers", away: "Cleveland Guardians", commence: "2026-08-10T21:00:00.000Z" });
  const directMatch = matchMlbDiscoveryGameToProviderEvent(target, [first, second]);
  assert.equal(directMatch.status, "AMBIGUOUS");

  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(BASE_NOW),
    fetchFn: async () => {
      calls += 1;
      return jsonResponse([first, second], 100, 10, 0);
    },
  });
  const result = await service.acquire({
    runId: "doubleheader-ambiguous",
    discovery: discovery([target]),
    maxRunCredits: 3,
    reserveCredits: 10,
    apiKey: "secret",
  });
  assert.equal(calls, 1);
  assert.equal(result.providerCalls.paidEventOdds, 0);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.games[0].status, "EVENT_MATCH_AMBIGUOUS");
});

test("fresh per-market cache performs a paid top-up only for newly required keys and then reuses the full set", async () => {
  let nowMs = Date.parse(BASE_NOW);
  const providerGame = event({ id: "cache-41", home: "Seattle Mariners", away: "Texas Rangers" });
  const paidMarketsSeen: string[][] = [];
  let providerRemaining = 100;
  let providerUsed = 20;
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(nowMs),
    fetchFn: async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("/events/?")) return jsonResponse([providerGame], providerRemaining, providerUsed, 0);
      const markets = new URL(url).searchParams.get("markets")?.split(",") ?? [];
      paidMarketsSeen.push(markets);
      providerRemaining -= markets.length;
      providerUsed += markets.length;
      return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: markets }), providerRemaining, providerUsed, markets.length);
    },
  });

  const firstPlan = discovery([game({ gamePk: 41, rank: 1, home: "Seattle Mariners", away: "Texas Rangers", markets: [H2H()] })]);
  const first = await service.acquire({ runId: "cache-first", discovery: firstPlan, maxRunCredits: 5, reserveCredits: 10, apiKey: "secret" });
  assert.equal(first.games[0].status, "FETCHED");
  assert.deepEqual(paidMarketsSeen, [["h2h"]]);

  nowMs += 30_000;
  const expandedPlan = discovery([game({ gamePk: 41, rank: 1, home: "Seattle Mariners", away: "Texas Rangers", markets: [H2H(), TOTALS()] })]);
  const second = await service.acquire({ runId: "cache-topup", discovery: expandedPlan, maxRunCredits: 5, reserveCredits: 10, apiKey: "secret" });
  assert.equal(second.games[0].status, "FETCHED");
  assert.deepEqual(second.games[0].cacheHitMarketKeys, ["h2h"]);
  assert.deepEqual(second.games[0].paidMarketKeysRequested, ["totals"]);
  assert.deepEqual(paidMarketsSeen, [["h2h"], ["totals"]]);
  assert.equal(second.games[0].quoteMarkets.length, 2);

  nowMs += 30_000;
  const third = await service.acquire({ runId: "cache-full-hit", discovery: expandedPlan, maxRunCredits: 5, reserveCredits: 10, apiKey: "secret" });
  assert.equal(third.games[0].status, "CACHE_HIT");
  assert.deepEqual(third.games[0].cacheHitMarketKeys, ["h2h", "totals"]);
  assert.deepEqual(third.games[0].paidMarketKeysRequested, []);
  assert.deepEqual(paidMarketsSeen, [["h2h"], ["totals"]]);
  assert.equal(calls, 5, "three zero-cost probes plus two paid calls");
});

test("cache TTL is freshness policy only: once expired, the market is paid-refreshed on a new explicit run", async () => {
  let nowMs = Date.parse(BASE_NOW);
  const providerGame = event({ id: "ttl-51", home: "Miami Marlins", away: "Philadelphia Phillies" });
  let paidCalls = 0;
  let remaining = 100;
  let used = 30;
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(nowMs),
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes("/events/?")) return jsonResponse([providerGame], remaining, used, 0);
      paidCalls += 1;
      remaining -= 1;
      used += 1;
      return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: ["h2h"] }), remaining, used, 1);
    },
  });
  const plan = discovery([game({ gamePk: 51, rank: 1, home: "Miami Marlins", away: "Philadelphia Phillies" })]);
  await service.acquire({ runId: "ttl-first", discovery: plan, maxRunCredits: 3, reserveCredits: 10, apiKey: "secret" });
  nowMs += MLB_SELECTIVE_ODDS_CACHE_TTL_MS + 1;
  const refreshed = await service.acquire({ runId: "ttl-second", discovery: plan, maxRunCredits: 3, reserveCredits: 10, apiKey: "secret" });
  assert.equal(refreshed.games[0].status, "FETCHED");
  assert.equal(paidCalls, 2);
  assert.equal(refreshed.policy.backgroundPolling, false);
  assert.equal(refreshed.policy.cacheTtlIsRefreshPolicyNotPolling, true);
});

test("same runId concurrent replay shares one execution; completed replay spends nothing; plan mutation is rejected pre-provider", async () => {
  const providerGame = event({ id: "idem-61", home: "San Diego Padres", away: "San Francisco Giants" });
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(BASE_NOW),
    fetchFn: async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("/events/?")) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonResponse([providerGame], 100, 40, 0);
      }
      return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: ["h2h"] }), 99, 41, 1);
    },
  });
  const plan = discovery([game({ gamePk: 61, rank: 1, home: "San Diego Padres", away: "San Francisco Giants" })]);
  const input = { runId: "same-run", discovery: plan, maxRunCredits: 3, reserveCredits: 10, apiKey: "secret" };
  const [a, b] = await Promise.all([service.acquire(input), service.acquire(input)]);
  assert.strictEqual(a, b);
  assert.equal(calls, 2);
  const replay = await service.acquire(input);
  assert.strictEqual(replay, a);
  assert.equal(calls, 2);

  const mutated = discovery([game({ gamePk: 61, rank: 1, home: "San Diego Padres", away: "San Francisco Giants", markets: [H2H(), TOTALS()] })]);
  await assert.rejects(
    () => service.acquire({ ...input, discovery: mutated }),
    (error: any) => error instanceof MlbSelectiveOddsPlanError && error.code === "RUN_ID_REUSED_WITH_DIFFERENT_PLAN",
  );
  assert.equal(calls, 2);
});

test("a network failure after a paid request is issued charges conservative worst case, blocks the run, and prevents lower-rank retries", async () => {
  const top = game({ gamePk: 71, rank: 1, home: "Houston Astros", away: "Los Angeles Angels", markets: [H2H(), TOTALS()] });
  const lower = game({ gamePk: 72, rank: 2, home: "Minnesota Twins", away: "Kansas City Royals", markets: [H2H()] });
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(BASE_NOW),
    fetchFn: async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("/events/?")) {
        return jsonResponse([
          event({ id: "evt-71", home: "Houston Astros", away: "Los Angeles Angels" }),
          event({ id: "evt-72", home: "Minnesota Twins", away: "Kansas City Royals" }),
        ], 100, 50, 0);
      }
      throw Object.assign(new Error("socket reset after issuance"), { code: "ECONNRESET" });
    },
  });
  const result = await service.acquire({
    runId: "network-fail-closed",
    discovery: discovery([top, lower]),
    maxRunCredits: 5,
    reserveCredits: 10,
    apiKey: "secret",
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.stopReason, "PAID_PROVIDER_REQUEST_FAILED");
  assert.equal(result.games[0].status, "PROVIDER_FAILED");
  assert.equal(result.games[0].providerErrorCode, "ECONNRESET");
  assert.equal(result.games[1].status, "NOT_REACHED_AFTER_BLOCK");
  assert.equal(result.budget?.runCreditsCharged, 2);
  assert.equal(result.budget?.status, "BLOCKED");
  assert.equal(result.budget?.blockReason, "PROVIDER_USAGE_HEADERS_INVALID");
  assert.equal(result.budget?.operations[0]?.accounting, "CONSERVATIVE_WORST_CASE");
});

test("a successfully queried but absent market is negative-cached for the TTL and is not repurchased immediately", async () => {
  let nowMs = Date.parse(BASE_NOW);
  const providerGame = event({ id: "negative-81", home: "Athletics", away: "Los Angeles Dodgers" });
  let paidCalls = 0;
  let remaining = 100;
  let used = 60;
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(nowMs),
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes("/events/?")) return jsonResponse([providerGame], remaining, used, 0);
      paidCalls += 1;
      remaining -= 0;
      return jsonResponse({ ...providerGame, bookmakers: [] }, remaining, used, 0);
    },
  });
  const plan = discovery([game({ gamePk: 81, rank: 1, home: "Athletics", away: "Los Angeles Dodgers", markets: [TOTALS()] })]);
  const first = await service.acquire({ runId: "negative-first", discovery: plan, maxRunCredits: 2, reserveCredits: 10, apiKey: "secret" });
  assert.equal(first.games[0].status, "FETCHED");
  assert.equal(first.games[0].quoteMarkets[0]?.availability, "UNAVAILABLE_FROM_PROVIDER");
  assert.equal(first.games[0].usableForMarketEdge, false);

  nowMs += 60_000;
  const second = await service.acquire({ runId: "negative-second", discovery: plan, maxRunCredits: 2, reserveCredits: 10, apiKey: "secret" });
  assert.equal(second.games[0].status, "CACHE_HIT");
  assert.equal(second.games[0].quoteMarkets[0]?.availability, "UNAVAILABLE_FROM_PROVIDER");
  assert.equal(second.games[0].usableForMarketEdge, false);
  assert.equal(paidCalls, 1);
});

test("fresh reference-only price remains non-executable and cannot be marked usable for Market Edge execution", async () => {
  const providerGame = event({ id: "ref-91", home: "New York Yankees", away: "Boston Red Sox" });
  const service = new MlbSelectiveOddsAcquisitionService({
    now: () => new Date(BASE_NOW),
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes("/events/?")) return jsonResponse([providerGame], 100, 70, 0);
      return jsonResponse(marketPayload({ providerEvent: providerGame, marketKeys: ["h2h"], omitHardRock: true }), 99, 71, 1);
    },
  });
  const result = await service.acquire({
    runId: "reference-only",
    discovery: discovery([game({ gamePk: 91, rank: 1, home: "New York Yankees", away: "Boston Red Sox" })]),
    maxRunCredits: 2,
    reserveCredits: 10,
    apiKey: "secret",
  });
  assert.equal(result.games[0].quoteMarkets[0]?.availability, "REFERENCE_ONLY");
  assert.equal(result.games[0].usableForMarketEdge, false);
  assert.equal(result.policy.staleOrMissingExecutionQuoteCanBeRecommended, false);
});

test("invalid or mutated discovery paid keys fail before the zero-cost probe", async () => {
  const valid = game({ gamePk: 101, rank: 1, home: "Baltimore Orioles", away: "Tampa Bay Rays" });
  const invalid = {
    ...valid,
    providerMarketKeysToRequestNow: ["h2h", "pitcher_strikeouts"],
  } as MlbMarketDiscoveryGamePlan;
  let calls = 0;
  const service = new MlbSelectiveOddsAcquisitionService({
    fetchFn: async () => {
      calls += 1;
      throw new Error("should not fetch");
    },
  });
  await assert.rejects(
    () => service.acquire({ runId: "mutated-plan", discovery: discovery([invalid]), maxRunCredits: 5, reserveCredits: 10, apiKey: "secret" }),
    (error: any) => error instanceof MlbSelectiveOddsPlanError && error.code === "PAID_MARKET_KEY_MUTATION",
  );
  assert.equal(calls, 0);
});

test("event odds URL is event-scoped, market-exact, and contains no broad sport-odds regions request", () => {
  const url = new URL(buildMlbSelectiveEventOddsUrl("event 1", "secret", ["totals", "h2h", "h2h"]));
  assert.equal(url.pathname.endsWith("/events/event%201/odds/"), true);
  assert.equal(url.searchParams.get("markets"), "h2h,totals");
  assert.equal(url.searchParams.get("bookmakers"), MLB_SELECTIVE_ODDS_BOOKMAKERS.join(","));
  assert.equal(url.searchParams.has("regions"), false);
});
