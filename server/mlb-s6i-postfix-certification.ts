import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import { terminalMlbLedgerRecords } from "./mlb-terminal-ledger-records";

export const MLB_S6I_POSTFIX_CERTIFICATION_VERSION = "mlb-s6i-postfix-certification.v1" as const;
export const MLB_S6I_PHASE3_DEPLOYMENT_COMMIT = "80c3120a35285724ef53b76e2d3a70300aab80ec" as const;
export const MLB_S6I_CLEAN_COHORT_CUTOFF = "2026-08-01T00:00:50.911Z" as const;
export const MLB_S6I_REQUIRED_CONSENSUS_METHOD = "median_implied_probability" as const;

const CUTOFF_MS = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);
const SETTLEMENT_OVERDUE_MS = 12 * 60 * 60 * 1000;
const ARITHMETIC_TOLERANCE_PP = 0.05;

export const MLB_S6I_REVIEW_THRESHOLDS = {
  minimumSettledUniqueDecisions: 20,
  minimumFinalSnapshotCoveragePct: 90,
  minimumClosingCoveragePct: 80,
  minimumFinalScoreCoveragePct: 95,
  requiredOverdueSettlementCoveragePct: 100,
} as const;

type S6iOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  now?: () => Date;
  deploymentCommit?: string;
  environment?: string;
};

export type S6iCertificationState = "COLLECTING" | "READY_FOR_HUMAN_REVIEW" | "ACTION_REQUIRED";

export type S6iIssueCode =
  | "CHAIN_CROSSES_CUTOFF"
  | "INVALID_AMERICAN_ODDS"
  | "IMPLIED_PROBABILITY_MISMATCH"
  | "EDGE_ARITHMETIC_MISMATCH"
  | "MISSING_PRICE_CAPTURE_TIME"
  | "MISSING_PRICE_PROVENANCE"
  | "WRONG_CONSENSUS_METHOD"
  | "MISSING_CONTRIBUTING_BOOKS"
  | "PRICE_VALIDATION_FLAG_MISSING"
  | "MARKET_SELECTION_MISMATCH"
  | "ANALYTICAL_DUPLICATE"
  | "FINAL_MISSED_AFTER_START"
  | "SETTLEMENT_OVERDUE"
  | "CLOSING_PRICE_INVALID"
  | "PERSISTENCE_COUNT_REGRESSION";

export type S6iIssue = {
  code: S6iIssueCode;
  severity: "INFO" | "WARNING" | "CRITICAL";
  predictionId: string | null;
  gamePk: number | null;
  message: string;
};

export type S6iCohortRow = {
  predictionId: string;
  gamePk: number | null;
  gameDate: string;
  commenceTime: string | null;
  awayTeam: string;
  homeTeam: string;
  marketType: string;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  modelProbabilityPct: number;
  marketImpliedProbabilityPct: number;
  edgePp: number;
  signal: string;
  analysisStage: string;
  recordedAt: string;
  chainLength: number;
  chainStartedAt: string;
  priceCapturedAt: string | null;
  providerLastUpdate: string | null;
  consensusMethod: string | null;
  contributingBooks: string[];
  standardAmericanOddsValidated: boolean;
  integrityStatus: "PASS" | "REVIEW" | "REJECT";
  duplicateOfPredictionId: string | null;
  settlement: {
    state: "PENDING" | "SETTLED" | "OVERDUE";
    result: string | null;
    settledAt: string | null;
    source: string | null;
    closingOddsAmerican: number | null;
    closingLine: number | null;
    clvPp: number | null;
    finalScore: { home: number; away: number } | null;
    profitUnits: number;
  };
  issueCodes: S6iIssueCode[];
};

export type S6iMarketBreakdown = {
  marketType: string;
  terminalDecisions: number;
  cleanUniqueDecisions: number;
  settled: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  meanModelProbabilityPct: number | null;
  observedWinRatePct: number | null;
  meanClvPp: number | null;
  brierScore: number | null;
};

