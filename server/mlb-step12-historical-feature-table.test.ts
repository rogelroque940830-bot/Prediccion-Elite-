import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbStep12HistoricalFeatureTable } from "./mlb-step12-historical-feature-table";

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    predictionKey: "2025-07-01:1:FULL_GAME",
    gamePk: 1,
    officialDate: "2025-07-01",
    scheduledStartAt: "2025-07-01T23:10:00.000Z",
    horizon: "FULL_GAME" as const,
    homeTeamId: 10,
    awayTeamId: 20,
    features: {
      leagueHomeMeanRuns: 4.6,
      leagueAwayMeanRuns: 4.2,
      teamHomeMeanRuns: 4.9,
      teamAwayMeanRuns: 3.8,
      homeOffenseFactor: 1.08,
      awayOffenseFactor: 0.94,
      homeDefenseWeaknessFactor: 0.97,
      awayDefenseWeaknessFactor: 1.04,
      homeStarterRiskFactor: 0.88,
      awayStarterRiskFactor: 1.12,
      pitcherEffectWeight: 0.5,
      homeLineupFactor: 1.06,
      awayLineupFactor: 0.96,
      lineupEffectWeight: 0.5,
    },
    featureProvenance: [
      {
        featureFamily: "LEAGUE_BASELINE" as const,
        sourceSchema: "baseline.v1",
        asOf: "2025-06-30T23:59:59.000Z",
        sourceDigest: "a".repeat(64),
      },
      {
        featureFamily: "TEAM_STRENGTH" as const,
        sourceSchema: "team.v1",
        asOf: "2025-06-30T23:59:59.000Z",
        sourceDigest: "b".repeat(64),
      },
      {
        featureFamily: "STARTING_PITCHER" as const,
        sourceSchema: "pitcher.v1",
        asOf: "2025-07-01T22:00:00.000Z",
        sourceDigest: "c".repeat(64),
      },
      {
        featureFamily: "LINEUP" as const,
        sourceSchema: "lineup.v1",
        asOf: "2025-07-01T23:05:00.000Z",
        sourceDigest: "d".repeat(64),
      },
    ],
    outcome: { homeRuns: 5, awayRuns: 3, totalRuns: 8, homeResult: "WIN" as const },
    ...overrides,
  };
}

test("Step 12B creates strict chronological discovery and holdout partitions", () => {
  const discovery = baseRow();
  const holdout = baseRow({
    predictionKey: "2025-08-15:2:FULL_GAME",
    gamePk: 2,
    officialDate: "2025-08-15",
    scheduledStartAt: "2025-08-15T23:10:00.000Z",
    featureProvenance: baseRow().featureProvenance.map((p) => ({ ...p, asOf: p.featureFamily === "LINEUP" ? "2025-08-15T23:05:00.000Z" : "2025-08-14T23:59:59.000Z" })),
  });
  const table = buildMlbStep12HistoricalFeatureTable({
    generatedAt: "2026-08-11T21:00:00.000Z",
    discoveryEndDate: "2025-07-31",
    holdoutStartDate: "2025-08-01",
    rows: [holdout, discovery],
  });
  assert.equal(table.split.discoveryRows, 1);
  assert.equal(table.split.holdoutRows, 1);
  assert.equal(table.rows[0].partition, "DISCOVERY");
  assert.equal(table.rows[1].partition, "HOLDOUT");
  assert.equal(table.policy.randomShuffleAllowed, false);
  assert.equal(table.policy.thresholdsLearnedFromHoldoutAllowed, false);
});

test("post-start feature evidence fails closed as time leakage", () => {
  const bad = baseRow({
    featureProvenance: [{
      featureFamily: "LINEUP" as const,
      sourceSchema: "lineup.v1",
      asOf: "2025-07-01T23:11:00.000Z",
      sourceDigest: "d".repeat(64),
    }],
  });
  assert.throws(() => buildMlbStep12HistoricalFeatureTable({
    generatedAt: "2026-08-11T21:00:00.000Z",
    discoveryEndDate: "2025-07-01",
    holdoutStartDate: "2025-07-02",
    rows: [bad, baseRow({ predictionKey: "2025-07-02:2:FULL_GAME", gamePk: 2, officialDate: "2025-07-02", scheduledStartAt: "2025-07-02T23:10:00.000Z", featureProvenance: [{ featureFamily: "LINEUP", sourceSchema: "lineup.v1", asOf: "2025-07-02T23:05:00.000Z", sourceDigest: "e".repeat(64) }] })],
  }), /MLB_STEP12_FEATURE_TABLE_TIME_LEAKAGE_DETECTED/);
});

test("outcome arithmetic and result labels are validated separately from features", () => {
  const invalid = baseRow({ outcome: { homeRuns: 5, awayRuns: 3, totalRuns: 9, homeResult: "WIN" } });
  assert.throws(() => buildMlbStep12HistoricalFeatureTable({
    generatedAt: "2026-08-11T21:00:00.000Z",
    discoveryEndDate: "2025-07-01",
    holdoutStartDate: "2025-07-02",
    rows: [invalid, baseRow({ predictionKey: "2025-07-02:2:FULL_GAME", gamePk: 2, officialDate: "2025-07-02", scheduledStartAt: "2025-07-02T23:10:00.000Z", featureProvenance: [{ featureFamily: "LINEUP", sourceSchema: "lineup.v1", asOf: "2025-07-02T23:05:00.000Z", sourceDigest: "e".repeat(64) }] })],
  }), /MLB_STEP12_FEATURE_TABLE_OUTCOME_INVALID/);
});

test("missing compatible pregame features stay null rather than fabricated zero", () => {
  const discovery = baseRow({
    features: {
      leagueHomeMeanRuns: 4.6,
      leagueAwayMeanRuns: 4.2,
      teamHomeMeanRuns: null,
      teamAwayMeanRuns: null,
      homeOffenseFactor: null,
      awayOffenseFactor: null,
      homeDefenseWeaknessFactor: null,
      awayDefenseWeaknessFactor: null,
      homeStarterRiskFactor: null,
      awayStarterRiskFactor: null,
      pitcherEffectWeight: null,
      homeLineupFactor: null,
      awayLineupFactor: null,
      lineupEffectWeight: null,
    },
    featureProvenance: [{ featureFamily: "LEAGUE_BASELINE", sourceSchema: "baseline.v1", asOf: "2025-06-30T23:59:59.000Z", sourceDigest: "a".repeat(64) }],
  });
  const holdout = baseRow({
    predictionKey: "2025-07-02:2:FULL_GAME",
    gamePk: 2,
    officialDate: "2025-07-02",
    scheduledStartAt: "2025-07-02T23:10:00.000Z",
    featureProvenance: [{ featureFamily: "LEAGUE_BASELINE", sourceSchema: "baseline.v1", asOf: "2025-07-01T23:59:59.000Z", sourceDigest: "b".repeat(64) }],
  });
  const table = buildMlbStep12HistoricalFeatureTable({ generatedAt: "2026-08-11T21:00:00.000Z", discoveryEndDate: "2025-07-01", holdoutStartDate: "2025-07-02", rows: [discovery, holdout] });
  assert.equal(table.rows[0].features.homeStarterRiskFactor, null);
  assert.equal(table.policy.missingPregameFeatureMeansUnknownNotZero, true);
  assert.equal(table.policy.historicalPricesRequiredForSportingHitRateStudy, false);
  assert.equal(table.policy.historicalPricesRequiredForHistoricalEvClaim, true);
});
