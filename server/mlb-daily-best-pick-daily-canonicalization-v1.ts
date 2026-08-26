import Database from "better-sqlite3";
import {
  MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE,
  parseMlbDailyBestPickProspectiveSnapshot,
  resolveMlbDailyBestPickProspectiveCustodyDbPath,
  type MlbDailyBestPickProspectiveSnapshot,
} from "./mlb-daily-best-pick-prospective-custody-v1";

export const MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA =
  "courtedge-mlb-daily-best-pick-daily-canonicalization.v1" as const;

export interface MlbDailyBestPickCanonicalizationStoredRow {
  officialDate: string;
  sourceRunId: string;
  createdAtMs: number;
  snapshot: unknown;
}

export interface MlbDailyBestPickCanonicalizationSafety {
  outcomesRead: false;
  outcomeStatusRead: false;
  performanceMetricsRead: false;
  sportsbookPricesRead: false;
  decisionAffectsCanonicalSelection: false;
  pickIdentityAffectsCanonicalSelection: false;
  tierAffectsCanonicalSelection: false;
  rankedGameCountAffectsCanonicalSelection: false;
  modelProbabilityAffectsCanonicalSelection: false;
  routeMatchAffectsCanonicalSelection: false;
  custodyRowsMutated: false;
  historicalBackfillAllowed: false;
  selectedPopulationProbabilityScoringAllowed: false;
  crossSportProbabilityAuthorized: false;
  promotionAllowed: false;
}

export interface MlbDailyBestPickCanonicalizationCounts {
  totalRows: number;
  integrityValidRows: number;
  completeScheduleRows: number;
  eligiblePregameRows: number;
  rejectedIntegrityRows: number;
  rejectedIncompleteScheduleRows: number;
  rejectedPregameBoundaryRows: number;
}

export type MlbDailyBestPickCanonicalizationResult =
  | {
      schemaVersion: typeof MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA;
      status: "CANONICAL";
      officialDate: string;
      datePregameCutoffUtc: string;
      canonicalSourceRunId: string;
      canonicalSnapshotDigest: string;
      canonicalCapturedAtUtc: string;
      canonicalRuntimeGeneratedAt: string;
      canonicalDatabaseCreatedAtMs: number;
      canonicalDecision: MlbDailyBestPickProspectiveSnapshot["dailyBestPickSelectorResult"]["decision"];
      canonicalSnapshot: MlbDailyBestPickProspectiveSnapshot;
      counts: MlbDailyBestPickCanonicalizationCounts;
      sortRule: readonly [
        "capturedAtUtc_DESC",
        "prepriceRuntimeGeneratedAt_DESC",
        "createdAtMs_ASC",
        "sourceRunId_ASC",
        "snapshotDigest_ASC",
      ];
      safety: MlbDailyBestPickCanonicalizationSafety;
    }
  | {
      schemaVersion: typeof MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA;
      status: "NO_CANONICAL";
      officialDate: string;
      reason:
        | "OFFICIAL_DATE_BEFORE_PROSPECTIVE_BOUNDARY"
        | "NO_INTEGRITY_VALID_COMPLETE_SCHEDULE_SNAPSHOTS"
        | "NO_STRICTLY_PREGAME_INGESTED_SNAPSHOT_BEFORE_DATE_CUTOFF";
      datePregameCutoffUtc: string | null;
      counts: MlbDailyBestPickCanonicalizationCounts;
      sortRule: readonly [
        "capturedAtUtc_DESC",
        "prepriceRuntimeGeneratedAt_DESC",
        "createdAtMs_ASC",
        "sourceRunId_ASC",
        "snapshotDigest_ASC",
      ];
      safety: MlbDailyBestPickCanonicalizationSafety;
    };

const SORT_RULE = Object.freeze([
  "capturedAtUtc_DESC",
  "prepriceRuntimeGeneratedAt_DESC",
  "createdAtMs_ASC",
  "sourceRunId_ASC",
  "snapshotDigest_ASC",
] as const);

