import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbNormalizedCandidatePricing,
  candidatePriceEvidenceFromSelectiveOddsAcquisition,
} from "./mlb-normalized-candidate-pricing-v1";

function baseCandidate(overrides: Record<string, unknown> = {}) {
  const candidate: any = {
    schemaVersion: "courtedge-mlb-normalized-sporting-candidate.v1",
    candidateSnapshotId: "candidate-full-f5-home",
    engineCandidateKey: "engine-key",
    bettingPropositionKey: "prop-key",
    marketIdentityKey: "market-key",
    sport: "MLB",
    game: {
      gamePk: 900001,
      officialDate: "2026-09-04",
      commenceTime: "2026-09-04T23:10:00.000Z",
      awayTeam: "Away Club",
      homeTeam: "Home Club",
      inputStage: "FINAL",
    },
    engine: {
      family: "FULL_GAME",
      name: "FROZEN_FULL_GAME_AUTHORITY",
      authority: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1",
      tier: "A_PLUS",
      localRank: 1,
    },
    market: {
      family: "MONEYLINE",
      horizon: "FIRST_5",
      teamSide: null,
      direction: "HOME",
      line: null,
      sourceMarketType: "FIRST_5_ML",
    },
    sporting: {
      eligible: true,
      modelWinProbability: 0.58,
      modelPushProbability: 0.07,
      modelLossProbability: 0.35,
      probabilitySemantics: "EXPLICIT_WIN_PUSH_LOSS",
      confidence: null,
      sourcePremiumFlag: false,
      reason: "Frozen A+ candidate",
    },
    pricing: {
      status: "UNPRICED",
      oddsAmerican: null,
      marketImpliedProbability: null,
      noVigProbability: null,
      edgePp: null,
      expectedValuePerUnit: null,
      capturedAt: null,
      freshnessSeconds: null,
    },
    calibration: {
      status: "NOT_ATTACHED",
      calibratedWinProbability: null,
      normalizedCrossEngineScore: null,
      sampleSize: null,
    },
    globalRank: {
      eligible: false,
      blockers: ["PRICE_NOT_ATTACHED", "CROSS_ENGINE_CALIBRATION_NOT_ATTACHED"],
    },
    provenance: {
      sourceSchemaVersion: "source-v1",
      sourceRunId: "fg-run",
      sourceCandidateId: null,
      sourceEvaluationId: "eval-1",
      sourceSnapshotSha256: "b".repeat(64),
    },
  };
  return Object.assign(candidate, overrides);
}

function pool(candidates: any[]) {
  return {
    schemaVersion: "courtedge-mlb-normalized-candidate-pool.v1",
    date: "2026-09-04",
    generatedAt: "2026-09-04T13:58:00.000Z",
    candidates,
    sources: {},
    crossEngineDiagnostics: {},
    summary: {},
    boundary: {},
  } as any;
}

function f5Availability(capturedAt = "2026-09-04T14:00:00.000Z", providerLastUpdate = "2026-09-04T13:59:00.000Z") {
  const executionQuote = {
    bookKey: "hardrockbet_fl",
    bookTitle: "Hard Rock Bet",
    providerMarketKey: "h2h_1st_5_innings",
    providerLastUpdate,
    capturedAt,
    freshness: "FRESH",
    ageMs: 60_000,
    selections: [
      { side: "HOME", selection: "Home Club", line: null, oddsAmerican: -120 },
      { side: "AWAY", selection: "Away Club", line: null, oddsAmerican: 105 },
    ],
  };
  const referenceQuote = {
    bookKey: "reference_consensus",
    bookTitle: "Reference consensus",
    providerMarketKey: "h2h_1st_5_innings",
    providerLastUpdate,
    capturedAt,
    freshness: "FRESH",
    ageMs: 60_000,
    selections: [
      { side: "HOME", selection: "Home Club", line: null, oddsAmerican: -115 },
      { side: "AWAY", selection: "Away Club", line: null, oddsAmerican: 100 },
    ],
    contributingBooks: ["draftkings", "fanduel", "betmgm"],
    n: 3,
    consensusMethod: "exact_line_median_implied_probability",
  };
  return {
    canonicalKey: "F5_ML:DEFAULT",
    marketType: "F5_ML",
    variant: null,
    period: "FIRST_5",
    family: "MONEYLINE",
    expectedQuoteContract: "TWO_WAY_PUSH_ON_TIE",
    providerMarketKey: "h2h_1st_5_innings",
    providerSupport: "DOCUMENTED",
    availability: "EXECUTABLE",
    execution: { status: "FRESH", quote: executionQuote, presentBooks: ["hardrockbet_fl"], invalidBooks: [] },
    reference: { status: "FRESH", quote: referenceQuote, presentBooks: ["draftkings", "fanduel", "betmgm"], invalidBooks: [] },
    alternateContractBooks: [],
    blockers: [],
  } as any;
}

