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

interface CacheEntry<T> { ts: number; data: T; }
const CACHE_TTL = 6 * 60 * 60 * 1000;     // 6h
const speedCache: { current: CacheEntry<Record<number, BatterSpeed>> | null } = { current: null };

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

export async function fetchPitcherDiscipline(pitcherId: number, pitcherName: string): Promise<PitcherDiscipline | null> {
  if (!pitcherId) return null;
  const season = String(new Date().getFullYear());
  try {
    const j: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`)).json();
    const st = j.stats?.[0]?.splits?.[0]?.stat;
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
  } catch (e) {
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

export async function getSprintSpeedMap(): Promise<Record<number, BatterSpeed>> {
  if (speedCache.current && Date.now() - speedCache.current.ts < CACHE_TTL) return speedCache.current.data;
  const yr = new Date().getFullYear();
  try {
    const url = `https://baseballsavant.mlb.com/leaderboard/sprint_speed?min_year=${yr}&max_year=${yr}&min_opp=10&csv=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Sprint speed ${res.status}`);
    const text = await res.text();
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
        name: r["last_name, first_name"] || "",
        sprintSpeed: sp,
        babipFloor: Math.round(babipFloor * 1000) / 1000,
        tier,
      };
    }
    speedCache.current = { ts: Date.now(), data: map };
    return map;
  } catch (e) {
    console.error("[sprint-speed] fetch failed:", e);
    return speedCache.current?.data ?? {};
  }
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
