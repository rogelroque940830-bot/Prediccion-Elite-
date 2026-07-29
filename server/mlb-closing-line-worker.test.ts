import assert from "node:assert/strict";
import test from "node:test";
import {
  closingCheckpointFor,
  closingMarketForPrediction,
  selectClosingQuote,
  validClosingQuoteTiming,
} from "./mlb-closing-line-worker";

function prediction(overrides: any = {}) {
  return {
    id: "pred-1",
    clientRequestId: "request-1",
    recordedAt: "2026-07-29T12:00:00.000Z",
    recordedAtMs: Date.parse("2026-07-29T12:00:00.000Z"),
    game: {
      gamePk: 1,
      gameDate: "2026-07-29",
      commenceTime: "2026-07-29T23:00:00.000Z",
      homeTeam: "Detroit Tigers",
      awayTeam: "Baltimore Orioles",
    },
    market: {
      type: "ML",
      selection: "Detroit Tigers ML",
      line: null,
      oddsAmerican: -140,
      book: "Hard Rock",
    },
    probabilities: { model: 0.62, marketImplied: 0.583333, noVig: null, edgePp: 3.67 },
    decision: { signal: "BET", confidenceLabel: "A", confidencePct: 62, stakeUnits: 1 },
    analysisStage: "FINAL",
    model: { name: "CourtEdge MLB", version: "test", gitCommit: null, environment: "test" },
    supersedesId: null,
    source: "app",
    payloadSha256: "sha",
    payload: {},
    ...overrides,
  } as any;
}

const event = {
  id: "odds-event-1",
  commence_time: "2026-07-29T23:00:00.000Z",
  home_team: "Detroit Tigers",
  away_team: "Baltimore Orioles",
  bookmakers: [
    {
      key: "hardrockbet_fl",
      title: "Hard Rock Bet",
      last_update: "2026-07-29T22:48:00.000Z",
      markets: [
        {
          key: "h2h",
          last_update: "2026-07-29T22:49:00.000Z",
          outcomes: [
            { name: "Detroit Tigers", price: -160 },
            { name: "Baltimore Orioles", price: 140 },
          ],
        },
        {
          key: "totals",
          last_update: "2026-07-29T22:49:00.000Z",
          outcomes: [
            { name: "Over", price: -115, point: 8.5 },
            { name: "Under", price: -105, point: 8.5 },
          ],
        },
      ],
    },
    {
      key: "fanduel",
      title: "FanDuel",
      last_update: "2026-07-29T22:49:00.000Z",
      markets: [{ key: "h2h", outcomes: [{ name: "Detroit Tigers", price: -158 }, { name: "Baltimore Orioles", price: 138 }] }],
    },
  ],
};

test("capture checkpoints are conservative and deterministic", () => {
  const commence = "2026-07-29T23:00:00.000Z";
  assert.equal(closingCheckpointFor(Date.parse("2026-07-29T19:59:00.000Z"), commence), null);
  assert.equal(closingCheckpointFor(Date.parse("2026-07-29T20:10:00.000Z"), commence), "T180");
  assert.equal(closingCheckpointFor(Date.parse("2026-07-29T22:10:00.000Z"), commence), "T60");
  assert.equal(closingCheckpointFor(Date.parse("2026-07-29T22:50:00.000Z"), commence), "T15");
  assert.equal(closingCheckpointFor(Date.parse("2026-07-29T23:00:00.000Z"), commence), null);
});

test("closing quotes must be newer than the saved pick and no later than first pitch", () => {
  const recordedAtMs = Date.parse("2026-07-29T22:00:00.000Z");
  const commence = "2026-07-29T23:00:00.000Z";
  assert.equal(validClosingQuoteTiming(recordedAtMs, "2026-07-29T21:59:59.000Z", commence), false);
  assert.equal(validClosingQuoteTiming(recordedAtMs, "2026-07-29T22:49:00.000Z", commence), true);
  assert.equal(validClosingQuoteTiming(recordedAtMs, "2026-07-29T23:00:01.000Z", commence), false);
});

test("market mapping never substitutes full-game moneyline for F5", () => {
  assert.deepEqual(closingMarketForPrediction(prediction()), { marketKey: "h2h", featured: true });
  assert.deepEqual(
    closingMarketForPrediction(prediction({ market: { ...prediction().market, type: "F5_ML" } })),
    { marketKey: "h2h_1st_5_innings", featured: false },
  );
  assert.equal(
    closingMarketForPrediction(prediction({ market: { ...prediction().market, type: "TEAM_TOTAL" } })),
    null,
  );
});

test("quote selection prefers the exact ticket book and selected outcome", () => {
  const quote = selectClosingQuote(event, prediction(), "h2h");
  assert.ok(quote);
  assert.equal(quote.bookmakerKey, "hardrockbet_fl");
  assert.equal(quote.matchMode, "EXACT_BOOK");
  assert.equal(quote.oddsAmerican, -160);
  assert.equal(quote.comparable, true);
  assert.equal(quote.quoteAt, "2026-07-29T22:49:00.000Z");
});

test("different totals lines report line CLV instead of fake probability CLV", () => {
  const over = prediction({
    market: {
      type: "TOTAL",
      selection: "Over 8",
      line: 8,
      oddsAmerican: -110,
      book: "Hard Rock",
    },
  });
  const quote = selectClosingQuote(event, over, "totals");
  assert.ok(quote);
  assert.equal(quote.line, 8.5);
  assert.equal(quote.comparable, false);
  assert.equal(quote.lineClv, 0.5);
});

test("consensus tickets use a clearly labeled proxy book", () => {
  const consensus = prediction({ market: { ...prediction().market, book: "Consensus FD/BetMGM/DK" } });
  const quote = selectClosingQuote(event, consensus, "h2h");
  assert.ok(quote);
  assert.equal(quote.matchMode, "PROXY_BOOK");
  assert.equal(quote.bookmakerKey, "hardrockbet_fl");
});