const SAFETY: MlbDailyBestPickCanonicalizationSafety = Object.freeze({
  outcomesRead: false,
  outcomeStatusRead: false,
  performanceMetricsRead: false,
  sportsbookPricesRead: false,
  decisionAffectsCanonicalSelection: false,
  pickIdentityAffectsCanonicalSelection: false,
  tierAffectsCanonicalSelection: false,
  rankedGameCountAffectsCanonicalSelection: false,
  modelProbabilityAffectsCanonicalSelection: false,
  routeMatchAffectsCanonicalSelection: false,
  custodyRowsMutated: false,
  historicalBackfillAllowed: false,
  selectedPopulationProbabilityScoringAllowed: false,
  crossSportProbabilityAuthorized: false,
  promotionAllowed: false,
});

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function scheduleStartsForCompleteSnapshot(
  snapshot: MlbDailyBestPickProspectiveSnapshot,
  officialDate: string,
): number[] | null {
  const games = snapshot.prepriceRuntime?.cheapScreen?.games;
  if (!Array.isArray(games) || games.length === 0) return null;
  const seen = new Set<number>();
  const starts: number[] = [];
  for (const game of games) {
    const gamePk = Number((game as any)?.gamePk);
    const gameDate = String((game as any)?.officialDate ?? "");
    const startTime = (game as any)?.startTime;
    if (!Number.isInteger(gamePk) || gamePk <= 0 || seen.has(gamePk)) return null;
    if (gameDate !== officialDate || !validIso(startTime)) return null;
    seen.add(gamePk);
    starts.push(Date.parse(startTime));
  }
  return starts;
}

interface ParsedRow {
  sourceRunId: string;
  createdAtMs: number;
  snapshot: MlbDailyBestPickProspectiveSnapshot;
  completeScheduleStarts: number[] | null;
}

function emptyCounts(totalRows: number): MlbDailyBestPickCanonicalizationCounts {
  return {
    totalRows,
    integrityValidRows: 0,
    completeScheduleRows: 0,
    eligiblePregameRows: 0,
    rejectedIntegrityRows: 0,
    rejectedIncompleteScheduleRows: 0,
    rejectedPregameBoundaryRows: 0,
  };
}

function compareCanonicalCandidates(left: ParsedRow, right: ParsedRow): number {
  const captured = Date.parse(right.snapshot.capturedAtUtc) - Date.parse(left.snapshot.capturedAtUtc);
  if (captured !== 0) return captured;
  const generated = Date.parse(right.snapshot.prepriceRuntimeGeneratedAt)
    - Date.parse(left.snapshot.prepriceRuntimeGeneratedAt);
  if (generated !== 0) return generated;
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  const source = left.sourceRunId.localeCompare(right.sourceRunId);
  if (source !== 0) return source;
  return left.snapshot.snapshotDigest.localeCompare(right.snapshot.snapshotDigest);
}

