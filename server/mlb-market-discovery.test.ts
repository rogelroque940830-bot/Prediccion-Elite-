import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { MLB_MARKET_UNIVERSE_REGISTRY } from "./mlb-market-universe-registry";
import {
  MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS,
  buildMlbMarketDiscovery,
} from "./mlb-market-discovery";
import { buildMlbIntrinsicEdge } from "./mlb-intrinsic-edge";
import {
  MLB_SHORTLIST_MAX_CANDIDATES,
  MLB_SHORTLIST_SCHEMA,
  type MlbShortlistCandidate,
  type MlbShortlistNativeSignal,
  type MlbShortlistResult,
} from "./mlb-shortlist";

function signal(
  component: MlbShortlistNativeSignal["component"],
  metric: string,
  valueRuns: number,
): MlbShortlistNativeSignal {
  return { component, metric, valueRuns, absoluteRuns: Math.abs(valueRuns) };
}

function candidate(input: {
  gamePk: number;
  final?: boolean;
  startTime?: string;
  signals: MlbShortlistNativeSignal[];
}): MlbShortlistCandidate {
  const finalInputsAvailable = input.final ?? true;
  return {
    gamePk: input.gamePk,
    officialDate: "2026-08-10",
    startTime: input.startTime ?? "2026-08-10T23:10:00.000Z",
    homeTeam: { id: input.gamePk * 10 + 1, name: `Home ${input.gamePk}` },
    awayTeam: { id: input.gamePk * 10 + 2, name: `Away ${input.gamePk}` },
    cheapScreenDisposition: finalInputsAvailable ? "ADVANCE_FINAL" : "ADVANCE_PROVISIONAL",
    finalInputsAvailable,
    certifiedComponentCount: new Set(input.signals.map((item) => item.component)).size,
    independentSignalCount: new Set(input.signals.map((item) => item.component)).size,
    maxAbsoluteNativeRunSignal: input.signals.reduce((max, item) => Math.max(max, item.absoluteRuns), 0),
    signals: input.signals,
    warnings: [],
    qualifiedForShortlist: input.signals.length > 0,
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

function intrinsic(selected: MlbShortlistCandidate[]) {
  return buildMlbIntrinsicEdge({ shortlist: shortlist(selected) });
}

function strongHomeSide(gamePk: number, final = true, startTime?: string): MlbShortlistCandidate {
  return candidate({
    gamePk,
    final,
    startTime,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.34),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.21),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.28),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.17),
    ],
  });
}

function strongTotalOver(gamePk: number, final = true): MlbShortlistCandidate {
  return candidate({
    gamePk,
    final,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.33),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.18),
      signal("ADVANCED_CONTEXT", "totalAdjustment", 0.8),
    ],
  });
}

function keys(values: readonly { providerMarketKey: string }[]): string[] {
  return values.map((value) => value.providerMarketKey).sort();
}

test("current paid-discovery catalog still exactly mirrors the five existing P1-M2A markets", () => {
  assert.deepEqual(
    [...MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS].sort(),
    ["F5_ML", "F5_TOTAL", "ML", "RUN_LINE", "TOTAL"],
  );

  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
  assert.deepEqual(keys(result.catalog.currentPregamePath), [
    "h2h",
    "h2h_1st_5_innings",
    "spreads",
    "totals",
    "totals_1st_5_innings",
  ]);
});

test("every Registry entry remains classified exactly once", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
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
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
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
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
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
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
  const playerEntries = result.catalog.catalogOnlyNotImplemented.filter((entry) => entry.period === "PLAYER");
  assert.ok(playerEntries.length > 0);
  assert.ok(playerEntries.every((entry) => entry.reasonCode === "PLAYER_PROP_REQUIRES_DEDICATED_MODEL"));
  assert.equal(result.policy.playerPropsQueryEligible, false);
});

test("strong two-sided intrinsic SIDE thesis opens only mature side markets and preserves HOME direction", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([strongHomeSide(101)]) });
  const plan = result.games[0];
  assert.equal(plan.intrinsicResearchEliteCandidate, true);
  assert.deepEqual(plan.researchEliteThesisKinds, ["HOME_SIDE"]);
  assert.deepEqual(plan.marketSearchIntents, ["SIDE"]);
  assert.equal(plan.paidLookupEligibleNow, true);
  assert.equal(plan.paidLookupHoldReason, null);
  assert.deepEqual([...plan.providerMarketKeysToRequestNow].sort(), [
    "h2h",
    "h2h_1st_5_innings",
    "spreads",
  ]);
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 3);
  assert.ok(plan.plannedMarkets.every((market) => market.thesisIntent === "SIDE"));
  assert.ok(plan.plannedMarkets.every((market) =>
    market.intrinsicThesisKinds.length === 1 && market.intrinsicThesisKinds[0] === "HOME_SIDE"));
});

