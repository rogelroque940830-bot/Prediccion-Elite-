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
    finalProb: number;                  // = ereF5Base + form + umpire
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

  // 4. Final
  const finalPp = clamp(ereF5BasePp + formAdjustment + umpireAdjustment, 8, 92);
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
