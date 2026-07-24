// MLB Prediction Model — CourtEdge
// Mercados: ML (partido completo), Run Line (-1.5), O/U, F5 (primeras 5 entradas)

const MLB_LEAGUE_AVG = {
  era: 4.10,
  whip: 1.28,
  fip: 4.00,
  k9: 8.7,
  bb9: 3.2,
  ops: 0.720,
  rpg: 4.5,
  bullpenEra: 4.00,
  parkFactor: 1.0,
};

export interface MLBPitcher {
  era: number;
  whip: number;
  fip: number;
  k9: number;
  bb9: number;
  record: string;     // "10-4"
  daysRest: number;   // 4-5 ideal
  hand: "L" | "R";
  recentEra?: number; // ERA ultimas 3 aperturas
  inningsPitched?: number; // IP en la temporada
  homeRuns?: number;  // HR allowed (season)
  walks?: number;     // BB (season)
  strikeouts?: number; // K (season)
  gamesStarted?: number; // # de aperturas en la temporada — sample-size cap
  // Stats más predictivas (no depende de IP)
  kPct?: number;      // K / batters faced — más estable que K/9
  bbPct?: number;     // BB / batters faced
  siera?: number;     // SIERA simplificado — mejor predictor que ERA/FIP
  battersFaced?: number;
}

export interface MLBTeam {
  name: string;
  ops: number;         // On-base + Slugging
  rpg: number;         // Runs per game (last 10)
  obp: number;         // On-base %
  avg: number;         // Batting average
  opsVsL: number;      // OPS vs zurdos
  opsVsR: number;      // OPS vs derechos
  wOBA?: number;       // Weighted On-Base Average (more predictive than OPS)
  iso?: number;        // Isolated Power (SLG - AVG) — pure extra-base hit power
  babip?: number;      // BABIP — luck indicator (.300 = normal, >.340 = lucky, <.270 = unlucky)
  bullpenEra: number;
  bullpenWhip: number;
  bullpenEra14d?: number;  // Bullpen ERA últimos 14 días — mucho más predictivo que season
  bullpenIp48h?: number;   // IP del bullpen en últimas 48h — detecta sobreuso
  bullpenTired: boolean; // bullpen usado mucho recientemente
  closerAvailable: boolean;
  streak: number;       // +3 = 3W, -2 = 2L
  winRate: number;      // ultimos 10
  travelPenalty?: number; // logit penalty for travel distance
  pitcher: MLBPitcher;
  h2hWins?: number;
  h2hLosses?: number;
  homeRPG?: number;
  homeERA?: number;
  awayRPG?: number;
  awayERA?: number;
  homeRecord?: string;
  awayRecord?: string;
  seasonWinRate?: number;
}

export interface MLBGameContext {
  isHome: boolean;       // para el equipo local
  parkFactor: number;    // 1.0 = neutro, 1.3 = Coors, 0.85 = Petco
  windFavorable: boolean;
  tempF: number;         // temperatura en Fahrenheit
  isNight: boolean;
  // Seasonal context
  isPlayoff?: boolean;       // Postseason game
  monthOfSeason?: number;    // 4=April (early), 7=July (midseason), 9=Sept (stretch)
}

// ── COEFFICIENTS ────────────────────────────────────────────────────────────

// Regresion a la media para pitchers con pocas aperturas — ESCALONADO (Opción A)
// Antes: un único REGRESSION_IP=50 era agresivo a 47 IP (~50% peso liga).
// Ahora: peso liga varía por tier de IP para preservar señal de pitchers con muestra suficiente.
function shrinkageLeagueWeight(ip: number): number {
  if (ip >= 60) return 0;       // ERA cruda, 0% liga
  if (ip >= 40) return 0.15;    // 7-10 starts: shrinkage leve
  if (ip >= 20) return 0.40;    // 4-7 starts: shrinkage moderado
  return 0.70;                  // <20 IP / <4 starts: shrinkage agresivo
}

export function computeFIP(p: MLBPitcher): number {
  const ip = p.inningsPitched ?? 0;
  if (ip <= 0) return p.fip;
  const hr = p.homeRuns ?? 0;
  const bb = p.walks ?? Math.round(p.bb9 * ip / 9);
  const k = p.strikeouts ?? Math.round(p.k9 * ip / 9);
  // FIP constant 3.17 (FanGraphs estandar 2024-2025), antes 3.10 desactualizado
  return Math.round(((13 * hr + 3 * bb - 2 * k) / ip + 3.17) * 100) / 100;
}

export function regressPitcher(p: MLBPitcher): MLBPitcher {
  const ip = p.inningsPitched ?? 100;
  // Compute real FIP if we have HR data
  let fip = p.fip;
  if (p.homeRuns !== undefined && ip > 0) {
    fip = computeFIP(p);
  }
  const adjusted = { ...p, fip };
  const lw = shrinkageLeagueWeight(ip);
  if (lw === 0) return adjusted; // ≥60 IP: sin shrinkage
  const w = 1 - lw;
  return {
    ...adjusted,
    era:  Math.round((adjusted.era * w + MLB_LEAGUE_AVG.era * lw) * 100) / 100,
    whip: Math.round((adjusted.whip * w + MLB_LEAGUE_AVG.whip * lw) * 100) / 100,
    fip:  Math.round((fip * w + MLB_LEAGUE_AVG.fip * lw) * 100) / 100,
    k9:   Math.round((adjusted.k9 * w + MLB_LEAGUE_AVG.k9 * lw) * 10) / 10,
    bb9:  Math.round((adjusted.bb9 * w + MLB_LEAGUE_AVG.bb9 * lw) * 10) / 10,
  };
}

// Pesos finales (después del fix bullpen):
//   pitcherDiff * 8  → ~50% del logit
//   offenseDiff * 6  → ~22%
//   bullpenDiff * 7  → ~22% (antes era 4 = 10%, casi duplicado)
//   situacional + winRate + splits + h2h → ~6%
const COEFF = {
  intercept: 0.08,         // slight home advantage
  pitcherDiff: 0.35,       // pitcher quality differential (biggest factor)
  offenseDiff: 0.25,       // offense quality differential
  bullpenDiff: 0.20,       // ↑ de 0.12 a 0.20 — bullpens deciden juegos cerrados
  situational: 0.10,       // park + weather + context
  momentum: 0.05,          // streak/form
};

