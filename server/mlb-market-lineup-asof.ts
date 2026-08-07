import crypto from "node:crypto";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
import type { MlbHistoricalPregameLineupSnapshot } from "./mlb-market-pregame-lineup-history";
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

export const MLB_P1_M6A3B2C2_SCHEMA = "courtedge-p1-m6a3b2c2-lineup-asof-oos.v1" as const;
export const MLB_P1_M6A3B2C2_MODEL = "NB2_TEAM_PLUS_LINEUP_PLAYER_RESIDUAL_RUN_FACTOR_SHRINKAGE" as const;

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];
const DEFAULT_TEAM_PRIOR_GRID = [5, 10, 20, 40, 80] as const;
const DEFAULT_PLAYER_PRIOR_GAMES_GRID = [5, 10, 20, 40, 80] as const;
const DEFAULT_LINEUP_EFFECT_GRID = [0, 0.25, 0.5, 0.75, 1] as const;
const DEFAULT_INNER_VALIDATION_DATES = 14;
const DEFAULT_MINIMUM_INNER_HISTORY_DATES = 30;
const LOG_EPS = 1e-15;

export interface MlbLineupPlayerEstimate {
  playerId: number;
  lineupGames: number;
  observedTeamRuns: number;
  expectedTeamRuns: number;
  residualRunFactor: number;
  historyMinDate: string;
  historyMaxDate: string;
}

export interface MlbLineupAsOfSnapshot {
  schemaVersion: typeof MLB_P1_M6A3B2C2_SCHEMA;
  model: typeof MLB_P1_M6A3B2C2_MODEL;
  horizon: MlbProbabilityHorizon;
  cutoffDateExclusive: string;
  teamPriorGames: number;
  playerPriorGames: number;
  eligibleOutcomeGames: number;
  eligibleLineupGames: number;
  historyMinDate: string;
  historyMaxDate: string;
  players: Record<string, MlbLineupPlayerEstimate>;
  snapshotDigest: string;
  actionabilityAllowed: false;
}

export interface MlbTeamPlusLineupPrediction {
  homeMeanRuns: number;
  awayMeanRuns: number;
  homeLineupFactor: number;
  awayLineupFactor: number;
  homeSeenBatters: number;
  awaySeenBatters: number;
  lineupEffectWeight: number;
}

export interface MlbLineupHyperparameterScore {
  teamPriorGames: number;
  playerPriorGames: number;
  lineupEffectWeight: number;
  validationGames: number;
  meanCountNegativeLogLikelihood: number;
}

export interface MlbLineupNestedSelection {
  selectedTeamPriorGames: number;
  selectedPlayerPriorGames: number;
  selectedLineupEffectWeight: number;
  candidates: MlbLineupHyperparameterScore[];
  innerHistoryDates: number;
  innerValidationDates: number;
  innerHistoryMaxDate: string;
  innerValidationMinDate: string;
  lineupSnapshotHistoryMaxDate: string;
  validationGamesWithCertifiedLineup: number;
  leakageFree: true;
}

export interface MlbLineupPairedRow {
  horizon: MlbProbabilityHorizon;
  foldIndex: number;
  gamePk: number;
  officialDate: string;
  leagueNb2CountNll: number;
  teamOnlyCountNll: number;
  teamPlusLineupCountNll: number;
  teamMinusLineupCountNll: number;
  leagueMinusLineupCountNll: number;
}

export interface MlbLineupFoldMetric {
  foldIndex: number;
  trainingGames: number;
  trainingCertifiedLineupGames: number;
  validationGames: number;
  validationGamesWithCertifiedLineup: number;
  validationGamesExcludedForLineup: number;
  trainingDates: number;
  validationDates: number;
  trainingMaxDate: string;
  validationMinDate: string;
  validationMaxDate: string;
  selectedTeamPriorGames: number;
  selectedPlayerPriorGames: number;
  selectedLineupEffectWeight: number;
  nestedSelection: MlbLineupNestedSelection;
  lineupSnapshotHistoryMaxDate: string;
  homeDispersionK: number;
  awayDispersionK: number;
  leagueNb2CountNegativeLogLikelihood: number;
  teamOnlyCountNegativeLogLikelihood: number;
  teamPlusLineupCountNegativeLogLikelihood: number;
  teamMinusLineupCountNll: number;
  leagueMinusLineupCountNll: number;
  bothLineupsAllBattersSeenValidationGames: number;
  atLeastOneUnseenBatterValidationGames: number;
  leakageFree: true;
}

