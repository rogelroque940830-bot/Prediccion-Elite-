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
    weightedSum += v.score * v.weight;
  }
  if (totalWeight === 0) return 50;
  return weightedSum / totalWeight;
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
async function computeLineupTop3OBP(gamePk: number, teamId: number): Promise<{ obp: number; pa: number } | null> {
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const side = j.teams?.home?.team?.id === teamId ? "home" : "away";
    const battingOrder: any[] = j.teams?.[side]?.battingOrder ?? [];
    const players = j.teams?.[side]?.players || {};
    let ids: number[] = [];
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
// HELPER: Top-5 ISO y K% del lineup
// ──────────────────────────────────────────────────────────────────────────
async function computeTop5IsoK(gamePk: number, teamId: number): Promise<{ iso: number; kPct: number; xwoba: number; pa: number } | null> {
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const side = j.teams?.home?.team?.id === teamId ? "home" : "away";
    const battingOrder: any[] = j.teams?.[side]?.battingOrder ?? [];
    const players = j.teams?.[side]?.players || {};
    let ids: number[] = [];
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
  };
}

async function computePitcherEarlyMetrics(pitcherId: number) {
  const data = emptyPitcherData();

  // a) 1st inning splits (sitCodes=i01)
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&season=2026&group=pitching&sitCodes=i01`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" } });
    const j: any = await r.json();
    const stat = j.stats?.[0]?.splits?.[0]?.stat;
    if (stat) {
      const er = parseInt(stat.earnedRuns) || 0;
      const ip = parseFloat(stat.inningsPitched || "0");
      if (ip > 0) data.firstInnEra = Math.round((er / ip) * 9 * 100) / 100;
      const gs = parseInt(stat.gamesStarted) || 0;
      data.gs = Math.max(data.gs, gs);
      // YRFI allowed = runs allowed / starts
      const r1 = parseInt(stat.runs) || 0;
      const gp = parseInt(stat.gamesPlayed) || 0;
      if (gp > 0) data.yrfiAllowed = Math.min(1, r1 / gp);
      // WHIP approx for 1st inning
      const h = parseInt(stat.hits) || 0;
      const bb = parseInt(stat.baseOnBalls) || 0;
      if (ip > 0) data.whip13 = Math.round(((h + bb) / ip) * 100) / 100;
    }
  } catch { /* ignore */ }

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
    // Solo partidos donde el pitcher fue starter (gamesStarted >= 1)
    const startsOnly = allSplits.filter((s: any) => (parseInt(s.stat?.gamesStarted) || 0) >= 1);
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

  // c) Savant xwOBA TTO1 + TTO2 para TTO penalty
  try {
    const tto1Url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=2026%7C&player_type=pitcher&hfInn=1%7C&min_pitches=0&group_by=name&sort_col=xwoba&min_pas=10&pitchers_lookup%5B%5D=${pitcherId}`;
    const tto2Url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=2026%7C&player_type=pitcher&hfInn=2%7C&min_pitches=0&group_by=name&sort_col=xwoba&min_pas=10&pitchers_lookup%5B%5D=${pitcherId}`;

    const [r1, r2] = await Promise.all([fetch(tto1Url), fetch(tto2Url)]);
    const [csv1, csv2] = await Promise.all([r1.text(), r2.text()]);
    const parsed1 = parseSavantRow(csv1);
    const parsed2 = parseSavantRow(csv2);

    if (parsed1) {
      data.xwobaTto1 = parsed1.xwoba;
      data.tto1Pa = parsed1.pa;
      data.kbbTto1 = parsed1.kPct - parsed1.bbPct;
    }
    if (parsed1 && parsed2) {
      data.ttoPenalty = Math.round((parsed2.xwoba - parsed1.xwoba) * 1000) / 1000;
    }
  } catch { /* ignore */ }

  return data;
}

function parseSavantRow(csv: string): { xwoba: number; kPct: number; bbPct: number; pa: number } | null {
  const lines = csv.split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  const header = lines[0].split(",").map(s => s.replace(/"/g, "").trim());
  const row = lines[1].split(",");
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
