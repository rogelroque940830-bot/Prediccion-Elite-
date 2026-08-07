import test from "node:test";
import assert from "node:assert/strict";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import type { MlbHistoricalHorizonObservation } from "./mlb-market-historical-dataset";
import {
  bootstrapMlbPairedDateClusters,
  buildMlbTeamStrengthPairedInferenceReport,
  type MlbPairedDateCluster,
} from "./mlb-market-team-strength-inference";

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];
const TEAMS = [1, 2, 3, 4];
const OFFENSE: Record<number, number> = { 1: 1.8, 2: 1.35, 3: 0.78, 4: 0.48 };
const DEFENSE_WEAKNESS: Record<number, number> = { 1: 0.55, 2: 0.82, 3: 1.22, 4: 1.65 };
const BASE: Record<MlbProbabilityHorizon, { home: number; away: number }> = {
  FIRST_INNING: { home: 0.56, away: 0.49 },
  FIRST_3: { home: 1.72, away: 1.48 },
  FIRST_5: { home: 2.84, away: 2.42 },
  FULL_GAME: { home: 4.95, away: 4.25 },
};

function dateAt(index: number): string {
  return new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
}

function observedRuns(mu: number, day: number, salt: number): number {
  const wobble = (((day * 17 + salt * 13) % 7) - 3) * 0.12;
  return Math.max(0, Math.round(mu + wobble));
}

function row(
  day: number,
  gameIndex: number,
  horizon: MlbProbabilityHorizon,
  homeTeamId: number,
  awayTeamId: number,
  homeRuns: number,
  awayRuns: number,
  sourceVersion: string,
): MlbHistoricalHorizonObservation {
  return {
    schemaVersion: "courtedge-p1-m6a3b1-historical-dataset.v1",
    source: "MLB_STATS_API_OFFICIAL",
    gamePk: 810000 + day * 10 + gameIndex,
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
    sourceVersion,
    sourceDigest: "a".repeat(64),
  };
}

function strongTeamSignalRows(days = 100): MlbHistoricalHorizonObservation[] {
  const rows: MlbHistoricalHorizonObservation[] = [];
  for (let day = 0; day < days; day += 1) {
    const matchups = day % 2 === 0
      ? [[1, 4], [2, 3]]
      : [[4, 2], [3, 1]];
    for (let gameIndex = 0; gameIndex < matchups.length; gameIndex += 1) {
      const [homeTeamId, awayTeamId] = matchups[gameIndex];
      for (const horizon of HORIZONS) {
        const base = BASE[horizon];
        const homeMu = base.home * OFFENSE[homeTeamId] * DEFENSE_WEAKNESS[awayTeamId];
        const awayMu = base.away * OFFENSE[awayTeamId] * DEFENSE_WEAKNESS[homeTeamId];
        let homeRuns = observedRuns(homeMu, day, homeTeamId + gameIndex);
        const awayRuns = observedRuns(awayMu, day, awayTeamId + gameIndex + 7);
        if (horizon === "FULL_GAME" && homeRuns === awayRuns) homeRuns += 1;
        rows.push(row(day, gameIndex, horizon, homeTeamId, awayTeamId, homeRuns, awayRuns, "strong-team-signal.v1"));
      }
    }
  }
  return rows;
}

function homogeneousRows(days = 90): MlbHistoricalHorizonObservation[] {
  const rows: MlbHistoricalHorizonObservation[] = [];
  for (let day = 0; day < days; day += 1) {
    const matchups = day % 2 === 0
      ? [[1, 2], [3, 4]]
      : [[2, 3], [4, 1]];
    for (let gameIndex = 0; gameIndex < matchups.length; gameIndex += 1) {
      const [homeTeamId, awayTeamId] = matchups[gameIndex];
      for (const horizon of HORIZONS) {
        const base = BASE[horizon];
        let homeRuns = observedRuns(base.home, day, gameIndex + 2);
        const awayRuns = observedRuns(base.away, day, gameIndex + 2);
        if (horizon === "FULL_GAME" && homeRuns === awayRuns) homeRuns += 1;
        rows.push(row(day, gameIndex, horizon, homeTeamId, awayTeamId, homeRuns, awayRuns, "homogeneous.v1"));
      }
    }
  }
  return rows;
}

function simpleClusters(values: number[]): MlbPairedDateCluster[] {
  return values.map((delta, index) => ({
    officialDate: dateAt(index),
    games: 10,
    countObservations: 20,
    baselineNllTotal: 40,
    challengerNllTotal: 40 - delta * 20,
    baselineMinusChallengerNllTotal: delta * 20,
    baselineMinusChallengerMeanCountNll: delta,
  }));
}

