export const MLB_STEP12_POCKET_VALIDATION_SCHEMA = "courtedge-p0-step12-pocket-validation.v1" as const;

export type MlbStep12PocketValidationStatus =
  | "OOS_SUPPORTED_HYPOTHESIS"
  | "PROMISING_NOT_FAMILYWISE_SUPPORTED"
  | "INSUFFICIENT_HOLDOUT_SAMPLE"
  | "UNSTABLE_HOLDOUT"
  | "INVALID_EVIDENCE";

export interface MlbStep12PocketMetrics {
  decisiveHitRate: number | null;
  decisiveRows: number;
  hits: number;
  losses: number;
  pushes: number;
  selectedRows: number;
  uniqueDates: number;
  retentionPct: number;
  noPickDatePct: number;
}

export interface MlbStep12PocketRuleEvidence {
  ruleKey: string;
  side: "HOME" | "AWAY";
  discovery: MlbStep12PocketMetrics;
  discoveryWilsonLower95: number | null;
  holdout: MlbStep12PocketMetrics;
  holdoutOneSidedPValueVsBaseline: number | null;
  holdoutBonferroniPValueTopK: number | null;
}

export interface MlbStep12PocketTargetEvidence {
  horizon: string;
  attemptedRules: number;
  topK: number;
  holdoutBaselineHomeDecisiveHitRate: number;
  rules: MlbStep12PocketRuleEvidence[];
}

export interface MlbStep12PocketPilotEvidence {
  schemaVersion: string;
  evidenceStatus: string;
  policy: {
    historicalPricesUsed: boolean;
    historicalEvClaimProduced: boolean;
    holdoutThresholdTuningAllowed: boolean;
    automaticBestRulePromotion: boolean;
    livePickFiltersChanged: boolean;
    betEliteProduced: boolean;
  };
  targets: MlbStep12PocketTargetEvidence[];
}

export interface MlbStep12PocketValidationResult {
  schemaVersion: typeof MLB_STEP12_POCKET_VALIDATION_SCHEMA;
  ruleKey: string;
  horizon: string;
  side: "HOME" | "AWAY";
  status: MlbStep12PocketValidationStatus;
  descriptiveHitRateBand: "EXCEPTIONAL_80_PLUS" | "STRONG_70_TO_80" | "USEFUL_BELOW_70" | "NO_DECISIVE_SAMPLE";
  discoveryHitRate: number | null;
  holdoutHitRate: number | null;
  absoluteHitRateDrift: number | null;
  baselineHitRateForSelectedSide: number;
  holdoutLiftVsBaseline: number | null;
  holdoutDecisiveRows: number;
  holdoutUniqueDates: number;
  familywiseAdjustedPValue: number | null;
  rawPValue: number | null;
  reasons: string[];
  policy: {
    researchOnly: true;
    familywiseAlpha: 0.05;
    minimumHoldoutDecisiveRows: 30;
    minimumHoldoutUniqueDates: 20;
    maximumAbsoluteDiscoveryHoldoutDrift: 0.15;
    hitRateBandIsDescriptiveNotPromotion: true;
    lowerHitRateStableSignalsRemainResearchEligible: true;
    historicalPricesRequiredForSportingSupport: false;
    historicalPricesRequiredForHistoricalEvClaim: true;
    holdoutThresholdTuningAllowed: false;
    livePickFiltersChanged: false;
    betEliteLabelProduced: false;
    automaticBetPlacement: false;
  };
}

const FAMILYWISE_ALPHA = 0.05;
const MIN_HOLDOUT_DECISIVE_ROWS = 30;
const MIN_HOLDOUT_UNIQUE_DATES = 20;
const MAX_ABSOLUTE_DISCOVERY_HOLDOUT_DRIFT = 0.15;

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateMetrics(metrics: MlbStep12PocketMetrics): boolean {
  if (![metrics.decisiveRows, metrics.hits, metrics.losses, metrics.pushes, metrics.selectedRows, metrics.uniqueDates]
    .every((value) => Number.isInteger(value) && value >= 0)) return false;
  if (![metrics.retentionPct, metrics.noPickDatePct].every((value) => Number.isFinite(value) && value >= 0 && value <= 100)) return false;
  if (metrics.hits + metrics.losses !== metrics.decisiveRows) return false;
  if (metrics.decisiveRows + metrics.pushes !== metrics.selectedRows) return false;
  if (metrics.uniqueDates > metrics.selectedRows) return false;
  if (metrics.decisiveRows === 0) return metrics.decisiveHitRate == null;
  return finiteProbability(metrics.decisiveHitRate)
    && Math.abs(metrics.decisiveHitRate - metrics.hits / metrics.decisiveRows) <= 1e-12;
}

