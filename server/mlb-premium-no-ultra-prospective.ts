import crypto from "node:crypto";
import type { LedgerRecord } from "./mlb-ledger-store";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";

export const MLB_PREMIUM_NO_ULTRA_SCHEMA = "courtedge-p1-premium-no-ultra-prospective.v1" as const;
export const MLB_PREMIUM_NO_ULTRA_CUTOFF = "2026-08-08T04:32:33Z" as const;
export const MLB_PREMIUM_NO_ULTRA_CUTOFF_COMMIT = "a2bc70badc97251f2f0333beb1b2b954f841fad0" as const;

export type MlbPremiumNoUltraState =
  | "COLLECTING_PROSPECTIVE_EVIDENCE"
  | "CANDIDATE_NOT_CONFIRMED"
  | "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY";

export interface MlbPremiumNoUltraMetricSummary {
  observations: number;
  settled: number;
  pending: number;
  dates: number;
  wins: number;
  losses: number;
  hitRatePct: number | null;
  meanModelProbability: number | null;
  observedWinRate: number | null;
  calibrationGap: number | null;
  flatStakeProfitUnits: number;
  flatStakeRoiPct: number | null;
  brierScore: number | null;
  logLoss: number | null;
  clvAvailable: number;
  clvCoveragePct: number | null;
  meanClvPp: number | null;
  medianClvPp: number | null;
}

export interface MlbPremiumNoUltraBootstrapInterval {
  confidenceLevel: 0.95;
  replicatesRequested: number;
  replicatesUsed: number;
  pointEstimate: number;
  lower: number;
  upper: number;
}

