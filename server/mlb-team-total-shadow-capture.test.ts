import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { MLB_FULL13_FEATURE_NAMES, type MlbFull13FeatureVector } from "./mlb-full13-live-feature-builder";
import {
  MlbTeamTotalShadowCaptureService,
  type MlbTeamTotalShadowCaptureResult,
  type MlbTeamTotalShadowGameResult,
  type MlbTeamTotalShadowRunAdmission,
  type MlbTeamTotalShadowStore,
} from "./mlb-team-total-shadow-capture";

const NOW = new Date("2026-08-14T20:00:00.000Z");
const START = "2026-08-14T23:10:00.000Z";
const FIXTURE_API_KEY = ["fixture", "provider", "token"].join("-");

function game(overrides: Partial<MlbP1SlateGame> = {}): MlbP1SlateGame {
  return {
    gamePk: 777001,
    startTime: START,
    officialDate: "2026-08-14",
    venue: "Test Park",
    state: "PREGAME",
    detailedState: "Pre-Game",
    homeTeam: { id: 1, name: "Home Club" },
    awayTeam: { id: 2, name: "Away Club" },
    homePitcher: { id: 11, name: "Home SP", hand: "R", confirmed: true },
    awayPitcher: { id: 22, name: "Away SP", hand: "L", confirmed: true },
    lineupState: "CONFIRMED",
    homeLineupCount: 9,
    awayLineupCount: 9,
    readiness: "READY_TO_ANALYZE",
    analysisStage: "FINAL",
    analysisAllowed: true,
    blockers: [],
    source: { name: "MLB_STATS_API", fetchedAt: NOW.toISOString(), quality: "AUTHORITATIVE" },
    ...overrides,
  } as MlbP1SlateGame;
}

function featureVector(): MlbFull13FeatureVector {
  const vector = Object.fromEntries(MLB_FULL13_FEATURE_NAMES.map((feature) => [feature, 0])) as MlbFull13FeatureVector;
  vector.min_probable_prior_bf = 130;
  vector.combined_starter_kbb = 0.27669490811376757;
  vector.combined_team_rs10 = 8.5;
  vector.combined_team_ra10 = 8.5;
  return vector;
}

class MemoryStore implements MlbTeamTotalShadowStore {
  readonly runs = new Map<string, { fingerprint: string; state: "IN_PROGRESS" | "COMPLETED"; result?: MlbTeamTotalShadowCaptureResult }>();
  readonly games = new Map<number, MlbTeamTotalShadowGameResult>();
  beginRun(input: { providerAccountScopeKey: string; runId: string; fingerprint: string }): MlbTeamTotalShadowRunAdmission {
    const key = `${input.providerAccountScopeKey}:${input.runId}`;
    const existing = this.runs.get(key);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) return { status: "FINGERPRINT_MISMATCH" };
      if (existing.state === "COMPLETED") return { status: "COMPLETED", result: existing.result! };
      return { status: "IN_PROGRESS" };
    }
    this.runs.set(key, { fingerprint: input.fingerprint, state: "IN_PROGRESS" });
    return { status: "ADMITTED" };
  }
  hasCanonicalGameCapture(_scope: string, gamePk: number): boolean { return this.games.has(gamePk); }
  saveCanonicalGameCapture(input: { gamePk: number; result: MlbTeamTotalShadowGameResult }): void {
    if (this.games.has(input.gamePk)) throw new Error("duplicate canonical game");
    this.games.set(input.gamePk, structuredClone(input.result));
  }
  completeRun(input: { providerAccountScopeKey: string; runId: string; fingerprint: string; result: MlbTeamTotalShadowCaptureResult }): void {
    this.runs.set(`${input.providerAccountScopeKey}:${input.runId}`, { fingerprint: input.fingerprint, state: "COMPLETED", result: structuredClone(input.result) });
  }
}

function headers(remaining: number, used: number, last: number): Headers {
  return new Headers({
    "x-requests-remaining": String(remaining),
    "x-requests-used": String(used),
    "x-requests-last": String(last),
  });
}

function eventsPayload(games = [game()]) {
  return games.map((item) => ({
    id: `event-${item.gamePk}`,
    sport_key: "baseball_mlb",
    commence_time: item.startTime,
    home_team: item.homeTeam.name,
    away_team: item.awayTeam.name,
  }));
}

