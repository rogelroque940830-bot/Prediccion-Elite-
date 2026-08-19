import assert from "node:assert/strict";
import {
  MLB_FROZEN_CLASSIFIER_MODELS,
  MLB_FROZEN_PREMIUM_A_THRESHOLDS,
} from "../server/mlb-frozen-a-plus-classifier";
// @ts-ignore -- test-only JSON authority import.
import authorityJson from "../research/mlb-frozen-classifier-authority-v1.json";

const authority = authorityJson as any;
assert.equal(authority.schemaVersion, "courtedge-mlb-frozen-classifier-authority.v1");
assert.equal(authority.source.blob, "b5b23d69aab6f9d8f3cef87af86d88a314b1cca2");
assert.deepEqual(authority.premiumAThresholds, MLB_FROZEN_PREMIUM_A_THRESHOLDS);
for (const modelId of ["A_PLUS_C4_2022_FROZEN", "A_PLUS_FULL13_2022_FROZEN"] as const) {
  assert.deepEqual(authority.models[modelId], MLB_FROZEN_CLASSIFIER_MODELS[modelId]);
}
assert.equal(authority.runtimePolicy.runtimeRefitAllowed, false);
assert.equal(authority.runtimePolicy.thresholdSearchAllowed, false);
assert.equal(authority.runtimePolicy.outcomeInputAllowed, false);
assert.equal(authority.runtimePolicy.sportsbookPriceInputAllowed, false);
console.log("MLB_FROZEN_CLASSIFIER_AUTHORITY_V1_PARITY_PASSED");
