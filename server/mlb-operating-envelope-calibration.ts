export const MLB_OPERATING_ENVELOPE_CALIBRATION_SCHEMA = "courtedge-p0-mlb-operating-envelope-calibration.v1" as const;

export const MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_OBSERVATIONS = 80;
export const MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_DATES = 30;

export type MlbCalibrationMarket = "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL";
export type MlbCalibrationOutcome = "WIN" | "LOSS" | "PUSH";
export type MlbCalibrationReferenceAgreement = "SUPPORTS_MODEL_EDGE" | "OPPOSES_MODEL_EDGE" | "NEUTRAL" | "UNAVAILABLE";

export interface MlbOperatingEnvelopeCalibrationObservation {
  predictionId: string;
  gameDate: string;
  gamePk: number;
  marketType: MlbCalibrationMarket;
  expectedValuePerUnit: number;
  executionNoVigEdgePp: number;
  modelWinProbability: number;
  referenceAgreement: MlbCalibrationReferenceAgreement;
  outcome: MlbCalibrationOutcome;
  realizedProfitUnits: number;
}

export type MlbOperatingEnvelopeCalibrationAtom =
  | { kind: "MIN_EXPECTED_VALUE"; value: number }
  | { kind: "MIN_NO_VIG_EDGE_PP"; value: number }
  | { kind: "MARKET_IS"; value: MlbCalibrationMarket }
  | { kind: "REFERENCE_IS"; value: MlbCalibrationReferenceAgreement };

export interface MlbOperatingEnvelopeCalibrationRule {
  ruleKey: string;
  atoms: readonly MlbOperatingEnvelopeCalibrationAtom[];
}

export interface MlbOperatingEnvelopeCalibrationMetrics {
  observations: number;
  dates: number;
  wins: number;
  losses: number;
  pushes: number;
  decisiveWinRate: number | null;
  meanModelWinProbability: number | null;
  calibrationGap: number | null;
  meanBrierScore: number | null;
  meanLogLoss: number | null;
  flatStakeRoiPct: number | null;
  retentionPctOfBaselineCandidates: number;
  activeDateCoveragePct: number;
  noPickDates: number;
  noPickDatePct: number;
  averagePicksPerActiveDate: number;
}

export interface MlbOperatingEnvelopeCalibrationRuleResult {
  rule: MlbOperatingEnvelopeCalibrationRule;
  metrics: MlbOperatingEnvelopeCalibrationMetrics;
}

