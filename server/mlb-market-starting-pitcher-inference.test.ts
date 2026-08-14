import test from "node:test";
import assert from "node:assert/strict";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type {
  MlbStartingPitcherHorizonReport,
  MlbStartingPitcherOosReport,
  MlbStartingPitcherPairedRow,
} from "./mlb-market-starting-pitcher-asof";
import { buildMlbStartingPitcherPairedInferenceReport } from "./mlb-market-starting-pitcher-inference";

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];

function day(index: number): string {
  return new Date(Date.UTC(2025, 4, 1 + index)).toISOString().slice(0, 10);
}

function rows(
  horizon: MlbProbabilityHorizon,
  teamDelta: number,
  leagueDelta: number,
  count = 40,
): MlbStartingPitcherPairedRow[] {
  return Array.from({ length: count }, (_, index) => {
    const pitcher = 1.5 + (index % 3) * 0.01;
    const team = pitcher + teamDelta;
    const league = pitcher + leagueDelta;
    return {
      horizon,
      foldIndex: Math.floor(index / 10),
      gamePk: 900000 + HORIZONS.indexOf(horizon) * 1000 + index,
      officialDate: day(index),
      leagueNb2CountNll: league,
      teamOnlyCountNll: team,
      teamPlusPitcherCountNll: pitcher,
      teamMinusPitcherCountNll: teamDelta,
      leagueMinusPitcherCountNll: leagueDelta,
    };
  });
}

function horizonReport(
  horizon: MlbProbabilityHorizon,
  pairedRows: MlbStartingPitcherPairedRow[],
): MlbStartingPitcherHorizonReport {
  const teamDelta = pairedRows.length
    ? pairedRows.reduce((sum, row) => sum + row.teamMinusPitcherCountNll, 0) / pairedRows.length
    : null;
  const leagueDelta = pairedRows.length
    ? pairedRows.reduce((sum, row) => sum + row.leagueMinusPitcherCountNll, 0) / pairedRows.length
    : null;
  const teamNll = pairedRows.length
    ? pairedRows.reduce((sum, row) => sum + row.teamOnlyCountNll, 0) / pairedRows.length
    : null;
  const pitcherNll = pairedRows.length
    ? pairedRows.reduce((sum, row) => sum + row.teamPlusPitcherCountNll, 0) / pairedRows.length
    : null;
  const leagueNll = pairedRows.length
    ? pairedRows.reduce((sum, row) => sum + row.leagueNb2CountNll, 0) / pairedRows.length
    : null;
  return {
    horizon,
    observations: pairedRows.length,
    uniqueDates: new Set(pairedRows.map((row) => row.officialDate)).size,
    validationGames: pairedRows.length,
    status: teamDelta != null && teamDelta > 0 ? "PITCHER_OOS_IMPROVEMENT_OVER_TEAM" : "NO_PITCHER_OOS_IMPROVEMENT",
    leagueNb2CountNegativeLogLikelihood: leagueNll,
    teamOnlyCountNegativeLogLikelihood: teamNll,
    teamPlusPitcherCountNegativeLogLikelihood: pitcherNll,
    teamMinusPitcherCountNll: teamDelta,
    leagueMinusPitcherCountNll: leagueDelta,
    relativePitcherReductionVsTeamPct: teamDelta != null && teamNll ? (teamDelta / teamNll) * 100 : null,
    folds: [],
    pairedRows,
    actionabilityAllowed: false,
    automaticPromotionAllowed: false,
    blockers: ["NO_AUTOMATIC_PROMOTION"],
  };
}

function reportFor(
  teamDelta: number,
  leagueDelta: number,
  count = 40,
): MlbStartingPitcherOosReport {
  return {
    schemaVersion: "courtedge-p1-m6a3b2b2-starting-pitcher-asof-oos.v1",
    model: "NB2_TEAM_PLUS_STARTER_ER_PER_BF_SHRINKAGE",
    generatedAt: "2026-08-07T00:00:00.000Z",
    configuration: {
      minimumTrainingDates: 60,
      validationDateCount: 14,
      stepDateCount: 14,
      minimumTotalValidationGames: 20,
      teamPriorGamesGrid: [20],
      pitcherPriorBattersGrid: [72],
      pitcherEffectWeightGrid: [0, 0.5, 1],
      innerValidationDateCount: 14,
      minimumInnerHistoryDates: 30,
    },
    horizons: HORIZONS.map((horizon) => horizonReport(horizon, rows(horizon, teamDelta, leagueDelta, count))),
    allFoldsLeakageFree: true,
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2B2_STARTING_PITCHER_CHALLENGER_ONLY",
      "P1_M6A3B2B2_PAIRED_INFERENCE_REQUIRED",
      "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE",
    ],
  };
}

