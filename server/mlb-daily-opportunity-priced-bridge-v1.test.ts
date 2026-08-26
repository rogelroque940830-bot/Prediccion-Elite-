import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbDailyOpportunityPriceDiscovery,
  runMlbDailyOpportunityPricedBridge,
} from "./mlb-daily-opportunity-priced-bridge-v1";

const generatedAt = "2026-08-26T15:00:00.000Z";
const officialDate = "2026-08-26";

function shortlistEntry(gamePk: number, inputStage: "FINAL" | "PROVISIONAL", contextRank: number) {
  return {
    gamePk,
    officialDate,
    startTime: `2026-08-26T${String(13 + Math.min(gamePk, 9)).padStart(2, "0")}:00:00.000Z`,
    awayTeam: `Away ${gamePk}`,
    homeTeam: `Home ${gamePk}`,
    inputStage,
    contextRank,
    selectedSide: "HOME",
    selectedSideProbability: 0.7,
    robustSelectedSideProbability: inputStage === "FINAL" ? 0.7 : 0.6467,
    priceTiming: inputStage === "FINAL"
      ? "READY_IF_PRICE_LAYER_INVOKED"
      : "DEFER_UNTIL_FINAL_INPUTS",
    selectionBasis: ["BEST_CONTEXT"],
  } as const;
}

function projection() {
  return {
    scope: "FULL_GAME",
    includedHorizons: ["CROSS_HORIZON"],
    signals: [],
    pressures: {},
    theses: [{
      kind: "HOME_SIDE",
      structure: "MULTI_SOURCE_SINGLE_AXIS",
      supportingComponents: ["BULLPEN"],
      opposingComponents: [],
      supportingTargets: ["HOME_RUNS"],
      signalCount: 1,
      maxAbsoluteNativeRunSignal: 0.5,
      marketSearchIntent: "SIDE",
      researchEliteEligible: true,
    }],
    marketSearchIntents: ["SIDE"],
    marketSearchEvidence: { side: ["BULLPEN"], total: [] },
    researchEliteCandidate: true,
    researchClassification: "GAME_ELITE_RESEARCH_CANDIDATE",
    maxAbsoluteNativeRunSignal: 0.5,
  };
}

function intrinsicGame(gamePk: number) {
  return {
    gamePk,
    officialDate,
    startTime: `2026-08-27T0${gamePk % 9}:00:00.000Z`,
    homeTeam: { id: 1000 + gamePk, name: `Home ${gamePk}` },
    awayTeam: { id: 2000 + gamePk, name: `Away ${gamePk}` },
    inputStage: "FINAL",
    signals: [],
    projections: {
      fullGame: { ...projection(), scope: "FULL_GAME" },
      earlyWindow: { ...projection(), scope: "EARLY_WINDOW" },
    },
    researchEliteCandidate: true,
    researchClassification: "GAME_ELITE_RESEARCH_CANDIDATE",
    certificationStatus: "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED",
    maxAbsoluteNativeRunSignal: 0.5,
    warnings: [],
  };
}

function fakeLive(entries: readonly any[], games: readonly any[] = []) {
  return {
    generatedAt,
    preprice: {
      runId: "whole-slate-run",
      intrinsic: {
        schemaVersion: "courtedge-p0-mlb-intrinsic-edge.v3",
        generatedAt,
        date: officialDate,
        sourceShortlistSchemaVersion: "courtedge-p0-mlb-shortlist.v1",
        games,
        rankedGames: games.slice(0, 8),
        summary: {
          qualifiedInputCandidates: games.length,
          evaluated: games.length,
          selectedForMarketDiscovery: Math.min(8, games.length),
          overflowAfterIntrinsicRanking: Math.max(0, games.length - 8),
          researchEliteCandidates: games.length,
          provisionalResearchEliteCandidates: 0,
          finalInputResearchEliteCandidates: games.length,
          fullGameResearchEliteCandidates: games.length,
          earlyWindowResearchEliteCandidates: games.length,
          intrinsicWatch: 0,
          conflicted: 0,
          noStrongThesis: 0,
        },
        policy: {},
        safety: {},
      },
    },
    dailyOpportunity: {
      summary: { intrinsicEvaluatedGames: games.length || 15 },
    },
    priceConsultationShortlist: {
      entries,
      summary: {
        wholeSlateSportingOpportunitiesEvaluated: games.length || 15,
        nonDominatedFrontierSize: entries.length,
        shortlistedForPossiblePriceConsultation: entries.length,
        readyFinalCandidates: entries.filter((entry: any) => entry.inputStage === "FINAL").length,
        deferredProvisionalCandidates: entries.filter((entry: any) => entry.inputStage === "PROVISIONAL").length,
      },
    },
  } as any;
}

const runtime = {
  providerAccountScopeKey: "test-scope",
  apiKey: "test-key",
  maxRunCredits: 20,
  reserveCredits: 0,
};