function teamTotalsPayload(target = game()) {
  return {
    id: `event-${target.gamePk}`,
    sport_key: "baseball_mlb",
    commence_time: target.startTime,
    home_team: target.homeTeam.name,
    away_team: target.awayTeam.name,
    bookmakers: [{
      key: "hardrockbet_fl",
      title: "Hard Rock Bet Florida",
      last_update: "2026-08-14T19:59:00.000Z",
      markets: [{
        key: "team_totals",
        last_update: "2026-08-14T19:59:00.000Z",
        outcomes: [
          { name: "Over", description: target.homeTeam.name, point: 4.5, price: -105 },
          { name: "Under", description: target.homeTeam.name, point: 4.5, price: -115 },
          { name: "Over", description: target.awayTeam.name, point: 3.5, price: 105 },
          { name: "Under", description: target.awayTeam.name, point: 3.5, price: -125 },
        ],
      }],
    }],
  };
}

function coordinator() {
  return {
    coordinationScope: "PROVIDER_ACCOUNT_SHARED" as const,
    runExclusive: async (_key: string, work: () => Promise<any>) => work(),
  } as any;
}

function baseInput(runId: string) {
  return {
    runId,
    date: "2026-08-14",
    games: [game()],
    maxGames: 1,
    providerAccountScopeKey: "scope-test",
    apiKey: FIXTURE_API_KEY,
    maxRunCredits: 1,
    reserveCredits: 10,
  };
}

test("V22 captures one paid team_totals market and evaluates both team sides without creating a bet", async () => {
  const calls: string[] = [];
  const store = new MemoryStore();
  const service = new MlbTeamTotalShadowCaptureService({
    coordinator: coordinator(),
    store,
    now: () => NOW,
    materializer: { assessFull13Game: async () => ({ featureVector: featureVector() }) } as any,
    fetchFn: async (input) => {
      const url = String(input); calls.push(url);
      if (url.includes("/events/?")) return new Response(JSON.stringify(eventsPayload()), { status: 200, headers: headers(100, 10, 0) });
      if (url.includes("/events/event-777001/odds/?")) return new Response(JSON.stringify(teamTotalsPayload()), { status: 200, headers: headers(99, 11, 1) });
      throw new Error(`unexpected url ${url}`);
    },
  });

  const result = await service.capture(baseInput("run-one"));
  assert.equal(result.status, "COMPLETED");
  assert.equal(calls.length, 2);
  assert.equal(result.summary.providerCalls, 1);
  assert.equal(result.summary.providerCreditsCharged, 1);
  assert.equal(result.summary.capturedGames, 1);
  assert.equal(result.summary.executableHomeTeamTotals, 1);
  assert.equal(result.summary.executableAwayTeamTotals, 1);
  assert.equal(result.summary.evaluatedTeamTotals, 2);
  assert.equal(result.games[0].home?.quoteSource, "EXECUTION");
  assert.equal(result.games[0].away?.quoteSource, "EXECUTION");
  assert.equal(result.games[0].home?.line, 4.5);
  assert.equal(result.games[0].away?.line, 3.5);
  assert.equal(result.games[0].home?.model.priceIndependent, true);
  assert.equal(result.games[0].home?.positiveEvEstablishedForPromotion, false);
  assert.equal(result.policy.changesEliteCandidates, false);
  assert.equal(result.policy.recommendsBet, false);
  assert.equal(result.policy.automaticBetPlacement, false);
  assert.equal(result.policy.realFinancialExposure, 0);
  assert.equal(JSON.stringify(result).includes(FIXTURE_API_KEY), false);
});

test("same run replay and later run for the same game consume no additional paid credits", async () => {
  let calls = 0;
  const store = new MemoryStore();
  const service = new MlbTeamTotalShadowCaptureService({
    coordinator: coordinator(), store, now: () => NOW,
    materializer: { assessFull13Game: async () => ({ featureVector: featureVector() }) } as any,
    fetchFn: async (input) => {
      calls += 1;
      const url = String(input);
      if (url.includes("/events/?")) return new Response(JSON.stringify(eventsPayload()), { headers: headers(100, 10, 0) });
      return new Response(JSON.stringify(teamTotalsPayload()), { headers: headers(99, 11, 1) });
    },
  });
  const first = await service.capture(baseInput("same-run"));
  assert.equal(first.summary.providerCreditsCharged, 1);
  assert.equal(calls, 2);
  const replay = await service.capture(baseInput("same-run"));
  assert.deepEqual(replay, first);
  assert.equal(calls, 2);
  const later = await service.capture(baseInput("later-run"));
  assert.equal(later.games[0].status, "ALREADY_CAPTURED");
  assert.equal(later.summary.providerCreditsCharged, 0);
  assert.equal(calls, 2);
});

