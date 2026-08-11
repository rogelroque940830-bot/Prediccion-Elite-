import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildMlbIntrinsicEdge,
  rankMlbIntrinsicGames,
  type MlbIntrinsicBullpenPair,
} from "./mlb-intrinsic-edge";
import {
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

function shortlist(
  candidates: MlbShortlistCandidate[],
  selected: MlbShortlistCandidate[] = candidates,
): MlbShortlistResult {
  return {
    schemaVersion: MLB_SHORTLIST_SCHEMA,
    generatedAt: "2026-08-10T14:00:00.000Z",
    date: "2026-08-10",
    sourceCheapScreenSchemaVersion: "courtedge-p0-mlb-cheap-screening.v1",
    candidates,
    selected,
    summary: {
      cheapScreenEligible: candidates.length,
      evaluated: candidates.length,
      qualified: candidates.filter((item) => item.qualifiedForShortlist).length,
      selected: selected.length,
      overflowQualified: Math.max(0, candidates.filter((item) => item.qualifiedForShortlist).length - selected.length),
      noCertifiedSignal: candidates.filter((item) => !item.qualifiedForShortlist).length,
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
      maxCandidates: 8,
      hardMaximumCandidates: 8,
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

test("Statcast pitcher deltas map to the offense that faces that pitcher", () => {
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([candidate({
      gamePk: 1,
      signals: [
        signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.31),
        signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.24),
      ],
    })]),
  });
  const profile = result.games[0];
  const home = profile.signals.find((item) => item.metric === "awaySP.runsDelta");
  const away = profile.signals.find((item) => item.metric === "homeSP.runsDelta");
  assert.equal(home?.target, "HOME_RUNS");
  assert.equal(home?.direction, "UP");
  assert.equal(away?.target, "AWAY_RUNS");
  assert.equal(away?.direction, "DOWN");
});

test("two-sided starter convergence creates HOME_SIDE in both full-game and early projections", () => {
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist([strongHomeSide(2)]) });
  const profile = result.games[0];
  assert.equal(profile.projections.fullGame.pressures.homeRuns.state, "CONVERGENT_UP");
  assert.equal(profile.projections.fullGame.pressures.awayRuns.state, "CONVERGENT_DOWN");
  assert.equal(profile.projections.earlyWindow.pressures.homeRuns.state, "CONVERGENT_UP");
  assert.equal(profile.projections.earlyWindow.pressures.awayRuns.state, "CONVERGENT_DOWN");
  assert.equal(profile.projections.fullGame.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), true);
  assert.equal(profile.projections.earlyWindow.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), true);
  assert.equal(profile.researchEliteCandidate, true);
  assert.equal(profile.certificationStatus, "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED");
});

test("single-team multi-source pressure remains a watch thesis, not research Elite", () => {
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([candidate({
      gamePk: 3,
      signals: [
        signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.35),
        signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.18),
      ],
    })]),
  });
  const profile = result.games[0];
  assert.equal(profile.projections.fullGame.theses.some((item) => item.kind === "HOME_TEAM_RUNS_UP"), true);
  assert.equal(profile.projections.earlyWindow.theses.some((item) => item.kind === "HOME_TEAM_RUNS_UP"), true);
  assert.equal(profile.researchEliteCandidate, false);
  assert.equal(profile.researchClassification, "INTRINSIC_WATCH");
});

test("TOTAL Elite thesis requires multi-source convergence across at least two run targets", () => {
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([candidate({
      gamePk: 4,
      signals: [
        signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.32),
        signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.16),
        signal("ADVANCED_CONTEXT", "totalAdjustment", 0.8),
      ],
    })]),
  });
  for (const projection of [result.games[0].projections.fullGame, result.games[0].projections.earlyWindow]) {
    const total = projection.theses.find((item) => item.kind === "TOTAL_OVER");
    assert.ok(total);
    assert.equal(total?.structure, "MULTI_AXIS_CONVERGENCE");
    assert.deepEqual(total?.supportingTargets, ["HOME_RUNS", "TOTAL_RUNS"]);
    assert.equal(total?.researchEliteEligible, true);
  }
});

test("opposing certified directions conflict inside the qualifying projection and cannot become Elite", () => {
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([candidate({
      gamePk: 5,
      signals: [
        signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.35),
        signal("DISCIPLINE_SPEED", "homeRunsDelta", -0.22),
        signal("ADVANCED_CONTEXT", "totalAdjustment", 0.7),
      ],
    })]),
  });
  const profile = result.games[0];
  assert.equal(profile.projections.fullGame.pressures.homeRuns.state, "CONFLICTED");
  assert.equal(profile.projections.earlyWindow.pressures.homeRuns.state, "CONFLICTED");
  assert.equal(profile.researchEliteCandidate, false);
  assert.equal(profile.researchClassification, "CONFLICTED_EVIDENCE");
});

