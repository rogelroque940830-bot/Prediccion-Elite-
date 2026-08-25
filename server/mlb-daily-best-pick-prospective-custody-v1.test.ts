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
  MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA,
  MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE,
  MlbDailyBestPickProspectiveCustodyStore,
  buildMlbDailyBestPickProspectiveSnapshot,
  captureMlbDailyBestPickProspective,
  parseMlbDailyBestPickProspectiveSnapshot,
} from "./mlb-daily-best-pick-prospective-custody-v1";

const DATE = "2026-08-26";
const RUN = "run-prospective-custody-1";
const GENERATED = "2026-08-26T16:00:00.000Z";
const CAPTURED = "2026-08-26T16:00:01.000Z";

function routes(input: { premium: boolean; aPlus: boolean }) {
  return {
    PREMIUM_A_HOME_ML: input.premium ? "MATCH" : "NO_MATCH",
    A_PLUS_HOME_ML: input.aPlus ? "MATCH" : "NO_MATCH",
    A_PLUS_SLG_POS: "NO_MATCH",
    A_PLUS_PITCHMIX_AT2: "NO_MATCH",
    F5_HRPA_OR_AT2: "NO_MATCH",
    F5_PARETO_UNION: "NO_MATCH",
  } as const;
}

function ledgerEntry(input: {
  gamePk: number;
  premium: boolean;
  aPlus: boolean;
  start: string;
}): MlbFrozenResearchRouteLedgerEntry {
  return {
    observationId: `obs-${input.gamePk}`,
    sourceRunId: RUN,
    gamePk: input.gamePk,
    gameDate: DATE,
    scheduledStartTime: input.start,
    evaluatedAt: GENERATED,
    capturedAt: GENERATED,
    finalInputs: true,
    featureSnapshotDigest: String(input.gamePk).padStart(64, "a").slice(-64),
    scorerVersion: "synthetic-frozen-route-v1",
    routes: routes({ premium: input.premium, aPlus: input.aPlus }),
    routers: {
      A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1: input.aPlus ? "FIRST_5_HOME" : "NOT_APPLICABLE",
    },
  };
}

