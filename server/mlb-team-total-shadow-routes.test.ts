import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import {
  executeMlbTeamTotalShadowCaptureCommand,
  MLB_TEAM_TOTAL_SHADOW_CAPTURE_ROUTE,
} from "./mlb-team-total-shadow-routes";

const NOW = new Date("2026-08-14T20:00:00.000Z");

function slate(stage: "FINAL" | "PROVISIONAL", startTime = "2026-08-14T23:10:00.000Z"): MlbP1DailySlate {
  const final = stage === "FINAL";
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-08-14",
    generatedAt: NOW.toISOString(),
    games: [{
      gamePk: 777001,
      startTime,
      officialDate: "2026-08-14",
      venue: "Test Park",
      state: "PREGAME",
      detailedState: "Pre-Game",
      homeTeam: { id: 1, name: "Home Club" },
      awayTeam: { id: 2, name: "Away Club" },
      homePitcher: { id: 11, name: "Home SP", hand: "R", confirmed: true },
      awayPitcher: { id: 22, name: "Away SP", hand: "L", confirmed: true },
      lineupState: final ? "CONFIRMED" : "PARTIAL",
      homeLineupCount: final ? 9 : 5,
      awayLineupCount: final ? 9 : 5,
      readiness: final ? "READY_TO_ANALYZE" : "PROVISIONAL_WAITING_FOR_LINEUPS",
      analysisStage: stage,
      analysisAllowed: true,
      blockers: final ? [] : ["LINEUPS_NOT_CONFIRMED"],
      source: { name: "MLB_STATS_API", fetchedAt: NOW.toISOString(), quality: "AUTHORITATIVE" },
    }],
    summary: { total: 1, ready: final ? 1 : 0, provisional: final ? 0 : 1, waitingForPitchers: 0, startedOrClosed: 0, dataInsufficient: 0 },
    safety: { mode: "SHADOW_DECISION_SUPPORT", realFinancialExposure: 0, automaticBetPlacement: false, automaticModelChangesAllowed: false, automaticPromotionAllowed: false },
  };
}

test("V22 route has a separate explicit endpoint from the production V16 command", () => {
  assert.equal(MLB_TEAM_TOTAL_SHADOW_CAPTURE_ROUTE, "/api/mlb/team-total-shadow/capture");
});

test("no FINAL pregame game stops before runtime custody or provider capture", async () => {
  let runtimeCalls = 0;
  let captureCalls = 0;
  const response = await executeMlbTeamTotalShadowCaptureCommand({ date: "2026-08-14", maxGames: 1 }, {
    now: () => NOW,
    buildSlate: async () => slate("PROVISIONAL"),
    resolveRuntime: () => { runtimeCalls += 1; throw new Error("runtime must not be read"); },
    capture: async () => { captureCalls += 1; throw new Error("capture must not execute"); },
  });
  assert.equal(response.httpStatus, 200);
  assert.equal(response.body.status, "NO_FINAL_PREGAME_WORK");
  assert.equal(response.body.providerCreditsConsumed, 0);
  assert.equal(runtimeCalls, 0);
  assert.equal(captureCalls, 0);
});

test("explicit FINAL command caps credits to maxGames and never returns provider secrets", async () => {
  let captured: any = null;
  const apiKey = "opaque-secret-key";
  const scope = "opaque-account-scope";
  const response = await executeMlbTeamTotalShadowCaptureCommand({ date: "2026-08-14", maxGames: 2 }, {
    now: () => NOW,
    runIdFactory: () => "shadow-route-test",
    buildSlate: async () => slate("FINAL"),
    resolveRuntime: () => ({ providerAccountScopeKey: scope, apiKey, maxRunCredits: 99, reserveCredits: 25 }),
    capture: async (input) => {
      captured = input;
      return {
        schemaVersion: "courtedge-p0-mlb-team-total-shadow-capture.v1",
        runId: input.runId,
        date: input.date,
        generatedAt: NOW.toISOString(),
        modelVersion: "mlb-team-total-count-model-v20-frozen-20220814",
        status: "COMPLETED",
        games: [],
        budget: null,
        summary: { requestedGames: 0, capturedGames: 0, alreadyCapturedGames: 0, executableHomeTeamTotals: 0, executableAwayTeamTotals: 0, evaluatedTeamTotals: 0, descriptivePositiveEvSides: 0, providerCalls: 0, providerCreditsCharged: 0 },
        policy: { explicitInvocationRequired: true, shadowOnly: true, finalPregameInputsOnly: true, oneProviderMarketKeyOnly: true, providerMarketKey: "team_totals", maxGamesPerRun: 5, firstProspectiveCapturePerGameIsCanonical: true, modelIsPriceIndependent: true, historicalTeamTotalPricesUsed: false, positiveEvRowsAreDiagnosticOnly: true, changesProductionLookupAuthorization: false, changesEliteCandidates: false, recommendsBet: false, calculatesStake: false, automaticPolling: false, automaticBetPlacement: false, realFinancialExposure: 0 },
      };
    },
  });
  assert.equal(response.httpStatus, 200);
  assert.equal(captured.maxRunCredits, 2);
  assert.equal(captured.reserveCredits, 25);
  assert.equal(captured.apiKey, apiKey);
  assert.equal(captured.providerAccountScopeKey, scope);
  const serialized = JSON.stringify(response.body);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes(scope), false);
  assert.equal(response.body.status, "SHADOW_CAPTURE_COMPLETED");
});

test("started games never enter Team Total shadow capture", async () => {
  let captureCalls = 0;
  const response = await executeMlbTeamTotalShadowCaptureCommand({ date: "2026-08-14", maxGames: 1 }, {
    now: () => NOW,
    buildSlate: async () => slate("FINAL", "2026-08-14T19:59:00.000Z"),
    capture: async () => { captureCalls += 1; throw new Error("must not capture started game"); },
  });
  assert.equal(response.body.status, "NO_FINAL_PREGAME_WORK");
  assert.equal(captureCalls, 0);
});
