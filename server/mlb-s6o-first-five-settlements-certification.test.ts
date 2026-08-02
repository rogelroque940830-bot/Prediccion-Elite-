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
import {
  evaluateMlbS6nFirstRealSettlement,
  type S6nReport,
} from "./mlb-s6n-first-real-settlement-monitor";
import {
  evaluateMlbS6oFirstFiveSettlements,
  type S6oBaseline,
  type S6oEvidence,
} from "./mlb-s6o-first-five-settlements-certification";

const cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

function record(index: number, options: {
  id?: string;
  supersedesId?: string | null;
  stage?: "PROVISIONAL" | "FINAL";
  gamePk?: number;
  marketType?: "F5_TOTAL" | "F5_MONEYLINE";
  selection?: string;
  line?: number | null;
  signal?: string;
  odds?: number;
  probability?: number;
  result?: "WIN" | "LOSS" | null;
  recordedOffset?: number;
} = {}): LedgerRecord {
  const id = options.id ?? `prediction-${index}`;
  const gamePk = options.gamePk ?? 995000 + index;
  const recordedAtMs = cutoffMs + 60_000 + (options.recordedOffset ?? index) * 1_000;
  const odds = options.odds ?? (index % 2 === 0 ? -110 : 120);
  const probability = options.probability ?? (index % 2 === 0 ? 0.6 : 0.53);
  const result = options.result === undefined ? (index % 2 === 0 ? "WIN" : "LOSS") : options.result;
  const marketType = options.marketType ?? (index % 2 === 0 ? "F5_TOTAL" : "F5_MONEYLINE");
  const line = options.line === undefined ? (marketType === "F5_TOTAL" ? 4.5 : null) : options.line;
  const selection = options.selection ?? (marketType === "F5_TOTAL" ? "OVER 4.5" : `HOME ${gamePk}`);
  return {
    prediction: {
      id,
      clientRequestId: `s5c:${id}`,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: {
        gamePk,
        gameDate: "2026-08-01",
        commenceTime: new Date(recordedAtMs + 60 * 60 * 1000).toISOString(),
        homeTeam: `Home ${gamePk}`,
        awayTeam: `Away ${gamePk}`,
      },
      market: {
        type: marketType,
        selection,
        line,
        oddsAmerican: odds,
        book: "betmgm, draftkings, fanduel",
      },
      probabilities: {
        model: probability,
        marketImplied: odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100),
        noVig: null,
        edgePp: 1,
      },
      decision: {
        signal: options.signal ?? (index % 3 === 0 ? "BET_FUERTE" : "BET"),
        confidenceLabel: "MODEL",
        confidencePct: probability * 100,
        stakeUnits: 0,
      },
      analysisStage: options.stage ?? "FINAL",
      model: {
        name: "CourtEdge MLB Early Markets",
        version: "s5c-shadow-v2-price-integrity",
        gitCommit: "fixture",
        environment: "test",
      },
      supersedesId: options.supersedesId ?? null,
      source: "app",
      payloadSha256: `${index}`.padStart(64, "a").slice(-64),
      payload: {
        market: { capturedAt: new Date(recordedAtMs - 30_000).toISOString() },
        analysis: {
          layers: {
            s5c: { schemaVersion: "mlb-s5c-shadow-ingestion.v1" },
            marketPriceIntegrity: {
              standardAmericanOddsValidated: true,
              consensusMethod: "median_implied_probability",
            },
          },
          rawInputs: {
            priceCapture: {
              capturedAt: new Date(recordedAtMs - 30_000).toISOString(),
              consensusMethod: "median_implied_probability",
            },
            marketProvenance: {
              consensusMethod: "median_implied_probability",
              contributingBooks: ["betmgm", "draftkings", "fanduel"],
            },
          },
        },
      },
    },
    settlement: result ? {
      eventId: `settlement-${id}`,
      settledAt: new Date(recordedAtMs + 2 * 60 * 60 * 1000).toISOString(),
      source: "correction",
      correctionOfEventId: `official-${id}`,
      result,
      outcomeValue: result === "WIN" ? 6 : 2,
      finalScore: { home: 4, away: 2 },
      profitUnits: 0,
      closingOddsAmerican: odds > 0 ? odds - 4 : odds + 2,
      closingLine: line,
      clvPp: index === 3 ? null : 0.5 + index * 0.2,
    } : null,
  } as LedgerRecord;
}

