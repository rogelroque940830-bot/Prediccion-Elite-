import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbInjuryCalibrationReport } from "./mlb-injury-calibration-report";

function audit() {
  const team = (side: "HOME" | "AWAY", name: string, coverage: "FULL" | "PARTIAL") => ({
    side,
    teamName: name,
    source: {
      detector: "BALLDONTLIE",
      detectorStatus: coverage === "FULL" ? "VERIFIED" : "PARTIAL",
      detectorStale: false,
      validator: "MLB_STATS",
      validatorStatus: "VERIFIED",
      rejectedCount: side === "HOME" ? 1 : 0,
      officialOnly: side === "AWAY" ? 2 : 0,
    },
    phaseB: {
      enabled: true,
      mode: "AUTO_CONSERVATIVE" as const,
      coverage,
      candidateCount: 1,
      eligiblePlayerNames: side === "HOME" ? ["Closer One"] : [],
      withheldCandidateNames: side === "AWAY" ? ["Hitter One"] : [],
      scale: coverage === "FULL" ? 0.5 : 0.35,
      maxAbsRuns: coverage === "FULL" ? 0.5 : 0.35,
      autoApplyAllowed: side === "HOME",
      requiresBullpenReconciliation: true,
      reason: "Calibration test",
    },
    reconciliation: {
      bullpenStatusAvailable: true,
      bullpenRunsAdjustment: side === "AWAY" ? 0.2 : 0,
      blockedReason: side === "AWAY" ? "BULLPEN_EFFECT_ALREADY_APPLIED" : null,
      closerAvailable: side === "HOME",
      bullpenCompromised: side === "AWAY",
    },
    adjustment: {
      rawAutomaticRuns: side === "HOME" ? -0.8 : 0,
      scaledAutomaticRuns: side === "HOME" ? -0.4 : 0,
      finalRuns: side === "HOME" ? -0.4 : -0.2,
      manualOverride: side === "AWAY",
      factorType: side === "HOME" ? "Fase B automática" : "Manual",
      offenseFactor: 1,
      defenseFactor: 0.8,
      selectedPlayerNames: side === "HOME" ? ["Closer One"] : ["Hitter One"],
      autoAppliedPlayerNames: side === "HOME" ? ["Closer One"] : [],
    },
    counts: {
      detected: 2,
      candidates: 1,
      backendEligible: side === "HOME" ? 1 : 0,
      autoApplied: side === "HOME" ? 1 : 0,
      selected: 1,
      retained: side === "AWAY" ? 1 : 0,
      rejected: side === "HOME" ? 1 : 0,
      officialOnly: side === "AWAY" ? 2 : 0,
    },
    players: [
      {
        playerId: side === "HOME" ? 1 : 2,
        name: side === "HOME" ? "Closer One" : "Hitter One",
        isPitcher: side === "HOME",
        disposition: side === "HOME" ? "AUTO_APPLIED" as const : "WITHHELD_BULLPEN" as const,
      },
      {
        playerId: side === "HOME" ? 3 : 4,
        name: "Old Injury",
        isPitcher: true,
        disposition: "IGNORED" as const,
      },
    ],
  });
  return {
    schemaVersion: "mlb-injury-audit.v1" as const,
    capturedAt: "2026-07-28T03:55:24.324Z",
    mode: "PHASE_B_AUTO_CONSERVATIVE" as const,
    home: team("HOME", "Detroit Tigers", "FULL"),
    away: team("AWAY", "Baltimore Orioles", "PARTIAL"),
  };
}

function record(market: string, settled: boolean, withAudit = true, recordedAtMs = 1_000) {
  return {
    prediction: {
      id: `pred-${market}-${recordedAtMs}`,
      clientRequestId: `request-${market}-${recordedAtMs}`,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: {
        gamePk: 824243,
        gameDate: "2026-07-28",
        commenceTime: "2026-07-28T22:40:00.000Z",
        homeTeam: "Detroit Tigers",
        awayTeam: "Baltimore Orioles",
      },
      market: { type: market, selection: `${market} selection`, line: null, oddsAmerican: -110, book: "Hard Rock" },
      probabilities: { model: 0.6, marketImplied: 0.5238, noVig: 0.5, edgePp: 7.62 },
      decision: { signal: "BET", confidenceLabel: "A", confidencePct: 60, stakeUnits: 1 },
      analysisStage: "PROVISIONAL",
      model: { name: "CourtEdge MLB", version: withAudit ? "predictor-full-snapshot-v2" : "predictor-full-snapshot-v1", gitCommit: null, environment: "p0-integration" },
      supersedesId: null,
      source: "app",
      payloadSha256: `sha-${market}-${recordedAtMs}`,
      payload: {
        analysis: withAudit ? { injuryAudit: audit() } : {},
      },
    },
    settlement: settled ? {
      eventId: `settle-${market}`,
      predictionId: `pred-${market}-${recordedAtMs}`,
      result: "WIN",
      profitUnits: 0.91,
    } : null,
  } as any;
}

