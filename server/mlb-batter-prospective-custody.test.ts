import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";
import {
  MlbBatterProspectiveCustodyService,
  type MlbBatterProspectiveCustodySaveResult,
  type MlbBatterProspectiveCustodySnapshot,
  type MlbBatterProspectiveCustodyStore,
} from "./mlb-batter-prospective-custody";

const NOW = new Date("2026-08-15T20:00:00.000Z");
const START = "2026-08-15T23:10:00.000Z";

function slateGame(overrides: Partial<MlbP1SlateGame> = {}): MlbP1SlateGame {
  return {
    gamePk: 880001,
    startTime: START,
    officialDate: "2026-08-15",
    venue: "Prospective Park",
    state: "PREGAME",
    detailedState: "Pre-Game",
    homeTeam: { id: 101, name: "Home Club" },
    awayTeam: { id: 202, name: "Away Club" },
    homePitcher: { id: 301, name: "Home SP", hand: "R", confirmed: true },
    awayPitcher: { id: 302, name: "Away SP", hand: "L", confirmed: true },
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

function liveFeed(homeOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9], awayOrder = [11, 12, 13, 14, 15, 16, 17, 18, 19]) {
  return {
    gameData: {
      datetime: { officialDate: "2026-08-15", dateTime: START },
      teams: { home: { id: 101 }, away: { id: 202 } },
      probablePitchers: { home: { id: 301 }, away: { id: 302 } },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: homeOrder },
          away: { battingOrder: awayOrder },
        },
      },
    },
  };
}

class MemoryStore implements MlbBatterProspectiveCustodyStore {
  readonly games = new Map<number, MlbBatterProspectiveCustodySnapshot>();
  getCanonicalGame(gamePk: number): MlbBatterProspectiveCustodySnapshot | null {
    const row = this.games.get(gamePk);
    return row ? structuredClone(row) : null;
  }
  saveCanonicalGame(snapshot: MlbBatterProspectiveCustodySnapshot): MlbBatterProspectiveCustodySaveResult {
    const existing = this.games.get(snapshot.gamePk);
    if (existing) return { status: "EXISTS", snapshot: structuredClone(existing) };
    this.games.set(snapshot.gamePk, structuredClone(snapshot));
    return { status: "SAVED", snapshot: structuredClone(snapshot) };
  }
}

test("V56 captures exact 9x9 batter identity before start with zero odds/model activity", async () => {
  const calls: string[] = [];
  const store = new MemoryStore();
  const service = new MlbBatterProspectiveCustodyService(store, {
    now: () => NOW,
    fetchFn: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(liveFeed()), { status: 200 });
    },
  });

  const result = await service.capture({ date: "2026-08-15", games: [slateGame()], maxGames: 1 });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.summary.capturedGames, 1);
  assert.equal(result.summary.mlbStatsApiCalls, 1);
  assert.equal(result.summary.providerOddsCalls, 0);
  assert.equal(result.summary.paidProviderCredits, 0);
  assert.equal(result.policy.modelScoringAllowed, false);
  assert.equal(result.policy.priceCaptureAllowed, false);
  assert.equal(result.policy.recommendsBet, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/statsapi\.mlb\.com\/api\/v1\.1\/game\/880001\/feed\/live$/);
  const snapshot = result.games[0].snapshot!;
  assert.deepEqual(snapshot.homeBattingOrder, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(snapshot.awayBattingOrder, [11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(snapshot.homeProbablePitcherId, 301);
  assert.equal(snapshot.awayProbablePitcherId, 302);
  assert.match(snapshot.sourceIdentityDigest, /^[a-f0-9]{64}$/);
});

test("later capture returns the first canonical snapshot and does not refetch MLB", async () => {
  let calls = 0;
  const store = new MemoryStore();
  const firstService = new MlbBatterProspectiveCustodyService(store, {
    now: () => NOW,
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify(liveFeed()), { status: 200 });
    },
  });
  const first = await firstService.capture({ date: "2026-08-15", games: [slateGame()], maxGames: 1 });
  const firstSnapshot = first.games[0].snapshot!;

  const laterService = new MlbBatterProspectiveCustodyService(store, {
    now: () => new Date("2026-08-15T20:30:00.000Z"),
    fetchFn: async () => {
      calls += 1;
      return new Response(JSON.stringify(liveFeed([9, 8, 7, 6, 5, 4, 3, 2, 1])), { status: 200 });
    },
  });
  const later = await laterService.capture({ date: "2026-08-15", games: [slateGame()], maxGames: 1 });
  assert.equal(later.games[0].status, "ALREADY_CAPTURED");
  assert.deepEqual(later.games[0].snapshot, firstSnapshot);
  assert.equal(calls, 1);
});

test("V56 fails closed on non-unique or non-9 batting orders", async () => {
  const store = new MemoryStore();
  const service = new MlbBatterProspectiveCustodyService(store, {
    now: () => NOW,
    fetchFn: async () => new Response(JSON.stringify(liveFeed([1, 2, 3, 4, 5, 6, 7, 8, 8])), { status: 200 }),
  });
  const result = await service.capture({ date: "2026-08-15", games: [slateGame()], maxGames: 1 });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.games[0].status, "LINEUP_INVALID");
  assert.equal(result.games[0].snapshot, null);
  assert.equal(store.games.size, 0);
});

test("V56 rejects live-feed identity drift instead of silently accepting changed pitcher/team custody", async () => {
  const feed = liveFeed();
  feed.gameData.probablePitchers.home.id = 999;
  const store = new MemoryStore();
  const service = new MlbBatterProspectiveCustodyService(store, {
    now: () => NOW,
    fetchFn: async () => new Response(JSON.stringify(feed), { status: 200 }),
  });
  const result = await service.capture({ date: "2026-08-15", games: [slateGame()], maxGames: 1 });
  assert.equal(result.games[0].status, "IDENTITY_MISMATCH");
  assert.equal(store.games.size, 0);
});

test("V56 never calls MLB after start or for non-FINAL slate rows", async () => {
  let calls = 0;
  const store = new MemoryStore();
  const startedService = new MlbBatterProspectiveCustodyService(store, {
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    fetchFn: async () => { calls += 1; throw new Error("must not fetch"); },
  });
  const started = await startedService.capture({ date: "2026-08-15", games: [slateGame()], maxGames: 1 });
  assert.equal(started.games[0].status, "STARTED_BEFORE_CAPTURE");

  const provisionalService = new MlbBatterProspectiveCustodyService(store, {
    now: () => NOW,
    fetchFn: async () => { calls += 1; throw new Error("must not fetch"); },
  });
  const provisional = await provisionalService.capture({
    date: "2026-08-15",
    games: [slateGame({ analysisStage: "PROVISIONAL", lineupState: "PARTIAL", homeLineupCount: 5 })],
    maxGames: 1,
  });
  assert.equal(provisional.games[0].status, "INELIGIBLE");
  assert.equal(calls, 0);
});