test("constant positive paired deltas produce supported incremental improvement", () => {
  const report = buildMlbStartingPitcherPairedInferenceReport(reportFor(0.02, 0.01), {
    bootstrapReplicates: 500,
    minimumDateClusters: 30,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  for (const horizon of report.horizons) {
    assert.equal(horizon.teamComparison.evidenceStatus, "SUPPORTED_IMPROVEMENT");
    assert.equal(horizon.leagueComparison.evidenceStatus, "SUPPORTED_IMPROVEMENT");
    assert.equal(horizon.overallEvidenceStatus, "SUPPORTED_INCREMENTAL_IMPROVEMENT");
    assert.equal(horizon.teamComparison.bonferroniFamilywise?.lower > 0, true);
    assert.equal(horizon.leagueComparison.bonferroniFamilywise?.lower > 0, true);
  }
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
});

test("supported loss against team is classified as pitcher regression", () => {
  const report = buildMlbStartingPitcherPairedInferenceReport(reportFor(-0.02, -0.01), {
    bootstrapReplicates: 500,
    minimumDateClusters: 30,
  });
  for (const horizon of report.horizons) {
    assert.equal(horizon.teamComparison.evidenceStatus, "SUPPORTED_REGRESSION");
    assert.equal(horizon.overallEvidenceStatus, "SUPPORTED_REGRESSION");
    assert.equal((horizon.teamComparison.bonferroniFamilywise?.upper ?? 1) < 0, true);
  }
});

test("zero paired delta remains inconclusive and cannot self-promote", () => {
  const report = buildMlbStartingPitcherPairedInferenceReport(reportFor(0, 0), {
    bootstrapReplicates: 500,
    minimumDateClusters: 30,
  });
  for (const horizon of report.horizons) {
    assert.equal(horizon.teamComparison.evidenceStatus, "INCONCLUSIVE");
    assert.equal(horizon.leagueComparison.evidenceStatus, "INCONCLUSIVE");
    assert.equal(horizon.overallEvidenceStatus, "INCONCLUSIVE");
  }
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
});

test("too few official-date clusters produces insufficient evidence", () => {
  const report = buildMlbStartingPitcherPairedInferenceReport(reportFor(0.02, 0.01, 10), {
    bootstrapReplicates: 500,
    minimumDateClusters: 30,
  });
  for (const horizon of report.horizons) {
    assert.equal(horizon.teamComparison.evidenceStatus, "INSUFFICIENT_OOS_SAMPLE");
    assert.equal(horizon.overallEvidenceStatus, "INSUFFICIENT_OOS_SAMPLE");
    assert.equal(horizon.teamComparison.bonferroniFamilywise, null);
  }
});

test("duplicate validation games fail closed rather than overweighting evidence", () => {
  const source = reportFor(0.02, 0.01);
  const first = source.horizons[0];
  first.pairedRows = [...first.pairedRows, first.pairedRows[0]];
  assert.throws(
    () => buildMlbStartingPitcherPairedInferenceReport(source, { bootstrapReplicates: 500 }),
    /DUPLICATE_VALIDATION_GAME/,
  );
});

test("tampered point-delta parity fails closed", () => {
  const source = reportFor(0.02, 0.01);
  source.horizons[0].pairedRows[0] = {
    ...source.horizons[0].pairedRows[0],
    teamMinusPitcherCountNll: 0.25,
  };
  assert.throws(
    () => buildMlbStartingPitcherPairedInferenceReport(source, { bootstrapReplicates: 500 }),
    /ROW_POINT_PARITY_FAILURE/,
  );
});
