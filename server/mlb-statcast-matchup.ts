// ═══════════════════════════════════════════════════════════════════════════
// STATCAST PITCH-BY-PITCH MATCHUP ENGINE
//
// Motor REAL de matchups MLB:
//   1. Lineup confirmado vs repertorio del pitcher (pitch-by-pitch xwOBA)
//   2. Bateador vs equipo histórico (último año + actual)
//   3. Análisis profundo: cómo cada bateador del lineup le pega a cada
//      tipo específico de pitch que el SP del rival lanza
//
// Fuentes: Baseball Savant CSV leaderboards (públicos, sin auth)
//   - pitch-arsenal-stats?type=batter → cómo cada bateador le pega a cada pitch
//   - pitch-arsenal-stats?type=pitcher → repertorio del pitcher
//   - statcast_search → matchups individuales pitcher vs batter
// ═══════════════════════════════════════════════════════════════════════════

// Lineup helper: confirmed first, fallback a roster activo (top 9 hitters por OPS)
type LineupSource = "CONFIRMED" | "PROJECTED_LAST_GAME" | "PROJECTED_ROSTER" | "UNAVAILABLE";
type LineupPlayer = { id: number; fullName: string; position?: string; battingOrder?: number };
type LineupResult = { players: LineupPlayer[]; source: LineupSource };

async function getConfirmedLineup(gamePk: number, teamId: number): Promise<LineupResult> {
  // ── 1. CONFIRMADO desde boxscore del juego actual ──
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d: any = await r.json();
      const teams = d?.liveData?.boxscore?.teams;
      const home = d?.gameData?.teams?.home?.id;
      const away = d?.gameData?.teams?.away?.id;
      const side = teamId === home ? "home" : teamId === away ? "away" : null;
      if (side && teams?.[side]?.battingOrder?.length > 0) {
        const order: number[] = teams[side].battingOrder;
        const players = teams[side].players;
        const list = order.map((pid, i) => {
          const p = players[`ID${pid}`];
          return {
            id: pid,
            fullName: p?.person?.fullName ?? "Unknown",
            position: p?.position?.abbreviation,
            battingOrder: i + 1,
          };
        });
        return { players: list, source: "CONFIRMED" };
      }
    }
  } catch {}

  // ── 2. PROYECTADO desde el lineup REAL del último juego jugado del equipo ──
  // Más confiable que tomar 9 del roster (descarta lesionados/banca naturalmente)
  try {
    // Buscar último juego terminado del equipo
    const sched = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${new Date(Date.now() - 14 * 86400000).toISOString().slice(0,10)}&endDate=${new Date().toISOString().slice(0,10)}`, { signal: AbortSignal.timeout(8000) });
    if (sched.ok) {
      const sd: any = await sched.json();
      // Recolectar todos los gamePks completados del equipo, más recientes primero
      const games: number[] = [];
      for (const date of (sd.dates ?? []).slice().reverse()) {
        for (const g of (date.games ?? []).slice().reverse()) {
          if (g.status?.abstractGameState === "Final" && g.gamePk !== gamePk) {
            games.push(g.gamePk);
          }
        }
      }
      // Tomar el más reciente y extraer su lineup
      for (const pastGamePk of games.slice(0, 1)) {
        try {
          const fr = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${pastGamePk}/feed/live`, { signal: AbortSignal.timeout(8000) });
          if (fr.ok) {
            const fd: any = await fr.json();
            const fteams = fd?.liveData?.boxscore?.teams;
            const fhome = fd?.gameData?.teams?.home?.id;
            const faway = fd?.gameData?.teams?.away?.id;
            const fside = teamId === fhome ? "home" : teamId === faway ? "away" : null;
            if (fside && fteams?.[fside]?.battingOrder?.length >= 8) {
              const order: number[] = fteams[fside].battingOrder;
              const players = fteams[fside].players;
              const list = order.map((pid, i) => {
                const p = players[`ID${pid}`];
                return {
                  id: pid,
                  fullName: p?.person?.fullName ?? "Unknown",
                  position: p?.position?.abbreviation,
                  battingOrder: i + 1,
                };
              });
              return { players: list, source: "PROJECTED_LAST_GAME" };
            }
          }
        } catch {}
      }
    }
  } catch {}

  // ── 3. Último recurso: roster activo, top 9 hitters por OPS (filtra IL list) ──
  try {
    const r = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { players: [], source: "UNAVAILABLE" };
    const d: any = await r.json();
    const hitters = (d.roster ?? []).filter((p: any) => !p.position?.code?.startsWith("1"));
    const list = hitters.slice(0, 9).map((p: any, i: number) => ({
      id: p.person.id,
      fullName: p.person.fullName,
      position: p.position?.abbreviation,
      battingOrder: i + 1,
    }));
    return { players: list, source: "PROJECTED_ROSTER" };
  } catch { return { players: [], source: "UNAVAILABLE" }; }
}

interface BatterPitchStats {
  playerId: number;
  playerName: string;
  team: string;
  pitchType: string;        // FF, SL, CH, CU, SI, FC, KC, FS, ST, SV
  pitchName: string;        // "4-Seam Fastball", "Slider", etc
  pitches: number;
  pa: number;
  ba: number;
  slg: number;
  woba: number;
  xwoba: number;            // expected wOBA (más predictivo que wOBA)
  whiff: number;            // % de swings y fallas
  k: number;                // K%
  hardHit: number;          // % de hard contact (95+ mph EV)
  runValue100: number;      // run value por 100 pitches (negativo = pitcher gana, positivo = bateador gana)
}

interface PitcherArsenal {
  pitcherId: number;
  pitcherName: string;
  pitches: { type: string; name: string; usage: number; wobaAgainst: number; whiff: number }[];
}

