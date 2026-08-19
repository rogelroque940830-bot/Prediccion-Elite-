// Frozen scientific authorities are bundled by esbuild/tsx; no runtime file lookup or refit is allowed.
// @ts-ignore -- repo-wide resolveJsonModule is intentionally disabled.
import fullModularAuthorityJson from "../research/mlb-unified-elite-live-authority-v1.json";
// @ts-ignore -- repo-wide resolveJsonModule is intentionally disabled.
import ppHorizonSnapshotJson from "../research/mlb-full-modular-pp-horizon-model-snapshot-v1.json";

export const MLB_UNIFIED_ELITE_FROZEN_AUTHORITY_VERSION =
  "mlb-unified-elite-frozen-authority-v1" as const;

export type FrozenAuthorityJson = Readonly<Record<string, any>>;

const FULL = fullModularAuthorityJson as FrozenAuthorityJson;
const PP = ppHorizonSnapshotJson as FrozenAuthorityJson;

let validated = false;

export function validateMlbUnifiedEliteFrozenAuthorities(): void {
  if (validated) return;
  if (FULL.schemaVersion !== "courtedge-mlb-unified-elite-live-authority.v1") {
    throw new Error("FULL_MODULAR_AUTHORITY_SCHEMA_INVALID");
  }
  if (FULL.frozenFrom?.fullModularHead !== "e352e25c131a53536745323bcd3268dcec75a66d") {
    throw new Error("FULL_MODULAR_AUTHORITY_HEAD_DRIFT");
  }
  if (FULL.runtimePolicy?.maximumDailySelections !== 1) {
    throw new Error("FULL_MODULAR_DAILY_SELECTION_LIMIT_DRIFT");
  }
  if (FULL.runtimePolicy?.runtimeRefitAllowed !== false
      || FULL.runtimePolicy?.runtimeThresholdFitAllowed !== false
      || FULL.runtimePolicy?.sameDateStateUpdateAllowed !== false
      || FULL.runtimePolicy?.outcomeInputAllowed !== false
      || FULL.runtimePolicy?.sportsbookPriceInputAllowed !== false) {
    throw new Error("FULL_MODULAR_RUNTIME_POLICY_DRIFT");
  }
  if (Number(FULL.minimumSelectedSideModelProbability) !== 0.6) {
    throw new Error("FULL_MODULAR_MINIMUM_PROBABILITY_DRIFT");
  }
  for (const horizon of ["F3", "F5", "FG"] as const) {
    const model = FULL.directionalModels?.[horizon];
    if (!model || !Array.isArray(model.features) || !Array.isArray(model.median)
        || !Array.isArray(model.mean) || !Array.isArray(model.scale)
        || !Array.isArray(model.weights)) {
      throw new Error(`FULL_MODULAR_DIRECTIONAL_AUTHORITY_MISSING:${horizon}`);
    }
    const p = model.features.length;
    const classCount = Number(model.classCount);
    if (p === 0 || model.median.length !== p || model.mean.length !== p || model.scale.length !== p) {
      throw new Error(`FULL_MODULAR_DIRECTIONAL_PREPROCESSING_DRIFT:${horizon}`);
    }
    if (model.weights.length !== classCount - 1
        || model.weights.some((row: unknown) => !Array.isArray(row) || row.length !== p + 1)) {
      throw new Error(`FULL_MODULAR_DIRECTIONAL_WEIGHT_DRIFT:${horizon}`);
    }
  }
  if (PP.schemaVersion !== "courtedge-mlb-full-modular-pp-horizon-model-snapshot.v1") {
    throw new Error("PP_HORIZON_SNAPSHOT_SCHEMA_INVALID");
  }
  if (PP.model?.parameterPayloadDigest !== "sha256:02f64630d94f5951fa684294e879937d1ad531acc6ecdedf56fc3b225526b275") {
    throw new Error("PP_HORIZON_PARAMETER_DIGEST_DRIFT");
  }
  if (PP.postSnapshotAuthority?.modelRefitAllowed !== false
      || PP.postSnapshotAuthority?.preprocessingRefitAllowed !== false
      || PP.postSnapshotAuthority?.futureRuntimeMustScoreFromPersistedSnapshotNotFreshOptimizerFit !== true) {
    throw new Error("PP_HORIZON_RUNTIME_POLICY_DRIFT");
  }
  if (!Array.isArray(PP.model?.featureNames) || PP.model.featureNames.length !== 49
      || !Array.isArray(PP.model?.rawCoefficients) || PP.model.rawCoefficients.length !== 49) {
    throw new Error("PP_HORIZON_FEATURE_COUNT_DRIFT");
  }
  validated = true;
}

export function getMlbFullModularFrozenAuthority(): FrozenAuthorityJson {
  validateMlbUnifiedEliteFrozenAuthorities();
  return FULL;
}

export function getMlbPpHorizonFrozenSnapshot(): FrozenAuthorityJson {
  validateMlbUnifiedEliteFrozenAuthorities();
  return PP;
}
