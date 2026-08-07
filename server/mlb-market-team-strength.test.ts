import test from "node:test";
import assert from "node:assert/strict";
import { negativeBinomialRunPmf } from "./mlb-market-run-distribution";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
import {
  buildMlbTeamStrengthOosReport,
  buildMlbTeamStrengthSnapshot,
  mlbNb2LogPmf,
  predictMlbTeamRunMeans,
  selectMlbTeamPriorGamesNested,
} from "./mlb-market-team-strength";

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];
const TEAMS = [1, 2, 3, 4, 5, 6];
const OFFENSE: Record<number, number> = { 1: 1.55, 2: 1.30, 3: 1.08, 4: 0.94, 5: 0.74, 6: 0.55 };
const DEFENSE_WEAKNESS: Record<number, number> = { 1: 0.72, 2: 0.86, 3: 0.98, 4: 1.08, 5: 1.24, 6: 1.42 };
const BASE: Record<MlbProbabilityHorizon, { home: number; away: number }> = {
  FIRST_INNING: { home: 0.54, away: 0.48 },
  FIRST_3: { home: 1.62, away: 1.44 },
  FIRST_5: { home: 2.68, away: 2.38 },
  FULL_GAME: { home: 4.75, away: 4.18 },
};

function dateAt(index: number): string {
  return new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
}

function deterministicRuns(mu: number, day: number, salt: number): number {
  const wobble = (((day * 7 + salt * 11) % 5) - 2) * 0.22;
  return Math.max(0, Math.round(mu + wobble));
}

function teamSignalRows(days = 110): MlbHistoricalHorizonObservation[] {
  const rows: MlbHistoricalHorizonObservation[] = [];
  for (let day = 0; day < days; day += 1) {
    for (let gameIndex = 0; gameIndex < 3; gameIndex += 1) {
      const homeTeamId = TEAMS[(day + gameIndex * 2) % TEAMS.length];
      const awayTeamId = TEAMS[(day + gameIndex * 2 + 1) % TEAMS.length];
      const gamePk = 700000 + day * 10 + gameIndex;
      for (const horizon of HORIZONS) {
        const base = BASE[horizon];
        const homeMu = base.home * OFFENSE[homeTeamId] * DEFENSE_WEAKNESS[awayTeamId];
        const awayMu = base.away * OFFENSE[awayTeamId] * DEFENSE_WEAKNESS[homeTeamId];
        let homeRuns = deterministicRuns(homeMu, day, homeTeamId + gameIndex);
        const awayRuns = deterministicRuns(awayMu, day, awayTeamId + gameIndex + 3);
        if (horizon === "FULL_GAME" && homeRuns === awayRuns) homeRuns += 1;
        rows.push({
          schemaVersion: "courtedge-p1-m6a3b1-historical-dataset.v1",
          source: "MLB_STATS_API_OFFICIAL",
          gamePk,
          officialDate: dateAt(day),
          season: 2025,
          horizon,
          homeTeamId,
          homeTeam: `Team ${homeTeamId}`,
          awayTeamId,
          awayTeam: `Team ${awayTeamId}`,
          homeRuns,
          awayRuns,
          totalRuns: homeRuns + awayRuns,
          homeMinusAway: homeRuns - awayRuns,
          nrfi: horizon === "FIRST_INNING" ? homeRuns + awayRuns === 0 : null,
          sourceVersion: "synthetic-team-signal.v1",
          sourceDigest: "a".repeat(64),
        });
      }
    }
  }
  return rows;
}

function homogeneousRows(days = 80): MlbHistoricalHorizonObservation[] {
  const rows = teamSignalRows(days);
  return rows.map((row, index) => {
    const base = BASE[row.horizon];
    let homeRuns = deterministicRuns(base.home, Math.floor(index / 12), 1);
    const awayRuns = deterministicRuns(base.away, Math.floor(index / 12), 2);
    if (row.horizon === "FULL_GAME" && homeRuns === awayRuns) homeRuns += 1;
    return {
      ...row,
      homeRuns,
      awayRuns,
      totalRuns: homeRuns + awayRuns,
      homeMinusAway: homeRuns - awayRuns,
      nrfi: row.horizon === "FIRST_INNING" ? homeRuns + awayRuns === 0 : null,
      sourceVersion: "synthetic-homogeneous.v1",
      sourceDigest: "b".repeat(64),
    };
  });
}

