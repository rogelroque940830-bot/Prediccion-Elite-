from pathlib import Path
import json

ROOT = Path('.')
SERVER = ROOT / 'server'

def write_new(path: Path, content: str):
    if path.exists():
        raise SystemExit(f'Refusing to overwrite {path}')
    path.write_text(content, encoding='utf-8')

module = r'''import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { OperationalBackupManifest, OperationalBackupService } from "./operational-backup";

export interface RestoreDrillAssetResult {
  id: string;
  kind: "sqlite" | "json";
  valid: boolean;
  tables?: Record<string, number>;
  jsonType?: "array" | "object" | "scalar";
  records?: number | null;
}

export interface RestoreDrillResult {
  schemaVersion: "courtedge-restore-drill.v1";
  drillId: string;
  backupId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  valid: boolean;
  sourceUntouched: true;
  assets: RestoreDrillAssetResult[];
}

function tableCounts(filename: string): Record<string, number> {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }) || "").toLowerCase();
    if (integrity !== "ok") throw new Error(`SQLite integrity_check failed: ${integrity}`);
    const rows = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const safe = row.name.replace(/"/g, '""');
      counts[row.name] = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${safe}"`).get() as any)?.n || 0);
    }
    return counts;
  } finally { db.close(); }
}

function parseJson(filename: string): { jsonType: "array" | "object" | "scalar"; records: number | null } {
  const value = JSON.parse(fs.readFileSync(filename, "utf-8"));
  if (Array.isArray(value)) return { jsonType: "array", records: value.length };
  if (value && typeof value === "object") return { jsonType: "object", records: Object.keys(value).length };
  return { jsonType: "scalar", records: null };
}

function appendDrillLog(root: string, result: RestoreDrillResult): void {
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(path.join(root, "restore-drills.jsonl"), `${JSON.stringify(result)}\n`, "utf-8");
}

export class OperationalRestoreDrillService {
  constructor(private readonly backups: OperationalBackupService) {}

  run(rawBackupId: string): RestoreDrillResult {
    const verification = this.backups.verifyBackup(rawBackupId);
    if (!verification.valid) throw Object.assign(new Error("Backup verification failed before restore drill"), { status: 409, details: verification.errors });
    const manifest: OperationalBackupManifest = verification.manifest;
    const startedAtMs = Date.now();
    const drillId = `restore-${startedAtMs}-${crypto.randomBytes(4).toString("hex")}`;
    const temporary = path.join(this.backups.getRoot(), `.restore-${drillId}`);
    fs.mkdirSync(temporary, { recursive: false });
    const assets: RestoreDrillAssetResult[] = [];

    try {
      for (const asset of manifest.assets) {
        if (!asset.present) continue;
        const source = path.join(this.backups.getRoot(), manifest.backupId, asset.filename);
        const restored = path.join(temporary, asset.filename);
        fs.copyFileSync(source, restored);
        if (asset.kind === "sqlite") {
          const tables = tableCounts(restored);
          assets.push({ id: asset.id, kind: asset.kind, valid: true, tables });
        } else {
          const parsed = parseJson(restored);
          assets.push({ id: asset.id, kind: asset.kind, valid: true, ...parsed });
        }
      }
      const completedAtMs = Date.now();
      const result: RestoreDrillResult = {
        schemaVersion: "courtedge-restore-drill.v1",
        drillId,
        backupId: manifest.backupId,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        valid: assets.every((asset) => asset.valid),
        sourceUntouched: true,
        assets,
      };
      appendDrillLog(this.backups.getRoot(), result);
      return result;
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  status(): { drills: number; latestDrillAt: string | null; latestValid: boolean | null; latestBackupId: string | null } {
    const file = path.join(this.backups.getRoot(), "restore-drills.jsonl");
    if (!fs.existsSync(file)) return { drills: 0, latestDrillAt: null, latestValid: null, latestBackupId: null };
    const rows = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as RestoreDrillResult]; } catch { return []; }
    });
    const latest = rows[rows.length - 1] || null;
    return { drills: rows.length, latestDrillAt: latest?.completedAt || null, latestValid: latest?.valid ?? null, latestBackupId: latest?.backupId || null };
  }
}

let singleton: OperationalRestoreDrillService | null = null;
export function getOperationalRestoreDrillService(backups: OperationalBackupService): OperationalRestoreDrillService {
  if (!singleton) singleton = new OperationalRestoreDrillService(backups);
  return singleton;
}
'''
write_new(SERVER / 'operational-restore-drill.ts', module)

routes = r'''import type { Express } from "express";
import { requireGlobalWorkerRole } from "./user-data-context";
import type { OperationalRestoreDrillService } from "./operational-restore-drill";

export function registerOperationalRestoreDrillRoutes(app: Express, service: OperationalRestoreDrillService): void {
  app.post("/api/ops/v1/backups/:id/restore-drill", requireGlobalWorkerRole, (req, res) => {
    try {
      const data = service.run(decodeURIComponent(String(req.params.id || "")));
      res.json({ success: data.valid, data });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || "Restore drill failed", details: error?.details });
    }
  });
}
'''
write_new(SERVER / 'operational-restore-routes.ts', routes)

test = r'''import assert from "node:assert/strict";
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
'''
write_new(SERVER / 'operational-restore-drill.test.ts', test)

# Patch index
index_path = SERVER / 'index.ts'
index = index_path.read_text(encoding='utf-8')
anchor = 'import { registerOperationalRoutes } from "./operational-routes";\n'
addition = anchor + 'import { getOperationalRestoreDrillService } from "./operational-restore-drill";\nimport { registerOperationalRestoreDrillRoutes } from "./operational-restore-routes";\n'
if index.count(anchor) != 1: raise SystemExit('S4B import anchor changed')
index = index.replace(anchor, addition, 1)
anchor2 = 'const operationalBackupService = getOperationalBackupService();\n'
index = index.replace(anchor2, anchor2 + 'const operationalRestoreDrillService = getOperationalRestoreDrillService(operationalBackupService);\n', 1)
anchor3 = '    operationalBackup: operationalBackupService.status(),\n'
index = index.replace(anchor3, anchor3 + '    operationalRestoreDrill: operationalRestoreDrillService.status(),\n', 1)
anchor4 = '  registerOperationalRoutes(app, operationalBackupService);\n'
index = index.replace(anchor4, anchor4 + '  registerOperationalRestoreDrillRoutes(app, operationalRestoreDrillService);\n', 1)
index_path.write_text(index, encoding='utf-8')

# Update package and tsconfig
package_path = ROOT / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package['scripts']['test:s4-operations'] = 'tsx --test server/operational-backup.test.ts server/operational-restore-drill.test.ts'
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

config_path = ROOT / 'tsconfig.s4-operations.json'
config = json.loads(config_path.read_text(encoding='utf-8'))
for item in ['server/operational-restore-drill.ts','server/operational-restore-routes.ts','server/operational-restore-drill.test.ts']:
    if item not in config['include']: config['include'].append(item)
config_path.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')

contract_path = SERVER / 'route-contract.snapshot.json'
contract = json.loads(contract_path.read_text(encoding='utf-8'))
entry = {'method':'POST','path':'/api/ops/v1/backups/:id/restore-drill','registrations':1}
if any(item['method']==entry['method'] and item['path']==entry['path'] for item in contract):
    raise SystemExit('S4B route already present in contract')
contract.append(entry)
contract.sort(key=lambda item: (item['method'], item['path']))
contract_path.write_text(json.dumps(contract, indent=2) + '\n', encoding='utf-8')
