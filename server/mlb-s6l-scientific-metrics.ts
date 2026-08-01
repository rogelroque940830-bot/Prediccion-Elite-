import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import type { MlbS6kFirstTenCyclesCertificationService } from "./mlb-s6k-first-ten-cycles-certification";
import {
  MLB_S6I_CLEAN_COHORT_CUTOFF,
  MLB_S6I_REQUIRED_CONSENSUS_METHOD,
} from "./mlb-s6i-postfix-certification";

export const MLB_S6L_SCIENTIFIC_METRICS_VERSION = "mlb-s6l-scientific-metrics.v1" as const;
export const MLB_S6L_MIN_BINARY_SAMPLE = 20 as const;
export const MLB_S6L_PREFERRED_BINARY_SAMPLE = 50 as const;
export const MLB_S6L_REQUIRED_CERTIFIED_CYCLES = 10 as const;

const CUTOFF_MS = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);
const EPSILON = 1e-15;

type S6lOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  now?: () => Date;
  deploymentCommit?: string;
  environment?: string;
};

export type S6lState = "INSUFFICIENT_SAMPLE" | "COLLECTING" | "READY_FOR_REVIEW" | "ACTION_REQUIRED";

type BinaryOutcome = 0 | 1;

type ScientificObservation = {
  rootPredictionId: string;
  terminalPredictionId: string;
  gamePk: number | null;
  gameDate: string;
  marketType: string;
  selection: string;
  line: number | null;
  signal: string;
  modelProbability: number;
  marketImpliedProbability: number;
  oddsAmerican: number;
  result: "WIN" | "LOSS" | "PUSH" | "VOID";
  outcome: BinaryOutcome | null;
  clvPp: number | null;
  independentlyCertified: boolean;
};

export type S6lMetricSummary = {
  observations: number;
  binaryDecisions: number;
  wins: number;
  losses: number;
  pushes: number;
  voids: number;
  meanModelProbability: number | null;
  observedWinRate: number | null;
  winRateWilson95: { low: number; high: number } | null;
  brierScore: number | null;
  logLoss: number | null;
  expectedCalibrationError: number | null;
  maximumCalibrationError: number | null;
  flatStakeExposureUnits: number;
  flatStakeProfitUnits: number;
  flatStakeRoiPct: number | null;
  clvAvailable: number;
  clvCoveragePct: number | null;
  meanClvPp: number | null;
  medianClvPp: number | null;
};

export type S6lCalibrationBin = {
  lowerInclusive: number;
  upperExclusive: number;
  observations: number;
  meanPredictedProbability: number;
  observedWinRate: number;
  calibrationGapPp: number;
};

export type S6lBreakdown = {
  key: string;
  metrics: S6lMetricSummary;
};

