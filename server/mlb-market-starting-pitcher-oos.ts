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
} from "./mlb-market-historical-fit";
import {
  buildMlbTeamStrengthSnapshot,
  mlbNb2LogPmf,
  predictMlbTeamRunMeans,
  selectMlbTeamPriorGamesNested,
} from "./mlb-market-team-strength";

export const MLB_P1_M6A3B2B2_SCHEMA = "courtedge-p1-m6a3b2b2-starting-pitcher-oos.v1" as const;
export const MLB_P1_M6A3B2B2_MODEL = "NB2_TEAM_PLUS_SHRUNK_STARTER_RUN_RATE" as const;

const LOG_EPS = 1e-15;
const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];
const DEFAULT_PITCHER_PRIOR_STARTS_GRID = [1, 2, 4, 8, 16] as const;
const DEFAULT_BETA_GRID = [0, 0.25, 0.5, 1] as const;
const DEFAULT_INNER_VALIDATION_DATES = 14;
const DEFAULT_MINIMUM_INNER_HISTORY_DATES = 30;

export interface MlbPitcherStrengthEstimate {
  pitcherId: number;
  starts: number;
  outsRecorded: number;
  runsAllowed: number;
  shrunkenRunsPerOut: number;
  leagueRunsPerOut: number;
  runRateFactor: number;
  expectedOutsPerStart: number;
}

export interface MlbPitcherStrengthSnapshot {
  schemaVersion: typeof MLB_P1_M6A3B2B2_SCHEMA;
  model: typeof MLB_P1_M6A3B2B2_MODEL;
  asOfMaxDate: string;
  priorStarts: number;
  historyGames: number;
  starterLines: number;
  leagueRunsPerOut: number;
  leagueExpectedOutsPerStart: number;
  pitchers: Record<string, MlbPitcherStrengthEstimate>;
  snapshotDigest: string;
  actionabilityAllowed: false;
}

export interface MlbPitcherAdjustedRunMeans {
  homeMeanRuns: number;
  awayMeanRuns: number;
  homeStarterId: number;
  awayStarterId: number;
  homeStarterSeen: boolean;
  awayStarterSeen: boolean;
  homeStarterPriorStarts: number;
  awayStarterPriorStarts: number;
  homeStarterRunRateFactor: number;
  awayStarterRunRateFactor: number;
  homeStarterExposure: number;
  awayStarterExposure: number;
  beta: number;
}

export interface MlbPitcherNestedCandidateScore {
  priorStarts: number;
  beta: number;
  validationGames: number;
  meanCountNegativeLogLikelihood: number;
}

export interface MlbPitcherNestedSelection {
  selectedPriorStarts: number;
  selectedBeta: number;
  candidates: MlbPitcherNestedCandidateScore[];
  innerHistoryDates: number;
  innerValidationDates: number;
  innerHistoryMaxDate: string;
  innerValidationMinDate: string;
  leakageFree: true;
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
  leakageFree: true;
  selectedTeamPriorGames: number;
  selectedPitcherPriorStarts: number;
  selectedPitcherBeta: number;
  pitcherNestedSelection: MlbPitcherNestedSelection;
  homeDispersionK: number;
  awayDispersionK: number;
  leagueBaselineCountNll: number;
  teamOnlyCountNll: number;
  teamPlusPitcherCountNll: number;
  leagueMinusTeamPlusPitcherCountNll: number;
  teamOnlyMinusTeamPlusPitcherCountNll: number;
  validationStarterLines: number;
  seenStarterLines: number;
  coldStartStarterLines: number;
}

export interface MlbStartingPitcherHorizonReport {
  horizon: MlbProbabilityHorizon;
  observations: number;
  uniqueDates: number;
  validationGames: number;
  status: "PITCHER_POINT_IMPROVEMENT" | "NO_PITCHER_POINT_IMPROVEMENT" | "INSUFFICIENT_OOS_SAMPLE";
  leagueBaselineCountNll: number | null;
  teamOnlyCountNll: number | null;
  teamPlusPitcherCountNll: number | null;
  leagueMinusTeamPlusPitcherCountNll: number | null;
  teamOnlyMinusTeamPlusPitcherCountNll: number | null;
  relativePitcherIncrementPctVsTeamOnly: number | null;
  validationStarterLines: number;
  seenStarterLines: number;
  coldStartStarterLines: number;
  coldStartStarterLinePct: number | null;
  folds: MlbStartingPitcherFoldMetric[];
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
    pitcherPriorStartsGrid: number[];
    betaGrid: number[];
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
    "NO_AUTOMATIC_PROMOTION"
  ];
}

