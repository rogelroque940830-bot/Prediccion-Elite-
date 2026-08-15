import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  MlbBatterProspectiveCustodySaveResult,
  MlbBatterProspectiveCustodySnapshot,
  MlbBatterProspectiveCustodyStore,
} from "./mlb-batter-prospective-custody";

export const MLB_BATTER_PROSPECTIVE_CUSTODY_SQLITE_SCHEMA =
  "courtedge-p0-mlb-batter-prospective-custody-sqlite.v1" as const;

function defaultDbPath(): string {
  return process.env.MLB_BATTER_PROSPECTIVE_CUSTODY_DB_PATH?.trim()
    || path.join(process.cwd(), "data", "mlb-batter-prospective-custody.sqlite");
}

function ensureParent(filename: string): void {
  if (filename === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function positiveGamePk(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_STORE_GAME_PK_INVALID");
  return parsed;
}

function parseSnapshot(raw: unknown): MlbBatterProspectiveCustodySnapshot {
  const parsed = JSON.parse(String(raw)) as MlbBatterProspectiveCustodySnapshot;
  if (!parsed || parsed.schemaVersion !== "courtedge-p0-mlb-batter-prospective-custody.v1") {
    throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_STORE_SNAPSHOT_INVALID");
  }
  return parsed;
}

export class MlbBatterProspectiveCustodySqliteStore implements MlbBatterProspectiveCustodyStore {
  private readonly sqlite: Database.Database;

  constructor(options: { filename?: string } = {}) {
    const filename = options.filename ?? defaultDbPath();
    ensureParent(filename);
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mlb_batter_prospective_custody_games (
        game_pk INTEGER PRIMARY KEY,
        official_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        source_identity_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mlb_batter_prospective_custody_date
        ON mlb_batter_prospective_custody_games(official_date, game_pk);
    `);
  }

  getCanonicalGame(gamePk: number): MlbBatterProspectiveCustodySnapshot | null {
    const id = positiveGamePk(gamePk);
    const row = this.sqlite.prepare(`
      SELECT snapshot_json
      FROM mlb_batter_prospective_custody_games
      WHERE game_pk = ?
    `).get(id) as any;
    return row ? parseSnapshot(row.snapshot_json) : null;
  }

  saveCanonicalGame(snapshot: MlbBatterProspectiveCustodySnapshot): MlbBatterProspectiveCustodySaveResult {
    const gamePk = positiveGamePk(snapshot.gamePk);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.officialDate)) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_STORE_DATE_INVALID");
    if (!Number.isFinite(Date.parse(snapshot.startTime))) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_STORE_START_TIME_INVALID");
    if (!Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_STORE_CAPTURED_AT_INVALID");
    if (!/^[a-f0-9]{64}$/.test(snapshot.sourceIdentityDigest)) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_STORE_DIGEST_INVALID");

    return this.sqlite.transaction((): MlbBatterProspectiveCustodySaveResult => {
      const result = this.sqlite.prepare(`
        INSERT OR IGNORE INTO mlb_batter_prospective_custody_games
          (game_pk, official_date, start_time, captured_at, source_identity_digest, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        gamePk,
        snapshot.officialDate,
        snapshot.startTime,
        snapshot.capturedAt,
        snapshot.sourceIdentityDigest,
        JSON.stringify(snapshot),
      );

      if (result.changes === 1) {
        return { status: "SAVED", snapshot: structuredClone(snapshot) };
      }

      const existing = this.getCanonicalGame(gamePk);
      if (!existing) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_STORE_DUPLICATE_WITHOUT_ROW");
      return { status: "EXISTS", snapshot: existing };
    })();
  }

  listCanonicalGames(): MlbBatterProspectiveCustodySnapshot[] {
    return (this.sqlite.prepare(`
      SELECT snapshot_json
      FROM mlb_batter_prospective_custody_games
      ORDER BY official_date ASC, game_pk ASC
    `).all() as any[]).map((row) => parseSnapshot(row.snapshot_json));
  }
}
