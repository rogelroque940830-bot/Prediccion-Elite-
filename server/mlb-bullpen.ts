// Bullpen Availability System (MLB)
// Mira los últimos 3 días de bullpen para cada equipo y predice quién está disponible HOY
// Las casas casi nunca ajustan por bullpen fatigue — aquí está nuestro edge.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export interface BullpenPitcher {
  id: number;
  name: string;
  hand?: "L" | "R";
  // Stats season para identificar rol
  saves?: number;
  holds?: number;
  era?: number;
  whip?: number;
  k9?: number;
  // Uso reciente
  daysWorked: { date: string; pitches: number; battersFaced: number; inningsPitched: number }[];
  // Análisis derivado
  role: "CLOSER" | "SETUP" | "MIDDLE" | "LONG" | "UNKNOWN";
  availability: "DISPONIBLE" | "RIESGO" | "NO_DISPONIBLE";
  availabilityProb: number;        // 0-1
  reason: string;
  totalPitchesLast3Days: number;
  consecutiveDays: number;
  lastUsed?: string;
}

export interface BullpenStatus {
  teamId: number;
  teamName: string;
  closer: BullpenPitcher | null;
  setupMen: BullpenPitcher[];
  middleRelievers: BullpenPitcher[];
  // Análisis general
  closerAvailable: boolean;
  setupAvailable: number;     // cuántos setup hombres disponibles
  bullpenCompromised: boolean; // top 3 todos NO disponibles
  predictedCloser: BullpenPitcher | null;  // quién va a cerrar hoy
  // Ajuste sugerido
  runsAdjustment: number;     // runs extra que el rival va a anotar tarde por bullpen débil
  signal: string;
}

// Cache
const teamRosterCache: Record<number, { ts: number; data: any[] }> = {};
const seasonStatsCache: Record<number, { ts: number; data: any }> = {};
const usageCache: Record<number, { ts: number; data: BullpenPitcher["daysWorked"] }> = {};

// ─── HELPERS ────────────────────────────────────────────────────────────────
function parseIP(ip: string | undefined): number {
  if (!ip) return 0;
  const parts = String(ip).split(".");
  return parseInt(parts[0]) + (parseInt(parts[1] || "0") / 3);
}

// Fechas: hoy y los 3 días previos en formato YYYY-MM-DD (Florida TZ)
function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// ─── GET BULLPEN ROSTER ─────────────────────────────────────────────────────
async function getBullpenRoster(teamId: number): Promise<any[]> {
  const cached = teamRosterCache[teamId];
  if (cached && Date.now() - cached.ts < 12 * 3600 * 1000) return cached.data;
  try {
    const r: any = await (await fetch(`${MLB_BASE}/teams/${teamId}/roster?rosterType=Active`)).json();
    const pitchers = (r.roster ?? []).filter((p: any) => p.position?.code === "1");
    // Filtrar pitchers que NO sean los probable starters (los abridores no son del bullpen normalmente)
    teamRosterCache[teamId] = { ts: Date.now(), data: pitchers };
    return pitchers;
  } catch {
    return [];
  }
}

// ─── GET SEASON STATS ───────────────────────────────────────────────────────
async function getPitcherSeasonStats(pitcherId: number): Promise<any | null> {
  const cached = seasonStatsCache[pitcherId];
  if (cached && Date.now() - cached.ts < 24 * 3600 * 1000) return cached.data;
  try {
    let stats: any = null;
    const j2026: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=2026`)).json();
    stats = j2026.stats?.[0]?.splits?.[0]?.stat;
    if (!stats || !stats.era) {
      const j2025: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=2025`)).json();
      stats = j2025.stats?.[0]?.splits?.[0]?.stat ?? stats;
    }
    seasonStatsCache[pitcherId] = { ts: Date.now(), data: stats };
    return stats;
  } catch {
    return null;
  }
}

