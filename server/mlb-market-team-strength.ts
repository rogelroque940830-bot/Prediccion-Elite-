import crypto from "node:crypto";
import {
  buildMlbCalibrationReport,
  type MlbCalibrationObservation,
  type MlbCalibrationReport,
} from "./mlb-market-calibration";
import {
  buildMlbHorizonRunDistribution,
  evaluateMlbExactMarketProbability,
} from "./mlb-market-run-distribution";
import type { MlbProbabilityHorizon, MlbMarketOutcome } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
import {
  buildMlbRollingOriginDateFolds,
  fitMlbMarginalRunModel,
  type MlbMarginalRunFit,
} from "./mlb-market-historical-fit";

export const MLB_P1_M6A3B2A_SCHEMA = "courtedge-p1-m6a3b2a-team-strength-oos.v1" as const;
export const MLB_P1_M6A3B2A_MODEL = "NB2_TEAM_ATTACK_DEFENSE_SHRINKAGE" as const;

const LOG_EPS = 1e-15;
const DEFAULT_PRIOR_GRID = [5, 10, 20, 40, 80] as const;
const DEFAULT_INNER_VALIDATION_DATES = 14;
const DEFAULT_MINIMUM_INNER_HISTORY_DATES = 30;
const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];

export interface MlbTeamStrengthEstimate {
  teamId: number;
  games: number;
  homeGames: number;
  awayGames: number;
  runsScored: number;
  runsAllowed: number;
  expectedRunsScoredAtLeagueBaseline: number;
  expectedRunsAllowedAtLeagueBaseline: number;
  offenseFactor: number;
  defenseWeaknessFactor: number;
}

export interface MlbTeamStrengthSnapshot {
  schemaVersion: typeof MLB_P1_M6A3B2A_SCHEMA;
  model: typeof MLB_P1_M6A3B2A_MODEL;
  horizon: MlbProbabilityHorizon;
  priorGames: number;
  trainingGames: number;
  trainingDates: number;
  trainingMinDate: string;
  trainingMaxDate: string;
  leagueHomeMean: number;
  leagueAwayMean: number;
  leagueOverallMean: number;
  teams: Record<string, MlbTeamStrengthEstimate>;
  snapshotDigest: string;
  actionabilityAllowed: false;
}

export interface MlbTeamRunMeanPrediction {
  homeMeanRuns: number;
  awayMeanRuns: number;
  homeOffenseFactor: number;
  homeDefenseWeaknessFactor: number;
  awayOffenseFactor: number;
  awayDefenseWeaknessFactor: number;
  homeTeamSeen: boolean;
  awayTeamSeen: boolean;
}

export interface MlbNestedPriorScore {
  priorGames: number;
  validationGames: number;
  meanCountNegativeLogLikelihood: number;
}

export interface MlbNestedPriorSelection {
  selectedPriorGames: number;
  candidates: MlbNestedPriorScore[];
  innerHistoryDates: number;
  innerValidationDates: number;
  innerHistoryMaxDate: string;
  innerValidationMinDate: string;
  leakageFree: true;
}

export interface MlbTeamStrengthFoldMetric {
  foldIndex: number;
  trainingGames: number;
  validationGames: number;
  trainingDates: number;
  validationDates: number;
  trainingMaxDate: string;
  validationMinDate: string;
  validationMaxDate: string;
  leakageFree: true;
  selectedPriorGames: number;
  nestedPriorSelection: MlbNestedPriorSelection;
  homeDispersionK: number;
  awayDispersionK: number;
  baselineCountNegativeLogLikelihood: number;
  challengerCountNegativeLogLikelihood: number;
  baselineMinusChallengerCountNll: number;
  bothTeamsSeenValidationGames: number;
  unseenTeamValidationGames: number;
}

