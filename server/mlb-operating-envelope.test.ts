import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbOperatingEnvelope } from "./mlb-operating-envelope";

function market(overrides: Record<string, unknown> = {}) {
  return {
    marketType: "TOTAL",
    providerMarketKey: "totals",
    intrinsicProjectionScope: "FULL_GAME",
    intrinsicThesisKinds: ["TOTAL_OVER"],
    supportingComponents: ["STATCAST_QUALITY", "DISCIPLINE_SPEED"],
    selectedSide: "OVER",
    selectedLine: 8.5,
    classification: "POSITIVE_EV",
    eligibleForOperatingEnvelope: true,
    model: {
      status: "READY",
      sourcePolicy: "TOTAL_RUN_DIFFERENTIAL_V1",
      modelVersion: "predictor-full-snapshot-v2",
      generatedAt: "2026-08-11T16:00:00.000Z",
      modelInputDigest: "abc",
      winProbability: 0.57,
      pushProbability: 0,
      lossProbability: 0.43,
      decisiveWinProbability: 0.57,
      pushProbabilityDerivedAsZero: true,
    },
    execution: {
      bookKey: "hardrockbet_fl",
      bookTitle: "Hard Rock Bet",
      selectedSide: "OVER",
      selectedSelection: "Over",
      line: 8.5,
      selectedOddsAmerican: -105,
      oppositeOddsAmerican: -115,
      selectedImpliedProbability: 0.5122,
      oppositeImpliedProbability: 0.5349,
      noVigDecisiveProbability: 0.4892,
      capturedAt: "2026-08-11T16:00:00.000Z",
      providerLastUpdate: "2026-08-11T16:00:00.000Z",
    },
    reference: null,
    economics: {
      fairPrice: { decimal: 1 / 0.57, american: -132, modelWinProbability: 0.57, modelPushProbability: 0 },
      currentBreakEvenWinProbability: 0.5122,
      executionEdgePp: 5.78,
      executionNoVigEdgePp: 8.08,
      referenceNoVigEdgePp: null,
      expectedValuePerUnit: 0.112,
      referenceAgreement: "UNAVAILABLE",
    },
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

function input(markets: any[]) {
  return {
    schemaVersion: "courtedge-p0-mlb-market-edge.v1",
    generatedAt: "2026-08-11T16:00:00.000Z",
    sourceSelectiveOddsSchemaVersion: "courtedge-p0-mlb-selective-odds-acquisition.v6",
    sourceRunId: "step11-test",
    games: [{
      gamePk: 123,
      intrinsicRank: 1,
      homeTeam: { id: 1, name: "Home" },
      awayTeam: { id: 2, name: "Away" },
      acquisitionStatus: "FETCHED",
      markets,
      summary: {
        thesisMarkets: markets.length,
        positiveEvMarkets: markets.filter((entry) => entry.classification === "POSITIVE_EV").length,
        noPositiveEvMarkets: 0,
        blockedOrUnavailableMarkets: 0,
        operatingEnvelopeEligibleMarkets: markets.filter((entry) => entry.eligibleForOperatingEnvelope).length,
      },
    }],
    summary: {
      games: 1,
      thesisMarkets: markets.length,
      positiveEvMarkets: markets.filter((entry) => entry.classification === "POSITIVE_EV").length,
      noPositiveEvMarkets: 0,
      blockedOrUnavailableMarkets: 0,
      operatingEnvelopeEligibleMarkets: markets.filter((entry) => entry.eligibleForOperatingEnvelope).length,
    },
    policy: {},
    safety: {},
  } as any;
}

test("positive EV with intact certified upstream evidence becomes only an elite evidence candidate", () => {
  const result = buildMlbOperatingEnvelope({ marketEdge: input([market()]) });
  const candidate = result.games[0].markets[0];
  assert.equal(candidate.classification, "ELITE_EVIDENCE_CANDIDATE");
  assert.equal(candidate.eliteEvidenceCandidate, true);
  assert.equal(result.policy.betEliteLabelProduced, false);
  assert.equal(result.policy.finalBetRecommendationProduced, false);
  assert.equal(result.policy.outcomeProfitabilityCertified, false);
});

test("positive EV cannot bypass upstream operating-envelope eligibility", () => {
  const result = buildMlbOperatingEnvelope({ marketEdge: input([market({ eligibleForOperatingEnvelope: false })]) });
  assert.equal(result.games[0].markets[0].classification, "POSITIVE_EV_ENVELOPE_BLOCKED");
});

test("positive EV cannot become elite candidate with a missing model or execution price", () => {
  const missingModel = market({ model: { ...market().model, status: "UNAVAILABLE" } });
  const missingPrice = market({ execution: null });
  const result = buildMlbOperatingEnvelope({ marketEdge: input([missingModel, missingPrice]) });
  assert.deepEqual(result.games[0].markets.map((entry) => entry.classification), [
    "POSITIVE_EV_ENVELOPE_BLOCKED",
    "POSITIVE_EV_ENVELOPE_BLOCKED",
  ]);
});

test("positive EV must remain finite and strictly positive", () => {
  for (const expectedValuePerUnit of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    const changed = market({ economics: { ...market().economics, expectedValuePerUnit } });
    const result = buildMlbOperatingEnvelope({ marketEdge: input([changed]) });
    assert.equal(result.games[0].markets[0].classification, "POSITIVE_EV_ENVELOPE_BLOCKED");
  }
});

test("upstream blockers and broken intrinsic evidence fail closed", () => {
  const blocked = market({ blockers: ["MODEL_EVIDENCE_INVALID"] });
  const noThesis = market({ intrinsicThesisKinds: [] });
  const noSupport = market({ supportingComponents: [] });
  const result = buildMlbOperatingEnvelope({ marketEdge: input([blocked, noThesis, noSupport]) });
  assert.ok(result.games[0].markets.every((entry) => entry.classification === "POSITIVE_EV_ENVELOPE_BLOCKED"));
});

test("reference consensus remains diagnostic and cannot create or veto an elite evidence candidate", () => {
  const opposing = market({ economics: { ...market().economics, referenceAgreement: "OPPOSES_MODEL_EDGE" } });
  const noPositiveEv = market({
    classification: "NO_POSITIVE_EV",
    eligibleForOperatingEnvelope: false,
    economics: { ...market().economics, expectedValuePerUnit: -0.01, referenceAgreement: "SUPPORTS_MODEL_EDGE" },
  });
  const result = buildMlbOperatingEnvelope({ marketEdge: input([opposing, noPositiveEv]) });
  assert.equal(result.games[0].markets[0].classification, "ELITE_EVIDENCE_CANDIDATE");
  assert.equal(result.games[0].markets[1].classification, "NO_POSITIVE_EV");
});

test("no fixed EV, probability, numeric Elite score, stake or automatic bet is introduced", () => {
  const result = buildMlbOperatingEnvelope({ marketEdge: input([market()]) });
  assert.equal(result.policy.fixedEvThresholdApplied, false);
  assert.equal(result.policy.fixedProbabilityThresholdApplied, false);
  assert.equal(result.policy.numericEliteScoreProduced, false);
  assert.equal(result.policy.stakeCalculated, false);
  assert.equal(result.policy.callsTheOddsApi, false);
  assert.equal(result.policy.automaticBetPlacement, false);
  assert.equal(result.policy.realFinancialExposure, 0);
});
