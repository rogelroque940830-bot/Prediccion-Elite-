import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_DAILY_OPPORTUNITY_LINEUP_P95_DELTA,
  buildMlbDailyOpportunityContext,
} from "./mlb-daily-opportunity-context-v1";

const date = "2026-08-26";

function slate(games: Array<{ gamePk: number; startTime: string; stage: "FINAL" | "PROVISIONAL" }>) {
  return {
    date,
    games: games.map((g) => ({
      gamePk: g.gamePk,
      officialDate: date,
      startTime: g.startTime,
      awayTeam: { id: g.gamePk * 10 + 1, name: `Away ${g.gamePk}` },
      homeTeam: { id: g.gamePk * 10 + 2, name: `Home ${g.gamePk}` },
      analysisStage: g.stage,
      analysisAllowed: true,
    })),
  } as any;
}

function profile(input: {
  gamePk: number;
  startTime: string;
  stage: "FINAL" | "PROVISIONAL";
  elite?: boolean;
  maxSignal?: number;
}) {
  const elite = input.elite ?? true;
  const thesis = {
    kind: "HOME_SIDE",
    structure: "TWO_SIDED_SEPARATION",
    supportingComponents: ["STATCAST_QUALITY", "DISCIPLINE_SPEED"],
    opposingComponents: [],
    supportingTargets: ["HOME_RUNS", "AWAY_RUNS"],
    signalCount: 4,
    maxAbsoluteNativeRunSignal: input.maxSignal ?? 0.31,
    marketSearchIntent: "SIDE",
    researchEliteEligible: elite,
  };
  return {
    gamePk: input.gamePk,
    officialDate: date,
    startTime: input.startTime,
    awayTeam: { id: input.gamePk * 10 + 1, name: `Away ${input.gamePk}` },
    homeTeam: { id: input.gamePk * 10 + 2, name: `Home ${input.gamePk}` },
    inputStage: input.stage,
    signals: [],
    projections: {
      fullGame: {
        theses: elite ? [thesis] : [],
        researchEliteCandidate: elite,
      },
      earlyWindow: {
        theses: [],
        researchEliteCandidate: false,
      },
    },
    researchEliteCandidate: elite,
    researchClassification: elite ? "GAME_ELITE_RESEARCH_CANDIDATE" : "NO_STRONG_THESIS",
    certificationStatus: "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED",
    maxAbsoluteNativeRunSignal: input.maxSignal ?? 0.31,
    warnings: [],
  } as any;
}

function intrinsic(profiles: any[]) {
  return {
    date,
    generatedAt: `${date}T14:00:00.000Z`,
    games: profiles,
    rankedGames: profiles,
  } as any;
}

function v16(gamePk: number, home: number) {
  return {
    gamePk,
    generatedAt: `${date}T14:00:00.000Z`,
    fullGame: {
      homeWinProbability: home,
      awayWinProbability: 1 - home,
      pushProbability: 0,
    },
    first5: {
      homeWinProbability: 0.45,
      awayWinProbability: 0.40,
      pushProbability: 0.15,
    },
  } as any;
}

