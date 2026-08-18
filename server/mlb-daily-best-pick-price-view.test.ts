import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbDailyBestPickPriceView } from "./mlb-daily-best-pick-price-view";

const DATE = "2026-08-18";
const RUN = "run-price-view";

function dailyPick(input: {
  market?: "FIRST_5_ML" | "FULL_GAME_ML";
  tier?: "A_PLUS" | "PREMIUM";
  gamePk?: number;
} = {}) {
  const market = input.market ?? "FIRST_5_ML";
  return {
    schemaVersion: "courtedge-mlb-daily-best-pick-ui.v1",
    decision: "BEST_PICK",
    pick: {
      gamePk: input.gamePk ?? 123,
      awayTeam: "Away",
      homeTeam: "Home",
      market,
      side: "HOME",
      route: market === "FIRST_5_ML" ? "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1" : "PREMIUM_A_HOME_ML",
      tier: input.tier ?? (market === "FIRST_5_ML" ? "A_PLUS" : "PREMIUM"),
      prepriceRank: 0,
    },
    audit: {
      readyAPlusEvaluations: market === "FIRST_5_ML" ? 1 : 0,
      readyPremiumEvaluations: market === "FULL_GAME_ML" ? 1 : 0,
      provisionalRowsSkipped: 0,
      frozenRouteMatchesOutsideRankedPreprice: 0,
    },
    policy: {
      trustedUnifiedPrepriceRuntimeOnly: true,
      finalFrozenInputsOnly: true,
      aPlusAlwaysPrecedesPremium: true,
      existingPrepriceRankPreservedWithinTier: true,
      generalV68FallbackAllowed: false,
      v80Read: false,
      v80Changed: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  } as any;
}

function noPlay() {
  return {
    ...dailyPick(),
    decision: "NO_PLAY",
    pick: null,
  } as any;
}

function envelopeMarket(input: {
  marketType?: "F5_ML" | "ML";
  classification?: "ELITE_EVIDENCE_CANDIDATE" | "POSITIVE_EV_ENVELOPE_BLOCKED" | "NO_POSITIVE_EV" | "UPSTREAM_BLOCKED";
  providerMarketKey?: string;
  side?: "HOME" | "AWAY";
} = {}) {
  return {
    marketType: input.marketType ?? "F5_ML",
    providerMarketKey: input.providerMarketKey ?? "h2h_1st_5_innings",
    selectedSide: input.side ?? "HOME",
    selectedLine: null,
    classification: input.classification ?? "ELITE_EVIDENCE_CANDIDATE",
    eliteEvidenceCandidate: (input.classification ?? "ELITE_EVIDENCE_CANDIDATE") === "ELITE_EVIDENCE_CANDIDATE",
    intrinsicProjectionScope: input.marketType === "ML" ? "FULL_GAME" : "FIRST_5",
    intrinsicThesisKinds: ["HOME_SIDE"],
    supportingComponents: ["FROZEN_ROUTE"],
    modelWinProbability: 0.61,
    modelPushProbability: input.marketType === "ML" ? 0 : 0.08,
    expectedValuePerUnit: input.classification === "NO_POSITIVE_EV" ? -0.02 : 0.05,
    executionEdgePp: 3.2,
    executionNoVigEdgePp: 2.8,
    referenceNoVigEdgePp: 2.4,
    referenceAgreement: "SUPPORTS_MODEL_EDGE",
    blockers: input.classification === "POSITIVE_EV_ENVELOPE_BLOCKED" ? ["UPSTREAM_ENVELOPE_BLOCK"] : [],
    warnings: [],
  } as any;
}

function edgeMarket(input: {
  marketType?: "F5_ML" | "ML";
  providerMarketKey?: string;
  side?: "HOME" | "AWAY";
  withExecution?: boolean;
} = {}) {
  return {
    marketType: input.marketType ?? "F5_ML",
    providerMarketKey: input.providerMarketKey ?? "h2h_1st_5_innings",
    intrinsicProjectionScope: input.marketType === "ML" ? "FULL_GAME" : "FIRST_5",
    intrinsicThesisKinds: ["HOME_SIDE"],
    supportingComponents: ["FROZEN_ROUTE"],
    selectedSide: input.side ?? "HOME",
    selectedLine: null,
    classification: "POSITIVE_EV",
    eligibleForOperatingEnvelope: true,
    model: {
      status: "READY",
      sourcePolicy: "ML_F5_EDGE_CONFIDENCE_V2",
      modelVersion: "fixture",
      generatedAt: "2026-08-18T17:00:00.000Z",
      modelInputDigest: "a".repeat(64),
      winProbability: 0.61,
      pushProbability: 0.08,
      lossProbability: 0.31,
      decisiveWinProbability: 0.663,
      pushProbabilityDerivedAsZero: false,
    },
    execution: input.withExecution === false ? null : {
      bookKey: "book-a",
      bookTitle: "Book A",
      selectedSide: input.side ?? "HOME",
      selectedSelection: "Home",
      line: null,
      selectedOddsAmerican: -105,
      oppositeOddsAmerican: -115,
      selectedImpliedProbability: 0.512,
      oppositeImpliedProbability: 0.535,
      noVigDecisiveProbability: 0.489,
      capturedAt: "2026-08-18T17:00:30.000Z",
      providerLastUpdate: "2026-08-18T17:00:20.000Z",
    },
    reference: null,
    economics: {
      fairPrice: null,
      currentBreakEvenWinProbability: 0.512,
      executionEdgePp: 3.2,
      executionNoVigEdgePp: 2.8,
      referenceNoVigEdgePp: 2.4,
      expectedValuePerUnit: 0.05,
      referenceAgreement: "SUPPORTS_MODEL_EDGE",
    },
    blockers: [],
    warnings: [],
  } as any;
}

function priced(input: {
  envelopeMarkets?: any[];
  edgeMarkets?: any[];
  otherGames?: any[];
  policy?: Record<string, unknown>;
  envelopePolicy?: Record<string, unknown>;
  sourceRunId?: string;
} = {}) {
  const sourceRunId = input.sourceRunId ?? RUN;
  const otherGames = input.otherGames ?? [];
  return {
    schemaVersion: "courtedge-p0-mlb-unified-priced-v16-runner.v1",
    runId: RUN,
    generatedAt: "2026-08-18T17:01:00.000Z",
    date: DATE,
    preprice: { runId: RUN, date: DATE },
    marketEdge: {
      sourceRunId,
      games: [
        { gamePk: 123, markets: input.edgeMarkets ?? [edgeMarket()] },
        ...otherGames.map((row) => ({ gamePk: row.gamePk, markets: row.edgeMarkets ?? [] })),
      ],
    },
    operatingEnvelope: {
      sourceRunId,
      games: [
        { gamePk: 123, markets: input.envelopeMarkets ?? [envelopeMarket()] },
        ...otherGames.map((row) => ({ gamePk: row.gamePk, markets: row.envelopeMarkets ?? [] })),
      ],
      policy: {
        fixedEvThresholdApplied: false,
        fixedProbabilityThresholdApplied: false,
        marketRankingProduced: false,
        numericEliteScoreProduced: false,
        finalBetRecommendationProduced: false,
        betEliteLabelProduced: false,
        stakeCalculated: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
        ...input.envelopePolicy,
      },
    },
    policy: {
      v16PriceIndependent: true,
      discoveryPlanMutatedBeforeOddsAcquisition: false,
      priceCanCreateIntrinsicThesis: false,
      additionalEliteFilterApplied: false,
      betEliteProduced: false,
      finalBetRecommendationProduced: false,
      stakeCalculated: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
      ...input.policy,
    },
  } as any;
}

test("A+ First 5 BEST PICK exposes only its exact Elite price evidence", () => {
  const result = buildMlbDailyBestPickPriceView({ priced: priced(), dailyBestPick: dailyPick() });
  assert.equal(result.decision, "ELITE_EVIDENCE_CANDIDATE");
  assert.equal(result.pick?.canonicalMarketType, "F5_ML");
  assert.equal(result.pick?.gamePk, 123);
  assert.equal(result.execution?.bookTitle, "Book A");
  assert.equal(result.execution?.oddsAmerican, -105);
  assert.equal(result.economics?.expectedValuePerUnit, 0.05);
  assert.equal(result.audit.exactEnvelopeMarketMatches, 1);
  assert.equal(result.audit.exactMarketEdgeMatches, 1);
  assert.equal(result.policy.sportingSelectionChangedByPrice, false);
  assert.equal(result.policy.betEliteLabelProduced, false);
  assert.equal(result.policy.finalBetRecommendationProduced, false);
});

test("Premium Full Game BEST PICK maps only to canonical ML", () => {
  const result = buildMlbDailyBestPickPriceView({
    dailyBestPick: dailyPick({ market: "FULL_GAME_ML", tier: "PREMIUM" }),
    priced: priced({
      envelopeMarkets: [envelopeMarket({ marketType: "ML", providerMarketKey: "h2h" })],
      edgeMarkets: [edgeMarket({ marketType: "ML", providerMarketKey: "h2h" })],
    }),
  });
  assert.equal(result.decision, "ELITE_EVIDENCE_CANDIDATE");
  assert.equal(result.pick?.canonicalMarketType, "ML");
  assert.equal(result.pick?.market, "FULL_GAME_ML");
});

test("NO_PLAY never crosses into a price decision", () => {
  const result = buildMlbDailyBestPickPriceView({ priced: priced(), dailyBestPick: noPlay() });
  assert.equal(result.decision, "NOT_APPLICABLE");
  assert.equal(result.pick, null);
  assert.equal(result.execution, null);
  assert.equal(result.economics, null);
});

test("NO_POSITIVE_EV stays attached to the same BEST PICK and never falls back to another game", () => {
  const result = buildMlbDailyBestPickPriceView({
    dailyBestPick: dailyPick(),
    priced: priced({
      envelopeMarkets: [envelopeMarket({ classification: "NO_POSITIVE_EV" })],
      otherGames: [{
        gamePk: 999,
        envelopeMarkets: [envelopeMarket({ classification: "ELITE_EVIDENCE_CANDIDATE" })],
        edgeMarkets: [edgeMarket()],
      }],
    }),
  });
  assert.equal(result.decision, "NO_POSITIVE_EV");
  assert.equal(result.pick?.gamePk, 123);
  assert.equal(result.audit.otherGameMarketsIgnored, 1);
  assert.equal(result.policy.fallbackToAnotherGameAllowed, false);
});

test("missing exact market returns PRICE_EVIDENCE_UNAVAILABLE and does not switch markets", () => {
  const result = buildMlbDailyBestPickPriceView({
    dailyBestPick: dailyPick(),
    priced: priced({
      envelopeMarkets: [envelopeMarket({ marketType: "ML", providerMarketKey: "h2h" })],
      edgeMarkets: [edgeMarket({ marketType: "ML", providerMarketKey: "h2h" })],
    }),
  });
  assert.equal(result.decision, "PRICE_EVIDENCE_UNAVAILABLE");
  assert.equal(result.execution, null);
  assert.deepEqual(result.blockers, ["EXACT_DAILY_BEST_PICK_MARKET_NOT_IN_OPERATING_ENVELOPE"]);
  assert.equal(result.policy.fallbackToAnotherMarketAllowed, false);
});

test("positive EV blocked by the existing envelope is visible but cannot become BET_ELITE", () => {
  const result = buildMlbDailyBestPickPriceView({
    dailyBestPick: dailyPick(),
    priced: priced({ envelopeMarkets: [envelopeMarket({ classification: "POSITIVE_EV_ENVELOPE_BLOCKED" })] }),
  });
  assert.equal(result.decision, "POSITIVE_EV_ENVELOPE_BLOCKED");
  assert.deepEqual(result.blockers, ["UPSTREAM_ENVELOPE_BLOCK"]);
  assert.equal(result.policy.betEliteLabelProduced, false);
  assert.equal(result.policy.stakeCalculated, false);
});

test("duplicate exact envelope market fails closed instead of choosing one", () => {
  assert.throws(
    () => buildMlbDailyBestPickPriceView({
      dailyBestPick: dailyPick(),
      priced: priced({ envelopeMarkets: [envelopeMarket(), envelopeMarket()] }),
    }),
    /MLB_DAILY_BEST_PICK_PRICE_AMBIGUOUS_ENVELOPE_MARKET/,
  );
});

test("priced source run mismatch fails closed", () => {
  assert.throws(
    () => buildMlbDailyBestPickPriceView({ dailyBestPick: dailyPick(), priced: priced({ sourceRunId: "wrong-run" }) }),
    /MLB_DAILY_BEST_PICK_PRICE_PRICED_RUN_ID_MISMATCH/,
  );
});

test("a future policy that produces BET_ELITE is rejected by this visibility layer", () => {
  assert.throws(
    () => buildMlbDailyBestPickPriceView({
      dailyBestPick: dailyPick(),
      priced: priced({ policy: { betEliteProduced: true } }),
    }),
    /MLB_DAILY_BEST_PICK_PRICE_RUNNER_POLICY_VIOLATION/,
  );
});

test("new fixed EV or probability thresholds are rejected", () => {
  assert.throws(
    () => buildMlbDailyBestPickPriceView({
      dailyBestPick: dailyPick(),
      priced: priced({ envelopePolicy: { fixedEvThresholdApplied: true } }),
    }),
    /MLB_DAILY_BEST_PICK_PRICE_ENVELOPE_POLICY_VIOLATION/,
  );
  assert.throws(
    () => buildMlbDailyBestPickPriceView({
      dailyBestPick: dailyPick(),
      priced: priced({ envelopePolicy: { fixedProbabilityThresholdApplied: true } }),
    }),
    /MLB_DAILY_BEST_PICK_PRICE_ENVELOPE_POLICY_VIOLATION/,
  );
});
