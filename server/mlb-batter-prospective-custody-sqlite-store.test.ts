import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_BATTER_PROSPECTIVE_CUSTODY_SCHEMA,
  type MlbBatterProspectiveCustodySnapshot,
} from "./mlb-batter-prospective-custody";
import { MlbBatterProspectiveCustodySqliteStore } from "./mlb-batter-prospective-custody-sqlite-store";

function snapshot(overrides: Partial<MlbBatterProspectiveCustodySnapshot> = {}): MlbBatterProspectiveCustodySnapshot {
  return {
    schemaVersion: MLB_BATTER_PROSPECTIVE_CUSTODY_SCHEMA,
    gamePk: 880001,
    officialDate: "2026-08-15",
    startTime: "2026-08-15T23:10:00.000Z",
    capturedAt: "2026-08-15T20:00:00.000Z",
    homeTeamId: 101,
    awayTeamId: 202,
    homeProbablePitcherId: 301,
    awayProbablePitcherId: 302,
    homeBattingOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    awayBattingOrder: [11, 12, 13, 14, 15, 16, 17, 18, 19],
    source: {
      name: "MLB_STATS_API",
      endpoint: "https://statsapi.mlb.com/api/v1.1/game/880001/feed/live",
      fetchedAt: "2026-08-15T20:00:00.000Z",
    },
    sourceIdentityDigest: "a".repeat(64),
    ...overrides,
  };
}

test("V56 SQLite preserves the first canonical snapshot for a gamePk", () => {
  const store = new MlbBatterProspectiveCustodySqliteStore({ filename: ":memory:" });
  try {
    const first = snapshot();
    const saved = store.saveCanonicalGame(first);
    assert.equal(saved.status, "SAVED");
    assert.deepEqual(store.getCanonicalGame(first.gamePk), first);

    const changed = snapshot({
      capturedAt: "2026-08-15T20:20:00.000Z",
      homeBattingOrder: [9, 8, 7, 6, 5, 4, 3, 2, 1],
      sourceIdentityDigest: "b".repeat(64),
    });
    const duplicate = store.saveCanonicalGame(changed);
    assert.equal(duplicate.status, "EXISTS");
    assert.deepEqual(duplicate.snapshot, first);
    assert.deepEqual(store.getCanonicalGame(first.gamePk), first);
    assert.equal(store.listCanonicalGames().length, 1);
  } finally {
    store.close();
  }
});

test("V56 SQLite keeps different gamePks as separate canonical rows", () => {
  const store = new MlbBatterProspectiveCustodySqliteStore({ filename: ":memory:" });
  try {
    store.saveCanonicalGame(snapshot());
    store.saveCanonicalGame(snapshot({
      gamePk: 880002,
      officialDate: "2026-08-16",
      startTime: "2026-08-16T23:10:00.000Z",
      capturedAt: "2026-08-16T20:00:00.000Z",
      source: {
        name: "MLB_STATS_API",
        endpoint: "https://statsapi.mlb.com/api/v1.1/game/880002/feed/live",
        fetchedAt: "2026-08-16T20:00:00.000Z",
      },
      sourceIdentityDigest: "c".repeat(64),
    }));
    assert.deepEqual(store.listCanonicalGames().map((row) => row.gamePk), [880001, 880002]);
  } finally {
    store.close();
  }
});
