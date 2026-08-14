import assert from "node:assert/strict";
import test from "node:test";
import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import {
  createMlbUnifiedV16CertifiedBullpenProvider,
  createMlbUnifiedV16CertifiedC4Provider,
  createMlbUnifiedV16CertifiedFrozenRouteProvider,
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

function liveContext() {
  const daily = slate();
  return {
    runId: "ready",
    slate: daily,
    now: new Date("2026-08-13T17:01:00.000Z"),
    analysisEligibleGamePks: [123],
    finalEligibleGamePks: [123],
  };
}

function certifiedBullpen(teamId: number, teamName: string) {
  return {
    teamId,
    teamName,
    closer: null,
    setupMen: [],
    middleRelievers: [],
    closerAvailable: true,
    setupAvailable: 2,
    bullpenCompromised: false,
    predictedCloser: null,
    runsAdjustment: 0,
    signal: "certified",
    sourceStatus: "CERTIFIED",
    generatedAt: "2026-08-13T17:01:00.000Z",
    provenance: {
      schemaVersion: "courtedge-mlb-bullpen-evidence.v1",
      status: "CERTIFIED",
      generatedAt: "2026-08-13T17:01:00.000Z",
      roster: { source: "MLB_STATS_ACTIVE_ROSTER", pitchersObserved: 8, cacheMaxAgeSeconds: 1800 },
      seasonStats: { source: "MLB_STATS_SEASON", pitchersRequested: 8, pitchersVerified: 8, cacheMaxAgeSeconds: 86400 },
      recentUsage: { source: "MLB_STATS_SCHEDULE_AND_FEED_LIVE", lookbackDays: 3, finalGamesVerified: 3, boxscoresVerified: 3 },
      failureDisposition: "THROW_FAIL_CLOSED",
    },
  } as any;
}

function full13Assessment() {
  return {
    featureVector: {
      team_rd10_diff: 0.5,
      team_win10_diff: 0.2,
      starter_kbb_adv: 0.05,
      team_ra10_adv: 0.3,
      lineup_exposure_rate_adv: 0.12,
      starter_runrisk_adv: 0.02,
      team_rs10_diff: 0.4,
      starter_hr_adv: 0.01,
      min_probable_prior_bf: 160,
      lineup_continuity_rate_adv: 0.1,
      combined_starter_kbb: 0.28,
      combined_team_rs10: 9.2,
      combined_team_ra10: 8.1,
    },
  } as any;
}

function certifiedMatchup() {
  return {
    sourceStatus: "CERTIFIED",
    featureAssessment: {
      slg: { eligible: true, adv: 0.20 },
      pitchmix: {
        eligible: true,
        contactAdv: 0.10,
        whiffAdv: -0.05,
        tbpaAdv: 0.12,
        hrpaAdv: 0.03,
      },
    },
    provenance: {
      targetOutcomeUsed: false,
      sportsbookPriceUsed: false,
    },
  } as any;
}

function certifiedBullpenD1(options: { eligible?: boolean; adv?: number } = {}) {
  return {
    eligible: options.eligible ?? true,
    bullpenPitches1dAdv: options.adv ?? 12,
    provenance: {
      status: "CERTIFIED_PROSPECTIVE_OPERATIONAL",
      targetGameOutcomeUsed: false,
      sameDateDataUsed: false,
      futureGameDataUsed: false,
      thresholdSearchUsed: false,
    },
  } as any;
}

function aPlusClassification() {
  return {
    premiumA: true,
    aPlus: true,
    f5Consensus: true,
    probabilities: {
      aPlusC4PHome: 0.8,
      aPlusFull13PHome: 0.8,
      f5C4PHome: 0.8,
      f5Full13PHome: 0.8,
    },
  } as any;
}

test("default provider set includes certified bullpen, frozen routes, and C4", () => {
  const providers = createMlbUnifiedV16DefaultLiveEvidenceProviders();
  assert.equal(typeof providers.bullpenEvidence, "function");
  assert.equal(typeof providers.frozenRouteAssessments, "function");
  assert.equal(typeof providers.c4Assessments, "function");
});

test("certified bullpen provider materializes both official MLB team sides", async () => {
  const calls: Array<{ teamId: number; teamName: string; now: string }> = [];
  const provider = createMlbUnifiedV16CertifiedBullpenProvider({
    getStatus: async (teamId, teamName, runtime) => {
      calls.push({ teamId, teamName, now: runtime?.now?.().toISOString() ?? "missing" });
      return certifiedBullpen(teamId, teamName);
    },
  });

  const result = await provider(liveContext());
  assert.equal(result.blockers, undefined);
  assert.equal((result.value?.[123]?.home as any)?.teamId, 1);
  assert.equal((result.value?.[123]?.away as any)?.teamId, 2);
  assert.deepEqual(calls.map((call) => [call.teamId, call.teamName]), [[1, "Home"], [2, "Away"]]);
  assert.equal(calls.every((call) => call.now === "2026-08-13T17:01:00.000Z"), true);
});

test("certified bullpen provider fails closed when an official MLB source fails", async () => {
  const provider = createMlbUnifiedV16CertifiedBullpenProvider({
    getStatus: async (teamId, teamName) => {
      if (teamId === 2) throw new Error("BULLPEN_SOURCE_HTTP_503");
      return certifiedBullpen(teamId, teamName);
    },
  });

  const result = await provider(liveContext());
  assert.equal(result.value, undefined);
  assert.equal(result.blockers?.[0].code, "BULLPEN_EVIDENCE_UNAVAILABLE");
  assert.deepEqual(result.blockers?.[0].gamePks, [123]);
  assert.match(result.blockers?.[0].message ?? "", /BULLPEN_SOURCE_HTTP_503/);
});

test("certified bullpen provider rejects degraded provenance instead of leaking it into V16", async () => {
  const provider = createMlbUnifiedV16CertifiedBullpenProvider({
    getStatus: async (teamId, teamName) => {
      const value = certifiedBullpen(teamId, teamName);
      if (teamId === 2) {
        value.sourceStatus = "DEGRADED";
        value.provenance.status = "DEGRADED";
      }
      return value;
    },
  });

  const result = await provider(liveContext());
  assert.equal(result.value, undefined);
  assert.equal(result.blockers?.[0].code, "BULLPEN_EVIDENCE_UNAVAILABLE");
  assert.match(result.blockers?.[0].message ?? "", /BULLPEN_CERTIFIED_PROVENANCE_REQUIRED/);
});

test("certified C4 provider returns canonical materialized evidence", async () => {
  let calls = 0;
  const provider = createMlbUnifiedV16CertifiedC4Provider({
    assessGame: async () => {
      calls += 1;
      return assessment;
    },
  });
  const result = await provider(liveContext());
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
  const result = await provider({ ...liveContext(), runId: "blocked" });
  assert.equal(result.value, undefined);
  assert.equal(result.blockers?.[0].code, "C4_LIVE_INPUT_UNAVAILABLE");
  assert.deepEqual(result.blockers?.[0].gamePks, [123]);
});

test("certified frozen-route provider composes FULL13, SLG, pitchmix, and D1 into the exact assessor", async () => {
  const calls = { full13: 0, matchup: 0, d1: 0 };
  const provider = createMlbUnifiedV16CertifiedFrozenRouteProvider({
    full13Materializer: {
      assessFull13Game: async () => {
        calls.full13 += 1;
        return full13Assessment();
      },
    },
    matchupMaterializer: {
      assessGame: async () => {
        calls.matchup += 1;
        return certifiedMatchup();
      },
    },
    bullpenD1Materializer: {
      assessGame: async () => {
        calls.d1 += 1;
        return certifiedBullpenD1();
      },
    },
    classify: () => aPlusClassification(),
  });

  const result = await provider(liveContext());
  assert.equal(result.blockers, undefined);
  assert.deepEqual(calls, { full13: 1, matchup: 1, d1: 1 });
  const routes = result.value?.[123];
  assert.ok(routes);
  assert.equal(routes.finalInputs, true);
  assert.equal(routes.evaluatedAt, "2026-08-13T17:01:00.000Z");
  assert.equal(routes.routes.PREMIUM_A_HOME_ML, "MATCH");
  assert.equal(routes.routes.A_PLUS_HOME_ML, "MATCH");
  assert.equal(routes.routes.A_PLUS_SLG_POS, "MATCH");
  assert.equal(routes.routes.A_PLUS_PITCHMIX_AT2, "MATCH");
  assert.equal(routes.routes.F5_HRPA_OR_AT2, "NO_MATCH");
  assert.equal(routes.routes.F5_PARETO_UNION, "NO_MATCH");
  assert.equal(routes.routers.A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1, "FIRST_5_HOME");
  assert.equal(/^[a-f0-9]{64}$/.test(routes.featureSnapshotDigest), true);
});

test("certified frozen-route provider fails closed when A+ D1 evidence is ineligible", async () => {
  const provider = createMlbUnifiedV16CertifiedFrozenRouteProvider({
    full13Materializer: { assessFull13Game: async () => full13Assessment() },
    matchupMaterializer: { assessGame: async () => certifiedMatchup() },
    bullpenD1Materializer: { assessGame: async () => certifiedBullpenD1({ eligible: false }) },
    classify: () => aPlusClassification(),
  });

  const result = await provider(liveContext());
  assert.equal(result.value, undefined);
  assert.equal(result.blockers?.[0].code, "FROZEN_ROUTE_ASSESSMENT_UNAVAILABLE");
  assert.deepEqual(result.blockers?.[0].gamePks, [123]);
  assert.match(result.blockers?.[0].message ?? "", /MLB_FROZEN_ROUTE_BULLPEN_D1_INELIGIBLE_FOR_APLUS/);
});

test("certified frozen-route provider rejects matchup provenance that touched the target outcome", async () => {
  const badMatchup = certifiedMatchup();
  badMatchup.provenance.targetOutcomeUsed = true;
  const provider = createMlbUnifiedV16CertifiedFrozenRouteProvider({
    full13Materializer: { assessFull13Game: async () => full13Assessment() },
    matchupMaterializer: { assessGame: async () => badMatchup },
    bullpenD1Materializer: { assessGame: async () => certifiedBullpenD1() },
    classify: () => aPlusClassification(),
  });

  const result = await provider(liveContext());
  assert.equal(result.value, undefined);
  assert.equal(result.blockers?.[0].code, "FROZEN_ROUTE_ASSESSMENT_UNAVAILABLE");
  assert.match(result.blockers?.[0].message ?? "", /FROZEN_ROUTE_MATCHUP_CERTIFIED_PROVENANCE_REQUIRED/);
});
