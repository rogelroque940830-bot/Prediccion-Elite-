import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { MLB_P1_SLATE_SCHEMA, type MlbP1DailySlate, type MlbP1Readiness, type MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { screenMlbDailySlateCheap, screenMlbSlateGameCheap } from "./mlb-cheap-screening";

function game(readiness: MlbP1Readiness, gamePk: number): MlbP1SlateGame {
  const final = readiness === "READY_TO_ANALYZE";
  const provisional = readiness === "PROVISIONAL_WAITING_FOR_LINEUPS";
  const state = readiness === "GAME_ALREADY_STARTED"
    ? "IN_PROGRESS"
    : readiness === "GAME_CLOSED"
      ? "FINAL"
      : "SCHEDULED";
  return {
    gamePk,
    startTime: "2026-08-10T23:10:00.000Z",
    officialDate: "2026-08-10",
    venue: "Verified Venue",
    state,
    detailedState: state,
    homeTeam: { id: 1, name: "Home" },
    awayTeam: { id: 2, name: "Away" },
    homePitcher: { id: readiness === "WAITING_FOR_PITCHERS" ? null : 11, name: readiness === "WAITING_FOR_PITCHERS" ? null : "Home SP", hand: "R", confirmed: readiness !== "WAITING_FOR_PITCHERS" },
    awayPitcher: { id: 22, name: "Away SP", hand: "L", confirmed: true },
    lineupState: final ? "CONFIRMED" : provisional ? "NOT_POSTED" : "UNKNOWN",
    homeLineupCount: final ? 9 : 0,
    awayLineupCount: final ? 9 : 0,
    readiness,
    analysisStage: final ? "FINAL" : provisional ? "PROVISIONAL" : "BLOCKED",
    analysisAllowed: final || provisional,
    blockers: final ? [] : [`fixture:${readiness}`],
    source: {
      name: "MLB_STATS_API",
      fetchedAt: "2026-08-10T21:00:00.000Z",
      quality: readiness === "DATA_INSUFFICIENT" ? "DEGRADED" : "AUTHORITATIVE",
    },
  };
}

function slate(games: MlbP1SlateGame[]): MlbP1DailySlate {
  return {
    schemaVersion: MLB_P1_SLATE_SCHEMA,
    date: "2026-08-10",
    generatedAt: "2026-08-10T21:00:00.000Z",
    games,
    summary: {
      total: games.length,
      ready: games.filter((g) => g.readiness === "READY_TO_ANALYZE").length,
      provisional: games.filter((g) => g.readiness === "PROVISIONAL_WAITING_FOR_LINEUPS").length,
      waitingForPitchers: games.filter((g) => g.readiness === "WAITING_FOR_PITCHERS").length,
      startedOrClosed: games.filter((g) => ["GAME_ALREADY_STARTED", "GAME_CLOSED"].includes(g.readiness)).length,
      dataInsufficient: games.filter((g) => g.readiness === "DATA_INSUFFICIENT").length,
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

test("cheap screening maps every existing official readiness state without new predictive thresholds", () => {
  const cases: Array<[MlbP1Readiness, string, boolean, boolean]> = [
    ["READY_TO_ANALYZE", "ADVANCE_FINAL", true, true],
    ["PROVISIONAL_WAITING_FOR_LINEUPS", "ADVANCE_PROVISIONAL", true, false],
    ["WAITING_FOR_PITCHERS", "DEFER", false, false],
    ["DATA_INSUFFICIENT", "DEFER", false, false],
    ["GAME_ALREADY_STARTED", "DROP", false, false],
    ["GAME_CLOSED", "DROP", false, false],
  ];
  cases.forEach(([readiness, disposition, eligible, final], index) => {
    const result = screenMlbSlateGameCheap(game(readiness, 100 + index));
    assert.equal(result.disposition, disposition);
    assert.equal(result.eligibleForDeepPrefilterNow, eligible);
    assert.equal(result.finalInputsAvailable, final);
  });
});

test("lineup-pending games advance provisionally instead of being falsely discarded", () => {
  const result = screenMlbSlateGameCheap(game("PROVISIONAL_WAITING_FOR_LINEUPS", 200));
  assert.equal(result.disposition, "ADVANCE_PROVISIONAL");
  assert.equal(result.reasonCode, "OFFICIAL_LINEUPS_PENDING");
  assert.equal(result.eligibleForDeepPrefilterNow, true);
  assert.equal(result.finalInputsAvailable, false);
});

test("missing pitchers and degraded official identity are deferred, never promoted or dropped", () => {
  const missingPitcher = screenMlbSlateGameCheap(game("WAITING_FOR_PITCHERS", 201));
  const degraded = screenMlbSlateGameCheap(game("DATA_INSUFFICIENT", 202));
  assert.equal(missingPitcher.disposition, "DEFER");
  assert.equal(degraded.disposition, "DEFER");
  assert.equal(missingPitcher.eligibleForDeepPrefilterNow, false);
  assert.equal(degraded.eligibleForDeepPrefilterNow, false);
});

test("started and closed games are the only hard drops at cheap-screen stage", () => {
  assert.equal(screenMlbSlateGameCheap(game("GAME_ALREADY_STARTED", 203)).disposition, "DROP");
  assert.equal(screenMlbSlateGameCheap(game("GAME_CLOSED", 204)).disposition, "DROP");
});

test("slate summary is deterministic and does not impose a shortlist quota", () => {
  const result = screenMlbDailySlateCheap(slate([
    game("READY_TO_ANALYZE", 1),
    game("READY_TO_ANALYZE", 2),
    game("PROVISIONAL_WAITING_FOR_LINEUPS", 3),
    game("WAITING_FOR_PITCHERS", 4),
    game("DATA_INSUFFICIENT", 5),
    game("GAME_ALREADY_STARTED", 6),
    game("GAME_CLOSED", 7),
  ]));
  assert.deepEqual(result.summary, {
    total: 7,
    advanceFinal: 2,
    advanceProvisional: 1,
    deferred: 2,
    dropped: 2,
    deepPrefilterEligibleNow: 3,
  });
  assert.equal(result.policy.marketAgnostic, true);
  assert.equal(result.policy.ranksGames, false);
  assert.equal(result.policy.capsCandidateCount, false);
  assert.equal(result.policy.requiresMarketOdds, false);
  assert.equal(result.policy.deferredGamesRequireNewExplicitRun, true);
});

test("cheap screening source has no The Odds API, odds secret, timer, polling, or predictive threshold capability", () => {
  const source = fs.readFileSync("server/mlb-cheap-screening.ts", "utf8");
  assert.doesNotMatch(source, /api\.the-odds-api\.com/i);
  assert.doesNotMatch(source, /ODDS_API_KEY|x-requests-|setInterval|setTimeout/i);
  assert.doesNotMatch(source, /\b(?:PREMIUM|ULTRA|confidence|edge|probability|stake)\b/i);
  assert.match(source, /requiresMarketOdds: false/);
  assert.match(source, /theOddsApiCreditsConsumed: 0/);
});
