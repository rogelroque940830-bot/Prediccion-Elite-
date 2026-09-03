import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import { executeMlbUnifiedV16UiCommand } from "./mlb-unified-v16-ui-routes";

const DATE = "2026-08-13";

function slate(stage: "FINAL" | "PROVISIONAL"): MlbP1DailySlate {
  const final = stage === "FINAL";
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: DATE,
    generatedAt: "2026-08-13T17:00:00.000Z",
    games: [{
      gamePk: 123,
      startTime: "2026-08-13T23:10:00.000Z",
      officialDate: DATE,
      venue: "Test Park",
      state: "PREGAME",
      detailedState: "Pre-Game",
      homeTeam: { id: 1, name: "Home" },
      awayTeam: { id: 2, name: "Away" },
      homePitcher: { id: 11, name: "Home SP", hand: "R", confirmed: true },
      awayPitcher: { id: 22, name: "Away SP", hand: "L", confirmed: true },
      lineupState: final ? "CONFIRMED" : "NOT_POSTED",
      homeLineupCount: final ? 9 : 0,
      awayLineupCount: final ? 9 : 0,
      readiness: final ? "READY_TO_ANALYZE" : "PROVISIONAL_WAITING_FOR_LINEUPS",
      analysisStage: stage,
      analysisAllowed: true,
      blockers: final ? [] : ["LINEUPS_PENDING"],
      source: { name: "MLB_STATS_API", fetchedAt: "2026-08-13T17:00:00.000Z", quality: "AUTHORITATIVE" },
    }],
    summary: {
      total: 1,
      ready: final ? 1 : 0,
      provisional: final ? 0 : 1,
      waitingForPitchers: 0,
      startedOrClosed: 0,
      dataInsufficient: 0,
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

function frozenRoutes(tier: "A_PLUS" | "PREMIUM" | "NONE") {
  return {
    PREMIUM_A_HOME_ML: tier === "A_PLUS" || tier === "PREMIUM" ? "MATCH" : "NO_MATCH",
    A_PLUS_HOME_ML: tier === "A_PLUS" ? "MATCH" : "NO_MATCH",
    A_PLUS_SLG_POS: "NO_MATCH",
    A_PLUS_PITCHMIX_AT2: "NO_MATCH",
    F5_HRPA_OR_AT2: "NO_MATCH",
    F5_PARETO_UNION: "NO_MATCH",
  } as const;
}

function basePreprice(input: {
  runId: string;
  plannedMarkets: string[];
  paidLookupEligibleNow: boolean;
  dailyTier: "A_PLUS" | "PREMIUM" | "NONE";
  stage?: "FINAL" | "PROVISIONAL";
}) {
  const stage = input.stage ?? "FINAL";
  const final = stage === "FINAL";
  const hasThesis = input.plannedMarkets.length > 0;
  const shortlistCandidate = {
    gamePk: 123,
    qualifiedForShortlist: true,
    certifiedComponentCount: 2,
    independentSignalCount: 2,
  };
  const intrinsicGame = {
    gamePk: 123,
    officialDate: DATE,
    inputStage: stage,
    startTime: "2026-08-13T23:10:00.000Z",
    awayTeam: { id: 2, name: "Away" },
    homeTeam: { id: 1, name: "Home" },
    researchClassification: hasThesis ? "GAME_ELITE_RESEARCH_CANDIDATE" : "NO_STRONG_THESIS",
  };
  return {
    schemaVersion: "courtedge-p0-mlb-unified-runner.preprice-step11c.v2",
    runId: input.runId,
    generatedAt: "2026-08-13T17:01:00.000Z",
    date: DATE,
    summary: {
      slateGames: 1,
      analysisEligibleGames: 1,
      finalAnalysisEligibleGames: final ? 1 : 0,
      provisionalAnalysisEligibleGames: final ? 0 : 1,
      intrinsicResearchEliteCandidates: hasThesis ? 1 : 0,
      gamesWithMarketDiscoveryPlan: hasThesis ? 1 : 0,
      gamesPaidLookupEligibleNow: input.paidLookupEligibleNow ? 1 : 0,
      frozenRouteRowsCaptured: 1,
    },
    cheapScreen: {
      games: [{ gamePk: 123, eligibleForDeepPrefilterNow: true, finalInputsAvailable: final }],
    },
    shortlist: { candidates: [shortlistCandidate], selected: [shortlistCandidate] },
    intrinsic: { games: [intrinsicGame], rankedGames: [intrinsicGame] },
    discovery: {
      games: [{
        gamePk: 123,
        inputStage: stage,
        intrinsicRank: 1,
        plannedMarkets: input.plannedMarkets.map((canonicalMarketType) => ({ canonicalMarketType })),
        paidLookupEligibleNow: input.paidLookupEligibleNow,
        paidLookupHoldReason: input.paidLookupEligibleNow
          ? null
          : final
            ? "NO_STRONG_INTRINSIC_MARKET_THESIS"
            : "OFFICIAL_FINAL_INPUTS_REQUIRED",
      }],
      summary: { gamesPaidLookupEligibleNow: input.paidLookupEligibleNow ? 1 : 0 },
    },
    frozenRouteLedger: {
      schemaVersion: "courtedge-p0-mlb-frozen-research-route-ledger.v2",
      sourceRunId: input.runId,
      capturedAt: "2026-08-13T17:01:00.000Z",
      entries: [{
        observationId: "obs-123",
        sourceRunId: input.runId,
        gamePk: 123,
        gameDate: DATE,
        scheduledStartTime: "2026-08-13T23:10:00.000Z",
        evaluatedAt: "2026-08-13T17:00:30.000Z",
        capturedAt: "2026-08-13T17:01:00.000Z",
        finalInputs: final,
        featureSnapshotDigest: "a".repeat(64),
        scorerVersion: "frozen-route-router-scorer.v2",
        routes: final ? frozenRoutes(input.dailyTier) : {
          PREMIUM_A_HOME_ML: "NOT_EVALUATED",
          A_PLUS_HOME_ML: "NOT_EVALUATED",
          A_PLUS_SLG_POS: "NOT_EVALUATED",
          A_PLUS_PITCHMIX_AT2: "NOT_EVALUATED",
          F5_HRPA_OR_AT2: "NOT_EVALUATED",
          F5_PARETO_UNION: "NOT_EVALUATED",
        },
        routers: {
          A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1: final
            ? input.dailyTier === "A_PLUS" ? "FIRST_5_HOME" : "NOT_APPLICABLE"
            : "NOT_EVALUATED",
        },
      }],
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
  } as any;
}

function rankedOpportunity(stage: "FINAL" | "PROVISIONAL") {
  return {
    gamePk: 123,
    officialDate: DATE,
    startTime: "2026-08-13T23:10:00.000Z",
    awayTeam: "Away",
    homeTeam: "Home",
    inputStage: stage,
    contextRank: 1,
    intrinsicClassification: "NO_STRONG_THESIS",
    eligibleSportingOpportunity: false,
    context: {
      thesisKinds: [],
      thesisStructures: [],
      supportingComponents: [],
      fullGameElite: false,
      earlyWindowElite: false,
      maxAbsoluteNativeRunSignal: 0.1,
    },
    probability: {
      stage: stage === "FINAL" ? "CONFIRMED_V16" : "PROVISIONAL_V16",
      selectedSide: "HOME",
      selectedSideProbability: 0.58,
      lineupUncertaintyP95: stage === "PROVISIONAL" ? 0.0533 : 0,
      robustSelectedSideProbability: stage === "PROVISIONAL" ? 0.5267 : 0.58,
    },
  } as any;
}

function opportunityLive(input: {
  runId: string;
  tier: "A_PLUS" | "PREMIUM" | "NONE";
  stage: "FINAL" | "PROVISIONAL";
}) {
  const final = input.stage === "FINAL";
  const preprice = basePreprice({
    runId: input.runId,
    plannedMarkets: input.tier === "NONE" ? [] : ["ML"],
    paidLookupEligibleNow: final && input.tier !== "NONE",
    dailyTier: input.tier,
    stage: input.stage,
  });
  return {
    schemaVersion: "courtedge-mlb-daily-opportunity-live.v1",
    date: DATE,
    generatedAt: "2026-08-13T17:01:00.000Z",
    preprice,
    provisionalV16: input.stage === "PROVISIONAL"
      ? { 123: { gamePk: 123, generatedAt: "2026-08-13T17:01:00.000Z" } }
      : {},
    dailyOpportunity: {
      schemaVersion: "courtedge-mlb-daily-opportunity-context.v1",
      date: DATE,
      generatedAt: "2026-08-13T17:01:00.000Z",
      action: input.stage === "PROVISIONAL" ? "WAIT" : "NO_PLAY",
      primaryOpportunity: null,
      nonDominatedFrontier: [],
      rankedOpportunities: [rankedOpportunity(input.stage)],
      summary: {
        intrinsicEvaluatedGames: 1,
        eligibleSportingOpportunities: 0,
        provisionalEligibleOpportunities: 0,
        finalEligibleOpportunities: 0,
        frontierSize: 0,
      },
      decisionReason: "NO_CONTEXT_QUALIFIED_OPPORTUNITY",
      policy: {},
    },
  } as any;
}

function settlementEvidence() {
  return [{
    gamePk: 123,
    generatedAt: "2026-08-13T17:01:00.000Z",
    modelVersion: "fixture",
    manifestSha256: "fixture",
    priceIndependent: true,
    fullGame: { homeWinProbability: 0.612, awayWinProbability: 0.388, pushProbability: 0 },
    first5: { homeWinProbability: 0.55, awayWinProbability: 0.35, pushProbability: 0.10 },
  }];
}

function eliteRunnerResult(input: any) {
  const candidate = {
    gamePk: 123,
    marketType: "h2h",
    selectedSide: "HOME",
    selectedLine: null,
    modelWinProbability: 0.612,
    modelPushProbability: 0,
    expectedValuePerUnit: 0.074,
    executionEdgePp: 5.2,
    executionNoVigEdgePp: 4.8,
    referenceNoVigEdgePp: 4.4,
    referenceAgreement: "AGREES",
    executionBookTitle: "Test Book",
    executionOddsAmerican: -105,
    executionCapturedAt: "2026-08-13T17:00:30.000Z",
    intrinsicProjectionScope: "FULL_GAME",
    intrinsicThesisKinds: ["A_PLUS"],
    supportingComponents: ["C4", "FULL13"],
  };
  return {
    schemaVersion: "courtedge-p0-mlb-unified-priced-v16-runner.v1",
    runId: input.runId,
    date: DATE,
    generatedAt: "2026-08-13T17:01:00.000Z",
    summary: {
      finalGamesScoredByV16: 1,
      modelAssessments: 4,
      paidLookupEligibleGames: 1,
      positiveEvMarkets: 1,
      eliteEvidenceCandidates: 1,
      eliteEvidenceRowsCaptured: 1,
    },
    preprice: basePreprice({
      runId: input.runId,
      plannedMarkets: ["ML"],
      paidLookupEligibleNow: true,
      dailyTier: "A_PLUS",
      stage: "FINAL",
    }),
    settlementEvidence: settlementEvidence(),
    marketEdge: {
      games: [{ gamePk: 123, markets: [{ classification: "POSITIVE_EV", execution: { bookKey: "fixture" } }] }],
      summary: { positiveEvMarkets: 1, noPositiveEvMarkets: 0, blockedOrUnavailableMarkets: 0 },
    },
    operatingEnvelope: {
      games: [{ gamePk: 123, markets: [{ classification: "ELITE_EVIDENCE_CANDIDATE" }] }],
      summary: { positiveEvEnvelopeBlocked: 0, eliteEvidenceCandidates: 1 },
    },
    eliteEvidenceLedger: {
      summary: { capturedCandidates: 1 },
      entries: [{ predictionId: "pred-123-home-ml", candidate }],
    },
  } as any;
}

function assembled(stage: "FINAL" | "PROVISIONAL") {
  return {
    status: "READY",
    input: {
      runId: stage === "FINAL" ? "run-complete" : "run-provisional",
      slate: slate(stage),
      shortlistEvidence: { 123: {} },
      bullpenEvidence: { 123: {} },
      frozenRouteAssessments: { 123: {} },
      c4Assessments: { 123: {} },
    },
  } as any;
}

test("provisional-only command analyzes whole slate, exposes one provisional leader, and never calls price", async () => {
  let assemblyCalls = 0;
  let opportunityCalls = 0;
  let runtimeCalls = 0;
  let pricedCalls = 0;
  const response = await executeMlbUnifiedV16UiCommand(DATE, {
    buildSlate: async () => slate("PROVISIONAL"),
    assembleLiveInput: (async () => { assemblyCalls += 1; return assembled("PROVISIONAL"); }) as any,
    buildOpportunityLive: (async () => {
      opportunityCalls += 1;
      return opportunityLive({ runId: "run-provisional", tier: "NONE", stage: "PROVISIONAL" });
    }) as any,
    resolveRuntimeConfig: () => { runtimeCalls += 1; throw new Error("unexpected runtime call"); },
    runPriced: (async () => { pricedCalls += 1; throw new Error("unexpected priced call"); }) as any,
    runIdFactory: () => "run-provisional",
    now: () => new Date("2026-08-13T17:01:00.000Z"),
  });

  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "WAITING_FOR_SPORTING_FINALIZATION");
  assert.equal(assemblyCalls, 1);
  assert.equal(opportunityCalls, 1);
  assert.equal(runtimeCalls, 0);
  assert.equal(pricedCalls, 0);
  const result = response.body.result as Record<string, any>;
  assert.equal(result.sportingSlateLeader.gamePk, 123);
  assert.equal(result.sportingSlateLeader.inputStage, "PROVISIONAL");
  assert.equal(result.sportingFinalization.state, "WAIT_FOR_PROVISIONAL_COMPETITOR");
  const policy = response.body.policy as Record<string, unknown>;
  assert.equal(policy.paidOddsCalled, false);
  assert.equal(policy.researchEliteCandidateIsProductionHardGate, false);
});

test("missing certified evidence blocks before whole-slate ranking and price", async () => {
  let opportunityCalls = 0;
  let runtimeCalls = 0;
  let pricedCalls = 0;
  const response = await executeMlbUnifiedV16UiCommand(DATE, {
    buildSlate: async () => slate("FINAL"),
    buildOpportunityLive: (async () => { opportunityCalls += 1; throw new Error("unexpected opportunity call"); }) as any,
    resolveRuntimeConfig: () => { runtimeCalls += 1; throw new Error("unexpected runtime call"); },
    runPriced: (async () => { pricedCalls += 1; throw new Error("unexpected priced call"); }) as any,
    runIdFactory: () => "run-blocked",
    now: () => new Date("2026-08-13T17:01:00.000Z"),
  });

  assert.equal(response.httpStatus, 202);
  assert.equal(response.body.status, "CERTIFIED_INPUT_ASSEMBLY_BLOCKED");
  assert.equal(opportunityCalls, 0);
  assert.equal(runtimeCalls, 0);
  assert.equal(pricedCalls, 0);
  const policy = response.body.policy as Record<string, unknown>;
  assert.equal(policy.pricedRunnerCalled, false);
  assert.equal(policy.paidOddsCalled, false);
});

test("stable FINAL A+ sporting pick is frozen before price and server custody never leaks", async () => {
  let runtimeCalls = 0;
  let pricedCalls = 0;
  let capturedInput: any = null;
  const opaqueKey = "server-only-opaque-key";
  const opaqueScope = "server-only-account-scope";

  const response = await executeMlbUnifiedV16UiCommand(DATE, {
    buildSlate: async () => slate("FINAL"),
    assembleLiveInput: (async () => assembled("FINAL")) as any,
    buildOpportunityLive: (async () => opportunityLive({
      runId: "run-complete",
      tier: "A_PLUS",
      stage: "FINAL",
    })) as any,
    resolveRuntimeConfig: () => {
      runtimeCalls += 1;
      return {
        providerAccountScopeKey: opaqueScope,
        apiKey: opaqueKey,
        maxRunCredits: 314159,
        reserveCredits: 271828,
      };
    },
    getOddsService: () => ({} as any),
    runPriced: (async (input: any) => {
      pricedCalls += 1;
      capturedInput = input;
      return eliteRunnerResult(input);
    }) as any,
    runIdFactory: () => "run-complete",
    now: () => new Date("2026-08-13T17:01:00.000Z"),
  });

  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "RUN_COMPLETED");
  assert.equal(runtimeCalls, 1);
  assert.equal(pricedCalls, 1);
  assert.equal(capturedInput.apiKey, opaqueKey);
  assert.equal(capturedInput.providerAccountScopeKey, opaqueScope);

  const result = response.body.result as Record<string, any>;
  assert.equal(result.dailyBestPick.decision, "BEST_PICK");
  assert.equal(result.dailyBestPick.pick.gamePk, 123);
  assert.equal(result.dailyBestPick.pick.tier, "A_PLUS");
  assert.equal(result.sportingFinalization.state, "FINAL_SPORTING_PICK");
  assert.equal(result.sportingSlateLeader.gamePk, 123);
  assert.equal(result.eliteCandidates.length, 1);
  assert.equal(result.noPlayAudit.primaryBlocker, "NONE");

  const policy = response.body.policy as Record<string, unknown>;
  assert.equal(policy.sportingDailyBestPickFinalizedBeforePrice, true);
  assert.equal(policy.dailyBestPickPriceMayChangeSportingSelection, false);
  assert.equal(policy.researchEliteCandidateIsProductionHardGate, false);

  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(opaqueKey), false);
  assert.equal(serialized.includes(opaqueScope), false);
  assert.equal(serialized.includes("314159"), false);
  assert.equal(serialized.includes("271828"), false);
  assert.equal(serialized.includes("obs-123"), false);
});

