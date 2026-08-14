import crypto from "node:crypto";
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