interface StarterIdentity {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeStarterId: number;
  awayStarterId: number;
}

interface MutablePitcherAggregate {
  pitcherId: number;
  starts: number;
  outsRecorded: number;
  runsAllowed: number;
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("P1_M6A3B2B2_INVALID_DATE");
}

function validateGrid(values: number[], label: string, options: { allowZero?: boolean; max: number }): number[] {
  if (!values.length) throw new Error(`P1_M6A3B2B2_EMPTY_${label}_GRID`);
  const unique = [...new Set(values)];
  for (const value of unique) {
    if (!Number.isFinite(value) || value < 0 || (!options.allowZero && value === 0) || value > options.max) {
      throw new Error(`P1_M6A3B2B2_INVALID_${label}_GRID`);
    }
  }
  return unique.sort((a, b) => a - b);
}

function horizonOuts(horizon: MlbProbabilityHorizon): number {
  if (horizon === "FIRST_INNING") return 3;
  if (horizon === "FIRST_3") return 9;
  if (horizon === "FIRST_5") return 15;
  return 27;
}

function flattenStarterLines(games: MlbHistoricalStartingPitcherGame[]): MlbHistoricalStartingPitcherLine[] {
  return games.flatMap((game) => [game.awayStarter, game.homeStarter]);
}

function materializeRowsByDates(rows: MlbHistoricalHorizonObservation[], dates: string[]): MlbHistoricalHorizonObservation[] {
  const allowed = new Set(dates);
  return rows.filter((row) => allowed.has(row.officialDate));
}

function starterIdentityMap(games: MlbHistoricalStartingPitcherGame[]): Map<number, StarterIdentity> {
  const map = new Map<number, StarterIdentity>();
  for (const game of games) {
    validateDate(game.officialDate);
    if (map.has(game.gamePk)) throw new Error("P1_M6A3B2B2_DUPLICATE_STARTER_GAME");
    map.set(game.gamePk, {
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      homeStarterId: game.homeStarter.pitcherId,
      awayStarterId: game.awayStarter.pitcherId,
    });
  }
  return map;
}

function requireStarterIdentity(
  row: MlbHistoricalHorizonObservation,
  identities: Map<number, StarterIdentity>,
): StarterIdentity {
  const identity = identities.get(row.gamePk);
  if (!identity) throw new Error(`P1_M6A3B2B2_STARTER_IDENTITY_MISSING:${row.gamePk}`);
  if (identity.officialDate !== row.officialDate
    || identity.homeTeamId !== row.homeTeamId
    || identity.awayTeamId !== row.awayTeamId) {
    throw new Error(`P1_M6A3B2B2_STARTER_IDENTITY_MISMATCH:${row.gamePk}`);
  }
  return identity;
}

function validateJoinedSample(
  observations: MlbHistoricalHorizonObservation[],
  starterGames: MlbHistoricalStartingPitcherGame[],
): void {
  if (!observations.length || !starterGames.length) throw new Error("P1_M6A3B2B2_EMPTY_SAMPLE");
  const identities = starterIdentityMap(starterGames);
  for (const row of observations) requireStarterIdentity(row, identities);
}

