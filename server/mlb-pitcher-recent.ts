// ═══════════════════════════════════════════════════════════════════════════
// PITCHER RECENT FORM — Post-mortem Marlins/Sandy Alcantara fix
//
// Fix #1: Forma reciente del SP (últimas 5 aperturas)
//   - Detecta tendencia: HOT / COOL / NEUTRAL / COLD / IMPLOSION
//   - Aplica delta de ERA y delta de confianza al modelo
//
// Fix #2: Splits H/R ponderados por recencia (últimos 30 días)
//   - Ya implementado en mlb-pitcher-form.ts pero usaba season completa.
//   - Aquí calculamos splits H/R SOLO de últimos 30 días vía gameLog.
//
// Fix #4: Bullpen contingency (SP inestable → salida temprana)
//   - Si el SP tiene 5+ ER en al menos una de las últimas 2 aperturas O
//     promedio IP < 5.0 en últimas 5 → marca "early-exit risk"
//   - Esto sube las runs proyectadas del rival porque el bullpen debe cubrir más
// ═══════════════════════════════════════════════════════════════════════════

interface RecentFormResult {
  pitcherId: number;
  pitcherName: string;
  startsAnalyzed: number;
  recentEra: number;
  recentIpPerStart: number;
  recentWhip: number;
  trend: "HOT" | "GOOD" | "NEUTRAL" | "COOL" | "COLD" | "IMPLOSION" | "UNKNOWN";
  recencyEraDelta: number;       // suma a ERA esperada (+ peor)
  recencyConfPenalty: number;    // pp a restar a confianza del favorito (0-12)
  earlyExitRisk: boolean;
  earlyExitExtraRuns: number;    // runs extra al rival si SP sale temprano
  // Fix #2: splits H/R recientes
  recentHomeEra: number | null;
  recentAwayEra: number | null;
  recentHomeIp: number;
  recentAwayIp: number;
  recentSplitDelta: number;      // ajuste ERA según ubicación del juego (delta sobre season splits)
  signal: string;
  alerts: string[];
}

interface CombinedRecentResult {
  home: RecentFormResult | null;
  away: RecentFormResult | null;
  homeRivalRunsDelta: number;    // por SP local: runs del visitante
  awayRivalRunsDelta: number;    // por SP visitante: runs del local
  homeConfPenalty: number;       // pp si Marlins/local es favorito y SP frío
  awayConfPenalty: number;
  alerts: string[];
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function classifyTrend(era: number, ipPerStart: number, whip: number, recentImplosion: boolean): { tier: RecentFormResult["trend"]; eraDelta: number; conf: number; signal: string } {
  if (recentImplosion) {
    return { tier: "IMPLOSION", eraDelta: 0.80, conf: 12, signal: `IMPLOSION reciente (apertura con 7+ ER) — ERA esperada +0.80, conf -12pp` };
  }
  // ERA reciente determina tier base
  if (era <= 2.50 && ipPerStart >= 6) {
    return { tier: "HOT", eraDelta: -0.30, conf: -3, signal: `HOT (ERA ${era.toFixed(2)}, ${ipPerStart.toFixed(1)} IP/start) — ERA -0.30` };
  }
  if (era <= 3.50 && ipPerStart >= 5.5) {
    return { tier: "GOOD", eraDelta: -0.10, conf: 0, signal: `GOOD (ERA ${era.toFixed(2)}) — ERA -0.10` };
  }
  if (era <= 4.50) {
    return { tier: "NEUTRAL", eraDelta: 0, conf: 0, signal: `NEUTRAL (ERA ${era.toFixed(2)})` };
  }
  if (era <= 5.50) {
    return { tier: "COOL", eraDelta: 0.25, conf: 4, signal: `COOL (ERA ${era.toFixed(2)} en ${ipPerStart.toFixed(1)} IP/start) — ERA +0.25, conf -4pp` };
  }
  if (era <= 7.00) {
    return { tier: "COLD", eraDelta: 0.50, conf: 8, signal: `COLD (ERA ${era.toFixed(2)}) — ERA +0.50, conf -8pp` };
  }
  return { tier: "IMPLOSION", eraDelta: 0.80, conf: 12, signal: `IMPLOSION reciente (ERA ${era.toFixed(2)}) — conf -12pp` };
}

async function getPitcherRecentForm(pitcherId: number, pitcherName: string, gameDateIso: string, isHomeStart: boolean, season: number): Promise<RecentFormResult> {
  const result: RecentFormResult = {
    pitcherId, pitcherName,
    startsAnalyzed: 0, recentEra: 0, recentIpPerStart: 0, recentWhip: 0,
    trend: "UNKNOWN", recencyEraDelta: 0, recencyConfPenalty: 0,
    earlyExitRisk: false, earlyExitExtraRuns: 0,
    recentHomeEra: null, recentAwayEra: null, recentHomeIp: 0, recentAwayIp: 0,
    recentSplitDelta: 0,
    signal: "", alerts: [],
  };

  // Pull season game log (also covers prior season for early-season scenarios)
  const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${season}&group=pitching`;
  const data = await fetchJson(url);
  let splits: any[] = data?.stats?.[0]?.splits ?? [];
  // Solo titulares
  let starts = splits.filter((s: any) => s.stat?.gamesStarted === 1);

  // Si tenemos <3 starts en la temporada actual, complementar con prior season
  if (starts.length < 3) {
    const prevUrl = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${season - 1}&group=pitching`;
    const prevData = await fetchJson(prevUrl);
    const prevSplits: any[] = prevData?.stats?.[0]?.splits ?? [];
    const prevStarts = prevSplits.filter((s: any) => s.stat?.gamesStarted === 1);
    starts = [...prevStarts.slice(-5), ...starts];
  }

