import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { OperationalBackupService } from "./operational-backup";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s4a-"));
  const data = path.join(root, "data");
  fs.mkdirSync(data, { recursive: true });
  const ledger = path.join(data, "ledger.sqlite");
  const auth = path.join(data, "auth.sqlite");
  for (const file of [ledger, auth]) {
    const db = new Database(file);
    db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO sample(value) VALUES('ok');");
    db.pragma("journal_mode = WAL");
    db.close();
  }
  const picks = path.join(data, "picks.json");
  fs.writeFileSync(picks, JSON.stringify([{ id: "p1" }]), "utf-8");
  const service = new OperationalBackupService(path.join(data, "backups"), [
    { id: "mlb-ledger", kind: "sqlite", filename: ledger, required: true },
    { id: "auth", kind: "sqlite", filename: auth, required: true },
    { id: "picks", kind: "json", filename: picks, required: false },
    { id: "optional", kind: "json", filename: path.join(data, "missing.json"), required: false },
  ]);
  return { root, ledger, picks, service };
}

test("S4A creates a consistent verified backup without WAL copying", async () => {
  const f = fixture();
  try {
    const manifest = await f.service.createBackup();
    assert.equal(manifest.verified, true);
    assert.equal(manifest.assets.filter((a) => a.present).length, 3);
    assert.equal(manifest.assets.find((a) => a.id === "optional")?.integrity, "MISSING_OPTIONAL");
    const verification = f.service.verifyBackup(manifest.backupId);
    assert.equal(verification.valid, true);
    const source = new Database(f.ledger);
    source.prepare("INSERT INTO sample(value) VALUES(?)").run("after-backup");
    source.close();
    const backed = new Database(path.join(f.service.getRoot(), manifest.backupId, "mlb-ledger.sqlite"), { readonly: true });
    assert.equal(backed.prepare("SELECT COUNT(*) AS n FROM sample").get().n, 1);
    backed.close();
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("S4A detects corrupted backup bytes", async () => {
  const f = fixture();
  try {
    const manifest = await f.service.createBackup();
    const file = path.join(f.service.getRoot(), manifest.backupId, "picks.json");
    fs.appendFileSync(file, "corruption");
    const verification = f.service.verifyBackup(manifest.backupId);
    assert.equal(verification.valid, false);
    assert.ok(verification.errors.some((error) => error.includes("picks")));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("S4A refuses to create a backup when a required asset is absent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s4a-required-"));
  try {
    const service = new OperationalBackupService(path.join(root, "backups"), [
      { id: "required", kind: "sqlite", filename: path.join(root, "missing.sqlite"), required: true },
    ]);
    await assert.rejects(() => service.createBackup(), /Required operational asset is missing/);
    assert.equal(service.listBackups().length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