function pairedDecision(index: number, result: "WIN" | "LOSS" | null = index % 2 === 0 ? "WIN" : "LOSS"): LedgerRecord[] {
  const rootId = `root-${index}`;
  return [
    record(index, {
      id: rootId,
      stage: "PROVISIONAL",
      result: null,
      probability: 0.56,
      odds: -105,
      recordedOffset: index * 2,
    }),
    record(index, {
      id: `final-${index}`,
      supersedesId: rootId,
      stage: "FINAL",
      result,
      recordedOffset: index * 2 + 1,
    }),
  ];
}

function decisions(count: number): LedgerRecord[] {
  return Array.from({ length: count }, (_, index) => pairedDecision(index)).flat();
}

function buildS6m(records: LedgerRecord[], certifiedIds: string[] = []): {
  report: S6mMilestoneReport;
  certificates: S6mCertificateMap;
} {
  const s6l = buildMlbS6lScientificMetrics(records, {
    certifiedTerminalPredictionIds: certifiedIds,
    generatedAt: "2026-08-01T20:00:00.000Z",
  });
  const evaluation = evaluateMlbS6mMilestones(records, s6l, certifiedIds, {}, {
    generatedAt: "2026-08-01T20:01:00.000Z",
    deploymentCommit: "fixture",
    environment: "test",
  });
  const certificates: S6mCertificateMap = {};
  for (const certificate of evaluation.newCertificates) {
    certificates[`${certificate.milestone}`] = certificate;
  }
  return { report: evaluation.report, certificates };
}

function certifyS6n(
  records: LedgerRecord[],
  report: S6mMilestoneReport,
  certificates: S6mCertificateMap,
  certifiedIds: string[] = [],
): S6nReport {
  const first = evaluateMlbS6nFirstRealSettlement(
    records,
    report,
    certificates,
    certifiedIds,
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T20:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
    },
  );
  assert.ok(first.baselineToPersist);
  const second = evaluateMlbS6nFirstRealSettlement(
    records,
    report,
    certificates,
    certifiedIds,
    { baseline: first.baselineToPersist, evidence: null },
    {
      generatedAt: "2026-08-01T20:03:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousOwnedLedgerRecords: records.length,
    },
  );
  assert.equal(second.report.state, "FIRST_REAL_SETTLEMENT_CERTIFIED");
  return second.report;
}

function buildSources(records: LedgerRecord[], certifiedIds: string[] = []) {
  const s6m = buildS6m(records, certifiedIds);
  const s6n = certifyS6n(records, s6m.report, s6m.certificates, certifiedIds);
  return { ...s6m, s6n };
}

function evaluate(
  records: LedgerRecord[],
  report: S6mMilestoneReport,
  certificates: S6mCertificateMap,
  s6n: S6nReport | null,
  certifiedIds: string[] = [],
  stored: { baseline?: S6oBaseline | null; evidence?: S6oEvidence | null; baselineReadError?: string | null; evidenceReadError?: string | null } = {},
  generatedAt = "2026-08-01T20:04:00.000Z",
  previousOwnedLedgerRecords: number | null = null,
) {
  return evaluateMlbS6oFirstFiveSettlements(
    records,
    report,
    certificates,
    s6n,
    certifiedIds,
    {
      baseline: stored.baseline ?? null,
      evidence: stored.evidence ?? null,
      baselineReadError: stored.baselineReadError,
      evidenceReadError: stored.evidenceReadError,
    },
    {
      generatedAt,
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
      previousOwnedLedgerRecords,
    },
  );
}

function recomputeDigest<T extends Record<string, any>>(value: T, digestKey: string): string {
  const core = Object.fromEntries(Object.entries(value).filter(([key]) => key !== digestKey));
  return crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
}

