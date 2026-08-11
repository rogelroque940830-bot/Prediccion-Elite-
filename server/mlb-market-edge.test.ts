import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_MARKET_EDGE_SCHEMA,
  buildMlbMarketProbabilityAssessmentDigest,
  evaluateMlbMarketEdges,
  MlbMarketEdgeInputError,
  type MlbMarketEdgeModelPolicy,
  type MlbMarketEdgeSupportedMarket,
  type MlbMarketProbabilityAssessment,
} from "./mlb-market-edge";
import {
  MLB_P1_M6A2_CONSENSUS_METHOD,
  type MlbCanonicalMarketAvailability,
  type MlbNormalizedBookQuote,
  type MlbReferenceConsensusQuote,
  type MlbSelectionSide,
} from "./mlb-market-odds-normalizer";
import { getMlbMarketContract } from "./mlb-market-contract";
import {
  MLB_SELECTIVE_ODDS_ACQUISITION_SCHEMA,
  type MlbSelectiveOddsAcquisitionResult,
  type MlbSelectiveOddsGameResult,
  type MlbSelectiveOddsMarketThesis,
} from "./mlb-selective-odds-acquisition";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const CAPTURED_AT = "2026-08-11T11:59:30.000Z";
const PROVIDER_UPDATE = "2026-08-11T11:59:20.000Z";

function providerKey(market: MlbMarketEdgeSupportedMarket): string {
  if (market === "ML") return "h2h";
  if (market === "F5_ML") return "h2h_1st_5_innings";
  if (market === "RUN_LINE") return "spreads";
  if (market === "TOTAL") return "totals";
  return "totals_1st_5_innings";
}

function policy(market: MlbMarketEdgeSupportedMarket): MlbMarketEdgeModelPolicy {
  if (market === "ML" || market === "F5_ML") return "ML_F5_EDGE_CONFIDENCE_V2";
  if (market === "RUN_LINE") return "RUN_LINE_COVER_PROBABILITY_V1";
  if (market === "TOTAL") return "TOTAL_RUN_DIFFERENTIAL_V1";
  return "F5_TOTAL_RUN_DIFFERENTIAL_V1";
}

function thesis(
  market: MlbMarketEdgeSupportedMarket,
  kind: "HOME_SIDE" | "AWAY_SIDE" | "TOTAL_OVER" | "TOTAL_UNDER",
): MlbSelectiveOddsMarketThesis {
  const total = market === "TOTAL" || market === "F5_TOTAL";
  return {
    providerMarketKey: providerKey(market),
    canonicalMarketType: market,
    intrinsicProjectionScope: market === "F5_ML" || market === "F5_TOTAL" ? "EARLY_WINDOW" : "FULL_GAME",
    thesisIntent: total ? "TOTAL" : "SIDE",
    intrinsicThesisKinds: [kind],
    supportingComponents: ["STATCAST_QUALITY", "DISCIPLINE_SPEED"],
  } as MlbSelectiveOddsMarketThesis;
}

function selectionPair(input: {
  side: "HOME" | "AWAY" | "OVER" | "UNDER";
  line: number | null;
  selectedOdds?: number;
  oppositeOdds?: number;
}): MlbNormalizedBookQuote["selections"] {
  const selectedOdds = input.selectedOdds ?? 100;
  const oppositeOdds = input.oppositeOdds ?? 100;
  if (input.side === "HOME" || input.side === "AWAY") {
    const home = {
      side: "HOME" as MlbSelectionSide,
      selection: "Home Team",
      line: input.side === "HOME" ? input.line : input.line == null ? null : -input.line,
      oddsAmerican: input.side === "HOME" ? selectedOdds : oppositeOdds,
    };
    const away = {
      side: "AWAY" as MlbSelectionSide,
      selection: "Away Team",
      line: input.side === "AWAY" ? input.line : input.line == null ? null : -input.line,
      oddsAmerican: input.side === "AWAY" ? selectedOdds : oppositeOdds,
    };
    return [home, away] as MlbNormalizedBookQuote["selections"];
  }
  const over = {
    side: "OVER" as MlbSelectionSide,
    selection: "Over",
    line: input.line,
    oddsAmerican: input.side === "OVER" ? selectedOdds : oppositeOdds,
  };
  const under = {
    side: "UNDER" as MlbSelectionSide,
    selection: "Under",
    line: input.line,
    oddsAmerican: input.side === "UNDER" ? selectedOdds : oppositeOdds,
  };
  return [over, under] as MlbNormalizedBookQuote["selections"];
}

