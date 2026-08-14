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
