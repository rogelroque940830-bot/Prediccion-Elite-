import { getStatcastMatchupCombined } from "./mlb-statcast-matchup";

const MLB_BASE = "https://statsapi.mlb.com/api";
const LEAGUE_OPS = 0.720;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const MLB_STATCAST_VSTEAM_IDENTITY_FIX_SCHEMA = "courtedge-mlb-statcast-vsteam-identity.v1" as const;

interface BatterIdentity {
  id: number;
  name: string;
}

interface VsTeamRow {
  batterId: number;
  batterName: string;
  pa: number;
  ba: number;
  ops: number;
  hr: number;
  rbi: number;
  vsTeamId: number;
}

export interface CorrectedVsTeamHistory {
  rows: VsTeamRow[];
  teamOpsVsOpp: number;
  signal: string;
  identity: {
    opposingTeamId: number;
    requestedBatters: number;
    successfulQueries: number;
    usableRows: number;
    failures: number;
  };
}

function positiveTeamId(value: unknown): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error("STATCAST_VSTEAM_OPPOSING_TEAM_ID_REQUIRED");
  return id;
}

export function buildVsTeamStatsUrl(batterId: number, opposingTeamId: number, season: number): string {
  const batter = Number(batterId);
  const opponent = positiveTeamId(opposingTeamId);
  const year = Number(season);
  if (!Number.isInteger(batter) || batter <= 0) throw new Error("STATCAST_VSTEAM_BATTER_ID_REQUIRED");
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error("STATCAST_VSTEAM_SEASON_INVALID");
  return `${MLB_BASE}/v1/people/${batter}/stats?stats=vsTeam&group=hitting&season=${year}&sportId=1&opposingTeamId=${opponent}`;
}

function batterIdentities(matchup: any): BatterIdentity[] {
  const source = Array.isArray(matchup?.perBatter) ? matchup.perBatter : [];
  const seen = new Set<number>();
  const result: BatterIdentity[] = [];
  for (const batter of source) {
    const id = Number(batter?.batterId);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: String(batter?.batterName ?? `Batter ${id}`) });
  }
  return result;
}

async function correctedVsTeamHistory(input: {
  batters: BatterIdentity[];
  opposingTeamId: number;
  season: number;
  fetchImpl: FetchLike;
}): Promise<CorrectedVsTeamHistory> {
  const opposingTeamId = positiveTeamId(input.opposingTeamId);
  const rows: VsTeamRow[] = [];
  let successfulQueries = 0;
  let failures = 0;

  for (const batter of input.batters) {
    try {
      const response = await input.fetchImpl(buildVsTeamStatsUrl(batter.id, opposingTeamId, input.season), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        failures++;
        continue;
      }
      const payload: any = await response.json();
      successfulQueries++;
      const stat = payload?.stats?.[0]?.splits?.[0]?.stat;
      if (!stat) continue;
      const pa = Number.parseInt(String(stat.plateAppearances ?? "0"), 10) || 0;
      if (pa < 5) continue;
      rows.push({
        batterId: batter.id,
        batterName: batter.name,
        pa,
        ba: Number.parseFloat(String(stat.avg ?? "0")) || 0,
        ops: Number.parseFloat(String(stat.ops ?? "0")) || 0,
        hr: Number.parseInt(String(stat.homeRuns ?? "0"), 10) || 0,
        rbi: Number.parseInt(String(stat.rbi ?? "0"), 10) || 0,
        vsTeamId: opposingTeamId,
      });
    } catch {
      failures++;
    }
  }

  const totalPa = rows.reduce((sum, row) => sum + row.pa, 0);
  const teamOpsVsOpp = totalPa > 0
    ? rows.reduce((sum, row) => sum + row.ops * row.pa, 0) / totalPa
    : LEAGUE_OPS;
  let signal: string;
  if (teamOpsVsOpp >= 0.800) signal = `Lineup CALIENTE vs este equipo (OPS ${teamOpsVsOpp.toFixed(3)} en ${totalPa} PA)`;
  else if (teamOpsVsOpp <= 0.640) signal = `Lineup FRÍO vs este equipo (OPS ${teamOpsVsOpp.toFixed(3)} en ${totalPa} PA)`;
  else if (totalPa < 30) signal = `Muestra limitada (${totalPa} PA combinados)`;
  else signal = `Lineup neutral vs este equipo (OPS ${teamOpsVsOpp.toFixed(3)})`;

  return {
    rows,
    teamOpsVsOpp: Math.round(teamOpsVsOpp * 1000) / 1000,
    signal,
    identity: {
      opposingTeamId,
      requestedBatters: input.batters.length,
      successfulQueries,
      usableRows: rows.length,
      failures,
    },
  };
}

