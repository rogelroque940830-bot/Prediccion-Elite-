import test from "node:test";
import assert from "node:assert/strict";
import {
  MLB_P1_M6A2_SCHEMA,
  buildMlbMarketOddsUniverseGame,
  type MlbCanonicalMarketAvailability,
} from "./mlb-market-odds-normalizer";

const CAPTURED_AT = "2026-08-07T13:00:00.000Z";
const FRESH_AT = "2026-08-07T12:58:00.000Z";
const STALE_AT = "2026-08-07T12:40:00.000Z";
const HOME = "Home Club";
const AWAY = "Away Club";

function market(key: string, outcomes: any[], lastUpdate = FRESH_AT) {
  return { key, last_update: lastUpdate, outcomes };
}

function book(key: string, markets: any[], lastUpdate = FRESH_AT) {
  return { key, title: key, last_update: lastUpdate, markets };
}

function event(bookmakers: any[]) {
  return {
    id: "event-1",
    home_team: HOME,
    away_team: AWAY,
    commence_time: "2026-08-07T23:10:00Z",
    bookmakers,
  };
}

function teamPrices(home: number, away: number) {
  return [
    { name: HOME, price: home },
    { name: AWAY, price: away },
  ];
}

function spreadPrices(homeLine: number, home: number, away: number) {
  return [
    { name: HOME, point: homeLine, price: home },
    { name: AWAY, point: -homeLine, price: away },
  ];
}

function totalPrices(line: number, over: number, under: number) {
  return [
    { name: "Over", point: line, price: over },
    { name: "Under", point: line, price: under },
  ];
}

function teamTotalPrices() {
  return [
    { name: "Over", description: HOME, point: 4.5, price: -105 },
    { name: "Under", description: HOME, point: 4.5, price: -115 },
    { name: "Over", description: AWAY, point: 3.5, price: 110 },
    { name: "Under", description: AWAY, point: 3.5, price: -130 },
  ];
}

function findMarket(
  game: ReturnType<typeof buildMlbMarketOddsUniverseGame>,
  key: string,
): MlbCanonicalMarketAvailability {
  const found = game.markets.find((entry) => entry.canonicalKey === key);
  assert.ok(found, `missing canonical market ${key}`);
  return found;
}

test("builds the complete canonical MLB quote universe without inventing undocumented period team totals", () => {
  const providerEvent = event([
    book("hardrockbet_fl", [
      market("h2h", teamPrices(-120, 105)),
      market("spreads", spreadPrices(-1.5, 110, -130)),
      market("totals", totalPrices(8.5, -110, -110)),
      market("team_totals", teamTotalPrices()),
      market("h2h_1st_1_innings", teamPrices(115, -135)),
      market("totals_1st_1_innings", totalPrices(0.5, -105, -115)),
    ]),
    book("draftkings", [
      market("h2h_1st_5_innings", teamPrices(-125, 105)),
      market("spreads_1st_5_innings", spreadPrices(-0.5, 105, -125)),
      market("totals_1st_5_innings", totalPrices(4.5, -112, -108)),
      market("h2h_1st_3_innings", teamPrices(-120, 100)),
      market("spreads_1st_3_innings", spreadPrices(-0.5, 115, -135)),
      market("totals_1st_3_innings", totalPrices(2.5, -110, -110)),
    ]),
    book("betmgm", [
      market("h2h_1st_5_innings", teamPrices(-130, 110)),
      market("totals_1st_5_innings", totalPrices(4.5, -105, -115)),
      market("h2h_1st_3_innings", teamPrices(-118, -102)),
      market("spreads_1st_3_innings", spreadPrices(-0.5, 110, -130)),
      market("totals_1st_3_innings", totalPrices(2.5, -108, -112)),
    ]),
    book("fanduel", [
      market("totals_1st_3_innings", totalPrices(3, 100, -120)),
    ]),
  ]);

  const game = buildMlbMarketOddsUniverseGame(providerEvent, CAPTURED_AT);
  assert.equal(game.schemaVersion, MLB_P1_M6A2_SCHEMA);
  assert.equal(game.markets.length, 18);
  assert.deepEqual(game.safety, {
    readOnly: true,
    ledgerWrites: false,
    automaticBetPlacement: false,
    realFinancialExposure: 0,
  });

  const fullMl = findMarket(game, "ML:DEFAULT");
  assert.equal(fullMl.availability, "EXECUTABLE");
  assert.equal(fullMl.execution.status, "FRESH");
  assert.equal(fullMl.execution.quote?.bookKey, "hardrockbet_fl");
  assert.equal(fullMl.execution.quote?.selections[0].oddsAmerican, -120);

  const f5Ml = findMarket(game, "F5_ML:DEFAULT");
  assert.equal(f5Ml.availability, "REFERENCE_ONLY");
  assert.equal(f5Ml.execution.status, "MISSING");
  assert.equal(f5Ml.reference.status, "FRESH");
  assert.deepEqual(f5Ml.reference.quote?.contributingBooks, ["betmgm", "draftkings"]);

  const f3Total = findMarket(game, "F3_TOTAL:DEFAULT");
  assert.equal(f3Total.reference.quote?.selections[0].line, 2.5);
  assert.equal(f3Total.reference.quote?.n, 2);
  assert.deepEqual(f3Total.reference.quote?.contributingBooks, ["betmgm", "draftkings"]);

  const homeTeamTotal = findMarket(game, "TEAM_TOTAL:HOME");
  const awayTeamTotal = findMarket(game, "TEAM_TOTAL:AWAY");
  assert.equal(homeTeamTotal.availability, "EXECUTABLE");
  assert.equal(homeTeamTotal.execution.quote?.selections[0].selection, `${HOME} Over`);
  assert.equal(awayTeamTotal.execution.quote?.selections[0].line, 3.5);

  assert.equal(findMarket(game, "F5_TEAM_TOTAL:HOME").availability, "UNAVAILABLE_FROM_PROVIDER");
  assert.deepEqual(findMarket(game, "F5_TEAM_TOTAL:HOME").blockers, ["F5_TEAM_TOTAL_NOT_DOCUMENTED_BY_PROVIDER"]);
  assert.equal(findMarket(game, "F3_TEAM_TOTAL:AWAY").availability, "UNAVAILABLE_FROM_PROVIDER");
});

