// WNBA Prediction Model — Based on NBA model with WNBA-specific adjustments
// Lower scoring (~80 PPG vs ~115 NBA), fewer teams (12), shorter season (40 games)

const WNBA_LEAGUE_AVG_RTG = 100.0; // WNBA average OffRtg/DefRtg

export interface WNBATeamStats {
  netRtg: number;
  offRtg: number;
  defRtg: number;
  pace: number;
  daysRest: number;
  winRate: number;
  isB2B: boolean;
  streak: number;
  recentPace?: number;
  recentPPG?: number;
  injuryAdj: number;
  // Forma reciente (últimos 10 juegos) — si está disponible, se mezcla 60% recent / 40% season
  recentNetRtg?: number;
  recentOffRtg?: number;
  recentDefRtg?: number;
  recentWinRate?: number;
  // Sample-size: si gamesPlayed < 15, el modelo regresa hacia neutral
  gamesPlayed?: number;
  // Strength of schedule — NetRtg promedio de los últimos 10 oponentes
  oppAvgNetRtg?: number;
  // Fatiga avanzada
  b2bWasRoad?: boolean;     // El juego anterior del B2B fue de visitante
  gamesLast7Days?: number;  // Carga de calendario reciente
  // Travel — distancia recorrida (solo aplica al visitante)
  travelMiles?: number;
}

const COEFF = {
  intercept: 0.12,
  diff_net_rtg: 0.09,
  diff_off_rtg: 0.035,
  diff_def_rtg: -0.035,
  diff_pace: 0.006,
  diff_rest: 0.07,
  home_win_rate: 1.3,
  away_win_rate: -1.3,
  // B2B granular: road B2B más pesado que home B2B (roster de 12, vuelos comerciales)
  home_b2b_road_prev: -0.28,   // home pero anoche jugó visitante
  home_b2b_home_prev: -0.18,   // home y anoche jugó en casa (menos fatiga)
  away_b2b_road_prev: 0.32,    // visitante después de otro road = fatigado máximo (beneficia local)
  away_b2b_home_prev: 0.22,    // visitante que venía de casa = menos fatigado
  diff_streak: 0.06,
  schedule_overload: -0.08,    // por juego en exceso de 3 en últimos 7 días
};

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── SOS-aware blend recent vs season ──
// Si el equipo tuvo agenda difícil reciente (oppAvgNetRtg > 0), su L10 vale MENOS
// (es bueno aun perdiendo). Si tuvo agenda fácil (oppAvgNetRtg < 0), L10 inflado.
// L10 weight base 60%, ajustado por SOS: tough→ hasta 75%, easy→ hasta 40%.
function sosAwareBlend(season: number, recent: number | undefined, oppAvgNetRtg: number | undefined): number {
  if (recent === undefined || !Number.isFinite(recent)) return season;
  let l10Weight = 0.60;
  if (oppAvgNetRtg !== undefined && Number.isFinite(oppAvgNetRtg)) {
    // sosShift: -0.20 a +0.15. Tough schedule (oppNet=+5) suma peso a L10
    const sosShift = Math.max(-0.20, Math.min(0.15, oppAvgNetRtg * 0.04));
    l10Weight = Math.max(0.40, Math.min(0.75, 0.60 + sosShift));
  }
  return season * (1 - l10Weight) + recent * l10Weight;
}

// Backward compat: blend simple 60/40 cuando no hay SOS
function blendRecent(season: number, recent: number | undefined): number {
  return sosAwareBlend(season, recent, undefined);
}

// ── Sample-size cap ── Si gamesPlayed < 15, regresar hacia neutral.
// Un equipo 4-1 (winRate 0.80) con 5 GP no debe tratarse como élite real.
function sampleCap(stat: number, neutral: number, gp: number | undefined): number {
  if (gp === undefined || gp >= 15) return stat;
  const trust = Math.max(0.30, Math.min(1.0, 0.30 + gp * 0.047)); // 5GP→54%, 10GP→77%, 15GP→100%
  return stat * trust + neutral * (1 - trust);
}

