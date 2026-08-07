import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerPrediction } from "./mlb-ledger-store";
import { gradeMlbPrediction, type OfficialMlbGame } from "./mlb-settlement-worker";

const officialGame: OfficialMlbGame = {
  gamePk: 888001,
  gameDate: "2026-07-30",
  final: true,
  homeTeam: "Home Club",
  awayTeam: "Away Club",
  homeScore: 5,
  awayScore: 3,
  innings: [
    { num: 1, home: 0, away: 0 },
    { num: 2, home: 1, away: 0 },
    { num: 3, home: 0, away: 2 },
    { num: 4, home: 1, away: 0 },
    { num: 5, home: 0, away: 0 },
    { num: 6, home: 2, away: 1 },
    { num: 7, home: 1, away: 0 },
    { num: 8, home: 0, away: 0 },
    { num: 9, home: 0, away: 0 },
  ],
};

function prediction(
  type: string,
  selection: string,
  line: number | null = null,
  gameOverrides: Partial<LedgerPrediction["game"]> = {},
): LedgerPrediction {
  return {
    id: `pred-${type}-${selection}`,
    clientRequestId: null,
    recordedAt: "2026-07-30T18:00:00.000Z",
    recordedAtMs: Date.parse("2026-07-30T18:00:00.000Z"),
    game: {
      gamePk: officialGame.gamePk,
      gameDate: officialGame.gameDate,
      commenceTime: "2026-07-30T23:00:00.000Z",
      homeTeam: officialGame.homeTeam,
      awayTeam: officialGame.awayTeam,
      ...gameOverrides,
    },
    market: {
      type,
      selection,
      line,
      oddsAmerican: -110,
      book: "Hard Rock",
    },
    probabilities: {
      model: 0.6,
      marketImplied: 0.5238,
      noVig: null,
      edgePp: 7.62,
    },
    decision: {
      signal: "BET",
      confidenceLabel: "LOW",
      confidencePct: 60,
      stakeUnits: 1,
    },
    analysisStage: "FINAL",
    model: {
      name: "CourtEdge MLB",
      version: "test",
      gitCommit: "test",
      environment: "test",
    },
    supersedesId: null,
    source: "app",
    payloadSha256: "a".repeat(64),
    payload: {},
  } as LedgerPrediction;
}

test("grades full-game ML and run line from official score", () => {
  assert.equal(gradeMlbPrediction(prediction("ML", "Home Club ML"), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("ML", "Away Club ML"), officialGame)?.result, "LOSS");
  assert.equal(gradeMlbPrediction(prediction("RUN_LINE", "Home Club -1.5", -1.5), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("RUN_LINE", "Away Club +1.5", 1.5), officialGame)?.result, "LOSS");
  assert.equal(gradeMlbPrediction(prediction("RUN_LINE", "Away Club +2", 2), officialGame)?.result, "PUSH");
});

test("official MLB orientation overrides reversed legacy history fields", () => {
  const reversedLegacy = prediction(
    "ML",
    "Away Club ML",
    null,
    {
      homeTeam: "Away Club",
      awayTeam: "Home Club",
    },
  );
  assert.equal(gradeMlbPrediction(reversedLegacy, officialGame)?.result, "LOSS");
});

test("grades F5 markets independently from full-game result", () => {
  assert.equal(gradeMlbPrediction(prediction("F5_ML", "Home Club F5 ML"), officialGame)?.result, "PUSH");
  assert.equal(gradeMlbPrediction(prediction("F5_TOTAL", "Under 4.5 F5", 4.5), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("TT_OVER_15_F5", "Away Club F5 Over 1.5"), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("TT_UNDER_25_F5", "Home Club F5 Under 2.5"), officialGame)?.result, "WIN");
});

test("grades canonical F3/F5 period markets independently", () => {
  assert.equal(gradeMlbPrediction(prediction("F3_ML", "Away Club F3 ML"), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("F3_ML", "Home Club F3 ML"), officialGame)?.result, "LOSS");
  assert.equal(gradeMlbPrediction(prediction("F3_RUN_LINE", "Away Club -0.5 F3", -0.5), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("F3_RUN_LINE", "Home Club +1 F3", 1), officialGame)?.result, "PUSH");
  assert.equal(gradeMlbPrediction(prediction("F5_RUN_LINE", "Home Club +0.5 F5", 0.5), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("F5_RUN_LINE", "Home Club -0.5 F5", -0.5), officialGame)?.result, "LOSS");
  assert.equal(gradeMlbPrediction(prediction("F3_TOTAL", "Over 2.5 F3", 2.5), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("F3_TOTAL", "Under 3 F3", 3), officialGame)?.result, "PUSH");
  assert.equal(gradeMlbPrediction(prediction("F3_TEAM_TOTAL", "Away Club F3 Over 1.5", 1.5), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("F5_TEAM_TOTAL", "Home Club F5 Over 1.5", 1.5), officialGame)?.result, "WIN");

  const f3Tie = {
    ...officialGame,
    innings: officialGame.innings.map((inning) =>
      inning.num <= 3 ? { ...inning, home: 0, away: 0 } : inning,
    ),
  };
  assert.equal(gradeMlbPrediction(prediction("F3_ML", "Home Club F3 ML"), f3Tie)?.result, "PUSH");
});

test("grades totals and first-inning run markets", () => {
  assert.equal(gradeMlbPrediction(prediction("TOTAL", "Under 8.5", 8.5), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("TOTAL", "Over 8", 8), officialGame)?.result, "PUSH");
  assert.equal(gradeMlbPrediction(prediction("NRFI", "NRFI"), officialGame)?.result, "WIN");
  assert.equal(gradeMlbPrediction(prediction("YRFI", "YRFI"), officialGame)?.result, "LOSS");
  assert.equal(gradeMlbPrediction(prediction("INNING_1_ML", "Home Club inning 1 ML"), officialGame)?.result, "PUSH");
});

test("does not grade unsupported or incomplete markets", () => {
  assert.equal(gradeMlbPrediction(prediction("OTHER", "Unknown market"), officialGame), null);
  const incomplete = { ...officialGame, innings: officialGame.innings.slice(0, 4) };
  assert.equal(gradeMlbPrediction(prediction("F5_TOTAL", "Over 3.5 F5", 3.5), incomplete), null);
  const incompleteF3 = { ...officialGame, innings: officialGame.innings.slice(0, 2) };
  assert.equal(gradeMlbPrediction(prediction("F3_ML", "Home Club F3 ML"), incompleteF3), null);
  assert.equal(gradeMlbPrediction(prediction("F3_RUN_LINE", "Home Club -0.5 F3", -0.5), incompleteF3), null);
  assert.equal(gradeMlbPrediction(prediction("F3_TOTAL", "Over 2.5 F3", 2.5), incompleteF3), null);
});