export type S6iPostfixCertificationReport = {
  schemaVersion: typeof MLB_S6I_POSTFIX_CERTIFICATION_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  cohort: {
    cutoff: typeof MLB_S6I_CLEAN_COHORT_CUTOFF;
    cutoffSource: "first-live-schema-v2-verification";
    phase3Commit: typeof MLB_S6I_PHASE3_DEPLOYMENT_COMMIT;
    requiredConsensusMethod: typeof MLB_S6I_REQUIRED_CONSENSUS_METHOD;
  };
  state: S6iCertificationState;
  summary: {
    ownedLedgerRecords: number;
    s5cRecords: number;
    terminalS5cRecords: number;
    postCutoffTerminalDecisions: number;
    cleanUniqueDecisions: number;
    excludedDecisions: number;
    analyticalDuplicatesExcluded: number;
    integrityPass: number;
    integrityReview: number;
    integrityReject: number;
    invalidAmericanOdds: number;
    completeProvenance: number;
    finalCaptured: number;
    provisionalPending: number;
    finalMissedAfterStart: number;
    settled: number;
    settlementPending: number;
    settlementOverdue: number;
    closingCaptured: number;
    finalScoreCaptured: number;
    wins: number;
    losses: number;
    pushes: number;
    voids: number;
  };
  coverage: {
    integrityPassPct: number;
    provenancePct: number;
    finalSnapshotCoveragePct: number | null;
    overdueSettlementCoveragePct: number | null;
    closingCoveragePct: number | null;
    finalScoreCoveragePct: number | null;
  };
  persistence: {
    ledgerImmutable: true;
    previousOwnedLedgerRecords: number | null;
    currentOwnedLedgerRecords: number;
    countMonotonic: boolean;
  };
  performanceObservation: {
    settledUniqueDecisions: number;
    meanModelProbabilityPct: number | null;
    observedWinRatePct: number | null;
    meanClvPp: number | null;
    brierScore: number | null;
    informationalOnly: true;
  };
  marketBreakdowns: S6iMarketBreakdown[];
  rows: S6iCohortRow[];
  issues: S6iIssue[];
  readiness: {
    thresholds: typeof MLB_S6I_REVIEW_THRESHOLDS;
    checks: {
      zeroInvalidAmericanOdds: boolean;
      allCleanRowsHaveProvenance: boolean;
      finalSnapshotCoverageMet: boolean;
      overdueSettlementCoverageMet: boolean;
      closingCoverageMet: boolean;
      finalScoreCoverageMet: boolean;
      minimumSettledSampleMet: boolean;
      persistenceMonotonic: boolean;
    };
    humanReviewRequired: true;
    automaticPromotion: false;
  };
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    historicalLedgerMutation: false;
    automaticPromotion: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type S6iStatus = {
  schemaVersion: typeof MLB_S6I_POSTFIX_CERTIFICATION_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: S6iPostfixCertificationReport | null;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round((numerator / denominator) * 100, 1) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function validIso(value: unknown): string | null {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isStandardAmericanOdds(value: unknown): boolean {
  const odds = finite(value);
  return odds != null && Math.abs(Math.round(odds)) >= 100 && Math.abs(Math.round(odds)) <= 100_000;
}

function impliedProbability(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function isS5cRecord(record: LedgerRecord): boolean {
  return (record.prediction.payload as any)?.analysis?.layers?.s5c?.schemaVersion === "mlb-s5c-shadow-ingestion.v1";
}

function semanticFingerprint(record: LedgerRecord): string | null {
  const value = (record.prediction.payload as any)?.analysis?.layers?.s5c?.semanticFingerprint;
  const text = String(value ?? "").trim();
  return text || null;
}

function priceEvidence(record: LedgerRecord) {
  const payload = record.prediction.payload as any;
  const market = payload?.market ?? {};
  const integrity = payload?.analysis?.layers?.marketPriceIntegrity ?? {};
  const capture = payload?.analysis?.rawInputs?.priceCapture ?? {};
  const provenance = payload?.analysis?.rawInputs?.marketProvenance ?? {};
  return {
    priceCapturedAt: validIso(market?.capturedAt ?? capture?.capturedAt),
    providerLastUpdate: validIso(capture?.providerLastUpdate ?? provenance?.providerLastUpdate),
    consensusMethod: String(capture?.consensusMethod ?? provenance?.consensusMethod ?? integrity?.consensusMethod ?? "").trim() || null,
    contributingBooks: stringArray(provenance?.contributingBooks),
    standardAmericanOddsValidated: integrity?.standardAmericanOddsValidated === true,
  };
}

function chainFor(record: LedgerRecord, byId: Map<string, LedgerRecord>): LedgerRecord[] {
  const reverse: LedgerRecord[] = [];
  const visited = new Set<string>();
  let current: LedgerRecord | undefined = record;
  while (current && !visited.has(current.prediction.id)) {
    visited.add(current.prediction.id);
    reverse.push(current);
    const parentId = current.prediction.supersedesId;
    current = parentId ? byId.get(parentId) : undefined;
  }
  return reverse.reverse();
}

function issue(
  code: S6iIssueCode,
  severity: S6iIssue["severity"],
  record: LedgerRecord | null,
  message: string,
): S6iIssue {
  return {
    code,
    severity,
    predictionId: record?.prediction.id ?? null,
    gamePk: record?.prediction.game.gamePk ?? null,
    message,
  };
}

function resultOutcome(result: string | null | undefined): number | null {
  if (result === "WIN") return 1;
  if (result === "LOSS") return 0;
  if (result === "HALF_WIN") return 0.75;
  if (result === "HALF_LOSS") return 0.25;
  return null;
}

function isWin(result: string | null | undefined): boolean {
  return result === "WIN" || result === "HALF_WIN";
}

function isLoss(result: string | null | undefined): boolean {
  return result === "LOSS" || result === "HALF_LOSS";
}

function aggregatePerformance(rows: S6iCohortRow[]) {
  const settled = rows.filter((row) => row.settlement.state === "SETTLED");
  const graded = settled
    .map((row) => ({ row, outcome: resultOutcome(row.settlement.result) }))
    .filter((entry): entry is { row: S6iCohortRow; outcome: number } => entry.outcome != null);
  const clv = settled.map((row) => finite(row.settlement.clvPp)).filter((value): value is number => value != null);
  return {
    settledUniqueDecisions: settled.length,
    meanModelProbabilityPct: rows.length
      ? round(rows.reduce((sum, row) => sum + row.modelProbabilityPct, 0) / rows.length, 2)
      : null,
    observedWinRatePct: graded.length
      ? round((graded.reduce((sum, entry) => sum + entry.outcome, 0) / graded.length) * 100, 1)
      : null,
    meanClvPp: clv.length ? round(clv.reduce((sum, value) => sum + value, 0) / clv.length, 3) : null,
    brierScore: graded.length
      ? round(graded.reduce((sum, entry) => {
          const probability = entry.row.modelProbabilityPct / 100;
          return sum + (probability - entry.outcome) ** 2;
        }, 0) / graded.length, 4)
      : null,
  };
}

function marketBreakdowns(rows: S6iCohortRow[]): S6iMarketBreakdown[] {
  const markets = new Map<string, S6iCohortRow[]>();
  for (const row of rows) {
    const current = markets.get(row.marketType) ?? [];
    current.push(row);
    markets.set(row.marketType, current);
  }
  return [...markets.entries()].map(([marketType, marketRows]) => {
    const performance = aggregatePerformance(marketRows);
    const settled = marketRows.filter((row) => row.settlement.state === "SETTLED");
    return {
      marketType,
      terminalDecisions: marketRows.length,
      cleanUniqueDecisions: marketRows.length,
      settled: settled.length,
      wins: settled.filter((row) => isWin(row.settlement.result)).length,
      losses: settled.filter((row) => isLoss(row.settlement.result)).length,
      pushes: settled.filter((row) => row.settlement.result === "PUSH").length,
      voids: settled.filter((row) => row.settlement.result === "VOID").length,
      meanModelProbabilityPct: performance.meanModelProbabilityPct,
      observedWinRatePct: performance.observedWinRatePct,
      meanClvPp: performance.meanClvPp,
      brierScore: performance.brierScore,
    };
  }).sort((left, right) => right.cleanUniqueDecisions - left.cleanUniqueDecisions || left.marketType.localeCompare(right.marketType));
}

export function buildMlbS6iPostfixCertification(
  records: LedgerRecord[],
  options: {
    now?: Date;
    trigger?: string;
    previousOwnedLedgerRecords?: number | null;
    deploymentCommit?: string;
    environment?: string;
  } = {},
): S6iPostfixCertificationReport {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const byId = new Map(records.map((record) => [record.prediction.id, record]));
  const s5cRecords = records.filter(isS5cRecord);
  const terminal = terminalMlbLedgerRecords(s5cRecords);
  const postCutoffTerminal = terminal.filter((record) => record.prediction.recordedAtMs >= CUTOFF_MS);
  const issues: S6iIssue[] = [];
  const rows: S6iCohortRow[] = [];
  const firstByFingerprint = new Map<string, string>();

  for (const record of postCutoffTerminal) {
    const prediction = record.prediction;
    const chain = chainFor(record, byId);
    const evidence = priceEvidence(record);
    const rowIssues: S6iIssue[] = [];
    const chainStartedAt = chain[0]?.prediction.recordedAt ?? prediction.recordedAt;

    if (chain.some((stage) => stage.prediction.recordedAtMs < CUTOFF_MS)) {
      rowIssues.push(issue("CHAIN_CROSSES_CUTOFF", "WARNING", record, "The terminal decision supersedes a pre-fix record and is excluded from the pure post-fix cohort."));
    }

    for (const stage of chain) {
      if (!isStandardAmericanOdds(stage.prediction.market.oddsAmerican)) {
        rowIssues.push(issue("INVALID_AMERICAN_ODDS", "CRITICAL", record, `Chain stage ${stage.prediction.id} contains non-standard American odds ${stage.prediction.market.oddsAmerican}.`));
      }
    }

    const formulaImpliedPct = impliedProbability(prediction.market.oddsAmerican) * 100;
    const storedImpliedPct = prediction.probabilities.marketImplied * 100;
    if (Math.abs(storedImpliedPct - formulaImpliedPct) > ARITHMETIC_TOLERANCE_PP) {
      rowIssues.push(issue("IMPLIED_PROBABILITY_MISMATCH", "CRITICAL", record, `Stored implied probability ${storedImpliedPct.toFixed(4)}% differs from formula ${formulaImpliedPct.toFixed(4)}%.`));
    }
    const formulaEdgePp = prediction.probabilities.model * 100 - formulaImpliedPct;
    if (Math.abs(prediction.probabilities.edgePp - formulaEdgePp) > ARITHMETIC_TOLERANCE_PP) {
      rowIssues.push(issue("EDGE_ARITHMETIC_MISMATCH", "CRITICAL", record, `Stored edge ${prediction.probabilities.edgePp.toFixed(4)} pp differs from formula ${formulaEdgePp.toFixed(4)} pp.`));
    }

    if (!evidence.priceCapturedAt) {
      rowIssues.push(issue("MISSING_PRICE_CAPTURE_TIME", "CRITICAL", record, "The original market capture time is missing."));
    }
    if (!evidence.consensusMethod) {
      rowIssues.push(issue("MISSING_PRICE_PROVENANCE", "CRITICAL", record, "The price consensus method is missing."));
    } else if (evidence.consensusMethod !== MLB_S6I_REQUIRED_CONSENSUS_METHOD) {
      rowIssues.push(issue("WRONG_CONSENSUS_METHOD", "CRITICAL", record, `Expected ${MLB_S6I_REQUIRED_CONSENSUS_METHOD}, received ${evidence.consensusMethod}.`));
    }
    if (!evidence.contributingBooks.length) {
      rowIssues.push(issue("MISSING_CONTRIBUTING_BOOKS", "CRITICAL", record, "No contributing sportsbook keys are present in the immutable payload."));
    }
    if (!evidence.standardAmericanOddsValidated) {
      rowIssues.push(issue("PRICE_VALIDATION_FLAG_MISSING", "CRITICAL", record, "The S6H standard-American-odds validation flag is absent."));
    }

    const selection = prediction.market.selection.toUpperCase();
    if (prediction.market.type === "F5_TOTAL" && (!Number.isFinite(prediction.market.line) || !/^(OVER|UNDER)\b/.test(selection))) {
      rowIssues.push(issue("MARKET_SELECTION_MISMATCH", "CRITICAL", record, "F5_TOTAL requires an OVER/UNDER selection and an explicit line."));
    }
    if (prediction.market.type === "F5_ML" && /^(OVER|UNDER)\b/.test(selection)) {
      rowIssues.push(issue("MARKET_SELECTION_MISMATCH", "CRITICAL", record, "F5_ML cannot use an OVER/UNDER selection."));
    }

    let duplicateOfPredictionId: string | null = null;
    const fingerprint = semanticFingerprint(record);
    if (fingerprint) {
      duplicateOfPredictionId = firstByFingerprint.get(fingerprint) ?? null;
      if (!duplicateOfPredictionId) firstByFingerprint.set(fingerprint, prediction.id);
      else rowIssues.push(issue("ANALYTICAL_DUPLICATE", "INFO", record, `Analytical duplicate of ${duplicateOfPredictionId}; excluded from performance metrics.`));
    }

    const commenceMs = Date.parse(String(prediction.game.commenceTime ?? ""));
    const started = Number.isFinite(commenceMs) && commenceMs <= nowMs;
    if (started && prediction.analysisStage !== "FINAL") {
      rowIssues.push(issue("FINAL_MISSED_AFTER_START", "WARNING", record, "Game started without a terminal FINAL snapshot."));
    }

    const overdue = Number.isFinite(commenceMs)
      && commenceMs + SETTLEMENT_OVERDUE_MS <= nowMs
      && !record.settlement;
    if (overdue) {
      rowIssues.push(issue("SETTLEMENT_OVERDUE", "WARNING", record, "Settlement is missing more than 12 hours after scheduled start."));
    }
    if (record.settlement?.closingOddsAmerican != null && !isStandardAmericanOdds(record.settlement.closingOddsAmerican)) {
      rowIssues.push(issue("CLOSING_PRICE_INVALID", "WARNING", record, `Settlement contains non-standard closing odds ${record.settlement.closingOddsAmerican}.`));
    }

    const hasReject = rowIssues.some((entry) => entry.severity === "CRITICAL");
    const hasReview = rowIssues.some((entry) => entry.severity === "WARNING");
    const integrityStatus: S6iCohortRow["integrityStatus"] = hasReject ? "REJECT" : hasReview ? "REVIEW" : "PASS";
    issues.push(...rowIssues);

    rows.push({
      predictionId: prediction.id,
      gamePk: prediction.game.gamePk,
      gameDate: prediction.game.gameDate,
      commenceTime: prediction.game.commenceTime,
      awayTeam: prediction.game.awayTeam,
      homeTeam: prediction.game.homeTeam,
      marketType: prediction.market.type,
      selection: prediction.market.selection,
      line: prediction.market.line,
      oddsAmerican: prediction.market.oddsAmerican,
      modelProbabilityPct: round(prediction.probabilities.model * 100, 2),
      marketImpliedProbabilityPct: round(prediction.probabilities.marketImplied * 100, 2),
      edgePp: round(prediction.probabilities.edgePp, 2),
      signal: prediction.decision.signal,
      analysisStage: prediction.analysisStage,
      recordedAt: prediction.recordedAt,
      chainLength: chain.length,
      chainStartedAt,
      priceCapturedAt: evidence.priceCapturedAt,
      providerLastUpdate: evidence.providerLastUpdate,
      consensusMethod: evidence.consensusMethod,
      contributingBooks: evidence.contributingBooks,
      standardAmericanOddsValidated: evidence.standardAmericanOddsValidated,
      integrityStatus,
      duplicateOfPredictionId,
      settlement: {
        state: record.settlement ? "SETTLED" : overdue ? "OVERDUE" : "PENDING",
        result: record.settlement?.result ?? null,
        settledAt: record.settlement?.settledAt ?? null,
        source: record.settlement?.source ?? null,
        closingOddsAmerican: record.settlement?.closingOddsAmerican ?? null,
        closingLine: record.settlement?.closingLine ?? null,
        clvPp: record.settlement?.clvPp ?? null,
        finalScore: record.settlement?.finalScore ?? null,
        profitUnits: Number(record.settlement?.profitUnits ?? 0),
      },
      issueCodes: rowIssues.map((entry) => entry.code),
    });
  }

  const pureCandidateRows = rows.filter((row) => !row.duplicateOfPredictionId && !row.issueCodes.includes("CHAIN_CROSSES_CUTOFF"));
  const cleanUniqueRows = pureCandidateRows.filter((row) => row.integrityStatus !== "REJECT");
  const cleanPassRows = cleanUniqueRows.filter((row) => row.integrityStatus === "PASS");
  const startedRows = cleanUniqueRows.filter((row) => {
    const commenceMs = Date.parse(String(row.commenceTime ?? ""));
    return Number.isFinite(commenceMs) && commenceMs <= nowMs;
  });
  const overdueEligible = cleanUniqueRows.filter((row) => {
    const commenceMs = Date.parse(String(row.commenceTime ?? ""));
    return Number.isFinite(commenceMs) && commenceMs + SETTLEMENT_OVERDUE_MS <= nowMs;
  });
  const settledRows = cleanUniqueRows.filter((row) => row.settlement.state === "SETTLED");
  const completeProvenance = cleanUniqueRows.filter((row) => row.priceCapturedAt && row.consensusMethod === MLB_S6I_REQUIRED_CONSENSUS_METHOD && row.contributingBooks.length && row.standardAmericanOddsValidated).length;
  const closingCaptured = settledRows.filter((row) => row.settlement.closingOddsAmerican != null && row.settlement.clvPp != null).length;
  const finalScoreCaptured = settledRows.filter((row) => row.settlement.finalScore != null && row.settlement.source === "official").length;
  const previousCount = options.previousOwnedLedgerRecords ?? null;
  const countMonotonic = previousCount == null || records.length >= previousCount;
  if (!countMonotonic) {
    issues.push(issue("PERSISTENCE_COUNT_REGRESSION", "CRITICAL", null, `Owned ledger record count decreased from ${previousCount} to ${records.length}.`));
  }

  const performance = aggregatePerformance(cleanUniqueRows);
  const integrityPassPct = pct(cleanPassRows.length, cleanUniqueRows.length) ?? 0;
  const provenancePct = pct(completeProvenance, cleanUniqueRows.length) ?? 0;
  const finalSnapshotCoveragePct = pct(startedRows.filter((row) => row.analysisStage === "FINAL").length, startedRows.length);
  const overdueSettlementCoveragePct = pct(overdueEligible.filter((row) => row.settlement.state === "SETTLED").length, overdueEligible.length);
  const closingCoveragePct = pct(closingCaptured, settledRows.length);
  const finalScoreCoveragePct = pct(finalScoreCaptured, settledRows.length);

  const checks = {
    zeroInvalidAmericanOdds: pureCandidateRows.every((row) => !row.issueCodes.includes("INVALID_AMERICAN_ODDS")),
    allCleanRowsHaveProvenance: cleanUniqueRows.length === 0 || completeProvenance === cleanUniqueRows.length,
    finalSnapshotCoverageMet: finalSnapshotCoveragePct == null || finalSnapshotCoveragePct >= MLB_S6I_REVIEW_THRESHOLDS.minimumFinalSnapshotCoveragePct,
    overdueSettlementCoverageMet: overdueSettlementCoveragePct == null || overdueSettlementCoveragePct >= MLB_S6I_REVIEW_THRESHOLDS.requiredOverdueSettlementCoveragePct,
    closingCoverageMet: closingCoveragePct == null || closingCoveragePct >= MLB_S6I_REVIEW_THRESHOLDS.minimumClosingCoveragePct,
    finalScoreCoverageMet: finalScoreCoveragePct == null || finalScoreCoveragePct >= MLB_S6I_REVIEW_THRESHOLDS.minimumFinalScoreCoveragePct,
    minimumSettledSampleMet: settledRows.length >= MLB_S6I_REVIEW_THRESHOLDS.minimumSettledUniqueDecisions,
    persistenceMonotonic: countMonotonic,
  };
  const excludedTransitionPredictionIds = new Set(
    rows
      .filter((row) => row.issueCodes.includes("CHAIN_CROSSES_CUTOFF"))
      .map((row) => row.predictionId),
  );
  const criticalOrActionable = issues.some((entry) => {
    const belongsToExcludedTransition = entry.predictionId != null
      && excludedTransitionPredictionIds.has(entry.predictionId);
    return !belongsToExcludedTransition
      && (entry.severity === "CRITICAL" || entry.code === "FINAL_MISSED_AFTER_START" || entry.code === "SETTLEMENT_OVERDUE");
  });
  const allOperationalChecks = Object.entries(checks)
    .filter(([key]) => key !== "minimumSettledSampleMet")
    .every(([, value]) => value);
  const state: S6iCertificationState = criticalOrActionable || !allOperationalChecks
    ? "ACTION_REQUIRED"
    : checks.minimumSettledSampleMet
      ? "READY_FOR_HUMAN_REVIEW"
      : "COLLECTING";

  return {
    schemaVersion: MLB_S6I_POSTFIX_CERTIFICATION_VERSION,
    generatedAt: now.toISOString(),
    trigger: options.trigger ?? "manual",
    deploymentCommit: options.deploymentCommit ?? "unknown",
    environment: options.environment ?? "unknown",
    cohort: {
      cutoff: MLB_S6I_CLEAN_COHORT_CUTOFF,
      cutoffSource: "first-live-schema-v2-verification",
      phase3Commit: MLB_S6I_PHASE3_DEPLOYMENT_COMMIT,
      requiredConsensusMethod: MLB_S6I_REQUIRED_CONSENSUS_METHOD,
    },
    state,
    summary: {
      ownedLedgerRecords: records.length,
      s5cRecords: s5cRecords.length,
      terminalS5cRecords: terminal.length,
      postCutoffTerminalDecisions: rows.length,
      cleanUniqueDecisions: cleanUniqueRows.length,
      excludedDecisions: rows.length - cleanUniqueRows.length,
      analyticalDuplicatesExcluded: rows.filter((row) => Boolean(row.duplicateOfPredictionId)).length,
      integrityPass: rows.filter((row) => row.integrityStatus === "PASS").length,
      integrityReview: rows.filter((row) => row.integrityStatus === "REVIEW").length,
      integrityReject: rows.filter((row) => row.integrityStatus === "REJECT").length,
      invalidAmericanOdds: pureCandidateRows.filter((row) => row.issueCodes.includes("INVALID_AMERICAN_ODDS")).length,
      completeProvenance,
      finalCaptured: cleanUniqueRows.filter((row) => row.analysisStage === "FINAL").length,
      provisionalPending: cleanUniqueRows.filter((row) => row.analysisStage === "PROVISIONAL" && row.settlement.state === "PENDING").length,
      finalMissedAfterStart: rows.filter((row) => row.issueCodes.includes("FINAL_MISSED_AFTER_START")).length,
      settled: settledRows.length,
      settlementPending: cleanUniqueRows.filter((row) => row.settlement.state === "PENDING").length,
      settlementOverdue: cleanUniqueRows.filter((row) => row.settlement.state === "OVERDUE").length,
      closingCaptured,
      finalScoreCaptured,
      wins: settledRows.filter((row) => isWin(row.settlement.result)).length,
      losses: settledRows.filter((row) => isLoss(row.settlement.result)).length,
      pushes: settledRows.filter((row) => row.settlement.result === "PUSH").length,
      voids: settledRows.filter((row) => row.settlement.result === "VOID").length,
    },
    coverage: {
      integrityPassPct,
      provenancePct,
      finalSnapshotCoveragePct,
      overdueSettlementCoveragePct,
      closingCoveragePct,
      finalScoreCoveragePct,
    },
    persistence: {
      ledgerImmutable: true,
      previousOwnedLedgerRecords: previousCount,
      currentOwnedLedgerRecords: records.length,
      countMonotonic,
    },
    performanceObservation: {
      ...performance,
      informationalOnly: true,
    },
    marketBreakdowns: marketBreakdowns(cleanUniqueRows),
    rows: rows.sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)),
    issues,
    readiness: {
      thresholds: MLB_S6I_REVIEW_THRESHOLDS,
      checks,
      humanReviewRequired: true,
      automaticPromotion: false,
    },
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      historicalLedgerMutation: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  };
}

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S6I_POSTFIX_CERTIFICATION?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6I_POSTFIX_CERTIFICATION_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6i-postfix-certification");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export class MlbS6iPostfixCertificationService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly ownerUserId: number;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    options: S6iOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6I_INTERVAL_MS, 15 * 60 * 1000, 5 * 60 * 1000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6I_INITIAL_DELAY_MS, 90_000, 10_000);
    this.ownerUserId = options.ownerUserId;
    this.root = options.root ?? defaultRoot();
    this.now = options.now ?? (() => new Date());
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.lastSuccessAt = this.readLatest()?.generatedAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): S6iPostfixCertificationReport | null {
    return readJson<S6iPostfixCertificationReport>(path.join(this.root, "latest.json"));
  }

  status(): S6iStatus {
    return {
      schemaVersion: MLB_S6I_POSTFIX_CERTIFICATION_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
    };
  }

  run(trigger = "scheduled"): S6iPostfixCertificationReport {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
      const report = buildMlbS6iPostfixCertification(records, {
        now,
        trigger,
        previousOwnedLedgerRecords: previous?.summary.ownedLedgerRecords ?? null,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
      });
      atomicWriteJson(path.join(this.root, "latest.json"), report);
      atomicWriteJson(path.join(this.root, "snapshots", `${report.generatedAt.replace(/[:.]/g, "-")}.json`), report);
      this.lastSuccessAt = report.generatedAt;
      this.lastError = null;
      return report;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function startMlbS6iPostfixCertificationWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  options: S6iOptions,
): { service: MlbS6iPostfixCertificationService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6iPostfixCertificationService(store, ownershipStore, options);
  if (!service.isEnabled()) return { service, timer: null };
  const run = () => {
    try {
      service.run("scheduled");
    } catch (error) {
      console.error("[s6i] MLB post-fix certification failed", error);
    }
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
