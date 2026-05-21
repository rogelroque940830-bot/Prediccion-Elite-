// ── Early Run Environment (ERE) — MLB Module ──────────────────────────────
// Composite score 0-100 que mide tendencia de carreras tempranas (innings 1-3)
// para un equipo dado, considerando su ofensiva early Y la vulnerabilidad del
// pitcher abridor rival.
//
// ARQUITECTURA:
//   ERE = 0.50 × OffenseScore (atacante)
//       + 0.50 × (100 − PitcherSuppression) (vulnerabilidad rival)
//   × parkFactor × weatherModifier
//
// OFFENSE SCORE (8 variables): runs 1-3 (20%), F5 runs (15%), YRFI% (10%),
//   xwOBA top-5 vs hand (18%), OBP top-3 (10%), K% top-5 inv (12%),
//   ISO top-5 (8%), L7 RPG (7%)
//
// PITCHER SUPPRESSION (8 variables): 1st inn ERA (22%), xwOBA TTO1 (20%),
//   K-BB% TTO1 (13%), runs 1-3/GS (12%), YRFI allowed% (8%),
//   pitch count 1-2 (7%), TTO penalty (10%), WHIP 1-3 (8%)
//
// Umbrales: 75+ Elite, 65-74 Strong, 55-64 Slight, 45-54 Neutral,
//   35-44 Slow, <35 Strong Slow.
//
// Advertencias: shrinkage agresivo si muestra <umbral mínimo. Park/weather
// SOLO post-cálculo. NO usar para full game total como predictor principal.

// Node 20+ provides global fetch natively; no need to import node-fetch.

// ── LEAGUE BASELINES (MLB 2026 estándares) ────────────────────────────────
const LEAGUE = {
  // Offense
  RUNS_1_3: 1.40, RUNS_1_3_SD: 0.35,
  F5_RUNS: 2.50, F5_RUNS_SD: 0.55,
  YRFI_RATE: 0.28, YRFI_RATE_SD: 0.07,
  TOP5_XWOBA: 0.320, TOP5_XWOBA_SD: 0.025,
  TOP3_OBP: 0.335, TOP3_OBP_SD: 0.025,
  TOP5_K_PCT: 0.225, TOP5_K_PCT_SD: 0.035,
  TOP5_ISO: 0.175, TOP5_ISO_SD: 0.025,
  L7_RPG: 4.50, L7_RPG_SD: 0.90,
  // Pitcher
  FIRST_INN_ERA: 4.20, FIRST_INN_ERA_SD: 1.10,
  XWOBA_TTO1: 0.305, XWOBA_TTO1_SD: 0.030,
  K_BB_PCT_TTO1: 0.14, K_BB_PCT_TTO1_SD: 0.045,
  RUNS_1_3_GS: 1.50, RUNS_1_3_GS_SD: 0.50,
  YRFI_ALLOWED: 0.28, YRFI_ALLOWED_SD: 0.07,
  PITCH_COUNT_1_2: 28, PITCH_COUNT_1_2_SD: 4,
  TTO_PENALTY: 0.020, TTO_PENALTY_SD: 0.025,
  WHIP_1_3: 1.20, WHIP_1_3_SD: 0.18,
};

// ── PESOS (deben sumar 1.0 en cada componente) ─────────────────────────────
const OFFENSE_WEIGHTS = {
  runs13: 0.20, f5: 0.15, yrfi: 0.10, top5xwoba: 0.18,
  top3obp: 0.10, top5k: 0.12, top5iso: 0.08, l7rpg: 0.07,
};
const PITCHER_WEIGHTS = {
  firstInnEra: 0.22, xwobaTto1: 0.20, kbbTto1: 0.13, runs13Gs: 0.12,
  yrfiAllowed: 0.08, pitchCount: 0.07, ttoPenalty: 0.10, whip13: 0.08,
};

// ── SAMPLE THRESHOLDS (mínimos para no aplicar shrinkage) ─────────────────
const SAMPLE_MIN = {
  TEAM_GP: 20, RECENT_GP: 5, PITCHER_GS: 8, TTO1_PA: 40,
  BATTER_PA: 80, FIRST_INN_GS: 8,
};

// ── PARK FACTORS EARLY (multiplicador sobre ERE final) ────────────────────
// >1.0 = inflate early scoring, <1.0 = suprime
const PARK_FACTORS_EARLY: Record<string, number> = {
  "Coors Field": 1.12,
  "Great American Ball Park": 1.06,
  "Yankee Stadium": 1.04,
  "Globe Life Field": 1.03,
  "Citizens Bank Park": 1.03,
  "Petco Park": 0.93,
  "Oracle Park": 0.92,
  "T-Mobile Park": 0.93,
  "loanDepot park": 0.95,
  "Tropicana Field": 0.97,
  "George M. Steinbrenner Field": 0.99,
};

