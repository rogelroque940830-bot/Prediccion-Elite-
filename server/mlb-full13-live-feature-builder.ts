import {
  C4_STARTER_SHRINKAGE_PRIOR_BF,
  buildC4LiveFeatures,
  type C4LiveFeatureAssessment,
  type C4LivePregameInput,
  type C4PriorPitcherLine,
  type C4PriorTeamGame,
} from "./mlb-c4-live-feature-builder";

export const MLB_FULL13_LIVE_FEATURE_BUILDER_VERSION =
  "mlb-full13-live-canonical-v1" as const;

export const MLB_FULL13_FEATURE_NAMES = [
  "team_rd10_diff",
  "team_win10_diff",
  "starter_kbb_adv",
  "team_ra10_adv",
  "lineup_exposure_rate_adv",
  "starter_runrisk_adv",
  "team_rs10_diff",
  "starter_hr_adv",
  "min_probable_prior_bf",
  "lineup_continuity_rate_adv",
  "combined_starter_kbb",
  "combined_team_rs10",
  "combined_team_ra10",
] as const;

export type MlbFull13FeatureName = (typeof MLB_FULL13_FEATURE_NAMES)[number];
export type MlbFull13FeatureVector = Record<MlbFull13FeatureName, number | null>;

export interface MlbFull13PriorPitcherLine extends C4PriorPitcherLine {
  earnedRuns: number | null;
  homeRuns: number | null;
}

export interface MlbFull13LivePregameInput extends Omit<
  C4LivePregameInput,
  "leagueStarterHistory" | "homeStarterHistory" | "awayStarterHistory"
> {
  leagueStarterHistory: MlbFull13PriorPitcherLine[];
  homeStarterHistory: MlbFull13PriorPitcherLine[];
  awayStarterHistory: MlbFull13PriorPitcherLine[];
}

export interface MlbFull13LiveFeatureAssessment {
  builderVersion: typeof MLB_FULL13_LIVE_FEATURE_BUILDER_VERSION;
  priceIndependent: true;
  sameDateHistoryAllowed: false;
  seasonResetHistory: true;
  featureVector: MlbFull13FeatureVector;
  c4Assessment: C4LiveFeatureAssessment;
  diagnostics: {
    homePriorGames: number;
    awayPriorGames: number;
    leaguePriorStarterBattersFaced: number;
    homeStarterPriorBattersFaced: number;
    awayStarterPriorBattersFaced: number;
    homePriorCompleteLineups: number;
    awayPriorCompleteLineups: number;
    starterShrinkagePriorBattersFaced: typeof C4_STARTER_SHRINKAGE_PRIOR_BF;
    canonicalStep12VFormulaParityClaimed: true;
  };
}

function sorted<T extends { officialDate: string; gamePk: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    a.officialDate === b.officialDate
      ? a.gamePk - b.gamePk
      : a.officialDate.localeCompare(b.officialDate),
  );
}

function teamStats(rows: readonly C4PriorTeamGame[]): {
  rs: number;
  ra: number;
  rd: number;
  win: number;
} | null {
  if (rows.length < 5) return null;
  const recent = sorted(rows).slice(-10);
  return {
    rs: recent.reduce((sum, row) => sum + row.runsFor, 0) / recent.length,
    ra: recent.reduce((sum, row) => sum + row.runsAgainst, 0) / recent.length,
    rd: recent.reduce((sum, row) => sum + row.runsFor - row.runsAgainst, 0) / recent.length,
    win: recent.reduce((sum, row) => sum + (row.runsFor > row.runsAgainst ? 1 : 0), 0) / recent.length,
  };
}

function assertExtendedPitcherHistory(
  rows: readonly MlbFull13PriorPitcherLine[],
  label: string,
): void {
  for (const row of rows) {
    if (row.battersFaced <= 0) continue;
    if (row.earnedRuns === null || !Number.isFinite(row.earnedRuns) || row.earnedRuns < 0) {
      throw new Error(`FULL13_PITCHER_EARNED_RUNS_REQUIRED:${label}:${row.gamePk}:${row.pitcherId}`);
    }
    if (row.homeRuns === null || !Number.isFinite(row.homeRuns) || row.homeRuns < 0) {
      throw new Error(`FULL13_PITCHER_HOME_RUNS_REQUIRED:${label}:${row.gamePk}:${row.pitcherId}`);
    }
  }
}

function leagueRates(rows: readonly MlbFull13PriorPitcherLine[]): {
  erbf: number;
  kbb: number;
  hrbf: number;
} | null {
  const valid = rows.filter((row) => row.battersFaced > 0);
  const bf = valid.reduce((sum, row) => sum + row.battersFaced, 0);
  if (bf <= 0) return null;
  return {
    erbf: valid.reduce((sum, row) => sum + (row.earnedRuns as number), 0) / bf,
    kbb: valid.reduce((sum, row) => sum + row.strikeOuts - row.baseOnBalls, 0) / bf,
    hrbf: valid.reduce((sum, row) => sum + (row.homeRuns as number), 0) / bf,
  };
}

