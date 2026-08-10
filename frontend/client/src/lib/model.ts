// NBA Prediction Model — Professional v3
// Core methodology: Dean Oliver's Four Factors (Basketball on Paper)
// eFG% ~40% | TOV% ~25% | OREB% ~15% | FT Rate ~20%

// ── LEAGUE AVERAGES ───────────────────────────────────────────────────────────
const LEAGUE_AVG_RTG = 113.5;

const NBA_LEAGUE_AVG = {
  offRtg: 113.5,
  defRtg: 113.5,
  eFGPct: 0.540,
  ftRate: 0.250,
  tovPct: 0.140,
  orebPct: 0.270,
  pace: 100.0,
};

// ── TEAM STATS INTERFACE ──────────────────────────────────────────────────────
export interface TeamStats {
  // Core rating stats (required)
  netRtg: number;
  offRtg: number;
  defRtg: number;
  pace: number;
  daysRest: number;
  winRate: number;
  isB2B: boolean;
  streak: number;        // +5 = racha 5 victorias, -3 = racha 3 derrotas
  recentPace?: number;   // Pace promedio ultimos 5 partidos
  recentPPG?: number;    // Puntos anotados promedio ultimos 5 partidos
  oppAvgDefRtg?: number; // DefRtg promedio de rivales ultimos 10 (ajusta OffRtg)
  oppAvgOffRtg?: number; // OffRtg promedio de rivales ultimos 10 (ajusta DefRtg)

  // Display
  name?: string;         // Team name for display in safe play descriptions
  // Fatigue: games played in last 7 days (3 = normal, 4+ = fatigued)
  gamesLast7Days?: number;

  // Four Factors — Offense (all optional; enables professional model path)
  eFGPct?: number;       // Effective FG%  (e.g. 0.554)
  ftRate?: number;       // Free throw rate (e.g. 0.234)
  tovPct?: number;       // Turnover %     (e.g. 0.138) — LOWER is better
  orebPct?: number;      // Offensive rebound % (e.g. 0.291)

  // Four Factors — Defense (opponent stats)
  oppEFGPct?: number;    // Opponent eFG%   (e.g. 0.546) — LOWER is better
  oppFTRate?: number;    // Opponent FT rate (e.g. 0.260) — LOWER is better
  oppTovPct?: number;    // Opponent TOV%   (e.g. 0.156) — HIGHER is better (forcing TOs)
  oppOrebPct?: number;   // Opponent OREB%  (e.g. 0.298) — LOWER is better

  // Recent Four Factors (L10) — for momentum signals
  l10eFGPct?: number;
  l10FTRate?: number;
  l10TovPct?: number;
  l10OrebPct?: number;
  l10OppEFGPct?: number;
  l10OppFTRate?: number;
  l10OppTovPct?: number;
  l10OppOrebPct?: number;

  // Games played (for regression to mean)
  gamesPlayed?: number;

  // Home/Away splits
  homeOffRtg?: number;
  homeDefRtg?: number;
  homeNetRtg?: number;
  awayOffRtg?: number;
  awayDefRtg?: number;
  awayNetRtg?: number;
  homeRecord?: string;
  awayRecord?: string;
  // H2H
  h2hWins?: number;    // wins vs this specific opponent this season
  h2hLosses?: number;  // losses vs this specific opponent
  // Game context
  isPlayoff?: boolean;       // Play-In or Playoff game
  isElimination?: boolean;   // "Loser eliminated" — must-win game
  isHomeCourtSeries?: boolean; // Team has home court advantage in series
  gameContextType?: "regular" | "playin" | "playoff" | "finals";
  // Travel
  travelPenalty?: number;
}

// ── CALIBRATION ──────────────────────────────────────────────────────────
// Backtesting showed models are UNDERCONFIDENT (same pattern across MLB/NHL)
// k=1.3 stretches NBA probabilities away from 50% to match reality
export function nbaCalibrate(rawProb: number): number {
  const k = 1.3;
  return Math.max(0.05, Math.min(0.95, 0.5 + (rawProb - 0.5) * k));
}

// ── MARKET REGRESSION ───────────────────────────────────────────────────
// The market (Vegas lines) has information the model doesn't.
// When model diverges significantly from market, shrink toward the market.
// This reduces overconfidence and improves calibration.
export function regressToMarket(
  modelProb: number,
  marketImpliedProb: number,
  shrinkFactor: number = 0.25, // 25% toward market
): number {
  if (marketImpliedProb <= 0 || marketImpliedProb >= 1) return modelProb;
  // Blend: 75% model + 25% market
  return modelProb * (1 - shrinkFactor) + marketImpliedProb * shrinkFactor;
}

// ── SCHEDULE ADJUSTMENT (SOS) ─────────────────────────────────────────────────
// If you played bad defenses your OffRtg is inflated, and vice-versa.
// adjOffRtg = rawOffRtg * (leagueAvg / oppAvgDefRtg)
export function getScheduleAdjusted(stats: TeamStats): {
  adjOffRtg: number;
  adjDefRtg: number;
  adjNetRtg: number;
  compressedNetRtg: number;  // diminishing returns applied
  offAdjPct: number;
  defAdjPct: number;
} {
  const adjOffRtg = stats.oppAvgDefRtg
    ? stats.offRtg * (LEAGUE_AVG_RTG / stats.oppAvgDefRtg)
    : stats.offRtg;

  const adjDefRtg = stats.oppAvgOffRtg
    ? stats.defRtg * (LEAGUE_AVG_RTG / stats.oppAvgOffRtg)
    : stats.defRtg;

  const rawNetRtg = adjOffRtg - adjDefRtg;

  // Diminishing returns for prediction: a +15 NetRtg is NOT 3x better than +5
  // ESPN BPI: a 30-pt win is only ~20% better than 15-pt win
  // sqrt compression: +5 → 7.1, +10 → 10, +15 → 12.2, +20 → 14.1, +30 → 17.3
  const compressed = rawNetRtg >= 0
    ? Math.sqrt(rawNetRtg) * Math.sqrt(10)
    : -Math.sqrt(Math.abs(rawNetRtg)) * Math.sqrt(10);

  return {
    adjOffRtg,
    adjDefRtg,
    adjNetRtg: rawNetRtg,              // raw for display
    compressedNetRtg: compressed,       // compressed for prediction logit
    offAdjPct: stats.oppAvgDefRtg ? ((adjOffRtg - stats.offRtg) / stats.offRtg) * 100 : 0,
    defAdjPct: stats.oppAvgOffRtg ? ((adjDefRtg - stats.defRtg) / stats.defRtg) * 100 : 0,
  };
}

