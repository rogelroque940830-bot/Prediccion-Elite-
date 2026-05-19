import type { Express } from "express";
import type { Server } from "http";
import fs from "fs";
import path from "path";
import {
  getNBARefImpact,
  getMLBUmpireImpact,
  type NBARefImpact,
  type MLBUmpireImpact,
} from "./referee-data";
import {
  getParkFactor,
  computeWeatherImpact,
  analyzeOpener,
} from "./mlb-advanced";
import {
  recordSnapshot,
  getAllSnapshots,
  getHistoryForGame,
  getAllGameKeys,
  analyzeLineMovement,
  detectSteamMoves,
  detectReverseLineMovement,
  computeCLV,
  type LineSnapshot,
} from "./sharp-signals";
import { computeContextual } from "./nba-contextual";
import { computeMLBContextual } from "./mlb-contextual";

// ── NBA Stats API Headers ────────────────────────────────────────────────────
const NBA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.nba.com/",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Origin": "https://www.nba.com",
  "Connection": "keep-alive",
};

const SEASON = "2025-26";

// ── In-memory cache (30 min TTL) ─────────────────────────────────────────────
const cache: Record<string, { data: unknown; ts: number }> = {};
const TTL = 30 * 60 * 1000;

async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < TTL) {
    return cache[key].data as T;
  }
  const data = await fn();
  cache[key] = { data, ts: now };
  return data;
}

async function nbaFetch(url: string) {
  const res = await fetch(url, { headers: NBA_HEADERS });
  if (!res.ok) throw new Error(`NBA API ${res.status}: ${url}`);
  return res.json();
}

function idx(headers: string[], name: string) {
  return headers.indexOf(name);
}

// ── Helper: today's date in Florida timezone (America/New_York) ─────────────
const FL_TZ = "America/New_York";

