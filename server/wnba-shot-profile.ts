// WNBA Shot Profile + H2H desde ESPN
// Shot Profile: 3PAr, 2PAr, FTRate, eFG%, defense allowed por shot type
// H2H: results entre 2 equipos en últimos 2 años

const CACHE_TTL = 6 * 60 * 60 * 1000;       // 6h
const profileCache: Record<number, { ts: number; data: TeamShotProfile | null }> = {};
const h2hCache: Record<string, { ts: number; data: H2HRecord | null }> = {};

export interface TeamShotProfile {
  espnTeamId: number;
  teamName: string;
  gamesPlayed: number;
  // Offensive shot tendencies
  fga: number;                    // attempts per game
  fg3a: number;
  fg3aRate: number;               // 3PA / FGA
  ftaRate: number;                // FTA / FGA
  fg3Pct: number;
  fgPct: number;
  efgPct: number;                 // effective FG%
  ppg: number;
  // Defensive — what we allow (calculated from opponent shooting via boxscore aggregates if available)
  // Por ahora usamos defRtg como proxy de calidad defensiva general
  defRtg?: number;
  // Style tier
  styleTier: "3PT_HEAVY" | "BALANCED" | "2PT_HEAVY";
}

function getStyleTier(fg3aRate: number): TeamShotProfile["styleTier"] {
  // liga WNBA promedio ~33% 3PA rate. >38% heavy, <28% 2pt heavy.
  if (fg3aRate > 0.38) return "3PT_HEAVY";
  if (fg3aRate < 0.28) return "2PT_HEAVY";
  return "BALANCED";
}

export async function fetchTeamShotProfile(espnTeamId: number, teamName: string): Promise<TeamShotProfile | null> {
  const cached = profileCache[espnTeamId];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${espnTeamId}/statistics`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) throw new Error(`ESPN team stats ${res.status}`);
    const j: any = await res.json();
    const cats = j?.results?.stats?.categories ?? [];

    const statMap: Record<string, number> = {};
    for (const c of cats) {
      for (const s of c.stats ?? []) {
        const v = s.perGameValue ?? s.value;
        if (typeof v === "number") statMap[s.name] = v;
      }
    }

    const fga = statMap["fieldGoalsAttempted"] ?? 0;
    const fg3a = statMap["threePointFieldGoalsAttempted"] ?? 0;
    const fta = statMap["freeThrowsAttempted"] ?? 0;
    const fgPctRaw = statMap["fieldGoalPct"] ?? 0;
    const fg3PctRaw = statMap["threePointFieldGoalPct"] ?? 0;
    const fgPct = fgPctRaw > 1 ? fgPctRaw / 100 : fgPctRaw;
    const fg3Pct = fg3PctRaw > 1 ? fg3PctRaw / 100 : fg3PctRaw;
    const fgm = statMap["fieldGoalsMade"] ?? 0;
    const fg3m = statMap["threePointFieldGoalsMade"] ?? 0;
    const ppg = statMap["points"] ?? 0;
    const gp = statMap["gamesPlayed"] ?? 1;

    if (fga === 0) {
      profileCache[espnTeamId] = { ts: Date.now(), data: null };
      return null;
    }

    const fg3aRate = fg3a / fga;
    const ftaRate = fta / fga;
    const efgPct = (fgm + 0.5 * fg3m) / fga;

    const result: TeamShotProfile = {
      espnTeamId,
      teamName,
      gamesPlayed: Math.round(gp),
      fga: Math.round(fga * 10) / 10,
      fg3a: Math.round(fg3a * 10) / 10,
      fg3aRate: Math.round(fg3aRate * 1000) / 1000,
      ftaRate: Math.round(ftaRate * 1000) / 1000,
      fg3Pct: Math.round(fg3Pct * 1000) / 1000,
      fgPct: Math.round(fgPct * 1000) / 1000,
      efgPct: Math.round(efgPct * 1000) / 1000,
      ppg: Math.round(ppg * 10) / 10,
      styleTier: getStyleTier(fg3aRate),
    };
    profileCache[espnTeamId] = { ts: Date.now(), data: result };
    return result;
  } catch (e) {
    console.error(`[wnba-shot-profile] team ${espnTeamId}:`, e);
    return cached?.data ?? null;
  }
}

// ─── H2H 2-year ─────────────────────────────────────────────────────────────

export interface H2HRecord {
  homeTeamId: number;
  awayTeamId: number;
  gamesAnalyzed: number;
  homeWins: number;
  awayWins: number;
  avgHomeScore: number;
  avgAwayScore: number;
  avgTotal: number;
  homeNetMargin: number;        // promedio (homeScore - awayScore)
  recentGames: Array<{ date: string; homeScore: number; awayScore: number; venue: string }>;
}

async function fetchTeamSchedule(espnTeamId: number, year: number): Promise<any[]> {
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/${espnTeamId}/schedule?season=${year}`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!res.ok) return [];
    const j: any = await res.json();
    return j.events ?? [];
  } catch {
    return [];
  }
}