export function buildMlbPitcherStrengthSnapshot(
  starterGames: MlbHistoricalStartingPitcherGame[],
  options: { asOfMaxDate: string; priorStarts: number },
): MlbPitcherStrengthSnapshot {
  validateDate(options.asOfMaxDate);
  if (!Number.isInteger(options.priorStarts) || options.priorStarts <= 0 || options.priorStarts > 100) {
    throw new Error("P1_M6A3B2B2_INVALID_PITCHER_PRIOR_STARTS");
  }
  const historyGames = starterGames
    .filter((game) => game.officialDate <= options.asOfMaxDate)
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  if (!historyGames.length) throw new Error("P1_M6A3B2B2_EMPTY_PITCHER_HISTORY");
  if (historyGames.some((game) => game.officialDate > options.asOfMaxDate)) {
    throw new Error("P1_M6A3B2B2_PITCHER_HISTORY_TIME_LEAKAGE");
  }

  const lines = flattenStarterLines(historyGames);
  const totalOuts = lines.reduce((sum, line) => sum + line.outsRecorded, 0);
  const totalRuns = lines.reduce((sum, line) => sum + line.runs, 0);
  if (!(totalOuts > 0) || totalRuns < 0) throw new Error("P1_M6A3B2B2_INVALID_LEAGUE_PITCHER_HISTORY");
  const leagueRunsPerOut = totalRuns / totalOuts;
  const leagueExpectedOutsPerStart = totalOuts / lines.length;
  if (!(leagueRunsPerOut > 0) || !(leagueExpectedOutsPerStart > 0)) {
    throw new Error("P1_M6A3B2B2_INVALID_LEAGUE_PITCHER_RATE");
  }

  const aggregates = new Map<number, MutablePitcherAggregate>();
  for (const line of lines) {
    let aggregate = aggregates.get(line.pitcherId);
    if (!aggregate) {
      aggregate = { pitcherId: line.pitcherId, starts: 0, outsRecorded: 0, runsAllowed: 0 };
      aggregates.set(line.pitcherId, aggregate);
    }
    aggregate.starts += 1;
    aggregate.outsRecorded += line.outsRecorded;
    aggregate.runsAllowed += line.runs;
  }

  const priorOuts = options.priorStarts * leagueExpectedOutsPerStart;
  const priorRuns = priorOuts * leagueRunsPerOut;
  const pitchers: Record<string, MlbPitcherStrengthEstimate> = {};
  for (const aggregate of [...aggregates.values()].sort((a, b) => a.pitcherId - b.pitcherId)) {
    const denominatorOuts = aggregate.outsRecorded + priorOuts;
    const shrunkenRunsPerOut = (aggregate.runsAllowed + priorRuns) / denominatorOuts;
    const runRateFactor = shrunkenRunsPerOut / leagueRunsPerOut;
    const expectedOutsPerStart = (aggregate.outsRecorded + options.priorStarts * leagueExpectedOutsPerStart)
      / (aggregate.starts + options.priorStarts);
    if (!(runRateFactor > 0) || !Number.isFinite(runRateFactor)
      || !(expectedOutsPerStart > 0) || !Number.isFinite(expectedOutsPerStart)) {
      throw new Error("P1_M6A3B2B2_INVALID_PITCHER_FACTOR");
    }
    pitchers[String(aggregate.pitcherId)] = {
      pitcherId: aggregate.pitcherId,
      starts: aggregate.starts,
      outsRecorded: aggregate.outsRecorded,
      runsAllowed: aggregate.runsAllowed,
      shrunkenRunsPerOut: round(shrunkenRunsPerOut, 12),
      leagueRunsPerOut: round(leagueRunsPerOut, 12),
      runRateFactor: round(runRateFactor, 10),
      expectedOutsPerStart: round(expectedOutsPerStart, 10),
    };
  }

  const withoutDigest = {
    schemaVersion: MLB_P1_M6A3B2B2_SCHEMA,
    model: MLB_P1_M6A3B2B2_MODEL,
    asOfMaxDate: options.asOfMaxDate,
    priorStarts: options.priorStarts,
    historyGames: historyGames.length,
    starterLines: lines.length,
    leagueRunsPerOut: round(leagueRunsPerOut, 12),
    leagueExpectedOutsPerStart: round(leagueExpectedOutsPerStart, 10),
    pitchers,
    actionabilityAllowed: false as const,
  };
  return { ...withoutDigest, snapshotDigest: digest(withoutDigest) };
}

