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
  return {
    component,
    metric,
    valueRuns,
    absoluteRuns: Math.abs(valueRuns),
  };
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
    generatedAt: "2026-08-10T14:00:00.000Z",
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

test("Statcast pitcher deltas are mapped to the offense that faces that pitcher", () => {
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

test("two-sided multi-source separation creates a research-only HOME side elite candidate", () => {
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist([strongHomeSide(2)]) });
  const profile = result.rankedGames[0];

  assert.equal(profile.pressures.homeRuns.state, "CONVERGENT_UP");
  assert.equal(profile.pressures.awayRuns.state, "CONVERGENT_DOWN");
  assert.equal(profile.researchEliteCandidate, true);
  assert.equal(profile.researchClassification, "GAME_ELITE_RESEARCH_CANDIDATE");
  assert.equal(profile.certificationStatus, "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED");
  assert.deepEqual(profile.marketSearchIntents, ["SIDE"]);
  assert.equal(profile.theses.some((item) => item.kind === "HOME_SIDE" && item.structure === "TWO_SIDED_SEPARATION"), true);
});

test("multi-source single-team scoring pressure is a watch thesis, not an elite market-search authorization", () => {
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

  assert.equal(profile.pressures.homeRuns.state, "CONVERGENT_UP");
  assert.equal(profile.theses.some((item) => item.kind === "HOME_TEAM_RUNS_UP"), true);
  assert.equal(profile.researchEliteCandidate, false);
  assert.equal(profile.researchClassification, "INTRINSIC_WATCH");
  assert.deepEqual(profile.marketSearchIntents, []);
});

test("TOTAL thesis requires convergence across at least two run targets rather than one noisy axis", () => {
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
  const profile = result.games[0];
  const total = profile.theses.find((item) => item.kind === "TOTAL_OVER");

  assert.ok(total);
  assert.equal(total?.structure, "MULTI_AXIS_CONVERGENCE");
  assert.deepEqual(total?.supportingTargets, ["HOME_RUNS", "TOTAL_RUNS"]);
  assert.equal(profile.researchEliteCandidate, true);
  assert.deepEqual(profile.marketSearchIntents, ["TOTAL"]);
});

test("opposing certified directions remain conflicted and can never become elite", () => {
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

  assert.equal(profile.pressures.homeRuns.state, "CONFLICTED");
  assert.equal(profile.researchEliteCandidate, false);
  assert.equal(profile.researchClassification, "CONFLICTED_EVIDENCE");
  assert.deepEqual(profile.marketSearchIntents, []);
});

test("certified bullpen can add late-run pressure; uncertified bullpen is warning-only", () => {
  const base = candidate({
    gamePk: 6,
    signals: [signal("ADVANCED_CONTEXT", "totalAdjustment", 0.6)],
  });
  const bullpenByGame: Record<number, MlbIntrinsicBullpenPair> = {
    6: {
      home: { sourceStatus: "DEGRADED", provenance: { status: "DEGRADED" }, runsAdjustment: 0.7 },
      away: certifiedBullpen(0.5),
    },
  };
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist([base]), bullpenByGame });
  const profile = result.games[0];

  assert.equal(profile.signals.some((item) => item.metric === "awayBullpen.runsAdjustment" && item.target === "HOME_RUNS" && item.horizon === "LATE_BULLPEN"), true);
  assert.equal(profile.signals.some((item) => item.metric === "homeBullpen.runsAdjustment"), false);
  assert.deepEqual(profile.warnings, ["HOME_BULLPEN_DEGRADED"]);
});

test("a later provisional game can rank above an earlier final game; time and final-input stage never affect intrinsic rank", () => {
  const earlyFinal = candidate({
    gamePk: 70,
    final: true,
    startTime: "2026-08-10T17:05:00.000Z",
    signals: [
      signal("STATCAST_QUALITY", "awaySP.runsDelta", 0.22),
      signal("DISCIPLINE_SPEED", "homeRunsDelta", 0.12),
      signal("STATCAST_QUALITY", "homeSP.runsDelta", -0.18),
      signal("DISCIPLINE_SPEED", "awayRunsDelta", -0.11),
    ],
  });
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

  const reranked = rankMlbIntrinsicGames([...result.rankedGames].reverse());
  assert.deepEqual(reranked.map((game) => game.gamePk), [71, 70]);
});

test("provisional strong convergence may be a research elite candidate but remains explicitly not outcome-certified", () => {
  const result = buildMlbIntrinsicEdge({ shortlist: shortlist([strongHomeSide(80, false)]) });
  const profile = result.games[0];

  assert.equal(profile.inputStage, "PROVISIONAL");
  assert.equal(profile.researchEliteCandidate, true);
  assert.equal(profile.certificationStatus, "RESEARCH_ONLY_NOT_OUTCOME_CERTIFIED");
  assert.equal(result.summary.provisionalResearchEliteCandidates, 1);
  assert.equal(result.policy.requiresFinalInputsForResearchEliteCandidate, false);
});

test("intrinsic engine is zero-odds, unweighted, and does not import overlapping legacy composite models as extra votes", () => {
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
  assert.match(source, /researchOnlyNotOutcomeCertified: true/);
});
