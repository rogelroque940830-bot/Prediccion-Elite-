// ─────────────────────────────────────────────────────────────────────────
// MLB Uncertainty Assessment Module (v1)
//
// Propósito: ANTES de mostrar la probabilidad final, evaluar cuán predecible
// es el juego basado en señales estructurales. NO cambia las predicciones.
// Es un OVERLAY informativo para que el usuario ajuste bet sizing.
//
// 3 dimensiones (v1):
//   1. Volatilidad histórica   — σ de F5 totals últimos 10 juegos por equipo
//   2. Coherencia de señales   — ERE recent vs season, matchup vs general
//   3. Tamaño de muestra       — warnings de pitcher pocas starts, TTO1 chico
//
// Score 0-100: 0 = perfectamente predecible, 100 = caos total.
// Clasificación: PREDECIBLE / MIXTO / VOLÁTIL / CAÓTICO
//
// Limitación HONESTA: este score NO predice si vas a ganar o perder.
// Solo te dice "este juego tiene más/menos ruido estructural de lo normal".
// Mercados eficientes ya incorporan parte de esta info en la línea.
// ─────────────────────────────────────────────────────────────────────────

const STATS_BASE = "https://statsapi.mlb.com/api/v1";

interface UncertaintyComponent {
  score: number;        // 0-100
  reason: string;       // Explicación breve (español)
  weight: number;       // Peso en el score final
}

export interface UncertaintyAssessment {
  overallScore: number;   // 0-100 (0 = predecible, 100 = caótico)
  classification: "PREDECIBLE" | "MIXTO" | "VOLATIL" | "CAOTICO";
  recommendation: string;
  components: {
    volatility: UncertaintyComponent;
    coherence: UncertaintyComponent;
    sampleSize: UncertaintyComponent;
  };
}

// ─── Volatilidad histórica ──────────────────────────────────────────────────
// σ de F5 totals últimos N juegos de cada equipo. σ alto = juegos impredecibles.

interface TeamVolatility {
  f5Totals: number[];
  sigma: number;
  mean: number;
  n: number;
}

const volatilityCache = new Map<string, { ts: number; data: TeamVolatility }>();
const VOL_CACHE_MS = 6 * 60 * 60 * 1000; // 6 horas

async function fetchTeamF5Volatility(teamId: number, lookbackDays: number = 20): Promise<TeamVolatility> {
  const cacheKey = `${teamId}-${lookbackDays}`;
  const cached = volatilityCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < VOL_CACHE_MS) return cached.data;

  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const url = `${STATS_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${fmt(start)}&endDate=${fmt(end)}&hydrate=linescore&gameType=R`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`schedule ${r.status}`);
    const j: any = await r.json();
    const f5Totals: number[] = [];
    for (const date of j.dates ?? []) {
      for (const g of date.games ?? []) {
        if (g.status?.abstractGameState !== "Final") continue;
        const innings = g.linescore?.innings ?? [];
        if (innings.length < 5) continue; // juego cortado, descartar
        let f5 = 0;
        for (let i = 0; i < 5; i++) {
          f5 += (innings[i]?.home?.runs ?? 0) + (innings[i]?.away?.runs ?? 0);
        }
        f5Totals.push(f5);
      }
    }

    // Quedarnos con los últimos 10
    const recent = f5Totals.slice(-10);
    if (recent.length < 5) {
      // Muestra muy chica, asumir volatilidad media
      const result = { f5Totals: recent, sigma: 2.0, mean: 4.5, n: recent.length };
      volatilityCache.set(cacheKey, { ts: Date.now(), data: result });
      return result;
    }
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length;
    const sigma = Math.sqrt(variance);
    const result = { f5Totals: recent, sigma, mean, n: recent.length };
    volatilityCache.set(cacheKey, { ts: Date.now(), data: result });
    return result;
  } catch (e: any) {
    // Fallback conservador
    return { f5Totals: [], sigma: 2.0, mean: 4.5, n: 0 };
  }
}

