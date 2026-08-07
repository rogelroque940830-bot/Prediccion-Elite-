import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMlbHistoricalDataset,
  deriveMlbHistoricalHorizonObservation,
  digestMlbHistoricalObservations,
  type MlbHistoricalOfficialGame,
} from "./mlb-market-historical-dataset";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function game(overrides: Partial<MlbHistoricalOfficialGame> = {}): MlbHistoricalOfficialGame {
  return {
    gamePk: 1001,
    officialDate: "2025-06-01",
    season: 2025,
    gameType: "R",
    finalState: "Final",
    homeTeamId: 10,
    homeTeam: "Home Club",
    awayTeamId: 20,
    awayTeam: "Away Club",
    homeFinalRuns: 6,
    awayFinalRuns: 4,
    innings: [
      { num: 1, awayRuns: 0, homeRuns: 1 },
      { num: 2, awayRuns: 1, homeRuns: 0 },
      { num: 3, awayRuns: 0, homeRuns: 2 },
      { num: 4, awayRuns: 1, homeRuns: 0 },
      { num: 5, awayRuns: 0, homeRuns: 1 },
      { num: 6, awayRuns: 2, homeRuns: 2 },
    ],
    sourceVersion: "fixture.v1",
    sourceDigest: DIGEST_A,
    ...overrides,
  };
}

test("derives independent F1, F3, F5 and full-game official outcomes", () => {
  const source = game();
  const first = deriveMlbHistoricalHorizonObservation(source, "FIRST_INNING");
  const f3 = deriveMlbHistoricalHorizonObservation(source, "FIRST_3");
  const f5 = deriveMlbHistoricalHorizonObservation(source, "FIRST_5");
  const full = deriveMlbHistoricalHorizonObservation(source, "FULL_GAME");

  assert.deepEqual({ home: first?.homeRuns, away: first?.awayRuns, nrfi: first?.nrfi }, { home: 1, away: 0, nrfi: false });
  assert.deepEqual({ home: f3?.homeRuns, away: f3?.awayRuns }, { home: 3, away: 1 });
  assert.deepEqual({ home: f5?.homeRuns, away: f5?.awayRuns }, { home: 4, away: 2 });
  assert.deepEqual({ home: full?.homeRuns, away: full?.awayRuns }, { home: 6, away: 4 });
  assert.equal(full?.nrfi, null);
});

test("does not invent an unplayed half inning for F5", () => {
  const called = game({
    gamePk: 1002,
    sourceDigest: DIGEST_B,
    innings: [
      { num: 1, awayRuns: 0, homeRuns: 0 },
      { num: 2, awayRuns: 0, homeRuns: 1 },
      { num: 3, awayRuns: 0, homeRuns: 0 },
      { num: 4, awayRuns: 0, homeRuns: 0 },
      { num: 5, awayRuns: 0, homeRuns: null },
    ],
    homeFinalRuns: 1,
    awayFinalRuns: 0,
  });
  assert.equal(deriveMlbHistoricalHorizonObservation(called, "FIRST_5"), null);
  assert.equal(deriveMlbHistoricalHorizonObservation(called, "FULL_GAME")?.homeRuns, 1);
});

test("dataset excludes non-regular games and counts incomplete horizons", () => {
  const regular = game();
  const incomplete = game({
    gamePk: 1002,
    officialDate: "2025-06-02",
    sourceDigest: DIGEST_B,
    innings: [{ num: 1, awayRuns: 0, homeRuns: 0 }],
    homeFinalRuns: 2,
    awayFinalRuns: 1,
  });
  const postseason = game({ gamePk: 1003, officialDate: "2025-10-01", gameType: "P", sourceDigest: "c".repeat(64) });
  const report = buildMlbHistoricalDataset([postseason, incomplete, regular], { generatedAt: "2026-08-07T00:00:00.000Z" });

  assert.equal(report.regularSeasonFinalGames, 2);
  assert.equal(report.observationsByHorizon.FIRST_INNING, 2);
  assert.equal(report.observationsByHorizon.FIRST_3, 1);
  assert.equal(report.observationsByHorizon.FIRST_5, 1);
  assert.equal(report.observationsByHorizon.FULL_GAME, 2);
  assert.equal(report.exclusionCounts.NON_REGULAR_SEASON_GAME, 1);
  assert.equal(report.exclusionCounts.INCOMPLETE_FIRST_3, 1);
  assert.equal(report.exclusionCounts.INCOMPLETE_FIRST_5, 1);
  assert.equal(report.actionabilityAllowed, false);
});

test("dataset digest is deterministic under input order", () => {
  const left = buildMlbHistoricalDataset([game(), game({ gamePk: 1002, officialDate: "2025-06-02", sourceDigest: DIGEST_B })]);
  const right = buildMlbHistoricalDataset([game({ gamePk: 1002, officialDate: "2025-06-02", sourceDigest: DIGEST_B }), game()]);
  assert.equal(left.datasetDigest, right.datasetDigest);
  assert.equal(left.datasetDigest, digestMlbHistoricalObservations(left.observations));
  assert.match(left.datasetDigest, /^[a-f0-9]{64}$/);
});

test("malformed official provenance and score data fail closed", () => {
  assert.throws(() => buildMlbHistoricalDataset([game({ sourceDigest: "bad" })]), /P1_M6A3B1_SOURCE_PROVENANCE_REQUIRED/);
  assert.throws(() => buildMlbHistoricalDataset([game({ homeFinalRuns: -1 })]), /P1_M6A3B1_INVALID_FINAL_SCORE/);
  assert.throws(() => buildMlbHistoricalDataset([game({ innings: [{ num: 1, awayRuns: 0, homeRuns: 0 }, { num: 1, awayRuns: 0, homeRuns: 0 }] })]), /P1_M6A3B1_INVALID_INNING_SEQUENCE/);
});