test("report deduplicates identical injury contexts across multiple markets", () => {
  const report = buildMlbInjuryCalibrationReport([
    record("ML", true, true, 1_000),
    record("F5_ML", false, true, 2_000),
    record("TOTAL", true, false, 3_000),
  ]);

  assert.equal(report.sample.totalPredictions, 3);
  assert.equal(report.sample.auditedPredictions, 2);
  assert.equal(report.sample.legacyPredictionsWithoutAudit, 1);
  assert.equal(report.sample.uniqueAnalyticalDecisions, 2);
  assert.equal(report.sample.analyticalDuplicatesExcluded, 0);
  assert.equal(report.sample.settledUniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.pendingUniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.uniqueAuditContexts, 1);
  assert.equal(report.sample.duplicateMarketSnapshotsExcluded, 1);
  assert.equal(report.sample.settledAuditedPredictions, 1);
  assert.equal(report.sample.pendingAuditedPredictions, 1);

  assert.deepEqual(report.coverage, {
    teamContexts: 2,
    full: 1,
    partial: 1,
    blocked: 0,
    fullPct: 50,
    partialPct: 50,
    blockedPct: 0,
  });

  assert.equal(report.decisions.detected, 4);
  assert.equal(report.decisions.candidates, 2);
  assert.equal(report.decisions.backendEligible, 1);
  assert.equal(report.decisions.autoApplied, 1);
  assert.equal(report.decisions.retained, 1);
  assert.equal(report.decisions.rejected, 1);
  assert.equal(report.decisions.officialOnly, 2);
  assert.equal(report.decisions.manualOverrideTeams, 1);
  assert.equal(report.decisions.bullpenBlockedTeams, 1);
  assert.equal(report.decisions.dispositions.AUTO_APPLIED, 1);
  assert.equal(report.decisions.dispositions.WITHHELD_BULLPEN, 1);
  assert.equal(report.decisions.dispositions.IGNORED, 2);

  assert.equal(report.adjustments.teamsWithAutomaticAdjustment, 1);
  assert.equal(report.adjustments.teamsWithAnyFinalAdjustment, 2);
  assert.equal(report.adjustments.totalRawRuns, -0.8);
  assert.equal(report.adjustments.totalScaledRuns, -0.4);
  assert.equal(report.adjustments.totalFinalRuns, -0.6);
  assert.equal(report.adjustments.averageAbsFinalRuns, 0.3);
  assert.equal(report.adjustments.maxAbsFinalRuns, 0.4);

  assert.equal(report.cohorts.contextsWithAutoApplied, 1);
  assert.equal(report.cohorts.contextsWithRetained, 1);
  assert.equal(report.cohorts.contextsWithManualOverride, 1);
  assert.equal(report.cohorts.contextsWithBullpenBlock, 1);
  assert.equal(report.cohorts.contextsWithPartialCoverage, 1);
  assert.equal(report.recent[0].predictionCount, 2);
  assert.deepEqual(report.recent[0].markets, ["F5_ML", "ML"]);
});

test("readiness remains conservative until enough audited picks are settled", () => {
  const report = buildMlbInjuryCalibrationReport([
    record("ML", true),
    record("F5_ML", false, true, 2_000),
  ], 20);
  assert.equal(report.readiness.targetSettledAuditedPicks, 20);
  assert.equal(report.readiness.settledAuditedPicks, 1);
  assert.equal(report.readiness.remaining, 19);
  assert.equal(report.readiness.readyForExpansion, false);
});


test("C2A readiness excludes exact analytical duplicates without removing ledger records", () => {
  const original = record("ML", true, true, 1_000);
  const duplicate = record("ML", true, true, 2_000);
  duplicate.prediction.id = "pred-ML-duplicate";
  duplicate.prediction.clientRequestId = "request-ML-duplicate";
  duplicate.prediction.payloadSha256 = "sha-ML-duplicate";
  duplicate.settlement.predictionId = duplicate.prediction.id;
  duplicate.settlement.eventId = "settle-ML-duplicate";

  const report = buildMlbInjuryCalibrationReport([original, duplicate], 20);

  assert.equal(report.readiness.countingBasis, "UNIQUE_ANALYTICAL_DECISIONS");
  assert.equal(report.readiness.settledAuditedPicks, 1);
  assert.equal(report.readiness.remaining, 19);
  assert.equal(report.sample.auditedPredictions, 2);
  assert.equal(report.sample.settledAuditedPredictions, 2);
  assert.equal(report.sample.uniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.settledUniqueAnalyticalDecisions, 1);
  assert.equal(report.sample.analyticalDuplicatesExcluded, 1);
  assert.equal(report.sample.settledAnalyticalDuplicatesExcluded, 1);
});
