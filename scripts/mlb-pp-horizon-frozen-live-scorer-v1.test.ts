import assert from "node:assert/strict";
import fs from "node:fs";
import type { FullModularLiveReadyAssessment } from "../server/mlb-full-modular-live-operational-bridge";
import type { MlbFullModularFrozenLiveGame, MlbFullModularStrengthTier } from "../server/mlb-full-modular-frozen-live-scorer-v1";
import {
  scoreMlbPpHorizonFrozenLiveSlate,
  type MlbPpHorizonFrozenLiveCandidate,
} from "../server/mlb-pp-horizon-frozen-live-scorer-v1";

const referencePath = process.env.MLB_PP_HORIZON_REFERENCE_JSON;
if (!referencePath) throw new Error("MLB_PP_HORIZON_REFERENCE_JSON_REQUIRED");
const reference = JSON.parse(fs.readFileSync(referencePath, "utf8"));
assert.equal(reference.schemaVersion, "courtedge-mlb-pp-horizon-frozen-live-reference.v1");
assert.equal(reference.officialDate, "2026-08-19");
assert.equal(reference.caseCount, 12);
assert.ok(reference.candidateCount > 0);

function assessment(gamePk: number, featureVector: Record<string, number>): FullModularLiveReadyAssessment {
  return {
    status: "READY",
    bridgeVersion: "mlb-full-modular-live-operational-parity-v1",
    officialDate: reference.officialDate,
    gamePk,
    featureVector,
  } as unknown as FullModularLiveReadyAssessment;
}

function close(actual: number | null, expected: number | null, label: string): void {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, label);
    return;
  }
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= 1e-12, `${label}: ${actual} vs ${expected}; diff=${diff}`);
}

function compareCandidate(actual: MlbPpHorizonFrozenLiveCandidate, expected: any, label: string): void {
  for (const key of [
    "officialDate","gamePk","market","horizon","side","selectedLine","lineGeometry","strengthTier",
    "matchupStructure","frontier","premium_core_support_count_0_to_3",
  ]) {
    assert.equal((actual as any)[key], expected[key], `${label}.${key}`);
  }
  for (const key of [
    "structureScore","structureObservedFeatureFraction","qualityScore","qualityPercentile","modelProbability",
    "premium_core_weakest_margin","frozen_c4_selected_side_probability","frozen_full13_selected_side_probability",
    "sel_starter_kbb_adv","sel_team_win10_diff","sel_lineup_exposure_rate_adv","sel_team_ra10_adv",
    "sel_starter_runrisk_adv","partialPoolProbability",
  ]) {
    close((actual as any)[key], expected[key], `${label}.${key}`);
  }
}

const games: MlbFullModularFrozenLiveGame[] = reference.cases.map((fixture: any, index: number) => ({
  assessment: assessment(990000 + index, fixture.featureVector),
  homeStrengthTier: fixture.homeStrengthTier as MlbFullModularStrengthTier,
  awayStrengthTier: fixture.awayStrengthTier as MlbFullModularStrengthTier,
}));

const actual = scoreMlbPpHorizonFrozenLiveSlate({ officialDate: reference.officialDate, games });
assert.equal(actual.candidateCount, reference.candidateCount);
assert.equal(actual.candidates.length, reference.candidateCount);
for (let index = 0; index < actual.candidates.length; index += 1) {
  const expectedAll = reference.cases.flatMap((fixture: any) => fixture.candidates).sort((a: any, b: any) =>
    (b.partialPoolProbability - a.partialPoolProbability)
    || (b.qualityPercentile - a.qualityPercentile)
    || (b.modelProbability - a.modelProbability)
    || String(a.market).localeCompare(String(b.market))
    || (a.gamePk - b.gamePk));
  compareCandidate(actual.candidates[index], expectedAll[index], `candidate[${index}]`);
}
assert.ok(actual.selection);
compareCandidate(actual.selection!, reference.dailySelection, "dailySelection");
assert.equal(actual.maximumDailySelections, 1);
assert.equal(actual.persistedSnapshotOnly, true);
assert.equal(actual.runtimeRefit, false);
assert.equal(actual.preprocessingRefit, false);
assert.equal(actual.outcomesRead, false);
assert.equal(actual.sportsbookPricesRead, false);

console.log("MLB_PP_HORIZON_FROZEN_LIVE_SCORER_V1_DIFFERENTIAL_PARITY_PASSED", {
  candidateCount: actual.candidateCount,
  selectedGamePk: actual.selection?.gamePk ?? null,
  selectedMarket: actual.selection?.market ?? null,
});