// Floors/ceilings de seguridad para evitar que injuryAdj extremo distorsione stats
// Liga WNBA: offRtg/defRtg avg ~100. Equipos peores caen a 95, mejores suben a 110.
// Con injuryAdj de hasta ±10 (SUPERSTAR fuera), cap [85, 115] mantiene rango plausible.
function clampRtg(rtg: number): number {
  // WNBA real range: offRtg/defRtg típico 92-110. Hard cap [88, 112] evita ratings absurdos
  // de inicio de temporada (ej. Indiana defRtg=120, LA defRtg=126 con <5 partidos).
  return Math.max(88, Math.min(112, rtg));
}

// Defense Bucket clasificación: ELITE/MEDIA/FLOJA según DefRtg
// liga WNBA promedio ~100. Elite <97 (top 3 típicamente), media 97-103, floja >103.
export type DefenseTier = "ELITE" | "MEDIA" | "FLOJA";
export function getDefenseTier(defRtg: number): DefenseTier {
  if (defRtg < 97) return "ELITE";
  if (defRtg > 103) return "FLOJA";
  return "MEDIA";
}

// Adjustment al offensive output esperado según calidad de defensa enfrentada.
// Defense ELITE suprime ofensiva ~2.5%, FLOJA infla ~2.5%, MEDIA neutral.
// Aplica MULTIPLICADOR a offRtg para reflejar el matchup real.
export function defenseMatchupMultiplier(oppDefTier: DefenseTier): number {
  if (oppDefTier === "ELITE") return 0.975;
  if (oppDefTier === "FLOJA") return 1.025;
  return 1.0;
}

export function predictWNBA(home: WNBATeamStats, away: WNBATeamStats, marketImpliedHomeProb?: number): number {
  // SOS-aware blend (recent 60% base, ajustado por dificultad del calendario)
  // Aplicamos clamp ANTES del blend para evitar stats absurdos post-injuryAdj.
  const hNet = sosAwareBlend(clampRtg(home.netRtg + 100) - 100, home.recentNetRtg, home.oppAvgNetRtg);
  let hOff = sosAwareBlend(clampRtg(home.offRtg), home.recentOffRtg !== undefined ? clampRtg(home.recentOffRtg) : undefined, home.oppAvgNetRtg);
  const hDef = sosAwareBlend(clampRtg(home.defRtg), home.recentDefRtg !== undefined ? clampRtg(home.recentDefRtg) : undefined, home.oppAvgNetRtg);
  const aNet = sosAwareBlend(clampRtg(away.netRtg + 100) - 100, away.recentNetRtg, away.oppAvgNetRtg);
  let aOff = sosAwareBlend(clampRtg(away.offRtg), away.recentOffRtg !== undefined ? clampRtg(away.recentOffRtg) : undefined, away.oppAvgNetRtg);
  const aDef = sosAwareBlend(clampRtg(away.defRtg), away.recentDefRtg !== undefined ? clampRtg(away.recentDefRtg) : undefined, away.oppAvgNetRtg);

  // ── Defense Bucket Matchup ──
  // Aplica multiplicador a offRtg según tier de la defensa rival.
  // ELITE -2.5%, FLOJA +2.5%. ANTI-DOBLE-CONTEO: NetRtg/DefRtg NO se ajustan porque
  // ya capturan la defensa propia; solo modulamos el OUTPUT ofensivo esperado.
  hOff = hOff * defenseMatchupMultiplier(getDefenseTier(aDef));
  aOff = aOff * defenseMatchupMultiplier(getDefenseTier(hDef));
  // Win rate: blend si recentWinRate existe, luego cap por sample
  const hWrBlend = blendRecent(home.winRate, home.recentWinRate);
  const aWrBlend = blendRecent(away.winRate, away.recentWinRate);
  const hWr = sampleCap(hWrBlend, 0.50, home.gamesPlayed);
  const aWr = sampleCap(aWrBlend, 0.50, away.gamesPlayed);

  // B2B granular: road-after-road es el escenario peor
  const homeB2BCoeff = home.isB2B ? (home.b2bWasRoad ? COEFF.home_b2b_road_prev : COEFF.home_b2b_home_prev) : 0;
  const awayB2BCoeff = away.isB2B ? (away.b2bWasRoad ? COEFF.away_b2b_road_prev : COEFF.away_b2b_home_prev) : 0;

  // Schedule overload: más de 3 juegos en últimos 7 días penaliza
  const homeOverload = home.gamesLast7Days !== undefined ? Math.max(0, home.gamesLast7Days - 3) : 0;
  const awayOverload = away.gamesLast7Days !== undefined ? Math.max(0, away.gamesLast7Days - 3) : 0;
  const overloadAdj = COEFF.schedule_overload * (homeOverload - awayOverload);

  // Travel penalty (solo al visitante)
  const travelAdj = away.travelMiles !== undefined && away.travelMiles > 0
    ? (away.travelMiles < 500 ? 0 : away.travelMiles < 1000 ? 0.007 : away.travelMiles < 2000 ? 0.014 : away.travelMiles < 2500 ? 0.020 : 0.028)
    : 0;  // positivo porque beneficia al LOCAL (visitante cansado)

  // ANTI-DOBLE-CONTEO: el frontend ya aplica injuryAdj a netRtg/offRtg/defRtg
  // antes de pasar el objeto al modelo. Aquí NO se vuelve a sumar (antes se contaba 6×).
  const logit =
    COEFF.intercept +
    COEFF.diff_net_rtg * (hNet - aNet) +
    COEFF.diff_off_rtg * (hOff - aOff) +
    COEFF.diff_def_rtg * (hDef - aDef) +
    COEFF.diff_pace * (home.pace - away.pace) +
    COEFF.diff_rest * (home.daysRest - away.daysRest) +
    COEFF.home_win_rate * hWr +
    COEFF.away_win_rate * aWr +
    homeB2BCoeff + awayB2BCoeff +
    overloadAdj +
    travelAdj +
    COEFF.diff_streak * (home.streak - away.streak);

  // Cap final del logit ±2.0 → prob queda entre 12% y 88%.
  // Evita predicciones extremas (95%+) cuando los 12 factores se alinean por casualidad.
  const LOGIT_HARD_CAP = 2.0;
  const cappedLogit = Math.max(-LOGIT_HARD_CAP, Math.min(LOGIT_HARD_CAP, logit));
  let prob = sigmoid(cappedLogit);

  // ── Calibración 65/35 vs mercado (igual que MLB) ──
  // Cuando el modelo dice 80% y mercado dice 55%, mezcla 65% modelo + 35% mercado.
  // En WNBA el mercado es eficiente (libros conocen rosters/lineups) → calibrar protege.
  if (marketImpliedHomeProb !== undefined && Number.isFinite(marketImpliedHomeProb) && marketImpliedHomeProb > 0 && marketImpliedHomeProb < 1) {
    let calibrated = prob * 0.65 + marketImpliedHomeProb * 0.35;
    const gap = prob - marketImpliedHomeProb;
    // Sanity cap: si gap >25pp y prob extrema (>=80% o <=20%), pull adicional
    if (Math.abs(gap) >= 0.25 && (prob >= 0.80 || prob <= 0.20)) {
      calibrated = (calibrated + (marketImpliedHomeProb + gap * 0.40)) / 2;
    }
    prob = Math.max(0.05, Math.min(0.95, calibrated));
  }
  return prob;
}