test("certified bullpen is late-only: it may create full-game TOTAL_OVER but can never create early-window TOTAL_OVER", () => {
  const base = candidate({ gamePk: 6, signals: [signal("ADVANCED_CONTEXT", "totalAdjustment", 0.6)] });
  const bullpenByGame: Record<number, MlbIntrinsicBullpenPair> = { 6: { away: certifiedBullpen(0.5) } };
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist([base]), bullpenByGame });
  const profile = result.games[0];
  assert.equal(profile.projections.fullGame.theses.some((item) => item.kind === "TOTAL_OVER" && item.researchEliteEligible), true);
  assert.equal(profile.projections.earlyWindow.theses.some((item) => item.kind === "TOTAL_OVER" && item.researchEliteEligible), false);
  assert.equal(profile.projections.earlyWindow.signals.some((item) => item.component === "BULLPEN"), false);
  assert.deepEqual(profile.projections.earlyWindow.includedHorizons, ["EARLY_STARTER", "CROSS_HORIZON"]);
  assert.equal(result.policy.lateBullpenEvidenceAllowedInEarlyWindow, false);
});

test("late bullpen conflict can invalidate full-game side while preserving an early HOME_SIDE thesis", () => {
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([strongHomeSide(7)]),
    bullpenByGame: { 7: { home: certifiedBullpen(0.9) } },
  });
  const profile = result.games[0];
  assert.equal(profile.projections.fullGame.pressures.awayRuns.state, "CONFLICTED");
  assert.equal(profile.projections.fullGame.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), false);
  assert.equal(profile.projections.earlyWindow.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), true);
  assert.equal(profile.researchEliteCandidate, true);
});

test("late bullpen can complete full-game HOME_SIDE without fabricating early-window HOME_SIDE", () => {
  const base = candidate({
    gamePk: 8,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.31),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.29),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.18),
    ],
  });
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([base]),
    bullpenByGame: { 8: { away: certifiedBullpen(0.45) } },
  });
  const profile = result.games[0];
  assert.equal(profile.projections.fullGame.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), true);
  assert.equal(profile.projections.earlyWindow.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), false);
});

test("uncertified bullpen remains warning-only in every projection", () => {
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([candidate({ gamePk: 9, signals: [signal("ADVANCED_CONTEXT", "totalAdjustment", 0.6)] })]),
    bullpenByGame: { 9: { home: { sourceStatus: "DEGRADED", provenance: { status: "DEGRADED" }, runsAdjustment: 0.7 } } },
  });
  const profile = result.games[0];
  assert.equal(profile.signals.some((item) => item.component === "BULLPEN"), false);
  assert.deepEqual(profile.warnings, ["HOME_BULLPEN_DEGRADED"]);
});

test("duplicate HOME_SIDE across full and early projections counts once before support strength breaks ties", () => {
  const duplicatedAcrossHorizons = strongHomeSide(20);
  const strongerFullOnly = candidate({
    gamePk: 21,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.31),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.29),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.18),
    ],
  });
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([duplicatedAcrossHorizons, strongerFullOnly]),
    bullpenByGame: { 21: { away: certifiedBullpen(0.45) } },
  });
  assert.deepEqual(result.rankedGames.map((game) => game.gamePk), [21, 20]);
  assert.equal(result.policy.duplicateHorizonThesisKindsCountOnceInRank, true);
});

test("non-qualifying late bullpen magnitude cannot outrank stronger F5-only thesis evidence", () => {
  const weakerEarlyHugeLateConflict = candidate({
    gamePk: 30,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.30),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.20),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.28),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.17),
    ],
  });
  const strongerEarlySmallerLateConflict = candidate({
    gamePk: 31,
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.36),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.22),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.31),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.19),
    ],
  });
  const result = buildMlbIntrinsicEdge({
    shortlist: shortlist([weakerEarlyHugeLateConflict, strongerEarlySmallerLateConflict]),
    bullpenByGame: {
      30: { home: certifiedBullpen(3.0) },
      31: { home: certifiedBullpen(0.40) },
    },
  });

  const weaker = result.games.find((game) => game.gamePk === 30)!;
  const stronger = result.games.find((game) => game.gamePk === 31)!;
  assert.equal(weaker.projections.fullGame.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), false);
  assert.equal(stronger.projections.fullGame.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), false);
  assert.equal(weaker.projections.earlyWindow.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), true);
  assert.equal(stronger.projections.earlyWindow.theses.some((item) => item.kind === "HOME_SIDE" && item.researchEliteEligible), true);
  assert.equal(weaker.maxAbsoluteNativeRunSignal, 3.0);
  assert.equal(stronger.maxAbsoluteNativeRunSignal, 0.4);
  assert.deepEqual(result.rankedGames.map((game) => game.gamePk), [31, 30]);
  assert.equal(result.policy.nonQualifyingSignalsAffectIntrinsicRank, false);
});

