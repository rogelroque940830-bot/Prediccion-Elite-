// ──────────────────────────────────────────────────────────────────────────
// F5 UNIFICADO — ERE core + capas internas (sin calibración con mercado)
//
// Reemplaza la inconsistencia entre el modelo viejo (predictF5) y el ERE.
// Una SOLA fuente de verdad para predicción F5.
//
// Pipeline:
//   1. F5 base = ERE F5 prob (variables Statcast + Savant + Rotowire)
//   2. × Pitcher recent form (IMPLOSIÓN/HOT trend)
//   3. × Umpire adjustment (strike zone effect)
//   4. (park & weather YA aplicados en ERE)
//   5. Output: prob F5 final, sin tocar con cuotas del mercado
// ──────────────────────────────────────────────────────────────────────────

import type { EreResult } from "./mlb-ere.js";

export interface PitcherRecentForm {
  trend?: "IMPLOSION" | "STRUGGLING" | "STABLE" | "HOT" | "ELITE";
  recentEra?: number;       // ERA últimas 3 starts
  seasonEra?: number;       // ERA season
  ipPerStart?: number;      // promedio IP/start reciente
}

export interface UmpireData {
  name?: string;
  callBias?: number;        // -1 (pitcher-friendly) a +1 (hitter-friendly)
  k9Effect?: number;        // strikeouts/9 effect del umpire vs liga
}

export interface F5UnifiedInput {
  homeEre: EreResult;
  awayEre: EreResult;
  homePitcherForm?: PitcherRecentForm;
  awayPitcherForm?: PitcherRecentForm;
  umpire?: UmpireData;
  // FASE 1 — matchup pitch-by-pitch signal para F5 (full lineup vs SP arsenal)
  matchupSignal?: {
    homeLineupAvgXwoba: number | null;
    awayLineupAvgXwoba: number | null;
    dataConfidence: "FULL" | "PARTIAL" | "LOW" | "NONE";
  };
}

export interface F5UnifiedResult {
  // Prob F5 final del HOME (1 - this = prob AWAY)
  f5ProbHome: number;
  f5ProbAway: number;
  pickSide: "HOME" | "AWAY" | "PASS";
  // Confianza basada en cuánto separa del 50/50
  confidence: "HIGH" | "MED" | "LOW";
  // Desglose de cada capa para transparencia
  layers: {
    ereF5Base: number;                  // antes de ajustes
    formAdjustment: number;             // ±pp aplicados por form
    umpireAdjustment: number;           // ±pp por umpire
    matchupAdjustment: number;          // ±pp por matchup lineup vs SP arsenal (FASE 1)
    finalProb: number;                  // = ereF5Base + form + umpire + matchup
  };
  // Sub-scores que entran al cálculo (para UI)
  components: {
    homeEreScore: number;
    awayEreScore: number;
    homePitcherForm?: string;
    awayPitcherForm?: string;
    parkFactor: number;
    weatherModifier: number;
  };
}

