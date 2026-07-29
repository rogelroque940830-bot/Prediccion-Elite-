import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  MlbLedgerStore,
  mlbPredictionInputSchema,
  mlbSettlementInputSchema,
  type LedgerRecord,
  type MlbPredictionInput,
  type MlbSettlementInput,
} from "./mlb-ledger-store";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "mlb-ledger-v1.sqlite");
const CLIENT_ID_MAX = 160;

type OwnershipSource = "session" | "service" | "migration" | "repair";

interface OwnershipRow {
  prediction_id: string;
  client_request_id: string | null;
  user_id: number;
  source: OwnershipSource;
  assigned_at_ms: number;
}

export interface OwnedLedgerRecord extends LedgerRecord {
  ownership: {
    userId: number;
    source: OwnershipSource;
    assignedAt: string;
  };
}

export interface OwnedRecordFilters {
  from?: string;
  to?: string;
  market?: string;
  confidence?: string;
  signal?: string;
  stage?: string;
  settled?: boolean;
  limit?: number;
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function positiveUserId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error("Invalid owner user id"), { status: 400 });
  }
  return parsed;
}

function shortHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

export function scopedLedgerClientRequestId(userId: number, raw?: string): string {
  const owner = positiveUserId(userId);
  const original = raw?.trim() || `auto-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  const prefix = `u${owner}:`;
  const scoped = original.startsWith(prefix) ? original : `${prefix}${original}`;
  if (scoped.length <= CLIENT_ID_MAX) return scoped;
  return `${prefix}sha256-${shortHash(scoped)}`;
}

function ownershipError(message: string, status = 409): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export class MlbLedgerOwnershipStore {
  private readonly db: Database.Database;

  constructor(filePath = process.env.MLB_LEDGER_DB_PATH || DEFAULT_DB_PATH) {
    ensureParent(filePath);
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mlb_prediction_owner_claims_v1 (
        client_request_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL CHECK(user_id > 0),
        claimed_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mlb_prediction_owners_v1 (
        prediction_id TEXT PRIMARY KEY REFERENCES mlb_prediction_ledger_v1(id),
        client_request_id TEXT UNIQUE,
        user_id INTEGER NOT NULL CHECK(user_id > 0),
        source TEXT NOT NULL CHECK(source IN ('session', 'service', 'migration', 'repair')),
        assigned_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mlb_prediction_owners_user
        ON mlb_prediction_owners_v1(user_id, assigned_at_ms, prediction_id);

      CREATE TRIGGER IF NOT EXISTS mlb_prediction_owner_claims_immutable_update
        BEFORE UPDATE ON mlb_prediction_owner_claims_v1
        BEGIN SELECT RAISE(ABORT, 'mlb ownership claims are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_prediction_owner_claims_immutable_delete
        BEFORE DELETE ON mlb_prediction_owner_claims_v1
        BEGIN SELECT RAISE(ABORT, 'mlb ownership claims are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_prediction_owners_immutable_update
        BEFORE UPDATE ON mlb_prediction_owners_v1
        BEGIN SELECT RAISE(ABORT, 'mlb prediction ownership is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_prediction_owners_immutable_delete
        BEFORE DELETE ON mlb_prediction_owners_v1
        BEGIN SELECT RAISE(ABORT, 'mlb prediction ownership is immutable'); END;
    `);

    this.db.prepare(
      "INSERT OR IGNORE INTO mlb_ledger_migrations(version, applied_at_ms) VALUES(2, ?)",
    ).run(Date.now());
  }

  close(): void {
    this.db.close();
  }

  claim(clientRequestId: string, userId: number): void {
    const owner = positiveUserId(userId);
    const clientId = clientRequestId.trim();
    if (!clientId) throw ownershipError("clientRequestId is required for ownership", 400);

    this.db.prepare(`
      INSERT OR IGNORE INTO mlb_prediction_owner_claims_v1
        (client_request_id, user_id, claimed_at_ms)
      VALUES (?, ?, ?)
    `).run(clientId, owner, Date.now());

    const existing = this.db.prepare(
      "SELECT user_id FROM mlb_prediction_owner_claims_v1 WHERE client_request_id = ?",
    ).get(clientId) as { user_id: number } | undefined;
    if (!existing || Number(existing.user_id) !== owner) {
      throw ownershipError("clientRequestId belongs to another user");
    }
  }

  bind(
    predictionId: string,
    clientRequestId: string | null,
    userId: number,
    source: OwnershipSource,
  ): void {
    const owner = positiveUserId(userId);
    if (clientRequestId) this.claim(clientRequestId, owner);

    this.db.prepare(`
      INSERT OR IGNORE INTO mlb_prediction_owners_v1
        (prediction_id, client_request_id, user_id, source, assigned_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(predictionId, clientRequestId, owner, source, Date.now());

    const existing = this.db.prepare(
      "SELECT * FROM mlb_prediction_owners_v1 WHERE prediction_id = ?",
    ).get(predictionId) as OwnershipRow | undefined;
    if (!existing) throw ownershipError("Unable to persist prediction ownership", 500);
    if (Number(existing.user_id) !== owner) {
      throw ownershipError("Prediction belongs to another user");
    }
    if (
      clientRequestId &&
      existing.client_request_id &&
      existing.client_request_id !== clientRequestId
    ) {
      throw ownershipError("Prediction ownership clientRequestId mismatch");
    }
  }

  getOwnership(predictionId: string): OwnershipRow | undefined {
    return this.db.prepare(
      "SELECT * FROM mlb_prediction_owners_v1 WHERE prediction_id = ?",
    ).get(predictionId) as OwnershipRow | undefined;
  }

  getOwnershipByClientRequestId(clientRequestId: string): OwnershipRow | undefined {
    return this.db.prepare(
      "SELECT * FROM mlb_prediction_owners_v1 WHERE client_request_id = ?",
    ).get(clientRequestId.trim()) as OwnershipRow | undefined;
  }

  assertOwner(predictionId: string, userId: number): OwnershipRow {
    const owner = this.getOwnership(predictionId);
    if (!owner || Number(owner.user_id) !== positiveUserId(userId)) {
      throw ownershipError("Prediction not found", 404);
    }
    return owner;
  }

  listPredictionIds(userId: number): string[] {
    const rows = this.db.prepare(`
      SELECT prediction_id FROM mlb_prediction_owners_v1
      WHERE user_id = ?
      ORDER BY assigned_at_ms ASC, prediction_id ASC
    `).all(positiveUserId(userId)) as Array<{ prediction_id: string }>;
    return rows.map((row) => String(row.prediction_id));
  }

  ensureExistingOwnership(_store: MlbLedgerStore, defaultUserId: number): {
    scanned: number;
    repaired: number;
    migrated: number;
    remainingUnowned: number;
  } {
    const owner = positiveUserId(defaultUserId);
    const rows = this.db.prepare(`
      SELECT p.id, p.client_request_id
      FROM mlb_prediction_ledger_v1 p
      LEFT JOIN mlb_prediction_owners_v1 o ON o.prediction_id = p.id
      WHERE o.prediction_id IS NULL
      ORDER BY p.recorded_at_ms ASC, p.id ASC
    `).all() as Array<{ id: string; client_request_id: string | null }>;
    let repaired = 0;
    let migrated = 0;

    const migrateAll = this.db.transaction(() => {
      for (const row of rows) {
        const clientRequestId = row.client_request_id;
        const claim = clientRequestId
          ? (this.db.prepare(
              "SELECT user_id FROM mlb_prediction_owner_claims_v1 WHERE client_request_id = ?",
            ).get(clientRequestId) as { user_id: number } | undefined)
          : undefined;
        if (claim) {
          this.bind(row.id, clientRequestId, Number(claim.user_id), "repair");
          repaired += 1;
        } else {
          this.bind(row.id, clientRequestId, owner, "migration");
          migrated += 1;
        }
      }
    });
    migrateAll();

    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_ledger_v1").get() as any)?.n || 0,
    );
    const owned = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_owners_v1").get() as any)?.n || 0,
    );
    return {
      scanned: rows.length,
      repaired,
      migrated,
      remainingUnowned: Math.max(0, total - owned),
    };
  }

  status(): {
    assignments: number;
    claims: number;
    owners: number;
    unownedPredictions: number;
    immutable: true;
  } {
    const assignments = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_owners_v1").get() as any)?.n || 0,
    );
    const claims = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_owner_claims_v1").get() as any)?.n || 0,
    );
    const owners = Number(
      (this.db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM mlb_prediction_owners_v1").get() as any)?.n || 0,
    );
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_ledger_v1").get() as any)?.n || 0,
    );
    return {
      assignments,
      claims,
      owners,
      unownedPredictions: Math.max(0, total - assignments),
      immutable: true,
    };
  }
}

function recordMatches(record: LedgerRecord, filters: OwnedRecordFilters): boolean {
  if (filters.from && record.prediction.game.gameDate < filters.from) return false;
  if (filters.to && record.prediction.game.gameDate > filters.to) return false;
  if (filters.market && record.prediction.market.type !== filters.market) return false;
  if (
    filters.confidence &&
    record.prediction.decision.confidenceLabel !== filters.confidence
  ) return false;
  if (filters.signal && record.prediction.decision.signal !== filters.signal) return false;
  if (filters.stage && record.prediction.analysisStage !== filters.stage) return false;
  if (
    filters.settled != null &&
    Boolean(record.settlement) !== filters.settled
  ) return false;
  return true;
}

export function ownedRecordsForUser(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  userId: number,
  filters: OwnedRecordFilters = {},
): OwnedLedgerRecord[] {
  const limit = Math.min(10_000, Math.max(1, filters.limit ?? 1_000));
  const rows = ownershipStore
    .listPredictionIds(userId)
    .map((id) => {
      const record = store.getRecord(id);
      const ownership = ownershipStore.getOwnership(id);
      if (!record || !ownership) return null;
      return {
        ...record,
        ownership: {
          userId: Number(ownership.user_id),
          source: ownership.source,
          assignedAt: new Date(Number(ownership.assigned_at_ms)).toISOString(),
        },
      } satisfies OwnedLedgerRecord;
    })
    .filter((record): record is OwnedLedgerRecord => Boolean(record))
    .filter((record) => recordMatches(record, filters))
    .sort((a, b) =>
      a.prediction.game.gameDate.localeCompare(b.prediction.game.gameDate) ||
      a.prediction.recordedAtMs - b.prediction.recordedAtMs ||
      a.prediction.id.localeCompare(b.prediction.id),
    );
  return rows.slice(0, limit);
}

export function getOwnedRecord(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  userId: number,
  predictionId: string,
): OwnedLedgerRecord | null {
  try {
    const ownership = ownershipStore.assertOwner(predictionId, userId);
    const record = store.getRecord(predictionId);
    if (!record) return null;
    return {
      ...record,
      ownership: {
        userId: Number(ownership.user_id),
        source: ownership.source,
        assignedAt: new Date(Number(ownership.assigned_at_ms)).toISOString(),
      },
    };
  } catch {
    return null;
  }
}

export function appendOwnedPrediction(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  raw: unknown,
  userId: number,
  source: OwnershipSource = "session",
): ReturnType<MlbLedgerStore["appendPrediction"]> {
  const parsed = mlbPredictionInputSchema.parse(raw) as MlbPredictionInput;
  const rawClientRequestId = parsed.clientRequestId?.trim();
  const migratedOwnership = rawClientRequestId
    ? ownershipStore.getOwnershipByClientRequestId(rawClientRequestId)
    : undefined;

  if (migratedOwnership && Number(migratedOwnership.user_id) === positiveUserId(userId)) {
    const result = store.appendPrediction({
      ...parsed,
      clientRequestId: rawClientRequestId,
    });
    ownershipStore.bind(result.data.id, rawClientRequestId!, userId, source);
    return result;
  }

  const clientRequestId = scopedLedgerClientRequestId(userId, rawClientRequestId);
  ownershipStore.claim(clientRequestId, userId);
  const result = store.appendPrediction({ ...parsed, clientRequestId });
  ownershipStore.bind(result.data.id, clientRequestId, userId, source);
  return result;
}

export function appendOwnedSettlement(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  predictionId: string,
  raw: unknown,
  userId: number,
): ReturnType<MlbLedgerStore["appendSettlement"]> {
  ownershipStore.assertOwner(predictionId, userId);
  const parsed = mlbSettlementInputSchema.parse(raw) as MlbSettlementInput;
  const clientRequestId = parsed.clientRequestId
    ? scopedLedgerClientRequestId(userId, parsed.clientRequestId)
    : undefined;
  return store.appendSettlement(
    predictionId,
    clientRequestId ? { ...parsed, clientRequestId } : parsed,
  );
}

let singletonOwnershipStore: MlbLedgerOwnershipStore | undefined;

export function getMlbLedgerOwnershipStore(): MlbLedgerOwnershipStore {
  if (!singletonOwnershipStore) singletonOwnershipStore = new MlbLedgerOwnershipStore();
  return singletonOwnershipStore;
}

export function resetMlbLedgerOwnershipStoreForTests(): void {
  singletonOwnershipStore?.close();
  singletonOwnershipStore = undefined;
}
