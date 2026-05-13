// Catcher Framing System (MLB)
// Mide cuánto valor genera el catcher robando strikes en zonas borde
// Las casas casi NO procesan esto al hacer la línea — aquí está nuestro edge

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const SAVANT_BASE = "https://baseballsavant.mlb.com";

export interface CatcherFramingStats {
  id: number;
  name: string;
  pitches: number;
  runValueTotal: number;       // Runs salvados/perdidos vs catcher promedio
  framingPctTotal: number;     // % strikes en zonas shadow
  // Calidad
  tier: "ELITE" | "GOOD" | "AVERAGE" | "POOR" | "TERRIBLE";
  eraImpact: number;           // ERA delta esperado vs catcher promedio
}

// Cache global — refrescar 1x por día
let framingCache: { ts: number; byName: Record<string, CatcherFramingStats>; byId: Record<number, CatcherFramingStats> } = {
  ts: 0, byName: {}, byId: {},
};

// Normaliza nombre para hacer match (Savant usa "Apellido, Nombre")
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function reverseName(savantName: string): string {
  // "Bailey, Patrick" -> "Patrick Bailey"
  const parts = savantName.split(",").map(s => s.trim());
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  return savantName;
}

function classifyFramer(rv: number, pitches: number): CatcherFramingStats["tier"] {
  if (pitches < 300) return "AVERAGE";   // muestra muy chica
  if (rv >= 3.0) return "ELITE";
  if (rv >= 1.0) return "GOOD";
  if (rv >= -1.0) return "AVERAGE";
  if (rv >= -2.5) return "POOR";
  return "TERRIBLE";
}

// Conversión RV → ERA impact:
// run value es para toda la temporada. 1 catcher juega ~120 partidos × 9 IP = 1080 IP.
// 1 run salvado = -0.0083 ERA en esa muestra
// Para impacto por start (9 IP): ERA impact = (rv / 1080) * 9
function calcEraImpact(rv: number): number {
  // Aproximación más útil: catcher élite (+5 rv) ahorra ~0.4 ERA vs promedio
  // catcher terrible (-3 rv) suma ~0.25 ERA
  if (rv >= 3.0) return -0.30;
  if (rv >= 1.0) return -0.15;
  if (rv >= -1.0) return 0;
  if (rv >= -2.5) return 0.20;
  return 0.35;
}