function starterStats(
  rows: readonly MlbFull13PriorPitcherLine[],
  league: { erbf: number; kbb: number; hrbf: number },
): { bf: number; erbf: number; kbb: number; hrbf: number } {
  const valid = rows.filter((row) => row.battersFaced > 0);
  const bf = valid.reduce((sum, row) => sum + row.battersFaced, 0);
  const er = valid.reduce((sum, row) => sum + (row.earnedRuns as number), 0);
  const kbb = valid.reduce((sum, row) => sum + row.strikeOuts - row.baseOnBalls, 0);
  const hr = valid.reduce((sum, row) => sum + (row.homeRuns as number), 0);
  const prior = C4_STARTER_SHRINKAGE_PRIOR_BF;
  return {
    bf,
    erbf: (er + prior * league.erbf) / (bf + prior),
    kbb: (kbb + prior * league.kbb) / (bf + prior),
    hrbf: (hr + prior * league.hrbf) / (bf + prior),
  };
}

function continuityRate(
  priorLineups: MlbFull13LivePregameInput["homePriorLineups"],
  currentOrder: number[] | null,
): number | null {
  if (currentOrder === null || priorLineups.length === 0) return null;
  const previous = sorted(priorLineups).at(-1);
  if (!previous) return null;
  const priorPlayers = new Set(previous.battingOrder);
  return currentOrder.reduce((count, playerId) => count + (priorPlayers.has(playerId) ? 1 : 0), 0) / 9;
}

export function buildMlbFull13LiveFeatures(
  input: MlbFull13LivePregameInput,
): MlbFull13LiveFeatureAssessment {
  assertExtendedPitcherHistory(input.leagueStarterHistory, "league");
  assertExtendedPitcherHistory(input.homeStarterHistory, "home");
  assertExtendedPitcherHistory(input.awayStarterHistory, "away");

  const c4Assessment = buildC4LiveFeatures(input);
  const homeTeam = teamStats(input.homeTeamHistory);
  const awayTeam = teamStats(input.awayTeamHistory);
  const league = leagueRates(input.leagueStarterHistory);

  let starterRunriskAdv: number | null = null;
  let starterHrAdv: number | null = null;
  let minProbablePriorBf: number | null = null;
  let combinedStarterKbb: number | null = null;

  if (input.homeStarterId !== null && input.awayStarterId !== null && league !== null) {
    const homeStarter = starterStats(input.homeStarterHistory, league);
    const awayStarter = starterStats(input.awayStarterHistory, league);
    starterRunriskAdv = awayStarter.erbf - homeStarter.erbf;
    starterHrAdv = awayStarter.hrbf - homeStarter.hrbf;
    minProbablePriorBf = Math.min(homeStarter.bf, awayStarter.bf);
    combinedStarterKbb = homeStarter.kbb + awayStarter.kbb;
  }

  const homeContinuity = continuityRate(input.homePriorLineups, input.homeBattingOrder);
  const awayContinuity = continuityRate(input.awayPriorLineups, input.awayBattingOrder);
  const lineupContinuityRateAdv =
    homeContinuity !== null && awayContinuity !== null
      ? homeContinuity - awayContinuity
      : null;

  const featureVector: MlbFull13FeatureVector = {
    team_rd10_diff: c4Assessment.featureVector.team_rd10_diff,
    team_win10_diff: homeTeam && awayTeam ? homeTeam.win - awayTeam.win : null,
    starter_kbb_adv: c4Assessment.featureVector.starter_kbb_adv,
    team_ra10_adv: homeTeam && awayTeam ? awayTeam.ra - homeTeam.ra : null,
    lineup_exposure_rate_adv: c4Assessment.featureVector.lineup_exposure_rate_adv,
    starter_runrisk_adv: starterRunriskAdv,
    team_rs10_diff: homeTeam && awayTeam ? homeTeam.rs - awayTeam.rs : null,
    starter_hr_adv: starterHrAdv,
    min_probable_prior_bf: minProbablePriorBf,
    lineup_continuity_rate_adv: lineupContinuityRateAdv,
    combined_starter_kbb: combinedStarterKbb,
    combined_team_rs10: c4Assessment.featureVector.combined_team_rs10,
    combined_team_ra10: homeTeam && awayTeam ? homeTeam.ra + awayTeam.ra : null,
  };

  return Object.freeze({
    builderVersion: MLB_FULL13_LIVE_FEATURE_BUILDER_VERSION,
    priceIndependent: true,
    sameDateHistoryAllowed: false,
    seasonResetHistory: true,
    featureVector: Object.freeze(featureVector),
    c4Assessment,
    diagnostics: Object.freeze({
      homePriorGames: c4Assessment.diagnostics.homePriorGames,
      awayPriorGames: c4Assessment.diagnostics.awayPriorGames,
      leaguePriorStarterBattersFaced: c4Assessment.diagnostics.leaguePriorStarterBattersFaced,
      homeStarterPriorBattersFaced: c4Assessment.diagnostics.homeStarterPriorBattersFaced,
      awayStarterPriorBattersFaced: c4Assessment.diagnostics.awayStarterPriorBattersFaced,
      homePriorCompleteLineups: c4Assessment.diagnostics.homePriorCompleteLineups,
      awayPriorCompleteLineups: c4Assessment.diagnostics.awayPriorCompleteLineups,
      starterShrinkagePriorBattersFaced: C4_STARTER_SHRINKAGE_PRIOR_BF,
      canonicalStep12VFormulaParityClaimed: true,
    }),
  });
}
