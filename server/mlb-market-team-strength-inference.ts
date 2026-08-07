import crypto from "node:crypto";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
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

export const MLB_P1_M6A3B2A_INFERENCE_SCHEMA = "courtedge-p1-m6a3b2a-paired-date-inference.v1" as const;

const LOG_EPS = 1e-15;
const DEFAULT_PRIOR_GRID = [5, 10, 20, 40, 80] as const;
const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];
const DEFAULT_BOOTSTRAP_REPLICATES = 5000;
const DEFAULT_MINIMUM_DATE_CLUSTERS = 30;
const FAMILYWISE_HORIZONS = 4;

export type MlbTeamStrengthPairedEvidenceStatus =
  | "SUPPORTED_IMPROVEMENT"
  | "SUPPORTED_REGRESSION"
  | "INCONCLUSIVE"
  | "INSUFFICIENT_OOS_SAMPLE";

export interface MlbPairedDateCluster {
  officialDate: string;
  games: number;
  countObservations: number;
  baselineNllTotal: number;
  challengerNllTotal: number;
  baselineMinusChallengerNllTotal: number;
  baselineMinusChallengerMeanCountNll: number;
}

export interface MlbBootstrapInterval {
  confidenceLevel: number;
  lower: number;
  upper: number;
}

export interface MlbPairedDateInferenceHorizon {
  horizon: MlbProbabilityHorizon;
  validationGames: number;
  countObservations: number;
  dateClusters: number;
  pointEstimateBaselineMinusChallengerCountNll: number | null;
  unadjusted95: MlbBootstrapInterval | null;
  bonferroniFamilywise: MlbBootstrapInterval | null;
  familywiseHorizons: number;
  bootstrapReplicates: number;
  bootstrapSeed: number | null;
  evidenceStatus: MlbTeamStrengthPairedEvidenceStatus;
  actionabilityAllowed: false;
  automaticPromotionAllowed: false;
  blockers: string[];
}