// ── LEGACY COEFFICIENTS (Path B fallback) ────────────────────────────────────
const COEFFICIENTS = {
  intercept: 0.15,
  diff_net_rtg: 0.08,
  diff_off_rtg: 0.03,
  diff_def_rtg: -0.03,
  diff_pace: 0.005,
  diff_rest: 0.06,
  home_win_rate: 1.2,
  away_win_rate: -1.2,
  home_b2b: -0.18,
  away_b2b: 0.18,
  diff_streak: 0.05,
};

// ── MATH HELPERS ──────────────────────────────────────────────────────────────
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// Normal CDF approximation — Abramowitz & Stegun 26.2.17
function normalCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

// Poisson PMF (kept for completeness; NBA uses normal for totals)
function poissonPmf(k: number, lambda: number): number {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) { result *= lambda / i; }
  return result;
}

// ── REGRESSION TO MEAN ────────────────────────────────────────────────────────
// stabilization: games needed before a stat is fully reliable
// eFG%  ~30 games, TOV% ~25 games (Dean Oliver / Tom Tango research)
function regressToMean(
  value: number,
  mean: number,
  games: number,
  stabilization: number
): number {
  const weight = games / (games + stabilization);
  return mean * (1 - weight) + value * weight;
}

// ── FOUR FACTOR SCORE ─────────────────────────────────────────────────────────
// Returns a dimensionless score (0 = league average).
// Positive = above average, negative = below average.
// Weights: eFG% 40%, TOV% 25%, OREB% 15%, FT Rate 20% (Dean Oliver)
// Uses BLENDED stats: L10 weight adjusted by SOS
// If schedule was tough (oppAvgDefRtg low = good defenses), L10 is more trustworthy → higher weight
// If schedule was easy (oppAvgDefRtg high = bad defenses), L10 is inflated → lower weight
function blendStat(season: number | undefined, l10: number | undefined, fallback: number, sosAdj?: number): number {
  const s = season ?? fallback;
  if (l10 === undefined) return s;
  // Default: 50/50 blend. SOS adjusts: tough schedule → 60% L10, easy schedule → 30% L10
  // sosAdj is oppAvgDefRtg or oppAvgOffRtg deviation from league avg
  let l10Weight = 0.45; // base: 45% L10, 55% season (more conservative than before)
  if (sosAdj !== undefined) {
    // sosAdj > 0 means opponents were above average (tough) → trust L10 more
    // sosAdj < 0 means opponents were below average (easy) → trust L10 less
    l10Weight = Math.max(0.25, Math.min(0.60, 0.45 + sosAdj * 0.03));
  }
  return s * (1 - l10Weight) + l10 * l10Weight;
}

function fourFactorScore(t: TeamStats, side: 'offense' | 'defense'): number {
  const games = t.gamesPlayed ?? 82;
  // SOS adjustment for blend weight
  // oppAvgDefRtg < league avg = tough schedule = L10 more reliable
  // oppAvgDefRtg > league avg = easy schedule = L10 less reliable  
  const sosOff = t.oppAvgDefRtg !== undefined ? (NBA_LEAGUE_AVG.defRtg - t.oppAvgDefRtg) : undefined;
  const sosDef = t.oppAvgOffRtg !== undefined ? (t.oppAvgOffRtg - NBA_LEAGUE_AVG.offRtg) : undefined;

  if (side === 'offense') {
    // Blend season + L10 with SOS-adjusted weighting
    const rawEfg = blendStat(t.eFGPct, t.l10eFGPct, NBA_LEAGUE_AVG.eFGPct, sosOff);
    const rawTov = blendStat(t.tovPct, t.l10TovPct, NBA_LEAGUE_AVG.tovPct, sosOff);
    const orb    = blendStat(t.orebPct, t.l10OrebPct, NBA_LEAGUE_AVG.orebPct, sosOff);
    const ft     = blendStat(t.ftRate, t.l10FTRate, NBA_LEAGUE_AVG.ftRate, sosOff);

    // Regression to mean on the blended value
    const efg = regressToMean(rawEfg, NBA_LEAGUE_AVG.eFGPct, games, 30);
    const tov = regressToMean(rawTov, NBA_LEAGUE_AVG.tovPct, games, 25);

    // Normalize around league avg; scaling denominators set so 1 stddev ≈ 1.0 unit
    const efgScore = (efg - NBA_LEAGUE_AVG.eFGPct) / 0.03 * 0.40;
    const tovScore = (NBA_LEAGUE_AVG.tovPct - tov) / 0.02 * 0.25;
    const orbScore = (orb - NBA_LEAGUE_AVG.orebPct) / 0.03 * 0.15;
    const ftScore  = (ft  - NBA_LEAGUE_AVG.ftRate)  / 0.03 * 0.20;

    return efgScore + tovScore + orbScore + ftScore;
  } else {
    // Defense: blend season + L10 with SOS-adjusted weighting
    const rawOppEfg = blendStat(t.oppEFGPct, t.l10OppEFGPct, NBA_LEAGUE_AVG.eFGPct, sosDef);
    const rawOppTov = blendStat(t.oppTovPct, t.l10OppTovPct, NBA_LEAGUE_AVG.tovPct, sosDef);
    const oppOrb    = blendStat(t.oppOrebPct, t.l10OppOrebPct, NBA_LEAGUE_AVG.orebPct, sosDef);
    const oppFt     = blendStat(t.oppFTRate, t.l10OppFTRate, NBA_LEAGUE_AVG.ftRate, sosDef);

    const oppEfg = regressToMean(rawOppEfg, NBA_LEAGUE_AVG.eFGPct, games, 30);
    const oppTov = regressToMean(rawOppTov, NBA_LEAGUE_AVG.tovPct, games, 25);

    const efgScore = (NBA_LEAGUE_AVG.eFGPct - oppEfg) / 0.03 * 0.40;
    const tovScore = (oppTov - NBA_LEAGUE_AVG.tovPct) / 0.02 * 0.25;
    const orbScore = (NBA_LEAGUE_AVG.orebPct - oppOrb) / 0.03 * 0.15;
    const ftScore  = (NBA_LEAGUE_AVG.ftRate  - oppFt)  / 0.03 * 0.20;

    return efgScore + tovScore + orbScore + ftScore;
  }
}

