import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { z } from "zod";
import { mlbInjuryAuditSchema } from "./mlb-injury-audit";

export const MLB_LEDGER_SCHEMA_VERSION = "mlb-ledger.v1" as const;
const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "mlb-ledger-v1.sqlite");
const idPattern = /^[A-Za-z0-9._:-]{1,160}$/;

const sourceSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(120),
  status: z.enum(["VERIFIED", "PARTIAL", "PROXY", "PRIOR", "MANUAL", "MISSING", "STALE", "UNKNOWN"]),
  fetchedAt: z.string().datetime().optional(),
  asOf: z.string().max(80).optional(),
  sample: z.number().finite().nonnegative().optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const factorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  direction: z.enum(["HOME", "AWAY", "OVER", "UNDER", "FOR", "AGAINST", "NEUTRAL"]),
  magnitude: z.number().finite().optional(),
  units: z.string().max(40).optional(),
  confidence: z.enum(["FULL", "PARTIAL", "LOW", "UNKNOWN"]).optional(),
  source: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
}).strict();

export const mlbPredictionInputSchema = z.object({
  schemaVersion: z.literal(MLB_LEDGER_SCHEMA_VERSION).default(MLB_LEDGER_SCHEMA_VERSION),
  clientRequestId: z.string().regex(idPattern).optional(),
  source: z.enum(["app", "manual", "backfill", "migration"]).default("app"),
  supersedesId: z.string().regex(idPattern).optional(),
  model: z.object({
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(120),
    gitCommit: z.string().max(80).optional(),
    environment: z.string().max(80).optional(),
  }).strict(),
  game: z.object({
    gamePk: z.number().int().positive().optional(),
    gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    commenceTime: z.string().datetime().optional(),
    homeTeam: z.string().trim().min(1).max(120),
    awayTeam: z.string().trim().min(1).max(120),
    venue: z.string().max(160).optional(),
  }).strict(),
  market: z.object({
    type: z.enum(["ML", "F5_ML", "RUN_LINE", "TOTAL", "F5_TOTAL", "TEAM_TOTAL", "TT_OVER_15_F5", "TT_UNDER_25_F5", "INNING_1_ML", "NRFI", "YRFI", "OTHER"]),
    selection: z.string().trim().min(1).max(200),
    line: z.number().finite().optional(),
    oddsAmerican: z.number().int().min(-100000).max(100000).refine((value) => value !== 0, "Odds cannot be zero"),
    book: z.string().max(80).optional(),
    capturedAt: z.string().datetime().optional(),
  }).strict(),
  probabilities: z.object({
    model: z.number().finite().min(0.001).max(0.999),
    marketImplied: z.number().finite().min(0.001).max(0.999).optional(),
    noVig: z.number().finite().min(0.001).max(0.999).optional(),
    edgePp: z.number().finite().min(-100).max(100).optional(),
  }).strict(),
  decision: z.object({
    signal: z.enum(["BET_FUERTE", "BET", "LEAN", "PASS", "INFO"]),
    confidenceLabel: z.string().max(40).optional(),
    confidencePct: z.number().finite().min(0).max(100).optional(),
    stakeUnits: z.number().finite().min(0).max(100).default(0),
    rationale: z.string().max(4000).optional(),
  }).strict(),
  analysis: z.object({
    stage: z.enum(["PROVISIONAL", "FINAL"]),
    warnings: z.array(z.string().max(500)).max(100).optional(),
    factors: z.array(factorSchema).max(200).optional(),
    sources: z.array(sourceSnapshotSchema).max(200).optional(),
    layers: z.record(z.unknown()).optional(),
    injuryAudit: mlbInjuryAuditSchema.optional(),
    rawInputs: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
  }).strict(),
}).strict();

