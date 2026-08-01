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
  type S6nBaseline,
  type S6nEvidence,
} from "./mlb-s6n-first-real-settlement-monitor";

const cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

function record(index: number, options: {
  id?: string;
  supersedesId?: string | null;
  stage?: "PROVISIONAL" | "FINAL";
  gamePk?: number;
  odds?: number;
  probability?: number;
  result?: "WIN" | "LOSS" | null;
  recordedOffset?: number;
} = {}): LedgerRecord {
  const id = options.id ?? `prediction-${index}`;
  const gamePk = options.gamePk ?? 990000 + index;
  const recordedAtMs = cutoffMs + 60_000 + (options.recordedOffset ?? index) * 1_000;
  const odds = options.odds ?? -110;
  const probability = options.probability ?? 0.6;
  const result = options.result === undefined ? (index % 2 === 0 ? "WIN" : "LOSS") : options.result;
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
        type: "F5_TOTAL",
        selection: "OVER 4.5",
        line: 4.5,
        oddsAmerican: odds,
        book: "betmgm, draftkings, fanduel",
      },
      probabilities: {
        model: probability,
        marketImplied: Math.abs(odds) / (Math.abs(odds) + 100),
        noVig: null,
        edgePp: 1,
      },
      decision: {
        signal: "BET",
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
      closingOddsAmerican: -108,
      closingLine: 4.5,
      clvPp: 1.2,
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
      probability: 0.58,
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

function evaluate(
  records: LedgerRecord[],
  report: S6mMilestoneReport | null,
  certificates: S6mCertificateMap,
  stored: { baseline?: S6nBaseline | null; evidence?: S6nEvidence | null; baselineReadError?: string | null; evidenceReadError?: string | null } = {},
  generatedAt = "2026-08-01T20:02:00.000Z",
  previousOwnedLedgerRecords: number | null = null,
) {
  return evaluateMlbS6nFirstRealSettlement(
    records,
    report,
    certificates,
    ["final-0"],
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

test("remains armed while the first eligible settlement is pending", () => {
  const records = pairedDecision(0, null);
  const { report, certificates } = buildS6m(records);
  const result = evaluate(records, report, certificates);
  assert.equal(result.report.state, "ARMED_AND_WAITING");
  assert.equal(result.report.sample.binaryEligibleDecisions, 0);
  assert.equal(result.report.readiness.armed, true);
  assert.equal(result.baselineToPersist, null);
  assert.equal(result.evidenceToPersist, null);
});

test("records an append-only baseline after the first valid milestone 1 certificate", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const result = evaluate(records, report, certificates);
  assert.equal(result.report.state, "OBSERVING_CERTIFICATE_STABILITY");
  assert.equal(result.report.checks.certificateIntegrity, true);
  assert.equal(result.report.checks.currentLedgerManifestMatches, true);
  assert.equal(result.report.checks.settlementIdentityMatches, true);
  assert.ok(result.baselineToPersist);
  assert.equal(result.evidenceToPersist, null);
  assert.equal(result.baselineToPersist?.terminalPredictionId, "final-0");
});

test("certifies the first real settlement only after a second stable observation", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const first = evaluate(records, report, certificates, {}, "2026-08-01T20:02:00.000Z");
  assert.ok(first.baselineToPersist);
  const second = evaluate(
    records,
    report,
    certificates,
    { baseline: first.baselineToPersist },
    "2026-08-01T20:03:00.000Z",
    records.length,
  );
  assert.equal(second.report.state, "FIRST_REAL_SETTLEMENT_CERTIFIED");
  assert.equal(second.report.readiness.firstRealSettlementCertified, true);
  assert.equal(second.report.readiness.conclusionsAllowed, false);
  assert.equal(second.report.readiness.automaticModelChangesAllowed, false);
  assert.ok(second.evidenceToPersist);
  assert.equal(second.evidenceToPersist?.checks.certificateStableAcrossRuns, true);
});

test("requires action when the certificate changes after the baseline", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const first = evaluate(records, report, certificates);
  const changed = structuredClone(certificates);
  if (!changed["1"]) throw new Error("fixture certificate missing");
  changed["1"].certificateDigestSha256 = "0".repeat(64);
  const second = evaluate(records, report, changed, { baseline: first.baselineToPersist });
  assert.equal(second.report.state, "ACTION_REQUIRED");
  assert.equal(second.report.issues.some((entry) => entry.code === "CERTIFICATE_DIGEST_MISMATCH"), true);
  assert.equal(second.report.issues.some((entry) => entry.code === "CERTIFICATE_CHANGED_AFTER_FIRST_OBSERVATION"), true);
});

test("detects divergence between the immutable manifest and current ledger", () => {
  const originalRecords = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(originalRecords, ["final-0"]);
  const differentRecords = pairedDecision(10, "LOSS");
  const result = evaluateMlbS6nFirstRealSettlement(
    differentRecords,
    report,
    certificates,
    [],
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T20:02:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
    },
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CURRENT_LEDGER_MANIFEST_MISMATCH"), true);
  assert.equal(result.report.issues.some((entry) => entry.code === "TERMINAL_RECORD_MISSING"), true);
});

