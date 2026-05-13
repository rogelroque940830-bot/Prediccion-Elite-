// ═══════════════════════════════════════════════════════════════════════════
// NBA CONTEXTUAL FACTORS
// Revenge spots, Look-ahead traps, B2B direccional, Load management patterns
// ═══════════════════════════════════════════════════════════════════════════

// Arena coordinates + timezone offsets (hours from UTC, standard time)
// Elevation in feet (Denver = altitude factor)
interface ArenaInfo {
  lat: number; lon: number; tzOffset: number; elevation: number; city: string;
}

export const NBA_ARENAS: Record<string, ArenaInfo> = {
  ATL: { lat: 33.757, lon: -84.396, tzOffset: -5, elevation: 1050, city: "Atlanta" },
  BOS: { lat: 42.366, lon: -71.062, tzOffset: -5, elevation: 19,   city: "Boston" },
  BKN: { lat: 40.683, lon: -73.975, tzOffset: -5, elevation: 35,   city: "Brooklyn" },
  CHA: { lat: 35.225, lon: -80.839, tzOffset: -5, elevation: 751,  city: "Charlotte" },
  CHI: { lat: 41.881, lon: -87.674, tzOffset: -6, elevation: 594,  city: "Chicago" },
  CLE: { lat: 41.497, lon: -81.688, tzOffset: -5, elevation: 653,  city: "Cleveland" },
  DAL: { lat: 32.790, lon: -96.810, tzOffset: -6, elevation: 430,  city: "Dallas" },
  DEN: { lat: 39.749, lon: -105.008,tzOffset: -7, elevation: 5280, city: "Denver" }, // Mile High
  DET: { lat: 42.341, lon: -83.055, tzOffset: -5, elevation: 600,  city: "Detroit" },
  GSW: { lat: 37.750, lon: -122.203,tzOffset: -8, elevation: 33,   city: "San Francisco" },
  HOU: { lat: 29.751, lon: -95.362, tzOffset: -6, elevation: 43,   city: "Houston" },
  IND: { lat: 39.764, lon: -86.155, tzOffset: -5, elevation: 715,  city: "Indianapolis" },
  LAC: { lat: 34.043, lon: -118.267,tzOffset: -8, elevation: 285,  city: "Los Angeles" },
  LAL: { lat: 34.043, lon: -118.267,tzOffset: -8, elevation: 285,  city: "Los Angeles" },
  MEM: { lat: 35.138, lon: -90.050, tzOffset: -6, elevation: 337,  city: "Memphis" },
  MIA: { lat: 25.781, lon: -80.187, tzOffset: -5, elevation: 6,    city: "Miami" },
  MIL: { lat: 43.045, lon: -87.917, tzOffset: -6, elevation: 617,  city: "Milwaukee" },
  MIN: { lat: 44.979, lon: -93.276, tzOffset: -6, elevation: 830,  city: "Minneapolis" },
  NOP: { lat: 29.949, lon: -90.082, tzOffset: -6, elevation: 7,    city: "New Orleans" },
  NYK: { lat: 40.750, lon: -73.993, tzOffset: -5, elevation: 33,   city: "New York" },
  OKC: { lat: 35.463, lon: -97.515, tzOffset: -6, elevation: 1200, city: "Oklahoma City" },
  ORL: { lat: 28.539, lon: -81.383, tzOffset: -5, elevation: 107,  city: "Orlando" },
  PHI: { lat: 39.901, lon: -75.172, tzOffset: -5, elevation: 39,   city: "Philadelphia" },
  PHX: { lat: 33.446, lon: -112.071,tzOffset: -7, elevation: 1086, city: "Phoenix" },
  POR: { lat: 45.531, lon: -122.667,tzOffset: -8, elevation: 50,   city: "Portland" },
  SAC: { lat: 38.580, lon: -121.499,tzOffset: -8, elevation: 30,   city: "Sacramento" },
  SAS: { lat: 29.427, lon: -98.437, tzOffset: -6, elevation: 650,  city: "San Antonio" },
  TOR: { lat: 43.643, lon: -79.379, tzOffset: -5, elevation: 250,  city: "Toronto" },
  UTA: { lat: 40.768, lon: -111.901,tzOffset: -7, elevation: 4226, city: "Salt Lake City" },
  WAS: { lat: 38.898, lon: -77.021, tzOffset: -5, elevation: 25,   city: "Washington" },
};

