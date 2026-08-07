import crypto from "node:crypto";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
import type {
  MlbHistoricalStartingPitcherGame,
  MlbHistoricalStartingPitcherLine,
} from "./mlb-market-starting-pitcher-history";
import {
  buildMlbRollingOriginDateFolds,
  fitMlbMarginalRunModel,
  type MlbMarginalRunFit,
} from "./mlb-market-historical-fit";
import {
  buildMlbTeamStrengthSnapshot,
  mlbNb2LogPmf,
  predictMlbTeamRunMeans,
} from "./mlb-market-team-strength";

export const MLB_P1_M6A3B2B2_SCHEMA = "courtedge-p1-m6a3b2b2-starting-pitcher-asof-oos.v1" as const;
export const MLB_P1_M6A3B2B2_MODEL = "NB2_TEAM_PLUS_STARTER_ER_PER_BF_SHRINKAGE" as const;

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];
const DEFAULT_TEAM_PRIOR_GRID = [5, 10, 20, 40, 80] as const;
const DEFAULT_PITCHER_PRIOR_BATTERS_GRID = [18, 36, 72, 144, 288] as const;
const DEFAULT_PITCHER_EFFECT_GRID = [0, 0.25, 0.5, 0.75, 1] as const;
const DEFAULT_INNER_VALIDATION_DATES = 14;
const DEFAULT_MINIMUM_INNER_HISTORY_DATES = 30;
const LOG_EPS = 1e-15;

export interface MlbPitcherStrengthEstimate {
  pitcherId: number;
  starts: number;
  battersFaced: number;
  earnedRuns: number;
  earnedRunsPerBatterFaced: number;
  shrunkEarnedRunsPerBatterFaced: number;
  runRiskFactor: number;
  historyMinDate: string;
  historyMaxDate: string;
}

export interface MlbPitcherAsOfSnapshot {
  schemaVersion: typeof MLB_P1_M6A3B2B2_SCHEMA;
  model: typeof MLB_P1_M6A3B2B2_MODEL;
  cutoffDateExclusive: string;
  priorBatters: number;
  eligibleStarterLines: number;
  eligibleBattersFaced: number;
  leagueEarnedRuns: number;
  leagueEarnedRunsPerBatterFaced: number;
  historyMinDate: string;
  historyMaxDate: string;
  pitchers: Record<string, MlbPitcherStrengthEstimate>;
  snapshotDigest: string;
  actionabilityAllowed: false;
}

export interface MlbTeamPlusPitcherPrediction {
  homeMeanRuns: number;
  awayMeanRuns: number;
  homeStarterId: number;
  awayStarterId: number;
  homeStarterRiskFactor: number;
  awayStarterRiskFactor: number;
  homeStarterSeen: boolean;
  awayStarterSeen: boolean;
  pitcherEffectWeight: number;
}

export interface MlbPitcherHyperparameterScore {
  teamPriorGames: number;
  pitcherPriorBatters: number;
  pitcherEffectWeight: number;
  validationGames: number;
  meanCountNegativeLogLikelihood: number;
}

export interface MlbPitcherNestedSelection {
  selectedTeamPriorGames: number;
  selectedPitcherPriorBatters: number;
  selectedPitcherEffectWeight: number;
  candidates: MlbPitcherHyperparameterScore[];
  innerHistoryDates: number;
  innerValidationDates: number;
  innerHistoryMaxDate: string;
  innerValidationMinDate: string;
  pitcherSnapshotHistoryMaxDate: string;
  leakageFree: true;
}

export interface MlbStartingPitcherPairedRow {
  horizon: MlbProbabilityHorizon;
  foldIndex: number;
  gamePk: number;
  officialDate: string;
  leagueNb2CountNll: number;
  teamOnlyCountNll: number;
  teamPlusPitcherCountNll: number;
  teamMinusPitcherCountNll: number;
  leagueMinusPitcherCountNll: number;
}

export interface MlbStartingPitcherFoldMetric {
  foldIndex: number;
  trainingGames: number;
  validationGames: number;
  trainingDates: number;
  validationDates: number;
  trainingMaxDate: string;
  validationMinDate: string;
  validationMaxDate: string;
  selectedTeamPriorGames: number;
  selectedPitcherPriorBatters: number;
  selectedPitcherEffectWeight: number;
  nestedSelection: MlbPitcherNestedSelection;
  pitcherSnapshotHistoryMaxDate: string;
  homeDispersionK: number;
  awayDispersionK: number;
  leagueNb2CountNegativeLogLikelihood: number;
  teamOnlyCountNegativeLogLikelihood: number;
  teamPlusPitcherCountNegativeLogLikelihood: number;
  teamMinusPitcherCountNll: number;
  leagueMinusPitcherCountNll: number;
  bothPitchersSeenValidationGames: number;
  onePitcherUnseenValidationGames: number;
  bothPitchersUnseenValidationGames: number;
  leakageFree: true;
}

