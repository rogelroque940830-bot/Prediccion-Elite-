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
  buildMlbDailyBestPickProspectiveSnapshot,
  type MlbDailyBestPickProspectiveSnapshot,
} from "./mlb-daily-best-pick-prospective-custody-v1";
import {
  MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA,
  canonicalizeMlbDailyBestPickRows,
  type MlbDailyBestPickCanonicalizationStoredRow,
} from "./mlb-daily-best-pick-daily-canonicalization-v1";

const DATE = "2026-08-26";
const GAME_1 = 3001;
const GAME_2 = 3002;
const EARLY_GAME = 3099;

function routeStates(input: { premium: boolean; aPlus: boolean }) {
  return {
    PREMIUM_A_HOME_ML: input.premium ? "MATCH" : "NO_MATCH",
    A_PLUS_HOME_ML: input.aPlus ? "MATCH" : "NO_MATCH",
    A_PLUS_SLG_POS: "NO_MATCH",
    A_PLUS_PITCHMIX_AT2: "NO_MATCH",
    F5_HRPA_OR_AT2: "NO_MATCH",
    F5_PARETO_UNION: "NO_MATCH",
  } as const;
}

function entry(input: {
  runId: string;
  generatedAt: string;
  gamePk: number;
  start: string;
  premium: boolean;
  aPlus: boolean;
}): MlbFrozenResearchRouteLedgerEntry {
  return {
    observationId: `obs-${input.runId}-${input.gamePk}`,
    sourceRunId: input.runId,
    gamePk: input.gamePk,
    gameDate: DATE,
    scheduledStartTime: input.start,
    evaluatedAt: input.generatedAt,
    capturedAt: input.generatedAt,
    finalInputs: true,
    featureSnapshotDigest: `${input.gamePk}`.padStart(64, "a").slice(-64),
    scorerVersion: "synthetic-canonicalization-v1",
    routes: routeStates({ premium: input.premium, aPlus: input.aPlus }),
    routers: {
      A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1: input.aPlus ? "FIRST_5_HOME" : "NOT_APPLICABLE",
    },
  };
}

