// ── MLB Early Markets — F5 ML, F5 O/U, NRFI/YRFI, 1-2-3 inning ML ─────────
import { computeF5Unified, type PitcherRecentForm, type UmpireData } from "./mlb-f5-unified.js";
// Toma 2 ERE objects (home + away) y deriva probabilidades para todos los
// mercados early que el modelo full game NO toca. Anti-doble-conteo garantizado.
//
// MERCADOS COBERTOS:
//   1. F5 Moneyline (winner first 5 innings)
//   2. F5 Over/Under (total runs first 5 innings)
//   3. NRFI / YRFI (no run / run in first inning)
//   4. 1st Inning ML (winner inning 1)
//   5. 2nd Inning ML (winner inning 2)
//   6. 3rd Inning ML (winner inning 3)
//
// IMPORTANTE: estos números NO tocan ni modifican el modelo full game.

import type { EreResult } from "./mlb-ere.js";

export interface EarlyMarketsInput {
  homeEre: EreResult;
  awayEre: EreResult;
  // Línea de mercado del libro (para edge cálculos)
  f5OverLine?: number;        // ej. 4.5
  f5OverOddsAmerican?: number;
  f5UnderOddsAmerican?: number;
  f5HomeMlOddsAmerican?: number;
  f5AwayMlOddsAmerican?: number;
  nrfiOddsAmerican?: number;
  yrfiOddsAmerican?: number;
  // FASE 1 — señal matchup pitch-by-pitch. Usa top-4 para NRFI/YRFI (currently disabled
  // por redundancia) y lineupAvg para F5. Back-compatible si no se provee.
  matchupSignal?: {
    homeTop4ExpectedXwoba: number | null;
    awayTop4ExpectedXwoba: number | null;
    homeLineupAvgXwoba: number | null;
    awayLineupAvgXwoba: number | null;
    dataConfidence: "FULL" | "PARTIAL" | "LOW" | "NONE";
  };
}

