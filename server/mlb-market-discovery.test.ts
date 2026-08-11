import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { MLB_MARKET_UNIVERSE_REGISTRY } from "./mlb-market-universe-registry";
import {
  MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS,
  buildMlbMarketDiscovery,
} from "./mlb-market-discovery";
import {
  buildMlbIntrinsicEdge,
  type MlbIntrinsicBullpenByGame,
} from "./mlb-intrinsic-edge";
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

function intrinsic(selected: MlbShortlistCandidate[], bullpenByGame?: MlbIntrinsicBullpenByGame) {
  return buildMlbIntrinsicEdge({ shortlist: shortlist(selected), bullpenByGame });
}

const certifiedBullpen = (runsAdjustment: number) => ({
  sourceStatus: "CERTIFIED",
  provenance: { status: "CERTIFIED" },
  runsAdjustment,
});

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

test("current paid-discovery catalog exactly mirrors the five existing P1-M2A markets", () => {
  assert.deepEqual([...MLB_CURRENT_PREGAME_ANALYTICAL_MARKETS].sort(), ["F5_ML", "F5_TOTAL", "ML", "RUN_LINE", "TOTAL"]);
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

test("first-three two-way markets remain visible, research-only and non-prioritized", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
  const research = new Map(result.catalog.researchOnly.map((entry) => [entry.providerMarketKey, entry]));
  for (const key of ["h2h_1st_3_innings", "spreads_1st_3_innings", "totals_1st_3_innings"]) {
    assert.equal(research.get(key)?.reasonCode, "ANALYTICAL_PATH_NOT_YET_IMPLEMENTED");
  }
  assert.equal(result.policy.firstThreeInningsPriority, false);
  assert.equal(result.policy.marketOrderCarriesPreference, false);
});

test("three-way contracts stay blocked and player props stay catalog-only", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
  const blocked = new Map(result.catalog.blockedContractMismatch.map((entry) => [entry.providerMarketKey, entry]));
  assert.equal(blocked.get("h2h_3_way_1st_3_innings")?.reasonCode, "THREE_WAY_CONTRACT_MISMATCH");
  const playerEntries = result.catalog.catalogOnlyNotImplemented.filter((entry) => entry.period === "PLAYER");
  assert.ok(playerEntries.length > 0);
  assert.ok(playerEntries.every((entry) => entry.reasonCode === "PLAYER_PROP_REQUIRES_DEDICATED_MODEL"));
});

test("starter-supported HOME_SIDE opens full-game side markets plus F5 ML with scope preserved", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([strongHomeSide(101)]) });
  const plan = result.games[0];
  assert.equal(plan.intrinsicResearchEliteCandidate, true);
  assert.deepEqual(plan.researchEliteThesisKindsByScope.fullGame, ["HOME_SIDE"]);
  assert.deepEqual(plan.researchEliteThesisKindsByScope.earlyWindow, ["HOME_SIDE"]);
  assert.deepEqual([...plan.providerMarketKeysToRequestNow].sort(), ["h2h", "h2h_1st_5_innings", "spreads"]);
  assert.equal(plan.plannedMarkets.find((market) => market.providerMarketKey === "h2h")?.intrinsicProjectionScope, "FULL_GAME");
  assert.equal(plan.plannedMarkets.find((market) => market.providerMarketKey === "spreads")?.intrinsicProjectionScope, "FULL_GAME");
  assert.equal(plan.plannedMarkets.find((market) => market.providerMarketKey === "h2h_1st_5_innings")?.intrinsicProjectionScope, "EARLY_WINDOW");
  assert.ok(plan.plannedMarkets.every((market) => market.intrinsicThesisKinds.includes("HOME_SIDE")));
});

test("multi-axis TOTAL_OVER supported before late innings opens both full-game and F5 totals", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([strongTotalOver(102)]) });
  const plan = result.games[0];
  assert.deepEqual([...plan.providerMarketKeysToRequestNow].sort(), ["totals", "totals_1st_5_innings"]);
  assert.equal(plan.plannedMarkets.find((market) => market.providerMarketKey === "totals")?.intrinsicProjectionScope, "FULL_GAME");
  assert.equal(plan.plannedMarkets.find((market) => market.providerMarketKey === "totals_1st_5_innings")?.intrinsicProjectionScope, "EARLY_WINDOW");
  assert.ok(plan.plannedMarkets.every((market) => market.intrinsicThesisKinds.includes("TOTAL_OVER")));
});

test("late bullpen may complete a full-game HOME_SIDE thesis but cannot authorize F5 ML", () => {
  const base = candidate({
    gamePk: 103,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.31),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.29),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.18),
    ],
  });
  const result = buildMlbMarketDiscovery({
    intrinsic: intrinsic([base], { 103: { away: certifiedBullpen(0.45) } }),
  });
  const plan = result.games[0];
  assert.deepEqual(plan.researchEliteThesisKindsByScope.fullGame, ["HOME_SIDE"]);
  assert.deepEqual(plan.researchEliteThesisKindsByScope.earlyWindow, []);
  assert.deepEqual([...plan.providerMarketKeysToRequestNow].sort(), ["h2h", "spreads"]);
  assert.equal(plan.plannedProviderMarketKeys.includes("h2h_1st_5_innings"), false);
});

