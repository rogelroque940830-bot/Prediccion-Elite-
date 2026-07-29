import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore } from "./mlb-ledger-store";
import { MlbClosingLineStore } from "./mlb-closing-line-store";
import {
  closingCaptureDateWindow,
  closingCheckpointFor,
  closingMarketForPrediction,
  runMlbClosingLineCapture,
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

test("capture scans a bounded current date window instead of the oldest ledger rows", () => {
  assert.deepEqual(
    closingCaptureDateWindow(Date.parse("2026-07-29T23:30:00.000Z")),
    { from: "2026-07-28", to: "2026-07-31" },
  );
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

test("quote selection falls through when the first exact alias lacks the requested market", () => {
  const f5Event = {
    ...event,
    bookmakers: [
      { key: "hardrockbet_fl", title: "Hard Rock Florida", markets: [] },
      { key: "hardrockbet", title: "Hard Rock Bet", markets: [{
        key: "h2h_1st_5_innings", last_update: "2026-07-29T22:49:00.000Z",
        outcomes: [{ name: "Detroit Tigers", price: -150 }, { name: "Baltimore Orioles", price: 130 }],
      }] },
      { key: "fanduel", title: "FanDuel", markets: [{
        key: "h2h_1st_5_innings", outcomes: [{ name: "Detroit Tigers", price: -145 }],
      }] },
    ],
  };
  const f5 = prediction({ market: { ...prediction().market, type: "F5_ML" } });
  const quote = selectClosingQuote(f5Event, f5, "h2h_1st_5_innings");
  assert.ok(quote);
  assert.equal(quote.bookmakerKey, "hardrockbet");
  assert.equal(quote.matchMode, "EXACT_BOOK");
  assert.equal(quote.oddsAmerican, -150);
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


test("a transient F5 provider failure remains retryable within the same checkpoint", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-closing-retry-"));
  const dbPath = path.join(dir, "ledger.sqlite");
  const ledger = new MlbLedgerStore(dbPath);
  const closing = new MlbClosingLineStore(dbPath);
  const commenceMs = Date.now() + 10 * 60 * 1000;
  const commenceTime = new Date(commenceMs).toISOString();
  const saved = ledger.appendPrediction({
    clientRequestId: `retry-pick-${Date.now()}`,
    source: "app",
    model: { name: "CourtEdge MLB", version: "test", environment: "test" },
    game: { gamePk: 555, gameDate: commenceTime.slice(0, 10), commenceTime, homeTeam: "Detroit Tigers", awayTeam: "Baltimore Orioles" },
    market: { type: "F5_ML", selection: "Detroit Tigers F5", oddsAmerican: -140, book: "Hard Rock", capturedAt: new Date().toISOString() },
    probabilities: { model: 0.62 },
    decision: { signal: "BET", stakeUnits: 1 },
    analysis: { stage: "FINAL" },
  }).data;
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.ODDS_API_KEY;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify([{
        id: "1234567890abcdef1234567890abcdef",
        commence_time: commenceTime,
        home_team: "Detroit Tigers",
        away_team: "Baltimore Orioles",
      }]), { status: 200, headers: { "content-type": "application/json", "x-requests-remaining": "100" } });
    }
    return new Response(JSON.stringify({ message: "temporary provider failure" }), {
      status: 503,
      headers: { "content-type": "application/json", "x-requests-remaining": "99" },
    });
  };
  process.env.ODDS_API_KEY = "test-key";
  try {
    const summary = await runMlbClosingLineCapture(ledger, closing, commenceMs - 10 * 60 * 1000);
    assert.equal(summary.errors.length, 1);
    assert.equal(closing.hasAttempt(saved.id, "T15"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey == null) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = previousKey;
    closing.close();
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