// ─── GET TEAM GAME LOG (last N days) ────────────────────────────────────────
// Trae las gamePks de los últimos 3 días para un equipo
async function getRecentGamePks(teamId: number, daysBack: number = 3): Promise<{ gamePk: number; date: string }[]> {
  const today = dateNDaysAgo(0);
  const start = dateNDaysAgo(daysBack);
  try {
    const r: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${today}`)).json();
    const games: { gamePk: number; date: string }[] = [];
    for (const dt of (r.dates ?? [])) {
      for (const g of (dt.games ?? [])) {
        if (g.status?.codedGameState === "F" || g.status?.detailedState === "Final") {
          games.push({ gamePk: g.gamePk, date: dt.date });
        }
      }
    }
    return games;
  } catch {
    return [];
  }
}

// ─── GET BULLPEN USAGE FROM BOXSCORE ────────────────────────────────────────
// Para un gamePk dado, devuelve qué pitchers del equipo lanzaron y cuántos pitches
async function getBoxscorePitchers(gamePk: number, teamId: number): Promise<{ id: number; name: string; pitches: number; bf: number; ip: number }[]> {
  try {
    const j: any = await (await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`)).json();
    const boxscore = j.liveData?.boxscore ?? {};
    for (const side of ["home", "away"]) {
      const team = boxscore.teams?.[side] ?? {};
      if (team.team?.id === teamId) {
        const pitcherIds: number[] = team.pitchers ?? [];
        const players = team.players ?? {};
        return pitcherIds.map((pid: number) => {
          const p = players[`ID${pid}`] ?? {};
          const stats = p.stats?.pitching ?? {};
          return {
            id: pid,
            name: p.person?.fullName ?? "?",
            pitches: parseInt(stats.pitchesThrown ?? "0") || 0,
            bf: parseInt(stats.battersFaced ?? "0") || 0,
            ip: parseIP(stats.inningsPitched),
          };
        });
      }
    }
    return [];
  } catch {
    return [];
  }
}

// ─── DETERMINE ROLE ─────────────────────────────────────────────────────────
function determineRole(stats: any): BullpenPitcher["role"] {
  if (!stats) return "UNKNOWN";
  const saves = parseInt(stats.saves ?? "0") || 0;
  const holds = parseInt(stats.holds ?? "0") || 0;
  const games = parseInt(stats.gamesPlayed ?? "0") || 0;
  const ip = parseIP(stats.inningsPitched);
  const ipPerGame = games > 0 ? ip / games : 0;
  if (saves >= 5) return "CLOSER";
  if (holds >= 8 && ipPerGame < 1.3) return "SETUP";
  if (ipPerGame >= 1.5 && games >= 5) return "LONG";
  if (games >= 5) return "MIDDLE";
  return "UNKNOWN";
}

