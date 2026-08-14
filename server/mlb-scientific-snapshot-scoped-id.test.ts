import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore } from "./mlb-ledger-store";
import {
  buildMlbLedgerPredictionFromPick,
  findMlbSupersedesId,
} from "./mlb-scientific-snapshot";

function fullSnapshotPick() {
  const capturedAt = "2026-07-29T22:55:00.000Z";
  return {
    id: "scoped-retry-regression",
    ts: Date.parse(capturedAt),
    sport: "mlb" as const,
    homeTeam: "New York Yankees",
    awayTeam: "Boston Red Sox",
    pickType: "ML",
    pickSide: "New York Yankees ML",
    confidence: 50,
    edge: 0,
    odds: -110,
    date: "2026-07-29",
    modelProb: 50,
    impliedProb: 52.380952,
    stake: 0,
    source: "app" as const,
    scientificSnapshot: {
      schemaVersion: "mlb-scientific-snapshot.v1" as const,
      model: {
        name: "CourtEdge MLB",
        version: "scoped-retry-regression-v1",
        gitCommit: "test-commit",
        environment: "test",
      },
      game: {
        gamePk: 999001,
        gameDate: "2026-07-29",
        commenceTime: "2026-07-29T23:00:00.000Z",
        homeTeam: "New York Yankees",
        awayTeam: "Boston Red Sox",
        venue: "Regression Park",
      },
      market: {
        type: "ML" as const,
        selection: "New York Yankees ML",
        oddsAmerican: -110,
        book: "Regression Book",
        capturedAt,
      },
      probabilities: {
        model: 0.5,
        marketImplied: 110 / 210,
        noVig: 0.5,
        edgePp: 0,
      },
      decision: {
        signal: "INFO" as const,
        confidenceLabel: "TEST_ONLY",
        confidencePct: 50,
        stakeUnits: 0,
      },
      analysis: {
        stage: "FINAL" as const,
        warnings: ["TEST_ONLY"],
        sources: [{ name: "Fixture", status: "VERIFIED" as const }],
        rawInputs: { fixture: true },
        rawOutput: { recommendation: "INFO" },
      },
    },
  };
}

test("user-scoped clientRequestId remains an exact retry, not a supersession", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-scoped-retry-"));
  const store = new MlbLedgerStore(path.join(dir, "ledger.sqlite"));

  try {
    const unscoped = buildMlbLedgerPredictionFromPick(fullSnapshotPick());
    assert.ok(unscoped.clientRequestId);
    const scoped = {
      ...unscoped,
      clientRequestId: `u1:${unscoped.clientRequestId}`,
    };
    const first = store.appendPrediction(scoped);
    const records = store.listRecords();

    assert.equal(findMlbSupersedesId(records, unscoped), undefined);
    const retry = store.appendPrediction(scoped);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.data.id, first.data.id);

    const recalculation = {
      ...unscoped,
      clientRequestId: `${unscoped.clientRequestId}-changed`,
      probabilities: { ...unscoped.probabilities, model: 0.51 },
    };
    assert.equal(findMlbSupersedesId(records, recalculation), first.data.id);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
