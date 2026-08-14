import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  MlbTeamTotalShadowCaptureResult,
  MlbTeamTotalShadowGameResult,
  MlbTeamTotalShadowRunAdmission,
  MlbTeamTotalShadowStore,
} from "./mlb-team-total-shadow-capture";

export const MLB_TEAM_TOTAL_SHADOW_SQLITE_STORE_SCHEMA =
  "courtedge-p0-mlb-team-total-shadow-sqlite-store.v1" as const;

function defaultDbPath(): string {
  return process.env.MLB_ODDS_COORDINATOR_DB_PATH?.trim()
    || path.join(process.cwd(), "data", "mlb-odds-coordinator.sqlite");
}

function ensureParent(filename: string): void {
  if (filename === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export class MlbTeamTotalShadowSqliteStore implements MlbTeamTotalShadowStore {
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
      CREATE TABLE IF NOT EXISTS mlb_team_total_shadow_runs (
        provider_account_scope_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
        admitted_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        result_json TEXT,
        PRIMARY KEY (provider_account_scope_key, run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mlb_team_total_shadow_runs_expiry
        ON mlb_team_total_shadow_runs(provider_account_scope_key, expires_at_ms);

      CREATE TABLE IF NOT EXISTS mlb_team_total_shadow_canonical_games (
        provider_account_scope_key TEXT NOT NULL,
        game_pk INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        result_json TEXT NOT NULL,
        PRIMARY KEY (provider_account_scope_key, game_pk)
      );

      CREATE INDEX IF NOT EXISTS idx_mlb_team_total_shadow_capture_run
        ON mlb_team_total_shadow_canonical_games(provider_account_scope_key, run_id);
    `);
  }

  beginRun(input: {
    providerAccountScopeKey: string;
    runId: string;
    fingerprint: string;
    nowMs: number;
    expiresAtMs: number;
  }): MlbTeamTotalShadowRunAdmission {
    const account = clean(input.providerAccountScopeKey);
    const runId = clean(input.runId);
    const fingerprint = clean(input.fingerprint);
    if (!account || !runId || !fingerprint) throw new Error("MLB_TEAM_TOTAL_SHADOW_STORE_RUN_IDENTITY_INVALID");

    return this.sqlite.transaction((): MlbTeamTotalShadowRunAdmission => {
      this.sqlite.prepare(`
        DELETE FROM mlb_team_total_shadow_runs
        WHERE provider_account_scope_key = ? AND expires_at_ms <= ?
      `).run(account, input.nowMs);
      const existing = this.sqlite.prepare(`
        SELECT fingerprint, state, result_json
        FROM mlb_team_total_shadow_runs
        WHERE provider_account_scope_key = ? AND run_id = ?
      `).get(account, runId) as any;
      if (existing) {
        if (String(existing.fingerprint) !== fingerprint) return { status: "FINGERPRINT_MISMATCH" };
        if (String(existing.state) === "COMPLETED") {
          return {
            status: "COMPLETED",
            result: JSON.parse(String(existing.result_json)) as MlbTeamTotalShadowCaptureResult,
          };
        }
        return { status: "IN_PROGRESS" };
      }
      this.sqlite.prepare(`
        INSERT INTO mlb_team_total_shadow_runs
          (provider_account_scope_key, run_id, fingerprint, state, admitted_at_ms, expires_at_ms, result_json)
        VALUES (?, ?, ?, 'IN_PROGRESS', ?, ?, NULL)
      `).run(account, runId, fingerprint, input.nowMs, input.expiresAtMs);
      return { status: "ADMITTED" };
    })();
  }

  hasCanonicalGameCapture(providerAccountScopeKey: string, gamePk: number): boolean {
    const account = clean(providerAccountScopeKey);
    if (!account || !Number.isInteger(gamePk) || gamePk <= 0) throw new Error("MLB_TEAM_TOTAL_SHADOW_STORE_GAME_IDENTITY_INVALID");
    const row = this.sqlite.prepare(`
      SELECT 1 AS present FROM mlb_team_total_shadow_canonical_games
      WHERE provider_account_scope_key = ? AND game_pk = ?
    `).get(account, gamePk) as any;
    return Boolean(row?.present);
  }

  saveCanonicalGameCapture(input: {
    providerAccountScopeKey: string;
    runId: string;
    gamePk: number;
    capturedAt: string;
    result: MlbTeamTotalShadowGameResult;
  }): void {
    const account = clean(input.providerAccountScopeKey);
    const runId = clean(input.runId);
    if (!account || !runId || !Number.isInteger(input.gamePk) || input.gamePk <= 0) {
      throw new Error("MLB_TEAM_TOTAL_SHADOW_STORE_CAPTURE_IDENTITY_INVALID");
    }
    if (!Number.isFinite(Date.parse(input.capturedAt))) throw new Error("MLB_TEAM_TOTAL_SHADOW_STORE_CAPTURE_TIME_INVALID");
    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO mlb_team_total_shadow_canonical_games
        (provider_account_scope_key, game_pk, run_id, captured_at, result_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(account, input.gamePk, runId, new Date(input.capturedAt).toISOString(), JSON.stringify(input.result));
    if (result.changes !== 1) throw new Error("MLB_TEAM_TOTAL_SHADOW_CANONICAL_CAPTURE_ALREADY_EXISTS");
  }

  completeRun(input: {
    providerAccountScopeKey: string;
    runId: string;
    fingerprint: string;
    result: MlbTeamTotalShadowCaptureResult;
  }): void {
    const account = clean(input.providerAccountScopeKey);
    const runId = clean(input.runId);
    const fingerprint = clean(input.fingerprint);
    const result = this.sqlite.prepare(`
      UPDATE mlb_team_total_shadow_runs
      SET state = 'COMPLETED', result_json = ?
      WHERE provider_account_scope_key = ? AND run_id = ? AND fingerprint = ? AND state = 'IN_PROGRESS'
    `).run(JSON.stringify(input.result), account, runId, fingerprint);
    if (result.changes !== 1) throw new Error("MLB_TEAM_TOTAL_SHADOW_STORE_COMPLETE_RUN_INVALID");
  }

  listCanonicalCaptures(providerAccountScopeKey: string): MlbTeamTotalShadowGameResult[] {
    const account = clean(providerAccountScopeKey);
    if (!account) throw new Error("MLB_TEAM_TOTAL_SHADOW_STORE_ACCOUNT_REQUIRED");
    return (this.sqlite.prepare(`
      SELECT result_json FROM mlb_team_total_shadow_canonical_games
      WHERE provider_account_scope_key = ? ORDER BY game_pk ASC
    `).all(account) as any[]).map((row) => JSON.parse(String(row.result_json)) as MlbTeamTotalShadowGameResult);
  }
}