function bookQuote(input: {
  market: MlbMarketEdgeSupportedMarket;
  side: "HOME" | "AWAY" | "OVER" | "UNDER";
  line: number | null;
  selectedOdds?: number;
  oppositeOdds?: number;
  capturedAt?: string;
}): MlbNormalizedBookQuote {
  return {
    bookKey: "hardrockbet_fl",
    bookTitle: "Hard Rock Bet (FL)",
    providerMarketKey: providerKey(input.market),
    providerLastUpdate: PROVIDER_UPDATE,
    capturedAt: input.capturedAt ?? CAPTURED_AT,
    freshness: "FRESH",
    ageMs: 10_000,
    selections: selectionPair(input),
  };
}

function referenceQuote(input: {
  market: MlbMarketEdgeSupportedMarket;
  side: "HOME" | "AWAY" | "OVER" | "UNDER";
  line: number | null;
  selectedOdds?: number;
  oppositeOdds?: number;
  capturedAt?: string;
}): MlbReferenceConsensusQuote {
  return {
    bookKey: "reference_consensus",
    bookTitle: "Reference consensus",
    providerMarketKey: providerKey(input.market),
    providerLastUpdate: PROVIDER_UPDATE,
    capturedAt: input.capturedAt ?? CAPTURED_AT,
    freshness: "FRESH",
    ageMs: 10_000,
    selections: selectionPair(input),
    contributingBooks: ["draftkings", "fanduel", "betmgm"],
    n: 3,
    consensusMethod: MLB_P1_M6A2_CONSENSUS_METHOD,
  };
}

function quoteAvailability(input: {
  market: MlbMarketEdgeSupportedMarket;
  side: "HOME" | "AWAY" | "OVER" | "UNDER";
  line: number | null;
  selectedOdds?: number;
  oppositeOdds?: number;
  capturedAt?: string;
  availability?: MlbCanonicalMarketAvailability["availability"];
  includeExecution?: boolean;
  includeReference?: boolean;
}): MlbCanonicalMarketAvailability {
  const contract = getMlbMarketContract(input.market);
  const execution = input.includeExecution === false ? null : bookQuote(input);
  const reference = input.includeReference === false ? null : referenceQuote(input);
  return {
    canonicalKey: input.market,
    marketType: input.market,
    variant: null,
    period: contract.period,
    family: contract.family,
    expectedQuoteContract: contract.quoteContract,
    providerMarketKey: providerKey(input.market),
    providerSupport: "DOCUMENTED",
    availability: input.availability ?? (execution ? "EXECUTABLE" : reference ? "REFERENCE_ONLY" : "UNAVAILABLE_FROM_PROVIDER"),
    execution: {
      status: execution ? "FRESH" : "MISSING",
      quote: execution,
      presentBooks: execution ? ["hardrockbet_fl"] : [],
      invalidBooks: [],
    },
    reference: {
      status: reference ? "FRESH" : "MISSING",
      quote: reference,
      presentBooks: reference ? ["draftkings", "fanduel", "betmgm"] : [],
      invalidBooks: [],
    },
    alternateContractBooks: [],
    blockers: [],
  };
}

