import crypto from "node:crypto";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";

export const MLB_P1_M3E3_SCHEMA = "courtedge-p1-m3e3-operating-envelope-freeze.v1" as const;

export type MlbP1M3e3State = "WAITING_FOR_FREEZE" | "FROZEN_RESEARCH_WINDOW";

export interface MlbP1M3e3Partition {
  minDate: string;
  maxDate: string;
  dates: number;
  rows: number;
  dateDigest: string;
}

export interface MlbP1M3e3FreezeManifest {
  cutoffDate: string;
  frozenRows: number;
  frozenDates: number;
  futureRowsExcluded: number;
  decisionIdentityDigest: string;
  discovery: MlbP1M3e3Partition;
  validation: MlbP1M3e3Partition;
  confirmation: MlbP1M3e3Partition;
  manifestDigest: string;
}

export interface MlbP1M3e3Report {
  schemaVersion: typeof MLB_P1_M3E3_SCHEMA;
  generatedAt: string;
  state: MlbP1M3e3State;
  hypothesisProtection: {
    purpose: "Freeze the first pregame decision window that reaches preregistered size before any outcome-based operating-envelope evaluation.";
    upstreamInteractiveTerminalRowsRequired: true;
    upstreamM3aPregameValidationRequired: true;
    outcomesUsedToChooseFreezeBoundary: false;
    settlementUsedToChooseFreezeBoundary: false;
    properScoresUsedToChooseFreezeBoundary: false;
    roiUsedToChooseFreezeBoundary: false;
    clvUsedToChooseFreezeBoundary: false;
    futureRowsMayMoveBoundary: false;
  };
  configuration: {
    minimumPregameDecisions: number;
    minimumDistinctDates: number;
    discoveryDateFraction: 0.5;
    validationDateFraction: 0.25;
    confirmationDateFraction: 0.25;
  };
  cohort: {
    inputRows: number;
    eligiblePregameRows: number;
    excludedRows: number;
    eligibleDistinctDates: number;
  };
  freeze: MlbP1M3e3FreezeManifest | null;
  interpretation: {
    researchWindowFrozen: boolean;
    economicProfitabilityCertified: false;
    operationalRecommendationGateAllowed: false;
    bettingRecommendationAllowed: false;
    stakeChangesAllowed: false;
    automaticBettingAllowed: false;
    modelProbabilityChanged: false;
    existingEconomicThresholdsChanged: false;
    premiumNoUltraProspectiveHypothesisChanged: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
  blockers: string[];
}

export interface MlbP1M3e3Options {
  minimumPregameDecisions?: number;
  minimumDistinctDates?: number;
  generatedAt?: string;
}

const DEFAULTS = {
  minimumPregameDecisions: 120,
  minimumDistinctDates: 36,
} as const;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function freezeEligible(row: MlbP1M3dReviewRow): boolean {
  return typeof row.predictionId === "string"
    && row.predictionId.length > 0
    && typeof row.lifecycleKey === "string"
    && row.lifecycleKey.length > 0
    && validDate(row.gameDate)
    && validIso(row.recordedAt)
    && Number.isFinite(row.modelProbability)
    && row.modelProbability > 0
    && row.modelProbability < 1;
}

function eligibleRows(rows: MlbP1M3dReviewRow[]): MlbP1M3dReviewRow[] {
  const seen = new Set<string>();
  const eligible: MlbP1M3dReviewRow[] = [];
  for (const row of rows) {
    if (!freezeEligible(row)) continue;
    if (seen.has(row.predictionId)) throw new Error(`P1_M3E3_DUPLICATE_PREDICTION_ID:${row.predictionId}`);
    seen.add(row.predictionId);
    eligible.push(row);
  }
  return eligible.sort((left, right) => left.gameDate.localeCompare(right.gameDate)
    || left.recordedAt.localeCompare(right.recordedAt)
    || left.predictionId.localeCompare(right.predictionId));
}

function partition(rows: MlbP1M3dReviewRow[], dates: string[]): MlbP1M3e3Partition {
  if (!dates.length) throw new Error("P1_M3E3_EMPTY_PARTITION");
  const dateSet = new Set(dates);
  return {
    minDate: dates[0],
    maxDate: dates.at(-1) as string,
    dates: dates.length,
    rows: rows.filter((row) => dateSet.has(row.gameDate)).length,
    dateDigest: digest(dates.join("\n")),
  };
}

function safeInterpretation(frozen: boolean): MlbP1M3e3Report["interpretation"] {
  return {
    researchWindowFrozen: frozen,
    economicProfitabilityCertified: false,
    operationalRecommendationGateAllowed: false,
    bettingRecommendationAllowed: false,
    stakeChangesAllowed: false,
    automaticBettingAllowed: false,
    modelProbabilityChanged: false,
    existingEconomicThresholdsChanged: false,
    premiumNoUltraProspectiveHypothesisChanged: false,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
  };
}

export function buildMlbP1M3e3OperatingEnvelopeFreeze(
  inputRows: MlbP1M3dReviewRow[],
  options: MlbP1M3e3Options = {},
): MlbP1M3e3Report {
  const minimumPregameDecisions = options.minimumPregameDecisions ?? DEFAULTS.minimumPregameDecisions;
  const minimumDistinctDates = options.minimumDistinctDates ?? DEFAULTS.minimumDistinctDates;
  if (!Number.isInteger(minimumPregameDecisions) || minimumPregameDecisions <= 0
    || !Number.isInteger(minimumDistinctDates) || minimumDistinctDates < 4) {
    throw new Error("P1_M3E3_INVALID_CONFIGURATION");
  }

  const eligible = eligibleRows(inputRows);
  const dates = [...new Set(eligible.map((row) => row.gameDate))].sort();
  const configuration: MlbP1M3e3Report["configuration"] = {
    minimumPregameDecisions,
    minimumDistinctDates,
    discoveryDateFraction: 0.5,
    validationDateFraction: 0.25,
    confirmationDateFraction: 0.25,
  };
  const base = {
    schemaVersion: MLB_P1_M3E3_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    hypothesisProtection: {
      purpose: "Freeze the first pregame decision window that reaches preregistered size before any outcome-based operating-envelope evaluation." as const,
      upstreamInteractiveTerminalRowsRequired: true as const,
      upstreamM3aPregameValidationRequired: true as const,
      outcomesUsedToChooseFreezeBoundary: false as const,
      settlementUsedToChooseFreezeBoundary: false as const,
      properScoresUsedToChooseFreezeBoundary: false as const,
      roiUsedToChooseFreezeBoundary: false as const,
      clvUsedToChooseFreezeBoundary: false as const,
      futureRowsMayMoveBoundary: false as const,
    },
    configuration,
    cohort: {
      inputRows: inputRows.length,
      eligiblePregameRows: eligible.length,
      excludedRows: inputRows.length - eligible.length,
      eligibleDistinctDates: dates.length,
    },
  };

  let cutoffIndex = -1;
  let cumulativeRows = 0;
  for (let index = 0; index < dates.length; index += 1) {
    cumulativeRows += eligible.filter((row) => row.gameDate === dates[index]).length;
    if (index + 1 >= minimumDistinctDates && cumulativeRows >= minimumPregameDecisions) {
      cutoffIndex = index;
      break;
    }
  }

  if (cutoffIndex < 0) {
    return {
      ...base,
      state: "WAITING_FOR_FREEZE",
      freeze: null,
      interpretation: safeInterpretation(false),
      blockers: [
        eligible.length < minimumPregameDecisions ? "P1_M3E3_MINIMUM_PREGAME_DECISIONS_NOT_REACHED" : null,
        dates.length < minimumDistinctDates ? "P1_M3E3_MINIMUM_DISTINCT_DATES_NOT_REACHED" : null,
      ].filter((value): value is string => value != null),
    };
  }

  const frozenDates = dates.slice(0, cutoffIndex + 1);
  const cutoffDate = frozenDates.at(-1) as string;
  const frozenRows = eligible.filter((row) => row.gameDate <= cutoffDate);
  const futureRowsExcluded = eligible.length - frozenRows.length;
  const discoveryCount = Math.floor(frozenDates.length * 0.5);
  const validationCount = Math.floor(frozenDates.length * 0.25);
  const discoveryDates = frozenDates.slice(0, discoveryCount);
  const validationDates = frozenDates.slice(discoveryCount, discoveryCount + validationCount);
  const confirmationDates = frozenDates.slice(discoveryCount + validationCount);
  if (!discoveryDates.length || !validationDates.length || !confirmationDates.length) {
    throw new Error("P1_M3E3_INVALID_TEMPORAL_PARTITION");
  }
  const discovery = partition(frozenRows, discoveryDates);
  const validation = partition(frozenRows, validationDates);
  const confirmation = partition(frozenRows, confirmationDates);
  if (!(discovery.maxDate < validation.minDate && validation.maxDate < confirmation.minDate)) {
    throw new Error("P1_M3E3_TIME_LEAKAGE_DETECTED");
  }

  const identityMaterial = frozenRows
    .map((row) => `${row.gameDate}|${row.recordedAt}|${row.predictionId}|${row.lifecycleKey}`)
    .join("\n");
  const decisionIdentityDigest = digest(identityMaterial);
  const manifestMaterial = JSON.stringify({
    schemaVersion: MLB_P1_M3E3_SCHEMA,
    minimumPregameDecisions,
    minimumDistinctDates,
    cutoffDate,
    frozenDates,
    decisionIdentityDigest,
    discoveryDateDigest: discovery.dateDigest,
    validationDateDigest: validation.dateDigest,
    confirmationDateDigest: confirmation.dateDigest,
  });
  const freeze: MlbP1M3e3FreezeManifest = {
    cutoffDate,
    frozenRows: frozenRows.length,
    frozenDates: frozenDates.length,
    futureRowsExcluded,
    decisionIdentityDigest,
    discovery,
    validation,
    confirmation,
    manifestDigest: digest(manifestMaterial),
  };

  return {
    ...base,
    state: "FROZEN_RESEARCH_WINDOW",
    freeze,
    interpretation: safeInterpretation(true),
    blockers: [
      "P1_M3E3_RESEARCH_WINDOW_ONLY",
      "P1_M3E3_OUTCOME_EVALUATION_NOT_PERFORMED",
      "P1_M3E3_OPERATIONAL_RECOMMENDATION_NOT_ALLOWED",
    ],
  };
}