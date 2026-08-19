import assert from "node:assert/strict";
import test from "node:test";
import {
  MlbUnifiedEliteProspectiveCustodyStore,
  buildMlbUnifiedEliteProspectiveGameSnapshot,
} from "../server/mlb-unified-elite-prospective-custody-v1";
import { MlbUnifiedEliteProspectiveCaptureService } from "../server/mlb-unified-elite-prospective-capture-service-v1";
import type { MlbP1DailySlate } from "../server/mlb-p1-daily-slate";

function fullCandidate(gamePk = 900001) {
  return {
    officialDate: "2026-08-20",
    gamePk,
    market: "F5_ML",
    horizon: "F5",
    side: "HOME",
    selectedLine: null,
    lineGeometry: "NEUTRAL_ML",
    strengthTier: "STRONG",
    matchupStructure: "SUPPORTIVE",
    structureScore: 0.5,
    structureObservedFeatureFraction: 1,
    frontier: "Q80",
    qualityScore: 0.12,
    qualityPercentile: 0.93,
    modelProbability: 0.66,
  } as any;
}

function ppCandidate(gamePk = 900001) {
  return {
    ...fullCandidate(gamePk),
    premium_core_support_count_0_to_3: 2,
    premium_core_weakest_margin: 0.1,
    frozen_c4_selected_side_probability: 0.64,
    frozen_full13_selected_side_probability: 0.65,
    sel_starter_kbb_adv: 0.2,
    sel_team_win10_diff: 0.3,
    sel_lineup_exposure_rate_adv: 0.1,
    sel_team_ra10_adv: 0.2,
    sel_starter_runrisk_adv: 0.1,
    partialPoolProbability: 0.69,
  } as any;
}

function slate(): MlbP1DailySlate {
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-08-20",
    generatedAt: "2026-08-20T20:00:00.000Z",
    games: [{
      gamePk: 900001,
      startTime: "2026-08-20T23:00:00.000Z",
      officialDate: "2026-08-20",
      venue: "Test Park",
      state: "PREGAME",
      detailedState: "Pre-Game",
      homeTeam: { id: 1, name: "Home" },
      awayTeam: { id: 2, name: "Away" },
      homePitcher: { id: 101, name: "Home SP", hand: "R", confirmed: true },
      awayPitcher: { id: 102, name: "Away SP", hand: "L", confirmed: true },
      lineupState: "CONFIRMED",
      homeLineupCount: 9,
      awayLineupCount: 9,
      readiness: "READY_TO_ANALYZE",
      analysisStage: "FINAL",
      analysisAllowed: true,
      blockers: [],
      source: { name: "MLB_STATS_API", fetchedAt: "2026-08-20T20:00:00.000Z", quality: "AUTHORITATIVE" },
    }],
    summary: { total: 1, ready: 1, provisional: 0, waitingForPitchers: 0, startedOrClosed: 0, dataInsufficient: 0 },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

test("first canonical T-5 snapshot is immutable and duplicate capture returns it", () => {
  const store = new MlbUnifiedEliteProspectiveCustodyStore({ filename: ":memory:" });
  try {
    const first = buildMlbUnifiedEliteProspectiveGameSnapshot({
      officialDate: "2026-08-20",
      gamePk: 900001,
      capturedAtUtc: "2026-08-20T22:50:00.000Z",
      decisionDeadlineUtc: "2026-08-20T22:55:00.000Z",
      homeStrengthTier: "STRONG",
      awayStrengthTier: "WEAK",
      fullModularCandidates: [fullCandidate()],
      ppHorizonCandidates: [ppCandidate()],
    });
    const inserted = store.putFirstCanonical(first);
    assert.equal(inserted.inserted, true);

    const altered = buildMlbUnifiedEliteProspectiveGameSnapshot({
      officialDate: "2026-08-20",
      gamePk: 900001,
      capturedAtUtc: "2026-08-20T22:51:00.000Z",
      decisionDeadlineUtc: "2026-08-20T22:55:00.000Z",
      homeStrengthTier: "WEAK",
      awayStrengthTier: "STRONG",
      fullModularCandidates: [{ ...fullCandidate(), modelProbability: 0.9 }],
      ppHorizonCandidates: [{ ...ppCandidate(), partialPoolProbability: 0.9 }],
    });
    const duplicate = store.putFirstCanonical(altered);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.snapshot.snapshotDigest, first.snapshotDigest);
    assert.equal(store.listDate("2026-08-20").length, 1);
  } finally {
    store.close();
  }
});

test("custody rejects capture at or after the frozen T-5 deadline", () => {
  assert.throws(() => buildMlbUnifiedEliteProspectiveGameSnapshot({
    officialDate: "2026-08-20",
    gamePk: 900001,
    capturedAtUtc: "2026-08-20T22:55:00.000Z",
    decisionDeadlineUtc: "2026-08-20T22:55:00.000Z",
    homeStrengthTier: "STRONG",
    awayStrengthTier: "WEAK",
    fullModularCandidates: [fullCandidate()],
    ppHorizonCandidates: [ppCandidate()],
  }), /CAPTURE_NOT_STRICTLY_PREGAME_T5/);
});

