// ═══════════════════════════════════════════════════════════════════════════
// TEAM FATIGUE / TRAVEL — efecto del calendario en la ofensiva
//
// Hueco #3:
//   1. Day-after-night: si jugaron noche y hoy es matinal/tarde → -0.5 OPS pts
//   2. Travel: cambio de zona horaria (Costa→Costa) → -0.3 OPS
//   3. Stretch: 8+ juegos en 7 días sin off-day → fatiga acumulada
//   4. Off-day previo: rebote (positivo)
//
// Salida: deltas de runs por equipo (positivo si suma, negativo si resta)
// ═══════════════════════════════════════════════════════════════════════════

const STADIUM_TZ_OFFSET: Record<string, number> = {
  // Approx UTC offsets (in hours, ignoring DST nuances — close enough for travel detection)
  // Eastern = -5/-4, Central = -6/-5, Mountain = -7/-6, Pacific = -8/-7
  "Fenway Park": -5, "Yankee Stadium": -5, "Camden Yards": -5, "Rogers Centre": -5,
  "Tropicana Field": -5, "Steinbrenner Field": -5,
  "Progressive Field": -5, "Comerica Park": -5, "Kauffman Stadium": -6,
  "Guaranteed Rate Field": -6, "Rate Field": -6, "Target Field": -6,
  "Truist Park": -5, "Citizens Bank Park": -5, "loanDepot park": -5,
  "Citi Field": -5, "Nationals Park": -5,
  "American Family Field": -6, "Wrigley Field": -6, "Great American Ball Park": -5,
  "Busch Stadium": -6, "PNC Park": -5,
  "Globe Life Field": -6, "Daikin Park": -6, "Minute Maid Park": -6,
  "Angel Stadium": -8, "Sutter Health Park": -8, "Oakland Coliseum": -8,
  "Dodger Stadium": -8, "Petco Park": -8, "Oracle Park": -8, "T-Mobile Park": -8,
  "Coors Field": -7, "Chase Field": -7, "Salt River Fields": -7,
};

interface FatigueResult {
  team: string;
  daysSinceLastGame: number | null;
  lastGameWasNight: boolean;
  todayIsAfternoon: boolean;
  travelTzShift: number;        // hours (positive = traveled east)
  gamesLast7Days: number;
  hadOffDay: boolean;            // off-day in last 2 days = rebote
  opsDelta: number;              // delta a OPS de batting (negativo = peor)
  runsDelta: number;             // delta a runs esperadas
  notes: string[];
}

async function fetchTeamSchedule(teamId: number, startDate: string, endDate: string): Promise<any[]> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return [];
    const data: any = await r.json();
    const games: any[] = [];
    for (const d of data.dates ?? []) {
      for (const g of d.games ?? []) {
        if (g?.status?.codedGameState && ["F", "I", "O"].includes(g.status.codedGameState)) {
          games.push(g);
        }
      }
    }
    return games;
  } catch { return []; }
  finally { clearTimeout(t); }
}

function isNightGame(iso: string): boolean {
  // Game starts after 5 PM local? Approximation: if UTC hour >= 22 it's night EDT, >=23 night CDT...
  // Simplified: if UTC hour >= 22 OR <= 4, treat as night
  const h = new Date(iso).getUTCHours();
  return h >= 22 || h <= 4;
}

function isAfternoonGame(iso: string): boolean {
  const h = new Date(iso).getUTCHours();
  // Day game ~ 16:00-21:00 UTC (12-5 PM ET)
  return h >= 16 && h < 22;
}

