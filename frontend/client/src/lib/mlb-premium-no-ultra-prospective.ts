export const MLB_PREMIUM_NO_ULTRA_SCHEMA = "courtedge-p1-premium-no-ultra-prospective.v1" as const;
export const MLB_PREMIUM_NO_ULTRA_ENDPOINT = "/api/mlb/p1/v1/premium-no-ultra-prospective" as const;
export const MLB_PREMIUM_NO_ULTRA_UI_RELEASE = "p1-premium-no-ultra-prospective-ui-2026-08-08" as const;

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

export interface MlbPremiumNoUltraInterval {
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
  preregistration: {
    cutoff: string;
    cutoffEvidenceCommit: string;
    ruleSemanticsCommit: string;
    market: "F5_ML";
    requiredStage: "FINAL";
    requiredSource: "app";
    classificationSurface: "ANALYSIS_RAW_OUTPUT_MARKETS_FINAL_RECOMMENDATION";
    candidateRule: "FINAL_RECOMMENDATION_IS_PREMIUM_TRUE_AND_REASON_HAS_NO_ULTRA";
    unclassifiableExcluded: true;
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
    finalF5Rows: number;
    unclassifiableRowsExcluded: number;
    eligibleClassifiableRows: number;
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
    candidateRoiPct: MlbPremiumNoUltraInterval | null;
    candidateMinusControlRoiPp: MlbPremiumNoUltraInterval | null;
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

export interface MlbPremiumNoUltraEnvelope {
  success: true;
  data: MlbPremiumNoUltraReport;
  endpoint: typeof MLB_PREMIUM_NO_ULTRA_ENDPOINT;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function finiteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validMetric(value: unknown): value is MlbPremiumNoUltraMetricSummary {
  const metric = record(value);
  if (!metric) return false;
  for (const key of ["observations", "settled", "pending", "dates", "wins", "losses", "clvAvailable"]) {
    if (!nonNegativeInteger(metric[key])) return false;
  }
  for (const key of ["hitRatePct", "meanModelProbability", "observedWinRate", "calibrationGap", "flatStakeRoiPct", "brierScore", "logLoss", "clvCoveragePct", "meanClvPp", "medianClvPp"]) {
    if (!finiteOrNull(metric[key])) return false;
  }
  return typeof metric.flatStakeProfitUnits === "number" && Number.isFinite(metric.flatStakeProfitUnits)
    && Number(metric.settled) + Number(metric.pending) === Number(metric.observations)
    && Number(metric.wins) + Number(metric.losses) <= Number(metric.settled)
    && Number(metric.clvAvailable) <= Number(metric.settled);
}

function validInterval(value: unknown): value is MlbPremiumNoUltraInterval {
  const interval = record(value);
  return Boolean(interval)
    && interval?.confidenceLevel === 0.95
    && nonNegativeInteger(interval?.replicatesRequested)
    && nonNegativeInteger(interval?.replicatesUsed)
    && typeof interval?.pointEstimate === "number" && Number.isFinite(interval.pointEstimate)
    && typeof interval?.lower === "number" && Number.isFinite(interval.lower)
    && typeof interval?.upper === "number" && Number.isFinite(interval.upper)
    && interval.lower <= interval.upper;
}

export function parseMlbPremiumNoUltraEnvelope(value: unknown): MlbPremiumNoUltraEnvelope {
  const envelope = record(value);
  const data = record(envelope?.data);
  const prereg = record(data?.preregistration);
  const cohort = record(data?.cohort);
  const candidate = record(data?.candidate);
  const control = record(data?.control);
  const inference = record(data?.inference);
  const criteria = record(data?.criteria);
  const interpretation = record(data?.interpretation);
  const fail = (message: string): never => {
    throw new Error(`PREMIUM_NO_ULTRA_UI_INVALID_RESPONSE:${message}`);
  };

  if (envelope?.success !== true) fail("success");
  if (envelope?.endpoint !== MLB_PREMIUM_NO_ULTRA_ENDPOINT) fail("endpoint");
  if (data?.schemaVersion !== MLB_PREMIUM_NO_ULTRA_SCHEMA) fail("schema");
  if (typeof data?.generatedAt !== "string" || !Number.isFinite(Date.parse(data.generatedAt))) fail("generatedAt");
  if (!["COLLECTING_PROSPECTIVE_EVIDENCE", "CANDIDATE_NOT_CONFIRMED", "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY"].includes(String(data?.state))) fail("state");

  if (prereg?.cutoff !== "2026-08-08T04:32:33Z") fail("cutoff");
  if (prereg?.cutoffEvidenceCommit !== "a2bc70badc97251f2f0333beb1b2b954f841fad0") fail("cutoff_commit");
  if (prereg?.ruleSemanticsCommit !== "a2bc70badc97251f2f0333beb1b2b954f841fad0") fail("rule_commit");
  if (prereg?.market !== "F5_ML" || prereg?.requiredStage !== "FINAL" || prereg?.requiredSource !== "app") fail("frozen_scope");
  if (prereg?.classificationSurface !== "ANALYSIS_RAW_OUTPUT_MARKETS_FINAL_RECOMMENDATION") fail("classification_surface");
  if (prereg?.candidateRule !== "FINAL_RECOMMENDATION_IS_PREMIUM_TRUE_AND_REASON_HAS_NO_ULTRA") fail("candidate_rule");
  for (const key of ["unclassifiableExcluded", "oneTerminalDecisionPerGame", "alternativePicksExcluded", "outcomeForbiddenFromMembership"]) {
    if (prereg?.[key] !== true) fail(`unsafe_${key}`);
  }
  for (const key of ["minimumCandidateSettled", "minimumCandidateDates", "minimumControlSettled", "minimumControlDates", "bootstrapReplicates"]) {
    if (!nonNegativeInteger(prereg?.[key]) || Number(prereg?.[key]) <= 0) fail(`prereg_${key}`);
  }
  if (prereg?.maximumCalibrationGap !== 0.05 || prereg?.maximumCalibrationDisadvantageVsControl !== 0.01) fail("calibration_thresholds");

  for (const key of ["inputReviewRows", "afterCutoff", "finalF5Rows", "unclassifiableRowsExcluded", "eligibleClassifiableRows", "independentGames", "duplicateGameRowsExcluded", "candidateGames", "controlGames", "candidateSettled", "controlSettled", "candidateDates", "controlDates"]) {
    if (!nonNegativeInteger(cohort?.[key])) fail(`cohort_${key}`);
  }
  if (Number(cohort?.candidateGames) + Number(cohort?.controlGames) !== Number(cohort?.independentGames)) fail("independent_accounting");
  if (Number(cohort?.candidateSettled) > Number(cohort?.candidateGames) || Number(cohort?.controlSettled) > Number(cohort?.controlGames)) fail("settled_accounting");

  if (!validMetric(candidate) || !validMetric(control)) fail("metrics");
  if (candidate.settled !== cohort?.candidateSettled || candidate.dates !== cohort?.candidateDates) fail("candidate_metric_cohort_parity");
  if (control.settled !== cohort?.controlSettled || control.dates !== cohort?.controlDates) fail("control_metric_cohort_parity");
  if (!nonNegativeInteger(inference?.dateClusters)) fail("date_clusters");
  if (inference?.candidateRoiPct !== null && !validInterval(inference?.candidateRoiPct)) fail("candidate_roi_interval");
  if (inference?.candidateMinusControlRoiPp !== null && !validInterval(inference?.candidateMinusControlRoiPp)) fail("incremental_roi_interval");

  const criterionKeys = ["minimumCandidateSampleAccepted", "minimumControlSampleAccepted", "candidateRoiLower95Positive", "candidateMinusControlRoiLower95Positive", "meanClvPositive", "properScoringNotWorse", "calibrationAccepted", "allAccepted"];
  for (const key of criterionKeys) if (typeof criteria?.[key] !== "boolean") fail(`criterion_${key}`);

  const expectedCandidateSample = candidate.settled >= Number(prereg.minimumCandidateSettled)
    && candidate.dates >= Number(prereg.minimumCandidateDates);
  const expectedControlSample = control.settled >= Number(prereg.minimumControlSettled)
    && control.dates >= Number(prereg.minimumControlDates);
  if (criteria?.minimumCandidateSampleAccepted !== expectedCandidateSample) fail("candidate_sample_criterion_parity");
  if (criteria?.minimumControlSampleAccepted !== expectedControlSample) fail("control_sample_criterion_parity");

  const candidateRoiInterval = inference?.candidateRoiPct as MlbPremiumNoUltraInterval | null;
  const differenceInterval = inference?.candidateMinusControlRoiPp as MlbPremiumNoUltraInterval | null;
  if (criteria?.candidateRoiLower95Positive !== (candidateRoiInterval != null && candidateRoiInterval.lower > 0)) fail("roi_criterion_parity");
  if (criteria?.candidateMinusControlRoiLower95Positive !== (differenceInterval != null && differenceInterval.lower > 0)) fail("incremental_roi_criterion_parity");
  if (criteria?.meanClvPositive !== (candidate.meanClvPp != null && candidate.meanClvPp > 0)) fail("clv_criterion_parity");
  const expectedProperScoring = candidate.brierScore != null && control.brierScore != null
    && candidate.logLoss != null && control.logLoss != null
    && candidate.brierScore <= control.brierScore
    && candidate.logLoss <= control.logLoss;
  if (criteria?.properScoringNotWorse !== expectedProperScoring) fail("proper_scoring_criterion_parity");
  const expectedCalibration = candidate.calibrationGap != null && control.calibrationGap != null
    && candidate.calibrationGap <= 0.05
    && candidate.calibrationGap <= control.calibrationGap + 0.01;
  if (criteria?.calibrationAccepted !== expectedCalibration) fail("calibration_criterion_parity");

  const expectedAll = criterionKeys.filter((key) => key !== "allAccepted").every((key) => criteria?.[key] === true);
  if (criteria?.allAccepted !== expectedAll) fail("criteria_parity");
  if ((data?.state === "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY") !== criteria?.allAccepted) fail("supported_state_parity");

  if (!Array.isArray(data?.blockers) || !data.blockers.every((item) => typeof item === "string")) fail("blockers");
  for (const key of ["prospectiveOnly", "independentGameUnit"]) if (interpretation?.[key] !== true) fail(`required_${key}`);
  for (const key of ["historicalThirteenAndFourIncludedInConfirmation", "oldUltraMoneyGateRestored", "operationalMoneyGateAllowed", "stakeChangesAllowed", "automaticBettingAllowed", "automaticModelChangesAllowed", "automaticPromotionAllowed"]) {
    if (interpretation?.[key] !== false) fail(`unsafe_${key}`);
  }
  if (typeof interpretation?.economicProfitabilitySupported !== "boolean") fail("supported_flag");
  if (interpretation?.economicProfitabilitySupported !== criteria?.allAccepted) fail("supported_flag_parity");

  return value as MlbPremiumNoUltraEnvelope;
}
