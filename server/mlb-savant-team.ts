// ──────────────────────────────────────────────────────────────────────────
// FUENTE 3: Baseball Savant — team xwOBA REAL (season-to-date)
// Reemplaza el proxy `0.42 * OPS + 0.005` del ERE.
//
// Estrategia:
//   1) Savant `/leaderboard/expected_statistics?type=batter-team` → xwOBA real
//      season-to-date a nivel team (NO split por mano).
//   2) MLB Stats API team OPS vs hand → ratio para ajustar.
//   3) xwOBA_vs_hand ≈ xwOBA_real × (OPS_vs_hand / OPS_season)
//      Esto preserva la base real Statcast y solo modula el split.
// ──────────────────────────────────────────────────────────────────────────

const UA = { "User-Agent": "Mozilla/5.0 (compatible; CourtEdge/1.0)" };

// MLB teamId → Savant team abbr
const TEAM_ABBR: Record<number, string> = {
  108: "LAA", 109: "ARI", 110: "BAL", 111: "BOS", 112: "CHC",
  113: "CIN", 114: "CLE", 115: "COL", 116: "DET", 117: "HOU",
  118: "KC",  119: "LAD", 120: "WSH", 121: "NYM", 133: "ATH",
  134: "PIT", 135: "SD",  136: "SEA", 137: "SF",  138: "STL",
  139: "TB",  140: "TEX", 141: "TOR", 142: "MIN", 143: "PHI",
  144: "ATL", 145: "CWS", 146: "MIA", 147: "NYY", 158: "MIL",
};

export interface SavantTeamXwoba {
  teamId: number;
  abbr: string;
  hand: "R" | "L";
  xwoba: number;          // xwOBA estimado vs esa mano (real-anchored)
  xwobaSeason: number;    // xwOBA season-to-date sin split (Savant directo)
  opsVsHand: number;      // OPS team vs hand (MLB Stats API)
  opsSeason: number;      // OPS team season-to-date (MLB Stats API)
  pa: number;
  season: number;
  source: "savant_team_real" | "savant_only" | "ops_proxy_fallback";
}

const seasonCache: { season: number; data: Map<string, { xwoba: number; pa: number }> | null; ts: number } =
  { season: 0, data: null, ts: 0 };
const SEASON_TTL = 6 * 60 * 60 * 1000; // 6h

const opsCache = new Map<string, { ops: number; pa: number; ts: number }>();
const splitCache = new Map<string, { data: SavantTeamXwoba; ts: number }>();
const SPLIT_TTL = 6 * 60 * 60 * 1000;

function getSeason(): number {
  const m = new Date().getUTCMonth() + 1;
  const y = new Date().getUTCFullYear();
  return m < 3 ? y - 1 : y;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
    else { cur += ch; }
  }
  out.push(cur);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// 1) Savant team-level xwOBA season-to-date (no split por hand)
// ──────────────────────────────────────────────────────────────────────────
async function fetchSavantTeamSeasonMap(): Promise<Map<string, { xwoba: number; pa: number }> | null> {
  const season = getSeason();
  if (seasonCache.season === season && seasonCache.data && Date.now() - seasonCache.ts < SEASON_TTL) {
    return seasonCache.data;
  }
  const url = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter-team&year=${season}&position=&team=&filter=&min=q&csv=true`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const txt = (await r.text()).replace(/^\uFEFF/, "");
    const lines = txt.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return null;
    const hdr = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    // El CSV de Savant team-stats trae "team" como NOMBRE (ej. "Pirates") y
    // "team_id" como ABBR (ej. "PIT"). Preferimos team_id (abbr) para match.
    const iAbbr = hdr.findIndex((h) => h === "team_id");
    const iName = hdr.findIndex((h) => h === "team");
    const iXwoba = hdr.findIndex((h) => h === "est_woba");
    const iPa = hdr.findIndex((h) => h === "pa");
    if ((iAbbr < 0 && iName < 0) || iXwoba < 0) return null;
    const col = iAbbr >= 0 ? iAbbr : iName;
    const map = new Map<string, { xwoba: number; pa: number }>();
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      const abbr = (row[col] || "").replace(/"/g, "").trim().toUpperCase();
      const x = parseFloat(row[iXwoba]);
      const pa = iPa >= 0 ? parseInt(row[iPa]) || 0 : 0;
      if (abbr && isFinite(x) && x > 0) map.set(abbr, { xwoba: x, pa });
    }
    seasonCache.season = season;
    seasonCache.data = map;
    seasonCache.ts = Date.now();
    return map;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 2) MLB Stats API team OPS vs hand (split) y season-to-date (sin split)
// ──────────────────────────────────────────────────────────────────────────
async function fetchTeamOpsSplit(teamId: number, hand: "R" | "L"): Promise<{ ops: number; pa: number } | null> {
  const season = getSeason();
  const key = `${teamId}-${hand}`;
  const c = opsCache.get(key);
  if (c && Date.now() - c.ts < SEASON_TTL) return { ops: c.ops, pa: c.pa };
  try {
    const sit = hand === "R" ? "vr" : "vl";
    const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?season=${season}&stats=statSplits&group=hitting&sitCodes=${sit}`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return null;
    const j: any = await r.json();
    const s = j.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    const ops = parseFloat(s.ops);
    const pa = parseInt(s.plateAppearances) || 0;
    if (!isFinite(ops) || ops <= 0) return null;
    opsCache.set(key, { ops, pa, ts: Date.now() });
    return { ops, pa };
  } catch { return null; }
}

