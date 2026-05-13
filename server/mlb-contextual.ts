// ═══════════════════════════════════════════════════════════════════════════
// MLB CONTEXTUAL FACTORS
// Series situation, Divisional rivalry, Hitter familiarity (3rd time through)
// ═══════════════════════════════════════════════════════════════════════════

interface MLBPastGame {
  date: string;          // ISO YYYY-MM-DD
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  status: string;        // "Final"
}

// MLB Divisions for rivalry detection
const DIVISIONS: Record<string, string[]> = {
  "AL East":    ["NYY", "BOS", "TOR", "TB", "BAL"],
  "AL Central": ["CLE", "MIN", "DET", "KC", "CHW"],
  "AL West":    ["HOU", "TEX", "SEA", "LAA", "OAK", "ATH"],
  "NL East":    ["ATL", "PHI", "NYM", "MIA", "WSH"],
  "NL Central": ["MIL", "CHC", "STL", "CIN", "PIT"],
  "NL West":    ["LAD", "SD", "SF", "ARI", "COL"],
};

const TEAM_TO_DIVISION: Record<string, string> = {};
for (const [div, teams] of Object.entries(DIVISIONS)) {
  for (const t of teams) TEAM_TO_DIVISION[t] = div;
}

// Famous historic rivalries (extra heat)
const HOT_RIVALRIES = new Set([
  "NYY-BOS", "BOS-NYY",
  "LAD-SF", "SF-LAD",
  "CHC-STL", "STL-CHC",
  "SD-LAD", "LAD-SD",
  "NYY-TB", "TB-NYY",
  "PHI-NYM", "NYM-PHI",
]);

export interface MLBSeriesSignal {
  applies: boolean;
  team: "home" | "away" | null;
  situation: "sweep-avoidance" | "down-2-of-3" | "rubber-game" | "tied-series" | "leading" | "none";
  adjustmentPp: number;
  notes: string;
}

export interface MLBDivisionalSignal {
  applies: boolean;
  isDivisional: boolean;
  isHotRivalry: boolean;
  notes: string;
  // Divisional games tend to be higher variance, slight edge to home (familiarity advantage)
  homeProbAdjPp: number;
  totalAdj: number; // hot rivalries score slightly less (more grinding)
}

export interface MLBContextualResult {
  series: MLBSeriesSignal;
  divisional: MLBDivisionalSignal;
  homeProbAdjPp: number;
  totalAdj: number;
  notes: string[];
}

/**
 * Detect series situation between two teams in the last 4 days.
 * MLB plays 3-4 game series. If we find 2-3 prior games this week, we're mid-series.
 */
