import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNflScoreboard, normalizeNflTeams } from "./nfl-data-routes";
import { getNflEliteIntegrationStatus, NFL_R5H16_EVIDENCE } from "./nfl-elite-integration-gate";
import { predictFrozenLogit, type FrozenLogitSpec } from "./nfl-frozen-logit";
import { evaluateNflR5H8 } from "./nfl-r5h8-engine";
import { NFL_R5H8_RUNTIME_FEATURES, NflPregameMaterializer } from "./nfl-pregame-materializer";

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("NFL scoreboard adapter preserves home/away identity and kickoff", () => {
  const games = normalizeNflScoreboard({
    events: [{
      id: "401",
      date: "2026-09-10T00:20:00Z",
      name: "Away at Home",
      shortName: "AWY @ HOM",
      status: { type: { name: "STATUS_SCHEDULED", completed: false } },
      competitions: [{ competitors: [
        { homeAway: "home", team: { id: "1", displayName: "Home Team", abbreviation: "HOM" } },
        { homeAway: "away", team: { id: "2", displayName: "Away Team", abbreviation: "AWY" } },
      ] }],
    }],
  });
  assert.equal(games.length, 1);
  assert.equal(games[0].homeTeam.name, "Home Team");
  assert.equal(games[0].awayTeam.name, "Away Team");
  assert.equal(games[0].kickoff, "2026-09-10T00:20:00Z");
  assert.equal(games[0].completed, false);
});

test("NFL team directory adapter normalizes wrapped ESPN teams", () => {
  const teams = normalizeNflTeams({ sports: [{ leagues: [{ teams: [
    { team: { id: "1", displayName: "Alpha", abbreviation: "ALP", location: "A", name: "Alphas" } },
    { team: { id: "2", displayName: "Beta", abbreviation: "BET", location: "B", name: "Betas" } },
  ] }] }] });
  assert.deepEqual(teams.map((team) => team.name), ["Alpha", "Beta"]);
});

test("NFL frozen logit reproduces imputation, scaling, and positive-class sigmoid", () => {
  const spec: FrozenLogitSpec = {
    kind: "STANDARDIZED_LOGISTIC_REGRESSION",
    features: ["a", "b"],
    imputer: { strategy: "median", statistics: [2, 10] },
    scaler: { mean: [2, 8], scale: [2, 4] },
    logistic: { C: 1, classes: [0, 1], coef: [0.5, -0.25], intercept: 0.1 },
  };
  const actual = predictFrozenLogit(spec, { a: null, b: 12 });
  const expected = 1 / (1 + Math.exp(-(0.1 + 0 * 0.5 + 1 * -0.25)));
  assert.ok(Math.abs(actual - expected) < 1e-12);
});

test("NFL R5H8 scalar port selects unanimous frozen-rule support without using market prices", () => {
  const reliability = [
    { rule: "A", fit_accuracy: 0.7, fit_log_loss: 0.6, reliability: 0.2 },
    { rule: "B", fit_accuracy: 0.68, fit_log_loss: 0.61, reliability: 0.1 },
  ];
  const evaluation = evaluateNflR5H8(
    0.70,
    { A: 0.80, B: 0.60 },
    reliability,
    [],
    {
      top_k: 2,
      reliability_power: 1,
      conviction_power: 1,
      redundancy_lambda: 0.5,
      synergy_lambda: 0.5,
      agreement_floor: 0.55,
      diversity_power: 0,
      confidence_bins: 1,
      confidence_floor_quantile: 0.5,
      confidence_floor: 0,
      rule_selection_rate: 0.1,
      bin_edges: [null, null],
      rule_thresholds: { "0": 0.99 },
    },
  );
  assert.ok(Math.abs(evaluation.interactionScore - 1) < 1e-12);
  assert.equal(evaluation.agreement, 1);
  assert.equal(evaluation.coreSelected, true);
});

