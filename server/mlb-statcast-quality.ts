// Statcast Expected / Quality — Tier A
// Trae 3 indicadores de Baseball Savant (gratis, CSV público):
//  1. xwOBA-allowed por pitcher → detector de regresión
//  2. HardHit% (ev95percent) por pitcher → vulnerabilidad
//  3. Bateador: luck-delta (wOBA - xwOBA)
// Cache 6h porque Savant actualiza diariamente y son leaderboards.

type CsvRow = Record<string, string>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry<T> { ts: number; data: T; }
const CACHE_TTL = 6 * 60 * 60 * 1000;

export const MLB_STATCAST_QUALITY_EVIDENCE_SCHEMA = "courtedge-mlb-statcast-quality-evidence.v1" as const;

export interface StatcastQualityRuntime {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface StatcastQualityEvidenceProvenance {
  schemaVersion: typeof MLB_STATCAST_QUALITY_EVIDENCE_SCHEMA;
  status: "CERTIFIED";
  generatedAt: string;
  sources: {
    expectedPitchers: "BASEBALL_SAVANT_EXPECTED_STATISTICS";
    pitcherQuality: "BASEBALL_SAVANT_STATCAST";
    expectedBatters: "BASEBALL_SAVANT_EXPECTED_STATISTICS";
  };
  cacheMaxAgeSeconds: 21_600;
  pitcherCacheHit: boolean;
  batterCacheHit: boolean;
  pitcherCacheAgeSeconds: number;
  batterCacheAgeSeconds: number;
  failureDisposition: "THROW_FAIL_CLOSED";
}

const pitcherCache: { current: CacheEntry<Record<number, PitcherQuality>> | null } = { current: null };
const batterCache: { current: CacheEntry<Record<number, BatterQuality>> | null } = { current: null };

export interface PitcherQuality {
  playerId: number;
  name: string;
  pa: number;
  era: number;
  xera: number;
  eraMinusXeraDiff: number;     // negative = ERA mejor que merece (suertudo)
  wOBA: number;
  xwOBA: number;                // xwOBA-allowed
  xwobaMinusWobaDiff: number;   // positive = pitcher peor que ERA sugiere
  hardHitPct: number;           // ev95percent (% batazos >=95mph)
  barrelPct: number;            // brl_percent
}

export interface BatterQuality {
  playerId: number;
  name: string;
  pa: number;
  wOBA: number;
  xwOBA: number;
  luckDelta: number;            // wOBA - xwOBA; positivo = suertudo, negativo = subbatando
}

export interface StatcastQualityCertifiedSnapshot {
  sourceStatus: "CERTIFIED";
  generatedAt: string;
  pitcherMap: Record<number, PitcherQuality>;
  batterMap: Record<number, BatterQuality>;
  provenance: StatcastQualityEvidenceProvenance;
}

interface CertifiedMapResult<T> {
  data: T;
  observedAtMs: number;
  cacheHit: boolean;
  cacheAgeSeconds: number;
}

function runtimeNow(runtime: StatcastQualityRuntime): Date {
  return runtime.now ? runtime.now() : new Date();
}

function runtimeFetch(runtime: StatcastQualityRuntime): FetchLike {
  return runtime.fetchImpl ?? ((input, init) => fetch(input, init));
}

function parseCsv(text: string): CsvRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cols = splitCsvLine(l);
    const row: CsvRow = {};
    headers.forEach((h, i) => { row[h.trim().replace(/^"|"$/g, "")] = (cols[i] ?? "").replace(/^"|"$/g, ""); });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; cur += c; }
    else if (c === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function num(s: string | undefined, def = 0): number {
  if (!s) return def;
  const n = parseFloat(s.replace(/^"|"$/g, ""));
  return isNaN(n) ? def : n;
}

async function fetchCsv(url: string, source: string, fetchImpl: FetchLike): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (error: any) {
    throw new Error(`STATCAST_QUALITY_SOURCE_FETCH_FAILED:${source}:${String(error?.message || error || "UNKNOWN")}`);
  }
  if (!res.ok) throw new Error(`STATCAST_QUALITY_SOURCE_HTTP_${res.status}:${source}`);
  return res.text();
}

