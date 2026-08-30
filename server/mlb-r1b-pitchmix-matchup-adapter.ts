import {
  buildMlbFrozenMatchupLiveFeatures,
  MLB_FROZEN_MATCHUP_LIVE_FEATURE_BUILDER_VERSION,
  type MlbFrozenMatchupLivePregameInput,
} from "./mlb-frozen-matchup-live-feature-builder";

export const MLB_R1B_PITCHMIX_ADAPTER_VERSION =
  "mlb-r1b-pitchmix-matchup-adapter-v1" as const;

export type MlbR1bPitchmixMissingnessReason =
  | "NOT_APPLICABLE_BEFORE_FROZEN_V12_WARMUP"
  | "NOT_APPLICABLE_FROZEN_V12_WARMUP_SEASON"
  | "PITCHMIX_COVERAGE_OR_STARTER_EVIDENCE_INSUFFICIENT";

export interface MlbR1bPitchmixFeaturePayload {
  eligible: boolean;
  values: null | {
    contactAdv: number | null;
    whiffAdv: number | null;
    tbpaAdv: number | null;
    hrpaAdv: number | null;
    positiveCount: number;
  };
  sourceVersion: string;
  sourceTimestampOrPriorWindow: string;
  inputStage: "PREGAME";
  missingnessReason: MlbR1bPitchmixMissingnessReason | null;
  diagnostics: null | {
    pitchmixWindowStart: string;
    pitchmixPriorGames: number;
    homeStarterAllPitches: number;
    awayStarterAllPitches: number;
    homeStarterCategorizedShare: number;
    awayStarterCategorizedShare: number;
    metricCoverage: Record<"CONTACT" | "WHIFF" | "TBPA" | "HRPA", { home: number; away: number }>;
    eligibilityReasons: string[];
  };
}

function frozenV12Boundary(officialDate: string): "PRE_WARMUP" | "WARMUP" | "EVALUATION" {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(officialDate)) {
    throw new Error(`MLB_R1B_PITCHMIX_DATE_INVALID:${officialDate}`);
  }
  const season = Number(officialDate.slice(0, 4));
  if (!Number.isInteger(season)) throw new Error(`MLB_R1B_PITCHMIX_DATE_INVALID:${officialDate}`);
  if (season < 2023) return "PRE_WARMUP";
  if (season === 2023) return "WARMUP";
  return "EVALUATION";
}

function structuralMissing(
  reason:
    | "NOT_APPLICABLE_BEFORE_FROZEN_V12_WARMUP"
    | "NOT_APPLICABLE_FROZEN_V12_WARMUP_SEASON",
): MlbR1bPitchmixFeaturePayload {
  return Object.freeze({
    eligible: false,
    values: null,
    sourceVersion: `${MLB_R1B_PITCHMIX_ADAPTER_VERSION}:${MLB_FROZEN_MATCHUP_LIVE_FEATURE_BUILDER_VERSION}`,
    sourceTimestampOrPriorWindow: reason === "NOT_APPLICABLE_BEFORE_FROZEN_V12_WARMUP"
      ? "FROZEN_V12_PRE_WARMUP_NO_NUMERIC_FEATURE"
      : "FROZEN_V12_2023_WARMUP_SOURCE_ONLY_NO_TARGET_FEATURE",
    inputStage: "PREGAME",
    missingnessReason: reason,
    diagnostics: null,
  });
}

/**
 * R1B feature-only adapter for the frozen V12 pitch-mix matchup family.
 *
 * Scientific boundary:
 * - 2022 is outside the frozen V12 warmup/evaluation domain: explicit structural missingness.
 * - 2023 is the frozen warmup season: usable only as prior evidence for later target dates.
 * - 2024+ delegates the numerical feature computation to the already-frozen canonical
 *   V9/V12 live builder, which uses a 365-day lower-bound-inclusive / target-date-exclusive
 *   window and contains no outcome or market-price inputs.
 */
export function buildMlbR1bPitchmixMatchupFeature(
  input: MlbFrozenMatchupLivePregameInput,
): MlbR1bPitchmixFeaturePayload {
  const boundary = frozenV12Boundary(input.officialDate);
  if (boundary === "PRE_WARMUP") {
    return structuralMissing("NOT_APPLICABLE_BEFORE_FROZEN_V12_WARMUP");
  }
  if (boundary === "WARMUP") {
    return structuralMissing("NOT_APPLICABLE_FROZEN_V12_WARMUP_SEASON");
  }

  const assessment = buildMlbFrozenMatchupLiveFeatures(input);
  const p = assessment.pitchmix;
  return Object.freeze({
    eligible: p.eligible,
    values: Object.freeze({
      contactAdv: p.contactAdv,
      whiffAdv: p.whiffAdv,
      tbpaAdv: p.tbpaAdv,
      hrpaAdv: p.hrpaAdv,
      positiveCount: p.positiveCount,
    }),
    sourceVersion: `${MLB_R1B_PITCHMIX_ADAPTER_VERSION}:${assessment.builderVersion}`,
    sourceTimestampOrPriorWindow: `${assessment.diagnostics.pitchmixWindowStart}/${input.officialDate}[EXCLUSIVE_TARGET_DATE]`,
    inputStage: "PREGAME",
    missingnessReason: p.eligible ? null : "PITCHMIX_COVERAGE_OR_STARTER_EVIDENCE_INSUFFICIENT",
    diagnostics: Object.freeze({
      pitchmixWindowStart: assessment.diagnostics.pitchmixWindowStart,
      pitchmixPriorGames: assessment.diagnostics.pitchmixPriorGames,
      homeStarterAllPitches: assessment.diagnostics.homeStarterAllPitches,
      awayStarterAllPitches: assessment.diagnostics.awayStarterAllPitches,
      homeStarterCategorizedShare: assessment.diagnostics.homeStarterCategorizedShare,
      awayStarterCategorizedShare: assessment.diagnostics.awayStarterCategorizedShare,
      metricCoverage: assessment.diagnostics.metricCoverage,
      eligibilityReasons: [...assessment.diagnostics.eligibilityReasons],
    }),
  });
}
