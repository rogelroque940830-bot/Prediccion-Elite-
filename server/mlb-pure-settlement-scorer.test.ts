import assert from "node:assert/strict";
import test from "node:test";
import { C4_LIVE_FEATURE_BUILDER_VERSION, type C4LiveFeatureAssessment, type C4LiveFeatureVector } from "./mlb-c4-live-feature-builder";
import { adaptMlbV16SettlementEvidence } from "./mlb-pure-settlement-evidence-adapter";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";

function assessment(featureVector: C4LiveFeatureVector): C4LiveFeatureAssessment {
  return {
    builderVersion: C4_LIVE_FEATURE_BUILDER_VERSION,
    priceIndependent: true,
    sameDateHistoryAllowed: false,
    seasonResetHistory: true,
    featureVector,
    diagnostics: {
      homePriorGames: 100,
      awayPriorGames: 100,
      leaguePriorStarterBattersFaced: 10000,
      homeStarterPriorBattersFaced: 500,
      awayStarterPriorBattersFaced: 500,
      homePriorCompleteLineups: 100,
      awayPriorCompleteLineups: 100,
    },
  };
}

function close(actual: number, expected: number, tolerance = 1e-14): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

test("matches the frozen V16 reference probabilities at the 2022 preprocessor mean", () => {
  const evidence = scoreMlbV16SettlementEvidence(999001, "2026-08-13T15:00:00.000Z", assessment({
    lineup_exposure_rate_adv: 0.0014282576209765502,
    starter_kbb_adv: 0.0002749983103482041,
    combined_team_rs10: 8.598701960628567,
    team_rd10_diff: -0.04855054476614112,
  }));
  close(evidence.fullGame.homeWinProbability, 0.5146047034270751);
  close(evidence.fullGame.awayWinProbability, 0.4853952965729249);
  close(evidence.first5.homeWinProbability, 0.44283115922946176);
  close(evidence.first5.awayWinProbability, 0.4072261113242296);
  close(evidence.first5.pushProbability, 0.14994272944630857);
  close(evidence.first5.homeWinProbability + evidence.first5.awayWinProbability + evidence.first5.pushProbability, 1);
});

test("uses the frozen median imputation for missing C4 values", () => {
  const evidence = scoreMlbV16SettlementEvidence(999002, "2026-08-13T15:00:00.000Z", assessment({
    lineup_exposure_rate_adv: null,
    starter_kbb_adv: null,
    combined_team_rs10: null,
    team_rd10_diff: null,
  }));
  close(evidence.fullGame.homeWinProbability, 0.5133268470054002);
  close(evidence.first5.homeWinProbability, 0.44201123619537275);
  close(evidence.first5.awayWinProbability, 0.40820180571329956);
  close(evidence.first5.pushProbability, 0.1497869580913277);
});

test("feeds the existing Step 10 V16 evidence adapter without changing settlement semantics", () => {
  const evidence = scoreMlbV16SettlementEvidence(999003, "2026-08-13T15:00:00.000Z", assessment({
    lineup_exposure_rate_adv: 0.1,
    starter_kbb_adv: 0.03,
    combined_team_rs10: 9.2,
    team_rd10_diff: 1.5,
  }));
  close(evidence.fullGame.homeWinProbability, 0.584105972876747);
  close(evidence.first5.homeWinProbability, 0.4963887595736469);
  close(evidence.first5.awayWinProbability, 0.3558973363960637);
  close(evidence.first5.pushProbability, 0.14771390403028947);
  const adapted = adaptMlbV16SettlementEvidence(evidence);
  assert.equal(adapted.length, 4);
  assert.ok(adapted.every((row) => row.status === "READY"));
  const f5Home = adapted.find((row) => row.marketType === "F5_ML" && row.side === "HOME");
  assert.equal(f5Home?.probabilitySemantics, "UNCONDITIONAL_SETTLEMENT");
  close(f5Home?.pushProbability ?? -1, evidence.first5.pushProbability);
});

test("fails closed if the C4 provenance boundary is not exact", () => {
  const bad = assessment({ lineup_exposure_rate_adv: 0, starter_kbb_adv: 0, combined_team_rs10: 8.5, team_rd10_diff: 0 }) as any;
  bad.builderVersion = "untrusted-c4-builder";
  assert.throws(() => scoreMlbV16SettlementEvidence(999004, "2026-08-13T15:00:00.000Z", bad), /MLB_V16_RUNTIME_C4_VERSION_INVALID/);
});