export function canonicalizeMlbDailyBestPickRows(input: {
  officialDate: string;
  rows: readonly MlbDailyBestPickCanonicalizationStoredRow[];
}): MlbDailyBestPickCanonicalizationResult {
  const counts = emptyCounts(input.rows.length);
  if (!validDate(input.officialDate) || input.officialDate < MLB_DAILY_BEST_PICK_PROSPECTIVE_FIRST_DATE) {
    return Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA,
      status: "NO_CANONICAL" as const,
      officialDate: input.officialDate,
      reason: "OFFICIAL_DATE_BEFORE_PROSPECTIVE_BOUNDARY" as const,
      datePregameCutoffUtc: null,
      counts: Object.freeze(counts),
      sortRule: SORT_RULE,
      safety: SAFETY,
    });
  }

  const parsedRows: ParsedRow[] = [];
  for (const row of input.rows) {
    const snapshot = parseMlbDailyBestPickProspectiveSnapshot(row.snapshot);
    const identityValid = snapshot
      && snapshot.officialDate === input.officialDate
      && row.officialDate === input.officialDate
      && snapshot.sourceRunId === row.sourceRunId
      && Number.isSafeInteger(row.createdAtMs)
      && row.createdAtMs > 0;
    if (!identityValid || !snapshot) {
      counts.rejectedIntegrityRows += 1;
      continue;
    }
    counts.integrityValidRows += 1;
    const completeScheduleStarts = scheduleStartsForCompleteSnapshot(snapshot, input.officialDate);
    if (!completeScheduleStarts) {
      counts.rejectedIncompleteScheduleRows += 1;
      parsedRows.push({
        sourceRunId: row.sourceRunId,
        createdAtMs: row.createdAtMs,
        snapshot,
        completeScheduleStarts: null,
      });
      continue;
    }
    counts.completeScheduleRows += 1;
    parsedRows.push({
      sourceRunId: row.sourceRunId,
      createdAtMs: row.createdAtMs,
      snapshot,
      completeScheduleStarts,
    });
  }

  const scheduleRows = parsedRows.filter(
    (row): row is ParsedRow & { completeScheduleStarts: number[] } => Array.isArray(row.completeScheduleStarts),
  );
  if (scheduleRows.length === 0) {
    return Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA,
      status: "NO_CANONICAL" as const,
      officialDate: input.officialDate,
      reason: "NO_INTEGRITY_VALID_COMPLETE_SCHEDULE_SNAPSHOTS" as const,
      datePregameCutoffUtc: null,
      counts: Object.freeze(counts),
      sortRule: SORT_RULE,
      safety: SAFETY,
    });
  }

  const cutoffMs = Math.min(...scheduleRows.flatMap((row) => row.completeScheduleStarts));
  const cutoffUtc = new Date(cutoffMs).toISOString();
  const eligible = scheduleRows.filter((row) => {
    const captured = Date.parse(row.snapshot.capturedAtUtc);
    const generated = Date.parse(row.snapshot.prepriceRuntimeGeneratedAt);
    const accepted = captured < cutoffMs && generated < cutoffMs && row.createdAtMs < cutoffMs;
    if (!accepted) counts.rejectedPregameBoundaryRows += 1;
    return accepted;
  });
  counts.eligiblePregameRows = eligible.length;

  if (eligible.length === 0) {
    return Object.freeze({
      schemaVersion: MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA,
      status: "NO_CANONICAL" as const,
      officialDate: input.officialDate,
      reason: "NO_STRICTLY_PREGAME_INGESTED_SNAPSHOT_BEFORE_DATE_CUTOFF" as const,
      datePregameCutoffUtc: cutoffUtc,
      counts: Object.freeze(counts),
      sortRule: SORT_RULE,
      safety: SAFETY,
    });
  }

  const winner = [...eligible].sort(compareCanonicalCandidates)[0]!;
  return Object.freeze({
    schemaVersion: MLB_DAILY_BEST_PICK_DAILY_CANONICALIZATION_SCHEMA,
    status: "CANONICAL" as const,
    officialDate: input.officialDate,
    datePregameCutoffUtc: cutoffUtc,
    canonicalSourceRunId: winner.sourceRunId,
    canonicalSnapshotDigest: winner.snapshot.snapshotDigest,
    canonicalCapturedAtUtc: winner.snapshot.capturedAtUtc,
    canonicalRuntimeGeneratedAt: winner.snapshot.prepriceRuntimeGeneratedAt,
    canonicalDatabaseCreatedAtMs: winner.createdAtMs,
    canonicalDecision: winner.snapshot.dailyBestPickSelectorResult.decision,
    canonicalSnapshot: winner.snapshot,
    counts: Object.freeze(counts),
    sortRule: SORT_RULE,
    safety: SAFETY,
  });
}

export class MlbDailyBestPickDailyCanonicalizer {
  private readonly sqlite: Database.Database;

  constructor(options: { filename?: string } = {}) {
    const filename = options.filename ?? resolveMlbDailyBestPickProspectiveCustodyDbPath();
    this.sqlite = new Database(filename, { readonly: true, fileMustExist: true });
    this.sqlite.pragma("query_only = ON");
  }

  close(): void {
    this.sqlite.close();
  }

  canonicalizeDate(officialDate: string): MlbDailyBestPickCanonicalizationResult {
    const rows = this.sqlite.prepare(`
      SELECT official_date, source_run_id, created_at_ms, snapshot_json
      FROM mlb_daily_best_pick_prospective_snapshot
      WHERE official_date = ?
      ORDER BY captured_at_utc ASC, source_run_id ASC
    `).all(officialDate) as Array<{
      official_date: string;
      source_run_id: string;
      created_at_ms: number;
      snapshot_json: string;
    }>;

    return canonicalizeMlbDailyBestPickRows({
      officialDate,
      rows: rows.map((row) => ({
        officialDate: row.official_date,
        sourceRunId: row.source_run_id,
        createdAtMs: row.created_at_ms,
        snapshot: JSON.parse(row.snapshot_json),
      })),
    });
  }
}
