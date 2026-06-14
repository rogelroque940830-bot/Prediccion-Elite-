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
import { fetchSavantTeamXwobaVsHand } from "./mlb-savant-team.js";
import { getRotowireLineupForGame, type RotowireGame } from "./mlb-rotowire-lineups.js";

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
  // Top-4 lineup wOBA vs mano del pitcher (específico para NRFI/YRFI)
  top4LineupWoba?: { woba: number; pa: number; battersUsed: number } | null;
  // Procedencia de top5xwoba (real Savant vs proxy)
  dataSources?: {
    top5xwoba: "savant" | "proxy" | "none";
    savantXwobaRaw?: number;
    savantPa?: number;
    lineupSource: "rotowire" | "mlb-boxscore" | "mlb-pa-fallback" | "none";
    lineupStatus?: "CONFIRMED" | "EXPECTED" | "PROJECTED" | "UNKNOWN";
    lineupBatters?: number;        // 0-9, cuántos bateadores Rotowire reconoció
    pitcherPrior?: number;         // Prior individual del pitcher (0-100)
    pitcherPriorUsed?: boolean;    // ¿Se aplicó regresión hacia prior?
    pitcherSeasonEra?: number;     // ERA season usada para el prior
  };
}

export async function computeMlbEre(input: EreInput): Promise<EreResult> {
  const { teamId, teamName, gamePk, opposingPitcherId, opposingPitcherHand, venue, tempF, windMph, windDirOut } = input;

  // ── 0. Rotowire lineup (anticipa 4-6h, mejor que boxscore que confirma 30min antes)
  let rotowireLineup: RotowireGame | null = null;
  let rotowireSide: "visit" | "home" | null = null;
  let rotowireBatterIds: number[] = [];
  if (gamePk) {
    try {
      rotowireLineup = await getRotowireLineupForGame(gamePk);
      if (rotowireLineup) {
        // Detectar si el teamId es visit o home
        // Estrategia: matchear cualquier batter con MLB ID resuelto
        const visitIds = rotowireLineup.visit.batters.map((b) => b.mlbId).filter((x): x is number => !!x);
        const homeIds = rotowireLineup.home.batters.map((b) => b.mlbId).filter((x): x is number => !!x);
        // Cross-check con boxscore: pedir lado correcto
        try {
          const bx = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
          const bj: any = await bx.json();
          if (bj.teams?.home?.team?.id === teamId) {
            rotowireSide = "home";
            rotowireBatterIds = homeIds;
          } else if (bj.teams?.away?.team?.id === teamId) {
            rotowireSide = "visit";
            rotowireBatterIds = visitIds;
          }
        } catch { /* keep null */ }
      }
    } catch { /* silent */ }
  }

  // ── 1. Offense data (paralelo) ──────────────────────────────────────────
  const useRotowire = rotowireBatterIds.length >= 5;
  const [teamMetrics, lineupTop3, savantTop5, savantTeamXwoba, lineupTop4Woba] = await Promise.all([
    computeTeamEarlyMetrics(teamId),
    gamePk ? computeLineupTop3OBP(gamePk, teamId, useRotowire ? rotowireBatterIds : undefined) : Promise.resolve(null),
    gamePk ? computeTop5IsoK(gamePk, teamId, useRotowire ? rotowireBatterIds : undefined) : Promise.resolve(null),
    opposingPitcherHand ? fetchSavantTeamXwobaVsHand(teamId, opposingPitcherHand) : Promise.resolve(null),
    (gamePk && opposingPitcherHand)
      ? computeLineupTop4Woba(gamePk, teamId, opposingPitcherHand, useRotowire ? rotowireBatterIds : undefined)
      : Promise.resolve(null),
  ]);

  // Reemplazar proxy xwOBA del lineup top-5 con Savant team xwOBA real cuando esté disponible.
  // Política: Savant team-level (real) toma precedencia. Si falla, mantener proxy lineup-level.
  let top5XwobaForEre: number | null = savantTop5?.xwoba ?? null;
  let top5XwobaPaForEre: number = savantTop5?.pa ?? 0;
  let top5XwobaSource: "savant" | "proxy" | "none" = top5XwobaForEre !== null ? "proxy" : "none";
  if (savantTeamXwoba && savantTeamXwoba.xwoba > 0) {
    top5XwobaForEre = savantTeamXwoba.xwoba;
    top5XwobaPaForEre = savantTeamXwoba.pa || top5XwobaPaForEre || 100;
    top5XwobaSource = "savant";
  }

  // ── 2. Pitcher data (paralelo) ──────────────────────────────────────────
  const pitcherData = opposingPitcherId
    ? await computePitcherEarlyMetrics(opposingPitcherId)
    : emptyPitcherData();

  // ── 3. Normalizar variables individuales ────────────────────────────────
  const offVars: EreResult["variables"]["offense"] = {
    runs13: normVar(teamMetrics.earlyOff, LEAGUE.RUNS_1_3, LEAGUE.RUNS_1_3_SD, OFFENSE_WEIGHTS.runs13, teamMetrics.gamesAnalyzed, SAMPLE_MIN.TEAM_GP),
    f5: normVar(teamMetrics.f5Runs, LEAGUE.F5_RUNS, LEAGUE.F5_RUNS_SD, OFFENSE_WEIGHTS.f5, teamMetrics.gamesAnalyzed, SAMPLE_MIN.TEAM_GP),
    yrfi: normVar(teamMetrics.probFirstInn, LEAGUE.YRFI_RATE, LEAGUE.YRFI_RATE_SD, OFFENSE_WEIGHTS.yrfi, teamMetrics.gamesAnalyzed, SAMPLE_MIN.TEAM_GP),
    top5xwoba: normVar(top5XwobaForEre, LEAGUE.TOP5_XWOBA, LEAGUE.TOP5_XWOBA_SD, OFFENSE_WEIGHTS.top5xwoba, top5XwobaPaForEre, SAMPLE_MIN.BATTER_PA),
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
  // Prior individual del pitcher: derivado de su ERA/WHIP/K9 season completos.
  // Usado para regresión cuando faltan variables Statcast específicas (rookies,
  // relievers como Fisher con pocas starts, etc.) en vez de regresar a 50.
  const pitcherPrior = pitcherData.seasonIp >= 10 ? computePitcherPrior(pitcherData) : 50;
  const offenseScore = weightedAvg(offVars);
  const pitcherSuppressionScore = weightedAvg(pitVars, pitcherPrior);
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
    top4LineupWoba: lineupTop4Woba,
    marketSuggestions, warnings,
    dataSources: {
      top5xwoba: top5XwobaSource,
      savantXwobaRaw: savantTeamXwoba?.xwoba,
      savantPa: savantTeamXwoba?.pa,
      lineupSource: useRotowire
        ? "rotowire"
        : (lineupTop3 || savantTop5 ? "mlb-boxscore" : "none"),
      lineupStatus: rotowireSide && rotowireLineup
        ? rotowireLineup[rotowireSide].status
        : undefined,
      lineupBatters: useRotowire ? rotowireBatterIds.length : undefined,
      pitcherPrior: Math.round(pitcherPrior * 10) / 10,
      pitcherPriorUsed: pitcherData.seasonIp >= 10 &&
        Object.values(pitVars).filter((v: any) => v.weight === 0).length > 0,
      pitcherSeasonEra: pitcherData.seasonEra ?? undefined,
    },
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

// Pesos totales esperados (offense suma 100%, pitcher suma 100%).
// Si peso disponible < UMBRAL_FULL, regresamos el score hacia 50 (neutral)
// para evitar falsa confianza con sample chico (ej. pitcher con 1-2 starts).
const UMBRAL_FULL = 70; // % de peso disponible para no regresar

function weightedAvg(
  vars: Record<string, { score: number; weight: number }>,
  prior: number = 50  // Prior individual (e.g. derivado de season stats); default = liga
): number {
  let availableWeight = 0;
  let weightedSum = 0;
  let nMissing = 0;
  for (const v of Object.values(vars)) {
    if (v.weight > 0) {
      availableWeight += v.weight;
      weightedSum += v.score * v.weight;
    } else {
      nMissing++;
    }
  }
  if (availableWeight === 0) return prior;
  const rawScore = weightedSum / availableWeight;
  if (nMissing === 0) return rawScore;
  const coverage = availableWeight / 100;
  if (coverage >= UMBRAL_FULL / 100) return rawScore;
  // Regresión hacia el PRIOR (no 50 fijo). Si tenemos prior individual del
  // pitcher (ej. ERA 2.73 → prior 65), usamos eso en vez de promedio liga.
  return coverage * rawScore + (1 - coverage) * prior;
}

// ──────────────────────────────────────────────────────────────────────────
// CLASIFICACIÓN + SUGERENCIAS DE MERCADO
// ──────────────────────────────────────────────────────────────────────────
function classifyEre(ere: number, off: number, sup: number, yrfi: number) {
  const suggestions: string[] = [];
  let category: EreResult["category"];

  if (ere >= 75) {
    category = "ELITE_EARLY";
    suggestions.push("YRFI fuerte");
    suggestions.push("F5 OVER");
    suggestions.push("Team Total F5 OVER si línea ≤2.0");
    suggestions.push("Full Game OVER (peso 30%)");
  } else if (ere >= 65) {
    category = "STRONG_EARLY";
    if (yrfi >= 0.32) suggestions.push("YRFI");
    suggestions.push("F5 OVER");
  } else if (ere >= 55) {
    category = "SLIGHT_OVER";
    suggestions.push("Team Total F5 OVER si línea baja");
  } else if (ere >= 45) {
    category = "NEUTRAL";
    suggestions.push("Sin edge early — enfocar full game");
  } else if (ere >= 35) {
    category = "SLOW_START";
    suggestions.push("F5 UNDER conservador");
  } else {
    category = "STRONG_SLOW";
    suggestions.push("NRFI");
    suggestions.push("F5 UNDER");
    suggestions.push("Team Total F5 UNDER");
  }

  return { category, marketSuggestions: suggestions };
}

function collectWarnings(
  off: EreResult["variables"]["offense"],
  pit: EreResult["variables"]["pitcher"],
  teamM: any, pitM: any
): string[] {
  const ws: string[] = [];
  if (teamM.gamesAnalyzed < SAMPLE_MIN.TEAM_GP)
    ws.push(`Muestra equipo pequeña (${teamM.gamesAnalyzed} GP < ${SAMPLE_MIN.TEAM_GP}) — shrinkage aplicado`);
  if (pitM.gs > 0 && pitM.gs < SAMPLE_MIN.PITCHER_GS)
    ws.push(`Pitcher con pocas starts (${pitM.gs} GS) — datos inestables`);
  if (pitM.tto1Pa < SAMPLE_MIN.TTO1_PA && pitM.tto1Pa > 0)
    ws.push(`Pitcher TTO1 con <${SAMPLE_MIN.TTO1_PA} PA — xwOBA/K-BB% regresados a liga`);
  if (off.top5xwoba.raw === null) ws.push("Top-5 xwOBA vs hand no disponible (Savant fallback)");
  if (pit.xwobaTto1.raw === null && pitM.gs > 0) ws.push("xwOBA TTO1 del pitcher no disponible");
  return ws;
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: Team early metrics (runs 1-3, F5, prob 1st inn, L7 RPG)
// ──────────────────────────────────────────────────────────────────────────
async function computeTeamEarlyMetrics(teamId: number) {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${fmt(start)}&endDate=${fmt(end)}&gameType=R`;
  let gamePks: number[] = [];
  // BUG FIX: /linescore NO devuelve teams.home.team.id, mapeamos desde el schedule.
  const gameTeamMap = new Map<number, { homeId: number; awayId: number }>();
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    for (const dd of j.dates ?? []) {
      for (const g of dd.games ?? []) {
        if (g.status?.detailedState === "Final") {
          gamePks.push(g.gamePk);
          gameTeamMap.set(g.gamePk, {
            homeId: g.teams?.home?.team?.id,
            awayId: g.teams?.away?.team?.id,
          });
        }
      }
    }
    console.log(`[ERE] team ${teamId}: fetched ${gamePks.length} finalized games from schedule`);
  } catch (e) {
    console.error(`[ERE] team ${teamId}: schedule fetch FAILED:`, e);
    return { gamesAnalyzed: 0, earlyOff: 0, f5Runs: 0, probFirstInn: 0, l7Rpg: LEAGUE.L7_RPG };
  }
  const recent = gamePks.slice(-30);

  const linescores = await Promise.all(
    recent.map(async (pk) => {
      try {
        const lr = await fetch(`https://statsapi.mlb.com/api/v1/game/${pk}/linescore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
        const data = await lr.json() as any;
        // Inyectar teamIds desde el map porque /linescore no los trae
        const ids = gameTeamMap.get(pk);
        if (ids) {
          if (data.teams?.home) data.teams.home.__teamId = ids.homeId;
          if (data.teams?.away) data.teams.away.__teamId = ids.awayId;
        }
        return data;
      } catch { return null; }
    })
  );

  let totalEarlyOff = 0, totalF5 = 0, firstInnScored = 0, gamesAnalyzed = 0;
  const l7Runs: number[] = [];

  for (let idx = 0; idx < linescores.length; idx++) {
    const ls = linescores[idx];
    if (!ls) continue;
    // Usar el campo inyectado __teamId (ver map arriba). El default team.id no existe en /linescore.
    const isHome = ls.teams?.home?.__teamId === teamId || ls.teams?.home?.team?.id === teamId;
    const isAway = ls.teams?.away?.__teamId === teamId || ls.teams?.away?.team?.id === teamId;
    if (!isHome && !isAway) continue;
    const innings = ls.innings ?? [];
    if (innings.length < 3) continue;

    let earlyOffG = 0, f5G = 0;
    for (let i = 0; i < Math.min(5, innings.length); i++) {
      const inn = innings[i];
      const myRuns = isHome ? (inn.home?.runs ?? 0) : (inn.away?.runs ?? 0);
      if (i < 3) {
        earlyOffG += myRuns;
        if (i === 0 && myRuns > 0) firstInnScored++;
      }
      f5G += myRuns;
    }
    const fullGameRuns = isHome ? (ls.teams?.home?.runs ?? 0) : (ls.teams?.away?.runs ?? 0);
    totalEarlyOff += earlyOffG;
    totalF5 += f5G;
    gamesAnalyzed++;
    l7Runs.push(fullGameRuns);
  }

  const g = Math.max(1, gamesAnalyzed);
  const last7 = l7Runs.slice(-7);
  const l7Rpg = last7.length > 0 ? last7.reduce((a, b) => a + b, 0) / last7.length : LEAGUE.L7_RPG;

  return {
    gamesAnalyzed,
    earlyOff: Math.round((totalEarlyOff / g) * 100) / 100,
    f5Runs: Math.round((totalF5 / g) * 100) / 100,
    probFirstInn: Math.round((firstInnScored / g) * 100) / 100,
    l7Rpg: Math.round(l7Rpg * 100) / 100,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: xwOBA del top-5 vs mano del pitcher rival
// ──────────────────────────────────────────────────────────────────────────
async function computeXwobaTop5VsHand(teamId: number, hand: "R" | "L"): Promise<{ xwoba: number; pa: number } | null> {
  // Proxy: usar team OPS vs hand × 0.92 como aproximación de xwOBA team
  // (Savant team xwOBA splits no son trivialmente accesibles vía API pública)
  try {
    const sit = hand === "R" ? "vr" : "vl";
    const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?season=2026&stats=statSplits&group=hitting&sitCodes=${sit}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const stat = j.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) return null;
    const ops = parseFloat(stat.ops);
    const pa = parseInt(stat.plateAppearances) || 0;
    if (!ops || isNaN(ops)) return null;
    // OPS → xwOBA approx (regresión empírica: xwOBA ≈ 0.42 × OPS + 0.005)
    const xwoba = 0.42 * ops + 0.005;
    return { xwoba: Math.round(xwoba * 1000) / 1000, pa };
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: Top-3 lineup OBP (vía boxscore)
// ──────────────────────────────────────────────────────────────────────────
async function computeLineupTop3OBP(
  gamePk: number,
  teamId: number,
  overrideIds?: number[]
): Promise<{ obp: number; pa: number } | null> {
  try {
    let ids: number[] = [];
    if (overrideIds && overrideIds.length >= 3) {
      ids = overrideIds.slice(0, 3);
    } else {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
      const j: any = await r.json();
      const side = j.teams?.home?.team?.id === teamId ? "home" : "away";
      const battingOrder: any[] = j.teams?.[side]?.battingOrder ?? [];
      const players = j.teams?.[side]?.players || {};
      if (battingOrder.length >= 3) {
        ids = battingOrder.slice(0, 3).map((id: any) => typeof id === "string" ? parseInt(id, 10) : id);
      } else {
        ids = Object.values(players)
          .filter((p: any) => p?.stats?.batting?.plateAppearances)
          .sort((a: any, b: any) => (b.stats.batting.plateAppearances || 0) - (a.stats.batting.plateAppearances || 0))
          .slice(0, 3)
          .map((p: any) => p.person?.id)
          .filter(Boolean);
      }
    }
    if (ids.length === 0) return null;

    const seasonStats = await Promise.all(ids.map(async (pid) => {
      try {
        const pr = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2026&group=hitting`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
        const pj: any = await pr.json();
        const s = pj.stats?.[0]?.splits?.[0]?.stat;
        if (!s) return null;
        return { obp: parseFloat(s.obp) || 0, pa: parseInt(s.plateAppearances) || 0 };
      } catch { return null; }
    }));
    const valid = seasonStats.filter((s): s is NonNullable<typeof s> => s !== null && s.pa >= 20);
    if (valid.length === 0) return null;
    const avgObp = valid.reduce((a, b) => a + b.obp, 0) / valid.length;
    const totalPa = valid.reduce((a, b) => a + b.pa, 0);
    return { obp: Math.round(avgObp * 1000) / 1000, pa: totalPa };
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: Top-4 lineup wOBA vs mano del pitcher (NRFI/YRFI específico)
// Pondera por slot (1-2 ven más PA por turno que 3-4)
// ──────────────────────────────────────────────────────────────────────────
export async function computeLineupTop4Woba(
  gamePk: number,
  teamId: number,
  opposingPitcherHand: "L" | "R",
  overrideIds?: number[]
): Promise<{ woba: number; pa: number; battersUsed: number } | null> {
  try {
    let ids: number[] = [];
    if (overrideIds && overrideIds.length >= 4) {
      ids = overrideIds.slice(0, 4);
    } else {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
      const j: any = await r.json();
      const side = j.teams?.home?.team?.id === teamId ? "home" : "away";
      const battingOrder: any[] = j.teams?.[side]?.battingOrder ?? [];
      const players = j.teams?.[side]?.players || {};
      if (battingOrder.length >= 4) {
        ids = battingOrder.slice(0, 4).map((id: any) => typeof id === "string" ? parseInt(id, 10) : id);
      } else {
        ids = Object.values(players)
          .filter((p: any) => p?.stats?.batting?.plateAppearances)
          .sort((a: any, b: any) => (b.stats.batting.plateAppearances || 0) - (a.stats.batting.plateAppearances || 0))
          .slice(0, 4)
          .map((p: any) => p.person?.id)
          .filter(Boolean);
      }
    }
    if (ids.length < 3) return null;

    // Split vs hand del pitcher + RECENT 15 días para blend de momentum
    const sitCode = opposingPitcherHand === "L" ? "vl" : "vr";
    const today = new Date();
    const past = new Date(today); past.setDate(past.getDate() - 15);
    const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

    const calcWoba = (s: any): { woba: number; pa: number } | null => {
      if (!s) return null;
      const ab = parseInt(s.atBats) || 0;
      const bb = parseInt(s.baseOnBalls) || 0;
      const ibb = parseInt(s.intentionalWalks) || 0;
      const hbp = parseInt(s.hitByPitch) || 0;
      const sf = parseInt(s.sacFlies) || 0;
      const hits = parseInt(s.hits) || 0;
      const doubles = parseInt(s.doubles) || 0;
      const triples = parseInt(s.triples) || 0;
      const hr = parseInt(s.homeRuns) || 0;
      const pa = parseInt(s.plateAppearances) || 0;
      const singles = hits - doubles - triples - hr;
      const denom = ab + bb - ibb + sf + hbp;
      if (denom <= 0) return null;
      const ubb = bb - ibb;
      const woba = (0.69 * ubb + 0.72 * hbp + 0.89 * singles + 1.27 * doubles + 1.62 * triples + 2.10 * hr) / denom;
      return { woba, pa };
    };

    const stats = await Promise.all(ids.map(async (pid) => {
      try {
        // 1. SEASON vs hand
        const seasonPr = await fetch(
          `https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=statSplits&season=2026&group=hitting&sitCodes=${sitCode}`,
          { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }
        );
        const seasonJ: any = await seasonPr.json();
        const seasonW = calcWoba(seasonJ.stats?.[0]?.splits?.[0]?.stat);
        if (!seasonW || seasonW.pa < 15) return null;

        // 2. RECENT 15 días (general, no split por mano — sample chico ya)
        let recentW: { woba: number; pa: number } | null = null;
        try {
          const recentPr = await fetch(
            `https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=byDateRange&startDate=${fmtDate(past)}&endDate=${fmtDate(today)}&group=hitting`,
            { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }
          );
          const recentJ: any = await recentPr.json();
          recentW = calcWoba(recentJ.stats?.[0]?.splits?.[0]?.stat);
        } catch { /* ignore */ }

        // 3. BLEND 60% recent + 40% season cuando recent tiene ≥8 PA
        let finalWoba = seasonW.woba;
        if (recentW && recentW.pa >= 8) {
          finalWoba = 0.6 * recentW.woba + 0.4 * seasonW.woba;
        }
        return { woba: finalWoba, pa: seasonW.pa };
      } catch { return null; }
    }));
    const valid = stats.filter((s): s is NonNullable<typeof s> => s !== null);
    if (valid.length < 3) return null;

    // Slot weights: slots 1-2 ven más PA por turno que 3-4
    const slotWeights = [1.15, 1.10, 1.05, 1.00];
    let totalWeight = 0, weightedWoba = 0, totalPa = 0;
    valid.forEach((s, i) => {
      const w = slotWeights[i] ?? 1.0;
      weightedWoba += s.woba * w;
      totalWeight += w;
      totalPa += s.pa;
    });
    return {
      woba: Math.round((weightedWoba / totalWeight) * 1000) / 1000,
      pa: totalPa,
      battersUsed: valid.length,
    };
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: Top-5 ISO y K% del lineup
// ──────────────────────────────────────────────────────────────────────────
async function computeTop5IsoK(
  gamePk: number,
  teamId: number,
  overrideIds?: number[]
): Promise<{ iso: number; kPct: number; xwoba: number; pa: number } | null> {
  try {
    let ids: number[] = [];
    if (overrideIds && overrideIds.length >= 5) {
      ids = overrideIds.slice(0, 5);
    } else {
      const r = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
      const j: any = await r.json();
      const side = j.teams?.home?.team?.id === teamId ? "home" : "away";
      const battingOrder: any[] = j.teams?.[side]?.battingOrder ?? [];
      const players = j.teams?.[side]?.players || {};
      if (battingOrder.length >= 5) {
        ids = battingOrder.slice(0, 5).map((id: any) => typeof id === "string" ? parseInt(id, 10) : id);
      } else {
        ids = Object.values(players)
          .filter((p: any) => p?.stats?.batting?.plateAppearances)
          .sort((a: any, b: any) => (b.stats.batting.plateAppearances || 0) - (a.stats.batting.plateAppearances || 0))
          .slice(0, 5)
          .map((p: any) => p.person?.id)
          .filter(Boolean);
      }
    }
    if (ids.length === 0) return null;

    const stats = await Promise.all(ids.map(async (pid) => {
      try {
        const pr = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2026&group=hitting`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
        const pj: any = await pr.json();
        const s = pj.stats?.[0]?.splits?.[0]?.stat;
        if (!s) return null;
        const pa = parseInt(s.plateAppearances) || 0;
        const so = parseInt(s.strikeOuts) || 0;
        const slg = parseFloat(s.slg) || 0;
        const avg = parseFloat(s.avg) || 0;
        const ops = parseFloat(s.ops) || 0;
        return {
          iso: slg - avg,
          kPct: pa > 0 ? so / pa : 0,
          xwoba: 0.42 * ops + 0.005, // proxy
          pa,
        };
      } catch { return null; }
    }));
    const valid = stats.filter((s): s is NonNullable<typeof s> => s !== null && s.pa >= 20);
    if (valid.length === 0) return null;
    const avgIso = valid.reduce((a, b) => a + b.iso, 0) / valid.length;
    const avgK = valid.reduce((a, b) => a + b.kPct, 0) / valid.length;
    const avgXwoba = valid.reduce((a, b) => a + b.xwoba, 0) / valid.length;
    const totalPa = valid.reduce((a, b) => a + b.pa, 0);
    return {
      iso: Math.round(avgIso * 1000) / 1000,
      kPct: Math.round(avgK * 1000) / 1000,
      xwoba: Math.round(avgXwoba * 1000) / 1000,
      pa: totalPa,
    };
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────────
// HELPER: Pitcher early metrics (8 variables)
// ──────────────────────────────────────────────────────────────────────────
function emptyPitcherData() {
  return {
    firstInnEra: null as number | null,
    xwobaTto1: null as number | null,
    kbbTto1: null as number | null,
    runs13Gs: null as number | null,
    yrfiAllowed: null as number | null,
    pitchCount12: null as number | null,
    ttoPenalty: null as number | null,
    whip13: null as number | null,
    gs: 0,
    tto1Pa: 0,
    // Season-wide stats para usar como PRIOR cuando faltan vars Statcast específicas
    seasonEra: null as number | null,
    seasonWhip: null as number | null,
    seasonK9: null as number | null,
    seasonIp: 0,
    // F5 AGREGADO (innings 1-5 desde MLB Stats API sitCodes) — NEW 14 jun 2026
    f5Era: null as number | null,
    f5K9: null as number | null,
    f5Bb9: null as number | null,
    f5KbbPct: null as number | null,
    f5Whip: null as number | null,
    f5Hr9: null as number | null,
    f5Ip: 0,
    f5InningsByInning: null as Record<string, { era: number; ip: number; er: number; k: number; bb: number; h: number; hr: number }> | null,
    // TTO penalty REAL basado en ERA (reemplaza ttoPenalty xwOBA roto)
    tto1EraProxy: null as number | null,   // ERA innings 1-3
    tto1Whip: null as number | null,
    tto1K9: null as number | null,
    tto2EraProxy: null as number | null,   // ERA innings 4-6
    tto2Whip: null as number | null,
    tto3EraProxy: null as number | null,   // ERA innings 7-9
    ttoPenaltyEra: null as number | null,  // TTO2 - TTO1 (qué tanto empeora 2da vuelta)
    tto3PenaltyEra: null as number | null, // TTO3 - TTO2 (qué tanto empeora 3ra vuelta/bullpen)
  };
}

// ──────────────────────────────────────────────────────────────────────────
// RECENT FORM: extrae stats de 1er inning de las últimas N starts
// Detecta tendencias (pitcher mejorando o empeorando) que el season-wide oculta.
// ──────────────────────────────────────────────────────────────────────────
interface PitcherRecentStats {
  firstInnEra: number | null;
  yrfiAllowed: number | null;
  whip13: number | null;
  startsAnalyzed: number;
}

async function computePitcherRecentStats(
  pitcherId: number,
  windowStarts: number = 4
): Promise<PitcherRecentStats> {
  const empty: PitcherRecentStats = { firstInnEra: null, yrfiAllowed: null, whip13: null, startsAnalyzed: 0 };
  try {
    // 1. Obtener gamePks de las últimas N starts completas
    const lr = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }
    );
    const lj: any = await lr.json();
    const todayStr = new Date().toISOString().slice(0, 10);
    const starts = ((lj.stats?.[0]?.splits ?? []) as any[])
      .filter((s: any) => {
        const gs = parseInt(s.stat?.gamesStarted) || 0;
        const ip = parseFloat(s.stat?.inningsPitched || "0");
        return gs >= 1 && ip >= 3 && s.date !== todayStr;
      })
      .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, windowStarts);

    if (starts.length < 3) return empty; // muestra insuficiente

    // 2. Para cada start, extraer 1er inning del feed/live
    let totalRuns = 0, totalH = 0, totalBB = 0, totalOuts = 0, yrfiCount = 0;
    const fetches = starts.map(async (start: any) => {
      const gpk = start.game?.gamePk;
      if (!gpk) return null;
      try {
        const fr = await fetch(
          `https://statsapi.mlb.com/api/v1.1/game/${gpk}/feed/live`,
          { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } }
        );
        const fj: any = await fr.json();
        const plays = fj.liveData?.plays?.allPlays || [];
        const firstInn = plays.filter((p: any) => p.about?.inning === 1 && p.matchup?.pitcher?.id === pitcherId);
        let runs = 0, h = 0, bb = 0, outs = 0;
        for (const p of firstInn) {
          if (["single", "double", "triple", "home_run"].includes(p.result?.eventType)) h++;
          if (p.result?.eventType === "walk") bb++;
          runs += parseInt(p.result?.rbi || "0") || 0;
          const eventType = p.result?.eventType || "";
          if (["field_out", "strikeout", "force_out", "grounded_into_double_play", "sac_fly", "sac_bunt"].includes(eventType)) outs++;
        }
        return { runs, h, bb, outs };
      } catch { return null; }
    });
    const results = (await Promise.all(fetches)).filter((r): r is { runs: number; h: number; bb: number; outs: number } => r !== null);
    if (results.length < 3) return empty;
    for (const r of results) {
      totalRuns += r.runs;
      totalH += r.h;
      totalBB += r.bb;
      totalOuts += Math.max(3, r.outs); // mínimo 3 outs por start completo
      if (r.runs > 0) yrfiCount++;
    }
    const ipReal = totalOuts / 3;
    return {
      firstInnEra: ipReal > 0 ? Math.round((totalRuns / ipReal) * 9 * 100) / 100 : null,
      yrfiAllowed: results.length > 0 ? Math.round((yrfiCount / results.length) * 100) / 100 : null,
      whip13: ipReal > 0 ? Math.round(((totalH + totalBB) / ipReal) * 100) / 100 : null,
      startsAnalyzed: results.length,
    };
  } catch {
    return empty;
  }
}

