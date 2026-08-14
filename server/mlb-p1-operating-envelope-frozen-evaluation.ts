import crypto from "node:crypto";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3e2OperatingEnvelopeStability,
  type MlbP1M3e2Report,
} from "./mlb-p1-operating-envelope-stability";
import {
  buildMlbP1M3e3OperatingEnvelopeFreeze,
  type MlbP1M3e3Report,
} from "./mlb-p1-operating-envelope-freeze";

export const MLB_P1_M3E4_SCHEMA = "courtedge-p1-m3e4-frozen-manifest-evaluation.v1" as const;

export type MlbP1M3e4State =
  | "WAITING_FOR_FREEZE"
  | "FROZEN_WAITING_FOR_SETTLEMENTS"
  | "FROZEN_NOT_EVALUABLE"
  | "NO_DISCOVERY_RULE"
  | "VALIDATION_FAILED"
  | "CONFIRMATION_FAILED"
  | "STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY";

export interface MlbP1M3e4Report {
  schemaVersion: typeof MLB_P1_M3E4_SCHEMA;
  generatedAt: string;
  state: MlbP1M3e4State;
  manifest: {
    verified: boolean;
    manifestDigest: string | null;
    cutoffDate: string | null;
    frozenRows: number;
    frozenDates: number;
  };
  cohort: {
    inputRows: number;
    frozenRows: number;
    resolvedFrozenRows: number;
    unresolvedFrozenRows: number;
    scoreableFrozenRows: number;
    scoreableFrozenDates: number;
    futureRowsExcluded: number;
  };
  evaluation: MlbP1M3e2Report | null;
  settlementSnapshotDigest: string | null;
  protocol: {
    freezeBoundaryChosenWithoutOutcomes: true;
    futureRowsExcludedFromEvaluation: true;
    allFrozenRowsResolvedBeforeEvaluation: true;
    exactManifestPartitionsRequired: true;
    discoveryRuleFrozenBeforeValidation: true;
    confirmationOpenedOnlyAfterValidationPasses: true;
  };
  interpretation: {
    stableModelQualityEnvelopeSupported: boolean;
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

export interface MlbP1M3e4Options {
  generatedAt?: string;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function freezeEligible(row: MlbP1M3dReviewRow): boolean {
  return typeof row.predictionId === "string" && row.predictionId.length > 0
    && typeof row.lifecycleKey === "string" && row.lifecycleKey.length > 0
    && validDate(row.gameDate)
    && validIso(row.recordedAt)
    && Number.isFinite(row.modelProbability)
    && row.modelProbability > 0
    && row.modelProbability < 1;
}

function scoreable(row: MlbP1M3dReviewRow): boolean {
  return (row.result === "WIN" || row.result === "LOSS")
    && row.brierScore != null && Number.isFinite(row.brierScore) && row.brierScore >= 0
    && row.logLoss != null && Number.isFinite(row.logLoss) && row.logLoss >= 0;
}

function safeInterpretation(supported: boolean): MlbP1M3e4Report["interpretation"] {
  return {
    stableModelQualityEnvelopeSupported: supported,
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

function protocol(): MlbP1M3e4Report["protocol"] {
  return {
    freezeBoundaryChosenWithoutOutcomes: true,
    futureRowsExcludedFromEvaluation: true,
    allFrozenRowsResolvedBeforeEvaluation: true,
    exactManifestPartitionsRequired: true,
    discoveryRuleFrozenBeforeValidation: true,
    confirmationOpenedOnlyAfterValidationPasses: true,
  };
}

function snapshotDigest(rows: MlbP1M3dReviewRow[]): string {
  const material = rows
    .map((row) => [
      row.gameDate,
      row.predictionId,
      row.result ?? "PENDING",
      row.settledAt ?? "",
      row.brierScore == null ? "" : String(row.brierScore),
      row.logLoss == null ? "" : String(row.logLoss),
      row.flatProfitUnits,
      row.closingOddsAmerican ?? "",
      row.clvPp ?? "",
    ].join("|"))
    .join("\n");
  return crypto.createHash("sha256").update(material).digest("hex");
}

function baseReport(
  inputRows: MlbP1M3dReviewRow[],
  freezeReport: MlbP1M3e3Report,
  generatedAt: string,
): Pick<MlbP1M3e4Report, "schemaVersion" | "generatedAt" | "manifest" | "protocol"> {
  return {
    schemaVersion: MLB_P1_M3E4_SCHEMA,
    generatedAt,
    manifest: {
      verified: false,
      manifestDigest: freezeReport.freeze?.manifestDigest ?? null,
      cutoffDate: freezeReport.freeze?.cutoffDate ?? null,
      frozenRows: freezeReport.freeze?.frozenRows ?? 0,
      frozenDates: freezeReport.freeze?.frozenDates ?? 0,
    },
    protocol: protocol(),
  };
}

export function buildMlbP1M3e4FrozenManifestEvaluation(
  inputRows: MlbP1M3dReviewRow[],
  freezeReport: MlbP1M3e3Report,
  options: MlbP1M3e4Options = {},
): MlbP1M3e4Report {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const base = baseReport(inputRows, freezeReport, generatedAt);

  if (freezeReport.state !== "FROZEN_RESEARCH_WINDOW" || !freezeReport.freeze) {
    return {
      ...base,
      state: "WAITING_FOR_FREEZE",
      cohort: {
        inputRows: inputRows.length,
        frozenRows: 0,
        resolvedFrozenRows: 0,
        unresolvedFrozenRows: 0,
        scoreableFrozenRows: 0,
        scoreableFrozenDates: 0,
        futureRowsExcluded: 0,
      },
      evaluation: null,
      settlementSnapshotDigest: null,
      interpretation: safeInterpretation(false),
      blockers: ["P1_M3E4_FROZEN_MANIFEST_REQUIRED"],
    };
  }

  const recomputed = buildMlbP1M3e3OperatingEnvelopeFreeze(inputRows, {
    minimumPregameDecisions: freezeReport.configuration.minimumPregameDecisions,
    minimumDistinctDates: freezeReport.configuration.minimumDistinctDates,
    generatedAt: freezeReport.generatedAt,
  });
  if (recomputed.state !== "FROZEN_RESEARCH_WINDOW" || !recomputed.freeze
    || recomputed.freeze.manifestDigest !== freezeReport.freeze.manifestDigest) {
    throw new Error("P1_M3E4_FROZEN_MANIFEST_MISMATCH");
  }

  const frozenRows = inputRows
    .filter((row) => freezeEligible(row) && row.gameDate <= freezeReport.freeze!.cutoffDate)
    .sort((left, right) => left.gameDate.localeCompare(right.gameDate)
      || left.recordedAt.localeCompare(right.recordedAt)
      || left.predictionId.localeCompare(right.predictionId));
  if (frozenRows.length !== freezeReport.freeze.frozenRows) {
    throw new Error("P1_M3E4_FROZEN_ROW_COUNT_MISMATCH");
  }

  const resolved = frozenRows.filter((row) => row.result != null);
  const scoreableRows = frozenRows.filter(scoreable);
  const scoreableDates = new Set(scoreableRows.map((row) => row.gameDate));
  const cohort = {
    inputRows: inputRows.length,
    frozenRows: frozenRows.length,
    resolvedFrozenRows: resolved.length,
    unresolvedFrozenRows: frozenRows.length - resolved.length,
    scoreableFrozenRows: scoreableRows.length,
    scoreableFrozenDates: scoreableDates.size,
    futureRowsExcluded: recomputed.freeze.futureRowsExcluded,
  };
  const verifiedBase = {
    ...base,
    manifest: { ...base.manifest, verified: true },
  };

  if (resolved.length !== frozenRows.length) {
    return {
      ...verifiedBase,
      state: "FROZEN_WAITING_FOR_SETTLEMENTS",
      cohort,
      evaluation: null,
      settlementSnapshotDigest: null,
      interpretation: safeInterpretation(false),
      blockers: ["P1_M3E4_WAITING_FOR_ALL_FROZEN_SETTLEMENTS"],
    };
  }

  const settlementSnapshotDigest = snapshotDigest(frozenRows);
  if (scoreableDates.size !== freezeReport.freeze.frozenDates) {
    return {
      ...verifiedBase,
      state: "FROZEN_NOT_EVALUABLE",
      cohort,
      evaluation: null,
      settlementSnapshotDigest,
      interpretation: safeInterpretation(false),
      blockers: ["P1_M3E4_SCOREABLE_DATE_COVERAGE_INCOMPLETE"],
    };
  }

  const evaluation = buildMlbP1M3e2OperatingEnvelopeStability(frozenRows, { generatedAt });
  if (evaluation.state === "INSUFFICIENT_SAMPLE") {
    return {
      ...verifiedBase,
      state: "FROZEN_NOT_EVALUABLE",
      cohort,
      evaluation,
      settlementSnapshotDigest,
      interpretation: safeInterpretation(false),
      blockers: ["P1_M3E4_FROZEN_SCOREABLE_SAMPLE_INSUFFICIENT", ...evaluation.blockers],
    };
  }

  const split = evaluation.temporalSplit;
  const manifest = freezeReport.freeze;
  const partitionsMatch = split.discovery.minDate === manifest.discovery.minDate
    && split.discovery.maxDate === manifest.discovery.maxDate
    && split.discovery.dates === manifest.discovery.dates
    && split.validation.minDate === manifest.validation.minDate
    && split.validation.maxDate === manifest.validation.maxDate
    && split.validation.dates === manifest.validation.dates
    && split.confirmation.minDate === manifest.confirmation.minDate
    && split.confirmation.maxDate === manifest.confirmation.maxDate
    && split.confirmation.dates === manifest.confirmation.dates;
  if (!partitionsMatch) throw new Error("P1_M3E4_FROZEN_PARTITION_MISMATCH");

  const state: MlbP1M3e4State = evaluation.state;
  const supported = state === "STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY";
  return {
    ...verifiedBase,
    state,
    cohort,
    evaluation,
    settlementSnapshotDigest,
    interpretation: safeInterpretation(supported),
    blockers: evaluation.blockers,
  };
}
