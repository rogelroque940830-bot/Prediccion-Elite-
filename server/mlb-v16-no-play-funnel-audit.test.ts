import assert from "node:assert/strict";
import test from "node:test";
import type { MlbUnifiedPricedV16RunnerResult } from "./mlb-unified-priced-v16-runner";
import {
  auditMlbV16NoPlayFunnel,
  MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA,
} from "./mlb-v16-no-play-funnel-audit";

function evidence(gamePk: number, home = 0.62) {
  return {
    gamePk,
    generatedAt: "2026-08-15T22:00:00.000Z",
    modelVersion: "fixture",
    manifestSha256: "fixture",
    priceIndependent: true,
    fullGame: { homeWinProbability: home, awayWinProbability: 1 - home, pushProbability: 0 },
    first5: { homeWinProbability: 0.55, awayWinProbability: 0.35, pushProbability: 0.10 },
  };
}

function discoveryGame(input: {
  gamePk: number;
  inputStage: "FINAL" | "PROVISIONAL";
  planned?: string[];
  paid?: boolean;
}) {
  const planned = input.planned ?? [];
  return {
    gamePk: input.gamePk,
    inputStage: input.inputStage,
    intrinsicRank: 1,
    plannedMarkets: planned.map((canonicalMarketType) => ({ canonicalMarketType })),
    paidLookupEligibleNow: input.paid ?? false,
    paidLookupHoldReason: input.paid
      ? null
      : planned.length === 0
        ? "NO_STRONG_INTRINSIC_MARKET_THESIS"
        : "OFFICIAL_FINAL_INPUTS_REQUIRED",
  };
}

function resultFixture(input: {
  discoveryGames: ReturnType<typeof discoveryGame>[];
  settlementEvidence?: ReturnType<typeof evidence>[];
  marketEdgeMarkets?: any[];
  envelopeMarkets?: any[];
  finalGames?: number;
  provisionalGames?: number;
  eliteRows?: number;
}): MlbUnifiedPricedV16RunnerResult {
  const marketEdgeMarkets = input.marketEdgeMarkets ?? [];
  const envelopeMarkets = input.envelopeMarkets ?? [];
  const positiveEvMarkets = marketEdgeMarkets.filter((m) => m.classification === "POSITIVE_EV").length;
  const noPositiveEvMarkets = marketEdgeMarkets.filter((m) => m.classification === "NO_POSITIVE_EV").length;
  const blockedOrUnavailableMarkets = marketEdgeMarkets.length - positiveEvMarkets - noPositiveEvMarkets;
  const eliteEvidenceCandidates = envelopeMarkets.filter((m) => m.classification === "ELITE_EVIDENCE_CANDIDATE").length;
  const positiveEvEnvelopeBlocked = envelopeMarkets.filter((m) => m.classification === "POSITIVE_EV_ENVELOPE_BLOCKED").length;
  const finalGames = input.finalGames ?? input.discoveryGames.filter((g) => g.inputStage === "FINAL").length;
  const provisionalGames = input.provisionalGames ?? input.discoveryGames.filter((g) => g.inputStage === "PROVISIONAL").length;

  return {
    generatedAt: "2026-08-15T22:00:00.000Z",
    runId: "audit-fixture",
    date: "2026-08-15",
    preprice: {
      summary: {
        slateGames: finalGames + provisionalGames + 2,
        analysisEligibleGames: finalGames + provisionalGames,
        finalAnalysisEligibleGames: finalGames,
        provisionalAnalysisEligibleGames: provisionalGames,
      },
      discovery: {
        games: input.discoveryGames,
        summary: {
          gamesPaidLookupEligibleNow: input.discoveryGames.filter((g) => g.paidLookupEligibleNow).length,
          gamesHeldForFinalInputs: input.discoveryGames.filter((g) => g.paidLookupHoldReason === "OFFICIAL_FINAL_INPUTS_REQUIRED").length,
          gamesWithNoStrongIntrinsicMarketThesis: input.discoveryGames.filter((g) => g.paidLookupHoldReason === "NO_STRONG_INTRINSIC_MARKET_THESIS").length,
        },
      },
    },
    settlementEvidence: input.settlementEvidence ?? [],
    marketEdge: {
      games: marketEdgeMarkets.length > 0 ? [{ gamePk: 100, markets: marketEdgeMarkets }] : [],
      summary: { positiveEvMarkets, noPositiveEvMarkets, blockedOrUnavailableMarkets },
    },
    operatingEnvelope: {
      games: envelopeMarkets.length > 0 ? [{ gamePk: 100, markets: envelopeMarkets }] : [],
      summary: { positiveEvEnvelopeBlocked, eliteEvidenceCandidates },
    },
    eliteEvidenceLedger: { summary: { capturedCandidates: input.eliteRows ?? 0 } },
    summary: {
      finalGamesScoredByV16: (input.settlementEvidence ?? []).length,
      paidLookupEligibleGames: input.discoveryGames.filter((g) => g.paidLookupEligibleNow).length,
      positiveEvMarkets,
      eliteEvidenceCandidates,
      eliteEvidenceRowsCaptured: input.eliteRows ?? 0,
    },
  } as unknown as MlbUnifiedPricedV16RunnerResult;
}