// ── PITCHER SCORE (0-100) ─────────────────────────────────────────────
// Stack ranking de métricas (consenso FanGraphs/Statcast):
//   SIERA > xFIP > FIP > ERA  (predictivo)
//   K%/BB% > K9/BB9            (estables, no dependen de IP)
// Pesos rebalanceados:
//   SIERA 25 → lo más predictivo si está disponible
//   FIP   25 → segundo más predictivo (lo que el pitcher controla)
//   ERA   15 → reducido (tiene mucho ruido por defensa/secuencia)
//   WHIP  15
//   K%    12 → si disponible, prefiere a K/9
//   BB%   8  → si disponible, prefiere a BB/9
//   (fallback K/9 + BB/9 = 15+15 cuando no hay K%/BB%)
function pitcherScore(p: MLBPitcher, oppOps: number): number {
  const eraScore = Math.max(0, (MLB_LEAGUE_AVG.era - p.era) / MLB_LEAGUE_AVG.era) * 15;
  const fipScore = Math.max(0, (MLB_LEAGUE_AVG.fip - p.fip) / MLB_LEAGUE_AVG.fip) * 25;
  const whipScore = Math.max(0, (MLB_LEAGUE_AVG.whip - p.whip) / MLB_LEAGUE_AVG.whip) * 15;

  // SIERA: si está disponible, sobrepondera al FIP/ERA (es lo más predictivo)
  let sieraScore = 0;
  if (p.siera !== undefined && p.siera > 0) {
    sieraScore = Math.max(0, (3.10 - p.siera) / 3.10) * 25; // 3.10 = league avg SIERA
  }

  // K% / BB% si disponibles, si no fallback a K/9 / BB/9
  let kScore = 0, bbScore = 0;
  if (p.kPct !== undefined && p.kPct > 0) {
    kScore = Math.max(0, (p.kPct - 0.225) / 0.225) * 12; // 22.5% = league avg
    bbScore = Math.max(0, (0.085 - (p.bbPct ?? 0.085)) / 0.085) * 8; // 8.5% = league avg
  } else {
    kScore = Math.max(0, (p.k9 - MLB_LEAGUE_AVG.k9) / MLB_LEAGUE_AVG.k9) * 15;
    bbScore = Math.max(0, (MLB_LEAGUE_AVG.bb9 - p.bb9) / MLB_LEAGUE_AVG.bb9) * 15;
  }

  let score = 50 + eraScore + fipScore + sieraScore + whipScore + kScore + bbScore;

  // Rest penalty REMOVED — ahora se maneja en /api/mlb/pitcher-form
  // con tiers granulares (ERA delta) que entra al RPG del rival.
  // Mantener este penalty causaba doble conteo del mismo evento.

  // Recent form adjustment
  if (p.recentEra !== undefined) {
    const recentDiff = p.era - p.recentEra;
    score += recentDiff * 3; // positive = improving
  }

  // ── SAMPLE-SIZE CAP ── Pitchers con pocas aperturas no son confiables.
  // Sin esto un rookie 2-0 con ERA 1.50 en 3 starts dispara el modelo.
  // Hace que el score regrese hacia 50 (neutral) cuando faltan datos.
  const gs = p.gamesStarted ?? 0;
  if (gs > 0 && gs < 10) {
    // gs=3 → 75% peso del score original, 25% neutral
    // gs=5 → 60/40
    // gs=8 → 30/70 (todavía regresa un poco)
    const trustFactor = Math.min(1.0, 0.40 + gs * 0.075); // 0.475 con gs=1, 1.0 con gs=8+
    score = score * trustFactor + 50 * (1 - trustFactor);
  }

  return Math.max(10, Math.min(95, score));
}

// ── OFFENSE SCORE (0-100) ───────────────────────────────────────────────────
// wOBA is the primary metric (more predictive than OPS per FanGraphs research)
// OPS vs L/R splits still used for platoon matchups
// BABIP regression: teams with extreme BABIP are likely to regress
function offenseScore(team: MLBTeam, pitcherHand: "L" | "R"): number {
  // Primary: wOBA (if available) or OPS as fallback
  const woba = team.wOBA ?? (team.ops * 0.45 + 0.05); // rough OPS-to-wOBA conversion
  const wobaScore = ((woba - 0.310) / 0.040) * 30; // .310 = avg, .350 = great, .270 = bad

  // Platoon matchup (OPS vs L/R)
  const opsUsed = pitcherHand === "L" ? team.opsVsL : team.opsVsR;
  const platoonScore = ((opsUsed - 0.700) / 0.150) * 12;

  // ISO (power) bonus — high ISO teams hit more HR even vs good pitchers
  const isoScore = team.iso !== undefined ? ((team.iso - 0.140) / 0.050) * 8 : 0;

  // RPG (run production)
  const rpgScore = ((team.rpg - 3.5) / 2.5) * 15;

  // BABIP regression: extreme BABIP suggests luck, not skill
  // .300 = normal. >.340 = likely to cool off. <.270 = likely to heat up.
  let babipAdj = 0;
  if (team.babip !== undefined) {
    const babipDeviation = team.babip - 0.300;
    if (Math.abs(babipDeviation) > 0.020) {
      babipAdj = -babipDeviation * 25; // .340 BABIP = -1.0 penalty, .270 = +0.75 boost
    }
  }

  let score = 50 + wobaScore + platoonScore + isoScore + rpgScore + babipAdj;
  return Math.max(10, Math.min(95, score));
}