test("team snapshot shrinks attack and defense toward league context without name-based identity", () => {
  const rows = teamSignalRows(50).filter((row) => row.horizon === "FULL_GAME");
  const snapshot = buildMlbTeamStrengthSnapshot(rows, 10);
  assert.equal(snapshot.horizon, "FULL_GAME");
  assert.equal(snapshot.actionabilityAllowed, false);
  assert.match(snapshot.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.ok(snapshot.teams["1"].offenseFactor > snapshot.teams["6"].offenseFactor);
  assert.ok(snapshot.teams["1"].defenseWeaknessFactor < snapshot.teams["6"].defenseWeaknessFactor);
  assert.equal(snapshot.teams["1"].teamId, 1);
});

test("unseen validation team falls back to league factor 1 instead of fabricated history", () => {
  const rows = teamSignalRows(40).filter((row) => row.horizon === "FIRST_5" && row.homeTeamId !== 6 && row.awayTeamId !== 6);
  const snapshot = buildMlbTeamStrengthSnapshot(rows, 20);
  const prediction = predictMlbTeamRunMeans(snapshot, {
    horizon: "FIRST_5",
    homeTeamId: 6,
    awayTeamId: 1,
  });
  assert.equal(prediction.homeTeamSeen, false);
  assert.equal(prediction.homeOffenseFactor, 1);
  assert.equal(prediction.homeDefenseWeaknessFactor, 1);
  assert.equal(prediction.awayTeamSeen, true);
  assert.ok(prediction.homeMeanRuns >= 0);
  assert.ok(prediction.awayMeanRuns >= 0);
});

test("B2A NB2 log probability matches A3A NB2 PMF parameterization", () => {
  const meanRuns = 3.4;
  const dispersionK = 2.7;
  const a3a = negativeBinomialRunPmf({
    meanRuns,
    dispersionK,
    sourceVersion: "parity.v1",
    sourceDigest: "parity",
  }, 20);
  for (let runs = 0; runs <= 10; runs += 1) {
    const expected = a3a.pmf[runs].probability;
    const actual = Math.exp(mlbNb2LogPmf(runs, meanRuns, dispersionK));
    assert.ok(Math.abs(actual - expected) < 2e-12, `NB2 parity failed at runs=${runs}`);
  }
});

test("nested prior selection is based only on the supplied training dates", () => {
  const horizonRows = teamSignalRows(70).filter((row) => row.horizon === "FULL_GAME");
  const trainingMax = dateAt(59);
  const training = horizonRows.filter((row) => row.officialDate <= trainingMax);
  const selection = selectMlbTeamPriorGamesNested(training, {
    priorGamesGrid: [5, 10, 20, 40],
    innerValidationDateCount: 7,
    minimumInnerHistoryDates: 30,
  });
  assert.ok([5, 10, 20, 40].includes(selection.selectedPriorGames));
  assert.ok(selection.innerHistoryMaxDate < selection.innerValidationMinDate);
  assert.equal(selection.leakageFree, true);
  assert.equal(selection.candidates.length, 4);
});

test("team signal challenger must beat the same NB2 league baseline out of sample", () => {
  const report = buildMlbTeamStrengthOosReport(teamSignalRows(110), {
    minimumTrainingDates: 40,
    validationDateCount: 7,
    stepDateCount: 7,
    minimumTotalValidationGames: 60,
    priorGamesGrid: [5, 10, 20, 40],
    innerValidationDateCount: 7,
    minimumInnerHistoryDates: 25,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(report.allFoldsLeakageFree, true);
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);

  const full = report.horizons.find((entry) => entry.horizon === "FULL_GAME");
  assert.equal(full?.status, "OOS_IMPROVEMENT");
  assert.ok((full?.baselineMinusChallengerCountNll ?? 0) > 0.05);
  assert.ok((full?.relativeCountNllReductionPct ?? 0) > 1);
  assert.ok((full?.challengerCountNegativeLogLikelihood ?? Infinity) < (full?.baselineNb2CountNegativeLogLikelihood ?? -Infinity));
  assert.ok(full?.folds.every((fold) => fold.trainingMaxDate < fold.validationMinDate));
  assert.ok(full?.folds.every((fold) => fold.nestedPriorSelection.innerHistoryMaxDate < fold.nestedPriorSelection.innerValidationMinDate));
});

test("homogeneous-team data cannot create automatic promotion even if a noisy metric happens to move", () => {
  const report = buildMlbTeamStrengthOosReport(homogeneousRows(80), {
    minimumTrainingDates: 40,
    validationDateCount: 5,
    stepDateCount: 5,
    minimumTotalValidationGames: 30,
    priorGamesGrid: [10, 20, 40],
    innerValidationDateCount: 5,
    minimumInnerHistoryDates: 25,
  });
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
  assert.ok(report.horizons.every((entry) => entry.automaticPromotionAllowed === false));
});

test("insufficient outer evidence remains explicitly non-actionable", () => {
  const report = buildMlbTeamStrengthOosReport(teamSignalRows(50), {
    minimumTrainingDates: 35,
    validationDateCount: 5,
    stepDateCount: 5,
    minimumTotalValidationGames: 500,
    priorGamesGrid: [10, 20],
    innerValidationDateCount: 5,
    minimumInnerHistoryDates: 25,
  });
  assert.ok(report.horizons.every((entry) => entry.status === "INSUFFICIENT_OOS_SAMPLE"));
  assert.ok(report.horizons.every((entry) => entry.actionabilityAllowed === false));
});

test("mixed horizons, full-game ties and malformed priors fail closed", () => {
  const rows = teamSignalRows(10);
  assert.throws(() => buildMlbTeamStrengthSnapshot(rows.slice(0, 2), 10), /P1_M6A3B2A_MIXED_HORIZONS/);

  const full = rows.find((row) => row.horizon === "FULL_GAME") as MlbHistoricalHorizonObservation;
  assert.throws(() => buildMlbTeamStrengthSnapshot([{ ...full, awayRuns: full.homeRuns }], 10), /P1_M6A3B2A_FULL_GAME_TIE_OBSERVATION/);

  const f5 = rows.filter((row) => row.horizon === "FIRST_5");
  assert.throws(() => selectMlbTeamPriorGamesNested(f5, { priorGamesGrid: [0] }), /P1_M6A3B2A_INVALID_PRIOR_GRID/);
  assert.throws(() => predictMlbTeamRunMeans(buildMlbTeamStrengthSnapshot(f5, 10), {
    horizon: "FIRST_3",
    homeTeamId: 1,
    awayTeamId: 2,
  }), /P1_M6A3B2A_HORIZON_MISMATCH/);
});
