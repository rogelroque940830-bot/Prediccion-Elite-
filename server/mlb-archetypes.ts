// Pitcher Archetype Matchup System (MLB)
// Clasifica pitchers en arquetipos y mide cómo cada equipo le pega a cada arquetipo
// Identifica patrones que las casas no procesan: ej "Twins le pegan a RHP medianos"

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export type PitcherArchetype =
  | "POWER_RHP_ELITE"      // RHP, K/9 ≥10, ERA <3.20
  | "POWER_RHP_DECENT"     // RHP, K/9 ≥9, ERA 3.20-4.00
  | "RHP_MEDIANO_VULN"     // RHP, K/9 7-9, ERA 3.80-4.50  ← AQUÍ EL EDGE
  | "RHP_MALO"             // RHP, ERA >4.50
  | "CONTACT_RHP"          // RHP, K/9 <8, ERA <3.80
  | "POWER_LHP_ELITE"      // LHP, K/9 ≥10, ERA <3.20
  | "LHP_MEDIANO_VULN"     // LHP, K/9 7-9, ERA 3.80-4.50
  | "LHP_MALO"             // LHP, ERA >4.50
  | "CONTACT_LHP"          // LHP, K/9 <8
  | "JUNKBALLER"           // K/9 <7 (cualquier mano)
  | "OPENER"               // gamesStarted/IP very low
  | "UNKNOWN";

export interface PitcherProfile {
  id: number;
  name: string;
  hand?: "L" | "R";
  era?: number;
  k9?: number;
  whip?: number;
  ip?: number;
  gamesStarted?: number;
  archetype: PitcherArchetype;
}

export interface ArchetypeRecord {
  archetype: PitcherArchetype;
  games: number;
  wins: number;
  losses: number;
  runsScored: number;
  runsAllowed: number;
  // metrics derivados
  avgRunsScored: number;
  avgRunsAllowed: number;
  winRate: number;
  // Si tienen ≥5 juegos, esta es señal real
  significantSample: boolean;
}

export interface TeamArchetypeProfile {
  teamId: number;
  teamName: string;
  byArchetype: Record<PitcherArchetype, ArchetypeRecord>;
  totalGamesAnalyzed: number;
  seasonRange: string;
}

// ─── ARCHETYPE CLASSIFIER ───────────────────────────────────────────────────
export function classifyPitcher(p: { hand?: "L" | "R"; era?: number; k9?: number; ip?: number; gamesStarted?: number }): PitcherArchetype {
  const era = p.era ?? 4.5;
  const k9 = p.k9 ?? 7.5;
  const ip = p.ip ?? 0;
  const gs = p.gamesStarted ?? 0;
  const hand = p.hand;

  // Opener si gamesStarted alto pero IP baja por start
  if (gs >= 5 && ip > 0 && (ip / gs) < 3) return "OPENER";

  // Junkballer: baja velocidad de strikeout independiente de mano
  if (k9 < 7) return "JUNKBALLER";

  if (hand === "R") {
    if (k9 >= 10 && era < 3.20) return "POWER_RHP_ELITE";
    if (k9 >= 9 && era < 4.00) return "POWER_RHP_DECENT";
    if (era > 4.50) return "RHP_MALO";
    if (k9 >= 7 && k9 < 9 && era >= 3.80 && era <= 4.50) return "RHP_MEDIANO_VULN";
    if (k9 < 8 && era < 3.80) return "CONTACT_RHP";
    return "RHP_MEDIANO_VULN"; // default si no encaja en otro
  }

  if (hand === "L") {
    if (k9 >= 10 && era < 3.20) return "POWER_LHP_ELITE";
    if (era > 4.50) return "LHP_MALO";
    if (k9 >= 7 && k9 < 9 && era >= 3.80 && era <= 4.50) return "LHP_MEDIANO_VULN";
    if (k9 < 8 && era < 3.80) return "CONTACT_LHP";
    return "LHP_MEDIANO_VULN";
  }

  return "UNKNOWN";
}

