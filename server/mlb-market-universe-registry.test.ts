import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { MLB_MARKET_TYPES } from "./mlb-market-contract";
import { MLB_P1_M6A2_PROVIDER_MARKETS } from "./mlb-market-odds-normalizer";
import {
  MLB_CANONICAL_MARKET_GAPS,
  MLB_MARKET_DISCOVERY_POLICY,
  MLB_MARKET_UNIVERSE_REGISTRY,
  MLB_MARKET_UNIVERSE_REGISTRY_VERSION,
  MLB_MARKET_UNIVERSE_VERIFIED_AT,
  getMlbMarketRegistryEntry,
  intersectMlbDiscoveredMarketKeys,
} from "./mlb-market-universe-registry";

test("Registry v1 is a unique, static, 69-key verified catalog", () => {
  assert.equal(MLB_MARKET_UNIVERSE_REGISTRY_VERSION, "courtedge-p0-mlb-market-universe-registry.v1");
  assert.equal(MLB_MARKET_UNIVERSE_VERIFIED_AT, "2026-08-10");
  assert.equal(MLB_MARKET_UNIVERSE_REGISTRY.length, 69);

  const keys = MLB_MARKET_UNIVERSE_REGISTRY.map((entry) => entry.providerMarketKey);
  assert.equal(new Set(keys).size, keys.length, "provider market keys must be unique");

  const classCounts = new Map<string, number>();
  for (const entry of MLB_MARKET_UNIVERSE_REGISTRY) {
    classCounts.set(entry.documentationClass, (classCounts.get(entry.documentationClass) ?? 0) + 1);
    assert.equal(entry.liveHardRockFloridaDiscoveryRequired, true);
  }
  assert.equal(classCounts.get("MLB_FEATURED"), 3);
  assert.equal(classCounts.get("GENERAL_ADDITIONAL"), 5);
  assert.equal(classCounts.get("BASEBALL_PERIOD"), 24);
  assert.equal(classCounts.get("MLB_PLAYER_PROP"), 20);
  assert.equal(classCounts.get("MLB_PLAYER_PROP_ALTERNATE"), 17);
});

test("Registry contains every provider market already used by the live MLB universe route", () => {
  for (const key of MLB_P1_M6A2_PROVIDER_MARKETS) {
    assert.ok(getMlbMarketRegistryEntry(key), `existing live provider key missing from Registry: ${key}`);
  }
});

test("documented baseball period catalog includes 1, 3, 5 and 7 inning families without inventing period team totals", () => {
  for (const innings of [1, 3, 5, 7]) {
    for (const prefix of ["h2h", "h2h_3_way", "spreads", "alternate_spreads", "totals", "alternate_totals"]) {
      const key = `${prefix}_1st_${innings}_innings`;
      const entry = getMlbMarketRegistryEntry(key);
      assert.ok(entry, `missing documented baseball-period market ${key}`);
      assert.equal(entry.providerApplicability, "MLB_EXPLICIT");
      assert.equal(entry.acquisition, "EVENT_ODDS_ONLY");
    }
  }

  assert.equal(getMlbMarketRegistryEntry("team_totals_1st_5_innings"), null);
  assert.equal(getMlbMarketRegistryEntry("team_totals_1st_3_innings"), null);
});

test("three-way markets remain contract mismatches and are never treated as two-way MLB moneylines", () => {
  for (const key of [
    "h2h_3_way",
    "h2h_3_way_1st_1_innings",
    "h2h_3_way_1st_3_innings",
    "h2h_3_way_1st_5_innings",
    "h2h_3_way_1st_7_innings",
  ]) {
    const entry = getMlbMarketRegistryEntry(key);
    assert.ok(entry);
    assert.equal(entry.modelIntegrationStatus, "CONTRACT_MISMATCH");
    assert.deepEqual(entry.canonicalMarketTypes, []);
  }
});