// ── PREDICT (win probability) ─────────────────────────────────────────────────
export function predict(home: TeamStats, away: TeamStats): number {

  // ── PATH A: Four Factors model (professional) ─────────────────────────────
  if (home.eFGPct !== undefined && away.eFGPct !== undefined) {
    const homeOffScore = fourFactorScore(home, 'offense');
    const homeDefScore = fourFactorScore(home, 'defense');
    const awayOffScore = fourFactorScore(away, 'offense');
    const awayDefScore = fourFactorScore(away, 'defense');

    // Matchup: home offense vs away defense, and vice-versa
    const homeMatchup = homeOffScore - awayDefScore; // positive = home offense > away defense
    const awayMatchup = awayOffScore - homeDefScore;
    const matchupDiff = homeMatchup - awayMatchup;

    // Secondary: schedule-adjusted net rating with diminishing returns
    const homeAdj = getScheduleAdjusted(home);
    const awayAdj = getScheduleAdjusted(away);
    const rtgDiff = (homeAdj.compressedNetRtg - awayAdj.compressedNetRtg) * 0.04;

    // Win% reality check: season record is the ultimate integrated measure of team strength
    // This anchors the model to actual results, preventing L10 inflation from dominating
    const winRateDiff = (home.winRate - away.winRate) * 1.5;

    // Momentum: L10 Four Factors vs season average (all 4 factors)
    let momentumBonus = 0;
    // eFG% trend
    if (home.l10eFGPct !== undefined && home.eFGPct !== undefined) {
      momentumBonus += (home.l10eFGPct - home.eFGPct) * 5;
    }
    if (away.l10eFGPct !== undefined && away.eFGPct !== undefined) {
      momentumBonus -= (away.l10eFGPct - away.eFGPct) * 5;
    }
    // TOV% trend (lower = better)
    if (home.l10TovPct !== undefined && home.tovPct !== undefined) {
      momentumBonus += (home.tovPct - home.l10TovPct) * 3;
    }
    if (away.l10TovPct !== undefined && away.tovPct !== undefined) {
      momentumBonus -= (away.tovPct - away.l10TovPct) * 3;
    }
    // OREB% trend
    if (home.l10OrebPct !== undefined && home.orebPct !== undefined) {
      momentumBonus += (home.l10OrebPct - home.orebPct) * 2;
    }
    if (away.l10OrebPct !== undefined && away.orebPct !== undefined) {
      momentumBonus -= (away.l10OrebPct - away.orebPct) * 2;
    }
    // FT Rate trend
    if (home.l10FTRate !== undefined && home.ftRate !== undefined) {
      momentumBonus += (home.l10FTRate - home.ftRate) * 1.5;
    }
    if (away.l10FTRate !== undefined && away.ftRate !== undefined) {
      momentumBonus -= (away.l10FTRate - away.ftRate) * 1.5;
    }

    // Rest / schedule factors
    let homeAdv = 0.12; // NBA home advantage ≈ 58% win rate
    if (home.isB2B) homeAdv -= 0.10;
    if (away.isB2B) homeAdv += 0.10;

    // Fatigue: games in last 7 days (normal = 2-3, fatigued = 4+)
    const homeFatigue = (home.gamesLast7Days ?? 2) - 2.5; // 0 = normal, +1.5 = very fatigued
    const awayFatigue = (away.gamesLast7Days ?? 2) - 2.5;
    const fatigueDiff = (awayFatigue - homeFatigue) * 0.03; // fatigued team is disadvantaged

    const restDiff = (home.daysRest - away.daysRest) * 0.04 + fatigueDiff;

    const homeStreak = home.streak ?? 0;
    const awayStreak = away.streak ?? 0;

    // Home/Away split adjustment — use actual location-specific ratings
    let splitAdj = 0;
    if (home.homeNetRtg !== undefined && away.awayNetRtg !== undefined) {
      // Use the ACTUAL home rating of the home team vs ACTUAL away rating of the away team
      // This is more accurate than a generic home advantage
      const homeSplitDiff = (home.homeNetRtg - away.awayNetRtg) * 0.02;
      splitAdj = homeSplitDiff;
    }

    // H2H adjustment — if one team has dominated the other this season
    let h2hAdj = 0;
    if (home.h2hWins !== undefined && home.h2hLosses !== undefined) {
      const totalH2H = home.h2hWins + home.h2hLosses;
      if (totalH2H >= 2) {
        const h2hWinRate = home.h2hWins / totalH2H;
        h2hAdj = (h2hWinRate - 0.5) * 0.3; // slight adjustment based on H2H
      }
    }

    // Playoff intensity adjustment
    // ── GAME CONTEXT ADJUSTMENTS ─────────────────────────────────────────
    let playoffAdj = 0;
    let contextAdj = 0;
    const ctx = home.gameContextType || (home.isPlayoff ? "playin" : "regular");

    if (ctx === "playin") {
      // Play-In: home court matters A LOT (neutral site feel but at home)
      // Better team tends to win (fewer upsets than regular season)
      playoffAdj = 0.05;
      // Teams with better record are more motivated/focused in Play-In
      if (home.winRate > away.winRate) contextAdj += 0.03;
      else if (away.winRate > home.winRate) contextAdj -= 0.03;
    } else if (ctx === "playoff" || ctx === "finals") {
      // Playoffs: home court advantage increases ~3-5% vs regular season
      playoffAdj = 0.08;
      // Better team wins more in playoffs (variance shrinks in 7-game series)
      contextAdj += (home.winRate - away.winRate) * 0.5;
      // Home court in series (higher seed) = additional edge
      if (home.isHomeCourtSeries) contextAdj += 0.03;
    }

    // Elimination game: desperate team plays harder
    // The team facing elimination gets a slight boost (urgency)
    if (home.isElimination && !away.isElimination) {
      // Home team is fighting for survival, away is comfortable → home gets boost
      contextAdj += 0.04;
    } else if (away.isElimination && !home.isElimination) {
      // Away team desperate → they play harder, reduces home advantage
      contextAdj -= 0.03;
    }

    // Streak momentum in context: a 5+ game win streak in playoffs/play-in = team is locked in
    if (ctx !== "regular") {
      if (homeStreak >= 3) contextAdj += 0.02;
      if (awayStreak >= 3) contextAdj -= 0.02;
      if (homeStreak <= -3) contextAdj -= 0.02; // team collapsing
      if (awayStreak <= -3) contextAdj += 0.02;
    }

    // Travel penalty: visiting team traveled far = home team gets bonus
    const awayTravelAdj = away.travelPenalty ?? 0; // negative number for long travel

    const logit =
      homeAdv +
      matchupDiff * 1.5 +      // Four Factors: informative but can overfit L10
      rtgDiff +
      winRateDiff +             // season record: strongest anchor for true team strength
      momentumBonus * 0.3 +     // momentum: noisy in small samples
      restDiff +
      (homeStreak - awayStreak) * 0.01 +
      splitAdj * 2.0 +          // Home/Away splits: very reliable, game-context specific
      h2hAdj * 1.5 +            // H2H: direct evidence of matchup quality
      playoffAdj +
      contextAdj -              // game context: play-in/playoff/elimination adjustments
      awayTravelAdj;            // away travel fatigue benefits home team

    return sigmoid(logit);
  }

  // ── PATH B: Fallback — OffRtg/DefRtg/NetRtg model (original) ─────────────
  const homeAdj = getScheduleAdjusted(home);
  const awayAdj = getScheduleAdjusted(away);

  const homeStreak = home.streak ?? 0;
  const awayStreak = away.streak ?? 0;

  const logit =
    COEFFICIENTS.intercept +
    COEFFICIENTS.diff_net_rtg  * (homeAdj.compressedNetRtg - awayAdj.compressedNetRtg) +
    COEFFICIENTS.diff_off_rtg  * (homeAdj.adjOffRtg - awayAdj.adjOffRtg) +
    COEFFICIENTS.diff_def_rtg  * (homeAdj.adjDefRtg - awayAdj.adjDefRtg) +
    COEFFICIENTS.diff_pace     * (home.pace - away.pace) +
    COEFFICIENTS.diff_rest     * (home.daysRest - away.daysRest) +
    COEFFICIENTS.home_win_rate * home.winRate +
    COEFFICIENTS.away_win_rate * away.winRate +
    COEFFICIENTS.home_b2b      * (home.isB2B ? 1 : 0) +
    COEFFICIENTS.away_b2b      * (away.isB2B ? 1 : 0) +
    COEFFICIENTS.diff_streak   * (homeStreak - awayStreak);

  return sigmoid(logit);
}