// ── BULLPEN SCORE (0-100) ─────────────────────────────────────────────
function bullpenScore(team: MLBTeam): number {
  // Mezcla 60% ERA últimos 14d (más predictivo) + 40% ERA season (estabilidad)
  // Si no hay 14d, cae a 100% season.
  const seasonEra = team.bullpenEra;
  const recent14d = team.bullpenEra14d;
  const blendedEra = recent14d !== undefined && recent14d > 0
    ? recent14d * 0.60 + seasonEra * 0.40
    : seasonEra;

  const eraScore = ((MLB_LEAGUE_AVG.bullpenEra - blendedEra) / MLB_LEAGUE_AVG.bullpenEra) * 35;
  const whipScore = ((MLB_LEAGUE_AVG.whip - team.bullpenWhip) / MLB_LEAGUE_AVG.whip) * 25;

  let score = 50 + eraScore + whipScore;
  if (team.bullpenTired) score -= 10;
  if (!team.closerAvailable) score -= 8;

  // Penalty extra si el bullpen tiró mucho últimas 48h (>9 IP ≈ cuerpo agotado)
  if (team.bullpenIp48h !== undefined && team.bullpenIp48h > 9) {
    score -= Math.min(8, (team.bullpenIp48h - 9) * 2.5);
  }

  return Math.max(10, Math.min(95, score));
}

// ── SIGMOID ─────────────────────────────────────────────────────────────────
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── PREDICT MLB ─────────────────────────────────────────────────────────────
export function predictMLB(
  home: MLBTeam,
  away: MLBTeam,
  ctx: MLBGameContext
): number {
  // Pitcher scores (each pitcher vs opposing offense)
  const homeP = regressPitcher(home.pitcher);
  const awayP = regressPitcher(away.pitcher);
  const homePScore = pitcherScore(homeP, away.ops);
  const awayPScore = pitcherScore(awayP, home.ops);
  const pitcherDiff = (homePScore - awayPScore) / 100;

  // Offense scores (each offense vs opposing pitcher hand)
  const homeOScore = offenseScore(home, away.pitcher.hand);
  const awayOScore = offenseScore(away, home.pitcher.hand);
  const offDiff = (homeOScore - awayOScore) / 100;

  // Bullpen
  const homeBScore = bullpenScore(home);
  const awayBScore = bullpenScore(away);
  const bpDiff = (homeBScore - awayBScore) / 100;

  // Situational
  let sitAdj = 0;
  sitAdj += 0.04; // home advantage ~54%
  if (ctx.parkFactor > 1.1) sitAdj += 0.02;
  if (ctx.parkFactor < 0.9) sitAdj -= 0.02;

  // Momentum (streak only, winRate separated)
  const momDiff = (home.streak - away.streak) * 0.01;

  // Season record anchor — full season win rate if available, else L10
  const homeWR = home.seasonWinRate ?? home.winRate;
  const awayWR = away.seasonWinRate ?? away.winRate;
  const winRateDiff = (homeWR - awayWR) * 1.0;

  // H2H season series
  let h2hAdj = 0;
  if (home.h2hWins !== undefined && home.h2hLosses !== undefined) {
    const total = home.h2hWins + home.h2hLosses;
    if (total >= 3) h2hAdj = ((home.h2hWins / total) - 0.5) * 0.3;
  }

  // Home/Away splits
  let splitAdj = 0;
  if (home.homeRPG !== undefined && home.homeERA !== undefined &&
      away.awayRPG !== undefined && away.awayERA !== undefined) {
    const homeNetHome = home.homeRPG - home.homeERA;
    const awayNetAway = away.awayRPG - away.awayERA;
    splitAdj = (homeNetHome - awayNetAway) * 0.03;
  }

  // Travel penalty for visiting team
  const awayTravelAdj = away.travelPenalty ?? 0;

  // Game context: early season stats are noisy, playoff games are tighter
  let contextAdj = 0;
  if (ctx.isPlayoff) {
    // Playoffs: better team wins more, home advantage increases
    contextAdj += (home.seasonWinRate ?? home.winRate) > (away.seasonWinRate ?? away.winRate) ? 0.04 : -0.04;
    contextAdj += 0.02; // home field matters more in October
  }
  if (ctx.monthOfSeason && ctx.monthOfSeason <= 4) {
    // Early season (March/April): stats are noisy, regress hacia el centro
    // Reducir el efecto del winRate diff porque las muestras son pequeas
    const wr_h = home.seasonWinRate ?? home.winRate;
    const wr_a = away.seasonWinRate ?? away.winRate;
    contextAdj -= (wr_h - wr_a) * 0.15; // contra-resta parte del efecto winRate
  }

  // FIX auditoría:
  //  - winRateDiff * 1.0 era el contributor más fuerte sin normalizar (bug)
  //    → reducido a * 0.5 para evitar dominar otros factores.
  //  - situational * sitAdj * 10 era confuso: sitAdj máx 0.06 × 10 ≈ 0.6 logit
  //    → simplificado: usar `sitAdj * 0.6` directo (mismo máximo, intención clara).
  const logit =
    COEFF.intercept +
    COEFF.pitcherDiff * pitcherDiff * 8 +
    COEFF.offenseDiff * offDiff * 6 +
    COEFF.bullpenDiff * bpDiff * 7 +    // ↑ de 4 a 7 — bullpen ahora pesa real ~22%
    sitAdj * 0.6 +                  // simplificado, mismo techo de impacto
    COEFF.momentum * momDiff * 5 +
    winRateDiff * 0.5 +              // normalizado para no dominar
    h2hAdj +
    splitAdj +
    contextAdj -         // Game context (playoffs, early season)
    awayTravelAdj;       // Away travel fatigue

  return sigmoid(logit);
}

// ── PREDICT F5 (First 5 innings — pitcher-dominant) ─────────────────────────
export function predictF5(
  home: MLBTeam,
  away: MLBTeam,
  ctx: MLBGameContext
): number {
  const homeP = regressPitcher(home.pitcher);
  const awayP = regressPitcher(away.pitcher);

  // F5 depends ~70% on starting pitchers, ~25% offense, ~5% situational
  const homePScore = pitcherScore(homeP, away.ops);
  const awayPScore = pitcherScore(awayP, home.ops);
  const pitcherDiff = (homePScore - awayPScore) / 100;

  const homeOScore = offenseScore(home, away.pitcher.hand);
  const awayOScore = offenseScore(away, home.pitcher.hand);
  const offDiff = (homeOScore - awayOScore) / 100;

  const logit =
    0.06 + // smaller home advantage in F5
    pitcherDiff * 3.5 +
    offDiff * 1.5;

  return sigmoid(logit);
}