export type S6lScientificMetricsReport = {
  schemaVersion: typeof MLB_S6L_SCIENTIFIC_METRICS_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6lState;
  cohort: {
    cutoff: typeof MLB_S6I_CLEAN_COHORT_CUTOFF;
    requiredConsensusMethod: typeof MLB_S6I_REQUIRED_CONSENSUS_METHOD;
    minimumBinarySample: typeof MLB_S6L_MIN_BINARY_SAMPLE;
    preferredBinarySample: typeof MLB_S6L_PREFERRED_BINARY_SAMPLE;
    requiredCertifiedCycles: typeof MLB_S6L_REQUIRED_CERTIFIED_CYCLES;
  };
  sample: {
    ownedLedgerRecords: number;
    s5cChains: number;
    uniqueAnalyticalCycles: number;
    duplicatesExcluded: number;
    eligibleSettledDecisions: number;
    binaryScoredDecisions: number;
    independentlyCertifiedDecisions: number;
    exclusionCounts: Record<string, number>;
  };
  overall: S6lMetricSummary;
  calibration: S6lCalibrationBin[];
  byMarket: S6lBreakdown[];
  bySignal: S6lBreakdown[];
  provisionalToFinal: {
    pairedCycles: number;
    meanSignedModelProbabilityDeltaPp: number | null;
    meanAbsoluteModelProbabilityDeltaPp: number | null;
    meanSignedMarketImpliedDeltaPp: number | null;
    meanAbsoluteMarketImpliedDeltaPp: number | null;
    signalChanges: number;
  };
  coverage: {
    independentCertificationPct: number | null;
    clvPct: number | null;
  };
  readiness: {
    enoughForFirstRead: boolean;
    preferredSampleReached: boolean;
    tenCertifiedCyclesReached: boolean;
    conclusionsAllowed: boolean;
    automaticModelChangesAllowed: false;
    recommendation: "NO_AUTOMATIC_MODEL_CHANGE";
  };
  persistence: {
    ledgerImmutable: true;
    previousOwnedLedgerRecords: number | null;
    currentOwnedLedgerRecords: number;
    countMonotonic: boolean;
  };
  issues: Array<{ code: string; severity: "INFO" | "WARNING" | "CRITICAL"; message: string }>;
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

export type S6lStatus = {
  schemaVersion: typeof MLB_S6L_SCIENTIFIC_METRICS_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: S6lScientificMetricsReport | null;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isStandardAmericanOdds(value: unknown): value is number {
  const odds = finite(value);
  return odds != null && Number.isInteger(odds) && Math.abs(odds) >= 100 && Math.abs(odds) <= 100_000;
}

function impliedProbability(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function americanWinProfit(odds: number): number {
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function isS5cRecord(record: LedgerRecord): boolean {
  return (record.prediction.payload as any)?.analysis?.layers?.s5c?.schemaVersion === "mlb-s5c-shadow-ingestion.v1";
}

function rootIdFor(record: LedgerRecord, byId: Map<string, LedgerRecord>): string {
  const visited = new Set<string>();
  let current = record;
  while (current.prediction.supersedesId && !visited.has(current.prediction.id)) {
    visited.add(current.prediction.id);
    const parent = byId.get(current.prediction.supersedesId);
    if (!parent) break;
    current = parent;
  }
  return current.prediction.id;
}

function groupS5cChains(records: LedgerRecord[]): Map<string, LedgerRecord[]> {
  const s5c = records.filter(isS5cRecord);
  const byId = new Map(s5c.map((record) => [record.prediction.id, record]));
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of s5c) {
    const rootId = rootIdFor(record, byId);
    const chain = groups.get(rootId) ?? [];
    chain.push(record);
    groups.set(rootId, chain);
  }
  for (const chain of groups.values()) {
    chain.sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs
      || left.prediction.id.localeCompare(right.prediction.id));
  }
  return groups;
}

function terminalFor(chain: LedgerRecord[]): LedgerRecord | null {
  if (!chain.length) return null;
  const parentIds = new Set(chain.map((record) => record.prediction.supersedesId).filter(Boolean));
  return chain
    .filter((record) => !parentIds.has(record.prediction.id))
    .sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs
      || left.prediction.id.localeCompare(right.prediction.id))
    .at(-1) ?? null;
}

function analyticalIdentity(record: LedgerRecord): string {
  const prediction = record.prediction;
  return JSON.stringify({
    gamePk: prediction.game.gamePk ?? null,
    gameDate: prediction.game.gameDate,
    homeTeam: normalize(prediction.game.homeTeam),
    awayTeam: normalize(prediction.game.awayTeam),
    marketType: prediction.market.type,
    selection: normalize(prediction.market.selection),
    line: prediction.market.line ?? null,
  });
}

function priceProvenanceComplete(record: LedgerRecord): boolean {
  const payload = record.prediction.payload as any;
  const integrity = payload?.analysis?.layers?.marketPriceIntegrity ?? {};
  const capture = payload?.analysis?.rawInputs?.priceCapture ?? {};
  const provenance = payload?.analysis?.rawInputs?.marketProvenance ?? {};
  const capturedAt = Date.parse(String(payload?.market?.capturedAt ?? capture?.capturedAt ?? ""));
  const method = String(capture?.consensusMethod ?? provenance?.consensusMethod ?? integrity?.consensusMethod ?? "");
  const books = Array.isArray(provenance?.contributingBooks)
    ? provenance.contributingBooks.map((entry: unknown) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  return integrity?.standardAmericanOddsValidated === true
    && Number.isFinite(capturedAt)
    && method === MLB_S6I_REQUIRED_CONSENSUS_METHOD
    && books.length > 0;
}

function settlementResult(record: LedgerRecord): ScientificObservation["result"] | null {
  const result = String(record.settlement?.result ?? "").toUpperCase();
  return result === "WIN" || result === "LOSS" || result === "PUSH" || result === "VOID" ? result : null;
}

function settlementSourceValid(record: LedgerRecord): boolean {
  const settlement = record.settlement;
  return Boolean(settlement && (settlement.source === "official"
    || (settlement.source === "correction" && settlement.correctionOfEventId)));
}

function wilson95(wins: number, total: number): { low: number; high: number } | null {
  if (total <= 0) return null;
  const z = 1.959963984540054;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total) / denominator;
  return { low: round(Math.max(0, center - margin)), high: round(Math.min(1, center + margin)) };
}

function calibrationBins(observations: ScientificObservation[]): S6lCalibrationBin[] {
  const binary = observations.filter((entry) => entry.outcome != null);
  const bins: S6lCalibrationBin[] = [];
  for (let index = 0; index < 10; index += 1) {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const values = binary.filter((entry) => entry.modelProbability >= lower
      && (index === 9 ? entry.modelProbability <= upper : entry.modelProbability < upper));
    if (!values.length) continue;
    const predicted = average(values.map((entry) => entry.modelProbability)) ?? 0;
    const observed = average(values.map((entry) => entry.outcome as number)) ?? 0;
    bins.push({
      lowerInclusive: lower,
      upperExclusive: upper,
      observations: values.length,
      meanPredictedProbability: round(predicted),
      observedWinRate: round(observed),
      calibrationGapPp: round((observed - predicted) * 100, 4),
    });
  }
  return bins;
}

function summarize(observations: ScientificObservation[]): S6lMetricSummary {
  const binary = observations.filter((entry) => entry.outcome != null);
  const wins = observations.filter((entry) => entry.result === "WIN").length;
  const losses = observations.filter((entry) => entry.result === "LOSS").length;
  const pushes = observations.filter((entry) => entry.result === "PUSH").length;
  const voids = observations.filter((entry) => entry.result === "VOID").length;
  const modelProbabilities = binary.map((entry) => entry.modelProbability);
  const brier = average(binary.map((entry) => (entry.modelProbability - (entry.outcome as number)) ** 2));
  const logLoss = average(binary.map((entry) => {
    const probability = Math.min(1 - EPSILON, Math.max(EPSILON, entry.modelProbability));
    return -((entry.outcome as number) * Math.log(probability)
      + (1 - (entry.outcome as number)) * Math.log(1 - probability));
  }));
  const bins = calibrationBins(observations);
  const ece = binary.length
    ? bins.reduce((sum, bin) => sum + (bin.observations / binary.length) * Math.abs(bin.calibrationGapPp / 100), 0)
    : null;
  const mce = bins.length ? Math.max(...bins.map((bin) => Math.abs(bin.calibrationGapPp / 100))) : null;
  const flatStake = observations.filter((entry) => entry.result !== "VOID");
  const flatProfit = flatStake.reduce((sum, entry) => {
    if (entry.result === "WIN") return sum + americanWinProfit(entry.oddsAmerican);
    if (entry.result === "LOSS") return sum - 1;
    return sum;
  }, 0);
  const clv = observations.map((entry) => entry.clvPp).filter((value): value is number => value != null);
  return {
    observations: observations.length,
    binaryDecisions: binary.length,
    wins,
    losses,
    pushes,
    voids,
    meanModelProbability: modelProbabilities.length ? round(average(modelProbabilities) as number) : null,
    observedWinRate: binary.length ? round(wins / binary.length) : null,
    winRateWilson95: wilson95(wins, binary.length),
    brierScore: brier == null ? null : round(brier),
    logLoss: logLoss == null ? null : round(logLoss),
    expectedCalibrationError: ece == null ? null : round(ece),
    maximumCalibrationError: mce == null ? null : round(mce),
    flatStakeExposureUnits: flatStake.length,
    flatStakeProfitUnits: round(flatProfit, 4),
    flatStakeRoiPct: flatStake.length ? round((flatProfit / flatStake.length) * 100, 4) : null,
    clvAvailable: clv.length,
    clvCoveragePct: observations.length ? round((clv.length / observations.length) * 100, 2) : null,
    meanClvPp: clv.length ? round(average(clv) as number, 4) : null,
    medianClvPp: clv.length ? round(median(clv) as number, 4) : null,
  };
}

function breakdown(observations: ScientificObservation[], selector: (entry: ScientificObservation) => string): S6lBreakdown[] {
  const groups = new Map<string, ScientificObservation[]>();
  for (const observation of observations) {
    const key = selector(observation) || "UNKNOWN";
    const values = groups.get(key) ?? [];
    values.push(observation);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .map(([key, values]) => ({ key, metrics: summarize(values) }))
    .sort((left, right) => right.metrics.binaryDecisions - left.metrics.binaryDecisions || left.key.localeCompare(right.key));
}

function exclusionCounter(): Record<string, number> {
  return {
    PRE_FIX_CHAIN: 0,
    ANALYTICAL_DUPLICATE: 0,
    NO_FINAL_TERMINAL: 0,
    INVALID_AMERICAN_ODDS: 0,
    INVALID_MODEL_PROBABILITY: 0,
    INCOMPLETE_PRICE_PROVENANCE: 0,
    UNSETTLED: 0,
    INVALID_SETTLEMENT_SOURCE: 0,
    UNSUPPORTED_SETTLEMENT_RESULT: 0,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function buildMlbS6lScientificMetrics(
  records: LedgerRecord[],
  options: {
    certifiedTerminalPredictionIds?: string[];
    generatedAt?: string;
    trigger?: string;
    deploymentCommit?: string;
    environment?: string;
    previousOwnedLedgerRecords?: number | null;
  } = {},
): S6lScientificMetricsReport {
  const groups = groupS5cChains(records);
  const certified = new Set(options.certifiedTerminalPredictionIds ?? []);
  const exclusions = exclusionCounter();
  const seenIdentities = new Set<string>();
  const observations: ScientificObservation[] = [];
  let duplicatesExcluded = 0;
  let uniqueAnalyticalCycles = 0;

  const orderedGroups = [...groups.entries()].sort((left, right) => {
    const leftTerminal = terminalFor(left[1]);
    const rightTerminal = terminalFor(right[1]);
    return (leftTerminal?.prediction.recordedAtMs ?? 0) - (rightTerminal?.prediction.recordedAtMs ?? 0)
      || left[0].localeCompare(right[0]);
  });

  for (const [rootPredictionId, chain] of orderedGroups) {
    if (!chain.every((record) => record.prediction.recordedAtMs >= CUTOFF_MS)) {
      increment(exclusions, "PRE_FIX_CHAIN");
      continue;
    }
    const terminal = terminalFor(chain);
    if (!terminal) continue;
    const identity = analyticalIdentity(terminal);
    if (seenIdentities.has(identity)) {
      duplicatesExcluded += 1;
      increment(exclusions, "ANALYTICAL_DUPLICATE");
      continue;
    }
    seenIdentities.add(identity);
    uniqueAnalyticalCycles += 1;
    if (terminal.prediction.analysisStage !== "FINAL") {
      increment(exclusions, "NO_FINAL_TERMINAL");
      continue;
    }
    const odds = terminal.prediction.market.oddsAmerican;
    if (!isStandardAmericanOdds(odds)) {
      increment(exclusions, "INVALID_AMERICAN_ODDS");
      continue;
    }
    const modelProbability = finite(terminal.prediction.probabilities.model);
    if (modelProbability == null || modelProbability <= 0 || modelProbability >= 1) {
      increment(exclusions, "INVALID_MODEL_PROBABILITY");
      continue;
    }
    if (!priceProvenanceComplete(terminal)) {
      increment(exclusions, "INCOMPLETE_PRICE_PROVENANCE");
      continue;
    }
    if (!terminal.settlement) {
      increment(exclusions, "UNSETTLED");
      continue;
    }
    if (!settlementSourceValid(terminal)) {
      increment(exclusions, "INVALID_SETTLEMENT_SOURCE");
      continue;
    }
    const result = settlementResult(terminal);
    if (!result) {
      increment(exclusions, "UNSUPPORTED_SETTLEMENT_RESULT");
      continue;
    }
    observations.push({
      rootPredictionId,
      terminalPredictionId: terminal.prediction.id,
      gamePk: terminal.prediction.game.gamePk ?? null,
      gameDate: terminal.prediction.game.gameDate,
      marketType: terminal.prediction.market.type,
      selection: terminal.prediction.market.selection,
      line: terminal.prediction.market.line ?? null,
      signal: String(terminal.prediction.decision.signal ?? "UNKNOWN"),
      modelProbability,
      marketImpliedProbability: impliedProbability(odds),
      oddsAmerican: odds,
      result,
      outcome: result === "WIN" ? 1 : result === "LOSS" ? 0 : null,
      clvPp: finite(terminal.settlement.clvPp),
      independentlyCertified: certified.has(terminal.prediction.id),
    });
  }

  const paired = orderedGroups
    .map(([, chain]) => ({
      provisional: chain.find((record) => record.prediction.analysisStage === "PROVISIONAL") ?? null,
      final: terminalFor(chain),
    }))
    .filter((entry): entry is { provisional: LedgerRecord; final: LedgerRecord } => Boolean(entry.provisional && entry.final?.prediction.analysisStage === "FINAL"))
    .filter((entry) => entry.provisional.prediction.recordedAtMs >= CUTOFF_MS)
    .filter((entry) => isStandardAmericanOdds(entry.provisional.prediction.market.oddsAmerican)
      && isStandardAmericanOdds(entry.final.prediction.market.oddsAmerican))
    .filter((entry) => finite(entry.provisional.prediction.probabilities.model) != null
      && finite(entry.final.prediction.probabilities.model) != null);
  const modelDeltas = paired.map((entry) => ((finite(entry.final.prediction.probabilities.model) as number)
    - (finite(entry.provisional.prediction.probabilities.model) as number)) * 100);
  const marketDeltas = paired.map((entry) => (impliedProbability(entry.final.prediction.market.oddsAmerican)
    - impliedProbability(entry.provisional.prediction.market.oddsAmerican)) * 100);

  const overall = summarize(observations);
  const independentlyCertifiedDecisions = observations.filter((entry) => entry.independentlyCertified).length;
  const independentCertificationPct = observations.length
    ? round((independentlyCertifiedDecisions / observations.length) * 100, 2)
    : null;
  const previousCount = options.previousOwnedLedgerRecords ?? null;
  const countMonotonic = previousCount == null || records.length >= previousCount;
  const enoughForFirstRead = overall.binaryDecisions >= MLB_S6L_MIN_BINARY_SAMPLE;
  const preferredSampleReached = overall.binaryDecisions >= MLB_S6L_PREFERRED_BINARY_SAMPLE;
  const tenCertifiedCyclesReached = independentlyCertifiedDecisions >= MLB_S6L_REQUIRED_CERTIFIED_CYCLES;
  const conclusionsAllowed = preferredSampleReached && tenCertifiedCyclesReached;
  const issues: S6lScientificMetricsReport["issues"] = [];
  if (!countMonotonic) {
    issues.push({
      code: "PERSISTENCE_COUNT_REGRESSION",
      severity: "CRITICAL",
      message: `Owned ledger count decreased from ${previousCount} to ${records.length}.`,
    });
  }
  if (!enoughForFirstRead) {
    issues.push({
      code: "MINIMUM_SAMPLE_NOT_REACHED",
      severity: "INFO",
      message: `${overall.binaryDecisions} binary decisions are available; ${MLB_S6L_MIN_BINARY_SAMPLE} are required for the first descriptive read.`,
    });
  } else if (!preferredSampleReached) {
    issues.push({
      code: "PREFERRED_SAMPLE_NOT_REACHED",
      severity: "INFO",
      message: `${overall.binaryDecisions} binary decisions are available; ${MLB_S6L_PREFERRED_BINARY_SAMPLE} are preferred before scientific review.`,
    });
  }
  if (!tenCertifiedCyclesReached) {
    issues.push({
      code: "CERTIFIED_CYCLE_COVERAGE_PENDING",
      severity: "INFO",
      message: `${independentlyCertifiedDecisions} independently certified decisions are available; ${MLB_S6L_REQUIRED_CERTIFIED_CYCLES} are required.`,
    });
  }
  const state: S6lState = !countMonotonic
    ? "ACTION_REQUIRED"
    : conclusionsAllowed
      ? "READY_FOR_REVIEW"
      : enoughForFirstRead
        ? "COLLECTING"
        : "INSUFFICIENT_SAMPLE";

  return {
    schemaVersion: MLB_S6L_SCIENTIFIC_METRICS_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    trigger: options.trigger ?? "manual",
    deploymentCommit: options.deploymentCommit ?? "unknown",
    environment: options.environment ?? "unknown",
    state,
    cohort: {
      cutoff: MLB_S6I_CLEAN_COHORT_CUTOFF,
      requiredConsensusMethod: MLB_S6I_REQUIRED_CONSENSUS_METHOD,
      minimumBinarySample: MLB_S6L_MIN_BINARY_SAMPLE,
      preferredBinarySample: MLB_S6L_PREFERRED_BINARY_SAMPLE,
      requiredCertifiedCycles: MLB_S6L_REQUIRED_CERTIFIED_CYCLES,
    },
    sample: {
      ownedLedgerRecords: records.length,
      s5cChains: groups.size,
      uniqueAnalyticalCycles,
      duplicatesExcluded,
      eligibleSettledDecisions: observations.length,
      binaryScoredDecisions: overall.binaryDecisions,
      independentlyCertifiedDecisions,
      exclusionCounts: exclusions,
    },
    overall,
    calibration: calibrationBins(observations),
    byMarket: breakdown(observations, (entry) => entry.marketType),
    bySignal: breakdown(observations, (entry) => entry.signal),
    provisionalToFinal: {
      pairedCycles: paired.length,
      meanSignedModelProbabilityDeltaPp: modelDeltas.length ? round(average(modelDeltas) as number, 4) : null,
      meanAbsoluteModelProbabilityDeltaPp: modelDeltas.length ? round(average(modelDeltas.map(Math.abs)) as number, 4) : null,
      meanSignedMarketImpliedDeltaPp: marketDeltas.length ? round(average(marketDeltas) as number, 4) : null,
      meanAbsoluteMarketImpliedDeltaPp: marketDeltas.length ? round(average(marketDeltas.map(Math.abs)) as number, 4) : null,
      signalChanges: paired.filter((entry) => entry.provisional.prediction.decision.signal !== entry.final.prediction.decision.signal).length,
    },
    coverage: {
      independentCertificationPct,
      clvPct: overall.clvCoveragePct,
    },
    readiness: {
      enoughForFirstRead,
      preferredSampleReached,
      tenCertifiedCyclesReached,
      conclusionsAllowed,
      automaticModelChangesAllowed: false,
      recommendation: "NO_AUTOMATIC_MODEL_CHANGE",
    },
    persistence: {
      ledgerImmutable: true,
      previousOwnedLedgerRecords: previousCount,
      currentOwnedLedgerRecords: records.length,
      countMonotonic,
    },
    issues,
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

function stableDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S6L_SCIENTIFIC_METRICS?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6L_SCIENTIFIC_METRICS_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6l-scientific-metrics");
}

export class MlbS6lScientificMetricsService {
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
    private readonly s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
    options: S6lOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6L_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6L_INITIAL_DELAY_MS, 210_000, 10_000);
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
  readLatest(): S6lScientificMetricsReport | null {
    return readJson<S6lScientificMetricsReport>(path.join(this.root, "latest.json"));
  }
  status(): S6lStatus {
    return {
      schemaVersion: MLB_S6L_SCIENTIFIC_METRICS_VERSION,
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

  async run(trigger = "scheduled"): Promise<S6lScientificMetricsReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
      const certifiedTerminalPredictionIds = (this.s6kFirstTen.readLatest()?.evidence ?? [])
        .filter((entry) => entry.state === "CERTIFIED")
        .map((entry) => entry.target.terminalPredictionId)
        .filter((entry): entry is string => Boolean(entry));
      const report = buildMlbS6lScientificMetrics(records, {
        certifiedTerminalPredictionIds,
        generatedAt: now.toISOString(),
        trigger,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
      });
      atomicWriteJson(path.join(this.root, "latest.json"), report);
      const previousDigest = previous ? stableDigest({ ...previous, generatedAt: undefined, trigger: undefined }) : null;
      const currentDigest = stableDigest({ ...report, generatedAt: undefined, trigger: undefined });
      if (currentDigest !== previousDigest) {
        atomicWriteJson(
          path.join(this.root, "snapshots", `${report.generatedAt.replace(/[:.]/g, "-")}-${currentDigest.slice(0, 12)}.json`),
          report,
        );
      }
      this.lastSuccessAt = report.generatedAt;
      this.lastError = null;
      return report;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function startMlbS6lScientificMetricsWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s6kFirstTen: MlbS6kFirstTenCyclesCertificationService,
  options: S6lOptions,
): { service: MlbS6lScientificMetricsService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6lScientificMetricsService(store, ownershipStore, s6kFirstTen, options);
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6l] scientific metrics worker failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
