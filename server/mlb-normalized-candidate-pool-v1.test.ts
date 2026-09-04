import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbNormalizedCandidatePool } from "./mlb-normalized-candidate-pool-v1";
import { executeMlbNormalizedCandidatePoolCommand } from "./mlb-normalized-candidate-pool-routes";

function slate() {
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-09-04",
    generatedAt: "2026-09-04T14:00:00.000Z",
    games: [
      {
        gamePk: 900001,
        startTime: "2026-09-04T23:10:00.000Z",
        officialDate: "2026-09-04",
        venue: "Test Park",
        state: "SCHEDULED",
        detailedState: "Scheduled",
        homeTeam: { id: 1, name: "Home Club" },
        awayTeam: { id: 2, name: "Away Club" },
        homePitcher: { id: 11, name: "Home SP", hand: "R", confirmed: true },
        awayPitcher: { id: 22, name: "Away SP", hand: "L", confirmed: true },
        lineupState: "CONFIRMED",
        homeLineupCount: 9,
        awayLineupCount: 9,
        readiness: "READY_TO_ANALYZE",
        analysisStage: "FINAL",
        analysisAllowed: true,
        blockers: [],
        source: { name: "MLB_STATS_API", fetchedAt: "2026-09-04T14:00:00.000Z", quality: "AUTHORITATIVE" },
      },
    ],
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
  } as any;
}

function fullGameSource() {
  return {
    status: "READY",
    sourceRunId: "fg-run-1",
    sourceSchemaVersion: "courtedge-mlb-daily-best-pick-runtime-adapter.v1",
    blockers: [],
    evaluations: [
      {
        officialDate: "2026-09-04",
        gamePk: 900001,
        market: "FIRST_5_ML",
        side: "HOME",
        route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1",
        evaluationState: "READY",
        prepriceRank: 0,
        sourceEvaluationId: "fg-eval-1",
      },
    ],
    opportunities: [
      {
        gamePk: 900001,
        probability: {
          marketProbabilities: {
            ml: { homeWinProbability: 0.57, awayWinProbability: 0.43 },
            f5Ml: { homeWinProbability: 0.58, awayWinProbability: 0.35, pushProbability: 0.07 },
          },
        },
      },
    ],
  } as any;
}

function earlyPayload(side: "HOME" | "AWAY" = "AWAY") {
  return {
    schemaVersion: "mlb-early-whole-slate-candidates.v1",
    date: "2026-09-04",
    generatedAt: "2026-09-04T14:00:00.000Z",
    sourceSlateSchemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    games: [],
    candidates: [
      {
        schemaVersion: "mlb-early-sporting-candidate.v1",
        candidateId: `900001:F5_ML:${side}:abc123`,
        gamePk: 900001,
        gameDate: "2026-09-04",
        commenceTime: "2026-09-04T23:10:00.000Z",
        homeTeam: "Home Club",
        awayTeam: "Away Club",
        engine: "ERE",
        engineSnapshotSha256: "a".repeat(64),
        authority: "FINAL_RECOMMENDATION",
        marketType: "F5_ML",
        selection: `${side} F5 ML`,
        side,
        line: null,
        modelProbability: 0.61,
        action: "BET",
        confidence: "HIGH",
        isPremium: true,
        reason: "Canonical Early candidate",
        sportingEligible: true,
        globalRankEligible: false,
        globalRankBlockers: ["UNPRICED_EARLY_CANDIDATE", "CROSS_ENGINE_CALIBRATION_NOT_ATTACHED"],
        price: {
          status: "UNPRICED",
          oddsAmerican: null,
          marketImpliedProbability: null,
          edgePp: null,
        },
      },
    ],
    summary: {
      totalGames: 1,
      candidateGames: 1,
      passGames: 0,
      blockedGames: 0,
      dataIncompleteGames: 0,
      errorGames: 0,
      sportingCandidates: 1,
      globallyRankEligibleCandidates: 0,
    },
    boundary: {},
  } as any;
}