export interface MlbStartingPitcherHorizonReport {
  horizon: MlbProbabilityHorizon;
  observations: number;
  uniqueDates: number;
  validationGames: number;
  status: "PITCHER_OOS_IMPROVEMENT_OVER_TEAM" | "NO_PITCHER_OOS_IMPROVEMENT" | "INSUFFICIENT_OOS_SAMPLE";
  leagueNb2CountNegativeLogLikelihood: number | null;
  teamOnlyCountNegativeLogLikelihood: number | null;
  teamPlusPitcherCountNegativeLogLikelihood: number | null;
  teamMinusPitcherCountNll: number | null;
  leagueMinusPitcherCountNll: number | null;
  relativePitcherReductionVsTeamPct: number | null;
  folds: MlbStartingPitcherFoldMetric[];
  pairedRows: MlbStartingPitcherPairedRow[];
  actionabilityAllowed: false;
  automaticPromotionAllowed: false;
  blockers: string[];
}

export interface MlbStartingPitcherOosReport {
  schemaVersion: typeof MLB_P1_M6A3B2B2_SCHEMA;
  model: typeof MLB_P1_M6A3B2B2_MODEL;
  generatedAt: string;
  configuration: {
    minimumTrainingDates: number;
    validationDateCount: number;
    stepDateCount: number;
    minimumTotalValidationGames: number;
    teamPriorGamesGrid: number[];
    pitcherPriorBattersGrid: number[];
    pitcherEffectWeightGrid: number[];
    innerValidationDateCount: number;
    minimumInnerHistoryDates: number;
  };
  horizons: MlbStartingPitcherHorizonReport[];
  allFoldsLeakageFree: boolean;
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  automaticPromotionAllowed: false;
  blockers: [
    "P1_M6A3B2B2_STARTING_PITCHER_CHALLENGER_ONLY",
    "P1_M6A3B2B2_PAIRED_INFERENCE_REQUIRED",
    "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE"
  ];
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validatePositiveIntegerGrid(values: number[], errorCode: string): number[] {
  const unique = [...new Set(values)];
  if (!unique.length || unique.some((value) => !Number.isInteger(value) || value <= 0 || value > 10_000)) {
    throw new Error(errorCode);
  }
  return unique.sort((a, b) => a - b);
}

function validateEffectGrid(values: number[]): number[] {
  const unique = [...new Set(values)];
  if (!unique.length || unique.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("P1_M6A3B2B2_INVALID_EFFECT_GRID");
  }
  return unique.sort((a, b) => a - b);
}

function validateObservations(rows: MlbHistoricalHorizonObservation[]): void {
  if (!rows.length) throw new Error("P1_M6A3B2B2_EMPTY_SAMPLE");
  const horizon = rows[0].horizon;
  for (const row of rows) {
    if (row.horizon !== horizon) throw new Error("P1_M6A3B2B2_MIXED_HORIZONS");
    if (!validIsoDate(row.officialDate)
      || !Number.isInteger(row.gamePk) || row.gamePk <= 0
      || !Number.isInteger(row.homeTeamId) || row.homeTeamId <= 0
      || !Number.isInteger(row.awayTeamId) || row.awayTeamId <= 0
      || row.homeTeamId === row.awayTeamId
      || !Number.isInteger(row.homeRuns) || row.homeRuns < 0
      || !Number.isInteger(row.awayRuns) || row.awayRuns < 0) {
      throw new Error("P1_M6A3B2B2_INVALID_OBSERVATION");
    }
  }
}

function starterLines(games: MlbHistoricalStartingPitcherGame[]): MlbHistoricalStartingPitcherLine[] {
  return games.flatMap((game) => [game.awayStarter, game.homeStarter]);
}

function validHistoricalLineForRate(line: MlbHistoricalStartingPitcherLine): boolean {
  return Number.isInteger(line.pitcherId) && line.pitcherId > 0
    && validIsoDate(line.officialDate)
    && line.battersFaced != null
    && Number.isInteger(line.battersFaced)
    && line.battersFaced > 0
    && Number.isInteger(line.earnedRuns)
    && line.earnedRuns >= 0;
}

export function buildMlbPitcherAsOfSnapshot(
  games: MlbHistoricalStartingPitcherGame[],
  cutoffDateExclusive: string,
  priorBatters: number,
): MlbPitcherAsOfSnapshot {
  if (!validIsoDate(cutoffDateExclusive)) throw new Error("P1_M6A3B2B2_INVALID_CUTOFF_DATE");
  if (!Number.isInteger(priorBatters) || priorBatters <= 0 || priorBatters > 10_000) {
    throw new Error("P1_M6A3B2B2_INVALID_PITCHER_PRIOR_BATTERS");
  }
  const eligible = starterLines(games)
    .filter((line) => line.officialDate < cutoffDateExclusive)
    .filter(validHistoricalLineForRate)
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk || a.side.localeCompare(b.side));
  if (!eligible.length) throw new Error("P1_M6A3B2B2_EMPTY_ASOF_PITCHER_HISTORY");
  const eligibleBattersFaced = eligible.reduce((sum, line) => sum + (line.battersFaced as number), 0);
  const leagueEarnedRuns = eligible.reduce((sum, line) => sum + line.earnedRuns, 0);
  if (!(eligibleBattersFaced > 0) || !(leagueEarnedRuns > 0)) {
    throw new Error("P1_M6A3B2B2_INVALID_LEAGUE_STARTER_RATE");
  }
  const leagueRate = leagueEarnedRuns / eligibleBattersFaced;