function game(input: {
  market: MlbMarketEdgeSupportedMarket;
  kind?: "HOME_SIDE" | "AWAY_SIDE" | "TOTAL_OVER" | "TOTAL_UNDER";
  side?: "HOME" | "AWAY" | "OVER" | "UNDER";
  line?: number | null;
  selectedOdds?: number;
  oppositeOdds?: number;
  capturedAt?: string;
  availability?: MlbCanonicalMarketAvailability["availability"];
  includeExecution?: boolean;
  includeReference?: boolean;
}): MlbSelectiveOddsGameResult {
  const total = input.market === "TOTAL" || input.market === "F5_TOTAL";
  const kind = input.kind ?? (total ? "TOTAL_OVER" : "HOME_SIDE");
  const side = input.side ?? (total ? "OVER" : "HOME");
  const line = input.line !== undefined ? input.line : input.market === "RUN_LINE" ? -1.5 : total ? 8.5 : null;
  const marketThesis = thesis(input.market, kind);
  const market = quoteAvailability({
    market: input.market,
    side,
    line,
    selectedOdds: input.selectedOdds,
    oppositeOdds: input.oppositeOdds,
    capturedAt: input.capturedAt,
    availability: input.availability,
    includeExecution: input.includeExecution,
    includeReference: input.includeReference,
  });
  return {
    gamePk: 900001,
    intrinsicRank: 1,
    homeTeam: { id: 1, name: "Home Team" },
    awayTeam: { id: 2, name: "Away Team" },
    officialDate: "2026-08-11",
    startTime: "2026-08-11T23:10:00.000Z",
    inputStage: "FINAL",
    status: input.includeExecution === false ? "FETCHED" : "FETCHED",
    holdReason: null,
    eventMatchStatus: "MATCHED",
    providerEventId: "evt-900001",
    requestedMarketKeys: [providerKey(input.market)],
    cacheHitMarketKeys: [],
    paidMarketKeysRequested: [providerKey(input.market)],
    marketTheses: [marketThesis],
    quoteMarkets: [market],
    budgetDenialCode: null,
    providerErrorCode: null,
    usableForMarketEdge: market.availability === "EXECUTABLE",
  } as MlbSelectiveOddsGameResult;
}

function acquisition(g: MlbSelectiveOddsGameResult): MlbSelectiveOddsAcquisitionResult {
  return {
    schemaVersion: MLB_SELECTIVE_ODDS_ACQUISITION_SCHEMA,
    generatedAt: CAPTURED_AT,
    runId: "step9-source-run",
    date: "2026-08-11",
    games: [g],
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  } as unknown as MlbSelectiveOddsAcquisitionResult;
}

function modelAssessment(input: {
  market: MlbMarketEdgeSupportedMarket;
  side?: "HOME" | "AWAY" | "OVER" | "UNDER";
  line?: number | null;
  winProbability: number | null;
  pushProbability: number | null;
  sourcePolicy?: MlbMarketEdgeModelPolicy;
  status?: "READY" | "UNAVAILABLE";
  generatedAt?: string;
  modelVersion?: string;
  semantics?: "UNCONDITIONAL_SETTLEMENT";
}): MlbMarketProbabilityAssessment {
  const total = input.market === "TOTAL" || input.market === "F5_TOTAL";
  const side = input.side ?? (total ? "OVER" : "HOME");
  const line = input.line !== undefined ? input.line : input.market === "RUN_LINE" ? -1.5 : total ? 8.5 : null;
  const withoutDigest = {
    gamePk: 900001,
    marketType: input.market,
    side,
    line,
    status: input.status ?? "READY",
    sourcePolicy: input.sourcePolicy ?? policy(input.market),
    modelVersion: input.modelVersion ?? "model-test-v1",
    generatedAt: input.generatedAt ?? "2026-08-11T11:59:40.000Z",
    probabilitySemantics: input.semantics ?? "UNCONDITIONAL_SETTLEMENT",
    winProbability: input.winProbability,
    pushProbability: input.pushProbability,
    unavailableReason: input.status === "UNAVAILABLE" ? "MODEL_PATH_UNAVAILABLE" : null,
  } as const;
  return {
    ...withoutDigest,
    modelInputDigest: buildMlbMarketProbabilityAssessmentDigest(withoutDigest),
  } as MlbMarketProbabilityAssessment;
}