function runtime(input: {
  runId: string;
  generatedAt: string;
  slateStarts?: readonly [string | null, string | null, string | null?];
  relevantStarts?: readonly [string, string];
  aPlus?: boolean;
  premium?: boolean;
  rankedOrder?: readonly number[];
}): MlbUnifiedRunnerResult {
  const relevantStarts = input.relevantStarts ?? ["2026-08-26T22:00:00.000Z", "2026-08-26T23:00:00.000Z"];
  const slateStarts = input.slateStarts ?? ["2026-08-26T20:00:00.000Z", relevantStarts[0], relevantStarts[1]];
  const aPlus = input.aPlus ?? true;
  const premium = input.premium ?? true;
  const rankedOrder = input.rankedOrder ?? [GAME_1, GAME_2];
  const entries = [
    entry({
      runId: input.runId,
      generatedAt: input.generatedAt,
      gamePk: GAME_1,
      start: relevantStarts[0],
      premium,
      aPlus: false,
    }),
    entry({
      runId: input.runId,
      generatedAt: input.generatedAt,
      gamePk: GAME_2,
      start: relevantStarts[1],
      premium,
      aPlus,
    }),
  ];
  const rankedGames = rankedOrder.map((gamePk) => ({
    gamePk,
    officialDate: DATE,
    startTime: gamePk === GAME_1 ? relevantStarts[0] : relevantStarts[1],
  }));
  const cheapGames = [
    { gamePk: EARLY_GAME, officialDate: DATE, startTime: slateStarts[0] },
    { gamePk: GAME_1, officialDate: DATE, startTime: slateStarts[1] },
    { gamePk: GAME_2, officialDate: DATE, startTime: slateStarts[2] ?? relevantStarts[1] },
  ];
  return {
    schemaVersion: MLB_UNIFIED_RUNNER_SCHEMA,
    runId: input.runId,
    generatedAt: input.generatedAt,
    date: DATE,
    cheapScreen: { games: cheapGames } as any,
    shortlist: {} as any,
    intrinsic: { rankedGames } as any,
    discovery: {} as any,
    frozenRouteLedger: {
      schemaVersion: MLB_FROZEN_RESEARCH_ROUTE_LEDGER_SCHEMA,
      sourceRunId: input.runId,
      capturedAt: input.generatedAt,
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

function snapshot(input: {
  runId: string;
  generatedAt: string;
  capturedAt?: string;
  slateStarts?: readonly [string | null, string | null, string | null?];
  aPlus?: boolean;
  premium?: boolean;
  rankedOrder?: readonly number[];
}): MlbDailyBestPickProspectiveSnapshot {
  return buildMlbDailyBestPickProspectiveSnapshot({
    preprice: runtime(input),
    capturedAtUtc: input.capturedAt ?? input.generatedAt,
  });
}

function row(
  value: MlbDailyBestPickProspectiveSnapshot,
  createdAtIso: string,
): MlbDailyBestPickCanonicalizationStoredRow {
  return {
    officialDate: value.officialDate,
    sourceRunId: value.sourceRunId,
    createdAtMs: Date.parse(createdAtIso),
    snapshot: value,
  };
}

test("latest eligible pregame row wins without consulting model output", () => {
  const early = snapshot({ runId: "run-a", generatedAt: "2026-08-26T17:00:00.000Z", aPlus: true });
  const late = snapshot({ runId: "run-b", generatedAt: "2026-08-26T19:30:00.000Z", aPlus: false, premium: false });
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [row(early, "2026-08-26T17:00:01.000Z"), row(late, "2026-08-26T19:30:01.000Z")],
  });
  assert.equal(result.schemaVersion, MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA);
  assert.equal(result.status, "CANONICAL");
  if (result.status !== "CANONICAL") return;
  assert.equal(result.datePregameCutoffUtc, "2026-08-26T20:00:00.000Z");
  assert.equal(result.canonicalSourceRunId, "run-b");
  assert.equal(result.canonicalDecision, "NO_PLAY");
  assert.equal(result.counts.eligiblePregameRows, 2);
  assert.equal(result.safety.outcomesRead, false);
  assert.equal(result.safety.modelProbabilityAffectsCanonicalSelection, false);
});

test("capture after the earliest full-slate game is rejected even if ranked games have not started", () => {
  const postEarlyGame = snapshot({
    runId: "run-post-early",
    generatedAt: "2026-08-26T20:30:00.000Z",
    relevantStarts: undefined as never,
  } as any);
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [row(postEarlyGame, "2026-08-26T20:30:01.000Z")],
  });
  assert.equal(result.status, "NO_CANONICAL");
  assert.equal(result.datePregameCutoffUtc, "2026-08-26T20:00:00.000Z");
  if (result.status === "NO_CANONICAL") {
    assert.equal(result.reason, "NO_STRICTLY_PREGAME_INGESTED_SNAPSHOT_BEFORE_DATE_CUTOFF");
    assert.equal(result.counts.rejectedPregameBoundaryRows, 1);
  }
});

test("late database insertion cannot backfill an old embedded pregame timestamp", () => {
  const oldRuntime = snapshot({ runId: "run-old", generatedAt: "2026-08-26T19:00:00.000Z" });
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [row(oldRuntime, "2026-08-26T20:00:00.000Z")],
  });
  assert.equal(result.status, "NO_CANONICAL");
  if (result.status === "NO_CANONICAL") {
    assert.equal(result.reason, "NO_STRICTLY_PREGAME_INGESTED_SNAPSHOT_BEFORE_DATE_CUTOFF");
  }
});

test("NO_PLAY is a valid canonical decision and never filtered out", () => {
  const noPlay = snapshot({
    runId: "run-no-play",
    generatedAt: "2026-08-26T19:00:00.000Z",
    aPlus: false,
    premium: false,
  });
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [row(noPlay, "2026-08-26T19:00:01.000Z")],
  });
  assert.equal(result.status, "CANONICAL");
  if (result.status === "CANONICAL") assert.equal(result.canonicalDecision, "NO_PLAY");
});