export interface MlbTeamStrengthPairedInferenceReport {
  schemaVersion: typeof MLB_P1_M6A3B2A_INFERENCE_SCHEMA;
  generatedAt: string;
  configuration: {
    minimumTrainingDates: number;
    validationDateCount: number;
    stepDateCount: number;
    minimumTotalValidationGames: number;
    priorGamesGrid: number[];
    innerValidationDateCount: number;
    minimumInnerHistoryDates: number;
    bootstrapReplicates: number;
    minimumDateClusters: number;
    familywiseHorizons: number;
  };
  horizons: MlbPairedDateInferenceHorizon[];
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  automaticPromotionAllowed: false;
  blockers: [
    "P1_M6A3B2A_PAIRED_DATE_INFERENCE_RESEARCH_ONLY",
    "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED",
    "NO_AUTOMATIC_PROMOTION"
  ];
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validatePriorGrid(grid: number[]): number[] {
  const unique = [...new Set(grid)];
  if (!unique.length || unique.some((value) => !Number.isInteger(value) || value <= 0 || value > 500)) {
    throw new Error("P1_M6A3B2A_INFERENCE_INVALID_PRIOR_GRID");
  }
  return unique.sort((a, b) => a - b);
}

function materializeByDates(
  rows: MlbHistoricalHorizonObservation[],
  dates: string[],
): MlbHistoricalHorizonObservation[] {
  const allowed = new Set(dates);
  return rows.filter((row) => allowed.has(row.officialDate));
}

function requireDispersion(value: number | null): number {
  if (!(value != null && Number.isFinite(value) && value > 0)) {
    throw new Error("P1_M6A3B2A_INFERENCE_NB2_DISPERSION_REQUIRED");
  }
  return value;
}

function rowNll(
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

function seedFromClusters(horizon: MlbProbabilityHorizon, clusters: MlbPairedDateCluster[]): number {
  const canonical = JSON.stringify({
    horizon,
    clusters: clusters.map((cluster) => ({
      officialDate: cluster.officialDate,
      games: cluster.games,
      countObservations: cluster.countObservations,
      baselineMinusChallengerNllTotal: cluster.baselineMinusChallengerNllTotal,
    })),
  });
  const bytes = crypto.createHash("sha256").update(canonical).digest();
  const seed = bytes.readUInt32BE(0) >>> 0;
  return seed === 0 ? 0x9e3779b9 : seed;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function quantile(sorted: number[], probability: number): number {
  if (!sorted.length || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("P1_M6A3B2A_INFERENCE_INVALID_QUANTILE");
  }
  if (sorted.length === 1) return sorted[0];
  const index = probability * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function bootstrapMlbPairedDateClusters(
  horizon: MlbProbabilityHorizon,
  clusters: MlbPairedDateCluster[],
  options: { replicates?: number; familywiseHorizons?: number } = {},
): {
  seed: number;
  pointEstimate: number;
  unadjusted95: MlbBootstrapInterval;
  bonferroniFamilywise: MlbBootstrapInterval;
} {
  if (!clusters.length || clusters.some((cluster) =>
    !/^\d{4}-\d{2}-\d{2}$/.test(cluster.officialDate)
    || !Number.isInteger(cluster.games) || cluster.games <= 0
    || !Number.isInteger(cluster.countObservations) || cluster.countObservations <= 0
    || !Number.isFinite(cluster.baselineMinusChallengerNllTotal))) {
    throw new Error("P1_M6A3B2A_INFERENCE_INVALID_DATE_CLUSTER");
  }
  const replicates = options.replicates ?? DEFAULT_BOOTSTRAP_REPLICATES;
  const familywiseHorizons = options.familywiseHorizons ?? FAMILYWISE_HORIZONS;
  if (!Number.isInteger(replicates) || replicates < 500 || replicates > 50_000) {
    throw new Error("P1_M6A3B2A_INFERENCE_INVALID_BOOTSTRAP_REPLICATES");
  }
  if (!Number.isInteger(familywiseHorizons) || familywiseHorizons <= 0 || familywiseHorizons > 20) {
    throw new Error("P1_M6A3B2A_INFERENCE_INVALID_FAMILYWISE_HORIZONS");
  }

  const totalDelta = clusters.reduce((sum, cluster) => sum + cluster.baselineMinusChallengerNllTotal, 0);
  const totalCount = clusters.reduce((sum, cluster) => sum + cluster.countObservations, 0);
  const pointEstimate = totalDelta / totalCount;
  const seed = seedFromClusters(horizon, clusters);
  const random = xorshift32(seed);
  const samples: number[] = [];

  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let sampledDelta = 0;
    let sampledCount = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const index = Math.min(clusters.length - 1, Math.floor(random() * clusters.length));
      const cluster = clusters[index];
      sampledDelta += cluster.baselineMinusChallengerNllTotal;
      sampledCount += cluster.countObservations;
    }
    samples.push(sampledDelta / sampledCount);
  }
  samples.sort((a, b) => a - b);

  const unadjustedAlpha = 0.05;
  const familywiseAlpha = 0.05 / familywiseHorizons;
  const interval = (alpha: number): MlbBootstrapInterval => ({
    confidenceLevel: round(1 - alpha, 6),
    lower: round(quantile(samples, alpha / 2)),
    upper: round(quantile(samples, 1 - alpha / 2)),
  });

  return {
    seed,
    pointEstimate: round(pointEstimate),
    unadjusted95: interval(unadjustedAlpha),
    bonferroniFamilywise: interval(familywiseAlpha),
  };
}

function buildDateClusters(
  horizon: MlbProbabilityHorizon,
  rows: MlbHistoricalHorizonObservation[],
  options: {
    minimumTrainingDates: number;
    validationDateCount: number;
    stepDateCount: number;
    priorGamesGrid: number[];
    innerValidationDateCount: number;
    minimumInnerHistoryDates: number;
  },
): { clusters: MlbPairedDateCluster[]; validationGames: number; countObservations: number } {
  const folds = buildMlbRollingOriginDateFolds(rows, options);
  const byDate = new Map<string, {
    games: number;
    countObservations: number;
    baselineNllTotal: number;
    challengerNllTotal: number;
  }>();
  let validationGames = 0;
  let countObservations = 0;

  for (const fold of folds) {
    if (!(fold.trainingMaxDate < fold.validationMinDate)) {
      throw new Error("P1_M6A3B2A_INFERENCE_OUTER_TIME_LEAKAGE_DETECTED");
    }
    const training = materializeByDates(rows, fold.trainingDates);
    const validation = materializeByDates(rows, fold.validationDates);
    if (!training.length || !validation.length) continue;

    const prior = selectMlbTeamPriorGamesNested(training, {
      priorGamesGrid: options.priorGamesGrid,
      innerValidationDateCount: options.innerValidationDateCount,
      minimumInnerHistoryDates: options.minimumInnerHistoryDates,
    });
    if (!(prior.innerHistoryMaxDate < prior.innerValidationMinDate)) {
      throw new Error("P1_M6A3B2A_INFERENCE_INNER_TIME_LEAKAGE_DETECTED");
    }
    const snapshot = buildMlbTeamStrengthSnapshot(training, prior.selectedPriorGames);
    const homeFit = fitMlbMarginalRunModel(training.map((row) => row.homeRuns), "NEGATIVE_BINOMIAL_NB2");
    const awayFit = fitMlbMarginalRunModel(training.map((row) => row.awayRuns), "NEGATIVE_BINOMIAL_NB2");
    const homeK = requireDispersion(homeFit.dispersionK);
    const awayK = requireDispersion(awayFit.dispersionK);

    for (const row of validation) {
      const prediction = predictMlbTeamRunMeans(snapshot, row);
      const baseline = rowNll(row, homeFit.meanRuns, awayFit.meanRuns, homeK, awayK);
      const challenger = rowNll(row, prediction.homeMeanRuns, prediction.awayMeanRuns, homeK, awayK);
      let cluster = byDate.get(row.officialDate);
      if (!cluster) {
        cluster = { games: 0, countObservations: 0, baselineNllTotal: 0, challengerNllTotal: 0 };
        byDate.set(row.officialDate, cluster);
      }
      cluster.games += 1;
      cluster.countObservations += 2;
      cluster.baselineNllTotal += baseline;
      cluster.challengerNllTotal += challenger;
      validationGames += 1;
      countObservations += 2;
    }
  }

  const clusters: MlbPairedDateCluster[] = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([officialDate, cluster]) => {
      const delta = cluster.baselineNllTotal - cluster.challengerNllTotal;
      return {
        officialDate,
        games: cluster.games,
        countObservations: cluster.countObservations,
        baselineNllTotal: round(cluster.baselineNllTotal, 10),
        challengerNllTotal: round(cluster.challengerNllTotal, 10),
        baselineMinusChallengerNllTotal: round(delta, 10),
        baselineMinusChallengerMeanCountNll: round(delta / cluster.countObservations, 10),
      };
    });

  return { clusters, validationGames, countObservations };
}

export function buildMlbTeamStrengthPairedInferenceReport(
  observations: MlbHistoricalHorizonObservation[],
  options: {
    minimumTrainingDates?: number;
    validationDateCount?: number;
    stepDateCount?: number;
    minimumTotalValidationGames?: number;
    priorGamesGrid?: number[];
    innerValidationDateCount?: number;
    minimumInnerHistoryDates?: number;
    bootstrapReplicates?: number;
    minimumDateClusters?: number;
    generatedAt?: string;
  } = {},
): MlbTeamStrengthPairedInferenceReport {
  if (!observations.length) throw new Error("P1_M6A3B2A_INFERENCE_EMPTY_SAMPLE");
  const configuration = {
    minimumTrainingDates: options.minimumTrainingDates ?? 60,
    validationDateCount: options.validationDateCount ?? 14,
    stepDateCount: options.stepDateCount ?? 14,
    minimumTotalValidationGames: options.minimumTotalValidationGames ?? 300,
    priorGamesGrid: validatePriorGrid(options.priorGamesGrid ?? [...DEFAULT_PRIOR_GRID]),
    innerValidationDateCount: options.innerValidationDateCount ?? 14,
    minimumInnerHistoryDates: options.minimumInnerHistoryDates ?? 30,
    bootstrapReplicates: options.bootstrapReplicates ?? DEFAULT_BOOTSTRAP_REPLICATES,
    minimumDateClusters: options.minimumDateClusters ?? DEFAULT_MINIMUM_DATE_CLUSTERS,
    familywiseHorizons: FAMILYWISE_HORIZONS,
  };
  if (!Number.isInteger(configuration.minimumTotalValidationGames) || configuration.minimumTotalValidationGames <= 0
    || !Number.isInteger(configuration.minimumDateClusters) || configuration.minimumDateClusters <= 0) {
    throw new Error("P1_M6A3B2A_INFERENCE_INVALID_SAMPLE_FLOOR");
  }

  const horizons: MlbPairedDateInferenceHorizon[] = [];
  for (const horizon of HORIZONS) {
    const rows = observations.filter((row) => row.horizon === horizon)
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    if (!rows.length) {
      horizons.push({
        horizon,
        validationGames: 0,
        countObservations: 0,
        dateClusters: 0,
        pointEstimateBaselineMinusChallengerCountNll: null,
        unadjusted95: null,
        bonferroniFamilywise: null,
        familywiseHorizons: FAMILYWISE_HORIZONS,
        bootstrapReplicates: configuration.bootstrapReplicates,
        bootstrapSeed: null,
        evidenceStatus: "INSUFFICIENT_OOS_SAMPLE",
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
        blockers: ["P1_M6A3B2A_INFERENCE_INSUFFICIENT_OOS_SAMPLE"],
      });
      continue;
    }

    const built = buildDateClusters(horizon, rows, configuration);
    const enough = built.validationGames >= configuration.minimumTotalValidationGames
      && built.clusters.length >= configuration.minimumDateClusters;
    if (!enough) {
      horizons.push({
        horizon,
        validationGames: built.validationGames,
        countObservations: built.countObservations,
        dateClusters: built.clusters.length,
        pointEstimateBaselineMinusChallengerCountNll: built.countObservations
          ? round(built.clusters.reduce((sum, cluster) => sum + cluster.baselineMinusChallengerNllTotal, 0) / built.countObservations)
          : null,
        unadjusted95: null,
        bonferroniFamilywise: null,
        familywiseHorizons: FAMILYWISE_HORIZONS,
        bootstrapReplicates: configuration.bootstrapReplicates,
        bootstrapSeed: null,
        evidenceStatus: "INSUFFICIENT_OOS_SAMPLE",
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
        blockers: ["P1_M6A3B2A_INFERENCE_INSUFFICIENT_OOS_SAMPLE"],
      });
      continue;
    }

    const bootstrap = bootstrapMlbPairedDateClusters(horizon, built.clusters, {
      replicates: configuration.bootstrapReplicates,
      familywiseHorizons: FAMILYWISE_HORIZONS,
    });
    const adjusted = bootstrap.bonferroniFamilywise;
    const evidenceStatus: MlbTeamStrengthPairedEvidenceStatus = adjusted.lower > 0
      ? "SUPPORTED_IMPROVEMENT"
      : adjusted.upper < 0
        ? "SUPPORTED_REGRESSION"
        : "INCONCLUSIVE";

    horizons.push({
      horizon,
      validationGames: built.validationGames,
      countObservations: built.countObservations,
      dateClusters: built.clusters.length,
      pointEstimateBaselineMinusChallengerCountNll: bootstrap.pointEstimate,
      unadjusted95: bootstrap.unadjusted95,
      bonferroniFamilywise: bootstrap.bonferroniFamilywise,
      familywiseHorizons: FAMILYWISE_HORIZONS,
      bootstrapReplicates: configuration.bootstrapReplicates,
      bootstrapSeed: bootstrap.seed,
      evidenceStatus,
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
      blockers: evidenceStatus === "SUPPORTED_IMPROVEMENT"
        ? ["P1_M6A3B2A_RESEARCH_IMPROVEMENT_ONLY", "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED", "NO_AUTOMATIC_PROMOTION"]
        : evidenceStatus === "SUPPORTED_REGRESSION"
          ? ["P1_M6A3B2A_SUPPORTED_REGRESSION", "NO_AUTOMATIC_PROMOTION"]
          : ["P1_M6A3B2A_OOS_DIFFERENCE_INCONCLUSIVE", "NO_AUTOMATIC_PROMOTION"],
    });
  }

  return {
    schemaVersion: MLB_P1_M6A3B2A_INFERENCE_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration,
    horizons,
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2A_PAIRED_DATE_INFERENCE_RESEARCH_ONLY",
      "P1_M6A3B2B_STARTING_PITCHER_INCREMENTAL_TEST_REQUIRED",
      "NO_AUTOMATIC_PROMOTION",
    ],
  };
}
