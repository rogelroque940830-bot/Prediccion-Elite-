import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveMlbPhaseBSelection,
  scaleMlbPhaseBRuns,
} from "../frontend/client/src/lib/mlb-injury-phase-b";

const roster = [
  { name: "Closer One", isPitcher: true },
  { name: "Hitter One", isPitcher: false },
];

const feed = {
  autoApplyAllowed: true,
  phaseB: {
    enabled: true,
    eligiblePlayerNames: ["Closer One"],
    scale: 0.5,
    maxAbsRuns: 0.5,
  },
};

test("Phase B applies an eligible reliever when bullpen module has no overlapping adjustment", () => {
  const result = resolveMlbPhaseBSelection(roster, feed, { runsAdjustment: 0 });
  assert.deepEqual(result.appliedNames, ["Closer One"]);
  assert.equal(result.blockedReason, null);
});

test("Phase B abstains when bullpen status is unavailable", () => {
  const result = resolveMlbPhaseBSelection(roster, feed, null);
  assert.deepEqual(result.appliedNames, []);
  assert.equal(result.blockedReason, "BULLPEN_STATUS_UNAVAILABLE");
});

test("Phase B prevents double counting when bullpen module already applies a runs adjustment", () => {
  const result = resolveMlbPhaseBSelection(roster, feed, { runsAdjustment: 0.3 });
  assert.deepEqual(result.appliedNames, []);
  assert.equal(result.blockedReason, "BULLPEN_EFFECT_ALREADY_APPLIED");
});

test("conservative scale and cap prevent oversized automatic injury adjustments", () => {
  assert.equal(scaleMlbPhaseBRuns(-2, 0.5, 0.5), -0.5);
  assert.equal(scaleMlbPhaseBRuns(-0.4, 0.5, 0.5), -0.2);
  assert.equal(scaleMlbPhaseBRuns(0.5, 0.5, 0.5), 0);
});
