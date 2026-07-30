import crypto from "node:crypto";
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
