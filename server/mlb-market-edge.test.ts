import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_MARKET_EDGE_SCHEMA,
  MlbMarketEdgeInputError,
  buildMlbMarketProbabilityAssessmentDigest,
  evaluateMlbMarketEdges,
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

function thesis(market: MlbMarketEdgeSupportedMarket, kind: "HOME_SIDE" | "AWAY_SIDE" | "TOTAL_OVER" | "TOTAL_UNDER"): MlbSelectiveOddsMarketThesis {
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

function selections(input: { side: "HOME" | "AWAY" | "OVER" | "UNDER"; line: number | null; selectedOdds?: number; oppositeOdds?: number }): MlbNormalizedBookQuote["selections"] {
  const selectedOdds = input.selectedOdds ?? 100;
  const oppositeOdds = input.oppositeOdds ?? 100;
  if (input.side === "HOME" || input.side === "AWAY") {
    const selectedLine = input.line;
    const otherLine = selectedLine == null ? null : -selectedLine;
    return [
      { side: "HOME" as MlbSelectionSide, selection: "Home Team", line: input.side === "HOME" ? selectedLine : otherLine, oddsAmerican: input.side === "HOME" ? selectedOdds : oppositeOdds },
      { side: "AWAY" as MlbSelectionSide, selection: "Away Team", line: input.side === "AWAY" ? selectedLine : otherLine, oddsAmerican: input.side === "AWAY" ? selectedOdds : oppositeOdds },
    ] as MlbNormalizedBookQuote["selections"];
  }
  return [
    { side: "OVER" as MlbSelectionSide, selection: "Over", line: input.line, oddsAmerican: input.side === "OVER" ? selectedOdds : oppositeOdds },
    { side: "UNDER" as MlbSelectionSide, selection: "Under", line: input.line, oddsAmerican: input.side === "UNDER" ? selectedOdds : oppositeOdds },
  ] as MlbNormalizedBookQuote["selections"];
}

function executionQuote(input: { market: MlbMarketEdgeSupportedMarket; side: "HOME" | "AWAY" | "OVER" | "UNDER"; line: number | null; selectedOdds?: number; oppositeOdds?: number; capturedAt?: string; providerLastUpdate?: string | null }): MlbNormalizedBookQuote {
  return {
    bookKey: "hardrockbet_fl",
    bookTitle: "Hard Rock Bet (FL)",
    providerMarketKey: providerKey(input.market),
    providerLastUpdate: input.providerLastUpdate === undefined ? PROVIDER_UPDATE : input.providerLastUpdate,
    capturedAt: input.capturedAt ?? CAPTURED_AT,
    freshness: "FRESH",
    ageMs: 10_000,
    selections: selections(input),
  };
}

function referenceQuote(input: { market: MlbMarketEdgeSupportedMarket; side: "HOME" | "AWAY" | "OVER" | "UNDER"; line: number | null; selectedOdds?: number; oppositeOdds?: number; capturedAt?: string; providerLastUpdate?: string | null }): MlbReferenceConsensusQuote {
  return {
    bookKey: "reference_consensus",
    bookTitle: "Reference consensus",
    providerMarketKey: providerKey(input.market),
    providerLastUpdate: input.providerLastUpdate === undefined ? PROVIDER_UPDATE : input.providerLastUpdate,
    capturedAt: input.capturedAt ?? CAPTURED_AT,
    freshness: "FRESH",
    ageMs: 10_000,
    selections: selections(input),
    contributingBooks: ["draftkings", "fanduel", "betmgm"],
    n: 3,
    consensusMethod: MLB_P1_M6A2_CONSENSUS_METHOD,
  };
}

function quoteAvailability(input: { market: MlbMarketEdgeSupportedMarket; side: "HOME" | "AWAY" | "OVER" | "UNDER"; line: number | null; selectedOdds?: number; oppositeOdds?: number; capturedAt?: string; providerLastUpdate?: string | null; availability?: MlbCanonicalMarketAvailability["availability"]; includeExecution?: boolean; includeReference?: boolean }): MlbCanonicalMarketAvailability {
  const contract = getMlbMarketContract(input.market);
  const execution = input.includeExecution === false ? null : executionQuote(input);
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
    execution: { status: execution ? "FRESH" : "MISSING", quote: execution, presentBooks: execution ? ["hardrockbet_fl"] : [], invalidBooks: [] },
    reference: { status: reference ? "FRESH" : "MISSING", quote: reference, presentBooks: reference ? ["draftkings", "fanduel", "betmgm"] : [], invalidBooks: [] },
    alternateContractBooks: [],
    blockers: [],
  };
}

