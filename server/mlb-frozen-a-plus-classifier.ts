export const MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION =
  "mlb-frozen-a-plus-classifier.v1" as const;

export const MLB_FROZEN_CLASSIFIER_FEATURE_NAMES = [
  "team_rd10_diff",
  "team_win10_diff",
  "starter_kbb_adv",
  "team_ra10_adv",
  "lineup_exposure_rate_adv",
  "starter_runrisk_adv",
  "team_rs10_diff",
  "starter_hr_adv",
  "min_probable_prior_bf",
  "lineup_continuity_rate_adv",
  "combined_starter_kbb",
  "combined_team_rs10",
  "combined_team_ra10",
] as const;

export type MlbFrozenClassifierFeatureName =
  (typeof MLB_FROZEN_CLASSIFIER_FEATURE_NAMES)[number];

export type MlbFrozenClassifierFeatureSnapshot = Record<
  MlbFrozenClassifierFeatureName,
  number | null
>;

export const MLB_FROZEN_CLASSIFIER_MODEL_IDS = [
  "A_PLUS_C4_2022_FROZEN",
  "A_PLUS_FULL13_2022_FROZEN",
  "F5_C4_2022_FROZEN",
  "F5_FULL13_2022_FROZEN",
] as const;

export type MlbFrozenClassifierModelId =
  (typeof MLB_FROZEN_CLASSIFIER_MODEL_IDS)[number];

interface FrozenFeatureSpec {
  name: MlbFrozenClassifierFeatureName;
  coef: number;
  mean: number;
  medianImpute: number;
  scale: number;
}

interface FrozenModelSpec {
  intercept: number;
  threshold: number;
  features: readonly FrozenFeatureSpec[];
}

export const MLB_FROZEN_PREMIUM_A_THRESHOLDS = Object.freeze({
  team_win10_diff: 0.09999999999999998,
  starter_kbb_adv: 0.02481042579422841,
  lineup_exposure_rate_adv: 0.09876543209876554,
});

export const MLB_FROZEN_CLASSIFIER_MODELS: Readonly<
  Record<MlbFrozenClassifierModelId, FrozenModelSpec>
