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


test("S2 retries a migrated raw clientRequestId without duplicating", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-idempotency-"));
  const filename = path.join(dir, "ledger.sqlite");
  const store = new MlbLedgerStore(filename);

  try {
    const legacy = store.appendPrediction(prediction("legacy-idempotent")).data;
    const ownership = new MlbLedgerOwnershipStore(filename);
    try {
      ownership.ensureExistingOwnership(store, 11);
      const retry = appendOwnedPrediction(
        store,
        ownership,
        prediction("legacy-idempotent"),
        11,
      );
      assert.equal(retry.idempotent, true);
      assert.equal(retry.data.id, legacy.id);
      assert.equal(store.status().predictions, 1);
      assert.equal(ownedRecordsForUser(store, ownership, 11).length, 1);
    } finally {
      ownership.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 migrates every unowned ledger row beyond the historical 10000 limit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-large-migration-"));
  const filename = path.join(dir, "ledger.sqlite");
  const store = new MlbLedgerStore(filename);

  try {
    store.appendPrediction(prediction("bulk-anchor"));
    const sqlite = new Database(filename);
    try {
      sqlite.exec(`
        WITH digits(d) AS (
          VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
        ), nums(n) AS (
          SELECT a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000 + 1
          FROM digits a, digits b, digits c, digits d, digits e
          WHERE a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000 < 10005
        )
        INSERT INTO mlb_prediction_ledger_v1 (
          id, client_request_id, recorded_at_ms, game_pk, game_date, commence_time,
          home_team, away_team, market_type, selection, line, odds_american, book,
          model_prob, market_implied_prob, no_vig_prob, edge_pp, signal,
          confidence_label, confidence_pct, stake_units, analysis_stage,
          model_name, model_version, git_commit, environment, supersedes_id,
          source, payload_sha256, payload_json
        )
        SELECT
          'bulk-' || n, NULL, 1753815600000 + n, NULL, '2026-07-29', NULL,
          'Home', 'Away', 'ML', 'Home', NULL, -110, NULL,
          0.55, 0.52381, NULL, 2.619, 'BET',
          NULL, NULL, 1, 'FINAL',
          'Bulk', '1.0.0', NULL, NULL, NULL,
          'migration', 'hash-' || n, '{}'
        FROM nums;
      `);
    } finally {
      sqlite.close();
    }

    const ownership = new MlbLedgerOwnershipStore(filename);
    try {
      const migration = ownership.ensureExistingOwnership(store, 13);
      assert.ok(migration.scanned > 10000);
      assert.equal(migration.remainingUnowned, 0);
      assert.equal(ownership.status().assignments, store.status().predictions);
    } finally {
      ownership.close();
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 prediction routes preserve the LedgerRecord response contract", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "server", "mlb-ledger-multiuser.ts"),
    "utf-8",
  );
  assert.match(source, /data: records/);
  assert.match(source, /data: record/);
  assert.doesNotMatch(source, /data: records\.map\(\(record\) => \(\{ \.\.\.record\.prediction/);
});
