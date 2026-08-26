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

test("whole-slate opportunity endpoint returns WAIT with a capped pre-odds shortlist", async () => {
  let assemblyCalls = 0;
  let opportunityCalls = 0;
  let strictBullpenEvidence = false;
  let forwardedProvider: unknown = null;
  const provisionalV16Provider = async () => {
    throw new Error("not invoked by this boundary test");
  };
  const response = await executeMlbDailyOpportunityUiCommand(date, {
    now: () => now,
    runIdFactory: () => "opportunity-test-1",
    buildSlate: async () => fakeSlate(),
    provisionalV16Provider: provisionalV16Provider as any,
    assembleLiveInput: async ({ runId, slate, requireCompleteProvisionalBullpenEvidence }) => {
      assemblyCalls += 1;
      strictBullpenEvidence = requireCompleteProvisionalBullpenEvidence === true;
      return {
        schemaVersion: "courtedge-p0-mlb-unified-v16-live-input-assembler.v1",
        status: "READY",
        runId,
        input: { runId, slate, shortlistEvidenceByGame: {}, bullpenByGame: {}, finalRouteAssessmentsByGame: {}, c4ByGame: {}, now },
        blockers: [],
        policy: {},
      } as any;
    },
    buildOpportunityLive: async (input) => {
      opportunityCalls += 1;
      forwardedProvider = input.provisionalV16Provider;
      return {
        generatedAt: now.toISOString(),
        dailyOpportunity: {
          action: "WAIT",
          primaryOpportunity: { gamePk: 2, inputStage: "PROVISIONAL" },
          summary: { intrinsicEvaluatedGames: 15, eligibleSportingOpportunities: 4, provisionalEligibleOpportunities: 2, finalEligibleOpportunities: 2, frontierSize: 3 },
        },
        priceConsultationShortlist: {
          entries: [
            { gamePk: 2, inputStage: "PROVISIONAL", priceTiming: "DEFER_UNTIL_FINAL_INPUTS" },
            { gamePk: 1, inputStage: "FINAL", priceTiming: "READY_IF_PRICE_LAYER_INVOKED" },
          ],
          summary: {
            wholeSlateSportingOpportunitiesEvaluated: 15,
            nonDominatedFrontierSize: 3,
            shortlistedForPossiblePriceConsultation: 2,
            readyFinalCandidates: 1,
            deferredProvisionalCandidates: 1,
          },
        },
        provisionalV16: { attemptedGamePks: [2], scoredGamePks: [2], failed: [] },
        policy: {
          wholeQualifiedSlateCompetes: true,
          provisionalGamesMayLead: true,
          provisionalProbabilityUsesPriorDateLineupProxy: true,
          maximumPossiblePriceConsultations: 3,
          wholeSlateAnalysisDoesNotExpandPriceQuota: true,
        },
      } as any;
    },
  });

  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "OPPORTUNITY_EVALUATED");
  assert.equal((response.body.dailyOpportunity as any).action, "WAIT");
  assert.equal((response.body.priceConsultationShortlist as any).entries.length, 2);
  assert.equal((response.body.priceConsultationShortlist as any).summary.wholeSlateSportingOpportunitiesEvaluated, 15);
  assert.equal((response.body.policy as any).maximumPossiblePriceConsultations, 3);
  assert.equal((response.body.policy as any).wholeSlateAnalysisDoesNotExpandPriceQuota, true);
  assert.equal((response.body.policy as any).paidOddsCalled, false);
  assert.equal((response.body.policy as any).theOddsApiCreditsConsumed, 0);
  assert.equal((response.body.policy as any).wholeQualifiedSlateCompetes, true);
  assert.equal((response.body.policy as any).completeProvisionalBullpenEvidenceRequired, true);
  assert.equal(strictBullpenEvidence, true);
  assert.equal(forwardedProvider, provisionalV16Provider);
  assert.equal(assemblyCalls, 1);
  assert.equal(opportunityCalls, 1);
});

test("certified evidence blocker returns before opportunity scoring and before odds", async () => {
  let opportunityCalls = 0;
  let strictBullpenEvidence = false;
  const response = await executeMlbDailyOpportunityUiCommand(date, {
    now: () => now,
    runIdFactory: () => "opportunity-test-2",
    buildSlate: async () => fakeSlate(),
    assembleLiveInput: async ({ runId, requireCompleteProvisionalBullpenEvidence }) => {
      strictBullpenEvidence = requireCompleteProvisionalBullpenEvidence === true;
      return {
        schemaVersion: "courtedge-p0-mlb-unified-v16-live-input-assembler.v1",
        status: "BLOCKED",
        runId,
        input: null,
        blockers: [{ code: "BULLPEN_EVIDENCE_UNAVAILABLE", gamePks: [2], message: "missing provisional bullpen" }],
        policy: {},
      } as any;
    },
    buildOpportunityLive: async () => {
      opportunityCalls += 1;
      throw new Error("must not run");
    },
  });

  assert.equal(response.httpStatus, 202);
  assert.equal(response.body.status, "OPPORTUNITY_INPUTS_BLOCKED");
  assert.equal((response.body.policy as any).maximumPossiblePriceConsultations, 3);
  assert.equal((response.body.policy as any).completeProvisionalBullpenEvidenceRequired, true);
  assert.equal((response.body.policy as any).paidOddsCalled, false);
  assert.equal((response.body.policy as any).theOddsApiCreditsConsumed, 0);
  assert.equal(strictBullpenEvidence, true);
  assert.equal(opportunityCalls, 0);
});
