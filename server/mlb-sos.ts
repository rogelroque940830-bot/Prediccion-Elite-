// SOS — Strength of Schedule del bateo reciente
// Para cada equipo, mira sus últimos 10 juegos y calcula la calidad PROMEDIO
// del pitcheo enfrentado (SP ERA + bullpen ERA del rival).
// Detecta rachas falsas: equipo .800 OPS vs Rockies/White Sox → inflado.
// Detecta rachas reales: equipo .700 OPS vs Dodgers/Mets → real.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const LEAGUE_AVG_ERA = 4.20;       // ERA promedio MLB (referencia)
const LEAGUE_AVG_BP_ERA = 4.15;    // bullpen ERA promedio MLB

interface CacheEntry<T> { ts: number; data: T; }
const CACHE_TTL = 60 * 60 * 1000; // 1h
const cache: Record<string, CacheEntry<TeamSos | null>> = {};

export interface TeamSos {
  teamId: number;
  teamName: string;
  games: number;
  avgSpEraFaced: number;          // ERA promedio del SP rival enfrentado
  avgBullpenEraFaced: number;     // ERA promedio del bullpen rival enfrentado
  combinedEraFaced: number;       // promedio ponderado (60% SP, 40% bullpen)
  leagueDelta: number;            // combinedEra - liga; negativo = enfrentó pitcheo TOP
  sosFactor: number;              // multiplicador para corregir RPG/wOBA reciente
  recentRpg: number;
  adjustedRpg: number;            // recentRpg × sosFactor
  tier: "INFLATED" | "REAL" | "DEFLATED";
  signal: string;
}

async function fetchTeamSchedule(teamId: number): Promise<any[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 días
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const url = `${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startStr}&endDate=${endStr}&hydrate=probablePitcher,linescore`;
  try {
    const j: any = await (await fetch(url)).json();
    const games: any[] = [];
    for (const d of j.dates ?? []) {
      for (const g of d.games ?? []) {
        if (g.status?.abstractGameState === "Final") games.push(g);
      }
    }
    return games.slice(-15); // últimos 15 finales (filtraremos a 10)
  } catch (e) {
    return [];
  }
}