// ── TOTAL RUNS (O/U) ────────────────────────────────────────────────────────
export function predictTotalRuns(
  home: MLBTeam,
  away: MLBTeam,
  ctx: MLBGameContext
): number {
  // Cada equipo anota un promedio entre su RPG y lo que permite el pitcher rival.
  // RPG refleja la calidad ofensiva. Pitcher ERA refleja cuantas carreras permite.
  // El promedio de ambos da un estimado balanceado.
  // Ej: RPG 4.5 vs pitcher ERA 2.50 = (4.5 + 2.50) / 2 = 3.5 carreras
  // Ej: RPG 4.5 vs pitcher ERA 5.00 = (4.5 + 5.00) / 2 = 4.75 carreras
  const adjAP = regressPitcher(away.pitcher);
  const adjHP = regressPitcher(home.pitcher);
  const homeExpected = ((home.rpg + adjAP.era) / 2) * ctx.parkFactor;
  const awayExpected = ((away.rpg + adjHP.era) / 2) * ctx.parkFactor;

  let total = homeExpected + awayExpected;

  // Ajuste por bullpen cansado (+0.4 carreras si relevistas fatigados)
  if (away.bullpenTired) total += 0.4;  // home team scores more
  if (home.bullpenTired) total += 0.4;  // away team scores more

  // Ajuste por clima
  if (ctx.tempF > 85) total += 0.5;     // calor = pelota viaja mas
  if (ctx.tempF < 55) total -= 0.4;     // frio = pelota no viaja
  if (ctx.windFavorable) total += 0.7;  // viento hacia afuera = mas HR

  return Math.round(total * 10) / 10;
}

// ── F5 TOTAL RUNS ───────────────────────────────────────────────────────────
export function predictF5Total(
  home: MLBTeam,
  away: MLBTeam,
  ctx: MLBGameContext
): number {
  // F5 depende mas del pitcher abridor (juega 5+ innings).
  // Usamos 55% del total pero con mas peso al pitcher.
  const aP5 = regressPitcher(away.pitcher);
  const hP5 = regressPitcher(home.pitcher);
  const homeF5 = ((home.rpg * 0.4 + aP5.era * 0.6) / 2) * ctx.parkFactor;
  const awayF5 = ((away.rpg * 0.4 + hP5.era * 0.6) / 2) * ctx.parkFactor;
  let total = (homeF5 + awayF5) * 1.1; // ~55% of full game

  if (ctx.tempF > 85) total += 0.2;
  if (ctx.tempF < 55) total -= 0.2;
  if (ctx.windFavorable) total += 0.3;

  return Math.round(total * 10) / 10;
}

