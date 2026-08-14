import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMlbFrozenAPlusAndF5,
  MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION,
  MLB_FROZEN_CLASSIFIER_FEATURE_NAMES,
  MLB_FROZEN_CLASSIFIER_MODELS,
  MLB_FROZEN_PREMIUM_A_THRESHOLDS,
  scoreMlbFrozenClassifierModel,
  type MlbFrozenClassifierFeatureName,
  type MlbFrozenClassifierFeatureSnapshot,
  type MlbFrozenClassifierModelId,
} from "./mlb-frozen-a-plus-classifier";

function highSignalFeatures(): MlbFrozenClassifierFeatureSnapshot {
  return {
    team_rd10_diff: 2.5,
    team_win10_diff: 0.3,
    starter_kbb_adv: 0.09,
    team_ra10_adv: 1.0,
    lineup_exposure_rate_adv: 0.35,
    starter_runrisk_adv: 0.04,
    team_rs10_diff: 1.0,
    starter_hr_adv: -0.01,
    min_probable_prior_bf: 250,
    lineup_continuity_rate_adv: -0.05,
    combined_starter_kbb: 0.24,
    combined_team_rs10: 10.0,
    combined_team_ra10: 7.5,
  };
}

function allNullFeatures(): MlbFrozenClassifierFeatureSnapshot {
  return Object.fromEntries(
    MLB_FROZEN_CLASSIFIER_FEATURE_NAMES.map((name) => [name, null]),
  ) as MlbFrozenClassifierFeatureSnapshot;
}

function thresholdVector(
  modelId: MlbFrozenClassifierModelId,
  varyingFeature: MlbFrozenClassifierFeatureName,
): MlbFrozenClassifierFeatureSnapshot {
  const features = allNullFeatures();
  const model = MLB_FROZEN_CLASSIFIER_MODELS[modelId];
  for (const feature of model.features) features[feature.name] = feature.mean;
  const spec = model.features.find((feature) => feature.name === varyingFeature);
  assert.ok(spec);
  const targetLogit = Math.log(model.threshold / (1 - model.threshold));
  features[varyingFeature] = spec.mean
    + spec.scale * ((targetLogit - model.intercept) / spec.coef);
  return features;
}

function close(actual: number, expected: number, tolerance = 1e-12): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test("frozen scorer reproduces nontrivial V6 and V7 probability fixtures", () => {
  const features = highSignalFeatures();
  close(scoreMlbFrozenClassifierModel("A_PLUS_C4_2022_FROZEN", features), 0.7651752054822136);
  close(scoreMlbFrozenClassifierModel("A_PLUS_FULL13_2022_FROZEN", features), 0.8136377891824075);
  close(scoreMlbFrozenClassifierModel("F5_C4_2022_FROZEN", features), 0.7518891821205067);
  close(scoreMlbFrozenClassifierModel("F5_FULL13_2022_FROZEN", features), 0.773060610848697);
});

test("null research values use each frozen model median before frozen standardization", () => {
  const features = allNullFeatures();
  close(scoreMlbFrozenClassifierModel("A_PLUS_C4_2022_FROZEN", features), 0.5316240721115372);
  close(scoreMlbFrozenClassifierModel("A_PLUS_FULL13_2022_FROZEN", features), 0.5293408433798336);
  close(scoreMlbFrozenClassifierModel("F5_C4_2022_FROZEN", features), 0.5303070490849551);
  close(scoreMlbFrozenClassifierModel("F5_FULL13_2022_FROZEN", features), 0.5266428986354831);
});

test("all four frozen model thresholds are inclusive at the probability boundary", () => {
  const cases: Array<[MlbFrozenClassifierModelId, MlbFrozenClassifierFeatureName]> = [
    ["A_PLUS_C4_2022_FROZEN", "lineup_exposure_rate_adv"],
    ["A_PLUS_FULL13_2022_FROZEN", "lineup_exposure_rate_adv"],
    ["F5_C4_2022_FROZEN", "starter_kbb_adv"],
    ["F5_FULL13_2022_FROZEN", "starter_kbb_adv"],
  ];

  for (const [modelId, varyingFeature] of cases) {
    const model = MLB_FROZEN_CLASSIFIER_MODELS[modelId];
    const score = scoreMlbFrozenClassifierModel(modelId, thresholdVector(modelId, varyingFeature));
    close(score, model.threshold, 2e-15);
    assert.ok(score >= model.threshold - 2e-15);
  }
});