function runtime(order: readonly number[] = [2001, 2002], date = DATE): MlbUnifiedRunnerResult {
  const entries = [
    ledgerEntry({ gamePk: 2001, premium: true, aPlus: false, start: "2026-08-26T22:00:00.000Z" }),
    ledgerEntry({ gamePk: 2002, premium: true, aPlus: true, start: "2026-08-26T23:00:00.000Z" }),
  ].map((entry) => date === DATE ? entry : { ...entry, gameDate: date });
  const rankedGames = order.map((gamePk) => ({
    gamePk,
    officialDate: date,
    startTime: gamePk === 2001 ? "2026-08-26T22:00:00.000Z" : "2026-08-26T23:00:00.000Z",
  }));
  return {
    schemaVersion: MLB_UNIFIED_RUNNER_SCHEMA,
    runId: RUN,
    generatedAt: GENERATED,
    date,
    cheapScreen: {} as any,
    shortlist: {} as any,
    intrinsic: { rankedGames } as any,
    discovery: {} as any,
    frozenRouteLedger: {
      schemaVersion: MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA,
      sourceRunId: RUN,
      capturedAt: GENERATED,
      entries,
      summary: {} as any,
      policy: {
        companionToStep11c: true,
        changesStep11aPopulation: false,
        changesOriginalStep11cPopulation: false,
        allAnalysisEligibleGamesRequireOneRow: true,
        provisionalGamesMayBeDropped: false,
        provisionalRoutesMustBeNotEvaluated: true,
        provisionalRoutersMustBeNotEvaluated: true,
        finalAPlusRequiresRouterDecision: true,
        finalNonAPlusRouterMustBeNotApplicable: true,
        routerDecisionCanRemoveOpportunity: false,
        routerDecisionChangesLiveRecommendation: false,
        routerDecisionProspectiveOnly: true,
        outcomeMayAffectPregameAssessment: false,
        liveFilterChangeAllowed: false,
        rankingChangeAllowed: false,
        stakeChangeAllowed: false,
        betEliteAllowed: false,
        finalBetRecommendationProduced: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    },
    summary: {} as any,
    policy: {
      explicitInvocationRequired: true,
      automaticPolling: false,
      officialSlateUsed: true,
      provisionalGamesPreserved: true,
      provisionalGamesCanCreateFinalRouteMatch: false,
      provisionalGamesCanCreateRouterDecision: false,
      finalGamesRequireFrozenRouteAssessment: true,
      finalAPlusGamesRequireFrozenRouterDecision: true,
      intrinsicRankIndependentOfGameStartTime: true,
      priceBoundaryCrossed: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      originalStep11cPopulationChanged: false,
      frozenRouteLedgerChangesRecommendation: false,
      frozenRouterDecisionChangesRecommendation: false,
      betEliteProduced: false,
      finalBetRecommendationProduced: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}

test("snapshot preserves exact ranked population, frozen routes and selector output without prices or outcomes", () => {
  const snapshot = buildMlbDailyBestPickProspectiveSnapshot({ preprice: runtime(), capturedAtUtc: CAPTURED });
  assert.equal(snapshot.schemaVersion, MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA);
  assert.equal(snapshot.officialDate, DATE);
  assert.equal(snapshot.sourceRunId, RUN);
  assert.deepEqual(snapshot.orderedIntrinsicRankedGames, [2001, 2002]);
  assert.equal(snapshot.frozenRouteLedgerForCapturedRuntime.entries.length, 2);
  assert.equal(snapshot.dailyBestPickAdapterEvaluations.length, 2);
  assert.equal(snapshot.dailyBestPickSelectorResult.decision, "BEST_PICK");
  assert.equal(snapshot.dailyBestPickSelectorResult.pick?.gamePk, 2002);
  assert.equal(snapshot.dailyBestPickSelectorResult.pick?.tier, "A_PLUS");
  assert.equal(snapshot.prepriceRuntime.runId, RUN);
  assert.equal(snapshot.safety.outcomesRead, false);
  assert.equal(snapshot.safety.sportsbookPricesReadForCustody, false);
  assert.equal(snapshot.safety.performanceMetricsRead, false);
  assert.match(snapshot.snapshotDigest, /^[a-f0-9]{64}$/);
});

test("append-only store is idempotent for the same immutable source run", () => {
  const store = new MlbDailyBestPickProspectiveCustodyStore({ filename: ":memory:", allowInMemoryForTests: true });
  try {
    const snapshot = buildMlbDailyBestPickProspectiveSnapshot({ preprice: runtime(), capturedAtUtc: CAPTURED });
    const first = store.putFirstCanonical(snapshot);
    const second = store.putFirstCanonical(snapshot);
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    assert.equal(second.snapshot.snapshotDigest, first.snapshot.snapshotDigest);
    assert.equal(store.listDate(DATE).length, 1);
    const status = store.status();
    assert.equal(status.capturedSnapshots, 1);
    assert.equal(status.distinctCapturedDates, 1);
    assert.equal(status.outcomeReadUnlocked, false);
    assert.equal(status.canonicalDailyRunDefined, false);
    assert.equal(status.selectedPopulationProbabilityScoringAllowed, false);
  } finally {
    store.close();
  }
});

test("same date and sourceRunId cannot be overwritten by a different ranked runtime", () => {
  const store = new MlbDailyBestPickProspectiveCustodyStore({ filename: ":memory:", allowInMemoryForTests: true });
  try {
    const first = buildMlbDailyBestPickProspectiveSnapshot({ preprice: runtime([2001, 2002]), capturedAtUtc: CAPTURED });
    const conflicting = buildMlbDailyBestPickProspectiveSnapshot({ preprice: runtime([2002, 2001]), capturedAtUtc: CAPTURED });
    store.putFirstCanonical(first);
    assert.throws(
      () => store.putFirstCanonical(conflicting),
      /MLB_DAILY_BEST_PICK_PROSPECTIVE_SOURCE_RUN_IMMUTABILITY_CONFLICT/,
    );
    assert.deepEqual(store.get(DATE, RUN)?.orderedIntrinsicRankedGames, [2001, 2002]);
  } finally {
    store.close();
  }
});

test("tampered serialized snapshot fails digest and semantic reconstruction", () => {
  const snapshot = buildMlbDailyBestPickProspectiveSnapshot({ preprice: runtime(), capturedAtUtc: CAPTURED });
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.orderedIntrinsicRankedGames = [2002, 2001];
  assert.equal(parseMlbDailyBestPickProspectiveSnapshot(tampered), null);
});

test("capture is rejected at or after any relevant game start boundary", () => {
  assert.throws(
    () => buildMlbDailyBestPickProspectiveSnapshot({
      preprice: runtime(),
      capturedAtUtc: "2026-08-26T22:00:00.000Z",
    }),
    /MLB_DAILY_BEST_PICK_PROSPECTIVE_CAPTURE_NOT_STRICTLY_PREGAME:2001/,
  );
});

test("historical backfill is skipped before the frozen prospective first date", () => {
  const old = runtime([2001, 2002], "2026-08-25");
  const result = captureMlbDailyBestPickProspective({
    preprice: old,
    capturedAtUtc: GENERATED,
    custody: {
      putFirstCanonical() {
        throw new Error("must not write before boundary");
      },
    },
  });
  assert.equal(MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE, "2026-08-26");
  assert.equal(result.status, "SKIPPED_BEFORE_PROSPECTIVE_BOUNDARY");
  assert.equal(result.snapshot, null);
});