export const mlbSettlementInputSchema = z.object({
  clientRequestId: z.string().regex(idPattern).optional(),
  settledAt: z.string().datetime().optional(),
  result: z.enum(["WIN", "LOSS", "PUSH", "VOID", "HALF_WIN", "HALF_LOSS"]),
  closingOddsAmerican: z.number().int().min(-100000).max(100000).refine((value) => value !== 0, "Odds cannot be zero").optional(),
  closingLine: z.number().finite().optional(),
  outcomeValue: z.number().finite().optional(),
  finalScore: z.object({ home: z.number().int().nonnegative(), away: z.number().int().nonnegative() }).strict().optional(),
  profitUnitsOverride: z.number().finite().min(-1000).max(1000).optional(),
  source: z.enum(["official", "manual", "migration", "correction"]).default("official"),
  correctionOfEventId: z.string().regex(idPattern).optional(),
  notes: z.string().max(2000).optional(),
}).strict();

export type MlbPredictionInput = z.infer<typeof mlbPredictionInputSchema>;
export type MlbSettlementInput = z.infer<typeof mlbSettlementInputSchema>;

interface PredictionRow {
  id: string;
  client_request_id: string | null;
  recorded_at_ms: number;
  game_pk: number | null;
  game_date: string;
  commence_time: string | null;
  home_team: string;
  away_team: string;
  market_type: string;
  selection: string;
  line: number | null;
  odds_american: number;
  book: string | null;
  model_prob: number;
  market_implied_prob: number;
  no_vig_prob: number | null;
  edge_pp: number;
  signal: string;
  confidence_label: string | null;
  confidence_pct: number | null;
  stake_units: number;
  analysis_stage: string;
  model_name: string;
  model_version: string;
  git_commit: string | null;
  environment: string | null;
  supersedes_id: string | null;
  source: string;
  payload_sha256: string;
  payload_json: string;
}

interface SettlementRow {
  event_id: string;
  prediction_id: string;
  client_request_id: string | null;
  recorded_at_ms: number;
  settled_at_ms: number;
  result: string;
  closing_odds_american: number | null;
  closing_line: number | null;
  closing_implied_prob: number | null;
  clv_pp: number | null;
  outcome_value: number | null;
  final_home_score: number | null;
  final_away_score: number | null;
  profit_units: number;
  source: string;
  correction_of_event_id: string | null;
  notes: string | null;
  payload_sha256: string;
  payload_json: string;
}

function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function generatedId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