test("Premium A preserves all three exact inclusive V6 thresholds", () => {
  const exact = highSignalFeatures();
  exact.team_win10_diff = MLB_FROZEN_PREMIUM_A_THRESHOLDS.team_win10_diff;
  exact.starter_kbb_adv = MLB_FROZEN_PREMIUM_A_THRESHOLDS.starter_kbb_adv;
  exact.lineup_exposure_rate_adv = MLB_FROZEN_PREMIUM_A_THRESHOLDS.lineup_exposure_rate_adv;
  assert.equal(classifyMlbFrozenAPlusAndF5(exact).premiumA, true);

  for (const name of ["team_win10_diff", "starter_kbb_adv", "lineup_exposure_rate_adv"] as const) {
    const below = highSignalFeatures();
    below[name] = MLB_FROZEN_PREMIUM_A_THRESHOLDS[name] - Number.EPSILON;
    assert.equal(classifyMlbFrozenAPlusAndF5(below).premiumA, false, name);
  }
});

test("A+ requires Premium A plus both frozen V6 probability gates", () => {
  const high = classifyMlbFrozenAPlusAndF5(highSignalFeatures());
  assert.equal(high.premiumA, true);
  assert.equal(high.aPlus, true);
  assert.ok(high.probabilities.aPlusC4PHome >= 0.69);
  assert.ok(high.probabilities.aPlusFull13PHome >= 0.64);

  const notPremium = highSignalFeatures();
  notPremium.team_win10_diff = 0.09;
  const result = classifyMlbFrozenAPlusAndF5(notPremium);
  assert.equal(result.premiumA, false);
  assert.equal(result.aPlus, false);
});

test("F5 consensus is exactly the frozen V7 intersection C4 >= .71 AND FULL13 >= .69", () => {
  const high = classifyMlbFrozenAPlusAndF5(highSignalFeatures());
  assert.equal(high.f5Consensus, true);
  assert.ok(high.probabilities.f5C4PHome >= 0.71);
  assert.ok(high.probabilities.f5Full13PHome >= 0.69);

  const full13Below = highSignalFeatures();
  full13Below.team_win10_diff = 5;
  const result = classifyMlbFrozenAPlusAndF5(full13Below);
  assert.ok(result.probabilities.f5C4PHome >= 0.71);
  assert.ok(result.probabilities.f5Full13PHome < 0.69);
  assert.equal(result.f5Consensus, false);
});

test("classifier fails closed on absent or nonfinite feature keys but accepts explicit nulls", () => {
  const absent = highSignalFeatures() as Partial<MlbFrozenClassifierFeatureSnapshot>;
  delete absent.combined_team_ra10;
  assert.throws(
    () => classifyMlbFrozenAPlusAndF5(absent as MlbFrozenClassifierFeatureSnapshot),
    /MLB_FROZEN_CLASSIFIER_FEATURE_MISSING:combined_team_ra10/,
  );

  const nonfinite = highSignalFeatures();
  nonfinite.starter_kbb_adv = Number.POSITIVE_INFINITY;
  assert.throws(
    () => classifyMlbFrozenAPlusAndF5(nonfinite),
    /MLB_FROZEN_CLASSIFIER_FEATURE_NONFINITE:starter_kbb_adv/,
  );

  const missingResearchValues = allNullFeatures();
  const result = classifyMlbFrozenAPlusAndF5(missingResearchValues);
  assert.equal(result.premiumA, false);
  assert.equal(result.aPlus, false);
  assert.equal(result.f5Consensus, false);
});

test("classifier is deterministic and remains a pure non-mutating research classifier", () => {
  const features = highSignalFeatures();
  const first = classifyMlbFrozenAPlusAndF5(features);
  const second = classifyMlbFrozenAPlusAndF5({ ...features });
  assert.deepEqual(first, second);
  assert.equal(first.version, MLB_FROZEN_A_PLUS_CLASSIFIER_VERSION);
  assert.deepEqual(first.policy, {
    medianImputation: true,
    standardScalerFrozen: true,
    noThresholdSearch: true,
    noFeatureSearch: true,
    acquiresLiveEvidence: false,
    changesLiveRecommendation: false,
    changesRanking: false,
    changesStake: false,
  });
});
