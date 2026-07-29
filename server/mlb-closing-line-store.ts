import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { americanToProbability, canonicalJson, type LedgerRecord } from "./mlb-ledger-store";

export const MLB_CLOSING_LINE_SCHEMA_VERSION = "mlb-closing-line.v1" as const;
export const MLB_CLOSING_CAPTURE_CHECKPOINTS = ["T180", "T60", "T15"] as const;
export type MlbClosingCaptureCheckpoint = typeof MLB_CLOSING_CAPTURE_CHECKPOINTS[number];
export type MlbClosingMatchMode = "EXACT_BOOK" | "PROXY_BOOK";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "mlb-ledger-v1.sqlite");
const idPattern = /^[A-Za-z0-9._:-]{1,220}$/;

const observationSchema = z.object({
  clientRequestId: z.string().regex(idPattern),
  checkpoint: z.enum(MLB_CLOSING_CAPTURE_CHECKPOINTS),
  quoteAt: z.string().datetime(),
  commenceTime: z.string().datetime(),
  source: z.literal("THE_ODDS_API"),
  sourceEventId: z.string().trim().min(1).max(120),
  bookmakerKey: z.string().trim().min(1).max(120),
  bookmakerTitle: z.string().trim().min(1).max(160).optional(),
  matchMode: z.enum(["EXACT_BOOK", "PROXY_BOOK"]),
  marketKey: z.string().trim().min(1).max(120),
  selection: z.string().trim().min(1).max(240),
  line: z.number().finite().nullable().optional(),
  oddsAmerican: z.number().int().min(-100000).max(100000).refine((value) => value !== 0),
  ticketOddsAmerican: z.number().int().min(-100000).max(100000).refine((value) => value !== 0),
  ticketLine: z.number().finite().nullable().optional(),
  comparable: z.boolean(),
  lineClv: z.number().finite().nullable().optional(),
  quota: z.object({
    remaining: z.number().int().nonnegative().nullable().optional(),
    used: z.number().int().nonnegative().nullable().optional(),
    last: z.number().int().nonnegative().nullable().optional(),
  }).strict().optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const attemptSchema = z.object({
  checkpoint: z.enum(MLB_CLOSING_CAPTURE_CHECKPOINTS),
  status: z.enum(["CAPTURED", "NO_EVENT", "NO_MARKET", "NO_BOOK", "UNSUPPORTED"]),
  attemptedAt: z.string().datetime().optional(),
  reason: z.string().max(500).optional(),
}).strict();

interface ObservationRow {
  event_id: string;
  prediction_id: string;
  client_request_id: string;
  recorded_at_ms: number;
  quote_at_ms: number;
  commence_time_ms: number;
  checkpoint: string;
  source: string;
  source_event_id: string;
  bookmaker_key: string;
  bookmaker_title: string | null;
  match_mode: string;
  market_key: string;
  selection: string;
  line: number | null;
  odds_american: number;
  implied_probability: number;
  ticket_odds_american: number;
  ticket_implied_probability: number;
  ticket_line: number | null;
  comparable: number;
  clv_pp: number | null;
  price_clv_pct: number | null;
  line_clv: number | null;
  payload_sha256: string;
  payload_json: string;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function decimalOdds(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function generatedId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
}

function mapObservation(row: ObservationRow) {
  return {
    schemaVersion: MLB_CLOSING_LINE_SCHEMA_VERSION,
    eventId: row.event_id,
    predictionId: row.prediction_id,
    clientRequestId: row.client_request_id,
    recordedAt: new Date(row.recorded_at_ms).toISOString(),
    recordedAtMs: row.recorded_at_ms,
    quoteAt: new Date(row.quote_at_ms).toISOString(),
    quoteAtMs: row.quote_at_ms,
    commenceTime: new Date(row.commence_time_ms).toISOString(),
    commenceTimeMs: row.commence_time_ms,
    checkpoint: row.checkpoint as MlbClosingCaptureCheckpoint,
    source: row.source as "THE_ODDS_API",
    sourceEventId: row.source_event_id,
    bookmakerKey: row.bookmaker_key,
    bookmakerTitle: row.bookmaker_title,
    matchMode: row.match_mode as MlbClosingMatchMode,
    marketKey: row.market_key,
    selection: row.selection,
    line: row.line,
    oddsAmerican: row.odds_american,
    impliedProbability: row.implied_probability,
    ticketOddsAmerican: row.ticket_odds_american,
    ticketImpliedProbability: row.ticket_implied_probability,
    ticketLine: row.ticket_line,
    comparable: Boolean(row.comparable),
    clvPp: row.clv_pp,
    priceClvPct: row.price_clv_pct,
    lineClv: row.line_clv,
    payloadSha256: row.payload_sha256,
    payload: JSON.parse(row.payload_json),
  };
}

export type MlbClosingLineObservation = ReturnType<typeof mapObservation>;

export class MlbClosingLineStore {
  private db: any;

  constructor(filePath = process.env.MLB_LEDGER_DB_PATH || DEFAULT_DB_PATH) {
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void { this.db.close(); }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mlb_closing_line_events_v1 (
        event_id TEXT PRIMARY KEY,
        prediction_id TEXT NOT NULL REFERENCES mlb_prediction_ledger_v1(id),
        client_request_id TEXT NOT NULL UNIQUE,
        recorded_at_ms INTEGER NOT NULL,
        quote_at_ms INTEGER NOT NULL,
        commence_time_ms INTEGER NOT NULL,
        checkpoint TEXT NOT NULL,
        source TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        bookmaker_key TEXT NOT NULL,
        bookmaker_title TEXT,
        match_mode TEXT NOT NULL,
        market_key TEXT NOT NULL,
        selection TEXT NOT NULL,
        line REAL,
        odds_american INTEGER NOT NULL,
        implied_probability REAL NOT NULL,
        ticket_odds_american INTEGER NOT NULL,
        ticket_implied_probability REAL NOT NULL,
        ticket_line REAL,
        comparable INTEGER NOT NULL,
        clv_pp REAL,
        price_clv_pct REAL,
        line_clv REAL,
        payload_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mlb_closing_capture_attempts_v1 (
        prediction_id TEXT NOT NULL REFERENCES mlb_prediction_ledger_v1(id),
        checkpoint TEXT NOT NULL,
        attempted_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(prediction_id, checkpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_mlb_closing_prediction_quote
        ON mlb_closing_line_events_v1(prediction_id, quote_at_ms DESC);
      CREATE TRIGGER IF NOT EXISTS mlb_closing_line_immutable_update
        BEFORE UPDATE ON mlb_closing_line_events_v1 BEGIN SELECT RAISE(ABORT, 'mlb closing line ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_closing_line_immutable_delete
        BEFORE DELETE ON mlb_closing_line_events_v1 BEGIN SELECT RAISE(ABORT, 'mlb closing line ledger is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_closing_attempt_immutable_update
        BEFORE UPDATE ON mlb_closing_capture_attempts_v1 BEGIN SELECT RAISE(ABORT, 'mlb closing capture attempts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS mlb_closing_attempt_immutable_delete
        BEFORE DELETE ON mlb_closing_capture_attempts_v1 BEGIN SELECT RAISE(ABORT, 'mlb closing capture attempts are immutable'); END;
    `);
  }

  status() {
    const observations = this.db.prepare("SELECT COUNT(*) AS n FROM mlb_closing_line_events_v1").get().n as number;
    const attempts = this.db.prepare("SELECT COUNT(*) AS n FROM mlb_closing_capture_attempts_v1").get().n as number;
    const latest = this.db.prepare("SELECT MAX(recorded_at_ms) AS ts FROM mlb_closing_line_events_v1").get().ts as number | null;
    return {
      schemaVersion: MLB_CLOSING_LINE_SCHEMA_VERSION,
      observations,
      attempts,
      latestObservationAt: latest ? new Date(latest).toISOString() : null,
      immutable: true,
    };
  }

  hasAttempt(predictionId: string, checkpoint: MlbClosingCaptureCheckpoint): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM mlb_closing_capture_attempts_v1 WHERE prediction_id = ? AND checkpoint = ?",
    ).get(predictionId, checkpoint));
  }

  appendAttempt(predictionId: string, raw: unknown): void {
    const parsed = attemptSchema.parse(raw);
    const prediction = this.db.prepare("SELECT 1 FROM mlb_prediction_ledger_v1 WHERE id = ?").get(predictionId);
    if (!prediction) throw Object.assign(new Error("Prediction not found"), { status: 404 });
    const attemptedAtMs = parsed.attemptedAt ? Date.parse(parsed.attemptedAt) : Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO mlb_closing_capture_attempts_v1
      (prediction_id, checkpoint, attempted_at_ms, status, reason, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(predictionId, parsed.checkpoint, attemptedAtMs, parsed.status, parsed.reason ?? null, canonicalJson(parsed));
  }

  appendObservation(predictionId: string, raw: unknown): { data: MlbClosingLineObservation; idempotent: boolean } {
    const parsed = observationSchema.parse(raw);
    const prediction = this.db.prepare("SELECT 1 FROM mlb_prediction_ledger_v1 WHERE id = ?").get(predictionId);
    if (!prediction) throw Object.assign(new Error("Prediction not found"), { status: 404 });

    const payload = { predictionId, ...parsed };
    const payloadJson = canonicalJson(payload);
    const payloadSha256 = crypto.createHash("sha256").update(payloadJson).digest("hex");
    const existing = this.db.prepare(
      "SELECT * FROM mlb_closing_line_events_v1 WHERE client_request_id = ?",
    ).get(parsed.clientRequestId) as ObservationRow | undefined;
    if (existing) {
      if (existing.prediction_id !== predictionId || existing.payload_sha256 !== payloadSha256) {
        throw Object.assign(new Error("clientRequestId already exists with different closing observation"), { status: 409 });
      }
      return { data: mapObservation(existing), idempotent: true };
    }

    const quoteAtMs = Date.parse(parsed.quoteAt);
    const commenceTimeMs = Date.parse(parsed.commenceTime);
    if (!Number.isFinite(quoteAtMs) || !Number.isFinite(commenceTimeMs) || quoteAtMs > commenceTimeMs) {
      throw Object.assign(new Error("Closing quote must be timestamped at or before commence time"), { status: 400 });
    }
    const impliedProbability = americanToProbability(parsed.oddsAmerican);
    const ticketImpliedProbability = americanToProbability(parsed.ticketOddsAmerican);
    const clvPp = parsed.comparable ? round((impliedProbability - ticketImpliedProbability) * 100) : null;
    const priceClvPct = parsed.comparable
      ? round(((decimalOdds(parsed.ticketOddsAmerican) - decimalOdds(parsed.oddsAmerican)) / decimalOdds(parsed.oddsAmerican)) * 100)
      : null;
    const eventId = generatedId("mlb-close");
    const recordedAtMs = Date.now();

    this.db.prepare(`
      INSERT INTO mlb_closing_line_events_v1 (
        event_id, prediction_id, client_request_id, recorded_at_ms, quote_at_ms,
        commence_time_ms, checkpoint, source, source_event_id, bookmaker_key,
        bookmaker_title, match_mode, market_key, selection, line, odds_american,
        implied_probability, ticket_odds_american, ticket_implied_probability,
        ticket_line, comparable, clv_pp, price_clv_pct, line_clv,
        payload_sha256, payload_json
      ) VALUES (
        @eventId, @predictionId, @clientRequestId, @recordedAtMs, @quoteAtMs,
        @commenceTimeMs, @checkpoint, @source, @sourceEventId, @bookmakerKey,
        @bookmakerTitle, @matchMode, @marketKey, @selection, @line, @oddsAmerican,
        @impliedProbability, @ticketOddsAmerican, @ticketImpliedProbability,
        @ticketLine, @comparable, @clvPp, @priceClvPct, @lineClv,
        @payloadSha256, @payloadJson
      )
    `).run({
      eventId,
      predictionId,
      clientRequestId: parsed.clientRequestId,
      recordedAtMs,
      quoteAtMs,
      commenceTimeMs,
      checkpoint: parsed.checkpoint,
      source: parsed.source,
      sourceEventId: parsed.sourceEventId,
      bookmakerKey: parsed.bookmakerKey,
      bookmakerTitle: parsed.bookmakerTitle ?? null,
      matchMode: parsed.matchMode,
      marketKey: parsed.marketKey,
      selection: parsed.selection,
      line: parsed.line ?? null,
      oddsAmerican: parsed.oddsAmerican,
      impliedProbability,
      ticketOddsAmerican: parsed.ticketOddsAmerican,
      ticketImpliedProbability,
      ticketLine: parsed.ticketLine ?? null,
      comparable: parsed.comparable ? 1 : 0,
      clvPp,
      priceClvPct,
      lineClv: parsed.lineClv ?? null,
      payloadSha256,
      payloadJson,
    });
    const row = this.db.prepare("SELECT * FROM mlb_closing_line_events_v1 WHERE event_id = ?").get(eventId) as ObservationRow;
    return { data: mapObservation(row), idempotent: false };
  }

  listForPrediction(predictionId: string): MlbClosingLineObservation[] {
    return (this.db.prepare(`
      SELECT * FROM mlb_closing_line_events_v1
      WHERE prediction_id = ? ORDER BY quote_at_ms ASC, recorded_at_ms ASC, event_id ASC
    `).all(predictionId) as ObservationRow[]).map(mapObservation);
  }

  latestBeforeCommence(predictionId: string, commenceTime: string | null | undefined): MlbClosingLineObservation | null {
    const commenceTimeMs = commenceTime ? Date.parse(commenceTime) : NaN;
    if (!Number.isFinite(commenceTimeMs)) return null;
    const row = this.db.prepare(`
      SELECT * FROM mlb_closing_line_events_v1
      WHERE prediction_id = ? AND quote_at_ms <= ?
      ORDER BY CASE WHEN match_mode = 'EXACT_BOOK' THEN 0 ELSE 1 END,
        quote_at_ms DESC, recorded_at_ms DESC, event_id DESC LIMIT 1
    `).get(predictionId, commenceTimeMs) as ObservationRow | undefined;
    return row ? mapObservation(row) : null;
  }
}

export function enrichMlbRecordsWithClosingLines(
  records: LedgerRecord[],
  store: MlbClosingLineStore,
): LedgerRecord[] {
  return records.map((record) => {
    if (!record.settlement || record.settlement.clvPp != null) return record;
    const observation = store.latestBeforeCommence(record.prediction.id, record.prediction.game.commenceTime);
    if (!observation || !observation.comparable || observation.matchMode !== "EXACT_BOOK") return record;
    return {
      prediction: record.prediction,
      settlement: {
        ...record.settlement,
        closingOddsAmerican: observation.oddsAmerican,
        closingLine: observation.line,
        closingImpliedProbability: observation.impliedProbability,
        clvPp: observation.clvPp,
      },
    };
  });
}