function scoreVolatility(homeVol: TeamVolatility, awayVol: TeamVolatility): UncertaintyComponent {
  if (homeVol.n < 5 || awayVol.n < 5) {
    return { score: 50, weight: 0.40, reason: "Muestra histórica insuficiente — vol asumida media" };
  }
  // Volatilidad combinada del juego: media cuadrática de las σ de cada equipo
  const gameSigma = Math.sqrt((homeVol.sigma ** 2 + awayVol.sigma ** 2) / 2);
  // Mapeo a 0-100:
  //   gameSigma < 1.5 → ~0-20 (muy estable)
  //   gameSigma 1.5-2.5 → 20-50 (normal)
  //   gameSigma 2.5-3.5 → 50-80 (volátil)
  //   gameSigma > 3.5 → 80-100 (caótico)
  let score: number;
  if (gameSigma < 1.5) score = (gameSigma / 1.5) * 20;
  else if (gameSigma < 2.5) score = 20 + ((gameSigma - 1.5) / 1.0) * 30;
  else if (gameSigma < 3.5) score = 50 + ((gameSigma - 2.5) / 1.0) * 30;
  else score = Math.min(100, 80 + ((gameSigma - 3.5) / 1.0) * 20);
  const reason = `σ F5 últimos: HOME=${homeVol.sigma.toFixed(1)} AWAY=${awayVol.sigma.toFixed(1)} → σ juego ${gameSigma.toFixed(2)}`;
  return { score: Math.round(score), weight: 0.40, reason };
}

// ─── Coherencia de señales ──────────────────────────────────────────────────
// Cuando ERE recent y season divergen mucho, o matchup discrepa de top4 general,
// el modelo está "indeciso" → más incertidumbre.

function scoreCoherence(homeEre: any, awayEre: any, matchupSignal: any): UncertaintyComponent {
  const reasons: string[] = [];
  let conflictPoints = 0;
  const maxConflicts = 4;

  // 1. ERE blend disagreement: si home tiene blendDelta alto, hay tensión recent vs season
  const homeBlendDelta = Math.abs((homeEre as any)?.blendDelta ?? 0);
  const awayBlendDelta = Math.abs((awayEre as any)?.blendDelta ?? 0);
  const maxBlend = Math.max(homeBlendDelta, awayBlendDelta);
  if (maxBlend > 8) {
    conflictPoints += 1;
    reasons.push(`ERE recent vs season diverge ${maxBlend.toFixed(0)}pts`);
  }

  // 2. Matchup signal disagreement con top-4 general
  const top4Home = homeEre?.top4LineupWoba?.woba;
  const top4Away = awayEre?.top4LineupWoba?.woba;
  const matchHome = matchupSignal?.homeTop4ExpectedXwoba;
  const matchAway = matchupSignal?.awayTop4ExpectedXwoba;
  if (top4Home && matchHome && Math.abs(top4Home - matchHome) > 0.030) {
    conflictPoints += 0.5;
    reasons.push(`Top4 HOME general (.${(top4Home * 1000).toFixed(0)}) vs matchup (.${(matchHome * 1000).toFixed(0)})`);
  }
  if (top4Away && matchAway && Math.abs(top4Away - matchAway) > 0.030) {
    conflictPoints += 0.5;
    reasons.push(`Top4 AWAY general (.${(top4Away * 1000).toFixed(0)}) vs matchup (.${(matchAway * 1000).toFixed(0)})`);
  }

  // 3. ERE score gap muy chico (juego parejo es más impredecible)
  const ereGap = Math.abs((homeEre?.ereScore ?? 50) - (awayEre?.ereScore ?? 50));
  if (ereGap < 5) {
    conflictPoints += 1;
    reasons.push(`ERE casi parejo (gap ${ereGap.toFixed(0)}pts)`);
  }

  // 4. Matchup data confidence
  if (matchupSignal?.dataConfidence === "LOW" || matchupSignal?.dataConfidence === "NONE") {
    conflictPoints += 1;
    reasons.push(`Matchup data ${matchupSignal.dataConfidence}`);
  }

  const score = Math.round((conflictPoints / maxConflicts) * 100);
  const reason = reasons.length > 0 ? reasons.join(" · ") : "Señales coherentes";
  return { score: Math.min(100, score), weight: 0.30, reason };
}

