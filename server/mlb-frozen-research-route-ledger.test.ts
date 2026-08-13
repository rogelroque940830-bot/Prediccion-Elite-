import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMlbFrozenResearchRouteLedger,
  MLB_FROZEN_RESEARCH_ROUTE_IDS,
  type MlbFrozenResearchRouteAssessment,
} from "./mlb-frozen-research-route-ledger";

const digest = "a".repeat(64);

function routes(state: "MATCH" | "NO_MATCH" | "NOT_EVALUATED") {
  return Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTE_IDS.map((id) => [id, state])) as MlbFrozenResearchRouteAssessment["routes"];
}

function finalRow(gamePk: number): MlbFrozenResearchRouteAssessment {
  const row: MlbFrozenResearchRouteAssessment = {
    gamePk,
    gameDate: "2026-08-13",
    scheduledStartTime: "2026-08-13T23:10:00.000Z",
    evaluatedAt: "2026-08-13T22:30:00.000Z",
    finalInputs: true,
    featureSnapshotDigest: digest,
    scorerVersion: "frozen-routes-v1",
    routes: routes("NO_MATCH"),
  };
  row.routes.A_PLUS_HOME_ML = "MATCH";
  row.routes.A_PLUS_SLG_POS = "MATCH";
  return row;
}

function provisionalRow(gamePk: number): MlbFrozenResearchRouteAssessment {
  return {
    gamePk,
    gameDate: "2026-08-13",
    scheduledStartTime: "2026-08-14T01:10:00.000Z",
    evaluatedAt: "2026-08-13T22:30:00.000Z",
    finalInputs: false,
    featureSnapshotDigest: "b".repeat(64),
    scorerVersion: "frozen-routes-v1",
    routes: routes("NOT_EVALUATED"),
  };
}

function capture(rows: MlbFrozenResearchRouteAssessment[]) {
  return captureMlbFrozenResearchRouteLedger({
    sourceRunId: "manual-2026-08-13T2230Z",
    capturedAt: "2026-08-13T22:31:00.000Z",
    analysisEligibleGamePks: rows.map((row) => row.gamePk),
    assessments: rows,
  });
}

test("captures 100% of analysis-eligible games without changing Step11A or original Step11C populations", () => {
  const ledger = capture([finalRow(1), provisionalRow(2)]);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.summary.captureRetentionPct, 100);
  assert.equal(ledger.summary.finalEvaluatedGames, 1);
  assert.equal(ledger.summary.provisionalNotEvaluatedGames, 1);
  assert.equal(ledger.policy.changesStep11aPopulation, false);
  assert.equal(ledger.policy.changesOriginalStep11cPopulation, false);
  assert.equal(ledger.policy.liveFilterChangeAllowed, false);
  assert.equal(ledger.policy.betEliteAllowed, false);
});

test("provisional games remain visible but every frozen route is NOT_EVALUATED", () => {
  const ledger = capture([provisionalRow(2)]);
  for (const id of MLB_FROZEN_RESEARCH_ROUTE_IDS) assert.equal(ledger.entries[0].routes[id], "NOT_EVALUATED");
});

test("a provisional game cannot be silently labeled as a match or no-match", () => {
  const row = provisionalRow(2);
  row.routes.A_PLUS_HOME_ML = "MATCH";
  assert.throws(() => capture([row]), /PROVISIONAL_MUST_NOT_EVALUATE/);
});

test("a final-input game must evaluate every frozen route", () => {
  const row = finalRow(1);
  row.routes.F5_PARETO_UNION = "NOT_EVALUATED";
  assert.throws(() => capture([row]), /FINAL_MUST_EVALUATE_ALL/);
});

test("missing or duplicate eligible rows fail instead of shrinking prospective volume", () => {
  const row = finalRow(1);
  assert.throws(() => captureMlbFrozenResearchRouteLedger({
    sourceRunId: "x",
    capturedAt: "2026-08-13T22:31:00.000Z",
    analysisEligibleGamePks: [1, 2],
    assessments: [row],
  }), /COVERAGE_COUNT_MISMATCH/);
  assert.throws(() => captureMlbFrozenResearchRouteLedger({
    sourceRunId: "x",
    capturedAt: "2026-08-13T22:31:00.000Z",
    analysisEligibleGamePks: [1],
    assessments: [row, row],
  }), /COVERAGE_COUNT_MISMATCH|GAME_IDENTITY_INVALID/);
});

test("post-start assessment or capture is rejected", () => {
  const row = finalRow(1);
  row.evaluatedAt = row.scheduledStartTime;
  assert.throws(() => capture([row]), /NOT_PREGAME/);
});

test("route metadata is deeply immutable", () => {
  const ledger = capture([finalRow(1)]);
  assert.equal(Object.isFrozen(ledger), true);
  assert.equal(Object.isFrozen(ledger.entries), true);
  assert.equal(Object.isFrozen(ledger.entries[0]), true);
  assert.equal(Object.isFrozen(ledger.entries[0].routes), true);
  assert.throws(() => { (ledger.entries[0].routes as any).A_PLUS_HOME_ML = "NO_MATCH"; }, TypeError);
  assert.equal(ledger.entries[0].routes.A_PLUS_HOME_ML, "MATCH");
});
