export const MLB_C4_LIVE_FEATURE_SCHEMA = "courtedge-p0-mlb-c4-live-features.v1" as const;
export const MLB_C4_LIVE_FEATURE_PRODUCER_VERSION = "mlb-c4-canonical-step12v-parity-v1" as const;
export const MLB_C4_FEATURE_NAMES = [
  "lineup_exposure_rate_adv",
  "starter_kbb_adv",
  "combined_team_rs10",
  "team_rd10_diff",
] as const;

export type MlbC4FeatureName = typeof MLB_C4_FEATURE_NAMES[number];

export interface MlbC4TeamGameHistory {
  rs: number;
  ra: number;
  win: number;
}

export interface MlbC4PitcherHistoryLine {
  battersFaced: number | null;
  earnedRuns: number;
  strikeOuts: number;
  baseOnBalls: number;
  homeRuns: number;
}

export interface MlbC4PregameState {
  auditValid: boolean;
  probableBothKnown: boolean;
  lineupComplete: boolean;
  homeTeamHistory: readonly MlbC4TeamGameHistory[];
  awayTeamHistory: readonly MlbC4TeamGameHistory[];
  homeStarterHistory: readonly MlbC4PitcherHistoryLine[];
  awayStarterHistory: readonly MlbC4PitcherHistoryLine[];
  leaguePitcherHistory: readonly MlbC4PitcherHistoryLine[];
  homeTeamPriorGames: number;
  awayTeamPriorGames: number;
  homeBattingOrder: readonly number[];
  awayBattingOrder: readonly number[];
  homePlayerPriorApps: Readonly<Record<string, number>>;
  awayPlayerPriorApps: Readonly<Record<string, number>>;
}

export interface MlbC4LiveFeatures {
  schemaVersion: typeof MLB_C4_LIVE_FEATURE_SCHEMA;
  producerVersion: typeof MLB_C4_LIVE_FEATURE_PRODUCER_VERSION;
  values: Readonly<Record<MlbC4FeatureName, number | null>>;
  ready: boolean;
  missing: readonly MlbC4FeatureName[];
  policy: {
    teamWindowMaxGames: 10;
    minimumTeamPriorGames: 5;
    starterPriorBattersFaced: 72;
    sameDateHistoryAllowed: false;
    currentGameOutcomeAllowed: false;
    featureImputationApplied: false;
  };
}

const STARTER_PRIOR_BF = 72;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mean(values: readonly number[]): number | null {
  if (!values.length || values.some((value) => !finite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function teamStats(history: readonly MlbC4TeamGameHistory[]): { rs: number; rd: number } | null {
  if (history.length < 5) return null;
  const recent = history.slice(-10);
  const rs = mean(recent.map((row) => row.rs));
  const rd = mean(recent.map((row) => row.rs - row.ra));
  if (rs == null || rd == null) return null;
  return { rs, rd };
}

function positiveBfLines(lines: readonly MlbC4PitcherHistoryLine[]): readonly MlbC4PitcherHistoryLine[] {
  return lines.filter((line) => finite(line.battersFaced) && line.battersFaced > 0);
}

function leagueKbbRate(lines: readonly MlbC4PitcherHistoryLine[]): number | null {
  const valid = positiveBfLines(lines);
  const bf = valid.reduce((sum, line) => sum + Number(line.battersFaced), 0);
  if (!(bf > 0)) return null;
  const kbb = valid.reduce((sum, line) => sum + line.strikeOuts - line.baseOnBalls, 0);
  return kbb / bf;
}

function starterShrunkKbb(
  history: readonly MlbC4PitcherHistoryLine[],
  priorLeagueKbb: number,
): number | null {
  const valid = positiveBfLines(history);
  const bf = valid.reduce((sum, line) => sum + Number(line.battersFaced), 0);
  const kbb = valid.reduce((sum, line) => sum + line.strikeOuts - line.baseOnBalls, 0);
  const value = (kbb + STARTER_PRIOR_BF * priorLeagueKbb) / (bf + STARTER_PRIOR_BF);
  return finite(value) ? value : null;
}

function validOrder(order: readonly number[]): boolean {
  return order.length === 9 && order.every((playerId) => Number.isInteger(playerId) && playerId > 0);
}

function lineupExposure(
  priorGames: number,
  order: readonly number[],
  playerPriorApps: Readonly<Record<string, number>>,
): number | null {
  if (!(Number.isInteger(priorGames) && priorGames > 0) || !validOrder(order)) return null;
  const rates = order.map((playerId) => {
    const raw = playerPriorApps[String(playerId)] ?? 0;
    if (!finite(raw) || raw < 0) return Number.NaN;
    return raw / priorGames;
  });
  return mean(rates);
}

export function produceMlbC4LiveFeatures(state: MlbC4PregameState): MlbC4LiveFeatures {
  const values: Record<MlbC4FeatureName, number | null> = {
    lineup_exposure_rate_adv: null,
    starter_kbb_adv: null,
    combined_team_rs10: null,
    team_rd10_diff: null,
  };

  const homeTeam = teamStats(state.homeTeamHistory);
  const awayTeam = teamStats(state.awayTeamHistory);
  if (homeTeam && awayTeam) {
    values.combined_team_rs10 = homeTeam.rs + awayTeam.rs;
    values.team_rd10_diff = homeTeam.rd - awayTeam.rd;
  }

  if (state.auditValid && state.probableBothKnown) {
    const league = leagueKbbRate(state.leaguePitcherHistory);
    if (league != null) {
      const homeKbb = starterShrunkKbb(state.homeStarterHistory, league);
      const awayKbb = starterShrunkKbb(state.awayStarterHistory, league);
      if (homeKbb != null && awayKbb != null) values.starter_kbb_adv = homeKbb - awayKbb;
    }
  }

  if (state.auditValid && state.lineupComplete) {
    const homeExposure = lineupExposure(state.homeTeamPriorGames, state.homeBattingOrder, state.homePlayerPriorApps);
    const awayExposure = lineupExposure(state.awayTeamPriorGames, state.awayBattingOrder, state.awayPlayerPriorApps);
    if (homeExposure != null && awayExposure != null) {
      values.lineup_exposure_rate_adv = homeExposure - awayExposure;
    }
  }

  const missing = MLB_C4_FEATURE_NAMES.filter((feature) => !finite(values[feature]));
  return Object.freeze({
    schemaVersion: MLB_C4_LIVE_FEATURE_SCHEMA,
    producerVersion: MLB_C4_LIVE_FEATURE_PRODUCER_VERSION,
    values: Object.freeze({ ...values }),
    ready: missing.length === 0,
    missing: Object.freeze([...missing]),
    policy: Object.freeze({
      teamWindowMaxGames: 10,
      minimumTeamPriorGames: 5,
      starterPriorBattersFaced: 72,
      sameDateHistoryAllowed: false,
      currentGameOutcomeAllowed: false,
      featureImputationApplied: false,
    }),
  });
}
