import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
  presentMlbDailyBestPickPrice,
} from "./mlb-daily-best-pick-price";

const policy = {
  trustedPricedV16RuntimeOnly: true,
  exactDailyBestPickIdentityOnly: true,
  sportingSelectionChangedByPrice: false,
  fallbackToAnotherGameAllowed: false,
  fallbackToAnotherMarketAllowed: false,
  newThresholdAdded: false,
  fixedEvThresholdAdded: false,
  fixedProbabilityThresholdAdded: false,
  betEliteLabelProduced: false,
  finalBetRecommendationProduced: false,
  stakeCalculated: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
} as const;

const audit = {
  exactEnvelopeMarketMatches: 1,
  exactMarketEdgeMatches: 1,
  otherGameMarketsIgnored: 2,
  otherSelectedGameMarketsIgnored: 1,
};

function elite(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: MLB_DAILY_BEST_PICK_PRICE_VIEW_SCHEMA,
    decision: "ELITE_EVIDENCE_CANDIDATE",
    pick: {
      gamePk: 123,
      market: "FIRST_5_ML",
      canonicalMarketType: "F5_ML",
      side: "HOME",
      route: "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1",
      tier: "A_PLUS",
      prepriceRank: 0,
    },
    execution: {
      bookKey: "book-a",
      bookTitle: "Book A",
      oddsAmerican: -105,
      capturedAt: "2026-08-18T17:00:30.000Z",
      providerLastUpdate: "2026-08-18T17:00:20.000Z",
    },
    economics: {
      modelWinProbability: 0.61,
      modelPushProbability: 0.08,
      expectedValuePerUnit: 0.05,
      executionEdgePp: 3.2,
      executionNoVigEdgePp: 2.8,
      referenceNoVigEdgePp: 2.4,
      referenceAgreement: "SUPPORTS_MODEL_EDGE",
    },
    blockers: [],
    warnings: [],
    audit,
    policy,
    ...overrides,
  };
}

test("Elite price evidence is visible without producing BET_ELITE", () => {
  const display = presentMlbDailyBestPickPrice(elite());
  assert.equal(display.state, "ELITE_EVIDENCE_CANDIDATE");
  assert.equal(display.executionLabel, "Book A -105");
  assert.equal(display.modelProbabilityLabel, "61.0%");
  assert.equal(display.evLabel, "5.0%");
  assert.equal(display.edgeLabel, "+3.20 pp");
  assert.match(display.message, /no produce BET_ELITE/i);
});

test("NO_POSITIVE_EV keeps the sporting prediction but blocks price", () => {
  const display = presentMlbDailyBestPickPrice(elite({
    decision: "NO_POSITIVE_EV",
    economics: {
      ...elite().economics,
      expectedValuePerUnit: -0.02,
    },
  }));
  assert.equal(display.state, "NO_POSITIVE_EV");
  assert.match(display.title, /SIN EV POSITIVO/);
  assert.match(display.message, /predicción deportiva se conserva/i);
});

test("positive EV envelope block never substitutes another game", () => {
  const display = presentMlbDailyBestPickPrice(elite({
    decision: "POSITIVE_EV_ENVELOPE_BLOCKED",
    blockers: ["UPSTREAM_ENVELOPE_BLOCK"],
  }));
  assert.equal(display.state, "POSITIVE_EV_ENVELOPE_BLOCKED");
  assert.match(display.message, /No se sustituye por otro juego/i);
  assert.deepEqual(display.blockers, ["UPSTREAM_ENVELOPE_BLOCK"]);
});

test("exact price evidence unavailable renders no fallback", () => {
  const display = presentMlbDailyBestPickPrice(elite({
    decision: "PRICE_EVIDENCE_UNAVAILABLE",
    execution: null,
    economics: null,
    blockers: ["EXACT_DAILY_BEST_PICK_MARKET_NOT_IN_OPERATING_ENVELOPE"],
  }));
  assert.equal(display.state, "PRICE_EVIDENCE_UNAVAILABLE");
  assert.equal(display.executionLabel, null);
  assert.match(display.message, /No se usa otro juego ni otro mercado/i);
});

test("NO PLAY makes price check not applicable", () => {
  const display = presentMlbDailyBestPickPrice(elite({
    decision: "NOT_APPLICABLE",
    pick: null,
    execution: null,
    economics: null,
  }));
  assert.equal(display.state, "NOT_APPLICABLE");
  assert.match(display.title, /NO APLICA/);
});

test("future BET_ELITE or threshold policy fails closed in the browser", () => {
  assert.equal(
    presentMlbDailyBestPickPrice(elite({ policy: { ...policy, betEliteLabelProduced: true } })).state,
    "UNAVAILABLE",
  );
  assert.equal(
    presentMlbDailyBestPickPrice(elite({ policy: { ...policy, fixedEvThresholdAdded: true } })).state,
    "UNAVAILABLE",
  );
});

test("wrong canonical market identity fails closed", () => {
  const value = elite();
  value.pick = { ...value.pick, canonicalMarketType: "ML" } as typeof value.pick;
  assert.equal(presentMlbDailyBestPickPrice(value).state, "UNAVAILABLE");
});

test("AWAY side is rejected because the frozen Daily routes are HOME-only", () => {
  const value = elite();
  value.pick = { ...value.pick, side: "AWAY" } as typeof value.pick;
  assert.equal(presentMlbDailyBestPickPrice(value).state, "UNAVAILABLE");
});
