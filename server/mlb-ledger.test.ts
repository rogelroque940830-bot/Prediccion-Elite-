import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMlbBacktestReport, MlbLedgerStore } from "./mlb-ledger";

function predictionPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "mlb-ledger.v1",
    clientRequestId: "req-pred-001",
    source: "app",
    model: {
      name: "CourtEdge MLB",
      version: "phase1-test",
      gitCommit: "test-commit",
      environment: "test",
    },
    game: {
      gamePk: 777001,
      gameDate: "2026-07-26",
      commenceTime: "2026-07-26T23:10:00.000Z",
      homeTeam: "Home Club",
      awayTeam: "Away Club",
      venue: "Test Park",
    },
    market: {
      type: "F5_ML",
      selection: "Home Club F5 ML",
      oddsAmerican: -120,
      book: "Hard Rock",
      capturedAt: "2026-07-26T20:00:00.000Z",
    },
    probabilities: {
      model: 0.61,
      noVig: 0.545,
    },
    decision: {
      signal: "BET",
      confidenceLabel: "LOW",
      confidencePct: 61,
      stakeUnits: 1,
      rationale: "Test prediction",
    },
    analysis: {
      stage: "FINAL",
      warnings: [],
      factors: [
        { name: "ERE diff", direction: "FOR", magnitude: 12, units: "points", confidence: "FULL", source: "ERE" },
      ],
      sources: [
        { name: "MLB Stats API", status: "VERIFIED", fetchedAt: "2026-07-26T19:59:00.000Z", sample: 30 },
      ],
      layers: { pureModel: 0.61 },
      rawInputs: { test: true },
      rawOutput: { recommendation: "BET" },
    },
    ...overrides,
  };
}

function withStore(fn: (store: MlbLedgerStore) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-ledger-test-"));
  const dbPath = path.join(dir, "ledger.sqlite");
  const store = new MlbLedgerStore(dbPath);
  try {
    fn(store);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("prediction writes are idempotent and immutable", () => {
  withStore((store) => {
    const first = store.appendPrediction(predictionPayload());
    assert.equal(first.idempotent, false);
    assert.equal(first.data.probabilities.model, 0.61);
    assert.equal(first.data.probabilities.edgePp, 6.5);

    const retry = store.appendPrediction(predictionPayload());
    assert.equal(retry.idempotent, true);
    assert.equal(retry.data.id, first.data.id);

    assert.throws(
      () => (store as any).db.prepare("UPDATE mlb_prediction_ledger_v1 SET signal = 'PASS' WHERE id = ?").run(first.data.id),
      /immutable/,
    );
  });
});

test("settlements append, compute profit and keep corrections as events", () => {
  withStore((store) => {
    const prediction = store.appendPrediction(predictionPayload()).data;
    const first = store.appendSettlement(prediction.id, {
      clientRequestId: "req-settle-001",
      settledAt: "2026-07-27T02:00:00.000Z",
      result: "WIN",
      closingOddsAmerican: -140,
      finalScore: { home: 4, away: 2 },
      source: "official",
    });

    assert.equal(first.idempotent, false);
    assert.equal(first.data.profitUnits, 0.8333);
    assert.ok((first.data.clvPp ?? 0) > 0);

    const retry = store.appendSettlement(prediction.id, {
      clientRequestId: "req-settle-001",
      settledAt: "2026-07-27T02:00:00.000Z",
      result: "WIN",
      closingOddsAmerican: -140,
      finalScore: { home: 4, away: 2 },
      source: "official",
    });
    assert.equal(retry.idempotent, true);
    assert.equal(retry.data.eventId, first.data.eventId);

    const correction = store.appendSettlement(prediction.id, {
      clientRequestId: "req-settle-002",
      settledAt: "2026-07-27T03:00:00.000Z",
      result: "PUSH",
      correctionOfEventId: first.data.eventId,
      source: "correction",
      notes: "Official scoring correction",
    });
    assert.notEqual(correction.data.eventId, first.data.eventId);
    assert.equal(store.latestSettlement(prediction.id)?.result, "PUSH");

    assert.throws(
      () => (store as any).db.prepare("DELETE FROM mlb_settlement_events_v1 WHERE event_id = ?").run(first.data.eventId),
      /immutable/,
    );
  });
});

test("report is chronological, reproducible and grouped by confidence", () => {
  withStore((store) => {
    const first = store.appendPrediction(predictionPayload()).data;
    store.appendSettlement(first.id, {
      clientRequestId: "req-settle-report-1",
      result: "WIN",
      closingOddsAmerican: -135,
      source: "official",
    });

    const secondPayload = predictionPayload({
      clientRequestId: "req-pred-002",
      game: {
        gamePk: 777002,
        gameDate: "2026-07-27",
        commenceTime: "2026-07-27T23:10:00.000Z",
        homeTeam: "Second Home",
        awayTeam: "Second Away",
      },
      market: {
        type: "TOTAL",
        selection: "Under 8.5",
        line: 8.5,
        oddsAmerican: -110,
        book: "Hard Rock",
      },
      probabilities: { model: 0.58, marketImplied: 0.5238, edgePp: 5.62 },
      decision: {
        signal: "LEAN",
        confidenceLabel: "HIGH",
        confidencePct: 58,
        stakeUnits: 0.5,
      },
    });
    const second = store.appendPrediction(secondPayload).data;
    store.appendSettlement(second.id, {
      clientRequestId: "req-settle-report-2",
      result: "LOSS",
      closingOddsAmerican: -105,
      source: "official",
    });

    const records = store.listRecords({ limit: 100 });
    const reportA = buildMlbBacktestReport(records, 50, 25);
    const reportB = buildMlbBacktestReport(records, 50, 25);

    assert.equal(reportA.datasetSha256, reportB.datasetSha256);
    assert.equal(reportA.overall.predictions, 2);
    assert.equal(reportA.overall.settled, 2);
    assert.equal(reportA.byConfidence.LOW.predictions, 1);
    assert.equal(reportA.byConfidence.HIGH.predictions, 1);
    assert.equal(reportA.temporalSplit.train.predictions, 1);
    assert.equal(reportA.temporalSplit.test.predictions, 1);
    assert.equal(reportA.overall.profitUnits, -0.1667);
  });
});
