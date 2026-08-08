import crypto from "node:crypto";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3eCandidateRules,
  matchesMlbP1M3eRule,
  summarizeMlbP1M3eRows,
  type MlbP1M3eComparison,
  type MlbP1M3eMetricSummary,
  type MlbP1M3eRule,
} from "./mlb-p1-operating-envelope";

export const MLB_P1_M3E2_SCHEMA = "courtedge-p1-m3e2-operating-envelope-stability.v1" as const;

export type MlbP1M3e2State =
  | "INSUFFICIENT_SAMPLE"
  | "NO_DISCOVERY_RULE"
  | "VALIDATION_FAILED"
  | "CONFIRMATION_FAILED"
  | "STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY";

export interface MlbP1M3e2BootstrapInterval {
  confidenceLevel: 0.95;
  replicatesRequested: number;
  replicatesUsed: number;
  pointEstimate: number;
  lower: number;
  upper: number;
}

export interface MlbP1M3e2HoldoutInference {
  comparison: MlbP1M3eComparison;
  logLossImprovement: MlbP1M3e2BootstrapInterval | null;
  brierImprovement: MlbP1M3e2BootstrapInterval | null;
  criteria: {
    minimumSamplesAccepted: boolean;
    minimumSelectedDatesAccepted: boolean;
    coverageAccepted: boolean;
    logLossLower95Positive: boolean;
    brierLower95Positive: boolean;
    calibrationAccepted: boolean;
    allAccepted: boolean;
  };
}