function game(input: { market: MlbMarketEdgeSupportedMarket; kind?: "HOME_SIDE" | "AWAY_SIDE" | "TOTAL_OVER" | "TOTAL_UNDER"; side?: "HOME" | "AWAY" | "OVER" | "UNDER"; line?: number | null; selectedOdds?: number; oppositeOdds?: number; capturedAt?: string; providerLastUpdate?: string | null; availability?: MlbCanonicalMarketAvailability["availability"]; includeExecution?: boolean; includeReference?: boolean }): MlbSelectiveOddsGameResult {
  const total = input.market === "TOTAL" || input.market === "F5_TOTAL";
  const kind = input.kind ?? (total ? "TOTAL_OVER" : "HOME_SIDE");
  const side = input.side ?? (total ? "OVER" : "HOME");
  const line = input.line !== undefined ? input.line : input.market === "RUN_LINE" ? -1.5 : total ? 8.5 : null;
  const market = quoteAvailability({ ...input, side, line });
  return {
    gamePk: 900001,
    intrinsicRank: 1,
    homeTeam: { id: 1, name: "Home Team" },
    awayTeam: { id: 2, name: "Away Team" },
    officialDate: "2026-08-11",
    startTime: "2026-08-11T23:10:00.000Z",
    inputStage: "FINAL",
    status: "FETCHED",
    holdReason: null,
    eventMatchStatus: "MATCHED",
    providerEventId: "evt-900001",
    requestedMarketKeys: [providerKey(input.market)],
    cacheHitMarketKeys: [],
    paidMarketKeysRequested: [providerKey(input.market)],
    marketTheses: [thesis(input.market, kind)],
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
    safety: { mode: "SHADOW_DECISION_SUPPORT", realFinancialExposure: 0, automaticBetPlacement: false, automaticModelChangesAllowed: false, automaticPromotionAllowed: false },
  } as unknown as MlbSelectiveOddsAcquisitionResult;
}

function assessment(input: { market: MlbMarketEdgeSupportedMarket; side?: "HOME" | "AWAY" | "OVER" | "UNDER"; line?: number | null; winProbability: number | null; pushProbability: number | null; sourcePolicy?: MlbMarketEdgeModelPolicy; status?: "READY" | "UNAVAILABLE"; generatedAt?: string; modelVersion?: string }): MlbMarketProbabilityAssessment {
  const total = input.market === "TOTAL" || input.market === "F5_TOTAL";
  const side = input.side ?? (total ? "OVER" : "HOME");
  const line = input.line !== undefined ? input.line : input.market === "RUN_LINE" ? -1.5 : total ? 8.5 : null;
  const payload = {
    gamePk: 900001,
    marketType: input.market,
    side,
    line,
    status: input.status ?? "READY",
    sourcePolicy: input.sourcePolicy ?? policy(input.market),
    modelVersion: input.modelVersion ?? "model-test-v1",
    generatedAt: input.generatedAt ?? "2026-08-11T11:59:40.000Z",
    probabilitySemantics: "UNCONDITIONAL_SETTLEMENT" as const,
    winProbability: input.winProbability,
    pushProbability: input.pushProbability,
    unavailableReason: input.status === "UNAVAILABLE" ? "MODEL_PATH_UNAVAILABLE" : null,
  };
  return { ...payload, modelInputDigest: buildMlbMarketProbabilityAssessmentDigest(payload) };
}

function single(input: { game: MlbSelectiveOddsGameResult; assessment?: MlbMarketProbabilityAssessment; now?: Date }) {
  return evaluateMlbMarketEdges({ acquisition: acquisition(input.game), modelAssessments: input.assessment ? [input.assessment] : [], now: input.now ?? NOW }).games[0].markets[0];
}

test("ML requires push probability", () => {
  const r = single({ game: game({ market: "ML" }), assessment: assessment({ market: "ML", winProbability: 0.55, pushProbability: null }) });
  assert.equal(r.classification, "PUSH_PROBABILITY_REQUIRED");
  assert.equal(r.economics.expectedValuePerUnit, null);
});

test("push-aware ML computes settlement-correct fair price and EV", () => {
  const r = single({ game: game({ market: "ML" }), assessment: assessment({ market: "ML", winProbability: 0.55, pushProbability: 0.10 }) });
  assert.equal(r.classification, "POSITIVE_EV");
  assert.equal(r.model.lossProbability, 0.35);
  assert.equal(r.model.decisiveWinProbability, 0.611111111111);
  assert.equal(r.economics.expectedValuePerUnit, 0.2);
  assert.equal(r.economics.fairPrice?.decimal, 1.63636364);
  assert.equal(r.economics.currentBreakEvenWinProbability, 0.45);
});

test("F5 ML requires push probability", () => {
  assert.equal(single({ game: game({ market: "F5_ML" }), assessment: assessment({ market: "F5_ML", winProbability: 0.56, pushProbability: null }) }).classification, "PUSH_PROBABILITY_REQUIRED");
});

