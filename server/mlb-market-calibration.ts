import type {
  MlbCalibrationPolicy,
  MlbMarketOutcome,
} from "./mlb-market-probability-contract";

export const MLB_P1_M6A3A_CALIBRATION_SCHEMA = "courtedge-p1-m6a3a-calibration-report.v1" as const;
const OUTCOMES: MlbMarketOutcome[] = ["WIN", "PUSH", "LOSS"];
const LOG_EPS = 1e-15;

export interface MlbCalibrationObservation {
  id: string;
  probabilities: Record<MlbMarketOutcome, number>;
  outcome: MlbMarketOutcome;
}

export interface MlbReliabilityBin {
  outcomeClass: MlbMarketOutcome;
  binIndex: number;
  lowerInclusive: number;
  upperInclusive: number;
  n: number;
  meanForecastProbability: number;
  empiricalFrequency: number;
  absoluteCalibrationGap: number;
  empiricalWilson95: { lower: number; upper: number };
}

export interface MlbCalibrationReport {
  schemaVersion: typeof MLB_P1_M6A3A_CALIBRATION_SCHEMA;
  n: number;
  multiclassBrier: number | null;
  logLoss: number | null;
  macroEce: number | null;
  classCounts: Record<MlbMarketOutcome, number>;
  pushRate: number | null;
  reliabilityBins: MlbReliabilityBin[];
  calibrationGate: {
    status: "POLICY_UNSET" | "INSUFFICIENT_SAMPLE" | "METRIC_FAIL" | "CALIBRATION_PASS_CANDIDATE";
    policyVersion: string | null;
    metricsPassed: boolean;
    actionabilityAllowed: false;
    blockers: string[];
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validateProbabilities(probabilities: Record<MlbMarketOutcome, number>): void {
  for (const outcome of OUTCOMES) {
    const value = probabilities[outcome];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("P1_M6A3A_INVALID_FORECAST_PROBABILITY");
    }
  }
  const total = OUTCOMES.reduce((sum, outcome) => sum + probabilities[outcome], 0);
  if (Math.abs(total - 1) > 1e-8) {
    throw new Error("P1_M6A3A_FORECAST_PROBABILITIES_MUST_SUM_TO_ONE");
  }
}

function wilson95(successes: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const z = 1.959963984540054;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    lower: round(clamp01(center - margin)),
    upper: round(clamp01(center + margin)),
  };
}

function reliability(
  observations: MlbCalibrationObservation[],
  binCount: number,
): { bins: MlbReliabilityBin[]; macroEce: number | null } {
  if (!observations.length) return { bins: [], macroEce: null };
  const bins: MlbReliabilityBin[] = [];
  const classEce: number[] = [];

  for (const outcomeClass of OUTCOMES) {
    let weightedGap = 0;
    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      const lowerInclusive = binIndex / binCount;
      const upperInclusive = (binIndex + 1) / binCount;
      const selected = observations.filter((observation) => {
        const p = observation.probabilities[outcomeClass];
        if (binIndex === binCount - 1) return p >= lowerInclusive && p <= upperInclusive;
        return p >= lowerInclusive && p < upperInclusive;
      });
      if (!selected.length) continue;
      const meanForecastProbability = selected.reduce(
        (sum, observation) => sum + observation.probabilities[outcomeClass],
        0,
      ) / selected.length;
      const successes = selected.filter((observation) => observation.outcome === outcomeClass).length;
      const empiricalFrequency = successes / selected.length;
      const absoluteCalibrationGap = Math.abs(meanForecastProbability - empiricalFrequency);
      weightedGap += absoluteCalibrationGap * (selected.length / observations.length);
      bins.push({
        outcomeClass,
        binIndex,
        lowerInclusive: round(lowerInclusive),
        upperInclusive: round(upperInclusive),
        n: selected.length,
        meanForecastProbability: round(meanForecastProbability),
        empiricalFrequency: round(empiricalFrequency),
        absoluteCalibrationGap: round(absoluteCalibrationGap),
        empiricalWilson95: wilson95(successes, selected.length),
      });
    }
    classEce.push(weightedGap);
  }

  return {
    bins,
    macroEce: round(classEce.reduce((sum, value) => sum + value, 0) / classEce.length),
  };
}

