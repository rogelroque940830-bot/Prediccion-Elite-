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
  // Recomendación final agregada (reglas 23 jun + 1 jul + 7 jul TT F5):
  // - Excluye Conf HIGH
  // - Prioriza mercado con mayor edge (TT F5 > F5_ML > INNING_1_ML)
  finalRecommendation: {
    market: "F5_ML" | "INNING_1_ML" | "TT_OVER_15_F5" | "TT_UNDER_25_F5" | "PASS";
    side: "HOME" | "AWAY" | "PASS";
    action: "BET" | "PASS";
    reason: string;
  };
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
  const finalRecommendation: EarlyMarketsResult["finalRecommendation"] = (() => {
    if (confidence === "HIGH") {
      return {
        market: "PASS" as const,
        side: "PASS" as const,
        action: "PASS" as const,
        reason: "Conf HIGH — revisión pendiente (muestra actual divergente), pasar hasta recalibración 15 jul",
      };
    }

    // Recolectar candidatos con su probabilidad y ranking
    type Candidate = { market: EarlyMarketsResult["finalRecommendation"]["market"]; side: "HOME"|"AWAY"; prob: number; label: string };
    const candidates: Candidate[] = [];

    // TT Over 1.5 F5 (nuevo mercado 7 jul — hit rate 75–78% según estudio ERE)
    if (ttOver15Side !== "PASS") {
      const prob = ttOver15Side === "HOME" ? homeTtOver15 : awayTtOver15;
      const cat = ttOver15Side === "HOME" ? homeEre.category : awayEre.category;
      candidates.push({ market: "TT_OVER_15_F5", side: ttOver15Side, prob,
        label: `TT Over 1.5 F5 ${ttOver15Side} (ERE ${cat} — ${Math.round(prob*100)}% hit histórico)` });
    }
    // TT Under 2.5 F5 (nuevo mercado 7 jul — hit rate 71–75% para SLOW_START/STRONG_SLOW)
    if (ttUnder25Side !== "PASS") {
      const prob = ttUnder25Side === "HOME" ? homeTtUnder25 : awayTtUnder25;
      const cat = ttUnder25Side === "HOME" ? homeEre.category : awayEre.category;
      candidates.push({ market: "TT_UNDER_25_F5", side: ttUnder25Side, prob,
        label: `TT Under 2.5 F5 ${ttUnder25Side} (ERE ${cat} — ${Math.round(prob*100)}% hit histórico)` });
    }
    // F5 ML tradicional
    if (f5RecommendedSide !== "PASS") {
      const winProb = f5RecommendedSide === "HOME" ? f5ProbHome : f5ProbAway;
      const inLightBucket = winProb >= 0.55 && winProb < 0.65;
      candidates.push({ market: "F5_ML", side: f5RecommendedSide, prob: winProb,
        label: `F5 ML ${f5RecommendedSide} ${Math.round(winProb*100)}%${inLightBucket ? " · ⚠️ Light bucket" : ""}` });
    }
    // Inning 1 ML
    if (inning1.side !== "PASS") {
      const winProb = inning1.side === "HOME" ? inning1.homeProb : inning1.awayProb;
      candidates.push({ market: "INNING_1_ML", side: inning1.side, prob: winProb,
        label: `Inning 1 ML ${inning1.side} ${Math.round(winProb*100)}%` });
    }

    if (candidates.length === 0) {
      return {
        market: "PASS" as const,
        side: "PASS" as const,
        action: "PASS" as const,
        reason: "Sin edge en mercados core (F5 ML, INNING 1 ML, TT F5)",
      };
    }
    // Elegir el candidato con mayor probabilidad
    candidates.sort((a, b) => b.prob - a.prob);
    const best = candidates[0];
    return {
      market: best.market,
      side: best.side,
      action: "BET" as const,
      reason: `${best.label} · Conf ${confidence}`,
    };
  })();

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