// ── ODDS UTILITIES ────────────────────────────────────────────────────────────
export function americanToProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

export function americanToDecimal(odds: number): number {
  if (odds > 0) return odds / 100 + 1;
  return 100 / Math.abs(odds) + 1;
}

export function kellyStake(prob: number, odds: number, bankroll: number): number {
  const b = odds > 0 ? odds / 100 : 100 / Math.abs(odds);
  const q = 1 - prob;
  const kelly = (b * prob - q) / b;
  return Math.max(0, kelly * 0.25) * bankroll; // Quarter Kelly
}

export function getEdge(modelProb: number, impliedProb: number): number {
  return (modelProb - impliedProb) * 100;
}

/**
 * Signal classification (v2 — Élite threshold).
 * BET requires BOTH: edge > 5% AND model confidence >= 70% (or <=30%).
 * This is the 70% confianza criterion — only strongly-sided picks qualify.
 */
export function getSignal(edge: number, modelProb?: number): "BET" | "LEAN" | "PASS" {
  const confident = modelProb === undefined
    ? true
    : (modelProb >= 0.70 || modelProb <= 0.30);
  if (edge > 5 && confident) return "BET";
  if (edge > 2) return "LEAN";
  return "PASS";
}

export function expectedValue(modelProb: number, odds: number, stake: number): number {
  const decimalOdds = americanToDecimal(odds);
  return modelProb * (stake * (decimalOdds - 1)) - (1 - modelProb) * stake;
}

// ── SPREAD MODEL ──────────────────────────────────────────────────────────────
export function predictSpread(homeProb: number): number {
  const logit = Math.log(homeProb / (1 - homeProb));
  return logit * 10;
}