function evidence(capturedAt = "2026-09-04T14:00:00.000Z", providerLastUpdate = "2026-09-04T13:59:00.000Z") {
  return {
    schemaVersion: "price-evidence-test.v1",
    sourceRunId: "price-run-1",
    generatedAt: capturedAt,
    games: [{ gamePk: 900001, markets: [f5Availability(capturedAt, providerLastUpdate)] }],
    providerCalls: { paidEventOdds: 1 },
  } as any;
}

test("attaches fresh execution/no-vig evidence and push-aware economics without enabling global rank", () => {
  const result = buildMlbNormalizedCandidatePricing({
    pool: pool([baseCandidate()]),
    priceEvidence: evidence(),
    now: new Date("2026-09-04T14:01:00.000Z"),
  });
  const candidate = result.candidates[0];
  assert.equal(candidate.sourceCandidateSnapshotId, "candidate-full-f5-home");
  assert.equal(candidate.pricing.status, "ATTACHED");
  assert.equal(candidate.pricing.executionBookKey, "hardrockbet_fl");
  assert.equal(candidate.pricing.oddsAmerican, -120);
  assert.equal(candidate.pricing.oppositeOddsAmerican, 105);
  assert.ok((candidate.pricing.noVigProbability ?? 0) > 0.52);
  assert.ok((candidate.pricing.modelDecisiveWinProbability ?? 0) > 0.62);
  assert.ok((candidate.pricing.expectedValuePerUnit ?? 0) > 0.13);
  assert.ok((candidate.pricing.noVigEdgePp ?? 0) > 9);
  assert.equal(candidate.globalRank.blockers.includes("PRICE_NOT_ATTACHED"), false);
  assert.equal(candidate.globalRank.blockers.includes("CROSS_ENGINE_CALIBRATION_NOT_ATTACHED"), true);
  assert.equal(candidate.globalRank.eligible, false);
  assert.equal(result.policy.crossEngineRankPerformed, false);
});

test("attaches price to Early F5 candidate but refuses EV when push settlement is not modeled", () => {
  const early = baseCandidate();
  early.candidateSnapshotId = "candidate-early-f5-away";
  early.engine = { family: "EARLY", name: "ERE", authority: "FINAL_RECOMMENDATION", tier: null, localRank: null };
  early.market.direction = "AWAY";
  early.market.sourceMarketType = "F5_ML";
  early.sporting = {
    eligible: true,
    modelWinProbability: 0.61,
    modelPushProbability: null,
    modelLossProbability: null,
    probabilitySemantics: "SOURCE_WIN_PROBABILITY_PUSH_UNMODELED",
    confidence: "HIGH",
    sourcePremiumFlag: true,
    reason: "ERE candidate",
  };
  early.globalRank.blockers = [
    "PRICE_NOT_ATTACHED",
    "CROSS_ENGINE_CALIBRATION_NOT_ATTACHED",
    "SETTLEMENT_MODEL_INCOMPLETE",
  ];

  const result = buildMlbNormalizedCandidatePricing({
    pool: pool([early]),
    priceEvidence: evidence(),
    now: new Date("2026-09-04T14:01:00.000Z"),
  });
  const candidate = result.candidates[0];
  assert.equal(candidate.pricing.status, "ATTACHED");
  assert.equal(candidate.pricing.oddsAmerican, 105);
  assert.ok((candidate.pricing.noVigProbability ?? 1) < 0.48);
  assert.equal(candidate.pricing.expectedValuePerUnit, null);
  assert.equal(candidate.pricing.edgePp, null);
  assert.equal(candidate.pricing.noVigEdgePp, null);
  assert.equal(candidate.pricing.blockers.includes("SETTLEMENT_ECONOMICS_NOT_COMPUTABLE"), true);
  assert.equal(candidate.globalRank.blockers.includes("PRICE_NOT_ATTACHED"), false);
  assert.equal(candidate.globalRank.blockers.includes("SETTLEMENT_MODEL_INCOMPLETE"), true);
});