test("keeps Full Game and Early as independent candidates and diagnoses cross-engine conflict", () => {
  const pool = buildMlbNormalizedCandidatePool({
    date: "2026-09-04",
    generatedAt: "2026-09-04T14:00:00.000Z",
    slate: slate(),
    fullGame: fullGameSource(),
    early: { status: "READY", payload: earlyPayload("AWAY"), blockers: [] },
  });

  assert.equal(pool.candidates.length, 2);
  assert.deepEqual(pool.candidates.map((candidate) => candidate.engine.family).sort(), ["EARLY", "FULL_GAME"]);
  assert.equal(pool.crossEngineDiagnostics.overlapMarketCount, 1);
  assert.equal(pool.crossEngineDiagnostics.conflictMarketCount, 1);
  assert.equal(pool.crossEngineDiagnostics.groups[0].state, "CONFLICT");
  assert.deepEqual(pool.crossEngineDiagnostics.groups[0].directions, ["AWAY", "HOME"]);
  assert.equal(pool.summary.globallyRankEligibleCandidates, 0);
  assert.equal(pool.boundary.crossEngineRankPerformed, false);
});

test("preserves explicit Full Game F5 push probability and blocks Early F5 settlement ambiguity", () => {
  const pool = buildMlbNormalizedCandidatePool({
    date: "2026-09-04",
    generatedAt: "2026-09-04T14:00:00.000Z",
    slate: slate(),
    fullGame: fullGameSource(),
    early: { status: "READY", payload: earlyPayload("HOME"), blockers: [] },
  });

  const full = pool.candidates.find((candidate) => candidate.engine.family === "FULL_GAME")!;
  const early = pool.candidates.find((candidate) => candidate.engine.family === "EARLY")!;
  assert.equal(full.sporting.modelWinProbability, 0.58);
  assert.equal(full.sporting.modelPushProbability, 0.07);
  assert.ok(Math.abs((full.sporting.modelLossProbability ?? Number.NaN) - 0.35) < 1e-12);
  assert.equal(full.sporting.probabilitySemantics, "EXPLICIT_WIN_PUSH_LOSS");
  assert.equal(full.globalRank.blockers.includes("SETTLEMENT_MODEL_INCOMPLETE"), false);

  assert.equal(early.sporting.modelWinProbability, 0.61);
  assert.equal(early.sporting.modelPushProbability, null);
  assert.equal(early.sporting.probabilitySemantics, "SOURCE_WIN_PROBABILITY_PUSH_UNMODELED");
  assert.equal(early.globalRank.blockers.includes("SETTLEMENT_MODEL_INCOMPLETE"), true);
  assert.equal(early.pricing.status, "UNPRICED");
  assert.equal(early.calibration.status, "NOT_ATTACHED");
});

test("candidate pool command preserves Early output when Full Game assembly is blocked", async () => {
  const early = earlyPayload("HOME");
  const response = await executeMlbNormalizedCandidatePoolCommand("2026-09-04", {
    liveEvidenceProviders: {} as any,
    provisionalV16Provider: async () => { throw new Error("should not run"); },
    now: () => new Date("2026-09-04T14:00:00.000Z"),
    runIdFactory: () => "pool-run-1",
    buildSlate: async () => slate(),
    buildEarlyCandidates: async () => early,
    assembleLiveInput: async () => ({ status: "BLOCKED", blockers: ["FULL_GAME_EVIDENCE_BLOCKED"] } as any),
  });

  assert.equal(response.httpStatus, 200);
  const body = response.body as any;
  assert.equal(body.success, true);
  assert.equal(body.data.sources.fullGame.status, "BLOCKED");
  assert.equal(body.data.sources.fullGame.candidateCount, 0);
  assert.equal(body.data.sources.early.status, "READY");
  assert.equal(body.data.sources.early.candidateCount, 1);
  assert.equal(body.data.candidates.length, 1);
  assert.equal(body.data.candidates[0].engine.family, "EARLY");
  assert.equal(body.policy.paidOddsCalled, false);
});