const HOME_F5_EDGE = 0.06;   // home advantage logit en F5 (más chico que full game)
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ──────────────────────────────────────────────────────────────────────────
// Capa: Pitcher Recent Form
//
// IMPLOSION    → -7pp (muy mala racha reciente)
// STRUGGLING   → -3pp
// STABLE       →  0pp
// HOT          → +3pp
// ELITE        → +6pp
// ──────────────────────────────────────────────────────────────────────────
function formAdjPpForPitcher(form?: PitcherRecentForm): number {
  if (!form?.trend) return 0;
  switch (form.trend) {
    case "IMPLOSION": return -7;
    case "STRUGGLING": return -3;
    case "STABLE": return 0;
    case "HOT": return 3;
    case "ELITE": return 6;
    default: return 0;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Capa: Umpire Adjustment
//
// Umpire con bias hitter-friendly (callBias > 0): favorece OFENSIVA
//   → home si home tiene mejor ofensiva, away si away
// Umpire con bias pitcher-friendly (callBias < 0): favorece PITCHING
//   → favor al equipo cuyo PITCHER es mejor
//
// Efecto pequeño: max ±2pp
// ──────────────────────────────────────────────────────────────────────────
function umpireAdjPp(input: F5UnifiedInput): number {
  const ump = input.umpire;
  if (!ump?.callBias) return 0;
  const bias = clamp(ump.callBias, -1, 1);
  const homeOffense = input.homeEre.offenseScore;
  const awayOffense = input.awayEre.offenseScore;
  const homePitchSup = input.homeEre.pitcherSuppressionScore;
  const awayPitchSup = input.awayEre.pitcherSuppressionScore;
  // delta home-vs-away en cada eje
  const offDeltaHome = (homeOffense - awayOffense) / 100;
  const pitDeltaHome = (homePitchSup - awayPitchSup) / 100;
  // bias positivo (hitter-friendly): pesa más la ofensiva
  // bias negativo (pitcher-friendly): pesa más el pitching
  const effect = bias * offDeltaHome * 2 + (-bias) * pitDeltaHome * 1.5;
  return clamp(effect, -2, 2);
}

// ──────────────────────────────────────────────────────────────────────────
// Cálculo principal
// ──────────────────────────────────────────────────────────────────────────
// FASE 1 — Ajuste pp para F5 basado en matchup lineup vs arsenal SP rival.
// Lógica: differential = (homeLineupXw - LEAGUE_WOBA) - (awayLineupXw - LEAGUE_WOBA)
//                       = homeLineupXw - awayLineupXw
// Positivo → lineup HOME tiene mejor matchup que AWAY → +pp HOME
// Escala conservadora: 50 pp por unit xwOBA differential, cap ±3pp.
// Confianza modula peso: FULL/PARTIAL = 100%, LOW = 50%, NONE = 0.
const LEAGUE_WOBA_F5 = 0.310;
function matchupAdjPp(input: F5UnifiedInput): number {
  const ms = input.matchupSignal;
  if (!ms || ms.dataConfidence === "NONE") return 0;
  if (ms.homeLineupAvgXwoba === null || ms.awayLineupAvgXwoba === null) return 0;
  if (!isFinite(ms.homeLineupAvgXwoba) || !isFinite(ms.awayLineupAvgXwoba)) return 0;
  // Differential: home matchup advantage − away matchup advantage
  const homeAdv = ms.homeLineupAvgXwoba - LEAGUE_WOBA_F5;
  const awayAdv = ms.awayLineupAvgXwoba - LEAGUE_WOBA_F5;
  // F5: ofensiva fuerte HOME = MENOS prob HOME (porque la prob es "home WIN F5",
  // no "home anota más"). Pero la convención del modelo: más ofensiva home reduce
  // prob HOME-win en F5 cuando el SP rival es bueno; equivalentemente, más ofensiva
  // AWAY reduce prob HOME-win. La fórmula F5 actual es ERE diff → home - away.
  // El matchup advantage es ofensiva: si HOME batea mejor vs el SP rival = HOME mete
  // más runs → ayuda HOME ganar F5 → +pp HOME. Por eso: home - away.
  const differential = homeAdv - awayAdv;
  let scale = 50; // 1 xwOBA point → ~0.5pp
  if (ms.dataConfidence === "LOW") scale *= 0.5;
  const adj = differential * scale;
  return Math.max(-3, Math.min(3, adj)); // cap ±3pp
}

export function computeF5Unified(input: F5UnifiedInput): F5UnifiedResult {
  const { homeEre, awayEre } = input;

  // 1. ERE F5 base (mismo cálculo que ya existe en early-markets.ts)
  const ereDiff = homeEre.ereScore - awayEre.ereScore;
  const f5Logit = ereDiff / 22 + (HOME_F5_EDGE * 6);
  const ereF5BaseHome = sigmoid(f5Logit);
  const ereF5BasePp = ereF5BaseHome * 100;

  // 2. Form adjustment: home form mejora prob HOME; away form mejora prob AWAY
  // Restamos away form porque favorecer al pitcher away reduce prob HOME.
  const homePitcherFormAdj = formAdjPpForPitcher(input.homePitcherForm);
  const awayPitcherFormAdj = formAdjPpForPitcher(input.awayPitcherForm);
  // Pitcher mejor del HOME = mejor para HOME (ofensiva visitante batea menos)
  // Pitcher mejor del AWAY = peor para HOME
  const formAdjustment = homePitcherFormAdj - awayPitcherFormAdj;

  // 3. Umpire
  const umpireAdjustment = umpireAdjPp(input);

  // 4. Matchup (FASE 1 — NUEVO)
  const matchupAdjustment = matchupAdjPp(input);

  // 5. Final
  const finalPp = clamp(ereF5BasePp + formAdjustment + umpireAdjustment + matchupAdjustment, 8, 92);
  const f5ProbHome = finalPp / 100;
  const f5ProbAway = 1 - f5ProbHome;

  // 5. Pick
  let pickSide: "HOME" | "AWAY" | "PASS" = "PASS";
  if (f5ProbHome >= 0.56) pickSide = "HOME";
  else if (f5ProbAway >= 0.56) pickSide = "AWAY";

  // 6. Confianza
  const edge = Math.abs(f5ProbHome - 0.5);
  let confidence: "HIGH" | "MED" | "LOW" = "LOW";
  if (edge >= 0.10) confidence = "HIGH";
  else if (edge >= 0.06) confidence = "MED";

  return {
    f5ProbHome: Math.round(f5ProbHome * 1000) / 1000,
    f5ProbAway: Math.round(f5ProbAway * 1000) / 1000,
    pickSide,
    confidence,
    layers: {
      ereF5Base: Math.round(ereF5BasePp * 10) / 10,
      formAdjustment: Math.round(formAdjustment * 10) / 10,
      umpireAdjustment: Math.round(umpireAdjustment * 10) / 10,
      matchupAdjustment: Math.round(matchupAdjustment * 10) / 10,
      finalProb: Math.round(finalPp * 10) / 10,
    },
    components: {
      homeEreScore: homeEre.ereScore,
      awayEreScore: awayEre.ereScore,
      homePitcherForm: input.homePitcherForm?.trend,
      awayPitcherForm: input.awayPitcherForm?.trend,
      parkFactor: homeEre.parkFactor,
      weatherModifier: homeEre.weatherModifier,
    },
  };
}
