import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  MLB_FROZEN_RESEARCH_ROUTE_IDS,
  MLB_FROZEN_RESEARCH_ROUTER_IDS,
} from "./mlb-frozen-research-route-ledger";
import type { MlbP1DailySlate, MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { runMlbUnifiedPrepriceStep11c } from "./mlb-unified-runner";
import { selectMlbDailyBestPickFromUnifiedPreprice } from "./mlb-daily-best-pick-runtime-adapter";

const DATE = "2026-08-13";
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
    officialDate: DATE,
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
    analysisStage: input.final ? "FINAL" : "PROVISIONAL",
    analysisAllowed: true,
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
    game({
      gamePk: 1001,
      startTime: "2026-08-13T17:00:00.000Z",
      readiness: "READY_TO_ANALYZE",
      lineupState: "CONFIRMED",
      final: true,
    }),
    game({
      gamePk: 1002,
      startTime: "2026-08-14T01:00:00.000Z",
      readiness: "PROVISIONAL_WAITING_FOR_LINEUPS",
      lineupState: "NOT_POSTED",
      final: false,
    }),
  ];
  return {
    schemaVersion: "courtedge-p1-mlb-daily-slate.v1",
    date: DATE,
    generatedAt: "2026-08-13T13:59:00.000Z",
    games,
    summary: {
      total: 2,
      ready: 1,
      provisional: 1,
      waitingForPitchers: 0,
      startedOrClosed: 0,
      dataInsufficient: 0,
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function finalAssessment() {
  const routes = Object.fromEntries(
    MLB_FROZEN_RESEARCH_ROUTE_IDS.map((id, index) => [id, index < 2 ? "MATCH" : "NO_MATCH"]),
  );
  const routers = Object.fromEntries(
    MLB_FROZEN_RESEARCH_ROUTER_IDS.map((id) => [id, "FIRST_5_HOME"]),
  );
  return {
    gamePk: 1001,
    gameDate: DATE,
    scheduledStartTime: "2026-08-13T17:00:00.000Z",
    evaluatedAt: "2026-08-13T13:58:30.000Z",
    finalInputs: true,
    featureSnapshotDigest: createHash("sha256").update("daily-best-pick-final-1001").digest("hex"),
    scorerVersion: "frozen-route-router-scorer.v2",
    routes,
    routers,
  } as any;
}

test("real Step11c runtime feeds Daily BEST PICK only FINAL frozen READY routes", () => {
  const evidence = {
    1001: {
      disciplineSpeed: {
        sourceStatus: "CERTIFIED",
        provenance: { status: "CERTIFIED" },
        homeRunsDelta: 0.4,
        awayRunsDelta: -0.4,
      },
      statcastQuality: {
        sourceStatus: "CERTIFIED",
        provenance: { status: "CERTIFIED" },
        homeSP: { runsDelta: -0.2 },
        awaySP: { runsDelta: 0.2 },
      },
    },
    1002: {
      disciplineSpeed: {
        sourceStatus: "CERTIFIED",
        provenance: { status: "CERTIFIED" },
        homeRunsDelta: 0.8,
        awayRunsDelta: -0.8,
      },
      statcastQuality: {
        sourceStatus: "CERTIFIED",
        provenance: { status: "CERTIFIED" },
        homeSP: { runsDelta: -0.6 },
        awaySP: { runsDelta: 0.6 },
      },
    },
  };

  const runtime = runMlbUnifiedPrepriceStep11c({
    runId: "run-daily-best-pick-integration",
    slate: slate(),
    shortlistEvidenceByGame: evidence,
    finalRouteAssessmentsByGame: { 1001: finalAssessment() },
    now: NOW,
  });

  // Existing Step11c rank remains untouched: provisional 1002 is intrinsically first.
  assert.equal(runtime.intrinsic.rankedGames[0]?.gamePk, 1002);
  assert.equal(runtime.intrinsic.rankedGames[0]?.inputStage, "PROVISIONAL");

  const daily = selectMlbDailyBestPickFromUnifiedPreprice({ runtime });

  // Provisional 1002 cannot manufacture a route. Final frozen A+ 1001 becomes the one pick.
  assert.equal(daily.audit.provisionalRowsSkipped, 1);
  assert.equal(daily.evaluations.length, 1);
  assert.equal(daily.evaluations[0]?.gamePk, 1001);
  assert.equal(daily.evaluations[0]?.evaluationState, "READY");
  assert.equal(daily.evaluations[0]?.prepriceRank, 1);
  assert.equal(daily.selection.decision, "BEST_PICK");
  assert.equal(daily.selection.pick?.gamePk, 1001);
  assert.equal(daily.selection.pick?.tier, "A_PLUS");
  assert.equal(daily.selection.pick?.market, "FIRST_5_ML");

  assert.equal(daily.policy.existingPrepricePopulationPreserved, true);
  assert.equal(daily.policy.existingPrepriceRankPreservedWithinTier, true);
  assert.equal(daily.policy.generalV68FallbackAllowed, false);
  assert.equal(daily.policy.v80Read, false);
  assert.equal(daily.policy.v80Changed, false);
  assert.equal(daily.policy.priceBoundaryCrossed, false);
  assert.equal(daily.policy.realFinancialExposure, 0);
});
