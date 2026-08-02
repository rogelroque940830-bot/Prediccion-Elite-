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
import type { S6pReport } from "./mlb-s6p-first-twenty-settlements-certification";
import {
  buildMlbS6qCertifiedTerminalPredictionIdsFromS6k,
  buildMlbS6qPreviousReportArtifact,
  buildMlbS6qStoredArtifacts,
  evaluateMlbS6qFiftySettlementHumanReview,
  type S6qBaseline,
  type S6qEvidence,
} from "./mlb-s6q-fifty-settlement-human-review";

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

function certifiedS6pReport(): S6pReport {
  return {
    generatedAt: "2026-08-01T21:00:30.000Z", state: "MINIMUM_SAMPLE_20_CERTIFIED", issues: [],
    readiness: { minimumSample20Certified: true },
  } as S6pReport;
}

function evaluate(records: LedgerRecord[], report: S6mMilestoneReport | null, certificates: S6mCertificateMap, stored: { baseline?: S6qBaseline | null; evidence?: S6qEvidence | null; baselinePresent?: boolean; evidencePresent?: boolean; baselineReadError?: string | null; evidenceReadError?: string | null } = {}, generatedAt = "2026-08-01T21:02:00.000Z", s6pReport: S6pReport | null = certifiedS6pReport(), previousOwnedLedgerRecords: number | null = null) {
  return evaluateMlbS6qFiftySettlementHumanReview(records, report, certificates, s6pReport, terminalIds(50), { baseline: stored.baseline ?? null, evidence: stored.evidence ?? null, baselinePresent: stored.baselinePresent, evidencePresent: stored.evidencePresent, baselineReadError: stored.baselineReadError, evidenceReadError: stored.evidenceReadError }, { generatedAt, deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords });
}

test("remains armed below fifty eligible settlements", () => {
  const records = recordsFor(49);
  const { report, certificates } = buildS6m(records, terminalIds(49));
  const result = evaluate(records, report, certificates);
  assert.equal(result.report.state, "ARMED_AND_WAITING_FOR_50");
  assert.equal(result.report.sample.binaryEligibleDecisions, 49);
  assert.equal(result.report.readiness.humanReviewReady, false);
});

test("records an append-only baseline for a valid milestone 50 certificate", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluate(records, report, certificates);
  assert.equal(result.report.state, "OBSERVING_FIFTY_RESULT_STABILITY");
  assert.equal(result.report.checks.certificateIntegrity, true);
  assert.ok(result.baselineToPersist);
  assert.equal(result.baselineToPersist?.terminalPredictionIds.length, 50);
});

test("marks the preferred sample ready for human review only after a second stable observation", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  assert.equal(second.report.state, "READY_FOR_HUMAN_REVIEW");
  assert.equal(second.report.readiness.humanReviewReady, true);
  assert.equal(second.report.readiness.sampleAdequateForHumanReview, true);
  assert.equal(second.report.readiness.conclusionsAllowed, true);
  assert.equal(second.report.readiness.automaticModelChangesAllowed, false);
  assert.ok(second.evidenceToPersist);
  assert.equal(second.evidenceToPersist?.calibrationBuckets.reduce((sum, row) => sum + row.sampleSize, 0), 50);
  assert.equal(second.evidenceToPersist?.provisionalFinalComparison.comparableDecisions, 50);
});

test("waits for the S6P minimum-sample prerequisite without fabricating review evidence", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const pending = { ...certifiedS6pReport(), state: "ARMED_AND_WAITING_FOR_20", readiness: { minimumSample20Certified: false }, issues: [] } as S6pReport;
  const result = evaluate(records, report, certificates, {}, undefined, pending);
  assert.equal(result.report.state, "WAITING_FOR_MINIMUM_SAMPLE_20_CERTIFICATION");
  assert.equal(result.report.issues.some((entry) => entry.code === "MINIMUM_SAMPLE_20_PREREQUISITE_PENDING"), true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});

