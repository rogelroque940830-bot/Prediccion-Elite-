import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FROZEN_V39_FEATURES, FROZEN_V39_MODEL } from "./mlb-full-modular-mechanistic-feature-builder";

const PYTHON_CANONICAL_PARAMETER_DIGEST =
  "sha256:29efa6b950c3dde20e6362cb604341add4df8528ef6d16deadb5f60869d8c0fa";

test("runtime V39 constants are value-identical to the persisted scientific snapshot", () => {
  const snapshot = JSON.parse(readFileSync("research/mlb-full-modular-v39-expected-outs-snapshot-v1.json", "utf8"));
  const m = snapshot.model;

  // Exact runtime-value parity is checked directly. Do not recompute the scientific
  // Python-canonical JSON digest with JSON.stringify: JavaScript renders integral
  // floating values such as 1.0 as 1, which changes bytes without changing values.
  assert.deepEqual([...FROZEN_V39_FEATURES], m.features);
  assert.deepEqual([...FROZEN_V39_MODEL.medianImpute], m.medianImpute);
  assert.deepEqual([...FROZEN_V39_MODEL.mean], m.mean);
  assert.deepEqual([...FROZEN_V39_MODEL.scale], m.scale);
  assert.deepEqual([...FROZEN_V39_MODEL.coefficients], m.coefficients);
  assert.equal(FROZEN_V39_MODEL.intercept, m.intercept);
  assert.equal(FROZEN_V39_MODEL.alpha, m.alpha);
  assert.equal(FROZEN_V39_MODEL.maxIter, m.maxIter);

  // The original scientific digest is preserved exactly and is recomputed with
  // Python's frozen serializer in CI, matching the serializer that created it.
  assert.equal(m.parameterPayloadSha256, PYTHON_CANONICAL_PARAMETER_DIGEST);
  assert.equal(FROZEN_V39_MODEL.parameterPayloadSha256, PYTHON_CANONICAL_PARAMETER_DIGEST);
  assert.equal(snapshot.scoring.runtimeModelFitAllowed, false);
  assert.equal(snapshot.scoring.runtimePreprocessingFitAllowed, false);
  assert.equal(snapshot.prospectiveOutcomesUsed, false);
});
