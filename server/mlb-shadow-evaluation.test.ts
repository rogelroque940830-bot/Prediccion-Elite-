import test from "node:test";
import assert from "node:assert/strict";
import { buildMlbShadowEvaluation, buildMlbShadowRows } from "./mlb-shadow-evaluation";
import type { LedgerRecord } from "./mlb-ledger-store";

type FixtureOptions = {
  probability?: number;
  marketImplied?: number | null;
  result?: "WIN" | "LOSS" | "PUSH";
  signal?: "BET_FUERTE" | "BET" | "LEAN" | "PASS" | "INFO";
  confidenceLabel?: string;
  stake?: number;
  odds?: number;
  clvPp?: number | null;
  warnings?: string[];
  stage?: "PROVISIONAL" | "FINAL";
  gamePk?: number | null;
};

function fixture(index: number, options: FixtureOptions = {}): LedgerRecord {
  const probability = options.probability ?? 0.62;
  const marketImplied = options.marketImplied === undefined ? 0.55 : options.marketImplied;
  const signal = options.signal ?? "BET";
  const stake = options.stake ?? (signal === "BET" || signal === "BET_FUERTE" ? 1 : 0);
  const odds = options.odds ?? 100;
  const stage = options.stage ?? "FINAL";
  const id = `shadow-${index}`;
  const recordedAt = `2026-07-${String(1 + (index % 27)).padStart(2, "0")}T12:00:00.000Z`;
  const gamePk = options.gamePk === undefined ? 900_000 + index : options.gamePk;
  const result = options.result ?? null;
  return {
    prediction: {
      id,
      clientRequestId: `shadow-request-${index}`,
      recordedAt,
      recordedAtMs: Date.parse(recordedAt),
      game: {
        gamePk,
        gameDate: recordedAt.slice(0, 10),
        commenceTime: `${recordedAt.slice(0, 10)}T23:00:00.000Z`,
        homeTeam: `Home ${index}`,
        awayTeam: `Away ${index}`,
      },
      market: {
        type: index % 2 === 0 ? "ML" : "F5_TOTAL",
        selection: index % 2 === 0 ? `Home ${index}` : "OVER 4.5",
        line: index % 2 === 0 ? null : 4.5,
        oddsAmerican: odds,
        book: "Shadow Book",
      },
      probabilities: {
        model: probability,
        marketImplied,
        noVig: marketImplied,
        edgePp: marketImplied == null ? null : (probability - marketImplied) * 100,
      },
      decision: {
        signal,
        confidenceLabel: options.confidenceLabel ?? (signal === "BET_FUERTE" ? "ELITE" : signal === "BET" ? "PREMIUM" : signal),
        confidencePct: probability * 100,
        stakeUnits: stake,
      },
      analysisStage: stage,
      model: {
        name: "CourtEdge MLB",
        version: "shadow-fixture-v1",
        gitCommit: "93e17cfbf30ba9971e2fea468c07ca399d7a8641",
        environment: "test",
      },
      supersedesId: null,
      source: "app",
      payloadSha256: `prediction-sha-${index}`,
      payload: {
        model: {
          name: "CourtEdge MLB",
          version: "shadow-fixture-v1",
          gitCommit: "93e17cfbf30ba9971e2fea468c07ca399d7a8641",
          environment: "test",
        },
        game: {
          gamePk,
          gameDate: recordedAt.slice(0, 10),
          commenceTime: `${recordedAt.slice(0, 10)}T23:00:00.000Z`,
          homeTeam: `Home ${index}`,
          awayTeam: `Away ${index}`,
        },
        market: {
          type: index % 2 === 0 ? "ML" : "F5_TOTAL",
          selection: index % 2 === 0 ? `Home ${index}` : "OVER 4.5",
          line: index % 2 === 0 ? undefined : 4.5,
          oddsAmerican: odds,
          book: "Shadow Book",
          capturedAt: recordedAt,
        },
        probabilities: { model: probability, marketImplied },
        decision: { signal, confidenceLabel: options.confidenceLabel, stakeUnits: stake },
        analysis: {
          stage,
          warnings: options.warnings ?? [],
          factors: [{ name: "fixture", direction: "NEUTRAL", magnitude: index }],
          sources: [{ name: "fixture-source", status: "VERIFIED", fetchedAt: recordedAt }],
          layers: {},
          rawOutput: { filterReasons: options.warnings ?? [] },
        },
      },
    },
    settlement: result ? {
      eventId: `settlement-${index}`,
      predictionId: id,
      clientRequestId: `settlement-request-${index}`,
      recordedAt: `${recordedAt.slice(0, 10)}T23:59:00.000Z`,
      recordedAtMs: Date.parse(`${recordedAt.slice(0, 10)}T23:59:00.000Z`),
      settledAt: `${recordedAt.slice(0, 10)}T23:59:00.000Z`,
      result,
      closingOddsAmerican: -105,
      closingLine: index % 2 === 0 ? null : 4.5,
      closingImpliedProbability: 0.5122,
      clvPp: options.clvPp === undefined ? 0.8 : options.clvPp,
      outcomeValue: result === "WIN" ? 1 : result === "LOSS" ? 0 : 0.5,
      finalScore: { home: 5, away: 3 },
      profitUnits: result === "WIN" ? stake : result === "LOSS" ? -stake : 0,
      source: "official",
      correctionOfEventId: null,
      notes: null,
      payloadSha256: `settlement-sha-${index}`,
      payload: {},
    } : null,
  } as LedgerRecord;
}

