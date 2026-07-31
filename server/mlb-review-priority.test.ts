import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbReviewQueue,
  classifyMlbDecisionReview,
  classifyMlbScheduleGame,
} from "../frontend/client/src/lib/mlb-review-priority";

const NOW = Date.parse("2026-07-31T17:00:00Z");

function game(overrides: Record<string, unknown> = {}) {
  return {
    gameId: 1,
    gameDate: "2026-07-31T20:00:00Z",
    homeTeam: { id: 1, name: "Home" },
    awayTeam: { id: 2, name: "Away" },
    homePitcher: { id: 10, name: "Home Starter" },
    awayPitcher: { id: 20, name: "Away Starter" },
    ...overrides,
  };
}

test("future game with both pitchers is ready for priority review", () => {
  assert.equal(classifyMlbScheduleGame(game(), NOW).readiness, "READY");
});

test("future game missing a probable pitcher remains pending", () => {
  assert.equal(classifyMlbScheduleGame(game({ awayPitcher: null }), NOW).readiness, "PENDING");
});

test("started game is closed even when both pitchers are known", () => {
  assert.equal(
    classifyMlbScheduleGame(game({ gameDate: "2026-07-31T16:00:00Z" }), NOW).readiness,
    "CLOSED",
  );
});

test("queue preserves all games while prioritizing ready pregame entries", () => {
  const queue = buildMlbReviewQueue([
    game({ gameId: 3, gameDate: "2026-07-31T16:00:00Z" }),
    game({ gameId: 2, gameDate: "2026-07-31T19:00:00Z", awayPitcher: null }),
    game({ gameId: 1, gameDate: "2026-07-31T18:00:00Z" }),
  ], NOW);

  assert.deepEqual(queue.priority.map((entry) => entry.game.gameId), [1]);
  assert.deepEqual(queue.pending.map((entry) => entry.game.gameId), [2]);
  assert.deepEqual(queue.all.map((entry) => entry.game.gameId), [1, 2, 3]);
});

test("positive BET without veto is actionable", () => {
  const result = classifyMlbDecisionReview({
    ml: { market: "ML", recommendation: "BET", edgeReal: 5.2, warnings: [] },
    f5: { market: "F5", recommendation: "PASS", edgeReal: -1 },
  });
  assert.equal(result.status, "ACTIONABLE");
  assert.equal(result.market, "ML");
});

test("positive LEAN is secondary review when no BET qualifies", () => {
  const result = classifyMlbDecisionReview({
    ml: { market: "ML", recommendation: "PASS", edgeReal: 2 },
    f5: { market: "F5", recommendation: "LEAN", edgeReal: 3.4 },
  });
  assert.equal(result.status, "REVIEW");
  assert.equal(result.market, "F5");
});

test("vetoed or non-positive recommendations are pass", () => {
  const result = classifyMlbDecisionReview({
    ml: { market: "ML", recommendation: "BET", edgeReal: 6, warnings: ["🚫 VETO: sharp en contra"] },
    f5: { market: "F5", recommendation: "LEAN", edgeReal: -0.2 },
  });
  assert.equal(result.status, "PASS");
});

test("missing pick qualities is explicitly unavailable", () => {
  assert.equal(classifyMlbDecisionReview(undefined).status, "UNAVAILABLE");
});
