import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbEarlyWholeSlateCandidates,
  earlyEngineSnapshotSha256,
  MLB_EARLY_CANDIDATE_SCHEMA,
  MLB_EARLY_WHOLE_SLATE_SCHEMA,
} from "./mlb-early-whole-slate-candidates";

function pitcher(id: number | null, hand: "R" | "L" | null = "R") {
  return { id, name: id ? `Pitcher ${id}` : null, hand, confirmed: Boolean(id) };
}

function game(input: {
  gamePk: number;
  homeId: number | null;
  awayId: number | null;
  homePitcherId: number | null;
  awayPitcherId: number | null;
  analysisAllowed?: boolean;
  readiness?: string;
  blockers?: string[];
}) {
  const allowed = input.analysisAllowed ?? true;
  return {
    gamePk: input.gamePk,
    startTime: `2026-09-04T${String(17 + (input.gamePk % 4)).padStart(2, "0")}:10:00.000Z`,
    officialDate: "2026-09-04",
    venue: `Park ${input.gamePk}`,
    state: allowed ? "SCHEDULED" : "IN_PROGRESS",
    detailedState: allowed ? "Scheduled" : "In Progress",
    homeTeam: { id: input.homeId, name: `Home ${input.gamePk}` },
    awayTeam: { id: input.awayId, name: `Away ${input.gamePk}` },
    homePitcher: pitcher(input.homePitcherId, "R"),
    awayPitcher: pitcher(input.awayPitcherId, "L"),
    lineupState: allowed ? "CONFIRMED" : "UNKNOWN",
    homeLineupCount: allowed ? 9 : 0,
    awayLineupCount: allowed ? 9 : 0,
    readiness: input.readiness ?? (allowed ? "READY_TO_ANALYZE" : "GAME_ALREADY_STARTED"),
    analysisStage: allowed ? "FINAL" : "BLOCKED",
    analysisAllowed: allowed,
    blockers: input.blockers ?? (allowed ? [] : ["El juego ya comenzó."]),
    source: { name: "MLB_STATS_API", fetchedAt: "2026-09-04T16:00:00.000Z", quality: "AUTHORITATIVE" },
  } as any;
}

function slate() {
  const games = [
    game({ gamePk: 910001, homeId: 101, awayId: 201, homePitcherId: 1001, awayPitcherId: 2001 }),
    game({ gamePk: 910002, homeId: 102, awayId: 202, homePitcherId: 1002, awayPitcherId: 2002 }),
    game({ gamePk: 910003, homeId: 103, awayId: 203, homePitcherId: 1003, awayPitcherId: 2003, analysisAllowed: false }),
    game({ gamePk: 910004, homeId: 104, awayId: 204, homePitcherId: 1004, awayPitcherId: 2004 }),
  ];
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-09-04",
    generatedAt: "2026-09-04T16:00:00.000Z",
    games,
    summary: { total: 4, ready: 3, provisional: 0, waitingForPitchers: 0, startedOrClosed: 1, dataInsufficient: 0 },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  } as any;
}

function earlyOutput(homeId: number, dataIncomplete = false) {
  const finalRecommendation = dataIncomplete
    ? { market: "PASS", side: "PASS", action: "PASS", reason: "Datos early incompletos" }
    : { market: "F5_ML", side: "HOME", action: "BET", reason: "Canonical F5 edge", isPremium: true };
  return {
    schemaVersion: "mlb-early-engine-service.v1",
    analysisDate: "2026-09-04",
    homeEre: { ereScore: 72, category: "ELITE_EARLY", dataStatus: dataIncomplete ? "PARTIAL" : "VERIFIED", warnings: [] },
    awayEre: { ereScore: 49, category: "NEUTRAL", dataStatus: dataIncomplete ? "PARTIAL" : "VERIFIED", warnings: [] },
    markets: {
      f5ProbHome: 0.68,
      f5ProbAway: 0.32,
      f5RecommendedSide: dataIncomplete ? "PASS" : "HOME",
      f5TotalRunsEstimated: 4.4,
      probAnyRun1stInn: 0.42,
      probNoRun1stInn: 0.58,
      nrfiYrfiRec: dataIncomplete ? "PASS" : "NRFI",
      inning1: { homeProb: 0.61, awayProb: 0.39, side: dataIncomplete ? "PASS" : "HOME" },
      inning2: { homeProb: 0.57, awayProb: 0.43, side: dataIncomplete ? "PASS" : "HOME" },
      inning3: { homeProb: 0.58, awayProb: 0.42, side: dataIncomplete ? "PASS" : "HOME" },
      teamTotalOver15F5: { homeProb: 0.8, awayProb: 0.62, side: dataIncomplete ? "PASS" : "HOME" },
      teamTotalUnder25F5: { homeProb: 0.2, awayProb: 0.75, side: dataIncomplete ? "PASS" : "AWAY" },
      confidence: dataIncomplete ? "LOW" : "MEDIUM",
      warnings: dataIncomplete ? ["PARTIAL_DATA"] : [],
      dataIncomplete,
      finalRecommendation,
      alternativePicks: dataIncomplete ? [] : [{
        market: "TT_UNDER_25_F5",
        side: "AWAY",
        prob: 0.75,
        reason: "Canonical alternate",
        isPremium: true,
      }],
    },
    f5Unified: { f5ProbHome: 0.68, f5ProbAway: 0.32, pickSide: "HOME", confidence: "HIGH" },
    matchupSignal: { dataConfidence: "FULL" },
    matchupDisabled: false,
    uncertainty: null,
    fixtureHomeId: homeId,
  } as any;
}

