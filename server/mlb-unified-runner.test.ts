import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { runMlbUnifiedPrepriceStep11c } from "./mlb-unified-runner";
import { MLB_FROZEN_RESEARCH_ROUTE_IDS } from "./mlb-frozen-research-route-ledger";
import type { MlbP1DailySlate, MlbP1SlateGame } from "./mlb-p1-daily-slate";

const NOW = new Date("2026-08-13T14:00:00.000Z");

function game(input: {
  gamePk: number;
  startTime: string;
  readiness: MlbP1SlateGame["readiness"];
  lineupState: MlbP1SlateGame["lineupState"];
  final: boolean;
}): MlbP1SlateGame {
  return {
    gamePk: input.gamePk,
    startTime: input.startTime,
    officialDate: "2026-08-13",
    venue: "Test Park",
    state: "SCHEDULED",
    detailedState: "Scheduled",
    homeTeam: { id: input.gamePk + 1, name: `Home ${input.gamePk}` },
    awayTeam: { id: input.gamePk + 2, name: `Away ${input.gamePk}` },
    homePitcher: { id: input.gamePk + 101, name: "Home SP", hand: "R", confirmed: true },
    awayPitcher: { id: input.gamePk + 102, name: "Away SP", hand: "L", confirmed: true },
    lineupState: input.lineupState,
    homeLineupCount: input.final ? 9 : 0,
    awayLineupCount: input.final ? 9 : 0,
    readiness: input.readiness,
    analysisStage: input.final ? "FINAL" : input.readiness === "PROVISIONAL_WAITING_FOR_LINEUPS" ? "PROVISIONAL" : "BLOCKED",
    analysisAllowed: input.readiness === "READY_TO_ANALYZE" || input.readiness === "PROVISIONAL_WAITING_FOR_LINEUPS",
    blockers: input.final ? [] : ["Los lineups oficiales todavía no están publicados."],
    source: {
      name: "MLB_STATS_API",
      fetchedAt: "2026-08-13T13:59:00.000Z",
      quality: "AUTHORITATIVE",
    },
  };
}

function slate(): MlbP1DailySlate {
  const games = [
    game({ gamePk: 1001, startTime: "2026-08-13T17:00:00.000Z", readiness: "READY_TO_ANALYZE", lineupState: "CONFIRMED", final: true }),
    game({ gamePk: 1002, startTime: "2026-08-14T01:00:00.000Z", readiness: "PROVISIONAL_WAITING_FOR_LINEUPS", lineupState: "NOT_POSTED", final: false }),
    game({ gamePk: 1003, startTime: "2026-08-13T18:00:00.000Z", readiness: "WAITING_FOR_PITCHERS", lineupState: "NOT_POSTED", final: false }),
  ];
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: "2026-08-13",
    generatedAt: "2026-08-13T13:59:00.000Z",
    games,
    summary: { total: 3, ready: 1, provisional: 1, waitingForPitchers: 1, startedOrClosed: 0, dataInsufficient: 0 },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function finalAssessment(gamePk = 1001) {
  const routes = Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTE_IDS.map((id, index) => [id, index < 2 ? "MATCH" : "NO_MATCH"]));
  return {
    gamePk,
    gameDate: "2026-08-13",
    scheduledStartTime: "2026-08-13T17:00:00.000Z",
    evaluatedAt: "2026-08-13T13:58:30.000Z",
    finalInputs: true,
    featureSnapshotDigest: createHash("sha256").update(`final-${gamePk}`).digest("hex"),
    scorerVersion: "frozen-route-scorer.v1",
    routes,
  } as any;
}

test("runner preserves final plus provisional games in Step11C companion ledger", () => {
  const result = runMlbUnifiedPrepriceStep11c({
    runId: "run-2026-08-13-a",
    slate: slate(),
    shortlistEvidenceByGame: {},
    finalRouteAssessmentsByGame: { 1001: finalAssessment() },
    now: NOW,
  });

  assert.equal(result.summary.slateGames, 3);
  assert.equal(result.summary.analysisEligibleGames, 2);
  assert.equal(result.summary.finalAnalysisEligibleGames, 1);
  assert.equal(result.summary.provisionalAnalysisEligibleGames, 1);
  assert.equal(result.frozenRouteLedger.entries.length, 2);
  assert.equal(result.frozenRouteLedger.summary.captureRetentionPct, 100);

  const final = result.frozenRouteLedger.entries.find((row) => row.gamePk === 1001)!;
  assert.equal(final.finalInputs, true);
  assert.equal(final.routes.PREMIUM_A_HOME_ML, "MATCH");
  assert.equal(final.routes.A_PLUS_HOME_ML, "MATCH");

  const provisional = result.frozenRouteLedger.entries.find((row) => row.gamePk === 1002)!;
  assert.equal(provisional.finalInputs, false);
  for (const routeId of MLB_FROZEN_RESEARCH_ROUTE_IDS) assert.equal(provisional.routes[routeId], "NOT_EVALUATED");
  assert.equal(result.policy.provisionalGamesPreserved, true);
  assert.equal(result.policy.priceBoundaryCrossed, false);
  assert.equal(result.policy.callsTheOddsApi, false);
});

