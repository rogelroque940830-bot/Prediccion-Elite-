import assert from "node:assert/strict";
import test from "node:test";
import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import {
  createMlbUnifiedV16CertifiedC4Provider,
  createMlbUnifiedV16DefaultLiveEvidenceProviders,
} from "./mlb-unified-v16-live-providers";

const assessment: C4LiveFeatureAssessment = {
  builderVersion: "mlb-c4-live-canonical-v1",
  priceIndependent: true,
  sameDateHistoryAllowed: false,
  seasonResetHistory: true,
  featureVector: {
    lineup_exposure_rate_adv: 0.02,
    starter_kbb_adv: 0.015,
    combined_team_rs10: 9.1,
    team_rd10_diff: 0.6,
  },
  diagnostics: {
    homePriorGames: 10,
    awayPriorGames: 10,
    leaguePriorStarterBattersFaced: 8000,
    homeStarterPriorBattersFaced: 120,
    awayStarterPriorBattersFaced: 115,
    homePriorCompleteLineups: 10,
    awayPriorCompleteLineups: 10,
  },
};

function slate(): MlbP1DailySlate {
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

test("default provider set includes certified C4", () => {
  const providers = createMlbUnifiedV16DefaultLiveEvidenceProviders();
  assert.equal(typeof providers.c4Assessments, "function");
});

test("certified C4 provider returns canonical materialized evidence", async () => {
  let calls = 0;
  const provider = createMlbUnifiedV16CertifiedC4Provider({
    assessGame: async () => {
      calls += 1;
      return assessment;
    },
  });
  const daily = slate();
  const result = await provider({
    runId: "ready",
    slate: daily,
    now: new Date("2026-08-13T17:01:00.000Z"),
    analysisEligibleGamePks: [123],
    finalEligibleGamePks: [123],
  });
  assert.equal(calls, 1);
  assert.equal(result.value?.[123], assessment);
  assert.equal(result.blockers, undefined);
});

test("certified C4 provider reports a typed blocker on materialization failure", async () => {
  const provider = createMlbUnifiedV16CertifiedC4Provider({
    assessGame: async () => {
      throw new Error("C4_CERTIFIED_HOME_LINEUP_HISTORY_INCOMPLETE");
    },
  });
  const daily = slate();
  const result = await provider({
    runId: "blocked",
    slate: daily,
    now: new Date("2026-08-13T17:01:00.000Z"),
    analysisEligibleGamePks: [123],
    finalEligibleGamePks: [123],
  });
  assert.equal(result.value, undefined);
  assert.equal(result.blockers?.[0].code, "C4_LIVE_INPUT_UNAVAILABLE");
  assert.deepEqual(result.blockers?.[0].gamePks, [123]);
});
