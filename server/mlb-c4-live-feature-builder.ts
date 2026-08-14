export const C4_LIVE_FEATURE_BUILDER_VERSION = "mlb-c4-live-canonical-v1";
export const C4_STARTER_SHRINKAGE_PRIOR_BF = 72;

export const C4_FEATURE_NAMES = [
  "lineup_exposure_rate_adv",
  "starter_kbb_adv",
  "combined_team_rs10",
  "team_rd10_diff",
] as const;

export type C4FeatureName = (typeof C4_FEATURE_NAMES)[number];

export interface C4PriorTeamGame {
  officialDate: string;
  gamePk: number;
  runsFor: number;
  runsAgainst: number;
}

export interface C4PriorPitcherLine {
  officialDate: string;
  gamePk: number;
  pitcherId: number;
  battersFaced: number;
  strikeOuts: number;
  baseOnBalls: number;
}

export interface C4PriorLineupSnapshot {
  officialDate: string;
  gamePk: number;
  battingOrder: number[];
}

export interface C4LivePregameInput {
  officialDate: string;
  gamePk: number;
  homeTeamId: number;
  awayTeamId: number;
  homeTeamHistory: C4PriorTeamGame[];
  awayTeamHistory: C4PriorTeamGame[];
  leagueStarterHistory: C4PriorPitcherLine[];
  homeStarterHistory: C4PriorPitcherLine[];
  awayStarterHistory: C4PriorPitcherLine[];
  homeStarterId: number | null;
  awayStarterId: number | null;
  homePriorLineups: C4PriorLineupSnapshot[];
  awayPriorLineups: C4PriorLineupSnapshot[];
  homeBattingOrder: number[] | null;
  awayBattingOrder: number[] | null;
}

export interface C4LiveFeatureVector {
  lineup_exposure_rate_adv: number | null;
  starter_kbb_adv: number | null;
  combined_team_rs10: number | null;
  team_rd10_diff: number | null;
}

export interface C4LiveFeatureAssessment {
  builderVersion: typeof C4_LIVE_FEATURE_BUILDER_VERSION;
  priceIndependent: true;
  sameDateHistoryAllowed: false;
  seasonResetHistory: true;
  featureVector: C4LiveFeatureVector;
  diagnostics: {
    homePriorGames: number;
    awayPriorGames: number;
    leaguePriorStarterBattersFaced: number;
    homeStarterPriorBattersFaced: number;
    awayStarterPriorBattersFaced: number;
    homePriorCompleteLineups: number;
    awayPriorCompleteLineups: number;
  };
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`C4_NONFINITE:${label}`);
}

function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`C4_INVALID_DATE:${label}`);
}

function assertPriorOnly<T extends { officialDate: string; gamePk: number }>(
  rows: T[],
  targetDate: string,
  label: string,
): void {
  const season = targetDate.slice(0, 4);
  for (const row of rows) {
    assertIsoDate(row.officialDate, `${label}.officialDate`);
    if (row.officialDate >= targetDate) {
      throw new Error(`C4_HISTORY_NOT_STRICTLY_PREGAME:${label}:${row.officialDate}:${row.gamePk}`);
    }
    if (row.officialDate.slice(0, 4) !== season) {
      throw new Error(`C4_CROSS_SEASON_HISTORY_FORBIDDEN:${label}:${row.officialDate}:${row.gamePk}`);
    }
  }
}

function sorted<T extends { officialDate: string; gamePk: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.officialDate === b.officialDate ? a.gamePk - b.gamePk : a.officialDate.localeCompare(b.officialDate),
  );
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validateTeamHistory(rows: C4PriorTeamGame[], targetDate: string, label: string): void {
  assertPriorOnly(rows, targetDate, label);
  for (const row of rows) {
    assertFiniteNumber(row.runsFor, `${label}.runsFor`);
    assertFiniteNumber(row.runsAgainst, `${label}.runsAgainst`);
  }
}

function validatePitcherHistory(rows: C4PriorPitcherLine[], targetDate: string, label: string): void {
  assertPriorOnly(rows, targetDate, label);
  for (const row of rows) {
    for (const key of ["battersFaced", "strikeOuts", "baseOnBalls"] as const) {
      assertFiniteNumber(row[key], `${label}.${key}`);
      if (row[key] < 0) throw new Error(`C4_NEGATIVE_PITCHER_STAT:${label}.${key}`);
    }
  }
}

function validatePriorLineups(rows: C4PriorLineupSnapshot[], targetDate: string, label: string): void {
  assertPriorOnly(rows, targetDate, label);
  for (const row of rows) validateBattingOrder(row.battingOrder, `${label}.battingOrder`);
}

function validateBattingOrder(order: number[], label: string): void {
  if (order.length !== 9) throw new Error(`C4_LINEUP_NOT_NINE:${label}`);
  if (new Set(order).size !== 9) throw new Error(`C4_LINEUP_DUPLICATE_PLAYER:${label}`);
  for (const pid of order) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`C4_INVALID_PLAYER_ID:${label}`);
  }
}

function teamForm(rows: C4PriorTeamGame[]): { rs: number; rd: number } | null {
  if (rows.length < 5) return null;
  const recent = sorted(rows).slice(-10);
  return {
    rs: recent.reduce((sum, row) => sum + row.runsFor, 0) / recent.length,
    rd: recent.reduce((sum, row) => sum + row.runsFor - row.runsAgainst, 0) / recent.length,
  };
}