export interface MlbLineupHorizonReport {
  horizon: MlbProbabilityHorizon;
  observations: number;
  uniqueDates: number;
  certifiedTargetObservations: number;
  validationGames: number;
  validationGamesExcludedForLineup: number;
  status: "LINEUP_OOS_IMPROVEMENT_OVER_TEAM" | "NO_LINEUP_OOS_IMPROVEMENT" | "INSUFFICIENT_OOS_SAMPLE";
  leagueNb2CountNegativeLogLikelihood: number | null;
  teamOnlyCountNegativeLogLikelihood: number | null;
  teamPlusLineupCountNegativeLogLikelihood: number | null;
  teamMinusLineupCountNll: number | null;
  leagueMinusLineupCountNll: number | null;
  relativeLineupReductionVsTeamPct: number | null;
  folds: MlbLineupFoldMetric[];
  pairedRows: MlbLineupPairedRow[];
  actionabilityAllowed: false;
  automaticPromotionAllowed: false;
  blockers: string[];
}

export interface MlbLineupOosReport {
  schemaVersion: typeof MLB_P1_M6A3B2C2_SCHEMA;
  model: typeof MLB_P1_M6A3B2C2_MODEL;
  generatedAt: string;
  configuration: {
    minimumTrainingDates: number;
    validationDateCount: number;
    stepDateCount: number;
    minimumTotalValidationGames: number;
    teamPriorGamesGrid: number[];
    playerPriorGamesGrid: number[];
    lineupEffectWeightGrid: number[];
    innerValidationDateCount: number;
    minimumInnerHistoryDates: number;
  };
  horizons: MlbLineupHorizonReport[];
  allFoldsLeakageFree: boolean;
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  automaticPromotionAllowed: false;
  blockers: [
    "P1_M6A3B2C2_LINEUP_CHALLENGER_ONLY",
    "P1_M6A3B2C2_PAIRED_INFERENCE_REQUIRED",
    "P1_M6A3B_FINAL_MODEL_CERTIFICATION_INCOMPLETE"
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
    throw new Error("P1_M6A3B2C2_INVALID_EFFECT_GRID");
  }
  return unique.sort((a, b) => a - b);
}

function validateObservations(rows: MlbHistoricalHorizonObservation[]): void {
  if (!rows.length) throw new Error("P1_M6A3B2C2_EMPTY_SAMPLE");
  const horizon = rows[0].horizon;
  for (const row of rows) {
    if (row.horizon !== horizon) throw new Error("P1_M6A3B2C2_MIXED_HORIZONS");
    if (!validIsoDate(row.officialDate)
      || !Number.isInteger(row.gamePk) || row.gamePk <= 0
      || !Number.isInteger(row.homeTeamId) || row.homeTeamId <= 0
      || !Number.isInteger(row.awayTeamId) || row.awayTeamId <= 0
      || row.homeTeamId === row.awayTeamId
      || !Number.isInteger(row.homeRuns) || row.homeRuns < 0
      || !Number.isInteger(row.awayRuns) || row.awayRuns < 0) {
      throw new Error("P1_M6A3B2C2_INVALID_OBSERVATION");
    }
  }
}

function validBattingOrder(order: number[]): boolean {
  return order.length === 9
    && order.every((playerId) => Number.isInteger(playerId) && playerId > 0)
    && new Set(order).size === 9;
}

function certifiedLineup(snapshot: MlbHistoricalPregameLineupSnapshot): boolean {
  return snapshot.complete === true
    && snapshot.availability === "COMPLETE"
    && validBattingOrder(snapshot.homeBattingOrder)
    && validBattingOrder(snapshot.awayBattingOrder);
}

function lineupMap(snapshots: MlbHistoricalPregameLineupSnapshot[]): Map<number, MlbHistoricalPregameLineupSnapshot> {
  const map = new Map<number, MlbHistoricalPregameLineupSnapshot>();
  for (const snapshot of snapshots) {
    if (!Number.isInteger(snapshot.gamePk) || snapshot.gamePk <= 0) {
      throw new Error("P1_M6A3B2C2_INVALID_LINEUP_GAMEPK");
    }
    if (map.has(snapshot.gamePk)) throw new Error("P1_M6A3B2C2_DUPLICATE_LINEUP_GAME");
    map.set(snapshot.gamePk, snapshot);
  }
  return map;
}

function verifyLineupIdentity(
  snapshot: MlbHistoricalPregameLineupSnapshot,
  row: MlbHistoricalHorizonObservation,
): void {
  if (snapshot.officialDate !== row.officialDate
    || snapshot.homeTeamId !== row.homeTeamId
    || snapshot.awayTeamId !== row.awayTeamId) {
    throw new Error(`P1_M6A3B2C2_LINEUP_IDENTITY_MISMATCH:${row.gamePk}`);
  }
}

function certifiedTargetLineup(
  map: Map<number, MlbHistoricalPregameLineupSnapshot>,
  row: MlbHistoricalHorizonObservation,
): MlbHistoricalPregameLineupSnapshot | null {
  const snapshot = map.get(row.gamePk);
  if (!snapshot || !certifiedLineup(snapshot)) return null;
  verifyLineupIdentity(snapshot, row);
  return snapshot;
}

