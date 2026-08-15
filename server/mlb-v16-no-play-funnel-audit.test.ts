import assert from "node:assert/strict";
import test from "node:test";
import type { MlbUnifiedPricedV16RunnerResult } from "./mlb-unified-priced-v16-runner";
import {
  auditMlbV16NoPlayFunnel,
  MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA,
} from "./mlb-v16-no-play-funnel-audit";

type Stage = "NO_SHORTLIST" | "DISCOVERY_CAP" | "NO_THESIS" | "NO_PRICE" | "NO_EV" | "ENVELOPE" | "ELITE";

function evidence(gamePk = 100, home = 0.62) {
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

function resultFixture(stage: Stage): MlbUnifiedPricedV16RunnerResult {
  const qualified = stage !== "NO_SHORTLIST";
  const selectedForDiscovery = qualified && stage !== "DISCOVERY_CAP";
  const hasThesis = selectedForDiscovery && stage !== "NO_THESIS";
  const hasPrice = hasThesis && stage !== "NO_PRICE";
  const positiveEv = stage === "ENVELOPE" || stage === "ELITE";
  const elite = stage === "ELITE";

  const shortlistCandidate = {
    gamePk: 100,
    qualifiedForShortlist: qualified,
    certifiedComponentCount: qualified ? 2 : 0,
    independentSignalCount: qualified ? 2 : 0,
  };
  const intrinsicGame = qualified
    ? { gamePk: 100, researchClassification: hasThesis ? "GAME_ELITE_RESEARCH_CANDIDATE" : "NO_STRONG_THESIS" }
    : null;
  const discoveryGame = selectedForDiscovery
    ? {
        gamePk: 100,
        inputStage: "FINAL",
        intrinsicRank: 1,
        plannedMarkets: hasThesis ? [{ canonicalMarketType: "ML" }] : [],
        paidLookupEligibleNow: hasThesis,
        paidLookupHoldReason: hasThesis ? null : "NO_STRONG_INTRINSIC_MARKET_THESIS",
      }
    : null;

  const marketClassification = positiveEv ? "POSITIVE_EV" : "NO_POSITIVE_EV";
  const marketEdgeMarkets = hasPrice
    ? [{ classification: marketClassification, execution: { bookKey: "fixture" } }]
    : [];
  const envelopeClassification = elite
    ? "ELITE_EVIDENCE_CANDIDATE"
    : stage === "ENVELOPE"
      ? "POSITIVE_EV_ENVELOPE_BLOCKED"
      : hasPrice
        ? "NO_POSITIVE_EV"
        : null;
  const envelopeMarkets = envelopeClassification ? [{ classification: envelopeClassification }] : [];
  const noPositiveEvMarkets = marketEdgeMarkets.filter((row) => row.classification === "NO_POSITIVE_EV").length;
  const positiveEvMarkets = marketEdgeMarkets.filter((row) => row.classification === "POSITIVE_EV").length;

  return {
    generatedAt: "2026-08-15T22:00:00.000Z",
    runId: `audit-${stage}`,
    date: "2026-08-15",
    preprice: {
      summary: {
        slateGames: 14,
        analysisEligibleGames: 12,
        finalAnalysisEligibleGames: 1,
        provisionalAnalysisEligibleGames: 11,
      },
      cheapScreen: {
        games: [{ gamePk: 100, eligibleForDeepPrefilterNow: true, finalInputsAvailable: true }],
      },
      shortlist: {
        candidates: [shortlistCandidate],
        selected: qualified ? [shortlistCandidate] : [],
      },
      intrinsic: {
        games: intrinsicGame ? [intrinsicGame] : [],
        rankedGames: selectedForDiscovery && intrinsicGame ? [intrinsicGame] : [],
      },
      discovery: {
        games: discoveryGame ? [discoveryGame] : [],
        summary: {
          gamesPaidLookupEligibleNow: hasThesis ? 1 : 0,
        },
      },
    },
    settlementEvidence: [evidence()],
    marketEdge: {
      games: marketEdgeMarkets.length > 0 ? [{ gamePk: 100, markets: marketEdgeMarkets }] : [],
      summary: {
        positiveEvMarkets,
        noPositiveEvMarkets,
        blockedOrUnavailableMarkets: 0,
      },
    },
    operatingEnvelope: {
      games: envelopeMarkets.length > 0 ? [{ gamePk: 100, markets: envelopeMarkets }] : [],
      summary: {
        positiveEvEnvelopeBlocked: stage === "ENVELOPE" ? 1 : 0,
        eliteEvidenceCandidates: elite ? 1 : 0,
      },
    },
    eliteEvidenceLedger: { summary: { capturedCandidates: elite ? 1 : 0 } },
    summary: {
      finalGamesScoredByV16: 1,
      paidLookupEligibleGames: hasThesis ? 1 : 0,
      positiveEvMarkets,
      eliteEvidenceCandidates: elite ? 1 : 0,
      eliteEvidenceRowsCaptured: elite ? 1 : 0,
    },
  } as unknown as MlbUnifiedPricedV16RunnerResult;
}

test("audit exposes a V16-scored FINAL game blocked before intrinsic evaluation by shortlist qualification", () => {
  const audit = auditMlbV16NoPlayFunnel(resultFixture("NO_SHORTLIST"));
  assert.equal(MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA, "courtedge-p0-v16-no-play-funnel-audit.v3");
  assert.equal(audit.primaryBlocker, "NO_SHORTLIST_SIGNAL_QUALIFICATION");
  assert.equal(audit.counts.v16ScoredGames, 1);
  assert.equal(audit.counts.v16ScoredWithoutShortlistQualification, 1);
  assert.equal(audit.gameAudits[0].sportsPrediction.fullGameHomeWinProbability, 0.62);
  assert.equal(audit.gameAudits[0].prePriceRouting.shortlistQualified, false);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NO_SHORTLIST_SIGNAL_QUALIFICATION");
  assert.equal(audit.policy.predictionRemainsPriceIndependent, true);
});

test("audit exposes a V16-scored game excluded by the intrinsic top-eight discovery cap", () => {
  const audit = auditMlbV16NoPlayFunnel(resultFixture("DISCOVERY_CAP"));
  assert.equal(audit.primaryBlocker, "EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP");
  assert.equal(audit.counts.v16ScoredExcludedByIntrinsicDiscoveryCap, 1);
  assert.equal(audit.gameAudits[0].prePriceRouting.intrinsicEvaluated, true);
  assert.equal(audit.gameAudits[0].prePriceRouting.selectedForMarketDiscovery, false);
  assert.equal(audit.gameAudits[0].earliestBlocker, "EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP");
});

test("audit distinguishes V16 scoring from an upstream no-strong-thesis suppression", () => {
  const audit = auditMlbV16NoPlayFunnel(resultFixture("NO_THESIS"));
  assert.equal(audit.primaryBlocker, "NO_STRONG_INTRINSIC_THESIS_ON_V16_SCORED_GAMES");
  assert.equal(audit.counts.v16ScoredSelectedForMarketDiscovery, 1);
  assert.equal(audit.counts.v16ScoredWithoutStrongIntrinsicThesis, 1);
  assert.equal(audit.counts.v16ScoredWithIntrinsicThesis, 0);
  assert.equal(audit.gameAudits[0].sportsPrediction.scoredByV16, true);
  assert.equal(audit.gameAudits[0].prePriceRouting.plannedMarkets.length, 0);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NO_STRONG_INTRINSIC_MARKET_THESIS");
});

test("audit separates a strong sports thesis from missing executable price", () => {
  const audit = auditMlbV16NoPlayFunnel(resultFixture("NO_PRICE"));
  assert.equal(audit.primaryBlocker, "NO_FRESH_EXECUTABLE_PRICE");
  assert.equal(audit.counts.v16ScoredWithIntrinsicThesis, 1);
  assert.equal(audit.counts.paidLookupEligibleGames, 1);
  assert.equal(audit.counts.pricedThesisMarkets, 0);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NO_FRESH_EXECUTABLE_PRICE");
});

test("audit attributes a priced thesis with non-positive economics to NO_POSITIVE_EV", () => {
  const audit = auditMlbV16NoPlayFunnel(resultFixture("NO_EV"));
  assert.equal(audit.primaryBlocker, "NO_POSITIVE_EV");
  assert.equal(audit.counts.pricedThesisMarkets, 1);
  assert.equal(audit.counts.noPositiveEvMarkets, 1);
  assert.equal(audit.marketClassificationCounts.NO_POSITIVE_EV, 1);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NO_POSITIVE_EV");
});

test("audit exposes a positive-EV market blocked only by the operating envelope", () => {
  const audit = auditMlbV16NoPlayFunnel(resultFixture("ENVELOPE"));
  assert.equal(audit.primaryBlocker, "POSITIVE_EV_ENVELOPE_BLOCKED");
  assert.equal(audit.counts.positiveEvMarkets, 1);
  assert.equal(audit.counts.positiveEvEnvelopeBlocked, 1);
  assert.equal(audit.gameAudits[0].earliestBlocker, "POSITIVE_EV_ENVELOPE_BLOCKED");
});

test("audit reports NONE once an Elite evidence row exists", () => {
  const audit = auditMlbV16NoPlayFunnel(resultFixture("ELITE"));
  assert.equal(audit.primaryBlocker, "NONE");
  assert.equal(audit.counts.eliteEvidenceRowsCaptured, 1);
  assert.equal(audit.gameAudits[0].earliestBlocker, "NONE");
  assert.equal(audit.policy.changesThresholds, false);
  assert.equal(audit.policy.changesShortlistQualification, false);
  assert.equal(audit.policy.changesIntrinsicDiscoveryCap, false);
});