// Mezcla 60% recent + 40% season cuando recent es confiable (>=3 starts)
function blendRecentSeason(recent: number | null, season: number | null, recentN: number): number | null {
  if (season === null) return recent;
  if (recent === null || recentN < 3) return season;
  return Math.round((0.6 * recent + 0.4 * season) * 100) / 100;
}

// Calcula prior individual del pitcher (0-100) desde sus stats season completas.
// Usado cuando faltan variables Statcast específicas — mejor que regresar a 50
// porque preserva el conocimiento que tenemos del pitcher de toda la temporada.
function computePitcherPrior(d: ReturnType<typeof emptyPitcherData>): number {
  if (d.seasonIp < 10 || d.seasonEra == null) return 50; // sin muestra suficiente
  // ERA: LEAGUE 4.20, SD 1.00. Bajo es bueno (invertido)
  const eraZ = -(d.seasonEra - 4.20) / 1.00;
  const eraScore = Math.max(0, Math.min(100, 50 + eraZ * 16.67));
  // WHIP: LEAGUE 1.30, SD 0.20. Bajo es bueno
  let whipScore = 50;
  if (d.seasonWhip != null) {
    const whipZ = -(d.seasonWhip - 1.30) / 0.20;
    whipScore = Math.max(0, Math.min(100, 50 + whipZ * 16.67));
  }
  // K/9: LEAGUE 8.5, SD 1.5. Alto es bueno
  let k9Score = 50;
  if (d.seasonK9 != null) {
    const k9Z = (d.seasonK9 - 8.5) / 1.5;
    k9Score = Math.max(0, Math.min(100, 50 + k9Z * 16.67));
  }
  // Pesos: 50% ERA, 30% WHIP, 20% K/9 (ERA es la más descriptiva del resultado)
  return 0.5 * eraScore + 0.3 * whipScore + 0.2 * k9Score;
}

