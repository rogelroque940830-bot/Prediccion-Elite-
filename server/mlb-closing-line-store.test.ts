import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore } from "./mlb-ledger-store";
import { enrichMlbRecordsWithClosingLines, MlbClosingLineStore } from "./mlb-closing-line-store";

function prediction(commenceTime: string) {
  return {
    clientRequestId: "closing-store-prediction-1",
    source: "app" as const,
    model: { name: "CourtEdge MLB", version: "test", environment: "test" },
    game: {
      gamePk: 123,
      gameDate: commenceTime.slice(0, 10),
      commenceTime,
      homeTeam: "Detroit Tigers",
      awayTeam: "Baltimore Orioles",
    },
    market: {
      type: "ML" as const,
      selection: "Detroit Tigers ML",
      oddsAmerican: -140,
      book: "Hard Rock",
      capturedAt: new Date().toISOString(),
    },
    probabilities: { model: 0.62 },
    decision: { signal: "BET" as const, stakeUnits: 1 },
    analysis: { stage: "FINAL" as const },
  };
}

test("closing-line observations are append-only, idempotent and enrich reports", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-closing-store-"));
  const dbPath = path.join(dir, "ledger.sqlite");
  const ledger = new MlbLedgerStore(dbPath);
  const commenceTime = "2026-08-01T23:10:00.000Z";
  const saved = ledger.appendPrediction(prediction(commenceTime)).data;
  const closing = new MlbClosingLineStore(dbPath);

  const input = {
    clientRequestId: `auto-close:${saved.id}:T15:hardrockbet_fl:h2h`,
    checkpoint: "T15" as const,
    quoteAt: "2026-08-01T23:00:00.000Z",
    commenceTime,
    source: "THE_ODDS_API" as const,
    sourceEventId: "odds-event-1",
    bookmakerKey: "hardrockbet_fl",
    bookmakerTitle: "Hard Rock Bet",
    matchMode: "EXACT_BOOK" as const,
    marketKey: "h2h",
    selection: "Detroit Tigers",
    line: null,
    oddsAmerican: -160,
    ticketOddsAmerican: -140,
    ticketLine: null,
    comparable: true,
  };
  const first = closing.appendObservation(saved.id, input);
  const second = closing.appendObservation(saved.id, input);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.data.clvPp, 3.205128);
  assert.equal(first.data.matchMode, "EXACT_BOOK");
  assert.equal(closing.latestBeforeCommence(saved.id, commenceTime)?.oddsAmerican, -160);

  ledger.appendSettlement(saved.id, {
    clientRequestId: `settle:${saved.id}`,
    result: "WIN",
    source: "official",
  });
  const enriched = enrichMlbRecordsWithClosingLines(ledger.listRecords(), closing);
  assert.equal(enriched[0].settlement?.closingOddsAmerican, -160);
  assert.equal(enriched[0].settlement?.clvPp, 3.205128);
  assert.equal(closing.status().observations, 1);

  closing.close();
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a later proxy never replaces the last exact-book close", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-closing-preference-"));
  const dbPath = path.join(dir, "ledger.sqlite");
  const ledger = new MlbLedgerStore(dbPath);
  const commenceTime = "2026-08-02T23:10:00.000Z";
  const saved = ledger.appendPrediction({ ...prediction(commenceTime), clientRequestId: "closing-store-prediction-preference" }).data;
  const closing = new MlbClosingLineStore(dbPath);
  closing.appendObservation(saved.id, {
    clientRequestId: `close:${saved.id}:T60:hardrockbet_fl`, checkpoint: "T60",
    quoteAt: "2026-08-02T22:20:00.000Z", commenceTime, source: "THE_ODDS_API",
    sourceEventId: "event-preference", bookmakerKey: "hardrockbet_fl", bookmakerTitle: "Hard Rock Bet",
    matchMode: "EXACT_BOOK", marketKey: "h2h", selection: "Detroit Tigers", line: null,
    oddsAmerican: -150, ticketOddsAmerican: -140, ticketLine: null, comparable: true,
  });
  closing.appendObservation(saved.id, {
    clientRequestId: `close:${saved.id}:T15:fanduel`, checkpoint: "T15",
    quoteAt: "2026-08-02T23:00:00.000Z", commenceTime, source: "THE_ODDS_API",
    sourceEventId: "event-preference", bookmakerKey: "fanduel", bookmakerTitle: "FanDuel",
    matchMode: "PROXY_BOOK", marketKey: "h2h", selection: "Detroit Tigers", line: null,
    oddsAmerican: -165, ticketOddsAmerican: -140, ticketLine: null, comparable: true,
  });
  const preferred = closing.latestBeforeCommence(saved.id, commenceTime);
  assert.equal(preferred?.matchMode, "EXACT_BOOK");
  assert.equal(preferred?.bookmakerKey, "hardrockbet_fl");
  assert.equal(preferred?.oddsAmerican, -150);
  closing.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("proxy observations remain visible but are not injected as exact CLV", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-closing-proxy-"));
  const dbPath = path.join(dir, "ledger.sqlite");
  const ledger = new MlbLedgerStore(dbPath);
  const commenceTime = "2026-08-02T23:10:00.000Z";
  const saved = ledger.appendPrediction({ ...prediction(commenceTime), clientRequestId: "closing-store-prediction-2" }).data;
  const closing = new MlbClosingLineStore(dbPath);
  closing.appendObservation(saved.id, {
    clientRequestId: `auto-close:${saved.id}:T60:fanduel:h2h`,
    checkpoint: "T60",
    quoteAt: "2026-08-02T22:20:00.000Z",
    commenceTime,
    source: "THE_ODDS_API",
    sourceEventId: "odds-event-2",
    bookmakerKey: "fanduel",
    bookmakerTitle: "FanDuel",
    matchMode: "PROXY_BOOK",
    marketKey: "h2h",
    selection: "Detroit Tigers",
    line: null,
    oddsAmerican: -155,
    ticketOddsAmerican: -140,
    ticketLine: null,
    comparable: true,
  });
  ledger.appendSettlement(saved.id, { clientRequestId: `settle:${saved.id}`, result: "WIN", source: "official" });
  const enriched = enrichMlbRecordsWithClosingLines(ledger.listRecords(), closing);
  assert.equal(enriched[0].settlement?.closingOddsAmerican, null);
  assert.equal(enriched[0].settlement?.clvPp, null);
  closing.close();
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
