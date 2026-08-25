import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  MLB_DAILY_BEST_PICK_RUNTIME_ADAPTER_SCHEMA,
  selectMlbDailyBestPickFromUnifiedPreprice,
  type MlbDailyBestPickRuntimeAdapterResult,
} from "./mlb-daily-best-pick-runtime-adapter";
import {
  MLB_UNIFIED_RUNNER_SCHEMA,
  type MlbUnifiedRunnerResult,
} from "./mlb-unified-runner";

export const MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA =
  "courtedge-mlb-daily-best-pick-prospective-custody.v1" as const;
export const MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE = "2026-08-26" as const;

export interface MlbDailyBestPickProspectiveSafety {
  outcomesRead: false;
  outcomeStatusReadForSelection: false;
  sportsbookPricesReadForCustody: false;
  performanceMetricsRead: false;
  historicalBackfillAllowed: false;
  selectionRuleChanged: false;
  rankingChanged: false;
  stakeCalculated: false;
  automaticBetPlacement: false;
  realFinancialExposure: 0;
}

export interface MlbDailyBestPickProspectiveSnapshot {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA;
  officialDate: string;
  sourceRunId: string;
  capturedAtUtc: string;
  prepriceRuntimeSchemaVersion: typeof MLB_UNIFIED_RUNNER_SCHEMA;
  prepriceRuntimeGeneratedAt: string;
  orderedIntrinsicRankedGames: readonly number[];
  frozenRouteLedgerForCapturedRuntime: MlbUnifiedRunnerResult["frozenRouteLedger"];
  dailyBestPickAdapterEvaluations: MlbDailyBestPickRuntimeAdapterResult["evaluations"];
  dailyBestPickSelectorResult: MlbDailyBestPickRuntimeAdapterResult["selection"];
  prepriceRuntime: MlbUnifiedRunnerResult;
  sourceStatus: "CERTIFIED_CURRENT_DAILY_BEST_PICK_TRUSTED_RUNTIME";
  safety: MlbDailyBestPickProspectiveSafety;
  snapshotDigest: string;
}

export interface MlbDailyBestPickProspectiveCustodyStatus {
  schemaVersion: typeof MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA;
  firstEligibleOfficialDate: typeof MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE;
  capturedSnapshots: number;
  distinctCapturedDates: number;
  firstCapturedOfficialDate: string | null;
  lastCapturedOfficialDate: string | null;
  outcomeReadUnlocked: false;
  canonicalDailyRunDefined: false;
  selectedPopulationProbabilityScoringAllowed: false;
  crossSportProbabilityAuthorized: false;
  promotionAllowed: false;
  safety: MlbDailyBestPickProspectiveSafety;
}

export type MlbDailyBestPickProspectiveCaptureResult =
  | {
      status: "SKIPPED_BEFORE_PROSPECTIVE_BOUNDARY";
      snapshot: null;
    }
  | {
      status: "CAPTURED" | "ALREADY_CAPTURED";
      snapshot: MlbDailyBestPickProspectiveSnapshot;
    };

const SAFETY: MlbDailyBestPickProspectiveSafety = Object.freeze({
  outcomesRead: false,
  outcomeStatusReadForSelection: false,
  sportsbookPricesReadForCustody: false,
  performanceMetricsRead: false,
  historicalBackfillAllowed: false,
  selectionRuleChanged: false,
  rankingChanged: false,
  stakeCalculated: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
});

function runningOnRailway(): boolean {
  return Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
}

export function resolveMlbDailyBestPickProspectiveCustodyDbPath(): string {
  const explicit = process.env.MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_DB_PATH?.trim();
  if (explicit) return explicit;
  const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayVolume) {
    return path.join(railwayVolume, "mlb-daily-best-pick-prospective-custody.sqlite");
  }
  if (runningOnRailway()) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_PERSISTENT_RAILWAY_CUSTODY_NOT_CONFIGURED");
  }
  return path.join(process.cwd(), "data", "mlb-daily-best-pick-prospective-custody.sqlite");
}

