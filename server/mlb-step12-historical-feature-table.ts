import { createHash } from "node:crypto";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";

export const MLB_STEP12_HISTORICAL_FEATURE_TABLE_SCHEMA = "courtedge-p0-step12-historical-feature-table.v1" as const;

export type MlbStep12Partition = "DISCOVERY" | "HOLDOUT";

export interface MlbStep12PregameFeatureVector {
  leagueHomeMeanRuns: number | null;
  leagueAwayMeanRuns: number | null;
  teamHomeMeanRuns: number | null;
  teamAwayMeanRuns: number | null;
  homeOffenseFactor: number | null;
  awayOffenseFactor: number | null;
  homeDefenseWeaknessFactor: number | null;
  awayDefenseWeaknessFactor: number | null;
  homeStarterRiskFactor: number | null;
  awayStarterRiskFactor: number | null;
  pitcherEffectWeight: number | null;
  homeLineupFactor: number | null;
  awayLineupFactor: number | null;
  lineupEffectWeight: number | null;
}

export interface MlbStep12FeatureProvenance {
  featureFamily: "LEAGUE_BASELINE" | "TEAM_STRENGTH" | "STARTING_PITCHER" | "LINEUP";
  sourceSchema: string;
  asOf: string;
  sourceDigest: string;
}

export interface MlbStep12HistoricalFeatureRow {
  predictionKey: string;
  gamePk: number;
  officialDate: string;
  scheduledStartAt: string;
  horizon: MlbProbabilityHorizon;
  homeTeamId: number;
  awayTeamId: number;
  partition: MlbStep12Partition;
  features: MlbStep12PregameFeatureVector;
  featureProvenance: readonly MlbStep12FeatureProvenance[];
  outcome: {
    homeRuns: number;
    awayRuns: number;
    totalRuns: number;
    homeResult: "WIN" | "LOSS" | "PUSH";
  };
}

