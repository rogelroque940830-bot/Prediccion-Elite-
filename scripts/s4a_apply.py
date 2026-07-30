from pathlib import Path
import json

ROOT = Path('.')
SERVER = ROOT / 'server'

def write_new(path: Path, content: str):
    if path.exists():
        raise SystemExit(f'Refusing to overwrite {path}')
    path.write_text(content, encoding='utf-8')

backup = r'''import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const OPERATIONAL_BACKUP_SCHEMA_VERSION = "courtedge-backup.v1" as const;

type AssetKind = "sqlite" | "json";

export interface OperationalAsset {
  id: string;
  kind: AssetKind;
  filename: string;
  required: boolean;
}

export interface BackupAssetManifest {
  id: string;
  kind: AssetKind;
  filename: string;
  required: boolean;
  present: boolean;
  bytes: number;
  sha256: string | null;
  integrity: "OK" | "MISSING_OPTIONAL";
}

export interface OperationalBackupManifest {
  schemaVersion: typeof OPERATIONAL_BACKUP_SCHEMA_VERSION;
  backupId: string;
  createdAt: string;
  createdAtMs: number;
  commit: string;
  environment: string;
  assets: BackupAssetManifest[];
  verified: true;
}

function dataPath(name: string): string {
  return path.join(process.cwd(), "data", name);
}

export function defaultOperationalAssets(): OperationalAsset[] {
  return [
    { id: "mlb-ledger", kind: "sqlite", filename: process.env.MLB_LEDGER_DB_PATH || dataPath("mlb-ledger-v1.sqlite"), required: true },
    { id: "auth", kind: "sqlite", filename: process.env.COURTEDGE_AUTH_DB_PATH || dataPath("courtedge-auth.sqlite"), required: true },
    { id: "picks", kind: "json", filename: process.env.COURTEDGE_PICKS_FILE || dataPath("picks.json"), required: false },
    { id: "legacy-picks", kind: "json", filename: dataPath("picks-data.json"), required: false },
    { id: "line-history", kind: "json", filename: dataPath("line-history.json"), required: false },
  ];
}

function backupRoot(): string {
  return process.env.COURTEDGE_BACKUP_DIR || dataPath("backups");
}

function sha256File(filename: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes = 0;
    do {
      bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes > 0) hash.update(buffer.subarray(0, bytes));
    } while (bytes > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function validateJson(filename: string): void {
  JSON.parse(fs.readFileSync(filename, "utf-8"));
}

function validateSqlite(filename: string): void {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const result = String(db.pragma("integrity_check", { simple: true }) || "").toLowerCase();
    if (result !== "ok") throw new Error(`SQLite integrity_check failed for ${path.basename(filename)}: ${result}`);
  } finally {
    db.close();
  }
}

function validateAsset(kind: AssetKind, filename: string): void {
  if (kind === "sqlite") validateSqlite(filename);
  else validateJson(filename);
}

function safeBackupId(value: string): string {
  if (!/^[A-Za-z0-9._-]{8,120}$/.test(value)) throw Object.assign(new Error("Invalid backup id"), { status: 400 });
  return value;
}

function generatedBackupId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

export class OperationalBackupService {
  private running: Promise<OperationalBackupManifest> | null = null;

  constructor(
    private readonly root = backupRoot(),
    private readonly assets = defaultOperationalAssets(),
  ) {}

  getRoot(): string { return this.root; }

  async createBackup(): Promise<OperationalBackupManifest> {
    if (this.running) return this.running;
    this.running = this.createBackupInternal();
    try { return await this.running; }
    finally { this.running = null; }
  }

  private async createBackupInternal(): Promise<OperationalBackupManifest> {
    fs.mkdirSync(this.root, { recursive: true });
    const createdAtMs = Date.now();
    const backupId = generatedBackupId(new Date(createdAtMs));
    const temporary = path.join(this.root, `.tmp-${backupId}`);
    const destination = path.join(this.root, backupId);
    fs.mkdirSync(temporary, { recursive: false });

    try {
      const manifests: BackupAssetManifest[] = [];
      for (const asset of this.assets) {
        const present = fs.existsSync(asset.filename);
        if (!present) {
          if (asset.required) throw new Error(`Required operational asset is missing: ${asset.id}`);
          manifests.push({ id: asset.id, kind: asset.kind, filename: path.basename(asset.filename), required: false, present: false, bytes: 0, sha256: null, integrity: "MISSING_OPTIONAL" });
          continue;
        }

        const outputName = `${asset.id}${asset.kind === "sqlite" ? ".sqlite" : ".json"}`;
        const output = path.join(temporary, outputName);
        if (asset.kind === "sqlite") {
          const db = new Database(asset.filename, { readonly: true, fileMustExist: true });
          try { await db.backup(output); }
          finally { db.close(); }
        } else {
          fs.copyFileSync(asset.filename, output);
        }
        validateAsset(asset.kind, output);
        const stat = fs.statSync(output);
        manifests.push({ id: asset.id, kind: asset.kind, filename: outputName, required: asset.required, present: true, bytes: stat.size, sha256: sha256File(output), integrity: "OK" });
      }

      const manifest: OperationalBackupManifest = {
        schemaVersion: OPERATIONAL_BACKUP_SCHEMA_VERSION,
        backupId,
        createdAt: new Date(createdAtMs).toISOString(),
        createdAtMs,
        commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "unknown",
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || "unknown",
        assets: manifests,
        verified: true,
      };
      fs.writeFileSync(path.join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
      fs.renameSync(temporary, destination);
      this.prune();
      return manifest;
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  listBackups(): OperationalBackupManifest[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".tmp-"))
      .flatMap((entry) => {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(this.root, entry.name, "manifest.json"), "utf-8"));
          return raw?.schemaVersion === OPERATIONAL_BACKUP_SCHEMA_VERSION ? [raw as OperationalBackupManifest] : [];
        } catch { return []; }
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  verifyBackup(rawId: string): { valid: boolean; manifest: OperationalBackupManifest; errors: string[] } {
    const backupId = safeBackupId(rawId);
    const directory = path.join(this.root, backupId);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf-8")) as OperationalBackupManifest;
    const errors: string[] = [];
    if (manifest.schemaVersion !== OPERATIONAL_BACKUP_SCHEMA_VERSION || manifest.backupId !== backupId) errors.push("Manifest identity mismatch");
    for (const asset of manifest.assets) {
      if (!asset.present) continue;
      const filename = path.join(directory, asset.filename);
      if (!fs.existsSync(filename)) { errors.push(`${asset.id}: missing backup file`); continue; }
      const stat = fs.statSync(filename);
      if (stat.size !== asset.bytes) errors.push(`${asset.id}: byte size mismatch`);
      if (sha256File(filename) !== asset.sha256) errors.push(`${asset.id}: sha256 mismatch`);
      try { validateAsset(asset.kind, filename); }
      catch (error: any) { errors.push(`${asset.id}: ${error?.message || "integrity failure"}`); }
    }
    return { valid: errors.length === 0, manifest, errors };
  }

  status() {
    const latest = this.listBackups()[0] || null;
    const verification = latest ? this.verifyBackup(latest.backupId) : null;
    return {
      enabled: process.env.COURTEDGE_BACKUP_ENABLED !== "false",
      schemaVersion: OPERATIONAL_BACKUP_SCHEMA_VERSION,
      backups: this.listBackups().length,
      latestBackupAt: latest?.createdAt || null,
      latestBackupId: latest?.backupId || null,
      latestVerified: verification?.valid ?? false,
      latestAgeHours: latest ? Math.round(((Date.now() - latest.createdAtMs) / 3_600_000) * 10) / 10 : null,
      assets: latest?.assets.length || this.assets.length,
    };
  }

  prune(retention = Number(process.env.COURTEDGE_BACKUP_RETENTION_COUNT || 14)): void {
    const keep = Number.isInteger(retention) && retention >= 2 ? retention : 14;
    for (const backup of this.listBackups().slice(keep)) {
      fs.rmSync(path.join(this.root, backup.backupId), { recursive: true, force: true });
    }
  }
}

let singleton: OperationalBackupService | null = null;
export function getOperationalBackupService(): OperationalBackupService {
  if (!singleton) singleton = new OperationalBackupService();
  return singleton;
}
'''
write_new(SERVER / 'operational-backup.ts', backup)