async function fetchPitcherSeasonEra(pitcherId: number, season: string): Promise<number | null> {
  if (!pitcherId) return null;
  try {
    const j: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`)).json();
    const split = j.stats?.[0]?.splits?.[0]?.stat;
    if (!split?.era) return null;
    const era = parseFloat(split.era);
    return isNaN(era) ? null : era;
  } catch {
    return null;
  }
}

async function fetchTeamSeasonBullpenEra(teamId: number, season: string): Promise<number | null> {
  if (!teamId) return null;
  try {
    const j: any = await (await fetch(`${MLB_BASE}/teams/${teamId}/stats?season=${season}&stats=season&group=pitching&gameType=R`)).json();
    // bullpen ERA aproximada = team ERA (no hay split bullpen vs starter en API básica)
    // → usaremos team pitching ERA como proxy general del staff rival
    const split = j.stats?.[0]?.splits?.[0]?.stat;
    if (!split?.era) return null;
    const era = parseFloat(split.era);
    return isNaN(era) ? null : era;
  } catch {
    return null;
  }
}

export async function getTeamSos(teamId: number, teamName: string): Promise<TeamSos | null> {
  const key = `${teamId}`;
  const cached = cache[key];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const season = String(new Date().getFullYear());
  const games = await fetchTeamSchedule(teamId);
  if (games.length < 5) {
    cache[key] = { ts: Date.now(), data: null };
    return null;
  }

  let totalSpEra = 0;
  let spCount = 0;
  let totalBpEra = 0;
  let bpCount = 0;
  let totalRunsScored = 0;
  let countedGames = 0;
  const opponentTeamIds = new Set<number>();

  // Para cada juego, identificar lado del rival y stats
  for (const g of games.slice(-10)) {
    const isHome = g.teams?.home?.team?.id === teamId;
    const ownSide = isHome ? g.teams.home : g.teams.away;
    const oppSide = isHome ? g.teams.away : g.teams.home;
    if (!oppSide?.team?.id) continue;

    opponentTeamIds.add(oppSide.team.id);
    const runs = ownSide.score ?? 0;
    totalRunsScored += runs;
    countedGames++;

    const oppSpId = oppSide.probablePitcher?.id;
    if (oppSpId) {
      const era = await fetchPitcherSeasonEra(oppSpId, season);
      if (era !== null && era > 0 && era < 15) {
        totalSpEra += era;
        spCount++;
      }
    }
  }

  // Para cada team rival único, traer su staff ERA general (proxy de bullpen)
  for (const oppId of opponentTeamIds) {
    const era = await fetchTeamSeasonBullpenEra(oppId, season);
    if (era !== null && era > 0 && era < 8) {
      totalBpEra += era;
      bpCount++;
    }
  }

  if (countedGames === 0 || spCount === 0) {
    cache[key] = { ts: Date.now(), data: null };
    return null;
  }

  const avgSpEraFaced = totalSpEra / spCount;
  const avgBullpenEraFaced = bpCount > 0 ? totalBpEra / bpCount : LEAGUE_AVG_BP_ERA;
  const combinedEraFaced = avgSpEraFaced * 0.60 + avgBullpenEraFaced * 0.40;
  const leagueRef = LEAGUE_AVG_ERA * 0.60 + LEAGUE_AVG_BP_ERA * 0.40;
  const leagueDelta = combinedEraFaced - leagueRef;
  const recentRpg = totalRunsScored / countedGames;

  // sosFactor: si leagueDelta > 0 → enfrentó pitcheo MALO → RPG inflado → factor <1
  //            si leagueDelta < 0 → enfrentó pitcheo BUENO → RPG deflactado → factor >1
  // Cap: ±20% adjustment. 1 ERA delta ≈ 12% adjustment.
  let sosFactor = 1.0 - (leagueDelta * 0.12);
  sosFactor = Math.max(0.80, Math.min(1.20, sosFactor));
  sosFactor = Math.round(sosFactor * 1000) / 1000;

  const adjustedRpg = Math.round(recentRpg * sosFactor * 10) / 10;
  const rpgDelta = adjustedRpg - recentRpg;

  let tier: TeamSos["tier"] = "REAL";
  let signal = "";
  if (leagueDelta >= 0.30) {
    tier = "INFLATED";
    signal = `⚠️ ${teamName} enfrentó pitcheo FLOJO (ERA ${combinedEraFaced.toFixed(2)} vs liga ${leagueRef.toFixed(2)}). RPG reciente ${recentRpg.toFixed(1)} probablemente inflado → ajuste ${adjustedRpg.toFixed(1)} (factor ${sosFactor}).`;
  } else if (leagueDelta <= -0.30) {
    tier = "DEFLATED";
    signal = `🔥 ${teamName} enfrentó pitcheo TOP (ERA ${combinedEraFaced.toFixed(2)} vs liga ${leagueRef.toFixed(2)}). RPG reciente ${recentRpg.toFixed(1)} es REAL → ajuste al alza ${adjustedRpg.toFixed(1)} (factor ${sosFactor}).`;
  } else {
    signal = `${teamName} enfrentó pitcheo similar a liga (ERA ${combinedEraFaced.toFixed(2)}). RPG reciente ${recentRpg.toFixed(1)} sin ajuste material.`;
  }

  const result: TeamSos = {
    teamId, teamName,
    games: countedGames,
    avgSpEraFaced: Math.round(avgSpEraFaced * 100) / 100,
    avgBullpenEraFaced: Math.round(avgBullpenEraFaced * 100) / 100,
    combinedEraFaced: Math.round(combinedEraFaced * 100) / 100,
    leagueDelta: Math.round(leagueDelta * 100) / 100,
    sosFactor,
    recentRpg: Math.round(recentRpg * 10) / 10,
    adjustedRpg,
    tier,
    signal,
  };

  cache[key] = { ts: Date.now(), data: result };
  return result;
}
