import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FROZEN_V39_FEATURES, FROZEN_V39_MODEL } from "./mlb-full-modular-mechanistic-feature-builder";

test("runtime V39 constants are byte-for-value identical to the persisted scientific snapshot", () => {
  const snapshot = JSON.parse(readFileSync("research/mlb-full-modular-v39-expected-outs-snapshot-v1.json", "utf8"));
  const m = snapshot.model;
  assert.deepEqual([...FROZEN_V39_FEATURES], m.features);
  assert.deepEqual([...FROZEN_V39_MODEL.medianImpute], m.medianImpute);
  assert.deepEqual([...FROZEN_V39_MODEL.mean], m.mean);
  assert.deepEqual([...FROZEN_V39_MODEL.scale], m.scale);
  assert.deepEqual([...FROZEN_V39_MODEL.coefficients], m.coefficients);
  assert.equal(FROZEN_V39_MODEL.intercept, m.intercept);
  assert.equal(FROZEN_V39_MODEL.alpha, m.alpha);
  assert.equal(FROZEN_V39_MODEL.maxIter, m.maxIter);

  const canonicalPayload = {
    alpha: m.alpha,
    coefficients: m.coefficients,
    features: m.features,
    intercept: m.intercept,
    maxIter: m.maxIter,
    mean: m.mean,
    medianImpute: m.medianImpute,
    scale: m.scale,
  };
  const digest = "sha256:" + createHash("sha256").update(JSON.stringify(canonicalPayload)).digest("hex");
  assert.equal(digest, "sha256:29efa6b950c3dde20e6362cb604341add4df8528ef6d16deadb5f60869d8c0fa");
  assert.equal(digest, m.parameterPayloadSha256);
  assert.equal(digest, FROZEN_V39_MODEL.parameterPayloadSha256);
  assert.equal(snapshot.scoring.runtimeModelFitAllowed, false);
  assert.equal(snapshot.scoring.runtimePreprocessingFitAllowed, false);
  assert.equal(snapshot.prospectiveOutcomesUsed, false);
});
