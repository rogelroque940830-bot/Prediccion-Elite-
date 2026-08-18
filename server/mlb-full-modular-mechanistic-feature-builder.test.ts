import test from "node:test";
import assert from "node:assert/strict";
import {
  FROZEN_V39_FEATURES,
  FROZEN_V39_MODEL,
  buildFullModularMechanisticFeatures,
  buildHorizonExposureFeatures,
  buildStarterQualityAdvantages,
  buildV66BullpenFeatures,
  buildV66BullpenProfile,
  computeV62StarterPitchQuality,
  scoreFrozenV39ExpectedOuts,
  type PitchQualityHistoryGame,
} from "./mlb-full-modular-mechanistic-feature-builder";

function close(actual: number | null | undefined, expected: number, tolerance = 1e-12) {
  assert.equal(typeof actual, "number");
  assert.ok(Number.isFinite(actual as number));
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${actual} != ${expected}`);
}

test("frozen V39 scorer reproduces the persisted standardized log-link formula", () => {
  const atMean = Object.fromEntries(FROZEN_V39_FEATURES.map((name, i) => [name, FROZEN_V39_MODEL.mean[i]]));
  close(scoreFrozenV39ExpectedOuts(atMean), 15.56057846750168, 1e-12);
  close(scoreFrozenV39ExpectedOuts({}), 15.606240468632386, 1e-12);
  assert.equal(FROZEN_V39_MODEL.parameterPayloadSha256, "sha256:29efa6b950c3dde20e6362cb604341add4df8528ef6d16deadb5f60869d8c0fa");
});

test("V66 horizon exposure exactly clips F3 and preserves F5/FG expected bullpen shares", () => {
  const f = buildHorizonExposureFeatures(12, 9);
  close(f.home_f3_starter_share, 1);
  close(f.away_f3_starter_share, 1);
  close(f.mean_f3_starter_share, 1);
  close(f.f3_exposure_adv, 0);
  close(f.home_f5_starter_share, 0.8);
  close(f.away_f5_starter_share, 0.6);
  close(f.mean_f5_starter_share, 0.7);
  close(f.f5_exposure_adv, 0.2);
  close(f.home_f5_expected_bullpen_share, 0.2);
  close(f.away_f5_expected_bullpen_share, 0.4);
  close(f.combined_f5_expected_bullpen_share, 0.6);
  close(f.home_fg_starter_share, 12 / 27);
  close(f.away_fg_starter_share, 9 / 27);
  close(f.fg_exposure_adv, 3 / 27);
});

test("V66 bullpen profile uses prior 30d, top-3 by pitch volume, D1/D3/core3/B2B exactly", () => {
  const history = [
    { officialDate: "2026-08-17", bullpenPitches: 30, relievers: { "1": 10, "2": 20 } },
    { officialDate: "2026-08-16", bullpenPitches: 40, relievers: { "1": 15, "3": 25 } },
    { officialDate: "2026-08-15", bullpenPitches: 50, relievers: { "4": 50 } },
    { officialDate: "2026-08-14", bullpenPitches: 10, relievers: { "2": 10 } },
    { officialDate: "2026-07-18", bullpenPitches: 999, relievers: { "9": 999 } },
  ];
  const p = buildV66BullpenProfile(history, "2026-08-18");
  assert.deepEqual(p, {
    bullpen_pitches_1d: 30,
    bullpen_pitches_3d: 120,
    bullpen_core3_pitches_2d: 45,
    bullpen_b2b_arms: 1,
    priorGames30d: 4,
    relieverPool: 4,
  });
});

test("V66 weighted bullpen advantages preserve away-minus-home orientation", () => {
  const exposure = buildHorizonExposureFeatures(12, 9);
  const home = {
    bullpen_pitches_1d: 30,
    bullpen_pitches_3d: 120,
    bullpen_core3_pitches_2d: 45,
    bullpen_b2b_arms: 1,
    priorGames30d: 4,
    relieverPool: 4,
  };
  const away = {
    bullpen_pitches_1d: 50,
    bullpen_pitches_3d: 150,
    bullpen_core3_pitches_2d: 65,
    bullpen_b2b_arms: 2,
    priorGames30d: 5,
    relieverPool: 5,
  };
  const f = buildV66BullpenFeatures({ homeProfile: home, awayProfile: away, exposure });
  close(f.bullpen_pitches_1d_adv, 20);
  close(f.bullpen_pitches_1d_adv_weighted_f5, 6);
  close(f.bullpen_pitches_1d_combined_weighted_f5, 24);
  close(f.bullpen_b2b_arms_adv, 1);
  close(f.bullpen_b2b_arms_adv_weighted_f5, 0.3);
});

test("V62 starter quality reproduces pitch-type shrinkage and excludes same-date history", () => {
  const history: PitchQualityHistoryGame[] = [
    {
      officialDate: "2026-08-17",
      gamePk: 1,
      pitcherPitchTypeTotals: [
        {
          pitcherId: 1, pitchType: "FF", pitches: 100, strikes: 60, swings: 50, whiffs: 10,
          velocityN: 100, velocitySum: 9500, spinN: 100, spinSum: 240000,
          battedBallN: 20, hardHitN: 5,
        },
        {
          pitcherId: 2, pitchType: "FF", pitches: 100, strikes: 50, swings: 50, whiffs: 5,
          velocityN: 100, velocitySum: 9300, spinN: 100, spinSum: 220000,
          battedBallN: 20, hardHitN: 10,
        },
      ],
    },
    {
      officialDate: "2026-08-18",
      gamePk: 2,
      pitcherPitchTypeTotals: [
        {
          pitcherId: 1, pitchType: "FF", pitches: 1000, strikes: 0, swings: 1000, whiffs: 1000,
          velocityN: 1000, velocitySum: 110000, spinN: 1000, spinSum: 4000000,
          battedBallN: 1000, hardHitN: 1000,
        },
      ],
    },
  ];
  const home = computeV62StarterPitchQuality({ starterId: 1, targetOfficialDate: "2026-08-18", history });
  const away = computeV62StarterPitchQuality({ starterId: 2, targetOfficialDate: "2026-08-18", history });
  assert.ok(home);
  assert.ok(away);
  close(home!.velocity, 0.5);
  close(home!.spin, 50);
  close(home!.whiff, 0.025);
  close(home!.strike, 0.025);
  close(home!.hard, 0.05);
  close(away!.velocity, -0.5);
  close(away!.spin, -50);
  close(away!.whiff, -0.025);
  close(away!.strike, -0.025);
  close(away!.hard, -0.05);
  const adv = buildStarterQualityAdvantages(home, away);
  close(adv.starter_velocity_adv, 1);
  close(adv.starter_spin_adv, 100);
  close(adv.starter_swing_miss_adv, 0.05);
  close(adv.starter_in_zone_adv, 0.05);
  close(adv.starter_weak_contact_adv, 0.1);
});

test("combined Full Modular mechanistic layer composes exposure, quality interactions and bullpen", () => {
  const homeQ = { velocity: 0.5, spin: 50, whiff: 0.025, strike: 0.025, hard: 0.05, starterPriorRecognizedPitches: 100 };
  const awayQ = { velocity: -0.5, spin: -50, whiff: -0.025, strike: -0.025, hard: -0.05, starterPriorRecognizedPitches: 100 };
  const f = buildFullModularMechanisticFeatures({
    homeExpectedOuts: 12,
    awayExpectedOuts: 9,
    homeStarterQuality: homeQ,
    awayStarterQuality: awayQ,
    homeBullpenProfile: { bullpen_pitches_1d: 30, bullpen_pitches_3d: 120, bullpen_core3_pitches_2d: 45, bullpen_b2b_arms: 1, priorGames30d: 4, relieverPool: 4 },
    awayBullpenProfile: { bullpen_pitches_1d: 50, bullpen_pitches_3d: 150, bullpen_core3_pitches_2d: 65, bullpen_b2b_arms: 2, priorGames30d: 5, relieverPool: 5 },
  });
  close(f.starter_velocity_adv_x_f5_mean_starter_share, 0.7);
  close(f.starter_spin_adv_x_f5_mean_starter_share, 70);
  close(f.starter_weak_contact_adv_x_fg_mean_starter_share, 0.1 * ((12 / 27 + 9 / 27) / 2));
  close(f.bullpen_pitches_1d_adv_weighted_f5, 6);
});
