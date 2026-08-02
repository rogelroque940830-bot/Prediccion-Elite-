import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";
import { buildMlbS6lScientificMetrics } from "./mlb-s6l-scientific-metrics";
import {
  buildMlbS6mMilestoneCertificate,
  computeMlbS6mIndependentMetrics,
  evaluateMlbS6mMilestones,
  extractMlbS6mIndependentSample,
  type S6mCertificateMap,
} from "./mlb-s6m-statistical-milestones";

const cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

function record(index: number, options: {
  id?: string;
  supersedesId?: string | null;
  stage?: "PROVISIONAL" | "FINAL";
  gamePk?: number;
  marketType?: string;
  selection?: string;
  line?: number | null;
  odds?: number;
  probability?: number;
  result?: "WIN" | "LOSS" | "PUSH" | "VOID" | null;
  clvPp?: number | null;
  signal?: string;
  recordedOffset?: number;
} = {}): LedgerRecord {
  const id = options.id ?? `prediction-${index}`;
  const gamePk = options.gamePk ?? 950000 + index;
  const recordedAtMs = cutoffMs + 60_000 + (options.recordedOffset ?? index) * 1_000;
  const line = options.line === undefined ? 4.5 : options.line;
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
        type: options.marketType ?? "F5_TOTAL",
        selection: options.selection ?? `OVER ${line}`,
        ...(line != null ? { line } : {}),
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
        signal: options.signal ?? "BET",
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
      payloadSha256: String(index).padStart(64, "a").slice(-64),
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
      outcomeValue: result === "WIN" ? 6 : result === "LOSS" ? 2 : 4.5,
      finalScore: { home: 4, away: 2 },
      profitUnits: 0,
      closingOddsAmerican: -108,
      closingLine: line,
      clvPp: options.clvPp === undefined ? 1.2 : options.clvPp,
    } : null,
  } as LedgerRecord;
}

function pairedDecision(index: number, options: Parameters<typeof record>[1] = {}): LedgerRecord[] {
  const rootId = `root-${index}`;
  return [
    record(index, {
      ...options,
      id: rootId,
      stage: "PROVISIONAL",
      result: null,
      probability: (options.probability ?? 0.6) - 0.02,
      odds: -105,
      recordedOffset: index * 2,
    }),
    record(index, {
      ...options,
      id: `final-${index}`,
      supersedesId: rootId,
      stage: "FINAL",
      recordedOffset: index * 2 + 1,
    }),
  ];
}

function evaluate(records: LedgerRecord[], certifiedIds: string[] = [], certificates: S6mCertificateMap = {}) {
  const s6l = buildMlbS6lScientificMetrics(records, {
    certifiedTerminalPredictionIds: certifiedIds,
    generatedAt: "2026-08-01T19:00:00.000Z",
  });
  return evaluateMlbS6mMilestones(records, s6l, certifiedIds, certificates, {
    generatedAt: "2026-08-01T19:05:00.000Z",
    deploymentCommit: "fixture",
    environment: "test",
  });
}

test("independently recomputes the scientific metrics and certifies milestone 1", () => {
  const records = pairedDecision(0);
  const sample = extractMlbS6mIndependentSample(records, ["final-0"]);
  const metrics = computeMlbS6mIndependentMetrics(sample.observations);
  assert.equal(sample.binaryObservations.length, 1);
  assert.equal(metrics.brierScore, 0.16);
  assert.equal(metrics.observedWinRate, 1);

  const evaluation = evaluate(records, ["final-0"]);
  assert.equal(evaluation.report.metricParity.passed, true);
  assert.equal(evaluation.report.state, "MILESTONE_1_CERTIFIED");
  assert.equal(evaluation.report.highestCertifiedMilestone, 1);
  assert.equal(evaluation.report.nextMilestone, 5);
  assert.equal(evaluation.newCertificates.length, 1);
  assert.equal(evaluation.newCertificates[0].manifest.length, 1);
  assert.equal(evaluation.report.readiness.automaticModelChangesAllowed, false);
});

test("matches S6L calibration precision when bin rounding crosses an ECE micro-unit", () => {
  const records = [
    ...pairedDecision(0, { probability: 0.4999999, result: "WIN" }),
    ...Array.from({ length: 17 }, (_, offset) => pairedDecision(offset + 1, {
      probability: 0.3999999,
      result: "WIN",
    })).flat(),
  ];

  const sample = extractMlbS6mIndependentSample(records);
  const metrics = computeMlbS6mIndependentMetrics(sample.observations);
  const evaluation = evaluate(records);
  assert.equal(metrics.expectedCalibrationError, 0.594444);
  assert.deepEqual(evaluation.report.metricParity.mismatches, []);
  assert.equal(evaluation.report.metricParity.passed, true);
});