test("blocks certification whenever S6M has a critical integrity issue", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const compromised: S6mMilestoneReport = {
    ...report,
    state: "ACTION_REQUIRED",
    issues: [...report.issues, { code: "TEST_CRITICAL", severity: "CRITICAL", message: "fixture" }],
  };
  const result = evaluate(records, compromised, certificates);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.readiness.firstRealSettlementCertified, false);
  assert.equal(result.report.issues.some((entry) => entry.code === "S6M_INTEGRITY_GATE_FAILED"), true);
});

test("surfaces unreadable append-only artifacts and ledger regressions", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const result = evaluate(
    records,
    report,
    certificates,
    { baselineReadError: "invalid baseline JSON", evidenceReadError: "invalid evidence JSON" },
    "2026-08-01T20:02:00.000Z",
    records.length + 1,
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.persistence.countMonotonic, false);
  assert.equal(result.report.issues.some((entry) => entry.code === "BASELINE_UNREADABLE"), true);
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_UNREADABLE"), true);
  assert.equal(result.report.issues.some((entry) => entry.code === "PERSISTENCE_COUNT_REGRESSION"), true);
});

test("detects tampering after S6N evidence has been certified", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const first = evaluate(records, report, certificates, {}, "2026-08-01T20:02:00.000Z");
  const second = evaluate(
    records,
    report,
    certificates,
    { baseline: first.baselineToPersist },
    "2026-08-01T20:03:00.000Z",
  );
  const tampered = structuredClone(second.evidenceToPersist);
  if (!tampered) throw new Error("fixture evidence missing");
  tampered.metrics.brierScore = 0.999;
  const third = evaluate(
    records,
    report,
    certificates,
    { baseline: first.baselineToPersist, evidence: tampered },
    "2026-08-01T20:04:00.000Z",
  );
  assert.equal(third.report.state, "ACTION_REQUIRED");
  assert.equal(third.report.issues.some((entry) => entry.code === "EVIDENCE_DIGEST_INVALID"), true);
});


function recomputeDigest<T extends Record<string, any>>(value: T, digestKey: string): string {
  const core = Object.fromEntries(Object.entries(value).filter(([key]) => key !== digestKey));
  return crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
}

test("rejects false certificate checks even when the certificate digest is recomputed", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const changed = structuredClone(certificates);
  if (!changed["1"]) throw new Error("fixture certificate missing");
  (changed["1"].checks as any).allSettled = false;
  changed["1"].certificateDigestSha256 = recomputeDigest(changed["1"] as any, "certificateDigestSha256");
  const result = evaluate(records, report, changed);
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "CERTIFICATE_CHECK_FLAGS_INVALID"), true);
});

test("rejects evidence with a broken baseline link even when its digest is recomputed", () => {
  const records = pairedDecision(0, "WIN");
  const { report, certificates } = buildS6m(records, ["final-0"]);
  const first = evaluate(records, report, certificates, {}, "2026-08-01T20:02:00.000Z");
  const second = evaluate(records, report, certificates, { baseline: first.baselineToPersist }, "2026-08-01T20:03:00.000Z");
  const changed = structuredClone(second.evidenceToPersist);
  if (!changed) throw new Error("fixture evidence missing");
  changed.baselineDigestSha256 = "f".repeat(64);
  changed.evidenceDigestSha256 = recomputeDigest(changed as any, "evidenceDigestSha256");
  const result = evaluate(
    records,
    report,
    certificates,
    { baseline: first.baselineToPersist, evidence: changed },
    "2026-08-01T20:04:00.000Z",
  );
  assert.equal(result.report.state, "ACTION_REQUIRED");
  assert.equal(result.report.issues.some((entry) => entry.code === "EVIDENCE_BASELINE_LINK_INVALID"), true);
});


test("accepts later independent-certification maturity without changing the immutable pick", () => {
  const records = pairedDecision(0, "WIN");
  const initial = buildS6m(records, []);
  const certificate = initial.certificates["1"];
  if (!certificate) throw new Error("fixture certificate missing");
  assert.equal(certificate.manifest[0].independentlyCertified, false);

  const matureS6l = buildMlbS6lScientificMetrics(records, {
    certifiedTerminalPredictionIds: ["final-0"],
    generatedAt: "2026-08-01T20:04:00.000Z",
  });
  const matureS6m = evaluateMlbS6mMilestones(
    records,
    matureS6l,
    ["final-0"],
    { "1": certificate },
    { generatedAt: "2026-08-01T20:05:00.000Z", deploymentCommit: "fixture", environment: "test" },
  );
  assert.equal(matureS6m.report.state, "MILESTONE_1_CERTIFIED");

  const result = evaluateMlbS6nFirstRealSettlement(
    records,
    matureS6m.report,
    { "1": certificate },
    ["final-0"],
    { baseline: null, evidence: null },
    {
      generatedAt: "2026-08-01T20:06:00.000Z",
      deploymentCommit: "fixture",
      environment: "test",
      minimumStabilityMs: 60_000,
    },
  );
  assert.equal(result.report.state, "OBSERVING_CERTIFICATE_STABILITY");
  assert.equal(result.report.checks.currentLedgerManifestMatches, true);
  assert.equal(result.report.issues.some((entry) => entry.code === "CURRENT_LEDGER_MANIFEST_MISMATCH"), false);
});