function ensureParent(filename: string): void {
  if (filename === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotDigestPayload(
  snapshot: Omit<MlbDailyBestPickProspectiveSnapshot, "snapshotDigest"> | MlbDailyBestPickProspectiveSnapshot,
): unknown {
  const { snapshotDigest: _snapshotDigest, ...payload } = snapshot as MlbDailyBestPickProspectiveSnapshot;
  return payload;
}

function validateTrustedRuntime(preprice: MlbUnifiedRunnerResult, capturedAtUtc: string): void {
  if (preprice.schemaVersion !== MLB_UNIFIED_RUNNER_SCHEMA) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_RUNTIME_SCHEMA_INVALID");
  }
  if (!validDate(preprice.date) || preprice.date < MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_DATE_BEFORE_BOUNDARY");
  }
  if (!String(preprice.runId ?? "").trim()) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_SOURCE_RUN_ID_REQUIRED");
  }
  if (!validIso(preprice.generatedAt) || !validIso(capturedAtUtc)) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_TIMESTAMP_INVALID");
  }
  if (Date.parse(capturedAtUtc) < Date.parse(preprice.generatedAt)) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_CAPTURE_PRECEDES_RUNTIME_GENERATION");
  }
  if (preprice.frozenRouteLedger.sourceRunId !== preprice.runId) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_ROUTE_LEDGER_RUN_MISMATCH");
  }

  const routeEntries = preprice.frozenRouteLedger.entries;
  if (!Array.isArray(routeEntries) || routeEntries.length === 0) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_NO_RELEVANT_PREGAME_BOUNDARY");
  }

  const routeGamePks = new Set<number>();
  for (const entry of routeEntries) {
    if (entry.sourceRunId !== preprice.runId || entry.gameDate !== preprice.date) {
      throw new Error(`MLB_DAILY_BEST_PICK_PROSPECTIVE_ROUTE_LEDGER_IDENTITY_MISMATCH:${entry.gamePk}`);
    }
    if (!Number.isInteger(entry.gamePk) || entry.gamePk <= 0 || routeGamePks.has(entry.gamePk)) {
      throw new Error(`MLB_DAILY_BEST_PICK_PROSPECTIVE_ROUTE_LEDGER_GAME_ID_INVALID:${entry.gamePk}`);
    }
    routeGamePks.add(entry.gamePk);
    if (!validIso(entry.scheduledStartTime)) {
      throw new Error(`MLB_DAILY_BEST_PICK_PROSPECTIVE_GAME_START_INVALID:${entry.gamePk}`);
    }
    if (Date.parse(capturedAtUtc) >= Date.parse(entry.scheduledStartTime)) {
      throw new Error(`MLB_DAILY_BEST_PICK_PROSPECTIVE_CAPTURE_NOT_STRICTLY_PREGAME:${entry.gamePk}`);
    }
  }

  const ranked = preprice.intrinsic.rankedGames;
  const rankedPks = new Set<number>();
  for (const game of ranked) {
    if (game.officialDate !== preprice.date || !Number.isInteger(game.gamePk) || game.gamePk <= 0) {
      throw new Error(`MLB_DAILY_BEST_PICK_PROSPECTIVE_RANKED_GAME_IDENTITY_INVALID:${game.gamePk}`);
    }
    if (rankedPks.has(game.gamePk)) {
      throw new Error(`MLB_DAILY_BEST_PICK_PROSPECTIVE_DUPLICATE_RANKED_GAME:${game.gamePk}`);
    }
    rankedPks.add(game.gamePk);
    if (!routeGamePks.has(game.gamePk)) {
      throw new Error(`MLB_DAILY_BEST_PICK_PROSPECTIVE_RANKED_GAME_MISSING_ROUTE_LEDGER:${game.gamePk}`);
    }
  }
}

