import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore } from "./mlb-ledger-store";
import { MlbShadowCollectionService } from "./mlb-shadow-collection-worker";

function predictionInput(clientRequestId: string) {
  return {
    clientRequestId,
    source: "app" as const,
    model: {
      name: "CourtEdge MLB",
      version: "s5b-test",
      gitCommit: "test-commit",
      environment: "test",
    },
    game: {
      gamePk: 900001,
      gameDate: "2026-07-30",
      commenceTime: "2026-07-30T23:10:00.000Z",
      homeTeam: "Miami Marlins",
      awayTeam: "Philadelphia Phillies",
    },
    market: {
      type: "ML" as const,
      selection: "Miami Marlins",
      oddsAmerican: -110,
      book: "shadow-test",
      capturedAt: "2026-07-30T20:00:00.000Z",
    },
    probabilities: {
      model: 0.58,
      marketImplied: 0.52381,
      edgePp: 5.619,
    },
    decision: {
      signal: "BET" as const,
      confidenceLabel: "PREMIUM",
      confidencePct: 58,
      stakeUnits: 1,
      rationale: "Technical shadow fixture",
    },
    analysis: {
      stage: "FINAL" as const,
      warnings: [],
      factors: [],
      sources: [{
        name: "test-source",
        status: "VERIFIED" as const,
        fetchedAt: "2026-07-30T20:00:00.000Z",
      }],
      layers: {},
      rawOutput: { filterReasons: [] },
    },
  };
}

test("recurring shadow collection snapshots only semantic changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s5b-shadow-collection-"));
  const databasePath = path.join(root, "ledger.sqlite");
  const store = new MlbLedgerStore(databasePath);
  try {
    const prediction = store.appendPrediction(predictionInput("s5b-shadow-test-1")).data;
    const service = new MlbShadowCollectionService(store, {
      root: path.join(root, "collection"),
      enabled: true,
      environment: "p0-integration",
      deploymentCommit: "test-commit",
      now: (() => {
        const values = [
          new Date("2026-07-30T20:10:00.000Z"),
          new Date("2026-07-30T20:20:00.000Z"),
          new Date("2026-07-30T20:30:00.000Z"),
        ];
        let index = 0;
        return () => values[Math.min(index++, values.length - 1)];
      })(),
    });

    const first = service.collect("test-first");
    assert.equal(first.changed, true);
    assert.equal(first.snapshotCreated, true);
    assert.equal(first.safety.realFinancialExposure, 0);
    assert.equal(first.evaluation.execution.automaticBetPlacement, false);
    assert.equal(service.status().snapshots, 1);

    const second = service.collect("test-repeat");
    assert.equal(second.changed, false);
    assert.equal(second.snapshotCreated, false);
    assert.equal(service.status().snapshots, 1);

    store.appendSettlement(prediction.id, {
      clientRequestId: "s5b-shadow-settlement-1",
      settledAt: "2026-07-30T23:59:00.000Z",
      result: "WIN",
      closingOddsAmerican: -105,
      finalScore: { home: 5, away: 3 },
      source: "official",
    });

    const third = service.collect("test-settlement");
    assert.equal(third.changed, true);
    assert.equal(third.snapshotCreated, true);
    assert.equal(third.evaluation.summary.settled, 1);
    assert.equal(service.status().snapshots, 2);

    const latest = service.readLatest();
    assert.equal(latest?.semanticDigest, third.semanticDigest);
    assert.equal(latest?.source.immutable, true);
    assert.equal(latest?.safety.productionWrites, false);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