export interface MlbStep12HistoricalFeatureTable {
  schemaVersion: typeof MLB_STEP12_HISTORICAL_FEATURE_TABLE_SCHEMA;
  generatedAt: string;
  split: {
    discoveryEndDate: string;
    holdoutStartDate: string;
    discoveryRows: number;
    holdoutRows: number;
  };
  rows: readonly MlbStep12HistoricalFeatureRow[];
  digest: string;
  policy: {
    chronologicalPartitionRequired: true;
    randomShuffleAllowed: false;
    pregameAsOfRequired: true;
    outcomeFieldsAllowedAsFeatures: false;
    missingPregameFeatureMeansUnknownNotZero: true;
    thresholdsLearnedFromHoldoutAllowed: false;
    highHitRatePocketSearchAllowedInDiscovery: true;
    holdoutUsedForFalsificationOnly: true;
    historicalPricesRequiredForSportingHitRateStudy: false;
    historicalPricesRequiredForHistoricalEvClaim: true;
    livePickFiltersChanged: false;
    betEliteLabelProduced: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function isIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function finiteOrNull(value: number | null): boolean {
  return value == null || Number.isFinite(value);
}

function digestRows(rows: readonly MlbStep12HistoricalFeatureRow[]): string {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function validateFeatures(features: MlbStep12PregameFeatureVector): void {
  for (const value of Object.values(features)) {
    if (!finiteOrNull(value)) throw new Error("MLB_STEP12_FEATURE_TABLE_NONFINITE_FEATURE");
  }
}

function validateProvenance(row: MlbStep12HistoricalFeatureRow): void {
  if (!row.featureProvenance.length) throw new Error("MLB_STEP12_FEATURE_TABLE_PROVENANCE_REQUIRED");
  const scheduledStartMs = Date.parse(row.scheduledStartAt);
  const seen = new Set<string>();
  for (const provenance of row.featureProvenance) {
    if (!provenance.sourceSchema.trim() || !/^[a-f0-9]{64}$/i.test(provenance.sourceDigest)) {
      throw new Error("MLB_STEP12_FEATURE_TABLE_PROVENANCE_INVALID");
    }
    if (!isIsoInstant(provenance.asOf) || Date.parse(provenance.asOf) >= scheduledStartMs) {
      throw new Error("MLB_STEP12_FEATURE_TABLE_TIME_LEAKAGE_DETECTED");
    }
    if (seen.has(provenance.featureFamily)) throw new Error("MLB_STEP12_FEATURE_TABLE_DUPLICATE_FEATURE_FAMILY");
    seen.add(provenance.featureFamily);
  }
}

function validateRow(row: MlbStep12HistoricalFeatureRow): void {
  if (!row.predictionKey.trim() || !Number.isInteger(row.gamePk) || row.gamePk <= 0
    || !isIsoDate(row.officialDate) || !isIsoInstant(row.scheduledStartAt)
    || !Number.isInteger(row.homeTeamId) || row.homeTeamId <= 0
    || !Number.isInteger(row.awayTeamId) || row.awayTeamId <= 0
    || row.homeTeamId === row.awayTeamId) {
    throw new Error("MLB_STEP12_FEATURE_TABLE_IDENTITY_INVALID");
  }
  if (row.scheduledStartAt.slice(0, 10) !== row.officialDate) {
    throw new Error("MLB_STEP12_FEATURE_TABLE_DATE_START_MISMATCH");
  }
  validateFeatures(row.features);
  validateProvenance(row);
  const { homeRuns, awayRuns, totalRuns, homeResult } = row.outcome;
  if (![homeRuns, awayRuns, totalRuns].every((value) => Number.isInteger(value) && value >= 0)
    || totalRuns !== homeRuns + awayRuns) {
    throw new Error("MLB_STEP12_FEATURE_TABLE_OUTCOME_INVALID");
  }
  const expectedResult = homeRuns > awayRuns ? "WIN" : homeRuns < awayRuns ? "LOSS" : "PUSH";
  if (homeResult !== expectedResult) throw new Error("MLB_STEP12_FEATURE_TABLE_OUTCOME_RESULT_MISMATCH");
}

export function buildMlbStep12HistoricalFeatureTable(input: {
  generatedAt: string;
  discoveryEndDate: string;
  holdoutStartDate: string;
  rows: readonly Omit<MlbStep12HistoricalFeatureRow, "partition">[];
}): MlbStep12HistoricalFeatureTable {
  if (!isIsoInstant(input.generatedAt) || !isIsoDate(input.discoveryEndDate) || !isIsoDate(input.holdoutStartDate)
    || !(input.discoveryEndDate < input.holdoutStartDate)) {
    throw new Error("MLB_STEP12_FEATURE_TABLE_SPLIT_INVALID");
  }

  const seen = new Set<string>();
  const rows = input.rows.map((raw): MlbStep12HistoricalFeatureRow => {
    if (raw.officialDate > input.discoveryEndDate && raw.officialDate < input.holdoutStartDate) {
      throw new Error(`MLB_STEP12_FEATURE_TABLE_SPLIT_GAP_ROW:${raw.predictionKey}`);
    }
    const partition: MlbStep12Partition = raw.officialDate <= input.discoveryEndDate ? "DISCOVERY" : "HOLDOUT";
    const row: MlbStep12HistoricalFeatureRow = { ...raw, partition };
    validateRow(row);
    if (seen.has(row.predictionKey)) throw new Error(`MLB_STEP12_FEATURE_TABLE_DUPLICATE:${row.predictionKey}`);
    seen.add(row.predictionKey);
    return row;
  }).sort((a, b) => a.officialDate.localeCompare(b.officialDate)
    || a.gamePk - b.gamePk
    || a.horizon.localeCompare(b.horizon));

  const discoveryRows = rows.filter((row) => row.partition === "DISCOVERY").length;
  const holdoutRows = rows.filter((row) => row.partition === "HOLDOUT").length;
  if (!discoveryRows || !holdoutRows) throw new Error("MLB_STEP12_FEATURE_TABLE_BOTH_PARTITIONS_REQUIRED");

  return {
    schemaVersion: MLB_STEP12_HISTORICAL_FEATURE_TABLE_SCHEMA,
    generatedAt: input.generatedAt,
    split: {
      discoveryEndDate: input.discoveryEndDate,
      holdoutStartDate: input.holdoutStartDate,
      discoveryRows,
      holdoutRows,
    },
    rows,
    digest: digestRows(rows),
    policy: {
      chronologicalPartitionRequired: true,
      randomShuffleAllowed: false,
      pregameAsOfRequired: true,
      outcomeFieldsAllowedAsFeatures: false,
      missingPregameFeatureMeansUnknownNotZero: true,
      thresholdsLearnedFromHoldoutAllowed: false,
      highHitRatePocketSearchAllowedInDiscovery: true,
      holdoutUsedForFalsificationOnly: true,
      historicalPricesRequiredForSportingHitRateStudy: false,
      historicalPricesRequiredForHistoricalEvClaim: true,
      livePickFiltersChanged: false,
      betEliteLabelProduced: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}
