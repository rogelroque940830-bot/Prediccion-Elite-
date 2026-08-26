import assert from "node:assert/strict";
import test from "node:test";
import { executeMlbDailyOpportunityUiCommand } from "./mlb-daily-opportunity-ui-route-v1";

const date = "2026-08-26";
const now = new Date("2026-08-26T14:00:00.000Z");

function fakeSlate() {
  return {
    schemaVersion: "courtedge-p0-mlb-p1-daily-slate.v1",
    date,
    generatedAt: now.toISOString(),
    games: [
      {
        gamePk: 1,
        startTime: "2026-08-26T17:00:00.000Z",
        officialDate: date,
        awayTeam: { id: 11, name: "Away 1" },
        homeTeam: { id: 12, name: "Home 1" },
        analysisAllowed: true,
        analysisStage: "FINAL",
      },
      {
        gamePk: 2,
        startTime: "2026-08-27T01:00:00.000Z",
        officialDate: date,
        awayTeam: { id: 21, name: "Away 2" },
        homeTeam: { id: 22, name: "Home 2" },
        analysisAllowed: true,
        analysisStage: "PROVISIONAL",
      },
    ],
    summary: {
      total: 2,
      waitingForPitchers: 0,
      startedOrClosed: 0,
      dataInsufficient: 0,
    },
  } as any;
}

test("whole-slate opportunity endpoint returns WAIT without crossing paid odds", async () => {
  let assemblyCalls = 0;
  let opportunityCalls = 0;
  const response = await executeMlbDailyOpportunityUiCommand(date, {
    now: () => now,
    runIdFactory: () => "opportunity-test-1",
    buildSlate: async () => fakeSlate(),
    assembleLiveInput: async ({ runId, slate }) => {
      assemblyCalls += 1;
      return {
        schemaVersion: "courtedge-p0-mlb-unified-v16-live-input-assembler.v1",
        status: "READY",
        runId,
        input: { runId, slate, shortlistEvidenceByGame: {}, bullpenByGame: {}, finalRouteAssessmentsByGame: {}, c4ByGame: {}, now },
        blockers: [],
        policy: {},
      } as any;
    },
    buildOpportunityLive: async () => {
      opportunityCalls += 1;
      return {
        generatedAt: now.toISOString(),
        dailyOpportunity: {
          action: "WAIT",
          primaryOpportunity: { gamePk: 2, inputStage: "PROVISIONAL" },
          summary: { intrinsicEvaluatedGames: 2, eligibleSportingOpportunities: 2, provisionalEligibleOpportunities: 1, finalEligibleOpportunities: 1, frontierSize: 2 },
        },
        provisionalV16: { attemptedGamePks: [2], scoredGamePks: [2], failed: [] },
        policy: {
          wholeQualifiedSlateCompetes: true,
          provisionalGamesMayLead: true,
          provisionalProbabilityUsesPriorDateLineupProxy: true,
        },
      } as any;
    },
  });

  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "OPPORTUNITY_EVALUATED");
  assert.equal((response.body.dailyOpportunity as any).action, "WAIT");
  assert.equal((response.body.policy as any).paidOddsCalled, false);
  assert.equal((response.body.policy as any).theOddsApiCreditsConsumed, 0);
  assert.equal((response.body.policy as any).wholeQualifiedSlateCompetes, true);
  assert.equal(assemblyCalls, 1);
  assert.equal(opportunityCalls, 1);
});

test("certified evidence blocker returns before opportunity scoring and before odds", async () => {
  let opportunityCalls = 0;
  const response = await executeMlbDailyOpportunityUiCommand(date, {
    now: () => now,
    runIdFactory: () => "opportunity-test-2",
    buildSlate: async () => fakeSlate(),
    assembleLiveInput: async ({ runId }) => ({
      schemaVersion: "courtedge-p0-mlb-unified-v16-live-input-assembler.v1",
      status: "BLOCKED",
      runId,
      input: null,
      blockers: [{ code: "SHORTLIST_EVIDENCE_UNAVAILABLE", gamePks: [2], message: "missing" }],
      policy: {},
    } as any),
    buildOpportunityLive: async () => {
      opportunityCalls += 1;
      throw new Error("must not run");
    },
  });

  assert.equal(response.httpStatus, 202);
  assert.equal(response.body.status, "OPPORTUNITY_INPUTS_BLOCKED");
  assert.equal((response.body.policy as any).paidOddsCalled, false);
  assert.equal((response.body.policy as any).theOddsApiCreditsConsumed, 0);
  assert.equal(opportunityCalls, 0);
});