test("freshness is rechecked at attachment time and stale execution never receives economics", () => {
  const result = buildMlbNormalizedCandidatePricing({
    pool: pool([baseCandidate()]),
    priceEvidence: evidence("2026-09-04T14:00:00.000Z", "2026-09-04T13:59:00.000Z"),
    now: new Date("2026-09-04T14:10:01.000Z"),
  });
  const candidate = result.candidates[0];
  assert.equal(candidate.pricing.status, "STALE");
  assert.equal(candidate.pricing.oddsAmerican, null);
  assert.equal(candidate.pricing.expectedValuePerUnit, null);
  assert.equal(candidate.globalRank.blockers.includes("PRICE_NOT_ATTACHED"), true);
});

test("F5 team-total legacy aliases fail closed because Registry v1 has no verified provider mapping", () => {
  const tt = baseCandidate();
  tt.candidateSnapshotId = "candidate-early-tt";
  tt.engine = { family: "EARLY", name: "ERE", authority: "FINAL_RECOMMENDATION", tier: null, localRank: null };
  tt.market = {
    family: "TEAM_TOTAL",
    horizon: "FIRST_5",
    teamSide: "HOME",
    direction: "OVER",
    line: 1.5,
    sourceMarketType: "TT_OVER_15_F5",
  };
  tt.sporting = {
    eligible: true,
    modelWinProbability: 0.8,
    modelPushProbability: 0,
    modelLossProbability: 0.2,
    probabilitySemantics: "TWO_WAY_WIN_LOSS",
    confidence: "HIGH",
    sourcePremiumFlag: false,
    reason: "ERE team total",
  };

  const result = buildMlbNormalizedCandidatePricing({
    pool: pool([tt]),
    priceEvidence: evidence(),
    now: new Date("2026-09-04T14:01:00.000Z"),
  });
  const candidate = result.candidates[0];
  assert.equal(candidate.pricing.status, "BLOCKED");
  assert.equal(candidate.pricing.canonicalMarketType, "TT_OVER_15_F5");
  assert.equal(candidate.pricing.providerMarketKey, null);
  assert.deepEqual(candidate.pricing.blockers, ["VERIFIED_PROVIDER_MARKET_MAPPING_MISSING"]);
  assert.equal(candidate.globalRank.blockers.includes("PRICE_NOT_ATTACHED"), true);
});

test("selective-odds acquisition adapter preserves normalized quote evidence without re-fetching", () => {
  const adapted = candidatePriceEvidenceFromSelectiveOddsAcquisition({
    schemaVersion: "courtedge-p0-mlb-selective-odds-acquisition.v6",
    generatedAt: "2026-09-04T14:00:00.000Z",
    runId: "selective-run-1",
    games: [{ gamePk: 900001, quoteMarkets: [f5Availability()] }],
    providerCalls: { zeroCostEventsProbe: 1, paidEventOdds: 1, eventMarkets: 0, sportOdds: 0 },
  } as any);
  assert.equal(adapted.sourceRunId, "selective-run-1");
  assert.equal(adapted.providerCalls.paidEventOdds, 1);
  assert.equal(adapted.games[0].gamePk, 900001);
  assert.equal(adapted.games[0].markets[0].marketType, "F5_ML");
});
