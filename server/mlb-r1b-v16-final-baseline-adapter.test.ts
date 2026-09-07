import assert from "node:assert/strict";
import test from "node:test";
import { C4_LIVE_FEATURE_BUILDER_VERSION, type C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";
import { adaptCertifiedFinalC4ToR1bV16Baseline } from "./mlb-r1b-v16-final-baseline-adapter";

function assessment(): C4LiveFeatureAssessment {
  return {
    builderVersion: C4_LIVE_FEATURE_BUILDER_VERSION,
    priceIndependent: true,
    sameDateHistoryAllowed: false,
    seasonResetHistory: true,
    featureVector: {
      lineup_exposure_rate_adv: 0.1,
      starter_kbb_adv: 0.03,
      combined_team_rs10: 9.2,
      team_rd10_diff: 1.5,
    },
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

test("projects FINAL C4 to R1B rows with exact frozen V16 probabilities", () => {
  const c4 = assessment();
  const generatedAt = "2026-08-13T15:00:00.000Z";
  const expected = scoreMlbV16SettlementEvidence(999003, generatedAt, c4);
  const rows = adaptCertifiedFinalC4ToR1bV16Baseline({
    officialDate: "2026-08-13",
    gamePk: 999003,
    generatedAt,
    inputStage: "FINAL",
    c4,
  });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => [row.market, row.side]), [
    ["FG_ML", "HOME"], ["FG_ML", "AWAY"], ["F5_ML", "HOME"], ["F5_ML", "AWAY"],
  ]);
  assert.equal(rows[0].probability, expected.fullGame.homeWinProbability);
  assert.equal(rows[1].probability, expected.fullGame.awayWinProbability);
  assert.equal(rows[2].probability, expected.first5.homeWinProbability);
  assert.equal(rows[3].probability, expected.first5.awayWinProbability);
  assert.equal(rows[2].pushProbability, expected.first5.pushProbability);
  assert.equal(rows[3].pushProbability, expected.first5.pushProbability);
  assert.ok(rows.every((row) => row.priceIndependent && !row.outcomeFieldsRead && !row.marketPricesRead));
});

test("fails closed for PROVISIONAL until the separate robust-proxy path is parity-certified", () => {
  assert.throws(() => adaptCertifiedFinalC4ToR1bV16Baseline({
    officialDate: "2026-08-13",
    gamePk: 999004,
    generatedAt: "2026-08-13T15:00:00.000Z",
    inputStage: "PROVISIONAL",
    c4: assessment(),
  }), /MLB_R1B_V16_PROVISIONAL_NOT_CERTIFIED_BY_FINAL_ADAPTER/);
});

test("inherits frozen C4 provenance fail-closed behavior from the runtime scorer", () => {
  const bad = assessment() as any;
  bad.sameDateHistoryAllowed = true;
  assert.throws(() => adaptCertifiedFinalC4ToR1bV16Baseline({
    officialDate: "2026-08-13",
    gamePk: 999005,
    generatedAt: "2026-08-13T15:00:00.000Z",
    inputStage: "FINAL",
    c4: bad,
  }), /MLB_V16_RUNTIME_TEMPORAL_BOUNDARY_INVALID/);
});
