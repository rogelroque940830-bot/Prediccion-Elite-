import assert from "node:assert/strict";
import { createMlbUnifiedEliteLowerTierLiveProvider } from "../server/mlb-unified-elite-lower-tier-live-provider";
import type { MlbP1DailySlate, MlbP1SlateGame } from "../server/mlb-p1-daily-slate";

const DATE = "2026-08-19";
const NOW = new Date("2026-08-19T19:50:00.000Z");

function game(overrides: Partial<MlbP1SlateGame> = {}): MlbP1SlateGame {
  return {
    gamePk: 9001,
    startTime: "2026-08-19T20:00:00.000Z",
    officialDate: DATE,
    venue: "Test Park",
    state: "PREGAME",
    detailedState: "Pre-Game",
    homeTeam: { id: 10, name: "Home" },
    awayTeam: { id: 20, name: "Away" },
    homePitcher: { id: 101, name: "Home SP", hand: "R", confirmed: true },
    awayPitcher: { id: 202, name: "Away SP", hand: "L", confirmed: true },
    lineupState: "CONFIRMED",
    homeLineupCount: 9,
    awayLineupCount: 9,
    readiness: "READY_TO_ANALYZE",
    analysisStage: "FINAL",
    analysisAllowed: true,
    blockers: [],
    source: {
      name: "MLB_STATS_API",
      fetchedAt: NOW.toISOString(),
      quality: "AUTHORITATIVE",
    },
    ...overrides,
  };
}

