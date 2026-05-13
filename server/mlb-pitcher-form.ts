// ═══════════════════════════════════════════════════════════════════════════
// PITCHER FORM — días de descanso + splits home/road
//
// Hueco #1: Días desde la última apertura
//   - 4 días = ideal (estándar moderno)
//   - 5 días = neutro
//   - 6+ días = posible óxido (rusty)
//   - 3 días = corto (fatiga)
//   - >10 días = vuelta de IL / spring training (rusty extremo)
//
// Hueco #2: Splits home/road del pitcher en la temporada actual
//   - Algunos pitchers son monstruos en casa, mediocres de visita
//   - Diferencia ERA H/A > 1.5 = señal real
// ═══════════════════════════════════════════════════════════════════════════

interface PitcherFormResult {
  pitcherId: number;
  pitcherName: string;
  daysRest: number | null;
  restTier: "SHORT" | "IDEAL" | "NEUTRAL" | "RUSTY" | "VERY_RUSTY" | "UNKNOWN";
  restEraDelta: number;       // suma a ERA esperada (+ = peor)
  homeAwayDiff: number | null; // ERA road - ERA home (positivo = mejor en casa)
  homeEra: number | null;
  awayEra: number | null;
  splitsTier: "HUGE_HOME_BIAS" | "MILD_HOME_BIAS" | "NEUTRAL" | "MILD_ROAD_BIAS" | "HUGE_ROAD_BIAS" | "UNKNOWN";
  splitsEraDelta: number;     // suma a ERA esperada para ESTE juego según si es home/road
  signal: string;
}