test("keeps an immutable pre-fix certificate valid at an exact ECE micro-unit boundary", () => {
  const records = [
    ...pairedDecision(0, { probability: 0.4999999, result: "WIN" }),
    ...Array.from({ length: 4 }, (_, offset) => pairedDecision(offset + 1, {
      probability: 0.3999999,
      result: "WIN",
    })).flat(),
  ];
  const sample = extractMlbS6mIndependentSample(records);
  const certificate = buildMlbS6mMilestoneCertificate(sample.binaryObservations, 5, {
    createdAt: "2026-08-01T19:05:00.000Z",
    sourceS6lGeneratedAt: "2026-08-01T19:00:00.000Z",
  });
  certificate.metrics.expectedCalibrationError =
    (certificate.metrics.expectedCalibrationError as number) + 0.000001;
  const { certificateDigestSha256: _oldDigest, ...core } = certificate;
  certificate.certificateDigestSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(core))
    .digest("hex");

  const evaluation = evaluate(records, [], { "5": certificate });
  assert.equal(evaluation.report.milestones.find((entry) => entry.milestone === 5)?.status, "CERTIFIED");
  assert.equal(evaluation.report.issues.some((entry) => entry.code === "MILESTONE_5_CERTIFICATE_INVALID"), false);
});

test("does not let a late-settled earlier decision displace a sealed milestone cohort", () => {
  const originallyEligible = Array.from({ length: 5 }, (_, index) => pairedDecision(index + 1)).flat();
  const originalSample = extractMlbS6mIndependentSample(originallyEligible);
  const certificate = buildMlbS6mMilestoneCertificate(originalSample.binaryObservations, 5, {
    createdAt: "2026-08-01T19:05:00.000Z",
    sourceS6lGeneratedAt: "2026-08-01T19:00:00.000Z",
  });
  const lateSettledEarlier = pairedDecision(0);

  const evaluation = evaluate([...lateSettledEarlier, ...originallyEligible], [], { "5": certificate });
  assert.equal(evaluation.report.milestones.find((entry) => entry.milestone === 5)?.status, "CERTIFIED");
  assert.equal(evaluation.report.issues.some((entry) => entry.code === "MILESTONE_5_CERTIFICATE_INVALID"), false);
});

test("creates immutable milestone 1 and 5 certificates from deterministic first-N decisions", () => {
  const records = Array.from({ length: 5 }, (_, index) => pairedDecision(index)).flat();
  const evaluation = evaluate(records, ["final-0", "final-1"]);
  assert.equal(evaluation.report.state, "MILESTONE_5_CERTIFIED");
  assert.deepEqual(evaluation.newCertificates.map((entry) => entry.milestone), [1, 5]);
  const milestone5 = evaluation.newCertificates.find((entry) => entry.milestone === 5);
  assert.equal(milestone5?.manifest.length, 5);
  assert.deepEqual(milestone5?.manifest.map((entry) => entry.terminalPredictionId), [
    "final-0",
    "final-1",
    "final-2",
    "final-3",
    "final-4",
  ]);
});

test("detects a tampered milestone certificate and requires action", () => {
  const records = Array.from({ length: 5 }, (_, index) => pairedDecision(index)).flat();
  const sample = extractMlbS6mIndependentSample(records);
  const certificate = buildMlbS6mMilestoneCertificate(sample.binaryObservations, 5, {
    createdAt: "2026-08-01T19:05:00.000Z",
    sourceS6lGeneratedAt: "2026-08-01T19:00:00.000Z",
  });
  certificate.metrics.brierScore = 0.999;
  const evaluation = evaluate(records, [], { "5": certificate });
  assert.equal(evaluation.report.state, "ACTION_REQUIRED");
  assert.equal(evaluation.report.issues.some((entry) => entry.code === "MILESTONE_5_CERTIFICATE_INVALID"), true);
});

test("matches S6L exclusion logic for duplicates and invalid American prices", () => {
  const records = [
    ...pairedDecision(0),
    record(100, {
      id: "duplicate-root",
      gamePk: 950000,
      selection: "OVER 4.5",
      line: 4.5,
      result: "WIN",
      recordedOffset: 100,
    }),
    ...pairedDecision(1, { odds: -4 }),
  ];
  const evaluation = evaluate(records);
  assert.equal(evaluation.report.metricParity.passed, true);
  assert.equal(evaluation.report.sample.binaryScoredDecisions, 1);
  assert.equal(evaluation.report.sample.duplicatesExcluded, 1);
  assert.equal(evaluation.report.sample.exclusionCounts.INVALID_AMERICAN_ODDS, 1);
});