test("whole-slate producer preserves every official game and emits only canonical Early BET candidates", async () => {
  const requests: any[] = [];
  const result = await buildMlbEarlyWholeSlateCandidates({
    date: "2026-09-04",
    now: new Date("2026-09-04T16:05:00.000Z"),
    concurrency: 2,
    slateProvider: async () => slate(),
    engineProvider: async (request) => {
      requests.push(request);
      if (request.home.teamId === 104) throw new Error("fixture engine failure");
      return earlyOutput(request.home.teamId, request.home.teamId === 102);
    },
  });

  assert.equal(result.schemaVersion, MLB_EARLY_WHOLE_SLATE_SCHEMA);
  assert.deepEqual(result.games.map((row) => row.gamePk), [910001, 910002, 910003, 910004]);
  assert.deepEqual(result.games.map((row) => row.status), ["CANDIDATES_READY", "DATA_INCOMPLETE", "BLOCKED", "ERROR"]);
  assert.equal(result.summary.totalGames, 4);
  assert.equal(result.summary.candidateGames, 1);
  assert.equal(result.summary.dataIncompleteGames, 1);
  assert.equal(result.summary.blockedGames, 1);
  assert.equal(result.summary.errorGames, 1);
  assert.equal(result.summary.sportingCandidates, 2);
  assert.equal(result.summary.globallyRankEligibleCandidates, 0);

  const candidateGame = result.games[0];
  assert.equal(candidateGame.candidates.length, 2);
  assert.equal(candidateGame.candidates[0].schemaVersion, MLB_EARLY_CANDIDATE_SCHEMA);
  assert.equal(candidateGame.candidates[0].marketType, "F5_ML");
  assert.equal(candidateGame.candidates[0].side, "HOME");
  assert.equal(candidateGame.candidates[0].modelProbability, 0.68);
  assert.equal(candidateGame.candidates[0].authority, "FINAL_RECOMMENDATION");
  assert.equal(candidateGame.candidates[0].globalRankEligible, false);
  assert.equal(candidateGame.candidates[0].price.status, "UNPRICED");
  assert.equal(candidateGame.candidates[1].marketType, "TT_UNDER_25_F5");
  assert.equal(candidateGame.candidates[1].authority, "ALTERNATIVE_PICK");
  assert.equal(candidateGame.candidates[1].line, 2.5);

  // NRFI and inning 2/3 remain visible as evaluated markets but are not silently
  // promoted to BET candidates because current canonical Early authority excludes them.
  assert.equal((candidateGame.evaluatedMarkets as any).nrfiYrfi.recommendedSide, "NRFI");
  assert.equal((candidateGame.evaluatedMarkets as any).nrfiYrfi.currentAuthority, "EVALUATED_NON_CORE_NOT_FINAL_RECOMMENDATION");
  assert.equal(result.candidates.some((row) => (row as any).marketType === "NRFI"), false);

  assert.equal(result.games[1].candidates.length, 0);
  assert.equal(result.games[2].candidates.length, 0);
  assert.equal(result.games[2].earlyEngine, null);
  assert.match(result.games[3].blockers[0], /fixture engine failure/i);
  assert.equal(result.boundary.fullGameAuthorityChanged, false);
  assert.equal(result.boundary.crossEngineRankingAttached, false);
});

test("whole-slate producer maps each lineup against the correct opposing pitcher with no cross-game identity leak", async () => {
  const requests: any[] = [];
  await buildMlbEarlyWholeSlateCandidates({
    date: "2026-09-04",
    slateProvider: async () => ({ ...slate(), games: slate().games.slice(0, 2) }),
    engineProvider: async (request) => {
      requests.push(request);
      return earlyOutput(request.home.teamId, false);
    },
  });

  assert.equal(requests.length, 2);
  const byHome = new Map(requests.map((request) => [request.home.teamId, request]));
  assert.equal(byHome.get(101).home.gamePk, 910001);
  assert.equal(byHome.get(101).home.opposingPitcherId, 2001);
  assert.equal(byHome.get(101).away.opposingPitcherId, 1001);
  assert.equal(byHome.get(102).home.gamePk, 910002);
  assert.equal(byHome.get(102).home.opposingPitcherId, 2002);
  assert.equal(byHome.get(102).away.opposingPitcherId, 1002);
  assert.notEqual(byHome.get(101).home.opposingPitcherId, byHome.get(102).home.opposingPitcherId);
});

test("same canonical Early snapshot produces the same digest and candidate identity", async () => {
  const output = earlyOutput(101, false);
  const firstDigest = earlyEngineSnapshotSha256(output);
  const reordered = JSON.parse(JSON.stringify(output));
  reordered.homeEre = { category: output.homeEre.category, warnings: [], dataStatus: output.homeEre.dataStatus, ereScore: output.homeEre.ereScore };
  assert.equal(earlyEngineSnapshotSha256(reordered), firstDigest);

  const build = () => buildMlbEarlyWholeSlateCandidates({
    date: "2026-09-04",
    now: new Date("2026-09-04T16:05:00.000Z"),
    slateProvider: async () => ({ ...slate(), games: [slate().games[0]] }),
    engineProvider: async () => output,
  });
  const first = await build();
  const second = await build();
  assert.equal(first.games[0].engineSnapshotSha256, second.games[0].engineSnapshotSha256);
  assert.equal(first.candidates[0].candidateId, second.candidates[0].candidateId);
});
