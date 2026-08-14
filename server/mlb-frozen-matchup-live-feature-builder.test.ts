import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbFrozenMatchupLiveFeatures,
  type MlbFrozenHandSplitGameAggregate,
  type MlbFrozenPitchmixGameAggregate,
} from "./mlb-frozen-matchup-live-feature-builder";

function handGame(
  gamePk: number,
  officialDate: string,
  homePa = 60,
  homeAb = 50,
  homeTb = 100,
  awayPa = 60,
  awayAb = 50,
  awayTb = 50,
): MlbFrozenHandSplitGameAggregate {
  return {
    gamePk,
    officialDate,
    teamHandTotals: [
      { teamId: 1, vsHand: "L", pa: homePa, ab: homeAb, tb: homeTb },
      { teamId: 2, vsHand: "R", pa: awayPa, ab: awayAb, tb: awayTb },
    ],
  };
}

function pitchGame(
  gamePk: number,
  officialDate: string,
  options: { homeStarterPitches?: number; mixBreaking?: boolean; breakingTeamSample?: number } = {},
): MlbFrozenPitchmixGameAggregate {
  const homeStarterPitches = options.homeStarterPitches ?? 300;
  const mixBreaking = options.mixBreaking ?? false;
  const breakingTeamSample = options.breakingTeamSample ?? 0;
  const fastball = mixBreaking ? 150 : 300;
  const breaking = mixBreaking ? 150 : 0;
  return {
    gamePk,
    officialDate,
    pitcherTotals: [
      {
        pitcherId: 101,
        allPitches: homeStarterPitches,
        categorizedPitches: homeStarterPitches,
        FASTBALL: Math.min(fastball, homeStarterPitches),
        BREAKING: homeStarterPitches > fastball ? Math.min(breaking, homeStarterPitches - fastball) : 0,
        OFFSPEED: 0,
      },
      { pitcherId: 202, allPitches: 300, categorizedPitches: 300, FASTBALL: fastball, BREAKING: breaking, OFFSPEED: 0 },
    ],
    teamPitchFamilyTotals: [
      { teamId: 1, pitchFamily: "FASTBALL", swings: 100, contacts: 80, whiffs: 20, terminalPa: 100, tb: 150, hr: 10 },
      { teamId: 2, pitchFamily: "FASTBALL", swings: 100, contacts: 70, whiffs: 30, terminalPa: 100, tb: 120, hr: 8 },
      { teamId: 1, pitchFamily: "BREAKING", swings: breakingTeamSample, contacts: breakingTeamSample, whiffs: 0, terminalPa: breakingTeamSample, tb: breakingTeamSample, hr: 0 },
      { teamId: 2, pitchFamily: "BREAKING", swings: breakingTeamSample, contacts: breakingTeamSample, whiffs: 0, terminalPa: breakingTeamSample, tb: breakingTeamSample, hr: 0 },
      { teamId: 1, pitchFamily: "OFFSPEED", swings: 0, contacts: 0, whiffs: 0, terminalPa: 0, tb: 0, hr: 0 },
      { teamId: 2, pitchFamily: "OFFSPEED", swings: 0, contacts: 0, whiffs: 0, terminalPa: 0, tb: 0, hr: 0 },
    ],
  };
}

function baseInput() {
  return {
    gamePk: 999001,
    officialDate: "2026-08-14",
    homeTeamId: 1,
    awayTeamId: 2,
    homeStarterId: 101,
    awayStarterId: 202,
    homeStarterHand: "R" as const,
    awayStarterHand: "L" as const,
    handSplitGames: [handGame(10, "2026-08-10")],
    pitchmixGames: [pitchGame(20, "2026-08-10")],
  };
}

