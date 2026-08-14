import assert from "node:assert/strict";
import test from "node:test";
import {
  americanOddsToImpliedProbability,
  consensusAmericanOdds,
  isStandardAmericanOdds,
} from "./american-odds";
import {
  buildMlbF5ConsensusGame,
  MLB_F5_CONSENSUS_METHOD,
  MLB_F5_ODDS_SCHEMA_VERSION,
} from "./mlb-f5-odds-routes";
import { validAmericanOdds } from "./mlb-s5c-shadow-ingestion";

const CAPTURED_AT = "2026-07-31T22:30:00.000Z";

function book(
  key: string,
  title: string,
  lastUpdate: string,
  prices: {
    mlHome?: number;
    mlAway?: number;
    totalLine?: number;
    totalOver?: number;
    totalUnder?: number;
    spreadLine?: number;
    spreadHome?: number;
    spreadAway?: number;
  },
) {
  const markets: any[] = [];
  if (prices.mlHome != null && prices.mlAway != null) {
    markets.push({
      key: "h2h_1st_5_innings",
      outcomes: [
        { name: "Home Team", price: prices.mlHome },
        { name: "Away Team", price: prices.mlAway },
      ],
    });
  }
  if (prices.totalLine != null && prices.totalOver != null && prices.totalUnder != null) {
    markets.push({
      key: "totals_1st_5_innings",
      outcomes: [
        { name: "Over", point: prices.totalLine, price: prices.totalOver },
        { name: "Under", point: prices.totalLine, price: prices.totalUnder },
      ],
    });
  }
  if (prices.spreadLine != null && prices.spreadHome != null && prices.spreadAway != null) {
    markets.push({
      key: "spreads_1st_5_innings",
      outcomes: [
        { name: "Home Team", point: prices.spreadLine, price: prices.spreadHome },
        { name: "Away Team", point: -prices.spreadLine, price: prices.spreadAway },
      ],
    });
  }
  return { key, title, last_update: lastUpdate, markets };
}

test("opposite-signed American prices are combined in probability space, never arithmetic price space", () => {
  assert.equal(consensusAmericanOdds([-110, 100]), -105);
  assert.equal(consensusAmericanOdds([-105, -115]), -110);
  const mixed = consensusAmericanOdds([-120, 105]);
  assert.ok(isStandardAmericanOdds(mixed));
  assert.notEqual(mixed, -8, "direct arithmetic averaging would create a synthetic near-zero price");
  assert.ok(Math.abs((americanOddsToImpliedProbability(mixed) ?? 0) - 0.5216) < 0.01);
});

test("F5 game consensus preserves provenance and selects one real total line before combining prices", () => {
  const game = buildMlbF5ConsensusGame({
    id: "event-1",
    home_team: "Home Team",
    away_team: "Away Team",
    commence_time: "2026-08-01T00:10:00.000Z",
    bookmakers: [
      book("fanduel", "FanDuel", "2026-07-31T22:29:00.000Z", {
        mlHome: -110, mlAway: 100,
        totalLine: 5, totalOver: -110, totalUnder: -110,
      }),
      book("draftkings", "DraftKings", "2026-07-31T22:28:00.000Z", {
        mlHome: 100, mlAway: -120,
        totalLine: 5, totalOver: 100, totalUnder: -120,
      }),
      book("betmgm", "BetMGM", "2026-07-31T22:27:00.000Z", {
        mlHome: -105, mlAway: -105,
        totalLine: 5.5, totalOver: -115, totalUnder: -105,
      }),
    ],
  }, CAPTURED_AT);

  assert.equal(game.schemaVersion, MLB_F5_ODDS_SCHEMA_VERSION);
  assert.equal(game.consensusMethod, MLB_F5_CONSENSUS_METHOD);
  assert.equal(game.f5Ml.home, -105);
  assert.ok(isStandardAmericanOdds(game.f5Ml.away));
  assert.equal(game.f5Total.line, 5, "two books at 5.0 must beat one book at 5.5");
  assert.equal(game.f5Total.n, 2);
  assert.equal(game.f5Total.rawN, 3);
  assert.equal(game.f5Total.overOdds, -105);
  assert.equal(game.f5Total.underOdds, -115);
  assert.equal(game.capturedAt, CAPTURED_AT);
  assert.equal(game.providerLastUpdate, "2026-07-31T22:29:00.000Z");
  assert.deepEqual(new Set(game.provenance.contributingBooks), new Set(["fanduel", "draftkings", "betmgm"]));
  assert.equal(game.provenance.selectedLineQuotes.f5Total.length, 2);
});

test("invalid provider prices are retained as rejected provenance but cannot enter the consensus", () => {
  const game = buildMlbF5ConsensusGame({
    id: "event-2",
    home_team: "Home Team",
    away_team: "Away Team",
    commence_time: "2026-08-01T01:10:00.000Z",
    bookmakers: [
      book("fanduel", "FanDuel", "2026-07-31T22:20:00.000Z", {
        mlHome: -4, mlAway: -110,
        totalLine: 5, totalOver: -4, totalUnder: -110,
      }),
    ],
  }, CAPTURED_AT);

  assert.equal(game.f5Ml.home, null);
  assert.equal(game.f5Total.line, null);
  assert.equal(game.f5Total.overOdds, null);
  assert.equal(game.provenance.rawQuotes.f5Ml.home[0].accepted, false);
  assert.equal(game.provenance.rawQuotes.f5Total[0].accepted, false);
});

test("S5C strict guard rejects every synthetic American price between -99 and +99", () => {
  for (const value of [-99, -15, -4, -1, 0, 1, 4, 15, 99]) {
    assert.equal(validAmericanOdds(value), null, `expected ${value} to be rejected`);
  }
  assert.equal(validAmericanOdds(-100), -100);
  assert.equal(validAmericanOdds(100), 100);
  assert.equal(validAmericanOdds(-145), -145);
  assert.equal(validAmericanOdds(120), 120);
});
