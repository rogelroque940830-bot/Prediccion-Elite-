import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import { executeMlbUnifiedV16UiCommand } from "./mlb-unified-v16-ui-routes";

function slate(stage: "FINAL" | "PROVISIONAL"): MlbP1DailySlate {
  const final = stage === "FINAL";
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-08-13",
    generatedAt: "2026-08-13T17:00:00.000Z",
    games: [{
      gamePk: 123,
      startTime: "2026-08-13T23:10:00.000Z",
      officialDate: "2026-08-13",
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
    summary: { total: 1, ready: final ? 1 : 0, provisional: final ? 0 : 1, waitingForPitchers: 0, startedOrClosed: 0, dataInsufficient: 0 },
    safety: { mode: "SHADOW_DECISION_SUPPORT", realFinancialExposure: 0, automaticBetPlacement: false, automaticModelChangesAllowed: false, automaticPromotionAllowed: false },
  };
}

test("provisional-only command does not assemble or invoke the priced runner", async () => {
  let assemblyCalls = 0;
  let runtimeCalls = 0;
  let pricedCalls = 0;
  const response = await executeMlbUnifiedV16UiCommand("2026-08-13", {
    buildSlate: async () => slate("PROVISIONAL"),
    assembleLiveInput: (async () => { assemblyCalls += 1; throw new Error("unexpected assembler call"); }) as any,
    resolveRuntimeConfig: () => { runtimeCalls += 1; throw new Error("unexpected runtime call"); },
    runPriced: (async () => { pricedCalls += 1; throw new Error("unexpected priced call"); }) as any,
    runIdFactory: () => "run-provisional",
    now: () => new Date("2026-08-13T17:01:00.000Z"),
  });
  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "WAITING_FOR_FINAL_INPUTS");
  assert.equal(assemblyCalls, 0);
  assert.equal(runtimeCalls, 0);
  assert.equal(pricedCalls, 0);
});

test("missing certified evidence blocks before runtime custody and Step 8", async () => {
  let runtimeCalls = 0;
  let pricedCalls = 0;
  const response = await executeMlbUnifiedV16UiCommand("2026-08-13", {
    buildSlate: async () => slate("FINAL"),
    resolveRuntimeConfig: () => { runtimeCalls += 1; throw new Error("unexpected runtime call"); },
    runPriced: (async () => { pricedCalls += 1; throw new Error("unexpected priced call"); }) as any,
    runIdFactory: () => "run-blocked",
    now: () => new Date("2026-08-13T17:01:00.000Z"),
  });
  assert.equal(response.httpStatus, 202);
  assert.equal(response.body.status, "CERTIFIED_INPUT_ASSEMBLY_BLOCKED");
  assert.equal(runtimeCalls, 0);
  assert.equal(pricedCalls, 0);
  const policy = response.body.policy as Record<string, unknown>;
  assert.equal(policy.pricedRunnerCalled, false);
  assert.equal(policy.paidOddsCalled, false);
  assert.equal(policy.theOddsApiCreditsConsumed, 0);
});

test("complete certified assembly invokes the priced runner once without returning server custody fields", async () => {
  let runtimeCalls = 0;
  let pricedCalls = 0;
  let capturedInput: any = null;
  const opaqueKey = "server-only-opaque-key";
  const opaqueScope = "server-only-account-scope";
  const response = await executeMlbUnifiedV16UiCommand("2026-08-13", {
    buildSlate: async () => slate("FINAL"),
    liveEvidenceProviders: {
      shortlistEvidence: async () => ({ value: { 123: {} } }),
      bullpenEvidence: async () => ({ value: { 123: {} } }),
      frozenRouteAssessments: async () => ({ value: { 123: {} as any } }),
      c4Assessments: async () => ({ value: { 123: {} as any } }),
    },
    resolveRuntimeConfig: () => {
      runtimeCalls += 1;
      return { providerAccountScopeKey: opaqueScope, apiKey: opaqueKey, maxRunCredits: 314159, reserveCredits: 271828 };
    },
    getOddsService: () => ({} as any),
    runPriced: (async (input: any) => {
      pricedCalls += 1;
      capturedInput = input;
      return {
        schemaVersion: "courtedge-p0-mlb-unified-priced-v16-runner.v1",
        runId: input.runId,
        generatedAt: "2026-08-13T17:01:00.000Z",
        summary: { finalGamesScoredByV16: 1, modelAssessments: 4, paidLookupEligibleGames: 1, positiveEvMarkets: 1, eliteEvidenceCandidates: 1, eliteEvidenceRowsCaptured: 1 },
        preprice: { summary: { slateGames: 1, analysisEligibleGames: 1, finalAnalysisEligibleGames: 1, provisionalAnalysisEligibleGames: 0, intrinsicResearchEliteCandidates: 1, gamesWithMarketDiscoveryPlan: 1, gamesPaidLookupEligibleNow: 1, frozenRouteRowsCaptured: 1 } },
      } as any;
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
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(opaqueKey), false);
  assert.equal(serialized.includes(opaqueScope), false);
  assert.equal(serialized.includes("314159"), false);
  assert.equal(serialized.includes("271828"), false);
});