function descriptiveBand(rate: number | null): MlbStep12PocketValidationResult["descriptiveHitRateBand"] {
  if (rate == null) return "NO_DECISIVE_SAMPLE";
  if (rate >= 0.80) return "EXCEPTIONAL_80_PLUS";
  if (rate >= 0.70) return "STRONG_70_TO_80";
  return "USEFUL_BELOW_70";
}

function invalidResult(rule: MlbStep12PocketRuleEvidence, horizon: string, baseline: number, reasons: string[]): MlbStep12PocketValidationResult {
  return {
    schemaVersion: MLB_STEP12_POCKET_VALIDATION_SCHEMA,
    ruleKey: rule.ruleKey,
    horizon,
    side: rule.side,
    status: "INVALID_EVIDENCE",
    descriptiveHitRateBand: descriptiveBand(rule.holdout.decisiveHitRate),
    discoveryHitRate: rule.discovery.decisiveHitRate,
    holdoutHitRate: rule.holdout.decisiveHitRate,
    absoluteHitRateDrift: null,
    baselineHitRateForSelectedSide: baseline,
    holdoutLiftVsBaseline: null,
    holdoutDecisiveRows: rule.holdout.decisiveRows,
    holdoutUniqueDates: rule.holdout.uniqueDates,
    familywiseAdjustedPValue: rule.holdoutBonferroniPValueTopK,
    rawPValue: rule.holdoutOneSidedPValueVsBaseline,
    reasons,
    policy: policy(),
  };
}

function policy(): MlbStep12PocketValidationResult["policy"] {
  return {
    researchOnly: true,
    familywiseAlpha: FAMILYWISE_ALPHA,
    minimumHoldoutDecisiveRows: MIN_HOLDOUT_DECISIVE_ROWS,
    minimumHoldoutUniqueDates: MIN_HOLDOUT_UNIQUE_DATES,
    maximumAbsoluteDiscoveryHoldoutDrift: MAX_ABSOLUTE_DISCOVERY_HOLDOUT_DRIFT,
    hitRateBandIsDescriptiveNotPromotion: true,
    lowerHitRateStableSignalsRemainResearchEligible: true,
    historicalPricesRequiredForSportingSupport: false,
    historicalPricesRequiredForHistoricalEvClaim: true,
    holdoutThresholdTuningAllowed: false,
    livePickFiltersChanged: false,
    betEliteLabelProduced: false,
    automaticBetPlacement: false,
  };
}

