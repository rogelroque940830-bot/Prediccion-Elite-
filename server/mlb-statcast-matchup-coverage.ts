export const MLB_STATCAST_MATCHUP_COVERAGE_SCHEMA = "courtedge-mlb-statcast-matchup-coverage.v2" as const;

export type StatcastMatchupCertificationState =
  | "BLOCKED_UNCONFIRMED_LINEUP"
  | "BLOCKED_VISIBLE_COVERAGE_GAP"
  | "BLOCKED_UNOBSERVABLE_PROVENANCE";

export interface StatcastSideCoverage {
  currentLineupConfirmed: boolean;
  lineupBatterCount: number;
  batterSourceCounts: {
    direct: number;
    teamProxy: number;
    leagueFallback: number;
    unknown: number;
  };
  directBatterCoveragePct: number;
  starterPitchTypes: number;
  bullpenEvaluated: number;
  history: {
    requestedBatters: number;
    successfulQueries: number;
    usableRows: number;
    failures: number;
    opposingTeamId: number | null;
  };
}

export interface StatcastMatchupCoverageReport {
  schemaVersion: typeof MLB_STATCAST_MATCHUP_COVERAGE_SCHEMA;
  certificationState: StatcastMatchupCertificationState;
  visibleCoverageComplete: boolean;
  home: StatcastSideCoverage;
  away: StatcastSideCoverage;
  hiddenProvenance: {
    pitcherArsenalSourceObservable: false;
    bullpenRosterCoverageObservable: false;
    recentBatterStatsCoverageObservable: false;
    cacheObservationTimesObservable: false;
  };
  blockers: string[];
  safety: {
    modelOutputChanged: false;
    probabilityChanged: false;
    economicThresholdChanged: false;
    actionabilityAllowed: false;
    automaticPromotionAllowed: false;
  };
}

function finiteNonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function positiveTeamId(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sourceCounts(perBatter: any[]): StatcastSideCoverage["batterSourceCounts"] {
  const counts = { direct: 0, teamProxy: 0, leagueFallback: 0, unknown: 0 };
  for (const row of perBatter) {
    // The production engine exposes `dataQuality`, not `source`.
    const source = String(row?.dataQuality ?? "").trim().toUpperCase();
    if (source === "DIRECT") counts.direct++;
    else if (source === "TEAM_PROXY") counts.teamProxy++;
    else if (source === "LEAGUE") counts.leagueFallback++;
    else counts.unknown++;
  }
  return counts;
}

function sideCoverage(input: {
  matchup: any;
  history: any;
  currentLineupConfirmed: boolean;
}): StatcastSideCoverage {
  const perBatter = Array.isArray(input.matchup?.perBatter) ? input.matchup.perBatter : [];
  const counts = sourceCounts(perBatter);
  const lineupSize = Number(input.matchup?.lineupSize);
  const lineupBatterCount = Math.max(
    Number.isInteger(lineupSize) && lineupSize >= 0 ? lineupSize : 0,
    perBatter.length,
  );
  const historyIdentity = input.history?.identity ?? {};
  const directBatterCoveragePct = lineupBatterCount > 0
    ? Math.round((counts.direct / lineupBatterCount) * 1_000_000) / 10_000
    : 0;

  return {
    currentLineupConfirmed: input.currentLineupConfirmed,
    lineupBatterCount,
    batterSourceCounts: counts,
    directBatterCoveragePct,
    // Production exposes the actual starter arsenal as an array.
    starterPitchTypes: Array.isArray(input.matchup?.arsenal) ? input.matchup.arsenal.length : 0,
    bullpenEvaluated: Array.isArray(input.matchup?.bullpenMatchup) ? input.matchup.bullpenMatchup.length : 0,
    history: {
      requestedBatters: finiteNonNegative(historyIdentity.requestedBatters),
      successfulQueries: finiteNonNegative(historyIdentity.successfulQueries),
      usableRows: finiteNonNegative(historyIdentity.usableRows),
      failures: finiteNonNegative(historyIdentity.failures),
      opposingTeamId: positiveTeamId(historyIdentity.opposingTeamId),
    },
  };
}

function visibleSideComplete(side: StatcastSideCoverage): boolean {
  return side.currentLineupConfirmed
    && side.lineupBatterCount === 9
    && side.batterSourceCounts.direct === 9
    && side.batterSourceCounts.teamProxy === 0
    && side.batterSourceCounts.leagueFallback === 0
    && side.batterSourceCounts.unknown === 0
    && side.starterPitchTypes > 0
    && side.bullpenEvaluated > 0
    && side.history.requestedBatters === 9
    && side.history.successfulQueries === 9
    && side.history.failures === 0
    && side.history.opposingTeamId != null;
}

export function buildStatcastMatchupCoverageReport(input: {
  identitySafeResult: any;
  homeCurrentLineupConfirmed: boolean;
  awayCurrentLineupConfirmed: boolean;
}): StatcastMatchupCoverageReport {
  const result = input.identitySafeResult ?? {};
  const home = sideCoverage({
    matchup: result.homeLineupVsAwaySP,
    history: result.homeLineupVsAwayTeam,
    currentLineupConfirmed: input.homeCurrentLineupConfirmed,
  });
  const away = sideCoverage({
    matchup: result.awayLineupVsHomeSP,
    history: result.awayLineupVsHomeTeam,
    currentLineupConfirmed: input.awayCurrentLineupConfirmed,
  });
  const visibleCoverageComplete = visibleSideComplete(home) && visibleSideComplete(away);
  const blockers: string[] = [];

  if (!home.currentLineupConfirmed || !away.currentLineupConfirmed) {
    blockers.push("STATCAST_MATCHUP_CURRENT_LINEUP_NOT_CONFIRMED");
  }
  if (!visibleCoverageComplete) {
    blockers.push("STATCAST_MATCHUP_VISIBLE_COVERAGE_INCOMPLETE");
  }

  // These four provenance dimensions are not represented in the legacy result.
  // In particular, the presence of an arsenal array does not reveal whether it
  // came from current Savant, prior-season Savant, Stats API, or a cache.
  blockers.push(
    "STATCAST_MATCHUP_PITCHER_ARSENAL_PROVENANCE_UNOBSERVABLE",
    "STATCAST_MATCHUP_BULLPEN_ROSTER_COVERAGE_UNOBSERVABLE",
    "STATCAST_MATCHUP_RECENT_BATTER_STATS_COVERAGE_UNOBSERVABLE",
    "STATCAST_MATCHUP_CACHE_OBSERVATION_TIMES_UNOBSERVABLE",
  );

  const certificationState: StatcastMatchupCertificationState =
    !home.currentLineupConfirmed || !away.currentLineupConfirmed
      ? "BLOCKED_UNCONFIRMED_LINEUP"
      : !visibleCoverageComplete
        ? "BLOCKED_VISIBLE_COVERAGE_GAP"
        : "BLOCKED_UNOBSERVABLE_PROVENANCE";

  return {
    schemaVersion: MLB_STATCAST_MATCHUP_COVERAGE_SCHEMA,
    certificationState,
    visibleCoverageComplete,
    home,
    away,
    hiddenProvenance: {
      pitcherArsenalSourceObservable: false,
      bullpenRosterCoverageObservable: false,
      recentBatterStatsCoverageObservable: false,
      cacheObservationTimesObservable: false,
    },
    blockers: Array.from(new Set(blockers)),
    safety: {
      modelOutputChanged: false,
      probabilityChanged: false,
      economicThresholdChanged: false,
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