test("remains armed while fewer than five eligible settlements exist", () => {
  const records = decisions(4);
  const { report, certificates, s6n } = buildSources(records, ["final-0"]);
  const result = evaluate(records, report, certificates, s6n, ["final-0"]);
  assert.equal(result.report.state, "ARMED_AND_WAITING_FOR_5");
  assert.equal(result.report.sample.binaryEligibleDecisions, 4);
  assert.equal(result.report.sourceS6n.firstRealSettlementCertified, true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});

test("records an append-only baseline after a valid milestone 5 certificate", () => {
  const records = decisions(5);
  const certifiedIds = ["final-0", "final-1"];
  const { report, certificates, s6n } = buildSources(records, certifiedIds);
  const result = evaluate(records, report, certificates, s6n, certifiedIds);
  assert.equal(result.report.state, "OBSERVING_FIVE_RESULT_STABILITY");
  assert.equal(result.report.checks.certificateIntegrity, true);
  assert.equal(result.report.checks.currentLedgerManifestMatches, true);
  assert.equal(result.report.checks.settlementIdentitiesMatch, true);
  assert.ok(result.baselineToPersist);
  assert.equal(result.baselineToPersist?.terminalPredictionIds.length, 5);
  assert.equal(result.evidenceToPersist, null);
});

test("certifies five settlements only after a second stable observation", () => {
  const records = decisions(5);
  const certifiedIds = ["final-0", "final-1"];
  const { report, certificates, s6n } = buildSources(records, certifiedIds);
  const first = evaluate(records, report, certificates, s6n, certifiedIds);
  assert.ok(first.baselineToPersist);
  const second = evaluate(
    records,
    report,
    certificates,
    s6n,
    certifiedIds,
    { baseline: first.baselineToPersist },
    "2026-08-01T20:05:00.000Z",
    records.length,
  );
  assert.equal(second.report.state, "FIRST_FIVE_SETTLEMENTS_CERTIFIED");
  assert.equal(second.report.readiness.technicalRepetitionValidated, true);
  assert.equal(second.report.readiness.sampleAdequateForModelConclusions, false);
  assert.equal(second.report.readiness.conclusionsAllowed, false);
  assert.equal(second.report.readiness.automaticModelChangesAllowed, false);
  assert.ok(second.evidenceToPersist);
  assert.equal(second.evidenceToPersist?.manifest.length, 5);
  assert.equal(second.evidenceToPersist?.marketBreakdowns.length, 2);
  assert.equal(second.evidenceToPersist?.signalBreakdowns.length, 2);
  assert.equal(
    second.evidenceToPersist?.sampleAdequacy,
    "TECHNICAL_REPETITION_CHECK_ONLY_TOO_SMALL_FOR_MODEL_CONCLUSIONS",
  );
});

test("requires S6N first-settlement certification before accepting milestone 5", () => {
  const records = decisions(5);
  const { report, certificates } = buildS6m(records);
  const result = evaluate(records, report, certificates, null);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "FIRST_SETTLEMENT_PREREQUISITE_NOT_CERTIFIED"), true);
});

test("rejects certificate tampering after the baseline", () => {
  const records = decisions(5);
  const { report, certificates, s6n } = buildSources(records);
  const first = evaluate(records, report, certificates, s6n);
  const changed = structuredClone(certificates);
  if (!changed["5"]) throw new Error("fixture certificate missing");
  changed["5"].certificateDigestSha256 = "0".repeat(64);
  const second = evaluate(records, report, changed, s6n, [], { baseline: first.baselineToPersist });
  assert.equal(second.report.state, "ACTION_REQUIRED");
  assert.equal(second.report.issues.some((entry) => entry.code === "CERTIFICATE_DIGEST_MISMATCH"), true);
  assert.equal(second.report.issues.some((entry) => entry.code === "CERTIFICATE_CHANGED_AFTER_FIRST_OBSERVATION"), true);
});

test("detects divergence between the current first-five sample and immutable manifest", () => {
  const original = decisions(5);
  const { report, certificates, s6n } = buildSources(original);
  const changed = decisions(5);
  const final = changed.find((entry) => entry.prediction.id === "final-2");
  if (!final) throw new Error("fixture terminal missing");
  final.settlement = { ...final.settlement!, eventId: "different-settlement" };
  const result = evaluate(changed, report, certificates, s6n);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CURRENT_LEDGER_MANIFEST_MISMATCH"), true);
  assert.equal(result.report.issues.some((entry) => entry.code === "SETTLEMENT_IDENTITY_MISMATCH"), true);
});

test("rejects false milestone checks even when its digest is recomputed", () => {
  const records = decisions(5);
  const { report, certificates, s6n } = buildSources(records);
  const changed = structuredClone(certificates);
  if (!changed["5"]) throw new Error("fixture certificate missing");
  (changed["5"].checks as any).allSettled = false;
  changed["5"].certificateDigestSha256 = recomputeDigest(changed["5"] as any, "certificateDigestSha256");
  const result = evaluate(records, report, changed, s6n);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_CHECK_FLAGS_INVALID"), true);
});