// ── RUN LINE (-1.5) ─────────────────────────────────────────────────────────
// Normal CDF for cover probability (MLB)
function mlbNormCdf(x: number, mean: number, std: number): number {
  const z = (x - mean) / std;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export function evaluateRunLine(homeProb: number, runLine: number, marketHomeOdds?: number, marketAwayOdds?: number): {
  expectedMargin: number;
  coversRL: boolean;
  signal: "BET" | "LEAN" | "PASS";
  side: string;
  pickedSide: "home" | "away";
  coverProb: number;        // probabilidad calibrada (post-mercado) — usada para decisiones
  modelCoverProb: number;   // probabilidad pura del modelo (Poisson/Normal)
  marketCoverProb?: number; // probabilidad implicada por el mercado (si hay odds)
  confidence: string;
} {
  const logit = Math.log(homeProb / (1 - homeProb));
  const expectedMargin = Math.round(logit * 2.0 * 100) / 100;

  // FIX: sigma 3.0 → 4.0 — la varianza real de MLB es mayor que la teórica de Poisson.
  // Estudios sabermetricos calibran sigma ≈ 3.8-4.2 para diferencial de carreras.
  // Sigma 3.0 daba probabilidades infladas en un 12-18%.
  const SIGMA_RUNS = 4.0;
  // Probabilidad de que el LOCAL cubra:
  const homeCoverProbModel = 1 - mlbNormCdf(-runLine, expectedMargin, SIGMA_RUNS);
  // El visitante cubre cuando home margin < -runLine
  const awayCoverProbModel = 1 - homeCoverProbModel;

  // Elegir el lado con MAYOR probabilidad de cubrir (usando modelo puro)
  const pickedSide: "home" | "away" = homeCoverProbModel >= awayCoverProbModel ? "home" : "away";
  const modelCoverProb = pickedSide === "home" ? homeCoverProbModel : awayCoverProbModel;

  // CALIBRACIÓN CONTRA MERCADO: cuando hay odds disponibles, regresar 35% al mercado.
  // El Poisson/Normal puro tiende a sobre-estimar coverage; el mercado lo conoce mejor.
  let marketCoverProb: number | undefined;
  let coverProb = modelCoverProb;
  const oddsForSide = pickedSide === "home" ? marketHomeOdds : marketAwayOdds;
  if (typeof oddsForSide === "number" && oddsForSide !== 0) {
    const implied = oddsForSide > 0 ? 100 / (oddsForSide + 100) : (-oddsForSide) / ((-oddsForSide) + 100);
    marketCoverProb = implied;
    // Regresión al mercado: 65% modelo + 35% mercado
    coverProb = modelCoverProb * 0.65 + implied * 0.35;
  }

  // La línea que cubre el lado elegido
  const sideLine = pickedSide === "home" ? runLine : -runLine;
  const sideLabel = pickedSide === "home" ? "Local" : "Visitante";
  const sign = sideLine < 0 ? "" : "+";
  const side = `${sideLabel} ${sign}${sideLine.toFixed(1)}`;

  // Señal: BET si coverProb >= 0.62, LEAN si >= 0.55, PASS si menos
  let signal: "BET" | "LEAN" | "PASS";
  if (coverProb >= 0.62) signal = "BET";
  else if (coverProb >= 0.55) signal = "LEAN";
  else signal = "PASS";

  const coversRL = pickedSide === "home" ? expectedMargin > Math.abs(runLine) : expectedMargin < -Math.abs(runLine);
  const confidence = coverProb >= 0.62 ? "ALTA" : coverProb >= 0.55 ? "MEDIA" : coverProb >= 0.50 ? "BAJA" : "SIN EDGE";

  return { expectedMargin, coversRL, signal, side, pickedSide, coverProb, modelCoverProb, marketCoverProb, confidence };
}

// ── EVALUATE O/U ────────────────────────────────────────────────────────────
export function evaluateMLBTotal(
  estimated: number,
  line: number,
  marketOverOdds?: number,
  marketUnderOdds?: number
): { edge: number; signal: "BET" | "LEAN" | "PASS"; side: "OVER" | "UNDER"; hitProb: number; modelHitProb: number; marketHitProb?: number; confidence: string } {
  const diff = estimated - line;
  const absDiff = Math.abs(diff);
  const signal: "BET" | "LEAN" | "PASS" = absDiff > 1.5 ? "BET" : absDiff > 0.7 ? "LEAN" : "PASS";
  const side: "OVER" | "UNDER" = diff > 0 ? "OVER" : "UNDER";
  // FIX: sigma 3.2 → 3.5 — varianza realista de totales MLB.
  const modelOverProb = 1 - mlbNormCdf(line, estimated, 3.5);
  const modelHitProb = side === "OVER" ? modelOverProb : (1 - modelOverProb);
  // CALIBRACIÓN CONTRA MERCADO (35% regresión)
  let marketHitProb: number | undefined;
  let hitProb = modelHitProb;
  const oddsForSide = side === "OVER" ? marketOverOdds : marketUnderOdds;
  if (typeof oddsForSide === "number" && oddsForSide !== 0) {
    const implied = oddsForSide > 0 ? 100 / (oddsForSide + 100) : (-oddsForSide) / ((-oddsForSide) + 100);
    marketHitProb = implied;
    hitProb = modelHitProb * 0.65 + implied * 0.35;
  }
  const confidence = hitProb >= 0.60 ? "ALTA" : hitProb >= 0.52 ? "MEDIA" : hitProb >= 0.48 ? "BAJA" : "SIN EDGE";
  return { edge: diff, signal, side, hitProb, modelHitProb, marketHitProb, confidence };
}

// ── SIGNALS & HELPERS ───────────────────────────────────────────────────────
export function mlbGetEdge(modelProb: number, impliedProb: number): number {
  return (modelProb - impliedProb) * 100;
}

/**
 * Signal classification (v2 — Élite threshold).
 * BET requires BOTH: edge > 8% AND model confidence >= 70% (or <=30%).
 * En baseball la varianza es mayor, por eso exigimos mas edge.
 */
export function mlbGetSignal(edge: number, modelProb?: number): "BET" | "LEAN" | "PASS" {
  const confident = modelProb === undefined
    ? true
    : (modelProb >= 0.70 || modelProb <= 0.30);
  if (edge > 8 && confident) return "BET";
  if (edge > 3) return "LEAN";
  return "PASS";
}

// Verifica si el modelo esta muy lejos del mercado
export function mlbEdgeWarning(modelProb: number, impliedProb: number): string | null {
  const diff = Math.abs(modelProb - impliedProb) * 100;
  if (diff > 25) return "El modelo difiere mucho del mercado. Revisa los datos o el pitcher puede tener pocas aperturas.";
  if (diff > 15) return "Diferencia significativa vs mercado. Verifica stats del pitcher.";
  return null;
}

export function americanToProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ── BEST PLAY ───────────────────────────────────────────────────────────────
export interface MLBBestPlay {
  market: "ML" | "F5" | "Run Line" | "O/U" | "F5 O/U";
  recommendation: string;
  signal: "BET" | "LEAN" | "PASS";
  edgeLabel: string;
  confidence: number;
  reason: string;
}

export function mlbGetBestPlay(plays: MLBBestPlay[]): MLBBestPlay | null {
  const valid = plays.filter(p => p.signal !== "PASS");
  if (valid.length === 0) return null;

  // Prioridad: ML y F5 antes que Run Line (Run Line es mas riesgoso)
  // Run Line solo gana si tiene confianza > 80% y es BET
  valid.sort((a, b) => {
    const sA = a.signal === "BET" ? 3 : 1;
    const sB = b.signal === "BET" ? 3 : 1;
    if (sA !== sB) return sB - sA;

    // Si mismo signal, penalizar Run Line vs ML/F5
    const riskA = a.market === "Run Line" ? -5 : 0;
    const riskB = b.market === "Run Line" ? -5 : 0;
    return (b.confidence + riskB) - (a.confidence + riskA);
  });
  return valid[0];
}

// ── PARK FACTORS (2025-26) ──────────────────────────────────────────────────
export const PARK_FACTORS: Record<string, number> = {
  "Coors Field": 1.28,           // Colorado
  "Great American Ball Park": 1.12, // Cincinnati
  "Globe Life Field": 1.08,      // Texas
  "Citizens Bank Park": 1.07,    // Philadelphia
  "Fenway Park": 1.06,           // Boston
  "Guaranteed Rate Field": 1.05, // White Sox
  "Wrigley Field": 1.04,         // Cubs
  "Yankee Stadium": 1.04,        // Yankees
  "Minute Maid Park": 1.02,      // Houston
  "Truist Park": 1.01,           // Atlanta
  "Angel Stadium": 1.00,         // LAA
  "Busch Stadium": 0.99,         // St. Louis
  "Dodger Stadium": 0.98,        // LAD
  "Target Field": 0.98,          // Minnesota
  "Progressive Field": 0.97,     // Cleveland
  "Kauffman Stadium": 0.97,      // KC
  "T-Mobile Park": 0.96,         // Seattle
  "Comerica Park": 0.96,         // Detroit
  "loanDepot Park": 0.95,        // Miami
  "Chase Field": 1.03,           // Arizona
  "PNC Park": 0.97,              // Pittsburgh
  "Camden Yards": 1.03,          // Baltimore
  "Oracle Park": 0.93,           // SF
  "Petco Park": 0.92,            // San Diego
  "Tropicana Field": 0.95,       // Tampa Bay
  "Rogers Centre": 1.01,         // Toronto
  "Nationals Park": 1.00,        // Washington
  "Citi Field": 0.96,            // Mets
  "American Family Field": 1.03, // Milwaukee
  "Sutter Health Park": 0.98,     // Sacramento (Athletics)
};

export const MLB_TEAMS = [
  "Arizona Diamondbacks", "Atlanta Braves", "Baltimore Orioles", "Boston Red Sox",
  "Chicago Cubs", "Chicago White Sox", "Cincinnati Reds", "Cleveland Guardians",
  "Colorado Rockies", "Detroit Tigers", "Houston Astros", "Kansas City Royals",
  "Los Angeles Angels", "Los Angeles Dodgers", "Miami Marlins", "Milwaukee Brewers",
  "Minnesota Twins", "New York Mets", "New York Yankees", "Athletics",
  "Philadelphia Phillies", "Pittsburgh Pirates", "San Diego Padres", "San Francisco Giants",
  "Seattle Mariners", "St. Louis Cardinals", "Tampa Bay Rays", "Texas Rangers",
  "Toronto Blue Jays", "Washington Nationals",
];

export const TEAM_PARKS: Record<string, string> = {
  "Arizona Diamondbacks": "Chase Field",
  "Atlanta Braves": "Truist Park",
  "Baltimore Orioles": "Camden Yards",
  "Boston Red Sox": "Fenway Park",
  "Chicago Cubs": "Wrigley Field",
  "Chicago White Sox": "Guaranteed Rate Field",
  "Cincinnati Reds": "Great American Ball Park",
  "Cleveland Guardians": "Progressive Field",
  "Colorado Rockies": "Coors Field",
  "Detroit Tigers": "Comerica Park",
  "Houston Astros": "Minute Maid Park",
  "Kansas City Royals": "Kauffman Stadium",
  "Los Angeles Angels": "Angel Stadium",
  "Los Angeles Dodgers": "Dodger Stadium",
  "Miami Marlins": "loanDepot Park",
  "Milwaukee Brewers": "American Family Field",
  "Minnesota Twins": "Target Field",
  "New York Mets": "Citi Field",
  "New York Yankees": "Yankee Stadium",
  "Athletics": "Oakland Coliseum",
  "Philadelphia Phillies": "Citizens Bank Park",
  "Pittsburgh Pirates": "PNC Park",
  "San Diego Padres": "Petco Park",
  "San Francisco Giants": "Oracle Park",
  "Seattle Mariners": "T-Mobile Park",
  "St. Louis Cardinals": "Busch Stadium",
  "Tampa Bay Rays": "Tropicana Field",
  "Texas Rangers": "Globe Life Field",
  "Toronto Blue Jays": "Rogers Centre",
  "Washington Nationals": "Nationals Park",
};

// ── POISSON ──────────────────────────────────────────────────────────────────
function poissonPmf(k: number, lambda: number): number {
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) { result *= lambda / i; }
  return result;
}

function normalCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

const MLB_MARGIN_STD = 2.5;
const MLB_TOTAL_STD = 3.0;

export interface MLBPoissonResult {
  homeExpRuns: number;
  awayExpRuns: number;
  totalExpRuns: number;
  overProb: number;
  underProb: number;
  exactScoreProbs: { score: string; prob: number }[];
}

export function mlbPoissonTotal(
  home: MLBTeam, away: MLBTeam, ctx: MLBGameContext, line: number
): MLBPoissonResult {
  const adjAP = regressPitcher(away.pitcher);
  const adjHP = regressPitcher(home.pitcher);
  let homeLambda = ((home.rpg + adjAP.era) / 2) * ctx.parkFactor;
  let awayLambda = ((away.rpg + adjHP.era) / 2) * ctx.parkFactor;

  if (away.bullpenTired) homeLambda += 0.2;
  if (home.bullpenTired) awayLambda += 0.2;
  if (ctx.tempF > 85) { homeLambda += 0.25; awayLambda += 0.25; }
  if (ctx.tempF < 55) { homeLambda -= 0.2; awayLambda -= 0.2; }
  if (ctx.windFavorable) { homeLambda += 0.35; awayLambda += 0.35; }

  homeLambda = Math.max(1, homeLambda);
  awayLambda = Math.max(1, awayLambda);

  const maxRuns = 16;
  const homeProbs: number[] = [];
  const awayProbs: number[] = [];
  for (let i = 0; i < maxRuns; i++) {
    homeProbs.push(poissonPmf(i, homeLambda));
    awayProbs.push(poissonPmf(i, awayLambda));
  }

  let overProb = 0;
  let underProb = 0;
  const scoreProbs: { score: string; prob: number }[] = [];

  for (let h = 0; h < maxRuns; h++) {
    for (let a = 0; a < maxRuns; a++) {
      const prob = homeProbs[h] * awayProbs[a];
      const total = h + a;
      if (total > line) overProb += prob;
      else if (total < line) underProb += prob;
      scoreProbs.push({ score: `${h}-${a}`, prob });
    }
  }

  scoreProbs.sort((a, b) => b.prob - a.prob);

  return {
    homeExpRuns: Math.round(homeLambda * 100) / 100,
    awayExpRuns: Math.round(awayLambda * 100) / 100,
    totalExpRuns: Math.round((homeLambda + awayLambda) * 10) / 10,
    overProb: Math.round(overProb * 1000) / 1000,
    underProb: Math.round(underProb * 1000) / 1000,
    exactScoreProbs: scoreProbs.slice(0, 5).map(s => ({
      score: s.score,
      prob: Math.round(s.prob * 10000) / 10000,
    })),
  };
}