test("missing final frozen-route assessment fails closed instead of silently dropping the game", () => {
  assert.throws(() => runMlbUnifiedPrepriceStep11c({
    runId: "run-missing-final",
    slate: slate(),
    shortlistEvidenceByGame: {},
    finalRouteAssessmentsByGame: {},
    now: NOW,
  }), /MLB_UNIFIED_RUNNER_FINAL_ROUTE_ASSESSMENT_REQUIRED:1001/);
});

test("provisional caller-supplied route assessment is forbidden", () => {
  const provisional = {
    ...finalAssessment(1002),
    scheduledStartTime: "2026-08-14T01:00:00.000Z",
    finalInputs: false,
  };
  assert.throws(() => runMlbUnifiedPrepriceStep11c({
    runId: "run-forged-provisional",
    slate: slate(),
    shortlistEvidenceByGame: {},
    finalRouteAssessmentsByGame: { 1001: finalAssessment(), 1002: provisional as any },
    now: NOW,
  }), /MLB_UNIFIED_RUNNER_PROVISIONAL_ROUTE_ASSESSMENT_FORBIDDEN:1002/);
});

test("final route identity and temporal custody are exact", () => {
  const wrongIdentity = finalAssessment();
  wrongIdentity.gameDate = "2026-08-12";
  assert.throws(() => runMlbUnifiedPrepriceStep11c({
    runId: "run-wrong-identity",
    slate: slate(),
    shortlistEvidenceByGame: {},
    finalRouteAssessmentsByGame: { 1001: wrongIdentity },
    now: NOW,
  }), /MLB_UNIFIED_RUNNER_FINAL_ROUTE_IDENTITY_MISMATCH:1001/);

  const futureAssessment = finalAssessment();
  futureAssessment.evaluatedAt = "2026-08-13T14:00:01.000Z";
  assert.throws(() => runMlbUnifiedPrepriceStep11c({
    runId: "run-future-assessment",
    slate: slate(),
    shortlistEvidenceByGame: {},
    finalRouteAssessmentsByGame: { 1001: futureAssessment },
    now: NOW,
  }), /MLB_UNIFIED_RUNNER_FINAL_ROUTE_EVALUATED_AFTER_CAPTURE:1001/);
});

test("deferred games are not fabricated into prospective route observations", () => {
  const result = runMlbUnifiedPrepriceStep11c({
    runId: "run-deferred",
    slate: slate(),
    shortlistEvidenceByGame: {},
    finalRouteAssessmentsByGame: { 1001: finalAssessment() },
    now: NOW,
  });
  assert.equal(result.frozenRouteLedger.entries.some((row) => row.gamePk === 1003), false);
  assert.equal(result.cheapScreen.games.find((row) => row.gamePk === 1003)?.disposition, "DEFER");
});

test("runner ranks no game merely because it starts earlier and crosses no paid boundary", () => {
  const evidence = {
    1001: {
      disciplineSpeed: { sourceStatus: "CERTIFIED", provenance: { status: "CERTIFIED" }, homeRunsDelta: 0.4, awayRunsDelta: -0.4 },
      statcastQuality: { sourceStatus: "CERTIFIED", provenance: { status: "CERTIFIED" }, homeSP: { runsDelta: -0.2 }, awaySP: { runsDelta: 0.2 } },
    },
    1002: {
      disciplineSpeed: { sourceStatus: "CERTIFIED", provenance: { status: "CERTIFIED" }, homeRunsDelta: 0.8, awayRunsDelta: -0.8 },
      statcastQuality: { sourceStatus: "CERTIFIED", provenance: { status: "CERTIFIED" }, homeSP: { runsDelta: -0.6 }, awaySP: { runsDelta: 0.6 } },
    },
  };
  const result = runMlbUnifiedPrepriceStep11c({
    runId: "run-rank-stage-neutral",
    slate: slate(),
    shortlistEvidenceByGame: evidence,
    finalRouteAssessmentsByGame: { 1001: finalAssessment() },
    now: NOW,
  });
  assert.equal(result.intrinsic.rankedGames[0].gamePk, 1002);
  assert.equal(result.intrinsic.rankedGames[0].inputStage, "PROVISIONAL");
  assert.equal(result.discovery.games.find((row) => row.gamePk === 1002)?.paidLookupEligibleNow, false);
  assert.equal(result.policy.intrinsicRankIndependentOfGameStartTime, true);
  assert.equal(result.policy.theOddsApiCreditsConsumed, 0);
});