test("detects milestone 50 certificate tampering", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const changed = structuredClone(certificates);
  if (!changed["50"]) throw new Error("fixture certificate missing");
  changed["50"].certificateDigestSha256 = "0".repeat(64);
  const result = evaluate(records, report, changed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_DIGEST_MISMATCH"), true);
});

test("detects ledger settlement divergence", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const changed = structuredClone(records);
  const terminal = changed.find((entry) => entry.prediction.id === "final-0");
  if (!terminal?.settlement) throw new Error("fixture settlement missing");
  terminal.settlement.eventId = "changed-event";
  const result = evaluate(changed, report, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "SETTLEMENT_IDENTITY_MISMATCH"), true);
});

test("rejects tampered append-only evidence", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!second.evidenceToPersist) throw new Error("fixture evidence missing");
  const tampered = structuredClone(second.evidenceToPersist);
  tampered.metrics.wins += 1;
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_DIGEST_INVALID"), true);
});

test("waits for ten independent certifications and then records the stable review baseline", () => {
  const records = recordsFor(50);
  const immature = buildS6m(records, terminalIds(9));
  const waiting = evaluateMlbS6qFiftySettlementHumanReview(records, immature.report, immature.certificates, certifiedS6pReport(), terminalIds(9), { baseline: null, evidence: null }, { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 });
  assert.equal(waiting.report.state, "WAITING_FOR_TEN_CERTIFIED_CYCLES");
  assert.equal(waiting.baselineToPersist, null);
  const mature = buildS6m(records, terminalIds(10));
  const unlocked = evaluateMlbS6qFiftySettlementHumanReview(records, mature.report, immature.certificates, certifiedS6pReport(), terminalIds(10), { baseline: null, evidence: null }, { generatedAt: "2026-08-01T21:03:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000, previousOwnedLedgerRecords: records.length });
  assert.equal(unlocked.report.state, "OBSERVING_FIFTY_RESULT_STABILITY");
  assert.ok(unlocked.baselineToPersist);
});

test("S6M critical issues block certification", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const broken = structuredClone(report);
  broken.issues.push({ code: "BROKEN", severity: "CRITICAL", message: "fixture" });
  const result = evaluate(records, broken, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.checks.s6mIntegrityGatePassed, false);
});


test("turns a syntactically valid but malformed baseline into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = {} as S6qBaseline;
  const result = evaluate(records, report, certificates, { baseline: malformed });
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_SHAPE_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});

test("turns syntactically valid but malformed evidence into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  const malformed = {} as S6qEvidence;
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
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  for (const malformed of [false, 0, "", null]) {
    const result = evaluate(records, report, certificates, {
      baseline: malformed as unknown as S6qBaseline,
      baselinePresent: true,
    });
    assert.equal(result.report.state, "ACTION_REQUIRED");
    assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_SHAPE_INVALID"), true);
    assert.equal(result.baselineToPersist, null);
  }
});

test("rejects every falsy but present evidence JSON artifact without synthesizing certification", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  for (const malformed of [false, 0, "", null]) {
    const result = evaluate(
      records,
      report,
      certificates,
      {
        baseline: first.baselineToPersist,
        evidence: malformed as unknown as S6qEvidence,
        evidencePresent: true,
      },
      "2026-08-01T21:03:00.000Z",
    );
    assert.equal(result.report.state, "ACTION_REQUIRED");
    assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_SHAPE_INVALID"), true);
    assert.equal(result.report.readiness.humanReviewReady, false);
    assert.equal(result.evidenceToPersist, null);
  }
});


test("preserves present-but-null artifacts when rebuilding refreshed worker state", () => {
  const stored = buildMlbS6qStoredArtifacts(
    { value: null, error: null, present: true },
    { value: null, error: null, present: true },
  );
  assert.equal(stored.baseline, null);
  assert.equal(stored.evidence, null);
  assert.equal(stored.baselinePresent, true);
  assert.equal(stored.evidencePresent, true);
});