test("certifies milestone 50 and becomes human-review ready only with ten certified decisions", () => {
  const records = Array.from({ length: 50 }, (_, index) => pairedDecision(index)).flat();
  const certifiedIds = Array.from({ length: 10 }, (_, index) => `final-${index}`);
  const evaluation = evaluate(records, certifiedIds);
  assert.equal(evaluation.report.state, "MILESTONE_50_CERTIFIED");
  assert.equal(evaluation.report.highestCertifiedMilestone, 50);
  assert.equal(evaluation.report.nextMilestone, null);
  assert.equal(evaluation.report.readiness.preferredSampleCertified, true);
  assert.equal(evaluation.report.readiness.tenCertifiedCyclesReached, true);
  assert.equal(evaluation.report.readiness.humanReviewReady, true);
  assert.equal(evaluation.report.readiness.conclusionsAllowed, true);
  assert.equal(evaluation.report.readiness.automaticModelChangesAllowed, false);
});

test("flags ledger-count regression as ACTION_REQUIRED", () => {
  const records = pairedDecision(0);
  const s6l = buildMlbS6lScientificMetrics(records);
  const evaluation = evaluateMlbS6mMilestones(records, s6l, [], {}, {
    previousOwnedLedgerRecords: 100,
  });
  assert.equal(evaluation.report.state, "ACTION_REQUIRED");
  assert.equal(evaluation.report.persistence.countMonotonic, false);
});


test("blocks human review whenever a critical integrity issue exists", () => {
  const records = Array.from({ length: 50 }, (_, index) => pairedDecision(index)).flat();
  const certifiedIds = Array.from({ length: 10 }, (_, index) => `final-${index}`);
  const s6l = buildMlbS6lScientificMetrics(records, {
    certifiedTerminalPredictionIds: certifiedIds,
  });
  const sample = extractMlbS6mIndependentSample(records, certifiedIds);
  const certificates: S6mCertificateMap = {};
  for (const milestone of [1, 5, 20, 50] as const) {
    certificates[`${milestone}`] = buildMlbS6mMilestoneCertificate(sample.binaryObservations, milestone, {
      createdAt: "2026-08-01T19:05:00.000Z",
      sourceS6lGeneratedAt: s6l.generatedAt,
    });
  }
  const evaluation = evaluateMlbS6mMilestones(records, s6l, certifiedIds, certificates, {
    previousOwnedLedgerRecords: records.length + 1,
  });
  assert.equal(evaluation.report.state, "ACTION_REQUIRED");
  assert.equal(evaluation.report.highestCertifiedMilestone, 50);
  assert.equal(evaluation.report.readiness.humanReviewReady, false);
  assert.equal(evaluation.report.readiness.conclusionsAllowed, false);
});

test("refuses to recreate a previously certified missing milestone", () => {
  const records = pairedDecision(0);
  const s6l = buildMlbS6lScientificMetrics(records);
  const evaluation = evaluateMlbS6mMilestones(records, s6l, [], {}, {
    previouslyCertifiedMilestones: [1],
  });
  assert.equal(evaluation.report.state, "ACTION_REQUIRED");
  assert.equal(evaluation.newCertificates.length, 0);
  assert.equal(evaluation.report.issues.some((entry) => entry.code === "MILESTONE_1_CERTIFICATE_MISSING"), true);
});

test("surfaces an unreadable append-only certificate as an integrity failure", () => {
  const records = pairedDecision(0);
  const s6l = buildMlbS6lScientificMetrics(records);
  const evaluation = evaluateMlbS6mMilestones(records, s6l, [], {}, {
    certificateReadErrors: [{ milestone: 1, message: "invalid JSON" }],
  });
  assert.equal(evaluation.report.state, "ACTION_REQUIRED");
  assert.equal(evaluation.newCertificates.length, 0);
  assert.equal(evaluation.report.issues.some((entry) => entry.code === "MILESTONE_1_CERTIFICATE_UNREADABLE"), true);
});


test("keeps an immutable milestone valid when independent certification matures later", () => {
  const records = pairedDecision(0);
  const first = evaluate(records, []);
  const certificate = first.newCertificates.find((entry) => entry.milestone === 1);
  assert.ok(certificate);
  assert.equal(certificate.manifest[0].independentlyCertified, false);

  const second = evaluate(records, ["final-0"], { "1": certificate });
  assert.equal(second.report.state, "MILESTONE_1_CERTIFIED");
  assert.equal(second.report.sample.independentlyCertifiedDecisions, 1);
  assert.equal(second.report.issues.some((entry) => entry.code === "MILESTONE_1_CERTIFICATE_INVALID"), false);
  assert.equal(second.newCertificates.length, 0);
});