test("rejects evidence with a broken baseline link even after digest recomputation", () => {
  const records = decisions(5);
  const { report, certificates, s6n } = buildSources(records);
  const first = evaluate(records, report, certificates, s6n);
  const second = evaluate(
    records,
    report,
    certificates,
    s6n,
    [],
    { baseline: first.baselineToPersist },
    "2026-08-01T20:05:00.000Z",
  );
  const changed = structuredClone(second.evidenceToPersist);
  if (!changed) throw new Error("fixture evidence missing");
  changed.baselineDigestSha256 = "f".repeat(64);
  changed.evidenceDigestSha256 = recomputeDigest(changed as any, "evidenceDigestSha256");
  const result = evaluate(
    records,
    report,
    certificates,
    s6n,
    [],
    { baseline: first.baselineToPersist, evidence: changed },
    "2026-08-01T20:06:00.000Z",
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_BASELINE_LINK_INVALID"), true);
});

test("accepts later independent-certification maturity without changing immutable pick identity", () => {
  const records = decisions(5);
  const initial = buildSources(records, ["final-0"]);
  const certificate = initial.certificates["5"];
  if (!certificate) throw new Error("fixture certificate missing");
  const matureIds = ["final-0", "final-1", "final-2", "final-3", "final-4"];
  const matureS6l = buildMlbS6lScientificMetrics(records, {
    certifiedTerminalPredictionIds: matureIds,
    generatedAt: "2026-08-01T20:10:00.000Z",
  });
  const matureS6m = evaluateMlbS6mMilestones(
    records,
    matureS6l,
    matureIds,
    initial.certificates,
    {
      generatedAt: "2026-08-01T20:11:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
    },
  );
  assert.equal(matureS6m.report.state, "MILESTONE_5_CERTIFIED");
  const result = evaluateMlbS6oFirstFiveSettlements(
    records,
    matureS6m.report,
    initial.certificates,
    initial.s6n,
    matureIds,
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T20:12:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
    },
  );
  assert.equal(result.report.state, "OBSERVING_FIVE_RESULT_STABILITY");
  assert.equal(result.report.checks.currentLedgerManifestMatches, true);
  assert.equal(result.report.sample.independentlyCertifiedAmongFirstFive, 5);
});

test("accepts an explicitly linked settlement correction without rewriting the sealed manifest", () => {
  const originalRecords = decisions(5);
  const initial = buildSources(originalRecords, ["final-0"]);
  const certificate = initial.certificates["5"];
  if (!certificate) throw new Error("fixture certificate missing");

  const correctedRecords = structuredClone(originalRecords);
  const corrected = correctedRecords.find((entry) => entry.prediction.id === "final-2");
  if (!corrected?.settlement) throw new Error("fixture settlement missing");
  const sealedEventId = corrected.settlement.eventId;
  corrected.settlement.eventId = "correction-final-2-v2";
  corrected.settlement.source = "correction";
  corrected.settlement.correctionOfEventId = sealedEventId;

  const currentS6l = buildMlbS6lScientificMetrics(correctedRecords, {
    certifiedTerminalPredictionIds: ["final-0"],
    generatedAt: "2026-08-01T20:20:00.000Z",
  });
  const currentS6m = evaluateMlbS6mMilestones(
    correctedRecords,
    currentS6l,
    ["final-0"],
    initial.certificates,
    {
      generatedAt: "2026-08-01T20:21:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
    },
  );
  assert.equal(currentS6m.report.state, "MILESTONE_5_CERTIFIED");

  const result = evaluateMlbS6oFirstFiveSettlements(
    correctedRecords,
    currentS6m.report,
    initial.certificates,
    initial.s6n,
    ["final-0"],
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T20:22:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
    },
  );
  assert.equal(result.report.state, "OBSERVING_FIVE_RESULT_STABILITY");
  assert.equal(result.report.checks.currentLedgerManifestMatches, true);
  assert.equal(result.report.checks.settlementIdentitiesMatch, true);
  assert.equal(certificate.manifest[2]?.settlementEventId, sealedEventId);
});

test("blocks certification when S6M has a critical integrity issue", () => {
  const records = decisions(5);
  const { report, certificates, s6n } = buildSources(records);
  const changed = structuredClone(report);
  changed.state = "ACTION_REQUIRED";
  changed.issues.push({ code: "FIXTURE_CRITICAL", severity: "CRITICAL", message: "fixture" });
  const result = evaluate(records, changed, certificates, s6n);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_INTEGRITY_GATE_FAILED"), true);
});