export interface MlbPremiumNoUltraReport {
  schemaVersion: typeof MLB_PREMIUM_NO_ULTRA_SCHEMA;
  generatedAt: string;
  state: MlbPremiumNoUltraState;
  hypothesis: {
    alternative: "Future FINAL F5_ML terminal decisions whose selected recommendation is PREMIUM and not ULTRA have a positive and repeatable economic edge versus contemporaneous eligible non-candidate decisions.";
    null: "The post-hoc PREMIUM-without-ULTRA pattern does not survive genuinely prospective independent game-level confirmation.";
  };
  preregistration: {
    cutoff: typeof MLB_PREMIUM_NO_ULTRA_CUTOFF;
    cutoffEvidenceCommit: typeof MLB_PREMIUM_NO_ULTRA_CUTOFF_COMMIT;
    market: "F5_ML";
    requiredStage: "FINAL";
    requiredSource: "app";
    candidateRule: "SELECTED_PREMIUM_AND_NOT_SELECTED_ULTRA";
    oneTerminalDecisionPerGame: true;
    alternativePicksExcluded: true;
    outcomeForbiddenFromMembership: true;
    minimumCandidateSettled: number;
    minimumCandidateDates: number;
    minimumControlSettled: number;
    minimumControlDates: number;
    bootstrapReplicates: number;
    maximumCalibrationGap: 0.05;
    maximumCalibrationDisadvantageVsControl: 0.01;
  };
  cohort: {
    inputReviewRows: number;
    afterCutoff: number;
    eligibleFinalF5Rows: number;
    independentGames: number;
    duplicateGameRowsExcluded: number;
    candidateGames: number;
    controlGames: number;
    candidateSettled: number;
    controlSettled: number;
    candidateDates: number;
    controlDates: number;
  };
  candidate: MlbPremiumNoUltraMetricSummary;
  control: MlbPremiumNoUltraMetricSummary;
  inference: {
    dateClusters: number;
    candidateRoiPct: MlbPremiumNoUltraBootstrapInterval | null;
    candidateMinusControlRoiPp: MlbPremiumNoUltraBootstrapInterval | null;
  };
  criteria: {
    minimumCandidateSampleAccepted: boolean;
    minimumControlSampleAccepted: boolean;
    candidateRoiLower95Positive: boolean;
    candidateMinusControlRoiLower95Positive: boolean;
    meanClvPositive: boolean;
    properScoringNotWorse: boolean;
    calibrationAccepted: boolean;
    allAccepted: boolean;
  };
  blockers: string[];
  interpretation: {
    prospectiveOnly: true;
    independentGameUnit: true;
    historicalThirteenAndFourIncludedInConfirmation: false;
    oldUltraMoneyGateRestored: false;
    economicProfitabilitySupported: boolean;
    operationalMoneyGateAllowed: false;
    stakeChangesAllowed: false;
    automaticBettingAllowed: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export interface MlbPremiumNoUltraOptions {
  minimumCandidateSettled?: number;
  minimumCandidateDates?: number;
  minimumControlSettled?: number;
  minimumControlDates?: number;
  bootstrapReplicates?: number;
  generatedAt?: string;
}

const DEFAULTS = {
  minimumCandidateSettled: 50,
  minimumCandidateDates: 20,
  minimumControlSettled: 50,
  minimumControlDates: 20,
  bootstrapReplicates: 5000,
} as const;

interface EligibleDecision {
  row: MlbP1M3dReviewRow;
  record: LedgerRecord;
  gameKey: string;
  candidate: boolean;
}

function object(value: unknown): Record<string, any> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function round(value: number, digits = 8): number {
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

function quantile(values: number[], probability: number): number {
  if (!values.length) throw new Error("PREMIUM_NO_ULTRA_EMPTY_QUANTILE");
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectedRecommendationSurface(record: LedgerRecord): Record<string, unknown> {
  const prediction = record.prediction as unknown as Record<string, any>;
  const payload = object(prediction.payload);
  const analysis = object(payload?.analysis);
  const rawOutput = object(analysis?.rawOutput);
  const markets = object(rawOutput?.markets);
  return {
    decision: {
      confidenceLabel: prediction.decision?.confidenceLabel ?? payload?.decision?.confidenceLabel ?? null,
      rationale: prediction.decision?.rationale ?? payload?.decision?.rationale ?? null,
    },
    selectedLane: rawOutput?.selectedLane ?? null,
    finalRecommendation: markets?.finalRecommendation ?? rawOutput?.finalRecommendation ?? null,
  };
}

function containsToken(value: unknown, token: "PREMIUM" | "ULTRA"): boolean {
  const text = JSON.stringify(value).toUpperCase();
  return new RegExp(`(^|[^A-Z])${token}([^A-Z]|$)`).test(text);
}

export function selectedPremiumNoUltra(record: LedgerRecord): boolean {
  const surface = selectedRecommendationSurface(record);
  return containsToken(surface, "PREMIUM") && !containsToken(surface, "ULTRA");
}

function gameKey(row: MlbP1M3dReviewRow): string {
  if (Number.isInteger(row.gamePk) && (row.gamePk as number) > 0) return `PK:${row.gamePk}`;
  return `FALLBACK:${crypto.createHash("sha256")
    .update(`${row.gameDate}|${row.homeTeam}|${row.awayTeam}`)
    .digest("hex").slice(0, 20)}`;
}

function pregame(record: LedgerRecord): boolean {
  const recordedAt = timestamp(record.prediction.recordedAt);
  const commenceTime = timestamp(record.prediction.game.commenceTime);
  return recordedAt != null && commenceTime != null && recordedAt < commenceTime;
}

function eligibleRows(
  rows: MlbP1M3dReviewRow[],
  recordsByPredictionId: Map<string, LedgerRecord>,
): { eligible: EligibleDecision[]; afterCutoff: number; finalF5: number } {
  const cutoff = Date.parse(MLB_PREMIUM_NO_ULTRA_CUTOFF);
  let afterCutoff = 0;
  let finalF5 = 0;
  const eligible: EligibleDecision[] = [];
  for (const row of rows) {
    const recordedAt = timestamp(row.recordedAt);
    if (recordedAt == null || recordedAt <= cutoff) continue;
    afterCutoff += 1;
    if (row.market !== "F5_ML" || row.stage !== "FINAL") continue;
    finalF5 += 1;
    const record = recordsByPredictionId.get(row.predictionId);
    if (!record) throw new Error(`PREMIUM_NO_ULTRA_RECORD_MISSING:${row.predictionId}`);
    if (record.prediction.source !== "app") continue;
    if (!pregame(record)) continue;
    if (!validDate(row.gameDate)) continue;
    eligible.push({
      row,
      record,
      gameKey: gameKey(row),
      candidate: selectedPremiumNoUltra(record),
    });
  }
  return { eligible, afterCutoff, finalF5 };
}

function independentLatestPerGame(eligible: EligibleDecision[]): EligibleDecision[] {
  const latest = new Map<string, EligibleDecision>();
  for (const entry of eligible) {
    const existing = latest.get(entry.gameKey);
    if (!existing
      || entry.row.recordedAt > existing.row.recordedAt
      || (entry.row.recordedAt === existing.row.recordedAt
        && entry.row.predictionId > existing.row.predictionId)) {
      latest.set(entry.gameKey, entry);
    }
  }
  return [...latest.values()].sort((left, right) => left.row.gameDate.localeCompare(right.row.gameDate)
    || left.row.recordedAt.localeCompare(right.row.recordedAt)
    || left.row.predictionId.localeCompare(right.row.predictionId));
}

function scoreable(row: MlbP1M3dReviewRow): boolean {
  return (row.result === "WIN" || row.result === "LOSS")
    && Number.isFinite(row.modelProbability)
    && row.modelProbability > 0
    && row.modelProbability < 1
    && row.brierScore != null
    && Number.isFinite(row.brierScore)
    && row.brierScore >= 0
    && row.logLoss != null
    && Number.isFinite(row.logLoss)
    && row.logLoss >= 0;
}

function metrics(entries: EligibleDecision[]): MlbPremiumNoUltraMetricSummary {
  const settled = entries.filter((entry) => scoreable(entry.row));
  const wins = settled.filter((entry) => entry.row.result === "WIN").length;
  const losses = settled.filter((entry) => entry.row.result === "LOSS").length;
  const modelProbability = settled.map((entry) => entry.row.modelProbability);
  const observedWinRate = settled.length ? wins / settled.length : null;
  const meanModelProbability = average(modelProbability);
  const clv = settled
    .map((entry) => entry.row.clvPp)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const flatStakeProfitUnits = settled.reduce((sum, entry) => sum + entry.row.flatProfitUnits, 0);
  return {
    observations: entries.length,
    settled: settled.length,
    pending: entries.length - settled.length,
    dates: new Set(settled.map((entry) => entry.row.gameDate)).size,
    wins,
    losses,
    hitRatePct: settled.length ? round((wins / settled.length) * 100, 4) : null,
    meanModelProbability: meanModelProbability == null ? null : round(meanModelProbability),
    observedWinRate: observedWinRate == null ? null : round(observedWinRate),
    calibrationGap: observedWinRate == null || meanModelProbability == null
      ? null
      : round(Math.abs(meanModelProbability - observedWinRate)),
    flatStakeProfitUnits: round(flatStakeProfitUnits, 6),
    flatStakeRoiPct: settled.length ? round((flatStakeProfitUnits / settled.length) * 100, 4) : null,
    brierScore: settled.length ? round(average(settled.map((entry) => entry.row.brierScore as number)) as number) : null,
    logLoss: settled.length ? round(average(settled.map((entry) => entry.row.logLoss as number)) as number) : null,
    clvAvailable: clv.length,
    clvCoveragePct: settled.length ? round((clv.length / settled.length) * 100, 4) : null,
    meanClvPp: clv.length ? round(average(clv) as number, 6) : null,
    medianClvPp: clv.length ? round(median(clv) as number, 6) : null,
  };
}

function roi(entries: EligibleDecision[]): number | null {
  const settled = entries.filter((entry) => scoreable(entry.row));
  if (!settled.length) return null;
  return settled.reduce((sum, entry) => sum + entry.row.flatProfitUnits, 0) / settled.length;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function interval(
  pointEstimate: number,
  values: number[],
  replicatesRequested: number,
): MlbPremiumNoUltraBootstrapInterval | null {
  if (!values.length) return null;
  return {
    confidenceLevel: 0.95,
    replicatesRequested,
    replicatesUsed: values.length,
    pointEstimate: round(pointEstimate, 8),
    lower: round(quantile(values, 0.025), 8),
    upper: round(quantile(values, 0.975), 8),
  };
}

function bootstrapRoi(
  candidate: EligibleDecision[],
  control: EligibleDecision[],
  replicates: number,
): {
  dateClusters: number;
  candidateRoiPct: MlbPremiumNoUltraBootstrapInterval | null;
  candidateMinusControlRoiPp: MlbPremiumNoUltraBootstrapInterval | null;
} {
  const dates = [...new Set([...candidate, ...control]
    .filter((entry) => scoreable(entry.row))
    .map((entry) => entry.row.gameDate))].sort();
  if (dates.length < 2) {
    return { dateClusters: dates.length, candidateRoiPct: null, candidateMinusControlRoiPp: null };
  }
  const candidateByDate = new Map(dates.map((date) => [date, candidate.filter((entry) => entry.row.gameDate === date)]));
  const controlByDate = new Map(dates.map((date) => [date, control.filter((entry) => entry.row.gameDate === date)]));
  const random = createRng(0x50A1D0E5);
  const candidateValues: number[] = [];
  const differenceValues: number[] = [];
  for (let iteration = 0; iteration < replicates; iteration += 1) {
    const sampledCandidate: EligibleDecision[] = [];
    const sampledControl: EligibleDecision[] = [];
    for (let index = 0; index < dates.length; index += 1) {
      const sampledDate = dates[Math.floor(random() * dates.length)];
      sampledCandidate.push(...(candidateByDate.get(sampledDate) ?? []));
      sampledControl.push(...(controlByDate.get(sampledDate) ?? []));
    }
    const candidateRoi = roi(sampledCandidate);
    const controlRoi = roi(sampledControl);
    if (candidateRoi != null) candidateValues.push(candidateRoi * 100);
    if (candidateRoi != null && controlRoi != null) differenceValues.push((candidateRoi - controlRoi) * 100);
  }
  const pointCandidate = roi(candidate);
  const pointControl = roi(control);
  return {
    dateClusters: dates.length,
    candidateRoiPct: pointCandidate == null ? null : interval(pointCandidate * 100, candidateValues, replicates),
    candidateMinusControlRoiPp: pointCandidate == null || pointControl == null
      ? null
      : interval((pointCandidate - pointControl) * 100, differenceValues, replicates),
  };
}

export function buildMlbPremiumNoUltraProspective(
  rows: MlbP1M3dReviewRow[],
  records: LedgerRecord[],
  options: MlbPremiumNoUltraOptions = {},
): MlbPremiumNoUltraReport {
  const minimumCandidateSettled = options.minimumCandidateSettled ?? DEFAULTS.minimumCandidateSettled;
  const minimumCandidateDates = options.minimumCandidateDates ?? DEFAULTS.minimumCandidateDates;
  const minimumControlSettled = options.minimumControlSettled ?? DEFAULTS.minimumControlSettled;
  const minimumControlDates = options.minimumControlDates ?? DEFAULTS.minimumControlDates;
  const bootstrapReplicates = options.bootstrapReplicates ?? DEFAULTS.bootstrapReplicates;
  if (![minimumCandidateSettled, minimumCandidateDates, minimumControlSettled, minimumControlDates]
    .every((value) => Number.isInteger(value) && value > 0)
    || !Number.isInteger(bootstrapReplicates)
    || bootstrapReplicates < 500
    || bootstrapReplicates > 50_000) {
    throw new Error("PREMIUM_NO_ULTRA_INVALID_CONFIGURATION");
  }

  const recordsByPredictionId = new Map(records.map((record) => [record.prediction.id, record]));
  const filtered = eligibleRows(rows, recordsByPredictionId);
  const independent = independentLatestPerGame(filtered.eligible);
  const candidateEntries = independent.filter((entry) => entry.candidate);
  const controlEntries = independent.filter((entry) => !entry.candidate);
  const candidate = metrics(candidateEntries);
  const control = metrics(controlEntries);
  const minimumCandidateSampleAccepted = candidate.settled >= minimumCandidateSettled
    && candidate.dates >= minimumCandidateDates;
  const minimumControlSampleAccepted = control.settled >= minimumControlSettled
    && control.dates >= minimumControlDates;
  const enoughForInference = minimumCandidateSampleAccepted && minimumControlSampleAccepted;
  const inference = enoughForInference
    ? bootstrapRoi(candidateEntries, controlEntries, bootstrapReplicates)
    : { dateClusters: new Set([...candidateEntries, ...controlEntries]
      .filter((entry) => scoreable(entry.row)).map((entry) => entry.row.gameDate)).size,
      candidateRoiPct: null,
      candidateMinusControlRoiPp: null };
  const candidateRoiLower95Positive = (inference.candidateRoiPct?.lower ?? -Infinity) > 0;
  const candidateMinusControlRoiLower95Positive = (inference.candidateMinusControlRoiPp?.lower ?? -Infinity) > 0;
  const meanClvPositive = candidate.meanClvPp != null && candidate.meanClvPp > 0;
  const properScoringNotWorse = candidate.brierScore != null
    && control.brierScore != null
    && candidate.logLoss != null
    && control.logLoss != null
    && candidate.brierScore <= control.brierScore
    && candidate.logLoss <= control.logLoss;
  const calibrationAccepted = candidate.calibrationGap != null
    && control.calibrationGap != null
    && candidate.calibrationGap <= 0.05
    && candidate.calibrationGap <= control.calibrationGap + 0.01;
  const criteria = {
    minimumCandidateSampleAccepted,
    minimumControlSampleAccepted,
    candidateRoiLower95Positive,
    candidateMinusControlRoiLower95Positive,
    meanClvPositive,
    properScoringNotWorse,
    calibrationAccepted,
    allAccepted: false,
  };
  criteria.allAccepted = Object.entries(criteria)
    .filter(([key]) => key !== "allAccepted")
    .every(([, value]) => value === true);

  const collecting = !minimumCandidateSampleAccepted || !minimumControlSampleAccepted;
  const state: MlbPremiumNoUltraState = criteria.allAccepted
    ? "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY"
    : collecting
      ? "COLLECTING_PROSPECTIVE_EVIDENCE"
      : "CANDIDATE_NOT_CONFIRMED";
  const blockers = criteria.allAccepted ? [
    "PREMIUM_NO_ULTRA_RESEARCH_SUPPORT_ONLY",
    "PREMIUM_NO_ULTRA_OPERATIONAL_MONEY_GATE_NOT_ACTIVATED",
  ] : [
    !minimumCandidateSampleAccepted ? "PREMIUM_NO_ULTRA_CANDIDATE_SAMPLE_INSUFFICIENT" : null,
    !minimumControlSampleAccepted ? "PREMIUM_NO_ULTRA_CONTROL_SAMPLE_INSUFFICIENT" : null,
    enoughForInference && !candidateRoiLower95Positive ? "PREMIUM_NO_ULTRA_ROI_NOT_CONFIRMED_POSITIVE" : null,
    enoughForInference && !candidateMinusControlRoiLower95Positive ? "PREMIUM_NO_ULTRA_INCREMENTAL_ROI_NOT_CONFIRMED" : null,
    enoughForInference && !meanClvPositive ? "PREMIUM_NO_ULTRA_MEAN_CLV_NOT_POSITIVE" : null,
    enoughForInference && !properScoringNotWorse ? "PREMIUM_NO_ULTRA_PROPER_SCORING_WORSE_THAN_CONTROL" : null,
    enoughForInference && !calibrationAccepted ? "PREMIUM_NO_ULTRA_CALIBRATION_NOT_ACCEPTED" : null,
  ].filter((value): value is string => value != null);

  return {
    schemaVersion: MLB_PREMIUM_NO_ULTRA_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    state,
    hypothesis: {
      alternative: "Future FINAL F5_ML terminal decisions whose selected recommendation is PREMIUM and not ULTRA have a positive and repeatable economic edge versus contemporaneous eligible non-candidate decisions.",
      null: "The post-hoc PREMIUM-without-ULTRA pattern does not survive genuinely prospective independent game-level confirmation.",
    },
    preregistration: {
      cutoff: MLB_PREMIUM_NO_ULTRA_CUTOFF,
      cutoffEvidenceCommit: MLB_PREMIUM_NO_ULTRA_CUTOFF_COMMIT,
      market: "F5_ML",
      requiredStage: "FINAL",
      requiredSource: "app",
      candidateRule: "SELECTED_PREMIUM_AND_NOT_SELECTED_ULTRA",
      oneTerminalDecisionPerGame: true,
      alternativePicksExcluded: true,
      outcomeForbiddenFromMembership: true,
      minimumCandidateSettled,
      minimumCandidateDates,
      minimumControlSettled,
      minimumControlDates,
      bootstrapReplicates,
      maximumCalibrationGap: 0.05,
      maximumCalibrationDisadvantageVsControl: 0.01,
    },
    cohort: {
      inputReviewRows: rows.length,
      afterCutoff: filtered.afterCutoff,
      eligibleFinalF5Rows: filtered.finalF5,
      independentGames: independent.length,
      duplicateGameRowsExcluded: filtered.eligible.length - independent.length,
      candidateGames: candidateEntries.length,
      controlGames: controlEntries.length,
      candidateSettled: candidate.settled,
      controlSettled: control.settled,
      candidateDates: candidate.dates,
      controlDates: control.dates,
    },
    candidate,
    control,
    inference,
    criteria,
    blockers,
    interpretation: {
      prospectiveOnly: true,
      independentGameUnit: true,
      historicalThirteenAndFourIncludedInConfirmation: false,
      oldUltraMoneyGateRestored: false,
      economicProfitabilitySupported: criteria.allAccepted,
      operationalMoneyGateAllowed: false,
      stakeChangesAllowed: false,
      automaticBettingAllowed: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