// Normal CDF approximation (Abramowitz & Stegun)
function normCdf(x: number, mean: number, std: number): number {
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export function evaluateSpread(
  homeProb: number,
  spreadLine: number
): { expectedMargin: number; edgeVsSpread: number; signal: "BET" | "LEAN" | "PASS"; side: string; pickedSide: "home" | "away"; coverProb: number; confidence: string } {
  const expectedMargin = predictSpread(homeProb);
  const edgeVsSpread = expectedMargin - (-spreadLine);
  const absEdge = Math.abs(edgeVsSpread);
  // Cover probability from normal distribution: P(home_margin > -spreadLine)
  // If spreadLine is -5.5 (home favored), home needs margin > 5.5 to cover
  // That's P(X > 5.5) where X ~ N(expectedMargin, 10.5)
  const homeCoverProb = 1 - normCdf(-spreadLine, expectedMargin, NBA_MARGIN_STD);
  const awayCoverProb = 1 - homeCoverProb;
  // Elegir el lado con mayor probabilidad de cubrir
  const pickedSide: "home" | "away" = homeCoverProb >= awayCoverProb ? "home" : "away";
  const coverProb = pickedSide === "home" ? homeCoverProb : awayCoverProb;
  const signal: "BET" | "LEAN" | "PASS" = absEdge > 4 ? "BET" : absEdge > 2 ? "LEAN" : "PASS";
  // Mostrar la línea específica del lado que cubre
  const sideLine = pickedSide === "home" ? spreadLine : -spreadLine;
  const sign = sideLine < 0 ? "" : "+";
  const sideLabel = pickedSide === "home" ? "Local" : "Visitante";
  const side = `${sideLabel} ${sign}${sideLine.toFixed(1)}`;
  const confidence = coverProb >= 0.65 ? "ALTA" : coverProb >= 0.55 ? "MEDIA" : coverProb >= 0.50 ? "BAJA" : "SIN EDGE";
  return { expectedMargin, edgeVsSpread, signal, side, pickedSide, coverProb, confidence };
}

// ── ALTERNATE LINES (buy points for higher confidence) ───────────────────────
export interface AltLine {
  type: "Spread" | "O/U";
  line: number;
  side: string;         // "Local" | "Visitante" | "OVER" | "UNDER"
  coverProb: number;    // probability this alt line hits
  confidence: string;   // "ULTRA" | "ALTA" | "MEDIA"
  estOdds: string;      // estimated juice for buying points
  description: string;  // human-readable description
}

// NBA margin std dev ≈ 10-11 points
const NBA_MARGIN_STD = 10.5;
// NBA total std dev ≈ 16-18 points  
const NBA_TOTAL_STD = 17;

export function generateAltLines(
  homeProb: number,
  spreadLine: number,
  ouLine: number,
  predictedTotal: number,
  homeTeam: string,
  awayTeam: string,
): AltLine[] {
  const alts: AltLine[] = [];
  const expectedMargin = predictSpread(homeProb);

  // ── SPREAD ALTERNATES ─────────────────────────────────────────────
  // Only generate spread alts if user entered a spread line
  const spreadSteps = [1, 2, 3, 4.5, 6.5];
  
  // Determine which team the market spread favors
  // spreadLine is from home perspective: -3.5 means home favored by 3.5
  const homeFavored = spreadLine < 0;
  const favoredTeam = homeFavored ? homeTeam : awayTeam;
  const dogTeam = homeFavored ? awayTeam : homeTeam;
  const marketSpreadAbs = Math.abs(spreadLine);

  if (spreadLine === 0) { /* skip spread alts if no spread entered */ }
  else for (const step of spreadSteps) {
    // Buy points FOR the favorite: spread goes from -3.5 to -1.5 (easier to cover)
    const buyFavLine = homeFavored ? spreadLine + step : spreadLine - step;
    const buyFavMarginNeeded = -buyFavLine; // margin home needs
    const buyFavCover = normalCdf((expectedMargin - buyFavMarginNeeded) / NBA_MARGIN_STD);
    // Only show if buying points actually increases probability meaningfully
    if (buyFavCover > 0.55 && buyFavCover < 0.98) {
      // Estimate odds: roughly -20 per half point bought from -110 base
      const ptsBought = step;
      const estJuice = Math.round(-110 - ptsBought * 20);
      const conf = buyFavCover >= 0.90 ? "ULTRA" : buyFavCover >= 0.80 ? "ALTA" : "MEDIA";
      alts.push({
        type: "Spread",
        line: Math.round(buyFavLine * 10) / 10,
        side: favoredTeam,
        coverProb: buyFavCover,
        confidence: conf,
        estOdds: `~${estJuice}`,
        description: `${favoredTeam} ${buyFavLine > 0 ? "+" : ""}${buyFavLine.toFixed(1)}`,
      });
    }

    // Buy points FOR the dog: give more points (e.g. +7.5 becomes +8.5, +9.5)
    const buyDogLine = homeFavored ? spreadLine - step : spreadLine + step;
    const buyDogMarginNeeded = -buyDogLine;
    const buyDogCover = 1 - normalCdf((expectedMargin - buyDogMarginNeeded) / NBA_MARGIN_STD);
    if (buyDogCover > 0.55 && buyDogCover < 0.98) {
      const ptsBought = step;
      const estJuice = Math.round(-110 - ptsBought * 20);
      const conf = buyDogCover >= 0.90 ? "ULTRA" : buyDogCover >= 0.80 ? "ALTA" : "MEDIA";
      // Display from dog's perspective: show positive spread
      const dogSpreadDisplay = Math.abs(buyDogLine);
      alts.push({
        type: "Spread",
        line: Math.round(buyDogLine * 10) / 10,
        side: dogTeam,
        coverProb: buyDogCover,
        confidence: conf,
        estOdds: `~${estJuice}`,
        description: `${dogTeam} +${dogSpreadDisplay.toFixed(1)}`,
      });
    }
  }

  // ── O/U ALTERNATES ────────────────────────────────────────────────
  // Only generate O/U alts if user entered an O/U line AND we have a predicted total
  const ouSteps = [2, 4, 6, 8, 10];
  if (ouLine === 0 || predictedTotal === 0) { /* skip O/U alts */ }
  else
  for (const step of ouSteps) {
    // Lower O/U line → OVER is easier
    const lowerLine = ouLine - step;
    const overProbLow = 1 - normalCdf((lowerLine - predictedTotal) / NBA_TOTAL_STD);
    if (overProbLow > 0.55 && overProbLow < 0.98) {
      const estJuice = Math.round(-110 - step * 10);
      const conf = overProbLow >= 0.90 ? "ULTRA" : overProbLow >= 0.80 ? "ALTA" : "MEDIA";
      alts.push({
        type: "O/U",
        line: lowerLine,
        side: "OVER",
        coverProb: overProbLow,
        confidence: conf,
        estOdds: `~${estJuice}`,
        description: `OVER ${lowerLine.toFixed(1)}`,
      });
    }

    // Higher O/U line → UNDER is easier
    const higherLine = ouLine + step;
    const underProbHigh = normalCdf((higherLine - predictedTotal) / NBA_TOTAL_STD);
    if (underProbHigh > 0.55 && underProbHigh < 0.98) {
      const estJuice = Math.round(-110 - step * 10);
      const conf = underProbHigh >= 0.90 ? "ULTRA" : underProbHigh >= 0.80 ? "ALTA" : "MEDIA";
      alts.push({
        type: "O/U",
        line: higherLine,
        side: "UNDER",
        coverProb: underProbHigh,
        confidence: conf,
        estOdds: `~${estJuice}`,
        description: `UNDER ${higherLine.toFixed(1)}`,
      });
    }
  }

  // Sort by confidence (highest prob first)
  alts.sort((a, b) => b.coverProb - a.coverProb);

  // Return top 6 most useful lines
  return alts.slice(0, 6);
}

// ── OVER/UNDER MODEL (pace + OffRtg/DefRtg) ──────────────────────────────────
export function predictTotal(home: TeamStats, away: TeamStats): number {
  // ── PASO 1: PACE EFECTIVO ─────────────────────────────────────────────
  const homePaceBase = home.pace * (home.isB2B ? 0.97 : 1.0);
  const awayPaceBase = away.pace * (away.isB2B ? 0.97 : 1.0);

  // Blend pace: 40% temporada + 60% ultimos 5 si disponible
  const homePaceEff = home.recentPace
    ? homePaceBase * 0.4 + (home.recentPace * (home.isB2B ? 0.97 : 1.0)) * 0.6
    : homePaceBase;
  const awayPaceEff = away.recentPace
    ? awayPaceBase * 0.4 + (away.recentPace * (away.isB2B ? 0.97 : 1.0)) * 0.6
    : awayPaceBase;

  const avgPace = (homePaceEff + awayPaceEff) / 2;

  // ── PASO 2: STATS AJUSTADAS POR SOS ──────────────────────────────────
  const homeAdj = getScheduleAdjusted(home);
  const awayAdj = getScheduleAdjusted(away);

  // ── PASO 3: PUNTOS BASE (OffRtg ajustado vs defensa rival) ───────────
  const homeScoreBase = (homeAdj.adjOffRtg / 100) * avgPace * (awayAdj.adjDefRtg / LEAGUE_AVG_RTG);
  const awayScoreBase = (awayAdj.adjOffRtg / 100) * avgPace * (homeAdj.adjDefRtg / LEAGUE_AVG_RTG);

  // ── PASO 4: AJUSTE POR RACHA OFENSIVA (PPG ultimos 5) ────────────────
  let homeScore = homeScoreBase;
  let awayScore = awayScoreBase;

  if (home.recentPPG) {
    const homeExpected = (homeAdj.adjOffRtg / 100) * homePaceBase;
    const momentum = home.recentPPG / homeExpected;
    homeScore = homeScoreBase * Math.max(0.85, Math.min(1.15, momentum));
  }

  if (away.recentPPG) {
    const awayExpected = (awayAdj.adjOffRtg / 100) * awayPaceBase;
    const momentum = away.recentPPG / awayExpected;
    awayScore = awayScoreBase * Math.max(0.85, Math.min(1.15, momentum));
  }

  return Math.round((homeScore + awayScore) * 10) / 10;
}

export function evaluateTotal(
  home: TeamStats,
  away: TeamStats,
  ouLine: number
): { estimatedTotal: number; edge: number; signal: "BET" | "LEAN" | "PASS"; side: "OVER" | "UNDER"; hitProb: number; confidence: string } {
  const estimatedTotal = predictTotal(home, away);
  const diff = estimatedTotal - ouLine;
  const absDiff = Math.abs(diff);
  const signal: "BET" | "LEAN" | "PASS" = absDiff > 6 ? "BET" : absDiff > 3 ? "LEAN" : "PASS";
  const side: "OVER" | "UNDER" = diff > 0 ? "OVER" : "UNDER";
  // Probability of the chosen side hitting, using normal distribution
  const overProb = 1 - normCdf(ouLine, estimatedTotal, NBA_TOTAL_STD);
  const hitProb = side === "OVER" ? overProb : (1 - overProb);
  const confidence = hitProb >= 0.65 ? "ALTA" : hitProb >= 0.55 ? "MEDIA" : hitProb >= 0.50 ? "BAJA" : "SIN EDGE";
  return { estimatedTotal, edge: diff, signal, side, hitProb, confidence };
}

// ── POISSON / NORMAL TOTAL MODEL ──────────────────────────────────────────────
// NBA totals are approximately normally distributed (σ ≈ 12 pts).
// Poisson PMF is provided as a utility but we use the normal CDF for O/U probs.
export interface NBAPoissonResult {
  homeExpPoints: number;
  awayExpPoints: number;
  totalExpPoints: number;
  overProb: number;
  underProb: number;
}

export function nbaPoissonTotal(
  home: TeamStats,
  away: TeamStats,
  ouLine: number
): NBAPoissonResult {
  const total = predictTotal(home, away);
  // NBA game totals: roughly normal, std dev ~12 points
  const stdDev = 12;
  const z = (ouLine - total) / stdDev;
  const underProb = normalCdf(z);
  const overProb = 1 - underProb;

  // Split expected total into home/away shares via adjusted OffRtg
  const homeAdj = getScheduleAdjusted(home);
  const awayAdj = getScheduleAdjusted(away);
  const homeShare = homeAdj.adjOffRtg / (homeAdj.adjOffRtg + awayAdj.adjOffRtg);

  return {
    homeExpPoints: Math.round(total * homeShare * 10) / 10,
    awayExpPoints: Math.round(total * (1 - homeShare) * 10) / 10,
    totalExpPoints: total,
    overProb: Math.round(overProb * 1000) / 1000,
    underProb: Math.round(underProb * 1000) / 1000,
  };
}

// ── SAFE PLAY (90%+ confidence) ───────────────────────────────────────────────
export interface NBASafePlay {
  type: "ML" | "Spread" | "O/U";
  description: string;
  probability: number;
  reasoning: string[];
  confidence: "ULTRA" | "HIGH";
}

export function nbaFindSafePlay(
  home: TeamStats,
  away: TeamStats,
  homeProb: number,
  poissonResult: NBAPoissonResult,
  ouLine: number,
  spreadLine: number,
): NBASafePlay | null {
  const plays: NBASafePlay[] = [];
  const awayProb = 1 - homeProb;

  // 1. ML at extreme confidence ──────────────────────────────────────────────
  if (homeProb >= 0.78) {
    const reasons: string[] = [];
    const homeAdj = getScheduleAdjusted(home);
    const awayAdj = getScheduleAdjusted(away);
    if (homeAdj.adjNetRtg - awayAdj.adjNetRtg > 8) {
      reasons.push(`NetRtg gap: +${(homeAdj.adjNetRtg - awayAdj.adjNetRtg).toFixed(1)}`);
    }
    if (home.eFGPct && away.oppEFGPct && home.eFGPct > away.oppEFGPct + 0.02) {
      reasons.push(`eFG% ventaja: ${(home.eFGPct * 100).toFixed(1)}% vs opp ${(away.oppEFGPct * 100).toFixed(1)}%`);
    }
    if (away.isB2B) reasons.push("Rival en back-to-back");
    if (home.winRate > 0.8) reasons.push(`Racha dominante: ${(home.winRate * 100).toFixed(0)}% últimos 10`);
    plays.push({
      type: "ML",
      description: `${home.name ?? "Local"} ML`,
      probability: homeProb,
      reasoning: reasons,
      confidence: homeProb >= 0.92 ? "ULTRA" : "HIGH",
    });
  }

  if (awayProb >= 0.78) {
    const reasons: string[] = [];
    const homeAdj = getScheduleAdjusted(home);
    const awayAdj = getScheduleAdjusted(away);
    if (awayAdj.adjNetRtg - homeAdj.adjNetRtg > 8) {
      reasons.push(`NetRtg gap: +${(awayAdj.adjNetRtg - homeAdj.adjNetRtg).toFixed(1)}`);
    }
    if (away.eFGPct && home.oppEFGPct && away.eFGPct > home.oppEFGPct + 0.02) {
      reasons.push(`eFG% ventaja: ${(away.eFGPct * 100).toFixed(1)}% vs opp ${(home.oppEFGPct * 100).toFixed(1)}%`);
    }
    if (home.isB2B) reasons.push("Local en back-to-back");
    if (away.winRate > 0.8) reasons.push("Racha dominante");
    plays.push({
      type: "ML",
      description: `${away.name ?? "Visitante"} ML`,
      probability: awayProb,
      reasoning: reasons,
      confidence: awayProb >= 0.92 ? "ULTRA" : "HIGH",
    });
  }

  // 2. O/U with normal distribution ─────────────────────────────────────────
  if (poissonResult.overProb >= 0.90) {
    plays.push({
      type: "O/U",
      description: `OVER ${ouLine}`,
      probability: poissonResult.overProb,
      reasoning: [
        `Modelo: ${(poissonResult.overProb * 100).toFixed(1)}% prob de OVER`,
        `Total esperado: ${poissonResult.totalExpPoints} vs línea ${ouLine}`,
      ],
      confidence: poissonResult.overProb >= 0.92 ? "ULTRA" : "HIGH",
    });
  }
  if (poissonResult.underProb >= 0.90) {
    plays.push({
      type: "O/U",
      description: `UNDER ${ouLine}`,
      probability: poissonResult.underProb,
      reasoning: [
        `Modelo: ${(poissonResult.underProb * 100).toFixed(1)}% prob de UNDER`,
        `Total esperado: ${poissonResult.totalExpPoints} vs línea ${ouLine}`,
      ],
      confidence: poissonResult.underProb >= 0.92 ? "ULTRA" : "HIGH",
    });
  }

  // 3. Spread at high confidence — when expected margin far exceeds spread line
  const expectedMargin = predictSpread(homeProb);
  const spreadEdge = expectedMargin - (-spreadLine); // positive = home covers
  if (Math.abs(spreadEdge) > 8) {
    // Model spread margin using normal distribution (std dev of margin ≈ 10 pts)
    const coverProb = normalCdf(spreadEdge / 10);
    if (coverProb >= 0.90) {
      const side = spreadEdge > 0 ? "Local cubre" : "Visitante cubre";
      plays.push({
        type: "Spread",
        description: `${side} (${spreadLine})`,
        probability: coverProb,
        reasoning: [
          `Margen esperado: ${expectedMargin.toFixed(1)} vs línea ${spreadLine}`,
          `Edge: ${spreadEdge.toFixed(1)} puntos`,
        ],
        confidence: coverProb >= 0.92 ? "ULTRA" : "HIGH",
      });
    }
  }

  // Return highest-confidence play at or above 90% threshold
  const safe = plays.filter(p => p.probability >= 0.90);
  if (safe.length === 0) return null;
  safe.sort((a, b) => b.probability - a.probability);
  return safe[0];
}

// ── BEST PLAY (jugada estrella) ───────────────────────────────────────────────
export interface BestPlay {
  market: "ML" | "Spread" | "O/U";
  recommendation: string;
  signal: "BET" | "LEAN" | "PASS";
  edgeLabel: string;
  confidence: number;
  reason: string;
}

function signalScore(signal: "BET" | "LEAN" | "PASS"): number {
  if (signal === "BET") return 3;
  if (signal === "LEAN") return 1;
  return 0;
}

export function getBestPlay(params: {
  homeTeam: string;
  awayTeam: string;
  mlEdge: number;
  mlSignal: "BET" | "LEAN" | "PASS";
  homeProb: number;
  spread?: { signal: "BET" | "LEAN" | "PASS"; edgeVsSpread: number; side: string } | null;
  total?: { signal: "BET" | "LEAN" | "PASS"; edge: number; side: "OVER" | "UNDER" } | null;
}): BestPlay | null {
  const { homeTeam, awayTeam, mlEdge, mlSignal, homeProb, spread, total } = params;
  const candidates: BestPlay[] = [];

  if (mlSignal !== "PASS") {
    const favTeam = homeProb >= 0.5 ? homeTeam : awayTeam;
    candidates.push({
      market: "ML",
      recommendation: `${favTeam} ML`,
      signal: mlSignal,
      edgeLabel: `Edge ${mlEdge > 0 ? "+" : ""}${mlEdge.toFixed(1)}%`,
      confidence: Math.round(Math.min(95, 50 + Math.abs(mlEdge) * 2.5)),
      reason: `Modelo asigna ${(homeProb * 100).toFixed(1)}% de probabilidad al local`,
    });
  }

  if (spread && spread.signal !== "PASS") {
    const absEdge = Math.abs(spread.edgeVsSpread);
    candidates.push({
      market: "Spread",
      recommendation: spread.side,
      signal: spread.signal,
      edgeLabel: `${spread.edgeVsSpread > 0 ? "+" : ""}${spread.edgeVsSpread.toFixed(1)} pts vs línea`,
      confidence: Math.round(Math.min(95, 50 + absEdge * 3)),
      reason: `Margen esperado supera la línea del libro por ${absEdge.toFixed(1)} puntos`,
    });
  }

  if (total && total.signal !== "PASS") {
    const absEdge = Math.abs(total.edge);
    candidates.push({
      market: "O/U",
      recommendation: total.side,
      signal: total.signal,
      edgeLabel: `${total.edge > 0 ? "+" : ""}${total.edge.toFixed(1)} pts vs línea`,
      confidence: Math.round(Math.min(95, 50 + absEdge * 2)),
      reason: `Total estimado ${total.side === "OVER" ? "supera" : "queda bajo"} la línea por ${absEdge.toFixed(1)} puntos`,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const sigDiff = signalScore(b.signal) - signalScore(a.signal);
    if (sigDiff !== 0) return sigDiff;
    return b.confidence - a.confidence;
  });

  return candidates[0];
}

// ── NBA TEAMS ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// REFEREE IMPACT — Applies referee tendencies to home probability and total
// ═══════════════════════════════════════════════════════════════════════════
export interface NBARefComposite {
  homeWinPct: number;
  overPct: number;
  paceBoost: number;
  foulRate: number;
}

/**
 * Adjusts home win probability based on referee crew tendencies.
 * Refs with home ATS > 54% slightly bump home prob, ATS < 51% nudge away.
 * Weight is modest (max ±2pp) since ref effect is small but consistent.
 */
export function applyRefAdjustment(homeProb: number, ref: NBARefComposite | null | undefined): number {
  if (!ref) return homeProb;
  const leagueAvg = 0.524;
  const delta = ref.homeWinPct - leagueAvg; // e.g. Foster = +0.044
  const adjustment = delta * 0.40; // 40% weight → max ±2pp
  return Math.max(0.05, Math.min(0.95, homeProb + adjustment));
}

/**
 * Adjusts projected total based on referee pace tendencies.
 */
export function applyRefTotalAdjustment(projectedTotal: number, ref: NBARefComposite | null | undefined): number {
  if (!ref) return projectedTotal;
  return projectedTotal + ref.paceBoost;
}

export const NBA_TEAMS = [
  "Atlanta Hawks", "Boston Celtics", "Brooklyn Nets", "Charlotte Hornets",
  "Chicago Bulls", "Cleveland Cavaliers", "Dallas Mavericks", "Denver Nuggets",
  "Detroit Pistons", "Golden State Warriors", "Houston Rockets", "Indiana Pacers",
  "LA Clippers", "Los Angeles Lakers", "Memphis Grizzlies", "Miami Heat",
  "Milwaukee Bucks", "Minnesota Timberwolves", "New Orleans Pelicans", "New York Knicks",
  "Oklahoma City Thunder", "Orlando Magic", "Philadelphia 76ers", "Phoenix Suns",
  "Portland Trail Blazers", "Sacramento Kings", "San Antonio Spurs", "Toronto Raptors",
  "Utah Jazz", "Washington Wizards",
];
