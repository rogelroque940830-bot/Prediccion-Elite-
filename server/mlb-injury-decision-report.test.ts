import test from "node:test";
import assert from "node:assert/strict";
import { buildMlbInjuryDecisionReport } from "./mlb-injury-decision-report";
import type { LedgerRecord } from "./mlb-ledger-store";

function audit() {
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
  return {
    schemaVersion: "mlb-injury-audit.v1",
    capturedAt: "2026-07-28T12:00:00.000Z",
    mode: "PHASE_B_AUTO_CONSERVATIVE",
    home: team("HOME"),
    away: team("AWAY"),
  };
}

function record(index: number, options: {
  probability: number;
  result?: "WIN" | "LOSS";
  profit?: number;
  clvPp?: number;
  market?: string;
}): LedgerRecord {
  const id = `c2c-${index}`;
  return {
    prediction: {
      id,
      clientRequestId: `req-${id}`,
      recordedAt: `2026-07-${String(1 + (index % 27)).padStart(2, "0")}T12:00:00.000Z`,
      recordedAtMs: Date.parse("2026-07-01T12:00:00.000Z") + index * 86_400_000,
      game: { gamePk: index + 1, gameDate: "2026-07-28", commenceTime: "2026-07-28T18:00:00.000Z", homeTeam: "Home", awayTeam: "Away" },
      market: { type: options.market || "ML", selection: "Home", line: null, oddsAmerican: 100, book: "Hard Rock" },
      probabilities: { model: options.probability, marketImplied: 0.5, noVig: null, edgePp: 5 },
      decision: { signal: "BET", confidenceLabel: "A", confidencePct: options.probability * 100, stakeUnits: 1 },
      analysisStage: "FINAL",
      model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2", gitCommit: null, environment: "test" },
      supersedesId: null,
      source: "app",
      payloadSha256: `sha-${id}`,
      payload: { analysis: { injuryAudit: audit(), layers: { injuryEffect: { homeProbabilityDeltaPp: 0, totalRunsDelta: 0, dataQuality: "VERIFIED" } } } },
    },
    settlement: options.result ? {
      eventId: `settle-${id}`,
      predictionId: id,
      clientRequestId: `settle-req-${id}`,
      recordedAt: "2026-07-29T01:00:00.000Z",
      recordedAtMs: Date.parse("2026-07-29T01:00:00.000Z") + index,
      settledAt: "2026-07-29T01:00:00.000Z",
      result: options.result,
      closingOddsAmerican: -105,
      closingLine: null,
      closingImpliedProbability: 0.5122,
      clvPp: options.clvPp ?? 0,
      outcomeValue: options.result === "WIN" ? 1 : 0,
      finalScore: { home: 5, away: 3 },
      profitUnits: options.profit ?? (options.result === "WIN" ? 1 : -1),
      source: "official",
      correctionOfEventId: null,
      notes: null,
      payloadSha256: `settle-sha-${id}`,
      payload: {},
    } : null,
  } as LedgerRecord;
}

test("C2C maintains rules when sample is insufficient", () => {
  const rows = Array.from({ length: 5 }, (_, index) => record(index, {
    probability: index % 2 === 0 ? 0.65 : 0.35,
    result: index % 2 === 0 ? "WIN" : "LOSS",
  }));
  const report = buildMlbInjuryDecisionReport(rows);
  assert.equal(report.schemaVersion, "mlb-injury-decision-report.v1");
  assert.equal(report.global.verdict, "MANTENER");
  assert.equal(report.global.sampleStatus, "INSUFFICIENT");
  assert.equal(report.global.confidence, "LOW");
  assert.equal(report.policy.automaticRuleChanges, false);
});

test("C2C restricts only after actionable sample and multiple negative signals", () => {
  const rows = Array.from({ length: 25 }, (_, index) => record(index, {
    probability: 0.8,
    result: "LOSS",
    profit: -1,
    clvPp: -2,
    market: index % 2 === 0 ? "ML" : "F5",
  }));
  const report = buildMlbInjuryDecisionReport(rows);
  assert.equal(report.global.sampleStatus, "ACTIONABLE");
  assert.equal(report.global.verdict, "RESTRINGIR");
  assert.ok(report.global.reasons.length >= 2);
  assert.equal(report.alerts[0]?.verdict, "RESTRINGIR");
});

test("C2C expands cautiously only with mature sample and multiple positive signals", () => {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const win = index < 24;
    return record(index, {
      probability: win ? 0.8 : 0.2,
      result: win ? "WIN" : "LOSS",
      profit: win ? 1 : -1,
      clvPp: 1,
      market: index % 3 === 0 ? "F5" : "ML",
    });
  });
  const report = buildMlbInjuryDecisionReport(rows);
  assert.equal(report.global.sampleStatus, "MATURE");
  assert.equal(report.global.verdict, "AMPLIAR_CON_CAUTELA");
  assert.equal(report.global.confidence, "HIGH");
  assert.ok(report.markets.length >= 2);
});