// ─── Tamaño de muestra ──────────────────────────────────────────────────────
// Suma de warnings de pitchers con pocas starts, TTO1 chico, lineup no confirmado.

function scoreSampleSize(homeEre: any, awayEre: any): UncertaintyComponent {
  const reasons: string[] = [];
  let warnings = 0;
  const maxWarnings = 6;

  // Pitcher de cada lado: pocas starts (<10 GS)
  const homePitcherGS = homeEre?.pitcherSeasonStats?.gamesStarted ?? homeEre?.pitcherForm?.startsCount ?? 99;
  const awayPitcherGS = awayEre?.pitcherSeasonStats?.gamesStarted ?? awayEre?.pitcherForm?.startsCount ?? 99;
  if (homePitcherGS < 10) { warnings += 1; reasons.push(`SP rival HOME pocas starts (${homePitcherGS})`); }
  if (awayPitcherGS < 10) { warnings += 1; reasons.push(`SP rival AWAY pocas starts (${awayPitcherGS})`); }

  // TTO1 sample chico
  const homeTto1Pas = homeEre?.pitcherTto1?.pas ?? 99;
  const awayTto1Pas = awayEre?.pitcherTto1?.pas ?? 99;
  if (homeTto1Pas < 40) { warnings += 0.5; reasons.push(`Pitcher rival HOME TTO1 chico (${homeTto1Pas} PA)`); }
  if (awayTto1Pas < 40) { warnings += 0.5; reasons.push(`Pitcher rival AWAY TTO1 chico (${awayTto1Pas} PA)`); }

  // Lineup status
  const homeLineupSrc = homeEre?.top4LineupWoba?.source ?? homeEre?.lineupSource;
  const awayLineupSrc = awayEre?.top4LineupWoba?.source ?? awayEre?.lineupSource;
  if (homeLineupSrc === "PROJECTED_ROSTER") { warnings += 1; reasons.push("Lineup HOME desde roster (incierto)"); }
  if (awayLineupSrc === "PROJECTED_ROSTER") { warnings += 1; reasons.push("Lineup AWAY desde roster (incierto)"); }

  const score = Math.round((warnings / maxWarnings) * 100);
  const reason = reasons.length > 0 ? reasons.join(" · ") : "Muestras adecuadas";
  return { score: Math.min(100, score), weight: 0.30, reason };
}

// ─── Composite ──────────────────────────────────────────────────────────────

function classify(score: number): UncertaintyAssessment["classification"] {
  if (score < 25) return "PREDECIBLE";
  if (score < 50) return "MIXTO";
  if (score < 75) return "VOLATIL";
  return "CAOTICO";
}

function recommend(score: number, classification: string): string {
  if (classification === "PREDECIBLE") return "Bet con tamaño normal — incertidumbre baja";
  if (classification === "MIXTO") return "Bet con tamaño normal — algunas señales menos firmes";
  if (classification === "VOLATIL") return "Bet con tamaño reducido (50-70%) — incertidumbre alta";
  return "Considerá PASS — múltiples señales de incertidumbre estructural";
}

export async function computeUncertainty(
  homeTeamId: number,
  awayTeamId: number,
  homeEre: any,
  awayEre: any,
  matchupSignal: any,
): Promise<UncertaintyAssessment> {
  // Fetch volatilidades en paralelo
  const [homeVol, awayVol] = await Promise.all([
    fetchTeamF5Volatility(homeTeamId),
    fetchTeamF5Volatility(awayTeamId),
  ]);

  const volatility = scoreVolatility(homeVol, awayVol);
  const coherence = scoreCoherence(homeEre, awayEre, matchupSignal);
  const sampleSize = scoreSampleSize(homeEre, awayEre);

  const overallScore = Math.round(
    volatility.score * volatility.weight +
    coherence.score * coherence.weight +
    sampleSize.score * sampleSize.weight
  );

  const classification = classify(overallScore);
  const recommendation = recommend(overallScore, classification);

  return {
    overallScore,
    classification,
    recommendation,
    components: { volatility, coherence, sampleSize },
  };
}