test("half-run total derives push zero", () => {
  const r = single({ game: game({ market: "TOTAL", line: 8.5 }), assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null }) });
  assert.equal(r.classification, "POSITIVE_EV");
  assert.equal(r.model.pushProbability, 0);
  assert.equal(r.model.pushProbabilityDerivedAsZero, true);
  assert.equal(r.economics.expectedValuePerUnit, 0.06);
});

test("integer total requires explicit push probability", () => {
  assert.equal(single({ game: game({ market: "TOTAL", line: 8 }), assessment: assessment({ market: "TOTAL", line: 8, winProbability: 0.52, pushProbability: null }) }).classification, "PUSH_PROBABILITY_REQUIRED");
});

test("half-run run line is no-push and uses market-specific policy", () => {
  const r = single({ game: game({ market: "RUN_LINE", line: -1.5, selectedOdds: 110, oppositeOdds: -130 }), assessment: assessment({ market: "RUN_LINE", line: -1.5, winProbability: 0.50, pushProbability: null }) });
  assert.equal(r.model.sourcePolicy, "RUN_LINE_COVER_PROBABILITY_V1");
  assert.equal(r.classification, "POSITIVE_EV");
});

test("capture age is rechecked", () => {
  const r = single({ game: game({ market: "TOTAL", line: 8.5 }), assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null }), now: new Date("2026-08-11T12:05:31.000Z") });
  assert.equal(r.classification, "QUOTE_STALE");
});

test("recent capture cannot hide stale providerLastUpdate", () => {
  const r = single({ game: game({ market: "TOTAL", line: 8.5, capturedAt: "2026-08-11T11:59:50.000Z", providerLastUpdate: "2026-08-11T11:54:59.000Z" }), assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.60, pushProbability: null }) });
  assert.equal(r.classification, "QUOTE_STALE");
});

test("reference-only cannot substitute Hard Rock execution", () => {
  const r = single({ game: game({ market: "TOTAL", line: 8.5, includeExecution: false, includeReference: true, availability: "REFERENCE_ONLY" }), assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.60, pushProbability: null }) });
  assert.equal(r.classification, "PRICE_UNUSABLE");
});

test("embedded execution quote must itself be Hard Rock and the thesis provider market", () => {
  const wrongBook = game({ market: "TOTAL", line: 8.5 });
  (wrongBook.quoteMarkets[0].execution.quote as any).bookKey = "fanduel";
  let r = single({ game: wrongBook, assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.60, pushProbability: null }) });
  assert.equal(r.classification, "PRICE_UNUSABLE");
  assert.equal(r.blockers.includes("EXECUTION_QUOTE_IDENTITY_MISMATCH"), true);

  const wrongMarket = game({ market: "TOTAL", line: 8.5 });
  (wrongMarket.quoteMarkets[0].execution.quote as any).providerMarketKey = "spreads";
  r = single({ game: wrongMarket, assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.60, pushProbability: null }) });
  assert.equal(r.classification, "PRICE_UNUSABLE");
});

test("wrong model source policy is invalid", () => {
  const r = single({ game: game({ market: "TOTAL", line: 8.5 }), assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.60, pushProbability: null, sourcePolicy: "RUN_LINE_COVER_PROBABILITY_V1" }) });
  assert.equal(r.classification, "MODEL_INVALID");
});

test("missing modelVersion fails closed without throwing", () => {
  const m = assessment({ market: "TOTAL", line: 8.5, winProbability: 0.60, pushProbability: null });
  (m as any).modelVersion = null;
  const r = single({ game: game({ market: "TOTAL", line: 8.5 }), assessment: m });
  assert.equal(r.classification, "MODEL_INVALID");
  assert.equal(r.blockers.includes("MODEL_PROVENANCE_INVALID"), true);
});

test("tampered model assessment cannot retain an unrelated digest", () => {
  const m = assessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null });
  m.winProbability = 0.73;
  const r = single({ game: game({ market: "TOTAL", line: 8.5 }), assessment: m });
  assert.equal(r.classification, "MODEL_INVALID");
  assert.equal(r.blockers.includes("MODEL_INPUT_DIGEST_MISMATCH"), true);
});

test("exact quoted line requires exact model assessment", () => {
  assert.equal(single({ game: game({ market: "TOTAL", line: 8.5 }), assessment: assessment({ market: "TOTAL", line: 9.5, winProbability: 0.60, pushProbability: null }) }).classification, "MODEL_UNAVAILABLE");
});