  const aggregates = new Map<number, {
    pitcherId: number;
    starts: number;
    battersFaced: number;
    earnedRuns: number;
    minDate: string;
    maxDate: string;
  }>();
  for (const line of eligible) {
    const bf = line.battersFaced as number;
    let aggregate = aggregates.get(line.pitcherId);
    if (!aggregate) {
      aggregate = {
        pitcherId: line.pitcherId,
        starts: 0,
        battersFaced: 0,
        earnedRuns: 0,
        minDate: line.officialDate,
        maxDate: line.officialDate,
      };
      aggregates.set(line.pitcherId, aggregate);
    }
    aggregate.starts += 1;
    aggregate.battersFaced += bf;
    aggregate.earnedRuns += line.earnedRuns;
    if (line.officialDate < aggregate.minDate) aggregate.minDate = line.officialDate;
    if (line.officialDate > aggregate.maxDate) aggregate.maxDate = line.officialDate;
  }

  const pitchers: Record<string, MlbPitcherStrengthEstimate> = {};
  for (const aggregate of [...aggregates.values()].sort((a, b) => a.pitcherId - b.pitcherId)) {
    const rawRate = aggregate.earnedRuns / aggregate.battersFaced;
    const shrunkRate = (aggregate.earnedRuns + priorBatters * leagueRate) / (aggregate.battersFaced + priorBatters);
    const riskFactor = shrunkRate / leagueRate;
    if (!(riskFactor > 0) || !Number.isFinite(riskFactor)) {
      throw new Error("P1_M6A3B2B2_INVALID_PITCHER_RISK_FACTOR");
    }
    pitchers[String(aggregate.pitcherId)] = {
      pitcherId: aggregate.pitcherId,
      starts: aggregate.starts,
      battersFaced: aggregate.battersFaced,
      earnedRuns: aggregate.earnedRuns,
      earnedRunsPerBatterFaced: round(rawRate, 10),
      shrunkEarnedRunsPerBatterFaced: round(shrunkRate, 10),
      runRiskFactor: round(riskFactor, 10),
      historyMinDate: aggregate.minDate,
      historyMaxDate: aggregate.maxDate,
    };
  }

  const historyMinDate = eligible[0].officialDate;
  const historyMaxDate = eligible.at(-1)?.officialDate as string;
  if (!(historyMaxDate < cutoffDateExclusive)) throw new Error("P1_M6A3B2B2_ASOF_TIME_LEAKAGE_DETECTED");
  const withoutDigest = {
    schemaVersion: MLB_P1_M6A3B2B2_SCHEMA,
    model: MLB_P1_M6A3B2B2_MODEL,
    cutoffDateExclusive,
    priorBatters,
    eligibleStarterLines: eligible.length,
    eligibleBattersFaced,
    leagueEarnedRuns,
    leagueEarnedRunsPerBatterFaced: round(leagueRate, 10),
    historyMinDate,
    historyMaxDate,
    pitchers,
    actionabilityAllowed: false as const,
  };
  return { ...withoutDigest, snapshotDigest: digest(withoutDigest) };
}

