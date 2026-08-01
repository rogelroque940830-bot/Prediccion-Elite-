import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import {
  buildMlbS6iPostfixCertification,
  MLB_S6I_CLEAN_COHORT_CUTOFF,
  MLB_S6I_POSTFIX_CERTIFICATION_VERSION,
} from "./mlb-s6i-postfix-certification";

const cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

function americanImplied(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function record(options: {
  id: string;
  recordedAtMs?: number;
  gamePk?: number;
  commenceTime?: string;
  marketType?: "F5_ML" | "F5_TOTAL";
  selection?: string;
  line?: number | null;
  odds?: number;
  modelProbability?: number;
  stage?: "PROVISIONAL" | "FINAL";
  supersedesId?: string | null;
  fingerprint?: string;
  consensusMethod?: string | null;
  books?: string[];
  capture?: string | null;
  validated?: boolean;
  settlement?: LedgerRecord["settlement"];
}): LedgerRecord {
  const recordedAtMs = options.recordedAtMs ?? cutoffMs + 60_000;
  const odds = options.odds ?? -110;
  const model = options.modelProbability ?? 0.61;
  const implied = americanImplied(odds);
  const marketType = options.marketType ?? "F5_ML";
  const line = options.line === undefined ? (marketType === "F5_TOTAL" ? 4.5 : null) : options.line;
  const selection = options.selection ?? (marketType === "F5_TOTAL" ? "OVER 4.5" : "Detroit Tigers");
  const capture = options.capture === undefined ? new Date(recordedAtMs - 30_000).toISOString() : options.capture;
  const consensusMethod = options.consensusMethod === undefined ? "median_implied_probability" : options.consensusMethod;
  const books = options.books ?? ["fanduel", "draftkings"];
  const validated = options.validated ?? true;
  return {
    prediction: {
      id: options.id,
      clientRequestId: `s5c:${options.id}`,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: {
        gamePk: options.gamePk ?? 123,
        gameDate: "2026-08-01",
        commenceTime: options.commenceTime ?? "2026-08-01T23:10:00.000Z",
        homeTeam: "Detroit Tigers",
        awayTeam: "Baltimore Orioles",
      },
      market: {
        type: marketType,
        selection,
        line,
        oddsAmerican: odds,
        book: "fanduel, draftkings",
      },
      probabilities: {
        model,
        marketImplied: implied,
        noVig: null,
        edgePp: (model - implied) * 100,
      },
      decision: {
        signal: "BET",
        confidenceLabel: "MODEL",
        confidencePct: model * 100,
        stakeUnits: 0,
      },
      analysisStage: options.stage ?? "FINAL",
      model: {
        name: "CourtEdge MLB Early Markets",
        version: "s5c-shadow-v2-price-integrity",
        gitCommit: "80c3120a35285724ef53b76e2d3a70300aab80ec",
        environment: "p0-integration",
      },
      supersedesId: options.supersedesId ?? null,
      source: "app",
      payloadSha256: `sha-${options.id}`,
      payload: {
        market: { capturedAt: capture },
        analysis: {
          layers: {
            marketPriceIntegrity: {
              capturedAt: capture,
              providerLastUpdate: capture,
              consensusMethod,
              standardAmericanOddsValidated: validated,
            },
            s5c: {
              schemaVersion: "mlb-s5c-shadow-ingestion.v1",
              semanticFingerprint: options.fingerprint ?? `fingerprint-${options.id}`,
              stage: options.stage ?? "FINAL",
            },
          },
          rawInputs: {
            priceCapture: {
              capturedAt: capture,
              providerLastUpdate: capture,
              consensusMethod,
              book: "fanduel, draftkings",
            },
            marketProvenance: {
              consensusMethod,
              providerLastUpdate: capture,
              contributingBooks: books,
            },
          },
        },
      },
    },
    settlement: options.settlement ?? null,
  } as LedgerRecord;
}

function settlement(id: string, options: {
  result?: string;
  closingOdds?: number | null;
  clvPp?: number | null;
  finalScore?: { home: number; away: number } | null;
  source?: string;
} = {}): LedgerRecord["settlement"] {
  return {
    eventId: `event-${id}`,
    predictionId: id,
    clientRequestId: `settlement-${id}`,
    recordedAt: "2026-08-02T04:00:00.000Z",
    recordedAtMs: Date.parse("2026-08-02T04:00:00.000Z"),
    settledAt: "2026-08-02T04:00:00.000Z",
    result: options.result ?? "WIN",
    closingOddsAmerican: options.closingOdds === undefined ? -120 : options.closingOdds,
    closingLine: null,
    closingImpliedProbability: options.closingOdds === null ? null : americanImplied(options.closingOdds ?? -120),
    clvPp: options.clvPp === undefined ? 2.16 : options.clvPp,
    outcomeValue: 1,
    finalScore: options.finalScore === undefined ? { home: 5, away: 3 } : options.finalScore,
    profitUnits: 0,
    source: options.source ?? "official",
    correctionOfEventId: null,
    notes: null,
    payloadSha256: `settlement-sha-${id}`,
    payload: {},
  } as any;
}

test("creates a clean post-fix cohort and remains COLLECTING before sufficient settlements", () => {
  const report = buildMlbS6iPostfixCertification([
    record({ id: "clean-final" }),
    record({ id: "clean-total", marketType: "F5_TOTAL", selection: "UNDER 4.5", line: 4.5, odds: 105 }),
  ], {
    now: new Date("2026-08-01T12:00:00.000Z"),
    trigger: "test",
    previousOwnedLedgerRecords: 1,
  });

  assert.equal(report.schemaVersion, MLB_S6I_POSTFIX_CERTIFICATION_VERSION);
  assert.equal(report.state, "COLLECTING");
  assert.equal(report.summary.postCutoffTerminalDecisions, 2);
  assert.equal(report.summary.cleanUniqueDecisions, 2);
  assert.equal(report.summary.invalidAmericanOdds, 0);
  assert.equal(report.summary.completeProvenance, 2);
  assert.equal(report.coverage.integrityPassPct, 100);
  assert.equal(report.coverage.provenancePct, 100);
  assert.equal(report.persistence.countMonotonic, true);
});

test("rejects near-zero odds and marks the cohort ACTION_REQUIRED", () => {
  const report = buildMlbS6iPostfixCertification([
    record({ id: "invalid-price", odds: -4 }),
  ], { now: new Date("2026-08-01T12:00:00.000Z") });

  assert.equal(report.state, "ACTION_REQUIRED");
  assert.equal(report.summary.invalidAmericanOdds, 1);
  assert.equal(report.summary.integrityReject, 1);
  assert.ok(report.issues.some((entry) => entry.code === "INVALID_AMERICAN_ODDS"));
});

test("excludes a terminal chain that crosses the Phase 3 deployment cutoff", () => {
  const provisional = record({
    id: "old-provisional",
    recordedAtMs: cutoffMs - 60_000,
    stage: "PROVISIONAL",
    fingerprint: "old-stage",
  });
  const final = record({
    id: "new-final",
    recordedAtMs: cutoffMs + 60_000,
    stage: "FINAL",
    supersedesId: "old-provisional",
    fingerprint: "new-stage",
  });
  const report = buildMlbS6iPostfixCertification([provisional, final], {
    now: new Date("2026-08-01T12:00:00.000Z"),
  });

  assert.equal(report.summary.postCutoffTerminalDecisions, 1);
  assert.equal(report.summary.cleanUniqueDecisions, 0);
  assert.equal(report.summary.excludedDecisions, 1);
  assert.ok(report.rows[0].issueCodes.includes("CHAIN_CROSSES_CUTOFF"));
});

test("excludes repeated semantic fingerprints from performance metrics", () => {
  const report = buildMlbS6iPostfixCertification([
    record({ id: "first", fingerprint: "same-fingerprint", recordedAtMs: cutoffMs + 10_000 }),
    record({ id: "duplicate", fingerprint: "same-fingerprint", recordedAtMs: cutoffMs + 20_000, gamePk: 456 }),
  ], { now: new Date("2026-08-01T12:00:00.000Z") });

  assert.equal(report.summary.postCutoffTerminalDecisions, 2);
  assert.equal(report.summary.cleanUniqueDecisions, 1);
  assert.equal(report.summary.analyticalDuplicatesExcluded, 1);
  assert.equal(report.performanceObservation.settledUniqueDecisions, 0);
});

test("measures official settlement, CLV, final score and Brier evidence without changing formulas", () => {
  const settled = record({
    id: "settled",
    commenceTime: "2026-08-01T01:00:00.000Z",
    settlement: settlement("settled"),
  });
  const report = buildMlbS6iPostfixCertification([settled], {
    now: new Date("2026-08-02T12:00:00.000Z"),
  });

  assert.equal(report.summary.settled, 1);
  assert.equal(report.summary.closingCaptured, 1);
  assert.equal(report.summary.finalScoreCaptured, 1);
  assert.equal(report.summary.wins, 1);
  assert.equal(report.coverage.closingCoveragePct, 100);
  assert.equal(report.coverage.finalScoreCoveragePct, 100);
  assert.equal(report.performanceObservation.informationalOnly, true);
  assert.equal(typeof report.performanceObservation.brierScore, "number");
  assert.equal(report.safety.formulasChanged, false);
  assert.equal(report.readiness.automaticPromotion, false);
});

test("detects missing FINAL snapshots, overdue settlement and persistence count regression", () => {
  const provisional = record({
    id: "overdue-provisional",
    stage: "PROVISIONAL",
    commenceTime: "2026-08-01T01:00:00.000Z",
  });
  const report = buildMlbS6iPostfixCertification([provisional], {
    now: new Date("2026-08-02T12:00:00.000Z"),
    previousOwnedLedgerRecords: 2,
  });

  assert.equal(report.state, "ACTION_REQUIRED");
  assert.equal(report.summary.finalMissedAfterStart, 1);
  assert.equal(report.summary.settlementOverdue, 1);
  assert.equal(report.persistence.countMonotonic, false);
  assert.ok(report.issues.some((entry) => entry.code === "PERSISTENCE_COUNT_REGRESSION"));
});