test("strong multi-axis TOTAL thesis opens only mature total markets and preserves OVER direction", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([strongTotalOver(102)]) });
  const plan = result.games[0];
  assert.equal(plan.intrinsicResearchEliteCandidate, true);
  assert.deepEqual(plan.researchEliteThesisKinds, ["TOTAL_OVER"]);
  assert.deepEqual(plan.marketSearchIntents, ["TOTAL"]);
  assert.deepEqual([...plan.providerMarketKeysToRequestNow].sort(), [
    "totals",
    "totals_1st_5_innings",
  ]);
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 2);
  assert.ok(plan.plannedMarkets.every((market) => market.thesisIntent === "TOTAL"));
  assert.ok(plan.plannedMarkets.every((market) =>
    market.intrinsicThesisKinds.length === 1 && market.intrinsicThesisKinds[0] === "TOTAL_OVER"));
});

test("single-axis watch signal no longer opens a paid market bundle", () => {
  const watch = candidate({
    gamePk: 103,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.33),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.18),
    ],
  });
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([watch]) });
  const plan = result.games[0];
  assert.equal(plan.intrinsicResearchClassification, "INTRINSIC_WATCH");
  assert.deepEqual(plan.researchEliteThesisKinds, []);
  assert.equal(plan.plannedMarkets.length, 0);
  assert.equal(plan.paidLookupEligibleNow, false);
  assert.equal(plan.paidLookupHoldReason, "NO_STRONG_INTRINSIC_MARKET_THESIS");
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
});

test("provisional intrinsic elite retains rank, thesis direction and market plan but cannot authorize paid lookup", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([strongHomeSide(104, false)]) });
  const plan = result.games[0];
  assert.equal(plan.intrinsicRank, 1);
  assert.equal(plan.inputStage, "PROVISIONAL");
  assert.deepEqual(plan.researchEliteThesisKinds, ["HOME_SIDE"]);
  assert.equal(plan.plannedProviderMarketKeys.length, 3);
  assert.equal(plan.paidLookupEligibleNow, false);
  assert.equal(plan.paidLookupHoldReason, "OFFICIAL_FINAL_INPUTS_REQUIRED");
  assert.deepEqual(plan.providerMarketKeysToRequestNow, []);
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
  assert.equal(result.summary.gamesHeldForFinalInputs, 1);
});

test("late provisional rank #1 remains rank #1 while an earlier final rank #2 may be price-ready", () => {
  const earlyFinal = strongHomeSide(110, true, "2026-08-10T17:05:00.000Z");
  const lateProvisional = candidate({
    gamePk: 111,
    final: false,
    startTime: "2026-08-11T01:40:00.000Z",
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.46),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.31),
      signal("SOS", "home.adjustedRpgDelta", 0.55),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.39),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.24),
      signal("SOS", "away.adjustedRpgDelta", -0.42),
    ],
  });
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([earlyFinal, lateProvisional]) });

  assert.deepEqual(result.games.map((plan) => plan.gamePk), [111, 110]);
  assert.equal(result.games[0].intrinsicRank, 1);
  assert.equal(result.games[0].inputStage, "PROVISIONAL");
  assert.deepEqual(result.games[0].researchEliteThesisKinds, ["HOME_SIDE"]);
  assert.equal(result.games[0].paidLookupEligibleNow, false);
  assert.equal(result.games[0].paidLookupHoldReason, "OFFICIAL_FINAL_INPUTS_REQUIRED");
  assert.equal(result.games[1].intrinsicRank, 2);
  assert.equal(result.games[1].inputStage, "FINAL");
  assert.deepEqual(result.games[1].researchEliteThesisKinds, ["HOME_SIDE"]);
  assert.equal(result.games[1].paidLookupEligibleNow, true);
  assert.equal(result.policy.intrinsicRankPreservedAcrossInputStage, true);
});

test("no intrinsic games means no market requests and zero planned provider cost", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
  assert.deepEqual(result.games, []);
  assert.equal(result.summary.intrinsicGames, 0);
  assert.equal(result.summary.providerMarketsPlannedNow, 0);
  assert.equal(result.summary.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
});

test("market discovery is a pure zero-odds planner and preserves intrinsic direction before any future paid lookup", () => {
  const source = fs.readFileSync("server/mlb-market-discovery.ts", "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|api\.the-odds-api\.com|ODDS_API_KEY|x-requests-|setInterval|setTimeout/i);
  assert.doesNotMatch(source, /PREMIUM|ULTRA|automaticBetPlacement|stake|sportsbook.*write/i);
  assert.match(source, /callsTheOddsApi: false/);
  assert.match(source, /theOddsApiCreditsConsumed: 0/);
  assert.match(source, /intrinsicThesisRequiredForPaidLookup: true/);
  assert.match(source, /intrinsicThesisDirectionPreserved: true/);
  assert.match(source, /intrinsicRankPreservedAcrossInputStage: true/);
  assert.match(source, /firstThreeInningsPriority: false/);
  assert.match(source, /marketOrderCarriesPreference: false/);
  assert.match(source, /researchOnlyMarketsConsumeProviderCredits: false/);
  assert.match(source, /onlyFinalInputsMayAuthorizePaidLookup: true/);
});