test("tiny positive EV remains raw evidence without a Step 9 floor", () => {
  const g = game({ market: "TOTAL", line: 8.5 });
  const m = assessment({ market: "TOTAL", line: 8.5, winProbability: 0.5005, pushProbability: null });
  const out = evaluateMlbMarketEdges({ acquisition: acquisition(g), modelAssessments: [m], now: NOW });
  assert.equal(out.games[0].markets[0].classification, "POSITIVE_EV");
  assert.equal(out.games[0].markets[0].economics.expectedValuePerUnit, 0.001);
  assert.equal(out.policy.fixedEdgeFloorApplied, false);
  assert.equal(out.policy.operatingEnvelopeApplied, false);
  assert.equal(out.policy.eliteLabelProduced, false);
});

test("negative EV is NO_POSITIVE_EV", () => {
  const r = single({ game: game({ market: "F5_TOTAL", line: 4.5 }), assessment: assessment({ market: "F5_TOTAL", line: 4.5, winProbability: 0.49, pushProbability: null }) });
  assert.equal(r.classification, "NO_POSITIVE_EV");
  assert.equal(r.economics.expectedValuePerUnit, -0.02);
});

test("invalid settlement probability mass fails closed", () => {
  assert.equal(single({ game: game({ market: "F5_ML" }), assessment: assessment({ market: "F5_ML", winProbability: 0.80, pushProbability: 0.30 }) }).classification, "MODEL_INVALID");
});

test("nonzero push rejected when half-line cannot push", () => {
  assert.equal(single({ game: game({ market: "TOTAL", line: 8.5 }), assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.52, pushProbability: 0.03 }) }).classification, "MODEL_INVALID");
});

test("reference disagreement remains diagnostic only", () => {
  const g = game({ market: "TOTAL", line: 8.5, selectedOdds: 110, oppositeOdds: -130 });
  g.quoteMarkets[0].reference.quote = referenceQuote({ market: "TOTAL", side: "OVER", line: 8.5, selectedOdds: -150, oppositeOdds: 130 });
  const r = single({ game: g, assessment: assessment({ market: "TOTAL", line: 8.5, winProbability: 0.50, pushProbability: null }) });
  assert.equal(r.classification, "POSITIVE_EV");
  assert.equal(r.economics.referenceAgreement, "OPPOSES_MODEL_EDGE");
});

test("all five model-policy families remain explicit", () => {
  const cases: Array<{ market: MlbMarketEdgeSupportedMarket; line: number | null; push: number | null; win: number }> = [
    { market: "ML", line: null, push: 0.02, win: 0.52 },
    { market: "F5_ML", line: null, push: 0.12, win: 0.48 },
    { market: "RUN_LINE", line: -1.5, push: null, win: 0.49 },
    { market: "TOTAL", line: 8.5, push: null, win: 0.51 },
    { market: "F5_TOTAL", line: 4.5, push: null, win: 0.51 },
  ];
  for (const item of cases) {
    const r = single({ game: game({ market: item.market, line: item.line, selectedOdds: 120, oppositeOdds: -140 }), assessment: assessment({ market: item.market, line: item.line, winProbability: item.win, pushProbability: item.push }) });
    assert.equal(r.model.sourcePolicy, policy(item.market));
    assert.equal(["POSITIVE_EV", "NO_POSITIVE_EV"].includes(r.classification), true);
  }
});

test("duplicate exact model assessments reject", () => {
  const m = assessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null });
  assert.throws(() => evaluateMlbMarketEdges({ acquisition: acquisition(game({ market: "TOTAL", line: 8.5 })), modelAssessments: [m, { ...m }], now: NOW }), (error: any) => error instanceof MlbMarketEdgeInputError && error.code === "DUPLICATE_MODEL_ASSESSMENT");
});

test("Market Edge remains pure post-price evaluation", () => {
  const out = evaluateMlbMarketEdges({ acquisition: acquisition(game({ market: "TOTAL", line: 8.5 })), modelAssessments: [assessment({ market: "TOTAL", line: 8.5, winProbability: 0.53, pushProbability: null })], now: NOW });
  assert.equal(out.schemaVersion, MLB_MARKET_EDGE_SCHEMA);
  assert.equal(out.policy.callsTheOddsApi, false);
  assert.equal(out.policy.theOddsApiCreditsConsumed, 0);
  assert.equal(out.policy.marketRankingProduced, false);
  assert.equal(out.policy.stakeCalculated, false);
  assert.equal(out.policy.providerLastUpdateFreshnessRecheckedAtEvaluation, true);
  assert.equal(out.policy.modelInputDigestRecomputedBeforeEconomics, true);
  assert.equal(out.policy.executionQuoteIdentityRevalidated, true);
  assert.equal(out.policy.automaticBetPlacement, false);
  assert.equal(out.policy.realFinancialExposure, 0);
});