async function fetchExpectedPitchers(fetchImpl: FetchLike = fetch): Promise<Record<number, Partial<PitcherQuality>>> {
  const yr = new Date().getFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${yr}&min=q&csv=true`;
  const text = await fetchCsv(url, "EXPECTED_PITCHERS", fetchImpl);
  const rows = parseCsv(text);
  const map: Record<number, Partial<PitcherQuality>> = {};
  for (const r of rows) {
    const id = parseInt(r["player_id"]);
    if (!id) continue;
    map[id] = {
      playerId: id,
      name: r["last_name, first_name"] || "",
      pa: num(r["pa"]),
      era: num(r["era"]),
      xera: num(r["xera"]),
      eraMinusXeraDiff: num(r["era_minus_xera_diff"]),
      wOBA: num(r["woba"]),
      xwOBA: num(r["est_woba"]),
      xwobaMinusWobaDiff: num(r["est_woba_minus_woba_diff"]),
    };
  }
  return map;
}

async function fetchQualityPitchers(fetchImpl: FetchLike = fetch): Promise<Record<number, { hardHitPct: number; barrelPct: number }>> {
  const yr = new Date().getFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&year=${yr}&min=q&csv=true`;
  const text = await fetchCsv(url, "PITCHER_QUALITY", fetchImpl);
  const rows = parseCsv(text);
  const map: Record<number, { hardHitPct: number; barrelPct: number }> = {};
  for (const r of rows) {
    const id = parseInt(r["player_id"]);
    if (!id) continue;
    map[id] = {
      hardHitPct: num(r["ev95percent"]),
      barrelPct: num(r["brl_percent"]),
    };
  }
  return map;
}