function single(input: {
  game: MlbSelectiveOddsGameResult;
  assessment?: MlbMarketProbabilityAssessment;
  now?: Date;
}) {
  return evaluateMlbMarketEdges({
    acquisition: acquisition(input.game),
    modelAssessments: input.assessment ? [input.assessment] : [],
    now: input.now ?? NOW,
  }).games[0].markets[0];
}

test("push-capable full-game ML refuses binary EV when model push probability is missing", () => {
  const result = single({
    game: game({ market: "ML", selectedOdds: 100, oppositeOdds: 100 }),
    assessment: modelAssessment({ market: "ML", winProbability: 0.55, pushProbability: null }),
  });
  assert.equal(result.classification, "PUSH_PROBABILITY_REQUIRED");
  assert.equal(result.eligibleForOperatingEnvelope, false);
  assert.equal(result.blockers.includes("MODEL_PUSH_PROBABILITY_REQUIRED"), true);
  assert.equal(result.economics.expectedValuePerUnit, null);
});

test("push-aware ML computes fair price, decisive no-vig edge and EV from win/push/loss", () => {
  const result = single({
    game: game({ market: "ML", selectedOdds: 100, oppositeOdds: 100 }),
    assessment: modelAssessment({ market: "ML", winProbability: 0.55, pushProbability: 0.10 }),
  });
  assert.equal(result.classification, "POSITIVE_EV");
  assert.equal(result.eligibleForOperatingEnvelope, true);
  assert.equal(result.model.lossProbability, 0.35);
  assert.equal(result.model.decisiveWinProbability, 0.611111111111);
  assert.equal(result.economics.expectedValuePerUnit, 0.2);
  assert.equal(result.economics.fairPrice?.decimal, 1.63636364);
  assert.equal(result.economics.currentBreakEvenWinProbability, 0.45);
  assert.equal(result.economics.executionEdgePp, 10);
  assert.equal(result.economics.executionNoVigEdgePp, 11.11111111);
});

test("F5 ML independently requires push probability under its two-way-push-on-tie contract", () => {
  const result = single({
    game: game({ market: "F5_ML" }),
    assessment: modelAssessment({ market: "F5_ML", winProbability: 0.56, pushProbability: null }),
  });
  assert.equal(result.classification, "PUSH_PROBABILITY_REQUIRED");
});

test("half-run totals derive zero push safely and do not require a synthetic push model", () => {
  const result = single({
    game: game({ market: "TOTAL", line: 8.5, selectedOdds: 100, oppositeOdds: 100 }),
    assessment: modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null }),
  });
  assert.equal(result.classification, "POSITIVE_EV");
  assert.equal(result.model.pushProbability, 0);
  assert.equal(result.model.pushProbabilityDerivedAsZero, true);
  assert.equal(result.model.lossProbability, 0.47);
  assert.equal(result.economics.expectedValuePerUnit, 0.06);
});

test("integer total requires explicit push probability before EV can exist", () => {
  const result = single({
    game: game({ market: "TOTAL", line: 8, selectedOdds: 100, oppositeOdds: 100 }),
    assessment: modelAssessment({ market: "TOTAL", line: 8, winProbability: 0.52, pushProbability: null }),
  });
  assert.equal(result.classification, "PUSH_PROBABILITY_REQUIRED");
  assert.equal(result.economics.expectedValuePerUnit, null);
});

