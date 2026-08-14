// Tier B — Pitcher Discipline (strike%) + Sprint Speed (BABIP correction)
//
// 1. strikePct como proxy de CSW%
//    league avg ~63-64%. Elite >67% predice K9 sostenido alto.
//    Pitchers con K9 alto pero strikePct bajo → K9 va a bajar.
//
// 2. Sprint Speed para BABIP correction
//    Bateadores >28 ft/s sostienen BABIP +0.020 sobre liga.
//    El modelo no debe castigar su BABIP "inflada" — es real para ellos.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const LEAGUE_STRIKE_PCT = 0.635;          // strikes/pitches league avg
const LEAGUE_BABIP = 0.295;
const SPEED_THRESHOLD = 28.0;             // ft/s para "rápido"
const SPEED_ELITE = 29.5;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface CacheEntry<T> { ts: number; data: T; }
const CACHE_TTL = 6 * 60 * 60 * 1000;     // 6h
const speedCache: { current: CacheEntry<Record<number, BatterSpeed>> | null } = { current: null };

export const MLB_DISCIPLINE_SPEED_EVIDENCE_SCHEMA = "courtedge-mlb-discipline-speed-evidence.v1" as const;

export interface DisciplineSpeedRuntime {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface PitcherDiscipline {
  pitcherId: number;
  pitcherName: string;
  numberOfPitches: number;
  strikes: number;
  strikePct: number;
  k9: number;
  league: { strikePct: number; };
  expectedK9Delta: number;       // si strikePct alto + K9 bajo → expected sube; si revés → baja
  signal: string;
}

export interface BatterSpeed {
  playerId: number;
  name: string;
  sprintSpeed: number;            // ft/s
  babipFloor: number;             // floor recomendado (no aplicar regression abajo)
  tier: "ELITE" | "FAST" | "AVG" | "SLOW";
}

export interface DisciplineSpeedResult {
  homeSPDiscipline: PitcherDiscipline | null;
  awaySPDiscipline: PitcherDiscipline | null;
  homeBatterSpeed: BatterSpeed[];
  awayBatterSpeed: BatterSpeed[];
  // Net adjustments para alimentar al modelo
  homeRunsDelta: number;   // si SP visitante baja K9 → home anota más
  awayRunsDelta: number;
}

export interface DisciplineSpeedEvidenceProvenance {
  schemaVersion: typeof MLB_DISCIPLINE_SPEED_EVIDENCE_SCHEMA;
  status: "CERTIFIED";
  generatedAt: string;
  sources: {
    homePitcher: "MLB_STATS_SEASON_PITCHING";
    awayPitcher: "MLB_STATS_SEASON_PITCHING";
    sprintSpeed: "BASEBALL_SAVANT_SPRINT_SPEED";
  };
  homePitcherSampleStatus: "AVAILABLE" | "NO_SEASON_SAMPLE";
  awayPitcherSampleStatus: "AVAILABLE" | "NO_SEASON_SAMPLE";
  speedCacheMaxAgeSeconds: 21_600;
  speedCacheHit: boolean;
  speedCacheAgeSeconds: number;
  failureDisposition: "THROW_FAIL_CLOSED";
}

export interface DisciplineSpeedCertifiedSnapshot extends DisciplineSpeedResult {
  sourceStatus: "CERTIFIED";
  generatedAt: string;
  provenance: DisciplineSpeedEvidenceProvenance;
}

interface PitcherSourceResult {
  data: PitcherDiscipline | null;
  observedAtMs: number;
  sampleStatus: "AVAILABLE" | "NO_SEASON_SAMPLE";
}

interface SpeedSourceResult {
  data: Record<number, BatterSpeed>;
  observedAtMs: number;
  cacheHit: boolean;
  cacheAgeSeconds: number;
}

function runtimeNow(runtime: DisciplineSpeedRuntime): Date {
  return runtime.now ? runtime.now() : new Date();
}

function runtimeFetch(runtime: DisciplineSpeedRuntime): FetchLike {
  return runtime.fetchImpl ?? ((input, init) => fetch(input, init));
}

async function fetchJson(url: string, source: string, runtime: DisciplineSpeedRuntime): Promise<any> {
  let response: Response;
  try {
    response = await runtimeFetch(runtime)(url, { headers: { accept: "application/json" } });
  } catch (error: any) {
    throw new Error(`DISCIPLINE_SPEED_SOURCE_FETCH_FAILED:${source}:${String(error?.message || error || "UNKNOWN")}`);
  }
  if (!response.ok) throw new Error(`DISCIPLINE_SPEED_SOURCE_HTTP_${response.status}:${source}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`DISCIPLINE_SPEED_SOURCE_INVALID_JSON:${source}`);
  }
}

function buildPitcherDiscipline(
  pitcherId: number,
  pitcherName: string,
  st: any,
): PitcherDiscipline | null {
  if (!st) return null;
  const numberOfPitches = parseInt(st.numberOfPitches ?? "0") || 0;
  const strikes = parseInt(st.strikes ?? "0") || 0;
  if (numberOfPitches < 200) return null;  // muestra mínima
  const strikePct = strikes / numberOfPitches;
  const k9 = parseFloat(st.strikeoutsPer9Inn ?? "0") || 0;

  // expectedK9Delta: si strikePct +0.025 sobre liga → K9 +1.5 expected
  // si strikePct -0.025 → K9 -1.5 expected
  const strikeGap = strikePct - LEAGUE_STRIKE_PCT;
  const expectedK9 = 8.5 + (strikeGap * 60);    // mapea ±2.5pp a ±1.5 K9
  const expectedK9Delta = expectedK9 - k9;

  let signal = "";
  if (Math.abs(expectedK9Delta) >= 0.8) {
    if (expectedK9Delta > 0) {
      signal = `🔥 ${pitcherName} subiendo K9 esperado: strike% ${(strikePct*100).toFixed(1)}% (liga ${(LEAGUE_STRIKE_PCT*100).toFixed(1)}%) sugiere K9 ${expectedK9.toFixed(1)} vs actual ${k9.toFixed(1)}.`;
    } else {
      signal = `⚠️ ${pitcherName} bajando K9 esperado: strike% ${(strikePct*100).toFixed(1)}% (liga ${(LEAGUE_STRIKE_PCT*100).toFixed(1)}%) sugiere K9 ${expectedK9.toFixed(1)} vs actual ${k9.toFixed(1)}.`;
    }
  } else {
    signal = `${pitcherName}: strike% ${(strikePct*100).toFixed(1)}% alineado con K9 ${k9.toFixed(1)}.`;
  }

  return {
    pitcherId, pitcherName,
    numberOfPitches, strikes,
    strikePct: Math.round(strikePct * 1000) / 1000,
    k9,
    league: { strikePct: LEAGUE_STRIKE_PCT },
    expectedK9Delta: Math.round(expectedK9Delta * 10) / 10,
    signal,
  };
}

async function loadPitcherDisciplineCertified(
  pitcherId: number,
  pitcherName: string,
  runtime: DisciplineSpeedRuntime,
): Promise<PitcherSourceResult> {
  if (!Number.isInteger(Number(pitcherId)) || Number(pitcherId) <= 0) {
    throw new Error("DISCIPLINE_SPEED_PITCHER_ID_REQUIRED");
  }
  const now = runtimeNow(runtime);
  const season = String(now.getFullYear());
  const payload = await fetchJson(
    `${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`,
    "PITCHER_SEASON",
    runtime,
  );
  if (!Array.isArray(payload?.stats)) throw new Error(`DISCIPLINE_SPEED_PITCHER_STATS_SHAPE_INVALID:${pitcherId}`);
  const st = payload.stats?.[0]?.splits?.[0]?.stat ?? null;
  const data = buildPitcherDiscipline(pitcherId, pitcherName, st);
  return {
    data,
    observedAtMs: now.getTime(),
    sampleStatus: data ? "AVAILABLE" : "NO_SEASON_SAMPLE",
  };
}

export async function fetchPitcherDiscipline(pitcherId: number, pitcherName: string): Promise<PitcherDiscipline | null> {
  if (!pitcherId) return null;
  try {
    return (await loadPitcherDisciplineCertified(pitcherId, pitcherName, {})).data;
  } catch {
    return null;
  }
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const cols = splitCsvLine(l);
    const row: Record<string, string> = {};
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

async function loadSprintSpeedCertified(runtime: DisciplineSpeedRuntime): Promise<SpeedSourceResult> {
  const nowMs = runtimeNow(runtime).getTime();
  const cached = speedCache.current;
  if (cached && nowMs - cached.ts < CACHE_TTL) {
    return {
      data: cached.data,
      observedAtMs: cached.ts,
      cacheHit: true,
      cacheAgeSeconds: Math.max(0, Math.round((nowMs - cached.ts) / 1000)),
    };
  }

  const yr = runtimeNow(runtime).getFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/sprint_speed?min_year=${yr}&max_year=${yr}&min_opp=10&csv=true`;
  let response: Response;
  try {
    response = await runtimeFetch(runtime)(url);
  } catch (error: any) {
    throw new Error(`DISCIPLINE_SPEED_SOURCE_FETCH_FAILED:SPRINT_SPEED:${String(error?.message || error || "UNKNOWN")}`);
  }
  if (!response.ok) throw new Error(`DISCIPLINE_SPEED_SOURCE_HTTP_${response.status}:SPRINT_SPEED`);
  const text = await response.text();
  const rows = parseCsv(text);
  const map: Record<number, BatterSpeed> = {};
  for (const r of rows) {
    const id = parseInt(r["player_id"]);
    const sp = parseFloat(r["sprint_speed"]);
    if (!id || isNaN(sp)) continue;
    let tier: BatterSpeed["tier"] = "AVG";
    if (sp >= SPEED_ELITE) tier = "ELITE";
    else if (sp >= SPEED_THRESHOLD) tier = "FAST";
    else if (sp < 26.0) tier = "SLOW";

    // BABIP floor: rápidos sostienen +0.020 sobre liga
    let babipFloor = LEAGUE_BABIP;
    if (tier === "ELITE") babipFloor = LEAGUE_BABIP + 0.030;
    else if (tier === "FAST") babipFloor = LEAGUE_BABIP + 0.015;
    else if (tier === "SLOW") babipFloor = LEAGUE_BABIP - 0.010;

    map[id] = {
      playerId: id,
      name: r["last_name, first_name"] || r["player_name"] || "",
      sprintSpeed: sp,
      babipFloor: Math.round(babipFloor * 1000) / 1000,
      tier,
    };
  }
  if (!Object.keys(map).length) throw new Error("DISCIPLINE_SPEED_SPRINT_SPEED_EMPTY");
  speedCache.current = { ts: nowMs, data: map };
  return { data: map, observedAtMs: nowMs, cacheHit: false, cacheAgeSeconds: 0 };
}

export async function getSprintSpeedMap(): Promise<Record<number, BatterSpeed>> {
  try {
    return (await loadSprintSpeedCertified({})).data;
  } catch (e) {
    console.error("[sprint-speed] fetch failed:", e);
    return speedCache.current?.data ?? {};
  }
}

function buildDisciplineSpeedResult(
  hDisc: PitcherDiscipline | null,
  aDisc: PitcherDiscipline | null,
  speedMap: Record<number, BatterSpeed>,
  homeLineupIds: number[],
  awayLineupIds: number[],
): DisciplineSpeedResult {
  const homeBatterSpeed = homeLineupIds.map(id => speedMap[id]).filter(Boolean) as BatterSpeed[];
  const awayBatterSpeed = awayLineupIds.map(id => speedMap[id]).filter(Boolean) as BatterSpeed[];

  // Convertir expectedK9Delta a runs delta. Cada 1 K9 ≈ 0.4 runs/juego (menos contactos = menos hits + walks).
  // SP visitante baja K9 (expectedK9Delta negativo) → home anota más → +runs para home
  const awaySPRunsImpact = aDisc ? -(aDisc.expectedK9Delta * 0.20) : 0;  // si SP visitante "sube" K9 esperado → menos runs home
  const homeSPRunsImpact = hDisc ? -(hDisc.expectedK9Delta * 0.20) : 0;

  // Speed boost: bateadores ELITE/FAST en el lineup → corrigen su BABIP a alza, suman runs marginales
  const speedRunsBoost = (batters: BatterSpeed[]): number => {
    const elite = batters.filter(b => b.tier === "ELITE").length;
    const fast = batters.filter(b => b.tier === "FAST").length;
    // Cada ELITE ≈ +0.03 runs, cada FAST ≈ +0.015 runs
    return Math.round((elite * 0.03 + fast * 0.015) * 100) / 100;
  };

  const homeSpeedBoost = speedRunsBoost(homeBatterSpeed);
  const awaySpeedBoost = speedRunsBoost(awayBatterSpeed);

  // Cap deltas finales
  const cap = (n: number) => Math.max(-0.3, Math.min(0.3, n));

  return {
    homeSPDiscipline: hDisc,
    awaySPDiscipline: aDisc,
    homeBatterSpeed,
    awayBatterSpeed,
    homeRunsDelta: Math.round(cap(awaySPRunsImpact + homeSpeedBoost) * 100) / 100,
    awayRunsDelta: Math.round(cap(homeSPRunsImpact + awaySpeedBoost) * 100) / 100,
  };
}

export async function getDisciplineSpeedForGame(
  homePitcherId: number, homePitcherName: string,
  awayPitcherId: number, awayPitcherName: string,
  homeLineupIds: number[], awayLineupIds: number[],
): Promise<DisciplineSpeedResult> {
  const [hDisc, aDisc, speedMap] = await Promise.all([
    fetchPitcherDiscipline(homePitcherId, homePitcherName),
    fetchPitcherDiscipline(awayPitcherId, awayPitcherName),
    getSprintSpeedMap(),
  ]);
  return buildDisciplineSpeedResult(hDisc, aDisc, speedMap, homeLineupIds, awayLineupIds);
}

export async function getDisciplineSpeedCertifiedSnapshot(input: {
  homePitcherId: number;
  homePitcherName: string;
  awayPitcherId: number;
  awayPitcherName: string;
  homeBatterIds: number[];
  awayBatterIds: number[];
  runtime?: DisciplineSpeedRuntime;
}): Promise<DisciplineSpeedCertifiedSnapshot> {
  const runtime = input.runtime ?? {};
  const [homePitcher, awayPitcher, speed] = await Promise.all([
    loadPitcherDisciplineCertified(input.homePitcherId, input.homePitcherName, runtime),
    loadPitcherDisciplineCertified(input.awayPitcherId, input.awayPitcherName, runtime),
    loadSprintSpeedCertified(runtime),
  ]);
  const result = buildDisciplineSpeedResult(
    homePitcher.data,
    awayPitcher.data,
    speed.data,
    input.homeBatterIds,
    input.awayBatterIds,
  );
  const generatedAt = new Date(Math.min(homePitcher.observedAtMs, awayPitcher.observedAtMs, speed.observedAtMs)).toISOString();
  return {
    ...result,
    sourceStatus: "CERTIFIED",
    generatedAt,
    provenance: {
      schemaVersion: MLB_DISCIPLINE_SPEED_EVIDENCE_SCHEMA,
      status: "CERTIFIED",
      generatedAt,
      sources: {
        homePitcher: "MLB_STATS_SEASON_PITCHING",
        awayPitcher: "MLB_STATS_SEASON_PITCHING",
        sprintSpeed: "BASEBALL_SAVANT_SPRINT_SPEED",
      },
      homePitcherSampleStatus: homePitcher.sampleStatus,
      awayPitcherSampleStatus: awayPitcher.sampleStatus,
      speedCacheMaxAgeSeconds: 21_600,
      speedCacheHit: speed.cacheHit,
      speedCacheAgeSeconds: speed.cacheAgeSeconds,
      failureDisposition: "THROW_FAIL_CLOSED",
    },
  };
}

export function resetDisciplineSpeedCachesForTests(): void {
  speedCache.current = null;
}