export interface MlbTeamStrengthHorizonReport {
  horizon: MlbProbabilityHorizon;
  observations: number;
  uniqueDates: number;
  validationGames: number;
  countObservations: number;
  status: "OOS_IMPROVEMENT" | "NO_OOS_IMPROVEMENT" | "INSUFFICIENT_OOS_SAMPLE";
  baselineNb2CountNegativeLogLikelihood: number | null;
  challengerCountNegativeLogLikelihood: number | null;
  baselineMinusChallengerCountNll: number | null;
  relativeCountNllReductionPct: number | null;
  baselineHomeMoneylineCalibration: MlbCalibrationReport | null;
  challengerHomeMoneylineCalibration: MlbCalibrationReport | null;
  baselineNrfiCalibration: MlbCalibrationReport | null;
  challengerNrfiCalibration: MlbCalibrationReport | null;
  folds: MlbTeamStrengthFoldMetric[];
  actionabilityAllowed: false;
  automaticPromotionAllowed: false;
  blockers: string[];
}

export interface MlbTeamStrengthOosReport {
  schemaVersion: typeof MLB_P1_M6A3B2A_SCHEMA;
  model: typeof MLB_P1_M6A3B2A_MODEL;
  generatedAt: string;
  configuration: {
    minimumTrainingDates: number;
    validationDateCount: number;
    stepDateCount: number;
    minimumTotalValidationGames: number;
    priorGamesGrid: number[];
    innerValidationDateCount: number;
    minimumInnerHistoryDates: number;
  };
  horizons: MlbTeamStrengthHorizonReport[];
  allFoldsLeakageFree: boolean;
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  automaticPromotionAllowed: false;
  blockers: [
    "P1_M6A3B2A_TEAM_STRENGTH_CHALLENGER_ONLY",
    "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED",
    "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE"
  ];
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validRows(rows: MlbHistoricalHorizonObservation[]): void {
  if (!rows.length) throw new Error("P1_M6A3B2A_EMPTY_SAMPLE");
  const horizon = rows[0].horizon;
  for (const row of rows) {
    if (row.horizon !== horizon) throw new Error("P1_M6A3B2A_MIXED_HORIZONS");
    if (!Number.isInteger(row.homeTeamId) || row.homeTeamId <= 0
      || !Number.isInteger(row.awayTeamId) || row.awayTeamId <= 0
      || row.homeTeamId === row.awayTeamId
      || !Number.isInteger(row.homeRuns) || row.homeRuns < 0
      || !Number.isInteger(row.awayRuns) || row.awayRuns < 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.officialDate)) {
      throw new Error("P1_M6A3B2A_INVALID_OBSERVATION");
    }
    if (row.horizon === "FULL_GAME" && row.homeRuns === row.awayRuns) {
      throw new Error("P1_M6A3B2A_FULL_GAME_TIE_OBSERVATION");
    }
  }
}

