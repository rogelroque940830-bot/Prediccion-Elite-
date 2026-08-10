import assert from "node:assert/strict";
import test from "node:test";
import {
  filterMlbDailySlateGames,
  mlbDailySlateLineupLabel,
  mlbDailySlateReadinessLabel,
  mlbDailySlateSafetyValid,
  type MlbDailySlateGame,
  type MlbDailySlateReport,
} from "./mlb-daily-slate";

function game(readiness: MlbDailySlateGame["readiness"], gamePk: number): MlbDailySlateGame {
  return {
    gamePk,
    startTime: "2026-08-04T23:10:00Z",
    officialDate: "2026-08-04",
    venue: "Test Park",
    state: "SCHEDULED",
    detailedState: "Scheduled",
    homeTeam: { id: 1, name: "Home" },
    awayTeam: { id: 2, name: "Away" },
    homePitcher: { id: 11, name: "Home Starter", hand: "R", confirmed: true },
    awayPitcher: { id: 22, name: "Away Starter", hand: "L", confirmed: true },
    lineupState: readiness === "READY_TO_ANALYZE" ? "CONFIRMED" : "NOT_POSTED",
    homeLineupCount: readiness === "READY_TO_ANALYZE" ? 9 : 0,
    awayLineupCount: readiness === "READY_TO_ANALYZE" ? 9 : 0,
    readiness,
    analysisStage: readiness === "READY_TO_ANALYZE" ? "FINAL" : readiness === "PROVISIONAL_WAITING_FOR_LINEUPS" ? "PROVISIONAL" : "BLOCKED",
    analysisAllowed: ["READY_TO_ANALYZE", "PROVISIONAL_WAITING_FOR_LINEUPS"].includes(readiness),
    blockers: [],
    source: { name: "MLB_STATS_API", fetchedAt: "2026-08-04T20:00:00Z", quality: "AUTHORITATIVE" },
  };
}

function report(): MlbDailySlateReport {
  const games = [
    game("READY_TO_ANALYZE", 1),
    game("PROVISIONAL_WAITING_FOR_LINEUPS", 2),
    game("WAITING_FOR_PITCHERS", 3),
  ];
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-08-04",
    generatedAt: "2026-08-04T20:00:00Z",
    games,
    summary: { total: 3, ready: 1, provisional: 1, waitingForPitchers: 1, startedOrClosed: 0, dataInsufficient: 0 },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

test("filters the daily slate into ready provisional and all views", () => {
  const games = report().games;
  assert.deepEqual(filterMlbDailySlateGames(games, "ready").map((item) => item.gamePk), [1]);
  assert.deepEqual(filterMlbDailySlateGames(games, "provisional").map((item) => item.gamePk), [2]);
  assert.deepEqual(filterMlbDailySlateGames(games, "all").map((item) => item.gamePk), [1, 2, 3]);
});

test("safety validation fails closed", () => {
  const valid = report();
  assert.equal(mlbDailySlateSafetyValid(valid), true);
  assert.equal(mlbDailySlateSafetyValid({ ...valid, safety: { ...valid.safety, automaticBetPlacement: true as false } }), false);
  assert.equal(mlbDailySlateSafetyValid(undefined), false);
});

test("labels readiness and lineup states for the operator", () => {
  assert.equal(mlbDailySlateReadinessLabel("READY_TO_ANALYZE"), "Listo para analizar");
  assert.equal(mlbDailySlateReadinessLabel("PROVISIONAL_WAITING_FOR_LINEUPS"), "Esperando lineups");
  assert.equal(mlbDailySlateLineupLabel(game("READY_TO_ANALYZE", 1)), "Lineups confirmados");
  assert.equal(mlbDailySlateLineupLabel(game("PROVISIONAL_WAITING_FOR_LINEUPS", 2)), "Lineups no publicados");
});