test("late bullpen can create full-game TOTAL_OVER but can never authorize F5 total", () => {
  const base = candidate({ gamePk: 104, signals: [signal("ADVANCED_CONTEXT", "totalAdjustment", 0.6)] });
  const result = buildMlbMarketDiscovery({
    intrinsic: intrinsic([base], { 104: { away: certifiedBullpen(0.5) } }),
  });
  const plan = result.games[0];
  assert.deepEqual(plan.researchEliteThesisKindsByScope.fullGame, ["TOTAL_OVER"]);
  assert.deepEqual(plan.researchEliteThesisKindsByScope.earlyWindow, []);
  assert.deepEqual(plan.providerMarketKeysToRequestNow, ["totals"]);
  assert.equal(plan.plannedProviderMarketKeys.includes("totals_1st_5_innings"), false);
  assert.equal(result.policy.lateBullpenCanAuthorizeFirstFiveLookup, false);
});

test("late bullpen conflict may block full-game HOME_SIDE while early-window HOME_SIDE still authorizes only F5 ML", () => {
  const result = buildMlbMarketDiscovery({
    intrinsic: intrinsic([strongHomeSide(105)], { 105: { home: certifiedBullpen(0.9) } }),
  });
  const plan = result.games[0];
  assert.deepEqual(plan.researchEliteThesisKindsByScope.fullGame, []);
  assert.deepEqual(plan.researchEliteThesisKindsByScope.earlyWindow, ["HOME_SIDE"]);
  assert.deepEqual(plan.providerMarketKeysToRequestNow, ["h2h_1st_5_innings"]);
});

test("single-axis watch signal opens no paid market bundle", () => {
  const watch = candidate({
    gamePk: 106,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.33),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.18),
    ],
  });
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([watch]) });
  const plan = result.games[0];
  assert.equal(plan.intrinsicResearchClassification, "INTRINSIC_WATCH");
  assert.equal(plan.plannedMarkets.length, 0);
  assert.equal(plan.paidLookupEligibleNow, false);
  assert.equal(plan.paidLookupHoldReason, "NO_STRONG_INTRINSIC_MARKET_THESIS");
});

test("provisional intrinsic Elite retains rank and horizon-specific plans but authorizes zero paid lookup", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([strongHomeSide(107, false)]) });
  const plan = result.games[0];
  assert.equal(plan.intrinsicRank, 1);
  assert.equal(plan.inputStage, "PROVISIONAL");
  assert.equal(plan.plannedProviderMarketKeys.length, 3);
  assert.equal(plan.paidLookupEligibleNow, false);
  assert.equal(plan.paidLookupHoldReason, "OFFICIAL_FINAL_INPUTS_REQUIRED");
  assert.deepEqual(plan.providerMarketKeysToRequestNow, []);
  assert.equal(plan.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
});

test("late provisional intrinsic rank #1 stays #1 while earlier final rank #2 may be price-ready", () => {
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
  assert.equal(result.games[0].inputStage, "PROVISIONAL");
  assert.equal(result.games[0].paidLookupEligibleNow, false);
  assert.equal(result.games[1].inputStage, "FINAL");
  assert.equal(result.games[1].paidLookupEligibleNow, true);
  assert.equal(result.policy.intrinsicRankPreservedAcrossInputStage, true);
});

test("no intrinsic games means no market requests and zero planned cost", () => {
  const result = buildMlbMarketDiscovery({ intrinsic: intrinsic([]) });
  assert.deepEqual(result.games, []);
  assert.equal(result.summary.providerMarketsPlannedNow, 0);
  assert.equal(result.summary.worstCaseCreditsPerOneBookmakerRegionEquivalentNow, 0);
});

test("discovery is zero-odds, direction-preserving and horizon-scoped before any paid lookup", () => {
  const source = fs.readFileSync("server/mlb-market-discovery.ts", "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|api\.the-odds-api\.com|ODDS_API_KEY|x-requests-|setInterval|setTimeout/i);
  assert.doesNotMatch(source, /PREMIUM|ULTRA|automaticBetPlacement|stake|sportsbook.*write/i);
  assert.match(source, /callsTheOddsApi: false/);
  assert.match(source, /theOddsApiCreditsConsumed: 0/);
  assert.match(source, /intrinsicThesisRequiredForPaidLookup: true/);
  assert.match(source, /intrinsicThesisDirectionPreserved: true/);
  assert.match(source, /intrinsicRankPreservedAcrossInputStage: true/);
  assert.match(source, /horizonScopedMarketThesisPlanning: true/);
  assert.match(source, /lateBullpenCanAuthorizeFirstFiveLookup: false/);
  assert.match(source, /firstThreeInningsPriority: false/);
  assert.match(source, /researchOnlyMarketsConsumeProviderCredits: false/);
  assert.match(source, /onlyFinalInputsMayAuthorizePaidLookup: true/);
});