export function buildMlbDailyBestPickProspectiveSnapshot(input: {
  preprice: MlbUnifiedRunnerResult;
  capturedAtUtc: string;
}): MlbDailyBestPickProspectiveSnapshot {
  validateTrustedRuntime(input.preprice, input.capturedAtUtc);
  const preprice = deepFreeze(jsonClone(input.preprice));
  const adapter = deepFreeze(jsonClone(selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: preprice,
    officialDate: preprice.date,
  })));
  if (adapter.schemaVersion !== MLB_DAILY_BEST_PICK_RUNTIME_ADAPTER_SCHEMA
    || adapter.officialDate !== preprice.date
    || adapter.sourceRunId !== preprice.runId) {
    throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_ADAPTER_IDENTITY_INVALID");
  }

  const withoutDigest: Omit<MlbDailyBestPickProspectiveSnapshot, "snapshotDigest"> = {
    schemaVersion: MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA,
    officialDate: preprice.date,
    sourceRunId: preprice.runId,
    capturedAtUtc: new Date(input.capturedAtUtc).toISOString(),
    prepriceRuntimeSchemaVersion: preprice.schemaVersion,
    prepriceRuntimeGeneratedAt: new Date(preprice.generatedAt).toISOString(),
    orderedIntrinsicRankedGames: deepFreeze(preprice.intrinsic.rankedGames.map((game) => game.gamePk)),
    frozenRouteLedgerForCapturedRuntime: preprice.frozenRouteLedger,
    dailyBestPickAdapterEvaluations: adapter.evaluations,
    dailyBestPickSelectorResult: adapter.selection,
    prepriceRuntime: preprice,
    sourceStatus: "CERTIFIED_CURRENT_DAILY_BEST_PICK_TRUSTED_RUNTIME",
    safety: SAFETY,
  };

  return deepFreeze({
    ...withoutDigest,
    snapshotDigest: sha256(withoutDigest),
  });
}

export function parseMlbDailyBestPickProspectiveSnapshot(
  raw: unknown,
): MlbDailyBestPickProspectiveSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as MlbDailyBestPickProspectiveSnapshot;
  try {
    if (value.schemaVersion !== MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA) return null;
    if (sha256(snapshotDigestPayload(value)) !== value.snapshotDigest) return null;
    const rebuilt = buildMlbDailyBestPickProspectiveSnapshot({
      preprice: value.prepriceRuntime,
      capturedAtUtc: value.capturedAtUtc,
    });
    return rebuilt.snapshotDigest === value.snapshotDigest && canonical(rebuilt) === canonical(value)
      ? rebuilt
      : null;
  } catch {
    return null;
  }
}

export class MlbDailyBestPickProspectiveCustodyStore {
  readonly schemaVersion = MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA;
  private readonly sqlite: Database.Database;