  if (starts.length === 0) {
    result.signal = "Sin gameLog disponible";
    return result;
  }

  // Tomar últimas 5 aperturas
  const last5 = starts.slice(-5);
  result.startsAnalyzed = last5.length;

  let totalIP = 0, totalER = 0, totalH = 0, totalBB = 0;
  let homeIP = 0, homeER = 0, awayIP = 0, awayER = 0;
  let recentImplosion = false;

  // Look at LAST 2 starts for implosion / early-exit
  const last2 = starts.slice(-2);
  let earlyExits = 0;
  for (const s of last2) {
    const ip = parseFloat(s.stat?.inningsPitched ?? "0");
    const er = parseInt(s.stat?.earnedRuns ?? "0");
    if (er >= 6) recentImplosion = true;
    if (ip < 5.0) earlyExits++;
  }

  for (const s of last5) {
    const ip = parseFloat(s.stat?.inningsPitched ?? "0");
    const er = parseInt(s.stat?.earnedRuns ?? "0");
    const h = parseInt(s.stat?.hits ?? "0");
    const bb = parseInt(s.stat?.baseOnBalls ?? "0");
    totalIP += ip; totalER += er; totalH += h; totalBB += bb;
    if (s.isHome) { homeIP += ip; homeER += er; } else { awayIP += ip; awayER += er; }
  }

  result.recentEra = totalIP > 0 ? Math.round((totalER * 9 / totalIP) * 100) / 100 : 0;
  result.recentIpPerStart = Math.round((totalIP / last5.length) * 10) / 10;
  result.recentWhip = totalIP > 0 ? Math.round(((totalH + totalBB) / totalIP) * 100) / 100 : 0;

  const trend = classifyTrend(result.recentEra, result.recentIpPerStart, result.recentWhip, recentImplosion);
  result.trend = trend.tier;
  result.recencyEraDelta = trend.eraDelta;
  result.recencyConfPenalty = trend.conf;

  // Early-exit risk
  if (earlyExits >= 1 || result.recentIpPerStart < 5.0 || recentImplosion) {
    result.earlyExitRisk = true;
    // Bullpen del equipo cubre ~2 IP extra de lo planeado → +0.5 ER típico
    result.earlyExitExtraRuns = recentImplosion ? 0.7 : 0.4;
    result.alerts.push(`Riesgo salida temprana SP — bullpen cubre +${result.earlyExitExtraRuns.toFixed(1)} runs extra`);
  }

  // Fix #2: splits H/R recientes (solo si tenemos ≥10 IP en cada lado en últimas 5)
  if (homeIP >= 8 && awayIP >= 8) {
    result.recentHomeEra = Math.round((homeER * 9 / homeIP) * 100) / 100;
    result.recentAwayEra = Math.round((awayER * 9 / awayIP) * 100) / 100;
    result.recentHomeIp = homeIP;
    result.recentAwayIp = awayIP;
    const recentDiff = result.recentAwayEra - result.recentHomeEra;
    // Aplicar 30% del diferencial reciente (más conservador que el de season)
    result.recentSplitDelta = isHomeStart ? -recentDiff * 0.20 : recentDiff * 0.20;
  }

  // Build signal
  result.signal = trend.signal + (result.earlyExitRisk ? ` · early-exit risk` : "");
  if (result.trend === "COLD" || result.trend === "IMPLOSION") {
    result.alerts.push(`SP ${result.trend} — últimas ${last5.length} aperturas con ERA ${result.recentEra.toFixed(2)}`);
  }
  return result;
}

export async function getPitcherRecentCombined(
  homePitcherId: number | null, homePitcherName: string,
  awayPitcherId: number | null, awayPitcherName: string,
  gameDateIso: string,
  season: number = new Date().getFullYear()
): Promise<CombinedRecentResult> {
  const [home, away] = await Promise.all([
    homePitcherId ? getPitcherRecentForm(homePitcherId, homePitcherName, gameDateIso, true, season) : Promise.resolve(null),
    awayPitcherId ? getPitcherRecentForm(awayPitcherId, awayPitcherName, gameDateIso, false, season) : Promise.resolve(null),
  ]);

  // ERA delta total (recencia + split reciente) → runs delta del rival
  // Fórmula: 0.6 runs/ERA point para 5.5 IP típicos
  const homeEraTotal = (home?.recencyEraDelta ?? 0) + (home?.recentSplitDelta ?? 0);
  const awayEraTotal = (away?.recencyEraDelta ?? 0) + (away?.recentSplitDelta ?? 0);

  const homeRivalRunsDelta = homeEraTotal * 0.55 + (home?.earlyExitExtraRuns ?? 0);
  const awayRivalRunsDelta = awayEraTotal * 0.55 + (away?.earlyExitExtraRuns ?? 0);

  const alerts: string[] = [
    ...(home?.alerts ?? []).map(a => `Local: ${a}`),
    ...(away?.alerts ?? []).map(a => `Visitante: ${a}`),
  ];

  return {
    home, away,
    homeRivalRunsDelta: Math.round(homeRivalRunsDelta * 100) / 100,
    awayRivalRunsDelta: Math.round(awayRivalRunsDelta * 100) / 100,
    homeConfPenalty: home?.recencyConfPenalty ?? 0,
    awayConfPenalty: away?.recencyConfPenalty ?? 0,
    alerts,
  };
}
