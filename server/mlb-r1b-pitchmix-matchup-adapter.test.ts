import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbFrozenMatchupLiveFeatures,
  type MlbFrozenMatchupLivePregameInput,
  type MlbFrozenPitchmixGameAggregate,
} from "./mlb-frozen-matchup-live-feature-builder";
import { buildMlbR1bPitchmixMatchupFeature } from "./mlb-r1b-pitchmix-matchup-adapter";

function pitchGame(officialDate = "2023-08-01"): MlbFrozenPitchmixGameAggregate {
  return {
    gamePk: 700001,
    officialDate,
    pitcherTotals: [
      { pitcherId: 1001, allPitches: 300, categorizedPitches: 300, FASTBALL: 100, BREAKING: 100, OFFSPEED: 100 },
      { pitcherId: 1002, allPitches: 300, categorizedPitches: 300, FASTBALL: 100, BREAKING: 100, OFFSPEED: 100 },
    ],
    teamPitchFamilyTotals: [
      { teamId: 10, pitchFamily: "FASTBALL", swings: 100, whiffs: 20, contacts: 80, terminalPa: 100, tb: 40, hr: 10 },
      { teamId: 10, pitchFamily: "BREAKING", swings: 100, whiffs: 25, contacts: 75, terminalPa: 100, tb: 35, hr: 8 },
      { teamId: 10, pitchFamily: "OFFSPEED", swings: 100, whiffs: 30, contacts: 70, terminalPa: 100, tb: 30, hr: 6 },
      { teamId: 20, pitchFamily: "FASTBALL", swings: 100, whiffs: 30, contacts: 70, terminalPa: 100, tb: 30, hr: 6 },
      { teamId: 20, pitchFamily: "BREAKING", swings: 100, whiffs: 35, contacts: 65, terminalPa: 100, tb: 25, hr: 5 },
      { teamId: 20, pitchFamily: "OFFSPEED", swings: 100, whiffs: 40, contacts: 60, terminalPa: 100, tb: 20, hr: 4 },
    ],
  };
}

function input(officialDate: string, games: MlbFrozenPitchmixGameAggregate[] = [pitchGame()]): MlbFrozenMatchupLivePregameInput {
  return {
    gamePk: 800001,
    officialDate,
    homeTeamId: 10,
    awayTeamId: 20,
    homeStarterId: 1001,
    awayStarterId: 1002,
    homeStarterHand: "R",
    awayStarterHand: "L",
    handSplitGames: [],
    pitchmixGames: games,
  };
}

test("2022 is structural missingness, never numeric zero", () => {
  const r = buildMlbR1bPitchmixMatchupFeature(input("2022-07-01", []));
  assert.equal(r.eligible, false);
  assert.equal(r.values, null);
  assert.equal(r.missingnessReason, "NOT_APPLICABLE_BEFORE_FROZEN_V12_WARMUP");
  assert.equal(r.inputStage, "PREGAME");
});

test("2023 is frozen V12 warmup/source-only, not a target feature", () => {
  const r = buildMlbR1bPitchmixMatchupFeature(input("2023-07-01", []));
  assert.equal(r.eligible, false);
  assert.equal(r.values, null);
  assert.equal(r.missingnessReason, "NOT_APPLICABLE_FROZEN_V12_WARMUP_SEASON");
});

test("2024+ numerical values are exact projection of canonical frozen builder", () => {
  const x = input("2024-04-01");
  const direct = buildMlbFrozenMatchupLiveFeatures(x);
  const r = buildMlbR1bPitchmixMatchupFeature(x);
  assert.equal(r.eligible, direct.pitchmix.eligible);
  assert.deepEqual(r.values, {
    contactAdv: direct.pitchmix.contactAdv,
    whiffAdv: direct.pitchmix.whiffAdv,
    tbpaAdv: direct.pitchmix.tbpaAdv,
    hrpaAdv: direct.pitchmix.hrpaAdv,
    positiveCount: direct.pitchmix.positiveCount,
  });
  assert.equal(r.diagnostics?.pitchmixWindowStart, direct.diagnostics.pitchmixWindowStart);
  assert.equal(r.diagnostics?.pitchmixPriorGames, direct.diagnostics.pitchmixPriorGames);
  assert.deepEqual(r.diagnostics?.metricCoverage, direct.diagnostics.metricCoverage);
  assert.deepEqual(r.diagnostics?.eligibilityReasons, direct.diagnostics.eligibilityReasons);
  assert.equal(r.inputStage, "PREGAME");
});

test("target-date pitch data is excluded by canonical V12 boundary", () => {
  const prior = pitchGame("2023-08-01");
  const sameDate = pitchGame("2024-04-01");
  sameDate.pitcherTotals[0].allPitches = 100000;
  sameDate.pitcherTotals[0].categorizedPitches = 100000;
  sameDate.pitcherTotals[0].FASTBALL = 100000;
  sameDate.pitcherTotals[0].BREAKING = 0;
  sameDate.pitcherTotals[0].OFFSPEED = 0;
  const a = buildMlbR1bPitchmixMatchupFeature(input("2024-04-01", [prior]));
  const b = buildMlbR1bPitchmixMatchupFeature(input("2024-04-01", [prior, sameDate]));
  assert.deepEqual(b.values, a.values);
  assert.deepEqual(b.diagnostics, a.diagnostics);
});

test("insufficient evidence remains missing/ineligible and is never imputed", () => {
  const r = buildMlbR1bPitchmixMatchupFeature(input("2024-04-01", []));
  assert.equal(r.eligible, false);
  assert.equal(r.missingnessReason, "PITCHMIX_COVERAGE_OR_STARTER_EVIDENCE_INSUFFICIENT");
  assert.deepEqual(r.values, { contactAdv: null, whiffAdv: null, tbpaAdv: null, hrpaAdv: null, positiveCount: 0 });
  assert.ok((r.diagnostics?.eligibilityReasons.length ?? 0) > 0);
});
