import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UserPickFileStore } from "./picks-v2-multiuser";

function legacyPick(id: string) {
  return {
    id,
    ts: 1_753_815_600_000,
    sport: "mlb" as const,
    homeTeam: "Detroit Tigers",
    awayTeam: "Baltimore Orioles",
    pickType: "ML",
    pickSide: "Detroit Tigers",
    confidence: 67.8,
    odds: -140,
  };
}

test("S2 migrates legacy picks to the bootstrap owner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-picks-"));
  const filename = path.join(dir, "picks.json");
  fs.writeFileSync(
    filename,
    JSON.stringify([legacyPick("legacy-1"), legacyPick("legacy-2")], null, 2),
    "utf-8",
  );
  const store = new UserPickFileStore(filename);

  try {
    const migrated = store.load(9);
    assert.equal(migrated.length, 2);
    assert.deepEqual(migrated.map((pick) => pick.userId), [9, 9]);
    const disk = JSON.parse(fs.readFileSync(filename, "utf-8"));
    assert.deepEqual(disk.map((pick: any) => pick.userId), [9, 9]);
    assert.deepEqual(store.migrationStatus(9), {
      records: 2,
      owners: 1,
      unowned: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 scopes list, patch and delete operations to the current user", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s2-pick-isolation-"));
  const filename = path.join(dir, "picks.json");
  const store = new UserPickFileStore(filename);

  try {
    store.upsert(legacyPick("shared-id"), 1, 1);
    store.upsert({ ...legacyPick("shared-id"), confidence: 61 }, 2, 1);

    assert.equal(store.listForUser(1, 1).length, 1);
    assert.equal(store.listForUser(2, 1).length, 1);
    assert.equal(store.listForUser(1, 1)[0].confidence, 67.8);
    assert.equal(store.listForUser(2, 1)[0].confidence, 61);

    const patched = store.patch("shared-id", 2, { confidence: 73 }, 1);
    assert.equal(patched?.confidence, 73);
    assert.equal(store.listForUser(1, 1)[0].confidence, 67.8);

    assert.equal(store.delete("shared-id", 3, 1), false);
    assert.equal(store.delete("shared-id", 2, 1), true);
    assert.equal(store.listForUser(1, 1).length, 1);
    assert.equal(store.listForUser(2, 1).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
