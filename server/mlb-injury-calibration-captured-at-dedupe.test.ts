import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbInjuryCalibrationReport } from "./mlb-injury-calibration-report";

function team(side: "HOME" | "AWAY", teamName: string) {
  return {
    side,
    teamName,
    source: {
      detector: "BALLDONTLIE",
      detectorStatus: "PARTIAL",
      detectorStale: false,
      validator: "MLB_STATS",
      validatorStatus: "VERIFIED",
      rejectedCount: 0,
      officialOnly: 1,
    },
    phaseB: {
      enabled: true,
      mode: "AUTO_CONSERVATIVE",
      coverage: "PARTIAL",
      candidateCount: 1,
      eligiblePlayerNames: [],
      withheldCandidateNames: ["Example Player"],
      scale: 0.35,
      maxAbsRuns: 0.35,
      autoApplyAllowed: false,
      requiresBullpenReconciliation: true,
      reason: "Conservative test context",
    },
    reconciliation: {
      bullpenStatusAvailable: true,
      blockedReason: null,
    },
    adjustment: {
      rawAutomaticRuns: 0,
      scaledAutomaticRuns: 0,
      finalRuns: 0,
      manualOverride: false,
      factorType: "Fase B automática",
      offenseFactor: 1,
      defenseFactor: 0.5,
      selectedPlayerNames: [],
      autoAppliedPlayerNames: [],
    },
    counts: {
      detected: 1,
      candidates: 1,
      backendEligible: 0,
      autoApplied: 0,
      selected: 0,
      retained: 1,
      rejected: 0,
      officialOnly: 1,
    },
    players: [{
      name: "Example Player",
      isPitcher: false,
      disposition: "WITHHELD_POLICY",
    }],
  };
}

function record(market: string, capturedAt: string, recordedAtMs: number) {
  const injuryAudit = {
    schemaVersion: "mlb-injury-audit.v1",
    capturedAt,
    mode: "PHASE_B_AUTO_CONSERVATIVE",
    home: team("HOME", "Detroit Tigers"),
    away: team("AWAY", "Baltimore Orioles"),
  };
  return {
    prediction: {
      id: `pred-${market}`,
      clientRequestId: `request-${market}`,
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
      model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2", gitCommit: null, environment: "p0-integration" },
      supersedesId: null,
      source: "app",
      payloadSha256: `sha-${market}`,
      payload: { analysis: { injuryAudit } },
    },
    settlement: null,
  } as any;
}

test("different per-market capturedAt values remain one injury decision context", () => {
  const report = buildMlbInjuryCalibrationReport([
    record("ML", "2026-07-28T03:55:24.324Z", 1_000),
    record("F5_ML", "2026-07-28T03:55:25.812Z", 2_000),
  ]);

  assert.equal(report.sample.auditedPredictions, 2);
  assert.equal(report.sample.uniqueAuditContexts, 1);
  assert.equal(report.sample.duplicateMarketSnapshotsExcluded, 1);
  assert.equal(report.decisions.candidates, 2);
  assert.equal(report.decisions.retained, 2);
  assert.deepEqual(report.recent[0].markets, ["F5_ML", "ML"]);
});
