import path from "node:path";
import Database from "better-sqlite3";
import type { LedgerPrediction, LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "mlb-ledger-v1.sqlite");

interface SettlementPredictionRow {
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
}

function mapSettlementPrediction(row: SettlementPredictionRow): LedgerPrediction {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    recordedAt: new Date(row.recorded_at_ms).toISOString(),
    recordedAtMs: row.recorded_at_ms,
    game: {
      gamePk: row.game_pk,
      gameDate: row.game_date,
      commenceTime: row.commence_time,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
    },
    market: {
      type: row.market_type,
      selection: row.selection,
      line: row.line,
      oddsAmerican: row.odds_american,
      book: row.book,
    },
    probabilities: {
      model: row.model_prob,
      marketImplied: row.market_implied_prob,
      noVig: row.no_vig_prob,
      edgePp: row.edge_pp,
    },
    decision: {
      signal: row.signal,
      confidenceLabel: row.confidence_label,
      confidencePct: row.confidence_pct,
      stakeUnits: row.stake_units,
    },
    analysisStage: row.analysis_stage,
    model: {
      name: row.model_name,
      version: row.model_version,
      gitCommit: row.git_commit,
      environment: row.environment,
    },
    supersedesId: row.supersedes_id,
    source: row.source,
    payloadSha256: row.payload_sha256,
    // Settlement grading is intentionally payload-blind. The immutable raw
    // prediction payload remains in the canonical ledger and is never read here.
    payload: null,
  } as LedgerPrediction;
}

export function listPendingMlbSettlementRecords(
  dbPath = process.env.MLB_LEDGER_DB_PATH || DEFAULT_DB_PATH,
  requestedLimit = 10_000,
): LedgerRecord[] {
  const limit = Math.min(10_000, Math.max(1, Math.floor(requestedLimit)));
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT
        p.id,
        p.client_request_id,
        p.recorded_at_ms,
        p.game_pk,
        p.game_date,
        p.commence_time,
        p.home_team,
        p.away_team,
        p.market_type,
        p.selection,
        p.line,
        p.odds_american,
        p.book,
        p.model_prob,
        p.market_implied_prob,
        p.no_vig_prob,
        p.edge_pp,
        p.signal,
        p.confidence_label,
        p.confidence_pct,
        p.stake_units,
        p.analysis_stage,
        p.model_name,
        p.model_version,
        p.git_commit,
        p.environment,
        p.supersedes_id,
        p.source,
        p.payload_sha256
      FROM mlb_prediction_ledger_v1 p
      WHERE NOT EXISTS (
        SELECT 1
        FROM mlb_settlement_events_v1 sx
        WHERE sx.prediction_id = p.id
      )
      ORDER BY p.game_date ASC, p.recorded_at_ms ASC, p.id ASC
      LIMIT ?
    `).all(limit) as SettlementPredictionRow[];

    return rows.map((row) => ({
      prediction: mapSettlementPrediction(row),
      settlement: null,
    }));
  } finally {
    db.close();
  }
}

/**
 * Settlement-only view of the canonical ledger.
 *
 * All mutating methods remain bound to the canonical MlbLedgerStore. Only the
 * pending-record scan is replaced with a payload-blind SQL projection so the
 * background settlement worker cannot deserialize rawInputs/rawOutput/layers.
 */
export function createMlbSettlementStoreView(
  store: MlbLedgerStore,
  dbPath = process.env.MLB_LEDGER_DB_PATH || DEFAULT_DB_PATH,
): MlbLedgerStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === "listRecords") {
        return (filters: Parameters<MlbLedgerStore["listRecords"]>[0] = {}) => {
          if (filters.settled === false) {
            return listPendingMlbSettlementRecords(dbPath, filters.limit ?? 10_000);
          }
          return target.listRecords(filters);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
