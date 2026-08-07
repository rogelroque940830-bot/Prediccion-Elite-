import test from "node:test";
import assert from "node:assert/strict";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbLineupOosReport, MlbLineupPairedRow } from "./mlb-market-lineup-asof";
import { buildMlbLineupPairedInferenceReport } from "./mlb-market-lineup-inference";

const horizons: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];

function pairedRows(delta: number): MlbLineupPairedRow[] {
  return Array.from({ length: 8 }, (_, index) => {
    const team = 2;
    const lineup = team - delta;
    const league = 2.1;
    return {
      horizon: "FIRST_5",
      foldIndex: Math.floor(index / 2),
      gamePk: 910000 + index,
      officialDate: `2025-07-${String(index + 1).padStart(2, "0")}`,
      leagueNb2CountNll: league,
      teamOnlyCountNll: team,
      teamPlusLineupCountNll: lineup,
      teamMinusLineupCountNll: delta,
      leagueMinusLineupCountNll: league - lineup,
    };
  });
}

function oosReport(delta: number): MlbLineupOosReport {
  const rows = pairedRows(delta);
  return {
    schemaVersion: "courtedge-p1-m6a3b2c2-lineup-asof-oos.v1",
    model: "NB2_TEAM_PLUS_LINEUP_PLAYER_RESIDUAL_RUN_FACTOR_SHRINKAGE",
    generatedAt: "2026-08-07T00:00:00.000Z",
    configuration: {
      minimumTrainingDates: 60,
      validationDateCount: 14,
      stepDateCount: 14,
      minimumTotalValidationGames: 300,
      teamPriorGamesGrid: [10],
      playerPriorGamesGrid: [10],
      lineupEffectWeightGrid: [0, 1],
      innerValidationDateCount: 14,
      minimumInnerHistoryDates: 30,
    },
    horizons: horizons.map((horizon) => ({
      horizon,
      observations: horizon === "FIRST_5" ? rows.length : 0,
      uniqueDates: horizon === "FIRST_5" ? rows.length : 0,
      certifiedTargetObservations: horizon === "FIRST_5" ? rows.length : 0,
      validationGames: horizon === "FIRST_5" ? rows.length : 0,
      validationGamesExcludedForLineup: 0,
      status: horizon === "FIRST_5"
        ? delta > 0 ? "LINEUP_OOS_IMPROVEMENT_OVER_TEAM" : "NO_LINEUP_OOS_IMPROVEMENT"
        : "INSUFFICIENT_OOS_SAMPLE",
      leagueNb2CountNegativeLogLikelihood: horizon === "FIRST_5" ? 2.1 : null,
      teamOnlyCountNegativeLogLikelihood: horizon === "FIRST_5" ? 2 : null,
      teamPlusLineupCountNegativeLogLikelihood: horizon === "FIRST_5" ? 2 - delta : null,
      teamMinusLineupCountNll: horizon === "FIRST_5" ? delta : null,
      leagueMinusLineupCountNll: horizon === "FIRST_5" ? 0.1 + delta : null,
      relativeLineupReductionVsTeamPct: horizon === "FIRST_5" ? delta / 2 * 100 : null,
      folds: [],
      pairedRows: horizon === "FIRST_5" ? rows : [],
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
      blockers: ["NO_AUTOMATIC_PROMOTION"],
    })),
    allFoldsLeakageFree: true,
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2C2_LINEUP_CHALLENGER_ONLY",
      "P1_M6A3B2C2_PAIRED_INFERENCE_REQUIRED",
      "P1_M6A3B_FINAL_MODEL_CERTIFICATION_INCOMPLETE",
    ],
  };
}

test("paired date-cluster inference supports a constant positive lineup improvement", () => {
  const report = buildMlbLineupPairedInferenceReport(oosReport(0.1), {
    bootstrapReplicates: 500,
    minimumDateClusters: 2,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  const first5 = report.horizons.find((entry) => entry.horizon === "FIRST_5");
  assert.ok(first5);
  assert.equal(first5.teamComparison.pointEstimateCountNll, 0.1);
  assert.equal(first5.teamComparison.evidenceStatus, "SUPPORTED_IMPROVEMENT");
  assert.equal(first5.overallEvidenceStatus, "SUPPORTED_INCREMENTAL_IMPROVEMENT");
  assert.ok((first5.teamComparison.bonferroniFamilywise?.lower ?? 0) > 0);
});

test("paired inference flags supported regression when lineup is consistently worse than team-only", () => {
  const report = buildMlbLineupPairedInferenceReport(oosReport(-0.1), {
    bootstrapReplicates: 500,
    minimumDateClusters: 2,
  });
  const first5 = report.horizons.find((entry) => entry.horizon === "FIRST_5");
  assert.ok(first5);
  assert.equal(first5.teamComparison.evidenceStatus, "SUPPORTED_REGRESSION");
  assert.equal(first5.overallEvidenceStatus, "SUPPORTED_REGRESSION");
  assert.ok((first5.teamComparison.bonferroniFamilywise?.upper ?? 0) < 0);
});

test("paired bootstrap is deterministic for the same official-date clusters", () => {
  const a = buildMlbLineupPairedInferenceReport(oosReport(0.05), { bootstrapReplicates: 500, minimumDateClusters: 2 });
  const b = buildMlbLineupPairedInferenceReport(oosReport(0.05), { bootstrapReplicates: 500, minimumDateClusters: 2 });
  assert.deepEqual(a.horizons.map((entry) => entry.teamComparison), b.horizons.map((entry) => entry.teamComparison));
});

test("duplicate validation game fails closed before inference", () => {
  const report = oosReport(0.1);
  const source = report.horizons.find((entry) => entry.horizon === "FIRST_5");
  assert.ok(source);
  source.pairedRows.push({ ...source.pairedRows[0] });
  assert.throws(
    () => buildMlbLineupPairedInferenceReport(report, { bootstrapReplicates: 500, minimumDateClusters: 2 }),
    /DUPLICATE_VALIDATION_GAME/,
  );
});

test("research boundary remains non-actionable even when improvement is supported", () => {
  const report = buildMlbLineupPairedInferenceReport(oosReport(0.1), { bootstrapReplicates: 500, minimumDateClusters: 2 });
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
});