worker = r'''import type { OperationalBackupService } from "./operational-backup";

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}

export function startOperationalBackupWorker(service: OperationalBackupService): NodeJS.Timeout | null {
  if (process.env.COURTEDGE_BACKUP_ENABLED === "false") return null;
  const intervalMs = positiveMs(process.env.COURTEDGE_BACKUP_INTERVAL_MS, 24 * 60 * 60 * 1000);
  const run = async () => {
    try {
      const latest = service.listBackups()[0];
      if (!latest || Date.now() - latest.createdAtMs >= intervalMs) await service.createBackup();
    } catch (error) {
      console.error("[s4] operational backup failed", error);
    }
  };
  const initial = setTimeout(run, 30_000);
  initial.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
'''
write_new(SERVER / 'operational-backup-worker.ts', worker)

routes = r'''import type { Express } from "express";
import { requireGlobalWorkerRole } from "./user-data-context";
import type { OperationalBackupService } from "./operational-backup";

export function registerOperationalRoutes(app: Express, service: OperationalBackupService): void {
  app.get("/api/ops/v1/status", (_req, res) => {
    res.json({ success: true, data: service.status() });
  });

  app.get("/api/ops/v1/backups", (_req, res) => {
    res.json({ success: true, data: service.listBackups() });
  });

  app.post("/api/ops/v1/backups", requireGlobalWorkerRole, async (_req, res) => {
    try {
      const data = await service.createBackup();
      res.status(201).json({ success: true, data });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || "Backup failed" });
    }
  });

  app.post("/api/ops/v1/backups/:id/verify", requireGlobalWorkerRole, (req, res) => {
    try {
      const data = service.verifyBackup(decodeURIComponent(req.params.id || ""));
      res.status(data.valid ? 200 : 409).json({ success: data.valid, data });
    } catch (error: any) {
      res.status(error?.status || 404).json({ success: false, error: error?.message || "Backup not found" });
    }
  });
}
'''
write_new(SERVER / 'operational-routes.ts', routes)