// ─── 1) REVENGE SPOT ────────────────────────────────────────────────────────
// A team is in a "revenge spot" if:
//   - Lost to this opponent within the last 14 days
//   - Lost by 15+ points (blowout) → stronger revenge
export interface RevengeSignal {
  applies: boolean;
  team: "home" | "away" | null;
  type: "blowout-revenge" | "recent-loss" | "none";
  adjustmentPp: number; // added to team's WR (not home prob directly)
  notes: string;
}

interface PastGame {
  date: string;          // MM/DD/YYYY or ISO
  homeTri: string;
  awayTri: string;
  homeScore: number;
  awayScore: number;
  gameLabel?: string;    // "Playoffs", "Play-In", "" (regular), etc
  seriesGameNumber?: string; // "1", "2", ... in a playoff series
  seriesText?: string;       // "LAL leads series 2-1", etc
}

function isPlayoffGame(g: PastGame): boolean {
  const label = (g.gameLabel || "").toLowerCase();
  return !!(
    g.seriesGameNumber ||
    label.includes("playoff") ||
    label.includes("round") ||
    label.includes("semifinal") ||
    label.includes("conf final") ||
    label.includes("finals") ||
    label.includes("play-in") ||
    label.includes("play in")
  );
}

export function detectRevengeSpot(
  homeTri: string,
  awayTri: string,
  recentGamesOfHome: PastGame[],
  recentGamesOfAway: PastGame[],
  currentIsPlayoff: boolean = false,
): RevengeSignal {
  // Look for the last game between these two teams (last 14 days)
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const allGames = [...recentGamesOfHome, ...recentGamesOfAway];

  let lastMeeting: PastGame | null = null;
  for (const g of allGames) {
    const isMatch = (g.homeTri === homeTri && g.awayTri === awayTri) ||
                    (g.homeTri === awayTri && g.awayTri === homeTri);
    if (!isMatch) continue;
    const ts = parsePastDate(g.date);
    if (ts === null) continue;
    if (now - ts > 14 * DAY) continue;

    // 🚨 CRITICAL FIX: if current game is playoffs AND the prior meeting was
    // also a playoff/play-in game, it's the SAME SERIES — not revenge. Skip.
    if (currentIsPlayoff && isPlayoffGame(g)) continue;

    if (!lastMeeting || ts > parsePastDate(lastMeeting.date)!) {
      lastMeeting = g;
    }
  }

  if (!lastMeeting) {
    return { applies: false, team: null, type: "none", adjustmentPp: 0, notes: "" };
  }

  const hS = lastMeeting.homeScore, aS = lastMeeting.awayScore;
  if (hS === 0 && aS === 0) {
    return { applies: false, team: null, type: "none", adjustmentPp: 0, notes: "" };
  }

  const margin = Math.abs(hS - aS);
  // Determine who lost
  let loserTri: string;
  if (hS > aS) loserTri = lastMeeting.awayTri;
  else loserTri = lastMeeting.homeTri;

  // Which team in THIS game is the revenge team?
  const revengeTeam: "home" | "away" | null = loserTri === homeTri ? "home" : loserTri === awayTri ? "away" : null;
  if (!revengeTeam) return { applies: false, team: null, type: "none", adjustmentPp: 0, notes: "" };

  if (margin >= 15) {
    return {
      applies: true, team: revengeTeam, type: "blowout-revenge",
      adjustmentPp: 3.0,
      notes: `Revancha tras blowout (perdió por ${margin} pts hace <14 días)`,
    };
  }
  return {
    applies: true, team: revengeTeam, type: "recent-loss",
    adjustmentPp: 1.5,
    notes: `Revancha reciente (perdió por ${margin} pts hace <14 días)`,
  };
}

// ─── 2) LOOK-AHEAD TRAP ─────────────────────────────────────────────────────
// A team is in a "look-ahead trap" if its NEXT game (within 1-2 days)
// is against a much stronger opponent (marquee matchup) — easy to overlook current game
export interface LookAheadSignal {
  applies: boolean;
  team: "home" | "away" | null;
  nextOpponent: string;
  adjustmentPp: number; // NEGATIVE — team looking past, reduces their prob
  notes: string;
}