  constructor(options: { filename?: string; allowInMemoryForTests?: boolean } = {}) {
    const filename = options.filename ?? resolveMlbDailyBestPickProspectiveCustodyDbPath();
    if (filename === ":memory:" && runningOnRailway() && options.allowInMemoryForTests !== true) {
      throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_IN_MEMORY_PRODUCTION_CUSTODY_FORBIDDEN");
    }
    ensureParent(filename);
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mlb_daily_best_pick_prospective_snapshot (
        official_date TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        captured_at_utc TEXT NOT NULL,
        preprice_runtime_generated_at TEXT NOT NULL,
        decision TEXT NOT NULL,
        selected_game_pk INTEGER,
        snapshot_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (official_date, source_run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mlb_daily_best_pick_prospective_date
        ON mlb_daily_best_pick_prospective_snapshot(official_date, captured_at_utc, source_run_id);
    `);
  }

  close(): void {
    this.sqlite.close();
  }

  get(officialDate: string, sourceRunId: string): MlbDailyBestPickProspectiveSnapshot | null {
    const row = this.sqlite.prepare(`
      SELECT snapshot_json
      FROM mlb_daily_best_pick_prospective_snapshot
      WHERE official_date = ? AND source_run_id = ?
    `).get(officialDate, sourceRunId) as { snapshot_json: string } | undefined;
    if (!row) return null;
    const parsed = parseMlbDailyBestPickProspectiveSnapshot(JSON.parse(row.snapshot_json));
    if (!parsed) {
      throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_STORED_SNAPSHOT_INTEGRITY_FAILED");
    }
    return parsed;
  }

  putFirstCanonical(
    snapshotInput: MlbDailyBestPickProspectiveSnapshot,
  ): { inserted: boolean; snapshot: MlbDailyBestPickProspectiveSnapshot } {
    const snapshot = parseMlbDailyBestPickProspectiveSnapshot(snapshotInput);
    if (!snapshot) throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_SNAPSHOT_INVALID");

    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO mlb_daily_best_pick_prospective_snapshot
        (official_date, source_run_id, captured_at_utc, preprice_runtime_generated_at,
         decision, selected_game_pk, snapshot_digest, snapshot_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.officialDate,
      snapshot.sourceRunId,
      snapshot.capturedAtUtc,
      snapshot.prepriceRuntimeGeneratedAt,
      snapshot.dailyBestPickSelectorResult.decision,
      snapshot.dailyBestPickSelectorResult.pick?.gamePk ?? null,
      snapshot.snapshotDigest,
      JSON.stringify(snapshot),
      Date.now(),
    );

    const canonicalSnapshot = this.get(snapshot.officialDate, snapshot.sourceRunId);
    if (!canonicalSnapshot) {
      throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_CANONICAL_READBACK_FAILED");
    }
    if (canonicalSnapshot.snapshotDigest !== snapshot.snapshotDigest) {
      throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_SOURCE_RUN_IMMUTABILITY_CONFLICT");
    }
    return { inserted: result.changes === 1, snapshot: canonicalSnapshot };
  }

  listDate(officialDate: string): readonly MlbDailyBestPickProspectiveSnapshot[] {
    const rows = this.sqlite.prepare(`
      SELECT snapshot_json
      FROM mlb_daily_best_pick_prospective_snapshot
      WHERE official_date = ?
      ORDER BY captured_at_utc ASC, source_run_id ASC
    `).all(officialDate) as Array<{ snapshot_json: string }>;
    return Object.freeze(rows.map((row) => {
      const parsed = parseMlbDailyBestPickProspectiveSnapshot(JSON.parse(row.snapshot_json));
      if (!parsed) {
        throw new Error("MLB_DAILY_BEST_PICK_PROSPECTIVE_STORED_SNAPSHOT_INTEGRITY_FAILED");
      }
      return parsed;
    }));
  }

  status(): MlbDailyBestPickProspectiveCustodyStatus {
    const row = this.sqlite.prepare(`
      SELECT
        COUNT(*) AS snapshots,
        COUNT(DISTINCT official_date) AS dates,
        MIN(official_date) AS first_date,
        MAX(official_date) AS last_date
      FROM mlb_daily_best_pick_prospective_snapshot
    `).get() as {
      snapshots: number;
      dates: number;
      first_date: string | null;
      last_date: string | null;
    };
    return Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_PROSPECTIVE_CUSTODY_SCHEMA,
      firstEligibleOfficialDate: MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE,
      capturedSnapshots: Number(row.snapshots ?? 0),
      distinctCapturedDates: Number(row.dates ?? 0),
      firstCapturedOfficialDate: row.first_date ?? null,
      lastCapturedOfficialDate: row.last_date ?? null,
      outcomeReadUnlocked: false as const,
      canonicalDailyRunDefined: false as const,
      selectedPopulationProbabilityScoringAllowed: false as const,
      crossSportProbabilityAuthorized: false as const,
      promotionAllowed: false as const,
      safety: SAFETY,
    });
  }
}

export function captureMlbDailyBestPickProspective(input: {
  preprice: MlbUnifiedRunnerResult;
  capturedAtUtc: string;
  custody?: Pick<MlbDailyBestPickProspectiveCustodyStore, "putFirstCanonical">;
}): MlbDailyBestPickProspectiveCaptureResult {
  if (input.preprice.date < MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE) {
    return Object.freeze({
      status: "SKIPPED_BEFORE_PROSPECTIVE_BOUNDARY" as const,
      snapshot: null,
    });
  }

  const snapshot = buildMlbDailyBestPickProspectiveSnapshot({
    preprice: input.preprice,
    capturedAtUtc: input.capturedAtUtc,
  });
  const owned = input.custody ? null : new MlbDailyBestPickProspectiveCustodyStore();
  try {
    const stored = (input.custody ?? owned!).putFirstCanonical(snapshot);
    return Object.freeze({
      status: stored.inserted ? "CAPTURED" as const : "ALREADY_CAPTURED" as const,
      snapshot: stored.snapshot,
    });
  } finally {
    owned?.close();
  }
}
