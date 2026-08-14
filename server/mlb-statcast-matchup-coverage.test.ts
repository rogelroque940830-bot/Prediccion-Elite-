import assert from "node:assert/strict";
import test from "node:test";
import { buildStatcastMatchupCoverageReport } from "./mlb-statcast-matchup-coverage";

function batter(id: number, dataQuality = "DIRECT") {
  return { batterId: id, batterName: `Batter ${id}`, dataQuality };
}

function side(options: {
  qualities?: string[];
  bullpenEvaluated?: number;
  lineupSize?: number;
  arsenalPitchTypes?: number;
} = {}) {
  const qualities = options.qualities ?? Array(9).fill("DIRECT");
  return {
    lineupSize: options.lineupSize ?? 9,
    perBatter: qualities.map((dataQuality, index) => batter(index + 1, dataQuality)),
    arsenal: Array.from({ length: options.arsenalPitchTypes ?? 2 }, (_, index) => ({
      type: index === 0 ? "FF" : "SL",
      name: index === 0 ? "4-Seam Fastball" : "Slider",
      usage: index === 0 ? 55 : 45,
      wobaAgainst: 0.3,
      whiff: 25,
    })),
    bullpenMatchup: Array.from({ length: options.bullpenEvaluated ?? 3 }, (_, index) => ({
      pitcherId: 100 + index,
      expectedRunsDelta: 0,
    })),
  };
}

function history(opponent: number, options: { failures?: number; successful?: number; requested?: number } = {}) {
  return {
    identity: {
      opposingTeamId: opponent,
      requestedBatters: options.requested ?? 9,
      successfulQueries: options.successful ?? 9,
      usableRows: 7,
      failures: options.failures ?? 0,
    },
  };
}

function completeResult() {
  return {
    homeLineupVsAwaySP: side(),
    awayLineupVsHomeSP: side(),
    homeLineupVsAwayTeam: history(116),
    awayLineupVsHomeTeam: history(112),
    homeRunsDelta: 0.12,
    awayRunsDelta: -0.08,
  };
}

test("production payload shape can reach perfect visible coverage but remains non-certifiable", () => {
  const result = completeResult();
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.schemaVersion, "courtedge-mlb-statcast-matchup-coverage.v2");
  assert.equal(report.visibleCoverageComplete, true);
  assert.equal(report.certificationState, "BLOCKED_UNOBSERVABLE_PROVENANCE");
  assert.equal(report.home.directBatterCoveragePct, 100);
  assert.equal(report.home.starterPitchTypes, 2);
  assert.equal(report.away.directBatterCoveragePct, 100);
  assert.equal(report.hiddenProvenance.pitcherArsenalSourceObservable, false);
  assert.equal(report.hiddenProvenance.bullpenRosterCoverageObservable, false);
  assert.equal(report.hiddenProvenance.recentBatterStatsCoverageObservable, false);
  assert.equal(report.hiddenProvenance.cacheObservationTimesObservable, false);
  assert.ok(report.blockers.includes("STATCAST_MATCHUP_CACHE_OBSERVATION_TIMES_UNOBSERVABLE"));
  assert.equal(result.homeRunsDelta, 0.12);
  assert.equal(result.awayRunsDelta, -0.08);
  assert.equal(report.safety.modelOutputChanged, false);
});

test("projected or previous-game lineup blocks certification before provenance questions", () => {
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: completeResult(),
    homeCurrentLineupConfirmed: false,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.certificationState, "BLOCKED_UNCONFIRMED_LINEUP");
  assert.equal(report.visibleCoverageComplete, false);
  assert.ok(report.blockers.includes("STATCAST_MATCHUP_CURRENT_LINEUP_NOT_CONFIRMED"));
});

test("TEAM_PROXY and LEAGUE dataQuality are visible coverage gaps, not direct evidence", () => {
  const result = completeResult();
  result.homeLineupVsAwaySP = side({
    qualities: ["DIRECT", "DIRECT", "DIRECT", "DIRECT", "DIRECT", "TEAM_PROXY", "TEAM_PROXY", "LEAGUE", "DIRECT"],
  });
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.certificationState, "BLOCKED_VISIBLE_COVERAGE_GAP");
  assert.equal(report.home.batterSourceCounts.direct, 6);
  assert.equal(report.home.batterSourceCounts.teamProxy, 2);
  assert.equal(report.home.batterSourceCounts.leagueFallback, 1);
  assert.equal(report.home.directBatterCoveragePct, 66.6667);
});

test("unknown dataQuality cannot be counted as direct evidence", () => {
  const result = completeResult();
  result.awayLineupVsHomeSP = side({
    qualities: ["DIRECT", "DIRECT", "DIRECT", "DIRECT", "DIRECT", "DIRECT", "DIRECT", "DIRECT", ""],
  });
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.certificationState, "BLOCKED_VISIBLE_COVERAGE_GAP");
  assert.equal(report.away.batterSourceCounts.unknown, 1);
});

test("empty starter arsenal prevents visible coverage completeness without pretending its source is known", () => {
  const result = completeResult();
  result.awayLineupVsHomeSP = side({ arsenalPitchTypes: 0 });
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.certificationState, "BLOCKED_VISIBLE_COVERAGE_GAP");
  assert.equal(report.away.starterPitchTypes, 0);
  assert.equal(report.hiddenProvenance.pitcherArsenalSourceObservable, false);
});

test("zero evaluated bullpen pitchers prevents visible coverage completeness", () => {
  const result = completeResult();
  result.homeLineupVsAwaySP = side({ bullpenEvaluated: 0 });
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.certificationState, "BLOCKED_VISIBLE_COVERAGE_GAP");
  assert.equal(report.home.bullpenEvaluated, 0);
});

test("numeric vs-team identity query failures prevent visible coverage completeness", () => {
  const result = completeResult();
  result.homeLineupVsAwayTeam = history(116, { failures: 1, successful: 8 });
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.certificationState, "BLOCKED_VISIBLE_COVERAGE_GAP");
  assert.equal(report.home.history.opposingTeamId, 116);
  assert.equal(report.home.history.failures, 1);
  assert.equal(report.home.history.successfulQueries, 8);
});

test("lineupSize from production payload is enforced even when perBatter happens to contain nine rows", () => {
  const result = completeResult();
  result.homeLineupVsAwaySP = side({ lineupSize: 8 });
  result.homeLineupVsAwaySP.perBatter.push(batter(10));
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  // max(lineupSize, perBatter.length) prevents under-counting but also makes the
  // extra row observable rather than silently accepting a malformed 8-player source.
  assert.equal(report.home.lineupBatterCount, 10);
  assert.equal(report.certificationState, "BLOCKED_VISIBLE_COVERAGE_GAP");
});

test("coverage accounting does not read or modify result outcome deltas", () => {
  const result = completeResult() as any;
  result.homeRunsDelta = 999;
  result.awayRunsDelta = -999;
  const report = buildStatcastMatchupCoverageReport({
    identitySafeResult: result,
    homeCurrentLineupConfirmed: true,
    awayCurrentLineupConfirmed: true,
  });

  assert.equal(report.visibleCoverageComplete, true);
  assert.equal(report.certificationState, "BLOCKED_UNOBSERVABLE_PROVENANCE");
  assert.equal(result.homeRunsDelta, 999);
  assert.equal(result.awayRunsDelta, -999);
  assert.equal(report.safety.probabilityChanged, false);
  assert.equal(report.safety.actionabilityAllowed, false);
  assert.equal(report.safety.automaticPromotionAllowed, false);
});
