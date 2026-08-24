import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNflScoreboard, normalizeNflTeams } from "./nfl-data-routes";
import { getNflEliteIntegrationStatus, NFL_R5H16_EVIDENCE } from "./nfl-elite-integration-gate";

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

test("NFL Elite gate fails closed by default and never turns historical accuracy into game probability", () => {
  withEnv({
    NFL_R5H18_PROSPECTIVE_GATE: undefined,
    NFL_ELITE_2026_ARTIFACT_VERIFIED: undefined,
    NFL_ELITE_MATERIALIZER_VERIFIED: undefined,
    NFL_ELITE_PARITY_GATE: undefined,
  }, () => {
    const status = getNflEliteIntegrationStatus();
    assert.equal(status.state, "BLOCKED");
    assert.equal(status.historicalAccuracyExposedAsGameProbability, false);
    assert.equal(status.marketDataUsedAsModelFeature, false);
    assert.equal(status.automaticBetPlacement, false);
    assert.equal(NFL_R5H16_EVIDENCE.combined.games, 204);
    assert.equal(NFL_R5H16_EVIDENCE.combined.wins, 165);
  });
});

test("NFL Elite gate becomes READY only when every explicit custody gate passes", () => {
  withEnv({
    NFL_R5H18_PROSPECTIVE_GATE: "PASS",
    NFL_ELITE_2026_ARTIFACT_VERIFIED: "true",
    NFL_ELITE_MATERIALIZER_VERIFIED: "true",
    NFL_ELITE_PARITY_GATE: "PASS",
  }, () => {
    const status = getNflEliteIntegrationStatus();
    assert.equal(status.state, "READY");
    assert.equal(status.reasons.length, 1);
  });
});
