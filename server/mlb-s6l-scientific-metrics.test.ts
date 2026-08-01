import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";
import { buildMlbS6lScientificMetrics } from "./mlb-s6l-scientific-metrics";

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
  const gamePk = options.gamePk ?? 900000 + index;
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
        marketImplied: Math.abs(odds) / (Math.abs(odds) + 100),
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
      payloadSha256: "a".repeat(64),
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
  const provisional = record(index, {
    ...options,
    id: rootId,
    stage: "PROVISIONAL",
    result: null,
    probability: (options.probability ?? 0.6) - 0.02,
    odds: -105,
    recordedOffset: index * 2,
  });
  const final = record(index, {
    ...options,
    id: `final-${index}`,
    supersedesId: rootId,
    stage: "FINAL",
    recordedOffset: index * 2 + 1,
  });
  return [provisional, final];
}

test("computes deterministic Brier, log loss, calibration, CLV and flat-stake ROI", () => {
  const records = Array.from({ length: 20 }, (_, index) => pairedDecision(index)).flat();
  const report = buildMlbS6lScientificMetrics(records, {
    certifiedTerminalPredictionIds: Array.from({ length: 10 }, (_, index) => `final-${index}`),
    generatedAt: "2026-08-01T18:00:00.000Z",
  });
  assert.equal(report.state, "COLLECTING");
  assert.equal(report.sample.binaryScoredDecisions, 20);
  assert.equal(report.sample.independentlyCertifiedDecisions, 10);
  assert.equal(report.overall.wins, 10);
  assert.equal(report.overall.losses, 10);
  assert.equal(report.overall.brierScore, 0.26);
  assert.ok(Math.abs((report.overall.logLoss ?? 0) - 0.713558) < 0.000001);
  assert.equal(report.overall.meanClvPp, 1.2);
  assert.equal(report.overall.clvCoveragePct, 100);
  assert.ok(Math.abs((report.overall.flatStakeRoiPct ?? 0) - (-4.5455)) < 0.0001);
  assert.equal(report.calibration.length, 1);
  assert.equal(report.calibration[0].observations, 20);
  assert.equal(report.provisionalToFinal.pairedCycles, 20);
  assert.equal(report.provisionalToFinal.meanSignedModelProbabilityDeltaPp, 2);
  assert.equal(report.readiness.enoughForFirstRead, true);
  assert.equal(report.readiness.automaticModelChangesAllowed, false);
});

test("reaches READY_FOR_REVIEW only with the preferred sample and ten certified decisions", () => {
  const records = Array.from({ length: 50 }, (_, index) => pairedDecision(index)).flat();
  const report = buildMlbS6lScientificMetrics(records, {
    certifiedTerminalPredictionIds: Array.from({ length: 10 }, (_, index) => `final-${index}`),
  });
  assert.equal(report.state, "READY_FOR_REVIEW");
  assert.equal(report.readiness.preferredSampleReached, true);
  assert.equal(report.readiness.tenCertifiedCyclesReached, true);
  assert.equal(report.readiness.conclusionsAllowed, true);
  assert.equal(report.readiness.recommendation, "NO_AUTOMATIC_MODEL_CHANGE");
});

test("excludes analytical duplicates and invalid prices without contaminating metrics", () => {
  const records = [
    ...pairedDecision(0),
    record(100, {
      id: "duplicate-root",
      gamePk: 900000,
      selection: "OVER 4.5",
      line: 4.5,
      result: "WIN",
      recordedOffset: 100,
    }),
    ...pairedDecision(1, { odds: -4 }),
  ];
  const report = buildMlbS6lScientificMetrics(records);
  assert.equal(report.sample.binaryScoredDecisions, 1);
  assert.equal(report.sample.duplicatesExcluded, 1);
  assert.equal(report.sample.exclusionCounts.ANALYTICAL_DUPLICATE, 1);
  assert.equal(report.sample.exclusionCounts.INVALID_AMERICAN_ODDS, 1);
  assert.equal(report.overall.brierScore, 0.16);
});

test("flags ledger-count regression as ACTION_REQUIRED", () => {
  const records = Array.from({ length: 3 }, (_, index) => pairedDecision(index)).flat();
  const report = buildMlbS6lScientificMetrics(records, { previousOwnedLedgerRecords: 100 });
  assert.equal(report.state, "ACTION_REQUIRED");
  assert.equal(report.persistence.countMonotonic, false);
  assert.equal(report.issues.some((entry) => entry.code === "PERSISTENCE_COUNT_REGRESSION"), true);
});