async function computePitcherEarlyMetrics(pitcherId: number) {
  const data = emptyPitcherData();

  // a0) Season stats completas (ERA, WHIP, K/9) — usado como PRIOR
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&season=2026&group=pitching`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const s = j.stats?.[0]?.splits?.[0]?.stat;
    if (s) {
      const era = parseFloat(s.era);
      const whip = parseFloat(s.whip);
      const k9 = parseFloat(s.strikeoutsPer9Inn);
      const ip = parseFloat(s.inningsPitched || "0");
      if (isFinite(era)) data.seasonEra = era;
      if (isFinite(whip)) data.seasonWhip = whip;
      if (isFinite(k9)) data.seasonK9 = k9;
      data.seasonIp = ip;
    }
  } catch { /* ignore */ }

  // a) Inning-by-inning splits (sitCodes=i01,i02,i03,i04,i05,i06,i07,i08,i09)
  // NEW 14 jun 2026: extiende para soportar F5 + TTO penalty real basado en ERA.
  // Reemplaza el TTO penalty xwOBA (roto por Savant timeout) con un proxy ERA más
  // directo: TTO1=ERA innings 1-3, TTO2=ERA innings 4-6, TTO3=ERA innings 7-9.
  // TTO penalty real = TTO2_era - TTO1_era (cómo empeora segunda vez orden).
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&season=2026&group=pitching&sitCodes=i01,i02,i03,i04,i05,i06,i07,i08,i09`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const splits = j.stats?.[0]?.splits ?? [];

    // Map per-inning stats indexed by inning code (i01-i05)
    const inningMap: Record<string, any> = {};
    for (const s of splits) {
      const code = s.split?.code; // e.g. "i01"
      if (code) inningMap[code] = s.stat;
    }

    // Inning 1 stats — mantiene firstInnEra/yrfiAllowed/whip13 para compatibilidad
    const i01 = inningMap["i01"];
    if (i01) {
      const er = parseInt(i01.earnedRuns) || 0;
      const ip = parseFloat(i01.inningsPitched || "0");
      if (ip > 0) data.firstInnEra = Math.round((er / ip) * 9 * 100) / 100;
      const gs = parseInt(i01.gamesStarted) || 0;
      data.gs = Math.max(data.gs, gs);
      const r1 = parseInt(i01.runs) || 0;
      const gp = parseInt(i01.gamesPlayed) || 0;
      if (gp > 0) data.yrfiAllowed = Math.min(1, r1 / gp);
      const h = parseInt(i01.hits) || 0;
      const bb = parseInt(i01.baseOnBalls) || 0;
      if (ip > 0) data.whip13 = Math.round(((h + bb) / ip) * 100) / 100;
    }

    // Helper: aggregate stats for a group of innings
    const aggregate = (codes: string[]) => {
      let ip = 0, er = 0, k = 0, bb = 0, h = 0, hr = 0, r = 0;
      for (const c of codes) {
        const s = inningMap[c];
        if (!s) continue;
        ip += parseFloat(s.inningsPitched || "0");
        er += parseInt(s.earnedRuns) || 0;
        k += parseInt(s.strikeOuts) || 0;
        bb += parseInt(s.baseOnBalls) || 0;
        h += parseInt(s.hits) || 0;
        hr += parseInt(s.homeRuns) || 0;
        r += parseInt(s.runs) || 0;
      }
      if (ip === 0) return null;
      return {
        ip,
        era: Math.round((er / ip) * 9 * 100) / 100,
        k9: Math.round((k / ip) * 9 * 100) / 100,
        bb9: Math.round((bb / ip) * 9 * 100) / 100,
        whip: Math.round(((h + bb) / ip) * 100) / 100,
        hr9: Math.round((hr / ip) * 9 * 100) / 100,
        er, k, bb, h, hr, r,
      };
    };

    // F5 AGREGADO (innings 1-5)
    const innByInn: Record<string, { era: number; ip: number; er: number; k: number; bb: number; h: number; hr: number }> = {};
    for (let i = 1; i <= 9; i++) {
      const code = i < 10 ? `i0${i}` : `i${i}`;
      const s = inningMap[code];
      if (!s) continue;
      const ip = parseFloat(s.inningsPitched || "0");
      innByInn[code] = {
        era: ip > 0 ? Math.round(((parseInt(s.earnedRuns) || 0) / ip) * 9 * 100) / 100 : 0,
        ip,
        er: parseInt(s.earnedRuns) || 0,
        k: parseInt(s.strikeOuts) || 0,
        bb: parseInt(s.baseOnBalls) || 0,
        h: parseInt(s.hits) || 0,
        hr: parseInt(s.homeRuns) || 0,
      };
    }

    const f5 = aggregate(["i01", "i02", "i03", "i04", "i05"]);
    if (f5) {
      data.f5Era = f5.era;
      data.f5K9 = f5.k9;
      data.f5Bb9 = f5.bb9;
      data.f5Whip = f5.whip;
      data.f5Hr9 = f5.hr9;
      data.f5KbbPct = Math.round((f5.k9 - f5.bb9) * 100) / 100;
      data.f5Ip = f5.ip;
      data.f5InningsByInning = innByInn;
    }

    // TTO PROXIES desde ERA real (reemplaza xwOBA TTO que está roto en Savant)
    // TTO1 = first time through order ≈ innings 1-3 (lineup completo de 9)
    // TTO2 = second time through order ≈ innings 4-6
    // TTO3 = third time through order ≈ innings 7-9
    const tto1 = aggregate(["i01", "i02", "i03"]);
    const tto2 = aggregate(["i04", "i05", "i06"]);
    const tto3 = aggregate(["i07", "i08", "i09"]);

    if (tto1) {
      data.tto1EraProxy = tto1.era;
      data.tto1Whip = tto1.whip;
      data.tto1K9 = tto1.k9;
    }
    if (tto2) {
      data.tto2EraProxy = tto2.era;
      data.tto2Whip = tto2.whip;
    }
    if (tto3) {
      data.tto3EraProxy = tto3.era;
    }
    // TTO penalty REAL: cuánto empeora la 2da vuelta vs 1ra
    if (tto1 && tto2) {
      data.ttoPenaltyEra = Math.round((tto2.era - tto1.era) * 100) / 100;
    }
    // F6+ penalty (3ra vuelta / bullpen vs 2da)
    if (tto2 && tto3) {
      data.tto3PenaltyEra = Math.round((tto3.era - tto2.era) * 100) / 100;
    }
  } catch (e) {
    console.warn(`[mlb-ere] inning splits error para pitcher ${pitcherId}:`, e instanceof Error ? e.message : e);
  }

  // b) Season game logs para runs 1-3/GS y pitch count 1-2 (approx via averages)
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=2026&group=pitching`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    // BUG FIX: filtrar SOLO starts reales (no relief appearances ni juegos cancelados).
    // Antes contaba todos los items del game log → reportaba 6 GS cuando el pitcher
    // tenía 10 GS reales porque entradas con IP≤1 (cancelados, suspendidos, relief) inflaban.
    const allSplits = (j.stats?.[0]?.splits ?? []).slice().sort((a: any, b: any) => {
      return new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime();
    });
    // Filtrar: gamesStarted >= 1 + IP mínimo 3 (exclude in-progress/cancelled).
    // El partido del día actual con IP=1 (start en vivo) contamina recentEra y daysRest.
    const todayStr = new Date().toISOString().slice(0, 10);
    const startsOnly = allSplits.filter((s: any) => {
      const gs = parseInt(s.stat?.gamesStarted) || 0;
      if (gs < 1) return false;
      if (s.date === todayStr) return false;
      const ip = parseFloat(s.stat?.inningsPitched || "0");
      if (ip < 3) return false;
      return true;
    });
    const recent10 = startsOnly.slice(0, 10);
    if (recent10.length >= 2) {
      const totalGS = recent10.length;
      data.gs = Math.max(data.gs, totalGS);
      // Pitch count promedio primeras 2 innings: aprox = pitches/IP × 2
      let totalPitches = 0, totalIp = 0;
      for (const s of recent10) {
        totalPitches += parseInt(s.stat?.numberOfPitches) || 0;
        totalIp += parseFloat(s.stat?.inningsPitched || "0");
      }
      if (totalIp > 0) {
        data.pitchCount12 = Math.round((totalPitches / totalIp) * 2);
      }
      // Runs 1-3/GS approx: usar ER total / starts × (3 / IP_avg) como proxy de runs en primeros 3 innings
      let er = 0;
      for (const s of recent10) er += parseInt(s.stat?.earnedRuns) || 0;
      if (totalGS > 0 && totalIp > 0) {
        const erPerGS = er / totalGS;
        const ipPerGS = totalIp / totalGS;
        data.runs13Gs = Math.round((erPerGS * Math.min(3, ipPerGS) / Math.max(ipPerGS, 3)) * 100) / 100;
      }
    }
  } catch { /* ignore */ }

  // c) Savant xwOBA TTO1 + TTO2 para TTO penalty (con MEZCLA recent + season)
  // FIX 14 jun 2026: Savant timeout-ea con hfInn=1/2 para muchos pitchers (incluyendo veteranos).
  // Estrategia: intentar primero con hfInn (TTO real). Si timeout o sin data,
  // FALLBACK a season-aggregate (sin hfInn). El ttoPenalty queda en null en fallback.
  try {
    const tto1Url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=2026%7C&player_type=pitcher&hfInn=1%7C&min_pitches=0&group_by=name&sort_col=xwoba&min_pas=10&pitchers_lookup%5B%5D=${pitcherId}`;
    const tto2Url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=2026%7C&player_type=pitcher&hfInn=2%7C&min_pitches=0&group_by=name&sort_col=xwoba&min_pas=10&pitchers_lookup%5B%5D=${pitcherId}`;
    const seasonUrl = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=2026%7C&player_type=pitcher&min_pitches=0&group_by=name&sort_col=xwoba&min_pas=10&pitchers_lookup%5B%5D=${pitcherId}`;

    // Versión recent: hace 28 días (≈4 starts)
    const today = new Date();
    const past = new Date(today); past.setDate(past.getDate() - 28);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const tto1RecentUrl = `${tto1Url}&game_date_gt=${fmt(past)}&game_date_lt=${fmt(today)}`;
    const tto2RecentUrl = `${tto2Url}&game_date_gt=${fmt(past)}&game_date_lt=${fmt(today)}`;
    const seasonRecentUrl = `${seasonUrl}&game_date_gt=${fmt(past)}&game_date_lt=${fmt(today)}`;

    // Helper: detecta respuestas error de Savant
    const isSavantError = (csv: string) =>
      csv.includes("Error: Query Timeout") || csv.includes("\"error\"");

    const fetchCsv = async (url: string): Promise<string | null> => {
      try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
        if (!r.ok) return null;
        const csv = await r.text();
        return isSavantError(csv) ? null : csv;
      } catch { return null; }
    };

    // Intento 1: TTO1 + TTO2 con hfInn (TTO real)
    const [csv1, csv2, csv1r, csv2r] = await Promise.all([
      fetchCsv(tto1Url), fetchCsv(tto2Url), fetchCsv(tto1RecentUrl), fetchCsv(tto2RecentUrl),
    ]);
    let parsed1 = csv1 ? parseSavantRow(csv1) : null;
    const parsed2 = csv2 ? parseSavantRow(csv2) : null;
    const parsed1r = csv1r ? parseSavantRow(csv1r) : null;
    const parsed2r = csv2r ? parseSavantRow(csv2r) : null;

    // FALLBACK: si TTO1 falló, usar season aggregate (sin hfInn)
    let seasonFallback: ReturnType<typeof parseSavantRow> = null;
    let seasonRecentFallback: ReturnType<typeof parseSavantRow> = null;
    if (!parsed1) {
      const [csvS, csvSR] = await Promise.all([fetchCsv(seasonUrl), fetchCsv(seasonRecentUrl)]);
      seasonFallback = csvS ? parseSavantRow(csvS) : null;
      seasonRecentFallback = csvSR ? parseSavantRow(csvSR) : null;
      if (seasonFallback) {
        console.warn(`[mlb-ere] TTO1 falló para pitcher ${pitcherId}, usando season aggregate`);
        parsed1 = seasonFallback;
      }
    }

    if (parsed1) {
      const seasonXwoba = parsed1.xwoba;
      const recentXwoba = (parsed1r ?? seasonRecentFallback)?.xwoba ?? null;
      const recentPa = (parsed1r ?? seasonRecentFallback)?.pa ?? 0;
      data.xwobaTto1 = (recentXwoba !== null && recentPa >= 10)
        ? Math.round((0.6 * recentXwoba + 0.4 * seasonXwoba) * 1000) / 1000
        : seasonXwoba;
      data.tto1Pa = parsed1.pa;
      const seasonKbb = parsed1.kPct - parsed1.bbPct;
      const recentSource = parsed1r ?? seasonRecentFallback;
      const recentKbb = recentSource ? (recentSource.kPct - recentSource.bbPct) : null;
      data.kbbTto1 = (recentKbb !== null && recentPa >= 10)
        ? Math.round((0.6 * recentKbb + 0.4 * seasonKbb) * 1000) / 1000
        : seasonKbb;
    }
    if (parsed1 && parsed2) {
      data.ttoPenalty = Math.round((parsed2.xwoba - parsed1.xwoba) * 1000) / 1000;
      if (parsed1r && parsed2r && parsed1r.pa >= 10 && parsed2r.pa >= 10) {
        const recentTto = parsed2r.xwoba - parsed1r.xwoba;
        data.ttoPenalty = Math.round((0.6 * recentTto + 0.4 * data.ttoPenalty!) * 1000) / 1000;
      }
    }
    // En fallback (sin TTO2), no calculamos ttoPenalty (queda null/undefined)
  } catch (e) {
    console.warn(`[mlb-ere] Savant fetch error para pitcher ${pitcherId}:`, e instanceof Error ? e.message : e);
  }

  // d) RECENT FORM: blend de 1Inn ERA, YRFI allowed, WHIP 1-3 con últimas 4 starts
  //    Detecta tendencias que el season-wide oculta (ej. Alcantara 73% YRFI season,
  //    pero 50% en recent 4 — mezcla = 59% más realista).
  try {
    const recent = await computePitcherRecentStats(pitcherId, 4);
    if (recent.startsAnalyzed >= 3) {
      data.firstInnEra = blendRecentSeason(recent.firstInnEra, data.firstInnEra, recent.startsAnalyzed);
      data.yrfiAllowed = blendRecentSeason(recent.yrfiAllowed, data.yrfiAllowed, recent.startsAnalyzed);
      data.whip13 = blendRecentSeason(recent.whip13, data.whip13, recent.startsAnalyzed);
    }
  } catch { /* ignore, mantener valores season */ }

  return data;
}