export function predictWNBATotal(home: WNBATeamStats, away: WNBATeamStats): number {
  // Pace blend SOS-aware: cuando hay SOS, peso L10 ajustado
  const homePace = home.recentPace !== undefined
    ? sosAwareBlend(home.pace, home.recentPace, home.oppAvgNetRtg)
    : home.pace;
  const awayPace = away.recentPace !== undefined
    ? sosAwareBlend(away.pace, away.recentPace, away.oppAvgNetRtg)
    : away.pace;
  // Pace cap: WNBA real range ~93-104. Inicio de temporada da ruido.
  const homePaceSafe = Math.max(92, Math.min(104, home.isB2B ? homePace * 0.97 : homePace));
  const awayPaceSafe = Math.max(92, Math.min(104, away.isB2B ? awayPace * 0.97 : awayPace));
  const avgPace = (homePaceSafe + awayPaceSafe) / 2;

  // ANTI-DOBLE-CONTEO: offRtg/defRtg ya incluyen injuryAdj desde el frontend.
  // Sample-size cap: si <15 partidos, regresar hacia liga (100). Crítico al inicio de temporada.
  const hOffSafe = sampleCap(clampRtg(home.offRtg), WNBA_LEAGUE_AVG_RTG, home.gamesPlayed);
  const hDefSafe = sampleCap(clampRtg(home.defRtg), WNBA_LEAGUE_AVG_RTG, home.gamesPlayed);
  const aOffSafe = sampleCap(clampRtg(away.offRtg), WNBA_LEAGUE_AVG_RTG, away.gamesPlayed);
  const aDefSafe = sampleCap(clampRtg(away.defRtg), WNBA_LEAGUE_AVG_RTG, away.gamesPlayed);

  // FÓRMULA DEAN OLIVER (aditiva, no multiplicativa). La fórmula vieja
  // (offA/100 * pace * defB/100) tripicaba el efecto defensivo y daba totales
  // ridiculos (235+ vs realidad WNBA 155-175).
  // Adjusted score = (offRtg_propio + defRtg_rival) / 2 * pace / 100
  const homeScore = ((hOffSafe + aDefSafe) / 2) * avgPace / 100;
  const awayScore = ((aOffSafe + hDefSafe) / 2) * avgPace / 100;

  let total = homeScore + awayScore;

  // Ajuste recent PPG (factor reducido a 0.15 para no sobre-corregir)
  if (home.recentPPG) {
    const expected = (hOffSafe / 100) * homePaceSafe;
    if (expected > 0) total += (home.recentPPG / expected - 1) * homeScore * 0.15;
  }
  if (away.recentPPG) {
    const expected = (aOffSafe / 100) * awayPaceSafe;
    if (expected > 0) total += (away.recentPPG / expected - 1) * awayScore * 0.15;
  }

  // EARLY-SEASON BLEND: si gp combinado < 30, regresar fuerte hacia baseline liga (165).
  // WNBA promedio histórico ~163-168 pts/partido. Inicio de temporada da ratings
  // ruidosos (Indiana defRtg=120 con 5GP no significa nada).
  const WNBA_BASELINE_TOTAL = 165;
  const totalGP = (home.gamesPlayed || 0) + (away.gamesPlayed || 0);
  if (totalGP < 30) {
    // 0GP combinado → 100% baseline; 30GP → 0% baseline (confianza plena en stats)
    const baselineWeight = Math.max(0, (30 - totalGP) / 30);
    total = total * (1 - baselineWeight) + WNBA_BASELINE_TOTAL * baselineWeight;
  }

  // Hard cap final: WNBA real rango típico 145-190. Cap [140, 195] previene outliers.
  total = Math.max(140, Math.min(195, total));

  return Math.round(total * 10) / 10;
}