export interface MlbOperatingEnvelopeCalibrationReport {
  schemaVersion: typeof MLB_OPERATING_ENVELOPE_CALIBRATION_SCHEMA;
  state: "INSUFFICIENT_SAMPLE" | "RESEARCH_METRICS_READY";
  cohort: {
    observations: number;
    dates: number;
    minimumObservations: typeof MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_OBSERVATIONS;
    minimumDates: typeof MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_DATES;
  };
  baseline: MlbOperatingEnvelopeCalibrationMetrics;
  rules: readonly MlbOperatingEnvelopeCalibrationRuleResult[];
  blockers: readonly string[];
  policy: {
    currentStep11aCandidatesAreBaselinePopulation: true;
    qualityAndPickVolumeMeasuredTogether: true;
    selectionRetentionAlwaysReported: true;
    noPickDateRateAlwaysReported: true;
    minimumSampleRequirementsAreResearchOnly: true;
    minimumSampleRequirementsAreLivePickFilters: false;
    ruleThresholdsHardCodedByRuntime: false;
    automaticBestRuleSelection: false;
    pointEstimateCanPromoteBetElite: false;
    historicalP1M3eMinimumsPreserved: true;
    liveOperatingEnvelopeChanged: false;
    betEliteLabelProduced: false;
    stakeCalculated: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validateSettlement(row: MlbOperatingEnvelopeCalibrationObservation): void {
  if (row.outcome !== "WIN" && row.outcome !== "LOSS" && row.outcome !== "PUSH") {
    throw new Error("MLB_OPERATING_ENVELOPE_CALIBRATION_OUTCOME_INVALID");
  }
  if (row.outcome === "PUSH" && row.realizedProfitUnits !== 0) {
    throw new Error("MLB_OPERATING_ENVELOPE_CALIBRATION_SETTLEMENT_PROFIT_INVALID");
  }
  if (row.outcome === "LOSS" && row.realizedProfitUnits !== -1) {
    throw new Error("MLB_OPERATING_ENVELOPE_CALIBRATION_SETTLEMENT_PROFIT_INVALID");
  }
  if (row.outcome === "WIN" && (!Number.isFinite(row.realizedProfitUnits) || row.realizedProfitUnits <= 0)) {
    throw new Error("MLB_OPERATING_ENVELOPE_CALIBRATION_SETTLEMENT_PROFIT_INVALID");
  }
}

function validateObservation(row: MlbOperatingEnvelopeCalibrationObservation): void {
  if (!row.predictionId || !validDate(row.gameDate) || !Number.isInteger(row.gamePk) || row.gamePk <= 0) {
    throw new Error("MLB_OPERATING_ENVELOPE_CALIBRATION_IDENTITY_INVALID");
  }
  if (!Number.isFinite(row.expectedValuePerUnit) || !Number.isFinite(row.executionNoVigEdgePp)
    || !Number.isFinite(row.modelWinProbability) || row.modelWinProbability <= 0 || row.modelWinProbability >= 1
    || !Number.isFinite(row.realizedProfitUnits)) {
    throw new Error("MLB_OPERATING_ENVELOPE_CALIBRATION_NUMERIC_INPUT_INVALID");
  }
  validateSettlement(row);
}

function matchesAtom(row: MlbOperatingEnvelopeCalibrationObservation, atom: MlbOperatingEnvelopeCalibrationAtom): boolean {
  if (atom.kind === "MIN_EXPECTED_VALUE") return Number.isFinite(atom.value) && row.expectedValuePerUnit >= atom.value;
  if (atom.kind === "MIN_NO_VIG_EDGE_PP") return Number.isFinite(atom.value) && row.executionNoVigEdgePp >= atom.value;
  if (atom.kind === "MARKET_IS") return row.marketType === atom.value;
  return row.referenceAgreement === atom.value;
}

export function matchesMlbOperatingEnvelopeCalibrationRule(
  row: MlbOperatingEnvelopeCalibrationObservation,
  rule: MlbOperatingEnvelopeCalibrationRule,
): boolean {
  if (!rule.ruleKey || rule.atoms.length === 0 || rule.atoms.length > 2) {
    throw new Error("MLB_OPERATING_ENVELOPE_CALIBRATION_RULE_COMPLEXITY_INVALID");
  }
  return rule.atoms.every((atom) => matchesAtom(row, atom));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function metrics(
  selected: readonly MlbOperatingEnvelopeCalibrationObservation[],
  baseline: readonly MlbOperatingEnvelopeCalibrationObservation[],
): MlbOperatingEnvelopeCalibrationMetrics {
  const baselineDates = [...new Set(baseline.map((row) => row.gameDate))];
  const selectedDates = new Set(selected.map((row) => row.gameDate));
  const wins = selected.filter((row) => row.outcome === "WIN").length;
  const losses = selected.filter((row) => row.outcome === "LOSS").length;
  const pushes = selected.filter((row) => row.outcome === "PUSH").length;
  const decisiveRows = selected.filter((row) => row.outcome === "WIN" || row.outcome === "LOSS");
  const decisive = decisiveRows.length;
  const decisiveWinRate = decisive > 0 ? wins / decisive : null;
  const meanModelWinProbability = mean(decisiveRows.map((row) => row.modelWinProbability));
  const brier = decisiveRows.map((row) => {
    const y = row.outcome === "WIN" ? 1 : 0;
    return (row.modelWinProbability - y) ** 2;
  });
  const logLoss = decisiveRows.map((row) => {
    const y = row.outcome === "WIN" ? 1 : 0;
    const p = Math.min(1 - 1e-12, Math.max(1e-12, row.modelWinProbability));
    return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  });
  const noPickDates = Math.max(0, baselineDates.length - selectedDates.size);
  const retentionPct = baseline.length > 0 ? (selected.length / baseline.length) * 100 : 0;
  const activeDateCoveragePct = baselineDates.length > 0 ? (selectedDates.size / baselineDates.length) * 100 : 0;
  return {
    observations: selected.length,
    dates: selectedDates.size,
    wins,
    losses,
    pushes,
    decisiveWinRate,
    meanModelWinProbability,
    calibrationGap: decisiveWinRate != null && meanModelWinProbability != null ? decisiveWinRate - meanModelWinProbability : null,
    meanBrierScore: mean(brier),
    meanLogLoss: mean(logLoss),
    flatStakeRoiPct: selected.length ? (selected.reduce((sum, row) => sum + row.realizedProfitUnits, 0) / selected.length) * 100 : null,
    retentionPctOfBaselineCandidates: retentionPct,
    activeDateCoveragePct,
    noPickDates,
    noPickDatePct: baselineDates.length ? (noPickDates / baselineDates.length) * 100 : 0,
    averagePicksPerActiveDate: selectedDates.size ? selected.length / selectedDates.size : 0,
  };
}

export function buildMlbOperatingEnvelopeCalibration(input: {
  observations: readonly MlbOperatingEnvelopeCalibrationObservation[];
  rules: readonly MlbOperatingEnvelopeCalibrationRule[];
}): MlbOperatingEnvelopeCalibrationReport {
  const seen = new Set<string>();
  for (const row of input.observations) {
    validateObservation(row);
    if (seen.has(row.predictionId)) throw new Error(`MLB_OPERATING_ENVELOPE_CALIBRATION_DUPLICATE:${row.predictionId}`);
    seen.add(row.predictionId);
  }
  const observations = [...input.observations].sort((a, b) => a.gameDate.localeCompare(b.gameDate) || a.predictionId.localeCompare(b.predictionId));
  const uniqueDates = new Set(observations.map((row) => row.gameDate)).size;
  const enoughSample = observations.length >= MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_OBSERVATIONS
    && uniqueDates >= MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_DATES;
  const blockers: string[] = [];
  if (observations.length < MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_OBSERVATIONS) blockers.push("MINIMUM_OBSERVATIONS_NOT_REACHED");
  if (uniqueDates < MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_DATES) blockers.push("MINIMUM_DATES_NOT_REACHED");
  const baseline = metrics(observations, observations);
  const rules = input.rules.map((rule) => ({
    rule,
    metrics: metrics(observations.filter((row) => matchesMlbOperatingEnvelopeCalibrationRule(row, rule)), observations),
  }));
  return {
    schemaVersion: MLB_OPERATING_ENVELOPE_CALIBRATION_SCHEMA,
    state: enoughSample ? "RESEARCH_METRICS_READY" : "INSUFFICIENT_SAMPLE",
    cohort: {
      observations: observations.length,
      dates: uniqueDates,
      minimumObservations: MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_OBSERVATIONS,
      minimumDates: MLB_OPERATING_ENVELOPE_CALIBRATION_MIN_DATES,
    },
    baseline,
    rules,
    blockers,
    policy: {
      currentStep11aCandidatesAreBaselinePopulation: true,
      qualityAndPickVolumeMeasuredTogether: true,
      selectionRetentionAlwaysReported: true,
      noPickDateRateAlwaysReported: true,
      minimumSampleRequirementsAreResearchOnly: true,
      minimumSampleRequirementsAreLivePickFilters: false,
      ruleThresholdsHardCodedByRuntime: false,
      automaticBestRuleSelection: false,
      pointEstimateCanPromoteBetElite: false,
      historicalP1M3eMinimumsPreserved: true,
      liveOperatingEnvelopeChanged: false,
      betEliteLabelProduced: false,
      stakeCalculated: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}
