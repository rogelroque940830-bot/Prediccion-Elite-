import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  MlbSelectiveOddsSharedCoordinator,
  MlbSelectiveOddsSharedEventCache,
  MlbSelectiveOddsSharedEventPrunePolicy,
  MlbSelectiveOddsSharedRunAdmission,
  MlbSelectiveOddsSharedRunAdmissionPolicy,
  MlbSelectiveOddsSharedRunCompleted,
} from "./mlb-selective-odds-acquisition";

export const MLB_SELECTIVE_ODDS_SQLITE_COORDINATOR_SCHEMA = "courtedge-p0-mlb-selective-odds-sqlite-coordinator.v1" as const;
export const MLB_SELECTIVE_ODDS_SQLITE_LOCK_LEASE_MS = 5 * 60 * 1000;
export const MLB_SELECTIVE_ODDS_SQLITE_LOCK_POLL_MS = 50;
export const MLB_SELECTIVE_ODDS_SQLITE_LOCK_WAIT_MS = 30 * 1000;

function defaultDbPath(): string {
  return process.env.MLB_ODDS_COORDINATOR_DB_PATH?.trim()
    || path.join(process.cwd(), "data", "mlb-odds-coordinator.sqlite");
}

function ensureParent(filename: string): void {
  if (filename === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MlbSelectiveOddsSqliteCoordinator implements MlbSelectiveOddsSharedCoordinator {
  readonly coordinationScope = "PROVIDER_ACCOUNT_SHARED" as const;
  private readonly sqlite: Database.Database;
  private readonly lockLeaseMs: number;
  private readonly lockPollMs: number;
  private readonly lockWaitMs: number;
  private readonly now: () => number;

  constructor(options: {
    filename?: string;
    lockLeaseMs?: number;
    lockPollMs?: number;
    lockWaitMs?: number;
    now?: () => number;
  } = {}) {
    const filename = options.filename ?? defaultDbPath();
    ensureParent(filename);
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.lockLeaseMs = options.lockLeaseMs ?? MLB_SELECTIVE_ODDS_SQLITE_LOCK_LEASE_MS;
    this.lockPollMs = options.lockPollMs ?? MLB_SELECTIVE_ODDS_SQLITE_LOCK_POLL_MS;
    this.lockWaitMs = options.lockWaitMs ?? MLB_SELECTIVE_ODDS_SQLITE_LOCK_WAIT_MS;
    this.now = options.now ?? (() => Date.now());
    if (![this.lockLeaseMs, this.lockPollMs, this.lockWaitMs].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error("MLB_ODDS_SQLITE_COORDINATOR_LOCK_CONFIG_INVALID");
    }
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mlb_odds_account_locks (
        provider_account_scope_key TEXT PRIMARY KEY,
        owner_token TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mlb_odds_run_journal (
        provider_account_scope_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
        fingerprint TEXT NOT NULL,
        admitted_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL,
        result_json TEXT,
        PRIMARY KEY (provider_account_scope_key, run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mlb_odds_run_journal_expiry
        ON mlb_odds_run_journal(provider_account_scope_key, expires_at_ms);

      CREATE TABLE IF NOT EXISTS mlb_odds_event_cache (
        provider_account_scope_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        provider_event_json TEXT NOT NULL,
        market_fetched_at_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (provider_account_scope_key, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mlb_odds_event_cache_updated
        ON mlb_odds_event_cache(provider_account_scope_key, updated_at_ms);
    `);
  }

  private tryAcquireLock(accountKey: string, ownerToken: string, nowMs: number): boolean {
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        DELETE FROM mlb_odds_account_locks
        WHERE provider_account_scope_key = ? AND expires_at_ms <= ?
      `).run(accountKey, nowMs);
      const result = this.sqlite.prepare(`
        INSERT OR IGNORE INTO mlb_odds_account_locks
          (provider_account_scope_key, owner_token, expires_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(accountKey, ownerToken, nowMs + this.lockLeaseMs, nowMs);
      return result.changes === 1;
    });
    return transaction();
  }

  private refreshLock(accountKey: string, ownerToken: string): void {
    const nowMs = this.now();
    const result = this.sqlite.prepare(`
      UPDATE mlb_odds_account_locks
      SET expires_at_ms = ?, updated_at_ms = ?
      WHERE provider_account_scope_key = ? AND owner_token = ?
    `).run(nowMs + this.lockLeaseMs, nowMs, accountKey, ownerToken);
    if (result.changes !== 1) throw new Error("MLB_ODDS_SQLITE_COORDINATOR_LOCK_LOST");
  }

  private releaseLock(accountKey: string, ownerToken: string): void {
    this.sqlite.prepare(`
      DELETE FROM mlb_odds_account_locks
      WHERE provider_account_scope_key = ? AND owner_token = ?
    `).run(accountKey, ownerToken);
  }

  async runExclusive<T>(providerAccountScopeKey: string, work: () => Promise<T>): Promise<T> {
    const accountKey = String(providerAccountScopeKey ?? "").trim();
    if (!accountKey) throw new Error("MLB_ODDS_SQLITE_COORDINATOR_ACCOUNT_SCOPE_REQUIRED");
    const ownerToken = crypto.randomUUID();
    const startedAt = this.now();
    while (!this.tryAcquireLock(accountKey, ownerToken, this.now())) {
      if (this.now() - startedAt >= this.lockWaitMs) {
        throw new Error("MLB_ODDS_SQLITE_COORDINATOR_LOCK_TIMEOUT");
      }
      await delay(this.lockPollMs);
    }

    const refreshEvery = Math.max(1000, Math.floor(this.lockLeaseMs / 3));
    const timer = setInterval(() => {
      try { this.refreshLock(accountKey, ownerToken); } catch { /* work will fail closed on next coordinator write */ }
    }, refreshEvery);
    timer.unref?.();

    try {
      return await work();
    } finally {
      clearInterval(timer);
      this.releaseLock(accountKey, ownerToken);
    }
  }

  async beginRun(
    providerAccountScopeKey: string,
    runId: string,
    fingerprint: string,
    policy: MlbSelectiveOddsSharedRunAdmissionPolicy,
  ): Promise<MlbSelectiveOddsSharedRunAdmission> {
    const accountKey = String(providerAccountScopeKey ?? "").trim();
    const normalizedRunId = String(runId ?? "").trim();
    const normalizedFingerprint = String(fingerprint ?? "").trim();
    if (!accountKey || !normalizedRunId || !normalizedFingerprint) throw new Error("MLB_ODDS_SQLITE_COORDINATOR_RUN_IDENTITY_INVALID");

    const transaction = this.sqlite.transaction((): MlbSelectiveOddsSharedRunAdmission => {
      this.sqlite.prepare(`
        DELETE FROM mlb_odds_run_journal
        WHERE provider_account_scope_key = ? AND expires_at_ms <= ?
      `).run(accountKey, policy.nowMs);

      const existing = this.sqlite.prepare(`
        SELECT * FROM mlb_odds_run_journal
        WHERE provider_account_scope_key = ? AND run_id = ?
      `).get(accountKey, normalizedRunId) as any;
      if (existing) {
        if (existing.state === "COMPLETED") {
          return {
            status: "COMPLETED",
            record: {
              state: "COMPLETED",
              fingerprint: String(existing.fingerprint),
              expiresAtMs: Number(existing.expires_at_ms),
              result: parseJson(existing.result_json),
            },
          };
        }
        return {
          status: "IN_PROGRESS",
          record: {
            state: "IN_PROGRESS",
            fingerprint: String(existing.fingerprint),
            admittedAtMs: Number(existing.admitted_at_ms),
            expiresAtMs: Number(existing.expires_at_ms),
          },
        };
      }

      const count = Number((this.sqlite.prepare(`
        SELECT COUNT(*) AS n FROM mlb_odds_run_journal
        WHERE provider_account_scope_key = ?
      `).get(accountKey) as any)?.n ?? 0);
      if (count >= policy.maxRunEntries) return { status: "CAPACITY_EXHAUSTED", record: null };

      this.sqlite.prepare(`
        INSERT INTO mlb_odds_run_journal
          (provider_account_scope_key, run_id, state, fingerprint, admitted_at_ms, expires_at_ms, result_json)
        VALUES (?, ?, 'IN_PROGRESS', ?, ?, ?, NULL)
      `).run(accountKey, normalizedRunId, normalizedFingerprint, policy.nowMs, policy.expiresAtMs);
      return {
        status: "ADMITTED",
        record: {
          state: "IN_PROGRESS",
          fingerprint: normalizedFingerprint,
          admittedAtMs: policy.nowMs,
          expiresAtMs: policy.expiresAtMs,
        },
      };
    });
    return transaction();
  }

  async completeRun(
    providerAccountScopeKey: string,
    runId: string,
    fingerprint: string,
    completed: MlbSelectiveOddsSharedRunCompleted,
  ): Promise<void> {
    const accountKey = String(providerAccountScopeKey ?? "").trim();
    const result = this.sqlite.prepare(`
      UPDATE mlb_odds_run_journal
      SET state = 'COMPLETED', expires_at_ms = ?, result_json = ?
      WHERE provider_account_scope_key = ? AND run_id = ? AND state = 'IN_PROGRESS' AND fingerprint = ?
    `).run(completed.expiresAtMs, stableJson(completed.result), accountKey, runId, fingerprint);
    if (result.changes !== 1) throw new Error("MLB_ODDS_SQLITE_COORDINATOR_COMPLETION_IDENTITY_MISMATCH");
  }

  async getEventCache(providerAccountScopeKey: string, eventId: string): Promise<MlbSelectiveOddsSharedEventCache | null> {
    const row = this.sqlite.prepare(`
      SELECT * FROM mlb_odds_event_cache
      WHERE provider_account_scope_key = ? AND event_id = ?
    `).get(providerAccountScopeKey, eventId) as any;
    if (!row) return null;
    return {
      eventId: String(row.event_id),
      providerEvent: parseJson(row.provider_event_json),
      marketFetchedAtMs: parseJson(row.market_fetched_at_json),
      updatedAtMs: Number(row.updated_at_ms),
    };
  }

  async putEventCache(providerAccountScopeKey: string, eventId: string, entry: MlbSelectiveOddsSharedEventCache): Promise<void> {
    if (entry.eventId !== eventId) throw new Error("MLB_ODDS_SQLITE_COORDINATOR_EVENT_ID_MISMATCH");
    this.sqlite.prepare(`
      INSERT INTO mlb_odds_event_cache
        (provider_account_scope_key, event_id, provider_event_json, market_fetched_at_json, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_account_scope_key, event_id) DO UPDATE SET
        provider_event_json = excluded.provider_event_json,
        market_fetched_at_json = excluded.market_fetched_at_json,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      providerAccountScopeKey,
      eventId,
      stableJson(entry.providerEvent),
      stableJson(entry.marketFetchedAtMs),
      entry.updatedAtMs,
    );
  }

  async pruneEventCache(providerAccountScopeKey: string, policy: MlbSelectiveOddsSharedEventPrunePolicy): Promise<void> {
    const cutoff = policy.nowMs - policy.eventCacheTtlMs;
    const transaction = this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        DELETE FROM mlb_odds_event_cache
        WHERE provider_account_scope_key = ? AND updated_at_ms < ?
      `).run(providerAccountScopeKey, cutoff);

      const rows = this.sqlite.prepare(`
        SELECT event_id FROM mlb_odds_event_cache
        WHERE provider_account_scope_key = ?
        ORDER BY updated_at_ms DESC, event_id ASC
      `).all(providerAccountScopeKey) as Array<{ event_id: string }>;
      for (const row of rows.slice(policy.maxEventEntries)) {
        this.sqlite.prepare(`
          DELETE FROM mlb_odds_event_cache
          WHERE provider_account_scope_key = ? AND event_id = ?
        `).run(providerAccountScopeKey, row.event_id);
      }
    });
    transaction();
  }
}