test("half-run run line is no-push and uses its existing market-specific source policy", () => {
  const result = single({
    game: game({ market: "RUN_LINE", line: -1.5, selectedOdds: 110, oppositeOdds: -130 }),
    assessment: modelAssessment({ market: "RUN_LINE", line: -1.5, winProbability: 0.50, pushProbability: null }),
  });
  assert.equal(result.model.sourcePolicy, "RUN_LINE_COVER_PROBABILITY_V1");
  assert.equal(result.model.pushProbability, 0);
  assert.equal(result.classification, "POSITIVE_EV");
});

test("Step 9 rechecks quote age so a 24h Step 8 idempotent replay cannot masquerade as fresh price", () => {
  const staleNow = new Date("2026-08-11T12:05:31.000Z");
  const result = single({
    game: game({ market: "TOTAL", line: 8.5, capturedAt: CAPTURED_AT }),
    assessment: modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null }),
    now: staleNow,
  });
  assert.equal(result.classification, "QUOTE_STALE");
  assert.equal(result.eligibleForOperatingEnvelope, false);
});

test("reference consensus can never substitute for a missing executable Hard Rock Florida quote", () => {
  const result = single({
    game: game({ market: "TOTAL", line: 8.5, includeExecution: false, includeReference: true, availability: "REFERENCE_ONLY" }),
    assessment: modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.60, pushProbability: null }),
  });
  assert.equal(result.classification, "PRICE_UNUSABLE");
  assert.equal(result.execution, null);
  assert.equal(result.eligibleForOperatingEnvelope, false);
});

test("wrong source-policy family is model-invalid even when the probability itself looks attractive", () => {
  const result = single({
    game: game({ market: "TOTAL", line: 8.5 }),
    assessment: modelAssessment({
      market: "TOTAL",
      line: 8.5,
      winProbability: 0.60,
      pushProbability: null,
      sourcePolicy: "RUN_LINE_COVER_PROBABILITY_V1",
    }),
  });
  assert.equal(result.classification, "MODEL_INVALID");
  assert.equal(result.blockers.includes("MODEL_SOURCE_POLICY_MISMATCH"), true);
});

test("exact quoted line must have an exact model assessment; nearby total line is not reusable", () => {
  const result = single({
    game: game({ market: "TOTAL", line: 8.5 }),
    assessment: modelAssessment({ market: "TOTAL", line: 9.5, winProbability: 0.60, pushProbability: null }),
  });
  assert.equal(result.classification, "MODEL_UNAVAILABLE");
  assert.equal(result.blockers.includes("EXACT_MARKET_MODEL_ASSESSMENT_REQUIRED"), true);
});

test("a tiny positive EV is retained as raw economic evidence without inventing a Step 9 edge floor", () => {
  const result = single({
    game: game({ market: "TOTAL", line: 8.5, selectedOdds: 100, oppositeOdds: 100 }),
    assessment: modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.5005, pushProbability: null }),
  });
  assert.equal(result.classification, "POSITIVE_EV");
  assert.equal(result.economics.expectedValuePerUnit, 0.001);
  const top = evaluateMlbMarketEdges({ acquisition: acquisition(game({ market: "TOTAL", line: 8.5 })), modelAssessments: [modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.5005, pushProbability: null })], now: NOW });
  assert.equal(top.policy.fixedEdgeFloorApplied, false);
  assert.equal(top.policy.operatingEnvelopeApplied, false);
  assert.equal(top.policy.eliteLabelProduced, false);
  assert.equal(top.policy.recommendsBet, false);
});

test("negative EV is NO_POSITIVE_EV rather than a bet recommendation", () => {
  const result = single({
    game: game({ market: "F5_TOTAL", line: 4.5, selectedOdds: 100, oppositeOdds: 100 }),
    assessment: modelAssessment({ market: "F5_TOTAL", line: 4.5, winProbability: 0.49, pushProbability: null }),
  });
  assert.equal(result.classification, "NO_POSITIVE_EV");
  assert.equal(result.eligibleForOperatingEnvelope, false);
  assert.equal(result.economics.expectedValuePerUnit, -0.02);
});