test = r'''import assert from "node:assert/strict";
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
'''
write_new(SERVER / 'operational-backup.test.ts', test)

# Patch security
security_path = SERVER / 'security.ts'
security = security_path.read_text(encoding='utf-8')
security = security.replace('  /^\\/api\\/mlb\\/ledger(?:\\/|$)/,\n];', '  /^\\/api\\/mlb\\/ledger(?:\\/|$)/,\n  /^\\/api\\/ops(?:\\/|$)/,\n];', 1)
security = security.replace('  /^\\/api\\/auth\\/users(?:\\/|$)/,\n];', '  /^\\/api\\/auth\\/users(?:\\/|$)/,\n  /^\\/api\\/ops(?:\\/|$)/,\n];', 1)
if security.count('/^\\/api\\/ops') != 2:
    raise SystemExit('Failed to protect ops routes')
security_path.write_text(security, encoding='utf-8')

# Patch index
index_path = SERVER / 'index.ts'
index = index_path.read_text(encoding='utf-8')
anchor = 'import { startMlbClosingLineWorker } from "./mlb-closing-line-worker";\n'
addition = anchor + 'import { getOperationalBackupService } from "./operational-backup";\nimport { startOperationalBackupWorker } from "./operational-backup-worker";\nimport { registerOperationalRoutes } from "./operational-routes";\n'
if index.count(anchor) != 1: raise SystemExit('index import anchor changed')
index = index.replace(anchor, addition, 1)
anchor2 = 'const pickOwnershipMigration = userPickStore.migrationStatus(systemOwnerUserId);\n'
index = index.replace(anchor2, anchor2 + 'const operationalBackupService = getOperationalBackupService();\n', 1)
anchor3 = '    pickOwnership: pickOwnershipMigration,\n'
index = index.replace(anchor3, anchor3 + '    operationalBackup: operationalBackupService.status(),\n', 1)
anchor4 = '  registerMlbLedgerMultiuserRoutes(app);\n'
index = index.replace(anchor4, anchor4 + '  registerOperationalRoutes(app, operationalBackupService);\n', 1)
anchor5 = '  startMlbSettlementWorker(mlbLedgerStore, mlbClosingLineStore);\n'
index = index.replace(anchor5, anchor5 + '  startOperationalBackupWorker(operationalBackupService);\n', 1)
for token in ['getOperationalBackupService', 'registerOperationalRoutes', 'startOperationalBackupWorker', 'operationalBackup:']:
    if token not in index: raise SystemExit(f'index patch missing {token}')
index_path.write_text(index, encoding='utf-8')

# package + tsconfig
package_path = ROOT / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package['scripts']['test:s4-operations'] = 'tsx --test server/operational-backup.test.ts'
package['scripts']['typecheck:s4-operations'] = 'tsc -p tsconfig.s4-operations.json'
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

config = {
  'extends': './tsconfig.json',
  'include': [
    'server/operational-backup.ts',
    'server/operational-backup-worker.ts',
    'server/operational-routes.ts',
    'server/operational-backup.test.ts',
    'server/user-data-context.ts',
  ],
  'exclude': ['node_modules', 'dist'],
  'compilerOptions': {'target': 'ES2020', 'noEmit': True},
}
write_new(ROOT / 'tsconfig.s4-operations.json', json.dumps(config, indent=2) + '\n')
print(json.dumps({'created': ['operational-backup.ts','operational-backup-worker.ts','operational-routes.ts','operational-backup.test.ts','tsconfig.s4-operations.json']}, indent=2))