// Returns { y, m, d } for today (or offset days) in Florida timezone
function floridaParts(offsetDays = 0): { y: string; m: string; d: string } {
  const now = new Date();
  if (offsetDays) now.setUTCDate(now.getUTCDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: FL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return { y: parts.year, m: parts.month, d: parts.day };
}

// NBA format MM/DD/YYYY in Florida timezone
// NBA Stats API ahora requiere formato ISO YYYY-MM-DD (cambio de la API — antes aceptaba MM/DD/YYYY)
function todayNBA(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

// ISO format YYYY-MM-DD in Florida timezone (NHL/MLB)
function todayISO(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

// Convert ISO YYYY-MM-DD → NBA format
// NBA Stats API ahora acepta ISO directamente. Mantenemos la función por compatibilidad.
function isoToNBA(iso: string): string {
  return iso;
}

// Convert NBA MM/DD/YYYY → ISO YYYY-MM-DD
function nbaToISO(nba: string): string {
  const m = nba.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return nba;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// URL del propio servicio (para sub-fetches internos)
// En Railway el puerto cambia (8080), por eso usamos process.env.PORT.
const SELF_URL = `http://localhost:${process.env.PORT || 5000}`;

// ── Picks history storage (file-based, persists until next Railway redeploy) ──
interface SavedPick {
  id: string;
  ts: number;
  sport: "mlb" | "nba" | "nhl" | "wnba";
  homeTeam: string;
  awayTeam: string;
  pickType: string;          // "ML", "Spread", "O/U", "Player Prop"
  pickSide: string;          // "Home", "Away", "Over", "Under", or specific
  confidence: number;        // 0–100 (BET threshold 70%)
  edge?: number;             // edge porcentual si lo hay
  odds?: string;             // odds americanas "+150", "-110"
  line?: string;             // "-5.5", "O 8.5"
  notes?: string;            // texto libre opcional
}

const PICKS_FILE = path.join(process.cwd(), "data", "picks.json");

function loadPicks(): SavedPick[] {
  try {
    if (!fs.existsSync(PICKS_FILE)) return [];
    const raw = fs.readFileSync(PICKS_FILE, "utf-8");
    return JSON.parse(raw) as SavedPick[];
  } catch (e) {
    console.error("loadPicks error:", e);
    return [];
  }
}

function savePicks(picks: SavedPick[]): void {
  try {
    const dir = path.dirname(PICKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2), "utf-8");
  } catch (e) {
    console.error("savePicks error:", e);
  }
}

export function registerRoutes(httpServer: Server, app: Express): void {

  // ── Picks history endpoints ──────────────────────────────────
  // POST /api/picks  body: SavedPick (sin id, sin ts)
  app.post("/api/picks", async (req, res) => {
    try {
      const body = req.body as Omit<SavedPick, "id" | "ts">;
      if (!body || !body.sport || !body.homeTeam || !body.awayTeam || !body.pickType || !body.pickSide || typeof body.confidence !== "number") {
        return res.status(400).json({ success: false, error: "Faltan campos obligatorios" });
      }
      const picks = loadPicks();
      const pick: SavedPick = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        ...body,
      };
      picks.push(pick);
      savePicks(picks);
      res.json({ success: true, data: pick });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // GET /api/picks?sport=mlb&days=7&minConfidence=70
  app.get("/api/picks", async (req, res) => {
    try {
      const sport = (req.query.sport as string | undefined)?.toLowerCase();
      const days = parseInt((req.query.days as string) || "30", 10);
      const minConf = parseFloat((req.query.minConfidence as string) || "0");
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      let picks = loadPicks().filter((p) => p.ts >= cutoff && p.confidence >= minConf);
      if (sport) picks = picks.filter((p) => p.sport === sport);
      picks.sort((a, b) => b.confidence - a.confidence);
      res.json({ success: true, data: picks, count: picks.length });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // DELETE /api/picks/:id
  app.delete("/api/picks/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const picks = loadPicks();
      const filtered = picks.filter((p) => p.id !== id);
      if (filtered.length === picks.length) {
        return res.status(404).json({ success: false, error: "No encontrado" });
      }
      savePicks(filtered);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // ── GET /api/nba/teams ───────────────────────────────────────────────────
  // Returns BLENDED advanced stats: 60% season + 40% L10 for ratings
  // Also returns raw season + L10 separately for transparency
  app.get("/api/nba/teams", async (req, res) => {
    try {
      const data = await withCache("teams-advanced-blended", async () => {
        const [seasonJson, l10Json] = await Promise.all([
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=10&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
        ]);
        const sH: string[] = seasonJson.resultSets[0].headers;
        const sR: unknown[][] = seasonJson.resultSets[0].rowSet;
        const lH: string[] = l10Json.resultSets[0].headers;
        const lR: unknown[][] = l10Json.resultSets[0].rowSet;
        
        // Build L10 map by teamId
        const l10Map: Record<number, any> = {};
        for (const row of lR) {
          l10Map[row[idx(lH, "TEAM_ID")] as number] = {
            netRtg: row[idx(lH, "NET_RATING")] as number,
            offRtg: row[idx(lH, "OFF_RATING")] as number,
            defRtg: row[idx(lH, "DEF_RATING")] as number,
            pace:   row[idx(lH, "PACE")] as number,
          };
        }
        
        // Blend: 60% season + 40% L10 for a balanced view
        return sR.map((row) => {
          const tid = row[idx(sH, "TEAM_ID")] as number;
          const sOff = row[idx(sH, "OFF_RATING")] as number;
          const sDef = row[idx(sH, "DEF_RATING")] as number;
          const sNet = row[idx(sH, "NET_RATING")] as number;
          const sPace = row[idx(sH, "PACE")] as number;
          const l = l10Map[tid];
          
          // Blend 60% season + 40% L10
          const offRtg = l ? Math.round((sOff * 0.6 + l.offRtg * 0.4) * 10) / 10 : sOff;
          const defRtg = l ? Math.round((sDef * 0.6 + l.defRtg * 0.4) * 10) / 10 : sDef;
          const netRtg = Math.round((offRtg - defRtg) * 10) / 10;
          const pace   = l ? Math.round((sPace * 0.6 + l.pace * 0.4) * 10) / 10 : sPace;
          
          return {
            teamId: tid,
            teamName: row[idx(sH, "TEAM_NAME")],
            netRtg,
            offRtg,
            defRtg,
            pace,
            // Raw values for transparency
            seasonNetRtg: sNet,
            