export function wnbaEvaluateSpread(homeProb: number, spreadLine: number): {
  expectedMargin: number; edge: number; signal: "BET" | "LEAN" | "PASS"; side: string;
} {
  // Guard contra homeProb 0/1 que darían logit ±Infinity
  const safeProb = Math.max(0.01, Math.min(0.99, homeProb));
  const logit = Math.log(safeProb / (1 - safeProb));
  const expectedMargin = Math.round(logit * 8 * 100) / 100; // WNBA smaller margins
  const edge = expectedMargin - (-spreadLine);
  const absEdge = Math.abs(edge);
  const signal: "BET" | "LEAN" | "PASS" = absEdge > 4 ? "BET" : absEdge > 2 ? "LEAN" : "PASS";
  const side = edge > 0 ? "Local cubre" : "Visitante cubre";
  return { expectedMargin, edge, signal, side };
}

export function wnbaEvaluateTotal(estimated: number, line: number): {
  edge: number; signal: "BET" | "LEAN" | "PASS"; side: "OVER" | "UNDER";
} {
  const diff = estimated - line;
  const absDiff = Math.abs(diff);
  const signal: "BET" | "LEAN" | "PASS" = absDiff > 5 ? "BET" : absDiff > 2.5 ? "LEAN" : "PASS";
  return { edge: diff, signal, side: diff > 0 ? "OVER" : "UNDER" };
}

export function americanToProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

export function wnbaGetSignal(edge: number): "BET" | "LEAN" | "PASS" {
  if (edge > 5) return "BET";
  if (edge > 2) return "LEAN";
  return "PASS";
}

// ── STAR POWER INDEX (WNBA) ──
// Proxy de impacto del jugador en netRtg basado en PPG + AST + REB + Min + FG%.
// Score 0-10. Convertimos a delta NetRtg perdido cuando está fuera.
export interface WNBAPlayer {
  name: string;
  ppg: number;
  apg: number;
  rpg: number;
  spg?: number;
  bpg?: number;
  min: number;
  fgPct?: number;
  gp: number;
}

