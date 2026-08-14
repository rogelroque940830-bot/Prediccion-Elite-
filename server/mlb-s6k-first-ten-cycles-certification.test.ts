import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import type { S6jFirstCycleReport } from "./mlb-s6j-first-cycle-certification";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";
import {
  buildMlbS6kFirstTenReport,
  certifiedTerminalPredictionIdsFromS6k,
  classifyS6kCycle,
  selectFirstTenCleanCycleTargets,
} from "./mlb-s6k-first-ten-cycles-certification";

const cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

function record(index: number, options: {
  id?: string;
  gamePk?: number;
  commenceOffsetMinutes?: number;
  selection?: string;
  line?: number;
  supersedesId?: string | null;
  stage?: "PROVISIONAL" | "FINAL";
} = {}): LedgerRecord {
  const id = options.id ?? `root-${index}`;
  const gamePk = options.gamePk ?? 800000 + index;
  const recordedAtMs = cutoffMs + 60_000 + index * 1_000;
  const commenceTime = new Date(cutoffMs + (options.commenceOffsetMinutes ?? index + 60) * 60_000).toISOString();
  const line = options.line ?? 4.5;
  return {
    prediction: {
      id,
      clientRequestId: `s5c:${id}`,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: {
        gamePk,
        gameDate: "2026-08-01",
        commenceTime,
        homeTeam: `Home ${gamePk}`,
        awayTeam: `Away ${gamePk}`,
      },
      market: {
        type: "F5_TOTAL",
        selection: options.selection ?? `OVER ${line}`,
        line,
        oddsAmerican: -110,
        book: "betmgm, draftkings, fanduel",
      },
      probabilities: {
        model: 0.58,
        marketImplied: 110 / 210,
        noVig: null,
        edgePp: (0.58 - 110 / 210) * 100,
      },
      decision: {
        signal: "BET",
        confidenceLabel: "MODEL",
        confidencePct: 58,
        stakeUnits: 0,
      },
      analysisStage: options.stage ?? "PROVISIONAL",
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
        analysis: {
          layers: {
            s5c: {
              schemaVersion: "mlb-s5c-shadow-ingestion.v1",
              lineupCounts: { home: 0, away: 0 },
            },
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
        market: {
          capturedAt: new Date(recordedAtMs - 30_000).toISOString(),
        },
      },
    },
    settlement: null,
  } as LedgerRecord;
}

function report(state: S6jFirstCycleReport["state"], critical = false): S6jFirstCycleReport {
  return {
    schemaVersion: "mlb-s6j-first-clean-cycle.v1",
    generatedAt: "2026-08-01T17:00:00.000Z",
    trigger: "test",
    deploymentCommit: "fixture",
    environment: "test",
    state,
    cohort: {
      cutoff: MLB_S6I_CLEAN_COHORT_CUTOFF,
      requiredConsensusMethod: "median_implied_probability",
    },
    target: {
      rootPredictionId: "root",
      terminalPredictionId: "terminal",
      gamePk: 900001,
      gameDate: "2026-08-01",
      awayTeam: "Away",
      homeTeam: "Home",
      marketType: "F5_TOTAL",
      selection: "OVER 4.5",
      line: 4.5,
      commenceTime: "2026-08-01T23:00:00.000Z",
    },
    lifecycle: {
      chainLength: 2,
      provisionalStages: 1,
      finalStages: 1,
      terminalStage: "FINAL",
      terminalRecordedAt: "2026-08-01T22:00:00.000Z",
      finalBeforeStart: true,
      lineupsConfirmed: true,
      settled: state !== "WAITING_FOR_FINAL" && state !== "WAITING_FOR_SETTLEMENT",
      settlementSource: state === "CERTIFIED" ? "correction" : null,
      settlementResult: state === "CERTIFIED" ? "WIN" : null,
      officialGradeResult: state === "CERTIFIED" ? "WIN" : null,
      comparableClosingCaptured: state === "CERTIFIED",
      clvCaptured: state === "CERTIFIED",
    },
    checks: {
      purePostFixChain: true,
      linearSupersession: true,
      identityStable: true,
      provisionalToFinalComplete: true,
      validMarketPrice: true,
      validPriceProvenance: true,
      settlementMatchesOfficialGrade: state === "CERTIFIED" ? true : null,
      officialFinalScoreMatches: state === "CERTIFIED" ? true : null,
      comparableClosingMatchesSettlement: state === "CERTIFIED" ? true : null,
      clvArithmeticValid: state === "CERTIFIED" ? true : null,
      persistenceMonotonic: true,
    },
    settlement: {
      eventId: null,
      settledAt: null,
      source: null,
      correctionOfEventId: null,
      result: null,
      outcomeValue: null,
      finalScore: null,
      profitUnits: null,
      closingOddsAmerican: null,
      closingLine: null,
      clvPp: null,
    },
    officialVerification: {
      gameAvailable: state === "CERTIFIED",
      gameFinal: state === "CERTIFIED",
      gamePk: 900001,
      finalScore: state === "CERTIFIED" ? { home: 4, away: 2 } : null,
      gradedResult: state === "CERTIFIED" ? "WIN" : null,
      gradedOutcomeValue: state === "CERTIFIED" ? 6 : null,
      note: null,
    },
    closing: {
      observationId: null,
      capturedAt: null,
      classification: null,
      comparable: state === "CERTIFIED",
      closingOddsAmerican: null,
      closingLine: null,
      sourceBooks: [],
    },
    persistence: {
      ledgerImmutable: true,
      previousOwnedLedgerRecords: 100,
      currentOwnedLedgerRecords: 101,
      countMonotonic: true,
    },
    issues: critical ? [{ code: "IDENTITY_CHANGED", severity: "CRITICAL", message: "fixture" }] : [],
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      historicalLedgerMutation: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  };
}

test("selects the first ten unique clean lifecycle roots and removes analytical duplicates", () => {
  const records = Array.from({ length: 12 }, (_, index) => record(index));
  records.push(record(99, {
    id: "duplicate-root",
    gamePk: 800000,
    commenceOffsetMinutes: 61,
    selection: "OVER 4.5",
    line: 4.5,
  }));
  const selected = selectFirstTenCleanCycleTargets(records);
  assert.equal(selected.length, 10);
  assert.deepEqual(selected, Array.from({ length: 10 }, (_, index) => `root-${index}`));
  assert.equal(selected.includes("duplicate-root"), false);
});

test("preserves the append-only target registry order while filling remaining slots", () => {
  const records = Array.from({ length: 12 }, (_, index) => record(index));
  const selected = selectFirstTenCleanCycleTargets(records, ["root-5", "missing-root"]);
  assert.equal(selected.length, 10);
  assert.deepEqual(selected.slice(0, 2), ["root-5", "missing-root"]);
  assert.equal(new Set(selected).size, 10);
});

test("maps lifecycle states into PASS, REVIEW, REJECT and WAITING", () => {
  assert.equal(classifyS6kCycle(report("CERTIFIED")), "PASS");
  assert.equal(classifyS6kCycle(report("WAITING_FOR_CLOSING")), "REVIEW");
  assert.equal(classifyS6kCycle(report("ACTION_REQUIRED")), "REJECT");
  assert.equal(classifyS6kCycle(report("WAITING_FOR_SETTLEMENT")), "WAITING");
  assert.equal(classifyS6kCycle(report("WAITING_FOR_SETTLEMENT", true)), "REJECT");
});

test("becomes READY_FOR_ANALYSIS only after ten certified cycles", () => {
  const reports = Array.from({ length: 10 }, () => report("CERTIFIED"));
  const batch = buildMlbS6kFirstTenReport(reports, {
    rootPredictionIds: Array.from({ length: 10 }, (_, index) => `root-${index}`),
    currentOwnedLedgerRecords: 500,
    previousOwnedLedgerRecords: 499,
  });
  assert.equal(batch.state, "READY_FOR_ANALYSIS");
  assert.equal(batch.readyForAnalysis, true);
  assert.equal(batch.summary.pass, 10);
});

test("stays collecting with incomplete evidence and requires action for a rejected cycle", () => {
  const collecting = buildMlbS6kFirstTenReport([
    ...Array.from({ length: 8 }, () => report("CERTIFIED")),
    report("WAITING_FOR_CLOSING"),
    report("WAITING_FOR_SETTLEMENT"),
  ], {
    rootPredictionIds: Array.from({ length: 10 }, (_, index) => `root-${index}`),
    currentOwnedLedgerRecords: 500,
  });
  assert.equal(collecting.state, "COLLECTING");
  assert.equal(collecting.summary.review, 1);
  assert.equal(collecting.summary.waiting, 1);

  const rejected = buildMlbS6kFirstTenReport([
    ...Array.from({ length: 9 }, () => report("CERTIFIED")),
    report("ACTION_REQUIRED"),
  ], {
    rootPredictionIds: Array.from({ length: 10 }, (_, index) => `root-${index}`),
    currentOwnedLedgerRecords: 500,
  });
  assert.equal(rejected.state, "ACTION_REQUIRED");
  assert.equal(rejected.summary.reject, 1);
});

test("preserves the immutable first ten while certifying later clean cycles in the extended pool", () => {
  const firstTen = [
    ...Array.from({ length: 4 }, () => report("CERTIFIED")),
    ...Array.from({ length: 6 }, () => report("ACTION_REQUIRED")),
  ];
  const pool = [
    ...firstTen,
    ...Array.from({ length: 8 }, (_, index) => {
      const value = report("CERTIFIED");
      value.target.terminalPredictionId = `later-final-${index}`;
      return value;
    }),
  ];
  const batch = buildMlbS6kFirstTenReport(firstTen, {
    rootPredictionIds: Array.from({ length: 10 }, (_, index) => `root-${index}`),
    currentOwnedLedgerRecords: 500,
    certificationPoolReports: pool,
    certificationPoolRootPredictionIds: Array.from({ length: 18 }, (_, index) => `root-${index}`),
  });

  assert.equal(batch.state, "ACTION_REQUIRED");
  assert.equal(batch.summary.pass, 4);
  assert.equal(batch.certificationPool.evaluated, 18);
  assert.equal(batch.certificationPool.certified, 12);
  assert.equal(certifiedTerminalPredictionIdsFromS6k(batch).length, 9);
  assert.equal(certifiedTerminalPredictionIdsFromS6k(batch).includes("later-final-7"), true);
});