test("a provisional shortlist candidate forces WAIT before any odds-provider call", async () => {
  let acquireCalls = 0;
  const live = fakeLive([
    shortlistEntry(2, "FINAL", 1),
    shortlistEntry(15, "PROVISIONAL", 2),
  ]);

  const result = await runMlbDailyOpportunityPricedBridge({
    assembled: {} as any,
    live,
    runtime,
    dependencies: {
      oddsService: {
        acquire: async () => {
          acquireCalls += 1;
          throw new Error("ODDS_PROVIDER_MUST_NOT_RUN_WHILE_PROVISIONAL_FRONTIER_REMAINS");
        },
      } as any,
    },
  });

  assert.equal(result.decision.action, "WAIT");
  assert.equal(result.decision.reason, "PROVISIONAL_FRONTIER_REMAINS");
  assert.equal(result.summary.gamesExposedToOddsService, 0);
  assert.equal(result.summary.paidEventOddsCalls, 0);
  assert.equal(acquireCalls, 0);
});

test("more than three possible price consultations fails before provider access", async () => {
  let acquireCalls = 0;
  const live = fakeLive([
    shortlistEntry(1, "FINAL", 1),
    shortlistEntry(2, "FINAL", 2),
    shortlistEntry(3, "FINAL", 3),
    shortlistEntry(4, "FINAL", 4),
  ]);

  await assert.rejects(
    runMlbDailyOpportunityPricedBridge({
      assembled: {} as any,
      live,
      runtime,
      dependencies: {
        oddsService: {
          acquire: async () => {
            acquireCalls += 1;
            throw new Error("ODDS_PROVIDER_MUST_NOT_RUN_AFTER_CAP_VIOLATION");
          },
        } as any,
      },
    }),
    /MLB_DAILY_OPPORTUNITY_PRICE_SHORTLIST_CAP_EXCEEDED:4/,
  );
  assert.equal(acquireCalls, 0);
});

test("a ninth-or-later whole-slate game survives the old top-8 boundary when shortlisted", () => {
  const games = Array.from({ length: 15 }, (_, index) => intrinsicGame(index + 1));
  const live = fakeLive([
    shortlistEntry(9, "FINAL", 1),
    shortlistEntry(15, "FINAL", 2),
  ], games);

  const discovery = buildMlbDailyOpportunityPriceDiscovery({ live });

  assert.deepEqual(discovery.games.map((game) => game.gamePk), [9, 15]);
  assert.equal(discovery.games.length, 2);
  assert.ok(discovery.games.every((game) => game.inputStage === "FINAL"));
  assert.ok(discovery.games.every((game) => game.paidLookupEligibleNow));
  assert.ok(discovery.games.every((game) =>
    game.plannedMarkets.every((market) => market.canonicalMarketType === "ML" || market.canonicalMarketType === "F5_ML"),
  ));
  assert.ok(discovery.games.every((game) =>
    game.providerMarketKeysToRequestNow.length === game.plannedMarkets.length,
  ));
});

test("unresolved economic evidence forces WAIT even when another market is elite, and freshness uses post-acquisition time", async () => {
  const game = intrinsicGame(9);
  const live = fakeLive([shortlistEntry(9, "FINAL", 1)], [game]);
  let evaluationNow: Date | null = null;
  const postAcquisitionNow = new Date("2026-08-26T15:05:00.000Z");

  const result = await runMlbDailyOpportunityPricedBridge({
    assembled: {
      c4ByGame: {
        9: {
          builderVersion: "mlb-c4-live-canonical-v1",
          priceIndependent: true,
          sameDateHistoryAllowed: false,
          seasonResetHistory: true,
          featureVector: {
            lineup_exposure_rate_adv: 0,
            starter_kbb_adv: 0,
            combined_team_rs10: 8.5,
            team_rd10_diff: 0,
          },
        },
      },
    } as any,
    live,
    runtime,
    dependencies: {
      oddsService: {
        acquire: async () => ({
          status: "COMPLETED",
          providerCalls: { zeroCostEventsProbe: 1, paidEventOdds: 1, eventMarkets: 0, sportOdds: 0 },
        }) as any,
      } as any,
      now: () => postAcquisitionNow,
      evaluateMarketEdges: ((input: any) => {
        evaluationNow = input.now;
        return { schemaVersion: "test-market-edge", safety: {}, games: [], summary: {} } as any;
      }) as any,
      buildOperatingEnvelope: (() => ({
        schemaVersion: "test-envelope",
        summary: { eliteEvidenceCandidates: 1 },
        safety: {},
        games: [{
          gamePk: 9,
          homeTeam: { name: "Home 9" },
          awayTeam: { name: "Away 9" },
          markets: [
            {
              marketType: "ML",
              selectedSide: "HOME",
              selectedLine: null,
              classification: "ELITE_EVIDENCE_CANDIDATE",
              eliteEvidenceCandidate: true,
              modelWinProbability: 0.72,
              expectedValuePerUnit: 0.09,
            },
            {
              marketType: "F5_ML",
              selectedSide: null,
              selectedLine: null,
              classification: "UPSTREAM_BLOCKED",
              eliteEvidenceCandidate: false,
              modelWinProbability: null,
              expectedValuePerUnit: null,
            },
          ],
        }],
      })) as any,
    },
  });

  assert.equal(evaluationNow?.toISOString(), postAcquisitionNow.toISOString());
  assert.equal(result.decision.action, "WAIT");
  assert.equal(result.decision.reason, "UNRESOLVED_ECONOMIC_EVIDENCE");
  assert.equal(result.decision.recommendation, null);
});
