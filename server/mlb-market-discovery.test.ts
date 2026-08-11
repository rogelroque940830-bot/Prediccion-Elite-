import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { MLB_MARKET_UNIVERSE_REGISTRY } from "./mlb-market-universe-registry";
import {
  MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS,
  buildMlbMarketDiscovery,
} from "./mlb-market-discovery";
import {
  MLB_SHORTLIST_MAX_CANDIDATES,
  MLB_SHORTLIST_SCHEMA,
  type MlbShortlistCandidate,
  type MlbShortlistComponent,
  type MlbShortlistResult,
} from "./mlb-shortlist";

function signal(component: MlbShortlistComponent, value = 0.4) {
  const metric: Record<MlbShortlistComponent, string> = {
    STATCAST_QUALITY: "homeSP.runsDelta",
    DISCIPLINE_SPEED: "homeRunsDelta",
    SOS: "home.adjustedRpgDelta",
    ADVANCED_CONTEXT: "totalAdjustment",
  };
  return {
    component,
    metric: metric[component],
    valueRuns: value,
    absoluteRuns: Math.abs(value),
  };
}

function candidate(input: {
  gamePk: number;
  finalInputsAvailable?: boolean;
  components?: MlbShortlistComponent[];
}): MlbShortlistCandidate {
  const components = input.components ?? ["STATCAST_QUALITY"];
  const signals = components.map((component, index) => signal(component, 0.4 + index * 0.1));
  return {
    gamePk: input.gamePk,
    officialDate: "2026-08-10",
    startTime: "2026-08-10T23:10:00.000Z",
    homeTeam: { id: 1, name: `Home ${input.gamePk}` },
    awayTeam: { id: 2, name: `Away ${input.gamePk}` },
    cheapScreenDisposition: input.finalInputsAvailable === false ? "ADVANCE_PROVISIONAL" : "ADVANCE_FINAL",
    finalInputsAvailable: input.finalInputsAvailable !== false,
    certifiedComponentCount: components.length,
    independentSignalCount: components.length,
    maxAbsoluteNativeRunSignal: signals.reduce((max, item) => Math.max(max, item.absoluteRuns), 0),
    signals,
    warnings: [],
    qualifiedForShortlist: components.length > 0,
  };
}

