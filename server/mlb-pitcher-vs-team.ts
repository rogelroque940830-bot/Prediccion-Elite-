// Pitcher vs Team Recent History (MLB)
// Mira los últimos 5 starts del pitcher vs ESTE equipo específico
// Detecta patrones: el equipo le está leyendo, o el pitcher lo domina

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export interface PitcherVsTeamHistory {
  pitcherId: number;
  pitcherName: string;
  opponentTeamId: number;
  opponentTeamName: string;
  starts: { date: string; ip: number; er: number; k: number; bb: number; hr: number; gamePk: number }[];
  totalStarts: number;
  totalIP: number;
  totalER: number;
  era: number;
  whip: number;
  k9: number;
  hr9: number;
  // Comparación con season ERA general
  seasonEra: number;
  eraDelta: number;
  // Significant si tiene 3+ starts contra este equipo
  significantSample: boolean;
  // Patrón: streak de buenos/malos starts
  recentTrend: "DOMINANCE" | "STRUGGLES" | "NEUTRAL";
  signal: string;
}

const cache: Record<string, { ts: number; data: PitcherVsTeamHistory | null }> = {};

function parseIP(ip: string | undefined): number {
  if (!ip) return 0;
  const parts = String(ip).split(".");
  return parseInt(parts[0]) + (parseInt(parts[1] || "0") / 3);
}