function validPitcherLines(rows: C4PriorPitcherLine[]): C4PriorPitcherLine[] {
  return rows.filter((row) => row.battersFaced > 0);
}

function totalBattersFaced(rows: C4PriorPitcherLine[]): number {
  return validPitcherLines(rows).reduce((sum, row) => sum + row.battersFaced, 0);
}

function leagueKbbRate(rows: C4PriorPitcherLine[]): number | null {
  const valid = validPitcherLines(rows);
  const bf = valid.reduce((sum, row) => sum + row.battersFaced, 0);
  if (bf <= 0) return null;
  const kbb = valid.reduce((sum, row) => sum + row.strikeOuts - row.baseOnBalls, 0);
  return kbb / bf;
}

function shrunkStarterKbb(rows: C4PriorPitcherLine[], leagueRate: number): { value: number; bf: number } {
  const valid = validPitcherLines(rows);
  const bf = valid.reduce((sum, row) => sum + row.battersFaced, 0);
  const kbb = valid.reduce((sum, row) => sum + row.strikeOuts - row.baseOnBalls, 0);
  return {
    bf,
    value: (kbb + C4_STARTER_SHRINKAGE_PRIOR_BF * leagueRate) / (bf + C4_STARTER_SHRINKAGE_PRIOR_BF),
  };
}

function lineupExposureRate(
  teamPriorGames: number,
  priorLineups: C4PriorLineupSnapshot[],
  currentOrder: number[] | null,
): number | null {
  if (teamPriorGames <= 0 || currentOrder === null) return null;
  const appearances = new Map<number, number>();
  for (const snapshot of priorLineups) {
    for (const pid of snapshot.battingOrder) appearances.set(pid, (appearances.get(pid) ?? 0) + 1);
  }
  return mean(currentOrder.map((pid) => (appearances.get(pid) ?? 0) / teamPriorGames));
}

export function buildC4LiveFeatures(input: C4LivePregameInput): C4LiveFeatureAssessment {
  assertIsoDate(input.officialDate, "officialDate");
  if (!Number.isInteger(input.gamePk) || input.gamePk <= 0) throw new Error("C4_INVALID_GAME_PK");

  validateTeamHistory(input.homeTeamHistory, input.officialDate, "homeTeamHistory");
  validateTeamHistory(input.awayTeamHistory, input.officialDate, "awayTeamHistory");
  validatePitcherHistory(input.leagueStarterHistory, input.officialDate, "leagueStarterHistory");
  validatePitcherHistory(input.homeStarterHistory, input.officialDate, "homeStarterHistory");
  validatePitcherHistory(input.awayStarterHistory, input.officialDate, "awayStarterHistory");
  validatePriorLineups(input.homePriorLineups, input.officialDate, "homePriorLineups");
  validatePriorLineups(input.awayPriorLineups, input.officialDate, "awayPriorLineups");
  if (input.homeBattingOrder !== null) validateBattingOrder(input.homeBattingOrder, "homeBattingOrder");
  if (input.awayBattingOrder !== null) validateBattingOrder(input.awayBattingOrder, "awayBattingOrder");

  const homeTeam = teamForm(input.homeTeamHistory);
  const awayTeam = teamForm(input.awayTeamHistory);
  const combinedTeamRs10 = homeTeam && awayTeam ? homeTeam.rs + awayTeam.rs : null;
  const teamRd10Diff = homeTeam && awayTeam ? homeTeam.rd - awayTeam.rd : null;

  let starterKbbAdv: number | null = null;
  let homeStarterPriorBf = 0;
  let awayStarterPriorBf = 0;
  const leagueRate = leagueKbbRate(input.leagueStarterHistory);
  if (input.homeStarterId !== null && input.awayStarterId !== null && leagueRate !== null) {
    const home = shrunkStarterKbb(input.homeStarterHistory, leagueRate);
    const away = shrunkStarterKbb(input.awayStarterHistory, leagueRate);
    homeStarterPriorBf = home.bf;
    awayStarterPriorBf = away.bf;
    starterKbbAdv = home.value - away.value;
  }

  const homeExposure = lineupExposureRate(
    input.homeTeamHistory.length,
    input.homePriorLineups,
    input.homeBattingOrder,
  );
  const awayExposure = lineupExposureRate(
    input.awayTeamHistory.length,
    input.awayPriorLineups,
    input.awayBattingOrder,
  );
  const lineupExposureRateAdv =
    homeExposure !== null && awayExposure !== null ? homeExposure - awayExposure : null;

  return {
    builderVersion: C4_LIVE_FEATURE_BUILDER_VERSION,
    priceIndependent: true,
    sameDateHistoryAllowed: false,
    seasonResetHistory: true,
    featureVector: {
      lineup_exposure_rate_adv: lineupExposureRateAdv,
      starter_kbb_adv: starterKbbAdv,
      combined_team_rs10: combinedTeamRs10,
      team_rd10_diff: teamRd10Diff,
    },
    diagnostics: {
      homePriorGames: input.homeTeamHistory.length,
      awayPriorGames: input.awayTeamHistory.length,
      leaguePriorStarterBattersFaced: totalBattersFaced(input.leagueStarterHistory),
      homeStarterPriorBattersFaced: homeStarterPriorBf,
      awayStarterPriorBattersFaced: awayStarterPriorBf,
      homePriorCompleteLineups: input.homePriorLineups.length,
      awayPriorCompleteLineups: input.awayPriorLineups.length,
    },
  };
}