interface CombinedFormResult {
  home: PitcherFormResult | null;
  away: PitcherFormResult | null;
  // Deltas listos para aplicar a runs:
  homePitcherEraDelta: number; // ERA delta del SP local (afecta runs del visitante)
  awayPitcherEraDelta: number; // ERA delta del SP visitante (afecta runs del local)
  homeRivalRunsDelta: number;  // runs del visitante por culpa del SP local
  awayRivalRunsDelta: number;  // runs del local por culpa del SP visitante
  alerts: string[];
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function classifyRest(days: number): { tier: PitcherFormResult["restTier"]; eraDelta: number; signal: string } {
  if (days <= 2) return { tier: "SHORT", eraDelta: 0.50, signal: `${days}d descanso (CORTO — fatiga, ERA esperada +0.50)` };
  if (days === 3) return { tier: "SHORT", eraDelta: 0.30, signal: `3d descanso (CORTO — ERA esperada +0.30)` };
  if (days === 4) return { tier: "IDEAL", eraDelta: 0.0, signal: `4d descanso (IDEAL)` };
  if (days === 5) return { tier: "NEUTRAL", eraDelta: -0.05, signal: `5d descanso (NEUTRAL — ligero plus)` };
  if (days >= 6 && days <= 7) return { tier: "RUSTY", eraDelta: 0.15, signal: `${days}d descanso (algo oxidado, ERA esperada +0.15)` };
  if (days >= 8 && days <= 12) return { tier: "RUSTY", eraDelta: 0.30, signal: `${days}d descanso (oxidado, ERA esperada +0.30)` };
  return { tier: "VERY_RUSTY", eraDelta: 0.55, signal: `${days}d descanso (vuelta de IL/largo descanso, ERA esperada +0.55)` };
}

function classifySplits(homeEra: number, awayEra: number, homeIp: number, awayIp: number, isHomeStart: boolean): { tier: PitcherFormResult["splitsTier"]; delta: number; signal: string } {
  // Necesitamos al menos 10 IP en cada lado para confiar
  if (homeIp < 10 || awayIp < 10) {
    return { tier: "UNKNOWN", delta: 0, signal: `Splits insuficientes (H:${homeIp}IP, A:${awayIp}IP)` };
  }
  const diff = awayEra - homeEra; // positivo = mejor en casa
  // Aplicamos solo MITAD de la diferencia para evitar sobreajuste
  // (si es home start: usamos homeEra como guía → delta negativo si diff es positivo)
  // FIX auditoría: peso reducido de 0.30 → 0.15 para evitar doble conteo
  // con pitcher-recent que aplica splits H/R recientes (últimas 5 starts).
  // pitcher-form (season) ahora aporta solo el componente "largo plazo".
  const adjustment = isHomeStart ? -diff * 0.15 : diff * 0.15;

  if (diff >= 1.5) {
    return { tier: "HUGE_HOME_BIAS", delta: adjustment, signal: `Bestia en casa (H ${homeEra.toFixed(2)} vs A ${awayEra.toFixed(2)}, Δ ${diff.toFixed(2)})` };
  }
  if (diff >= 0.6) {
    return { tier: "MILD_HOME_BIAS", delta: adjustment, signal: `Mejor en casa (H ${homeEra.toFixed(2)} vs A ${awayEra.toFixed(2)})` };
  }
  if (diff <= -1.5) {
    return { tier: "HUGE_ROAD_BIAS", delta: adjustment, signal: `Bestia de visita (A ${awayEra.toFixed(2)} vs H ${homeEra.toFixed(2)}, Δ ${(-diff).toFixed(2)})` };
  }
  if (diff <= -0.6) {
    return { tier: "MILD_ROAD_BIAS", delta: adjustment, signal: `Mejor de visita (A ${awayEra.toFixed(2)} vs H ${homeEra.toFixed(2)})` };
  }
  return { tier: "NEUTRAL", delta: 0, signal: `Splits H/A similares (Δ ${diff.toFixed(2)})` };
}

async function getPitcherForm(pitcherId: number, pitcherName: string, gameDateIso: string, isHomeStart: boolean, season: number): Promise<PitcherFormResult> {
  const result: PitcherFormResult = {
    pitcherId, pitcherName,
    daysRest: null, restTier: "UNKNOWN", restEraDelta: 0,
    homeAwayDiff: null, homeEra: null, awayEra: null,
    splitsTier: "UNKNOWN", splitsEraDelta: 0,
    signal: "",
  };

  // 1) Game log para días de descanso
  const logUrl = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${season}&group=pitching`;
  const logData = await fetchJson(logUrl);
  const splits = logData?.stats?.[0]?.splits ?? [];
  const starts = splits.filter((s: any) => s.stat?.gamesStarted === 1 && s.date);
  if (starts.length > 0) {
    const lastStart = starts[starts.length - 1];
    const lastDate = new Date(lastStart.date + "T00:00:00Z");
    const gameDate = new Date(gameDateIso.slice(0, 10) + "T00:00:00Z");
    const days = Math.round((gameDate.getTime() - lastDate.getTime()) / 86400000);
    if (days >= 0) {
      result.daysRest = days;
      const r = classifyRest(days);
      result.restTier = r.tier;
      result.restEraDelta = r.eraDelta;
    }
  }

  // 2) Splits home/road
  const splitUrl = `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=statSplits&season=${season}&group=pitching&sitCodes=h,a`;
  const splitData = await fetchJson(splitUrl);
  const splitArr = splitData?.stats?.[0]?.splits ?? [];
  let hEra = NaN, aEra = NaN, hIp = 0, aIp = 0;
  for (const s of splitArr) {
    const desc = (s.split?.description || "").toLowerCase();
    const era = parseFloat(s.stat?.era);
    const ip = parseFloat(s.stat?.inningsPitched);
    if (desc.includes("home")) { hEra = era; hIp = ip; }
    else if (desc.includes("away") || desc.includes("road")) { aEra = era; aIp = ip; }
  }
  if (!isNaN(hEra) && !isNaN(aEra)) {
    result.homeEra = hEra;
    result.awayEra = aEra;
    result.homeAwayDiff = aEra - hEra;
    const sp = classifySplits(hEra, aEra, hIp, aIp, isHomeStart);
    result.splitsTier = sp.tier;
    result.splitsEraDelta = sp.delta;
  }

  // Build signal
  const parts: string[] = [];
  if (result.daysRest !== null) parts.push(classifyRest(result.daysRest).signal);
  if (result.splitsTier !== "UNKNOWN") {
    const sp = classifySplits(result.homeEra!, result.awayEra!, hIp, aIp, isHomeStart);
    parts.push(sp.signal);
  }
  result.signal = parts.join(" · ") || "Sin datos suficientes";
  return result;
}

export async function getPitcherFormCombined(
  homePitcherId: number | null,
  homePitcherName: string,
  awayPitcherId: number | null,
  awayPitcherName: string,
  gameDateIso: string,
  season: number = new Date().getFullYear()
): Promise<CombinedFormResult> {
  const tasks: Promise<PitcherFormResult | null>[] = [
    homePitcherId ? getPitcherForm(homePitcherId, homePitcherName, gameDateIso, true, season) : Promise.resolve(null),
    awayPitcherId ? getPitcherForm(awayPitcherId, awayPitcherName, gameDateIso, false, season) : Promise.resolve(null),
  ];
  const [home, away] = await Promise.all(tasks);

  const homePitcherEraDelta = (home?.restEraDelta ?? 0) + (home?.splitsEraDelta ?? 0);
  const awayPitcherEraDelta = (away?.restEraDelta ?? 0) + (away?.splitsEraDelta ?? 0);

  // ERA delta → runs delta del rival ≈ ERA delta * 6/9 (≈ runs por 6 IP del SP)
  // Usamos factor 0.6 (algo conservador; un SP típico tira 5.5-6 IP)
  const homeRivalRunsDelta = homePitcherEraDelta * 0.60;
  const awayRivalRunsDelta = awayPitcherEraDelta * 0.60;

  const alerts: string[] = [];
  if (home?.restTier === "SHORT") alerts.push(`SP local en descanso corto (${home.daysRest}d)`);
  if (away?.restTier === "SHORT") alerts.push(`SP visitante en descanso corto (${away.daysRest}d)`);
  if (home?.restTier === "VERY_RUSTY") alerts.push(`SP local oxidado (${home.daysRest}d)`);
  if (away?.restTier === "VERY_RUSTY") alerts.push(`SP visitante oxidado (${away.daysRest}d)`);
  if (home?.splitsTier === "HUGE_HOME_BIAS") alerts.push(`SP local domina en casa`);
  if (away?.splitsTier === "HUGE_ROAD_BIAS") alerts.push(`SP visitante domina de visita`);
  if (home?.splitsTier === "HUGE_ROAD_BIAS") alerts.push(`SP local lucha en casa`);
  if (away?.splitsTier === "HUGE_HOME_BIAS") alerts.push(`SP visitante lucha de visita`);

  return {
    home, away,
    homePitcherEraDelta: Math.round(homePitcherEraDelta * 100) / 100,
    awayPitcherEraDelta: Math.round(awayPitcherEraDelta * 100) / 100,
    homeRivalRunsDelta: Math.round(homeRivalRunsDelta * 100) / 100,
    awayRivalRunsDelta: Math.round(awayRivalRunsDelta * 100) / 100,
    alerts,
  };
}