test("later provisional context-rank #1 forces WAIT instead of taking earlier final game", () => {
  const games = [
    profile({ gamePk: 9, startTime: `${date}T01:00:00.000Z`, stage: "PROVISIONAL" }),
    profile({ gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" }),
  ];
  const result = buildMlbDailyOpportunityContext({
    slate: slate([
      { gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" },
      { gamePk: 9, startTime: `${date}T01:00:00.000Z`, stage: "PROVISIONAL" },
    ]),
    intrinsic: intrinsic(games),
    finalV16ByGame: { 1: v16(1, 0.72) },
    provisionalV16ByGame: { 9: v16(9, 0.81) },
  });
  assert.equal(result.action, "WAIT");
  assert.equal(result.primaryOpportunity?.gamePk, 9);
  assert.equal(result.primaryOpportunity?.inputStage, "PROVISIONAL");
});

test("empirical P95 lineup uncertainty is applied only to provisional V16", () => {
  const finalGame = profile({ gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" });
  const provisionalGame = profile({ gamePk: 2, startTime: `${date}T23:00:00.000Z`, stage: "PROVISIONAL" });
  const result = buildMlbDailyOpportunityContext({
    slate: slate([
      { gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" },
      { gamePk: 2, startTime: `${date}T23:00:00.000Z`, stage: "PROVISIONAL" },
    ]),
    intrinsic: intrinsic([finalGame, provisionalGame]),
    finalV16ByGame: { 1: v16(1, 0.72) },
    provisionalV16ByGame: { 2: v16(2, 0.81) },
  });
  const final = result.rankedOpportunities.find((g) => g.gamePk === 1)!;
  const provisional = result.rankedOpportunities.find((g) => g.gamePk === 2)!;
  assert.equal(final.probability.lineupUncertaintyP95, 0);
  assert.equal(final.probability.robustSelectedSideProbability, 0.72);
  assert.equal(provisional.probability.lineupUncertaintyP95, MLB_DAILY_OPPORTUNITY_LINEUP_P95_DELTA);
  assert.ok(Math.abs((provisional.probability.robustSelectedSideProbability ?? 0) - 0.7567) < 1e-12);
});

test("context-probability tradeoff keeps both games on frontier and WAITs", () => {
  const contextLeader = profile({ gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" });
  const probabilityLeader = profile({ gamePk: 2, startTime: `${date}T23:00:00.000Z`, stage: "PROVISIONAL" });
  const result = buildMlbDailyOpportunityContext({
    slate: slate([
      { gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" },
      { gamePk: 2, startTime: `${date}T23:00:00.000Z`, stage: "PROVISIONAL" },
    ]),
    intrinsic: intrinsic([contextLeader, probabilityLeader]),
    finalV16ByGame: { 1: v16(1, 0.72) },
    provisionalV16ByGame: { 2: v16(2, 0.82) },
  });
  assert.deepEqual(result.nonDominatedFrontier.map((g) => g.gamePk), [1, 2]);
  assert.equal(result.action, "WAIT");
  assert.equal(result.decisionReason, "PROVISIONAL_OPPORTUNITY_REMAINS_NON_DOMINATED");
});

test("final context leader that also dominates robust probability becomes PLAY_NOW_CANDIDATE", () => {
  const finalLeader = profile({ gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" });
  const later = profile({ gamePk: 2, startTime: `${date}T23:00:00.000Z`, stage: "PROVISIONAL" });
  const result = buildMlbDailyOpportunityContext({
    slate: slate([
      { gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" },
      { gamePk: 2, startTime: `${date}T23:00:00.000Z`, stage: "PROVISIONAL" },
    ]),
    intrinsic: intrinsic([finalLeader, later]),
    finalV16ByGame: { 1: v16(1, 0.79) },
    provisionalV16ByGame: { 2: v16(2, 0.80) },
  });
  assert.deepEqual(result.nonDominatedFrontier.map((g) => g.gamePk), [1]);
  assert.equal(result.action, "PLAY_NOW_CANDIDATE");
  assert.equal(result.primaryOpportunity?.gamePk, 1);
});

test("confirmation can naturally collapse the slate to NO_PLAY without forcing a selection", () => {
  const notElite = profile({ gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL", elite: false });
  const result = buildMlbDailyOpportunityContext({
    slate: slate([{ gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" }]),
    intrinsic: intrinsic([notElite]),
    finalV16ByGame: { 1: v16(1, 0.84) },
  });
  assert.equal(result.action, "NO_PLAY");
  assert.equal(result.primaryOpportunity, null);
  assert.equal(result.summary.eligibleSportingOpportunities, 0);
});

test("start time and FINAL/PROVISIONAL stage never rewrite the existing intrinsic context rank", () => {
  const lateProvisional = profile({ gamePk: 9, startTime: `${date}T23:59:00.000Z`, stage: "PROVISIONAL" });
  const earlyFinal = profile({ gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" });
  const result = buildMlbDailyOpportunityContext({
    slate: slate([
      { gamePk: 1, startTime: `${date}T17:00:00.000Z`, stage: "FINAL" },
      { gamePk: 9, startTime: `${date}T23:59:00.000Z`, stage: "PROVISIONAL" },
    ]),
    intrinsic: intrinsic([lateProvisional, earlyFinal]),
  });
  assert.equal(result.rankedOpportunities[0].gamePk, 1);
  assert.equal(result.rankedOpportunities[0].contextRank, 1);
  assert.equal(result.rankedOpportunities[1].gamePk, 9);
  assert.equal(result.rankedOpportunities[1].contextRank, 2);
  assert.equal(result.policy.finalInputStatusAffectsContextRank, false);
  assert.equal(result.policy.gameStartTimeAffectsContextRank, false);
});

test("whole qualified slate competes even when market discovery rankedGames kept only top eight", () => {
  const profiles = Array.from({ length: 10 }, (_, index) => profile({
    gamePk: index + 1,
    startTime: `${date}T${String(12 + index).padStart(2, "0")}:00:00.000Z`,
    stage: index === 9 ? "PROVISIONAL" : "FINAL",
    maxSignal: index === 9 ? 0.99 : 0.20 + index / 100,
  }));
  const fakeIntrinsic = {
    ...intrinsic(profiles),
    rankedGames: profiles.slice(0, 8),
  };
  const fakeSlate = slate(profiles.map((game) => ({
    gamePk: game.gamePk,
    startTime: game.startTime,
    stage: game.inputStage,
  })));
  const result = buildMlbDailyOpportunityContext({
    slate: fakeSlate,
    intrinsic: fakeIntrinsic,
    provisionalV16ByGame: { 10: v16(10, 0.80) },
  });

  assert.equal(result.summary.intrinsicEvaluatedGames, 10);
  assert.equal(result.rankedOpportunities.some((game) => game.gamePk === 10), true);
  assert.equal(result.rankedOpportunities[0].gamePk, 10);
  assert.equal(result.action, "WAIT");
  assert.equal(result.policy.wholeQualifiedIntrinsicPopulationRanked, true);
  assert.equal(result.policy.marketDiscoveryCapMayHideDailyOpportunity, false);
});