export interface EreInput {
  teamId: number;
  teamName: string;
  gamePk?: number;
  opposingPitcherId?: number;
  opposingPitcherHand?: "R" | "L";
  venue?: string;
  tempF?: number;
  windMph?: number;
  windDirOut?: boolean;
}

export interface EreResult {
  teamId: number;
  teamName: string;
  // Composite
  ereScore: number;            // 0-100 final con park/weather modifier
  ereRaw: number;              // 0-100 sin modifiers
  category: "ELITE_EARLY" | "STRONG_EARLY" | "SLIGHT_OVER" | "NEUTRAL" | "SLOW_START" | "STRONG_SLOW";
  // Sub-scores
  offenseScore: number;        // 0-100
  pitcherSuppressionScore: number; // 0-100 (alto = suprime bien)
  // Modifiers aplicados
  parkFactor: number;
  weatherModifier: number;
  // Variables individuales (para transparencia)
  variables: {
    offense: Record<string, { raw: number | null; score: number; weight: number; sample: number }>;
    pitcher: Record<string, { raw: number | null; score: number; weight: number; sample: number }>;
  };
  // Recomendaciones de mercado
  marketSuggestions: string[];
  warnings: string[];
}

export async function computeMlbEre(input: EreInput): Promise<EreResult> {
  const { teamId, teamName, gamePk, opposingPitcherId, opposingPitcherHand, venue, tempF, windMph, windDirOut } = input;

  // ── 1. Offense data (paralelo) ──────────────────────────────────────────
  const [teamMetrics, opsTop5VsHand, lineupTop3, savantTop5] = await Promise.all([
    computeTeamEarlyMetrics(teamId),
    opposingPitcherHand ? computeXwobaTop5VsHand(teamId, opposingPitcherHand) : Promise.resolve(null),
    gamePk ? computeLineupTop3OBP(gamePk, teamId) : Promise.resolve(null),
    gamePk ? computeTop5IsoK(gamePk, teamId) : Promise.resolve(null),
  ]);

  // ── 2. Pitcher data (paralelo) ──────────────────────────────────────────
  const pitcherData = opposingPitcherId
    ? await computePitcherEarlyMetrics(opposingPitcherId)
    : emptyPitcherData();

  // ── 3. Normalizar variables individuales ────────────────────────────────
  const offVars: EreResult["variables"]["offense"] = {
    runs13: normVar(teamMetrics.earlyOff, LEAGUE.RUNS_1_3, LEAGUE.RUNS_1_3_SD, OFFENSE_WEIGHTS.runs13, teamMetrics.gamesAnalyzed, SAMPLE_MIN.TEAM_GP),
    f5: normVar(teamMetrics.f5Runs, LEAGUE.F5_RUNS, LEAGUE.F5_RUNS_SD, OFFENSE_WEIGHTS.f5, teamMetrics.gamesAnalyzed, SAMPLE_MIN.TEAM_GP),
    yrfi: normVar(teamMetrics.probFirstInn, LEAGUE.YRFI_RATE, LEAGUE.YRFI_RATE_SD, OFFENSE_WEIGHTS.yrfi, teamMetrics.gamesAnalyzed, SAMPLE_MIN.TEAM_GP),
    top5xwoba: normVar(savantTop5?.xwoba ?? null, LEAGUE.TOP5_XWOBA, LEAGUE.TOP5_XWOBA_SD, OFFENSE_WEIGHTS.top5xwoba, savantTop5?.pa ?? 0, SAMPLE_MIN.BATTER_PA),
    top3obp: normVar(lineupTop3?.obp ?? null, LEAGUE.TOP3_OBP, LEAGUE.TOP3_OBP_SD, OFFENSE_WEIGHTS.top3obp, lineupTop3?.pa ?? 0, SAMPLE_MIN.BATTER_PA),
    top5k: normVar(savantTop5?.kPct ?? null, LEAGUE.TOP5_K_PCT, LEAGUE.TOP5_K_PCT_SD, OFFENSE_WEIGHTS.top5k, savantTop5?.pa ?? 0, SAMPLE_MIN.BATTER_PA, true), // invertido
    top5iso: normVar(savantTop5?.iso ?? null, LEAGUE.TOP5_ISO, LEAGUE.TOP5_ISO_SD, OFFENSE_WEIGHTS.top5iso, savantTop5?.pa ?? 0, SAMPLE_MIN.BATTER_PA),
    l7rpg: normVar(teamMetrics.l7Rpg, LEAGUE.L7_RPG, LEAGUE.L7_RPG_SD, OFFENSE_WEIGHTS.l7rpg, Math.min(teamMetrics.gamesAnalyzed, 7), SAMPLE_MIN.RECENT_GP),
  };

  const pitVars: EreResult["variables"]["pitcher"] = {
    firstInnEra: normVar(pitcherData.firstInnEra, LEAGUE.FIRST_INN_ERA, LEAGUE.FIRST_INN_ERA_SD, PITCHER_WEIGHTS.firstInnEra, pitcherData.gs, SAMPLE_MIN.FIRST_INN_GS, true),
    xwobaTto1: normVar(pitcherData.xwobaTto1, LEAGUE.XWOBA_TTO1, LEAGUE.XWOBA_TTO1_SD, PITCHER_WEIGHTS.xwobaTto1, pitcherData.tto1Pa, SAMPLE_MIN.TTO1_PA, true),
    kbbTto1: normVar(pitcherData.kbbTto1, LEAGUE.K_BB_PCT_TTO1, LEAGUE.K_BB_PCT_TTO1_SD, PITCHER_WEIGHTS.kbbTto1, pitcherData.tto1Pa, SAMPLE_MIN.TTO1_PA),
    runs13Gs: normVar(pitcherData.runs13Gs, LEAGUE.RUNS_1_3_GS, LEAGUE.RUNS_1_3_GS_SD, PITCHER_WEIGHTS.runs13Gs, pitcherData.gs, SAMPLE_MIN.PITCHER_GS, true),
    yrfiAllowed: normVar(pitcherData.yrfiAllowed, LEAGUE.YRFI_ALLOWED, LEAGUE.YRFI_ALLOWED_SD, PITCHER_WEIGHTS.yrfiAllowed, pitcherData.gs, SAMPLE_MIN.FIRST_INN_GS, true),
    pitchCount: normVar(pitcherData.pitchCount12, LEAGUE.PITCH_COUNT_1_2, LEAGUE.PITCH_COUNT_1_2_SD, PITCHER_WEIGHTS.pitchCount, pitcherData.gs, SAMPLE_MIN.PITCHER_GS, true),
    ttoPenalty: normVar(pitcherData.ttoPenalty, LEAGUE.TTO_PENALTY, LEAGUE.TTO_PENALTY_SD, PITCHER_WEIGHTS.ttoPenalty, pitcherData.tto1Pa, SAMPLE_MIN.TTO1_PA, true),
    whip13: normVar(pitcherData.whip13, LEAGUE.WHIP_1_3, LEAGUE.WHIP_1_3_SD, PITCHER_WEIGHTS.whip13, pitcherData.gs, SAMPLE_MIN.PITCHER_GS, true),
  };

  // ── 4. Suma ponderada con renormalización (variables N/D no penalizan) ──
  const offenseScore = weightedAvg(offVars);
  const pitcherSuppressionScore = weightedAvg(pitVars);
  const ereRaw = Math.round((0.5 * offenseScore + 0.5 * (100 - pitcherSuppressionScore)) * 10) / 10;

  // ── 5. Park & weather modifier ──────────────────────────────────────────
  const parkFactor = venue ? (PARK_FACTORS_EARLY[venue] ?? 1.00) : 1.00;
  let weatherModifier = 1.00;
  if (tempF !== undefined && tempF < 55) weatherModifier *= 0.92;
  if (tempF !== undefined && tempF >= 85) weatherModifier *= 1.03;
  if (windMph !== undefined && windDirOut && windMph >= 10) weatherModifier *= 1.05;

  const ereScore = Math.max(0, Math.min(100, Math.round(ereRaw * parkFactor * weatherModifier * 10) / 10));

  // ── 6. Categoría + sugerencias de mercado ───────────────────────────────
  const { category, marketSuggestions } = classifyEre(ereScore, offenseScore, pitcherSuppressionScore, teamMetrics.probFirstInn);
  const warnings = collectWarnings(offVars, pitVars, teamMetrics, pitcherData);

  return {
    teamId, teamName,
    ereScore, ereRaw,
    category,
    offenseScore: Math.round(offenseScore * 10) / 10,
    pitcherSuppressionScore: Math.round(pitcherSuppressionScore * 10) / 10,
    parkFactor, weatherModifier,
    variables: { offense: offVars, pitcher: pitVars },
    marketSuggestions, warnings,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// NORMALIZACIÓN z-score → 0-100 con shrinkage por muestra
// ──────────────────────────────────────────────────────────────────────────
function normVar(
  raw: number | null,
  mean: number, sd: number,
  weight: number,
  sample: number, sampleMin: number,
  inverted: boolean = false
) {
  if (raw === null || raw === undefined || isNaN(raw)) {
    return { raw: null, score: 50, weight: 0, sample }; // weight=0 hace que se ignore en weightedAvg
  }
  // Z-score
  let z = (raw - mean) / sd;
  if (inverted) z = -z;
  // Shrinkage si muestra < mínimo
  if (sample < sampleMin) {
    const trust = Math.max(0.30, sample / sampleMin);
    z = z * trust;
  }
  // Map z [-3, +3] → [0, 100]
  const score = Math.max(0, Math.min(100, 50 + z * 16.67));
  return { raw, score: Math.round(score * 10) / 10, weight, sample };
}

function weightedAvg(vars: Record<string, { score: number; weight: number }>): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const v of Object.values(vars)) {
    totalWeight += v.weight;
    weightedSum += v.s
