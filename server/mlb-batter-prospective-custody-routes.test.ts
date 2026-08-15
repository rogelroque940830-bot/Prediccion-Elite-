import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import { executeMlbBatterProspectiveCustodyCommand } from "./mlb-batter-prospective-custody-routes";

function slate(): MlbP1DailySlate {
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-08-15",
    generatedAt: "2026-08-15T20:00:00.000Z",
    games: [],
    summary: {
      total: 0,
      ready: 0,
      provisional: 0,
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

test("V56 route is explicit, zero-price and returns custody result without changing Elite flow", async () => {
  let buildCalls = 0;
  let captureCalls = 0;
  const response = await executeMlbBatterProspectiveCustodyCommand(
    { date: "2026-08-15", maxGames: 15 },
    {
      buildSlate: (async ({ date }: { date: string }) => {
        buildCalls += 1;
        assert.equal(date, "2026-08-15");
        return slate();
      }) as any,
      capture: async (input) => {
        captureCalls += 1;
        assert.equal(input.date, "2026-08-15");
        assert.equal(input.maxGames, 15);
        assert.deepEqual(input.games, []);
        return {
          schemaVersion: "courtedge-p0-mlb-batter-prospective-custody-result.v1",
          date: input.date,
          generatedAt: "2026-08-15T20:00:00.000Z",
          status: "NO_WORK",
          games: [],
          summary: {
            inputGames: 0,
            eligibleGames: 0,
            selectedUncapturedGames: 0,
            capturedGames: 0,
            alreadyCapturedGames: 0,
            failedGames: 0,
            canonicalSnapshotsReturned: 0,
            mlbStatsApiCalls: 0,
            providerOddsCalls: 0,
            paidProviderCredits: 0,
          },
          policy: {
            explicitInvocationRequired: true,
            firstCanonicalCapturePerGameIsImmutable: true,
            overwriteCanonicalSnapshotAllowed: false,
            finalPregameInputsOnly: true,
            outcomeSettlementAllowed: false,
            modelScoringAllowed: false,
            priceCaptureAllowed: false,
            providerOddsCallsAllowed: false,
            automaticPolling: false,
            changesProductionLookupAuthorization: false,
            changesEliteCandidates: false,
            recommendsBet: false,
            calculatesStake: false,
            automaticBetPlacement: false,
            realFinancialExposure: 0,
          },
        };
      },
    },
  );

  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "NO_CANONICAL_WORK");
  assert.equal(buildCalls, 1);
  assert.equal(captureCalls, 1);
  const policy = response.body.policy as any;
  assert.equal(policy.explicitInvocationRequired, true);
  assert.equal(policy.automaticPolling, false);
  assert.equal(policy.providerOddsCallsAllowed, false);
  assert.equal(policy.paidProviderCredits, 0);
  assert.equal(policy.modelScoringAllowed, false);
  assert.equal(policy.priceCaptureAllowed, false);
  assert.equal(policy.changesEliteCandidates, false);
  assert.equal(policy.recommendsBet, false);
  assert.equal(policy.realFinancialExposure, 0);
});

test("V56 route rejects invalid maxGames before any slate or capture work", async () => {
  let touched = false;
  await assert.rejects(
    () => executeMlbBatterProspectiveCustodyCommand(
      { date: "2026-08-15", maxGames: 16 },
      {
        buildSlate: (async () => { touched = true; return slate(); }) as any,
        capture: async () => { touched = true; throw new Error("must not run"); },
      },
    ),
    /INVALID_MAX_GAMES/,
  );
  assert.equal(touched, false);
});
