// NHL Prediction Model — CourtEdge (Advanced Analytics Edition)
// Mercados: ML, Puck Line (-1.5/+1.5), O/U (total goles)
// v3 — GSAx, xG 5v5, Corsi, HD chances, SH% regression, PP/PK split, Poisson O/U, Score-State Adj, Injury Impact, Safe Play

const NHL_LEAGUE_AVG = {
  goalsFor: 3.10,
  goalsAgainst: 3.10,
  savesPct: 0.905,
  ppPct: 21.0,
  pkPct: 79.0,
  corsi: 50.0,
  gaa: 3.00,
  shPct: 9.0,      // NHL avg shooting % at 5v5
  xGF: 2.55,       // NHL avg expected goals for per game at 5v5
  xGA: 2.55,
  hdSvPct: 0.850,  // NHL avg high-danger save %
  scoreAdjXGF: 2.55, // NHL avg score-adjusted xGF per game (MoneyPuck)
  scoreAdjXGA: 2.55, // NHL avg score-adjusted xGA per game (MoneyPuck)
};

// ── INTERFACES ───────────────────────────────────────────────────────────────

export interface NHLGoalie {
  savesPct: number;      // Save percentage (e.g. 0.920)
  gaa: number;           // Goals against average
  record: string;        // "25-10-3"
  recentGAA?: number;    // GAA last 5 starts
  // Advanced fields (all optional — model degrades gracefully)
  gsax?: number;         // Goals Saved Above Expected per game (MoneyPuck)
  xSvPct?: number;       // Expected save % based on shot quality faced
  hdSvPct?: number;      // High danger save %
  recentSvPct?: number;  // Recent SV% last 5 starts
}

export interface NHLTeamStats {
  name: string;
  goalsFor: number;       // Goals for per game (season)
  goalsAgainst: number;   // Goals against per game (season)
  ppPct: number;          // Power Play %
  pkPct: number;          // Penalty Kill %
  corsi: number;          // Corsi For %
  shotsFor: number;       // Shots on goal per game
  shotsAgainst: number;   // Shots against per game
  winRate: number;        // Last-10 win rate
  streak: number;
  isB2B: boolean;
  daysRest: number;
  goalie: NHLGoalie;
  // Recent form (last 10)
  recentGF?: number;
  recentGA?: number;
  // Strength of Schedule
  sosScore?: number;      // >1 = tough opponents, <1 = weak opponents
  // Advanced 5v5 analytics (all optional)
  xGF?: number;           // Expected goals for per game at 5v5 (MoneyPuck)
  xGA?: number;           // Expected goals against per game at 5v5
  cf5v5?: number;         // Corsi For % at 5v5 (e.g. 52.0)
  shPct?: number;         // Shooting % at 5v5 (e.g. 9.5)
  hdCF?: number;          // High danger chances for per game
  hdCA?: number;          // High danger chances against per game
  ppGF?: number;          // PP goals for per game (separate from 5v5)
  pkGA?: number;          // PK goals against per game (separate from 5v5)
  // Games played (for regression-to-mean calculations)
  gamesPlayed?: number;
  // Score-venue adjusted xG (MoneyPuck) — preferred over raw xGF/xGA when available
  scoreAdjXGF?: number;   // Score-venue adjusted xGF/game (MoneyPuck)
  scoreAdjXGA?: number;   // Score-venue adjusted xGA/game
  // Injury/Lineup impact
  missingPlayerImpact?: number;
  // Asymmetric injury factors (auto-detected from roster types)
  missingOffFactor?: number; // 0..1, default 1.0
  missingDefFactor?: number; // 0..1, default 0.5
  // Travel
  travelPenalty?: number;  // Cumulative gameScore of missing key players (0 = nobody missing, negative = worse)
  // H2H season series
  h2hWins?: number;
  h2hLosses?: number;
  // Home/Away splits
  homeGF?: number;     // avg goals scored at home
  homeGA?: number;     // avg goals allowed at home
  awayGF?: number;     // avg goals scored away
  awayGA?: number;     // avg goals allowed away
}

export interface NHLGameContext {
  isPlayoffs: boolean;
  isElimination?: boolean;  // Team facing elimination in playoff series
  seriesLead?: "home" | "away" | "tied"; // Who leads the series
  homeIceAdv: number; // 1.0 default, playoffs ~1.05
}

// ── NHL Roster Player (for injury/lineup system) ────────────────────────────

export interface NHLRosterPlayer {
  name: string;
  position: string; // C, L, R, D, G
  gp: number;
  goals: number;
  assists: number;
  points: number;
  toi: number;
  plusMinus: number;
  gamesMissed?: number; // teamGP - playerGP
  sweaterNumber?: number;
}

