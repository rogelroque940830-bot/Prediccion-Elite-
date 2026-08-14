import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import { assembleMlbUnifiedV16LiveInput } from "./mlb-unified-v16-live-input-assembler";
import { createMlbUnifiedV16CertifiedC4Provider } from "./mlb-unified-v16-live-providers";

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
      source: { name: "MLB_STATS_API", fetchedAt: "2026-08-13T17:00:00.000Z", quality: "AUTHORITATIVE" },
    }],
    summary: { total: 1, ready: 1, provisional: 0, waitingForPitchers: 0, startedOrClosed: 0, dataInsufficient: 0 },
    safety: { mode: "SHADOW_DECISION_SUPPORT", realFinancialExposure: 0, automaticBetPlacement: false, automaticModelChangesAllowed: false, automaticPromotionAllowed: false },
  };
}

test("missing certified C4 evidence blocks the assembled runner input", async () => {
  const c4Assessments = createMlbUnifiedV16CertifiedC4Provider({
    assessGame: async () => {
      throw new Error("C4_CERTIFIED_HOME_LINEUP_HISTORY_INCOMPLETE");
    },
  });
  const result = await assembleMlbUnifiedV16LiveInput(
    {
      runId: "c4-blocked",
      slate: finalSlate(),
      now: new Date("2026-08-13T17:01:00.000Z"),
    },
    {
      shortlistEvidence: async () => ({ value: { 123: {} } }),
      bullpenEvidence: async () => ({ value: { 123: {} } }),
      frozenRouteAssessments: async () => ({ value: { 123: {} as any } }),
      c4Assessments,
    },
  );

  assert.equal(result.status, "BLOCKED");
  assert.equal(result.input, null);
  assert.deepEqual(result.blockers.map((entry) => entry.code), ["C4_LIVE_INPUT_UNAVAILABLE"]);
  assert.equal(result.policy.paidOddsBoundaryCrossed, false);
  assert.equal(result.policy.theOddsApiCreditsConsumed, 0);
});