export interface MlbP1M3e2Report {
  schemaVersion: typeof MLB_P1_M3E2_SCHEMA;
  generatedAt: string;
  state: MlbP1M3e2State;
  hypothesis: {
    alternative: "A bounded pregame-identifiable operating-envelope rule discovered only on earlier dates retains better model quality through two untouched later chronological holdouts.";
    null: "An apparent operating-envelope rule is unstable, sample-dependent, or fails later untouched validation or confirmation.";
  };
  configuration: {
    discoveryDateFraction: 0.5;
    validationDateFraction: 0.25;
    confirmationDateFraction: 0.25;
    minimumTotalObservations: number;
    minimumTotalDates: number;
    minimumDiscoverySelected: number;
    minimumDiscoveryRejected: number;
    minimumHoldoutSelected: number;
    minimumHoldoutRejected: number;
    minimumHoldoutSelectedDates: number;
    minimumHoldoutCoveragePct: number;
    maximumHoldoutCoveragePct: number;
    maximumCalibrationGap: 0.05;
    maximumCalibrationDisadvantageVsRejected: 0.01;
    maximumRuleAtoms: 2;
    bootstrapReplicates: number;
    candidateRuleCount: number;
  };
  cohort: {
    inputRows: number;
    scoreableRows: number;
    excludedRows: number;
    uniqueDates: number;
  };
  temporalSplit: {
    leakageFree: boolean;
    discovery: { minDate: string | null; maxDate: string | null; rows: number; dates: number };
    validation: { minDate: string | null; maxDate: string | null; rows: number; dates: number };
    confirmation: { minDate: string | null; maxDate: string | null; rows: number; dates: number };
  };
  selectedRule: MlbP1M3eRule | null;
  discovery: MlbP1M3eComparison | null;
  validation: MlbP1M3e2HoldoutInference | null;
  confirmation: MlbP1M3e2HoldoutInference | null;
  economicsDiagnostics: {
    promotionCriterion: false;
    validationSelectedFlatRoiPct: number | null;
    validationSelectedMeanClvPp: number | null;
    confirmationSelectedFlatRoiPct: number | null;
    confirmationSelectedMeanClvPp: number | null;
  };
  interpretation: {
    stableModelQualityEnvelopeSupported: boolean;
    economicProfitabilityCertified: false;
    operationalRecommendationGateAllowed: false;
    bettingRecommendationAllowed: false;
    stakeChangesAllowed: false;
    automaticBettingAllowed: false;
    modelProbabilityChanged: false;
    existingEconomicThresholdsChanged: false;
    premiumNoUltraProspectiveHypothesisChanged: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
  blockers: string[];
}

export interface MlbP1M3e2Options {
  minimumTotalObservations?: number;
  minimumTotalDates?: number;
  minimumDiscoverySelected?: number;
  minimumDiscoveryRejected?: number;
  minimumHoldoutSelected?: number;
  minimumHoldoutRejected?: number;
  minimumHoldoutSelectedDates?: number;
  minimumHoldoutCoveragePct?: number;
  maximumHoldoutCoveragePct?: number;
  bootstrapReplicates?: number;
  generatedAt?: string;
}

const DEFAULTS = {
  minimumTotalObservations: 120,
  minimumTotalDates: 36,
  minimumDiscoverySelected: 24,
  minimumDiscoveryRejected: 24,
  minimumHoldoutSelected: 12,
  minimumHoldoutRejected: 12,
  minimumHoldoutSelectedDates: 6,
  minimumHoldoutCoveragePct: 10,
  maximumHoldoutCoveragePct: 70,
  bootstrapReplicates: 5000,
} as const;

const MAXIMUM_CALIBRATION_GAP = 0.05 as const;
const MAXIMUM_CALIBRATION_DISADVANTAGE = 0.01 as const;

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values: number[], probability: number): number {
  if (!values.length) throw new Error("P1_M3E2_EMPTY_QUANTILE");
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const weight = index - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function scoreable(row: MlbP1M3dReviewRow): boolean {
  return validDate(row.gameDate)
    && (row.result === "WIN" || row.result === "LOSS")
    && Number.isFinite(row.modelProbability)
    && row.modelProbability > 0
    && row.modelProbability < 1
    && row.logLoss != null
    && Number.isFinite(row.logLoss)
    && row.logLoss >= 0
    && row.brierScore != null
    && Number.isFinite(row.brierScore)
    && row.brierScore >= 0;
}

function scoreableRows(rows: MlbP1M3dReviewRow[]): MlbP1M3dReviewRow[] {
  const seen = new Set<string>();
  const eligible: MlbP1M3dReviewRow[] = [];
  for (const row of rows) {
    if (!scoreable(row)) continue;
    if (seen.has(row.predictionId)) throw new Error(`P1_M3E2_DUPLICATE_PREDICTION_ID:${row.predictionId}`);
    seen.add(row.predictionId);
    eligible.push(row);
  }
  return eligible.sort((a, b) => a.gameDate.localeCompare(b.gameDate)
    || a.recordedAt.localeCompare(b.recordedAt)
    || a.predictionId.localeCompare(b.predictionId));
}

export function matchesMlbP1M3e2Rule(row: MlbP1M3dReviewRow, rule: MlbP1M3eRule): boolean {
  return matchesMlbP1M3eRule(row, rule);
}

function comparison(rows: MlbP1M3dReviewRow[], rule: MlbP1M3eRule): MlbP1M3eComparison {
  const selected = rows.filter((row) => matchesMlbP1M3e2Rule(row, rule));
  const rejected = rows.filter((row) => !matchesMlbP1M3e2Rule(row, rule));
  const selectedSummary = summarizeMlbP1M3eRows(selected);
  const rejectedSummary = summarizeMlbP1M3eRows(rejected);
  return {
    selected: selectedSummary,
    rejected: rejectedSummary,
    coveragePct: rows.length ? round((selected.length / rows.length) * 100, 4) : 0,
    rejectedCoveragePct: rows.length ? round((rejected.length / rows.length) * 100, 4) : 0,
    rejectedMinusSelectedLogLoss: selectedSummary.meanLogLoss != null && rejectedSummary.meanLogLoss != null
      ? round(rejectedSummary.meanLogLoss - selectedSummary.meanLogLoss)
      : null,
    rejectedMinusSelectedBrier: selectedSummary.meanBrierScore != null && rejectedSummary.meanBrierScore != null
      ? round(rejectedSummary.meanBrierScore - selectedSummary.meanBrierScore)
      : null,
  };
}

function discoveryScore(value: MlbP1M3eComparison, complexity: number): number | null {
  if (value.rejectedMinusSelectedLogLoss == null || value.rejectedMinusSelectedBrier == null) return null;
  if (value.rejectedMinusSelectedLogLoss <= 0 || value.rejectedMinusSelectedBrier <= 0) return null;
  if (value.coveragePct < 10 || value.coveragePct > 70) return null;
  const selectedCalibration = value.selected.calibrationGap;
  const rejectedCalibration = value.rejected.calibrationGap;
  if (selectedCalibration == null || rejectedCalibration == null) return null;
  if (selectedCalibration > MAXIMUM_CALIBRATION_GAP) return null;
  if (selectedCalibration > rejectedCalibration + MAXIMUM_CALIBRATION_DISADVANTAGE) return null;
  const complexityPenalty = complexity === 2 ? 0.0005 : 0;
  return value.rejectedMinusSelectedLogLoss + 0.5 * value.rejectedMinusSelectedBrier - complexityPenalty;
}

function splitDates(rows: MlbP1M3dReviewRow[]): {
  discovery: MlbP1M3dReviewRow[];
  validation: MlbP1M3dReviewRow[];
  confirmation: MlbP1M3dReviewRow[];
  discoveryDates: string[];
  validationDates: string[];
  confirmationDates: string[];
} {
  const dates = [...new Set(rows.map((row) => row.gameDate))].sort();
  const discoveryCount = Math.floor(dates.length * 0.5);
  const validationCount = Math.floor(dates.length * 0.25);
  const discoveryDates = dates.slice(0, discoveryCount);
  const validationDates = dates.slice(discoveryCount, discoveryCount + validationCount);
  const confirmationDates = dates.slice(discoveryCount + validationCount);
  const discoverySet = new Set(discoveryDates);
  const validationSet = new Set(validationDates);
  const confirmationSet = new Set(confirmationDates);
  return {
    discovery: rows.filter((row) => discoverySet.has(row.gameDate)),
    validation: rows.filter((row) => validationSet.has(row.gameDate)),
    confirmation: rows.filter((row) => confirmationSet.has(row.gameDate)),
    discoveryDates,
    validationDates,
    confirmationDates,
  };
}

function seededRandom(seedText: string): () => number {
  const seedHex = crypto.createHash("sha256").update(seedText).digest("hex").slice(0, 8);
  let state = Number.parseInt(seedHex, 16) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function bootstrapImprovement(
  rows: MlbP1M3dReviewRow[],
  rule: MlbP1M3eRule,
  metric: "logLoss" | "brierScore",
  replicates: number,
): MlbP1M3e2BootstrapInterval | null {
  const dates = [...new Set(rows.map((row) => row.gameDate))].sort();
  if (dates.length < 2) return null;
  const byDate = new Map<string, MlbP1M3dReviewRow[]>();
  for (const date of dates) byDate.set(date, rows.filter((row) => row.gameDate === date));
  const base = comparison(rows, rule);
  const pointEstimate = metric === "logLoss"
    ? base.rejectedMinusSelectedLogLoss
    : base.rejectedMinusSelectedBrier;
  if (pointEstimate == null) return null;

  const random = seededRandom(`${MLB_P1_M3E2_SCHEMA}:${rule.ruleKey}:${metric}:${dates[0]}:${dates.at(-1)}:${replicates}`);
  const values: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const selected: number[] = [];
    const rejected: number[] = [];
    for (let draw = 0; draw < dates.length; draw += 1) {
      const sampledDate = dates[Math.floor(random() * dates.length)];
      for (const row of byDate.get(sampledDate) ?? []) {
        const value = metric === "logLoss" ? row.logLoss as number : row.brierScore as number;
        if (matchesMlbP1M3e2Rule(row, rule)) selected.push(value);
        else rejected.push(value);
      }
    }
    if (!selected.length || !rejected.length) continue;
    const improvement = (average(rejected) as number) - (average(selected) as number);
    if (Number.isFinite(improvement)) values.push(improvement);
  }
  if (values.length < Math.max(400, Math.floor(replicates * 0.8))) return null;
  return {
    confidenceLevel: 0.95,
    replicatesRequested: replicates,
    replicatesUsed: values.length,
    pointEstimate: round(pointEstimate),
    lower: round(quantile(values, 0.025)),
    upper: round(quantile(values, 0.975)),
  };
}

function holdoutInference(
  rows: MlbP1M3dReviewRow[],
  rule: MlbP1M3eRule,
  options: Required<Pick<MlbP1M3e2Options,
    "minimumHoldoutSelected" | "minimumHoldoutRejected" | "minimumHoldoutSelectedDates"
    | "minimumHoldoutCoveragePct" | "maximumHoldoutCoveragePct" | "bootstrapReplicates">>,
): MlbP1M3e2HoldoutInference {
  const value = comparison(rows, rule);
  const logLossImprovement = bootstrapImprovement(rows, rule, "logLoss", options.bootstrapReplicates);
  const brierImprovement = bootstrapImprovement(rows, rule, "brierScore", options.bootstrapReplicates);
  const minimumSamplesAccepted = value.selected.observations >= options.minimumHoldoutSelected
    && value.rejected.observations >= options.minimumHoldoutRejected;
  const minimumSelectedDatesAccepted = value.selected.dates >= options.minimumHoldoutSelectedDates;
  const coverageAccepted = value.coveragePct >= options.minimumHoldoutCoveragePct
    && value.coveragePct <= options.maximumHoldoutCoveragePct;
  const logLossLower95Positive = (logLossImprovement?.lower ?? Number.NEGATIVE_INFINITY) > 0;
  const brierLower95Positive = (brierImprovement?.lower ?? Number.NEGATIVE_INFINITY) > 0;
  const selectedCalibration = value.selected.calibrationGap;
  const rejectedCalibration = value.rejected.calibrationGap;
  const calibrationAccepted = selectedCalibration != null
    && rejectedCalibration != null
    && selectedCalibration <= MAXIMUM_CALIBRATION_GAP
    && selectedCalibration <= rejectedCalibration + MAXIMUM_CALIBRATION_DISADVANTAGE;
  return {
    comparison: value,
    logLossImprovement,
    brierImprovement,
    criteria: {
      minimumSamplesAccepted,
      minimumSelectedDatesAccepted,
      coverageAccepted,
      logLossLower95Positive,
      brierLower95Positive,
      calibrationAccepted,
      allAccepted: minimumSamplesAccepted
        && minimumSelectedDatesAccepted
        && coverageAccepted
        && logLossLower95Positive
        && brierLower95Positive
        && calibrationAccepted,
    },
  };
}

function dateSummary(rows: MlbP1M3dReviewRow[], dates: string[]) {
  return {
    minDate: dates[0] ?? null,
    maxDate: dates.at(-1) ?? null,
    rows: rows.length,
    dates: dates.length,
  };
}

function emptyEconomics(): MlbP1M3e2Report["economicsDiagnostics"] {
  return {
    promotionCriterion: false,
    validationSelectedFlatRoiPct: null,
    validationSelectedMeanClvPp: null,
    confirmationSelectedFlatRoiPct: null,
    confirmationSelectedMeanClvPp: null,
  };
}

function safeInterpretation(supported: boolean): MlbP1M3e2Report["interpretation"] {
  return {
    stableModelQualityEnvelopeSupported: supported,
    economicProfitabilityCertified: false,
    operationalRecommendationGateAllowed: false,
    bettingRecommendationAllowed: false,
    stakeChangesAllowed: false,
    automaticBettingAllowed: false,
    modelProbabilityChanged: false,
    existingEconomicThresholdsChanged: false,
    premiumNoUltraProspectiveHypothesisChanged: false,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
  };
}

function blockers(prefix: "VALIDATION" | "CONFIRMATION", inference: MlbP1M3e2HoldoutInference): string[] {
  const out: string[] = [];
  if (!inference.criteria.minimumSamplesAccepted) out.push(`P1_M3E2_${prefix}_MINIMUM_SAMPLES_NOT_REACHED`);
  if (!inference.criteria.minimumSelectedDatesAccepted) out.push(`P1_M3E2_${prefix}_MINIMUM_SELECTED_DATES_NOT_REACHED`);
  if (!inference.criteria.coverageAccepted) out.push(`P1_M3E2_${prefix}_COVERAGE_NOT_ACCEPTED`);
  if (!inference.criteria.logLossLower95Positive) out.push(`P1_M3E2_${prefix}_LOG_LOSS_NOT_CONFIRMED`);
  if (!inference.criteria.brierLower95Positive) out.push(`P1_M3E2_${prefix}_BRIER_NOT_CONFIRMED`);
  if (!inference.criteria.calibrationAccepted) out.push(`P1_M3E2_${prefix}_CALIBRATION_NOT_ACCEPTED`);
  return out;
}

export function buildMlbP1M3e2OperatingEnvelopeStability(
  inputRows: MlbP1M3dReviewRow[],
  options: MlbP1M3e2Options = {},
): MlbP1M3e2Report {
  const config = {
    minimumTotalObservations: options.minimumTotalObservations ?? DEFAULTS.minimumTotalObservations,
    minimumTotalDates: options.minimumTotalDates ?? DEFAULTS.minimumTotalDates,
    minimumDiscoverySelected: options.minimumDiscoverySelected ?? DEFAULTS.minimumDiscoverySelected,
    minimumDiscoveryRejected: options.minimumDiscoveryRejected ?? DEFAULTS.minimumDiscoveryRejected,
    minimumHoldoutSelected: options.minimumHoldoutSelected ?? DEFAULTS.minimumHoldoutSelected,
    minimumHoldoutRejected: options.minimumHoldoutRejected ?? DEFAULTS.minimumHoldoutRejected,
    minimumHoldoutSelectedDates: options.minimumHoldoutSelectedDates ?? DEFAULTS.minimumHoldoutSelectedDates,
    minimumHoldoutCoveragePct: options.minimumHoldoutCoveragePct ?? DEFAULTS.minimumHoldoutCoveragePct,
    maximumHoldoutCoveragePct: options.maximumHoldoutCoveragePct ?? DEFAULTS.maximumHoldoutCoveragePct,
    bootstrapReplicates: options.bootstrapReplicates ?? DEFAULTS.bootstrapReplicates,
  };
  const positiveIntegers = [config.minimumTotalObservations, config.minimumTotalDates,
    config.minimumDiscoverySelected, config.minimumDiscoveryRejected, config.minimumHoldoutSelected,
    config.minimumHoldoutRejected, config.minimumHoldoutSelectedDates, config.bootstrapReplicates];
  if (!positiveIntegers.every((value) => Number.isInteger(value) && value > 0)
    || config.bootstrapReplicates < 500 || config.bootstrapReplicates > 50_000
    || !(config.minimumHoldoutCoveragePct > 0
      && config.maximumHoldoutCoveragePct < 100
      && config.minimumHoldoutCoveragePct < config.maximumHoldoutCoveragePct)) {
    throw new Error("P1_M3E2_INVALID_CONFIGURATION");
  }

  const candidateRules = buildMlbP1M3eCandidateRules();
  const configuration: MlbP1M3e2Report["configuration"] = {
    discoveryDateFraction: 0.5,
    validationDateFraction: 0.25,
    confirmationDateFraction: 0.25,
    ...config,
    maximumCalibrationGap: MAXIMUM_CALIBRATION_GAP,
    maximumCalibrationDisadvantageVsRejected: MAXIMUM_CALIBRATION_DISADVANTAGE,
    maximumRuleAtoms: 2,
    candidateRuleCount: candidateRules.length,
  };
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const eligible = scoreableRows(inputRows);
  const uniqueDates = [...new Set(eligible.map((row) => row.gameDate))].sort();
  const base = {
    schemaVersion: MLB_P1_M3E2_SCHEMA,
    generatedAt,
    hypothesis: {
      alternative: "A bounded pregame-identifiable operating-envelope rule discovered only on earlier dates retains better model quality through two untouched later chronological holdouts." as const,
      null: "An apparent operating-envelope rule is unstable, sample-dependent, or fails later untouched validation or confirmation." as const,
    },
    configuration,
    cohort: {
      inputRows: inputRows.length,
      scoreableRows: eligible.length,
      excludedRows: inputRows.length - eligible.length,
      uniqueDates: uniqueDates.length,
    },
  };

  if (eligible.length < config.minimumTotalObservations || uniqueDates.length < config.minimumTotalDates) {
    return {
      ...base,
      state: "INSUFFICIENT_SAMPLE",
      temporalSplit: {
        leakageFree: true,
        discovery: dateSummary([], []),
        validation: dateSummary([], []),
        confirmation: dateSummary([], []),
      },
      selectedRule: null,
      discovery: null,
      validation: null,
      confirmation: null,
      economicsDiagnostics: emptyEconomics(),
      interpretation: safeInterpretation(false),
      blockers: [eligible.length < config.minimumTotalObservations
        ? "P1_M3E2_MINIMUM_TOTAL_OBSERVATIONS_NOT_REACHED"
        : "P1_M3E2_MINIMUM_TOTAL_DATES_NOT_REACHED"],
    };
  }

  const split = splitDates(eligible);
  const discoveryMax = split.discoveryDates.at(-1) as string;
  const validationMin = split.validationDates[0];
  const validationMax = split.validationDates.at(-1) as string;
  const confirmationMin = split.confirmationDates[0];
  const leakageFree = discoveryMax < validationMin && validationMax < confirmationMin;
  if (!leakageFree) throw new Error("P1_M3E2_TIME_LEAKAGE_DETECTED");

  let winner: { rule: MlbP1M3eRule; value: MlbP1M3eComparison; score: number } | null = null;
  for (const rule of candidateRules) {
    const value = comparison(split.discovery, rule);
    if (value.selected.observations < config.minimumDiscoverySelected
      || value.rejected.observations < config.minimumDiscoveryRejected) continue;
    const score = discoveryScore(value, rule.atoms.length);
    if (score == null) continue;
    if (!winner
      || score > winner.score
      || (score === winner.score && rule.atoms.length < winner.rule.atoms.length)
      || (score === winner.score && rule.atoms.length === winner.rule.atoms.length
        && rule.ruleKey < winner.rule.ruleKey)) {
      winner = { rule, value, score };
    }
  }

  const temporalSplit = {
    leakageFree,
    discovery: dateSummary(split.discovery, split.discoveryDates),
    validation: dateSummary(split.validation, split.validationDates),
    confirmation: dateSummary(split.confirmation, split.confirmationDates),
  };

  if (!winner) {
    return {
      ...base,
      state: "NO_DISCOVERY_RULE",
      temporalSplit,
      selectedRule: null,
      discovery: null,
      validation: null,
      confirmation: null,
      economicsDiagnostics: emptyEconomics(),
      interpretation: safeInterpretation(false),
      blockers: ["P1_M3E2_NO_DISCOVERY_RULE_MET_PRE_REGISTERED_CRITERIA"],
    };
  }

  const holdoutOptions = {
    minimumHoldoutSelected: config.minimumHoldoutSelected,
    minimumHoldoutRejected: config.minimumHoldoutRejected,
    minimumHoldoutSelectedDates: config.minimumHoldoutSelectedDates,
    minimumHoldoutCoveragePct: config.minimumHoldoutCoveragePct,
    maximumHoldoutCoveragePct: config.maximumHoldoutCoveragePct,
    bootstrapReplicates: config.bootstrapReplicates,
  };
  const validation = holdoutInference(split.validation, winner.rule, holdoutOptions);
  const confirmation = holdoutInference(split.confirmation, winner.rule, holdoutOptions);
  const supported = validation.criteria.allAccepted && confirmation.criteria.allAccepted;
  const state: MlbP1M3e2State = !validation.criteria.allAccepted
    ? "VALIDATION_FAILED"
    : !confirmation.criteria.allAccepted
      ? "CONFIRMATION_FAILED"
      : "STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY";
  const validationSelected: MlbP1M3eMetricSummary = validation.comparison.selected;
  const confirmationSelected: MlbP1M3eMetricSummary = confirmation.comparison.selected;
  return {
    ...base,
    state,
    temporalSplit,
    selectedRule: winner.rule,
    discovery: winner.value,
    validation,
    confirmation,
    economicsDiagnostics: {
      promotionCriterion: false,
      validationSelectedFlatRoiPct: validationSelected.flatStakeRoiPct,
      validationSelectedMeanClvPp: validationSelected.meanClvPp,
      confirmationSelectedFlatRoiPct: confirmationSelected.flatStakeRoiPct,
      confirmationSelectedMeanClvPp: confirmationSelected.meanClvPp,
    },
    interpretation: safeInterpretation(supported),
    blockers: [
      ...blockers("VALIDATION", validation),
      ...blockers("CONFIRMATION", confirmation),
    ],
  };
}