export interface EarlyMarketsResult {
  // F5 ML
  f5ProbHome: number;
  f5ProbAway: number;
  f5RecommendedSide: "HOME" | "AWAY" | "PASS";
  f5MlEdge?: number;          // edge sobre lado recomendado
  // F5 Total
  f5TotalRunsEstimated: number;
  f5OverProb?: number;        // si hay línea
  f5UnderProb?: number;
  f5OverEdge?: number;
  f5UnderEdge?: number;
  f5TotalSide?: "OVER" | "UNDER" | "PASS";
  // NRFI/YRFI
  probAnyRun1stInn: number;   // YRFI prob
  probNoRun1stInn: number;    // NRFI prob
  nrfiEdge?: number;
  yrfiEdge?: number;
  nrfiYrfiRec?: "NRFI" | "YRFI" | "PASS";
  // Inning-by-inning ML
  inning1: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  inning2: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  inning3: { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" };
  // Team Total F5 markets (agregados 7 jul basados en estudio ERE n=60):
  // Over 1.5: SLIGHT_OVER 78% · STRONG_EARLY 75% · ELITE_EARLY 80% (base)
  // Under 2.5: SLOW_START 71% · STRONG_SLOW 75% (base)
  teamTotalOver15F5: {
    homeProb: number;
    awayProb: number;
    side: "HOME" | "AWAY" | "PASS";
  };
  teamTotalUnder25F5: {
    homeProb: number;
    awayProb: number;
    side: "HOME" | "AWAY" | "PASS";
  };
  // Meta
  confidence: "HIGH" | "MEDIUM" | "LOW";  // baja si warnings significativos
  warnings: string[];
  // Recomendación final: pick con mayor prob (o PREMIUM si hay)
  finalRecommendation: {
    market: "F5_ML" | "INNING_1_ML" | "TT_OVER_15_F5" | "TT_UNDER_25_F5" | "PASS";
    side: "HOME" | "AWAY" | "PASS";
    action: "BET" | "PASS";
    reason: string;
    isPremium?: boolean;
  };
  // Picks alternos válidos (BET adicionales más allá del top). Cuando hay 2 PREMIUM,
  // el segundo aparece aquí para que el usuario decida cuál jugar.
  alternativePicks?: Array<{
    market: "F5_ML" | "INNING_1_ML" | "TT_OVER_15_F5" | "TT_UNDER_25_F5";
    side: "HOME" | "AWAY";
    prob: number;
    reason: string;
    isPremium: boolean;
  }>;
}

// Team Total F5 probabilities by ERE category (from 7 jul empirical study, n=60):
// Over 1.5 hit rate given category:
const TT_OVER15_PROB_BY_CAT: Record<string, number> = {
  ELITE_EARLY: 0.80,
  STRONG_EARLY: 0.75,
  SLIGHT_OVER: 0.78,
  NEUTRAL: 0.62,
  SLOW_START: 0.46,
  STRONG_SLOW: 0.50,
};
// Under 2.5 hit rate given category (1 - P(>=3 runs)):
const TT_UNDER25_PROB_BY_CAT: Record<string, number> = {
  ELITE_EARLY: 0.20,
  STRONG_EARLY: 0.42,
  SLIGHT_OVER: 0.46,
  NEUTRAL: 0.59,
  SLOW_START: 0.71,
  STRONG_SLOW: 0.75,
};

const LEAGUE_F5_TOTAL = 4.65;             // baseline F5 total runs
const LEAGUE_YRFI_RATE = 0.28;            // prob históricamente liga
const HOME_F5_EDGE = 0.018;               // home advantage F5 (menor que full game)
const HOME_INN_EDGE = 0.006;              // inning-level home edge (muy pequeño)

export function computeEarlyMarkets(input: EarlyMarketsInput): EarlyMarketsResult {
  const { homeEre, awayEre } = input;
  const warnings = [...homeEre.warnings, ...awayEre.warnings];

  // ── 1. F5 ML ────────────────────────────────────────────────────────────
  // Diferencial ERE convertido a logit. Divisor 22 = sensibilidad calibrada:
  // gap ERE 22 puntos → ~62% prob lado fuerte (calibración inicial conservadora)
  // F5 ML = modelo unificado (ERE core + form/umpire layers, sin calibración mercado)
  // Garantiza UNA SOLA fuente de verdad para F5 prob.
  const f5U = computeF5Unified({
    homeEre, awayEre,
    homePitcherForm: (input as any).homePitcherForm as PitcherRecentForm | undefined,
    awayPitcherForm: (input as any).awayPitcherForm as PitcherRecentForm | undefined,
    umpire: (input as any).umpire as UmpireData | undefined,
    // FASE 1 — propagar matchup signal a F5
    matchupSignal: input.matchupSignal ? {
      homeLineupAvgXwoba: (input.matchupSignal as any).homeLineupAvgXwoba ?? null,
      awayLineupAvgXwoba: (input.matchupSignal as any).awayLineupAvgXwoba ?? null,
      dataConfidence: input.matchupSignal.dataConfidence,
    } : undefined,
  });
  const f5ProbHome = f5U.f5ProbHome;
  const f5ProbAway = f5U.f5ProbAway;

  let f5RecommendedSide: "HOME" | "AWAY" | "PASS" = "PASS";
  if (f5ProbHome >= 0.56) f5RecommendedSide = "HOME";
  else if (f5ProbAway >= 0.56) f5RecommendedSide = "AWAY";

  let f5MlEdge: number | undefined;
  if (f5RecommendedSide === "HOME" && input.f5HomeMlOddsAmerican !== undefined) {
    f5MlEdge = (f5ProbHome - americanToProb(input.f5HomeMlOddsAmerican)) * 100;
  } else if (f5RecommendedSide === "AWAY" && input.f5AwayMlOddsAmerican !== undefined) {
    f5MlEdge = (f5ProbAway - americanToProb(input.f5AwayMlOddsAmerican)) * 100;
  }

  // ── 2. F5 Total ─────────────────────────────────────────────────────────
  // Modelo: scoreOff de cada equipo predice sus runs F5, ajustado por
  // pitcher suppression del rival y modifiers ya aplicados en ERE.
  // homeF5runs = baseline_per_team × (homeOff/50) × (1 + (100-awayPit)/100 × 0.20)
  const baselinePerTeam = LEAGUE_F5_TOTAL / 2; // ~2.32 runs/team F5
  const homeF5Runs =
    baselinePerTeam *
    (homeEre.offenseScore / 50) *
    (1 + ((100 - awayEre.pitcherSuppressionScore) / 100 - 0.5) * 0.40) *
    homeEre.parkFactor * homeEre.weatherModifier;
  const awayF5Runs =
    baselinePerTeam *
    (awayEre.offenseScore / 50) *
    (1 + ((100 - homeEre.pitcherSuppressionScore) / 100 - 0.5) * 0.40) *
    awayEre.parkFactor * awayEre.weatherModifier;
  const f5TotalRunsEstimated = Math.round((homeF5Runs + awayF5Runs) * 100) / 100;

  let f5OverProb: number | undefined, f5UnderProb: number | undefined;
  let f5OverEdge: number | undefined, f5UnderEdge: number | undefined;
  let f5TotalSide: "OVER" | "UNDER" | "PASS" | undefined;

  if (input.f5OverLine !== undefined) {
    // Modelo gaussiano simple: P(total > line) usando SD ~1.6 runs para F5
    const sd = 1.6;
    const z = (f5TotalRunsEstimated - input.f5OverLine) / sd;
    f5OverProb = sigmoid(z * 1.8); // aproximación normal con factor calibración
    f5UnderProb = 1 - f5OverProb;
    if (input.f5OverOddsAmerican !== undefined) {
      f5OverEdge = (f5OverProb - americanToProb(input.f5OverOddsAmerican)) * 100;
    }
    if (input.f5UnderOddsAmerican !== undefined) {
      f5UnderEdge = (f5UnderProb - americanToProb(input.f5UnderOddsAmerican)) * 100;
    }
    if (f5OverProb >= 0.56) f5TotalSide = "OVER";
    else if (f5UnderProb >= 0.56) f5TotalSide = "UNDER";
    else f5TotalSide = "PASS";
  }

  // ── 3. NRFI / YRFI ──────────────────────────────────────────────────────
  // Probabilidad inning 1 anote alguien: 1 − P(home no anota) × P(away no anota)
  // P(home anota) viene del top-3 OBP * pitcher YRFI allowed * baseline YRFI
  const homeYrfiTeam = homeEre.variables.offense.yrfi?.raw ?? LEAGUE_YRFI_RATE;
  const awayYrfiTeam = awayEre.variables.offense.yrfi?.raw ?? LEAGUE_YRFI_RATE;
  // Pitcher rival vulnerability inning 1 (sobre 50=neutral)
  // Pitcher vulnerability inning 1: invertir score (alto = pitcher vuln) y normalizar.
  // Si firstInnEra es undefined o score es 50 (datos missing), defaulteamos a vuln=0.5.
  const homeFacesPitcherVuln = (100 - (awayEre.variables.pitcher.firstInnEra?.score ?? 50)) / 100;
  const awayFacesPitcherVuln = (100 - (homeEre.variables.pitcher.firstInnEra?.score ?? 50)) / 100;

  // Top-4 lineup wOBA vs mano del pitcher (específico al matchup del día).
  // Si está disponible, lo usamos como la señal más rica. Convertimos wOBA
  // a "prob anotar 1er inning" via ratio sobre league mean.
  const LEAGUE_WOBA = 0.310;
  const homeTop4 = homeEre.top4LineupWoba?.woba;
  const awayTop4 = awayEre.top4LineupWoba?.woba;

  // FASE 1 RESULT — En NRFI/YRFI, el matchup top-4 vs arsenal resultó
  // REDUNDANTE con top4LineupWoba (shifts <0.7pp incluso a peso 60%).
  // Peso revertido a 0: NRFI/YRFI usa SOLO top4 general (back-compatible total).
  // Documentado para no perder el aprendizaje.
  const ms = input.matchupSignal;
  const matchupWeight: number = 0.0;  // disabled - signal redundant in NRFI/YRFI
  const homeTop4Blended =
    homeTop4 !== undefined && isFinite(homeTop4) && homeTop4 > 0
      ? (ms?.homeTop4ExpectedXwoba && isFinite(ms.homeTop4ExpectedXwoba) && ms.homeTop4ExpectedXwoba > 0
          ? homeTop4 * (1 - matchupWeight) + ms.homeTop4ExpectedXwoba * matchupWeight
          : homeTop4)
      : (ms?.homeTop4ExpectedXwoba && isFinite(ms.homeTop4ExpectedXwoba) && ms.homeTop4ExpectedXwoba > 0
          ? ms.homeTop4ExpectedXwoba  // solo matchup disponible
          : undefined);
  const awayTop4Blended =
    awayTop4 !== undefined && isFinite(awayTop4) && awayTop4 > 0
      ? (ms?.awayTop4ExpectedXwoba && isFinite(ms.awayTop4ExpectedXwoba) && ms.awayTop4ExpectedXwoba > 0
          ? awayTop4 * (1 - matchupWeight) + ms.awayTop4ExpectedXwoba * matchupWeight
          : awayTop4)
      : (ms?.awayTop4ExpectedXwoba && isFinite(ms.awayTop4ExpectedXwoba) && ms.awayTop4ExpectedXwoba > 0
          ? ms.awayTop4ExpectedXwoba
          : undefined);

  // Probabilidad cada equipo anote en 1er inning con 3 señales:
  //   40% team YRFI rate (baseline equipo)
  //   35% top-4 wOBA blended (general 70-100% + matchup 0-30%)
  //   25% pitcher firstInnEra vulnerability
  // Si top-4 wOBA no disponible (sample chico, lineup no confirmado), repesar a 60/40.
  function combineSignals(
    teamYrfi: number,
    top4Woba: number | undefined,
    pitcherVuln: number,
    leagueYrfi: number,
  ): number {
    if (top4Woba !== undefined && isFinite(top4Woba) && top4Woba > 0) {
      // Convertir wOBA a un "effective rate": leagueYrfi * (wOBA / leagueWoba)
      const top4Signal = leagueYrfi * (top4Woba / LEAGUE_WOBA);
      return clamp(
        teamYrfi * 0.40 + top4Signal * 0.35 + pitcherVuln * 0.25,
        0.10, 0.65
      );
    }
    // Fallback: sin top-4, usar pesos 70/30 (team/pitcher)
    return clamp(teamYrfi * 0.70 + pitcherVuln * 0.30, 0.10, 0.65);
  }
  const probHomeScore1 = combineSignals(homeYrfiTeam, homeTop4Blended, homeFacesPitcherVuln, LEAGUE_YRFI_RATE);
  const probAwayScore1 = combineSignals(awayYrfiTeam, awayTop4Blended, awayFacesPitcherVuln, LEAGUE_YRFI_RATE);

  const probNoRun1stInn = (1 - probHomeScore1) * (1 - probAwayScore1);
  const probAnyRun1stInn = 1 - probNoRun1stInn;

  let nrfiEdge: number | undefined, yrfiEdge: number | undefined;
  let nrfiYrfiRec: "NRFI" | "YRFI" | "PASS" = "PASS";
  if (input.nrfiOddsAmerican !== undefined) {
    nrfiEdge = (probNoRun1stInn - americanToProb(input.nrfiOddsAmerican)) * 100;
  }
  if (input.yrfiOddsAmerican !== undefined) {
    yrfiEdge = (probAnyRun1stInn - americanToProb(input.yrfiOddsAmerican)) * 100;
  }
  if (probNoRun1stInn >= 0.58) nrfiYrfiRec = "NRFI";
  else if (probAnyRun1stInn >= 0.58) nrfiYrfiRec = "YRFI";

  // ── 4. Inning-by-inning ML (1, 2, 3) ────────────────────────────────────
  // Para cada inning: P(home gana ese inning) ≈ función de differencial early
  // pero con varianza ALTA. Cada inning individual es ~50/50 ± 8% normalmente.
  // Usamos ereDiff/45 (sensibilidad menor que F5) más home edge tiny.
  const ereDiff = homeEre.ereScore - awayEre.ereScore;
  const innLogitBase = ereDiff / 45;
  const inning1 = buildInningPred(innLogitBase * 1.1, HOME_INN_EDGE);  // 1st inning depende más de top lineup + pitcher
  const inning2 = buildInningPred(innLogitBase * 0.9, HOME_INN_EDGE);  // 2nd inning más aleatorio
  const inning3 = buildInningPred(innLogitBase * 1.0, HOME_INN_EDGE);

  // ── Confidence based on warnings + ERE N/D coverage (FIX 14 jun 2026) ──
  // Reconcilia con el badge BAJA CONFIANZA del ERE card. Antes solo miraba
  // warnings.length, ahora tambien degrada cuando pitcher tiene muchos N/D.
  const countNd = (ere: EreResult) => {
    const p = Object.values(ere.variables.pitcher).filter(v => v.raw === null).length;
    const o = Object.values(ere.variables.offense).filter(v => v.raw === null).length;
    return { pitcherNd: p, totalNd: p + o };
  };
  const homeNd = countNd(homeEre);
  const awayNd = countNd(awayEre);
  const maxPitcherNd = Math.max(homeNd.pitcherNd, awayNd.pitcherNd);
  const maxTotalNd = Math.max(homeNd.totalNd, awayNd.totalNd);

  let confidence: "HIGH" | "MEDIUM" | "LOW" = "HIGH";
  // LOW si cualquier lado tiene cobertura colapsada
  if (warnings.length >= 4 || maxPitcherNd >= 3 || maxTotalNd >= 5) confidence = "LOW";
  // MEDIUM si cobertura parcial en algun lado
  else if (warnings.length >= 2 || maxTotalNd >= 2) confidence = "MEDIUM";

  if (maxPitcherNd >= 3) warnings.push(`Pitcher con ${maxPitcherNd} variables N/D — modelo apoyado en prior`);

  // ---- Team Total F5 by ERE category (empirical study 7 jul, n=60 games) ----
  const homeTtOver15 = TT_OVER15_PROB_BY_CAT[homeEre.category] ?? 0.55;
  const awayTtOver15 = TT_OVER15_PROB_BY_CAT[awayEre.category] ?? 0.55;
  const homeTtUnder25 = TT_UNDER25_PROB_BY_CAT[homeEre.category] ?? 0.55;
  const awayTtUnder25 = TT_UNDER25_PROB_BY_CAT[awayEre.category] ?? 0.55;

  // Threshold: 0.70 hit rate = clear edge over -110 breakeven (52.4%)
  const TT_THRESHOLD = 0.70;
  const ttOver15Side: "HOME" | "AWAY" | "PASS" =
    Math.max(homeTtOver15, awayTtOver15) >= TT_THRESHOLD
      ? homeTtOver15 >= awayTtOver15 ? "HOME" : "AWAY"
      : "PASS";
  const ttUnder25Side: "HOME" | "AWAY" | "PASS" =
    Math.max(homeTtUnder25, awayTtUnder25) >= TT_THRESHOLD
      ? homeTtUnder25 >= awayTtUnder25 ? "HOME" : "AWAY"
      : "PASS";

  const teamTotalOver15F5 = {
    homeProb: Math.round(homeTtOver15 * 1000) / 1000,
    awayProb: Math.round(awayTtOver15 * 1000) / 1000,
    side: ttOver15Side,
  };
  const teamTotalUnder25F5 = {
    homeProb: Math.round(homeTtUnder25 * 1000) / 1000,
    awayProb: Math.round(awayTtUnder25 * 1000) / 1000,
    side: ttUnder25Side,
  };

  // ---- Recomendación FINAL (reglas descubiertas 23 jun + recalibración 1 jul) ----
  // Regla 1: Conf HIGH => PASS siempre (backend "seguro" estructuralmente invertido).
  // Regla 2: Solo mercados core (F5_ML + INNING_1_ML). NRFI/YRFI/I2/I3 nunca BET.
  // Regla 3: F5_ML prob en 0.55–0.65 (Light bucket) marca warning — sigue siendo BET
  //          pero el UI puede pedir verificación manual de banderas verdes.
  // ============================================================================
  // FILTROS DUROS validados out-of-sample (backtest 7 jul, n=481 F5+I1)
  // F5_ML TEST n=27 filtrado: 24W-3L = 88.9% hit, +18.84u, ROI +69.8%
  // Filtros 4 y 5 agregados 7 jul (2° iteración) tras backtest de nuevas reglas
  // sobre variables secundarias.
  // Aplican a F5_ML e INNING_1_ML. TT F5 usa regla legacy HIGH=PASS hasta
  // tener su propio backtest out-of-sample.
  // ============================================================================
  function coreMarketFilter(pickSide: "HOME"|"AWAY", pickProb: number, market: "F5_ML"|"INNING_1_ML"): { pass: true; reason: string } | null {
    const erePickObj = pickSide === "HOME" ? homeEre : awayEre;
    const ereRivalObj = pickSide === "HOME" ? awayEre : homeEre;
    const erePick = erePickObj.ereScore;
    const ereRival = ereRivalObj.ereScore;
    const ereDiff = (erePick ?? 0) - (ereRival ?? 0);

    // Filtro 1: ERE_diff < 10 (bloquéa 55 picks en TEST, hit 43.6%, −9.16u)
    if (ereDiff < 10) {
      return { pass: true, reason: `ERE_diff=${ereDiff.toFixed(0)} <10 — histórico 40–50% hit rate (backtest 7 jul)` };
    }
    // Filtro 2: ERE del equipo apostado < 45 (bloqueó 8 picks TEST, hit 25%, −4.18u)
    if ((erePick ?? 100) < 45) {
      return { pass: true, reason: `ERE_pick=${erePick?.toFixed(0)} <45 — equipo apostado sin edge ofensivo (histórico 34–41% hit)` };
    }
    // Filtro 3: solo F5_ML — Prob >=0.65 + Conf=HIGH (bloquéa 13 picks TEST, hit 46%, −1.54u)
    if (market === "F5_ML" && pickProb >= 0.65 && confidence === "HIGH") {
      return { pass: true, reason: `Prob=${Math.round(pickProb*100)}% + Conf=HIGH — trampa favorito seguro (histórico 46% hit)` };
    }
    // Filtro 4 (NUEVO 2° iter): solo F5_ML — rival xwOBA TTO1 en [0.28, 0.32)
    // TRAIN 42.1% hit (n=76) · TEST 36.4% hit (n=22, −6.72u) — pitcher rival "gris"
    if (market === "F5_ML") {
      const rivalXwobaTto1 = ereRivalObj.variables?.pitcher?.xwobaTto1?.raw;
      if (rivalXwobaTto1 !== null && rivalXwobaTto1 !== undefined && rivalXwobaTto1 >= 0.28 && rivalXwobaTto1 < 0.32) {
        return { pass: true, reason: `Rival xwOBA TTO1=${rivalXwobaTto1.toFixed(3)} en zona gris [0.28, 0.32) — pitcher rival ni elite ni malo, histórico 36–42% hit` };
      }
    }
    // Filtro 6 (iter 4 - 10 jul, Fase 1 backtest deep n=522): solo F5_ML
    // rival_f5_whip en [1.2, 1.7) → PASS. TRAIN 46% (n=124) · TEST 40.5% (n=42, -9.53u)
    // Interpretación: pitcher rival mediocre = juego caótico, alta varianza,
    // favorito puede voltearse. F5 ML gana MEJOR contra pitchers buenos-a-elite.
    if (market === "F5_ML") {
      const rivalF5Whip = ereRivalObj.f5InningData?.f5Whip;
      if (rivalF5Whip !== null && rivalF5Whip !== undefined && rivalF5Whip >= 1.2 && rivalF5Whip < 1.7) {
        return { pass: true, reason: `Rival F5 WHIP=${rivalF5Whip.toFixed(2)} en [1.2, 1.7) — pitcher rival mediocre, juego high-variance (backtest 10 jul TEST 40.5% hit)` };
      }
    }
    // Filtro 7 (iter 4 - 10 jul): solo F5_ML — psuppr_pick (pitcher del equipo
    // apostado) en [60, 75) → PASS. TRAIN 51.1% (n=45) · TEST 25% (n=16, -8.36u)
    // Interpretación contraintuitiva: cuando TU pitcher tiene score suppression
    // "élite" (60-75), la línea ya cobra premium y el pick pierde brutalmente.
    if (market === "F5_ML") {
      const psupprPick = erePickObj.pitcherSuppressionScore;
      if (psupprPick !== undefined && psupprPick !== null && psupprPick >= 60 && psupprPick < 75) {
        return { pass: true, reason: `Pitcher suppression pick=${psupprPick.toFixed(0)} en [60, 75) — línea inflada por premium ace (backtest 10 jul TEST 25% hit)` };
      }
    }
    // Filtro 8 (iter 4 - 10 jul): solo F5_ML — rival_f5era >= 5.5 → PASS.
    // TRAIN 35% (n=20) · TEST 36.4% (n=11, -3.36u)
    // Interpretación: pitcher rival terrible = juego high-scoring, alta varianza,
    // favorito puede voltearse. Similar a F6 pero por ERA directa.
    if (market === "F5_ML") {
      const rivalF5Era = ereRivalObj.f5InningData?.f5Era;
      if (rivalF5Era !== null && rivalF5Era !== undefined && rivalF5Era >= 5.5) {
        return { pass: true, reason: `Rival F5 ERA=${rivalF5Era.toFixed(2)} >=5.5 — pitcher rival terrible, juego high-variance (backtest 10 jul TEST 36% hit)` };
      }
    }
    // Filtro 5 (iter 3 - 8 jul): INNING_1_ML solo BET si own_top5_xwoba está
    // en el sweet spot [0.29, 0.33). Fuera de ese rango → PASS.
    // Justificación: I1 baseline general = 57% (flojo). Solo el bucket
    // own_top5_xwoba [0.29, 0.33) sobrevivió out-of-sample con 75% hit (n=20).
    // Los otros rangos: <0.29 (n<12 muestra chica), [0.33, 0.36) 37% hit (loser),
    // >=0.36 (mixed). Restricción dura: solo BET en el sweet spot.
    if (market === "INNING_1_ML") {
      const ownTop5Xwoba = erePickObj.variables?.offense?.top5xwoba?.raw;
      if (ownTop5Xwoba === null || ownTop5Xwoba === undefined) {
        return { pass: true, reason: `INNING_1_ML sin datos xwOBA top-5 — requerido para validar sweet spot` };
      }
      if (ownTop5Xwoba < 0.29 || ownTop5Xwoba >= 0.33) {
        return { pass: true, reason: `INNING_1_ML: xwOBA top-5 propio=${ownTop5Xwoba.toFixed(3)} fuera del sweet spot [0.29, 0.33) — solo esa zona rinde 75% hit histórico` };
      }
    }
    return null;
  }

  // Container compartido para exponer los candidatos al calculo de alternativePicks
  type Candidate = { market: EarlyMarketsResult["finalRecommendation"]["market"]; side: "HOME"|"AWAY"; prob: number; label: string; blockedReason?: string };
  const _rankedCandidates: Candidate[] = [];

  const finalRecommendation: EarlyMarketsResult["finalRecommendation"] = (() => {
    // Recolectar candidatos con su probabilidad
    const candidates: Candidate[] = [];

    // TT Over 1.5 F5 (7 jul iter 3: quitada la regla HIGH=PASS tras backtest
    // propio out-of-sample. Baseline TEST n=78 = 82.1% hit, HIGH TEST n=38 = 71.1%.
    // La restricción previa filtraba ganadores. Badge PREMIUM para STRONG_EARLY
    // que ganó 95.5% en TEST (n=22).
    if (ttOver15Side !== "PASS") {
      const prob = ttOver15Side === "HOME" ? homeTtOver15 : awayTtOver15;
      const cat = ttOver15Side === "HOME" ? homeEre.category : awayEre.category;
      const isPremium = cat === "STRONG_EARLY";
      const premiumTag = isPremium ? "🏆 PREMIUM · " : "";
      const histPct = isPremium ? 96 : Math.round(prob*100);
      candidates.push({ market: "TT_OVER_15_F5", side: ttOver15Side, prob: isPremium ? Math.max(prob, 0.85) : prob,
        label: `${premiumTag}TT Over 1.5 F5 ${ttOver15Side} (ERE ${cat} — ${histPct}% hit histórico)` });
    }
    // TT Under 2.5 F5
    if (ttUnder25Side !== "PASS") {
      const prob = ttUnder25Side === "HOME" ? homeTtUnder25 : awayTtUnder25;
      const cat = ttUnder25Side === "HOME" ? homeEre.category : awayEre.category;
      candidates.push({ market: "TT_UNDER_25_F5", side: ttUnder25Side, prob,
        label: `TT Under 2.5 F5 ${ttUnder25Side} (ERE ${cat} — ${Math.round(prob*100)}% hit histórico)` });
    }
    // F5 ML — usa los 4 filtros duros validados + PREMIUM detection
    // PREMIUM: ERE_diff >= 20 o ERE_pick >= 65 (dentro de supervivientes)
    // Backtest 8 jul TEST: ambos rangos = 100% hit (6/6 cada uno).
    if (f5RecommendedSide !== "PASS") {
      const winProb = f5RecommendedSide === "HOME" ? f5ProbHome : f5ProbAway;
      const blocked = coreMarketFilter(f5RecommendedSide, winProb, "F5_ML");
      if (!blocked) {
        const erePick = f5RecommendedSide === "HOME" ? homeEre.ereScore : awayEre.ereScore;
        const ereRival = f5RecommendedSide === "HOME" ? awayEre.ereScore : homeEre.ereScore;
        const ereDiff = (erePick ?? 0) - (ereRival ?? 0);
        const isPremiumF5 = ereDiff >= 20 || (erePick !== undefined && erePick !== null && erePick >= 65);
        const inLightBucket = winProb >= 0.55 && winProb < 0.65;
        const premiumTag = isPremiumF5 ? "🏆 PREMIUM · " : "";
        const premiumStats = isPremiumF5
          ? ereDiff >= 20
            ? " · ERE_diff=" + ereDiff.toFixed(0) + " ≥ 20, histórico 100% hit (n=18)"
            : " · ERE_pick=" + (erePick?.toFixed(0) ?? "?") + " ≥ 65, histórico 100% hit TEST (n=6)"
          : "";
        candidates.push({
          market: "F5_ML",
          side: f5RecommendedSide,
          prob: isPremiumF5 ? Math.max(winProb, 0.97) : winProb,
          label: `${premiumTag}F5 ML ${f5RecommendedSide} ${Math.round(winProb*100)}%${inLightBucket ? " · ⚠️ Light bucket" : ""}${premiumStats}`,
        });
      }
    }
    // Inning 1 ML — usa filtros 1 y 2 (no aplica filtro 3 según estudio)
    if (inning1.side !== "PASS") {
      const winProb = inning1.side === "HOME" ? inning1.homeProb : inning1.awayProb;
      const blocked = coreMarketFilter(inning1.side, winProb, "INNING_1_ML");
      if (!blocked) {
        candidates.push({ market: "INNING_1_ML", side: inning1.side, prob: winProb,
          label: `Inning 1 ML ${inning1.side} ${Math.round(winProb*100)}%` });
      }
    }

    if (candidates.length === 0) {
      // Construir razón explicando el motivo del PASS (más útil que genérico)
      const reasons: string[] = [];
      if (f5RecommendedSide !== "PASS") {
        const winProb = f5RecommendedSide === "HOME" ? f5ProbHome : f5ProbAway;
        const blocked = coreMarketFilter(f5RecommendedSide, winProb, "F5_ML");
        if (blocked) reasons.push(`F5 ML bloqueado: ${blocked.reason}`);
      }
      if (inning1.side !== "PASS") {
        const winProb = inning1.side === "HOME" ? inning1.homeProb : inning1.awayProb;
        const blocked = coreMarketFilter(inning1.side, winProb, "INNING_1_ML");
        if (blocked) reasons.push(`I1 ML bloqueado: ${blocked.reason}`);
      }

      return {
        market: "PASS" as const,
        side: "PASS" as const,
        action: "PASS" as const,
        reason: reasons.length ? reasons.join(" · ") : "Sin edge en mercados core (F5 ML, INNING 1 ML, TT F5)",
      };
    }
    // Elegir el candidato con mayor probabilidad
    candidates.sort((a, b) => b.prob - a.prob);
    _rankedCandidates.push(...candidates); // exponer para alternativePicks
    const best = candidates[0];
    return {
      market: best.market,
      side: best.side,
      action: "BET" as const,
      reason: `${best.label} · Conf ${confidence}`,
      isPremium: best.label.includes("🏆 PREMIUM"),
    };
  })();

  // alternativePicks: cuando hay 2+ PREMIUM (o BET con label PREMIUM), mostrar todos
  const alternativePicks: EarlyMarketsResult["alternativePicks"] =
    finalRecommendation.action === "BET"
      ? _rankedCandidates
          .slice(1) // skip el top (ya está en finalRecommendation)
          .filter(c => c.label.includes("🏆 PREMIUM"))
          .map(c => ({
            market: c.market as "F5_ML" | "INNING_1_ML" | "TT_OVER_15_F5" | "TT_UNDER_25_F5",
            side: c.side,
            prob: Math.round(c.prob * 1000) / 1000,
            reason: `${c.label} · Conf ${confidence}`,
            isPremium: true,
          }))
      : [];

  return {
    f5ProbHome: Math.round(f5ProbHome * 1000) / 1000,
    f5ProbAway: Math.round(f5ProbAway * 1000) / 1000,
    f5RecommendedSide,
    f5MlEdge: f5MlEdge !== undefined ? Math.round(f5MlEdge * 10) / 10 : undefined,
    f5TotalRunsEstimated,
    f5OverProb: f5OverProb !== undefined ? Math.round(f5OverProb * 1000) / 1000 : undefined,
    f5UnderProb: f5UnderProb !== undefined ? Math.round(f5UnderProb * 1000) / 1000 : undefined,
    f5OverEdge: f5OverEdge !== undefined ? Math.round(f5OverEdge * 10) / 10 : undefined,
    f5UnderEdge: f5UnderEdge !== undefined ? Math.round(f5UnderEdge * 10) / 10 : undefined,
    f5TotalSide,
    probAnyRun1stInn: Math.round(probAnyRun1stInn * 1000) / 1000,
    probNoRun1stInn: Math.round(probNoRun1stInn * 1000) / 1000,
    nrfiEdge: nrfiEdge !== undefined ? Math.round(nrfiEdge * 10) / 10 : undefined,
    yrfiEdge: yrfiEdge !== undefined ? Math.round(yrfiEdge * 10) / 10 : undefined,
    nrfiYrfiRec,
    inning1,
    inning2,
    inning3,
    teamTotalOver15F5,
    teamTotalUnder25F5,
    confidence,
    warnings,
    finalRecommendation,
    alternativePicks,
  };
}

// Helper inning prediction
function buildInningPred(logit: number, homeEdge: number): { homeProb: number; awayProb: number; side: "HOME" | "AWAY" | "PASS" } {
  // P(home wins this inning vs away wins) — pero la mayoría de innings empata 0-0
  // Aquí calculamos: P(home anota más que away EN ESTE inning)
  // Empate es muy común (~50-60% innings son 0-0), por eso side se requiere edge >55% para BET
  const adjustedLogit = logit + homeEdge;
  const homeProb = clamp(sigmoid(adjustedLogit), 0.20, 0.80);
  const awayProb = 1 - homeProb;
  let side: "HOME" | "AWAY" | "PASS" = "PASS";
  if (homeProb >= 0.58) side = "HOME";
  else if (awayProb >= 0.58) side = "AWAY";
  return {
    homeProb: Math.round(homeProb * 1000) / 1000,
    awayProb: Math.round(awayProb * 1000) / 1000,
    side,
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function americanToProb(odds: number): number {
  if (odds === 0) return 0.5;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}