interface BatterMatchup {
  batterId: number;
  batterName: string;
  position: string | undefined;
  battingOrder: number | undefined;
  // Análisis vs el repertorio del SP rival (ponderado 50/30/20 con momentum)
  expectedXwoba: number;       // xwOBA ponderado por usage del pitcher Y por ventana temporal
  expectedRunValue: number;
  vulnerabilities: string[];
  strengths: string[];
  // Versiones con filtro de forma reciente — cada item tiene un tier de confianza
  // tier: "REAL" (peso 100%) | "PAPEL" (ventaja histórica pero bateador frío) |
  //       "HISTORICO_MAL_PERO_HOT" (vulnerabilidad pero bateador caliente)
  strengthsAnnotated?: { pitch: string; tier: "REAL" | "PAPEL"; xwoba: number; recentOps?: number; momentumTier?: string }[];
  vulnerabilitiesAnnotated?: { pitch: string; tier: "REAL" | "NEUTRALIZED"; xwoba: number; recentOps?: number; momentumTier?: string }[];
  // Hot streak oculto: bateador con OPS 15d alto pero sin destacar por pitch type
  hotStreakHidden?: boolean;
  notes: string;
  // Momentum reciente (últimos 15 días)
  recentOps?: number;
  recentPa?: number;
  momentumTier?: "HOT" | "WARM" | "NEUTRAL" | "COOL" | "COLD" | "UNKNOWN";
  // Matchup directo vs el pitcher rival (carrera)
  vsPitcherCareer?: { pa: number; ops: number; hr: number; k: number };
}

interface LineupMatchupResult {
  pitcherId: number;
  pitcherName: string;
  arsenal: PitcherArsenal["pitches"];
  lineupSize: number;
  battersAnalyzed: number;
  averageExpectedXwoba: number;
  expectedTeamRunsDelta: number;
  topVulnerabilities: BatterMatchup[];
  topStrengths: BatterMatchup[];
  perBatter: BatterMatchup[];
  signal: string;
  // Bullpen breakdown (top relevistas que probablemente entran)
  bullpenMatchup?: { pitcherId: number; pitcherName: string; role: string; expectedRunsDelta: number }[];
  // Calidad de los datos del análisis: FULL/PARTIAL/LOW — el modelo modera su peso
  dataConfidence?: "FULL" | "PARTIAL" | "LOW";
  directCount?: number;
  proxyCount?: number;
  // Fuente del lineup: confirmado, proyectado del último juego, o roster genérico
  lineupSource?: "CONFIRMED" | "PROJECTED_LAST_GAME" | "PROJECTED_ROSTER" | "UNAVAILABLE";
  // Diagnóstico explícito cuando no se pudo analizar (lineup pendiente, sin arsenal, etc.)
  reason?: string;
  // Momentum del lineup completo (últimos 15 días)
  lineupMomentum?: { teamOps15d: number; tier: "HOT" | "WARM" | "NEUTRAL" | "COOL" | "COLD"; vsTrend: number };
  // Contexto del juego (factores blandos)
  gameContext?: { isAfternoon: boolean; afterOffDay: boolean; bullpenTired: boolean; postImplosion: boolean; notes: string[] };
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────
async function fetchSavantCsv(url: string, timeoutMs = 30000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://baseballsavant.mlb.com/" },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function parseCsv(text: string): Record<string, string>[] {
  // Strip BOM
  text = text.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ""; });
    return obj;
  });
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (c === '"') inQ = !inQ;
    else if (c === "," && !inQ) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// ─── Cache ──────────────────────────────────────────────────────────────────
const CACHE_TTL = 24 * 3600 * 1000; // 24h
const MOMENTUM_TTL = 6 * 3600 * 1000;  // momentum: refresh cada 6h
const VS_PITCHER_TTL = 24 * 3600 * 1000;

// Caches específicos
const recentStatsCache: Record<string, { ts: number; ops: number; pa: number; tier: BatterMatchup["momentumTier"] }> = {};
const vsPitcherCache: Record<string, { ts: number; data: BatterMatchup["vsPitcherCareer"] | null }> = {};
const bullpenCache: Record<string, { ts: number; data: number[] }> = {};
let batterArsenalCache: { ts: number; year: number; data: BatterPitchStats[] } | null = null;
let pitcherArsenalCache: { ts: number; year: number; data: Record<number, PitcherArsenal> } | null = null;

// Team-vs-pitch-type aggregate (proxy cuando no hay datos del bateador individual)
interface TeamPitchAggregate { pa: number; xwoba: number; whiff: number; }
let teamArsenalCache: { ts: number; year: number; data: Record<string, Record<string, TeamPitchAggregate>> } | null = null;