test("maps NRFI and YRFI only from an exact first-inning total of 0.5", () => {
  const exact = buildMlbMarketOddsUniverseGame(event([
    book("hardrockbet", [market("totals_1st_1_innings", totalPrices(0.5, -115, -105))]),
  ]), CAPTURED_AT);

  const nrfi = findMarket(exact, "NRFI:NRFI");
  const yrfi = findMarket(exact, "YRFI:YRFI");
  assert.equal(nrfi.availability, "EXECUTABLE");
  assert.equal(nrfi.execution.quote?.selections[0].side, "NRFI");
  assert.equal(nrfi.execution.quote?.selections[0].oddsAmerican, -105);
  assert.equal(nrfi.execution.quote?.selections[1].side, "YRFI");
  assert.equal(yrfi.execution.quote?.selections[0].side, "YRFI");
  assert.equal(yrfi.execution.quote?.selections[0].oddsAmerican, -115);

  const wrongLine = buildMlbMarketOddsUniverseGame(event([
    book("hardrockbet", [market("totals_1st_1_innings", totalPrices(1.5, -110, -110))]),
  ]), CAPTURED_AT);
  assert.equal(findMarket(wrongLine, "NRFI:NRFI").availability, "CONTRACT_MISMATCH");
  assert.ok(findMarket(wrongLine, "NRFI:NRFI").blockers.includes("QUOTE_CONTRACT_MISMATCH"));
});

test("fails closed when only a three-way F3 moneyline contract is present", () => {
  const game = buildMlbMarketOddsUniverseGame(event([
    book("draftkings", [
      market("h2h_3_way_1st_3_innings", [
        { name: HOME, price: 120 },
        { name: "Draw", price: 210 },
        { name: AWAY, price: 145 },
      ]),
    ]),
  ]), CAPTURED_AT);
  const f3Ml = findMarket(game, "F3_ML:DEFAULT");
  assert.equal(f3Ml.availability, "CONTRACT_MISMATCH");
  assert.deepEqual(f3Ml.alternateContractBooks, ["draftkings"]);
  assert.ok(f3Ml.blockers.includes("ALTERNATE_THREE_WAY_CONTRACT_PRESENT"));
  assert.equal(f3Ml.execution.quote, null);
  assert.equal(f3Ml.reference.quote, null);
});

test("a fresh reference price never upgrades a stale Hard Rock quote to executable", () => {
  const game = buildMlbMarketOddsUniverseGame(event([
    book("hardrockbet_fl", [market("h2h", teamPrices(-130, 110), STALE_AT)], STALE_AT),
    book("draftkings", [market("h2h", teamPrices(-125, 105))]),
    book("fanduel", [market("h2h", teamPrices(-120, 100))]),
  ]), CAPTURED_AT);
  const fullMl = findMarket(game, "ML:DEFAULT");
  assert.equal(fullMl.execution.status, "STALE");
  assert.equal(fullMl.reference.status, "FRESH");
  assert.equal(fullMl.availability, "REFERENCE_ONLY");
  assert.ok(fullMl.blockers.includes("FRESH_EXECUTION_BOOK_QUOTE_REQUIRED"));
  assert.ok(fullMl.blockers.includes("NOT_EXECUTABLE_AT_CURRENT_HARD_ROCK_PRICE"));
});

test("rejects malformed paired structures instead of averaging mismatched lines", () => {
  const game = buildMlbMarketOddsUniverseGame(event([
    book("hardrockbet", [
      market("spreads_1st_3_innings", [
        { name: HOME, point: -0.5, price: -110 },
        { name: AWAY, point: 1.5, price: -110 },
      ]),
      market("totals_1st_5_innings", [
        { name: "Over", point: 4.5, price: -110 },
        { name: "Under", point: 5, price: -110 },
      ]),
    ]),
  ]), CAPTURED_AT);
  assert.equal(findMarket(game, "F3_RUN_LINE:DEFAULT").availability, "INVALID_PRICE_OR_STRUCTURE");
  assert.equal(findMarket(game, "F5_TOTAL:DEFAULT").availability, "INVALID_PRICE_OR_STRUCTURE");
});