function starterGameMap(games: MlbHistoricalStartingPitcherGame[]): Map<number, MlbHistoricalStartingPitcherGame> {
  const map = new Map<number, MlbHistoricalStartingPitcherGame>();
  for (const game of games) {
    if (map.has(game.gamePk)) throw new Error("P1_M6A3B2B2_DUPLICATE_STARTER_GAME");
    map.set(game.gamePk, game);
  }
  return map;
}

function requireTargetStarterGame(
  map: Map<number, MlbHistoricalStartingPitcherGame>,
  row: MlbHistoricalHorizonObservation,
): MlbHistoricalStartingPitcherGame {
  const game = map.get(row.gamePk);
  if (!game) throw new Error(`P1_M6A3B2B2_TARGET_STARTER_GAME_MISSING:${row.gamePk}`);
  if (game.officialDate !== row.officialDate
    || game.homeTeamId !== row.homeTeamId
    || game.awayTeamId !== row.awayTeamId
    || game.homeStarter.teamId !== row.homeTeamId
    || game.awayStarter.teamId !== row.awayTeamId) {
    throw new Error(`P1_M6A3B2B2_TARGET_STARTER_IDENTITY_MISMATCH:${row.gamePk}`);
  }
  return game;
}

export function predictMlbTeamPlusPitcherRunMeans(
  teamPrediction: { homeMeanRuns: number; awayMeanRuns: number },
  pitcherSnapshot: MlbPitcherAsOfSnapshot,
  targetStarterGame: MlbHistoricalStartingPitcherGame,
  pitcherEffectWeight: number,
): MlbTeamPlusPitcherPrediction {
  if (!Number.isFinite(pitcherEffectWeight) || pitcherEffectWeight < 0 || pitcherEffectWeight > 1) {
    throw new Error("P1_M6A3B2B2_INVALID_PITCHER_EFFECT_WEIGHT");
  }
  const home = pitcherSnapshot.pitchers[String(targetStarterGame.homeStarter.pitcherId)] ?? null;
  const away = pitcherSnapshot.pitchers[String(targetStarterGame.awayStarter.pitcherId)] ?? null;
  const homeRisk = home?.runRiskFactor ?? 1;
  const awayRisk = away?.runRiskFactor ?? 1;
  const homeMeanRuns = teamPrediction.homeMeanRuns * Math.pow(awayRisk, pitcherEffectWeight);
  const awayMeanRuns = teamPrediction.awayMeanRuns * Math.pow(homeRisk, pitcherEffectWeight);
  if (!Number.isFinite(homeMeanRuns) || homeMeanRuns < 0 || !Number.isFinite(awayMeanRuns) || awayMeanRuns < 0) {
    throw new Error("P1_M6A3B2B2_INVALID_EXPECTED_RUNS");
  }
  return {
    homeMeanRuns: round(homeMeanRuns, 10),
    awayMeanRuns: round(awayMeanRuns, 10),
    homeStarterId: targetStarterGame.homeStarter.pitcherId,
    awayStarterId: targetStarterGame.awayStarter.pitcherId,
    homeStarterRiskFactor: homeRisk,
    awayStarterRiskFactor: awayRisk,
    homeStarterSeen: home != null,
    awayStarterSeen: away != null,
    pitcherEffectWeight,
  };
}