export function wnbaStarPower(p: WNBAPlayer): { score: number; tier: "SUPERSTAR" | "STAR" | "STARTER" | "ROLE"; netRtgImpact: number } {
  // Componente ofensivo: PPG (cap 25) + asistencias (cap 8) + eficiencia FG
  const ppgScore = Math.min(4.5, p.ppg / 25 * 4.5);                 // 25 PPG = 4.5 puntos
  const astScore = Math.min(2.0, p.apg / 8 * 2.0);                  // 8 APG = 2.0 puntos
  const rebScore = Math.min(1.5, p.rpg / 11 * 1.5);                 // 11 RPG = 1.5 puntos
  const minScore = Math.min(2.0, p.min / 35 * 2.0);                 // 35 MPG = 2.0 puntos (cap)
  const defScore = Math.min(0.8, ((p.spg ?? 0) + (p.bpg ?? 0)) / 4 * 0.8); // 4 STK = 0.8 puntos
  const fgBonus = (p.fgPct ?? 0) >= 0.50 ? 0.5 : (p.fgPct ?? 0) >= 0.45 ? 0.2 : 0;
  let score = ppgScore + astScore + rebScore + minScore + defScore + fgBonus;

  // Sample-size penalty: <10 GP regresa hacia neutral
  if (p.gp < 10) {
    const trust = Math.max(0.40, Math.min(1.0, 0.40 + p.gp * 0.06));
    score = score * trust + 4.0 * (1 - trust);
  }
  score = Math.max(0, Math.min(10, score));

  const tier = score >= 8 ? "SUPERSTAR" : score >= 6 ? "STAR" : score >= 4 ? "STARTER" : "ROLE";

  // Conversión a NetRtg impact: una SUPERSTAR (Caitlin Clark, A'ja Wilson) vale ~-8 NetRtg
  // STAR ~-5, STARTER ~-3, ROLE ~-1
  // Fórmula: (score - 3) * 1.2 con cap [0, 9]
  const netRtgImpact = Math.max(0, Math.min(9, (score - 3) * 1.2));
  return { score: Math.round(score * 10) / 10, tier, netRtgImpact: Math.round(netRtgImpact * 10) / 10 };
}

// ── PICK QUALITY SCORE (WNBA) ── Score 1-10 + tier + Kelly fractional + hard vetos
export interface WNBAPickQuality {
  market: "ML" | "Spread" | "O/U";
  score: number;          // 1-10
  tier: "S+" | "S" | "A" | "B" | "C" | "D" | "F";
  recommendation: "BET_FUERTE" | "BET" | "LEAN" | "PASS";
  stakeUnits: number;     // 0-5 (Kelly × 0.25, capped por tier)
  edgeReal: number;       // pp
  warnings: string[];
  confirms: string[];
  reasoning: string;
  pickedSideLabel: string;
  pickedSideOdds: number;
  modelProb: number;
  marketImpliedProb: number;
}

// Kelly fractional (cuarto) para WNBA — más conservador que MLB por menor sample
export function wnbaKellyStake(modelProb: number, oddsAmerican: number, bankroll: number = 100): number {
  const dec = oddsAmerican > 0 ? oddsAmerican / 100 + 1 : 100 / Math.abs(oddsAmerican) + 1;
  const b = dec - 1;
  const p = modelProb;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  return Math.max(0, kelly * 0.25 * bankroll); // 25% Kelly
}

