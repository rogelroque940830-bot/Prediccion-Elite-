import test from "node:test";
import assert from "node:assert/strict";
import { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";
import type { LedgerRecord } from "./mlb-ledger-store";

function audit(overrides: any = {}) {
  const team = (side: "HOME" | "AWAY") => ({
    side,
    teamName: side === "HOME" ? "Home" : "Away",
    source: {
      detector: "BALLDONTLIE", detectorStatus: "VERIFIED", detectorStale: false,
      validator: "MLB_STATS", validatorStatus: "VERIFIED", rejectedCount: 0, officialOnly: 0,
    },
    phaseB: {
      enabled: true, mode: "AUTO_CONSERVATIVE", coverage: "FULL", candidateCount: 0,
      eligiblePlayerNames: [], withheldCandidateNames: [], scale: 0.5, maxAbsRuns: 0.5,
      autoApplyAllowed: true, requiresBullpenReconciliation: true, reason: "ok",
    },
    reconciliation: { bullpenStatusAvailable: true, blockedReason: null },
    adjustment: {
      rawAutomaticRuns: 0, scaledAutomaticRuns: 0, finalRuns: 0, manualOverride: false,
      factorType: "Mixto", offenseFactor: 1, defenseFactor: 0.5,
      selectedPlayerNames: [], autoAppliedPlayerNames: [],
    },
    counts: {
      detected: 0, candidates: 0, backendEligible: 0, autoApplied: 0,
      selected: 0, retained: 0, rejected: 0, officialOnly: 0,
    },
    players: [],
  });
  const base = {
    schemaVersion: "mlb-injury-audit.v1",
    capturedAt: "2026-07-28T12:00:00.000Z",
    mode: "PHASE_B_AUTO_CONSERVATIVE",
    home: team("HOME"),
    away: team("AWAY"),
  };
  return {
    ...base,
    ...overrides,
    home: { ...base.home, ...(overrides.home || {}) },
    away: { ...base.away, ...(overrides.away || {}) },
  };
}

function record({
  id,
  probability,
  result,
  profit,
  auditValue,
  effect,
}: {
  id: string;
  probability: number;
  result?: string;
  profit?: number;
  auditValue: any;
  effect?: any;
}): LedgerRecord {
  return {
    prediction: {
      id,
      clientRequestId: `req-${id}`,
      recordedAt: "2026-07-28T12:00:00.000Z",
      recordedAtMs: Date.parse("2026-07-28T12:00:00.000Z"),
      game: { gamePk: 1, gameDate: "2026-07-28", commenceTime: "2026-07-28T18:00:00.000Z", homeTeam: "Home", awayTeam: "Away" },
      market: { type: "ML", selection: "Home ML", line: null, oddsAmerican: -110, book: "Hard Rock" },
      probabilities: { model: probability, marketImplied: 0.5238, noVig: null, edgePp: 6 },
      decision: { signal: "BET", confidenceLabel: "A", confidencePct: probability * 100, stakeUnits: 1 },
      analysisStage: "FINAL",
      model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2", gitCommit: null, environment: "test" },
      supersedesId: null,
      source: "app",
      payloadSha256: `sha-${id}`,
      payload: {
        analysis: {
          injuryAudit: auditValue,
          layers: effect ? { injuryEffect: effect } : {},
        },
      },
    },
    settlement: result ? {
      eventId: `settle-${id}`,
      predictionId: id,
      clientRequestId: `settle-req-${id}`,
      recordedAt: "2026-07-29T01:00:00.000Z",
      recordedAtMs: Date.parse("2026-07-29T01:00:00.000Z"),
      settledAt: "2026-07-29T01:00:00.000Z",
      result,
      closingOddsAmerican: -105,
      closingLine: null,
      closingImpliedProbability: 0.5122,
      clvPp: 1.16,
      outcomeValue: result === "WIN" ? 1 : result === "LOSS" ? 0 : null,
      finalScore: { home: 5, away: 3 },
      profitUnits: profit ?? 0,
      source: "official",
      correctionOfEventId: null,
      notes: null,
      payloadSha256: `settle-sha-${id}`,
      payload: {},
    } : null,
  } as LedgerRecord;
}

test("C2B scores settled audited picks and keeps pending picks", () => {
  const autoAudit = audit({
    home: {
      counts: { detected: 1, candidates: 1, backendEligible: 1, autoApplied: 1, selected: 1, retained: 0, rejected: 0, officialOnly: 0 },
      adjustment: {
        rawAutomaticRuns: -0.4, scaledAutomaticRuns: -0.2, finalRuns: -0.2, manualOverride: false,
        factorType: "Reliever", offenseFactor: 0, defenseFactor: 1,
        selectedPlayerNames: ["Closer"], autoAppliedPlayerNames: ["Closer"],
      },
    },
  });
  const retainedAudit = audit({
    home: {
      phaseB: {
        enabled: true, mode: "AUTO_CONSERVATIVE", coverage: "PARTIAL", candidateCount: 1,
        eligiblePlayerNames: [], withheldCandidateNames: ["Hitter"], scale: 0.35, maxAbsRuns: 0.35,
        autoApplyAllowed: false, requiresBullpenReconciliation: true, reason: "withheld",
      },
      counts: { detected: 1, candidates: 1, backendEligible: 0, autoApplied: 0, selected: 0, retained: 1, rejected: 0, officialOnly: 0 },
    },
  });

  const report = buildMlbInjuryOutcomesReport([
    record({
      id: "win", probability: 0.7, result: "WIN", profit: 0.91, auditValue: autoAudit,
      effect: { homeProbabilityDeltaPp: 2.5, totalRunsDelta: 0.2, dataQuality: "VERIFIED" },
    }),
    record({ id: "loss", probability: 0.6, result: "LOSS", profit: -1, auditValue: retainedAudit }),
    record({ id: "pending", probability: 0.58, auditValue: retainedAudit }),
  ]);

  assert.equal(report.schemaVersion, "mlb-injury-outcomes-report.v1");
  assert.equal(report.summary.total, 3);
  assert.equal(report.summary.settled, 2);
  assert.equal(report.summary.pending, 1);
  assert.equal(report.summary.scored, 2);
  assert.equal(report.summary.wins, 1);
  assert.equal(report.summary.losses, 1);
  assert.equal(report.cohorts.AUTO_APPLIED.total, 1);
  assert.equal(report.cohorts.AUTO_APPLIED.wins, 1);
  assert.equal(report.cohorts.RETAINED.total, 2);
  assert.equal(report.cohorts.PARTIAL_COVERAGE.total, 2);
  assert.equal(report.summary.effectAvailable, 3);
  assert.equal(report.summary.effectUnavailable, 0);
  assert.equal(report.recentSettled.length, 2);
  assert.ok((report.summary.brierScore ?? 1) < 0.3);
  assert.ok((report.summary.logLoss ?? 10) < 1);
});

test("C2B marks non-zero legacy adjustments without counterfactual data as unavailable", () => {
  const legacyAudit = audit({
    home: {
      adjustment: {
        rawAutomaticRuns: -0.4, scaledAutomaticRuns: -0.2, finalRuns: -0.2, manualOverride: false,
        factorType: "Reliever", offenseFactor: 0, defenseFactor: 1,
        selectedPlayerNames: ["Closer"], autoAppliedPlayerNames: ["Closer"],
      },
      counts: { detected: 1, candidates: 1, backendEligible: 1, autoApplied: 1, selected: 1, retained: 0, rejected: 0, officialOnly: 0 },
    },
  });
  const report = buildMlbInjuryOutcomesReport([
    record({ id: "legacy", probability: 0.62, result: "WIN", profit: 0.8, auditValue: legacyAudit }),
  ]);
  assert.equal(report.summary.effectAvailable, 0);
  assert.equal(report.summary.effectUnavailable, 1);
  assert.equal(report.recentSettled[0].effect.source, "UNAVAILABLE");
});


test("C2B derives proper-score targets from settlement result, not raw market margin", () => {
  const winRecord = record({
    id: "margin-win", probability: 0.6781014109277892, result: "WIN", profit: 0.7143, auditValue: audit(),
  });
  const lossRecord = record({
    id: "margin-loss", probability: 0.62, result: "LOSS", profit: -1, auditValue: audit(),
  });
  if (!winRecord.settlement || !lossRecord.settlement) throw new Error("settlements required");
  winRecord.settlement.outcomeValue = 14;
  lossRecord.settlement.outcomeValue = -3;

  const report = buildMlbInjuryOutcomesReport([winRecord, lossRecord]);
  assert.equal(report.summary.scored, 2);
  assert.ok(report.summary.brierScore != null && report.summary.brierScore >= 0 && report.summary.brierScore <= 1);
  assert.ok(report.summary.logLoss != null && report.summary.logLoss >= 0);

  const win = report.recentSettled.find((row) => row.predictionId === "margin-win");
  const loss = report.recentSettled.find((row) => row.predictionId === "margin-loss");
  assert.equal(win?.outcomeValue, 1);
  assert.equal(loss?.outcomeValue, 0);
  assert.ok((win?.brierScore ?? 2) < 1);
  assert.ok((loss?.brierScore ?? 2) < 1);
});
