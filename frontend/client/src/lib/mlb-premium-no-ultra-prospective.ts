export const MLB_PREMIUM_NO_ULTRA_SCHEMA = "courtedge-p1-premium-no-ultra-prospective.v1" as const;
export const MLB_PREMIUM_NO_ULTRA_ENDPOINT = "/api/mlb/p1/v1/premium-no-ultra-prospective" as const;

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
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  for (const key of ["observations", "settled", "pending", "dates", "wins", "losses", "clvAvailable"]) if (!nonNegativeInteger(metric[key])) return false;
  for (const key of ["hitRatePct", "meanModelProbability", "observedWinRate", "calibrationGap", "flatStakeRoiPct", "brierScore", "logLoss", "clvCoveragePct", "meanClvPp", "medianClvPp"]) if (!finiteOrNull(metric[key])) return false;
  return typeof metric.flatStakeProfitUnits === "number" && Number.isFinite(metric.flatStakeProfitUnits)
    && Number(metric.settled) + Number(metric.pending) === Number(metric.observations)
    && Number(metric.wins) + Number(metric.losses) <= Number(metric.settled)
    && Number(metric.clvAvailable) <= Number(metric.settled);
}
function validInterval(value: unknown): value is MlbPremiumNoUltraInterval {
  const x = record(value);
  return Boolean(x) && x?.confidenceLevel === 0.95
    && nonNegativeInteger(x?.replicatesRequested) && nonNegativeInteger(x?.replicatesUsed)
    && typeof x?.pointEstimate === "number" && Number.isFinite(x.pointEstimate)
    && typeof x?.lower === "number" && Number.isFinite(x.lower)
    && typeof x?.upper === "number" && Number.isFinite(x.upper) && x.lower <= x.upper;
}