function slate(games = [game()]): MlbP1DailySlate {
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: DATE,
    generatedAt: NOW.toISOString(),
    games,
    summary: {
      total: games.length,
      ready: games.filter((x) => x.analysisStage === "FINAL").length,
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

function full13() {
  return {
    officialDate: DATE,
    gamePk: 9001,
    homeTeamId: 10,
    awayTeamId: 20,
    homeStarterId: 101,
    awayStarterId: 202,
    homeBattingOrder: [1,2,3,4,5,6,7,8,9],
    awayBattingOrder: [11,12,13,14,15,16,17,18,19],
    homeTeamHistory: [],
    awayTeamHistory: [],
    leagueStarterHistory: [],
    homeStarterHistory: [],
    awayStarterHistory: [],
    homePriorLineups: [],
    awayPriorLineups: [],
  } as any;
}

function readyAssessment() {
  return {
    status: "READY",
    bridgeVersion: "mlb-full-modular-live-operational-parity-v1",
    officialDate: DATE,
    gamePk: 9001,
    observedAtUtc: NOW.toISOString(),
    decisionDeadlineUtc: "2026-08-19T19:55:00.000Z",
    full13: { featureVector: {} },
    expectedStarterOuts: { home: 16, away: 15 },
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
  } as any;
}

function fullScore(selection: any = {
  officialDate: DATE,
  gamePk: 9001,
  market: "FG_RL_HOME_PLUS_1_5",
  horizon: "FG",
  side: "HOME",
  selectedLine: 1.5,
}) {
  return {
    scorerVersion: "mlb-full-modular-frozen-live-scorer-v1",
    officialDate: DATE,
    candidateCount: selection ? 1 : 0,
    candidates: selection ? [selection] : [],
    selection,
    maximumDailySelections: 1,
    runtimeRefit: false,
    runtimeThresholdFit: false,
    sameDateStateUpdate: false,
    outcomesRead: false,
    sportsbookPricesRead: false,
  } as any;
}

function ppScore(selection: any = {
  officialDate: DATE,
  gamePk: 9001,
  market: "F5_ML",
  horizon: "F5",
  side: "HOME",
  selectedLine: null,
}) {
  return {
    scorerVersion: "mlb-pp-horizon-frozen-live-scorer-v1",
    officialDate: DATE,
    candidateCount: selection ? 1 : 0,
    candidates: selection ? [selection] : [],
    selection,
    maximumDailySelections: 1,
    persistedSnapshotOnly: true,
    runtimeRefit: false,
    preprocessingRefit: false,
    outcomesRead: false,
    sportsbookPricesRead: false,
  } as any;
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    full13Materializer: {
      materializeFull13PregameInput: async () => full13(),
    },
    stateAdapter: {
      buildFullModularEvidence: async () => ({
        v39: { home: {}, away: {} },
        pitchQualityHistory: [],
      }),
    },
    bullpenMaterializer: {
      materializeGame: async () => ({ homeHistory: [], awayHistory: [] }),
    },
    teamStrengthMaterializer: {
      materializeDate: async () => ({ tiers: { 10: "STRONG", 20: "MIDDLE" } }),
    },
    assessOperational: () => readyAssessment(),
    scoreFullModular: () => fullScore(),
    scorePpHorizon: () => ppScore(),
    ...overrides,
  } as any;
}

async function runProvider(overrides: Record<string, unknown> = {}, games = [game()]) {
  const provider = createMlbUnifiedEliteLowerTierLiveProvider(baseDeps(overrides));
  return provider({ officialDate: DATE, slate: slate(games), now: NOW });
}

{
  const result = await runProvider();
  assert.equal(result.ppHorizon.status, "SELECTION");
  assert.equal(result.fullModular.status, "SELECTION");
  if (result.ppHorizon.status === "SELECTION") {
    assert.equal(result.ppHorizon.selection.market, "F5_ML");
  }
  if (result.fullModular.status === "SELECTION") {
    assert.equal(result.fullModular.selection.market, "FG_RL_HOME_PLUS_1_5");
  }
  assert.equal(result.sourceStatus, "CERTIFIED_OPERATIONAL_LOWER_TIER_LIVE_V1:1");
}

{
  const result = await runProvider({ scorePpHorizon: () => ppScore(null) });
  assert.equal(result.ppHorizon.status, "NO_PLAY");
  assert.equal(result.fullModular.status, "SELECTION");
}

{
  const result = await runProvider({ scorePpHorizon: () => { throw new Error("snapshot integrity"); } });
  assert.equal(result.ppHorizon.status, "TECHNICAL_UNAVAILABLE");
  if (result.ppHorizon.status === "TECHNICAL_UNAVAILABLE") {
    assert.equal(result.ppHorizon.reason, "PP_RUNTIME_INTEGRITY_FAILED");
  }
  assert.equal(result.fullModular.status, "SELECTION");
}

{
  const result = await runProvider({
    stateAdapter: {
      buildFullModularEvidence: async () => { throw new Error("state unavailable"); },
    },
  });
  assert.equal(result.ppHorizon.status, "TECHNICAL_UNAVAILABLE");
  assert.equal(result.fullModular.status, "NO_PLAY");
  assert.match(result.sourceStatus ?? "", /^LOWER_TIER_CERTIFIED_SOURCE_FAILED_CLOSED:/);
}

{
  const result = await runProvider({
    assessOperational: () => ({
      status: "NO_PLAY",
      reason: "DECISION_TIMESTAMP_MISSING_OR_LATE",
      diagnostics: {
        failClosed: true,
        sameDateHistoryAllowed: false,
        outcomeFieldsUsed: [],
        sportsbookPriceFieldsUsed: [],
      },
    }),
  });
  assert.equal(result.ppHorizon.status, "NO_PLAY");
  assert.equal(result.fullModular.status, "NO_PLAY");
  assert.equal(result.sourceStatus, "LOWER_TIER_NO_T5_READY_GAMES");
}

{
  const beforeProvider = createMlbUnifiedEliteLowerTierLiveProvider(baseDeps({
    teamStrengthMaterializer: {
      materializeDate: async () => { throw new Error("must not be called"); },
    },
  }));
  const result = await beforeProvider({
    officialDate: "2026-08-18",
    slate: { ...slate(), date: "2026-08-18", games: [] },
    now: new Date("2026-08-18T18:00:00Z"),
  });
  assert.equal(result.ppHorizon.status, "TECHNICAL_UNAVAILABLE");
  assert.equal(result.sourceStatus, "BEFORE_FROZEN_PROSPECTIVE_BOUNDARY");
}

console.log("MLB_UNIFIED_ELITE_LOWER_TIER_LIVE_PROVIDER_V1_TESTS_PASSED");