test("NFL pregame materializer snapshots before applying the same-game observation", () => {
  const materializer = new NflPregameMaterializer();
  const first = {
    gameId: "2025_01_A_B",
    season: 2025,
    week: 1,
    gameday: "2025-09-04",
    homeTeam: "B",
    awayTeam: "A",
    observation: {
      homeScore: 27,
      awayScore: 20,
      homeMetrics: { off_epa: 0.2, off_success: 0.5, pass_epa: 0.3, pass_success: 0.55, rush_epa: 0.1, rush_success: 0.45, sack_rate: 0.05, explosive_pass: 0.1, explosive_rush: 0.08, plays: 65, drives: 11 },
      awayMetrics: { off_epa: -0.1, off_success: 0.4, pass_epa: -0.05, pass_success: 0.42, rush_epa: -0.15, rush_success: 0.38, sack_rate: 0.08, explosive_pass: 0.06, explosive_rush: 0.05, plays: 62, drives: 10 },
      quarterbacks: [],
    },
  };
  const before = materializer.replayCompletedGame(first);
  assert.equal(before.features.home_points_for, null);
  assert.equal(before.features.away_points_for, null);
  assert.equal(before.processedCompletedGames, 0);
  assert.equal(materializer.getProcessedCompletedGames(), 1);

  const second = materializer.materializePregame({
    gameId: "2025_02_C_B",
    season: 2025,
    week: 2,
    gameday: "2025-09-11",
    homeTeam: "B",
    awayTeam: "C",
  });
  assert.equal(second.features.home_points_for, 27);
  assert.equal(second.provenance.sameGameObservationUsed, false);
  assert.equal(second.provenance.marketDataUsedAsFeature, false);
});

test("NFL R5H8 runtime feature contract is exactly 68 sports-only pregame fields", () => {
  assert.equal(NFL_R5H8_RUNTIME_FEATURES.length, 68);
  assert.equal(new Set(NFL_R5H8_RUNTIME_FEATURES).size, 68);
  for (const feature of NFL_R5H8_RUNTIME_FEATURES) {
    assert.doesNotMatch(feature, /moneyline|spread|total_line|odds|price|vig|book|over_under/i);
  }
});

test("NFL Elite gate fails closed by default and never turns historical accuracy into game probability", () => {
  withEnv({
    NFL_R5H18_PROSPECTIVE_GATE: undefined,
    NFL_ELITE_2026_ARTIFACT_VERIFIED: undefined,
    NFL_ELITE_MATERIALIZER_VERIFIED: undefined,
    NFL_ELITE_PARITY_GATE: undefined,
  }, () => {
    const status = getNflEliteIntegrationStatus();
    assert.equal(status.state, "BLOCKED");
    assert.equal(status.coreReady, false);
    assert.equal(status.lateDownEnabled, false);
    assert.equal(status.historicalAccuracyExposedAsGameProbability, false);
    assert.equal(status.marketDataUsedAsModelFeature, false);
    assert.equal(status.automaticBetPlacement, false);
    assert.equal(NFL_R5H16_EVIDENCE.combined.games, 204);
    assert.equal(NFL_R5H16_EVIDENCE.combined.wins, 165);
  });
});

test("NFL R5H8 core can become ready while late-down remains disabled", () => {
  withEnv({
    NFL_R5H18_PROSPECTIVE_GATE: "FAIL",
    NFL_ELITE_2026_ARTIFACT_VERIFIED: "true",
    NFL_ELITE_MATERIALIZER_VERIFIED: "true",
    NFL_ELITE_PARITY_GATE: "PASS",
  }, () => {
    const status = getNflEliteIntegrationStatus();
    assert.equal(status.state, "CORE_READY");
    assert.equal(status.coreReady, true);
    assert.equal(status.lateDownEnabled, false);
  });
});

test("NFL Elite gate becomes FULL_READY only when core custody and late-down deployability pass", () => {
  withEnv({
    NFL_R5H18_PROSPECTIVE_GATE: "PASS",
    NFL_ELITE_2026_ARTIFACT_VERIFIED: "true",
    NFL_ELITE_MATERIALIZER_VERIFIED: "true",
    NFL_ELITE_PARITY_GATE: "PASS",
  }, () => {
    const status = getNflEliteIntegrationStatus();
    assert.equal(status.state, "FULL_READY");
    assert.equal(status.coreReady, true);
    assert.equal(status.lateDownEnabled, true);
  });
});
