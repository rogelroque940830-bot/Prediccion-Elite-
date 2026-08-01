import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";
import { buildMlbS6lScientificMetrics } from "./mlb-s6l-scientific-metrics";
import {
  evaluateMlbS6mMilestones,
  type S6mCertificateMap,
  type S6mMilestoneReport,
} from "./mlb-s6m-statistical-milestones";
import type { S6oReport } from "./mlb-s6o-first-five-settlements-certification";
import {
  evaluateMlbS6pFirstTwentySettlements,
  type S6pBaseline,
  type S6pEvidence,
} from "./mlb-s6p-first-twenty-settlements-certification";

const cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(index: number, options: {
  id?: string; supersedesId?: string | null; stage?: "PROVISIONAL" | "FINAL";
  gamePk?: number; odds?: number; probability?: number; result?: "WIN" | "LOSS" | null; recordedOffset?: number;
} = {}): LedgerRecord {
  const id = options.id ?? `prediction-${index}`;
  const gamePk = options.gamePk ?? 880000 + index;
  const recordedAtMs = cutoffMs + 60_000 + (options.recordedOffset ?? index) * 1_000;
  const odds = options.odds ?? -110;
  const probability = options.probability ?? 0.6;
  const result = options.result === undefined ? (index % 2 === 0 ? "WIN" : "LOSS") : options.result;
  return {
    prediction: {
      id, clientRequestId: `s5c:${id}`, recordedAt: new Date(recordedAtMs).toISOString(), recordedAtMs,
      game: { gamePk, gameDate: "2026-08-01", commenceTime: new Date(recordedAtMs + 3_600_000).toISOString(), homeTeam: `Home ${gamePk}`, awayTeam: `Away ${gamePk}` },
      market: { type: "F5_TOTAL", selection: "OVER 4.5", line: 4.5, oddsAmerican: odds, book: "betmgm, draftkings, fanduel" },
      probabilities: { model: probability, marketImplied: Math.abs(odds) / (Math.abs(odds) + 100), noVig: null, edgePp: 1 },
      decision: { signal: index % 3 === 0 ? "BET_FUERTE" : "BET", confidenceLabel: "MODEL", confidencePct: probability * 100, stakeUnits: 0 },
      analysisStage: options.stage ?? "FINAL",
      model: { name: "CourtEdge MLB Early Markets", version: "s5c-shadow-v2-price-integrity", gitCommit: "fixture", environment: "test" },
      supersedesId: options.supersedesId ?? null, source: "app", payloadSha256: `${index}`.padStart(64, "a").slice(-64),
      payload: { market: { capturedAt: new Date(recordedAtMs - 30_000).toISOString() }, analysis: { layers: { s5c: { schemaVersion: "mlb-s5c-shadow-ingestion.v1" }, marketPriceIntegrity: { standardAmericanOddsValidated: true, consensusMethod: "median_implied_probability" } }, rawInputs: { priceCapture: { capturedAt: new Date(recordedAtMs - 30_000).toISOString(), consensusMethod: "median_implied_probability" }, marketProvenance: { consensusMethod: "median_implied_probability", contributingBooks: ["betmgm", "draftkings", "fanduel"] } } } },
    },
    settlement: result ? { eventId: `settlement-${id}`, settledAt: new Date(recordedAtMs + 7_200_000).toISOString(), source: "correction", correctionOfEventId: `official-${id}`, result, outcomeValue: result === "WIN" ? 6 : 2, finalScore: { home: 4, away: 2 }, profitUnits: 0, closingOddsAmerican: -108, closingLine: 4.5, clvPp: 1.2 } : null,
  } as LedgerRecord;
}

function pairedDecision(index: number, result: "WIN" | "LOSS" | null = index % 2 === 0 ? "WIN" : "LOSS"): LedgerRecord[] {
  const rootId = `root-${index}`;
  return [
    record(index, { id: rootId, stage: "PROVISIONAL", result: null, probability: 0.54 + (index % 5) * 0.02, odds: -105, recordedOffset: index * 2 }),
    record(index, { id: `final-${index}`, supersedesId: rootId, stage: "FINAL", result, probability: 0.56 + (index % 5) * 0.02, recordedOffset: index * 2 + 1 }),
  ];
}