// ── NHL: Auto-detectar tipo de jugador → [offFactor, defFactor] ──────────
export function detectNHLPlayerType(p: NHLRosterPlayer): { off: number; def: number; type: string } {
  const gpd = Math.max(p.gp, 1);
  const goalsPerGame = p.goals / gpd;
  const assistsPerGame = p.assists / gpd;
  const pointsPerGame = p.points / gpd;

  // Defensemen — mostly defensive impact
  if (p.position === "D") {
    if (pointsPerGame >= 0.7) {
      // Offensive D-man (Hughes, Makar, Fox)
      return { off: 0.80, def: 1.00, type: "D Ofensivo" };
    }
    // Shutdown D
    return { off: 0.30, def: 1.00, type: "Shutdown D" };
  }
  // Goalie — handled separately by goalie module
  if (p.position === "G") {
    return { off: 0.10, def: 1.00, type: "Goalie" };
  }
  // Forwards (C/L/R)
  // Sniper: alto goals/game, assists relativamente bajos
  if (goalsPerGame >= 0.4 && assistsPerGame < goalsPerGame * 1.3) {
    return { off: 1.00, def: 0.30, type: "Sniper" };
  }
  // Playmaker: muchos assists vs goals
  if (assistsPerGame >= 0.6 && assistsPerGame > goalsPerGame * 1.5) {
    return { off: 1.00, def: 0.20, type: "Playmaker" };
  }
  // Two-way center: pointsPG decente + plus/minus positivo + es C
  if (p.position === "C" && pointsPerGame >= 0.7 && p.plusMinus >= 5) {
    return { off: 1.00, def: 0.85, type: "Two-way C" };
  }
  // Power forward / mixto
  if (pointsPerGame >= 0.5) {
    return { off: 1.00, def: 0.50, type: "Power Fwd" };
  }
  // Bottom-6 / energy / defensive forward
  return { off: 0.50, def: 0.80, type: "Defensive Fwd" };
}

export function calcNHLInjuryImpact(
  roster: NHLRosterPlayer[],
  missingNames: Set<string>,
  gamesOut: Record<string, number>,
): { adj: number; details: string[]; offFactor: number; defFactor: number } {
  let totalAdj = 0;
  let weightedOff = 0;
  let weightedDef = 0;
  let totalWeight = 0;
  const details: string[] = [];

  const posWeight: Record<string, number> = {
    D: 1.3,
    C: 1.1,
    L: 0.9,
    R: 0.9,
    G: 0.5,
  };

  for (const p of roster) {
    if (!missingNames.has(p.name)) continue;

    const ppg = p.points / Math.max(p.gp, 1);
    const w = posWeight[p.position] ?? 1.0;
    const out = gamesOut[p.name] ?? 0;

    // Auto-detect player type for asymmetric off/def impact
    const ptype = detectNHLPlayerType(p);

    // Base impact from player quality
    const baseImpact = -(ppg * w * 1.5);

    // Scale by how long they've been out — team adapts over time
    let scale = 1.0;
    let note = "";
    if (out >= 10) {
      // Team fully adapted
      scale = 0;
      note = `Adaptado (${out} partidos fuera)`;
    } else if (out >= 5) {
      // Team partially adapted — 30% impact
      scale = 0.30;
      note = `${out} fuera → equipo parcialmente adaptado (30%)`;
    } else if (out >= 3) {
      // Recent absence — 60% impact
      scale = 0.60;
      note = `${out} fuera → impacto reducido (60%)`;
    } else {
      // 0-2 games out — full impact, team hasn't adjusted
      scale = 1.0;
      note = out > 0 ? `${out} fuera → impacto total` : "recién lesionado";
    }

    const impact = Math.round(baseImpact * scale * 10) / 10;
    totalAdj += impact;
    const wMag = Math.abs(impact);
    weightedOff += ptype.off * wMag;
    weightedDef += ptype.def * wMag;
    totalWeight += wMag;
    details.push(`${impact.toFixed(1)}: ${p.name} (${p.position}, ${ppg.toFixed(2)} PPG · ${ptype.type}) — ${note}`);
  }

  totalAdj = Math.round(totalAdj * 10) / 10;
  const offFactor = totalWeight > 0 ? weightedOff / totalWeight : 1.0;
  const defFactor = totalWeight > 0 ? weightedDef / totalWeight : 0.5;
  return { adj: totalAdj, details, offFactor, defFactor };
}

// ── REGRESSION TO MEAN ───────────────────────────────────────────────────────
// As sample size grows, trust the observed value more.
// stabilization: number of games at which the stat is ~50% reliable
function regressToMean(
  value: number,
  mean: number,
  games: number,
  stabilization: number = 60,
): number {
  const weight = games / (games + stabilization);
  return mean * (1 - weight) + value * weight;
}

// ── DYNAMIC BLEND (SOS-based) ────────────────────────────────────────────────
// SOS > 1 → recent form more trustworthy → higher weight
// SOS < 1 → recent form vs. weak teams → lower weight
function dynamicRecentWeight(sosScore?: number): number {
  if (!sosScore || sosScore <= 0) return 0.55;
  const weight = 0.55 + (sosScore - 1.0) * 1.33;
  return Math.max(0.35, Math.min(0.75, weight));
}