test("S5B excludes repeated polling from analytical sample size", () => {
  const original = fixture(1, { result: "WIN", warnings: ["LINEUP_CONFIRMED"] });
  const duplicate = structuredClone(original);
  duplicate.prediction.id = "shadow-duplicate";
  duplicate.prediction.clientRequestId = "shadow-request-duplicate";
  duplicate.prediction.recordedAt = "2026-07-02T12:00:10.000Z";
  duplicate.prediction.recordedAtMs = Date.parse(duplicate.prediction.recordedAt);
  (duplicate.prediction.payload as any).market.capturedAt = "2026-07-02T12:00:10.000Z";
  (duplicate.prediction.payload as any).analysis.sources[0].fetchedAt = "2026-07-02T12:00:10.000Z";

  const report = buildMlbShadowEvaluation([original, duplicate]);
  assert.equal(report.deduplication.ledgerRecords, 2);
  assert.equal(report.deduplication.uniqueAnalyticalDecisions, 1);
  assert.equal(report.deduplication.duplicatesExcluded, 1);
  assert.deepEqual(report.deduplication.duplicatePredictionIds, ["shadow-duplicate"]);
  assert.equal(buildMlbShadowRows([original, duplicate]).length, 1);
});

test("S5B separates accepted and blocked decisions and simulates zero-exposure accounting", () => {
  const accepted = fixture(2, {
    result: "WIN",
    signal: "BET_FUERTE",
    confidenceLabel: "ELITE",
    stake: 2,
    odds: 100,
    clvPp: 1.2,
  });
  const blocked = fixture(3, {
    result: "LOSS",
    signal: "PASS",
    confidenceLabel: "PASS",
    stake: 0,
    odds: 100,
    warnings: ["BULLPEN_STATUS_MISSING", "EDGE_BELOW_THRESHOLD"],
    clvPp: -0.2,
  });

  const report = buildMlbShadowEvaluation([accepted, blocked]);
  assert.equal(report.execution.realFinancialExposure, 0);
  assert.equal(report.execution.automaticBetPlacement, false);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.flatProfitUnits, 0);
  assert.equal(report.summary.flatRoiPct, 0);
  assert.equal(report.summary.policyProfitUnits, 2);
  assert.equal(report.summary.policyStakedUnits, 2);
  assert.equal(report.summary.policyRoiPct, 100);
  assert.equal(report.breakdowns.byDisposition.ACCEPTED.total, 1);
  assert.equal(report.breakdowns.byDisposition.BLOCKED.total, 1);
  assert.deepEqual(report.rows.find((row) => row.disposition === "BLOCKED")?.filterReasons, [
    "BULLPEN_STATUS_MISSING",
    "EDGE_BELOW_THRESHOLD",
  ]);
  assert.equal(report.rows.find((row) => row.disposition === "ACCEPTED")?.category, "ELITE");
});

test("S5B extends collection when sample or data coverage is insufficient", () => {
  const report = buildMlbShadowEvaluation([
    fixture(4, { result: "WIN" }),
    fixture(5, { result: "LOSS", marketImplied: null, stage: "PROVISIONAL", gamePk: null, clvPp: null }),
  ]);
  assert.equal(report.decisionGate.status, "EXTEND");
  assert.equal(report.decisionGate.automaticPromotion, false);
  assert.equal(report.decisionGate.formulasChanged, false);
  assert.ok(report.decisionGate.reasons.some((reason) => reason.includes("decisiones liquidadas")));
  assert.ok((report.dataQuality.missingFieldCounts.marketImpliedProbability ?? 0) >= 1);
});

test("S5B produces NO_GO only after a mature sample with severe negative evidence", () => {
  const records = Array.from({ length: 30 }, (_, index) => fixture(100 + index, {
    probability: 0.8,
    marketImplied: 0.55,
    result: "LOSS",
    signal: "BET",
    stake: 1,
    odds: -110,
    clvPp: -2,
  }));
  const report = buildMlbShadowEvaluation(records);
  assert.equal(report.summary.settled, 30);
  assert.equal(report.decisionGate.status, "NO_GO");
  assert.equal(report.decisionGate.automaticPromotion, false);
  assert.ok((report.summary.brierScore ?? 0) >= 0.6);
  assert.ok((report.summary.averageClvPp ?? 0) <= -2);
});