function shortlist(selected: MlbShortlistCandidate[]): MlbShortlistResult {
  return {
    schemaVersion: MLB_SHORTLIST_SCHEMA,
    generatedAt: "2026-08-10T22:00:00.000Z",
    date: "2026-08-10",
    sourceCheapScreenSchemaVersion: "courtedge-p0-mlb-cheap-screening.v1",
    candidates: selected,
    selected,
    summary: {
      cheapScreenEligible: selected.length,
      evaluated: selected.length,
      qualified: selected.length,
      selected: selected.length,
      overflowQualified: 0,
      noCertifiedSignal: 0,
    },
    policy: {
      marketAgnostic: true,
      predictsWinner: false,
      recommendsBet: false,
      requiresMarketOdds: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      weightsApplied: false,
      forcedQuota: false,
      requiresCertifiedProvenance: true,
      maxCandidates: MLB_SHORTLIST_MAX_CANDIDATES,
      hardMaximumCandidates: MLB_SHORTLIST_MAX_CANDIDATES,
      qualificationRule: "AT_LEAST_ONE_NONZERO_NATIVE_RUN_SIGNAL_FROM_CERTIFIED_COMPONENT",
      rankingRule: "SIGNAL_COMPONENT_COUNT_THEN_MAX_NATIVE_RUN_MAGNITUDE_THEN_CERTIFIED_COVERAGE",
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function keys(values: readonly { providerMarketKey: string }[]): string[] {
  return values.map((value) => value.providerMarketKey).sort();
}

test("current paid-discovery path exactly mirrors the five existing P1-M2A markets", () => {
  assert.deepEqual(
    [...MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS].sort(),
    ["F5_ML", "F5_TOTAL", "ML", "RUN_LINE", "TOTAL"],
  );

  const result = buildMlbMarketDiscovery({ shortlist: shortlist([]) });
  assert.deepEqual(keys(result.catalog.currentPregamePath), [
    "h2h",
    "h2h_1st_5_innings",
    "spreads",
    "totals",
    "totals_1st_5_innings",
  ]);
});

test("every Registry entry is classified exactly once", () => {
  const result = buildMlbMarketDiscovery({ shortlist: shortlist([]) });
  const all = [
    ...result.catalog.currentPregamePath,
    ...result.catalog.researchOnly,
    ...result.catalog.blockedContractMismatch,
    ...result.catalog.catalogOnlyNotImplemented,
  ];
  assert.equal(all.length, MLB_MARKET_UNIVERSE_REGISTRY.length);
  assert.equal(new Set(all.map((entry) => entry.providerMarketKey)).size, MLB_MARKET_UNIVERSE_REGISTRY.length);
});

test("first-three two-way markets remain visible but research-only with no priority", () => {
  const result = buildMlbMarketDiscovery({ shortlist: shortlist([]) });
  const research = new Map(result.catalog.researchOnly.map((entry) => [entry.providerMarketKey, entry]));
  for (const key of ["h2h_1st_3_innings", "spreads_1st_3_innings", "totals_1st_3_innings"]) {
    const entry = research.get(key);
    assert.ok(entry, `${key} must remain in research-only catalog`);
    assert.equal(entry?.catalogStatus, "RESEARCH_ONLY_ANALYTICAL_PATH_MISSING");
    assert.equal(entry?.reasonCode, "ANALYTICAL_PATH_NOT_YET_IMPLEMENTED");
  }
  assert.equal(result.policy.firstThreeInningsPriority, false);
  assert.equal(result.policy.marketOrderCarriesPreference, false);
});

test("three-way period contracts are blocked rather than coerced into two-way markets", () => {
  const result = buildMlbMarketDiscovery({ shortlist: shortlist([]) });
  const blocked = new Map(result.catalog.blockedContractMismatch.map((entry) => [entry.providerMarketKey, entry]));
  for (const key of [
    "h2h_3_way_1st_1_innings",
    "h2h_3_way_1st_3_innings",
    "h2h_3_way_1st_5_innings",
    "h2h_3_way_1st_7_innings",
  ]) {
    assert.equal(blocked.get(key)?.reasonCode, "THREE_WAY_CONTRACT_MISMATCH");
  }
  assert.equal(result.policy.threeWayCoercionAllowed, false);
});

test("player props stay cataloged but never become paid-query eligible without dedicated models", () => {
  const result = buildMlbMarketDiscovery({ shortlist: shortlist([]) });
  const playerEntries = result.catalog.catalogOnlyNotImplemented.filter((entry) => entry.period === "PLAYER");
  assert.ok(playerEntries.length > 0);
  assert.ok(playerEntries.every((entry) => entry.reasonCode === "PLAYER_PROP_REQUIRES_DEDICATED_MODEL"));
  assert.equal(result.policy.playerPropsQueryEligible, false);
});

test("a final Statcast candidate plans all five currently mature analytical markets and nothing else", () => {
  const result = buildMlbMarketDiscovery({
    shortlist: shortlist([candidate({ gamePk: 101, components: ["STATCAST_QUALITY"] })]),
  });
  const plan = result.games[0];
  assert.equal(plan.paidLookupEligibleNow, true);
  assert.equal(plan.paidLookupHoldReason, null);
  assert.deepEqual([...plan.providerMarketKeysToRequestNow].sort(), [
    "h2h",
    "h2h_1st_5_innings",
    "spreads",
    "totals",
    "totals_1st_5_innings",
  ]);
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 5);
  assert.ok(!plan.providerMarketKeysToRequestNow.some((key) => key.includes("1st_3")));
  assert.ok(!plan.providerMarketKeysToRequestNow.some((key) => key.startsWith("batter_") || key.startsWith("pitcher_")));
});

test("Advanced Context by itself opens only total markets, never side markets", () => {
  const result = buildMlbMarketDiscovery({
    shortlist: shortlist([candidate({ gamePk: 102, components: ["ADVANCED_CONTEXT"] })]),
  });
  const plan = result.games[0];
  assert.deepEqual([...plan.providerMarketKeysToRequestNow].sort(), [
    "totals",
    "totals_1st_5_innings",
  ]);
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 2);
  assert.ok(plan.plannedMarkets.every((market) => market.family === "TOTAL"));
});

test("multiple certified components add market support without creating a weighted score", () => {
  const result = buildMlbMarketDiscovery({
    shortlist: shortlist([candidate({
      gamePk: 103,
      components: ["STATCAST_QUALITY", "DISCIPLINE_SPEED", "SOS", "ADVANCED_CONTEXT"],
    })]),
  });
  const plan = result.games[0];
  const total = plan.plannedMarkets.find((market) => market.canonicalMarketType === "TOTAL");
  const ml = plan.plannedMarkets.find((market) => market.canonicalMarketType === "ML");
  assert.deepEqual(total?.supportingComponents, ["ADVANCED_CONTEXT", "DISCIPLINE_SPEED", "SOS", "STATCAST_QUALITY"]);
  assert.deepEqual(ml?.supportingComponents, ["DISCIPLINE_SPEED", "SOS", "STATCAST_QUALITY"]);
  assert.equal(total?.independentSupportingComponentCount, 4);
  assert.equal(ml?.independentSupportingComponentCount, 3);
  assert.equal(result.policy.marketOrderCarriesPreference, false);
});

test("provisional shortlisted games may be planned but cannot authorize paid market lookup", () => {
  const result = buildMlbMarketDiscovery({
    shortlist: shortlist([candidate({ gamePk: 104, finalInputsAvailable: false, components: ["STATCAST_QUALITY"] })]),
  });
  const plan = result.games[0];
  assert.equal(plan.plannedProviderMarketKeys.length, 5);
  assert.equal(plan.paidLookupEligibleNow, false);
  assert.equal(plan.paidLookupHoldReason, "OFFICIAL_FINAL_INPUTS_REQUIRED");
  assert.deepEqual(plan.providerMarketKeysToRequestNow, []);
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
  assert.equal(result.summary.gamesHeldForFinalInputs, 1);
});

test("no selected shortlist candidates means no market requests and zero planned provider cost", () => {
  const result = buildMlbMarketDiscovery({ shortlist: shortlist([]) });
  assert.deepEqual(result.games, []);
  assert.equal(result.summary.shortlistedGames, 0);
  assert.equal(result.summary.providerMarketsPlannedNow, 0);
  assert.equal(result.summary.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
});

test("an impossible selected candidate with no certified native signal fails closed to no relevant market", () => {
  const empty = candidate({ gamePk: 105, components: [] });
  empty.qualifiedForShortlist = false;
  const result = buildMlbMarketDiscovery({ shortlist: shortlist([empty]) });
  const plan = result.games[0];
  assert.equal(plan.plannedMarkets.length, 0);
  assert.equal(plan.paidLookupEligibleNow, false);
  assert.equal(plan.paidLookupHoldReason, "NO_RELEVANT_CURRENT_ANALYTICAL_MARKET");
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
});

test("market discovery is a pure zero-odds planner with no network, secret, timer or betting capability", () => {
  const source = fs.readFileSync("server/mlb-market-discovery.ts", "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|api\.the-odds-api\.com|ODDS_API_KEY|x-requests-|setInterval|setTimeout/i);
  assert.doesNotMatch(source, /PREMIUM|ULTRA|automaticBetPlacement|stake|sportsbook.*write/i);
  assert.match(source, /callsTheOddsApi: false/);
  assert.match(source, /theOddsApiCreditsConsumed: 0/);
  assert.match(source, /firstThreeInningsPriority: false/);
  assert.match(source, /marketOrderCarriesPreference: false/);
  assert.match(source, /researchOnlyMarketsConsumeProviderCredits: false/);
  assert.match(source, /onlyFinalInputsMayAuthorizePaidLookup: true/);
});