export function predictMlbTeamPlusPitcherRunMeans(
  teamMeans: { homeMeanRuns: number; awayMeanRuns: number },
  pitcherSnapshot: MlbPitcherStrengthSnapshot,
  identity: StarterIdentity,
  horizon: MlbProbabilityHorizon,
  beta: number,
): MlbPitcherAdjustedRunMeans {
  if (!Number.isFinite(beta) || beta < 0 || beta > 2) throw new Error("P1_M6A3B2B2_INVALID_BETA");
  const homeStarter = pitcherSnapshot.pitchers[String(identity.homeStarterId)] ?? null;
  const awayStarter = pitcherSnapshot.pitchers[String(identity.awayStarterId)] ?? null;
  const requiredOuts = horizonOuts(horizon);
  const homeExpectedOuts = homeStarter?.expectedOutsPerStart ?? pitcherSnapshot.leagueExpectedOutsPerStart;
  const awayExpectedOuts = awayStarter?.expectedOutsPerStart ?? pitcherSnapshot.leagueExpectedOutsPerStart;
  const homeExposure = Math.min(requiredOuts, homeExpectedOuts) / requiredOuts;
  const awayExposure = Math.min(requiredOuts, awayExpectedOuts) / requiredOuts;
  const homeFactor = homeStarter?.runRateFactor ?? 1;
  const awayFactor = awayStarter?.runRateFactor ?? 1;

  // Home offense faces the away starter; away offense faces the home starter.
  const homeMeanRuns = teamMeans.homeMeanRuns * Math.exp(beta * awayExposure * Math.log(awayFactor));
  const awayMeanRuns = teamMeans.awayMeanRuns * Math.exp(beta * homeExposure * Math.log(homeFactor));
  if (!(homeMeanRuns >= 0) || !Number.isFinite(homeMeanRuns)
    || !(awayMeanRuns >= 0) || !Number.isFinite(awayMeanRuns)) {
    throw new Error("P1_M6A3B2B2_INVALID_ADJUSTED_RUN_MEAN");
  }

  return {
    homeMeanRuns: round(homeMeanRuns, 10),
    awayMeanRuns: round(awayMeanRuns, 10),
    homeStarterId: identity.homeStarterId,
    awayStarterId: identity.awayStarterId,
    homeStarterSeen: homeStarter != null,
    awayStarterSeen: awayStarter != null,
    homeStarterPriorStarts: homeStarter?.starts ?? 0,
    awayStarterPriorStarts: awayStarter?.starts ?? 0,
    homeStarterRunRateFactor: homeFactor,
    awayStarterRunRateFactor: awayFactor,
    homeStarterExposure: round(homeExposure, 10),
    awayStarterExposure: round(awayExposure, 10),
    beta,
  };
}