test("reproduces frozen V9 SLG sign and V12 pitchmix directions", () => {
  const result = buildMlbFrozenMatchupLiveFeatures(baseInput());
  assert.equal(result.slg.eligible, true);
  assert.equal(result.slg.minimumPriorPa, 60);
  assert.equal(result.slg.adv, 1);

  assert.equal(result.pitchmix.eligible, true);
  assert.ok(Math.abs((result.pitchmix.contactAdv as number) - 0.10) < 1e-12);
  assert.ok(Math.abs((result.pitchmix.whiffAdv as number) - 0.10) < 1e-12);
  assert.ok(Math.abs((result.pitchmix.tbpaAdv as number) - 0.30) < 1e-12);
  assert.ok(Math.abs((result.pitchmix.hrpaAdv as number) - 0.02) < 1e-12);
  assert.equal(result.pitchmix.positiveCount, 4);
  assert.deepEqual(result.diagnostics.eligibilityReasons, []);
});

test("excludes same-date outcomes and resets SLG history at the season boundary", () => {
  const input = baseInput();
  input.handSplitGames = [
    handGame(1, "2025-09-20", 1000, 1000, 0, 1000, 1000, 5000),
    handGame(2, "2026-08-10"),
    handGame(3, "2026-08-14", 1000, 1000, 0, 1000, 1000, 5000),
  ];
  input.pitchmixGames = [
    pitchGame(4, "2026-08-10"),
    {
      ...pitchGame(5, "2026-08-14"),
      teamPitchFamilyTotals: [
        { teamId: 1, pitchFamily: "FASTBALL", swings: 1000, contacts: 0, whiffs: 1000, terminalPa: 1000, tb: 0, hr: 0 },
        { teamId: 2, pitchFamily: "FASTBALL", swings: 1000, contacts: 1000, whiffs: 0, terminalPa: 1000, tb: 5000, hr: 500 },
      ],
    },
  ];

  const result = buildMlbFrozenMatchupLiveFeatures(input);
  assert.equal(result.slg.adv, 1);
  assert.ok(Math.abs((result.pitchmix.contactAdv as number) - 0.10) < 1e-12);
});

test("fails SLG eligibility below the frozen 50 PA floor but preserves the descriptive value", () => {
  const input = baseInput();
  input.handSplitGames = [handGame(2, "2026-08-10", 49, 40, 80, 60, 50, 50)];
  const result = buildMlbFrozenMatchupLiveFeatures(input);
  assert.equal(result.slg.eligible, false);
  assert.equal(result.slg.adv, 1);
  assert.equal(result.slg.minimumPriorPa, 49);
});

test("fails pitchmix eligibility below the frozen 250-pitch starter floor but preserves descriptive values", () => {
  const input = baseInput();
  input.pitchmixGames = [pitchGame(20, "2026-08-10", { homeStarterPitches: 249 })];
  const result = buildMlbFrozenMatchupLiveFeatures(input);
  assert.equal(result.pitchmix.eligible, false);
  assert.ok(Math.abs((result.pitchmix.contactAdv as number) - 0.10) < 1e-12);
  assert.ok(result.diagnostics.eligibilityReasons.includes("HOME_STARTER_LOW_PITCHES"));
});

test("fails pitchmix eligibility when weighted family coverage is below 0.80", () => {
  const input = baseInput();
  input.pitchmixGames = [pitchGame(20, "2026-08-10", { mixBreaking: true, breakingTeamSample: 10 })];
  const result = buildMlbFrozenMatchupLiveFeatures(input);
  assert.equal(result.pitchmix.eligible, false);
  assert.ok(result.diagnostics.metricCoverage.CONTACT.home < 0.80);
  assert.ok(result.diagnostics.eligibilityReasons.includes("CONTACT_LOW_COVERAGE"));
  assert.ok(result.diagnostics.eligibilityReasons.includes("TBPA_LOW_COVERAGE"));
});

test("enforces the exact 365-day pitchmix window", () => {
  const input = baseInput();
  const stale = pitchGame(19, "2025-08-13");
  stale.pitcherTotals[0].allPitches = 5000;
  stale.pitcherTotals[0].categorizedPitches = 5000;
  stale.pitcherTotals[0].FASTBALL = 5000;
  input.pitchmixGames = [stale, pitchGame(20, "2026-08-10")];
  const result = buildMlbFrozenMatchupLiveFeatures(input);
  assert.equal(result.diagnostics.pitchmixWindowStart, "2025-08-14");
  assert.equal(result.diagnostics.homeStarterAllPitches, 300);
});
