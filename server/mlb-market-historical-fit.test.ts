import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMlbHistoricalOutOfSampleReport,
  buildMlbRollingOriginDateFolds,
  fitMlbMarginalRunModel,
} from "./mlb-market-historical-fit";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];

function dateAt(index: number): string {
  return new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
}

function syntheticRows(days = 100): MlbHistoricalHorizonObservation[] {
  const rows: MlbHistoricalHorizonObservation[] = [];
  const homePattern = [0, 1, 2, 3, 6, 8];
  const awayPattern = [0, 0, 1, 2, 5, 7];
  for (let day = 0; day < days; day += 1) {
    for (let h = 0; h < HORIZONS.length; h += 1) {
      const horizon = HORIZONS[h];
      const scale = horizon === "FIRST_INNING" ? 0.25 : horizon === "FIRST_3" ? 0.55 : horizon === "FIRST_5" ? 0.75 : 1;
      const homeRuns = Math.round(homePattern[(day + h) % homePattern.length] * scale);
      const awayRuns = Math.round(awayPattern[(day * 2 + h) % awayPattern.length] * scale);
      rows.push({
        schemaVersion: "courtedge-p1-m6a3b1-historical-dataset.v1",
        source: "MLB_STATS_API_OFFICIAL",
        gamePk: 100000 + day,
        officialDate: dateAt(day),
        season: 2025,
        horizon,
        homeTeamId: 10,
        homeTeam: "Home Club",
        awayTeamId: 20,
        awayTeam: "Away Club",
        homeRuns,
        awayRuns,
        totalRuns: homeRuns + awayRuns,
        homeMinusAway: homeRuns - awayRuns,
        nrfi: horizon === "FIRST_INNING" ? homeRuns + awayRuns === 0 : null,
        sourceVersion: "fixture.v1",
        sourceDigest: "a".repeat(64),
      });
    }
  }
  return rows;
}

test("marginal NB2 fitting estimates finite positive dispersion on overdispersed counts", () => {
  const values = [0, 1, 2, 3, 6, 8, 0, 1, 2, 3, 6, 8];
  const poisson = fitMlbMarginalRunModel(values, "POISSON");
  const nb = fitMlbMarginalRunModel(values, "NEGATIVE_BINOMIAL_NB2");
  assert.equal(poisson.dispersionK, null);
  assert.ok((nb.dispersionK ?? 0) > 0);
  assert.ok(Number.isFinite(nb.dispersionK));
  assert.ok(nb.varianceRuns > nb.meanRuns);
  assert.ok(nb.inSampleMeanNegativeLogLikelihood < poisson.inSampleMeanNegativeLogLikelihood);
});

test("rolling-origin folds never mix the same or future date into training", () => {
  const firstHorizon = syntheticRows(50).filter((row) => row.horizon === "FIRST_5");
  const folds = buildMlbRollingOriginDateFolds(firstHorizon, {
    minimumTrainingDates: 20,
    validationDateCount: 5,
    stepDateCount: 5,
  });
  assert.ok(folds.length > 0);
  for (const fold of folds) {
    assert.ok(fold.trainingMaxDate < fold.validationMinDate);
    assert.equal(fold.trainingDates.some((date) => fold.validationDates.includes(date)), false);
  }
});

test("OOS report compares Poisson and NB2 separately for all four horizons", () => {
  const report = buildMlbHistoricalOutOfSampleReport(syntheticRows(100), {
    minimumTrainingDates: 30,
    validationDateCount: 10,
    stepDateCount: 10,
    minimumTotalValidationGames: 20,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(report.horizons.length, 4);
  assert.equal(report.allFoldsLeakageFree, true);
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);

  for (const horizon of report.horizons) {
    assert.equal(horizon.status, "READY_FOR_RESEARCH_REVIEW");
    assert.ok(horizon.candidates.POISSON.validationGames >= 20);
    assert.ok(horizon.candidates.NEGATIVE_BINOMIAL_NB2.validationGames >= 20);
    assert.ok((horizon.candidates.POISSON.meanCountNegativeLogLikelihood ?? 0) > 0);
    assert.ok((horizon.candidates.NEGATIVE_BINOMIAL_NB2.meanCountNegativeLogLikelihood ?? 0) > 0);
    assert.equal(horizon.candidates.POISSON.homeMoneylineCalibration?.calibrationGate.actionabilityAllowed, false);
    assert.equal(horizon.candidates.NEGATIVE_BINOMIAL_NB2.homeMoneylineCalibration?.calibrationGate.actionabilityAllowed, false);
  }

  const first = report.horizons.find((entry) => entry.horizon === "FIRST_INNING");
  assert.ok(first?.candidates.POISSON.nrfiCalibration);
  assert.ok(first?.candidates.NEGATIVE_BINOMIAL_NB2.nrfiCalibration);
  const f5 = report.horizons.find((entry) => entry.horizon === "FIRST_5");
  assert.equal(f5?.candidates.POISSON.nrfiCalibration, null);
});

test("overdispersed synthetic baseline favors NB2 by OOS count log score", () => {
  const report = buildMlbHistoricalOutOfSampleReport(syntheticRows(120), {
    minimumTrainingDates: 30,
    validationDateCount: 10,
    stepDateCount: 10,
    minimumTotalValidationGames: 30,
  });
  const full = report.horizons.find((entry) => entry.horizon === "FULL_GAME");
  assert.equal(full?.preferredFamilyByCountNll, "NEGATIVE_BINOMIAL_NB2");
  assert.ok((full?.countNllDeltaPoissonMinusNb2 ?? 0) > 0);
});

test("insufficient OOS evidence never produces a preferred family", () => {
  const report = buildMlbHistoricalOutOfSampleReport(syntheticRows(25), {
    minimumTrainingDates: 15,
    validationDateCount: 5,
    stepDateCount: 5,
    minimumTotalValidationGames: 100,
  });
  for (const horizon of report.horizons) {
    assert.equal(horizon.status, "INSUFFICIENT_OOS_SAMPLE");
    assert.equal(horizon.preferredFamilyByCountNll, null);
    assert.equal(horizon.actionabilityAllowed, false);
  }
});

test("invalid samples and invalid rolling configuration fail closed", () => {
  assert.throws(() => fitMlbMarginalRunModel([1, -1], "POISSON"), /P1_M6A3B1_INVALID_RUN_SAMPLE/);
  assert.throws(() => buildMlbRollingOriginDateFolds(syntheticRows(10), {
    minimumTrainingDates: 0,
    validationDateCount: 5,
    stepDateCount: 5,
  }), /P1_M6A3B1_INVALID_ROLLING_ORIGIN_CONFIGURATION/);
});