async function fetchExpectedBatters(fetchImpl: FetchLike = fetch): Promise<Record<number, BatterQuality>> {
  const yr = new Date().getFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${yr}&min=q&csv=true`;
  const text = await fetchCsv(url, "EXPECTED_BATTERS", fetchImpl);
  const rows = parseCsv(text);
  const map: Record<number, BatterQuality> = {};
  for (const r of rows) {
    const id = parseInt(r["player_id"]);
    if (!id) continue;
    const wOBA = num(r["woba"]);
    const xwOBA = num(r["est_woba"]);
    map[id] = {
      playerId: id,
      name: r["last_name, first_name"] || "",
      pa: num(r["pa"]),
      wOBA, xwOBA,
      luckDelta: Math.round((wOBA - xwOBA) * 1000) / 1000,
    };
  }
  return map;
}

function mergePitcherQuality(
  expected: Record<number, Partial<PitcherQuality>>,
  quality: Record<number, { hardHitPct: number; barrelPct: number }>,
): Record<number, PitcherQuality> {
  const merged: Record<number, PitcherQuality> = {};
  for (const id in expected) {
    const e = expected[id];
    const q = quality[parseInt(id)] || { hardHitPct: 0, barrelPct: 0 };
    merged[parseInt(id)] = {
      playerId: e.playerId!,
      name: e.name!,
      pa: e.pa ?? 0,
      era: e.era ?? 0,
      xera: e.xera ?? 0,
      eraMinusXeraDiff: e.eraMinusXeraDiff ?? 0,
      wOBA: e.wOBA ?? 0,
      xwOBA: e.xwOBA ?? 0,
      xwobaMinusWobaDiff: e.xwobaMinusWobaDiff ?? 0,
      hardHitPct: q.hardHitPct,
      barrelPct: q.barrelPct,
    };
  }
  return merged;
}

async function loadPitcherQualityCertified(runtime: StatcastQualityRuntime): Promise<CertifiedMapResult<Record<number, PitcherQuality>>> {
  const nowMs = runtimeNow(runtime).getTime();
  const cached = pitcherCache.current;
  if (cached && nowMs - cached.ts < CACHE_TTL) {
    return {
      data: cached.data,
      observedAtMs: cached.ts,
      cacheHit: true,
      cacheAgeSeconds: Math.max(0, Math.round((nowMs - cached.ts) / 1000)),
    };
  }

  const fetchImpl = runtimeFetch(runtime);
  const [expected, quality] = await Promise.all([
    fetchExpectedPitchers(fetchImpl),
    fetchQualityPitchers(fetchImpl),
  ]);
  if (!Object.keys(expected).length) throw new Error("STATCAST_QUALITY_EXPECTED_PITCHERS_EMPTY");
  if (!Object.keys(quality).length) throw new Error("STATCAST_QUALITY_PITCHER_QUALITY_EMPTY");
  const merged = mergePitcherQuality(expected, quality);
  if (!Object.keys(merged).length) throw new Error("STATCAST_QUALITY_PITCHER_MAP_EMPTY");
  pitcherCache.current = { ts: nowMs, data: merged };
  return { data: merged, observedAtMs: nowMs, cacheHit: false, cacheAgeSeconds: 0 };
}

async function loadBatterQualityCertified(runtime: StatcastQualityRuntime): Promise<CertifiedMapResult<Record<number, BatterQuality>>> {
  const nowMs = runtimeNow(runtime).getTime();
  const cached = batterCache.current;
  if (cached && nowMs - cached.ts < CACHE_TTL) {
    return {
      data: cached.data,
      observedAtMs: cached.ts,
      cacheHit: true,
      cacheAgeSeconds: Math.max(0, Math.round((nowMs - cached.ts) / 1000)),
    };
  }

  const data = await fetchExpectedBatters(runtimeFetch(runtime));
  if (!Object.keys(data).length) throw new Error("STATCAST_QUALITY_EXPECTED_BATTERS_EMPTY");
  batterCache.current = { ts: nowMs, data };
  return { data, observedAtMs: nowMs, cacheHit: false, cacheAgeSeconds: 0 };
}

export async function getStatcastQualityCertifiedSnapshot(
  runtime: StatcastQualityRuntime = {},
): Promise<StatcastQualityCertifiedSnapshot> {
  const [pitchers, batters] = await Promise.all([
    loadPitcherQualityCertified(runtime),
    loadBatterQualityCertified(runtime),
  ]);
  const generatedAt = new Date(Math.min(pitchers.observedAtMs, batters.observedAtMs)).toISOString();
  return {
    sourceStatus: "CERTIFIED",
    generatedAt,
    pitcherMap: pitchers.data,
    batterMap: batters.data,
    provenance: {
      schemaVersion: MLB_STATCAST_QUALITY_EVIDENCE_SCHEMA,
      status: "CERTIFIED",
      generatedAt,
      sources: {
        expectedPitchers: "BASEBALL_SAVANT_EXPECTED_STATISTICS",
        pitcherQuality: "BASEBALL_SAVANT_STATCAST",
        expectedBatters: "BASEBALL_SAVANT_EXPECTED_STATISTICS",
      },
      cacheMaxAgeSeconds: 21_600,
      pitcherCacheHit: pitchers.cacheHit,
      batterCacheHit: batters.cacheHit,
      pitcherCacheAgeSeconds: pitchers.cacheAgeSeconds,
      batterCacheAgeSeconds: batters.cacheAgeSeconds,
      failureDisposition: "THROW_FAIL_CLOSED",
    },
  };
}

export function resetStatcastQualityCachesForTests(): void {
  pitcherCache.current = null;
  batterCache.current = null;
}

export async function getPitcherQualityMap(): Promise<Record<number, PitcherQuality>> {
  try {
    return (await loadPitcherQualityCertified({})).data;
  } catch (err) {
    console.error("[statcast-quality] pitcher fetch failed:", err);
    return pitcherCache.current?.data ?? {};
  }
}

export async function getBatterQualityMap(): Promise<Record<number, BatterQuality>> {
  try {
    return (await loadBatterQualityCertified({})).data;
  } catch (err) {
    console.error("[statcast-quality] batter fetch failed:", err);
    return batterCache.current?.data ?? {};
  }
}

// Análisis del pitcher rival: aplicar runs delta basado en xwOBA-allowed gap + HardHit%
// Solo entra si el pitcher tiene >=qualified PA en season actual (n>=q). Si no, retorna 0.
export interface PitcherQualitySignal {
  pitcherId: number;
  pitcherName: string;
  era: number;
  xera: number;
  xwoba: number;
  hardHitPct: number;
  barrelPct: number;
  runsDelta: number;          // runs/juego que debería ceder DE MÁS o DE MENOS
  confidence: "FULL" | "PARTIAL" | "NONE";
  signal: string;
}

export function evaluatePitcher(p: PitcherQuality | undefined): PitcherQualitySignal | null {
  if (!p || p.pa < 50) return null; // muestra mínima
  // ERA gap: era_minus_xera_diff > 0 = ERA peor que merece (mala suerte → mejora)
  //          era_minus_xera_diff < 0 = ERA mejor que merece (sobrerendimiento → regresión)
  // xwOBA gap: est_woba_minus_woba_diff > 0 = xwOBA mayor que wOBA = pitcher peor que stats
  const eraGap = p.eraMinusXeraDiff;       // si negativo, pitcher está siendo suertudo
  const xwobaGap = p.xwobaMinusWobaDiff;   // si positivo, pitcher peor de lo que ERA dice

  // Hard-hit liga ~ 38%; HardHit elite < 33%, vulnerable > 43%
  const hhLeague = 38;
  const hhExcess = p.hardHitPct - hhLeague; // positivo = vulnerable

  // Runs adjustment: convertir ERA gap + HardHit excess a runs/juego (cap ±0.5)
  // 1 ERA ≈ 0.6 runs/9inn. eraGap negativo (suertudo) → más runs esperados → +runs.
  let runsDelta = 0;
  runsDelta += -eraGap * 0.30;              // -eraGap porque suerte ya pasó, ahora regresará
  runsDelta += xwobaGap * 5.0;              // .020 gap → +0.10 runs (xwOBA→runs sensitivity)
  runsDelta += (hhExcess / 100) * 0.8;      // 5pp sobre liga → +0.04 runs
  // Cap
  runsDelta = Math.max(-0.45, Math.min(0.45, runsDelta));
  runsDelta = Math.round(runsDelta * 100) / 100;

  let signal = "";
  let confidence: "FULL" | "PARTIAL" | "NONE" = p.pa >= 120 ? "FULL" : "PARTIAL";

  if (runsDelta >= 0.20) {
    signal = `🚨 ${p.name} sobrerendiendo: ERA ${p.era.toFixed(2)} pero xERA ${p.xera.toFixed(2)}, xwOBA-allowed ${p.xwOBA.toFixed(3)}, HardHit% ${p.hardHitPct.toFixed(0)}%. Regresión pendiente → +${runsDelta.toFixed(2)} runs.`;
  } else if (runsDelta <= -0.20) {
    signal = `✓ ${p.name} subrendiendo: ERA ${p.era.toFixed(2)} pero xERA ${p.xera.toFixed(2)}, xwOBA-allowed ${p.xwOBA.toFixed(3)}. Mejor de lo que ERA muestra → ${runsDelta.toFixed(2)} runs.`;
  } else {
    signal = `${p.name}: xERA ${p.xera.toFixed(2)} alineado con ERA ${p.era.toFixed(2)}. xwOBA-allowed ${p.xwOBA.toFixed(3)}, HardHit% ${p.hardHitPct.toFixed(0)}%.`;
  }

  return {
    pitcherId: p.playerId,
    pitcherName: p.name,
    era: p.era,
    xera: p.xera,
    xwoba: p.xwOBA,
    hardHitPct: p.hardHitPct,
    barrelPct: p.barrelPct,
    runsDelta,
    confidence,
    signal,
  };
}

// Análisis de bateadores: aplicar luck-delta como CORRECCIÓN de wOBA actual (no se suma extra)
export interface BatterLuckCorrection {
  playerId: number;
  name: string;
  wOBA: number;
  xwOBA: number;
  luckDelta: number;        // wOBA - xwOBA; positivo = suertudo, negativo = subbatando
  correctedWoba: number;    // = xwOBA (lo que MERECE)
  tier: "OVERPERFORMING" | "UNDERPERFORMING" | "REAL";
  signal: string;
}

export function evaluateBatter(b: BatterQuality | undefined): BatterLuckCorrection | null {
  if (!b || b.pa < 50) return null;
  let tier: BatterLuckCorrection["tier"] = "REAL";
  if (b.luckDelta >= 0.030) tier = "OVERPERFORMING";
  else if (b.luckDelta <= -0.030) tier = "UNDERPERFORMING";

  let signal = "";
  if (tier === "OVERPERFORMING") {
    signal = `⚠️ ${b.name} suertudo: wOBA ${b.wOBA.toFixed(3)} vs xwOBA ${b.xwOBA.toFixed(3)} (regresará -${b.luckDelta.toFixed(3)})`;
  } else if (tier === "UNDERPERFORMING") {
    signal = `🔥 ${b.name} subbatando: wOBA ${b.wOBA.toFixed(3)} vs xwOBA ${b.xwOBA.toFixed(3)} (subirá +${(-b.luckDelta).toFixed(3)})`;
  } else {
    signal = `${b.name}: wOBA ${b.wOBA.toFixed(3)} alineado con xwOBA ${b.xwOBA.toFixed(3)}.`;
  }

  return {
    playerId: b.playerId,
    name: b.name,
    wOBA: b.wOBA,
    xwOBA: b.xwOBA,
    luckDelta: b.luckDelta,
    correctedWoba: b.xwOBA,
    tier,
    signal,
  };
}
