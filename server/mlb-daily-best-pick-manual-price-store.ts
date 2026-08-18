import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA,
  parseMlbDailyBestPickManualPriceContext,
  type MlbDailyBestPickManualPriceContext,
} from "./mlb-daily-best-pick-manual-price";

export const MLB_DAILY_BEST_PICK_MANUAL_PRICE_STORE_SCHEMA =
  "courtedge-mlb-daily-best-pick-manual-price-store.v1" as const;

function defaultDbPath(): string {
  return process.env.MLB_DAILY_BEST_PICK_PRICE_CONTINUITY_DB_PATH?.trim()
    || path.join(process.cwd(), "data", "mlb-daily-best-pick-price-continuity.sqlite");
}

function ensureParent(filename: string): void {
  if (filename === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

export class MlbDailyBestPickManualPriceStore {
  readonly schemaVersion = MLB_DAILY_BEST_PICK_MANUAL_PRICE_STORE_SCHEMA;
  private readonly sqlite: Database.Database;

  constructor(options: { filename?: string } = {}) {
    const filename = options.filename ?? defaultDbPath();
    ensureParent(filename);
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mlb_daily_best_pick_manual_price_context (
        run_id TEXT PRIMARY KEY,
        context_schema TEXT NOT NULL,
        date TEXT NOT NULL,
        game_pk INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        context_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mlb_daily_best_pick_manual_price_context_expiry
        ON mlb_daily_best_pick_manual_price_context(expires_at_ms);
    `);
  }

  close(): void {
    this.sqlite.close();
  }

  put(contextInput: MlbDailyBestPickManualPriceContext): void {
    const context = parseMlbDailyBestPickManualPriceContext(contextInput);
    if (!context) throw new Error("MLB_DAILY_BEST_PICK_MANUAL_PRICE_STORE_CONTEXT_INVALID");
    const expiresAtMs = Date.parse(context.expiresAt);
    const updatedAtMs = Date.now();
    this.prune(updatedAtMs);
    this.sqlite.prepare(`
      INSERT INTO mlb_daily_best_pick_manual_price_context
        (run_id, context_schema, date, game_pk, expires_at_ms, context_json, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        context_schema = excluded.context_schema,
        date = excluded.date,
        game_pk = excluded.game_pk,
        expires_at_ms = excluded.expires_at_ms,
        context_json = excluded.context_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      context.runId,
      MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA,
      context.date,
      context.pick.gamePk,
      expiresAtMs,
      JSON.stringify(context),
      updatedAtMs,
    );
  }

  get(runIdInput: string, nowMs = Date.now()): MlbDailyBestPickManualPriceContext | null {
    const runId = String(runIdInput ?? "").trim();
    if (!runId) return null;
    this.prune(nowMs);
    const row = this.sqlite.prepare(`
      SELECT context_schema, expires_at_ms, context_json
      FROM mlb_daily_best_pick_manual_price_context
      WHERE run_id = ?
    `).get(runId) as { context_schema: string; expires_at_ms: number; context_json: string } | undefined;
    if (!row) return null;
    if (row.context_schema !== MLB_DAILY_BEST_PICK_MANUAL_PRICE_CONTEXT_SCHEMA || row.expires_at_ms < nowMs) {
      this.delete(runId);
      return null;
    }
    try {
      const context = parseMlbDailyBestPickManualPriceContext(JSON.parse(row.context_json));
      if (!context || context.runId !== runId || Date.parse(context.expiresAt) !== row.expires_at_ms) {
        this.delete(runId);
        return null;
      }
      return context;
    } catch {
      this.delete(runId);
      return null;
    }
  }

  delete(runIdInput: string): void {
    const runId = String(runIdInput ?? "").trim();
    if (!runId) return;
    this.sqlite.prepare(`DELETE FROM mlb_daily_best_pick_manual_price_context WHERE run_id = ?`).run(runId);
  }

  prune(nowMs = Date.now()): number {
    const result = this.sqlite.prepare(`
      DELETE FROM mlb_daily_best_pick_manual_price_context
      WHERE expires_at_ms < ?
    `).run(nowMs);
    return result.changes;
  }
}