test("an earlier schedule in any complete immutable snapshot defines the conservative date cutoff", () => {
  const earlySchedule = snapshot({
    runId: "run-early-schedule",
    generatedAt: "2026-08-26T18:00:00.000Z",
    slateStarts: ["2026-08-26T20:00:00.000Z", "2026-08-26T22:00:00.000Z", "2026-08-26T23:00:00.000Z"],
  });
  const delayedSchedule = snapshot({
    runId: "run-delayed-schedule",
    generatedAt: "2026-08-26T20:30:00.000Z",
    capturedAt: "2026-08-26T20:30:00.000Z",
    slateStarts: ["2026-08-26T21:00:00.000Z", "2026-08-26T22:00:00.000Z", "2026-08-26T23:00:00.000Z"],
  });
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [
      row(earlySchedule, "2026-08-26T18:00:01.000Z"),
      row(delayedSchedule, "2026-08-26T20:30:01.000Z"),
    ],
  });
  assert.equal(result.status, "CANONICAL");
  if (result.status !== "CANONICAL") return;
  assert.equal(result.datePregameCutoffUtc, "2026-08-26T20:00:00.000Z");
  assert.equal(result.canonicalSourceRunId, "run-early-schedule");
  assert.equal(result.counts.rejectedPregameBoundaryRows, 1);
});

test("row with missing full-slate start time cannot become canonical", () => {
  const incomplete = snapshot({
    runId: "run-incomplete",
    generatedAt: "2026-08-26T19:30:00.000Z",
    slateStarts: [null, "2026-08-26T22:00:00.000Z", "2026-08-26T23:00:00.000Z"],
  });
  const complete = snapshot({ runId: "run-complete", generatedAt: "2026-08-26T19:00:00.000Z" });
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [
      row(incomplete, "2026-08-26T19:30:01.000Z"),
      row(complete, "2026-08-26T19:00:01.000Z"),
    ],
  });
  assert.equal(result.status, "CANONICAL");
  if (result.status !== "CANONICAL") return;
  assert.equal(result.canonicalSourceRunId, "run-complete");
  assert.equal(result.counts.rejectedIncompleteScheduleRows, 1);
});

test("tie breaks are deterministic and do not prefer BEST_PICK over NO_PLAY", () => {
  const best = snapshot({ runId: "run-z", generatedAt: "2026-08-26T19:00:00.000Z", aPlus: true });
  const noPlay = snapshot({ runId: "run-a", generatedAt: "2026-08-26T19:00:00.000Z", aPlus: false, premium: false });
  const created = "2026-08-26T19:00:01.000Z";
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [row(best, created), row(noPlay, created)],
  });
  assert.equal(result.status, "CANONICAL");
  if (result.status !== "CANONICAL") return;
  assert.equal(result.canonicalSourceRunId, "run-a");
  assert.equal(result.canonicalDecision, "NO_PLAY");
});

test("tampered snapshot is excluded before canonical sorting", () => {
  const valid = snapshot({ runId: "run-valid", generatedAt: "2026-08-26T18:00:00.000Z" });
  const tampered = JSON.parse(JSON.stringify(snapshot({
    runId: "run-tampered",
    generatedAt: "2026-08-26T19:30:00.000Z",
  })));
  tampered.orderedIntrinsicRankedGames = [...tampered.orderedIntrinsicRankedGames].reverse();
  const result = canonicalizeMlbDailyBestPickRows({
    officialDate: DATE,
    rows: [
      row(valid, "2026-08-26T18:00:01.000Z"),
      {
        officialDate: DATE,
        sourceRunId: "run-tampered",
        createdAtMs: Date.parse("2026-08-26T19:30:01.000Z"),
        snapshot: tampered,
      },
    ],
  });
  assert.equal(result.status, "CANONICAL");
  if (result.status !== "CANONICAL") return;
  assert.equal(result.canonicalSourceRunId, "run-valid");
  assert.equal(result.counts.rejectedIntegrityRows, 1);
});
