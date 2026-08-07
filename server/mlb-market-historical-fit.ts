import { buildMlbCalibrationReport, type MlbCalibrationObservation, type MlbCalibrationReport } from "./mlb-market-calibration";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";

export const MLB_P1_M6A3B1_FIT_SCHEMA = "courtedge-p1-m6a3b1-historical-oos-fit.v1" as const;
export type MlbHistoricalModelFamily = "POISSON" | "NEGATIVE_BINOMIAL_NB2";

export interface MlbMarginalRunFit {
  family: MlbHistoricalModelFamily;
  n: number;
  meanRuns: number;
  dispersionK: number | null;
  varianceRuns: number;
  inSampleMeanNegativeLogLikelihood: number;
}

export interface MlbHistoricalOosFoldMetric {
  foldIndex: number;
  trainingDates: number;
  validationDates: number;
  trainingGames: number;
  validationGames: number;
  trainingMaxDate: string;
  validationMinDate: string;
  validationMaxDate: string;
  leakageFree: true;
  homeFit: MlbMarginalRunFit;
  awayFit: MlbMarginalRunFit;
  countNegativeLogLikelihood: number;
}

export interface MlbHistoricalFamilyOosMetrics {
  family: MlbHistoricalModelFamily;
  folds: MlbHistoricalOosFoldMetric[];
  validationGames: number;
  countObservations: number;
  meanCountNegativeLogLikelihood: number | null;
  homeMoneylineCalibration: MlbCalibrationReport | null;
  nrfiCalibration: MlbCalibrationReport | null;
}

export interface MlbHistoricalHorizonOosReport {
  horizon: MlbProbabilityHorizon;
  observations: number;
  uniqueDates: number;
  status: "READY_FOR_RESEARCH_REVIEW" | "INSUFFICIENT_OOS_SAMPLE";
  candidates: Record<MlbHistoricalModelFamily, MlbHistoricalFamilyOosMetrics>;
  preferredFamilyByCountNll: MlbHistoricalModelFamily | null;
  countNllDeltaPoissonMinusNb2: number | null;
  actionabilityAllowed: false;
  blockers: string[];
}

export interface MlbHistoricalOosReport {
  schemaVersion: typeof MLB_P1_M6A3B1_FIT_SCHEMA;
  generatedAt: string;
  configuration: {
    minimumTrainingDates: number;
    validationDateCount: number;
    stepDateCount: number;
    minimumTotalValidationGames: number;
  };
  horizons: MlbHistoricalHorizonOosReport[];
  allFoldsLeakageFree: boolean;
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  blockers: ["P1_M6A3B1_BASELINE_ONLY", "P1_M6A3B2_COVARIATE_MODEL_REQUIRED", "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE"];
}

const LOG_EPS = 1e-15;
const SUPPORT_TAIL_TARGET = 1e-8;
const MAX_SUPPORT_RUNS = 60;
const FAMILIES: MlbHistoricalModelFamily[] = ["POISSON", "NEGATIVE_BINOMIAL_NB2"];
const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number {
  if (!values.length) throw new Error("P1_M6A3B1_EMPTY_TRAINING_SAMPLE");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[], average: number): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
}

function logGamma(z: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.99999999999980993;
  const adjusted = z - 1;
  for (let i = 0; i < coefficients.length; i += 1) x += coefficients[i] / (adjusted + i + 1);
  const t = adjusted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (adjusted + 0.5) * Math.log(t) - t + Math.log(x);
}

function poissonLogPmf(y: number, mu: number): number {
  if (!Number.isInteger(y) || y < 0 || !Number.isFinite(mu) || mu < 0) return Number.NEGATIVE_INFINITY;
  if (mu === 0) return y === 0 ? 0 : Number.NEGATIVE_INFINITY;
  return y * Math.log(mu) - mu - logGamma(y + 1);
}

function nb2LogPmf(y: number, mu: number, k: number): number {
  if (!Number.isInteger(y) || y < 0 || !(mu >= 0) || !(k > 0)) return Number.NEGATIVE_INFINITY;
  if (mu === 0) return y === 0 ? 0 : Number.NEGATIVE_INFINITY;
  return logGamma(y + k) - logGamma(k) - logGamma(y + 1)
    + k * Math.log(k / (k + mu))
    + y * Math.log(mu / (k + mu));
}

function averageNll(values: number[], family: MlbHistoricalModelFamily, mu: number, k: number | null): number {
  const total = values.reduce((sum, y) => {
    const logP = family === "POISSON" ? poissonLogPmf(y, mu) : nb2LogPmf(y, mu, k as number);
    return sum - Math.max(Math.log(LOG_EPS), logP);
  }, 0);
  return total / values.length;
}