async function getTeamFatigue(teamId: number, teamName: string, gameDateIso: string, gameVenue: string): Promise<FatigueResult> {
  const result: FatigueResult = {
    team: teamName, daysSinceLastGame: null, lastGameWasNight: false,
    todayIsAfternoon: isAfternoonGame(gameDateIso), travelTzShift: 0,
    gamesLast7Days: 0, hadOffDay: false, opsDelta: 0, runsDelta: 0, notes: [],
  };

  // Pull last 8 days of schedule
  const today = new Date(gameDateIso);
  const start = new Date(today.getTime() - 8 * 86400000).toISOString().slice(0, 10);
  const end = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
  const games = await fetchTeamSchedule(teamId, start, end);

  result.gamesLast7Days = games.length;
  if (games.length >= 8) {
    result.notes.push(`Stretch ${games.length} juegos en 7 días`);
    result.opsDelta -= 0.015;
  }

  if (games.length === 0) {
    // Long break — could be season-opening or rebote positivo
    result.notes.push("Sin juegos previos en 7 días");
    return result;
  }

  // Days since last game (considering off-day)
  const lastGame = games[games.length - 1];
  const lastDate = new Date(lastGame.gameDate);
  const daysSince = Math.round((today.getTime() - lastDate.getTime()) / 86400000);
  result.daysSinceLastGame = daysSince;

  if (daysSince >= 2) {
    result.hadOffDay = true;
    result.notes.push(`Off-day previo (${daysSince}d) — rebote +OPS`);
    result.opsDelta += 0.010;
  }

  // Day after night?
  result.lastGameWasNight = isNightGame(lastGame.gameDate);
  if (result.lastGameWasNight && result.todayIsAfternoon && daysSince <= 1) {
    result.notes.push("Día después de noche (matinal/tarde) — bate frío");
    result.opsDelta -= 0.020;
  }

  // Travel — compare last venue to current venue TZ
  const lastVenue = lastGame?.venue?.name;
  const lastTz = STADIUM_TZ_OFFSET[lastVenue ?? ""];
  const currTz = STADIUM_TZ_OFFSET[gameVenue ?? ""];
  if (typeof lastTz === "number" && typeof currTz === "number") {
    const shift = currTz - lastTz; // negativo = viajó al oeste, positivo = al este
    result.travelTzShift = shift;
    if (Math.abs(shift) >= 2 && daysSince <= 1) {
      // East travel (e.g. LA → NY) is harder; west travel less so
      const penalty = shift > 0 ? 0.020 : 0.012; // viajar al este = perder horas de sueño
      result.opsDelta -= penalty;
      result.notes.push(`Travel ${shift > 0 ? "ESTE" : "OESTE"} ${Math.abs(shift)}h — bate frío`);
    } else if (Math.abs(shift) >= 1 && daysSince <= 1) {
      result.opsDelta -= 0.008;
      result.notes.push(`Travel ${shift}h zona horaria`);
    }
  }

  // Convert OPS delta to runs delta
  // Empirical: 100 puntos OPS ≈ 1.5 runs/game para un equipo
  result.runsDelta = result.opsDelta * 15; // 15 runs por punto OPS (i.e., 0.020 → 0.30 runs)
  result.runsDelta = Math.round(result.runsDelta * 100) / 100;
  result.opsDelta = Math.round(result.opsDelta * 1000) / 1000;
  return result;
}

interface CombinedFatigueResult {
  home: FatigueResult | null;
  away: FatigueResult | null;
  homeRunsDelta: number;   // runs ofensivos del local (positivo = anota más)
  awayRunsDelta: number;   // runs ofensivos del visitante
  alerts: string[];
}

export async function getTeamFatigueCombined(
  homeTeamId: number, homeTeamName: string,
  awayTeamId: number, awayTeamName: string,
  gameDateIso: string, gameVenue: string
): Promise<CombinedFatigueResult> {
  const [home, away] = await Promise.all([
    getTeamFatigue(homeTeamId, homeTeamName, gameDateIso, gameVenue),
    getTeamFatigue(awayTeamId, awayTeamName, gameDateIso, gameVenue),
  ]);
  const alerts: string[] = [];
  if (home && Math.abs(home.runsDelta) >= 0.20) alerts.push(`Local: ${home.notes.join(", ")}`);
  if (away && Math.abs(away.runsDelta) >= 0.20) alerts.push(`Visitante: ${away.notes.join(", ")}`);
  return {
    home, away,
    homeRunsDelta: home?.runsDelta ?? 0,
    awayRunsDelta: away?.runsDelta ?? 0,
    alerts,
  };
}