test("does not permit automatic model changes after human review becomes ready", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  assert.equal(second.report.state, "READY_FOR_HUMAN_REVIEW");
  assert.equal(second.report.readiness.humanReviewReady, true);
  assert.equal(second.report.readiness.conclusionsAllowed, true);
  assert.equal(second.report.readiness.automaticModelChangesAllowed, false);
  assert.equal(second.report.readiness.recommendation, "NO_AUTOMATIC_MODEL_CHANGE");
  assert.ok(second.evidenceToPersist?.concentration);
});


test("enters ACTION_REQUIRED when the S6P prerequisite reports a critical integrity issue", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const brokenS6p = {
    ...certifiedS6pReport(),
    state: "ACTION_REQUIRED",
    issues: [{ code: "BROKEN_S6P", severity: "CRITICAL", message: "fixture" }],
  } as S6pReport;
  const result = evaluate(records, report, certificates, {}, undefined, brokenS6p);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6P_INTEGRITY_GATE_FAILED"), true);
});

test("treats independent-certification regression after baseline creation as critical", () => {
  const records = recordsFor(50);
  const mature = buildS6m(records, terminalIds(10));
  const first = evaluate(records, mature.report, mature.certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  const regressed = buildS6m(records, terminalIds(9));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    regressed.report,
    mature.certificates,
    certifiedS6pReport(),
    terminalIds(9),
    { baseline: first.baselineToPersist, evidence: null },
    { generatedAt: "2026-08-01T21:03:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "INDEPENDENT_CERTIFICATION_REGRESSION"), true);
});


test("treats disappearance of previously certified evidence as an integrity failure", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const certified = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !certified.evidenceToPersist) throw new Error("fixture artifacts missing");
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(10),
    { baseline: first.baselineToPersist, evidence: null, baselinePresent: true, evidencePresent: false },
    {
      generatedAt: "2026-08-01T21:04:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousOwnedLedgerRecords: records.length,
      currentOwnedLedgerRecords: records.length,
      previousBaselinePresent: true,
      previousEvidencePresent: true,
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_DISAPPEARED_AFTER_CERTIFICATION"), true);
  assert.equal(result.evidenceToPersist, null);
});

test("uses the uncapped owned-ledger count for monotonicity", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(10),
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T21:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousOwnedLedgerRecords: 12_000,
      currentOwnedLedgerRecords: 11_000,
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.persistence.currentOwnedLedgerRecords, 11_000);
  assert.equal(result.report.sample.ownedLedgerRecords, 11_000);
  assert.equal(result.report.issues.some((entry) => entry.code === "PERSISTENCE_COUNT_REGRESSION"), true);
});


test("turns a malformed milestone-50 certificate into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(certificates);
  malformed["50"] = {} as any;
  const result = evaluate(records, report, malformed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.target.certificatePresent, true);
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_SHAPE_INVALID"), true);
});

test("persists the exact independent certifications that unlocked human review", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  const certification = second.evidenceToPersist?.independentCertification;
  assert.ok(certification);
  assert.equal(certification?.required, 10);
  assert.equal(certification?.certifiedAtReview, 50);
  assert.deepEqual(certification?.terminalPredictionIds, terminalIds(50));
});

test("rejects certification evidence that no longer substantiates the review gate", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !second.evidenceToPersist) throw new Error("fixture review evidence missing");
  const tampered = structuredClone(second.evidenceToPersist);
  tampered.independentCertification.terminalPredictionIds = tampered.independentCertification.terminalPredictionIds.slice(0, 9);
  tampered.independentCertification.certifiedAtReview = 9;
  const certificationCore = {
    required: tampered.independentCertification.required,
    certifiedAtReview: tampered.independentCertification.certifiedAtReview,
    terminalPredictionIds: tampered.independentCertification.terminalPredictionIds,
  };
  tampered.independentCertification.digestSha256 = digest(certificationCore);
  const { evidenceDigestSha256: _ignored, ...evidenceCore } = tampered;
  tampered.evidenceDigestSha256 = digest(evidenceCore);
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "INDEPENDENT_CERTIFICATION_EVIDENCE_INVALID"), true);
});