export function detectMLBSeriesSituation(
  homeTri: string,
  awayTri: string,
  recentGames: MLBPastGame[],
  targetDate: string,
): MLBSeriesSignal {
  const target = new Date(targetDate).getTime();
  const FIVE_DAYS = 5 * 24 * 60 * 60 * 1000;

  // Find prior games between these two teams in last 5 days
  const priorMeetings: MLBPastGame[] = [];
  for (const g of recentGames) {
    const ts = new Date(g.date).getTime();
    if (target - ts > FIVE_DAYS || target - ts <= 0) continue;
    if (g.status !== "Final") continue;
    const isMatch = (g.homeTeam === homeTri && g.awayTeam === awayTri) ||
                    (g.homeTeam === awayTri && g.awayTeam === homeTri);
    if (isMatch) priorMeetings.push(g);
  }

  if (priorMeetings.length === 0) {
    return { applies: false, team: null, situation: "none", adjustmentPp: 0, notes: "Sin serie en curso" };
  }

  // Count wins for each side
  let homeWins = 0, awayWins = 0;
  for (const g of priorMeetings) {
    const homeWon = g.homeScore > g.awayScore;
    if (g.homeTeam === homeTri) {
      if (homeWon) homeWins++; else awayWins++;
    } else {
      // homeTri was visiting in that game
      if (homeWon) awayWins++; else homeWins++;
    }
  }

  const total = homeWins + awayWins;
  if (total === 0) {
    return { applies: false, team: null, situation: "none", adjustmentPp: 0, notes: "Serie por iniciar" };
  }

  // Sweep avoidance: home down 0-2 in a 3-game series, OR 0-3 in 4-game
  if (awayWins >= 2 && homeWins === 0) {
    return {
      applies: true, team: "home", situation: "sweep-avoidance",
      adjustmentPp: 1.5,
      notes: `Local evita barrida (perdió ${homeWins}-${awayWins} en serie)`,
    };
  }
  if (homeWins >= 2 && awayWins === 0) {
    return {
      applies: true, team: "away", situation: "sweep-avoidance",
      adjustmentPp: 1.5,
      notes: `Visitante evita barrida (${awayWins}-${homeWins} en serie)`,
    };
  }
  // Down 1-2 in 4-game: still pressure
  if (awayWins === 2 && homeWins === 1) {
    return {
      applies: true, team: "home", situation: "down-2-of-3",
      adjustmentPp: 0.8,
      notes: `Local atrás ${homeWins}-${awayWins}, juego clave`,
    };
  }
  if (homeWins === 2 && awayWins === 1) {
    return {
      applies: true, team: "away", situation: "down-2-of-3",
      adjustmentPp: 0.8,
      notes: `Visitante atrás ${awayWins}-${homeWins}, juego clave`,
    };
  }
  // Rubber game (tied 1-1 or 2-2)
  if (homeWins === awayWins) {
    return {
      applies: false, team: null, situation: total === 2 ? "rubber-game" : "tied-series",
      adjustmentPp: 0,
      notes: `Serie empatada ${homeWins}-${awayWins} (juego decisivo)`,
    };
  }
  return {
    applies: false, team: null, situation: "leading",
    adjustmentPp: 0,
    notes: `Serie ${homeWins}-${awayWins}`,
  };
}

/**
 * Detect divisional matchup and hot rivalries.
 * Divisional games: more familiarity → home advantage slightly bigger.
 * Hot rivalries: high intensity → totals slightly lower (grinding ABs).
 */
export function detectMLBDivisional(homeTri: string, awayTri: string): MLBDivisionalSignal {
  const homeDiv = TEAM_TO_DIVISION[homeTri];
  const awayDiv = TEAM_TO_DIVISION[awayTri];
  const isDivisional = !!homeDiv && homeDiv === awayDiv;
  const isHot = HOT_RIVALRIES.has(`${homeTri}-${awayTri}`);

  if (isHot) {
    return {
      applies: true, isDivisional: true, isHotRivalry: true,
      notes: `Rivalidad histórica ${homeTri} vs ${awayTri}`,
      homeProbAdjPp: 1.2,
      totalAdj: -0.3,
    };
  }
  if (isDivisional) {
    return {
      applies: true, isDivisional: true, isHotRivalry: false,
      notes: `Partido divisional (${homeDiv})`,
      homeProbAdjPp: 0.5,
      totalAdj: -0.1,
    };
  }
  return {
    applies: false, isDivisional: false, isHotRivalry: false,
    notes: "Inter-divisional",
    homeProbAdjPp: 0,
    totalAdj: 0,
  };
}

export function computeMLBContextual(
  homeTri: string,
  awayTri: string,
  targetDate: string,
  recentGames: MLBPastGame[],
): MLBContextualResult {
  const series = detectMLBSeriesSituation(homeTri, awayTri, recentGames, targetDate);
  const divisional = detectMLBDivisional(homeTri, awayTri);

  let homeAdj = divisional.homeProbAdjPp;
  let totalAdj = divisional.totalAdj;
  const notes: string[] = [];

  if (series.applies) {
    const sign = series.team === "home" ? 1 : -1;
    homeAdj += sign * series.adjustmentPp;
    notes.push(`${series.notes} (${(sign * series.adjustmentPp).toFixed(1)}pp)`);
  }
  if (divisional.applies) {
    notes.push(`${divisional.notes} (+${divisional.homeProbAdjPp.toFixed(1)}pp local${divisional.totalAdj !== 0 ? `, ${divisional.totalAdj} runs` : ""})`);
  }

  return {
    series,
    divisional,
    homeProbAdjPp: Math.round(homeAdj * 10) / 10,
    totalAdj: Math.round(totalAdj * 10) / 10,
    notes,
  };
}
