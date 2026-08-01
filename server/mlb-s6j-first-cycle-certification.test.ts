import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import type { S5eConsensusObservation } from "./mlb-s5e-coverage-service";
import type { OfficialMlbGame } from "./mlb-settlement-worker";
import {
  buildMlbS6jFirstCycleCertification,
  selectFirstCleanCycleTarget,
} from "./mlb-s6j-first-cycle-certification";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";

const cutoffMs = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);
const commenceTime = "2026-08-01T23:00:00.000Z";

function americanImplied(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function record(options: {
  id: string;
  recordedAtMs: number;
  stage: "PROVISIONAL" | "FINAL";
  supersedesId?: string | null;
  odds?: number;
  line?: number;
  selection?: string;
  lineupHome?: number;
  lineupAway?: number;
  settlement?: LedgerRecord["settlement"];
}): LedgerRecord {
  const odds = options.odds ?? -110;
  const implied = americanImplied(odds);
  const line = options.line ?? 4.5;
  const capturedAt = new Date(options.recordedAtMs - 30_000).toISOString();
  return {
    prediction: {
      id: options.id,
      clientRequestId: `s5c:${options.id}`,
      recordedAt: new Date(options.recordedAtMs).toISOString(),
      recordedAtMs: options.recordedAtMs,
      game: {
        gamePk: 990001,
        gameDate: "2026-08-01",
        commenceTime,
        homeTeam: "Miami Marlins",
        awayTeam: "Philadelphia Phillies",
      },
      market: {
        type: "F5_TOTAL",
        selection: options.selection ?? `OVER ${line}`,
        line,
        oddsAmerican: odds,
        book: "betmgm, draftkings, fanduel",
      },
      probabilities: {
        model: 0.62,
        marketImplied: implied,
        noVig: null,
        edgePp: (0.62 - implied) * 100,
      },
      decision: {
        signal: "BET",
        confidenceLabel: "MODEL",
        confidencePct: 62,
        stakeUnits: 0,
      },
      analysisStage: options.stage,
      model: {
        name: "CourtEdge MLB Early Markets",
        version: "s5c-shadow-v2-price-integrity",
        gitCommit: "fixture",
        environment: "p0-integration",
      },
      supersedesId: options.supersedesId ?? null,
      source: "app",
      payloadSha256: `sha-${options.id}`,
      payload: {
        market: { capturedAt },
        analysis: {
          layers: {
            s5c: {
              schemaVersion: "mlb-s5c-shadow-ingestion.v1",
              lineupCounts: {
                home: options.lineupHome ?? (options.stage === "FINAL" ? 9 : 0),
                away: options.lineupAway ?? (options.stage === "FINAL" ? 9 : 0),
              },
            },
            marketPriceIntegrity: {
              standardAmericanOddsValidated: true,
              consensusMethod: "median_implied_probability",
            },
          },
          rawInputs: {
            priceCapture: {
              capturedAt,
              consensusMethod: "median_implied_probability",
            },
            marketProvenance: {
              contributingBooks: ["betmgm", "draftkings", "fanduel"],
              consensusMethod: "median_implied_probability",
            },
          },
        },
      },
    },
    settlement: options.settlement ?? null,
  } as LedgerRecord;
}

const officialGame: OfficialMlbGame = {
  gamePk: 990001,
  gameDate: "2026-08-01",
  final: true,
  homeTeam: "Miami Marlins",
  awayTeam: "Philadelphia Phillies",
  homeScore: 6,
  awayScore: 3,
  innings: [
    { num: 1, home: 1, away: 0 },
    { num: 2, home: 0, away: 1 },
    { num: 3, home: 1, away: 0 },
    { num: 4, home: 0, away: 1 },
    { num: 5, home: 1, away: 0 },
    { num: 6, home: 1, away: 0 },
    { num: 7, home: 1, away: 0 },
    { num: 8, home: 1, away: 1 },
    { num: 9, home: 0, away: 0 },
  ],
};

function comparableObservation(predictionId: string): S5eConsensusObservation {
  return {
    schemaVersion: "mlb-s5e-consensus-closing.v1",
    observationId: "s5e-close-fixture",
    semanticDigest: "a".repeat(64),
    predictionId,
    capturedAt: "2026-08-01T22:50:00.000Z",
    gamePk: 990001,
    gameDate: "2026-08-01",
    commenceTime,
    homeTeam: "Miami Marlins",
    awayTeam: "Philadelphia Phillies",
    marketType: "F5_TOTAL",
    selection: "OVER 4.5",
    ticketLine: 4.5,
    ticketOddsAmerican: -110,
    openingSourceBooks: ["betmgm", "draftkings", "fanduel"],
    closingSourceBooks: ["betmgm", "draftkings", "fanduel"],
    closingOddsAmerican: -120,
    closingLine: 4.5,
    comparable: true,
    classification: "COMPARABLE",
    source: "COURTEDGE_F5_CONSENSUS",
    safety: { syntheticOdds: false, realFinancialExposure: 0 },
  };
}

function correctedSettlement(result: "WIN" | "LOSS" = "WIN"): LedgerRecord["settlement"] {
  const opening = americanImplied(-110);
  const closing = americanImplied(-120);
  return {
    eventId: "mlb-settle-correction",
    predictionId: "final",
    clientRequestId: "s5e-close:final",
    recordedAt: "2026-08-02T03:20:00.000Z",
    recordedAtMs: Date.parse("2026-08-02T03:20:00.000Z"),
    settledAt: "2026-08-02T03:05:00.000Z",
    result,
    closingOddsAmerican: -120,
    closingLine: 4.5,
    closingImpliedProbability: closing,
    clvPp: (closing - opening) * 100,
    outcomeValue: 5,
    finalScore: { home: 6, away: 3 },
    profitUnits: 0,
    source: "correction",
    correctionOfEventId: "mlb-settle-official",
    notes: "Official F5 total 5 vs OVER 4.5 · S5E comparable closing",
    payloadSha256: "b".repeat(64),
    payload: {},
  } as LedgerRecord["settlement"];
}

test("locks the earliest pure post-fix PROVISIONAL chain and waits for FINAL", () => {
  const early = record({
    id: "early-provisional",
    recordedAtMs: cutoffMs + 60_000,
    stage: "PROVISIONAL",
  });
  const later = record({
    id: "later-provisional",
    recordedAtMs: cutoffMs + 120_000,
    stage: "PROVISIONAL",
  });
  const target = selectFirstCleanCycleTarget([later, early]);
  assert.equal(target, "early-provisional");

  const report = buildMlbS6jFirstCycleCertification([early, later], {
    targetRootId: target,
    now: new Date("2026-08-01T18:00:00.000Z"),
  });
  assert.equal(report.state, "WAITING_FOR_FINAL");
  assert.equal(report.lifecycle.provisionalStages, 1);
  assert.equal(report.lifecycle.finalStages, 0);
  assert.equal(report.safety.realFinancialExposure, 0);
});

test("certifies a complete PROVISIONAL to FINAL to official settlement to comparable CLV cycle", () => {
  const provisional = record({
    id: "provisional",
    recordedAtMs: cutoffMs + 60_000,
    stage: "PROVISIONAL",
  });
  const final = record({
    id: "final",
    recordedAtMs: Date.parse("2026-08-01T22:40:00.000Z"),
    stage: "FINAL",
    supersedesId: "provisional",
    settlement: correctedSettlement("WIN"),
  });
  const report = buildMlbS6jFirstCycleCertification([provisional, final], {
    targetRootId: "provisional",
    observations: [comparableObservation("final")],
    officialGame,
    now: new Date("2026-08-02T04:00:00.000Z"),
    previousOwnedLedgerRecords: 2,
  });

  assert.equal(report.state, "CERTIFIED");
  assert.equal(report.checks.purePostFixChain, true);
  assert.equal(report.checks.linearSupersession, true);
  assert.equal(report.checks.identityStable, true);
  assert.equal(report.checks.provisionalToFinalComplete, true);
  assert.equal(report.checks.settlementMatchesOfficialGrade, true);
  assert.equal(report.checks.officialFinalScoreMatches, true);
  assert.equal(report.checks.comparableClosingMatchesSettlement, true);
  assert.equal(report.checks.clvArithmeticValid, true);
  assert.equal(report.lifecycle.officialGradeResult, "WIN");
  assert.equal(report.issues.length, 0);
});

test("keeps a completed official settlement waiting until comparable closing correction arrives", () => {
  const provisional = record({
    id: "provisional",
    recordedAtMs: cutoffMs + 60_000,
    stage: "PROVISIONAL",
  });
  const settlement = correctedSettlement("WIN");
  settlement.source = "official";
  settlement.correctionOfEventId = null;
  settlement.closingOddsAmerican = null;
  settlement.closingLine = null;
  settlement.clvPp = null;
  const final = record({
    id: "final",
    recordedAtMs: Date.parse("2026-08-01T22:40:00.000Z"),
    stage: "FINAL",
    supersedesId: "provisional",
    settlement,
  });
  const report = buildMlbS6jFirstCycleCertification([provisional, final], {
    targetRootId: "provisional",
    observations: [],
    officialGame,
    now: new Date("2026-08-02T03:30:00.000Z"),
  });
  assert.equal(report.state, "WAITING_FOR_CLOSING");
  assert.equal(report.checks.settlementMatchesOfficialGrade, true);
  assert.equal(report.lifecycle.clvCaptured, false);
});

test("raises ACTION_REQUIRED when stored settlement disagrees with independent official grading", () => {
  const provisional = record({
    id: "provisional",
    recordedAtMs: cutoffMs + 60_000,
    stage: "PROVISIONAL",
  });
  const final = record({
    id: "final",
    recordedAtMs: Date.parse("2026-08-01T22:40:00.000Z"),
    stage: "FINAL",
    supersedesId: "provisional",
    settlement: correctedSettlement("LOSS"),
  });
  const report = buildMlbS6jFirstCycleCertification([provisional, final], {
    targetRootId: "provisional",
    observations: [comparableObservation("final")],
    officialGame,
    now: new Date("2026-08-02T04:00:00.000Z"),
  });
  assert.equal(report.state, "ACTION_REQUIRED");
  assert.ok(report.issues.some((entry) => entry.code === "SETTLEMENT_RESULT_MISMATCH"));
});

test("rejects identity drift inside a supersession chain", () => {
  const provisional = record({
    id: "provisional",
    recordedAtMs: cutoffMs + 60_000,
    stage: "PROVISIONAL",
    line: 4.5,
  });
  const final = record({
    id: "final",
    recordedAtMs: Date.parse("2026-08-01T22:40:00.000Z"),
    stage: "FINAL",
    supersedesId: "provisional",
    line: 5,
  });
  const report = buildMlbS6jFirstCycleCertification([provisional, final], {
    targetRootId: "provisional",
    now: new Date("2026-08-01T22:50:00.000Z"),
  });
  assert.equal(report.state, "ACTION_REQUIRED");
  assert.ok(report.issues.some((entry) => entry.code === "IDENTITY_CHANGED"));
});