test("V16 audit distinguishes a scored FINAL game suppressed by the intrinsic-thesis gate", () => {
  const result = resultFixture({
    finalGames: 1,
    provisionalGames: 11,
    discoveryGames: [
      discoveryGame({ gamePk: 100, inputStage: "FINAL" }),
      discoveryGame({ gamePk: 101, inputStage: "PROVISIONAL", planned: ["ML"] }),
    ],
    settlementEvidence: [evidence(100, 0.62)],
  });

  const audit = auditMlbV16NoPlayFunnel(result);
  assert.equal(MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA, "courtedge-p0-v16-no-play-funnel-audit.v2");
  assert.equal(audit.primaryBlocker, "NO_STRONG_INTRINSIC_THESIS_ON_FINAL_GAMES");
  assert.equal(audit.counts.v16ScoredGames, 1);
  assert.equal(audit.counts.finalGamesWithIntrinsicThesis, 0);
  assert.equal(audit.counts.finalGamesWithoutStrongIntrinsicThesis, 1);
  assert.equal(audit.counts.provisionalGamesWithIntrinsicThesis, 1);
  assert.equal(audit.discoveryHoldReasons.heldForFinalInputs, 1);
  assert.equal(audit.gameAudits[0].sportsPrediction.scoredByV16, true);
  assert.equal(audit.gameAudits[0].sportsPrediction.fullGameHomeWinProbability, 0.62);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NO_STRONG_INTRINSIC_MARKET_THESIS");
  assert.equal(audit.policy.predictionRemainsPriceIndependent, true);
  assert.equal(audit.policy.changesThresholds, false);
});

test("V16 audit attributes a priced thesis with non-positive economics to NO_POSITIVE_EV", () => {
  const result = resultFixture({
    discoveryGames: [discoveryGame({ gamePk: 100, inputStage: "FINAL", planned: ["ML"], paid: true })],
    settlementEvidence: [evidence(100)],
    marketEdgeMarkets: [{ classification: "NO_POSITIVE_EV", execution: { bookKey: "fixture" } }],
    envelopeMarkets: [{ classification: "NO_POSITIVE_EV" }],
  });

  const audit = auditMlbV16NoPlayFunnel(result);
  assert.equal(audit.primaryBlocker, "NO_POSITIVE_EV");
  assert.equal(audit.counts.pricedThesisMarkets, 1);
  assert.equal(audit.counts.noPositiveEvMarkets, 1);
  assert.equal(audit.marketClassificationCounts.NO_POSITIVE_EV, 1);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NO_POSITIVE_EV");
});

test("V16 audit exposes a positive-EV market blocked only by the operating envelope", () => {
  const result = resultFixture({
    discoveryGames: [discoveryGame({ gamePk: 100, inputStage: "FINAL", planned: ["ML"], paid: true })],
    settlementEvidence: [evidence(100)],
    marketEdgeMarkets: [{ classification: "POSITIVE_EV", execution: { bookKey: "fixture" } }],
    envelopeMarkets: [{ classification: "POSITIVE_EV_ENVELOPE_BLOCKED" }],
  });

  const audit = auditMlbV16NoPlayFunnel(result);
  assert.equal(audit.primaryBlocker, "POSITIVE_EV_ENVELOPE_BLOCKED");
  assert.equal(audit.counts.positiveEvMarkets, 1);
  assert.equal(audit.counts.positiveEvEnvelopeBlocked, 1);
  assert.equal(audit.gameAudits[0].earliestBlocker, "POSITIVE_EV_ENVELOPE_BLOCKED");
});

test("V16 audit reports NONE once an Elite evidence row exists", () => {
  const result = resultFixture({
    discoveryGames: [discoveryGame({ gamePk: 100, inputStage: "FINAL", planned: ["ML"], paid: true })],
    settlementEvidence: [evidence(100)],
    marketEdgeMarkets: [{ classification: "POSITIVE_EV", execution: { bookKey: "fixture" } }],
    envelopeMarkets: [{ classification: "ELITE_EVIDENCE_CANDIDATE" }],
    eliteRows: 1,
  });

  const audit = auditMlbV16NoPlayFunnel(result);
  assert.equal(audit.primaryBlocker, "NONE");
  assert.equal(audit.counts.eliteEvidenceRowsCaptured, 1);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NONE");
});