// ─── ANALYZE AVAILABILITY ───────────────────────────────────────────────────
function analyzeAvailability(daysWorked: BullpenPitcher["daysWorked"]): {
  availability: BullpenPitcher["availability"];
  availabilityProb: number;
  reason: string;
  consecutiveDays: number;
  totalPitchesLast3Days: number;
} {
  const today = dateNDaysAgo(0);
  const yesterday = dateNDaysAgo(1);
  const dayBefore = dateNDaysAgo(2);

  const yesterdayWork = daysWorked.find(d => d.date === yesterday);
  const dayBeforeWork = daysWorked.find(d => d.date === dayBefore);
  const threeDaysAgoWork = daysWorked.find(d => d.date === dateNDaysAgo(3));

  const totalPitchesLast3Days = (yesterdayWork?.pitches ?? 0) + (dayBeforeWork?.pitches ?? 0) + (threeDaysAgoWork?.pitches ?? 0);

  // Consecutive days
  let consecutive = 0;
  if (yesterdayWork && yesterdayWork.pitches > 0) {
    consecutive = 1;
    if (dayBeforeWork && dayBeforeWork.pitches > 0) {
      consecutive = 2;
      if (threeDaysAgoWork && threeDaysAgoWork.pitches > 0) consecutive = 3;
    }
  }

  // Reglas
  if (consecutive >= 3) {
    return {
      availability: "NO_DISPONIBLE",
      availabilityProb: 0.05,
      reason: `Lanzó 3 días seguidos (${threeDaysAgoWork?.pitches ?? 0}p · ${dayBeforeWork?.pitches ?? 0}p · ${yesterdayWork?.pitches ?? 0}p)`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }

  const yp = yesterdayWork?.pitches ?? 0;

  if (yp >= 36) {
    return {
      availability: "NO_DISPONIBLE",
      availabilityProb: 0.15,
      reason: `Lanzó ${yp} pitches ayer (extended outing)`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }

  if (yp >= 26) {
    const probBase = 0.50;
    const prob = consecutive === 2 ? Math.max(0.20, probBase - 0.30) : probBase;
    return {
      availability: prob < 0.40 ? "NO_DISPONIBLE" : "RIESGO",
      availabilityProb: prob,
      reason: `Lanzó ${yp} pitches ayer${consecutive === 2 ? " + back-to-back" : ""}`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }

  if (yp >= 16) {
    const probBase = 0.75;
    const prob = consecutive === 2 ? Math.max(0.40, probBase - 0.30) : probBase;
    return {
      availability: consecutive === 2 ? "RIESGO" : "DISPONIBLE",
      availabilityProb: prob,
      reason: `Lanzó ${yp} pitches ayer${consecutive === 2 ? " + back-to-back" : ""}`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }

  if (yp >= 1) {
    const probBase = 0.90;
    const prob = consecutive === 2 ? Math.max(0.55, probBase - 0.30) : probBase;
    return {
      availability: "DISPONIBLE",
      availabilityProb: prob,
      reason: `Lanzó ${yp} pitches ayer (1 inning ligero)${consecutive === 2 ? " + back-to-back" : ""}`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }

  return {
    availability: "DISPONIBLE",
    availabilityProb: 0.95,
    reason: "Descansó ayer",
    consecutiveDays: 0,
    totalPitchesLast3Days,
  };
}

// ─── MAIN: GET BULLPEN STATUS ───────────────────────────────────────────────
export async function getBullpenStatus(teamId: number, teamName: string): Promise<BullpenStatus> {
  // 1. Roster + season stats
  const roster = await getBullpenRoster(teamId);

  // 2. Para cada pitcher, traer season stats y construir BullpenPitcher
  const allPitchers: BullpenPitcher[] = await Promise.all(
    roster.slice(0, 18).map(async (p: any) => {
      const pid = p.person?.id;
      const name = p.person?.fullName ?? "?";
      const stats = await getPitcherSeasonStats(pid);
      const role = determineRole(stats);
      // No incluir abridores (gamesStarted alto)
      const gs = parseInt(stats?.gamesStarted ?? "0") || 0;
      const ip = parseIP(stats?.inningsPitched);
      const isStarter = gs >= 5 && ip >= 30 && (ip / Math.max(gs, 1)) >= 4.5;
      if (isStarter) return null;
      return {
        id: pid,
        name,
        saves: parseInt(stats?.saves ?? "0") || 0,
        holds: parseInt(stats?.holds ?? "0") || 0,
        era: parseFloat(stats?.era) || undefined,
        whip: parseFloat(stats?.whip) || undefined,
        k9: parseFloat(stats?.strikeoutsPer9Inn) || undefined,
        role,
        daysWorked: [],
        availability: "DISPONIBLE",
        availabilityProb: 0.95,
        reason: "",
        totalPitchesLast3Days: 0,
        consecutiveDays: 0,
      } as BullpenPitcher;
    }),
  ).then(arr => arr.filter(Boolean) as BullpenPitcher[]);

  // 3. Traer uso de los últimos 3 días
  const recentGames = await getRecentGamePks(teamId, 3);
  for (const game of recentGames) {
    const pitchersUsed = await getBoxscorePitchers(game.gamePk, teamId);
    for (const used of pitchersUsed) {
      const pitcher = allPitchers.find(p => p.id === used.id);
      if (pitcher) {
        pitcher.daysWorked.push({
          date: game.date,
          pitches: used.pitches,
          battersFaced: used.bf,
          inningsPitched: used.ip,
        });
      }
    }
  }

  // 4. Analizar disponibilidad de cada uno
  for (const p of allPitchers) {
    const analysis = analyzeAvailability(p.daysWorked);
    p.availability = analysis.availability;
    p.availabilityProb = analysis.availabilityProb;
    p.reason = analysis.reason;
    p.consecutiveDays = analysis.consecutiveDays;
    p.totalPitchesLast3Days = analysis.totalPitchesLast3Days;
    if (p.daysWorked.length > 0) {
      const sorted = [...p.daysWorked].sort((a, b) => b.date.localeCompare(a.date));
      p.lastUsed = sorted[0]?.date;
    }
  }

  // 5. Identificar closer y setup men
  const closer = [...allPitchers].sort((a, b) => (b.saves ?? 0) - (a.saves ?? 0))[0] ?? null;
  if (closer && (closer.saves ?? 0) === 0) {
    // Sin closer claro
  }
  const setupMen = allPitchers
    .filter(p => p.id !== closer?.id && p.role === "SETUP")
    .sort((a, b) => (b.holds ?? 0) - (a.holds ?? 0))
    .slice(0, 3);
  const middleRelievers = allPitchers
    .filter(p => p.id !== closer?.id && !setupMen.includes(p))
    .slice(0, 4);

  // 6. Análisis general
  const closerAvailable = closer ? closer.availability !== "NO_DISPONIBLE" : false;
  const setupAvailable = setupMen.filter(p => p.availability !== "NO_DISPONIBLE").length;
  const bullpenCompromised = !closerAvailable && setupAvailable === 0;

  // 7. Predecir quién cerrará
  let predictedCloser: BullpenPitcher | null = null;
  if (closer && closer.availability === "DISPONIBLE") {
    predictedCloser = closer;
  } else {
    // Buscar el setup man con mejor stats que esté disponible
    const candidates = [...setupMen, ...middleRelievers].filter(p => p.availability === "DISPONIBLE");
    candidates.sort((a, b) => (a.era ?? 5.0) - (b.era ?? 5.0));
    predictedCloser = candidates[0] ?? null;
  }

  // 8. Calcular ajuste de runs
  let runsAdjustment = 0;
  let signal = "";
  if (bullpenCompromised) {
    runsAdjustment = 0.7;
    signal = `🚨 Bullpen comprometido — top 3 (closer + 2 setup) NO disponibles. Rival anotará más en 7-9.`;
  } else if (!closerAvailable && setupAvailable <= 1) {
    runsAdjustment = 0.5;
    signal = `⚠️ Closer NO disponible y solo ${setupAvailable} setup disponible. Cerrará probablemente ${predictedCloser?.name ?? "relevista débil"}.`;
  } else if (!closerAvailable) {
    runsAdjustment = 0.3;
    signal = `⚠️ Closer NO disponible. Cerrará probablemente ${predictedCloser?.name ?? "?"} (setup man).`;
  } else if (closer && closer.availability === "RIESGO") {
    runsAdjustment = 0.15;
    signal = `🔶 Closer disponible pero arriesgado (${closer.reason}). Rendimiento puede caer.`;
  } else {
    signal = `✅ Bullpen completo. ${closer?.name ?? "Closer"} disponible.`;
  }

  return {
    teamId,
    teamName,
    closer,
    setupMen,
    middleRelievers,
    closerAvailable,
    setupAvailable,
    bullpenCompromised,
    predictedCloser,
    runsAdjustment,
    signal,
  };
}
