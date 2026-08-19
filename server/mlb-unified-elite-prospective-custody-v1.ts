import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  MlbFullModularFrozenLiveCandidate,
  MlbFullModularStrengthTier,
} from "./mlb-full-modular-frozen-live-scorer-v1";
import type { MlbPpHorizonFrozenLiveCandidate } from "./mlb-pp-horizon-frozen-live-scorer-v1";

export const MLB_UNIFIED_ELITE_PROSPECTIVE_CUSTODY_SCHEMA =
  "courtedge-mlb-unified-elite-prospective-custody.v1" as const;
export const MLB_UNIFIED_ELITE_PROSPECTIVE_FIRST_DATE = "2026-08-19" as const;
export const MLB_UNIFIED_ELITE_OUTCOME_EMBARGO_MIN_COMMON_DATES = 50 as const;
export const MLB_UNIFIED_ELITE_OUTCOME_EMBARGO_MIN_DISCORDANT_DATES = 12 as const;

export interface MlbUnifiedEliteProspectiveSafety {
  outcomesRead: false;
  outcomeStatusReadForScoring: false;
  sportsbookPricesRead: false;
  performanceMetricsRead: false;
  stakeCalculated: false;
  automaticBetPlacement: false;
  realFinancialExposure: 0;
}

export interface MlbUnifiedEliteProspectiveGameSnapshot {
  schemaVersion: typeof MLB_UNIFIED_ELITE_PROSPECTIVE_CUSTODY_SCHEMA;
  officialDate: string;
  gamePk: number;
  capturedAtUtc: string;
  decisionDeadlineUtc: string;
  homeStrengthTier: MlbFullModularStrengthTier;
  awayStrengthTier: MlbFullModularStrengthTier;
  fullModularCandidates: readonly MlbFullModularFrozenLiveCandidate[];
  ppHorizonCandidates: readonly MlbPpHorizonFrozenLiveCandidate[];
  candidateUniverseDigest: string;
  snapshotDigest: string;
  sourceStatus: "CERTIFIED_OPERATIONAL_LOWER_TIER_LIVE_V1";
  safety: MlbUnifiedEliteProspectiveSafety;
}

export interface MlbUnifiedEliteProspectiveDateState {
  officialDate: string;
  firstObservedAtUtc: string;
  maturityEligible: boolean;
  captureComplete: boolean;
  parentNoPlayObserved: boolean;
  partialReason: string | null;
  capturedGames: number;
}

export interface MlbUnifiedEliteProspectiveCustodyStatus {
  schemaVersion: typeof MLB_UNIFIED_ELITE_PROSPECTIVE_CUSTODY_SCHEMA;
  firstEligibleOfficialDate: typeof MLB_UNIFIED_ELITE_PROSPECTIVE_FIRST_DATE;
  capturedGames: number;
  distinctCapturedDates: number;
  maturityEligibleDates: number;
  completeParentNoPlayDates: number;
  outcomeEmbargoMinimumCommonDates: typeof MLB_UNIFIED_ELITE_OUTCOME_EMBARGO_MIN_COMMON_DATES;
  outcomeEmbargoMinimumDiscordantDates: typeof MLB_UNIFIED_ELITE_OUTCOME_EMBARGO_MIN_DISCORDANT_DATES;
  outcomeReadUnlocked: false;
  promotionAllowed: false;
  safety: MlbUnifiedEliteProspectiveSafety;
}

const SAFETY: MlbUnifiedEliteProspectiveSafety = Object.freeze({
  outcomesRead: false,
  outcomeStatusReadForScoring: false,
  sportsbookPricesRead: false,
  performanceMetricsRead: false,
  stakeCalculated: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
});

function defaultDbPath(): string {
  const explicit = process.env.MLB_UNIFIED_ELITE_CUSTODY_DB_PATH?.trim();
  if (explicit) return explicit;
  const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayVolume) return path.join(railwayVolume, "mlb-unified-elite-prospective-custody.sqlite");
  return path.join(process.cwd(), "data", "mlb-unified-elite-prospective-custody.sqlite");
}