test("later PROVISIONAL game can rank above earlier FINAL game; time and stage do not affect intrinsic rank", () => {
  const earlyFinal = strongHomeSide(70, true, "2026-08-10T17:05:00.000Z");
  const lateProvisional = candidate({
    gamePk: 71,
    final: false,
    startTime: "2026-08-11T01:40:00.000Z",
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.44),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.29),
      signal("SOS", "home.adjustedRpgDelta", 0.5),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.38),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.23),
      signal("SOS", "away.adjustedRpgDelta", -0.4),
    ],
  });
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist([earlyFinal, lateProvisional]) });
  assert.deepEqual(result.rankedGames.map((game) => game.gamePk), [71, 70]);
  assert.equal(result.rankedGames[0].inputStage, "PROVISIONAL");
  assert.equal(result.rankedGames[1].inputStage, "FINAL");
  assert.equal(result.policy.finalInputsAffectIntrinsicRank, false);
  assert.equal(result.policy.gameStartTimeAffectsIntrinsicRank, false);
  assert.deepEqual(rankMlbIntrinsicGames([...result.rankedGames].reverse()).map((game) => game.gamePk), [71, 70]);
});

test("upstream shortlist selected cap cannot exclude a coherent PROVISIONAL Elite thesis before intrinsic ranking", () => {
  const upstreamSelected: MlbShortlistCandidate[] = Array.from({ length: 8 }, (_, index) => candidate({
    gamePk: 200 + index,
    final: true,
    signals: [signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.10 + index * 0.001)],
  }));
  const lateProvisionalElite = candidate({
    gamePk: 299,
    final: false,
    startTime: "2026-08-11T01:40:00.000Z",
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.42),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.27),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.37),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.22),
    ],
  });
  const allCandidates = [...upstreamSelected, lateProvisionalElite];
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist(allCandidates, upstreamSelected) });

  assert.equal(result.summary.qualifiedInputCandidates, 9);
  assert.equal(result.summary.selectedForMarketDiscovery, 8);
  assert.equal(result.summary.overflowAfterIntrinsicRanking, 1);
  assert.equal(result.rankedGames[0].gamePk, 299);
  assert.equal(result.rankedGames[0].inputStage, "PROVISIONAL");
  assert.equal(result.rankedGames.some((game) => game.gamePk === 299), true);
  assert.equal(result.policy.upstreamShortlistSelectedCapAffectsIntrinsicPopulation, false);
  assert.equal(result.policy.intrinsicCapAppliedAfterIntrinsicRanking, true);
});

test("provisional convergence may be research Elite while remaining explicitly not outcome-certified", () => {
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist([strongHomeSide(80, false)]) });
  const profile = result.games[0];
  assert.equal(profile.inputStage, "PROVISIONAL");
  assert.equal(profile.researchEliteCandidate, true);
  assert.equal(profile.certificationStatus, "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED");
  assert.equal(result.summary.provisionalResearchEliteCandidates, 1);
  assert.equal(result.policy.requiresFinalInputsForResearchEliteCandidate, false);
});

test("intrinsic engine is zero-odds, unweighted, horizon-scoped, post-rank capped, and excludes overlapping composites", () => {
  const source = fs.readFileSync("server/mlb-intrinsic-edge.ts", "utf8");
  assert.doesNotMatch(source, /api\.the-odds-api\.com|ODDS_API_KEY|x-requests-|\bfetch\s*\(|setInterval|setTimeout/i);
  assert.doesNotMatch(source, /from\s+["']\.\/mlb-(ere|tesi|f5-unified|early-markets)/i);
  assert.doesNotMatch(source, /\bPREMIUM\b|\bULTRA\b|\bmodelProbability\b|\bimpliedProbability\b|\bweightedScore\s*[:=]/i);
  assert.match(source, /oddsAffectIntrinsicRank: false/);
  assert.match(source, /finalInputsAffectIntrinsicRank: false/);
  assert.match(source, /gameStartTimeAffectsIntrinsicRank: false/);
  assert.match(source, /weightedScoreApplied: false/);
  assert.match(source, /legacyCompositeModelsCountAsIndependentEvidence: false/);
  assert.match(source, /sameUnderlyingEvidenceDoubleCountingAllowed: false/);
  assert.match(source, /duplicateHorizonThesisKindsCountOnceInRank: true/);
  assert.match(source, /nonQualifyingSignalsAffectIntrinsicRank: false/);
  assert.match(source, /contradictionsWithinQualifyingProjectionCanBeElite: false/);
  assert.match(source, /horizonScopedThesesRequired: true/);
  assert.match(source, /lateBullpenEvidenceAllowedInEarlyWindow: false/);
  assert.match(source, /upstreamShortlistSelectedCapAffectsIntrinsicPopulation: false/);
  assert.match(source, /intrinsicCapAppliedAfterIntrinsicRanking: true/);
  assert.match(source, /researchOnlyNotOutcomeCertified: true/);
});
