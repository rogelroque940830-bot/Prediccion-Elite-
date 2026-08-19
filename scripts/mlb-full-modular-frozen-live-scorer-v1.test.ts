import assert from "node:assert/strict";
import fs from "node:fs";
import type { FullModularLiveReadyAssessment } from "../server/mlb-full-modular-live-operational-bridge";
import {
  scoreMlbFullModularFrozenLiveGame,
  scoreMlbFullModularFrozenLiveSlate,
  type MlbFullModularFrozenLiveCandidate,
  type MlbFullModularStrengthTier,
} from "../server/mlb-full-modular-frozen-live-scorer-v1";

const referencePath = process.env.MLB_FULL_MODULAR_REFERENCE_JSON;
if (!referencePath) throw new Error("MLB_FULL_MODULAR_REFERENCE_JSON_REQUIRED");
const reference = JSON.parse(fs.readFileSync(referencePath, "utf8"));
assert.equal(reference.schemaVersion, "courtedge-mlb-full-modular-frozen-live-reference.v1");
assert.equal(reference.officialDate, "2026-08-19");
assert.equal(reference.cases.length, 12);

function close(actual: number | null, expected: number | null, label: string): void {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, label);
    return;
  }
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= 1e-12, `${label}: ${actual} vs ${expected}; diff=${diff}`);
}

function assessment(gamePk: number, featureVector: Record<string, number>): FullModularLiveReadyAssessment {
  return {
    status: "READY",
    bridgeVersion: "mlb-full-modular-live-operational-parity-v1",
    officialDate: "2026-08-19",
    gamePk,
    featureVector,
  } as unknown as FullModularLiveReadyAssessment;
}

function compareCandidate(actual: MlbFullModularFrozenLiveCandidate, expected: any, prefix: string): void {
  for (const key of [
    "officialDate","gamePk","market","horizon","side","selectedLine","lineGeometry","strengthTier",
    "matchupStructure","frontier",
  ]) {
    assert.equal((actual as any)[key], expected[key], `${prefix}.${key}`);
  }
  close(actual.structureScore, expected.structureScore, `${prefix}.structureScore`);
  close(actual.structureObservedFeatureFraction, expected.structureObservedFeatureFraction, `${prefix}.structureObservedFeatureFraction`);
  close(actual.qualityScore, expected.qualityScore, `${prefix}.qualityScore`);
  close(actual.qualityPercentile, expected.qualityPercentile, `${prefix}.qualityPercentile`);
  close(actual.modelProbability, expected.modelProbability, `${prefix}.modelProbability`);
}

const slateGames: Array<{
  assessment: FullModularLiveReadyAssessment;
  homeStrengthTier: MlbFullModularStrengthTier;
  awayStrengthTier: MlbFullModularStrengthTier;
}> = [];
let candidateTotal = 0;
for (let i = 0; i < reference.cases.length; i += 1) {
  const fixture = reference.cases[i];
  const gamePk = 990000 + i;
  const game = {
    assessment: assessment(gamePk, fixture.featureVector),
    homeStrengthTier: fixture.homeStrengthTier as MlbFullModularStrengthTier,
    awayStrengthTier: fixture.awayStrengthTier as MlbFullModularStrengthTier,
  };
  slateGames.push(game);
  const actual = scoreMlbFullModularFrozenLiveGame(game);
  assert.equal(actual.length, fixture.candidates.length, `case[${i}] candidate count`);
  candidateTotal += actual.length;
  for (let j = 0; j < actual.length; j += 1) compareCandidate(actual[j], fixture.candidates[j], `case[${i}].candidate[${j}]`);
}

const slate = scoreMlbFullModularFrozenLiveSlate({ officialDate: "2026-08-19", games: slateGames });
assert.equal(slate.candidateCount, candidateTotal);
assert.equal(slate.maximumDailySelections, 1);
assert.equal(slate.runtimeRefit, false);
assert.equal(slate.runtimeThresholdFit, false);
assert.equal(slate.sameDateStateUpdate, false);
assert.equal(slate.outcomesRead, false);
assert.equal(slate.sportsbookPricesRead, false);
if (slate.candidates.length > 0) {
  assert.deepEqual(slate.selection, slate.candidates[0]);
  for (let i = 1; i < slate.candidates.length; i += 1) {
    const prev = slate.candidates[i - 1];
    const cur = slate.candidates[i];
    assert.ok(
      prev.qualityPercentile > cur.qualityPercentile
      || (prev.qualityPercentile === cur.qualityPercentile && prev.modelProbability > cur.modelProbability)
      || (prev.qualityPercentile === cur.qualityPercentile && prev.modelProbability === cur.modelProbability && prev.market <= cur.market),
      `daily ranking drift at ${i}`,
    );
  }
}

assert.ok(candidateTotal > 0, "reference fixtures must exercise at least one eligible candidate");
console.log("MLB_FULL_MODULAR_FROZEN_LIVE_SCORER_V1_DIFFERENTIAL_PARITY_PASSED", { candidateTotal });