test("rejects a syntactically valid but malformed previous S6Q report", () => {
  const artifact = buildMlbS6qPreviousReportArtifact({ value: {}, error: null, present: true });
  assert.equal(artifact.value, null);
  assert.equal(artifact.present, true);
  assert.match(artifact.error ?? "", /incomplete or incompatible/);
});

test("converts a malformed previous report into ACTION_REQUIRED", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(10),
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T21:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      currentOwnedLedgerRecords: records.length,
      previousReportReadError: "latest.json fixture is malformed",
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "PREVIOUS_REPORT_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});


test("turns a malformed S6M upstream report into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    {} as S6mMilestoneReport,
    certificates,
    certifiedS6pReport(),
    terminalIds(10),
    { baseline: null, evidence: null },
    { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_REPORT_SHAPE_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
});

test("turns a malformed S6P upstream report into ACTION_REQUIRED without throwing", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    {} as S6pReport,
    terminalIds(10),
    { baseline: null, evidence: null },
    { generatedAt: "2026-08-01T21:02:00.000Z", deploymentCommit: "fixture", environment: "test", minimumStabilityMs: 60_000 },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6P_REPORT_SHAPE_INVALID"), true);
  assert.equal(result.baselineToPersist, null);
});

test("rejects a self-consistent milestone certificate with missing named checks", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const changed = structuredClone(certificates);
  if (!changed["50"]) throw new Error("fixture milestone-50 certificate missing");
  changed["50"].checks = {} as any;
  const { certificateDigestSha256: _ignored, ...core } = changed["50"];
  changed["50"].certificateDigestSha256 = digest(core);
  const result = evaluate(records, report, changed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_SHAPE_INVALID" || entry.code === "CERTIFICATE_CHECK_FLAGS_INVALID"), true);
});


test("rejects malformed S6M issue entries before filtering", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(report) as any;
  malformed.issues = [null];
  const result = evaluate(records, malformed, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_REPORT_SHAPE_INVALID"), true);
});

test("rejects malformed S6M milestone rows before searching them", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(report) as any;
  malformed.milestones = [null];
  const result = evaluate(records, malformed, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_REPORT_SHAPE_INVALID"), true);
});

test("rejects malformed S6P issue entries before filtering", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const malformed = structuredClone(certifiedS6pReport()) as any;
  malformed.issues = [null];
  const result = evaluate(records, report, certificates, {}, undefined, malformed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6P_REPORT_SHAPE_INVALID"), true);
});

test("rejects self-consistent evidence with missing named checks", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !second.evidenceToPersist) throw new Error("fixture artifacts missing");
  const tampered = structuredClone(second.evidenceToPersist) as any;
  tampered.checks = {};
  const { evidenceDigestSha256: _ignored, ...core } = tampered;
  tampered.evidenceDigestSha256 = digest(core);
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_SHAPE_INVALID" || entry.code === "EVIDENCE_CHECK_FLAGS_INVALID"), true);
});

test("rejects a milestone certificate when any required named check is false", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const changed = structuredClone(certificates);
  if (!changed["50"]) throw new Error("fixture milestone-50 certificate missing");
  (changed["50"].checks as any).allSettled = false;
  const { certificateDigestSha256: _ignored, ...core } = changed["50"];
  changed["50"].certificateDigestSha256 = digest(core);
  const result = evaluate(records, report, changed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_SHAPE_INVALID" || entry.code === "CERTIFICATE_CHECK_FLAGS_INVALID"), true);
});