test("paired date bootstrap is deterministic for identical evidence", () => {
  const clusters = simpleClusters(Array.from({ length: 60 }, (_, index) => 0.02 + (index % 5 - 2) * 0.002));
  const first = bootstrapMlbPairedDateClusters("FULL_GAME", clusters, { replicates: 1000 });
  const second = bootstrapMlbPairedDateClusters("FULL_GAME", clusters, { replicates: 1000 });
  assert.deepEqual(first, second);
  assert.ok(first.bonferroniFamilywise.lower > 0);
  assert.ok(first.unadjusted95.lower > 0);
});

test("Bonferroni family-wise interval is never narrower than unadjusted 95 percent interval", () => {
  const clusters = simpleClusters(Array.from({ length: 50 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.008)));
  const result = bootstrapMlbPairedDateClusters("FIRST_5", clusters, { replicates: 1000, familywiseHorizons: 4 });
  assert.ok(result.bonferroniFamilywise.lower <= result.unadjusted95.lower);
  assert.ok(result.bonferroniFamilywise.upper >= result.unadjusted95.upper);
  assert.equal(result.bonferroniFamilywise.confidenceLevel, 0.9875);
});

test("strong team signal produces supported improvement only after paired date uncertainty clears zero", () => {
  const report = buildMlbTeamStrengthPairedInferenceReport(strongTeamSignalRows(100), {
    minimumTrainingDates: 35,
    validationDateCount: 5,
    stepDateCount: 5,
    minimumTotalValidationGames: 50,
    priorGamesGrid: [5, 10, 20],
    innerValidationDateCount: 5,
    minimumInnerHistoryDates: 20,
    bootstrapReplicates: 1000,
    minimumDateClusters: 25,
    generatedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
  assert.ok(report.horizons.every((horizon) => horizon.evidenceStatus === "SUPPORTED_IMPROVEMENT"));
  assert.ok(report.horizons.every((horizon) => (horizon.bonferroniFamilywise?.lower ?? -1) > 0));
});

test("homogeneous team evidence never creates a false supported improvement", () => {
  const report = buildMlbTeamStrengthPairedInferenceReport(homogeneousRows(90), {
    minimumTrainingDates: 35,
    validationDateCount: 5,
    stepDateCount: 5,
    minimumTotalValidationGames: 40,
    priorGamesGrid: [10, 20, 40],
    innerValidationDateCount: 5,
    minimumInnerHistoryDates: 20,
    bootstrapReplicates: 1000,
    minimumDateClusters: 20,
  });

  for (const horizon of report.horizons) {
    assert.notEqual(horizon.evidenceStatus, "SUPPORTED_IMPROVEMENT");
    assert.ok(
      horizon.evidenceStatus === "INCONCLUSIVE" || horizon.evidenceStatus === "SUPPORTED_REGRESSION",
      `unexpected homogeneous-data status ${horizon.horizon}:${horizon.evidenceStatus}`,
    );
    const interval = horizon.bonferroniFamilywise;
    assert.ok(interval != null);
    if (horizon.evidenceStatus === "INCONCLUSIVE") {
      assert.ok(interval.lower <= 0 && interval.upper >= 0);
    } else {
      assert.ok(interval.upper < 0);
    }
    assert.equal(horizon.automaticPromotionAllowed, false);
  }
});

test("insufficient date clusters fail closed before bootstrap inference", () => {
  const report = buildMlbTeamStrengthPairedInferenceReport(strongTeamSignalRows(45), {
    minimumTrainingDates: 30,
    validationDateCount: 5,
    stepDateCount: 5,
    minimumTotalValidationGames: 500,
    priorGamesGrid: [10, 20],
    innerValidationDateCount: 5,
    minimumInnerHistoryDates: 20,
    bootstrapReplicates: 500,
    minimumDateClusters: 50,
  });
  assert.ok(report.horizons.every((horizon) => horizon.evidenceStatus === "INSUFFICIENT_OOS_SAMPLE"));
  assert.ok(report.horizons.every((horizon) => horizon.bonferroniFamilywise === null));
});

test("malformed cluster and bootstrap configurations fail closed", () => {
  assert.throws(() => bootstrapMlbPairedDateClusters("FULL_GAME", simpleClusters([0.1]), { replicates: 100 }), /P1_M6A3B2A_INFERENCE_INVALID_BOOTSTRAP_REPLICATES/);
  assert.throws(() => bootstrapMlbPairedDateClusters("FULL_GAME", [{ ...simpleClusters([0.1])[0], officialDate: "bad" }], { replicates: 500 }), /P1_M6A3B2A_INFERENCE_INVALID_DATE_CLUSTER/);
});