function optimizeDispersionK(values: number[], mu: number): number {
  if (mu === 0) return 1_000_000;
  const objective = (logK: number) => {
    const k = Math.exp(logK);
    return values.reduce((sum, y) => sum - nb2LogPmf(y, mu, k), 0);
  };
  let left = Math.log(0.05);
  let right = Math.log(1_000_000);
  const phi = (Math.sqrt(5) - 1) / 2;
  let x1 = right - phi * (right - left);
  let x2 = left + phi * (right - left);
  let f1 = objective(x1);
  let f2 = objective(x2);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    if (f1 > f2) {
      left = x1;
      x1 = x2;
      f1 = f2;
      x2 = left + phi * (right - left);
      f2 = objective(x2);
    } else {
      right = x2;
      x2 = x1;
      f2 = f1;
      x1 = right - phi * (right - left);
      f1 = objective(x1);
    }
  }
  return Math.exp((left + right) / 2);
}

export function fitMlbMarginalRunModel(
  values: number[],
  family: MlbHistoricalModelFamily,
): MlbMarginalRunFit {
  if (!values.length || values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("P1_M6A3B1_INVALID_RUN_SAMPLE");
  }
  const mu = mean(values);
  const varianceRuns = variance(values, mu);
  const dispersionK = family === "NEGATIVE_BINOMIAL_NB2" ? optimizeDispersionK(values, mu) : null;
  return {
    family,
    n: values.length,
    meanRuns: round(mu),
    dispersionK: dispersionK == null ? null : round(dispersionK),
    varianceRuns: round(varianceRuns),
    inSampleMeanNegativeLogLikelihood: round(averageNll(values, family, mu, dispersionK)),
  };
}

function discretePmf(fit: MlbMarginalRunFit): number[] {
  const probabilities: number[] = [];
  let represented = 0;
  for (let runs = 0; runs <= MAX_SUPPORT_RUNS; runs += 1) {
    const logP = fit.family === "POISSON"
      ? poissonLogPmf(runs, fit.meanRuns)
      : nb2LogPmf(runs, fit.meanRuns, fit.dispersionK as number);
    const probability = Math.exp(logP);
    probabilities.push(probability);
    represented += probability;
    if (runs >= 8 && 1 - represented <= SUPPORT_TAIL_TARGET) break;
  }
  if (1 - represented > SUPPORT_TAIL_TARGET) throw new Error("P1_M6A3B1_PMF_TAIL_TARGET_NOT_MET");
  return probabilities.map((value) => value / represented);
}

function jointOutcomeProbabilities(
  homeFit: MlbMarginalRunFit,
  awayFit: MlbMarginalRunFit,
  fullGame: boolean,
): { WIN: number; PUSH: number; LOSS: number; nrfi: number } {
  const home = discretePmf(homeFit);
  const away = discretePmf(awayFit);
  let win = 0;
  let push = 0;
  let loss = 0;
  let nrfi = 0;
  for (let h = 0; h < home.length; h += 1) {
    for (let a = 0; a < away.length; a += 1) {
      const probability = home[h] * away[a];
      if (h === 0 && a === 0) nrfi += probability;
      if (h > a) win += probability;
      else if (h < a) loss += probability;
      else push += probability;
    }
  }
  if (fullGame) {
    const nonTie = win + loss;
    if (!(nonTie > 0)) throw new Error("P1_M6A3B1_FULL_GAME_NON_TIE_MASS_REQUIRED");
    return { WIN: win / nonTie, PUSH: 0, LOSS: loss / nonTie, nrfi };
  }
  const total = win + push + loss;
  return { WIN: win / total, PUSH: push / total, LOSS: loss / total, nrfi };
}

interface DateFold {
  foldIndex: number;
  trainDateSet: Set<string>;
  validationDateSet: Set<string>;
  trainingMaxDate: string;
  validationMinDate: string;
  validationMaxDate: string;
}

export function buildMlbRollingOriginDateFolds(
  observations: MlbHistoricalHorizonObservation[],
  options: { minimumTrainingDates: number; validationDateCount: number; stepDateCount: number },
): Array<{
  foldIndex: number;
  trainingMaxDate: string;
  validationMinDate: string;
  validationMaxDate: string;
  trainingDates: string[];
  validationDates: string[];
}> {
  const { minimumTrainingDates, validationDateCount, stepDateCount } = options;
  if (![minimumTrainingDates, validationDateCount, stepDateCount].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("P1_M6A3B1_INVALID_ROLLING_ORIGIN_CONFIGURATION");
  }
  const dates = [...new Set(observations.map((row) => row.officialDate))].sort();
  const folds = [];
  let foldIndex = 0;
  for (let trainDateCount = minimumTrainingDates;
    trainDateCount + validationDateCount <= dates.length;
    trainDateCount += stepDateCount) {
    const trainingDates = dates.slice(0, trainDateCount);
    const validationDates = dates.slice(trainDateCount, trainDateCount + validationDateCount);
    const trainingMaxDate = trainingDates.at(-1) as string;
    const validationMinDate = validationDates[0];
    const validationMaxDate = validationDates.at(-1) as string;
    if (!(trainingMaxDate < validationMinDate)) throw new Error("P1_M6A3B1_TIME_LEAKAGE_DETECTED");
    folds.push({ foldIndex, trainingMaxDate, validationMinDate, validationMaxDate, trainingDates, validationDates });
    foldIndex += 1;
  }
  return folds;
}