function recordsFor(count: number): LedgerRecord[] {
  return Array.from({ length: count }, (_, index) => pairedDecision(index)).flat();
}

function terminalIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `final-${index}`);
}

function buildS6m(records: LedgerRecord[], certifiedIds: string[] = []): { report: S6mMilestoneReport; certificates: S6mCertificateMap } {
  const s6l = buildMlbS6lScientificMetrics(records, { certifiedTerminalPredictionIds: certifiedIds, generatedAt: "2026-08-01T21:00:00.000Z" });
  const evaluation = evaluateMlbS6mMilestones(records, s6l, certifiedIds, {}, { generatedAt: "2026-08-01T21:01:00.000Z", deploymentCommit: "fixture", environment: "test" });
  const certificates: S6mCertificateMap = {};
  for (const certificate of evaluation.newCertificates) certificates[`${certificate.milestone}`] = certificate;
  return { report: evaluation.report, certificates };
}

function certifiedS6oReport(): S6oReport {
  return {
    generatedAt: "2026-08-01T21:00:30.000Z", state: "FIRST_FIVE_SETTLEMENTS_CERTIFIED", issues: [],
    readiness: { firstFiveSettlementsCertified: true },
  } as S6oReport;
}

function evaluate(records: LedgerRecord[], report: S6mMilestoneReport | null, certificates: S6mCertificateMap, stored: { baseline?: S6pBaseline | null; evidence?: S6pEvidence | null; baselinePresent?: boolean; evidencePresent?: boolean; baselineReadError?: string | null; evidenceReadError?: string | null } = {}, generatedAt = "2026-08-01T21:02:00.000Z", s6oReport: S6oReport | null = certifiedS6oReport(), previousOwnedLedgerRecords: number | null = null) {
  return evaluateMlbS6pFirstTwentySettlements(records, report, certificates, s6oReport, terminalIds(20), { baseline: stored.baseline ?? null, evidence: stored.evidence ?? null, baselinePresent: stored.baselinePresent, evidencePresent: stored.evidencePresent, baselineReadError: stored.baselineReadError, evidenceReadError: stored.evidenceReadError }, { generatedAt, deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords });
}

test("remains armed below twenty eligible settlements", () => {
  const records = recordsFor(19);
  const { report, certificates } = buildS6m(records, terminalIds(19));
  const result = evaluate(records, report, certificates);
  assert.equal(result.report.state, "ARMED_AND_WAITING_FOR_20");
  assert.equal(result.report.sample.binaryEligibleDecisions, 19);
  assert.equal(result.report.readiness.preliminaryReviewAvailable, false);
});

test("records an append-only baseline for a valid milestone 20 certificate", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const result = evaluate(records, report, certificates);
  assert.equal(result.report.state, "OBSERVING_TWENTY_RESULT_STABILITY");
  assert.equal(result.report.checks.certificateIntegrity, true);
  assert.ok(result.baselineToPersist);
  assert.equal(result.baselineToPersist?.terminalPredictionIds.length, 20);
});

test("certifies the minimum sample only after a second stable observation", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6oReport(), records.length);
  assert.equal(second.report.state, "MINIMUM_SAMPLE_20_CERTIFIED");
  assert.equal(second.report.readiness.preliminaryReviewAvailable, true);
  assert.equal(second.report.readiness.sampleAdequateForModelConclusions, false);
  assert.equal(second.report.readiness.conclusionsAllowed, false);
  assert.equal(second.report.readiness.automaticModelChangesAllowed, false);
  assert.ok(second.evidenceToPersist);
  assert.equal(second.evidenceToPersist?.calibrationBuckets.reduce((sum, row) => sum + row.sampleSize, 0), 20);
  assert.equal(second.evidenceToPersist?.provisionalFinalComparison.comparableDecisions, 20);
});

