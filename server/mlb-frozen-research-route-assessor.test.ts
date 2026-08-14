import assert from "node:assert/strict";
import test from "node:test";
import { captureMlbFrozenResearchRouteLedger } from "./mlb-frozen-research-route-ledger";
import {
  assessMlbFrozenResearchRoutes,
  MLB_FROZEN_RESEARCH_ROUTE_ASSESSOR_VERSION,
  type MlbFrozenRouteClassifierSnapshot,
} from "./mlb-frozen-research-route-assessor";

const BASE = {
  gamePk: 777001,
  gameDate: "2026-08-13",
  scheduledStartTime: "2026-08-13T23:05:00.000Z",
  evaluatedAt: "2026-08-13T20:00:00.000Z",
  finalInputs: true,
} as const;

function classifiers(overrides: Partial<MlbFrozenRouteClassifierSnapshot> = {}): MlbFrozenRouteClassifierSnapshot {
  return {
    premiumA: true,
    aPlus: true,
    slg: { eligible: true, adv: 0.02 },
    pitchmix: {
      eligible: true,
      contactAdv: 0.01,
      whiffAdv: 0.02,
      tbpaAdv: -0.01,
      hrpaAdv: -0.02,
    },
    f5Consensus: false,
    bullpenD1Eligible: true,
    bullpenPitches1dAdv: 18,
    ...overrides,
  };
}

test("A+ with frozen D1 positive routes prospectively to First 5 without removing the A+ opportunity", () => {
  const row = assessMlbFrozenResearchRoutes({ ...BASE, classifiers: classifiers() });
  assert.equal(row.routes.PREMIUM_A_HOME_ML, "MATCH");
  assert.equal(row.routes.A_PLUS_HOME_ML, "MATCH");
  assert.equal(row.routes.A_PLUS_SLG_POS, "MATCH");
  assert.equal(row.routes.A_PLUS_PITCHMIX_AT2, "MATCH");
  assert.equal(row.routes.F5_HRPA_OR_AT2, "NO_MATCH");
  assert.equal(row.routes.F5_PARETO_UNION, "NO_MATCH");
  assert.equal(row.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "FIRST_5_HOME");
  assert.equal(row.scorerVersion, MLB_FROZEN_RESEARCH_ROUTE_ASSESSOR_VERSION);
});

test("A+ at frozen D1 sign boundary routes to Full Game", () => {
  const zero = assessMlbFrozenResearchRoutes({
    ...BASE,
    classifiers: classifiers({ bullpenPitches1dAdv: 0 }),
  });
  const negative = assessMlbFrozenResearchRoutes({
    ...BASE,
    classifiers: classifiers({ bullpenPitches1dAdv: -7 }),
  });
  assert.equal(zero.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "FULL_GAME_HOME");
  assert.equal(negative.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "FULL_GAME_HOME");
});

test("non-A+ router is not applicable and outside-A F5 unions preserve the frozen logical definitions", () => {
  const row = assessMlbFrozenResearchRoutes({
    ...BASE,
    classifiers: classifiers({
      premiumA: false,
      aPlus: false,
      f5Consensus: true,
      bullpenD1Eligible: false,
      bullpenPitches1dAdv: null,
      pitchmix: {
        eligible: true,
        contactAdv: -0.01,
        whiffAdv: -0.02,
        tbpaAdv: 0.03,
        hrpaAdv: -0.04,
      },
    }),
  });
  assert.equal(row.routes.PREMIUM_A_HOME_ML, "NO_MATCH");
  assert.equal(row.routes.A_PLUS_HOME_ML, "NO_MATCH");
  assert.equal(row.routes.F5_HRPA_OR_AT2, "NO_MATCH");
  assert.equal(row.routes.F5_PARETO_UNION, "MATCH");
  assert.equal(row.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "NOT_APPLICABLE");
});

test("provisional inputs are retained but every frozen route and router stays not evaluated", () => {
  const row = assessMlbFrozenResearchRoutes({
    ...BASE,
    finalInputs: false,
    classifiers: undefined,
  });
  assert.equal(row.finalInputs, false);
  assert.deepEqual(new Set(Object.values(row.routes)), new Set(["NOT_EVALUATED"]));
  assert.deepEqual(new Set(Object.values(row.routers)), new Set(["NOT_EVALUATED"]));
});

test("A+ fails closed when exact bullpen D1 evidence is absent or the frozen eligibility gate fails", () => {
  assert.throws(
    () => assessMlbFrozenResearchRoutes({
      ...BASE,
      classifiers: classifiers({ bullpenPitches1dAdv: null }),
    }),
    /MLB_FROZEN_ROUTE_BULLPEN_D1_REQUIRED_FOR_APLUS/,
  );
  assert.throws(
    () => assessMlbFrozenResearchRoutes({
      ...BASE,
      classifiers: classifiers({ bullpenD1Eligible: false }),
    }),
    /MLB_FROZEN_ROUTE_BULLPEN_D1_INELIGIBLE_FOR_APLUS/,
  );
});

test("assessment is deterministic and accepted by the frozen ledger contract", () => {
  const input = { ...BASE, classifiers: classifiers() };
  const first = assessMlbFrozenResearchRoutes(input);
  const second = assessMlbFrozenResearchRoutes(input);
  assert.equal(first.featureSnapshotDigest, second.featureSnapshotDigest);
  assert.match(first.featureSnapshotDigest, /^[a-f0-9]{64}$/);

  const ledger = captureMlbFrozenResearchRouteLedger({
    sourceRunId: "route-assessor-test",
    capturedAt: "2026-08-13T20:01:00.000Z",
    analysisEligibleGamePks: [BASE.gamePk],
    assessments: [first],
  });
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.summary.routerDecisions.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1.first5Home, 1);
  assert.equal(ledger.policy.routerDecisionChangesLiveRecommendation, false);
  assert.equal(ledger.policy.routerDecisionProspectiveOnly, true);
});
