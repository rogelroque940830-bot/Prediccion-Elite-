import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import {
  assembleMlbUnifiedV16LiveInput,
  MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA,
} from "./mlb-unified-v16-live-input-assembler";

function finalSlate(): MlbP1DailySlate {
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
      lineupState: "CONFIRMED",
      homeLineupCount: 9,
      awayLineupCount: 9,
      readiness: "READY_TO_ANALYZE",
      analysisStage: "FINAL",
      analysisAllowed: true,
      blockers: [],
      source: {
        name: "MLB_STATS_API",
        fetchedAt: "2026-08-13T17:00:00.000Z",
        quality: "AUTHORITATIVE",
      },
    }],
    summary: {
      total: 1,
      ready: 1,
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

function mixedFinalAndProvisionalSlate(): MlbP1DailySlate {
  const slate = finalSlate();
  return {
    ...slate,
    games: [
      slate.games[0],
      {
        gamePk: 456,
        startTime: "2026-08-13T23:40:00.000Z",
        officialDate: "2026-08-13",
        venue: "Provisional Park",
        state: "PREGAME",
        detailedState: "Pre-Game",
        homeTeam: { id: 3, name: "Provisional Home" },
        awayTeam: { id: 4, name: "Provisional Away" },
        homePitcher: { id: 33, name: "Provisional Home SP", hand: "R", confirmed: true },
        awayPitcher: { id: 44, name: "Provisional Away SP", hand: "L", confirmed: true },
        lineupState: "NOT_POSTED",
        homeLineupCount: 0,
        awayLineupCount: 0,
        readiness: "PROVISIONAL_WAITING_FOR_LINEUPS",
        analysisStage: "PROVISIONAL",
        analysisAllowed: true,
        blockers: ["Los lineups oficiales todavía no están publicados."],
        source: {
          name: "MLB_STATS_API",
          fetchedAt: "2026-08-13T17:00:00.000Z",
          quality: "AUTHORITATIVE",
        },
      },
    ],
    summary: {
      total: 2,
      ready: 1,
      provisional: 1,
      waitingForPitchers: 0,
      startedOrClosed: 0,
      dataInsufficient: 0,
    },
  };
}

test("live assembler reports typed blockers and never crosses the paid boundary when providers are absent", async () => {
  const result = await assembleMlbUnifiedV16LiveInput({
    runId: "run-blocked",
    slate: finalSlate(),
    now: new Date("2026-08-13T17:01:00.000Z"),
  });

  assert.equal(result.schemaVersion, MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.input, null);
  assert.deepEqual(
    result.blockers.map((entry) => entry.code).sort(),
    [
      "BULLPEN_EVIDENCE_UNAVAILABLE",
      "C4_LIVE_INPUT_UNAVAILABLE",
      "FROZEN_ROUTE_ASSESSMENT_UNAVAILABLE",
      "SHORTLIST_EVIDENCE_UNAVAILABLE",
    ],
  );
  assert.equal(result.policy.paidOddsBoundaryCrossed, false);
  assert.equal(result.policy.theOddsApiCreditsConsumed, 0);
});

test("live assembler emits a runner input only when every certified provider contract is satisfied", async () => {
  const shortlistEvidenceByGame = { 123: {} };
  const bullpenByGame = { 123: {} };
  const finalRouteAssessmentsByGame = { 123: {} as any };
  const c4ByGame = { 123: {} as any };

  const result = await assembleMlbUnifiedV16LiveInput(
    {
      runId: "run-ready",
      slate: finalSlate(),
      now: new Date("2026-08-13T17:01:00.000Z"),
    },
    {
      shortlistEvidence: async () => ({ value: shortlistEvidenceByGame }),
      bullpenEvidence: async () => ({ value: bullpenByGame }),
      frozenRouteAssessments: async () => ({ value: finalRouteAssessmentsByGame }),
      c4Assessments: async () => ({ value: c4ByGame }),
    },
  );

  assert.equal(result.status, "READY");
  if (result.status !== "READY") assert.fail("expected READY assembly");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.input.runId, "run-ready");
  assert.equal(result.input.shortlistEvidenceByGame, shortlistEvidenceByGame);
  assert.equal(result.input.bullpenByGame, bullpenByGame);
  assert.equal(result.input.finalRouteAssessmentsByGame, finalRouteAssessmentsByGame);
  assert.equal(result.input.c4ByGame, c4ByGame);
  assert.equal(result.policy.paidOddsBoundaryCrossed, false);
});

test("provisional-only bullpen failure cannot block a clean FINAL game", async () => {
  const calls: number[][] = [];
  const finalBullpen = { 123: { home: {}, away: {} } };
  const finalRoutes = { 123: {} as any };
  const c4 = { 123: {} as any };

  const result = await assembleMlbUnifiedV16LiveInput(
    {
      runId: "run-provisional-bullpen-isolated",
      slate: mixedFinalAndProvisionalSlate(),
      now: new Date("2026-08-13T17:01:00.000Z"),
    },
    {
      shortlistEvidence: async () => ({ value: { 123: {}, 456: {} } }),
      bullpenEvidence: async (context) => {
        calls.push([...context.analysisEligibleGamePks]);
        if (context.analysisEligibleGamePks.includes(456)) {
          return {
            blockers: [{
              code: "BULLPEN_EVIDENCE_UNAVAILABLE",
              gamePks: [456],
              message: "Provisional bullpen source unavailable.",
            }],
          };
        }
        return { value: finalBullpen };
      },
      frozenRouteAssessments: async () => ({ value: finalRoutes }),
      c4Assessments: async () => ({ value: c4 }),
    },
  );

  assert.equal(result.status, "READY");
  if (result.status !== "READY") assert.fail("expected provisional-only bullpen failure to be isolated");
  assert.deepEqual(calls, [[123, 456], [123]]);
  assert.equal(result.input.bullpenByGame, finalBullpen);
  assert.equal(result.input.bullpenByGame[456], undefined);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.policy.paidOddsBoundaryCrossed, false);
  assert.equal(result.policy.theOddsApiCreditsConsumed, 0);
});

test("FINAL bullpen failure remains fail closed and is never downgraded", async () => {
  const calls: number[][] = [];
  const result = await assembleMlbUnifiedV16LiveInput(
    {
      runId: "run-final-bullpen-blocked",
      slate: mixedFinalAndProvisionalSlate(),
      now: new Date("2026-08-13T17:01:00.000Z"),
    },
    {
      shortlistEvidence: async () => ({ value: { 123: {}, 456: {} } }),
      bullpenEvidence: async (context) => {
        calls.push([...context.analysisEligibleGamePks]);
        return {
          blockers: [{
            code: "BULLPEN_EVIDENCE_UNAVAILABLE",
            gamePks: [123],
            message: "FINAL bullpen source unavailable.",
          }],
        };
      },
      frozenRouteAssessments: async () => ({ value: { 123: {} as any } }),
      c4Assessments: async () => ({ value: { 123: {} as any } }),
    },
  );

  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(calls, [[123, 456]]);
  assert.equal(result.input, null);
  assert.deepEqual(result.blockers.map((entry) => entry.gamePks), [[123]]);
  assert.equal(result.blockers[0]?.code, "BULLPEN_EVIDENCE_UNAVAILABLE");
  assert.equal(result.policy.paidOddsBoundaryCrossed, false);
  assert.equal(result.policy.theOddsApiCreditsConsumed, 0);
});