test("preserves irreversible artifact anchors across repeated disappearance runs", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  assert.ok(first.baselineToPersist);
  assert.equal(first.report.stability.baselineEverObserved, true);
  const disappearedOnce = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: null, evidence: null, baselinePresent: false, evidencePresent: false },
    {
      generatedAt: "2026-08-01T21:03:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousBaselineEverObserved: first.report.stability.baselineEverObserved,
      previousBaselineFirstObservedAtAnchor: first.report.stability.baselineFirstObservedAtAnchor,
      previousBaselineDigestAnchorSha256: first.report.stability.baselineDigestAnchorSha256,
    },
  );
  assert.equal(disappearedOnce.report.state, "ACTION_REQUIRED");
  assert.equal(disappearedOnce.report.stability.baselineEverObserved, true);
  const disappearedTwice = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: null, evidence: null, baselinePresent: false, evidencePresent: false },
    {
      generatedAt: "2026-08-01T21:04:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousBaselineEverObserved: disappearedOnce.report.stability.baselineEverObserved,
      previousBaselineFirstObservedAtAnchor: disappearedOnce.report.stability.baselineFirstObservedAtAnchor,
      previousBaselineDigestAnchorSha256: disappearedOnce.report.stability.baselineDigestAnchorSha256,
    },
  );
  assert.equal(disappearedTwice.report.state, "ACTION_REQUIRED");
  assert.equal(disappearedTwice.report.issues.some((entry) => entry.code === "BASELINE_DISAPPEARED_AFTER_OBSERVATION"), true);
  assert.equal(disappearedTwice.baselineToPersist, null);
});

test("rejects a baseline timestamp rewrite even with a recomputed digest", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  if (!first.baselineToPersist) throw new Error("fixture baseline missing");
  const tampered = structuredClone(first.baselineToPersist);
  tampered.firstObservedAt = "2020-01-01T00:00:00.000Z";
  const { baselineDigestSha256: _ignored, ...core } = tampered;
  tampered.baselineDigestSha256 = digest(core);
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    terminalIds(50),
    { baseline: tampered, evidence: null },
    {
      generatedAt: "2026-08-01T21:03:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousBaselineEverObserved: true,
      previousBaselineFirstObservedAtAnchor: first.report.stability.baselineFirstObservedAtAnchor,
      previousBaselineDigestAnchorSha256: first.report.stability.baselineDigestAnchorSha256,
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_FIRST_OBSERVATION_CHANGED"), true);
  assert.equal(result.evidenceToPersist, null);
});

test("validates the S6K report before traversing its evidence", () => {
  for (const malformed of [{ evidence: {} }, { evidence: [null] }]) {
    const parsed = buildMlbS6qCertifiedTerminalPredictionIdsFromS6k(malformed);
    assert.deepEqual(parsed.terminalPredictionIds, []);
    assert.match(parsed.error ?? "", /incomplete or incompatible/);
  }
  const valid = buildMlbS6qCertifiedTerminalPredictionIdsFromS6k({
    evidence: [
      { state: "CERTIFIED", target: { terminalPredictionId: "final-1" } },
      { state: "WAITING_FOR_FINAL", target: { terminalPredictionId: "final-2" } },
    ],
  });
  assert.deepEqual(valid, { terminalPredictionIds: ["final-1"], error: null });
});

test("converts malformed S6K evidence into ACTION_REQUIRED", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const result = evaluateMlbS6qFiftySettlementHumanReview(
    records,
    report,
    certificates,
    certifiedS6pReport(),
    [],
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T21:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      s6kReportReadError: "fixture malformed S6K evidence",
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6K_REPORT_SHAPE_INVALID"), true);
});

test("reconstructs every derived evidence section independently", () => {
  const records = recordsFor(50);
  const { report, certificates } = buildS6m(records, terminalIds(10));
  const first = evaluate(records, report, certificates, {}, "2026-08-01T21:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T21:03:00.000Z", certifiedS6pReport(), records.length);
  if (!first.baselineToPersist || !second.evidenceToPersist) throw new Error("fixture evidence missing");
  const tampered = structuredClone(second.evidenceToPersist);
  tampered.calibrationBuckets[0].sampleSize += 1;
  const { evidenceDigestSha256: _ignored, ...core } = tampered;
  tampered.evidenceDigestSha256 = digest(core);
  const result = evaluate(records, report, certificates, { baseline: first.baselineToPersist, evidence: tampered }, "2026-08-01T21:04:00.000Z");
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_DERIVED_SECTIONS_MISMATCH"), true);
});