export function detectLookAheadTrap(
  homeTri: string,
  awayTri: string,
  homeNextGames: PastGame[],
  awayNextGames: PastGame[],
  currentGameDate: string,
  teamWinRates: Record<string, number>,
  currentIsPlayoff: boolean = false,
): LookAheadSignal {
  // 🚨 PLAYOFFS: no existe trap game. El siguiente partido ES el mismo rival.
  if (currentIsPlayoff) {
    return { applies: false, team: null, nextOpponent: "", adjustmentPp: 0, notes: "" };
  }

  const checkTeam = (tri: string, nextGames: PastGame[]): LookAheadSignal | null => {
    const gameTs = parsePastDate(currentGameDate);
    if (gameTs === null) return null;

    for (const ng of nextGames) {
      const ngTs = parsePastDate(ng.date);
      if (ngTs === null || ngTs <= gameTs) continue;
      const daysUntil = (ngTs - gameTs) / (24 * 60 * 60 * 1000);
      if (daysUntil > 3 || daysUntil < 1) continue;
      const oppTri = ng.homeTri === tri ? ng.awayTri : ng.homeTri;
      const oppWR = teamWinRates[oppTri];
      if (oppWR !== undefined && oppWR >= 0.65) {
        return {
          applies: true, team: tri === homeTri ? "home" : "away",
          nextOpponent: oppTri,
          adjustmentPp: -2.0,
          notes: `Mira hacia partido vs ${oppTri} (${(oppWR*100).toFixed(0)}% WR) en ${Math.round(daysUntil)}d`,
        };
      }
    }
    return null;
  };

  const h = checkTeam(homeTri, homeNextGames);
  if (h) return h;
  const a = checkTeam(awayTri, awayNextGames);
  if (a) return a;
  return { applies: false, team: null, nextOpponent: "", adjustmentPp: 0, notes: "" };
}

// ─── 3) B2B DIRECTIONAL + ALTITUDE ──────────────────────────────────────────
// Casas aplican penalización plana B2B. Pero East → West es mucho peor que
// West → East (circadian). Altitude (Denver, Utah) añade castigo al visitante.
export interface B2BSignal {
  applies: boolean;
  team: "home" | "away" | null;
  direction: "east-to-west" | "west-to-east" | "short" | "none";
  altitudeConcern: boolean;
  adjustmentPp: number;
  notes: string;
}

export function detectB2BDirectional(
  homeTri: string,
  awayTri: string,
  awayPrevGameTri: string | null, // where the away team played last night
  awayIsB2B: boolean,
): B2BSignal {
  if (!awayIsB2B || !awayPrevGameTri) {
    // Check altitude only (no b2b)
    const homeArena = NBA_ARENAS[homeTri];
    if (homeArena && homeArena.elevation >= 4000) {
      return {
        applies: true, team: "away",
        direction: "none", altitudeConcern: true,
        adjustmentPp: -1.5,
        notes: `Altitud ${homeArena.elevation}ft (${homeArena.city}) afecta visitante`,
      };
    }
    return { applies: false, team: null, direction: "none", altitudeConcern: false, adjustmentPp: 0, notes: "" };
  }

  const prevArena = NBA_ARENAS[awayPrevGameTri];
  const homeArena = NBA_ARENAS[homeTri];
  if (!prevArena || !homeArena) {
    return { applies: true, team: "away", direction: "short", altitudeConcern: false, adjustmentPp: -1.0, notes: "B2B (dirección desconocida)" };
  }
  const tzDelta = homeArena.tzOffset - prevArena.tzOffset;
  const altitudeConcern = homeArena.elevation >= 4000;

  let direction: B2BSignal["direction"] = "short";
  let adjPp = -1.5;
  let notes = "B2B corto";

  if (tzDelta <= -2) {
    // Playing west after being east — easier circadian (going back in time)
    direction = "east-to-west";
    adjPp = -2.5;
    notes = `B2B east→west (${prevArena.city} → ${homeArena.city}, ${Math.abs(tzDelta)}h atrás)`;
  } else if (tzDelta >= 2) {
    // West → east, losing sleep, brutal
    direction = "west-to-east";
    adjPp = -3.5;
    notes = `B2B west→east brutal (${prevArena.city} → ${homeArena.city}, +${tzDelta}h)`;
  }

  if (altitudeConcern) {
    adjPp -= 1.0;
    notes += ` + altitud ${homeArena.elevation}ft`;
  }

  return { applies: true, team: "away", direction, altitudeConcern, adjustmentPp: adjPp, notes };
}