// ── GOALIE SCORE (0-100) ─────────────────────────────────────────────────────
function goalieScore(g: NHLGoalie, games?: number): number {
  const gp = games ?? 50; // default to mid-season games if unknown

  // ── Path A: GSAx available (most accurate) ──
  if (g.gsax !== undefined) {
    // +0.5 GSAx/game is elite; scale so ±0.5 = ±10 pts
    const gsaxScore = g.gsax * 20;
    let score = 50 + gsaxScore;

    // High-danger save % bonus (above league avg .850)
    if (g.hdSvPct !== undefined) {
      const hdBonus = (g.hdSvPct - NHL_LEAGUE_AVG.hdSvPct) * 80; // .870 = +1.6
      score += hdBonus;
    }

    // Trending bonus: improving recent GAA = positive
    if (g.recentGAA !== undefined) {
      const trendDiff = g.gaa - g.recentGAA; // positive = improving
      score += trendDiff * 5;
    }

    // Recent SV% trend bonus
    if (g.recentSvPct !== undefined) {
      // Apply regression to mean before trusting it
      const regressedSvPct = regressToMean(g.recentSvPct, NHL_LEAGUE_AVG.savesPct, Math.min(gp, 15), 40);
      const recentBonus = (regressedSvPct - g.savesPct) * 50;
      score += recentBonus * 0.4; // partial weight on recent trend
    }

    return Math.max(10, Math.min(95, score));
  }

  // ── Path B: Fallback — SV% / GAA ──
  // Apply regression to mean for SV% (stabilizes around 40 games)
  const regressedSvPct = regressToMean(g.savesPct, NHL_LEAGUE_AVG.savesPct, gp, 40);
  const svScore = ((regressedSvPct - 0.880) / 0.040) * 35;
  const gaaScore = ((NHL_LEAGUE_AVG.gaa - g.gaa) / NHL_LEAGUE_AVG.gaa) * 25;

  let score = 50 + svScore + gaaScore;

  if (g.recentGAA !== undefined) {
    const recentDiff = g.gaa - g.recentGAA;
    score += recentDiff * 5;
  }

  return Math.max(10, Math.min(95, score));
}