function ensureParent(filename: string): void {
  if (filename === ":memory:") return;
  fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00.000Z`));
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonical(value: unknown): string {
  if (value === null) return "null";
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

function candidateIdentity(candidate: {
  officialDate: string;
  gamePk: number;
  market: string;
  horizon: string;
  side: string;
  selectedLine: number | null;
}): string {
  return canonical({
    officialDate: candidate.officialDate,
    gamePk: candidate.gamePk,
    market: candidate.market,
    horizon: candidate.horizon,
    side: candidate.side,
    selectedLine: candidate.selectedLine,
  });
}

function candidateUniverseDigest(
  full: readonly MlbFullModularFrozenLiveCandidate[],
  pp: readonly MlbPpHorizonFrozenLiveCandidate[],
): string {
  const fullIds = full.map(candidateIdentity).sort();
  const ppIds = pp.map(candidateIdentity).sort();
  if (fullIds.length !== ppIds.length || fullIds.some((value, index) => value !== ppIds[index])) {
    throw new Error("MLB_UNIFIED_ELITE_CUSTODY_CANDIDATE_UNIVERSE_DRIFT");
  }
  return sha256(fullIds);
}

function snapshotDigestPayload(snapshot: Omit<MlbUnifiedEliteProspectiveGameSnapshot, "snapshotDigest">): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    officialDate: snapshot.officialDate,
    gamePk: snapshot.gamePk,
    capturedAtUtc: snapshot.capturedAtUtc,
    decisionDeadlineUtc: snapshot.decisionDeadlineUtc,
    homeStrengthTier: snapshot.homeStrengthTier,
    awayStrengthTier: snapshot.awayStrengthTier,
    fullModularCandidates: snapshot.fullModularCandidates,
    ppHorizonCandidates: snapshot.ppHorizonCandidates,
    candidateUniverseDigest: snapshot.candidateUniverseDigest,
    sourceStatus: snapshot.sourceStatus,
    safety: snapshot.safety,
  };
}

function validateCandidateRows(
  officialDate: string,
  gamePk: number,
  rows: readonly Array<{ officialDate: string; gamePk: number }>,
  label: string,
): void {
  for (const row of rows) {
    if (row.officialDate !== officialDate || row.gamePk !== gamePk) {
      throw new Error(`MLB_UNIFIED_ELITE_CUSTODY_${label}_IDENTITY_MISMATCH`);
    }
  }
}

export function buildMlbUnifiedEliteProspectiveGameSnapshot(input: {
  officialDate: string;
  gamePk: number;
  capturedAtUtc: string;
  decisionDeadlineUtc: string;
  homeStrengthTier: MlbFullModularStrengthTier;
  awayStrengthTier: MlbFullModularStrengthTier;
  fullModularCandidates: readonly MlbFullModularFrozenLiveCandidate[];
  ppHorizonCandidates: readonly MlbPpHorizonFrozenLiveCandidate[];
}): MlbUnifiedEliteProspectiveGameSnapshot {
  if (!validDate(input.officialDate) || input.officialDate < MLB_UNIFIED_ELITE_PROSPECTIVE_FIRST_DATE) {
    throw new Error("MLB_UNIFIED_ELITE_CUSTODY_DATE_INVALID");
  }
  if (!Number.isInteger(input.gamePk) || input.gamePk <= 0) {
    throw new Error("MLB_UNIFIED_ELITE_CUSTODY_GAME_PK_INVALID");
  }
  if (!validIso(input.capturedAtUtc) || !validIso(input.decisionDeadlineUtc)) {
    throw new Error("MLB_UNIFIED_ELITE_CUSTODY_TIMESTAMP_INVALID");
  }
  if (Date.parse(input.capturedAtUtc) >= Date.parse(input.decisionDeadlineUtc)) {
    throw new Error("MLB_UNIFIED_ELITE_CUSTODY_CAPTURE_NOT_STRICTLY_PREGAME_T5");
  }
  validateCandidateRows(input.officialDate, input.gamePk, input.fullModularCandidates, "FULL_MODULAR");
  validateCandidateRows(input.officialDate, input.gamePk, input.ppHorizonCandidates, "PP_HORIZON");
  const universeDigest = candidateUniverseDigest(input.fullModularCandidates, input.ppHorizonCandidates);
  const withoutDigest: Omit<MlbUnifiedEliteProspectiveGameSnapshot, "snapshotDigest"> = {
    schemaVersion: MLB_UNIFIED_ELITE_PROSPECTIVE_CUSTODY_SCHEMA,
    officialDate: input.officialDate,
    gamePk: input.gamePk,
    capturedAtUtc: new Date(input.capturedAtUtc).toISOString(),
    decisionDeadlineUtc: new Date(input.decisionDeadlineUtc).toISOString(),
    homeStrengthTier: input.homeStrengthTier,
    awayStrengthTier: input.awayStrengthTier,
    fullModularCandidates: Object.freeze([...input.fullModularCandidates]),
    ppHorizonCandidates: Object.freeze([...input.ppHorizonCandidates]),
    candidateUniverseDigest: universeDigest,
    sourceStatus: "CERTIFIED_OPERATIONAL_LOWER_TIER_LIVE_V1",
    safety: SAFETY,
  };
  return Object.freeze({
    ...withoutDigest,
    snapshotDigest: sha256(snapshotDigestPayload(withoutDigest)),
  });
}

export function parseMlbUnifiedEliteProspectiveGameSnapshot(
  raw: unknown,
): MlbUnifiedEliteProspectiveGameSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as MlbUnifiedEliteProspectiveGameSnapshot;
  try {
    if (value.schemaVersion !== MLB_UNIFIED_ELITE_PROSPECTIVE_CUSTODY_SCHEMA) return null;
    const rebuilt = buildMlbUnifiedEliteProspectiveGameSnapshot({
      officialDate: value.officialDate,
      gamePk: value.gamePk,
      capturedAtUtc: value.capturedAtUtc,
      decisionDeadlineUtc: value.decisionDeadlineUtc,
      homeStrengthTier: value.homeStrengthTier,
      awayStrengthTier: value.awayStrengthTier,
      fullModularCandidates: Array.isArray(value.fullModularCandidates) ? value.fullModularCandidates : [],
      ppHorizonCandidates: Array.isArray(value.ppHorizonCandidates) ? value.ppHorizonCandidates : [],
    });
    return rebuilt.snapshotDigest === value.snapshotDigest
      && rebuilt.candidateUniverseDigest === value.candidateUniverseDigest
      ? rebuilt
      : null;
  } catch {
    return null;
  }
}

export class MlbUnifiedEliteProspectiveCustodyStore {
  readonly schemaVersion = MLB_UNIFIED_ELITE_PROSPECTIVE_CUSTODY_SCHEMA;
  private readonly sqlite: Database.Database;

  constructor(options: { filename?: string } = {}) {
    const filename = options.filename ?? defaultDbPath();
    ensureParent(filename);
    this.sqlite = new Database(filename);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("busy_timeout = 5000");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mlb_unified_elite_prospective_game_snapshot (
        official_date TEXT NOT NULL,
        game_pk INTEGER NOT NULL,
        captured_at_utc TEXT NOT NULL,
        decision_deadline_utc TEXT NOT NULL,
        candidate_universe_digest TEXT NOT NULL,
        snapshot_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (official_date, game_pk)
      );
      CREATE TABLE IF NOT EXISTS mlb_unified_elite_prospective_date_state (
        official_date TEXT PRIMARY KEY,
        first_observed_at_utc TEXT NOT NULL,
        maturity_eligible INTEGER NOT NULL,
        capture_complete INTEGER NOT NULL DEFAULT 0,
        parent_no_play_observed INTEGER NOT NULL DEFAULT 0,
        partial_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mlb_unified_elite_prospective_snapshot_date
        ON mlb_unified_elite_prospective_game_snapshot(official_date, game_pk);
    `);
  }

  close(): void {
    this.sqlite.close();
  }

  get(officialDate: string, gamePk: number): MlbUnifiedEliteProspectiveGameSnapshot | null {
    const row = this.sqlite.prepare(`
      SELECT snapshot_json FROM mlb_unified_elite_prospective_game_snapshot
      WHERE official_date = ? AND game_pk = ?
    `).get(officialDate, gamePk) as { snapshot_json: string } | undefined;
    if (!row) return null;
    try {
      const parsed = parseMlbUnifiedEliteProspectiveGameSnapshot(JSON.parse(row.snapshot_json));
      if (!parsed) throw new Error("MLB_UNIFIED_ELITE_CUSTODY_STORED_SNAPSHOT_INTEGRITY_FAILED");
      return parsed;
    } catch (error) {
      throw error instanceof Error ? error : new Error("MLB_UNIFIED_ELITE_CUSTODY_STORED_SNAPSHOT_INVALID");
    }
  }

  putFirstCanonical(
    snapshotInput: MlbUnifiedEliteProspectiveGameSnapshot,
  ): { inserted: boolean; snapshot: MlbUnifiedEliteProspectiveGameSnapshot } {
    const snapshot = parseMlbUnifiedEliteProspectiveGameSnapshot(snapshotInput);
    if (!snapshot) throw new Error("MLB_UNIFIED_ELITE_CUSTODY_SNAPSHOT_INVALID");
    const result = this.sqlite.prepare(`
      INSERT OR IGNORE INTO mlb_unified_elite_prospective_game_snapshot
        (official_date, game_pk, captured_at_utc, decision_deadline_utc, candidate_universe_digest, snapshot_digest, snapshot_json, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.officialDate,
      snapshot.gamePk,
      snapshot.capturedAtUtc,
      snapshot.decisionDeadlineUtc,
      snapshot.candidateUniverseDigest,
      snapshot.snapshotDigest,
      JSON.stringify(snapshot),
      Date.now(),
    );
    const canonicalSnapshot = this.get(snapshot.officialDate, snapshot.gamePk);
    if (!canonicalSnapshot) throw new Error("MLB_UNIFIED_ELITE_CUSTODY_CANONICAL_READBACK_FAILED");
    return { inserted: result.changes === 1, snapshot: canonicalSnapshot };
  }

  listDate(officialDate: string): readonly MlbUnifiedEliteProspectiveGameSnapshot[] {
    const rows = this.sqlite.prepare(`
      SELECT snapshot_json FROM mlb_unified_elite_prospective_game_snapshot
      WHERE official_date = ? ORDER BY game_pk ASC
    `).all(officialDate) as Array<{ snapshot_json: string }>;
    return Object.freeze(rows.map((row) => {
      const parsed = parseMlbUnifiedEliteProspectiveGameSnapshot(JSON.parse(row.snapshot_json));
      if (!parsed) throw new Error("MLB_UNIFIED_ELITE_CUSTODY_STORED_SNAPSHOT_INTEGRITY_FAILED");
      return parsed;
    }));
  }

  observeDate(input: {
    officialDate: string;
    observedAtUtc: string;
    earliestDecisionDeadlineUtc: string | null;
  }): MlbUnifiedEliteProspectiveDateState {
    if (!validDate(input.officialDate) || !validIso(input.observedAtUtc)) {
      throw new Error("MLB_UNIFIED_ELITE_CUSTODY_DATE_OBSERVATION_INVALID");
    }
    const beforeFirstDeadline = input.earliestDecisionDeadlineUtc !== null
      && validIso(input.earliestDecisionDeadlineUtc)
      && Date.parse(input.observedAtUtc) < Date.parse(input.earliestDecisionDeadlineUtc);
    const maturityEligible = input.officialDate >= MLB_UNIFIED_ELITE_PROSPECTIVE_FIRST_DATE && beforeFirstDeadline;
    this.sqlite.prepare(`
      INSERT OR IGNORE INTO mlb_unified_elite_prospective_date_state
        (official_date, first_observed_at_utc, maturity_eligible, capture_complete, parent_no_play_observed, partial_reason)
      VALUES (?, ?, ?, 0, 0, ?)
    `).run(
      input.officialDate,
      new Date(input.observedAtUtc).toISOString(),
      maturityEligible ? 1 : 0,
      maturityEligible ? null : "SERVICE_FIRST_OBSERVED_AFTER_FIRST_T5_OR_NO_VALID_DEADLINE",
    );
    return this.getDateState(input.officialDate)!;
  }

  markDatePartial(officialDate: string, reasonInput: string): void {
    const reason = String(reasonInput ?? "").trim() || "CAPTURE_INCOMPLETE";
    this.sqlite.prepare(`
      UPDATE mlb_unified_elite_prospective_date_state
      SET maturity_eligible = 0,
          capture_complete = 0,
          partial_reason = COALESCE(partial_reason, ?)
      WHERE official_date = ?
    `).run(reason, officialDate);
  }

  markDateComplete(officialDate: string): void {
    this.sqlite.prepare(`
      UPDATE mlb_unified_elite_prospective_date_state
      SET capture_complete = CASE WHEN maturity_eligible = 1 AND partial_reason IS NULL THEN 1 ELSE 0 END
      WHERE official_date = ?
    `).run(officialDate);
  }

  markParentNoPlayObserved(officialDate: string): void {
    this.sqlite.prepare(`
      UPDATE mlb_unified_elite_prospective_date_state
      SET parent_no_play_observed = 1
      WHERE official_date = ?
    `).run(officialDate);
  }

  getDateState(officialDate: string): MlbUnifiedEliteProspectiveDateState | null {
    const row = this.sqlite.prepare(`
      SELECT official_date, first_observed_at_utc, maturity_eligible, capture_complete,
             parent_no_play_observed, partial_reason
      FROM mlb_unified_elite_prospective_date_state WHERE official_date = ?
    `).get(officialDate) as {
      official_date: string;
      first_observed_at_utc: string;
      maturity_eligible: number;
      capture_complete: number;
      parent_no_play_observed: number;
      partial_reason: string | null;
    } | undefined;
    if (!row) return null;
    const count = this.sqlite.prepare(`
      SELECT COUNT(*) AS n FROM mlb_unified_elite_prospective_game_snapshot WHERE official_date = ?
    `).get(officialDate) as { n: number };
    return {
      officialDate: row.official_date,
      firstObservedAtUtc: row.first_observed_at_utc,
      maturityEligible: row.maturity_eligible === 1,
      captureComplete: row.capture_complete === 1,
      parentNoPlayObserved: row.parent_no_play_observed === 1,
      partialReason: row.partial_reason,
      capturedGames: Number(count.n),
    };
  }

  status(): MlbUnifiedEliteProspectiveCustodyStatus {
    const snapshots = this.sqlite.prepare(`
      SELECT COUNT(*) AS games, COUNT(DISTINCT official_date) AS dates
      FROM mlb_unified_elite_prospective_game_snapshot
    `).get() as { games: number; dates: number };
    const dateCounts = this.sqlite.prepare(`
      SELECT
        SUM(CASE WHEN maturity_eligible = 1 THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN maturity_eligible = 1 AND capture_complete = 1 AND parent_no_play_observed = 1 THEN 1 ELSE 0 END) AS complete_parent_no_play
      FROM mlb_unified_elite_prospective_date_state
    `).get() as { eligible: number | null; complete_parent_no_play: number | null };
    return Object.freeze({
      schemaVersion: MLB_UNIFIED_ELITE_PROSPECTIVE_CUSTODY_SCHEMA,
      firstEligibleOfficialDate: MLB_UNIFIED_ELITE_PROSPECTIVE_FIRST_DATE,
      capturedGames: Number(snapshots.games ?? 0),
      distinctCapturedDates: Number(snapshots.dates ?? 0),
      maturityEligibleDates: Number(dateCounts.eligible ?? 0),
      completeParentNoPlayDates: Number(dateCounts.complete_parent_no_play ?? 0),
      outcomeEmbargoMinimumCommonDates: MLB_UNIFIED_ELITE_OUTCOME_EMBARGO_MIN_COMMON_DATES,
      outcomeEmbargoMinimumDiscordantDates: MLB_UNIFIED_ELITE_OUTCOME_EMBARGO_MIN_DISCORDANT_DATES,
      outcomeReadUnlocked: false,
      promotionAllowed: false,
      safety: SAFETY,
    });
  }
}
