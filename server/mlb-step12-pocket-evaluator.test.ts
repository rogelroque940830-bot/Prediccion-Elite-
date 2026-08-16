import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbStep12HistoricalFeatureTable } from "./mlb-step12-historical-feature-table";
import { evaluateMlbStep12PocketRule } from "./mlb-step12-pocket-evaluator";

function row(gamePk: number, date: string, homeResult: "WIN" | "LOSS" | "PUSH", teamAdv: number, pitcherAdv: number) {
  const homeRuns = homeResult === "WIN" ? 5 : homeResult === "LOSS" ? 2 : 3;
  const awayRuns = homeResult === "WIN" ? 2 : homeResult === "LOSS" ? 5 : 3;
  return {
    predictionKey: `${date}:${gamePk}:FULL_GAME`,
    gamePk,
    officialDate: date,
    scheduledStartAt: `${date}T23:10:00.000Z`,
    horizon: "FULL_GAME" as const,
    homeTeamId: 100 + gamePk,
    awayTeamId: 200 + gamePk,
    features: {
      leagueHomeMeanRuns: 4.5,
      leagueAwayMeanRuns: 4.2,
      teamHomeMeanRuns: 4.8,
      teamAwayMeanRuns: 4.0,
      homeOffenseFactor: 1.1,
      awayOffenseFactor: 0.9,
      homeDefenseWeaknessFactor: 0.95,
      awayDefenseWeaknessFactor: 1.05,
      homeStarterRiskFactor: pitcherAdv > 0 ? 0.9 : 1.1,
      awayStarterRiskFactor: pitcherAdv > 0 ? 1.1 : 0.9,
      pitcherEffectWeight: 0.5,
      homeLineupFactor: 1.05,
      awayLineupFactor: 0.98,
      lineupEffectWeight: 0.5,
    },
    featureProvenance: [{
      featureFamily: "TEAM_STRENGTH" as const,
      sourceSchema: "team.v1",
      asOf: `${date}T20:00:00.000Z`,
      sourceDigest: String(gamePk % 10).repeat(64),
    }],
    outcome: { homeRuns, awayRuns, totalRuns: homeRuns + awayRuns, homeResult },
  };
}

function table() {
  const rows = [
    row(1, "2025-07-01", "WIN", 2, 2),
    row(2, "2025-07-02", "WIN", 2, 2),
    row(3, "2025-07-03", "LOSS", -2, -2),
    row(4, "2025-08-01", "WIN", 2, 2),
    row(5, "2025-08-02", "WIN", 2, 2),
    row(6, "2025-08-03", "LOSS", -2, -2),
  ];
  // Map abstract test advantages onto canonical fields.
  rows[0].features.teamHomeMeanRuns = 6; rows[0].features.teamAwayMeanRuns = 3;
  rows[1].features.teamHomeMeanRuns = 6; rows[1].features.teamAwayMeanRuns = 3;
  rows[2].features.teamHomeMeanRuns = 3; rows[2].features.teamAwayMeanRuns = 6;
  rows[3].features.teamHomeMeanRuns = 6; rows[3].features.teamAwayMeanRuns = 3;
  rows[4].features.teamHomeMeanRuns = 6; rows[4].features.teamAwayMeanRuns = 3;
  rows[5].features.teamHomeMeanRuns = 3; rows[5].features.teamAwayMeanRuns = 6;
  return buildMlbStep12HistoricalFeatureTable({
    generatedAt: "2026-08-11T21:00:00.000Z",
    discoveryEndDate: "2025-07-31",
    holdoutStartDate: "2025-08-01",
    rows,
  });
}

test("pocket evaluator reports hit rate and volume separately in discovery and untouched holdout", () => {
  const result = evaluateMlbStep12PocketRule({
    table: table(),
    rule: {
      ruleKey: "home-team-mean-pocket",
      horizon: "FULL_GAME",
      side: "HOME",
      atoms: [{ feature: "teamHomeMeanRuns", operator: "GTE", threshold: 5, thresholdSource: "DISCOVERY_ONLY" }],
    },
  });
  assert.equal(result.discovery.selectedRows, 2);
  assert.equal(result.discovery.hits, 2);
  assert.equal(result.discovery.decisiveHitRate, 1);
  assert.equal(result.holdout.selectedRows, 2);
  assert.equal(result.holdout.hits, 2);
  assert.equal(result.holdout.decisiveHitRate, 1);
  assert.equal(result.policy.hitRateBandIsDescriptiveNotPromotion, true);
  assert.equal(result.policy.pocketsBelow80RemainResearchEligible, true);
  assert.equal(result.policy.sampleAndFrequencyAlwaysReported, true);
});

test("rules may contain up to three interpretable atoms but not unrestricted complexity", () => {
  assert.throws(() => evaluateMlbStep12PocketRule({
    table: table(),
    rule: {
      ruleKey: "too-complex",
      horizon: "FULL_GAME",
      side: "HOME",
      atoms: [
        { feature: "teamHomeMeanRuns", operator: "GTE", threshold: 5, thresholdSource: "DISCOVERY_ONLY" },
        { feature: "teamAwayMeanRuns", operator: "LTE", threshold: 4, thresholdSource: "DISCOVERY_ONLY" },
        { feature: "homeStarterRiskFactor", operator: "LTE", threshold: 1, thresholdSource: "DISCOVERY_ONLY" },
        { feature: "awayStarterRiskFactor", operator: "GTE", threshold: 1, thresholdSource: "DISCOVERY_ONLY" },
      ],
    } as any,
  }), /MLB_STEP12_POCKET_RULE_COMPLEXITY_INVALID/);
});

test("holdout-derived thresholds are rejected before scoring", () => {
  assert.throws(() => evaluateMlbStep12PocketRule({
    table: table(),
    rule: {
      ruleKey: "leaky-threshold",
      horizon: "FULL_GAME",
      side: "HOME",
      atoms: [{ feature: "teamHomeMeanRuns", operator: "GTE", threshold: 5, thresholdSource: "HOLDOUT" as any }],
    },
  }), /MLB_STEP12_POCKET_THRESHOLD_SOURCE_INVALID/);
});

test("missing feature values never satisfy a pocket atom", () => {
  const t = table();
  const result = evaluateMlbStep12PocketRule({
    table: t,
    rule: {
      ruleKey: "missing-pitcher-does-not-pass",
      horizon: "FULL_GAME",
      side: "HOME",
      atoms: [{ feature: "pitcherEffectWeight", operator: "GTE", threshold: 1, thresholdSource: "DISCOVERY_ONLY" }],
    },
  });
  assert.equal(result.discovery.selectedRows, 0);
  assert.equal(result.holdout.selectedRows, 0);
  assert.equal(result.discovery.observedHitRateBand, "NO_DECISIVE_SAMPLE");
});