> = Object.freeze({
  A_PLUS_C4_2022_FROZEN: Object.freeze({
    intercept: 0.13346732838304923,
    threshold: 0.69,
    features: Object.freeze([
      { name: "lineup_exposure_rate_adv", coef: 0.18718356825590396, mean: 0.0014746687094488085, medianImpute: 0.0, scale: 0.13755882386676263 },
      { name: "starter_kbb_adv", coef: 0.22693050925842057, mean: 0.00027511303638506223, medianImpute: 0.0, scale: 0.06102601114606269 },
      { name: "combined_team_rs10", coef: 0.10094756294462916, mean: 8.598868294362662, medianImpute: 8.5, scale: 1.4990281969726007 },
      { name: "team_rd10_diff", coef: 0.14240502027486293, mean: -0.05057330260709487, medianImpute: 0.0, scale: 2.495698473834091 },
    ]),
  }),
  A_PLUS_FULL13_2022_FROZEN: Object.freeze({
    intercept: 0.1346743267263629,
    threshold: 0.64,
    features: Object.freeze([
      { name: "team_rd10_diff", coef: 0.0469514416835648, mean: -0.05057330260709487, medianImpute: 0.0, scale: 2.495698473834091 },
      { name: "team_win10_diff", coef: 0.0199400427127508, mean: -0.006691399964241014, medianImpute: 0.0, scale: 0.27436112618719666 },
      { name: "starter_kbb_adv", coef: 0.16540832130511177, mean: 0.00027511303638506223, medianImpute: 0.0, scale: 0.06102601114606269 },
      { name: "team_ra10_adv", coef: 0.08194226081992839, mean: -0.03913406970353152, medianImpute: 0.0, scale: 1.5960174523670227 },
      { name: "lineup_exposure_rate_adv", coef: 0.22223301323120748, mean: 0.0014746687094488085, medianImpute: 0.0, scale: 0.13755882386676263 },
      { name: "starter_runrisk_adv", coef: 0.14500677939327994, mean: 0.0000929388447975137, medianImpute: 0.0, scale: 0.029292588166369173 },
      { name: "team_rs10_diff", coef: -0.008978746354314622, mean: -0.011439232903563317, medianImpute: 0.0, scale: 1.5152045134325847 },
      { name: "starter_hr_adv", coef: -0.06350707350801672, mean: 0.00006483154569761516, medianImpute: 0.0, scale: 0.012709709463485909 },
      { name: "min_probable_prior_bf", coef: 0.04225737996347226, mean: 175.0892782644973, medianImpute: 130.0, scale: 161.02465094549933 },
      { name: "lineup_continuity_rate_adv", coef: -0.1003125744872183, mean: -0.0011125017382839666, medianImpute: 0.0, scale: 0.16897625165242633 },
      { name: "combined_starter_kbb", coef: -0.07009043223475815, mean: 0.28028306727454666, medianImpute: 0.27669490811376757, scale: 0.061174323511824585 },
      { name: "combined_team_rs10", coef: 0.10351059776752332, mean: 8.598868294362662, medianImpute: 8.5, scale: 1.4990281969726007 },
      { name: "combined_team_ra10", coef: 0.03366602543099145, mean: 8.594272768208938, medianImpute: 8.5, scale: 1.5244708797348414 },
    ]),
  }),
  F5_C4_2022_FROZEN: Object.freeze({
    intercept: 0.12785551478658838,
    threshold: 0.71,
    features: Object.freeze([
      { name: "lineup_exposure_rate_adv", coef: 0.11626823984498584, mean: 0.002085484683969735, medianImpute: 0.0, scale: 0.13693381340894337 },
      { name: "starter_kbb_adv", coef: 0.32935953881051333, mean: 0.000288499088083486, medianImpute: 0.0, scale: 0.06095753502065744 },
      { name: "combined_team_rs10", coef: 0.08098967905359096, mean: 8.592812382076419, medianImpute: 8.5, scale: 1.5048094331708086 },
      { name: "team_rd10_diff", coef: 0.12240651794059583, mean: -0.03748002826151535, medianImpute: 0.0, scale: 2.484955678007553 },
    ]),
  }),
  F5_FULL13_2022_FROZEN: Object.freeze({
    intercept: 0.12875201178437817,
    threshold: 0.69,
    features: Object.freeze([
      { name: "team_rd10_diff", coef: 0.05849471681554274, mean: -0.03748002826151535, medianImpute: 0.0, scale: 2.484955678007553 },
      { name: "team_win10_diff", coef: -0.03307669991847259, mean: -0.007308853401417893, medianImpute: 0.0, scale: 0.27391347595781607 },
      { name: "starter_kbb_adv", coef: 0.28570640080742965, mean: 0.000288499088083486, medianImpute: 0.0, scale: 0.06095753502065744 },
      { name: "team_ra10_adv", coef: 0.10172764164215456, mean: -0.02954131239411968, medianImpute: 0.0, scale: 1.5918309131943098 },
      { name: "lineup_exposure_rate_adv", coef: 0.14187301261410493, mean: 0.002085484683969735, medianImpute: 0.0, scale: 0.13693381340894337 },
      { name: "starter_runrisk_adv", coef: 0.08404618056637879, mean: -0.000068911537140103, medianImpute: 0.0, scale: 0.029358759372157824 },
      { name: "team_rs10_diff", coef: -0.010910829704541032, mean: -0.007938715867395682, medianImpute: 0.0, scale: 1.5192635626242292 },
      { name: "starter_hr_adv", coef: 0.03053134351297316, mean: -0.00009823309134907915, medianImpute: 0.0, scale: 0.012569371001170565 },
      { name: "min_probable_prior_bf", coef: 0.059012343398904384, mean: 175.11203844208396, medianImpute: 129.5, scale: 160.85293794225856 },
      { name: "lineup_continuity_rate_adv", coef: -0.07415720076636664, mean: -0.0019108638228516836, medianImpute: 0.0, scale: 0.16906912818736453 },
      { name: "combined_starter_kbb", coef: -0.05212485817717321, mean: 0.27952286063641085, medianImpute: 0.2758943964303685, scale: 0.060869904912645045 },
      { name: "combined_team_rs10", coef: 0.08277999743502022, mean: 8.592812382076419, medianImpute: 8.5, scale: 1.5048094331708086 },
      { name: "combined_team_ra10", coef: 0.022038604339067847, mean: 8.587629565398913, medianImpute: 8.5, scale: 1.529643733967444 },
    ]),
  }),
});

