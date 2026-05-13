// WNBA Injuries auto-fill desde ESPN
// Scraping del payload __espnfitt__ embedded en https://www.espn.com/wnba/injuries
// Devuelve listado por equipo con tier de severidad + fecha + decay por tiempo fuera.

const CACHE_TTL = 30 * 60 * 1000; // 30 minutos
let cache: { ts: number; data: TeamInjuryReport[] } | null = null;

export interface InjuredPlayer {
  name: string;
  position: string;
  statusCode: string;           // "INJURY_STATUS_OUT" | "INJURY_STATUS_DAYTODAY" | ...
  statusDesc: string;           // "Out" | "Day-To-Day" | "Questionable" | etc.
  severityTier: "OUT" | "DOUBTFUL" | "QUESTIONABLE" | "DAY_TO_DAY" | "PROBABLE";
  description: string;
  dateReported: string;         // "May 13"
  daysOut: number;              // calculado contra hoy
  decayFactor: number;          // 1.0 día 1-3, 0.8 día 4-10, 0.6 día 11-30, 0.4 >30
}

export interface TeamInjuryReport {
  teamName: string;
  teamAbbreviation: string;
  espnTeamId: number | null;
  injuries: InjuredPlayer[];
}

function severityFromStatus(code: string, desc: string): InjuredPlayer["severityTier"] {
  const c = code.toUpperCase();
  if (c.includes("OUT") && !c.includes("DAY")) return "OUT";
  if (c.includes("DOUBTFUL")) return "DOUBTFUL";
  if (c.includes("QUESTIONABLE")) return "QUESTIONABLE";
  if (c.includes("DAYTODAY") || desc.toLowerCase().includes("day-to-day")) return "DAY_TO_DAY";
  if (c.includes("PROBABLE")) return "PROBABLE";
  return "DAY_TO_DAY";
}

function parseDateReported(dateStr: string): Date {
  // ESPN devuelve "May 13" sin año. Asumir año actual; si la fecha futuro >30d, asumir año anterior.
  const now = new Date();
  const yr = now.getFullYear();
  const parsed = new Date(`${dateStr} ${yr}`);
  if (isNaN(parsed.getTime())) return now;
  const diffDays = (parsed.getTime() - now.getTime()) / (24 * 3600 * 1000);
  if (diffDays > 30) parsed.setFullYear(yr - 1);
  return parsed;
}

function daysOutSince(reportedDate: Date): number {
  const now = new Date();
  const ms = now.getTime() - reportedDate.getTime();
  return Math.max(0, Math.floor(ms / (24 * 3600 * 1000)));
}

function decayForDays(days: number): number {
  if (days <= 3) return 1.00;     // shock fase: 100% impacto
  if (days <= 10) return 0.80;    // adaptación inicial
  if (days <= 30) return 0.60;    // adaptación clara
  return 0.40;                    // nueva normalidad
}

export async function fetchWNBAInjuries(): Promise<TeamInjuryReport[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;

  try {
    const res = await fetch("https://www.espn.com/wnba/injuries", {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0" },
    });
    if (!res.ok) throw new Error(`ESPN injuries ${res.status}`);
    const html = await res.text();

    // Extract __espnfitt__ payload — buscamos solo por la clave única "__espnfitt__"
    // y luego avanzamos al primer { (más robusto vs minificación y variantes de comillas).
    const marker = "__espnfitt__";
    const startIdx = html.indexOf(marker);
    if (startIdx === -1) throw new Error("ESPN payload marker not found");
    // Avanzar hasta el primer { tras el marker
    let i = startIdx + marker.length;
    while (i < html.length && html[i] !== "{") i++;
    if (i >= html.length) throw new Error("ESPN payload start { not found");
    // Contar llaves para encontrar el fin del objeto JSON
    let depth = 0;
    let inStr = false;
    let esc = false;
    const start = i;
    for (; i < html.length; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    const jsonText = html.slice(start, i);
    const payload = JSON.parse(jsonText);
    const teamsInj = payload?.page?.content?.injuries;
    if (!Array.isArray(teamsInj)) throw new Error("injuries key missing");

    const result: TeamInjuryReport[] = [];
    for (const t of teamsInj) {
      const items = t.items ?? [];
      const injuries: InjuredPlayer[] = [];
      for (const it of items) {
        const athlete = it.athlete ?? {};
        const type = it.type ?? {};
        const desc = it.description ?? "";
        const dateStr = it.date ?? "";
        const reportedDate = parseDateReported(dateStr);
        const days = daysOutSince(reportedDate);
        injuries.push({
          name: athlete.name ?? athlete.shortName ?? "Unknown",
          position: athlete.position ?? "",
          statusCode: type.name ?? type.id ?? "",
          statusDesc: it.statusDesc ?? type.description ?? "",
          severityTier: severityFromStatus(type.name ?? "", it.statusDesc ?? ""),
          description: desc,
          dateReported: dateStr,
          daysOut: days,
          decayFactor: decayForDays(days),
        });
      }
      result.push({
        teamName: t.displayName ?? t.name ?? "Unknown",
        teamAbbreviation: t.abbreviation ?? "",
        espnTeamId: t.id ? parseInt(t.id) : null,
        injuries,
      });
    }

    cache = { ts: Date.now(), data: result };
    return result;
  } catch (e) {
    console.error("[wnba-injuries] fetch failed:", e);
    return cache?.data ?? [];
  }
}

// Helper para mapear nombre de equipo del frontend a las claves ESPN
export function findTeamInjuries(reports: TeamInjuryReport[], teamName: string): TeamInjuryReport | null {
  if (!teamName) return null;
  const norm = teamName.toLowerCase();
  return reports.find(r =>
    r.teamName.toLowerCase() === norm ||
    norm.includes(r.teamName.toLowerCase()) ||
    r.teamName.toLowerCase().includes(norm.split(" ").pop() ?? "")
  ) ?? null;
}
