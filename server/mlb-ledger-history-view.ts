import type { LedgerRecord } from "./mlb-ledger-store";
import { classifyMlbAnalyticalDuplicates, MLB_ANALYTICAL_FINGERPRINT_VERSION } from "./mlb-analytical-dedup";

export const MLB_LEDGER_HISTORY_VIEW_VERSION = "mlb-ledger-history-view.v1" as const;

const MARKET_LABELS: Record<string, string> = {
  ML: "ML",
  F5_ML: "F5",
  RUN_LINE: "Run Line",
  TOTAL: "O/U",
  F5_TOTAL: "F5 O/U",
  TEAM_TOTAL: "Team Total",
  TT_OVER_15_F5: "F5 TT Over 1.5",
  TT_UNDER_25_F5: "F5 TT Under 2.5",
  INNING_1_ML: "1st Inning ML",
  NRFI: "NRFI",
  YRFI: "YRFI",
  OTHER: "Otro",
};

const RESULT_LABELS: Record<string, string> = {
  WIN: "W",
  LOSS: "L",
  PUSH: "PUSH",
  VOID: "VOID",
  HALF_WIN: "½W",
  HALF_LOSS: "½L",
};

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isWin(result?: string | null): boolean {
  return result === "WIN" || result === "HALF_WIN";
}

function isLoss(result?: string | null): boolean {
  return result === "LOSS" || result === "HALF_LOSS";
}

function countsTowardRoi(result?: string | null): boolean {
  return Boolean(result) && result !== "PUSH" && result !== "VOID";
}

export function buildMlbLedgerHistoryView(records: LedgerRecord[]) {
  const ordered = [...records].sort((a, b) => b.prediction.recordedAtMs - a.prediction.recordedAtMs);
  const analyticalStatuses = classifyMlbAnalyticalDuplicates(records);
  const wins = ordered.filter((record) => isWin(record.settlement?.result)).length;
  const losses = ordered.filter((record) => isLoss(record.settlement?.result)).length;
  const pushes = ordered.filter((record) => record.settlement?.result === "PUSH").length;
  const voids = ordered.filter((record) => record.settlement?.result === "VOID").length;
  const settled = ordered.filter((record) => Boolean(record.settlement)).length;
  const pending = ordered.length - settled;
  const gradedForWinRate = wins + losses;
  const totalProfitUnits = ordered.reduce((sum, record) => sum + Number(record.settlement?.profitUnits || 0), 0);
  const totalStakedUnits = ordered.reduce((sum, record) => {
    if (!countsTowardRoi(record.settlement?.result)) return sum;
    return sum + Number(record.prediction.decision.stakeUnits || 0);
  }, 0);
  const roiPct = totalStakedUnits > 0 ? (totalProfitUnits / totalStakedUnits) * 100 : 0;

  const marketMap = new Map<string, {
    marketType: string;
    marketLabel: string;
    total: number;
    pending: number;
    wins: number;
    losses: number;
    settled: number;
    profitUnits: number;
  }>();

  for (const record of ordered) {
    const type = record.prediction.market.type;
    const current = marketMap.get(type) || {
      marketType: type,
      marketLabel: MARKET_LABELS[type] || type,
      total: 0,
      pending: 0,
      wins: 0,
      losses: 0,
      settled: 0,
      profitUnits: 0,
    };
    current.total += 1;
    if (record.settlement) {
      current.settled += 1;
      if (isWin(record.settlement.result)) current.wins += 1;
      if (isLoss(record.settlement.result)) current.losses += 1;
      current.profitUnits += Number(record.settlement.profitUnits || 0);
    } else {
      current.pending += 1;
    }
    marketMap.set(type, current);
  }

  const marketStats = [...marketMap.values()]
    .map((market) => ({
      ...market,
      profitUnits: round(market.profitUnits),
      winRatePct: market.wins + market.losses > 0
        ? round((market.wins / (market.wins + market.losses)) * 100, 1)
        : 0,
    }))
    .sort((a, b) => b.total - a.total || a.marketLabel.localeCompare(b.marketLabel));

  const picks = ordered.map((record) => {
    const prediction = record.prediction;
    const settlement = record.settlement;
    const analyticalStatus = analyticalStatuses.get(prediction.id);
    return {
      id: prediction.id,
      clientRequestId: prediction.clientRequestId,
      recordedAt: prediction.recordedAt,
      gameDate: prediction.game.gameDate,
      commenceTime: prediction.game.commenceTime,
      gamePk: prediction.game.gamePk,
      homeTeam: prediction.game.homeTeam,
      awayTeam: prediction.game.awayTeam,
      marketType: prediction.market.type,
      marketLabel: MARKET_LABELS[prediction.market.type] || prediction.market.type,
      selection: prediction.market.selection,
      line: prediction.market.line,
      oddsAmerican: prediction.market.oddsAmerican,
      book: prediction.market.book,
      modelProbabilityPct: round(prediction.probabilities.model * 100, 2),
      marketImpliedProbabilityPct: round(prediction.probabilities.marketImplied * 100, 2),
      edgePp: round(prediction.probabilities.edgePp, 2),
      signal: prediction.decision.signal,
      confidenceLabel: prediction.decision.confidenceLabel,
      stakeUnits: round(prediction.decision.stakeUnits, 2),
      analysisStage: prediction.analysisStage,
      modelVersion: prediction.model.version,
      result: settlement ? RESULT_LABELS[settlement.result] || settlement.result : "PENDING",
      settlementResult: settlement?.result || null,
      settledAt: settlement?.settledAt || null,
      profitUnits: round(Number(settlement?.profitUnits || 0), 4),
      closingOddsAmerican: settlement?.closingOddsAmerican ?? null,
      clvPp: settlement?.clvPp ?? null,
      finalScore: settlement?.finalScore || null,
      immutable: true,
      hasInjuryAudit: prediction.payload?.analysis?.injuryAudit?.schemaVersion === "mlb-injury-audit.v1",
      analyticalFingerprint: analyticalStatus?.fingerprint ?? null,
      analyticalDuplicate: analyticalStatus?.analyticalDuplicate ?? false,
      analyticalDuplicateOfPredictionId: analyticalStatus?.analyticalDuplicateOfPredictionId ?? null,
    };
  });

  return {
    schemaVersion: MLB_LEDGER_HISTORY_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
    source: "immutable-ledger" as const,
    analyticalCalibration: {
      fingerprintVersion: MLB_ANALYTICAL_FINGERPRINT_VERSION,
      auditedLedgerRecords: picks.filter((pick) => pick.hasInjuryAudit).length,
      uniqueDecisions: picks.filter((pick) => pick.hasInjuryAudit && !pick.analyticalDuplicate).length,
      duplicatesExcluded: picks.filter((pick) => pick.analyticalDuplicate).length,
      settledUniqueDecisions: picks.filter((pick) => pick.hasInjuryAudit && !pick.analyticalDuplicate && pick.settlementResult != null).length,
    },
    summary: {
      total: ordered.length,
      pending,
      settled,
      wins,
      losses,
      pushes,
      voids,
      winRatePct: gradedForWinRate > 0 ? round((wins / gradedForWinRate) * 100, 1) : 0,
      totalProfitUnits: round(totalProfitUnits),
      totalStakedUnits: round(totalStakedUnits),
      roiPct: round(roiPct, 1),
    },
    marketStats,
    picks,
  };
}

export type MlbLedgerHistoryView = ReturnType<typeof buildMlbLedgerHistoryView>;