// CSV parser que respeta valores entre comillas ("Taillon, Jameson" no se rompe en la coma)
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSavantRow(csv: string): { xwoba: number; kPct: number; bbPct: number; pa: number } | null {
  const lines = csv.split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  // BUG FIX 2026-05-22: 3 bugs corregidos en este parser:
  //   1. Savant CSV empieza con BOM (\uFEFF) que rompía header match
  //   2. Row contiene nombres con comas ("Taillon, Jameson") → split(",") destrozaba columnas
  //   3. Por (2), todos los pa, xwoba, k%, bb% leían valores incorrectos
  // Ahora: BOM removido + parser CSV-aware con manejo de comillas.
  const cleanField = (s: string) => s.replace(/[\uFEFF]/g, "").trim();
  const header = splitCsvRow(lines[0]).map(cleanField);
  const row = splitCsvRow(lines[1]).map(cleanField);
  const get = (col: string) => {
    const idx = header.indexOf(col);
    if (idx < 0 || !row[idx]) return NaN;
    return parseFloat(row[idx]);
  };
  const xwoba = get("xwoba");
  const pa = parseInt(String(get("pa"))) || 0;
  const kPct = get("k_percent") / 100;
  const bbPct = get("bb_percent") / 100;
  if (isNaN(xwoba) || xwoba <= 0) return null;
  return { xwoba, kPct: isNaN(kPct) ? 0 : kPct, bbPct: isNaN(bbPct) ? 0 : bbPct, pa };
}
