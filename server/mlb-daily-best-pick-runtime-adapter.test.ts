import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA,
  type MlbFrozenResearchRouteLedgerEntry,
} from "./mlb-frozen-research-route-ledger";
import {
  MLB_UNIFIED_RUNNER_SCHEMA,
  type MlbUnifiedRunnerResult,
} from "./mlb-unified-runner";
import {
  MLB_DAILY_BEST_PICK_RUNTIME_ADAPTER_SCHEMA,
  selectMlbDailyBestPickFromUnifiedPreprice,
} from "./mlb-daily-best-pick-runtime-adapter";

const DATE = "2026-08-17";
const RUN = "run-daily-best-pick-test";

function routeStates(overrides: Partial<MlbFrozenResearchRouteLedgerEntry["routes"]> = {}) {
  return {
    PREMIUM_A_HOME_ML: "NO_MATCH" as const,
    A_PLUS_HOME_ML: "NO_MATCH" as const,
    A_PLUS_SLG_POS: "NO_MATCH" as const,
    A_PLUS_PITCHMIX_AT2: "NO_MATCH" as const,
    F5_HRPA_OR_AT2: "NO_MATCH" as const,
    F5_PARETO_UNION: "NO_MATCH" as const,
    ...overrides,
  };
}

function entry(input: {
  gamePk: number;
  finalInputs?: boolean;
  premium?: boolean;
  aPlus?: boolean;
  router?: MlbFrozenResearchRouteLedgerEntry["routers"]["A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1"];
}): MlbFrozenResearchRouteLedgerEntry {
  const finalInputs = input.finalInputs ?? true;
  const premium = input.premium ?? input.aPlus ?? false;
  const aPlus = input.aPlus ?? false;
  const routes = finalInputs
    ? routeStates({
        PREMIUM_A_HOME_ML: premium ? "MATCH" : "NO_MATCH",
        A_PLUS_HOME_ML: aPlus ? "MATCH" : "NO_MATCH",
      })
    : {
        PREMIUM_A_HOME_ML: "NOT_EVALUATED" as const,
        A_PLUS_HOME_ML: "NOT_EVALUATED" as const,
        A_PLUS_SLG_POS: "NOT_EVALUATED" as const,
        A_PLUS_PITCHMIX_AT2: "NOT_EVALUATED" as const,
        F5_HRPA_OR_AT2: "NOT_EVALUATED" as const,
        F5_PARETO_UNION: "NOT_EVALUATED" as const,
      };
  const router = finalInputs
    ? input.router ?? (aPlus ? "FULL_GAME_HOME" : "NOT_APPLICABLE")
    : "NOT_EVALUATED";

  return {
    observationId: `obs-${input.gamePk}`,
    sourceRunId: RUN,
    gamePk: input.gamePk,
    gameDate: DATE,
    scheduledStartTime: `${DATE}T23:00:00.000Z`,
    evaluatedAt: `${DATE}T18:00:00.000Z`,
    capturedAt: `${DATE}T18:05:00.000Z`,
    finalInputs,
    featureSnapshotDigest: "a".repeat(64),
    scorerVersion: "mlb-frozen-research-route-assessor.v1",
    routes,
    routers: {
      A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1: router,
    },
  };
}

function runtime(input: {
  rankedGamePks: number[];
  entries: MlbFrozenResearchRouteLedgerEntry[];
}): MlbUnifiedRunnerResult {
  return {
    schemaVersion: MLB_UNIFIED_RUNNER_SCHEMA,
    runId: RUN,
    generatedAt: `${DATE}T18:05:00.000Z`,
    date: DATE,
    intrinsic: {
      rankedGames: input.rankedGamePks.map((gamePk) => ({ gamePk, officialDate: DATE })),
    },
    frozenRouteLedger: {
      schemaVersion: MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA,
      sourceRunId: RUN,
      capturedAt: `${DATE}T18:05:00.000Z`,
      entries: input.entries,
      policy: {
        outcomeMayAffectPregameAssessment: false,
        liveFilterChangeAllowed: false,
        rankingChangeAllowed: false,
        stakeChangeAllowed: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    },
    policy: {
      priceBoundaryCrossed: false,
      callsTheOddsApi: false,
      originalStep11cPopulationChanged: false,
      frozenRouteLedgerChangesRecommendation: false,
      frozenRouterDecisionChangesRecommendation: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  } as unknown as MlbUnifiedRunnerResult;
}

test("A+ FIRST_5 router is preserved from the frozen final evaluation", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [1001],
      entries: [entry({ gamePk: 1001, aPlus: true, router: "FIRST_5_HOME" })],
    }),
  });

  assert.equal(result.schemaVersion, MLB_DAILY_BEST_PICK_RUNTIME_ADAPTER_SCHEMA);
  assert.equal(result.selection.decision, "BEST_PICK");
  assert.equal(result.selection.pick?.tier, "A_PLUS");
  assert.equal(result.selection.pick?.market, "FIRST_5_ML");
  assert.equal(result.selection.pick?.side, "HOME");
  assert.equal(result.selection.pick?.route, "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1");
  assert.equal(result.selection.pick?.prepriceRank, 0);
});

test("A+ FULL_GAME router is preserved from the frozen final evaluation", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [1002],
      entries: [entry({ gamePk: 1002, aPlus: true, router: "FULL_GAME_HOME" })],
    }),
  });

  assert.equal(result.selection.pick?.tier, "A_PLUS");
  assert.equal(result.selection.pick?.market, "FULL_GAME_ML");
});