function requireNb2Dispersion(fit: MlbMarginalRunFit): number {
  if (fit.family !== "NEGATIVE_BINOMIAL_NB2" || fit.dispersionK == null || !(fit.dispersionK > 0)) {
    throw new Error("P1_M6A3B2B2_NB2_DISPERSION_REQUIRED");
  }
  return fit.dispersionK;
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

function byDates(rows: MlbHistoricalHorizonObservation[], dates: string[]): MlbHistoricalHorizonObservation[] {
  const allowed = new Set(dates);
  return rows.filter((row) => allowed.has(row.officialDate));
}

function evaluateCombination(
  historyRows: MlbHistoricalHorizonObservation[],
  validationRows: MlbHistoricalHorizonObservation[],
  starterGames: MlbHistoricalStartingPitcherGame[],
  teamPriorGames: number,
  pitcherPriorBatters: number,
  pitcherEffectWeight: number,
  cutoffDateExclusive: string,
): number {
  const teamSnapshot = buildMlbTeamStrengthSnapshot(historyRows, teamPriorGames);
  const pitcherSnapshot = buildMlbPitcherAsOfSnapshot(starterGames, cutoffDateExclusive, pitcherPriorBatters);
  if (!(pitcherSnapshot.historyMaxDate < cutoffDateExclusive)) throw new Error("P1_M6A3B2B2_INNER_PITCHER_TIME_LEAKAGE_DETECTED");
  const homeFit = fitMlbMarginalRunModel(historyRows.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
  const awayFit = fitMlbMarginalRunModel(historyRows.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
  const homeK = requireNb2Dispersion(homeFit);
  const awayK = requireNb2Dispersion(awayFit);
  const starters = starterGameMap(starterGames);
  let total = 0;
  for (const row of validationRows) {
    const teamPrediction = predictMlbTeamRunMeans(teamSnapshot, row);
    const target = requireTargetStarterGame(starters, row);
    const pitcherPrediction = predictMlbTeamPlusPitcherRunMeans(
      teamPrediction,
      pitcherSnapshot,
      target,
      pitcherEffectWeight,
    );
    total += rowCountNll(row, pitcherPrediction.homeMeanRuns, pitcherPrediction.awayMeanRuns, homeK, awayK);
  }
  return total / (validationRows.length * 2);
}

export function selectMlbStartingPitcherHyperparametersNested(
  trainingRows: MlbHistoricalHorizonObservation[],
  starterGames: MlbHistoricalStartingPitcherGame[],
  options: {
    teamPriorGamesGrid?: number[];
    pitcherPriorBattersGrid?: number[];
    pitcherEffectWeightGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
  } = {},
): MlbPitcherNestedSelection {
  validateObservations(trainingRows);
  const teamGrid = validatePositiveIntegerGrid(
    options.teamPriorGamesGrid ?? [...DEFAULT_TEAM_PRIOR_GRID],
    "P1_M6A3B2B2_INVALID_TEAM_PRIOR_GRID",
  );
  const pitcherGrid = validatePositiveIntegerGrid(
    options.pitcherPriorBattersGrid ?? [...DEFAULT_PITCHER_PRIOR_BATTERS_GRID],
    "P1_M6A3B2B2_INVALID_PITCHER_PRIOR_GRID",
  );
  const effectGrid = validateEffectGrid(options.pitcherEffectWeightGrid ?? [...DEFAULT_PITCHER_EFFECT_GRID]);
  const innerValidationDateCount = options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES;
  const minimumInnerHistoryDates = options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES;
  if (!Number.isInteger(innerValidationDateCount) || innerValidationDateCount <= 0
    || !Number.isInteger(minimumInnerHistoryDates) || minimumInnerHistoryDates <= 0) {
    throw new Error("P1_M6A3B2B2_INVALID_INNER_CONFIGURATION");
  }
  const dates = [...new Set(trainingRows.map((row) => row.officialDate))].sort();
  if (dates.length < minimumInnerHistoryDates + innerValidationDateCount) {
    throw new Error("P1_M6A3B2B2_INSUFFICIENT_INNER_HISTORY");
  }
  const innerValidationDates = dates.slice(-innerValidationDateCount);
  const innerHistoryDates = dates.slice(0, -innerValidationDateCount);
  const innerHistory = byDates(trainingRows, innerHistoryDates);
  const innerValidation = byDates(trainingRows, innerValidationDates);
  const innerHistoryMaxDate = innerHistoryDates.at(-1) as string;
  const innerValidationMinDate = innerValidationDates[0];
  if (!(innerHistoryMaxDate < innerValidationMinDate)) throw new Error("P1_M6A3B2B2_INNER_TIME_LEAKAGE_DETECTED");

  const candidates: MlbPitcherHyperparameterScore[] = [];
  for (const teamPriorGames of teamGrid) {
    for (const pitcherPriorBatters of pitcherGrid) {
      for (const pitcherEffectWeight of effectGrid) {
        candidates.push({
          teamPriorGames,
          pitcherPriorBatters,
          pitcherEffectWeight,
          validationGames: innerValidation.length,
          meanCountNegativeLogLikelihood: round(evaluateCombination(
            innerHistory,
            innerValidation,
            starterGames,
            teamPriorGames,
            pitcherPriorBatters,
            pitcherEffectWeight,
            innerValidationMinDate,
          )),
        });
      }
    }
  }
  if (!candidates.length) throw new Error("P1_M6A3B2B2_NO_HYPERPARAMETER_CANDIDATES");
  let selected = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const delta = candidate.meanCountNegativeLogLikelihood - selected.meanCountNegativeLogLikelihood;
    const tied = Math.abs(delta) <= 1e-10;
    const moreConservative = candidate.pitcherEffectWeight < selected.pitcherEffectWeight
      || (candidate.pitcherEffectWeight === selected.pitcherEffectWeight
        && candidate.pitcherPriorBatters > selected.pitcherPriorBatters)
      || (candidate.pitcherEffectWeight === selected.pitcherEffectWeight
        && candidate.pitcherPriorBatters === selected.pitcherPriorBatters
        && candidate.teamPriorGames > selected.teamPriorGames);
    if (delta < -1e-10 || (tied && moreConservative)) selected = candidate;
  }
  const selectedSnapshot = buildMlbPitcherAsOfSnapshot(
    starterGames,
    innerValidationMinDate,
    selected.pitcherPriorBatters,
  );
  if (!(selectedSnapshot.historyMaxDate < innerValidationMinDate)) {
    throw new Error("P1_M6A3B2B2_INNER_PITCHER_TIME_LEAKAGE_DETECTED");
  }
  return {
    selectedTeamPriorGames: selected.teamPriorGames,
    selectedPitcherPriorBatters: selected.pitcherPriorBatters,
    selectedPitcherEffectWeight: selected.pitcherEffectWeight,
    candidates,
    innerHistoryDates: innerHistoryDates.length,
    innerValidationDates: innerValidationDates.length,
    innerHistoryMaxDate,
    innerValidationMinDate,
    pitcherSnapshotHistoryMaxDate: selectedSnapshot.historyMaxDate,
    leakageFree: true,
  };
}

export function buildMlbStartingPitcherOosReport(
  observations: MlbHistoricalHorizonObservation[],
  starterGames: MlbHistoricalStartingPitcherGame[],
  options: {
    minimumTrainingDates?: number;
    validationDateCount?: number;
    stepDateCount?: number;
    minimumTotalValidationGames?: number;
    teamPriorGamesGrid?: number[];
    pitcherPriorBattersGrid?: number[];
    pitcherEffectWeightGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
    generatedAt?: string;
  } = {},
): MlbStartingPitcherOosReport {
  if (!observations.length) throw new Error("P1_M6A3B2B2_EMPTY_SAMPLE");
  if (!starterGames.length) throw new Error("P1_M6A3B2B2_EMPTY_STARTER_HISTORY");
  const configuration = {
    minimumTrainingDates: options.minimumTrainingDates ?? 60,
    validationDateCount: options.validationDateCount ?? 14,
    stepDateCount: options.stepDateCount ?? 14,
    minimumTotalValidationGames: options.minimumTotalValidationGames ?? 300,
    teamPriorGamesGrid: validatePositiveIntegerGrid(
      options.teamPriorGamesGrid ?? [...DEFAULT_TEAM_PRIOR_GRID],
      "P1_M6A3B2B2_INVALID_TEAM_PRIOR_GRID",
    ),
    pitcherPriorBattersGrid: validatePositiveIntegerGrid(
      options.pitcherPriorBattersGrid ?? [...DEFAULT_PITCHER_PRIOR_BATTERS_GRID],
      "P1_M6A3B2B2_INVALID_PITCHER_PRIOR_GRID",
    ),
    pitcherEffectWeightGrid: validateEffectGrid(options.pitcherEffectWeightGrid ?? [...DEFAULT_PITCHER_EFFECT_GRID]),
    innerValidationDateCount: options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES,
    minimumInnerHistoryDates: options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES,
  };
  if (![configuration.minimumTrainingDates, configuration.validationDateCount, configuration.stepDateCount,
    configuration.minimumTotalValidationGames, configuration.innerValidationDateCount,
    configuration.minimumInnerHistoryDates].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("P1_M6A3B2B2_INVALID_OOS_CONFIGURATION");
  }
  const starters = starterGameMap(starterGames);
  const horizons: MlbStartingPitcherHorizonReport[] = [];

  for (const horizon of HORIZONS) {
    const rows = observations.filter((row) => row.horizon === horizon)
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    if (!rows.length) {
      horizons.push({
        horizon,
        observations: 0,
        uniqueDates: 0,
        validationGames: 0,
        status: "INSUFFICIENT_OOS_SAMPLE",
        leagueNb2CountNegativeLogLikelihood: null,
        teamOnlyCountNegativeLogLikelihood: null,
        teamPlusPitcherCountNegativeLogLikelihood: null,
        teamMinusPitcherCountNll: null,
        leagueMinusPitcherCountNll: null,
        relativePitcherReductionVsTeamPct: null,
        folds: [],
        pairedRows: [],
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
        blockers: ["P1_M6A3B2B2_INSUFFICIENT_OOS_SAMPLE", "NO_AUTOMATIC_PROMOTION"],
      });
      continue;
    }
    validateObservations(rows);
    for (const row of rows) requireTargetStarterGame(starters, row);
    const folds = buildMlbRollingOriginDateFolds(rows, configuration);
    const foldMetrics: MlbStartingPitcherFoldMetric[] = [];
    const pairedRows: MlbStartingPitcherPairedRow[] = [];
    let leagueNllTotal = 0;
    let teamNllTotal = 0;
    let pitcherNllTotal = 0;
    let countObservations = 0;
    let validationGames = 0;

    for (const fold of folds) {
      const training = byDates(rows, fold.trainingDates);
      const validation = byDates(rows, fold.validationDates);
      if (!training.length || !validation.length) continue;
      if (!(fold.trainingMaxDate < fold.validationMinDate)) throw new Error("P1_M6A3B2B2_OUTER_TIME_LEAKAGE_DETECTED");
      const nestedSelection = selectMlbStartingPitcherHyperparametersNested(training, starterGames, {
        teamPriorGamesGrid: configuration.teamPriorGamesGrid,
        pitcherPriorBattersGrid: configuration.pitcherPriorBattersGrid,
        pitcherEffectWeightGrid: configuration.pitcherEffectWeightGrid,
        innerValidationDateCount: configuration.innerValidationDateCount,
        minimumInnerHistoryDates: configuration.minimumInnerHistoryDates,
      });
      const teamSnapshot = buildMlbTeamStrengthSnapshot(training, nestedSelection.selectedTeamPriorGames);
      const pitcherSnapshot = buildMlbPitcherAsOfSnapshot(
        starterGames,
        fold.validationMinDate,
        nestedSelection.selectedPitcherPriorBatters,
      );
      if (!(pitcherSnapshot.historyMaxDate < fold.validationMinDate)) {
        throw new Error("P1_M6A3B2B2_OUTER_PITCHER_TIME_LEAKAGE_DETECTED");
      }
      const homeFit = fitMlbMarginalRunModel(training.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
      const awayFit = fitMlbMarginalRunModel(training.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
      const homeK = requireNb2Dispersion(homeFit);
      const awayK = requireNb2Dispersion(awayFit);

      let foldLeagueNll = 0;
      let foldTeamNll = 0;
      let foldPitcherNll = 0;
      let bothSeen = 0;
      let oneUnseen = 0;
      let bothUnseen = 0;

      for (const row of validation) {
        const target = requireTargetStarterGame(starters, row);
        const teamPrediction = predictMlbTeamRunMeans(teamSnapshot, row);
        const pitcherPrediction = predictMlbTeamPlusPitcherRunMeans(
          teamPrediction,
          pitcherSnapshot,
          target,
          nestedSelection.selectedPitcherEffectWeight,
        );
        if (pitcherPrediction.homeStarterSeen && pitcherPrediction.awayStarterSeen) bothSeen += 1;
        else if (!pitcherPrediction.homeStarterSeen && !pitcherPrediction.awayStarterSeen) bothUnseen += 1;
        else oneUnseen += 1;

        const leagueRowNll = rowCountNll(row, homeFit.meanRuns, awayFit.meanRuns, homeK, awayK);
        const teamRowNll = rowCountNll(row, teamPrediction.homeMeanRuns, teamPrediction.awayMeanRuns, homeK, awayK);
        const pitcherRowNll = rowCountNll(row, pitcherPrediction.homeMeanRuns, pitcherPrediction.awayMeanRuns, homeK, awayK);
        foldLeagueNll += leagueRowNll;
        foldTeamNll += teamRowNll;
        foldPitcherNll += pitcherRowNll;
        leagueNllTotal += leagueRowNll;
        teamNllTotal += teamRowNll;
        pitcherNllTotal += pitcherRowNll;
        countObservations += 2;
        pairedRows.push({
          horizon,
          foldIndex: fold.foldIndex,
          gamePk: row.gamePk,
          officialDate: row.officialDate,
          leagueNb2CountNll: round(leagueRowNll / 2),
          teamOnlyCountNll: round(teamRowNll / 2),
          teamPlusPitcherCountNll: round(pitcherRowNll / 2),
          teamMinusPitcherCountNll: round((teamRowNll - pitcherRowNll) / 2),
          leagueMinusPitcherCountNll: round((leagueRowNll - pitcherRowNll) / 2),
        });
      }

      validationGames += validation.length;
      const denominator = validation.length * 2;
      foldMetrics.push({
        foldIndex: fold.foldIndex,
        trainingGames: training.length,
        validationGames: validation.length,
        trainingDates: fold.trainingDates.length,
        validationDates: fold.validationDates.length,
        trainingMaxDate: fold.trainingMaxDate,
        validationMinDate: fold.validationMinDate,
        validationMaxDate: fold.validationMaxDate,
        selectedTeamPriorGames: nestedSelection.selectedTeamPriorGames,
        selectedPitcherPriorBatters: nestedSelection.selectedPitcherPriorBatters,
        selectedPitcherEffectWeight: nestedSelection.selectedPitcherEffectWeight,
        nestedSelection,
        pitcherSnapshotHistoryMaxDate: pitcherSnapshot.historyMaxDate,
        homeDispersionK: homeK,
        awayDispersionK: awayK,
        leagueNb2CountNegativeLogLikelihood: round(foldLeagueNll / denominator),
        teamOnlyCountNegativeLogLikelihood: round(foldTeamNll / denominator),
        teamPlusPitcherCountNegativeLogLikelihood: round(foldPitcherNll / denominator),
        teamMinusPitcherCountNll: round((foldTeamNll - foldPitcherNll) / denominator),
        leagueMinusPitcherCountNll: round((foldLeagueNll - foldPitcherNll) / denominator),
        bothPitchersSeenValidationGames: bothSeen,
        onePitcherUnseenValidationGames: oneUnseen,
        bothPitchersUnseenValidationGames: bothUnseen,
        leakageFree: true,
      });
    }

    const ready = validationGames >= configuration.minimumTotalValidationGames && countObservations > 0;
    const leagueNll = countObservations ? leagueNllTotal / countObservations : null;
    const teamNll = countObservations ? teamNllTotal / countObservations : null;
    const pitcherNll = countObservations ? pitcherNllTotal / countObservations : null;
    const teamDelta = teamNll != null && pitcherNll != null ? teamNll - pitcherNll : null;
    const leagueDelta = leagueNll != null && pitcherNll != null ? leagueNll - pitcherNll : null;
    const relative = teamNll != null && teamNll > 0 && teamDelta != null ? (teamDelta / teamNll) * 100 : null;
    const improved = ready && teamDelta != null && teamDelta > 0;
    horizons.push({
      horizon,
      observations: rows.length,
      uniqueDates: new Set(rows.map((row) => row.officialDate)).size,
      validationGames,
      status: !ready ? "INSUFFICIENT_OOS_SAMPLE" : improved
        ? "PITCHER_OOS_IMPROVEMENT_OVER_TEAM"
        : "NO_PITCHER_OOS_IMPROVEMENT",
      leagueNb2CountNegativeLogLikelihood: leagueNll == null ? null : round(leagueNll),
      teamOnlyCountNegativeLogLikelihood: teamNll == null ? null : round(teamNll),
      teamPlusPitcherCountNegativeLogLikelihood: pitcherNll == null ? null : round(pitcherNll),
      teamMinusPitcherCountNll: teamDelta == null ? null : round(teamDelta),
      leagueMinusPitcherCountNll: leagueDelta == null ? null : round(leagueDelta),
      relativePitcherReductionVsTeamPct: relative == null ? null : round(relative, 6),
      folds: foldMetrics,
      pairedRows,
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
      blockers: !ready
        ? ["P1_M6A3B2B2_INSUFFICIENT_OOS_SAMPLE", "NO_AUTOMATIC_PROMOTION"]
        : improved
          ? ["P1_M6A3B2B2_POINT_ESTIMATE_ONLY", "P1_M6A3B2B2_PAIRED_INFERENCE_REQUIRED", "NO_AUTOMATIC_PROMOTION"]
          : ["P1_M6A3B2B2_PITCHER_FEATURE_DID_NOT_IMPROVE_TEAM_COUNT_NLL", "NO_AUTOMATIC_PROMOTION"],
    });
  }

  return {
    schemaVersion: MLB_P1_M6A3B2B2_SCHEMA,
    model: MLB_P1_M6A3B2B2_MODEL,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration,
    horizons,
    allFoldsLeakageFree: horizons.every((horizon) => horizon.folds.every((fold) =>
      fold.leakageFree
      && fold.nestedSelection.leakageFree
      && fold.trainingMaxDate < fold.validationMinDate
      && fold.pitcherSnapshotHistoryMaxDate < fold.validationMinDate
      && fold.nestedSelection.pitcherSnapshotHistoryMaxDate < fold.nestedSelection.innerValidationMinDate)),
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2B2_STARTING_PITCHER_CHALLENGER_ONLY",
      "P1_M6A3B2B2_PAIRED_INFERENCE_REQUIRED",
      "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE",
    ],
  };
}