async function fetchTeamOpsSeason(teamId: number): Promise<{ ops: number; pa: number } | null> {
  const season = getSeason();
  const key = `${teamId}-season`;
  const c = opsCache.get(key);
  if (c && Date.now() - c.ts < SEASON_TTL) return { ops: c.ops, pa: c.pa };
  try {
    const url = `https://statsapi.mlb.com/api/v1/teams/${teamId}/stats?season=${season}&stats=season&group=hitting`;
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return null;
    const j: any = await r.json();
    const s = j.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;
    const ops = parseFloat(s.ops);
    const pa = parseInt(s.plateAppearances) || 0;
    if (!isFinite(ops) || ops <= 0) return null;
    opsCache.set(key, { ops, pa, ts: Date.now() });
    return { ops, pa };
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────────
// Recent xwOBA (últimos N días) vía Savant statcast_search agregado por equipo.
// Usado para detectar momentum reciente que el season-wide oculta.
// ──────────────────────────────────────────────────────────────────────────
async function fetchSavantTeamXwobaRecent(abbr: string, hand: "R" | "L", days: number): Promise<{ xwoba: number; pa: number } | null> {
  const today = new Date();
  const past = new Date(today); past.setDate(past.getDate() - days);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  // statcast_search agregando por team: filtramos por team del bateador,
  // mano del pitcher, y rango de fechas
  const url = `https://baseballsavant.mlb.com/statcast_search/csv?` +
    `all=true&hfPT=&hfAB=&hfGT=R%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones=&` +
    `hfPull=&hfC=&hfSit=&player_type=batter&hfOuts=&hfOpponent=&pitcher_throws=${hand}&` +
    `batter_stands=&hfSA=&game_date_gt=${fmt(past)}&game_date_lt=${fmt(today)}&` +
    `hfMo=&hfTeam=${abbr}%7C&home_road=&hfRO=&position=&hfInfield=&hfOutfield=&hfInn=&hfBBT=&` +
    `hfFlag=&metric_1=&group_by=team&min_pitches=0&min_results=0&min_pas=0&` +
    `sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc&type=details`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const csv = await r.text();
    // Aggregamos manualmente: cada fila es un PA, sumar woba_value y woba_denom
    const lines = csv.split(/\r?\n/);
    if (lines.length < 2) return null;
    const hdr = lines[0].split(",").map(h => h.trim().toLowerCase().replace(/"/g, ""));
    const iEstWoba = hdr.indexOf("estimated_woba_using_speedangle");
    const iWobaDenom = hdr.indexOf("woba_denom");
    if (iEstWoba < 0 || iWobaDenom < 0) return null;
    let totalEstWoba = 0, totalDenom = 0, totalPa = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const denom = parseFloat(cols[iWobaDenom]) || 0;
      const est = parseFloat(cols[iEstWoba]);
      if (denom > 0 && isFinite(est)) {
        totalEstWoba += est * denom;
        totalDenom += denom;
        totalPa++;
      }
    }
    if (totalDenom < 30) return null; // sample insuficiente (<30 PA recent)
    return {
      xwoba: Math.round((totalEstWoba / totalDenom) * 1000) / 1000,
      pa: totalPa,
    };
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────────
// Combinador público: xwOBA real-anchored vs hand (CON BLEND RECENT 60/40)
// ──────────────────────────────────────────────────────────────────────────
export async function fetchSavantTeamXwobaVsHand(
  teamId: number,
  hand: "R" | "L"
): Promise<SavantTeamXwoba | null> {
  const abbr = TEAM_ABBR[teamId];
  if (!abbr) return null;
  const cacheKey = `${teamId}-${hand}`;
  const c = splitCache.get(cacheKey);
  if (c && Date.now() - c.ts < SPLIT_TTL) return c.data;

  const [savantMap, opsHand, opsSeason, recent15d] = await Promise.all([
    fetchSavantTeamSeasonMap(),
    fetchTeamOpsSplit(teamId, hand),
    fetchTeamOpsSeason(teamId),
    fetchSavantTeamXwobaRecent(abbr, hand, 15),
  ]);

  const savant = savantMap?.get(abbr) || null;
  if (!savant && !opsHand) return null;

  const season = getSeason();
  let xwoba: number;
  let source: SavantTeamXwoba["source"];

  if (savant && opsHand && opsSeason && opsSeason.ops > 0) {
    // Real-anchored: xwOBA_real × (ops_hand / ops_season). Clipped a ±25% del season.
    const ratio = opsHand.ops / opsSeason.ops;
    const clipped = Math.max(0.75, Math.min(1.25, ratio));
    xwoba = savant.xwoba * clipped;
    source = "savant_team_real";
  } else if (savant) {
    xwoba = savant.xwoba;
    source = "savant_only";
  } else if (opsHand) {
    // Último fallback (mejor que nada): proxy clásico
    xwoba = 0.42 * opsHand.ops + 0.005;
    source = "ops_proxy_fallback";
  } else {
    return null;
  }

  // BLEND con recent 15d (60% recent + 40% season) si sample suficiente (≥30 PA).
  // Capta momentum reciente del equipo bateador vs ese tipo de mano.
  if (recent15d && recent15d.pa >= 30) {
    xwoba = 0.6 * recent15d.xwoba + 0.4 * xwoba;
    xwoba = Math.round(xwoba * 1000) / 1000;
  }

  const result: SavantTeamXwoba = {
    teamId,
    abbr,
    hand,
    xwoba: Math.round(xwoba * 1000) / 1000,
    xwobaSeason: savant ? Math.round(savant.xwoba * 1000) / 1000 : 0,
    opsVsHand: opsHand?.ops ?? 0,
    opsSeason: opsSeason?.ops ?? 0,
    pa: opsHand?.pa ?? savant?.pa ?? 0,
    season,
    source,
  };
  splitCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}