function bullpenAverage(matchup: any): number {
  const bullpen = Array.isArray(matchup?.bullpenMatchup) ? matchup.bullpenMatchup : [];
  if (!bullpen.length) return 0;
  return bullpen.reduce((sum: number, item: any) => sum + (Number(item?.expectedRunsDelta) || 0), 0) / bullpen.length;
}

export function recomputeStatcastRunsDelta(input: {
  starterRunsDelta: number;
  bullpenRunsDelta: number;
  teamOpsVsOpp: number;
}): number {
  const value = (Number(input.starterRunsDelta) || 0) * 0.50
    + (Number(input.bullpenRunsDelta) || 0) * 0.25
    + ((Number(input.teamOpsVsOpp) - LEAGUE_OPS) * 4) * 0.25;
  return Math.round(value * 100) / 100;
}

export async function getStatcastMatchupCombinedIdentitySafe(input: {
  gamePk: number;
  homeTeamId: number;
  awayTeamId: number;
  homePitcherId: number;
  homePitcherName: string;
  awayPitcherId: number;
  awayPitcherName: string;
  homeTeamAbbrev: string;
  awayTeamAbbrev: string;
  season: number;
  fetchImpl?: FetchLike;
}): Promise<any> {
  const homeTeamId = positiveTeamId(input.homeTeamId);
  const awayTeamId = positiveTeamId(input.awayTeamId);
  const fetchImpl = input.fetchImpl ?? fetch;
  const legacy = await getStatcastMatchupCombined(
    input.gamePk,
    homeTeamId,
    awayTeamId,
    input.homePitcherId,
    input.homePitcherName,
    input.awayPitcherId,
    input.awayPitcherName,
    input.homeTeamAbbrev,
    input.awayTeamAbbrev,
    input.season,
  );

  const [homeHistory, awayHistory] = await Promise.all([
    correctedVsTeamHistory({
      batters: batterIdentities(legacy?.homeLineupVsAwaySP),
      opposingTeamId: awayTeamId,
      season: input.season,
      fetchImpl,
    }),
    correctedVsTeamHistory({
      batters: batterIdentities(legacy?.awayLineupVsHomeSP),
      opposingTeamId: homeTeamId,
      season: input.season,
      fetchImpl,
    }),
  ]);

  const homeRunsDelta = recomputeStatcastRunsDelta({
    starterRunsDelta: legacy?.homeLineupVsAwaySP?.expectedTeamRunsDelta ?? 0,
    bullpenRunsDelta: bullpenAverage(legacy?.homeLineupVsAwaySP),
    teamOpsVsOpp: homeHistory.teamOpsVsOpp,
  });
  const awayRunsDelta = recomputeStatcastRunsDelta({
    starterRunsDelta: legacy?.awayLineupVsHomeSP?.expectedTeamRunsDelta ?? 0,
    bullpenRunsDelta: bullpenAverage(legacy?.awayLineupVsHomeSP),
    teamOpsVsOpp: awayHistory.teamOpsVsOpp,
  });

  return {
    ...legacy,
    homeLineupVsAwayTeam: homeHistory,
    awayLineupVsHomeTeam: awayHistory,
    homeRunsDelta,
    awayRunsDelta,
    identityCorrection: {
      schemaVersion: MLB_STATCAST_VSTEAM_IDENTITY_FIX_SCHEMA,
      opposingTeamIdContract: "NUMERIC_MLB_TEAM_ID",
      weightsPreserved: { starter: 0.50, bullpen: 0.25, vsTeam: 0.25 },
      homeOpponentTeamId: awayTeamId,
      awayOpponentTeamId: homeTeamId,
    },
  };
}