test("NRFI/YRFI are derived from the first-inning 0.5 total contract, not invented provider keys", () => {
  assert.equal(getMlbMarketRegistryEntry("nrfi"), null);
  assert.equal(getMlbMarketRegistryEntry("yrfi"), null);
  const firstInningTotal = getMlbMarketRegistryEntry("totals_1st_1_innings");
  assert.ok(firstInningTotal);
  assert.deepEqual(firstInningTotal.canonicalMarketTypes, ["NRFI", "YRFI"]);
  assert.ok(firstInningTotal.notes.some((note) => note.includes("exactly 0.5")));
});

test("every production canonical market is either mapped or has an explicit verified gap", () => {
  const mapped = new Set(MLB_MARKET_UNIVERSE_REGISTRY.flatMap((entry) => entry.canonicalMarketTypes));
  const gaps = new Set(MLB_CANONICAL_MARKET_GAPS.map((gap) => gap.marketType));
  for (const marketType of MLB_MARKET_TYPES) {
    if (marketType === "OTHER") continue;
    assert.ok(mapped.has(marketType) || gaps.has(marketType), `canonical market lacks registry disposition: ${marketType}`);
  }

  assert.deepEqual(
    [...gaps].sort(),
    ["F3_TEAM_TOTAL", "F5_TEAM_TOTAL", "TT_OVER_15_F5", "TT_UNDER_25_F5"].sort(),
  );
});

test("provider documentation and Hard Rock product evidence never imply executable Florida availability", () => {
  const exactEvidence = MLB_MARKET_UNIVERSE_REGISTRY.filter((entry) =>
    entry.hardRockEvidenceStatus === "EXACT_FIRST_PARTY_PRODUCT_EVIDENCE");
  assert.ok(exactEvidence.length > 0);
  for (const entry of exactEvidence) {
    assert.equal(entry.liveHardRockFloridaDiscoveryRequired, true);
    assert.ok(entry.hardRockEvidenceSourceIds.length > 0);
  }

  const f3Ml = getMlbMarketRegistryEntry("h2h_1st_3_innings");
  assert.ok(f3Ml);
  assert.equal(f3Ml.hardRockEvidenceStatus, "NOT_VERIFIED");
  assert.equal(f3Ml.liveHardRockFloridaDiscoveryRequired, true);

  const f7Total = getMlbMarketRegistryEntry("totals_1st_7_innings");
  assert.ok(f7Total);
  assert.equal(f7Total.hardRockEvidenceStatus, "NOT_VERIFIED");
});

test("live discovery policy is quota-aware and shortlist-gated", () => {
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.executionBookmakerKey, "hardrockbet_fl");
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.executionBookmakerRegion, "us2");
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.registryPerformsNetworkRequests, false);
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.registryConsumesProviderCredits, false);
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.eventsEndpointReportedQuotaCost, 0);
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.eventMarketsEndpointReportedQuotaCost, 1);
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.eventMarketsIsComprehensiveCatalog, false);
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.queryEventMarketsOnlyAfterShortlist, true);
  assert.equal(MLB_MARKET_DISCOVERY_POLICY.providerDocumentationNeverImpliesHardRockFloridaExecution, true);
});

test("intersection returns only known market keys and does not create unknown markets", () => {
  const discovered = intersectMlbDiscoveredMarketKeys([
    "h2h_1st_7_innings",
    "pitcher_strikeouts",
    "unknown_future_market",
  ]);
  assert.deepEqual(discovered.map((entry) => entry.providerMarketKey), [
    "h2h_1st_7_innings",
    "pitcher_strikeouts",
  ]);
});

test("Registry source is quota-zero static metadata with no provider call capability", () => {
  const source = fs.readFileSync("server/mlb-market-universe-registry.ts", "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /ODDS_API_KEY/);
  assert.doesNotMatch(source, /api\.the-odds-api\.com/);
  assert.doesNotMatch(source, /setInterval|setTimeout/);
});