async function loadBatterArsenal(year: number): Promise<BatterPitchStats[]> {
  if (batterArsenalCache && batterArsenalCache.year === year && Date.now() - batterArsenalCache.ts < CACHE_TTL) {
    return batterArsenalCache.data;
  }
  const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitch_type=ALL&min_pa=q&min_pitches=q&year=${year}&team=&csv=true`;
  const csv = await fetchSavantCsv(url);
  if (!csv) return batterArsenalCache?.data ?? [];
  const rows = parseCsv(csv);
  const data: BatterPitchStats[] = rows.map(r => ({
    playerId: parseInt(r["player_id"]),
    playerName: r["last_name, first_name"],
    team: r["team_name_alt"],
    pitchType: r["pitch_type"],
    pitchName: r["pitch_name"],
    pitches: parseInt(r["pitches"]) || 0,
    pa: parseInt(r["pa"]) || 0,
    ba: parseFloat(r["ba"]) || 0,
    slg: parseFloat(r["slg"]) || 0,
    woba: parseFloat(r["woba"]) || 0,
    xwoba: parseFloat(r["est_woba"]) || parseFloat(r["woba"]) || 0,
    whiff: parseFloat(r["whiff_percent"]) || 0,
    k: parseFloat(r["k_percent"]) || 0,
    hardHit: parseFloat(r["hard_hit_percent"]) || 0,
    runValue100: parseFloat(r["run_value_per_100"]) || 0,
  })).filter(r => r.playerId > 0);
  batterArsenalCache = { ts: Date.now(), year, data };
  return data;
}

async function loadTeamArsenal(year: number): Promise<Record<string, Record<string, TeamPitchAggregate>>> {
  if (teamArsenalCache && teamArsenalCache.year === year && Date.now() - teamArsenalCache.ts < CACHE_TTL) {
    return teamArsenalCache.data;
  }
  // Re-usa el batter arsenal CSV pero agrega por team+pitch_type
  const data = await loadBatterArsenal(year);
  const byTeam: Record<string, Record<string, TeamPitchAggregate & { _xwobaSum: number; _whiffSum: number }>> = {};
  for (const r of data) {
    if (r.pa < 30 || !r.team) continue;
    if (!byTeam[r.team]) byTeam[r.team] = {};
    if (!byTeam[r.team][r.pitchType]) byTeam[r.team][r.pitchType] = { pa: 0, xwoba: 0, whiff: 0, _xwobaSum: 0, _whiffSum: 0 };
    const agg = byTeam[r.team][r.pitchType];
    agg.pa += r.pa;
    agg._xwobaSum += r.xwoba * r.pa;
    agg._whiffSum += r.whiff * r.pa;
  }
  // Calcular promedios ponderados
  const final: Record<string, Record<string, TeamPitchAggregate>> = {};
  for (const [team, pitches] of Object.entries(byTeam)) {
    final[team] = {};
    for (const [pt, agg] of Object.entries(pitches)) {
      final[team][pt] = {
        pa: agg.pa,
        xwoba: agg.pa > 0 ? agg._xwobaSum / agg.pa : 0.310,
        whiff: agg.pa > 0 ? agg._whiffSum / agg.pa : 22,
      };
    }
  }
  teamArsenalCache = { ts: Date.now(), year, data: final };
  return final;
}

async function loadPitcherArsenal(year: number): Promise<Record<number, PitcherArsenal>> {
  if (pitcherArsenalCache && pitcherArsenalCache.year === year && Date.now() - pitcherArsenalCache.ts < CACHE_TTL) {
    return pitcherArsenalCache.data;
  }
  const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitch_type=ALL&min_pa=q&min_pitches=q&year=${year}&team=&csv=true`;
  const csv = await fetchSavantCsv(url);
  if (!csv) return pitcherArsenalCache?.data ?? {};
  const rows = parseCsv(csv);
  const byPitcher: Record<number, PitcherArsenal> = {};
  for (const r of rows) {
    const pid = parseInt(r["player_id"]);
    if (!pid) continue;
    if (!byPitcher[pid]) {
      byPitcher[pid] = { pitcherId: pid, pitcherName: r["last_name, first_name"], pitches: [] };
    }
    byPitcher[pid].pitches.push({
      type: r["pitch_type"],
      name: r["pitch_name"],
      usage: parseFloat(r["pitch_usage"]) || 0,
      wobaAgainst: parseFloat(r["woba"]) || 0,
      whiff: parseFloat(r["whiff_percent"]) || 0,
    });
  }
  pitcherArsenalCache = { ts: Date.now(), year, data: byPitcher };
  return byPitcher;
}

// ─── Core matchup analysis ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// MOMENTUM: stats últimos 15 días (peso 50% en xwOBA final)
// ═══════════════════════════════════════════════════════════════════════════
async function getRecentBatterStats(batterId: number, gameDate: string): Promise<{ ops: number; pa: number; tier: BatterMatchup["momentumTier"] }> {
  const cacheKey = `${batterId}_${gameDate.slice(0,10)}`;
  const c = recentStatsCache[cacheKey];
  if (c && Date.now() - c.ts < MOMENTUM_TTL) return { ops: c.ops, pa: c.pa, tier: c.tier };
  const end = gameDate.slice(0, 10);
  const startDate = new Date(new Date(end).getTime() - 15 * 86400000).toISOString().slice(0, 10);
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=byDateRange&group=hitting&startDate=${startDate}&endDate=${end}&sportId=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ops: 0, pa: 0, tier: "UNKNOWN" };
    const d: any = await r.json();
    const split = d?.stats?.[0]?.splits?.[0]?.stat;
    if (!split) return { ops: 0, pa: 0, tier: "UNKNOWN" };
    const ops = parseFloat(split.ops) || 0;
    const pa = parseInt(split.plateAppearances) || 0;
    let tier: BatterMatchup["momentumTier"] = "NEUTRAL";
    if (pa < 15) tier = "UNKNOWN";
    else if (ops >= 0.900) tier = "HOT";
    else if (ops >= 0.800) tier = "WARM";
    else if (ops >= 0.680) tier = "NEUTRAL";
    else if (ops >= 0.580) tier = "COOL";
    else tier = "COLD";
    recentStatsCache[cacheKey] = { ts: Date.now(), ops, pa, tier };
    return { ops, pa, tier };
  } catch { return { ops: 0, pa: 0, tier: "UNKNOWN" }; }
}

// ═══════════════════════════════════════════════════════════════════════════
// MATCHUP DIRECTO BATEADOR vs PITCHER (vsPlayerTotal — toda la carrera)
// ═══════════════════════════════════════════════════════════════════════════
async function getVsPitcherCareer(batterId: number, pitcherId: number): Promise<BatterMatchup["vsPitcherCareer"]> {
  const cacheKey = `${batterId}_vs_${pitcherId}`;
  const c = vsPitcherCache[cacheKey];
  if (c && Date.now() - c.ts < VS_PITCHER_TTL) return c.data ?? undefined;
  try {
    const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) { vsPitcherCache[cacheKey] = { ts: Date.now(), data: null }; return undefined; }
    const d: any = await r.json();
    const split = d?.stats?.[0]?.splits?.[0]?.stat;
    if (!split || !split.plateAppearances) { vsPitcherCache[cacheKey] = { ts: Date.now(), data: null }; return undefined; }
    const data = {
      pa: parseInt(split.plateAppearances),
      ops: parseFloat(split.ops) || 0,
      hr: parseInt(split.homeRuns) || 0,
      k: parseInt(split.strikeOuts) || 0,
    };
    vsPitcherCache[cacheKey] = { ts: Date.now(), data };
    return data;
  } catch { return undefined; }
}