export async function getH2H(homeTeamId: number, awayTeamId: number): Promise<H2HRecord | null> {
  const key = `${homeTeamId}_${awayTeamId}`;
  const cached = h2hCache[key];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const yr = new Date().getFullYear();
  const seasons = [yr, yr - 1];

  const allHomeEvents: any[] = [];
  for (const s of seasons) {
    const events = await fetchTeamSchedule(homeTeamId, s);
    allHomeEvents.push(...events);
  }

  const h2hGames: any[] = [];
  for (const e of allHomeEvents) {
    const comp = e.competitions?.[0];
    if (!comp) continue;
    const c0 = comp.competitors?.[0];
    const c1 = comp.competitors?.[1];
    if (!c0 || !c1) continue;
    const id0 = parseInt(c0.id ?? c0.team?.id);
    const id1 = parseInt(c1.id ?? c1.team?.id);
    if (![id0, id1].includes(awayTeamId)) continue;
    // Solo juegos completados (con score)
    const score0 = c0.score?.displayValue ? parseInt(c0.score.displayValue) : null;
    const score1 = c1.score?.displayValue ? parseInt(c1.score.displayValue) : null;
    if (score0 === null || score1 === null) continue;

    const home0 = c0.homeAway === "home";
    const homeScore = home0 ? score0 : score1;
    const awayScore = home0 ? score1 : score0;
    const homeTeamWasUs = (home0 ? id0 : id1) === homeTeamId;

    h2hGames.push({
      date: e.date,
      homeScore,
      awayScore,
      homeTeamWasOriginalHome: homeTeamWasUs,
      venue: comp.venue?.fullName ?? "",
    });
  }

  if (h2hGames.length === 0) {
    h2hCache[key] = { ts: Date.now(), data: null };
    return null;
  }

  // Calcular agregados desde la perspectiva del LOCAL DE HOY
  let ourWins = 0, theirWins = 0;
  let ourTotal = 0, theirTotal = 0;
  for (const g of h2hGames) {
    const ourScore = g.homeTeamWasOriginalHome ? g.homeScore : g.awayScore;
    const theirScore = g.homeTeamWasOriginalHome ? g.awayScore : g.homeScore;
    if (ourScore > theirScore) ourWins++; else theirWins++;
    ourTotal += ourScore;
    theirTotal += theirScore;
  }
  const n = h2hGames.length;
  const result: H2HRecord = {
    homeTeamId, awayTeamId,
    gamesAnalyzed: n,
    homeWins: ourWins,
    awayWins: theirWins,
    avgHomeScore: Math.round(ourTotal / n * 10) / 10,
    avgAwayScore: Math.round(theirTotal / n * 10) / 10,
    avgTotal: Math.round((ourTotal + theirTotal) / n * 10) / 10,
    homeNetMargin: Math.round(((ourTotal - theirTotal) / n) * 10) / 10,
    recentGames: h2hGames.slice(-5).map(g => ({
      date: g.date,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      venue: g.venue,
    })),
  };
  h2hCache[key] = { ts: Date.now(), data: result };
  return result;
}
