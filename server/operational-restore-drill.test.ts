import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { OperationalBackupService } from "./operational-backup";
import { OperationalRestoreDrillService } from "./operational-restore-drill";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s4b-"));
  const ledger = path.join(root, "ledger.sqlite");
  const auth = path.join(root, "auth.sqlite");
  for (const file of [ledger, auth]) {
    const db = new Database(file);
    db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES('a'),('b');");
    db.close();
  }
  const picks = path.join(root, "picks.json");
  fs.writeFileSync(picks, JSON.stringify([{ id: 1 }, { id: 2 }]), "utf-8");
  const backups = new OperationalBackupService(path.join(root, "backups"), [
    { id: "mlb-ledger", kind: "sqlite", filename: ledger, required: true },
    { id: "auth", kind: "sqlite", filename: auth, required: true },
    { id: "picks", kind: "json", filename: picks, required: false },
  ]);
  return { root, ledger, backups, drills: new OperationalRestoreDrillService(backups) };
}

test("S4B restores a backup into isolation and validates table counts", async () => {
  const f = fixture();
  try {
    const backup = await f.backups.createBackup();
    const before = fs.statSync(f.ledger).mtimeMs;
    const result = f.drills.run(backup.backupId);
    assert.equal(result.valid, true);
    assert.equal(result.sourceUntouched, true);
    assert.equal(result.assets.find((asset) => asset.id === "mlb-ledger")?.tables?.sample, 2);
    assert.equal(result.assets.find((asset) => asset.id === "picks")?.records, 2);
    assert.equal(fs.statSync(f.ledger).mtimeMs, before);
    assert.equal(fs.readdirSync(f.backups.getRoot()).some((name) => name.startsWith(".restore-")), false);
    assert.equal(f.drills.status().drills, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("S4B refuses a restore drill for a corrupted backup", async () => {
  const f = fixture();
  try {
    const backup = await f.backups.createBackup();
    fs.appendFileSync(path.join(f.backups.getRoot(), backup.backupId, "picks.json"), "broken");
    assert.throws(() => f.drills.run(backup.backupId), /Backup verification failed/);
    assert.equal(f.drills.status().drills, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