// ═══════════════════════════════════════════════════════════════════════════
// BULLPEN PROYECTADO: cierre + setup + middle más probables
// ═══════════════════════════════════════════════════════════════════════════
async function getProjectedBullpen(teamId: number, season: number): Promise<{ pitcherId: number; pitcherName: string; role: string }[]> {
  const cacheKey = `${teamId}_${season}`;
  const c = bullpenCache[cacheKey];
  if (c && Date.now() - c.ts < CACHE_TTL) {
    // En el cache solo guardamos los IDs; rehidratamos el resto
  }
  try {
    // 1. Roster activo
    const rosterRes = await fetch(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&hydrate=person`, { signal: AbortSignal.timeout(8000) });
    if (!rosterRes.ok) return [];
    const roster: any = await rosterRes.json();
    const pitchers = (roster.roster ?? []).filter((p: any) => p.position?.code === "1");
    // 2. Para cada pitcher, traer stats de relievo (saves + holds + leverage)
    const stats = await Promise.all(pitchers.map(async (p: any) => {
      try {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/people/${p.person.id}/stats?stats=season&group=pitching&season=${season}&sportId=1`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return null;
        const d: any = await r.json();
        const s = d?.stats?.[0]?.splits?.[0]?.stat;
        if (!s) return null;
        const games = parseInt(s.gamesPlayed) || 0;
        const starts = parseInt(s.gamesStarted) || 0;
        const saves = parseInt(s.saves) || 0;
        const holds = parseInt(s.holds) || 0;
        const ip = parseFloat(s.inningsPitched) || 0;
        // Solo relevistas (no SP)
        if (starts > games * 0.3) return null;
        if (games < 5) return null;
        return {
          pitcherId: p.person.id,
          pitcherName: p.person.fullName,
          saves, holds, games, ip,
          score: saves * 4 + holds * 2 + ip * 0.5, // peso de leverage
        };
      } catch { return null; }
    }));
    const valid = stats.filter(Boolean).sort((a: any, b: any) => b.score - a.score);
    if (valid.length === 0) return [];
    // Top 4 por leverage
    const top = valid.slice(0, 4);
    const result: { pitcherId: number; pitcherName: string; role: string }[] = [];
    if (top[0]) result.push({ pitcherId: top[0]!.pitcherId, pitcherName: top[0]!.pitcherName, role: "Closer" });
    if (top[1]) result.push({ pitcherId: top[1]!.pitcherId, pitcherName: top[1]!.pitcherName, role: "Setup" });
    if (top[2]) result.push({ pitcherId: top[2]!.pitcherId, pitcherName: top[2]!.pitcherName, role: "Middle" });
    if (top[3]) result.push({ pitcherId: top[3]!.pitcherId, pitcherName: top[3]!.pitcherName, role: "Middle" });
    return result;
  } catch { return []; }
}

// ── Threshold dinámico por mes ──
// Mar-May (poca muestra) → thresholds bajos para no caer a LEAGUE en abril/mayo
// Jun-Sep (muestra completa) → thresholds estándar
// Oct (playoffs) → thresholds altos para máxima certeza
function getStatcastThresholds(): { minPitches: number; minTeamPa: number } {
  const month = new Date().getMonth() + 1; // 1-12
  if (month >= 3 && month <= 5) return { minPitches: 20, minTeamPa: 35 };  // primavera
  if (month === 10) return { minPitches: 50, minTeamPa: 80 };               // playoffs
  return { minPitches: 30, minTeamPa: 50 };                                  // verano
}

function analyzeBatter(
  batterId: number,
  batterName: string,
  position: string | undefined,
  battingOrder: number | undefined,
  arsenal: PitcherArsenal,
  batterStats: BatterPitchStats[],
  teamFallback: Record<string, TeamPitchAggregate> | null, // PROXY del equipo cuando bateador sin data
): BatterMatchup & { dataQuality: "DIRECT" | "TEAM_PROXY" | "LEAGUE" } {
  const { minPitches, minTeamPa } = getStatcastThresholds();
  const batterByType: Record<string, BatterPitchStats> = {};
  for (const s of batterStats) batterByType[s.pitchType] = s;

  let weightedXwoba = 0;
  let totalUsage = 0;
  let weightedRunValue = 0;
  const vulnerabilities: string[] = [];
  const strengths: string[] = [];
  let directMatches = 0;
  let proxyMatches = 0;

  for (const pitch of arsenal.pitches) {
    const bs = batterByType[pitch.type];
    if (bs && bs.pitches >= minPitches) {
      // Capa 1: data directa del bateador
      weightedXwoba += bs.xwoba * (pitch.usage / 100);
      weightedRunValue += bs.runValue100 * (pitch.usage / 100);
      totalUsage += pitch.usage / 100;
      directMatches++;
      if (bs.xwoba < 0.290) vulnerabilities.push(`${pitch.name} (xwOBA ${bs.xwoba.toFixed(3)}, whiff ${bs.whiff.toFixed(0)}%)`);
      else if (bs.xwoba > 0.360) strengths.push(`${pitch.name} (xwOBA ${bs.xwoba.toFixed(3)})`);
    } else if (teamFallback && teamFallback[pitch.type] && teamFallback[pitch.type].pa >= minTeamPa) {
      // Capa 2: PROXY del equipo — cómo bate el equipo entero contra ese pitch type
      const tp = teamFallback[pitch.type];
      weightedXwoba += tp.xwoba * (pitch.usage / 100);
      totalUsage += pitch.usage / 100;
      proxyMatches++;
      if (tp.xwoba < 0.300) vulnerabilities.push(`${pitch.name} (proxy equipo: xwOBA ${tp.xwoba.toFixed(3)})`);
      else if (tp.xwoba > 0.350) strengths.push(`${pitch.name} (proxy equipo: xwOBA ${tp.xwoba.toFixed(3)})`);
    }
    // Capa 3: si no hay nada, asume neutralidad de liga (xwOBA 0.310) — ya implicito
  }
  let expectedXwoba = totalUsage > 0 ? weightedXwoba / totalUsage : 0.310;
  const expectedRunValue = weightedRunValue;

  // Data quality
  const dataQuality: "DIRECT" | "TEAM_PROXY" | "LEAGUE" =
    directMatches >= arsenal.pitches.length * 0.6 ? "DIRECT" :
    (directMatches + proxyMatches) >= arsenal.pitches.length * 0.6 ? "TEAM_PROXY" : "LEAGUE";

  let notes = "";
  if (vulnerabilities.length >= 2) notes = `Vulnerable a ${vulnerabilities.length} pitches del SP`;
  else if (strengths.length >= 2) notes = `Castiga ${strengths.length} pitches del SP`;
  else if (dataQuality === "LEAGUE") notes = "Sin muestra (liga promedio)";
  else if (dataQuality === "TEAM_PROXY") notes = `Estimado vía perfil del equipo (sin data directa)`;
  else notes = "Matchup neutral";

  return { batterId, batterName, position, battingOrder, expectedXwoba, expectedRunValue, vulnerabilities, strengths, notes, dataQuality };
}