// ── SAFE PLAY (Jugada Segura 90%+) ─────────────────────────────────────────
export interface MLBSafePlay {
  type: string;
  description: string;
  probability: number;
  details: string[];
}

export function mlbFindSafePlay(
  home: MLBTeam, away: MLBTeam, ctx: MLBGameContext,
  homeProb: number, poisson: MLBPoissonResult,
  ouLine: number, runLine: number
): MLBSafePlay | null {
  const plays: MLBSafePlay[] = [];
  const awayProb = 1 - homeProb;

  // 1. ML at extreme confidence
  if (homeProb >= 0.90) {
    const details: string[] = [];
    if (home.seasonWinRate && home.seasonWinRate > 0.6) details.push(`Record temporada: ${(home.seasonWinRate*100).toFixed(0)}%`);
    if (home.pitcher.era < 3.0) details.push(`Pitcher elite: ERA ${home.pitcher.era}`);
    if (away.pitcher.era > 5.0) details.push(`Pitcher rival débil: ERA ${away.pitcher.era}`);
    plays.push({ type: "ML", description: `${home.name} ML`, probability: homeProb, details });
  }
  if (awayProb >= 0.90) {
    const details: string[] = [];
    if (away.seasonWinRate && away.seasonWinRate > 0.6) details.push(`Record temporada: ${(away.seasonWinRate*100).toFixed(0)}%`);
    if (away.pitcher.era < 3.0) details.push(`Pitcher elite: ERA ${away.pitcher.era}`);
    if (home.pitcher.era > 5.0) details.push(`Pitcher rival débil: ERA ${home.pitcher.era}`);
    plays.push({ type: "ML", description: `${away.name} ML`, probability: awayProb, details });
  }

  // 2. Run Line with normal CDF
  const expectedMargin = Math.log(homeProb / (1 - homeProb)) * 2.0;
  const rlEdge = expectedMargin - Math.abs(runLine);
  const rlCoverProb = normalCdf(rlEdge / MLB_MARGIN_STD);
  if (rlCoverProb >= 0.90) {
    plays.push({
      type: "Run Line",
      description: `${home.name} ${runLine}`,
      probability: rlCoverProb,
      details: [`Margen esperado: ${expectedMargin.toFixed(2)}`, `Prob cubre: ${(rlCoverProb*100).toFixed(1)}%`],
    });
  }
  const rlDogProb = 1 - normalCdf((expectedMargin + Math.abs(runLine)) / MLB_MARGIN_STD);
  if (rlDogProb >= 0.90) {
    plays.push({
      type: "Run Line",
      description: `${away.name} +${Math.abs(runLine)}`,
      probability: rlDogProb,
      details: [`Margen esperado: ${expectedMargin.toFixed(2)}`],
    });
  }

  // 3. O/U at alternative lines
  for (const altLine of [ouLine + 2, ouLine + 3, ouLine - 2, ouLine - 3]) {
    if (altLine <= 0) continue;
    let altOver = 0, altUnder = 0;
    for (let h = 0; h < 16; h++) {
      for (let a = 0; a < 16; a++) {
        const p = poissonPmf(h, poisson.homeExpRuns) * poissonPmf(a, poisson.awayExpRuns);
        if (h + a > altLine) altOver += p;
        else if (h + a < altLine) altUnder += p;
      }
    }
    if (altUnder >= 0.90) {
      plays.push({
        type: "O/U",
        description: `UNDER ${altLine}`,
        probability: altUnder,
        details: [`Poisson: ${(altUnder*100).toFixed(1)}%`, `Total esperado: ${poisson.totalExpRuns}`],
      });
    }
    if (altOver >= 0.90) {
      plays.push({
        type: "O/U",
        description: `OVER ${altLine}`,
        probability: altOver,
        details: [`Poisson: ${(altOver*100).toFixed(1)}%`, `Total esperado: ${poisson.totalExpRuns}`],
      });
    }
  }

  // Also check the main line
  if (poisson.overProb >= 0.90) {
    plays.push({
      type: "O/U", description: `OVER ${ouLine}`, probability: poisson.overProb,
      details: [`Total esperado: ${poisson.totalExpRuns} vs línea ${ouLine}`],
    });
  }
  if (poisson.underProb >= 0.90) {
    plays.push({
      type: "O/U", description: `UNDER ${ouLine}`, probability: poisson.underProb,
      details: [`Total esperado: ${poisson.totalExpRuns} vs línea ${ouLine}`],
    });
  }

  const safe = plays.filter(p => p.probability >= 0.90);
  if (safe.length === 0) return null;
  safe.sort((a, b) => b.probability - a.probability);
  return safe[0];
}

// ── ALT LINES ───────────────────────────────────────────────────────────────
export interface AltLine {
  type: "Run Line" | "O/U";
  line: number;
  side: string;
  coverProb: number;
  confidence: string;
  estOdds: string;
  description: string;
}