test("sporting NO PLAY is final only after the whole slate resolves and never calls odds", async () => {
  let runtimeCalls = 0;
  let pricedCalls = 0;
  const response = await executeMlbUnifiedV16UiCommand(DATE, {
    buildSlate: async () => slate("FINAL"),
    assembleLiveInput: (async () => assembled("FINAL")) as any,
    buildOpportunityLive: (async () => opportunityLive({
      runId: "run-no-play",
      tier: "NONE",
      stage: "FINAL",
    })) as any,
    resolveRuntimeConfig: () => { runtimeCalls += 1; throw new Error("unexpected runtime call"); },
    runPriced: (async () => { pricedCalls += 1; throw new Error("unexpected priced call"); }) as any,
    runIdFactory: () => "run-no-play",
    now: () => new Date("2026-08-13T17:01:00.000Z"),
  });

  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "RUN_COMPLETED");
  assert.equal(runtimeCalls, 0);
  assert.equal(pricedCalls, 0);
  const result = response.body.result as Record<string, any>;
  assert.equal(result.dailyBestPick.decision, "NO_PLAY");
  assert.equal(result.sportingFinalization.state, "SPORTING_NO_PLAY");
  assert.equal(result.economicEvaluationSkippedReason, "SPORTING_NO_PLAY");
  assert.equal(result.dailyBestPickPrice, null);
  const policy = response.body.policy as Record<string, unknown>;
  assert.equal(policy.priceMayCreateSportingPick, false);
  assert.equal(policy.paidOddsCalled, false);
});