test("blocks milestone 20 when the first-five prerequisite is not certified", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const pending = { ...certifiedS6oReport(), state: "ARMED_AND_WAITING_FOR_5", readiness: { firstFiveSettlementsCertified: false }, issues: [] } as S6oReport;
  const result = evaluate(records, report, certificates, {}, undefined, pending);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "FIRST_FIVE_PREREQUISITE_NOT_CERTIFIED"), true);
});

test("detects milestone 20 certificate tampering", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const changed = structuredClone(certificates);
  if (!changed["20"]) throw new Error("fixture certificate missing");
  changed["20"].certificateDigestSha256 = "0".repeat(64);
  const result = evaluate(records, report, changed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_DIGEST_MISMATCH"), true);
});

test("detects ledger settlement divergence", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const changed = structuredClone(records);
  const terminal = changed.find((entry) => entry.prediction.id === "final-0");
  if (!terminal?.settlement) throw new Error("fixture settlement missing");
  terminal.settlement.eventId = "changed-event";
  const result = evaluate(changed, report, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "SETTLEMENT_IDENTITY_MISMATCH"), true);
});

test("rejects tampered append-only evidence", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6oReport(), records.length);
  if (!second.evidenceToPersist) throw new Error("fixture evidence missing");
  const tampered = structuredClone(second.evidenceToPersist);
  tampered.metrics.wins += 1;
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_DIGEST_INVALID"), true);
});

test("later independent-certification maturity does not alter immutable identity", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, []);
  const first = evaluateMlbS6pFirstTwentySettlements(records, report, certificates, certifiedS6oReport(), [], { baseline: null, evidence: null }, { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 });
  assert.ok(first.baselineToPersist);
  const matured = buildS6m(records, terminalIds(20));
  const second = evaluateMlbS6pFirstTwentySettlements(records, matured.report, certificates, certifiedS6oReport(), terminalIds(20), { baseline: first.baselineToPersist, evidence: null }, { generatedAt: "2026-08-01T21:03:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords: records.length });
  assert.notEqual(second.report.state, "ACTION_REQUIRED");
});

test("S6M critical issues block certification", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const broken = structuredClone(report);
  broken.issues.push({ code: "BROKEN", severity: "CRITICAL", message: "fixture" });
  const result = evaluate(records, broken, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.checks.s6mIntegrityGatePassed, false);
});


test("turns a syntactically valid but malformed baseline into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const malformed = {} as S6pBaseline;
  const result = evaluate(records, report, certificates, { baseline: malformed });
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_SHAPE_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});

test("turns syntactically valid but malformed evidence into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  const malformed = {} as S6pEvidence;
  const result = evaluate(
    records,
    report,
    certificates,
    { baseline: first.baselineToPersist, evidence: malformed },
    "2026-08-01T21:03:00.000Z",
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_SHAPE_INVALID"), true);
  assert.equal(result.evidenceToPersist, null);
});


test("rejects every falsy but present baseline JSON artifact", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  for (const malformed of [false, 0, "", null]) {
    const result = evaluate(records, report, certificates, {
      baseline: malformed as unknown as S6pBaseline,
      baselinePresent: true,
    });
    assert.equal(result.report.state, "ACTION_REQUIRED");
    assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_SHAPE_INVALID"), true);
    assert.equal(result.baselineToPersist, null);
  }
});

test("rejects every falsy but present evidence JSON artifact without synthesizing certification", () => {
  const records = recordsFor(20);
  const { report, certificates } = buildS6m(records, terminalIds(20));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  for (const malformed of [false, 0, "", null]) {
    const result = evaluate(
      records,
      report,
      certificates,
      {
        baseline: first.baselineToPersist,
        evidence: malformed as unknown as S6pEvidence,
        evidencePresent: true,
      },
      "2026-08-01T21:03:00.000Z",
    );
    assert.equal(result.report.state, "ACTION_REQUIRED");
    assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_SHAPE_INVALID"), true);
    assert.equal(result.report.readiness.minimumSample20Certified, false);
    assert.equal(result.evidenceToPersist, null);
  }
});