async function loadFramingData(season: string = "2025"): Promise<void> {
  if (Date.now() - framingCache.ts < 24 * 3600 * 1000 && Object.keys(framingCache.byId).length > 0) {
    return;
  }
  try {
    const url = `${SAVANT_BASE}/leaderboard/catcher-framing?year=${season}&min=q&team=&csv=true`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return;
    const csv = await r.text();
    const lines = csv.split("\n").filter(l => l.trim());
    if (lines.length < 2) return;
    const headers = lines[0].split(",").map(h => h.replace(/^["\ufeff]+|"$/g, ""));
    const idxId = headers.findIndex(h => h === "id");
    const idxName = headers.findIndex(h => h === "name");
    const idxPitches = headers.findIndex(h => h === "pitches");
    const idxRvTot = headers.findIndex(h => h === "rv_tot");
    const idxPctTot = headers.findIndex(h => h === "pct_tot");

    const byName: Record<string, CatcherFramingStats> = {};
    const byId: Record<number, CatcherFramingStats> = {};

    for (let i = 1; i < lines.length; i++) {
      // CSV parser básico que respeta comillas
      const row = parseCSVLine(lines[i]);
      if (row.length < headers.length) continue;
      const id = parseInt(row[idxId]) || 0;
      const savantName = row[idxName] ?? "";
      const name = reverseName(savantName);
      const pitches = parseInt(row[idxPitches]) || 0;
      const rvTot = parseFloat(row[idxRvTot]) || 0;
      const pctTot = parseFloat(row[idxPctTot]) || 0;

      const stats: CatcherFramingStats = {
        id, name, pitches,
        runValueTotal: Math.round(rvTot * 100) / 100,
        framingPctTotal: Math.round(pctTot * 1000) / 1000,
        tier: classifyFramer(rvTot, pitches),
        eraImpact: calcEraImpact(rvTot),
      };
      byId[id] = stats;
      byName[normalizeName(name)] = stats;
    }
    framingCache = { ts: Date.now(), byName, byId };
    console.log(`[Catcher Framing] Loaded ${Object.keys(byId).length} catchers for ${season}`);
  } catch (e) {
    console.error("Failed to load framing data:", e);
  }
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result.map(s => s.replace(/^["\ufeff]+|"$/g, "").trim());
}

export async function getFramingForCatcher(catcherId: number, catcherName: string): Promise<CatcherFramingStats | null> {
  await loadFramingData();
  if (framingCache.byId[catcherId]) return framingCache.byId[catcherId];
  // Fallback por nombre
  const found = framingCache.byName[normalizeName(catcherName)];
  if (found) return found;
  return null;
}

// Cache de probable catcher por equipo/fecha
const probableCatcherCache: Record<string, { ts: number; catcherId: number; catcherName: string; source: string }> = {};

// Busca el catcher de hoy con prioridad:
// 1. Lineup CONFIRMADO del juego (gamePk) → catcher real anunciado por el equipo
// 2. Roster activo + AB season (fallback cuando lineup aún no está confirmado)
async function getProbableCatcher(teamId: number, gamePk?: number): Promise<{ id: number; name: string; source: string } | null> {
  const cacheKey = `${teamId}::${gamePk ?? "none"}`;
  const cached = probableCatcherCache[cacheKey];
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
    return { id: cached.catcherId, name: cached.catcherName, source: cached.source };
  }

  // 1. INTENTAR LINEUP CONFIRMADO PRIMERO (la fuente más confiable)
  if (gamePk) {
    try {
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=lineups,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (game) {
        const isHome = game.teams?.home?.team?.id === teamId;
        const lineupKey = isHome ? "homePlayers" : "awayPlayers";
        const lineup: any[] = game.lineups?.[lineupKey] ?? [];
        if (lineup.length >= 8) {
          // Buscar catcher en el lineup confirmado
          const catcher = lineup.find((p: any) => p.primaryPosition?.abbreviation === "C" || p.primaryPosition?.code === "2");
          if (catcher?.id) {
            const result = { id: catcher.id, name: catcher.fullName, source: "lineup_confirmado" };
            probableCatcherCache[cacheKey] = { ts: Date.now(), catcherId: catcher.id, catcherName: catcher.fullName, source: "lineup_confirmado" };
            return result;
          }
        }
      }
    } catch {}
  }

  // 2. FALLBACK: roster activo + AB season
  try {
    const r: any = await (await fetch(`${MLB_BASE}/teams/${teamId}/roster?rosterType=Active`)).json();
    const catchers = (r.roster ?? []).filter((p: any) => p.position?.code === "2");
    if (catchers.length === 0) return null;
    const withStats = await Promise.all(catchers.map(async (c: any) => {
      try {
        const sJ: any = await (await fetch(`${MLB_BASE}/people/${c.person.id}/stats?stats=season&group=hitting&season=2026`)).json();
        let st = sJ.stats?.[0]?.splits?.[0]?.stat;
        if (!st || !st.atBats) {
          const sJ25: any = await (await fetch(`${MLB_BASE}/people/${c.person.id}/stats?stats=season&group=hitting&season=2025`)).json();
          st = sJ25.stats?.[0]?.splits?.[0]?.stat;
        }
        return { id: c.person.id, name: c.person.fullName, ab: parseInt(st?.atBats ?? "0") || 0 };
      } catch {
        return { id: c.person.id, name: c.person.fullName, ab: 0 };
      }
    }));
    withStats.sort((a, b) => b.ab - a.ab);
    const starter = withStats[0];
    if (!starter) return null;
    probableCatcherCache[cacheKey] = { ts: Date.now(), catcherId: starter.id, catcherName: starter.name, source: "roster_proyectado" };
    return { id: starter.id, name: starter.name, source: "roster_proyectado" };
  } catch {
    return null;
  }
}

export interface CatcherFramingMatchup {
  homeCatcher: { id: number; name: string; source: string; framing: CatcherFramingStats | null } | null;
  awayCatcher: { id: number; name: string; source: string; framing: CatcherFramingStats | null } | null;
  // Aplicado al SP rival (catcher home afecta al SP visitante? NO — afecta a SU PROPIO SP)
  homeEraImpact: number;  // ERA impact del catcher home sobre el SP local
  awayEraImpact: number;  // ERA impact del catcher away sobre el SP visitante
  bothLineupsConfirmed: boolean;
  signal: string;
}

export async function analyzeCatcherFramingMatchup(
  homeTeamId: number,
  awayTeamId: number,
  gamePk?: number,
): Promise<CatcherFramingMatchup> {
  const [homeCatcherInfo, awayCatcherInfo] = await Promise.all([
    getProbableCatcher(homeTeamId, gamePk),
    getProbableCatcher(awayTeamId, gamePk),
  ]);
  const bothLineupsConfirmed =
    homeCatcherInfo?.source === "lineup_confirmado" &&
    awayCatcherInfo?.source === "lineup_confirmado";

  const [homeFraming, awayFraming] = await Promise.all([
    homeCatcherInfo ? getFramingForCatcher(homeCatcherInfo.id, homeCatcherInfo.name) : Promise.resolve(null),
    awayCatcherInfo ? getFramingForCatcher(awayCatcherInfo.id, awayCatcherInfo.name) : Promise.resolve(null),
  ]);

  // Catcher local frame para el SP local. Si es élite, SP local mejora ERA.
  const homeEraImpact = homeFraming?.eraImpact ?? 0;
  const awayEraImpact = awayFraming?.eraImpact ?? 0;

  // Construir signal explicativo
  const parts: string[] = [];
  if (homeFraming) {
    if (homeFraming.tier === "ELITE") {
      parts.push(`⭐ ${homeFraming.name} (Local) framing élite: +${(-homeEraImpact).toFixed(2)} ERA al SP local`);
    } else if (homeFraming.tier === "TERRIBLE" || homeFraming.tier === "POOR") {
      parts.push(`🚨 ${homeFraming.name} (Local) framing pobre: +${homeEraImpact.toFixed(2)} ERA al SP local`);
    }
  }
  if (awayFraming) {
    if (awayFraming.tier === "ELITE") {
      parts.push(`⭐ ${awayFraming.name} (Visitante) framing élite: +${(-awayEraImpact).toFixed(2)} ERA al SP visitante`);
    } else if (awayFraming.tier === "TERRIBLE" || awayFraming.tier === "POOR") {
      parts.push(`🚨 ${awayFraming.name} (Visitante) framing pobre: +${awayEraImpact.toFixed(2)} ERA al SP visitante`);
    }
  }
  const signal = parts.length > 0 ? parts.join(" · ") : "Catchers con framing promedio en ambos equipos";

  return {
    homeCatcher: homeCatcherInfo ? { ...homeCatcherInfo, framing: homeFraming } : null,
    awayCatcher: awayCatcherInfo ? { ...awayCatcherInfo, framing: awayFraming } : null,
    homeEraImpact,
    awayEraImpact,
    bothLineupsConfirmed,
    signal,
  };
}