// ─── TEAM PROFILE BUILDER ───────────────────────────────────────────────────
// Cache: para cada equipo, guardar perfil de matchups por arquetipo
const profileCache: Record<number, { ts: number; profile: TeamArchetypeProfile }> = {};
const PROFILE_TTL = 12 * 3600 * 1000; // 12 horas

// Cache de stats de pitchers (compartido)
const pitcherStatsCache: Record<number, { ts: number; data: any }> = {};

async function getPitcherStats(pitcherId: number): Promise<{ hand?: "L" | "R"; era?: number; k9?: number; ip?: number; gamesStarted?: number } | null> {
  const cached = pitcherStatsCache[pitcherId];
  if (cached && Date.now() - cached.ts < 24 * 3600 * 1000) return cached.data;
  try {
    // FIX auditoría: usar temporada actual primero, fallback a temporada anterior
    // si el pitcher no tiene IP en current season (rookies, debutantes, retornos de IL)
    const currentSeason = new Date().getFullYear();
    const prevSeason = currentSeason - 1;
    const [info, currStats, prevStats] = await Promise.all([
      fetch(`${MLB_BASE}/people/${pitcherId}`).then(r => r.json()),
      fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${currentSeason}`).then(r => r.json()),
      fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${prevSeason}`).then(r => r.json()),
    ]);
    const person = info.people?.[0];
    const hand = person?.pitchHand?.code as "L" | "R" | undefined;
    // Preferir temporada actual si tiene IP suficiente (>10 IP), si no — caer a la anterior
    const currStat = currStats.stats?.[0]?.splits?.[0]?.stat;
    const prevStat = prevStats.stats?.[0]?.splits?.[0]?.stat;
    const currIp = currStat ? parseIP(currStat.inningsPitched || "0") : 0;
    const stat = currIp >= 10 ? currStat : (prevStat || currStat);
    if (!stat) {
      const data = { hand };
      pitcherStatsCache[pitcherId] = { ts: Date.now(), data };
      return data;
    }
    const ip = parseIP(stat.inningsPitched || "0");
    const data = {
      hand,
      era: parseFloat(stat.era) || undefined,
      k9: parseFloat(stat.strikeoutsPer9Inn) || undefined,
      ip,
      gamesStarted: parseInt(stat.gamesStarted) || 0,
    };
    pitcherStatsCache[pitcherId] = { ts: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

function parseIP(ip: string): number {
  const parts = ip.split(".");
  return parseInt(parts[0]) + (parseInt(parts[1] || "0") / 3);
}

function emptyRecord(arch: PitcherArchetype): ArchetypeRecord {
  return {
    archetype: arch,
    games: 0, wins: 0, losses: 0,
    runsScored: 0, runsAllowed: 0,
    avgRunsScored: 0, avgRunsAllowed: 0,
    winRate: 0, significantSample: false,
  };
}

export async function getTeamArchetypeProfile(teamId: number, teamName: string): Promise<TeamArchetypeProfile> {
  const cached = profileCache[teamId];
  if (cached && Date.now() - cached.ts < PROFILE_TTL) return cached.profile;

  const archetypes: PitcherArchetype[] = [
    "POWER_RHP_ELITE", "POWER_RHP_DECENT", "RHP_MEDIANO_VULN", "RHP_MALO",
    "CONTACT_RHP", "POWER_LHP_ELITE", "LHP_MEDIANO_VULN", "LHP_MALO",
    "CONTACT_LHP", "JUNKBALLER", "OPENER", "UNKNOWN",
  ];
  const byArchetype: Record<PitcherArchetype, ArchetypeRecord> = {} as any;
  for (const a of archetypes) byArchetype[a] = emptyRecord(a);

  // Obtener juegos del equipo en season 2025 + lo que haya 2026
  // Usar últimos 90 días para señal reciente
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 200 * 24 * 60 * 60 * 1000); // ~ todo 2025
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  let games: any[] = [];
  try {
    const [s2025, s2026] = await Promise.all([
      fetch(`${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=2025-03-01&endDate=2025-11-01&hydrate=probablePitcher,decisions&gameType=R`).then(r => r.json()),
      fetch(`${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=2026-03-01&endDate=${fmt(endDate)}&hydrate=probablePitcher,decisions&gameType=R`).then(r => r.json()),
    ]);
    for (const dt of (s2025.dates ?? [])) games.push(...(dt.games ?? []));
    for (const dt of (s2026.dates ?? [])) games.push(...(dt.games ?? []));
  } catch (e) {
    console.error("Failed to fetch team schedule:", e);
  }

  // Filtrar a juegos terminados con score
  const completed = games.filter(g => g.status?.statusCode === "F" || g.status?.detailedState === "Final");

  // Para cada juego, identificar pitcher rival, su arquetipo, y el resultado para nuestro equipo
  let processed = 0;
  for (const g of completed) {
    const isHome = g.teams?.home?.team?.id === teamId;
    const ourTeam = isHome ? g.teams.home : g.teams.away;
    const oppTeam = isHome ? g.teams.away : g.teams.home;
    const oppPitcher = oppTeam?.probablePitcher;
    if (!oppPitcher?.id) continue;

    const stats = await getPitcherStats(oppPitcher.id);
    if (!stats) continue;
    const arch = classifyPitcher(stats);

    const rec = byArchetype[arch];
    rec.games++;
    rec.runsScored += ourTeam.score ?? 0;
    rec.runsAllowed += oppTeam.score ?? 0;
    if ((ourTeam.score ?? 0) > (oppTeam.score ?? 0)) rec.wins++;
    else if ((ourTeam.score ?? 0) < (oppTeam.score ?? 0)) rec.losses++;
    processed++;

    // Limitar para no saturar la API
    if (processed > 200) break;
  }

  // Calcular promedios
  for (const a of archetypes) {
    const r = byArchetype[a];
    if (r.games > 0) {
      r.avgRunsScored = r.runsScored / r.games;
      r.avgRunsAllowed = r.runsAllowed / r.games;
      r.winRate = r.wins / r.games;
      r.significantSample = r.games >= 5;
    }
  }

  const profile: TeamArchetypeProfile = {
    teamId,
    teamName,
    byArchetype,
    totalGamesAnalyzed: processed,
    seasonRange: "2025 + 2026 (in-season)",
  };

  profileCache[teamId] = { ts: Date.now(), profile };
  return profile;
}

// ─── ANÁLISIS DE MATCHUP ────────────────────────────────────────────────────
export interface ArchetypeMatchupResult {
  pitcherId: number;
  pitcherName: string;
  archetype: PitcherArchetype;
  archetypeLabel: string;
  homeRecord: ArchetypeRecord;
  awayRecord: ArchetypeRecord;
  // Lectura de matchup
  homeAdvantage: number;      // runs/juego diff vs liga promedio (4.5)
  awayAdvantage: number;
  signal: string;             // texto explicativo
}

export async function analyzeMatchup(
  homeTeamId: number,
  homeTeamName: string,
  awayTeamId: number,
  awayTeamName: string,
  homePitcherId: number | undefined,
  homePitcherName: string,
  awayPitcherId: number | undefined,
  awayPitcherName: string,
): Promise<{ home: ArchetypeMatchupResult | null; away: ArchetypeMatchupResult | null }> {

  const [homeProfile, awayProfile] = await Promise.all([
    getTeamArchetypeProfile(homeTeamId, homeTeamName),
    getTeamArchetypeProfile(awayTeamId, awayTeamName),
  ]);

  const result: { home: ArchetypeMatchupResult | null; away: ArchetypeMatchupResult | null } = { home: null, away: null };

  // Local enfrenta al pitcher VISITANTE → buscamos cómo le pega ESE equipo (homeProfile) a ESE arquetipo
  if (awayPitcherId) {
    const awayPitcherStats = await getPitcherStats(awayPitcherId);
    if (awayPitcherStats) {
      const arch = classifyPitcher(awayPitcherStats);
      const homeRecord = homeProfile.byArchetype[arch];
      const awayRecord = awayProfile.byArchetype[arch];
      const homeAdvantage = homeRecord.games > 0 ? homeRecord.avgRunsScored - 4.5 : 0;
      const awayAdvantage = awayRecord.games > 0 ? awayRecord.avgRunsScored - 4.5 : 0;
      result.home = {
        pitcherId: awayPitcherId,
        pitcherName: awayPitcherName,
        archetype: arch,
        archetypeLabel: archetypeLabel(arch),
        homeRecord,
        awayRecord,
        homeAdvantage,
        awayAdvantage,
        signal: buildSignal(homeTeamName, arch, homeRecord, awayPitcherName),
      };
    }
  }

  // Visitante enfrenta al pitcher LOCAL
  if (homePitcherId) {
    const homePitcherStats = await getPitcherStats(homePitcherId);
    if (homePitcherStats) {
      const arch = classifyPitcher(homePitcherStats);
      const homeRecord = homeProfile.byArchetype[arch];
      const awayRecord = awayProfile.byArchetype[arch];
      const homeAdvantage = homeRecord.games > 0 ? homeRecord.avgRunsScored - 4.5 : 0;
      const awayAdvantage = awayRecord.games > 0 ? awayRecord.avgRunsScored - 4.5 : 0;
      result.away = {
        pitcherId: homePitcherId,
        pitcherName: homePitcherName,
        archetype: arch,
        archetypeLabel: archetypeLabel(arch),
        homeRecord,
        awayRecord,
        homeAdvantage,
        awayAdvantage,
        signal: buildSignal(awayTeamName, arch, awayRecord, homePitcherName),
      };
    }
  }

  return result;
}

export function archetypeLabel(arch: PitcherArchetype): string {
  switch (arch) {
    case "POWER_RHP_ELITE": return "Power RHP élite";
    case "POWER_RHP_DECENT": return "Power RHP decente";
    case "RHP_MEDIANO_VULN": return "RHP mediano (vulnerable)";
    case "RHP_MALO": return "RHP malo";
    case "CONTACT_RHP": return "Contact RHP";
    case "POWER_LHP_ELITE": return "Power LHP élite";
    case "LHP_MEDIANO_VULN": return "LHP mediano (vulnerable)";
    case "LHP_MALO": return "LHP malo";
    case "CONTACT_LHP": return "Contact LHP";
    case "JUNKBALLER": return "Junkballer";
    case "OPENER": return "Opener / Bullpen day";
    default: return "Desconocido";
  }
}

function buildSignal(teamName: string, arch: PitcherArchetype, rec: ArchetypeRecord, pitcherName: string): string {
  if (rec.games < 3) {
    return `${teamName} enfrenta ${pitcherName} (${archetypeLabel(arch)}) — muestra insuficiente (${rec.games} juegos)`;
  }
  const sample = rec.significantSample ? "muestra sólida" : "muestra moderada";
  if (rec.avgRunsScored >= 5.5) {
    return `🔥 ${teamName} le pega FUERTE a ${archetypeLabel(arch)} — ${rec.avgRunsScored.toFixed(1)} runs/juego en ${rec.games} juegos (${rec.wins}-${rec.losses}, ${(rec.winRate * 100).toFixed(0)}% W) [${sample}]`;
  }
  if (rec.avgRunsScored <= 3.0) {
    return `❄️ ${teamName} sufre vs ${archetypeLabel(arch)} — solo ${rec.avgRunsScored.toFixed(1)} runs/juego en ${rec.games} juegos (${rec.wins}-${rec.losses}) [${sample}]`;
  }
  return `${teamName} promedia ${rec.avgRunsScored.toFixed(1)} runs/juego vs ${archetypeLabel(arch)} (${rec.games} juegos, ${rec.wins}-${rec.losses})`;
}