export function americanToProbability(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function decimalProfitMultiple(odds: number): number {
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function profitFor(result: MlbSettlementInput["result"], stake: number, odds: number): number {
  const winProfit = stake * decimalProfitMultiple(odds);
  if (result === "WIN") return round(winProfit, 4);
  if (result === "LOSS") return round(-stake, 4);
  if (result === "HALF_WIN") return round(winProfit / 2, 4);
  if (result === "HALF_LOSS") return round(-stake / 2, 4);
  return 0;
}

function scoringOutcome(result: string): number | null {
  if (result === "WIN") return 1;
  if (result === "LOSS") return 0;
  if (result === "HALF_WIN") return 0.75;
  if (result === "HALF_LOSS") return 0.25;
  return null;
}

function mapPrediction(row: PredictionRow) {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    recordedAt: new Date(row.recorded_at_ms).toISOString(),
    recordedAtMs: row.recorded_at_ms,
    game: { gamePk: row.game_pk, gameDate: row.game_date, commenceTime: row.commence_time, homeTeam: row.home_team, awayTeam: row.away_team },
    market: { type: row.market_type, selection: row.selection, line: row.line, oddsAmerican: row.odds_american, book: row.book },
    probabilities: { model: row.model_prob, marketImplied: row.market_implied_prob, noVig: row.no_vig_prob, edgePp: row.edge_pp },
    decision: { signal: row.signal, confidenceLabel: row.confidence_label, confidencePct: row.confidence_pct, stakeUnits: row.stake_units },
    analysisStage: row.analysis_stage,
    model: { name: row.model_name, version: row.model_version, gitCommit: row.git_commit, environment: row.environment },
    supersedesId: row.supersedes_id,
    source: row.source,
    payloadSha256: row.payload_sha256,
    payload: JSON.parse(row.payload_json),
  };
}

function mapSettlement(row: SettlementRow) {
  return {
    eventId: row.event_id,
    predictionId: row.prediction_id,
    clientRequestId: row.client_request_id,
    recordedAt: new Date(row.recorded_at_ms).toISOString(),
    recordedAtMs: row.recorded_at_ms,
    settledAt: new Date(row.settled_at_ms).toISOString(),
    result: row.result,
    closingOddsAmerican: row.closing_odds_american,
    closingLine: row.closing_line,
    closingImpliedProbability: row.closing_implied_prob,
    clvPp: row.clv_pp,
    outcomeValue: row.outcome_value,
    finalScore: row.final_home_score == null || row.final_away_score == null ? null : { home: row.final_home_score, away: row.final_away_score },
    profitUnits: row.profit_units,
    source: row.source,
    correctionOfEventId: row.correction_of_event_id,
    notes: row.notes,
    payloadSha256: row.payload_sha256,
    payload: JSON.parse(row.payload_json),
  };
}

export type LedgerPrediction = ReturnType<typeof mapPrediction>;
export type LedgerSettlement = ReturnType<typeof mapSettlement>;
export interface LedgerRecord { prediction: LedgerPrediction; settlement: LedgerSettlement | null }

export class MlbLedgerStore {
  private db: any;

  constructor(filePath = process.env.MLB_LEDGER_DB_PATH || DEFAULT_DB_PATH) {
    ensureParent(filePath);
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mlb_ledger_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mlb_prediction_ledger_v1 (
        id TEXT PRIMARY KEY,
        client_request_id TEXT UNIQUE,
        recorded_at_ms INTEGER NOT NULL,
        game_pk INTEGER,
        game_date TEXT NOT NULL,
        commence_time TEXT,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        market_type TEXT NOT NULL,
        selection TEXT NOT NULL,
        line REAL,
        odds_american INTEGER NOT NULL,
        book TEXT,
        model_prob REAL NOT NULL CHECK(model_prob > 0 AND model_prob < 1),
        market_implied_prob REAL NOT NULL CHECK(market_implied_prob > 0 AND market_implied_prob < 1),
        no_vig_prob REAL,
        edge_pp REAL NOT NULL,
        signal TEXT NOT NULL,
        confidence_label TEXT,
        confidence_pct REAL,
        stake_units REAL NOT NULL CHECK(stake_units >= 0),
        analysis_stage TEXT NOT NULL,
        model_name TEXT NOT NULL,
        model_version TEXT NOT NULL,
        git_commit TEXT,
        environment TEXT,
        supersedes_id TEXT REFERENCES mlb_prediction_ledger_v1(id),
        source TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mlb_settlement_events_v1 (
        event_id TEXT PRIMARY KEY,
        prediction_id TEXT NOT NULL REFERENCES mlb_prediction_ledger_v1(id),
        client_request_id TEXT UNIQUE,
        recorded_at_ms INTEGER NOT NULL,
        settled_at_ms INTEGER NOT NULL,
        result TEXT NOT NULL,
        closing_odds_american INTEGER,
        closing_line REAL,
        closing_implied_prob REAL,
        clv_pp REAL,
        outcome_value REAL,
        final_home_score INTEGER,
        final_away_score INTEGER,
        profit_units REAL NOT NULL,
        source TEXT NOT NULL,
        correction_of_event_id TEXT REFERENCES mlb_settlement_events_v1(event_id),
        notes TEXT,
        payload_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mlb_prediction_game_date ON mlb_prediction_ledger_v1(game_date);
      CREATE INDEX IF NOT EXISTS idx_mlb_prediction_market ON mlb_prediction_ledger_v1(market_type);
      CREATE INDEX IF NOT EXISTS idx_mlb_prediction_confidence ON mlb_prediction_ledger_v1(confidence_label);
      CREATE INDEX IF NOT EXISTS idx_mlb_prediction_signal ON mlb_prediction_ledger_v1(signal);
      CREATE INDEX IF NOT EXISTS idx_mlb_settlement_prediction ON mlb_settlement_events_v1(prediction_id, recorded_at_ms DESC);
      CREATE TRIGGER IF NOT EXISTS mlb_prediction_immutable_update BEFORE UPDATE ON mlb_prediction_ledger_v1 BEGIN SELECT RAISE(ABORT, 'mlb prediction ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_prediction_immutable_delete BEFORE DELETE ON mlb_prediction_ledger_v1 BEGIN SELECT RAISE(ABORT, 'mlb prediction ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_settlement_immutable_update BEFORE UPDATE ON mlb_settlement_events_v1 BEGIN SELECT RAISE(ABORT, 'mlb settlement ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_settlement_immutable_delete BEFORE DELETE ON mlb_settlement_events_v1 BEGIN SELECT RAISE(ABORT, 'mlb settlement ledger is immutable'); END;
    `);
    this.db.prepare("INSERT OR IGNORE INTO mlb_ledger_migrations(version, applied_at_ms) VALUES(1, ?)").run(Date.now());
  }

  status() {
    const predictions = this.db.prepare("SELECT COUNT(*) AS n FROM mlb_prediction_ledger_v1").get().n as number;
    const settlementEvents = this.db.prepare("SELECT COUNT(*) AS n FROM mlb_settlement_events_v1").get().n as number;
    const latest = this.db.prepare("SELECT MAX(recorded_at_ms) AS ts FROM mlb_prediction_ledger_v1").get().ts as number | null;
    return {
      schemaVersion: MLB_LEDGER_SCHEMA_VERSION,
      predictions,
      settlementEvents,
      latestPredictionAt: latest ? new Date(latest).toISOString() : null,
      immutable: true,
      journalMode: this.db.pragma("journal_mode", { simple: true }),
    };
  }

  appendPrediction(raw: unknown): { data: LedgerPrediction; idempotent: boolean } {
    const parsed = mlbPredictionInputSchema.parse(raw);
    const payloadJson = canonicalJson(parsed);
    const payloadSha256 = sha256(payloadJson);

    if (parsed.clientRequestId) {
      const existing = this.db.prepare("SELECT * FROM mlb_prediction_ledger_v1 WHERE client_request_id = ?").get(parsed.clientRequestId) as PredictionRow | undefined;
      if (existing) {
        if (existing.payload_sha256 !== payloadSha256) throw Object.assign(new Error("clientRequestId already exists with different payload"), { status: 409 });
        return { data: mapPrediction(existing), idempotent: true };
      }
    }

    if (parsed.supersedesId && !this.db.prepare("SELECT id FROM mlb_prediction_ledger_v1 WHERE id = ?").get(parsed.supersedesId)) {
      throw Object.assign(new Error("supersedesId does not exist"), { status: 400 });
    }

    const id = generatedId("mlb-pred");
    const recordedAtMs = Date.now();
    const marketImplied = parsed.probabilities.marketImplied ?? americanToProbability(parsed.market.oddsAmerican);
    const edgePp = parsed.probabilities.edgePp ?? (parsed.probabilities.model - (parsed.probabilities.noVig ?? marketImplied)) * 100;
    const gitCommit = parsed.model.gitCommit || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;
    const environment = parsed.model.environment || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || null;

    this.db.prepare(`
      INSERT INTO mlb_prediction_ledger_v1 (
        id, client_request_id, recorded_at_ms, game_pk, game_date, commence_time,
        home_team, away_team, market_type, selection, line, odds_american, book,
        model_prob, market_implied_prob, no_vig_prob, edge_pp, signal,
        confidence_label, confidence_pct, stake_units, analysis_stage,
        model_name, model_version, git_commit, environment, supersedes_id,
        source, payload_sha256, payload_json
      ) VALUES (
        @id, @clientRequestId, @recordedAtMs, @gamePk, @gameDate, @commenceTime,
        @homeTeam, @awayTeam, @marketType, @selection, @line, @oddsAmerican, @book,
        @modelProb, @marketImplied, @noVig, @edgePp, @signal,
        @confidenceLabel, @confidencePct, @stakeUnits, @analysisStage,
        @modelName, @modelVersion, @gitCommit, @environment, @supersedesId,
        @source, @payloadSha256, @payloadJson
      )
    `).run({
      id,
      clientRequestId: parsed.clientRequestId ?? null,
      recordedAtMs,
      gamePk: parsed.game.gamePk ?? null,
      gameDate: parsed.game.gameDate,
      commenceTime: parsed.game.commenceTime ?? null,
      homeTeam: parsed.game.homeTeam,
      awayTeam: parsed.game.awayTeam,
      marketType: parsed.market.type,
      selection: parsed.market.selection,
      line: parsed.market.line ?? null,
      oddsAmerican: parsed.market.oddsAmerican,
      book: parsed.market.book ?? null,
      modelProb: parsed.probabilities.model,
      marketImplied,
      noVig: parsed.probabilities.noVig ?? null,
      edgePp,
      signal: parsed.decision.signal,
      confidenceLabel: parsed.decision.confidenceLabel ?? null,
      confidencePct: parsed.decision.confidencePct ?? null,
      stakeUnits: parsed.decision.stakeUnits,
      analysisStage: parsed.analysis.stage,
      modelName: parsed.model.name,
      modelVersion: parsed.model.version,
      gitCommit,
      environment,
      supersedesId: parsed.supersedesId ?? null,
      source: parsed.source,
      payloadSha256,
      payloadJson,
    });
    return { data: this.getPrediction(id)!, idempotent: false };
  }

  appendSettlement(predictionId: string, raw: unknown): { data: LedgerSettlement; idempotent: boolean } {
    if (!idPattern.test(predictionId)) throw Object.assign(new Error("Invalid prediction id"), { status: 400 });
    const prediction = this.db.prepare("SELECT * FROM mlb_prediction_ledger_v1 WHERE id = ?").get(predictionId) as PredictionRow | undefined;
    if (!prediction) throw Object.assign(new Error("Prediction not found"), { status: 404 });

    const parsed = mlbSettlementInputSchema.parse(raw);
    const payloadJson = canonicalJson(parsed);
    const payloadSha256 = sha256(payloadJson);
    if (parsed.clientRequestId) {
      const existing = this.db.prepare("SELECT * FROM mlb_settlement_events_v1 WHERE client_request_id = ?").get(parsed.clientRequestId) as SettlementRow | undefined;
      if (existing) {
        if (existing.prediction_id !== predictionId || existing.payload_sha256 !== payloadSha256) throw Object.assign(new Error("clientRequestId already exists with different settlement"), { status: 409 });
        return { data: mapSettlement(existing), idempotent: true };
      }
    }

    if (parsed.correctionOfEventId) {
      const corrected = this.db.prepare("SELECT prediction_id FROM mlb_settlement_events_v1 WHERE event_id = ?").get(parsed.correctionOfEventId) as { prediction_id: string } | undefined;
      if (!corrected || corrected.prediction_id !== predictionId) throw Object.assign(new Error("correctionOfEventId is invalid for this prediction"), { status: 400 });
    }

    const eventId = generatedId("mlb-settle");
    const recordedAtMs = Date.now();
    const settledAtMs = parsed.settledAt ? Date.parse(parsed.settledAt) : recordedAtMs;
    const closingImplied = parsed.closingOddsAmerican == null ? null : americanToProbability(parsed.closingOddsAmerican);
    const clvPp = closingImplied == null ? null : (closingImplied - prediction.market_implied_prob) * 100;
    const profitUnits = parsed.profitUnitsOverride ?? profitFor(parsed.result, prediction.stake_units, prediction.odds_american);

    this.db.prepare(`
      INSERT INTO mlb_settlement_events_v1 (
        event_id, prediction_id, client_request_id, recorded_at_ms, settled_at_ms,
        result, closing_odds_american, closing_line, closing_implied_prob, clv_pp,
        outcome_value, final_home_score, final_away_score, profit_units, source,
        correction_of_event_id, notes, payload_sha256, payload_json
      ) VALUES (
        @eventId, @predictionId, @clientRequestId, @recordedAtMs, @settledAtMs,
        @result, @closingOdds, @closingLine, @closingImplied, @clvPp,
        @outcomeValue, @finalHome, @finalAway, @profitUnits, @source,
        @correctionOf, @notes, @payloadSha256, @payloadJson
      )
    `).run({
      eventId,
      predictionId,
      clientRequestId: parsed.clientRequestId ?? null,
      recordedAtMs,
      settledAtMs,
      result: parsed.result,
      closingOdds: parsed.closingOddsAmerican ?? null,
      closingLine: parsed.closingLine ?? null,
      closingImplied,
      clvPp,
      outcomeValue: parsed.outcomeValue ?? null,
      finalHome: parsed.finalScore?.home ?? null,
      finalAway: parsed.finalScore?.away ?? null,
      profitUnits,
      source: parsed.source,
      correctionOf: parsed.correctionOfEventId ?? null,
      notes: parsed.notes ?? null,
      payloadSha256,
      payloadJson,
    });
    return { data: mapSettlement(this.db.prepare("SELECT * FROM mlb_settlement_events_v1 WHERE event_id = ?").get(eventId) as SettlementRow), idempotent: false };
  }

  getPrediction(id: string): LedgerPrediction | null {
    const row = this.db.prepare("SELECT * FROM mlb_prediction_ledger_v1 WHERE id = ?").get(id) as PredictionRow | undefined;
    return row ? mapPrediction(row) : null;
  }

  latestSettlement(predictionId: string): LedgerSettlement | null {
    const row = this.db.prepare(`
      SELECT * FROM mlb_settlement_events_v1
      WHERE prediction_id = ?
      ORDER BY recorded_at_ms DESC, event_id DESC
      LIMIT 1
    `).get(predictionId) as SettlementRow | undefined;
    return row ? mapSettlement(row) : null;
  }

  getRecord(id: string): LedgerRecord | null {
    const prediction = this.getPrediction(id);
    return prediction ? { prediction, settlement: this.latestSettlement(id) } : null;
  }

  listRecords(filters: { from?: string; to?: string; market?: string; confidence?: string; signal?: string; stage?: string; settled?: boolean; limit?: number } = {}): LedgerRecord[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filters.from) { clauses.push("p.game_date >= @from"); params.from = filters.from; }
    if (filters.to) { clauses.push("p.game_date <= @to"); params.to = filters.to; }
    if (filters.market) { clauses.push("p.market_type = @market"); params.market = filters.market; }
    if (filters.confidence) { clauses.push("p.confidence_label = @confidence"); params.confidence = filters.confidence; }
    if (filters.signal) { clauses.push("p.signal = @signal"); params.signal = filters.signal; }
    if (filters.stage) { clauses.push("p.analysis_stage = @stage"); params.stage = filters.stage; }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(10000, Math.max(1, filters.limit ?? 1000));

    const rows = this.db.prepare(`
      SELECT p.*,
        s.event_id AS s_event_id, s.prediction_id AS s_prediction_id,
        s.client_request_id AS s_client_request_id, s.recorded_at_ms AS s_recorded_at_ms,
        s.settled_at_ms AS s_settled_at_ms, s.result AS s_result,
        s.closing_odds_american AS s_closing_odds_american, s.closing_line AS s_closing_line,
        s.closing_implied_prob AS s_closing_implied_prob, s.clv_pp AS s_clv_pp,
        s.outcome_value AS s_outcome_value, s.final_home_score AS s_final_home_score,
        s.final_away_score AS s_final_away_score, s.profit_units AS s_profit_units,
        s.source AS s_source, s.correction_of_event_id AS s_correction_of_event_id,
        s.notes AS s_notes, s.payload_sha256 AS s_payload_sha256, s.payload_json AS s_payload_json
      FROM mlb_prediction_ledger_v1 p
      LEFT JOIN mlb_settlement_events_v1 s ON s.event_id = (
        SELECT s2.event_id FROM mlb_settlement_events_v1 s2
        WHERE s2.prediction_id = p.id
        ORDER BY s2.recorded_at_ms DESC, s2.event_id DESC
        LIMIT 1
      )
      ${where}
      ORDER BY p.game_date ASC, p.recorded_at_ms ASC, p.id ASC
      LIMIT ${limit}
    `).all(params) as Array<PredictionRow & Record<string, unknown>>;

    const records = rows.map((row) => {
      const prediction = mapPrediction(row);
      const settlement = row.s_event_id ? mapSettlement({
        event_id: row.s_event_id as string,
        prediction_id: row.s_prediction_id as string,
        client_request_id: row.s_client_request_id as string | null,
        recorded_at_ms: row.s_recorded_at_ms as number,
        settled_at_ms: row.s_settled_at_ms as number,
        result: row.s_result as string,
        closing_odds_american: row.s_closing_odds_american as number | null,
        closing_line: row.s_closing_line as number | null,
        closing_implied_prob: row.s_closing_implied_prob as number | null,
        clv_pp: row.s_clv_pp as number | null,
        outcome_value: row.s_outcome_value as number | null,
        final_home_score: row.s_final_home_score as number | null,
        final_away_score: row.s_final_away_score as number | null,
        profit_units: row.s_profit_units as number,
        source: row.s_source as string,
        correction_of_event_id: row.s_correction_of_event_id as string | null,
        notes: row.s_notes as string | null,
        payload_sha256: row.s_payload_sha256 as string,
        payload_json: row.s_payload_json as string,
      }) : null;
      return { prediction, settlement };
    });
    return filters.settled == null ? records : records.filter((record) => Boolean(record.settlement) === filters.settled);
  }
}

function summarize(records: LedgerRecord[]) {
  const settled = records.filter((record) => record.settlement);
  const graded = settled.filter((record) => scoringOutcome(record.settlement!.result) != null);
  let wins = 0;
  let losses = 0;
  let risked = 0;
  let profit = 0;
  let brier = 0;
  let logLoss = 0;
  let modelSum = 0;
  let edgeSum = 0;
  let clvSum = 0;
  let clvCount = 0;

  for (const record of settled) {
    if (record.settlement!.result !== "VOID") risked += record.prediction.decision.stakeUnits;
    profit += record.settlement!.profitUnits;
    if (record.settlement!.clvPp != null) { clvSum += record.settlement!.clvPp!; clvCount++; }
  }

  for (const record of graded) {
    const result = record.settlement!.result;
    if (result === "WIN") wins += 1;
    else if (result === "LOSS") losses += 1;
    else if (result === "HALF_WIN") wins += 0.5;
    else if (result === "HALF_LOSS") losses += 0.5;

    const y = scoringOutcome(result)!;
    const p = Math.min(0.999, Math.max(0.001, record.prediction.probabilities.model));
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    modelSum += p;
    edgeSum += record.prediction.probabilities.edgePp;
  }

  const decisions = wins + losses;
  return {
    predictions: records.length,
    settled: settled.length,
    pending: records.length - settled.length,
    graded: graded.length,
    weightedWins: round(wins, 2),
    weightedLosses: round(losses, 2),
    hitRate: decisions > 0 ? round(wins / decisions, 4) : null,
    unitsRisked: round(risked, 4),
    profitUnits: round(profit, 4),
    roi: risked > 0 ? round(profit / risked, 4) : null,
    averageModelProbability: graded.length ? round(modelSum / graded.length, 4) : null,
    averageEdgePp: graded.length ? round(edgeSum / graded.length, 3) : null,
    averageClvPp: clvCount ? round(clvSum / clvCount, 3) : null,
    brierScore: graded.length ? round(brier / graded.length, 6) : null,
    logLoss: graded.length ? round(logLoss / graded.length, 6) : null,
  };
}

function grouped(records: LedgerRecord[], selector: (record: LedgerRecord) => string) {
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of records) {
    const key = selector(record) || "UNKNOWN";
    groups.set(key, [...(groups.get(key) || []), record]);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => [key, summarize(rows)]));
}

function calibration(records: LedgerRecord[]) {
  const boundaries = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00];
  return boundaries.slice(0, -1).map((lower, index) => {
    const upper = boundaries[index + 1];
    const rows = records.filter((record) => {
      const p = record.prediction.probabilities.model;
      return p >= lower && (index === boundaries.length - 2 ? p <= upper : p < upper) && scoringOutcome(record.settlement?.result || "") != null;
    });
    const predicted = rows.reduce((sum, row) => sum + row.prediction.probabilities.model, 0);
    const actual = rows.reduce((sum, row) => sum + scoringOutcome(row.settlement!.result)!, 0);
    return {
      range: `${Math.round(lower * 100)}-${Math.round(upper * 100)}%`,
      count: rows.length,
      averagePredicted: rows.length ? round(predicted / rows.length, 4) : null,
      actualHitRate: rows.length ? round(actual / rows.length, 4) : null,
    };
  });
}

export function buildMlbBacktestReport(records: LedgerRecord[], trainPct = 70, validationPct = 15) {
  if (trainPct <= 0 || validationPct < 0 || trainPct + validationPct >= 100) {
    throw Object.assign(new Error("Temporal split must leave a positive test partition"), { status: 400 });
  }
  const ordered = [...records].sort((a, b) =>
    a.prediction.game.gameDate.localeCompare(b.prediction.game.gameDate) ||
    a.prediction.recordedAtMs - b.prediction.recordedAtMs ||
    a.prediction.id.localeCompare(b.prediction.id),
  );
  const trainEnd = Math.floor(ordered.length * trainPct / 100);
  const validationEnd = trainEnd + Math.floor(ordered.length * validationPct / 100);
  const train = ordered.slice(0, trainEnd);
  const validation = ordered.slice(trainEnd, validationEnd);
  const test = ordered.slice(validationEnd);
  const fingerprint = ordered.map((record) => [record.prediction.id, record.prediction.payloadSha256, record.settlement?.eventId || "pending", record.settlement?.payloadSha256 || "pending"].join(":")).join("\n");

  return {
    schemaVersion: MLB_LEDGER_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    datasetSha256: sha256(fingerprint),
    overall: summarize(ordered),
    temporalSplit: {
      policy: `${trainPct}/${validationPct}/${100 - trainPct - validationPct} chronological`,
      train: summarize(train),
      validation: summarize(validation),
      test: summarize(test),
    },
    byMarket: grouped(ordered, (record) => record.prediction.market.type),
    byConfidence: grouped(ordered, (record) => record.prediction.decision.confidenceLabel || "UNKNOWN"),
    bySignal: grouped(ordered, (record) => record.prediction.decision.signal),
    byAnalysisStage: grouped(ordered, (record) => record.prediction.analysisStage),
    byMonth: grouped(ordered, (record) => record.prediction.game.gameDate.slice(0, 7)),
    calibration: calibration(ordered),
    methodology: {
      probabilityScale: "0-1",
      pushesAndVoidsExcludedFromProbabilityScores: true,
      halfResultsScoredAs: { HALF_WIN: 0.75, HALF_LOSS: 0.25 },
      roiDenominator: "sum of stakeUnits for settled non-VOID predictions",
      latestSettlementEventWinsByRecordedAt: true,
    },
  };
}

export function recordsToCsv(records: LedgerRecord[]): string {
  const escape = (value: unknown) => {
    if (value == null) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const headers = ["prediction_id", "recorded_at", "game_date", "game_pk", "away_team", "home_team", "market", "selection", "line", "odds_american", "book", "model_probability", "market_implied_probability", "no_vig_probability", "edge_pp", "signal", "confidence_label", "confidence_pct", "stake_units", "analysis_stage", "model_name", "model_version", "git_commit", "settlement_event_id", "result", "settled_at", "closing_odds_american", "closing_line", "clv_pp", "profit_units"];
  const rows = records.map((record) => [
    record.prediction.id, record.prediction.recordedAt, record.prediction.game.gameDate, record.prediction.game.gamePk,
    record.prediction.game.awayTeam, record.prediction.game.homeTeam, record.prediction.market.type,
    record.prediction.market.selection, record.prediction.market.line, record.prediction.market.oddsAmerican,
    record.prediction.market.book, record.prediction.probabilities.model, record.prediction.probabilities.marketImplied,
    record.prediction.probabilities.noVig, record.prediction.probabilities.edgePp, record.prediction.decision.signal,
    record.prediction.decision.confidenceLabel, record.prediction.decision.confidencePct,
    record.prediction.decision.stakeUnits, record.prediction.analysisStage, record.prediction.model.name,
    record.prediction.model.version, record.prediction.model.gitCommit, record.settlement?.eventId,
    record.settlement?.result, record.settlement?.settledAt, record.settlement?.closingOddsAmerican,
    record.settlement?.closingLine, record.settlement?.clvPp, record.settlement?.profitUnits,
  ].map(escape).join(","));
  return [headers.join(","), ...rows].join("\n");
}