export interface MlbFrozenAPlusClassifierResult {
  version: typeof MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION;
  premiumA: boolean;
  aPlus: boolean;
  f5Consensus: boolean;
  probabilities: Readonly<{
    aPlusC4PHome: number;
    aPlusFull13PHome: number;
    f5C4PHome: number;
    f5Full13PHome: number;
  }>;
  policy: Readonly<{
    medianImputation: true;
    standardScalerFrozen: true;
    noThresholdSearch: true;
    noFeatureSearch: true;
    acquiresLiveEvidence: false;
    changesLiveRecommendation: false;
    changesRanking: false;
    changesStake: false;
  }>;
}

function assertFeatureSnapshot(features: MlbFrozenClassifierFeatureSnapshot): void {
  if (!features || typeof features !== "object") {
    throw new Error("MLB_FROZEN_CLASSIFIER_FEATURE_SNAPSHOT_REQUIRED");
  }
  for (const name of MLB_FROZEN_CLASSIFIER_FEATURE_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(features, name)) {
      throw new Error(`MLB_FROZEN_CLASSIFIER_FEATURE_MISSING:${name}`);
    }
    const value = features[name];
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`MLB_FROZEN_CLASSIFIER_FEATURE_NONFINITE:${name}`);
    }
  }
}

function sigmoid(logit: number): number {
  if (logit >= 0) {
    const exp = Math.exp(-logit);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(logit);
  return exp / (1 + exp);
}

export function scoreMlbFrozenClassifierModel(
  modelId: MlbFrozenClassifierModelId,
  features: MlbFrozenClassifierFeatureSnapshot,
): number {
  assertFeatureSnapshot(features);
  const model = MLB_FROZEN_CLASSIFIER_MODELS[modelId];
  let logit = model.intercept;
  for (const feature of model.features) {
    const raw = features[feature.name];
    const value = raw === null ? feature.medianImpute : raw;
    logit += feature.coef * ((value - feature.mean) / feature.scale);
  }
  return sigmoid(logit);
}

function meetsPremiumA(features: MlbFrozenClassifierFeatureSnapshot): boolean {
  const win10 = features.team_win10_diff;
  const kbb = features.starter_kbb_adv;
  const exposure = features.lineup_exposure_rate_adv;
  return win10 !== null
    && kbb !== null
    && exposure !== null
    && win10 >= MLB_FROZEN_PREMIUM_A_THRESHOLDS.team_win10_diff
    && kbb >= MLB_FROZEN_PREMIUM_A_THRESHOLDS.starter_kbb_adv
    && exposure >= MLB_FROZEN_PREMIUM_A_THRESHOLDS.lineup_exposure_rate_adv;
}

export function classifyMlbFrozenAPlusAndF5(
  features: MlbFrozenClassifierFeatureSnapshot,
): MlbFrozenAPlusClassifierResult {
  assertFeatureSnapshot(features);

  const aPlusC4PHome = scoreMlbFrozenClassifierModel("A_PLUS_C4_2022_FROZEN", features);
  const aPlusFull13PHome = scoreMlbFrozenClassifierModel("A_PLUS_FULL13_2022_FROZEN", features);
  const f5C4PHome = scoreMlbFrozenClassifierModel("F5_C4_2022_FROZEN", features);
  const f5Full13PHome = scoreMlbFrozenClassifierModel("F5_FULL13_2022_FROZEN", features);
  const premiumA = meetsPremiumA(features);

  const aPlus = premiumA
    && aPlusC4PHome >= MLB_FROZEN_CLASSIFIER_MODELS.A_PLUS_C4_2022_FROZEN.threshold
    && aPlusFull13PHome >= MLB_FROZEN_CLASSIFIER_MODELS.A_PLUS_FULL13_2022_FROZEN.threshold;

  const f5Consensus =
    f5C4PHome >= MLB_FROZEN_CLASSIFIER_MODELS.F5_C4_2022_FROZEN.threshold
    && f5Full13PHome >= MLB_FROZEN_CLASSIFIER_MODELS.F5_FULL13_2022_FROZEN.threshold;

  return Object.freeze({
    version: MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION,
    premiumA,
    aPlus,
    f5Consensus,
    probabilities: Object.freeze({
      aPlusC4PHome,
      aPlusFull13PHome,
      f5C4PHome,
      f5Full13PHome,
    }),
    policy: Object.freeze({
      medianImputation: true,
      standardScalerFrozen: true,
      noThresholdSearch: true,
      noFeatureSearch: true,
      acquiresLiveEvidence: false,
      changesLiveRecommendation: false,
      changesRanking: false,
      changesStake: false,
    }),
  });
}
