import type { C4PriorLineupSnapshot, C4PriorPitcherLine, C4PriorTeamGame } from "../server/mlb-c4-live-feature-builder";

export type Json = Record<string, any>;

export function mapPush<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
}

export function auditValid(audit: Json | undefined): boolean {
  return Boolean(audit?.identityOk && audit?.sourceHistorical && audit?.pregame);
}

export function probableKnown(audit: Json | undefined): boolean {
  return Boolean(auditValid(audit) && audit?.probableBothKnown);
}

export function pitcherLine(raw: Json): C4PriorPitcherLine {
  return {
    officialDate: String(raw.officialDate),
    gamePk: Number(raw.gamePk),
    pitcherId: Number(raw.pitcherId),
    battersFaced: Number(raw.battersFaced ?? 0),
    strikeOuts: Number(raw.strikeOuts ?? 0),
    baseOnBalls: Number(raw.baseOnBalls ?? 0),
  };
}

export interface C4ReplayState {
  teamHistory: Map<number, C4PriorTeamGame[]>;
  pitcherHistory: Map<number, C4PriorPitcherLine[]>;
  leagueStarterHistory: C4PriorPitcherLine[];
  priorLineups: Map<number, C4PriorLineupSnapshot[]>;
}

export function emptyReplayState(): C4ReplayState {
  return {
    teamHistory: new Map(),
    pitcherHistory: new Map(),
    leagueStarterHistory: [],
    priorLineups: new Map(),
  };
}

export function updateReplayStateForGame(
  state: C4ReplayState,
  game: Json,
  starters: Json | undefined,
  lineup: Json | undefined,
  audit: Json | undefined,
): void {
  const officialDate = String(game.officialDate);
  const gamePk = Number(game.gamePk);
  const homeTeamId = Number(game.homeTeamId);
  const awayTeamId = Number(game.awayTeamId);
  const homeRuns = Number(game.homeRuns);
  const awayRuns = Number(game.awayRuns);
  mapPush(state.teamHistory, homeTeamId, { officialDate, gamePk, runsFor: homeRuns, runsAgainst: awayRuns });
  mapPush(state.teamHistory, awayTeamId, { officialDate, gamePk, runsFor: awayRuns, runsAgainst: homeRuns });

  if (starters) {
    for (const side of ["homeStarter", "awayStarter"]) {
      const raw = starters[side];
      if (!raw) continue;
      const line = pitcherLine(raw);
      mapPush(state.pitcherHistory, line.pitcherId, line);
      state.leagueStarterHistory.push(line);
    }
  }

  if (auditValid(audit) && lineup?.complete) {
    mapPush(state.priorLineups, homeTeamId, { officialDate, gamePk, battingOrder: lineup.homeBattingOrder.map(Number) });
    mapPush(state.priorLineups, awayTeamId, { officialDate, gamePk, battingOrder: lineup.awayBattingOrder.map(Number) });
  }
}
