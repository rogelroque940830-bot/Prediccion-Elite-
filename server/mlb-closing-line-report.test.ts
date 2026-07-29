import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore } from "./mlb-ledger-store";
import { MlbClosingLineStore } from "./mlb-closing-line-store";
import { buildMlbClosingLineReport } from "./mlb-closing-line-report";

function input(id: string, commenceTime: string, marketType: "ML" | "F5_ML" = "ML") {
  return {
    clientRequestId: id,
    source: "app" as const,
    model: { name: "CourtEdge MLB", version: "test", environment: "test" },
    game: {
      gamePk: 100,
      gameDate: commenceTime.slice(0, 10),
      commenceTime,
      homeTeam: "Detroit Tigers",
      awayTeam: "Baltimore Orioles",
    },
    market: {
      type: marketType,
      selection: `Detroit Tigers ${marketType}`,
      oddsAmerican: -140,
      book: "Hard Rock",
      capturedAt: "2026-08-01T18:00:00.000Z",
    },
    probabilities: { model: 0.62 },
    decision: { signal: "BET" as const, stakeUnits: 1 },
    analysis: { stage: "FINAL" as const },
  };
}

test("C2D reports historical picks as unavailable without inventing a close", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-closing-report-"));
  const dbPath = path.join(dir, "ledger.sqlite");
  const ledger = new MlbLedgerStore(dbPath);
  const close = new MlbClosingLineStore(dbPath);
  ledger.appendPrediction(input("old-pick", "2026-08-01T23:00:00.000Z"));
  const report = buildMlbClosingLineReport(
    ledger.listRecords(),
    close,
    Date.parse("2026-08-02T01:00:00.000Z"),
  );
  assert.equal(report.summary.final, 0);
  assert.equal(report.summary.unavailable, 1);
  assert.equal(report.summary.averageExactClvPp, null);
  assert.equal(report.methodology.historicalBackfill, false);
  close.close();
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("C2D finalizes the latest valid pregame observation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlb-closing-final-"));
  const dbPath = path.join(dir, "ledger.sqlite");
  const ledger = new MlbLedgerStore(dbPath);
  const close = new MlbClosingLineStore(dbPath);
  const commence = "2026-08-03T23:00:00.000Z";
  const saved = ledger.appendPrediction(input("future-pick", commence)).data;
  for (const [checkpoint, quoteAt, odds] of [
    ["T180", "2026-08-03T20:10:00.000Z", -145],
    ["T60", "2026-08-03T22:10:00.000Z", -150],
    ["T15", "2026-08-03T22:50:00.000Z", -160],
  ] as const) {
    close.appendObservation(saved.id, {
      clientRequestId: `close:${saved.id}:${checkpoint}`,
      checkpoint,
      quoteAt,
      commenceTime: commence,
      source: "THE_ODDS_API",
      sourceEventId: "event-100",
      bookmakerKey: "hardrockbet_fl",
      bookmakerTitle: "Hard Rock Bet",
      matchMode: "EXACT_BOOK",
      marketKey: "h2h",
      selection: "Detroit Tigers",
      line: null,
      oddsAmerican: odds,
      ticketOddsAmerican: -140,
      ticketLine: null,
      comparable: true,
    });
  }
  const report = buildMlbClosingLineReport(
    ledger.listRecords(),
    close,
    Date.parse("2026-08-04T01:00:00.000Z"),
  );
  assert.equal(report.summary.final, 1);
  assert.equal(report.summary.exactBookMeasured, 1);
  assert.equal(report.summary.quality.verified, 1);
  assert.equal(report.rows[0].observation?.checkpoint, "T15");
  assert.equal(report.rows[0].observation?.oddsAmerican, -160);
  assert.equal(report.rows[0].observation?.clvPp, 3.205128);
  close.close();
  ledger.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