function evaluateGate(
  report: Pick<MlbCalibrationReport, "n" | "multiclassBrier" | "logLoss" | "macroEce">,
  policy?: MlbCalibrationPolicy,
): MlbCalibrationReport["calibrationGate"] {
  if (!policy) {
    return {
      status: "POLICY_UNSET",
      policyVersion: null,
      metricsPassed: false,
      actionabilityAllowed: false,
      blockers: ["P1_M6A3B_VERSIONED_CALIBRATION_POLICY_REQUIRED"],
    };
  }
  if (
    !String(policy.policyVersion ?? "").trim()
    || !Number.isInteger(policy.minimumSamples)
    || policy.minimumSamples <= 0
    || !Number.isFinite(policy.maximumMulticlassBrier)
    || !Number.isFinite(policy.maximumLogLoss)
    || !Number.isFinite(policy.maximumMacroEce)
  ) {
    throw new Error("P1_M6A3A_INVALID_CALIBRATION_POLICY");
  }
  if (report.n < policy.minimumSamples) {
    return {
      status: "INSUFFICIENT_SAMPLE",
      policyVersion: policy.policyVersion,
      metricsPassed: false,
      actionabilityAllowed: false,
      blockers: ["MINIMUM_HISTORICAL_SAMPLE_NOT_MET"],
    };
  }
  const passed =
    report.multiclassBrier != null
    && report.logLoss != null
    && report.macroEce != null
    && report.multiclassBrier <= policy.maximumMulticlassBrier
    && report.logLoss <= policy.maximumLogLoss
    && report.macroEce <= policy.maximumMacroEce;
  return {
    status: passed ? "CALIBRATION_PASS_CANDIDATE" : "METRIC_FAIL",
    policyVersion: policy.policyVersion,
    metricsPassed: passed,
    actionabilityAllowed: false,
    blockers: passed
      ? ["A3A_CANNOT_ENABLE_ACTIONABILITY", "A3B_OUT_OF_SAMPLE_CERTIFICATION_REQUIRED"]
      : ["CALIBRATION_METRIC_THRESHOLD_NOT_MET"],
  };
}

export function buildMlbCalibrationReport(
  observations: MlbCalibrationObservation[],
  options: { binCount?: number; policy?: MlbCalibrationPolicy } = {},
): MlbCalibrationReport {
  const binCount = options.binCount ?? 10;
  if (!Number.isInteger(binCount) || binCount < 2 || binCount > 20) {
    throw new Error("P1_M6A3A_INVALID_CALIBRATION_BIN_COUNT");
  }
  for (const observation of observations) {
    if (!String(observation.id ?? "").trim()) throw new Error("P1_M6A3A_OBSERVATION_ID_REQUIRED");
    validateProbabilities(observation.probabilities);
    if (!OUTCOMES.includes(observation.outcome)) throw new Error("P1_M6A3A_INVALID_OBSERVED_OUTCOME");
  }

  const classCounts: Record<MlbMarketOutcome, number> = { WIN: 0, PUSH: 0, LOSS: 0 };
  let brierSum = 0;
  let logLossSum = 0;
  for (const observation of observations) {
    classCounts[observation.outcome] += 1;
    for (const outcome of OUTCOMES) {
      const target = outcome === observation.outcome ? 1 : 0;
      const error = observation.probabilities[outcome] - target;
      brierSum += error * error;
    }
    logLossSum += -Math.log(Math.max(LOG_EPS, observation.probabilities[observation.outcome]));
  }

  const reliabilityResult = reliability(observations, binCount);
  const base = {
    n: observations.length,
    multiclassBrier: observations.length ? round(brierSum / observations.length) : null,
    logLoss: observations.length ? round(logLossSum / observations.length) : null,
    macroEce: reliabilityResult.macroEce,
  };
  return {
    schemaVersion: MLB_P1_M6A3A_CALIBRATION_SCHEMA,
    ...base,
    classCounts,
    pushRate: observations.length ? round(classCounts.PUSH / observations.length) : null,
    reliabilityBins: reliabilityResult.bins,
    calibrationGate: evaluateGate(base, options.policy),
  };
}