function byDates(rows: MlbHistoricalHorizonObservation[], dates: string[]): MlbHistoricalHorizonObservation[] {
  const allowed = new Set(dates);
  return rows.filter((row) => allowed.has(row.officialDate));
}

function requireNb2Dispersion(fit: MlbMarginalRunFit): number {
  if (fit.family !== "NEGATIVE_BINOMIAL_NB2" || fit.dispersionK == null || !(fit.dispersionK > 0)) {
    throw new Error("P1_M6A3B2C2_NB2_DISPERSION_REQUIRED");
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

interface MutablePlayerAggregate {
  playerId: number;
  lineupGames: number;
  observedTeamRuns: number;
  expectedTeamRuns: number;
  minDate: string;
  maxDate: string;
}

export function buildMlbLineupAsOfSnapshot(
  rows: MlbHistoricalHorizonObservation[],
  lineupSnapshots: MlbHistoricalPregameLineupSnapshot[],
  cutoffDateExclusive: string,
  teamPriorGames: number,
  playerPriorGames: number,
): MlbLineupAsOfSnapshot {
  validateObservations(rows);
  if (!validIsoDate(cutoffDateExclusive)) throw new Error("P1_M6A3B2C2_INVALID_CUTOFF_DATE");
  if (!Number.isInteger(teamPriorGames) || teamPriorGames <= 0 || teamPriorGames > 10_000) {
    throw new Error("P1_M6A3B2C2_INVALID_TEAM_PRIOR_GAMES");
  }
  if (!Number.isInteger(playerPriorGames) || playerPriorGames <= 0 || playerPriorGames > 10_000) {
    throw new Error("P1_M6A3B2C2_INVALID_PLAYER_PRIOR_GAMES");
  }
  const eligibleRows = rows
    .filter((row) => row.officialDate < cutoffDateExclusive)
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  if (!eligibleRows.length) throw new Error("P1_M6A3B2C2_EMPTY_ASOF_OUTCOME_HISTORY");
  const teamSnapshot = buildMlbTeamStrengthSnapshot(eligibleRows, teamPriorGames);
  if (!(teamSnapshot.leagueOverallMean > 0)) throw new Error("P1_M6A3B2C2_INVALID_LEAGUE_RUN_MEAN");
  const lineups = lineupMap(lineupSnapshots);
  const aggregates = new Map<number, MutablePlayerAggregate>();
  const includedDates: string[] = [];
  let eligibleLineupGames = 0;

  const addPlayer = (playerId: number, observedRuns: number, expectedRuns: number, officialDate: string) => {
    let aggregate = aggregates.get(playerId);
    if (!aggregate) {
      aggregate = {
        playerId,
        lineupGames: 0,
        observedTeamRuns: 0,
        expectedTeamRuns: 0,
        minDate: officialDate,
        maxDate: officialDate,
      };
      aggregates.set(playerId, aggregate);
    }
    aggregate.lineupGames += 1;
    aggregate.observedTeamRuns += observedRuns;
    aggregate.expectedTeamRuns += expectedRuns;
    if (officialDate < aggregate.minDate) aggregate.minDate = officialDate;
    if (officialDate > aggregate.maxDate) aggregate.maxDate = officialDate;
  };

  for (const row of eligibleRows) {
    const lineup = certifiedTargetLineup(lineups, row);
    if (!lineup) continue;
    const teamPrediction = predictMlbTeamRunMeans(teamSnapshot, row);
    for (const playerId of lineup.homeBattingOrder) {
      addPlayer(playerId, row.homeRuns, teamPrediction.homeMeanRuns, row.officialDate);
    }
    for (const playerId of lineup.awayBattingOrder) {
      addPlayer(playerId, row.awayRuns, teamPrediction.awayMeanRuns, row.officialDate);
    }
    eligibleLineupGames += 1;
    includedDates.push(row.officialDate);
  }
  if (!eligibleLineupGames || !aggregates.size) throw new Error("P1_M6A3B2C2_EMPTY_ASOF_LINEUP_HISTORY");

  const priorRuns = playerPriorGames * teamSnapshot.leagueOverallMean;
  const players: Record<string, MlbLineupPlayerEstimate> = {};
  for (const aggregate of [...aggregates.values()].sort((a, b) => a.playerId - b.playerId)) {
    const denominator = aggregate.expectedTeamRuns + priorRuns;
    const factor = denominator > 0
      ? (aggregate.observedTeamRuns + priorRuns) / denominator
      : 1;
    if (!(factor > 0) || !Number.isFinite(factor)) throw new Error("P1_M6A3B2C2_INVALID_PLAYER_FACTOR");
    players[String(aggregate.playerId)] = {
      playerId: aggregate.playerId,
      lineupGames: aggregate.lineupGames,
      observedTeamRuns: round(aggregate.observedTeamRuns, 8),
      expectedTeamRuns: round(aggregate.expectedTeamRuns, 8),
      residualRunFactor: round(factor, 10),
      historyMinDate: aggregate.minDate,
      historyMaxDate: aggregate.maxDate,
    };
  }

  const uniqueDates = [...new Set(includedDates)].sort();
  const historyMinDate = uniqueDates[0];
  const historyMaxDate = uniqueDates.at(-1) as string;
  if (!(historyMaxDate < cutoffDateExclusive)) throw new Error("P1_M6A3B2C2_ASOF_TIME_LEAKAGE_DETECTED");

  const withoutDigest = {
    schemaVersion: MLB_P1_M6A3B2C2_SCHEMA,
    model: MLB_P1_M6A3B2C2_MODEL,
    horizon: eligibleRows[0].horizon,
    cutoffDateExclusive,
    teamPriorGames,
    playerPriorGames,
    eligibleOutcomeGames: eligibleRows.length,
    eligibleLineupGames,
    historyMinDate,
    historyMaxDate,
    players,
    actionabilityAllowed: false as const,
  };
  return { ...withoutDigest, snapshotDigest: digest(withoutDigest) };
}

function lineupFactor(
  order: number[],
  snapshot: MlbLineupAsOfSnapshot,
): { factor: number; seenBatters: number } {
  if (!validBattingOrder(order)) throw new Error("P1_M6A3B2C2_INVALID_TARGET_BATTING_ORDER");
  let logTotal = 0;
  let seenBatters = 0;
  for (const playerId of order) {
    const player = snapshot.players[String(playerId)] ?? null;
    const factor = player?.residualRunFactor ?? 1;
    if (player) seenBatters += 1;
    logTotal += Math.log(factor);
  }
  const factor = Math.exp(logTotal / order.length);
  if (!(factor > 0) || !Number.isFinite(factor)) throw new Error("P1_M6A3B2C2_INVALID_LINEUP_FACTOR");
  return { factor, seenBatters };
}

export function predictMlbTeamPlusLineupRunMeans(
  teamPrediction: { homeMeanRuns: number; awayMeanRuns: number },
  lineupSnapshot: MlbLineupAsOfSnapshot,
  targetLineup: MlbHistoricalPregameLineupSnapshot,
  lineupEffectWeight: number,
): MlbTeamPlusLineupPrediction {
  if (!Number.isFinite(lineupEffectWeight) || lineupEffectWeight < 0 || lineupEffectWeight > 1) {
    throw new Error("P1_M6A3B2C2_INVALID_LINEUP_EFFECT_WEIGHT");
  }
  if (!certifiedLineup(targetLineup)) throw new Error("P1_M6A3B2C2_TARGET_LINEUP_NOT_CERTIFIED");
  const home = lineupFactor(targetLineup.homeBattingOrder, lineupSnapshot);
  const away = lineupFactor(targetLineup.awayBattingOrder, lineupSnapshot);
  const homeMeanRuns = teamPrediction.homeMeanRuns * Math.pow(home.factor, lineupEffectWeight);
  const awayMeanRuns = teamPrediction.awayMeanRuns * Math.pow(away.factor, lineupEffectWeight);
  if (!Number.isFinite(homeMeanRuns) || homeMeanRuns < 0 || !Number.isFinite(awayMeanRuns) || awayMeanRuns < 0) {
    throw new Error("P1_M6A3B2C2_INVALID_EXPECTED_RUNS");
  }
  return {
    homeMeanRuns: round(homeMeanRuns, 10),
    awayMeanRuns: round(awayMeanRuns, 10),
    homeLineupFactor: round(home.factor, 10),
    awayLineupFactor: round(away.factor, 10),
    homeSeenBatters: home.seenBatters,
    awaySeenBatters: away.seenBatters,
    lineupEffectWeight,
  };
}

function evaluateCombination(
  historyRows: MlbHistoricalHorizonObservation[],
  validationRows: MlbHistoricalHorizonObservation[],
  lineupSnapshots: MlbHistoricalPregameLineupSnapshot[],
  teamPriorGames: number,
  playerPriorGames: number,
  lineupEffectWeight: number,
  cutoffDateExclusive: string,
): { nll: number; validationGames: number } {
  const teamSnapshot = buildMlbTeamStrengthSnapshot(historyRows, teamPriorGames);
  const lineupSnapshot = buildMlbLineupAsOfSnapshot(
    historyRows,
    lineupSnapshots,
    cutoffDateExclusive,
    teamPriorGames,
    playerPriorGames,
  );
  if (!(lineupSnapshot.historyMaxDate < cutoffDateExclusive)) throw new Error("P1_M6A3B2C2_INNER_LINEUP_TIME_LEAKAGE_DETECTED");
  const homeFit = fitMlbMarginalRunModel(historyRows.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
  const awayFit = fitMlbMarginalRunModel(historyRows.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
  const homeK = requireNb2Dispersion(homeFit);
  const awayK = requireNb2Dispersion(awayFit);
  const lineups = lineupMap(lineupSnapshots);
  let total = 0;
  let used = 0;
  for (const row of validationRows) {
    const target = certifiedTargetLineup(lineups, row);
    if (!target) continue;
    const teamPrediction = predictMlbTeamRunMeans(teamSnapshot, row);
    const lineupPrediction = predictMlbTeamPlusLineupRunMeans(
      teamPrediction,
      lineupSnapshot,
      target,
      lineupEffectWeight,
    );
    total += rowCountNll(row, lineupPrediction.homeMeanRuns, lineupPrediction.awayMeanRuns, homeK, awayK);
    used += 1;
  }
  if (!used) throw new Error("P1_M6A3B2C2_NO_CERTIFIED_INNER_VALIDATION_LINEUPS");
  return { nll: total / (used * 2), validationGames: used };
}

export function selectMlbLineupHyperparametersNested(
  trainingRows: MlbHistoricalHorizonObservation[],
  lineupSnapshots: MlbHistoricalPregameLineupSnapshot[],
  options: {
    teamPriorGamesGrid?: number[];
    playerPriorGamesGrid?: number[];
    lineupEffectWeightGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
  } = {},
): MlbLineupNestedSelection {
  validateObservations(trainingRows);
  const teamGrid = validatePositiveIntegerGrid(
    options.teamPriorGamesGrid ?? [...DEFAULT_TEAM_PRIOR_GRID],
    "P1_M6A3B2C2_INVALID_TEAM_PRIOR_GRID",
  );
  const playerGrid = validatePositiveIntegerGrid(
    options.playerPriorGamesGrid ?? [...DEFAULT_PLAYER_PRIOR_GAMES_GRID],
    "P1_M6A3B2C2_INVALID_PLAYER_PRIOR_GRID",
  );
  const effectGrid = validateEffectGrid(options.lineupEffectWeightGrid ?? [...DEFAULT_LINEUP_EFFECT_GRID]);
  const innerValidationDateCount = options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES;
  const minimumInnerHistoryDates = options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES;
  if (!Number.isInteger(innerValidationDateCount) || innerValidationDateCount <= 0
    || !Number.isInteger(minimumInnerHistoryDates) || minimumInnerHistoryDates <= 0) {
    throw new Error("P1_M6A3B2C2_INVALID_INNER_CONFIGURATION");
  }
  const dates = [...new Set(trainingRows.map((row) => row.officialDate))].sort();
  if (dates.length < minimumInnerHistoryDates + innerValidationDateCount) {
    throw new Error("P1_M6A3B2C2_INSUFFICIENT_INNER_HISTORY");
  }
  const innerValidationDates = dates.slice(-innerValidationDateCount);
  const innerHistoryDates = dates.slice(0, -innerValidationDateCount);
  const innerHistory = byDates(trainingRows, innerHistoryDates);
  const innerValidation = byDates(trainingRows, innerValidationDates);
  const innerHistoryMaxDate = innerHistoryDates.at(-1) as string;
  const innerValidationMinDate = innerValidationDates[0];
  if (!(innerHistoryMaxDate < innerValidationMinDate)) throw new Error("P1_M6A3B2C2_INNER_TIME_LEAKAGE_DETECTED");

  const candidates: MlbLineupHyperparameterScore[] = [];
  for (const teamPriorGames of teamGrid) {
    for (const playerPriorGames of playerGrid) {
      for (const lineupEffectWeight of effectGrid) {
        const result = evaluateCombination(
          innerHistory,
          innerValidation,
          lineupSnapshots,
          teamPriorGames,
          playerPriorGames,
          lineupEffectWeight,
          innerValidationMinDate,
        );
        candidates.push({
          teamPriorGames,
          playerPriorGames,
          lineupEffectWeight,
          validationGames: result.validationGames,
          meanCountNegativeLogLikelihood: round(result.nll),
        });
      }
    }
  }
  if (!candidates.length) throw new Error("P1_M6A3B2C2_NO_HYPERPARAMETER_CANDIDATES");
  let selected = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const delta = candidate.meanCountNegativeLogLikelihood - selected.meanCountNegativeLogLikelihood;
    const tied = Math.abs(delta) <= 1e-10;
    const moreConservative = candidate.lineupEffectWeight < selected.lineupEffectWeight
      || (candidate.lineupEffectWeight === selected.lineupEffectWeight
        && candidate.playerPriorGames > selected.playerPriorGames)
      || (candidate.lineupEffectWeight === selected.lineupEffectWeight
        && candidate.playerPriorGames === selected.playerPriorGames
        && candidate.teamPriorGames > selected.teamPriorGames);
    if (delta < -1e-10 || (tied && moreConservative)) selected = candidate;
  }
  const selectedSnapshot = buildMlbLineupAsOfSnapshot(
    innerHistory,
    lineupSnapshots,
    innerValidationMinDate,
    selected.teamPriorGames,
    selected.playerPriorGames,
  );
  if (!(selectedSnapshot.historyMaxDate < innerValidationMinDate)) {
    throw new Error("P1_M6A3B2C2_INNER_LINEUP_TIME_LEAKAGE_DETECTED");
  }
  return {
    selectedTeamPriorGames: selected.teamPriorGames,
    selectedPlayerPriorGames: selected.playerPriorGames,
    selectedLineupEffectWeight: selected.lineupEffectWeight,
    candidates,
    innerHistoryDates: innerHistoryDates.length,
    innerValidationDates: innerValidationDates.length,
    innerHistoryMaxDate,
    innerValidationMinDate,
    lineupSnapshotHistoryMaxDate: selectedSnapshot.historyMaxDate,
    validationGamesWithCertifiedLineup: selected.validationGames,
    leakageFree: true,
  };
}

export function buildMlbLineupOosReport(
  observations: MlbHistoricalHorizonObservation[],
  lineupSnapshots: MlbHistoricalPregameLineupSnapshot[],
  options: {
    minimumTrainingDates?: number;
    validationDateCount?: number;
    stepDateCount?: number;
    minimumTotalValidationGames?: number;
    teamPriorGamesGrid?: number[];
    playerPriorGamesGrid?: number[];
    lineupEffectWeightGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
    generatedAt?: string;
  } = {},
): MlbLineupOosReport {
  if (!observations.length) throw new Error("P1_M6A3B2C2_EMPTY_SAMPLE");
  if (!lineupSnapshots.length) throw new Error("P1_M6A3B2C2_EMPTY_LINEUP_HISTORY");
  const configuration = {
    minimumTrainingDates: options.minimumTrainingDates ?? 60,
    validationDateCount: options.validationDateCount ?? 14,
    stepDateCount: options.stepDateCount ?? 14,
    minimumTotalValidationGames: options.minimumTotalValidationGames ?? 300,
    teamPriorGamesGrid: validatePositiveIntegerGrid(
      options.teamPriorGamesGrid ?? [...DEFAULT_TEAM_PRIOR_GRID],
      "P1_M6A3B2C2_INVALID_TEAM_PRIOR_GRID",
    ),
    playerPriorGamesGrid: validatePositiveIntegerGrid(
      options.playerPriorGamesGrid ?? [...DEFAULT_PLAYER_PRIOR_GAMES_GRID],
      "P1_M6A3B2C2_INVALID_PLAYER_PRIOR_GRID",
    ),
    lineupEffectWeightGrid: validateEffectGrid(options.lineupEffectWeightGrid ?? [...DEFAULT_LINEUP_EFFECT_GRID]),
    innerValidationDateCount: options.innerValidationDateCount ?? DEFAULT_INNER_VALIDATION_DATES,
    minimumInnerHistoryDates: options.minimumInnerHistoryDates ?? DEFAULT_MINIMUM_INNER_HISTORY_DATES,
  };
  if (![configuration.minimumTrainingDates, configuration.validationDateCount, configuration.stepDateCount,
    configuration.minimumTotalValidationGames, configuration.innerValidationDateCount,
    configuration.minimumInnerHistoryDates].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("P1_M6A3B2C2_INVALID_OOS_CONFIGURATION");
  }

  const lineups = lineupMap(lineupSnapshots);
  const horizons: MlbLineupHorizonReport[] = [];
  for (const horizon of HORIZONS) {
    const rows = observations.filter((row) => row.horizon === horizon)
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    if (!rows.length) {
      horizons.push({
        horizon,
        observations: 0,
        uniqueDates: 0,
        certifiedTargetObservations: 0,
        validationGames: 0,
        validationGamesExcludedForLineup: 0,
        status: "INSUFFICIENT_OOS_SAMPLE",
        leagueNb2CountNegativeLogLikelihood: null,
        teamOnlyCountNegativeLogLikelihood: null,
        teamPlusLineupCountNegativeLogLikelihood: null,
        teamMinusLineupCountNll: null,
        leagueMinusLineupCountNll: null,
        relativeLineupReductionVsTeamPct: null,
        folds: [],
        pairedRows: [],
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
        blockers: ["P1_M6A3B2C2_INSUFFICIENT_OOS_SAMPLE", "NO_AUTOMATIC_PROMOTION"],
      });
      continue;
    }
    validateObservations(rows);
    const certifiedTargetObservations = rows.reduce((sum, row) =>
      sum + (certifiedTargetLineup(lineups, row) ? 1 : 0), 0);
    const folds = buildMlbRollingOriginDateFolds(rows, configuration);
    const foldMetrics: MlbLineupFoldMetric[] = [];
    const pairedRows: MlbLineupPairedRow[] = [];
    let leagueNllTotal = 0;
    let teamNllTotal = 0;
    let lineupNllTotal = 0;
    let countObservations = 0;
    let validationGames = 0;
    let validationGamesExcludedForLineup = 0;

    for (const fold of folds) {
      const training = byDates(rows, fold.trainingDates);
      const validationRaw = byDates(rows, fold.validationDates);
      if (!training.length || !validationRaw.length) continue;
      if (!(fold.trainingMaxDate < fold.validationMinDate)) throw new Error("P1_M6A3B2C2_OUTER_TIME_LEAKAGE_DETECTED");
      const validation = validationRaw.filter((row) => certifiedTargetLineup(lineups, row) != null);
      if (!validation.length) {
        validationGamesExcludedForLineup += validationRaw.length;
        continue;
      }
      const nestedSelection = selectMlbLineupHyperparametersNested(training, lineupSnapshots, {
        teamPriorGamesGrid: configuration.teamPriorGamesGrid,
        playerPriorGamesGrid: configuration.playerPriorGamesGrid,
        lineupEffectWeightGrid: configuration.lineupEffectWeightGrid,
        innerValidationDateCount: configuration.innerValidationDateCount,
        minimumInnerHistoryDates: configuration.minimumInnerHistoryDates,
      });
      const teamSnapshot = buildMlbTeamStrengthSnapshot(training, nestedSelection.selectedTeamPriorGames);
      const lineupSnapshot = buildMlbLineupAsOfSnapshot(
        training,
        lineupSnapshots,
        fold.validationMinDate,
        nestedSelection.selectedTeamPriorGames,
        nestedSelection.selectedPlayerPriorGames,
      );
      if (!(lineupSnapshot.historyMaxDate < fold.validationMinDate)) {
        throw new Error("P1_M6A3B2C2_OUTER_LINEUP_TIME_LEAKAGE_DETECTED");
      }
      const homeFit = fitMlbMarginalRunModel(training.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
      const awayFit = fitMlbMarginalRunModel(training.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
      const homeK = requireNb2Dispersion(homeFit);
      const awayK = requireNb2Dispersion(awayFit);

      let foldLeagueNll = 0;
      let foldTeamNll = 0;
      let foldLineupNll = 0;
      let bothAllSeen = 0;
      let atLeastOneUnseen = 0;

      for (const row of validation) {
        const target = certifiedTargetLineup(lineups, row);
        if (!target) throw new Error("P1_M6A3B2C2_CERTIFIED_TARGET_DISAPPEARED");
        const teamPrediction = predictMlbTeamRunMeans(teamSnapshot, row);
        const lineupPrediction = predictMlbTeamPlusLineupRunMeans(
          teamPrediction,
          lineupSnapshot,
          target,
          nestedSelection.selectedLineupEffectWeight,
        );
        if (lineupPrediction.homeSeenBatters === 9 && lineupPrediction.awaySeenBatters === 9) bothAllSeen += 1;
        else atLeastOneUnseen += 1;

        const leagueRowNll = rowCountNll(row, homeFit.meanRuns, awayFit.meanRuns, homeK, awayK);
        const teamRowNll = rowCountNll(row, teamPrediction.homeMeanRuns, teamPrediction.awayMeanRuns, homeK, awayK);
        const lineupRowNll = rowCountNll(row, lineupPrediction.homeMeanRuns, lineupPrediction.awayMeanRuns, homeK, awayK);
        foldLeagueNll += leagueRowNll;
        foldTeamNll += teamRowNll;
        foldLineupNll += lineupRowNll;
        leagueNllTotal += leagueRowNll;
        teamNllTotal += teamRowNll;
        lineupNllTotal += lineupRowNll;
        countObservations += 2;
        pairedRows.push({
          horizon,
          foldIndex: fold.foldIndex,
          gamePk: row.gamePk,
          officialDate: row.officialDate,
          leagueNb2CountNll: round(leagueRowNll / 2),
          teamOnlyCountNll: round(teamRowNll / 2),
          teamPlusLineupCountNll: round(lineupRowNll / 2),
          teamMinusLineupCountNll: round((teamRowNll - lineupRowNll) / 2),
          leagueMinusLineupCountNll: round((leagueRowNll - lineupRowNll) / 2),
        });
      }

      validationGames += validation.length;
      const excluded = validationRaw.length - validation.length;
      validationGamesExcludedForLineup += excluded;
      const denominator = validation.length * 2;
      foldMetrics.push({
        foldIndex: fold.foldIndex,
        trainingGames: training.length,
        trainingCertifiedLineupGames: lineupSnapshot.eligibleLineupGames,
        validationGames: validationRaw.length,
        validationGamesWithCertifiedLineup: validation.length,
        validationGamesExcludedForLineup: excluded,
        trainingDates: fold.trainingDates.length,
        validationDates: fold.validationDates.length,
        trainingMaxDate: fold.trainingMaxDate,
        validationMinDate: fold.validationMinDate,
        validationMaxDate: fold.validationMaxDate,
        selectedTeamPriorGames: nestedSelection.selectedTeamPriorGames,
        selectedPlayerPriorGames: nestedSelection.selectedPlayerPriorGames,
        selectedLineupEffectWeight: nestedSelection.selectedLineupEffectWeight,
        nestedSelection,
        lineupSnapshotHistoryMaxDate: lineupSnapshot.historyMaxDate,
        homeDispersionK: homeK,
        awayDispersionK: awayK,
        leagueNb2CountNegativeLogLikelihood: round(foldLeagueNll / denominator),
        teamOnlyCountNegativeLogLikelihood: round(foldTeamNll / denominator),
        teamPlusLineupCountNegativeLogLikelihood: round(foldLineupNll / denominator),
        teamMinusLineupCountNll: round((foldTeamNll - foldLineupNll) / denominator),
        leagueMinusLineupCountNll: round((foldLeagueNll - foldLineupNll) / denominator),
        bothLineupsAllBattersSeenValidationGames: bothAllSeen,
        atLeastOneUnseenBatterValidationGames: atLeastOneUnseen,
        leakageFree: true,
      });
    }

    const ready = validationGames >= configuration.minimumTotalValidationGames && countObservations > 0;
    const leagueNll = countObservations ? leagueNllTotal / countObservations : null;
    const teamNll = countObservations ? teamNllTotal / countObservations : null;
    const lineupNll = countObservations ? lineupNllTotal / countObservations : null;
    const teamDelta = teamNll != null && lineupNll != null ? teamNll - lineupNll : null;
    const leagueDelta = leagueNll != null && lineupNll != null ? leagueNll - lineupNll : null;
    const relative = teamNll != null && teamNll > 0 && teamDelta != null ? (teamDelta / teamNll) * 100 : null;
    const improved = ready && teamDelta != null && teamDelta > 0;
    horizons.push({
      horizon,
      observations: rows.length,
      uniqueDates: new Set(rows.map((row) => row.officialDate)).size,
      certifiedTargetObservations,
      validationGames,
      validationGamesExcludedForLineup,
      status: !ready ? "INSUFFICIENT_OOS_SAMPLE" : improved
        ? "LINEUP_OOS_IMPROVEMENT_OVER_TEAM"
        : "NO_LINEUP_OOS_IMPROVEMENT",
      leagueNb2CountNegativeLogLikelihood: leagueNll == null ? null : round(leagueNll),
      teamOnlyCountNegativeLogLikelihood: teamNll == null ? null : round(teamNll),
      teamPlusLineupCountNegativeLogLikelihood: lineupNll == null ? null : round(lineupNll),
      teamMinusLineupCountNll: teamDelta == null ? null : round(teamDelta),
      leagueMinusLineupCountNll: leagueDelta == null ? null : round(leagueDelta),
      relativeLineupReductionVsTeamPct: relative == null ? null : round(relative, 6),
      folds: foldMetrics,
      pairedRows,
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
      blockers: !ready
        ? ["P1_M6A3B2C2_INSUFFICIENT_OOS_SAMPLE", "NO_AUTOMATIC_PROMOTION"]
        : improved
          ? ["P1_M6A3B2C2_POINT_ESTIMATE_ONLY", "P1_M6A3B2C2_PAIRED_INFERENCE_REQUIRED", "NO_AUTOMATIC_PROMOTION"]
          : ["P1_M6A3B2C2_LINEUP_FEATURE_DID_NOT_IMPROVE_TEAM_COUNT_NLL", "NO_AUTOMATIC_PROMOTION"],
    });
  }

  return {
    schemaVersion: MLB_P1_M6A3B2C2_SCHEMA,
    model: MLB_P1_M6A3B2C2_MODEL,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration,
    horizons,
    allFoldsLeakageFree: horizons.every((horizon) => horizon.folds.every((fold) =>
      fold.leakageFree
      && fold.nestedSelection.leakageFree
      && fold.trainingMaxDate < fold.validationMinDate
      && fold.lineupSnapshotHistoryMaxDate < fold.validationMinDate
      && fold.nestedSelection.lineupSnapshotHistoryMaxDate < fold.nestedSelection.innerValidationMinDate)),
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2C2_LINEUP_CHALLENGER_ONLY",
      "P1_M6A3B2C2_PAIRED_INFERENCE_REQUIRED",
      "P1_M6A3B_FINAL_MODEL_CERTIFICATION_INCOMPLETE",
    ],
  };
}