export async function getLineupVsPitcherMatchup(
  gamePk: number,
  pitcherId: number,
  pitcherName: string,
  lineupTeamId: number,
  season: number = new Date().getFullYear(),
  lineupTeamAbbrev: string = "",  // código de 3 letras (TOR, BOS, etc.) para fallback proxy
): Promise<LineupMatchupResult | null> {
  // 1. Lineup confirmado o proyectado del TEAM con el que enfrenta este pitcher
  const lineupResult = await getConfirmedLineup(gamePk, lineupTeamId);
  const lineup = lineupResult.players;
  const lineupSource = lineupResult.source;
  if (!lineup || lineup.length === 0) {
    return { pitcherId, pitcherName, arsenal: [], lineupSize: 0, battersAnalyzed: 0,
      averageExpectedXwoba: 0.310, expectedTeamRunsDelta: 0, topVulnerabilities: [], topStrengths: [], perBatter: [],
      signal: "Sin lineup disponible", dataConfidence: "LOW", lineupSource: "UNAVAILABLE",
      reason: "LINEUP_UNAVAILABLE: no pudimos obtener ni el confirmado ni el proyectado. Vuelve más cerca del juego." };
  }
  // Si el lineup es del roster genérico (último recurso), avisar al usuario que puede tener fantasmas
  // y aplicar pérdida de confianza automática.
  if (lineupSource === "PROJECTED_ROSTER") {
    // Continuar pero marcar como BAJA confianza
  }

  // 2. Cargar arsenales (current season; fallback prev si vacío)
  let pitcherArsenals = await loadPitcherArsenal(season);
  let arsenal = pitcherArsenals[pitcherId];
  if (!arsenal || arsenal.pitches.length === 0) {
    pitcherArsenals = await loadPitcherArsenal(season - 1);
    arsenal = pitcherArsenals[pitcherId];
  }
  if (!arsenal) {
    return { pitcherId, pitcherName, arsenal: [], lineupSize: lineup.length, battersAnalyzed: 0,
      averageExpectedXwoba: 0.310, expectedTeamRunsDelta: 0, topVulnerabilities: [], topStrengths: [], perBatter: [],
      signal: "Sin arsenal Statcast del pitcher", dataConfidence: "LOW", lineupSource,
      reason: `NO_ARSENAL: ${pitcherName} aún no tiene perfil en Baseball Savant (rookie con <30 pitches o anuncio tardío). Imposible análisis pitch-by-pitch.` };
  }

  let batterStats = await loadBatterArsenal(season);
  if (batterStats.length === 0) batterStats = await loadBatterArsenal(season - 1);

  const batterStatsMap = new Map<number, BatterPitchStats[]>();
  for (const s of batterStats) {
    if (!batterStatsMap.has(s.playerId)) batterStatsMap.set(s.playerId, []);
    batterStatsMap.get(s.playerId)!.push(s);
  }

  // Cargar team arsenal para fallback (proxy)
  // Cargar AMBAS temporadas y fusionar — current season tiene poca muestra en abril/mayo,
  // prev season tiene la base histórica completa
  let teamArsenal = await loadTeamArsenal(season);
  const prevTeamArsenal = await loadTeamArsenal(season - 1);
  // Fusionar: si current tiene <80 PA en un pitch_type, usar prev season para ese tipo
  for (const [team, pitches] of Object.entries(prevTeamArsenal)) {
    if (!teamArsenal[team]) teamArsenal[team] = {};
    for (const [pt, prevAgg] of Object.entries(pitches)) {
      const curr = teamArsenal[team][pt];
      if (!curr || curr.pa < 80) {
        // Usar prev como respaldo
        teamArsenal[team][pt] = prevAgg;
      }
    }
  }
  // Buscar el código de equipo: primero del parámetro explícito, fallback a stats del primer bateador con data
  let lineupTeamCode: string | null = lineupTeamAbbrev || null;
  if (!lineupTeamCode) {
    for (const b of lineup) {
      const sStats = batterStatsMap.get(b.id) ?? [];
      if (sStats[0]?.team) { lineupTeamCode = sStats[0].team; break; }
    }
  }
  const teamFallback = lineupTeamCode ? (teamArsenal[lineupTeamCode] ?? null) : null;

  // Game date para momentum window
  const gameDate = new Date().toISOString();

  const perBatter: (BatterMatchup & { dataQuality: string })[] = [];
  let totalXwoba = 0;
  let countAnalyzed = 0;
  let directCount = 0, proxyCount = 0;

  // PARALELIZAR: por cada bateador disparamos en paralelo (a) statcast analysis, (b) momentum 15d, (c) vs-pitcher career
  await Promise.all(lineup.map(async (b) => {
    const stats = batterStatsMap.get(b.id) ?? [];
    const baseMatchup = analyzeBatter(b.id, b.fullName, b.position, b.battingOrder, arsenal, stats, teamFallback);
    // Momentum y vsPitcher en paralelo
    const [recent, vsP] = await Promise.all([
      getRecentBatterStats(b.id, gameDate),
      pitcherId ? getVsPitcherCareer(b.id, pitcherId) : Promise.resolve(undefined),
    ]);
    // PONDERACIÓN TEMPORAL 50/30/20:
    //   - 50% xwOBA reciente (15d, convertido aprox: ops -> xwoba via ops*0.42)
    //   - 30% xwOBA Statcast season actual (de baseMatchup)
    //   - 20% liga (0.310)
    // Si recent tier es UNKNOWN, redistribuimos: 70% statcast + 30% liga (sin momentum)
    let finalXwoba = baseMatchup.expectedXwoba;
    if (recent.tier !== "UNKNOWN" && recent.pa >= 15) {
      const recentXwobaProxy = Math.max(0.200, Math.min(0.500, recent.ops * 0.42)); // ops -> xwoba aprox
      finalXwoba = recentXwobaProxy * 0.50 + baseMatchup.expectedXwoba * 0.30 + 0.310 * 0.20;
    } else {
      finalXwoba = baseMatchup.expectedXwoba * 0.70 + 0.310 * 0.30;
    }
    // BOOST/DRAG por vsPitcher career (cuando hay 8+ PA)
    if (vsP && vsP.pa >= 8) {
      const vsPxwobaProxy = Math.max(0.200, Math.min(0.500, vsP.ops * 0.42));
      // Mezcla: 70% modelo agregado + 30% vsPitcher directo
      finalXwoba = finalXwoba * 0.70 + vsPxwobaProxy * 0.30;
    }
    baseMatchup.expectedXwoba = Math.round(finalXwoba * 1000) / 1000;
    baseMatchup.recentOps = recent.ops > 0 ? recent.ops : undefined;
    baseMatchup.recentPa = recent.pa > 0 ? recent.pa : undefined;
    baseMatchup.momentumTier = recent.tier;
    baseMatchup.vsPitcherCareer = vsP;

    // ─── FORM GATE: re-evaluar fortalezas/vulnerabilidades con OPS 15d ───
    // Una fortaleza solo es REAL si el bateador está al menos en forma normal (OPS 15d ≥0.700).
    // Una vulnerabilidad solo es REAL si el bateador no está en llamas (OPS 15d <0.850).
    const isCold = recent.tier === "COOL" || recent.tier === "COLD";
    const isHot = recent.tier === "HOT";
    const ops15d = recent.ops;
    // `stats` ya está disponible desde arriba en el closure

    const strengthsAnnotated: { pitch: string; tier: "REAL" | "PAPEL"; xwoba: number; recentOps?: number; momentumTier?: string }[] = [];
    const vulnerabilitiesAnnotated: { pitch: string; tier: "REAL" | "NEUTRALIZED"; xwoba: number; recentOps?: number; momentumTier?: string }[] = [];

    // Recorre las fortalezas detectadas en analyzeBatter
    for (const strStr of baseMatchup.strengths) {
      // Extraer pitch name + xwoba del string ("FF (xwOBA 0.420)" o "FF (proxy equipo: xwOBA 0.420)")
      const m = strStr.match(/^(.+?)\s*\(.*xwOBA\s+([0-9.]+)/);
      const pitchName = m ? m[1].trim() : strStr;
      const xwoba = m ? parseFloat(m[2]) : 0;
      // Es "PAPEL" si OPS 15d válido y bateador frío (ventaja en papel mojado)
      const tier: "REAL" | "PAPEL" = (isCold && recent.pa >= 15) ? "PAPEL" : "REAL";
      strengthsAnnotated.push({ pitch: pitchName, tier, xwoba, recentOps: ops15d || undefined, momentumTier: recent.tier });
    }
    for (const vStr of baseMatchup.vulnerabilities) {
      const m = vStr.match(/^(.+?)\s*\(.*xwOBA\s+([0-9.]+)/);
      const pitchName = m ? m[1].trim() : vStr;
      const xwoba = m ? parseFloat(m[2]) : 0;
      // Vulnerabilidad NEUTRALIZED si bateador en llamas (ignora su historial malo)
      const tier: "REAL" | "NEUTRALIZED" = (isHot && recent.pa >= 15) ? "NEUTRALIZED" : "REAL";
      vulnerabilitiesAnnotated.push({ pitch: pitchName, tier, xwoba, recentOps: ops15d || undefined, momentumTier: recent.tier });
    }
    // Hot streak oculto: bateador en buena forma reciente que el modelo se está perdiendo.
    // Antes: solo HOT (≥0.900). Ahora: también WARM (≥0.800) con muestra mínima.
    // Esto captura bateadores como Elly De La Cruz dando 2 hits/juego que el matchup
    // pitch-by-pitch no destaca por su perfil de strikeout o por arsenal específico.
    const isWarmOrHot = recent.tier === "HOT" || recent.tier === "WARM";
    baseMatchup.hotStreakHidden = isWarmOrHot && strengthsAnnotated.length === 0 && recent.pa >= 20;
    baseMatchup.strengthsAnnotated = strengthsAnnotated;
    baseMatchup.vulnerabilitiesAnnotated = vulnerabilitiesAnnotated;

    // ─── AJUSTE NUMÉRICO al expectedXwoba según tiers de confianza ───
    // Si la mayoría de "fortalezas" son PAPEL, degradar xwoba final (volíamos hacia liga)
    // Si hay hot streak oculto, subir xwoba (el modelo se lo estaba perdiendo)
    const totalStrengths = strengthsAnnotated.length;
    const realStrengths = strengthsAnnotated.filter(s => s.tier === "REAL").length;
    if (totalStrengths >= 2 && realStrengths === 0) {
      // Todas son PAPEL → reducir xwoba 5% hacia la liga
      baseMatchup.expectedXwoba = Math.round((baseMatchup.expectedXwoba * 0.85 + 0.310 * 0.15) * 1000) / 1000;
    }
    if (baseMatchup.hotStreakHidden) {
      // Boost xwoba según intensidad de la forma:
      // HOT (≥0.900) → +0.040 (mayor que antes)
      // WARM (0.800-0.900) → +0.020
      const boost = isHot ? 0.040 : 0.020;
      baseMatchup.expectedXwoba = Math.round((baseMatchup.expectedXwoba + boost) * 1000) / 1000;
    }

    perBatter.push(baseMatchup);
    if (baseMatchup.expectedXwoba > 0) {
      totalXwoba += baseMatchup.expectedXwoba;
      countAnalyzed++;
      if (baseMatchup.dataQuality === "DIRECT") directCount++;
      else if (baseMatchup.dataQuality === "TEAM_PROXY") proxyCount++;
    }
  }));

  // Re-ordenar por bateadingOrder después del Promise.all (porque el orden se pierde)
  perBatter.sort((a, b) => (a.battingOrder ?? 99) - (b.battingOrder ?? 99));

  const averageExpectedXwoba = countAnalyzed > 0 ? totalXwoba / countAnalyzed : 0.310;
  // Conversion xwOBA → runs/game: ΔxwOBA × 11 ≈ Δruns/game (sabermetric estandar)
  const expectedTeamRunsDelta = Math.round((averageExpectedXwoba - 0.310) * 11 * 100) / 100;

  // Top 3 vulnerabilities y strengths del lineup
  const sortedByXwoba = [...perBatter].filter(m => m.expectedXwoba > 0).sort((a, b) => a.expectedXwoba - b.expectedXwoba);
  const topVulnerabilities = sortedByXwoba.slice(0, 3);
  const topStrengths = sortedByXwoba.slice(-3).reverse();

  // ── Data confidence agregado del lineup ──
  // FULL: 66%+ del lineup con DIRECT data
  // PARTIAL: 60%+ con DIRECT o TEAM_PROXY
  // LOW: <60% con datos reales (mayoritariamente liga)
  const lineupSizeAnalyzed = perBatter.length || 1;
  const directRatio = directCount / lineupSizeAnalyzed;
  const usableRatio = (directCount + proxyCount) / lineupSizeAnalyzed;
  let dataConfidence: "FULL" | "PARTIAL" | "LOW" = "LOW";
  if (directRatio >= 0.66) dataConfidence = "FULL";
  else if (usableRatio >= 0.60) dataConfidence = "PARTIAL";
  // ⚠️ Si el lineup viene de roster genérico (no del último juego ni confirmado),
  // forzar BAJA confianza porque puede haber lesionados/banca
  if (lineupSource === "PROJECTED_ROSTER") dataConfidence = "LOW";

  const reasonParts: string[] = [];
  if (lineupSource === "PROJECTED_ROSTER") {
    reasonParts.push("LINEUP_INCIERTO: lineup proyectado desde roster activo — puede incluir lesionados/banca. Vuelve cerca del juego.");
  } else if (lineupSource === "PROJECTED_LAST_GAME") {
    reasonParts.push("LINEUP_PROYECTADO: del último juego del equipo. Confirmado real sale 1-2h antes del juego.");
  }
  if (dataConfidence === "LOW" && lineupSource !== "PROJECTED_ROSTER") {
    reasonParts.push(`LOW_SAMPLE: solo ${directCount}/${lineupSizeAnalyzed} bateadores con datos directos.`);
  }
  const reason = reasonParts.length > 0 ? reasonParts.join(" \u00b7 ") : undefined;

  let signal = "";
  const qualityNote = directCount >= 6 ? "" : proxyCount > 0 ? ` · ${directCount} directos + ${proxyCount} proxy equipo` : ` · ${directCount} directos`;
  if (expectedTeamRunsDelta <= -0.4) signal = `🔥 Lineup DOMINADO por arsenal de ${pitcherName} (${expectedTeamRunsDelta.toFixed(2)} runs vs liga)${qualityNote}`;
  else if (expectedTeamRunsDelta <= -0.15) signal = `Lineup en desventaja vs este pitcher (${expectedTeamRunsDelta.toFixed(2)} runs)${qualityNote}`;
  else if (expectedTeamRunsDelta >= 0.4) signal = `💥 Lineup CASTIGA arsenal de ${pitcherName} (+${expectedTeamRunsDelta.toFixed(2)} runs vs liga)${qualityNote}`;
  else if (expectedTeamRunsDelta >= 0.15) signal = `Lineup en ventaja vs este pitcher (+${expectedTeamRunsDelta.toFixed(2)} runs)${qualityNote}`;
  else signal = `Matchup neutral pitch-by-pitch${qualityNote}`;

  return {
    pitcherId, pitcherName,
    arsenal: arsenal.pitches,
    lineupSize: lineup.length,
    battersAnalyzed: countAnalyzed,
    averageExpectedXwoba: Math.round(averageExpectedXwoba * 1000) / 1000,
    expectedTeamRunsDelta,
    topVulnerabilities,
    topStrengths,
    perBatter,
    signal,
    dataConfidence,
    directCount,
    proxyCount,
    lineupSource,
    reason,
  };
}

// ─── BATTER VS TEAM HISTORICAL ──────────────────────────────────────────────
// Cómo le pega cada bateador del lineup al equipo rival (cualquier pitcher) últimos 2 años
interface BatterVsTeamRow {
  batterId: number;
  batterName: string;
  pa: number;
  ba: number;
  ops: number;
  hr: number;
  rbi: number;
  vsTeam: string;
}

const batterVsTeamCache: Record<string, { ts: number; data: BatterVsTeamRow[] }> = {};

export async function getLineupVsTeamHistory(
  gamePk: number,
  lineupTeamId: number,
  oppTeamAbbrev: string, // "NYY", "TOR", etc
  season: number = new Date().getFullYear(),
): Promise<{ rows: BatterVsTeamRow[]; teamOpsVsOpp: number; signal: string }> {
  const lineupRes = await getConfirmedLineup(gamePk, lineupTeamId);
  const lineup = lineupRes.players;
  if (!lineup || lineup.length === 0) return { rows: [], teamOpsVsOpp: 0.720, signal: "Sin lineup disponible" };

  // Para cada bateador del lineup, traer su rendimiento últimos 2 años vs ese equipo
  // Usamos MLB stats API: people/{id}/stats?stats=vsTeam5Y
  const rows: BatterVsTeamRow[] = [];
  for (const b of lineup) {
    const cacheKey = `${b.id}_${oppTeamAbbrev}_${season}`;
    if (batterVsTeamCache[cacheKey] && Date.now() - batterVsTeamCache[cacheKey].ts < CACHE_TTL) {
      rows.push(...batterVsTeamCache[cacheKey].data);
      continue;
    }
    try {
      const url = `https://statsapi.mlb.com/api/v1/people/${b.id}/stats?stats=vsTeam&group=hitting&season=${season}&sportId=1&opposingTeamId=${oppTeamAbbrev}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const d: any = await r.json();
      const split = d?.stats?.[0]?.splits?.[0];
      if (!split?.stat) continue;
      const row: BatterVsTeamRow = {
        batterId: b.id,
        batterName: b.fullName,
        pa: parseInt(split.stat.plateAppearances) || 0,
        ba: parseFloat(split.stat.avg) || 0,
        ops: parseFloat(split.stat.ops) || 0,
        hr: parseInt(split.stat.homeRuns) || 0,
        rbi: parseInt(split.stat.rbi) || 0,
        vsTeam: oppTeamAbbrev,
      };
      if (row.pa >= 5) rows.push(row);
      batterVsTeamCache[cacheKey] = { ts: Date.now(), data: row.pa >= 5 ? [row] : [] };
    } catch {}
  }

  const totalPa = rows.reduce((s, r) => s + r.pa, 0);
  const teamOpsVsOpp = totalPa > 0 ? rows.reduce((s, r) => s + r.ops * r.pa, 0) / totalPa : 0.720;
  let signal = "";
  if (teamOpsVsOpp >= 0.800) signal = `Lineup CALIENTE vs este equipo (OPS ${teamOpsVsOpp.toFixed(3)} en ${totalPa} PA)`;
  else if (teamOpsVsOpp <= 0.640) signal = `Lineup FRÍO vs este equipo (OPS ${teamOpsVsOpp.toFixed(3)} en ${totalPa} PA)`;
  else if (totalPa < 30) signal = `Muestra limitada (${totalPa} PA combinados)`;
  else signal = `Lineup neutral vs este equipo (OPS ${teamOpsVsOpp.toFixed(3)})`;

  return { rows, teamOpsVsOpp: Math.round(teamOpsVsOpp * 1000) / 1000, signal };
}

// ─── COMBINED ENDPOINT (las 2 cosas en una llamada) ────────────────────────
export async function getStatcastMatchupCombined(
  gamePk: number,
  homeTeamId: number,
  awayTeamId: number,
  homePitcherId: number, homePitcherName: string,
  awayPitcherId: number, awayPitcherName: string,
  homeTeamAbbrev: string, awayTeamAbbrev: string,
  season: number = new Date().getFullYear(),
) {
  // Lineup local enfrenta SP visitante; lineup visitante enfrenta SP local
  // 1. SP titular matchup + historic
  const [homeLineupVsAwaySP, awayLineupVsHomeSP, homeLineupVsAwayTeam, awayLineupVsHomeTeam, awayBullpen, homeBullpen] = await Promise.all([
    awayPitcherId ? getLineupVsPitcherMatchup(gamePk, awayPitcherId, awayPitcherName, homeTeamId, season, homeTeamAbbrev) : Promise.resolve(null),
    homePitcherId ? getLineupVsPitcherMatchup(gamePk, homePitcherId, homePitcherName, awayTeamId, season, awayTeamAbbrev) : Promise.resolve(null),
    getLineupVsTeamHistory(gamePk, homeTeamId, awayTeamAbbrev, season),
    getLineupVsTeamHistory(gamePk, awayTeamId, homeTeamAbbrev, season),
    getProjectedBullpen(awayTeamId, season), // bullpen visitante: viene a enfrentar lineup local
    getProjectedBullpen(homeTeamId, season), // bullpen local: viene a enfrentar lineup visitante
  ]);

  // 2. BULLPEN MATCHUP — cada relevista vs el lineup correspondiente
  // Se ejecuta después del SP para no quemar todas las APIs en paralelo
  const homeLineupVsAwayBullpen = await Promise.all(
    awayBullpen.map(async (rp) => {
      const m = await getLineupVsPitcherMatchup(gamePk, rp.pitcherId, rp.pitcherName, homeTeamId, season, homeTeamAbbrev);
      return { pitcherId: rp.pitcherId, pitcherName: rp.pitcherName, role: rp.role, expectedRunsDelta: m?.expectedTeamRunsDelta ?? 0 };
    })
  );
  const awayLineupVsHomeBullpen = await Promise.all(
    homeBullpen.map(async (rp) => {
      const m = await getLineupVsPitcherMatchup(gamePk, rp.pitcherId, rp.pitcherName, awayTeamId, season, awayTeamAbbrev);
      return { pitcherId: rp.pitcherId, pitcherName: rp.pitcherName, role: rp.role, expectedRunsDelta: m?.expectedTeamRunsDelta ?? 0 };
    })
  );

  // Pegar bullpen al resultado del SP titular
  if (homeLineupVsAwaySP) homeLineupVsAwaySP.bullpenMatchup = homeLineupVsAwayBullpen;
  if (awayLineupVsHomeSP) awayLineupVsHomeSP.bullpenMatchup = awayLineupVsHomeBullpen;

  // Net runs delta para cada equipo
  // Mix:
  //   - 50% SP titular (los primeros 5-6 IP son del SP)
  //   - 25% bullpen (últimos 3-4 IP)
  //   - 25% historic vs equipo (contexto largo plazo)
  const homeBullpenAvg = homeLineupVsAwayBullpen.length > 0
    ? homeLineupVsAwayBullpen.reduce((s, b) => s + b.expectedRunsDelta, 0) / homeLineupVsAwayBullpen.length
    : 0;
  const awayBullpenAvg = awayLineupVsHomeBullpen.length > 0
    ? awayLineupVsHomeBullpen.reduce((s, b) => s + b.expectedRunsDelta, 0) / awayLineupVsHomeBullpen.length
    : 0;
  const homeRunsDelta = (homeLineupVsAwaySP?.expectedTeamRunsDelta ?? 0) * 0.50 +
                        homeBullpenAvg * 0.25 +
                        ((homeLineupVsAwayTeam.teamOpsVsOpp - 0.720) * 4) * 0.25;
  const awayRunsDelta = (awayLineupVsHomeSP?.expectedTeamRunsDelta ?? 0) * 0.50 +
                        awayBullpenAvg * 0.25 +
                        ((awayLineupVsHomeTeam.teamOpsVsOpp - 0.720) * 4) * 0.25;

  return {
    homeLineupVsAwaySP, awayLineupVsHomeSP,
    homeLineupVsAwayTeam, awayLineupVsHomeTeam,
    homeRunsDelta: Math.round(homeRunsDelta * 100) / 100,
    awayRunsDelta: Math.round(awayRunsDelta * 100) / 100,
  };
}