export function parseMlbPremiumNoUltraEnvelope(value: unknown): MlbPremiumNoUltraEnvelope {
  const envelope = record(value);
  const data = record(envelope?.data);
  const prereg = record(data?.preregistration);
  const cohort = record(data?.cohort);
  const inference = record(data?.inference);
  const criteria = record(data?.criteria);
  const interpretation = record(data?.interpretation);
  const fail = (message: string): never => { throw new Error(`PNU:${message}`); };

  if (envelope?.success !== true) fail("success");
  if (envelope?.endpoint !== MLB_PREMIUM_NO_ULTRA_ENDPOINT) fail("endpoint");
  if (data?.schemaVersion !== MLB_PREMIUM_NO_ULTRA_SCHEMA) fail("schema");
  if (typeof data?.generatedAt !== "string" || !Number.isFinite(Date.parse(data.generatedAt))) fail("time");
  if (!["COLLECTING_PROSPECTIVE_EVIDENCE", "CANDIDATE_NOT_CONFIRMED", "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY"].includes(String(data?.state))) fail("state");

  if (prereg?.cutoff !== "2026-08-08T04:32:33Z") fail("cutoff");
  if (prereg?.cutoffEvidenceCommit !== "a2bc70badc97251f2f0333beb1b2b954f841fad0" || prereg?.ruleSemanticsCommit !== "a2bc70badc97251f2f0333beb1b2b954f841fad0") fail("commit");
  if (prereg?.market !== "F5_ML" || prereg?.requiredStage !== "FINAL" || prereg?.requiredSource !== "app") fail("scope");
  if (prereg?.classificationSurface !== "ANALYSIS_RAW_OUTPUT_MARKETS_FINAL_RECOMMENDATION" || prereg?.candidateRule !== "FINAL_RECOMMENDATION_IS_PREMIUM_TRUE_AND_REASON_HAS_NO_ULTRA") fail("rule");
  for (const key of ["unclassifiableExcluded", "oneTerminalDecisionPerGame", "alternativePicksExcluded", "outcomeForbiddenFromMembership"]) if (prereg?.[key] !== true) fail(`unsafe_${key}`);
  for (const key of ["minimumCandidateSettled", "minimumCandidateDates", "minimumControlSettled", "minimumControlDates", "bootstrapReplicates"]) if (!nonNegativeInteger(prereg?.[key]) || Number(prereg?.[key]) <= 0) fail("minimum");
  if (prereg?.maximumCalibrationGap !== 0.05 || prereg?.maximumCalibrationDisadvantageVsControl !== 0.01) fail("calibration");

  for (const key of ["inputReviewRows", "afterCutoff", "finalF5Rows", "unclassifiableRowsExcluded", "eligibleClassifiableRows", "independentGames", "duplicateGameRowsExcluded", "candidateGames", "controlGames", "candidateSettled", "controlSettled", "candidateDates", "controlDates"]) if (!nonNegativeInteger(cohort?.[key])) fail("cohort");
  if (Number(cohort?.candidateGames) + Number(cohort?.controlGames) !== Number(cohort?.independentGames)) fail("independent_accounting");
  if (Number(cohort?.candidateSettled) > Number(cohort?.candidateGames) || Number(cohort?.controlSettled) > Number(cohort?.controlGames)) fail("settled");

  const candidate: MlbPremiumNoUltraMetricSummary = validMetric(data?.candidate) ? data.candidate : fail("candidate");
  const control: MlbPremiumNoUltraMetricSummary = validMetric(data?.control) ? data.control : fail("control");
  if (candidate.settled !== cohort?.candidateSettled || candidate.dates !== cohort?.candidateDates || control.settled !== cohort?.controlSettled || control.dates !== cohort?.controlDates) fail("metric_cohort");
  if (!nonNegativeInteger(inference?.dateClusters)) fail("clusters");
  const roi: MlbPremiumNoUltraInterval | null = inference?.candidateRoiPct === null ? null : validInterval(inference?.candidateRoiPct) ? inference.candidateRoiPct : fail("roi");
  const delta: MlbPremiumNoUltraInterval | null = inference?.candidateMinusControlRoiPp === null ? null : validInterval(inference?.candidateMinusControlRoiPp) ? inference.candidateMinusControlRoiPp : fail("delta");

  const expected = {
    minimumCandidateSampleAccepted: candidate.settled >= Number(prereg?.minimumCandidateSettled) && candidate.dates >= Number(prereg?.minimumCandidateDates),
    minimumControlSampleAccepted: control.settled >= Number(prereg?.minimumControlSettled) && control.dates >= Number(prereg?.minimumControlDates),
    candidateRoiLower95Positive: roi != null && roi.lower > 0,
    candidateMinusControlRoiLower95Positive: delta != null && delta.lower > 0,
    meanClvPositive: candidate.meanClvPp != null && candidate.meanClvPp > 0,
    properScoringNotWorse: candidate.brierScore != null && control.brierScore != null && candidate.logLoss != null && control.logLoss != null && candidate.brierScore <= control.brierScore && candidate.logLoss <= control.logLoss,
    calibrationAccepted: candidate.calibrationGap != null && control.calibrationGap != null && candidate.calibrationGap <= 0.05 && candidate.calibrationGap <= control.calibrationGap + 0.01,
  };
  for (const [key, expectedValue] of Object.entries(expected)) if (criteria?.[key] !== expectedValue) fail(`criterion_${key}`);
  const allAccepted = Object.values(expected).every(Boolean);
  if (criteria?.allAccepted !== allAccepted || (data?.state === "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY") !== allAccepted) fail("all");

  if (!Array.isArray(data?.blockers) || !data.blockers.every((item) => typeof item === "string")) fail("blockers");
  if (interpretation?.prospectiveOnly !== true || interpretation?.independentGameUnit !== true) fail("prospective");
  for (const key of ["historicalThirteenAndFourIncludedInConfirmation", "oldUltraMoneyGateRestored", "operationalMoneyGateAllowed", "stakeChangesAllowed", "automaticBettingAllowed", "automaticModelChangesAllowed", "automaticPromotionAllowed"]) if (interpretation?.[key] !== false) fail(`unsafe_${key}`);
  if (interpretation?.economicProfitabilitySupported !== allAccepted) fail("support");

  return value as MlbPremiumNoUltraEnvelope;
}