export function validateMlbStep12Pocket(
  target: MlbStep12PocketTargetEvidence,
  rule: MlbStep12PocketRuleEvidence,
): MlbStep12PocketValidationResult {
  const homeBaseline = target.holdoutBaselineHomeDecisiveHitRate;
  const selectedSideBaseline = rule.side === "HOME" ? homeBaseline : 1 - homeBaseline;
  const invalidReasons: string[] = [];

  if (!String(rule.ruleKey ?? "").trim()) invalidReasons.push("RULE_KEY_REQUIRED");
  if (!(rule.side === "HOME" || rule.side === "AWAY")) invalidReasons.push("SIDE_INVALID");
  if (!Number.isInteger(target.attemptedRules) || target.attemptedRules < target.topK || target.topK <= 0) invalidReasons.push("TARGET_COUNTS_INVALID");
  if (!finiteProbability(homeBaseline)) invalidReasons.push("BASELINE_INVALID");
  if (!validateMetrics(rule.discovery)) invalidReasons.push("DISCOVERY_METRICS_INVALID");
  if (!validateMetrics(rule.holdout)) invalidReasons.push("HOLDOUT_METRICS_INVALID");
  if (rule.discoveryWilsonLower95 != null && !finiteProbability(rule.discoveryWilsonLower95)) invalidReasons.push("DISCOVERY_WILSON_INVALID");
  if (rule.holdoutOneSidedPValueVsBaseline != null && !finiteProbability(rule.holdoutOneSidedPValueVsBaseline)) invalidReasons.push("RAW_P_VALUE_INVALID");
  if (rule.holdoutBonferroniPValueTopK != null && !finiteProbability(rule.holdoutBonferroniPValueTopK)) invalidReasons.push("ADJUSTED_P_VALUE_INVALID");
  if (rule.holdoutOneSidedPValueVsBaseline != null && rule.holdoutBonferroniPValueTopK != null
    && rule.holdoutBonferroniPValueTopK + 1e-12 < rule.holdoutOneSidedPValueVsBaseline) {
    invalidReasons.push("ADJUSTED_P_VALUE_LT_RAW_P_VALUE");
  }
  if (invalidReasons.length) return invalidResult(rule, target.horizon, selectedSideBaseline, invalidReasons);

  const discoveryRate = rule.discovery.decisiveHitRate;
  const holdoutRate = rule.holdout.decisiveHitRate;
  const drift = discoveryRate == null || holdoutRate == null ? null : Math.abs(discoveryRate - holdoutRate);
  const lift = holdoutRate == null ? null : holdoutRate - selectedSideBaseline;
  const reasons: string[] = [];

  let status: MlbStep12PocketValidationStatus;
  if (rule.holdout.decisiveRows < MIN_HOLDOUT_DECISIVE_ROWS || rule.holdout.uniqueDates < MIN_HOLDOUT_UNIQUE_DATES) {
    status = "INSUFFICIENT_HOLDOUT_SAMPLE";
    if (rule.holdout.decisiveRows < MIN_HOLDOUT_DECISIVE_ROWS) reasons.push("DECISIVE_ROWS_BELOW_30");
    if (rule.holdout.uniqueDates < MIN_HOLDOUT_UNIQUE_DATES) reasons.push("UNIQUE_DATES_BELOW_20");
  } else if (holdoutRate == null || holdoutRate <= selectedSideBaseline || drift == null || drift > MAX_ABSOLUTE_DISCOVERY_HOLDOUT_DRIFT) {
    status = "UNSTABLE_HOLDOUT";
    if (holdoutRate == null) reasons.push("NO_HOLDOUT_DECISIVE_RATE");
    else if (holdoutRate <= selectedSideBaseline) reasons.push("NO_POSITIVE_HOLDOUT_LIFT");
    if (drift != null && drift > MAX_ABSOLUTE_DISCOVERY_HOLDOUT_DRIFT) reasons.push("DISCOVERY_HOLDOUT_DRIFT_GT_15PP");
  } else if (rule.holdoutBonferroniPValueTopK != null && rule.holdoutBonferroniPValueTopK <= FAMILYWISE_ALPHA) {
    status = "OOS_SUPPORTED_HYPOTHESIS";
    reasons.push("POSITIVE_HOLDOUT_LIFT", "FAMILYWISE_P_LE_0_05", "SAMPLE_AND_DATE_FLOORS_MET", "DISCOVERY_HOLDOUT_DRIFT_WITHIN_15PP");
  } else {
    status = "PROMISING_NOT_FAMILYWISE_SUPPORTED";
    if (rule.holdoutOneSidedPValueVsBaseline != null && rule.holdoutOneSidedPValueVsBaseline <= FAMILYWISE_ALPHA) {
      reasons.push("RAW_P_LE_0_05_BUT_FAMILYWISE_NOT_SUPPORTED");
    } else {
      reasons.push("HOLDOUT_NOT_SIGNIFICANT_VS_BASELINE");
    }
    reasons.push("REMAINS_RESEARCH_ELIGIBLE");
  }

  return {
    schemaVersion: MLB_STEP12_POCKET_VALIDATION_SCHEMA,
    ruleKey: rule.ruleKey,
    horizon: target.horizon,
    side: rule.side,
    status,
    descriptiveHitRateBand: descriptiveBand(holdoutRate),
    discoveryHitRate: discoveryRate,
    holdoutHitRate: holdoutRate,
    absoluteHitRateDrift: drift,
    baselineHitRateForSelectedSide: selectedSideBaseline,
    holdoutLiftVsBaseline: lift,
    holdoutDecisiveRows: rule.holdout.decisiveRows,
    holdoutUniqueDates: rule.holdout.uniqueDates,
    familywiseAdjustedPValue: rule.holdoutBonferroniPValueTopK,
    rawPValue: rule.holdoutOneSidedPValueVsBaseline,
    reasons,
    policy: policy(),
  };
}

export function validateMlbStep12PilotEvidence(pilot: MlbStep12PocketPilotEvidence): MlbStep12PocketValidationResult[] {
  if (pilot.schemaVersion !== "courtedge-p0-step12-pocket-pilot.v1") throw new Error("STEP12C_PILOT_SCHEMA_INVALID");
  if (pilot.evidenceStatus !== "PILOT_RESEARCH_ONLY_NOT_BET_ELITE") throw new Error("STEP12C_PILOT_STATUS_INVALID");
  if (pilot.policy.historicalPricesUsed || pilot.policy.historicalEvClaimProduced || pilot.policy.holdoutThresholdTuningAllowed
    || pilot.policy.automaticBestRulePromotion || pilot.policy.livePickFiltersChanged || pilot.policy.betEliteProduced) {
    throw new Error("STEP12C_RESEARCH_BOUNDARY_VIOLATION");
  }
  return pilot.targets.flatMap((target) => target.rules.map((rule) => validateMlbStep12Pocket(target, rule)));
}
