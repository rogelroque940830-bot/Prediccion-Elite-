import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE,
  loadMlbFrozenMatchupCanonicalSeed,
  resetMlbFrozenMatchupCanonicalSeedForTests,
} from "./mlb-frozen-matchup-canonical-seed";

test("decodes the frozen V9/V12 custody and verifies its raw digest", () => {
  resetMlbFrozenMatchupCanonicalSeedForTests();
  const seed = loadMlbFrozenMatchupCanonicalSeed();
  assert.equal(seed.rawSha256, MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256);
  assert.equal(seed.seedThroughDate, MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE);
  assert.equal(seed.supportedTargetDateGte, MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE);
  assert.equal(seed.supportedTargetDateLte, MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE);
  assert.equal(seed.pitchmixGames.length, 50);
  assert.equal(seed.pitchmixGames[0].officialDate, "2025-08-11");
  assert.equal(seed.pitchmixGames[48].officialDate, "2025-09-28");
  assert.equal(seed.pitchmixGames[49].officialDate, "2026-08-10");
  assert.equal(seed.handSplitGames.length, 1);
  assert.equal(seed.handSplitGames[0].officialDate, "2026-08-10");
  assert.equal(seed.sourceCustody.v9_2026_YTD.workflowRunId, 31666803576);
  assert.equal(seed.sourceCustody.v12_2025.workflowRunId, 31669146698);
  assert.equal(seed.sourceCustody.v12_2026_YTD.workflowRunId, 31669146698);
  assert.equal(seed.policy.priceIndependent, true);
  assert.equal(seed.policy.sameDateOutcomeLeakageAllowed, false);
  assert.equal(seed.policy.syntheticAggregateGameIdentities, true);
});

test("returns one immutable cached custody object", () => {
  resetMlbFrozenMatchupCanonicalSeedForTests();
  const left = loadMlbFrozenMatchupCanonicalSeed();
  const right = loadMlbFrozenMatchupCanonicalSeed();
  assert.equal(left, right);
  assert.equal(Object.isFrozen(left), true);
  assert.equal(Object.isFrozen(left.pitchmixGames), true);
  assert.equal(Object.isFrozen(left.handSplitGames), true);
});