test("maxGames counts uncaptured games so an older canonical capture cannot starve later games", async () => {
  const first = game();
  const second = game({
    gamePk: 777002,
    startTime: "2026-08-15T00:10:00.000Z",
    homeTeam: { id: 3, name: "Second Home" },
    awayTeam: { id: 4, name: "Second Away" },
  });
  const store = new MemoryStore();
  store.games.set(first.gamePk, {
    gamePk: first.gamePk, officialDate: first.officialDate, startTime: first.startTime!, homeTeam: first.homeTeam.name, awayTeam: first.awayTeam.name,
    status: "CAPTURED", providerEventId: `event-${first.gamePk}`, providerCallMade: true, providerCreditsCharged: 1,
    homeMarketAvailability: "EXECUTABLE", awayMarketAvailability: "EXECUTABLE", home: null, away: null, blockers: [],
  });
  let paidCalls = 0;
  const service = new MlbTeamTotalShadowCaptureService({
    coordinator: coordinator(), store, now: () => NOW,
    materializer: { assessFull13Game: async () => ({ featureVector: featureVector() }) } as any,
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes("/events/?")) return new Response(JSON.stringify(eventsPayload([first, second])), { headers: headers(100, 10, 0) });
      paidCalls += 1;
      assert.ok(url.includes("event-777002"));
      return new Response(JSON.stringify(teamTotalsPayload(second)), { headers: headers(99, 11, 1) });
    },
  });
  const result = await service.capture({ ...baseInput("progress-run"), games: [first, second], maxGames: 1 });
  assert.equal(result.games.some((row) => row.gamePk === first.gamePk && row.status === "ALREADY_CAPTURED"), true);
  assert.equal(result.games.some((row) => row.gamePk === second.gamePk && row.status === "CAPTURED"), true);
  assert.equal(paidCalls, 1);
  assert.equal(result.summary.providerCreditsCharged, 1);
});

test("zero paid-credit authorization probes quota but never crosses the paid boundary", async () => {
  let paidCalls = 0;
  const service = new MlbTeamTotalShadowCaptureService({
    coordinator: coordinator(), store: new MemoryStore(), now: () => NOW,
    materializer: { assessFull13Game: async () => { throw new Error("must not materialize"); } } as any,
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes("/events/?")) return new Response(JSON.stringify(eventsPayload()), { headers: headers(100, 10, 0) });
      paidCalls += 1;
      throw new Error("unexpected paid call");
    },
  });
  const result = await service.capture({ ...baseInput("zero-budget"), maxRunCredits: 0 });
  assert.equal(paidCalls, 0);
  assert.equal(result.games[0].status, "BUDGET_DENIED");
  assert.equal(result.summary.providerCreditsCharged, 0);
});

test("paid network failure charges worst-case authorized credits instead of releasing an issued request", async () => {
  const service = new MlbTeamTotalShadowCaptureService({
    coordinator: coordinator(), store: new MemoryStore(), now: () => NOW,
    materializer: { assessFull13Game: async () => { throw new Error("must not materialize"); } } as any,
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes("/events/?")) return new Response(JSON.stringify(eventsPayload()), { headers: headers(100, 10, 0) });
      throw Object.assign(new Error("network lost after request issuance"), { name: "NetworkError" });
    },
  });
  const result = await service.capture(baseInput("network-failure"));
  assert.equal(result.games[0].status, "PROVIDER_FAILED");
  assert.equal(result.games[0].providerCallMade, true);
  assert.equal(result.games[0].providerCreditsCharged, 1);
  assert.equal(result.summary.providerCreditsCharged, 1);
});

test("provider paid response must reproduce the complete probed event identity", async () => {
  const service = new MlbTeamTotalShadowCaptureService({
    coordinator: coordinator(), store: new MemoryStore(), now: () => NOW,
    materializer: { assessFull13Game: async () => ({ featureVector: featureVector() }) } as any,
    fetchFn: async (input) => {
      const url = String(input);
      if (url.includes("/events/?")) return new Response(JSON.stringify(eventsPayload()), { headers: headers(100, 10, 0) });
      const wrong = { ...teamTotalsPayload(), home_team: "Different Home" };
      return new Response(JSON.stringify(wrong), { headers: headers(99, 11, 1) });
    },
  });
  const result = await service.capture(baseInput("identity-fail"));
  assert.equal(result.games[0].status, "PROVIDER_FAILED");
  assert.equal(result.games[0].providerCreditsCharged, 1);
  assert.equal(result.summary.evaluatedTeamTotals, 0);
  assert.ok(result.games[0].blockers.includes("PAID_EVENT_IDENTITY_MISMATCH"));
});