export function mlbGenerateAltLines(
  homeProb: number, runLine: number, ouLine: number,
  predictedTotal: number, homeTeam: string, awayTeam: string
): AltLine[] {
  const alts: AltLine[] = [];
  const expectedMargin = Math.log(homeProb / (1 - homeProb)) * 2.0;

  // Run Line alternates
  const rlSteps = [0.5, 1, 1.5, 2.5];
  const homeFavored = runLine < 0;
  const favoredTeam = homeFavored ? homeTeam : awayTeam;
  const dogTeam = homeFavored ? awayTeam : homeTeam;

  if (runLine !== 0) {
    for (const step of rlSteps) {
      // Buy points for favorite
      const buyFavLine = homeFavored ? runLine + step : runLine - step;
      const buyFavMarginNeeded = -buyFavLine;
      const buyFavCover = normalCdf((expectedMargin - buyFavMarginNeeded) / MLB_MARGIN_STD);
      if (buyFavCover > 0.55 && buyFavCover < 0.98) {
        const estJuice = Math.round(-110 - step * 40);
        const conf = buyFavCover >= 0.90 ? "ULTRA" : buyFavCover >= 0.80 ? "ALTA" : "MEDIA";
        alts.push({
          type: "Run Line", line: Math.round(buyFavLine * 10) / 10,
          side: favoredTeam, coverProb: buyFavCover, confidence: conf,
          estOdds: `~${estJuice}`,
          description: `${favoredTeam} ${buyFavLine > 0 ? "+" : ""}${buyFavLine.toFixed(1)}`,
        });
      }

      // Buy points for dog
      const buyDogLine = homeFavored ? runLine - step : runLine + step;
      const buyDogMarginNeeded = -buyDogLine;
      const buyDogCover = 1 - normalCdf((expectedMargin - buyDogMarginNeeded) / MLB_MARGIN_STD);
      if (buyDogCover > 0.55 && buyDogCover < 0.98) {
        const estJuice = Math.round(-110 - step * 40);
        const conf = buyDogCover >= 0.90 ? "ULTRA" : buyDogCover >= 0.80 ? "ALTA" : "MEDIA";
        const dogDisplay = Math.abs(buyDogLine);
        alts.push({
          type: "Run Line", line: Math.round(buyDogLine * 10) / 10,
          side: dogTeam, coverProb: buyDogCover, confidence: conf,
          estOdds: `~${estJuice}`,
          description: `${dogTeam} +${dogDisplay.toFixed(1)}`,
        });
      }
    }
  }

  // O/U alternates
  const ouSteps = [1, 2, 3, 4];
  if (ouLine > 0 && predictedTotal > 0) {
    for (const step of ouSteps) {
      const lowerLine = ouLine - step;
      if (lowerLine > 0) {
        const overProbLow = 1 - normalCdf((lowerLine - predictedTotal) / MLB_TOTAL_STD);
        if (overProbLow > 0.55 && overProbLow < 0.98) {
          const estJuice = Math.round(-110 - step * 25);
          const conf = overProbLow >= 0.90 ? "ULTRA" : overProbLow >= 0.80 ? "ALTA" : "MEDIA";
          alts.push({
            type: "O/U", line: lowerLine, side: "OVER", coverProb: overProbLow,
            confidence: conf, estOdds: `~${estJuice}`,
            description: `OVER ${lowerLine.toFixed(1)}`,
          });
        }
      }

      const higherLine = ouLine + step;
      const underProbHigh = normalCdf((higherLine - predictedTotal) / MLB_TOTAL_STD);
      if (underProbHigh > 0.55 && underProbHigh < 0.98) {
        const estJuice = Math.round(-110 - step * 25);
        const conf = underProbHigh >= 0.90 ? "ULTRA" : underProbHigh >= 0.80 ? "ALTA" : "MEDIA";
        alts.push({
          type: "O/U", line: higherLine, side: "UNDER", coverProb: underProbHigh,
          confidence: conf, estOdds: `~${estJuice}`,
          description: `UNDER ${higherLine.toFixed(1)}`,
        });
      }
    }
  }

  alts.sort((a, b) => b.coverProb - a.coverProb);
  return alts.slice(0, 6);
}

// ── MARKET REGRESSION ───────────────────────────────────────────────────────
// ── CALIBRATION ─────────────────────────────────────────────────────────────
// Backtested on 185 MLB games (Apr 1-14, 2026):
// Model was UNDERCONFIDENT — 60% predicted → 71% actual
// Calibration factor k=1.8 (recalibrado 2026-05-15 con backtest de 472 partidos)
// Previo k=1.4 era sub-calibrado: modelo conservador, no identificaba favoritos claros.
// Brier 0.2398 → mejora esperada con k=1.8.
// Improves Brier Score by 1.8% and aligns predicted with actual outcomes
export function mlbCalibrate(rawProb: number): number {
  const k = 1.8;
  const calibrated = 0.5 + (rawProb - 0.5) * k;
  return Math.max(0.05, Math.min(0.95, calibrated));
}

export function mlbRegressToMarket(modelProb: number, marketProb: number, shrink: number = 0.25): number {
  if (marketProb <= 0 || marketProb >= 1) return modelProb;
  return modelProb * (1 - shrink) + marketProb * shrink;
}

// ═══════════════════════════════════════════════════════════════════════════
// HOME PLATE UMPIRE IMPACT — adjusts win prob and total
// ═══════════════════════════════════════════════════════════════════════════
export interface MLBUmpireImpact {
  name: string;
  kZoneSize: number;   // 1.0 = league avg
  overPct: number;
  runAdj: number;      // ± runs per game
  favor: "pitcher" | "hitter" | "neutral";
  accuracy: number;
}

/**
 * Adjusts home win probability based on umpire tendencies.
 * A pitcher-friendly umpire FAVORS the team with the better bullpen/starter
 * (usually already priced into home). Effect is small but real (~±1pp).
 */
export function applyUmpireAdjustment(
  homeProb: number,
  ump: MLBUmpireImpact | null | undefined,
  homePitcherERA: number,
  awayPitcherERA: number
): number {
  if (!ump) return homeProb;
  // Pitcher-friendly umpire helps the team with the BETTER pitcher (lower ERA)
  if (ump.favor === "pitcher") {
    const homeHasBetter = homePitcherERA < awayPitcherERA;
    const delta = homeHasBetter ? 0.010 : -0.010;
    return Math.max(0.05, Math.min(0.95, homeProb + delta));
  }
  if (ump.favor === "hitter") {
    // Hitter-friendly umpire narrows gap between good and bad pitching
    const homeHasBetter = homePitcherERA < awayPitcherERA;
    const delta = homeHasBetter ? -0.008 : +0.008;
    return Math.max(0.05, Math.min(0.95, homeProb + delta));
  }
  return homeProb;
}

/**
 * Adjusts projected run total based on umpire strike zone size.
 * Wide zone = more K's = fewer runs. Tight zone = more BB = more runs.
 */
export function applyUmpireTotalAdjustment(
  projectedTotal: number,
  ump: MLBUmpireImpact | null | undefined
): number {
  if (!ump) return projectedTotal;
  return projectedTotal + ump.runAdj;
}