export function wnbaPickQuality(params: {
  market: "ML" | "Spread" | "O/U";
  modelProb: number;
  marketImpliedProb: number;
  oddsAmerican: number;
  pickedSideLabel: string;
  marketGap?: number;
  injurySignificant?: boolean;
  sampleConcern?: boolean;
  sharpAgainst?: boolean;
}): WNBAPickQuality {
  const { market, modelProb, marketImpliedProb, oddsAmerican, pickedSideLabel } = params;
  const edgeReal = (modelProb - marketImpliedProb) * 100;
  const warnings: string[] = [];
  const confirms: string[] = [];

  let score = 5.0;
  // Edge real es el factor principal
  if (edgeReal >= 8) { score += 3; confirms.push(`Edge real ${edgeReal.toFixed(1)}pp — fuerte`); }
  else if (edgeReal >= 5) { score += 2; confirms.push(`Edge real ${edgeReal.toFixed(1)}pp—decente`); }
  else if (edgeReal >= 3) { score += 1; }
  else if (edgeReal >= 0) { score += 0; }
  else { score -= 2; warnings.push(`Edge NEGATIVO ${edgeReal.toFixed(1)}pp — modelo no ve valor`); }

  // Sample concern (gamesPlayed bajo)
  if (params.sampleConcern) { score -= 1.5; warnings.push("Muestra pequeña — menos de 15 GP"); }
  // Injury significant (perdimos SUPERSTAR/STAR)
  if (params.injurySignificant) { score -= 1.0; warnings.push("Lesión crítica (SUPERSTAR/STAR) detectada"); }
  // Gap mercado vs modelo — si gap >25pp con prob extrema, alerta
  // Solo aplica a ML (probabilidad real). O/U y Spread usan modelProb heurístico
  // que SIEMPRE genera gap grande con edge fuerte (ej. 90% vs 52%) sin ser sospechoso.
  if (market === "ML" && params.marketGap !== undefined && params.marketGap > 0.25) {
    score -= 1.0; warnings.push(`Gap modelo vs mercado ${(params.marketGap * 100).toFixed(0)}pp — desviado`);
  }
  // Sharp against
  if (params.sharpAgainst) { score -= 1.5; warnings.push("Sharp money en contra"); }

  // HARD VETOS → fuerzan PASS
  let hardVeto = false;
  if (edgeReal < 0) hardVeto = true;
  if (params.sharpAgainst && edgeReal < 3) hardVeto = true;
  // Solo ML usa probabilidad real medida. O/U y Spread usan modelProb como proxy
  // heurística (cap a 0.90 con edge fuerte), por eso este veto los pisaba siempre.
  if (market === "ML" && params.marketGap !== undefined && params.marketGap > 0.30 && (modelProb >= 0.80 || modelProb <= 0.20)) hardVeto = true;

  score = Math.max(0, Math.min(10, score));
  const tier: WNBAPickQuality["tier"] = score >= 9 ? "S+" : score >= 8 ? "S" : score >= 7 ? "A" : score >= 6 ? "B" : score >= 5 ? "C" : score >= 4 ? "D" : "F";

  let recommendation: WNBAPickQuality["recommendation"];
  let stakeUnits: number;
  if (hardVeto || score < 5) { recommendation = "PASS"; stakeUnits = 0; }
  else if (score >= 8.5) { recommendation = "BET_FUERTE"; stakeUnits = Math.min(5, Math.round((wnbaKellyStake(modelProb, oddsAmerican) / 10) * 10) / 10); }
  else if (score >= 7) { recommendation = "BET"; stakeUnits = Math.min(3, Math.round((wnbaKellyStake(modelProb, oddsAmerican) / 10) * 10) / 10); }
  else if (score >= 6) { recommendation = "LEAN"; stakeUnits = Math.min(1, Math.round((wnbaKellyStake(modelProb, oddsAmerican) / 10) * 10) / 10); }
  else { recommendation = "PASS"; stakeUnits = 0; }

  const reasoning = recommendation === "PASS"
    ? (hardVeto ? "Hard veto: edge negativo, sharp en contra, o gap extremo del mercado." : `Score ${score.toFixed(1)} insuficiente — esperar mejor oportunidad.`)
    : `Edge ${edgeReal.toFixed(1)}pp + score ${score.toFixed(1)} → ${recommendation}. Kelly 1/4 = ${stakeUnits}u.`;

  return {
    market, score: Math.round(score * 10) / 10, tier, recommendation, stakeUnits,
    edgeReal: Math.round(edgeReal * 10) / 10, warnings, confirms, reasoning,
    pickedSideLabel, pickedSideOdds: oddsAmerican, modelProb, marketImpliedProb,
  };
}

export interface WNBABestPlay {
  market: "ML" | "Spread" | "O/U";
  recommendation: string;
  signal: "BET" | "LEAN" | "PASS";
  edgeLabel: string;
  confidence: number;
}

export function wnbaGetBestPlay(plays: WNBABestPlay[]): WNBABestPlay | null {
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

export const WNBA_TEAMS = [
  "Atlanta Dream", "Chicago Sky", "Connecticut Sun", "Dallas Wings",
  "Golden State Valkyries", "Indiana Fever", "Las Vegas Aces", "Los Angeles Sparks",
  "Minnesota Lynx", "New York Liberty", "Phoenix Mercury", "Seattle Storm",
  "Washington Mystics",
];