function materializeFold(observations: MlbHistoricalHorizonObservation[], fold: ReturnType<typeof buildMlbRollingOriginDateFolds>[number]): {
  training: MlbHistoricalHorizonObservation[];
  validation: MlbHistoricalHorizonObservation[];
  dateFold: DateFold;
} {
  const trainDateSet = new Set(fold.trainingDates);
  const validationDateSet = new Set(fold.validationDates);
  const training = observations.filter((row) => trainDateSet.has(row.officialDate));
  const validation = observations.filter((row) => validationDateSet.has(row.officialDate));
  if (training.some((row) => validationDateSet.has(row.officialDate))) throw new Error("P1_M6A3B1_TIME_LEAKAGE_DETECTED");
  return {
    training,
    validation,
    dateFold: {
      foldIndex: fold.foldIndex,
      trainDateSet,
      validationDateSet,
      trainingMaxDate: fold.trainingMaxDate,
      validationMinDate: fold.validationMinDate,
      validationMaxDate: fold.validationMaxDate,
    },
  };
}

function observedHomeMlOutcome(row: MlbHistoricalHorizonObservation): "WIN" | "PUSH" | "LOSS" {
  if (row.homeRuns > row.awayRuns) return "WIN";
  if (row.homeRuns < row.awayRuns) return "LOSS";
  return "PUSH";
}

function validateObservationSet(rows: MlbHistoricalHorizonObservation[]): void {
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.officialDate)
      || !Number.isInteger(row.gamePk)
      || row.gamePk <= 0
      || !Number.isInteger(row.homeRuns)
      || row.homeRuns < 0
      || !Number.isInteger(row.awayRuns)
      || row.awayRuns < 0) {
      throw new Error("P1_M6A3B1_INVALID_OOS_OBSERVATION");
    }
  }
}

function evaluateFamily(
  horizon: MlbProbabilityHorizon,
  rows: MlbHistoricalHorizonObservation[],
  family: MlbHistoricalModelFamily,
  foldDefinitions: ReturnType<typeof buildMlbRollingOriginDateFolds>,
): MlbHistoricalFamilyOosMetrics {
  const folds: MlbHistoricalOosFoldMetric[] = [];
  const mlForecasts: MlbCalibrationObservation[] = [];
  const nrfiForecasts: MlbCalibrationObservation[] = [];
  let totalCountNll = 0;
  let countObservations = 0;
  let validationGames = 0;

  for (const definition of foldDefinitions) {
    const { training, validation } = materializeFold(rows, definition);
    if (!training.length || !validation.length) continue;
    const homeFit = fitMlbMarginalRunModel(training.map((row) => row.homeRuns), family);
    const awayFit = fitMlbMarginalRunModel(training.map((row) => row.awayRuns), family);
    let foldNll = 0;
    for (const row of validation) {
      const homeLogP = family === "POISSON"
        ? poissonLogPmf(row.homeRuns, homeFit.meanRuns)
        : nb2LogPmf(row.homeRuns, homeFit.meanRuns, homeFit.dispersionK as number);
      const awayLogP = family === "POISSON"
        ? poissonLogPmf(row.awayRuns, awayFit.meanRuns)
        : nb2LogPmf(row.awayRuns, awayFit.meanRuns, awayFit.dispersionK as number);
      foldNll += -Math.max(Math.log(LOG_EPS), homeLogP) - Math.max(Math.log(LOG_EPS), awayLogP);
      totalCountNll += -Math.max(Math.log(LOG_EPS), homeLogP) - Math.max(Math.log(LOG_EPS), awayLogP);
      countObservations += 2;

      const probabilities = jointOutcomeProbabilities(homeFit, awayFit, horizon === "FULL_GAME");
      const outcome = observedHomeMlOutcome(row);
      if (!(horizon === "FULL_GAME" && outcome === "PUSH")) {
        mlForecasts.push({
          id: `${family}:${horizon}:${definition.foldIndex}:${row.gamePk}:HOME_ML`,
          probabilities: { WIN: probabilities.WIN, PUSH: probabilities.PUSH, LOSS: probabilities.LOSS },
          outcome,
        });
      }
      if (horizon === "FIRST_INNING") {
        nrfiForecasts.push({
          id: `${family}:${horizon}:${definition.foldIndex}:${row.gamePk}:NRFI`,
          probabilities: { WIN: probabilities.nrfi, PUSH: 0, LOSS: 1 - probabilities.nrfi },
          outcome: row.totalRuns === 0 ? "WIN" : "LOSS",
        });
      }
    }
    validationGames += validation.length;
    folds.push({
      foldIndex: definition.foldIndex,
      trainingDates: definition.trainingDates.length,
      validationDates: definition.validationDates.length,
      trainingGames: training.length,
      validationGames: validation.length,
      trainingMaxDate: definition.trainingMaxDate,
      validationMinDate: definition.validationMinDate,
      validationMaxDate: definition.validationMaxDate,
      leakageFree: true,
      homeFit,
      awayFit,
      countNegativeLogLikelihood: round(foldNll / (validation.length * 2)),
    });
  }

  return {
    family,
    folds,
    validationGames,
    countObservations,
    meanCountNegativeLogLikelihood: countObservations ? round(totalCountNll / countObservations) : null,
    homeMoneylineCalibration: mlForecasts.length ? buildMlbCalibrationReport(mlForecasts) : null,
    nrfiCalibration: nrfiForecasts.length ? buildMlbCalibrationReport(nrfiForecasts) : null,
  };
}

