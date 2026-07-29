import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { MlbLedgerStore } from "./mlb-ledger-store";
import {
  MlbLedgerOwnershipStore,
  appendOwnedPrediction,
  appendOwnedSettlement,
  getOwnedRecord,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";

function prediction(clientRequestId: string) {
  return {
    schemaVersion: "mlb-ledger.v1" as const,
    clientRequestId,
    source: "app" as const,
    model: { name: "S2 Test", version: "1.0.0" },
    game: {
      gamePk: 999001,
      gameDate: "2026-07-29",
      commenceTime: "2026-07-30T00:00:00.000Z",
      homeTeam: "Home",
      awayTeam: "Away",
    },
    market: {
      type: "ML" as const,
      selection: "Home",
      oddsAmerican: -120,
      book: "Test Book",
      capturedAt: "2026-07-29T18:00:00.000Z",
    },
    probabilities: { model: 0.58, marketImplied: 0.5455, edgePp: 3.45 },
    decision: { signal: "BET" as const, stakeUnits: 1 },
    analysis: { stage: "FINAL" as const },
  };
}

test("S2 isolates identical client ids by user and blocks cross-user settlement", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-ledger-"));
  const filename = path.join(dir, "ledger.sqlite");
  const store = new MlbLedgerStore(filename);
  const ownership = new MlbLedgerOwnershipStore(filename);

  try {
    const first = appendOwnedPrediction(store, ownership, prediction("same-request"), 1);
    const second = appendOwnedPrediction(store, ownership, prediction("same-request"), 2);

    assert.notEqual(first.data.id, second.data.id);
    assert.equal(ownedRecordsForUser(store, ownership, 1).length, 1);
    assert.equal(ownedRecordsForUser(store, ownership, 2).length, 1);
    assert.equal(getOwnedRecord(store, ownership, 2, first.data.id), null);

    assert.throws(
      () => appendOwnedSettlement(store, ownership, first.data.id, {
        result: "WIN",
        source: "manual",
      }, 2),
      /Prediction not found/,
    );

    const settlement = appendOwnedSettlement(store, ownership, first.data.id, {
      clientRequestId: "grade-1",
      result: "WIN",
      source: "manual",
    }, 1);
    assert.equal(settlement.data.result, "WIN");
    assert.equal(ownedRecordsForUser(store, ownership, 1, { settled: true }).length, 1);
  } finally {
    ownership.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 migrates legacy predictions without changing immutable payloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-migration-"));
  const filename = path.join(dir, "ledger.sqlite");
  const store = new MlbLedgerStore(filename);

  try {
    const legacy = store.appendPrediction(prediction("legacy-request")).data;
    const before = store.getRecord(legacy.id)!;
    const ownership = new MlbLedgerOwnershipStore(filename);

    try {
      const migration = ownership.ensureExistingOwnership(store, 7);
      assert.equal(migration.migrated, 1);
      assert.equal(migration.remainingUnowned, 0);
      const after = getOwnedRecord(store, ownership, 7, legacy.id)!;
      assert.equal(after.prediction.payloadSha256, before.prediction.payloadSha256);
      assert.deepEqual(after.prediction.payload, before.prediction.payload);
      assert.equal(after.ownership.userId, 7);
      assert.equal(after.ownership.source, "migration");

      const sqlite = new Database(filename);
      try {
        assert.throws(
          () => sqlite.prepare(
            "UPDATE mlb_prediction_owners_v1 SET user_id = 8 WHERE prediction_id = ?",
          ).run(legacy.id),
          /immutable/,
        );
      } finally {
        sqlite.close();
      }
    } finally {
      ownership.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