async function getPitcherGameLogs(pitcherId: number): Promise<any[]> {
  const all: any[] = [];
  for (const season of ["2024", "2025", "2026"]) {
    try {
      const j: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`)).json();
      const splits = j.stats?.[0]?.splits ?? [];
      all.push(...splits);
    } catch {}
  }
  return all;
}

async function getSeasonERA(pitcherId: number): Promise<number> {
  try {
    const j2026: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=2026`)).json();
    let stats = j2026.stats?.[0]?.splits?.[0]?.stat;
    if (!stats?.era) {
      const j2025: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=2025`)).json();
      stats = j2025.stats?.[0]?.splits?.[0]?.stat ?? stats;
    }
    return parseFloat(stats?.era ?? "4.50") || 4.50;
  } catch {
    return 4.50;
  }
}

export async function getPitcherVsTeam(
  pitcherId: number,
  pitcherName: string,
  opponentTeamId: number,
  opponentTeamName: string,
): Promise<PitcherVsTeamHistory | null> {
  const cacheKey = `${pitcherId}::${opponentTeamId}`;
  const cached = cache[cacheKey];
  if (cached && Date.now() - cached.ts < 12 * 3600 * 1000) return cached.data;

  const [logs, seasonEra] = await Promise.all([
    getPitcherGameLogs(pitcherId),
    getSeasonERA(pitcherId),
  ]);

  // Filtrar por opponent.id, ordenar por fecha desc, tomar últimos 5 starts
  const filtered = logs
    .filter((s: any) => s.opponent?.id === opponentTeamId)
    .sort((a: any, b: any) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, 5);

  if (filtered.length === 0) {
    cache[cacheKey] = { ts: Date.now(), data: null };
    return null;
  }

  // Agregar stats
  let totalIP = 0, totalER = 0, totalK = 0, totalBB = 0, totalHR = 0, totalH = 0;
  const starts = filtered.map((s: any) => {
    const st = s.stat ?? {};
    const ip = parseIP(st.inningsPitched);
    const er = parseInt(st.earnedRuns ?? "0") || 0;
    totalIP += ip;
    totalER += er;
    totalK += parseInt(st.strikeOuts ?? "0") || 0;
    totalBB += parseInt(st.baseOnBalls ?? "0") || 0;
    totalHR += parseInt(st.homeRuns ?? "0") || 0;
    totalH += parseInt(st.hits ?? "0") || 0;
    return {
      date: s.date ?? "?",
      ip,
      er,
      k: parseInt(st.strikeOuts ?? "0") || 0,
      bb: parseInt(st.baseOnBalls ?? "0") || 0,
      hr: parseInt(st.homeRuns ?? "0") || 0,
      gamePk: s.game?.gamePk ?? 0,
    };
  });

  const era = totalIP > 0 ? (totalER * 9) / totalIP : 0;
  const whip = totalIP > 0 ? (totalBB + totalH) / totalIP : 0;
  const k9 = totalIP > 0 ? (totalK * 9) / totalIP : 0;
  const hr9 = totalIP > 0 ? (totalHR * 9) / totalIP : 0;
  const eraDelta = era - seasonEra;
  const significantSample = filtered.length >= 3;

  // Detectar trend: si los últimos 3 starts son todos buenos o todos malos
  const lastThree = starts.slice(0, 3);
  const goodStarts = lastThree.filter(s => s.er <= 2 && s.ip >= 5).length;
  const badStarts = lastThree.filter(s => s.er >= 4 || s.ip < 4).length;
  let recentTrend: "DOMINANCE" | "STRUGGLES" | "NEUTRAL" = "NEUTRAL";
  if (goodStarts >= 2 && lastThree.length >= 2) recentTrend = "DOMINANCE";
  if (badStarts >= 2 && lastThree.length >= 2) recentTrend = "STRUGGLES";

  let signal = "";
  const NOTE_STATCAST = " — señal HISTÓRICA; el lineup/arsenal de hoy lo manda Statcast Pitch-by-Pitch";
  if (filtered.length < 2) {
    signal = `${pitcherName} solo tiene ${filtered.length} start vs ${opponentTeamName} — muestra insuficiente`;
  } else if (recentTrend === "STRUGGLES" && significantSample) {
    signal = `🚨 Histórico desfavorable de ${pitcherName} vs ${opponentTeamName}: ${badStarts} de últimos 3 con 4+ ER. ERA ${era.toFixed(2)} en ${filtered.length} starts (vs season ${seasonEra.toFixed(2)})${NOTE_STATCAST}`;
  } else if (recentTrend === "DOMINANCE" && significantSample) {
    signal = `⭐ Histórico favorable de ${pitcherName} vs ${opponentTeamName}: ${goodStarts} de últimos 3 con 2- ER. ERA ${era.toFixed(2)} en ${filtered.length} starts (vs season ${seasonEra.toFixed(2)})${NOTE_STATCAST}`;
  } else if (significantSample && Math.abs(eraDelta) >= 1.0) {
    if (eraDelta > 0) {
      signal = `⚠️ Histórico desfavorable de ${pitcherName} vs ${opponentTeamName}: ERA ${era.toFixed(2)} en ${filtered.length} starts (+${eraDelta.toFixed(2)} vs season)${NOTE_STATCAST}`;
    } else {
      signal = `✓ Histórico favorable de ${pitcherName} vs ${opponentTeamName}: ERA ${era.toFixed(2)} en ${filtered.length} starts (${eraDelta.toFixed(2)} vs season)${NOTE_STATCAST}`;
    }
  } else {
    signal = `${pitcherName} vs ${opponentTeamName}: ERA ${era.toFixed(2)} en ${filtered.length} starts (similar a season ${seasonEra.toFixed(2)})`;
  }

  const result: PitcherVsTeamHistory = {
    pitcherId, pitcherName, opponentTeamId, opponentTeamName,
    starts,
    totalStarts: filtered.length,
    totalIP, totalER,
    era: Math.round(era * 100) / 100,
    whip: Math.round(whip * 100) / 100,
    k9: Math.round(k9 * 100) / 100,
    hr9: Math.round(hr9 * 100) / 100,
    seasonEra,
    eraDelta: Math.round(eraDelta * 100) / 100,
    significantSample,
    recentTrend,
    signal,
  };

  cache[cacheKey] = { ts: Date.now(), data: result };
  return result;
}

// Helper: para un partido, obtener historiales de ambos pitchers vs sus rivales
export async function analyzePitcherVsTeamMatchup(
  homeTeamId: number,
  homeTeamName: string,
  homePitcherId: number | undefined,
  homePitcherName: string,
  awayTeamId: number,
  awayTeamName: string,
  awayPitcherId: number | undefined,
  awayPitcherName: string,
): Promise<{ homeVsAway: PitcherVsTeamHistory | null; awayVsHome: PitcherVsTeamHistory | null }> {
  const [homeVsAway, awayVsHome] = await Promise.all([
    homePitcherId ? getPitcherVsTeam(homePitcherId, homePitcherName, awayTeamId, awayTeamName) : Promise.resolve(null),
    awayPitcherId ? getPitcherVsTeam(awayPitcherId, awayPitcherName, homeTeamId, homeTeamName) : Promise.resolve(null),
  ]);
  return { homeVsAway, awayVsHome };
}