function requireNb2Dispersion(fit: ReturnType<typeof fitMlbMarginalRunModel>): number {
  if (fit.family !== "NEGATIVE_BINOMIAL_NB2" || !(fit.dispersionK != null && fit.dispersionK > 0)) {
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
  const homeLog = mlbNb2LogPmf(row.homeRuns, homeMean, homeK);
  const awayLog = mlbNb2LogPmf(row.awayRuns, awayMean, awayK);
  return -Math.max(Math.log(LOG_EPS), homeLog) - Math.max(Math.log(LOG_EPS), awayLog);
}

function evaluatePitcherCandidate(
  validation: MlbHistoricalHorizonObservation[],
  identities: Map<number, StarterIdentity>,
  teamSnapshot: ReturnType<typeof buildMlbTeamStrengthSnapshot>,
  pitcherSnapshot: MlbPitcherStrengthSnapshot,
  beta: number,
  homeK: number,
  awayK: number,
): number {
  let total = 0;
  for (const row of validation) {
    const identity = requireStarterIdentity(row, identities);
    const team = predictMlbTeamRunMeans(teamSnapshot, row);
    const adjusted = predictMlbTeamPlusPitcherRunMeans(team, pitcherSnapshot, identity, row.horizon, beta);
    total += rowCountNll(row, adjusted.homeMeanRuns, adjusted.awayMeanRuns, homeK, awayK);
  }
  return total / (validation.length * 2);
}

export function selectMlbPitcherHyperparametersNested(
  trainingRows: MlbHistoricalHorizonObservation[],
  starterGames: MlbHistoricalStartingPitcherGame[],
  options: {
    selectedTeamPriorGames: number;
    pitcherPriorStartsGrid?: number[];
    betaGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
  },
): MlbPitcherNestedSelection {
  if (!trainingRows.length) throw new Error("P1_M6A3B2B2_EMPTY_NESTED_TRAINING");
  const priorGrid = validateGrid(options.pitcherPriorStartsGrid ?? [...DEFAULT_PITCHER_PRIOR_STARTS_GRID], "PITCHER_PRIOR_STARTS", { max: 100 });
  const betaGrid = validateGrid(options.betaGrid ?? [...DEFAULT_BETA_GRID], "BETA", { allowZero: true, max: 2 });
  const innerValidationDateCount = options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES;
  const minimumInnerHistoryDates = options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES;
  const dates = [...new Set(trainingRows.map((row) => row.officialDate))].sort();
  if (dates.length < minimumInnerHistoryDates + innerValidationDateCount) {
    throw new Error("P1_M6A3B2B2_INSUFFICIENT_INNER_HISTORY");
  }
  const innerValidationDates = dates.slice(-innerValidationDateCount);
  const innerHistoryDates = dates.slice(0, -innerValidationDateCount);
  const innerHistoryMaxDate = innerHistoryDates.at(-1) as string;
  const innerValidationMinDate = innerValidationDates[0];
  if (!(innerHistoryMaxDate < innerValidationMinDate)) throw new Error("P1_M6A3B2B2_INNER_TIME_LEAKAGE_DETECTED");
  const innerHistory = materializeRowsByDates(trainingRows, innerHistoryDates);
  const innerValidation = materializeRowsByDates(trainingRows, innerValidationDates);
  const identities = starterIdentityMap(starterGames);
  for (const row of innerValidation) requireStarterIdentity(row, identities);

  const teamSnapshot = buildMlbTeamStrengthSnapshot(innerHistory, options.selectedTeamPriorGames);
  const homeK = requireNb2Dispersion(fitMlbMarginalRunModel(innerHistory.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2"));
  const awayK = requireNb2Dispersion(fitMlbMarginalRunModel(innerHistory.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2"));

  const candidates: MlbPitcherNestedCandidateScore[] = [];
  for (const priorStarts of priorGrid) {
    const pitcherSnapshot = buildMlbPitcherStrengthSnapshot(starterGames, {
      asOfMaxDate: innerHistoryMaxDate,
      priorStarts,
    });
    for (const beta of betaGrid) {
      candidates.push({
        priorStarts,
        beta,
        validationGames: innerValidation.length,
        meanCountNegativeLogLikelihood: round(evaluatePitcherCandidate(
          innerValidation,
          identities,
          teamSnapshot,
          pitcherSnapshot,
          beta,
          homeK,
          awayK,
        )),
      });
    }
  }

  let selected = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const delta = candidate.meanCountNegativeLogLikelihood - selected.meanCountNegativeLogLikelihood;
    if (delta < -1e-10
      || (Math.abs(delta) <= 1e-10 && candidate.beta < selected.beta)
      || (Math.abs(delta) <= 1e-10 && candidate.beta === selected.beta && candidate.priorStarts > selected.priorStarts)) {
      selected = candidate;
    }
  }

  return {
    selectedPriorStarts: selected.priorStarts,
    selectedBeta: selected.beta,
    candidates,
    innerHistoryDates: innerHistoryDates.length,
    innerValidationDates: innerValidationDates.length,
    innerHistoryMaxDate,
    innerValidationMinDate,
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
    pitcherPriorStartsGrid?: number[];
    betaGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
    generatedAt?: string;
  } = {},
): MlbStartingPitcherOosReport {
  validateJoinedSample(observations, starterGames);
  const configuration = {
    minimumTrainingDates: options.minimumTrainingDates ?? 60,
    validationDateCount: options.validationDateCount ?? 14,
    stepDateCount: options.stepDateCount ?? 14,
    minimumTotalValidationGames: options.minimumTotalValidationGames ?? 300,
    teamPriorGamesGrid: validateGrid(options.teamPriorGamesGrid ?? [5, 10, 20, 40, 80], "TEAM_PRIOR_GAMES", { max: 500 }),
    pitcherPriorStartsGrid: validateGrid(options.pitcherPriorStartsGrid ?? [...DEFAULT_PITCHER_PRIOR_STARTS_GRID], "PITCHER_PRIOR_STARTS", { max: 100 }),
    betaGrid: validateGrid(options.betaGrid ?? [...DEFAULT_BETA_GRID], "BETA", { allowZero: true, max: 2 }),
    innerValidationDateCount: options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES,
    minimumInnerHistoryDates: options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES,
  };
  if (!Number.isInteger(configuration.minimumTotalValidationGames) || configuration.minimumTotalValidationGames <= 0) {
    throw new Error("P1_M6A3B2B2_INVALID_MINIMUM_VALIDATION_GAMES");
  }
  const identities = starterIdentityMap(starterGames);
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
        leagueBaselineCountNll: null,
        teamOnlyCountNll: null,
        teamPlusPitcherCountNll: null,
        leagueMinusTeamPlusPitcherCountNll: null,
        teamOnlyMinusTeamPlusPitcherCountNll: null,
        relativePitcherIncrementPctVsTeamOnly: null,
        validationStarterLines: 0,
        seenStarterLines: 0,
        coldStartStarterLines: 0,
        coldStartStarterLinePct: null,
        folds: [],
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
        blockers: ["P1_M6A3B2B2_INSUFFICIENT_OOS_SAMPLE"],
      });
      continue;
    }
    const folds = buildMlbRollingOriginDateFolds(rows, configuration);
    const foldMetrics: MlbStartingPitcherFoldMetric[] = [];
    let leagueTotal = 0;
    let teamTotal = 0;
    let pitcherTotal = 0;
    let countObservations = 0;
    let validationGames = 0;
    let validationStarterLines = 0;
    let seenStarterLines = 0;
    let coldStartStarterLines = 0;

    for (const fold of folds) {
      const training = materializeRowsByDates(rows, fold.trainingDates);
      const validation = materializeRowsByDates(rows, fold.validationDates);
      if (!training.length || !validation.length) continue;
      if (!(fold.trainingMaxDate < fold.validationMinDate)) throw new Error("P1_M6A3B2B2_OUTER_TIME_LEAKAGE_DETECTED");

      const teamPriorSelection = selectMlbTeamPriorGamesNested(training, {
        priorGamesGrid: configuration.teamPriorGamesGrid,
        innerValidationDateCount: configuration.innerValidationDateCount,
        minimumInnerHistoryDates: configuration.minimumInnerHistoryDates,
      });
      const pitcherSelection = selectMlbPitcherHyperparametersNested(training, starterGames, {
        selectedTeamPriorGames: teamPriorSelection.selectedPriorGames,
        pitcherPriorStartsGrid: configuration.pitcherPriorStartsGrid,
        betaGrid: configuration.betaGrid,
        innerValidationDateCount: configuration.innerValidationDateCount,
        minimumInnerHistoryDates: configuration.minimumInnerHistoryDates,
      });
      const teamSnapshot = buildMlbTeamStrengthSnapshot(training, teamPriorSelection.selectedPriorGames);
      const pitcherSnapshot = buildMlbPitcherStrengthSnapshot(starterGames, {
        asOfMaxDate: fold.trainingMaxDate,
        priorStarts: pitcherSelection.selectedPriorStarts,
      });
      if (!(pitcherSnapshot.asOfMaxDate < fold.validationMinDate)) {
        throw new Error("P1_M6A3B2B2_PITCHER_SNAPSHOT_OUTER_TIME_LEAKAGE_DETECTED");
      }
      const homeFit = fitMlbMarginalRunModel(training.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
      const awayFit = fitMlbMarginalRunModel(training.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
      const homeK = requireNb2Dispersion(homeFit);
      const awayK = requireNb2Dispersion(awayFit);

      let foldLeague = 0;
      let foldTeam = 0;
      let foldPitcher = 0;
      let foldSeenStarterLines = 0;
      let foldColdStarterLines = 0;
      for (const row of validation) {
        const identity = requireStarterIdentity(row, identities);
        const team = predictMlbTeamRunMeans(teamSnapshot, row);
        const adjusted = predictMlbTeamPlusPitcherRunMeans(
          team,
          pitcherSnapshot,
          identity,
          horizon,
          pitcherSelection.selectedBeta,
        );
        const leagueNll = rowCountNll(row, homeFit.meanRuns, awayFit.meanRuns, homeK, awayK);
        const teamNll = rowCountNll(row, team.homeMeanRuns, team.awayMeanRuns, homeK, awayK);
        const pitcherNll = rowCountNll(row, adjusted.homeMeanRuns, adjusted.awayMeanRuns, homeK, awayK);
        foldLeague += leagueNll;
        foldTeam += teamNll;
        foldPitcher += pitcherNll;
        leagueTotal += leagueNll;
        teamTotal += teamNll;
        pitcherTotal += pitcherNll;
        countObservations += 2;
        validationStarterLines += 2;
        const seen = Number(adjusted.homeStarterSeen) + Number(adjusted.awayStarterSeen);
        foldSeenStarterLines += seen;
        foldColdStarterLines += 2 - seen;
        seenStarterLines += seen;
        coldStartStarterLines += 2 - seen;
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
        leakageFree: true,
        selectedTeamPriorGames: teamPriorSelection.selectedPriorGames,
        selectedPitcherPriorStarts: pitcherSelection.selectedPriorStarts,
        selectedPitcherBeta: pitcherSelection.selectedBeta,
        pitcherNestedSelection: pitcherSelection,
        homeDispersionK: homeK,
        awayDispersionK: awayK,
        leagueBaselineCountNll: round(foldLeague / denominator),
        teamOnlyCountNll: round(foldTeam / denominator),
        teamPlusPitcherCountNll: round(foldPitcher / denominator),
        leagueMinusTeamPlusPitcherCountNll: round((foldLeague - foldPitcher) / denominator),
        teamOnlyMinusTeamPlusPitcherCountNll: round((foldTeam - foldPitcher) / denominator),
        validationStarterLines: validation.length * 2,
        seenStarterLines: foldSeenStarterLines,
        coldStartStarterLines: foldColdStarterLines,
      });
    }

    const ready = validationGames >= configuration.minimumTotalValidationGames && countObservations > 0;
    const leagueNll = ready ? leagueTotal / countObservations : null;
    const teamNll = ready ? teamTotal / countObservations : null;
    const pitcherNll = ready ? pitcherTotal / countObservations : null;
    const leagueDelta = leagueNll != null && pitcherNll != null ? leagueNll - pitcherNll : null;
    const pitcherIncrement = teamNll != null && pitcherNll != null ? teamNll - pitcherNll : null;
    const relative = teamNll != null && teamNll > 0 && pitcherIncrement != null
      ? (pitcherIncrement / teamNll) * 100
      : null;
    const improved = ready && pitcherIncrement != null && pitcherIncrement > 0;

    horizons.push({
      horizon,
      observations: rows.length,
      uniqueDates: new Set(rows.map((row) => row.officialDate)).size,
      validationGames,
      status: !ready ? "INSUFFICIENT_OOS_SAMPLE" : improved ? "PITCHER_POINT_IMPROVEMENT" : "NO_PITCHER_POINT_IMPROVEMENT",
      leagueBaselineCountNll: leagueNll == null ? null : round(leagueNll),
      teamOnlyCountNll: teamNll == null ? null : round(teamNll),
      teamPlusPitcherCountNll: pitcherNll == null ? null : round(pitcherNll),
      leagueMinusTeamPlusPitcherCountNll: leagueDelta == null ? null : round(leagueDelta),
      teamOnlyMinusTeamPlusPitcherCountNll: pitcherIncrement == null ? null : round(pitcherIncrement),
      relativePitcherIncrementPctVsTeamOnly: relative == null ? null : round(relative, 6),
      validationStarterLines,
      seenStarterLines,
      coldStartStarterLines,
      coldStartStarterLinePct: validationStarterLines ? round((coldStartStarterLines / validationStarterLines) * 100, 6) : null,
      folds: foldMetrics,
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
      blockers: !ready
        ? ["P1_M6A3B2B2_INSUFFICIENT_OOS_SAMPLE", "NO_AUTOMATIC_PROMOTION"]
        : improved
          ? ["P1_M6A3B2B2_POINT_IMPROVEMENT_REQUIRES_PAIRED_INFERENCE", "NO_AUTOMATIC_PROMOTION"]
          : ["P1_M6A3B2B2_PITCHER_FEATURE_DID_NOT_IMPROVE_POINT_COUNT_NLL", "NO_AUTOMATIC_PROMOTION"],
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
      && fold.pitcherNestedSelection.leakageFree
      && fold.trainingMaxDate < fold.validationMinDate
      && fold.pitcherNestedSelection.innerHistoryMaxDate < fold.pitcherNestedSelection.innerValidationMinDate)),
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2B2_STARTING_PITCHER_CHALLENGER_ONLY",
      "P1_M6A3B2B2_PAIRED_INFERENCE_REQUIRED",
      "NO_AUTOMATIC_PROMOTION",
    ],
  };
}