function validatePriorGrid(grid: number[]): number[] {
  if (!grid.length) throw new Error("P1_M6A3B2A_EMPTY_PRIOR_GRID");
  const unique = [...new Set(grid)];
  if (unique.some((value) => !Number.isInteger(value) || value <= 0 || value > 500)) {
    throw new Error("P1_M6A3B2A_INVALID_PRIOR_GRID");
  }
  return unique.sort((a, b) => a - b);
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface MutableTeamAggregate {
  teamId: number;
  games: number;
  homeGames: number;
  awayGames: number;
  runsScored: number;
  runsAllowed: number;
}

function aggregateTeams(rows: MlbHistoricalHorizonObservation[]): Map<number, MutableTeamAggregate> {
  const map = new Map<number, MutableTeamAggregate>();
  const team = (teamId: number) => {
    let value = map.get(teamId);
    if (!value) {
      value = { teamId, games: 0, homeGames: 0, awayGames: 0, runsScored: 0, runsAllowed: 0 };
      map.set(teamId, value);
    }
    return value;
  };

  for (const row of rows) {
    const home = team(row.homeTeamId);
    home.games += 1;
    home.homeGames += 1;
    home.runsScored += row.homeRuns;
    home.runsAllowed += row.awayRuns;

    const away = team(row.awayTeamId);
    away.games += 1;
    away.awayGames += 1;
    away.runsScored += row.awayRuns;
    away.runsAllowed += row.homeRuns;
  }
  return map;
}

export function buildMlbTeamStrengthSnapshot(
  rows: MlbHistoricalHorizonObservation[],
  priorGames: number,
): MlbTeamStrengthSnapshot {
  validRows(rows);
  if (!Number.isInteger(priorGames) || priorGames <= 0 || priorGames > 500) {
    throw new Error("P1_M6A3B2A_INVALID_PRIOR_GAMES");
  }
  const horizon = rows[0].horizon;
  const dates = [...new Set(rows.map((row) => row.officialDate))].sort();
  const leagueHomeMean = rows.reduce((sum, row) => sum + row.homeRuns, 0) / rows.length;
  const leagueAwayMean = rows.reduce((sum, row) => sum + row.awayRuns, 0) / rows.length;
  const leagueOverallMean = (leagueHomeMean + leagueAwayMean) / 2;
  const aggregates = aggregateTeams(rows);
  const teams: Record<string, MlbTeamStrengthEstimate> = {};

  for (const aggregate of [...aggregates.values()].sort((a, b) => a.teamId - b.teamId)) {
    const expectedRunsScoredAtLeagueBaseline =
      aggregate.homeGames * leagueHomeMean + aggregate.awayGames * leagueAwayMean;
    const expectedRunsAllowedAtLeagueBaseline =
      aggregate.homeGames * leagueAwayMean + aggregate.awayGames * leagueHomeMean;
    const priorRuns = priorGames * leagueOverallMean;

    let offenseFactor = 1;
    let defenseWeaknessFactor = 1;
    if (leagueOverallMean > 0) {
      const offenseDenominator = expectedRunsScoredAtLeagueBaseline + priorRuns;
      const defenseDenominator = expectedRunsAllowedAtLeagueBaseline + priorRuns;
      offenseFactor = offenseDenominator > 0
        ? (aggregate.runsScored + priorRuns) / offenseDenominator
        : 1;
      defenseWeaknessFactor = defenseDenominator > 0
        ? (aggregate.runsAllowed + priorRuns) / defenseDenominator
        : 1;
    }
    if (!(offenseFactor > 0) || !Number.isFinite(offenseFactor)
      || !(defenseWeaknessFactor > 0) || !Number.isFinite(defenseWeaknessFactor)) {
      throw new Error("P1_M6A3B2A_INVALID_TEAM_FACTOR");
    }

    teams[String(aggregate.teamId)] = {
      teamId: aggregate.teamId,
      games: aggregate.games,
      homeGames: aggregate.homeGames,
      awayGames: aggregate.awayGames,
      runsScored: aggregate.runsScored,
      runsAllowed: aggregate.runsAllowed,
      expectedRunsScoredAtLeagueBaseline: round(expectedRunsScoredAtLeagueBaseline),
      expectedRunsAllowedAtLeagueBaseline: round(expectedRunsAllowedAtLeagueBaseline),
      offenseFactor: round(offenseFactor, 10),
      defenseWeaknessFactor: round(defenseWeaknessFactor, 10),
    };
  }

  const snapshotWithoutDigest = {
    schemaVersion: MLB_P1_M6A3B2A_SCHEMA,
    model: MLB_P1_M6A3B2A_MODEL,
    horizon,
    priorGames,
    trainingGames: rows.length,
    trainingDates: dates.length,
    trainingMinDate: dates[0],
    trainingMaxDate: dates.at(-1) as string,
    leagueHomeMean: round(leagueHomeMean, 10),
    leagueAwayMean: round(leagueAwayMean, 10),
    leagueOverallMean: round(leagueOverallMean, 10),
    teams,
    actionabilityAllowed: false as const,
  };

  return {
    ...snapshotWithoutDigest,
    snapshotDigest: digest(snapshotWithoutDigest),
  };
}

export function predictMlbTeamRunMeans(
  snapshot: MlbTeamStrengthSnapshot,
  row: Pick<MlbHistoricalHorizonObservation, "horizon" | "homeTeamId" | "awayTeamId">,
): MlbTeamRunMeanPrediction {
  if (row.horizon !== snapshot.horizon) throw new Error("P1_M6A3B2A_HORIZON_MISMATCH");
  const home = snapshot.teams[String(row.homeTeamId)] ?? null;
  const away = snapshot.teams[String(row.awayTeamId)] ?? null;
  const homeOffenseFactor = home?.offenseFactor ?? 1;
  const homeDefenseWeaknessFactor = home?.defenseWeaknessFactor ?? 1;
  const awayOffenseFactor = away?.offenseFactor ?? 1;
  const awayDefenseWeaknessFactor = away?.defenseWeaknessFactor ?? 1;
  const homeMeanRuns = snapshot.leagueHomeMean * homeOffenseFactor * awayDefenseWeaknessFactor;
  const awayMeanRuns = snapshot.leagueAwayMean * awayOffenseFactor * homeDefenseWeaknessFactor;

  if (!Number.isFinite(homeMeanRuns) || homeMeanRuns < 0 || !Number.isFinite(awayMeanRuns) || awayMeanRuns < 0) {
    throw new Error("P1_M6A3B2A_INVALID_EXPECTED_RUNS");
  }

  return {
    homeMeanRuns: round(homeMeanRuns, 10),
    awayMeanRuns: round(awayMeanRuns, 10),
    homeOffenseFactor,
    homeDefenseWeaknessFactor,
    awayOffenseFactor,
    awayDefenseWeaknessFactor,
    homeTeamSeen: home != null,
    awayTeamSeen: away != null,
  };
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

export function mlbNb2LogPmf(runs: number, meanRuns: number, dispersionK: number): number {
  if (!Number.isInteger(runs) || runs < 0 || !Number.isFinite(meanRuns) || meanRuns < 0
    || !Number.isFinite(dispersionK) || dispersionK <= 0) {
    throw new Error("P1_M6A3B2A_INVALID_NB2_ARGUMENT");
  }
  if (meanRuns === 0) return runs === 0 ? 0 : Number.NEGATIVE_INFINITY;
  return logGamma(runs + dispersionK) - logGamma(dispersionK) - logGamma(runs + 1)
    + dispersionK * Math.log(dispersionK / (dispersionK + meanRuns))
    + runs * Math.log(meanRuns / (dispersionK + meanRuns));
}

function rowCountNll(
  row: MlbHistoricalHorizonObservation,
  homeMean: number,
  awayMean: number,
  homeK: number,
  awayK: number,
): number {
  const homeLogP = mlbNb2LogPmf(row.homeRuns, homeMean, homeK);
  const awayLogP = mlbNb2LogPmf(row.awayRuns, awayMean, awayK);
  return -Math.max(Math.log(LOG_EPS), homeLogP) - Math.max(Math.log(LOG_EPS), awayLogP);
}

function requireNb2Dispersion(fit: MlbMarginalRunFit): number {
  if (fit.family !== "NEGATIVE_BINOMIAL_NB2" || !(fit.dispersionK != null && fit.dispersionK > 0)) {
    throw new Error("P1_M6A3B2A_NB2_DISPERSION_REQUIRED");
  }
  return fit.dispersionK;
}

function materializeByDates(
  rows: MlbHistoricalHorizonObservation[],
  dates: string[],
): MlbHistoricalHorizonObservation[] {
  const allowed = new Set(dates);
  return rows.filter((row) => allowed.has(row.officialDate));
}

function evaluateTeamSnapshotCountNll(
  snapshot: MlbTeamStrengthSnapshot,
  validation: MlbHistoricalHorizonObservation[],
  homeK: number,
  awayK: number,
): number {
  if (!validation.length) throw new Error("P1_M6A3B2A_EMPTY_VALIDATION_SAMPLE");
  let total = 0;
  for (const row of validation) {
    const prediction = predictMlbTeamRunMeans(snapshot, row);
    total += rowCountNll(row, prediction.homeMeanRuns, prediction.awayMeanRuns, homeK, awayK);
  }
  return total / (validation.length * 2);
}

export function selectMlbTeamPriorGamesNested(
  trainingRows: MlbHistoricalHorizonObservation[],
  options: {
    priorGamesGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
  } = {},
): MlbNestedPriorSelection {
  validRows(trainingRows);
  const priorGamesGrid = validatePriorGrid(options.priorGamesGrid ?? [...DEFAULT_PRIOR_GRID]);
  const innerValidationDateCount = options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES;
  const minimumInnerHistoryDates = options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES;
  if (!Number.isInteger(innerValidationDateCount) || innerValidationDateCount <= 0
    || !Number.isInteger(minimumInnerHistoryDates) || minimumInnerHistoryDates <= 0) {
    throw new Error("P1_M6A3B2A_INVALID_INNER_VALIDATION_CONFIGURATION");
  }

  const dates = [...new Set(trainingRows.map((row) => row.officialDate))].sort();
  if (dates.length < minimumInnerHistoryDates + innerValidationDateCount) {
    throw new Error("P1_M6A3B2A_INSUFFICIENT_INNER_HISTORY");
  }
  const innerValidationDates = dates.slice(-innerValidationDateCount);
  const innerHistoryDates = dates.slice(0, -innerValidationDateCount);
  const innerHistory = materializeByDates(trainingRows, innerHistoryDates);
  const innerValidation = materializeByDates(trainingRows, innerValidationDates);
  const homeFit = fitMlbMarginalRunModel(innerHistory.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
  const awayFit = fitMlbMarginalRunModel(innerHistory.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
  const homeK = requireNb2Dispersion(homeFit);
  const awayK = requireNb2Dispersion(awayFit);

  const candidates: MlbNestedPriorScore[] = priorGamesGrid.map((priorGames) => {
    const snapshot = buildMlbTeamStrengthSnapshot(innerHistory, priorGames);
    return {
      priorGames,
      validationGames: innerValidation.length,
      meanCountNegativeLogLikelihood: round(evaluateTeamSnapshotCountNll(
        snapshot,
        innerValidation,
        homeK,
        awayK,
      )),
    };
  });

  let selected = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const delta = candidate.meanCountNegativeLogLikelihood - selected.meanCountNegativeLogLikelihood;
    if (delta < -1e-10 || (Math.abs(delta) <= 1e-10 && candidate.priorGames > selected.priorGames)) {
      selected = candidate;
    }
  }

  const innerHistoryMaxDate = innerHistoryDates.at(-1) as string;
  const innerValidationMinDate = innerValidationDates[0];
  if (!(innerHistoryMaxDate < innerValidationMinDate)) {
    throw new Error("P1_M6A3B2A_INNER_TIME_LEAKAGE_DETECTED");
  }

  return {
    selectedPriorGames: selected.priorGames,
    candidates,
    innerHistoryDates: innerHistoryDates.length,
    innerValidationDates: innerValidationDates.length,
    innerHistoryMaxDate,
    innerValidationMinDate,
    leakageFree: true,
  };
}

function moneylineMarketType(horizon: MlbProbabilityHorizon): "INNING_1_ML" | "F3_ML" | "F5_ML" | "ML" {
  if (horizon === "FIRST_INNING") return "INNING_1_ML";
  if (horizon === "FIRST_3") return "F3_ML";
  if (horizon === "FIRST_5") return "F5_ML";
  return "ML";
}

function observedMlOutcome(row: MlbHistoricalHorizonObservation): MlbMarketOutcome {
  if (row.homeRuns > row.awayRuns) return "WIN";
  if (row.homeRuns < row.awayRuns) return "LOSS";
  return "PUSH";
}

function probabilityVector(
  horizon: MlbProbabilityHorizon,
  homeMean: number,
  awayMean: number,
  homeK: number,
  awayK: number,
  sourceDigest: string,
): { moneyline: Record<MlbMarketOutcome, number>; nrfi: Record<MlbMarketOutcome, number> | null } {
  const distribution = buildMlbHorizonRunDistribution({
    horizon,
    home: {
      meanRuns: homeMean,
      dispersionK: homeK,
      sourceVersion: MLB_P1_M6A3B2A_SCHEMA,
      sourceDigest,
    },
    away: {
      meanRuns: awayMean,
      dispersionK: awayK,
      sourceVersion: MLB_P1_M6A3B2A_SCHEMA,
      sourceDigest,
    },
  });
  const ml = evaluateMlbExactMarketProbability(distribution, {
    marketType: moneylineMarketType(horizon),
    side: "HOME",
  });
  if (ml.status !== "OK" || !ml.probabilities) throw new Error("P1_M6A3B2A_MONEYLINE_PROBABILITY_FAILED");

  let nrfi: Record<MlbMarketOutcome, number> | null = null;
  if (horizon === "FIRST_INNING") {
    const result = evaluateMlbExactMarketProbability(distribution, { marketType: "NRFI", side: "NRFI" });
    if (result.status !== "OK" || !result.probabilities) throw new Error("P1_M6A3B2A_NRFI_PROBABILITY_FAILED");
    nrfi = result.probabilities;
  }
  return { moneyline: ml.probabilities, nrfi };
}

function calibrationOrNull(observations: MlbCalibrationObservation[]): MlbCalibrationReport | null {
  return observations.length ? buildMlbCalibrationReport(observations) : null;
}

export function buildMlbTeamStrengthOosReport(
  observations: MlbHistoricalHorizonObservation[],
  options: {
    minimumTrainingDates?: number;
    validationDateCount?: number;
    stepDateCount?: number;
    minimumTotalValidationGames?: number;
    priorGamesGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
    generatedAt?: string;
  } = {},
): MlbTeamStrengthOosReport {
  if (!observations.length) throw new Error("P1_M6A3B2A_EMPTY_SAMPLE");
  const configuration = {
    minimumTrainingDates: options.minimumTrainingDates ?? 60,
    validationDateCount: options.validationDateCount ?? 14,
    stepDateCount: options.stepDateCount ?? 14,
    minimumTotalValidationGames: options.minimumTotalValidationGames ?? 300,
    priorGamesGrid: validatePriorGrid(options.priorGamesGrid ?? [...DEFAULT_PRIOR_GRID]),
    innerValidationDateCount: options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES,
    minimumInnerHistoryDates: options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES,
  };
  if (!Number.isInteger(configuration.minimumTotalValidationGames) || configuration.minimumTotalValidationGames <= 0) {
    throw new Error("P1_M6A3B2A_INVALID_MINIMUM_VALIDATION_GAMES");
  }

  const horizons: MlbTeamStrengthHorizonReport[] = [];
  for (const horizon of HORIZONS) {
    const rows = observations.filter((row) => row.horizon === horizon)
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    if (!rows.length) {
      horizons.push({
        horizon,
        observations: 0,
        uniqueDates: 0,
        validationGames: 0,
        countObservations: 0,
        status: "INSUFFICIENT_OOS_SAMPLE",
        baselineNb2CountNegativeLogLikelihood: null,
        challengerCountNegativeLogLikelihood: null,
        baselineMinusChallengerCountNll: null,
        relativeCountNllReductionPct: null,
        baselineHomeMoneylineCalibration: null,
        challengerHomeMoneylineCalibration: null,
        baselineNrfiCalibration: null,
        challengerNrfiCalibration: null,
        folds: [],
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
        blockers: ["P1_M6A3B2A_INSUFFICIENT_OOS_SAMPLE"],
      });
      continue;
    }
    validRows(rows);
    const folds = buildMlbRollingOriginDateFolds(rows, configuration);
    const foldMetrics: MlbTeamStrengthFoldMetric[] = [];
    const baselineMl: MlbCalibrationObservation[] = [];
    const challengerMl: MlbCalibrationObservation[] = [];
    const baselineNrfi: MlbCalibrationObservation[] = [];
    const challengerNrfi: MlbCalibrationObservation[] = [];
    let baselineNllTotal = 0;
    let challengerNllTotal = 0;
    let countObservations = 0;
    let validationGames = 0;

    for (const fold of folds) {
      const training = materializeByDates(rows, fold.trainingDates);
      const validation = materializeByDates(rows, fold.validationDates);
      if (!training.length || !validation.length) continue;
      if (!(fold.trainingMaxDate < fold.validationMinDate)) throw new Error("P1_M6A3B2A_OUTER_TIME_LEAKAGE_DETECTED");

      const nestedPriorSelection = selectMlbTeamPriorGamesNested(training, {
        priorGamesGrid: configuration.priorGamesGrid,
        innerValidationDateCount: configuration.innerValidationDateCount,
        minimumInnerHistoryDates: configuration.minimumInnerHistoryDates,
      });
      const snapshot = buildMlbTeamStrengthSnapshot(training, nestedPriorSelection.selectedPriorGames);
      const homeFit = fitMlbMarginalRunModel(training.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
      const awayFit = fitMlbMarginalRunModel(training.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
      const homeK = requireNb2Dispersion(homeFit);
      const awayK = requireNb2Dispersion(awayFit);

      let foldBaselineNll = 0;
      let foldChallengerNll = 0;
      let bothTeamsSeenValidationGames = 0;
      let unseenTeamValidationGames = 0;

      for (const row of validation) {
        const prediction = predictMlbTeamRunMeans(snapshot, row);
        if (prediction.homeTeamSeen && prediction.awayTeamSeen) bothTeamsSeenValidationGames += 1;
        else unseenTeamValidationGames += 1;

        const baselineRowNll = rowCountNll(row, homeFit.meanRuns, awayFit.meanRuns, homeK, awayK);
        const challengerRowNll = rowCountNll(row, prediction.homeMeanRuns, prediction.awayMeanRuns, homeK, awayK);
        foldBaselineNll += baselineRowNll;
        foldChallengerNll += challengerRowNll;
        baselineNllTotal += baselineRowNll;
        challengerNllTotal += challengerRowNll;
        countObservations += 2;

        const observed = observedMlOutcome(row);
        const baselineProbability = probabilityVector(
          horizon,
          homeFit.meanRuns,
          awayFit.meanRuns,
          homeK,
          awayK,
          digest({ kind: "baseline", fold: fold.foldIndex, horizon, gamePk: row.gamePk }),
        );
        const challengerProbability = probabilityVector(
          horizon,
          prediction.homeMeanRuns,
          prediction.awayMeanRuns,
          homeK,
          awayK,
          digest({ snapshot: snapshot.snapshotDigest, gamePk: row.gamePk }),
        );
        baselineMl.push({
          id: `BASELINE:${horizon}:${fold.foldIndex}:${row.gamePk}:HOME_ML`,
          probabilities: baselineProbability.moneyline,
          outcome: observed,
        });
        challengerMl.push({
          id: `TEAM:${horizon}:${fold.foldIndex}:${row.gamePk}:HOME_ML`,
          probabilities: challengerProbability.moneyline,
          outcome: observed,
        });
        if (horizon === "FIRST_INNING") {
          if (!baselineProbability.nrfi || !challengerProbability.nrfi) throw new Error("P1_M6A3B2A_NRFI_PROBABILITY_FAILED");
          const nrfiOutcome: MlbMarketOutcome = row.totalRuns === 0 ? "WIN" : "LOSS";
          baselineNrfi.push({
            id: `BASELINE:${horizon}:${fold.foldIndex}:${row.gamePk}:NRFI`,
            probabilities: baselineProbability.nrfi,
            outcome: nrfiOutcome,
          });
          challengerNrfi.push({
            id: `TEAM:${horizon}:${fold.foldIndex}:${row.gamePk}:NRFI`,
            probabilities: challengerProbability.nrfi,
            outcome: nrfiOutcome,
          });
        }
      }

      validationGames += validation.length;
      const foldDenominator = validation.length * 2;
      foldMetrics.push({
        foldIndex: fold.foldIndex,
        trainingGames: training.length,
        validationGames: validation.length,
        trainingDates: fold.trainingDates.length,
        validationDates: fold.validationDates.length,
        trainingMaxDate: fold.trainingMaxDate,
        validationMinDate: fold.validationMinDate,
        validationMaxDate: fold.validationMaxDate,
        leakageFree: true,
        selectedPriorGames: nestedPriorSelection.selectedPriorGames,
        nestedPriorSelection,
        homeDispersionK: homeK,
        awayDispersionK: awayK,
        baselineCountNegativeLogLikelihood: round(foldBaselineNll / foldDenominator),
        challengerCountNegativeLogLikelihood: round(foldChallengerNll / foldDenominator),
        baselineMinusChallengerCountNll: round((foldBaselineNll - foldChallengerNll) / foldDenominator),
        bothTeamsSeenValidationGames,
        unseenTeamValidationGames,
      });
    }

    const ready = validationGames >= configuration.minimumTotalValidationGames && countObservations > 0;
    const baselineNll = countObservations ? baselineNllTotal / countObservations : null;
    const challengerNll = countObservations ? challengerNllTotal / countObservations : null;
    const delta = baselineNll != null && challengerNll != null ? baselineNll - challengerNll : null;
    const relative = baselineNll != null && baselineNll > 0 && delta != null ? (delta / baselineNll) * 100 : null;
    const improved = ready && delta != null && delta > 0;

    horizons.push({
      horizon,
      observations: rows.length,
      uniqueDates: new Set(rows.map((row) => row.officialDate)).size,
      validationGames,
      countObservations,
      status: !ready ? "INSUFFICIENT_OOS_SAMPLE" : improved ? "OOS_IMPROVEMENT" : "NO_OOS_IMPROVEMENT",
      baselineNb2CountNegativeLogLikelihood: baselineNll == null ? null : round(baselineNll),
      challengerCountNegativeLogLikelihood: challengerNll == null ? null : round(challengerNll),
      baselineMinusChallengerCountNll: delta == null ? null : round(delta),
      relativeCountNllReductionPct: relative == null ? null : round(relative, 6),
      baselineHomeMoneylineCalibration: calibrationOrNull(baselineMl),
      challengerHomeMoneylineCalibration: calibrationOrNull(challengerMl),
      baselineNrfiCalibration: calibrationOrNull(baselineNrfi),
      challengerNrfiCalibration: calibrationOrNull(challengerNrfi),
      folds: foldMetrics,
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
      blockers: !ready
        ? ["P1_M6A3B2A_INSUFFICIENT_OOS_SAMPLE", "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED"]
        : improved
          ? ["P1_M6A3B2A_RESEARCH_IMPROVEMENT_ONLY", "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED", "NO_AUTOMATIC_PROMOTION"]
          : ["P1_M6A3B2A_TEAM_FEATURE_DID_NOT_IMPROVE_COUNT_NLL", "NO_AUTOMATIC_PROMOTION"],
    });
  }

  return {
    schemaVersion: MLB_P1_M6A3B2A_SCHEMA,
    model: MLB_P1_M6A3B2A_MODEL,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration,
    horizons,
    allFoldsLeakageFree: horizons.every((horizon) => horizon.folds.every((fold) =>
      fold.leakageFree && fold.nestedPriorSelection.leakageFree && fold.trainingMaxDate < fold.validationMinDate)),
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2A_TEAM_STRENGTH_CHALLENGER_ONLY",
      "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED",
      "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE",
    ],
  };
}
