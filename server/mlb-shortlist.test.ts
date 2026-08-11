import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildMlbShortlist,
  MLB_SHORTLIST_MAX_CANDIDATES,
  rankMlbShortlistCandidates,
  type MlbShortlistFactorPayloads,
} from "./mlb-shortlist";
import {
  MLB_CHEAP_SCREENING_SCHEMA,
  type MlbCheapScreenGameResult,
  type MlbCheapScreeningResult,
} from "./mlb-cheap-screening";

function game(
  gamePk: number,
  disposition: MlbCheapScreenGameResult["disposition"] = "ADVANCE_FINAL",
): MlbCheapScreenGameResult {
  const eligible = disposition === "ADVANCE_FINAL" || disposition === "ADVANCE_PROVISIONAL";
  return {
    gamePk,
    officialDate: "2026-08-10",
    startTime: "2026-08-10T23:10:00.000Z",
    homeTeam: { id: gamePk * 10 + 1, name: `Home ${gamePk}` },
    awayTeam: { id: gamePk * 10 + 2, name: `Away ${gamePk}` },
    homePitcher: { id: gamePk * 10 + 3, name: `Home SP ${gamePk}`, hand: "R", confirmed: true },
    awayPitcher: { id: gamePk * 10 + 4, name: `Away SP ${gamePk}`, hand: "L", confirmed: true },
    lineupState: disposition === "ADVANCE_FINAL" ? "CONFIRMED" : "NOT_POSTED",
    sourceQuality: "AUTHORITATIVE",
    sourceFetchedAt: "2026-08-10T21:00:00.000Z",
    disposition,
    reasonCode: disposition === "ADVANCE_FINAL"
      ? "OFFICIAL_PREGAME_INPUTS_FINAL"
      : disposition === "ADVANCE_PROVISIONAL"
        ? "OFFICIAL_LINEUPS_PENDING"
        : disposition === "DEFER"
          ? "OFFICIAL_DATA_INSUFFICIENT"
          : "GAME_ALREADY_STARTED",
    reasons: [],
    eligibleForDeepPrefilterNow: eligible,
    finalInputsAvailable: disposition === "ADVANCE_FINAL",
  };
}

