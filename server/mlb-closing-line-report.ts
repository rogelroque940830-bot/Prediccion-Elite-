import { classifyMlbAnalyticalDuplicates } from "./mlb-analytical-dedup";
import type { LedgerRecord } from "./mlb-ledger-store";
import {
  enrichMlbRecordsWithClosingLines,
  type MlbClosingLineObservation,
  type MlbClosingLineStore,
} from "./mlb-closing-line-store";
import { closingMarketForPrediction } from "./mlb-closing-line-worker";

export const MLB_CLOSING_LINE_REPORT_VERSION = "mlb-closing-line-report.v1" as const;

type ClosingStatus = "PENDING" | "OBSERVED" | "FINAL" | "UNAVAILABLE" | "UNSUPPORTED";
type ClosingQuality = "VERIFIED" | "ACCEPTABLE" | "STALE" | "UNKNOWN";

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : null;
}

function qualityFor(observation: MlbClosingLineObservation | null): ClosingQuality {
  if (!observation) return "UNKNOWN";
  const minutes = (observation.commenceTimeMs - observation.quoteAtMs) / 60_000;
  if (minutes <= 20) return "VERIFIED";
  if (minutes <= 60) return "ACCEPTABLE";
  if (minutes <= 180) return "STALE";
  return "UNKNOWN";
}

function rowStatus(
  supported: boolean,
  observation: MlbClosingLineObservation | null,
  commenceTime: string | null,
  nowMs: number,
): ClosingStatus {
  if (!supported) return "UNSUPPORTED";
  const commenceMs = commenceTime ? Date.parse(commenceTime) : NaN;
  if (!Number.isFinite(commenceMs)) return "UNAVAILABLE";
  if (nowMs < commenceMs) return observation ? "OBSERVED" : "PENDING";
  return observation ? "FINAL" : "UNAVAILABLE";
}

export function buildMlbClosingLineReport(
  records: LedgerRecord[],
  store: MlbClosingLineStore,
  nowMs = Date.now(),
) {
  const duplicateStatuses = classifyMlbAnalyticalDuplicates(records);
  const rows = records.map((record) => {
    const support = closingMarketForPrediction(record.prediction);
    const observation = store.latestBeforeCommence(
      record.prediction.id,
      record.prediction.game.commenceTime,
    );
    const status = rowStatus(Boolean(support), observation, record.prediction.game.commenceTime, nowMs);
    const commenceMs = record.prediction.game.commenceTime
      ? Date.parse(record.prediction.game.commenceTime)
      : NaN;
    const quoteAgeMinutes = observation && Number.isFinite(commenceMs)
      ? round((commenceMs - observation.quoteAtMs) / 60_000, 1)
      : null;
    const duplicate = duplicateStatuses.get(record.prediction.id);

    return {
      predictionId: record.prediction.id,
      gameDate: record.prediction.game.gameDate,
      gamePk: record.prediction.game.gamePk,
      commenceTime: record.prediction.game.commenceTime,
      homeTeam: record.prediction.game.homeTeam,
      awayTeam: record.prediction.game.awayTeam,
      marketType: record.prediction.market.type,
      selection: record.prediction.market.selection,
      ticketOddsAmerican: record.prediction.market.oddsAmerican,
      ticketLine: record.prediction.market.line,
      requestedBook: record.prediction.market.book,
      supportedMarketKey: support?.marketKey ?? null,
      status,
      observation: observation ? {
        eventId: observation.eventId,
        checkpoint: observation.checkpoint,
        quoteAt: observation.quoteAt,
        bookmakerKey: observation.bookmakerKey,
        bookmakerTitle: observation.bookmakerTitle,
        matchMode: observation.matchMode,
        oddsAmerican: observation.oddsAmerican,
        line: observation.line,
        comparable: observation.comparable,
        clvPp: observation.clvPp,
        priceClvPct: observation.priceClvPct,
        lineClv: observation.lineClv,
        quoteAgeMinutes,
        quality: qualityFor(observation),
      } : null,
      analyticalDuplicate: duplicate?.analyticalDuplicate ?? false,
      analyticalDuplicateOfPredictionId: duplicate?.analyticalDuplicateOfPredictionId ?? null,
      settled: Boolean(record.settlement),
    };
  });

  const uniqueRows = rows.filter((row) => !row.analyticalDuplicate);
  const finalRows = uniqueRows.filter((row) => row.status === "FINAL");
  const measuredExact = finalRows.filter((row) =>
    row.observation?.matchMode === "EXACT_BOOK"
    && row.observation.comparable
    && row.observation.clvPp != null
  );
  const measuredProxy = finalRows.filter((row) =>
    row.observation?.matchMode === "PROXY_BOOK"
    && row.observation.comparable
    && row.observation.clvPp != null
  );
  const qualityCounts = {
    verified: finalRows.filter((row) => row.observation?.quality === "VERIFIED").length,
    acceptable: finalRows.filter((row) => row.observation?.quality === "ACCEPTABLE").length,
    stale: finalRows.filter((row) => row.observation?.quality === "STALE").length,
    unknown: finalRows.filter((row) => row.observation?.quality === "UNKNOWN").length,
  };

  return {
    schemaVersion: MLB_CLOSING_LINE_REPORT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      ledgerRecords: rows.length,
      uniqueAnalyticalDecisions: uniqueRows.length,
      analyticalDuplicatesExcluded: rows.length - uniqueRows.length,
      final: finalRows.length,
      pending: uniqueRows.filter((row) => row.status === "PENDING" || row.status === "OBSERVED").length,
      unavailable: uniqueRows.filter((row) => row.status === "UNAVAILABLE").length,
      unsupported: uniqueRows.filter((row) => row.status === "UNSUPPORTED").length,
      exactBookMeasured: measuredExact.length,
      proxyBookMeasured: measuredProxy.length,
      positiveExactClv: measuredExact.filter((row) => Number(row.observation?.clvPp) > 0).length,
      negativeExactClv: measuredExact.filter((row) => Number(row.observation?.clvPp) < 0).length,
      averageExactClvPp: average(measuredExact.map((row) => Number(row.observation?.clvPp))),
      averageExactPriceClvPct: average(measuredExact.map((row) => Number(row.observation?.priceClvPct))),
      averageProxyClvPp: average(measuredProxy.map((row) => Number(row.observation?.clvPp))),
      quality: qualityCounts,
    },
    rows: [...rows].sort((left, right) =>
      right.gameDate.localeCompare(left.gameDate)
      || String(right.commenceTime || "").localeCompare(String(left.commenceTime || ""))
      || right.predictionId.localeCompare(left.predictionId)
    ),
    methodology: {
      source: "The Odds API current pregame odds",
      featuredMarkets: ["ML", "RUN_LINE", "TOTAL"],
      additionalMarkets: ["F5_ML", "F5_TOTAL"],
      checkpointsMinutesBeforeStart: [180, 60, 15],
      exactBookPreferred: true,
      proxyBookClearlyLabeled: true,
      positiveClvMeaning: "Closing implied probability exceeded ticket implied probability for the same selection and line.",
      differentLines: "Probability CLV is withheld when spread or total lines differ; lineClv is reported separately.",
      historicalBackfill: false,
      immutableObservations: true,
    },
  };
}

export function enrichRecordsForMlbReports(
  records: LedgerRecord[],
  store: MlbClosingLineStore,
): LedgerRecord[] {
  return enrichMlbRecordsWithClosingLines(records, store);
}

export type MlbClosingLineReport = ReturnType<typeof buildMlbClosingLineReport>;