test("invalid settlement probability mass fails closed", () => {
  const result = single({
    game: game({ market: "F5_ML" }),
    assessment: modelAssessment({ market: "F5_ML", winProbability: 0.80, pushProbability: 0.30 }),
  });
  assert.equal(result.classification, "MODEL_INVALID");
  assert.equal(result.blockers.includes("MODEL_SETTLEMENT_PROBABILITIES_INVALID"), true);
});

test("nonzero push probability is rejected when an exact half-line makes push impossible", () => {
  const result = single({
    game: game({ market: "TOTAL", line: 8.5 }),
    assessment: modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.52, pushProbability: 0.03 }),
  });
  assert.equal(result.classification, "MODEL_INVALID");
  assert.equal(result.blockers.includes("MODEL_PUSH_PROBABILITY_NONZERO_FOR_NO_PUSH_CONTRACT"), true);
});

test("reference disagreement remains diagnostic and cannot erase a positive executable EV", () => {
  const g = game({ market: "TOTAL", line: 8.5, selectedOdds: 110, oppositeOdds: -130 });
  const q = g.quoteMarkets[0];
  q.reference.quote = referenceQuote({ market: "TOTAL", side: "OVER", line: 8.5, selectedOdds: -150, oppositeOdds: 130 });
  const result = single({
    game: g,
    assessment: modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.50, pushProbability: null }),
  });
  assert.equal(result.classification, "POSITIVE_EV");
  assert.equal(result.economics.referenceAgreement, "OPPOSES_MODEL_EDGE");
  assert.equal(result.eligibleForOperatingEnvelope, true);
});

test("all five currently authorized model-policy families remain explicit and market-specific", () => {
  const cases: Array<{ market: MlbMarketEdgeSupportedMarket; line: number | null; push: number | null; win: number }> = [
    { market: "ML", line: null, push: 0.02, win: 0.52 },
    { market: "F5_ML", line: null, push: 0.12, win: 0.48 },
    { market: "RUN_LINE", line: -1.5, push: null, win: 0.49 },
    { market: "TOTAL", line: 8.5, push: null, win: 0.51 },
    { market: "F5_TOTAL", line: 4.5, push: null, win: 0.51 },
  ];
  for (const item of cases) {
    const r = single({
      game: game({ market: item.market, line: item.line, selectedOdds: 120, oppositeOdds: -140 }),
      assessment: modelAssessment({ market: item.market, line: item.line, winProbability: item.win, pushProbability: item.push }),
    });
    assert.equal(r.model.sourcePolicy, policy(item.market));
    assert.equal(["POSITIVE_EV", "NO_POSITIVE_EV"].includes(r.classification), true, `${item.market} should reach economics`);
  }
});

test("duplicate exact model assessments reject instead of making source choice order-dependent", () => {
  const a = modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null });
  assert.throws(
    () => evaluateMlbMarketEdges({ acquisition: acquisition(game({ market: "TOTAL", line: 8.5 })), modelAssessments: [a, { ...a }], now: NOW }),
    (error: any) => error instanceof MlbMarketEdgeInputError && error.code === "DUPLICATE_MODEL_ASSESSMENT",
  );
});

test("Market Edge is a pure post-price evaluator: no provider calls, stake, ranking or Elite output", () => {
  const output = evaluateMlbMarketEdges({
    acquisition: acquisition(game({ market: "TOTAL", line: 8.5 })),
    modelAssessments: [modelAssessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null })],
    now: NOW,
  });
  assert.equal(output.schemaVersion, MLB_MARKET_EDGE_SCHEMA);
  assert.equal(output.policy.callsTheOddsApi, false);
  assert.equal(output.policy.theOddsApiCreditsConsumed, 0);
  assert.equal(output.policy.marketRankingProduced, false);
  assert.equal(output.policy.stakeCalculated, false);
  assert.equal(output.policy.automaticBetPlacement, false);
  assert.equal(output.policy.realFinancialExposure, 0);
});