function cheapScreen(games: MlbCheapScreenGameResult[]): MlbCheapScreeningResult {
  return {
    schemaVersion: MLB_CHEAP_SCREENING_SCHEMA,
    date: "2026-08-10",
    generatedAt: "2026-08-10T21:00:00.000Z",
    sourceSlateSchemaVersion: "courtedge-p1-m1-mlb-daily-slate.v1",
    games,
    summary: {
      total: games.length,
      advanceFinal: games.filter((g) => g.disposition === "ADVANCE_FINAL").length,
      advanceProvisional: games.filter((g) => g.disposition === "ADVANCE_PROVISIONAL").length,
      deferred: games.filter((g) => g.disposition === "DEFER").length,
      dropped: games.filter((g) => g.disposition === "DROP").length,
      deepPrefilterEligibleNow: games.filter((g) => g.eligibleForDeepPrefilterNow).length,
    },
    policy: {
      marketAgnostic: true,
      ranksGames: false,
      capsCandidateCount: false,
      requiresMarketOdds: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      automaticRetryOrPolling: false,
      deferredGamesRequireNewExplicitRun: true,
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

const certified = <T extends object>(value: T) => ({
  ...value,
  sourceStatus: "CERTIFIED",
  provenance: { status: "CERTIFIED" },
});

function evidence(input: Partial<MlbShortlistFactorPayloads>): MlbShortlistFactorPayloads {
  return input;
}

test("uncertified or degraded factor payloads never create shortlist signals", () => {
  const result = buildMlbShortlist({
    cheapScreen: cheapScreen([game(1)]),
    evidenceByGame: {
      1: evidence({
        statcastQuality: {
          sourceStatus: "DEGRADED",
          provenance: { status: "DEGRADED" },
          homeSP: { runsDelta: 0.5 },
        },
        disciplineSpeed: {
          sourceStatus: "CERTIFIED",
          provenance: { status: "DEGRADED" },
          homeRunsDelta: 0.3,
        },
      }),
    },
  });

  assert.equal(result.selected.length, 0);
  assert.equal(result.candidates[0].certifiedComponentCount, 0);
  assert.equal(result.candidates[0].independentSignalCount, 0);
  assert.deepEqual(result.candidates[0].warnings.sort(), [
    "DISCIPLINE_SPEED_CERTIFIED",
    "STATCAST_QUALITY_DEGRADED",
  ]);
});

test("native run signals are preserved without weighted aggregation", () => {
  const result = buildMlbShortlist({
    cheapScreen: cheapScreen([game(2)]),
    evidenceByGame: {
      2: evidence({
        statcastQuality: certified({
          homeSP: { runsDelta: 0.42 },
          awaySP: { runsDelta: -0.11 },
        }),
        disciplineSpeed: certified({ homeRunsDelta: 0.18, awayRunsDelta: -0.06 }),
        sos: certified({
          home: { recentRpg: 4.2, adjustedRpg: 4.6 },
          away: { recentRpg: 5.0, adjustedRpg: 4.7 },
        }),
        advancedContext: certified({ totalAdjustment: 0.9 }),
      }),
    },
  });

  const candidate = result.selected[0];
  assert.equal(candidate.certifiedComponentCount, 4);
  assert.equal(candidate.independentSignalCount, 4);
  assert.equal(candidate.maxAbsoluteNativeRunSignal, 0.9);
  assert.deepEqual(
    candidate.signals.map((signal) => [signal.component, signal.metric, signal.valueRuns]),
    [
      ["STATCAST_QUALITY", "homeSP.runsDelta", 0.42],
      ["STATCAST_QUALITY", "awaySP.runsDelta", -0.11],
      ["DISCIPLINE_SPEED", "homeRunsDelta", 0.18],
      ["DISCIPLINE_SPEED", "awayRunsDelta", -0.06],
      ["SOS", "home.adjustedRpgDelta", 0.4],
      ["SOS", "away.adjustedRpgDelta", -0.3],
      ["ADVANCED_CONTEXT", "totalAdjustment", 0.9],
    ],
  );
  assert.equal(result.policy.weightsApplied, false);
});

test("ranking is deterministic: independent certified signal count, then max native magnitude, then coverage", () => {
  const result = buildMlbShortlist({
    cheapScreen: cheapScreen([game(10), game(11), game(12), game(13, "ADVANCE_PROVISIONAL")]),
    evidenceByGame: {
      10: evidence({
        statcastQuality: certified({ homeSP: { runsDelta: 0.49 } }),
      }),
      11: evidence({
        statcastQuality: certified({ homeSP: { runsDelta: 0.20 } }),
        disciplineSpeed: certified({ homeRunsDelta: 0.10, awayRunsDelta: 0 }),
      }),
      12: evidence({
        statcastQuality: certified({ homeSP: { runsDelta: 0.20 } }),
        disciplineSpeed: certified({ homeRunsDelta: 0.10, awayRunsDelta: 0 }),
        sos: certified({ home: { recentRpg: 4.0, adjustedRpg: 4.0 } }),
      }),
      13: evidence({
        statcastQuality: certified({ homeSP: { runsDelta: 0.20 } }),
        disciplineSpeed: certified({ homeRunsDelta: 0.10, awayRunsDelta: 0 }),
        sos: certified({ home: { recentRpg: 4.0, adjustedRpg: 4.0 } }),
      }),
    },
  });

  assert.deepEqual(result.selected.map((candidate) => candidate.gamePk), [12, 13, 11, 10]);
  assert.equal(result.selected[0].certifiedComponentCount, 3);
  assert.equal(result.selected[0].independentSignalCount, 2);
  assert.equal(result.selected[1].finalInputsAvailable, false);

  const reversed = rankMlbShortlistCandidates([...result.selected].reverse());
  assert.deepEqual(reversed.map((candidate) => candidate.gamePk), [12, 13, 11, 10]);
});

test("zero certified native run signals means zero shortlist; there is no forced quota", () => {
  const result = buildMlbShortlist({
    cheapScreen: cheapScreen([game(20), game(21)]),
    evidenceByGame: {
      20: evidence({ disciplineSpeed: certified({ homeRunsDelta: 0, awayRunsDelta: 0 }) }),
      21: evidence({
        sos: certified({
          home: { recentRpg: 4.5, adjustedRpg: 4.5 },
          away: { recentRpg: 3.9, adjustedRpg: 3.9 },
        }),
      }),
    },
  });

  assert.equal(result.summary.evaluated, 2);
  assert.equal(result.summary.qualified, 0);
  assert.equal(result.summary.selected, 0);
  assert.equal(result.summary.noCertifiedSignal, 2);
  assert.equal(result.policy.forcedQuota, false);
});

test("deferred and dropped cheap-screen games cannot enter shortlist even with strong certified evidence", () => {
  const result = buildMlbShortlist({
    cheapScreen: cheapScreen([game(30, "DEFER"), game(31, "DROP"), game(32)]),
    evidenceByGame: {
      30: evidence({ advancedContext: certified({ totalAdjustment: 2.4 }) }),
      31: evidence({ advancedContext: certified({ totalAdjustment: -2.1 }) }),
      32: evidence({ advancedContext: certified({ totalAdjustment: 0.3 }) }),
    },
  });

  assert.equal(result.summary.cheapScreenEligible, 1);
  assert.deepEqual(result.candidates.map((candidate) => candidate.gamePk), [32]);
  assert.deepEqual(result.selected.map((candidate) => candidate.gamePk), [32]);
});

test("hard maximum is eight candidates and remains a cap rather than a quota", () => {
  const games = Array.from({ length: 10 }, (_, index) => game(100 + index));
  const evidenceByGame = Object.fromEntries(games.map((g, index) => [
    g.gamePk,
    evidence({ advancedContext: certified({ totalAdjustment: 1 - index * 0.05 }) }),
  ]));

  const result = buildMlbShortlist({ cheapScreen: cheapScreen(games), evidenceByGame });
  assert.equal(MLB_SHORTLIST_MAX_CANDIDATES, 8);
  assert.equal(result.summary.qualified, 10);
  assert.equal(result.summary.selected, 8);
  assert.equal(result.summary.overflowQualified, 2);
  assert.equal(result.policy.maxCandidates, 8);
  assert.equal(result.policy.hardMaximumCandidates, 8);
});

test("caller may lower the cap but cannot exceed the hard maximum", () => {
  const games = [game(201), game(202), game(203)];
  const evidenceByGame = Object.fromEntries(games.map((g) => [
    g.gamePk,
    evidence({ advancedContext: certified({ totalAdjustment: 0.2 }) }),
  ]));

  const result = buildMlbShortlist({ cheapScreen: cheapScreen(games), evidenceByGame, maxCandidates: 2 });
  assert.equal(result.selected.length, 2);
  assert.throws(
    () => buildMlbShortlist({
      cheapScreen: cheapScreen(games),
      evidenceByGame,
      maxCandidates: MLB_SHORTLIST_MAX_CANDIDATES + 1,
    }),
    /MLB_SHORTLIST_MAX_CANDIDATES_OUT_OF_RANGE/,
  );
});

test("shortlist source has no odds provider, timer, polling, model formula, stake, or weighted-score capability", () => {
  const source = fs.readFileSync("server/mlb-shortlist.ts", "utf8");
  assert.doesNotMatch(source, /api\.the-odds-api\.com|ODDS_API_KEY|x-requests-|setInterval|setTimeout/i);
  assert.doesNotMatch(source, /\bPREMIUM\b|\bULTRA\b|\bstake\b|\bprobability\b|\bconfidence\b|weightedScore|modelFormula/i);
  assert.match(source, /requiresMarketOdds: false/);
  assert.match(source, /theOddsApiCreditsConsumed: 0/);
  assert.match(source, /weightsApplied: false/);
  assert.match(source, /forcedQuota: false/);
});