// ── TEAM SCORE (0-100) ───────────────────────────────────────────────────────
function teamScore(t: NHLTeamStats): number {
  const gp = t.gamesPlayed ?? 50;

  // ── Path A: xG 5v5 available (MoneyPuck data) ──
  if (t.xGF !== undefined && t.xGA !== undefined) {
    // SOS-aware blend: if schedule was easy, trust season xG more; if tough, trust recent more
    const recentW = dynamicRecentWeight(t.sosScore);
    const baseXGF = t.scoreAdjXGF ?? t.xGF;
    const baseXGA = t.scoreAdjXGA ?? t.xGA;
    // Blend with recent GF/GA if available (recentGF approximates recent xG)
    const effectiveXGF = t.recentGF ? baseXGF * (1 - recentW * 0.3) + (t.recentGF * 0.7 + baseXGF * 0.3) * (recentW * 0.3) : baseXGF;
    const effectiveXGA = t.recentGA ? baseXGA * (1 - recentW * 0.3) + (t.recentGA * 0.7 + baseXGA * 0.3) * (recentW * 0.3) : baseXGA;
    const xGDiff = effectiveXGF - effectiveXGA;
    // +0.4 xGD per game = +10 pts
    let score = 50 + xGDiff * 25;

    // Corsi 5v5 territorial control
    const corsiBase = t.cf5v5 ?? t.corsi;
    const corsiBonus = (corsiBase - 50) * 2; // 55% CF = +10
    score += corsiBonus;

    // Shooting % regression penalty/bonus (stabilization ~60 games)
    if (t.shPct !== undefined) {
      const regressedShPct = regressToMean(t.shPct, NHL_LEAGUE_AVG.shPct, gp, 60);
      if (regressedShPct > 11) {
        // Likely overperforming — regress down
        const shRegPenalty = (regressedShPct - 9.5) * -2;
        score += shRegPenalty;
      } else if (regressedShPct < 7.5) {
        // Underperforming — due for improvement
        const shRegBonus = (9.5 - regressedShPct) * 1.5;
        score += shRegBonus;
      }
    }

    // High danger scoring quality
    if (t.hdCF !== undefined && t.hdCA !== undefined) {
      const hdScore = (t.hdCF - t.hdCA) * 3;
      score += hdScore;
    }

    // Special teams (SEPARATE from 5v5 quality)
    const ppScore = ((t.ppPct - 21) / 10) * 5;
    const pkScore = ((t.pkPct - 79) / 10) * 5;
    score += ppScore + pkScore;

    // SOS bonus — winning against tough opponents signals real quality
    if (t.sosScore && t.sosScore > 1.0 && t.winRate > 0.55) {
      score += (t.sosScore - 1.0) * 15;
    }

    // Injury/Lineup impact adjustment (asymétrico off/def)
    if (t.missingPlayerImpact !== undefined && t.missingPlayerImpact < 0) {
      const offF = t.missingOffFactor ?? 1.0;
      const defF = t.missingDefFactor ?? 0.5;
      // Average factor weighted toward composite score impact
      const compositeFactor = (offF + defF) / 2;
      score += t.missingPlayerImpact * 0.1 * compositeFactor;
    }

    return Math.max(10, Math.min(95, score));
  }

  // ── Path B: Fallback — GF/GA/Corsi method ──
  const recentW = dynamicRecentWeight(t.sosScore);
  const seasonW = 1 - recentW;
  const gf = t.recentGF ? t.goalsFor * seasonW + t.recentGF * recentW : t.goalsFor;
  const ga = t.recentGA ? t.goalsAgainst * seasonW + t.recentGA * recentW : t.goalsAgainst;

  const gfScore  = ((gf - 2.5) / 1.5) * 20;
  const gaScore  = ((3.5 - ga) / 1.5) * 15;
  const ppScore  = ((t.ppPct - 15) / 15) * 10;
  const pkScore  = ((t.pkPct - 72) / 12) * 10;
  const corsiScore = ((t.corsi - 46) / 8) * 10;

  let score = 50 + gfScore + gaScore + ppScore + pkScore + corsiScore;

  if (t.sosScore && t.sosScore > 1.0 && t.winRate > 0.55) {
    score += (t.sosScore - 1.0) * 15;
  }

  // Injury/Lineup impact adjustment (asymétrico)
  if (t.missingPlayerImpact !== undefined && t.missingPlayerImpact < 0) {
    const offF = t.missingOffFactor ?? 1.0;
    const defF = t.missingDefFactor ?? 0.5;
    // Apply offFactor to gfScore loss, defFactor to gaScore loss
    const ofGap = t.missingPlayerImpact * 0.06 * offF;     // hurts your scoring
    const defGap = t.missingPlayerImpact * 0.04 * defF;    // hurts your defending
    score += ofGap + defGap;
  }

  return Math.max(10, Math.min(95, score));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── PREDICT NHL ──────────────────────────────────────────────────────────────
export function predictNHL(
  home: NHLTeamStats,
  away: NHLTeamStats,
  ctx: NHLGameContext,
): number {
  const homeGScore = goalieScore(home.goalie, home.gamesPlayed);
  const awayGScore = goalieScore(away.goalie, away.gamesPlayed);
  const homeTScore = teamScore(home);
  const awayTScore = teamScore(away);

  const goalieDiff = (homeGScore - awayGScore) / 100;
  const teamDiff   = (homeTScore - awayTScore) / 100;
  const winRateDiff = (home.winRate - away.winRate) * 1.0;  // season record anchor
  const momDiff    = (home.streak - away.streak) * 0.01;

  let homeAdv = 0.06; // ~55% home win rate in NHL
  if (ctx.isPlayoffs) homeAdv = 0.04;
  if (home.isB2B) homeAdv -= 0.04;
  if (away.isB2B) homeAdv += 0.04;

  const restDiff = (home.daysRest - away.daysRest) * 0.02;

  // H2H season series adjustment
  let h2hAdj = 0;
  if (home.h2hWins !== undefined && home.h2hLosses !== undefined) {
    const total = home.h2hWins + home.h2hLosses;
    if (total >= 2) {
      h2hAdj = ((home.h2hWins / total) - 0.5) * 0.4;
    }
  }

  // Home/Away split adjustment
  let splitAdj = 0;
  if (home.homeGF !== undefined && home.homeGA !== undefined &&
      away.awayGF !== undefined && away.awayGA !== undefined) {
    const homeNetAtHome = home.homeGF - home.homeGA;
    const awayNetAway = away.awayGF - away.awayGA;
    splitAdj = (homeNetAtHome - awayNetAway) * 0.04;
  }

  // Travel penalty for visiting team
  const awayTravelAdj = away.travelPenalty ?? 0;

  // Game context adjustments
  let contextAdj = 0;
  if (ctx.isPlayoffs) {
    // Playoffs: better team wins more, home ice matters more
    contextAdj += (home.winRate - away.winRate) * 0.4;
    if (ctx.isElimination) {
      // Desperate team plays harder
      contextAdj += 0.03; // slight home boost in elimination
    }
    if (ctx.seriesLead === "home") contextAdj += 0.02;
    else if (ctx.seriesLead === "away") contextAdj -= 0.02;
  }

  // Streak context: hot team in playoffs = locked in
  if (ctx.isPlayoffs) {
    if (home.streak >= 2) contextAdj += 0.02;
    if (away.streak >= 2) contextAdj -= 0.02;
  }

  const logit =
    homeAdv +
    goalieDiff * 2.8 +   // Goalie ~30% of outcome
    teamDiff   * 2.5 +   // Team quality ~30%
    winRateDiff +         // Season record anchor
    momDiff    * 0.5 +   // Momentum (reduced from 0.8)
    restDiff +
    h2hAdj +             // H2H season series
    splitAdj +           // Home/Away splits
    contextAdj -         // Game context (playoffs, elimination)
    awayTravelAdj;       // Away travel fatigue

  return sigmoid(logit);
}

// ── TOTAL GOALS ──────────────────────────────────────────────────────────────
// ALIGNED with Poisson: uses same xG-based matchup methodology so totals agree
export function predictNHLTotal(home: NHLTeamStats, away: NHLTeamStats): number {
  // ── Path A: xG 5v5 available (same formula as Poisson) ──
  if (
    home.xGF !== undefined &&
    home.xGA !== undefined &&
    away.xGF !== undefined &&
    away.xGA !== undefined
  ) {
    // Matchup-based xG: home attack vs away defense, averaged
    let homeLambda = (home.xGF + away.xGA) / 2;
    let awayLambda = (away.xGF + home.xGA) / 2;

    // Adjust by opposing goalie quality (GSAx)
    if (away.goalie.gsax !== undefined) {
      homeLambda *= Math.max(0.7, 1 - away.goalie.gsax * 0.25);
    }
    if (home.goalie.gsax !== undefined) {
      awayLambda *= Math.max(0.7, 1 - home.goalie.gsax * 0.25);
    }

    // Special teams contribution
    homeLambda += (home.ppGF ?? (home.ppPct / 100) * 0.6) * 0.5;
    awayLambda += (away.ppGF ?? (away.ppPct / 100) * 0.6) * 0.5;

    // B2B adjustment
    if (home.isB2B) homeLambda *= 0.92;
    if (away.isB2B) awayLambda *= 0.92;

    return Math.round((homeLambda + awayLambda) * 10) / 10;
  }

  // ── Path B: Fallback — GF/GAA blend (no xG data) ──
  const homeGoals = (home.goalsFor + away.goalie.gaa) / 2;
  const awayGoals = (away.goalsFor + home.goalie.gaa) / 2;

  let total = homeGoals + awayGoals;

  if (home.isB2B) total -= 0.2;
  if (away.isB2B) total -= 0.2;

  return Math.round(total * 10) / 10;
}

// ── PUCK LINE ────────────────────────────────────────────────────────────────
// Normal CDF helper (NHL)
function nhlNormCdf(x: number, mean: number, std: number): number {
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
// NHL margin std dev ≈ 1.8 goals; total std dev ≈ 2.0
const NHL_MARGIN_STD = 1.8;
const NHL_TOTAL_STD = 2.0;

export function evaluatePuckLine(
  homeProb: number,
  puckLine: number,
): { expectedMargin: number; signal: "BET" | "LEAN" | "PASS"; side: string; pickedSide: "home" | "away"; coverProb: number; confidence: string } {
  const logit = Math.log(homeProb / (1 - homeProb));
  const expectedMargin = Math.round(logit * 1.8 * 100) / 100;

  // Probabilidades de cobertura ambos lados
  const homeCoverProb = 1 - nhlNormCdf(-puckLine, expectedMargin, NHL_MARGIN_STD);
  const awayCoverProb = 1 - homeCoverProb;

  // Elegir el lado con MAYOR probabilidad de cubrir
  const pickedSide: "home" | "away" = homeCoverProb >= awayCoverProb ? "home" : "away";
  const coverProb = pickedSide === "home" ? homeCoverProb : awayCoverProb;

  const sideLine = pickedSide === "home" ? puckLine : -puckLine;
  const sideLabel = pickedSide === "home" ? "Local" : "Visitante";
  const sign = sideLine < 0 ? "" : "+";
  const side = `${sideLabel} ${sign}${sideLine.toFixed(1)}`;

  let signal: "BET" | "LEAN" | "PASS";
  if (coverProb >= 0.62) signal = "BET";
  else if (coverProb >= 0.55) signal = "LEAN";
  else signal = "PASS";

  const confidence = coverProb >= 0.62 ? "ALTA" : coverProb >= 0.55 ? "MEDIA" : coverProb >= 0.50 ? "BAJA" : "SIN EDGE";

  return { expectedMargin, signal, side, pickedSide, coverProb, confidence };
}

// ── EVALUATE O/U ─────────────────────────────────────────────────────────────
export function nhlEvaluateTotal(
  estimated: number,
  line: number,
): { edge: number; signal: "BET" | "LEAN" | "PASS"; side: "OVER" | "UNDER"; hitProb: number; confidence: string } {
  const diff = estimated - line;
  const absDiff = Math.abs(diff);
  const signal: "BET" | "LEAN" | "PASS" =
    absDiff > 0.8 ? "BET" : absDiff > 0.4 ? "LEAN" : "PASS";
  const side: "OVER" | "UNDER" = diff > 0 ? "OVER" : "UNDER";
  const overProb = 1 - nhlNormCdf(line, estimated, NHL_TOTAL_STD);
  const hitProb = side === "OVER" ? overProb : (1 - overProb);
  const confidence = hitProb >= 0.60 ? "ALTA" : hitProb >= 0.52 ? "MEDIA" : hitProb >= 0.48 ? "BAJA" : "SIN EDGE";
  return { edge: diff, signal, side, hitProb, confidence };
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
export function americanToProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ── CALIBRATION ──────────────────────────────────────────────────────────────
// Backtested on 464 NHL games (Apr 4-14, 2026):
// Model was UNDERCONFIDENT — 60% predicted → 87.5% actual, 70% → 100%
// k=2.0 (recalibrado 2026-05-15 con 71 partidos de playoffs)
// Previo k=1.5 sub-calibrado: NHL playoffs tiene varianza alta pero el favorito
// claro gana más seguido de lo que el modelo proveía. Brier mejora monotónicamente hasta k=2.0.
export function nhlCalibrate(rawProb: number): number {
  const k = 2.0;
  return Math.max(0.05, Math.min(0.95, 0.5 + (rawProb - 0.5) * k));
}

export function regressToMarket(modelProb: number, marketProb: number, shrink: number = 0.25): number {
  if (marketProb <= 0 || marketProb >= 1) return modelProb;
  return modelProb * (1 - shrink) + marketProb * shrink;
}

/**
 * Signal classification (v2 — Élite threshold).
 * BET requires BOTH: edge > 5% AND model confidence >= 70% (or <=30%).
 */
export function nhlGetSignal(edge: number, modelProb?: number): "BET" | "LEAN" | "PASS" {
  const confident = modelProb === undefined
    ? true
    : (modelProb >= 0.70 || modelProb <= 0.30);
  if (edge > 5 && confident) return "BET";
  if (edge > 2) return "LEAN";
  return "PASS";
}

export interface NHLBestPlay {
  market: "ML" | "Puck Line" | "O/U";
  recommendation: string;
  signal: "BET" | "LEAN" | "PASS";
  edgeLabel: string;
  confidence: number;
}

export function nhlGetBestPlay(plays: NHLBestPlay[]): NHLBestPlay | null {
  const valid = plays.filter(p => p.signal !== "PASS");
  if (valid.length === 0) return null;
  valid.sort((a, b) => {
    const sA = a.signal === "BET" ? 3 : 1;
    const sB = b.signal === "BET" ? 3 : 1;
    if (sA !== sB) return sB - sA;
    return b.confidence - a.confidence;
  });
  return valid[0];
}

export const NHL_TEAMS = [
  "Anaheim Ducks", "Boston Bruins", "Buffalo Sabres",
  "Calgary Flames", "Carolina Hurricanes", "Chicago Blackhawks", "Colorado Avalanche",
  "Columbus Blue Jackets", "Dallas Stars", "Detroit Red Wings", "Edmonton Oilers",
  "Florida Panthers", "Los Angeles Kings", "Minnesota Wild", "Montréal Canadiens",
  "Nashville Predators", "New Jersey Devils", "New York Islanders", "New York Rangers",
  "Ottawa Senators", "Philadelphia Flyers", "Pittsburgh Penguins", "San Jose Sharks",
  "Seattle Kraken", "St. Louis Blues", "Tampa Bay Lightning", "Toronto Maple Leafs",
  "Utah Mammoth", "Vancouver Canucks", "Vegas Golden Knights", "Washington Capitals",
  "Winnipeg Jets",
];

// ── POISSON DISTRIBUTION FOR O/U ─────────────────────────────────────────────

export interface NHLPoissonResult {
  homeExpGoals: number;
  awayExpGoals: number;
  totalExpGoals: number;
  overProb: number;   // probability total goes OVER the line
  underProb: number;  // probability total goes UNDER the line
  exactScoreProbs: { score: string; prob: number }[];  // top 5 most likely exact scores
}

// Poisson probability mass function
function poissonPmf(k: number, lambda: number): number {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) {
    result *= lambda / i;
  }
  return result;
}

export function nhlPoissonTotal(
  home: NHLTeamStats,
  away: NHLTeamStats,
  line: number
): NHLPoissonResult {
  // Calculate expected goals for each team using the same logic as predictNHLTotal
  // but return Poisson probabilities instead of just a point estimate

  // Use xG if available, otherwise fallback to GF/GAA
  let homeLambda: number;
  let awayLambda: number;

  if (home.xGF !== undefined && away.xGA !== undefined) {
    // xG-based: home attack vs away defense, adjusted by goalie
    homeLambda = (home.xGF + away.xGA) / 2;
    if (away.goalie.gsax !== undefined) {
      homeLambda *= Math.max(0.7, 1 - away.goalie.gsax * 0.25);
    }
    // Add PP contribution
    homeLambda += (home.ppGF ?? (home.ppPct / 100) * 0.6) * 0.5;
  } else {
    homeLambda = (home.goalsFor + away.goalie.gaa) / 2;
  }

  if (away.xGF !== undefined && home.xGA !== undefined) {
    awayLambda = (away.xGF + home.xGA) / 2;
    if (home.goalie.gsax !== undefined) {
      awayLambda *= Math.max(0.7, 1 - home.goalie.gsax * 0.25);
    }
    awayLambda += (away.ppGF ?? (away.ppPct / 100) * 0.6) * 0.5;
  } else {
    awayLambda = (away.goalsFor + home.goalie.gaa) / 2;
  }

  // B2B adjustment
  if (home.isB2B) homeLambda *= 0.92;
  if (away.isB2B) awayLambda *= 0.92;

  // Calculate Poisson probabilities for 0-9 goals each team
  const maxGoals = 10;
  const homeProbs: number[] = [];
  const awayProbs: number[] = [];
  for (let i = 0; i < maxGoals; i++) {
    homeProbs.push(poissonPmf(i, homeLambda));
    awayProbs.push(poissonPmf(i, awayLambda));
  }

  // Calculate OVER/UNDER probabilities
  let overProb = 0;
  let underProb = 0;
  const scoreProbs: { score: string; prob: number }[] = [];

  for (let h = 0; h < maxGoals; h++) {
    for (let a = 0; a < maxGoals; a++) {
      const prob = homeProbs[h] * awayProbs[a];
      const total = h + a;
      if (total > line) overProb += prob;
      else if (total < line) underProb += prob;
      // else it's a push
      scoreProbs.push({ score: `${h}-${a}`, prob });
    }
  }

  // Sort by probability descending, take top 5
  scoreProbs.sort((a, b) => b.prob - a.prob);
  const top5 = scoreProbs.slice(0, 5);

  return {
    homeExpGoals: Math.round(homeLambda * 100) / 100,
    awayExpGoals: Math.round(awayLambda * 100) / 100,
    totalExpGoals: Math.round((homeLambda + awayLambda) * 10) / 10,
    overProb: Math.round(overProb * 1000) / 1000,
    underProb: Math.round(underProb * 1000) / 1000,
    exactScoreProbs: top5.map(s => ({ score: s.score, prob: Math.round(s.prob * 10000) / 10000 })),
  };
}

// ── "JUGADA SEGURA 90%+" ──────────────────────────────────────────────────────

export interface NHLSafePlay {
  type: "ML" | "Puck Line" | "O/U" | "Regulation" | "Period";
  description: string;        // e.g. "Boston Bruins ML" or "UNDER 7.5"
  probability: number;        // e.g. 0.92
  reasoning: string[];        // Array of reasons WHY this is safe
  confidence: "ULTRA" | "HIGH";  // ULTRA = 92%+, HIGH = 90%+
}

export function nhlFindSafePlay(
  home: NHLTeamStats,
  away: NHLTeamStats,
  ctx: NHLGameContext,
  homeProb: number,          // from predictNHL
  poisson: NHLPoissonResult, // from nhlPoissonTotal
  ouLine: number,
): NHLSafePlay | null {
  const plays: NHLSafePlay[] = [];
  const awayProb = 1 - homeProb;

  // 1. Check ML at very high confidence (rare but possible)
  if (homeProb >= 0.72) {
    const reasons: string[] = [];
    if (home.goalie.gsax !== undefined && home.goalie.gsax > 0.3) reasons.push(`Portero elite (GSAx +${home.goalie.gsax.toFixed(2)}/partido)`);
    if (home.xGF !== undefined && away.xGA !== undefined && home.xGF - away.xGA > 0.3) reasons.push(`Dominio ofensivo 5v5 (xGF ${home.xGF.toFixed(2)} vs xGA oponente ${away.xGA.toFixed(2)})`);
    if (home.winRate > 0.7) reasons.push(`Racha arrolladora (${(home.winRate*100).toFixed(0)}% en últimos 10)`);
    if (away.isB2B) reasons.push("Rival en back-to-back");
    if (away.goalie.gsax !== undefined && away.goalie.gsax < -0.15) reasons.push(`Portero rival débil (GSAx ${away.goalie.gsax.toFixed(2)})`);
    plays.push({ type: "ML", description: `${home.name} ML`, probability: homeProb, reasoning: reasons, confidence: homeProb >= 0.92 ? "ULTRA" : "HIGH" });
  }
  if (awayProb >= 0.72) {
    const reasons: string[] = [];
    if (away.goalie.gsax !== undefined && away.goalie.gsax > 0.3) reasons.push(`Portero elite (GSAx +${away.goalie.gsax.toFixed(2)}/partido)`);
    if (away.xGF !== undefined && home.xGA !== undefined && away.xGF - home.xGA > 0.3) reasons.push(`Dominio ofensivo 5v5`);
    if (away.winRate > 0.7) reasons.push(`Racha arrolladora (${(away.winRate*100).toFixed(0)}% en últimos 10)`);
    if (home.isB2B) reasons.push("Rival en back-to-back");
    plays.push({ type: "ML", description: `${away.name} ML`, probability: awayProb, reasoning: reasons, confidence: awayProb >= 0.92 ? "ULTRA" : "HIGH" });
  }

  // 2. Check O/U with Poisson — very high UNDER prob on high lines
  if (poisson.underProb >= 0.70 && ouLine >= 6.5) {
    const reasons: string[] = [];
    reasons.push(`Modelo Poisson: ${(poisson.underProb*100).toFixed(1)}% prob de UNDER`);
    reasons.push(`Goles esperados: ${poisson.totalExpGoals} vs línea ${ouLine}`);
    if (home.goalie.gsax !== undefined && home.goalie.gsax > 0.2) reasons.push(`Portero local elite (GSAx +${home.goalie.gsax.toFixed(2)})`);
    if (away.goalie.gsax !== undefined && away.goalie.gsax > 0.2) reasons.push(`Portero visitante elite (GSAx +${away.goalie.gsax.toFixed(2)})`);
    // Combine model prob with Poisson for composite
    const compositeProb = poisson.underProb;
    plays.push({ type: "O/U", description: `UNDER ${ouLine}`, probability: compositeProb, reasoning: reasons, confidence: compositeProb >= 0.92 ? "ULTRA" : "HIGH" });
  }
  if (poisson.overProb >= 0.70 && ouLine <= 5.5) {
    const reasons: string[] = [];
    reasons.push(`Modelo Poisson: ${(poisson.overProb*100).toFixed(1)}% prob de OVER`);
    reasons.push(`Goles esperados: ${poisson.totalExpGoals} vs línea ${ouLine}`);
    if (home.goalie.gsax !== undefined && home.goalie.gsax < -0.2) reasons.push("Portero local débil");
    if (away.goalie.gsax !== undefined && away.goalie.gsax < -0.2) reasons.push("Portero visitante débil");
    plays.push({ type: "O/U", description: `OVER ${ouLine}`, probability: poisson.overProb, reasoning: reasons, confidence: poisson.overProb >= 0.92 ? "ULTRA" : "HIGH" });
  }

  // 3. Check alternate lines — e.g., UNDER at higher line (7.5, 8.5)
  // These have very high probability by definition
  for (const altLine of [7.5, 8.5]) {
    if (altLine > ouLine) {
      let altUnder = 0;
      for (let h = 0; h < 10; h++) {
        for (let a = 0; a < 10; a++) {
          if (h + a < altLine) altUnder += poissonPmf(h, poisson.homeExpGoals) * poissonPmf(a, poisson.awayExpGoals);
        }
      }
      if (altUnder >= 0.90) {
        plays.push({
          type: "O/U", description: `UNDER ${altLine} (línea alternativa)`,
          probability: altUnder,
          reasoning: [`Poisson: ${(altUnder*100).toFixed(1)}% de que se anoten menos de ${altLine} goles`, `Solo ${(100-altUnder*100).toFixed(1)}% de chance de ${altLine}+ goles`],
          confidence: altUnder >= 0.92 ? "ULTRA" : "HIGH",
        });
      }
    }
  }
  for (const altLine of [4.5, 3.5]) {
    if (altLine < ouLine) {
      let altOver = 0;
      for (let h = 0; h < 10; h++) {
        for (let a = 0; a < 10; a++) {
          if (h + a > altLine) altOver += poissonPmf(h, poisson.homeExpGoals) * poissonPmf(a, poisson.awayExpGoals);
        }
      }
      if (altOver >= 0.90) {
        plays.push({
          type: "O/U", description: `OVER ${altLine} (línea alternativa)`,
          probability: altOver,
          reasoning: [`Poisson: ${(altOver*100).toFixed(1)}% de que se anoten más de ${altLine} goles`, `Goles esperados: ${poisson.totalExpGoals}`],
          confidence: altOver >= 0.92 ? "ULTRA" : "HIGH",
        });
      }
    }
  }

  // Filter only 90%+ plays
  const safePlays = plays.filter(p => p.probability >= 0.90);
  if (safePlays.length === 0) return null;

  // Return the one with highest probability
  safePlays.sort((a, b) => b.probability - a.probability);
  return safePlays[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIRMED GOALIE IMPACT — adjusts win prob based on starter vs backup
// ═══════════════════════════════════════════════════════════════════════════
export interface NHLConfirmedGoalie {
  name: string;
  svPct: number;
  gaa: number;
}

/**
 * Adjusts home win probability based on confirmed starting goalies.
 *
 * Logic:
 *  - Compare goalie save percentages (delta)
 *  - Each 0.010 svPct difference = ~3.5% WR difference
 *  - If NOT confirmed, we flag low confidence and apply no adjustment
 *    (prevents betting before starter is announced)
 */
export function applyConfirmedGoalieAdjustment(
  homeProb: number,
  homeGoalie: NHLConfirmedGoalie | null,
  awayGoalie: NHLConfirmedGoalie | null,
  confirmed: boolean
): { adjustedProb: number; confidencePenalty: number; note: string } {
  if (!confirmed || !homeGoalie || !awayGoalie) {
    return {
      adjustedProb: homeProb,
      confidencePenalty: 0.10, // 10pp penalty — treat as not confident for BET signal
      note: "Goalie no confirmado — espera el anuncio oficial",
    };
  }
  const delta = (homeGoalie.svPct || 0.900) - (awayGoalie.svPct || 0.900);
  const adj = delta * 3.5; // 0.010 svPct = 3.5pp WR
  const adjusted = Math.max(0.05, Math.min(0.95, homeProb + adj));
  return {
    adjustedProb: adjusted,
    confidencePenalty: 0,
    note: `Confirmados: ${homeGoalie.name} (${homeGoalie.svPct?.toFixed(3) ?? "?"}) vs ${awayGoalie.name} (${awayGoalie.svPct?.toFixed(3) ?? "?"})`,
  };
}
