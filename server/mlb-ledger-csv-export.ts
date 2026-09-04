import type { LedgerRecord } from "./mlb-ledger-store";
import { projectMlbEarlyEngineCapture } from "./mlb-early-engine-capture-projection";

const BASE_HEADERS = [
  "prediction_id",
  "recorded_at",
  "game_date",
  "game_pk",
  "away_team",
  "home_team",
  "market",
  "selection",
  "line",
  "odds_american",
  "book",
  "model_probability",
  "market_implied_probability",
  "no_vig_probability",
  "edge_pp",
  "signal",
  "confidence_label",
  "confidence_pct",
  "stake_units",
  "analysis_stage",
  "model_name",
  "model_version",
  "git_commit",
  "settlement_event_id",
  "result",
  "settled_at",
  "closing_odds_american",
  "closing_line",
  "clv_pp",
  "profit_units",
] as const;

const EARLY_ERE_HEADERS = [
  "supersedes_id",
  "market_captured_at",
  "early_schema_version",
  "early_source",
  "early_observed_at",
  "early_freshness",
  "early_age_ms_at_saved_pick",
  "early_saved_market_type",
  "early_saved_side",
  "early_recommendation_matches_saved_pick",
  "home_ere_score",
  "home_ere_category",
  "home_ere_data_status",
  "away_ere_score",
  "away_ere_category",
  "away_ere_data_status",
  "f5_prob_home_pct",
  "f5_prob_away_pct",
  "f5_pick_side",
  "f5_confidence",
  "f5_total_runs_estimated",
  "early_confidence",
  "early_data_incomplete",
  "early_warnings",
  "early_final_recommendation_market",
  "early_final_recommendation_side",
  "early_final_recommendation_action",
  "early_final_recommendation_is_premium",
  "early_final_recommendation_reason",
] as const;

function escapeCsv(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function marketCapturedAt(record: LedgerRecord): string | null {
  const payload = record.prediction.payload as any;
  const capturedAt = payload?.market?.capturedAt;
  return typeof capturedAt === "string" && capturedAt.trim() ? capturedAt.trim() : null;
}

/**
 * Backward-compatible MLB CSV export: the legacy 30 columns stay in the same
 * order and compact Early/ERE audit columns are appended. JSONL remains the
 * full immutable record and is intentionally unchanged.
 */
export function recordsToMlbCsv(records: LedgerRecord[]): string {
  const headers = [...BASE_HEADERS, ...EARLY_ERE_HEADERS];
  const rows = records.map((record) => {
    const early = projectMlbEarlyEngineCapture(record.prediction.payload);
    const finalRecommendation = early?.finalRecommendation ?? null;

    const baseValues = [
      record.prediction.id,
      record.prediction.recordedAt,
      record.prediction.game.gameDate,
      record.prediction.game.gamePk,
      record.prediction.game.awayTeam,
      record.prediction.game.homeTeam,
      record.prediction.market.type,
      record.prediction.market.selection,
      record.prediction.market.line,
      record.prediction.market.oddsAmerican,
      record.prediction.market.book,
      record.prediction.probabilities.model,
      record.prediction.probabilities.marketImplied,
      record.prediction.probabilities.noVig,
      record.prediction.probabilities.edgePp,
      record.prediction.decision.signal,
      record.prediction.decision.confidenceLabel,
      record.prediction.decision.confidencePct,
      record.prediction.decision.stakeUnits,
      record.prediction.analysisStage,
      record.prediction.model.name,
      record.prediction.model.version,
      record.prediction.model.gitCommit,
      record.settlement?.eventId,
      record.settlement?.result,
      record.settlement?.settledAt,
      record.settlement?.closingOddsAmerican,
      record.settlement?.closingLine,
      record.settlement?.clvPp,
      record.settlement?.profitUnits,
    ];

    const earlyValues = [
      record.prediction.supersedesId,
      marketCapturedAt(record),
      early?.schemaVersion,
      early?.source,
      early?.observedAt,
      early?.freshness,
      early?.ageMsAtSavedPick,
      early?.savedMarketType,
      early?.savedSide,
      early?.recommendationMatchesSavedPick,
      early?.homeEreScore,
      early?.homeEreCategory,
      early?.homeEreDataStatus,
      early?.awayEreScore,
      early?.awayEreCategory,
      early?.awayEreDataStatus,
      early?.f5ProbHomePct,
      early?.f5ProbAwayPct,
      early?.f5PickSide,
      early?.f5Confidence,
      early?.f5TotalRunsEstimated,
      early?.earlyConfidence,
      early?.earlyDataIncomplete,
      early?.earlyWarnings.join(" | "),
      finalRecommendation?.market,
      finalRecommendation?.side,
      finalRecommendation?.action,
      finalRecommendation?.isPremium,
      finalRecommendation?.reason,
    ];

    return [...baseValues, ...earlyValues].map(escapeCsv).join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

export const MLB_CSV_BASE_HEADERS = BASE_HEADERS;
export const MLB_CSV_EARLY_ERE_HEADERS = EARLY_ERE_HEADERS;