// ─── 4) LOAD MANAGEMENT PATTERNS ────────────────────────────────────────────
// Coaches conocidos por descansar estrellas en segundo partido de B2B
// o en tramos densos (4 partidos en 5 días).
export interface LoadMgmtSignal {
  applies: boolean;
  team: "home" | "away" | null;
  restLikely: boolean;
  adjustmentPp: number;
  notes: string;
}

// Coaches/teams with heavy load management history (2022-2025 data)
const LOAD_MGMT_TEAMS = new Set([
  "LAC", "GSW", "LAL", "PHX", // West contenders historically rest stars
  "MIL", "BOS", // Eastern contenders
  "DEN", // Malone rests Jokic occasionally in B2B
]);

export function detectLoadManagement(
  homeTri: string,
  awayTri: string,
  awayB2BSecondNight: boolean,
  homeGamesIn5Days: number,
  awayGamesIn5Days: number,
): LoadMgmtSignal {
  // Most common: away team 2nd night of B2B in load-mgmt-heavy franchise
  if (awayB2BSecondNight && LOAD_MGMT_TEAMS.has(awayTri)) {
    return {
      applies: true, team: "away", restLikely: true,
      adjustmentPp: -2.5,
      notes: `${awayTri} históricamente descansa estrellas en B2B 2da noche`,
    };
  }
  // 4 in 5 — force reduce
  if (awayGamesIn5Days >= 4 && LOAD_MGMT_TEAMS.has(awayTri)) {
    return {
      applies: true, team: "away", restLikely: true,
      adjustmentPp: -2.0,
      notes: `${awayTri} en tramo denso (4 en 5 días) — posible descanso`,
    };
  }
  if (homeGamesIn5Days >= 4 && LOAD_MGMT_TEAMS.has(homeTri)) {
    return {
      applies: true, team: "home", restLikely: true,
      adjustmentPp: -1.5,
      notes: `${homeTri} en tramo denso (4 en 5 días) — posible descanso`,
    };
  }
  return { applies: false, team: null, restLikely: false, adjustmentPp: 0, notes: "" };
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
// SERIES DESPERATION (playoffs only)
export interface SeriesSignal {
  applies: boolean;
  team: "home" | "away" | null;
  situation: "elimination" | "closeout" | "tied" | "lead" | "none";
  adjustmentPp: number;
  notes: string;
}

export function detectSeriesSituation(
  homeTri: string,
  awayTri: string,
  recentGamesOfHome: PastGame[],
  currentIsPlayoff: boolean,
): SeriesSignal {
  if (!currentIsPlayoff) {
    return { applies: false, team: null, situation: "none", adjustmentPp: 0, notes: "" };
  }
  let homeWins = 0, awayWins = 0;
  for (const g of recentGamesOfHome) {
    const isMatch = (g.homeTri === homeTri && g.awayTri === awayTri) ||
                    (g.homeTri === awayTri && g.awayTri === homeTri);
    if (!isMatch) continue;
    if (!isPlayoffGame(g)) continue;
    if (g.homeScore === 0 && g.awayScore === 0) continue;
    const winnerIsHome = (g.homeTri === homeTri && g.homeScore > g.awayScore) ||
                         (g.awayTri === homeTri && g.awayScore > g.homeScore);
    if (winnerIsHome) homeWins++; else awayWins++;
  }
  if (homeWins + awayWins === 0) {
    return { applies: false, team: null, situation: "none", adjustmentPp: 0, notes: "Serie por comenzar" };
  }
  if (awayWins === 3 && homeWins < 3) {
    return { applies: true, team: "home", situation: "elimination", adjustmentPp: 2.0, notes: `Local al borde de eliminacion ${homeWins}-${awayWins}` };
  }
  if (homeWins === 3 && awayWins < 3) {
    return { applies: true, team: "away", situation: "elimination", adjustmentPp: 2.0, notes: `Visitante al borde de eliminacion ${awayWins}-${homeWins}` };
  }
  if (homeWins === 3) return { applies: true, team: "home", situation: "closeout", adjustmentPp: -0.3, notes: `Local busca cerrar ${homeWins}-${awayWins}` };
  if (awayWins === 3) return { applies: true, team: "away", situation: "closeout", adjustmentPp: -0.3, notes: `Visitante busca cerrar ${awayWins}-${homeWins}` };
  if (homeWins === awayWins && homeWins >= 2) {
    return { applies: false, team: null, situation: "tied", adjustmentPp: 0, notes: `Serie ${homeWins}-${awayWins} empatada` };
  }
  return { applies: false, team: null, situation: "lead", adjustmentPp: 0, notes: `Serie ${homeWins}-${awayWins}` };
}

function parsePastDate(s: string): number | null {
  if (!s) return null;
  // "04/12/2026 00:00:00" or ISO
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) {
    return new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`).getTime();
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

// ─── COMPOSITE CONTEXT ──────────────────────────────────────────────────────
export interface NBAContextualResult {
  revenge: RevengeSignal;
  lookAhead: LookAheadSignal;
  b2b: B2BSignal;
  loadMgmt: LoadMgmtSignal;
  series: SeriesSignal;
  isPlayoff: boolean;
  homeProbAdjPp: number;
  notes: string[];
}

export function computeContextual(
  homeTri: string,
  awayTri: string,
  gameDate: string,
  options: {
    recentGamesHome: PastGame[];
    recentGamesAway: PastGame[];
    nextGamesHome: PastGame[];
    nextGamesAway: PastGame[];
    teamWinRates: Record<string, number>;
    awayB2B: boolean;
    awayPrevTri: string | null;
    homeGamesIn5Days: number;
    awayGamesIn5Days: number;
    currentIsPlayoff?: boolean;
  }
): NBAContextualResult {
  const isPlayoff = !!options.currentIsPlayoff;
  const revenge = detectRevengeSpot(homeTri, awayTri, options.recentGamesHome, options.recentGamesAway, isPlayoff);
  const lookAhead = detectLookAheadTrap(
    homeTri, awayTri, options.nextGamesHome, options.nextGamesAway, gameDate, options.teamWinRates, isPlayoff
  );
  const b2b = detectB2BDirectional(homeTri, awayTri, options.awayPrevTri, options.awayB2B);
  const loadMgmt = detectLoadManagement(
    homeTri, awayTri, options.awayB2B && !!options.awayPrevTri,
    options.homeGamesIn5Days, options.awayGamesIn5Days
  );
  const series = detectSeriesSituation(homeTri, awayTri, options.recentGamesHome, isPlayoff);

  // Convert signals to a net HOME prob adjustment
  // revenge/lookAhead: if on home team, positive; if on away, negative (home bonus for opponent looking past = home benefit; away revenge = home penalty)
  let homeAdjPp = 0;
  const notes: string[] = [];
  if (revenge.applies) {
    const sign = revenge.team === "home" ? 1 : -1;
    homeAdjPp += sign * revenge.adjustmentPp;
    notes.push(`Revancha ${revenge.team === "home" ? "LOCAL" : "VISITANTE"} (${revenge.adjustmentPp > 0 ? "+" : ""}${(sign * revenge.adjustmentPp).toFixed(1)}pp)`);
  }
  if (lookAhead.applies) {
    // lookAhead penalizes the team looking past — negative to THEM
    const sign = lookAhead.team === "home" ? 1 : -1;
    homeAdjPp += sign * lookAhead.adjustmentPp;
    notes.push(`Look-ahead ${lookAhead.team === "home" ? "LOCAL" : "VISITANTE"} vs ${lookAhead.nextOpponent} (${(sign * lookAhead.adjustmentPp).toFixed(1)}pp)`);
  }
  if (b2b.applies) {
    // B2B penalizes the away team (always) — HOME benefits
    const sign = b2b.team === "home" ? 1 : -1;
    homeAdjPp += sign * b2b.adjustmentPp;
    notes.push(`${b2b.notes} (${(sign * b2b.adjustmentPp).toFixed(1)}pp home)`);
  }
  if (loadMgmt.applies) {
    const sign = loadMgmt.team === "home" ? 1 : -1;
    homeAdjPp += sign * loadMgmt.adjustmentPp;
    notes.push(`${loadMgmt.notes} (${(sign * loadMgmt.adjustmentPp).toFixed(1)}pp)`);
  }
  if (series.applies) {
    const sign = series.team === "home" ? 1 : -1;
    homeAdjPp += sign * series.adjustmentPp;
    notes.push(`${series.notes} (${(sign * series.adjustmentPp).toFixed(1)}pp)`);
  }

  return { revenge, lookAhead, b2b, loadMgmt, series, isPlayoff, homeProbAdjPp: Math.round(homeAdjPp * 10) / 10, notes };
}