test("late service start marks the official date ineligible instead of backfilling", () => {
  const store = new MlbUnifiedEliteProspectiveCustodyStore({ filename: ":memory:" });
  try {
    const state = store.observeDate({
      officialDate: "2026-08-20",
      observedAtUtc: "2026-08-20T23:00:00.000Z",
      earliestDecisionDeadlineUtc: "2026-08-20T22:55:00.000Z",
    });
    assert.equal(state.maturityEligible, false);
    assert.match(state.partialReason ?? "", /AFTER_FIRST_T5/);
    assert.equal(store.status().outcomeReadUnlocked, false);
    assert.equal(store.status().promotionAllowed, false);
  } finally {
    store.close();
  }
});

test("capture service persists exact outcome-blind per-game Full Modular and PP_HORIZON rows once", async () => {
  const store = new MlbUnifiedEliteProspectiveCustodyStore({ filename: ":memory:" });
  let full13Calls = 0;
  const fixedNow = new Date("2026-08-20T20:00:00.000Z");
  const service = new MlbUnifiedEliteProspectiveCaptureService({
    custody: store,
    now: () => fixedNow,
    full13Materializer: {
      materializeFull13PregameInput: async () => {
        full13Calls += 1;
        return { officialDate: "2026-08-20", gamePk: 900001 } as any;
      },
    },
    stateAdapter: {
      buildFullModularEvidence: async () => ({ v39: { home: {}, away: {} }, pitchQualityHistory: [] } as any),
    },
    bullpenMaterializer: {
      materializeGame: async () => ({ homeHistory: [], awayHistory: [] } as any),
    },
    teamStrengthMaterializer: {
      materializeDate: async () => ({ tiers: { 1: "STRONG", 2: "WEAK" } } as any),
    },
    assessOperational: (() => ({
      status: "READY",
      bridgeVersion: "mlb-full-modular-live-operational-parity-v1",
      officialDate: "2026-08-20",
      gamePk: 900001,
      observedAtUtc: "2026-08-20T20:00:00.000Z",
      decisionDeadlineUtc: "2026-08-20T22:55:00.000Z",
      full13: {},
      expectedStarterOuts: { home: 15, away: 15 },
      starterQuality: { home: {}, away: {} },
      bullpenProfiles: { home: {}, away: {} },
      featureVector: {},
      diagnostics: {
        failClosed: true,
        sameDateHistoryAllowed: false,
        outcomeFieldsUsed: [],
        sportsbookPriceFieldsUsed: [],
        v39RuntimeFitAllowed: false,
        v39RuntimePreprocessingFitAllowed: false,
        mechanisticBuilderFinalAuthority: true,
      },
    })) as any,
    scoreFullModular: ((input: any) => ({
      scorerVersion: "mlb-full-modular-frozen-live-scorer-v1",
      officialDate: input.officialDate,
      candidateCount: 1,
      candidates: [fullCandidate()],
      selection: fullCandidate(),
      maximumDailySelections: 1,
      runtimeRefit: false,
      runtimeThresholdFit: false,
      sameDateStateUpdate: false,
      outcomesRead: false,
      sportsbookPricesRead: false,
    })) as any,
    scorePpHorizon: ((input: any) => ({
      scorerVersion: "mlb-pp-horizon-frozen-live-scorer-v1",
      officialDate: input.officialDate,
      candidateCount: 1,
      candidates: [ppCandidate()],
      selection: ppCandidate(),
      maximumDailySelections: 1,
      persistedSnapshotOnly: true,
      runtimeRefit: false,
      preprocessingRefit: false,
      outcomesRead: false,
      sportsbookPricesRead: false,
    })) as any,
  });
  try {
    const first = await service.captureSlate({ officialDate: "2026-08-20", slate: slate(), now: fixedNow });
    assert.equal(first.newlyCapturedGames, 1);
    assert.equal(first.failures.length, 0);
    assert.equal(first.dateMaturityEligible, true);
    assert.equal(store.listDate("2026-08-20").length, 1);
    assert.equal(full13Calls, 1);

    const second = await service.captureSlate({ officialDate: "2026-08-20", slate: slate(), now: fixedNow });
    assert.equal(second.newlyCapturedGames, 0);
    assert.equal(second.alreadyCapturedGames, 1);
    assert.equal(full13Calls, 1, "immutable duplicate must not rematerialize the pregame game");
    assert.equal(second.safety.outcomesRead, false);
    assert.equal(second.safety.sportsbookPricesRead, false);
  } finally {
    service.close();
    store.close();
  }
});
