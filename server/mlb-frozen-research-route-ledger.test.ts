import assert from "node:assert/strict";
import test from "node:test";
import {
  captureMlbFrozenResearchRouteLedger,
  MLB_FROZEN_RESEARCH_ROUTE_IDS,
  MLB_FROZEN_RESEARCH_ROUTER_IDS,
  type MlbFrozenResearchRouteAssessment,
} from "./mlb-frozen-research-route-ledger";

const digest = "a".repeat(64);

function routes(state: "MATCH" | "NO_MATCH" | "NOT_EVALUATED") {
  return Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTE_IDS.map((id) => [id, state])) as MlbFrozenResearchRouteAssessment["routes"];
}

function routers(state: "FIRST_5_HOME" | "FULL_GAME_HOME" | "NOT_APPLICABLE" | "NOT_EVALUATED") {
  return Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTER_IDS.map((id) => [id, state])) as MlbFrozenResearchRouteAssessment["routers"];
}

function finalRow(gamePk: number): MlbFrozenResearchRouteAssessment {
  const row: MlbFrozenResearchRouteAssessment = {
    gamePk,
    gameDate: "2026-08-13",
    scheduledStartTime: "2026-08-13T23:10:00.000Z",
    evaluatedAt: "2026-08-13T22:30:00.000Z",
    finalInputs: true,
    featureSnapshotDigest: digest,
    scorerVersion: "frozen-routes-v15-router-v2",
    routes: routes("NO_MATCH"),
    routers: routers("NOT_APPLICABLE"),
  };
  row.routes.PREMIUM_A_HOME_ML = "MATCH";
  row.routes.A_PLUS_HOME_ML = "MATCH";
  row.routes.A_PLUS_SLG_POS = "MATCH";
  row.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "FIRST_5_HOME";
  return row;
}

function nonAPlusFinalRow(gamePk: number): MlbFrozenResearchRouteAssessment {
  const row = finalRow(gamePk);
  row.routes.A_PLUS_HOME_ML = "NO_MATCH";
  row.routes.A_PLUS_SLG_POS = "NO_MATCH";
  row.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "NOT_APPLICABLE";
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
    scorerVersion: "frozen-routes-v15-router-v2",
    routes: routes("NOT_EVALUATED"),
    routers: routers("NOT_EVALUATED"),
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

test("provisional games remain visible with routes and routers NOT_EVALUATED", () => {
  const ledger = capture([provisionalRow(2)]);
  for (const id of MLB_FROZEN_RESEARCH_ROUTE_IDS) assert.equal(ledger.entries[0].routes[id], "NOT_EVALUATED");
  for (const id of MLB_FROZEN_RESEARCH_ROUTER_IDS) assert.equal(ledger.entries[0].routers[id], "NOT_EVALUATED");
});

test("a provisional game cannot be silently evaluated by route or router", () => {
  const routeRow = provisionalRow(2);
  routeRow.routes.A_PLUS_HOME_ML = "MATCH";
  assert.throws(() => capture([routeRow]), /PROVISIONAL_MUST_NOT_EVALUATE/);

  const routerRow = provisionalRow(3);
  routerRow.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "FIRST_5_HOME";
  assert.throws(() => capture([routerRow]), /ROUTER_PROVISIONAL_MUST_NOT_EVALUATE/);
});

test("a final-input game must evaluate every frozen route and router", () => {
  const routeRow = finalRow(1);
  routeRow.routes.F5_PARETO_UNION = "NOT_EVALUATED";
  assert.throws(() => capture([routeRow]), /FINAL_MUST_EVALUATE_ALL/);

  const routerRow = finalRow(2);
  routerRow.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "NOT_EVALUATED";
  assert.throws(() => capture([routerRow]), /ROUTER_FINAL_MUST_EVALUATE_ALL/);
});

test("V15 router applies to every final A+ and preserves non-A+ as NOT_APPLICABLE", () => {
  const aPlus = finalRow(1);
  aPlus.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "FULL_GAME_HOME";
  const nonAPlus = nonAPlusFinalRow(2);
  const ledger = capture([aPlus, nonAPlus]);
  assert.equal(ledger.entries.find((row) => row.gamePk === 1)?.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "FULL_GAME_HOME");
  assert.equal(ledger.entries.find((row) => row.gamePk === 2)?.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "NOT_APPLICABLE");
  assert.equal(ledger.summary.routerDecisions.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1.fullGameHome, 1);
  assert.equal(ledger.summary.routerDecisions.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1.notApplicable, 1);
  assert.equal(ledger.policy.routerDecisionCanRemoveOpportunity, false);
  assert.equal(ledger.policy.routerDecisionChangesLiveRecommendation, false);
});

test("A+ cannot omit a V15 market decision and non-A+ cannot receive one", () => {
  const missing = finalRow(1);
  missing.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "NOT_APPLICABLE";
  assert.throws(() => capture([missing]), /APLUS_DECISION_REQUIRED/);

  const forged = nonAPlusFinalRow(2);
  forged.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "FIRST_5_HOME";
  assert.throws(() => capture([forged]), /NON_APLUS_MUST_NOT_APPLY/);
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

test("route and router metadata are deeply immutable", () => {
  const ledger = capture([finalRow(1)]);
  assert.equal(Object.isFrozen(ledger), true);
  assert.equal(Object.isFrozen(ledger.entries), true);
  assert.equal(Object.isFrozen(ledger.entries[0]), true);
  assert.equal(Object.isFrozen(ledger.entries[0].routes), true);
  assert.equal(Object.isFrozen(ledger.entries[0].routers), true);
  assert.throws(() => { (ledger.entries[0].routes as any).A_PLUS_HOME_ML = "NO_MATCH"; }, TypeError);
  assert.throws(() => { (ledger.entries[0].routers as any).A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1 = "FULL_GAME_HOME"; }, TypeError);
  assert.equal(ledger.entries[0].routes.A_PLUS_HOME_ML, "MATCH");
  assert.equal(ledger.entries[0].routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "FIRST_5_HOME");
});