export function buildMlbHistoricalOutOfSampleReport(
  observations: MlbHistoricalHorizonObservation[],
  options: {
    minimumTrainingDates?: number;
    validationDateCount?: number;
    stepDateCount?: number;
    minimumTotalValidationGames?: number;
    generatedAt?: string;
  } = {},
): MlbHistoricalOosReport {
  validateObservationSet(observations);
  const configuration = {
    minimumTrainingDates: options.minimumTrainingDates ?? 60,
    validationDateCount: options.validationDateCount ?? 14,
    stepDateCount: options.stepDateCount ?? 14,
    minimumTotalValidationGames: options.minimumTotalValidationGames ?? 300,
  };
  if (!Number.isInteger(configuration.minimumTotalValidationGames) || configuration.minimumTotalValidationGames <= 0) {
    throw new Error("P1_M6A3B1_INVALID_MINIMUM_VALIDATION_GAMES");
  }

  const horizons: MlbHistoricalHorizonOosReport[] = [];
  for (const horizon of HORIZONS) {
    const rows = observations.filter((row) => row.horizon === horizon)
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    const folds = buildMlbRollingOriginDateFolds(rows, configuration);
    const evaluated = Object.fromEntries(
      FAMILIES.map((family) => [family, evaluateFamily(horizon, rows, family, folds)]),
    ) as Record<MlbHistoricalModelFamily, MlbHistoricalFamilyOosMetrics>;
    const poissonNll = evaluated.POISSON.meanCountNegativeLogLikelihood;
    const nbNll = evaluated.NEGATIVE_BINOMIAL_NB2.meanCountNegativeLogLikelihood;
    const validationGames = Math.min(evaluated.POISSON.validationGames, evaluated.NEGATIVE_BINOMIAL_NB2.validationGames);
    const ready = validationGames >= configuration.minimumTotalValidationGames && folds.length > 0;
    let preferredFamilyByCountNll: MlbHistoricalModelFamily | null = null;
    if (ready && poissonNll != null && nbNll != null) {
      preferredFamilyByCountNll = nbNll < poissonNll ? "NEGATIVE_BINOMIAL_NB2" : "POISSON";
    }
    horizons.push({
      horizon,
      observations: rows.length,
      uniqueDates: new Set(rows.map((row) => row.officialDate)).size,
      status: ready ? "READY_FOR_RESEARCH_REVIEW" : "INSUFFICIENT_OOS_SAMPLE",
      candidates: evaluated,
      preferredFamilyByCountNll,
      countNllDeltaPoissonMinusNb2: poissonNll != null && nbNll != null ? round(poissonNll - nbNll) : null,
      actionabilityAllowed: false,
      blockers: ready
        ? ["P1_M6A3B1_BASELINE_ONLY", "P1_M6A3B2_COVARIATE_MODEL_REQUIRED", "NO_AUTOMATIC_FAMILY_PROMOTION"]
        : ["P1_M6A3B1_INSUFFICIENT_OOS_SAMPLE", "P1_M6A3B2_COVARIATE_MODEL_REQUIRED"],
    });
  }

  return {
    schemaVersion: MLB_P1_M6A3B1_FIT_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration,
    horizons,
    allFoldsLeakageFree: horizons.every((horizon) => FAMILIES.every((family) => horizon.candidates[family].folds.every((fold) => fold.leakageFree))),
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    blockers: [
      "P1_M6A3B1_BASELINE_ONLY",
      "P1_M6A3B2_COVARIATE_MODEL_REQUIRED",
      "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE",
    ],
  };
}