test("Premium keeps the frozen PREMIUM_A_HOME_ML full-game route", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [1003],
      entries: [entry({ gamePk: 1003, premium: true })],
    }),
  });

  assert.equal(result.selection.pick?.tier, "PREMIUM");
  assert.equal(result.selection.pick?.market, "FULL_GAME_ML");
  assert.equal(result.selection.pick?.route, "PREMIUM_A_HOME_ML");
  assert.equal(result.policy.premiumFrozenFullGameRoutePreserved, true);
});

test("A+ beats an earlier-ranked Premium without changing preprice rank inside either tier", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [2001, 2002],
      entries: [
        entry({ gamePk: 2001, premium: true }),
        entry({ gamePk: 2002, aPlus: true, router: "FULL_GAME_HOME" }),
      ],
    }),
  });

  assert.equal(result.evaluations[0]?.prepriceRank, 0);
  assert.equal(result.evaluations[1]?.prepriceRank, 1);
  assert.equal(result.selection.pick?.gamePk, 2002);
  assert.equal(result.selection.pick?.tier, "A_PLUS");
});

test("two A+ candidates preserve the existing preprice ordering", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [3002, 3001],
      entries: [
        entry({ gamePk: 3001, aPlus: true, router: "FULL_GAME_HOME" }),
        entry({ gamePk: 3002, aPlus: true, router: "FIRST_5_HOME" }),
      ],
    }),
  });

  assert.equal(result.selection.pick?.gamePk, 3002);
  assert.equal(result.selection.pick?.prepriceRank, 0);
  assert.equal(result.policy.existingPrepriceRankPreservedWithinTier, true);
  assert.equal(result.policy.rankingFormulaAdded, false);
});

test("provisional frozen rows cannot create READY evaluations", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [4001],
      entries: [entry({ gamePk: 4001, finalInputs: false })],
    }),
  });

  assert.equal(result.evaluations.length, 0);
  assert.equal(result.selection.decision, "NO_PLAY");
  assert.equal(result.audit.provisionalRowsSkipped, 1);
  assert.equal(result.policy.finalFrozenInputsOnly, true);
});

test("final frozen row with no A+ or Premium match produces NO_PLAY", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [5001],
      entries: [entry({ gamePk: 5001 })],
    }),
  });

  assert.equal(result.selection.decision, "NO_PLAY");
  assert.equal(result.audit.noAPlusOrPremiumRouteSkipped, 1);
});

test("frozen matches outside the existing ranked preprice population are not promoted", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({
      rankedGamePks: [6001],
      entries: [
        entry({ gamePk: 6001 }),
        entry({ gamePk: 6002, aPlus: true, router: "FIRST_5_HOME" }),
      ],
    }),
  });

  assert.equal(result.selection.decision, "NO_PLAY");
  assert.equal(result.audit.frozenRouteMatchesOutsideRankedPreprice, 1);
  assert.equal(result.policy.existingPrepricePopulationPreserved, true);
});

test("corrupt final A+ semantics fail closed instead of inventing a market", () => {
  const base = entry({ gamePk: 7001, aPlus: true, router: "FIRST_5_HOME" });
  const corrupted = {
    ...base,
    routers: {
      ...base.routers,
      A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1: "NOT_APPLICABLE" as const,
    },
  } as MlbFrozenResearchRouteLedgerEntry;

  assert.throws(
    () => selectMlbDailyBestPickFromUnifiedPreprice({
      runtime: runtime({ rankedGamePks: [7001], entries: [corrupted] }),
    }),
    /MLB_DAILY_BEST_PICK_APLUS_ROUTER_INVALID/,
  );
});

test("corrupt provisional evaluation fails closed", () => {
  const base = entry({ gamePk: 7002, finalInputs: false });
  const corrupted = {
    ...base,
    routes: {
      ...base.routes,
      PREMIUM_A_HOME_ML: "MATCH" as const,
    },
  } as MlbFrozenResearchRouteLedgerEntry;

  assert.throws(
    () => selectMlbDailyBestPickFromUnifiedPreprice({
      runtime: runtime({ rankedGamePks: [7002], entries: [corrupted] }),
    }),
    /MLB_DAILY_BEST_PICK_PROVISIONAL_ROUTE_EVALUATED/,
  );
});

test("date mismatch fails closed", () => {
  assert.throws(
    () => selectMlbDailyBestPickFromUnifiedPreprice({
      runtime: runtime({ rankedGamePks: [], entries: [] }),
      officialDate: "2026-08-18",
    }),
    /MLB_DAILY_BEST_PICK_RUNTIME_DATE_MISMATCH/,
  );
});

test("adapter never reads or changes V80 and never enables General/V68 fallback", () => {
  const result = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: runtime({ rankedGamePks: [], entries: [] }),
  });

  assert.equal(result.selection.decision, "NO_PLAY");
  assert.equal(result.policy.generalV68FallbackAllowed, false);
  assert.equal(result.policy.v80Read, false);
  assert.equal(result.policy.v80Changed, false);
  assert.equal(result.policy.priceBoundaryCrossed, false);
  assert.equal(result.policy.newThresholdAdded, false);
  assert.equal(result.policy.stakingChanged, false);
  assert.equal(result.policy.automaticBetPlacement, false);
  assert.equal(result.policy.realFinancialExposure, 0);
});
