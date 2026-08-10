import type { Express, Request } from "express";
import fs from "fs";
import path from "path";

type WnbaTeamRow = {
  teamId: number;
  teamName: string;
  netRtg: number;
  offRtg: number;
  defRtg: number;
  pace: number;
  winPct: number;
  ppg: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  recentNetRtg: number;
  recentOffRtg: number;
  recentDefRtg: number;
  recentPace: number;
  recentPpg: number;
  recentWinPct: number;
};

type FatigueRow = {
  teamId: number;
  daysRest: number;
  isB2B: boolean;
  b2bWasRoad: boolean;
  gamesLast7Days: number;
  streak: number;
};

type LocalSnapshot = {
  schemaVersion: 1;
  fetchedAt: string;
  season: number;
  teams: WnbaTeamRow[];
  fatigue: FatigueRow[];
  source: string;
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_FILE = path.join(process.cwd(), "data", "wnba-independent-cache.json");
const BDL_BASE = "https://api.balldontlie.io/wnba/v1";

let memorySnapshot: LocalSnapshot | null = null;
let memoryLoadedAt = 0;

function currentWnbaSeason(): number {
  const now = new Date();
  return now.getUTCFullYear();
}

function numeric(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ensureDataDir(): void {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function validSnapshot(value: any): value is LocalSnapshot {
  return Boolean(
    value &&
    value.schemaVersion === 1 &&
    Array.isArray(value.teams) &&
    value.teams.length >= 10 &&
    Array.isArray(value.fatigue)
  );
}

function loadLocalSnapshot(): LocalSnapshot | null {
  if (memorySnapshot) return memorySnapshot;
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (!validSnapshot(parsed)) return null;
    memorySnapshot = parsed;
    memoryLoadedAt = Date.now();
    return parsed;
  } catch (error) {
    console.error("WNBA independent cache read error", error);
    return null;
  }
}

function saveLocalSnapshot(snapshot: LocalSnapshot): void {
  ensureDataDir();
  const temp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(snapshot, null, 2), "utf8");
  fs.renameSync(temp, CACHE_FILE);
  memorySnapshot = snapshot;
  memoryLoadedAt = Date.now();
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 15_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${url}${body ? ` — ${body.slice(0, 180)}` : ""}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBdlPaged(pathname: string, params: Record<string, string | number>): Promise<any[]> {
  const apiKey = (process.env.BDL_API_KEY || "").trim();
  if (!apiKey) throw new Error("BDL_API_KEY is not configured");

  const rows: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${BDL_BASE}${pathname}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    url.searchParams.set("per_page", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    const payload = await fetchJson(url.toString(), {
      Accept: "application/json",
      Authorization: apiKey,
    });
    const data = Array.isArray(payload?.data) ? payload.data : [];
    rows.push(...data);
    const next = payload?.meta?.next_cursor;
    if (next === undefined || next === null || next === "") break;
    cursor = String(next);
  }
  return rows;
}

function teamIdOf(row: any): number | undefined {
  return numeric(row?.team?.id, row?.team_id, row?.teamId);
}

function teamNameOf(row: any): string {
  return String(row?.team?.full_name || row?.team?.fullName || row?.team_name || row?.teamName || "").trim();
}

function statsObject(row: any): any {
  return row?.stats?.advanced || row?.stats || row || {};
}

function completedGames(rows: any[]): any[] {
  return rows.filter((game) => {
    const home = numeric(game?.home_score, game?.homeTeamScore);
    const away = numeric(game?.away_score, game?.visitor_team_score, game?.awayTeamScore);
    const status = String(game?.status || "").toLowerCase();
    return home !== undefined && away !== undefined && (status === "post" || status === "final" || status.includes("final"));
  });
}

function buildGameContext(gamesInput: any[], teamId: number): {
  gamesPlayed: number;
  wins: number;
  losses: number;
  ppg: number;
  oppPpg: number;
  recentPpg: number;
  recentWinPct: number;
  daysRest?: number;
  isB2B: boolean;
  b2bWasRoad: boolean;
  gamesLast7Days: number;
  streak: number;
} {
  const now = new Date();
  const games = completedGames(gamesInput)
    .filter((game) => numeric(game?.home_team?.id) === teamId || numeric(game?.visitor_team?.id, game?.away_team?.id) === teamId)
    .sort((a, b) => new Date(String(b.date)).getTime() - new Date(String(a.date)).getTime());

  let wins = 0;
  let points = 0;
  let oppPoints = 0;
  const normalized = games.map((game) => {
    const isHome = numeric(game?.home_team?.id) === teamId;
    const scored = numeric(isHome ? game?.home_score : game?.away_score, isHome ? game?.homeTeamScore : game?.visitor_team_score) || 0;
    const allowed = numeric(isHome ? game?.away_score : game?.home_score, isHome ? game?.visitor_team_score : game?.homeTeamScore) || 0;
    const won = scored > allowed;
    if (won) wins += 1;
    points += scored;
    oppPoints += allowed;
    return { date: new Date(String(game.date)), isHome, scored, allowed, won };
  });

  const recent = normalized.slice(0, 10);
  const recentWins = recent.filter((game) => game.won).length;
  const last = normalized[0];
  const previous = normalized[1];
  const daysRest = last ? Math.max(0, Math.floor((now.getTime() - last.date.getTime()) / 86_400_000)) : undefined;
  const isB2B = Boolean(last && previous && Math.floor((last.date.getTime() - previous.date.getTime()) / 86_400_000) <= 1);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
  const gamesLast7Days = normalized.filter((game) => game.date >= sevenDaysAgo).length;

  let streak = 0;
  if (normalized.length > 0) {
    const winning = normalized[0].won;
    for (const game of normalized) {
      if (game.won !== winning) break;
      streak += winning ? 1 : -1;
    }
  }

  return {
    gamesPlayed: normalized.length,
    wins,
    losses: normalized.length - wins,
    ppg: normalized.length ? points / normalized.length : 0,
    oppPpg: normalized.length ? oppPoints / normalized.length : 0,
    recentPpg: recent.length ? recent.reduce((sum, game) => sum + game.scored, 0) / recent.length : 0,
    recentWinPct: recent.length ? recentWins / recent.length : 0.5,
    daysRest,
    isB2B,
    b2bWasRoad: Boolean(isB2B && previous && !previous.isHome),
    gamesLast7Days,
    streak,
  };
}

async function fetchBdlSnapshot(): Promise<LocalSnapshot> {
  const season = currentWnbaSeason();
  const [advancedRows, baseRows, standingsRows, gameRows] = await Promise.all([
    fetchBdlPaged("/team_season_advanced_stats", {
      season,
      season_type: "regular",
      scope: "general",
      measure_type: "advanced",
      per_mode: "per_game",
    }),
    fetchBdlPaged("/team_season_stats", { season, season_type: 2 }),
    fetchBdlPaged("/standings", { season }),
    fetchBdlPaged("/games", { "seasons[]": season, season_type: 2 }),
  ]);

  const advancedById = new Map<number, any>();
  for (const row of advancedRows) {
    const id = teamIdOf(row);
    if (id !== undefined) advancedById.set(id, row);
  }
  const baseById = new Map<number, any>();
  for (const row of baseRows) {
    const id = teamIdOf(row);
    if (id !== undefined) baseById.set(id, row);
  }
  const standingsById = new Map<number, any>();
  for (const row of standingsRows) {
    const id = teamIdOf(row);
    if (id !== undefined) standingsById.set(id, row);
  }

  const teamIds = new Set<number>([...advancedById.keys(), ...baseById.keys(), ...standingsById.keys()]);
  const teams: WnbaTeamRow[] = [];
  const fatigue: FatigueRow[] = [];

  for (const teamId of teamIds) {
    const advancedRow = advancedById.get(teamId) || {};
    const baseRow = baseById.get(teamId) || {};
    const standing = standingsById.get(teamId) || {};
    const advanced = statsObject(advancedRow);
    const base = statsObject(baseRow);
    const context = buildGameContext(gameRows, teamId);
    const teamName = teamNameOf(advancedRow) || teamNameOf(baseRow) || teamNameOf(standing);

    const fga = numeric(base.fga);
    const fta = numeric(base.fta);
    const oreb = numeric(base.oreb);
    const turnovers = numeric(base.turnover, base.turnovers, base.tov);
    const estimatedPace = fga !== undefined && fta !== undefined && oreb !== undefined && turnovers !== undefined
      ? fga + 0.44 * fta - oreb + turnovers
      : undefined;

    const pace = numeric(advanced.pace, advanced.pace_per_game, estimatedPace);
    const offRtg = numeric(advanced.off_rating, advanced.offensive_rating, advanced.off_rtg,
      pace && context.ppg ? (context.ppg / pace) * 100 : undefined);
    const defRtg = numeric(advanced.def_rating, advanced.defensive_rating, advanced.def_rtg,
      pace && context.oppPpg ? (context.oppPpg / pace) * 100 : undefined);
    const netRtg = numeric(advanced.net_rating, advanced.net_rtg,
      offRtg !== undefined && defRtg !== undefined ? offRtg - defRtg : undefined);

    const gamesPlayed = numeric(baseRow.games_played, base.gp, standing.wins !== undefined ? Number(standing.wins) + Number(standing.losses) : undefined, context.gamesPlayed) || 0;
    const wins = numeric(standing.wins, base.w, context.wins) || 0;
    const losses = numeric(standing.losses, base.l, context.losses) || 0;
    const winPct = numeric(standing.win_percentage, standing.win_pct, base.w_pct,
      gamesPlayed > 0 ? wins / gamesPlayed : undefined);
    const ppg = numeric(base.pts, context.ppg);

    if (!teamName || pace === undefined || offRtg === undefined || defRtg === undefined || netRtg === undefined || winPct === undefined || ppg === undefined) {
      continue;
    }

    teams.push({
      teamId,
      teamName,
      netRtg: round(netRtg),
      offRtg: round(offRtg),
      defRtg: round(defRtg),
      pace: round(pace),
      winPct: round(winPct, 2),
      ppg: round(ppg),
      gamesPlayed,
      wins,
      losses,
      recentNetRtg: round(netRtg),
      recentOffRtg: round(offRtg),
      recentDefRtg: round(defRtg),
      recentPace: round(pace),
      recentPpg: round(context.recentPpg || ppg),
      recentWinPct: round(context.recentWinPct, 2),
    });

    fatigue.push({
      teamId,
      daysRest: context.daysRest ?? 0,
      isB2B: context.isB2B,
      b2bWasRoad: context.b2bWasRoad,
      gamesLast7Days: context.gamesLast7Days,
      streak: context.streak,
    });
  }

  if (teams.length < 10) {
    throw new Error(`BALLDONTLIE returned only ${teams.length} complete WNBA teams`);
  }

  return {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    season,
    teams: teams.sort((a, b) => a.teamName.localeCompare(b.teamName)),
    fatigue,
    source: "balldontlie-direct",
  };
}

async function resolveSnapshot(): Promise<{ snapshot: LocalSnapshot; source: string; stale: boolean }> {
  const now = Date.now();
  if (memorySnapshot && now - memoryLoadedAt < CACHE_TTL_MS) {
    const source = memorySnapshot.source === "production-bootstrap-cache"
      ? "integration-local-cache"
      : memorySnapshot.source;
    return { snapshot: memorySnapshot, source, stale: false };
  }

  try {
    const direct = await fetchBdlSnapshot();
    saveLocalSnapshot(direct);
    return { snapshot: direct, source: direct.source, stale: false };
  } catch (directError) {
    console.error("WNBA BALLDONTLIE direct source error", directError);
    const local = loadLocalSnapshot();
    if (local) {
      const ageMs = Math.max(0, now - new Date(local.fetchedAt).getTime());
      return { snapshot: local, source: "integration-local-cache", stale: ageMs > CACHE_TTL_MS };
    }

    throw new Error("WNBA direct source unavailable and integration cache is empty");
  }
}

export function registerIndependentWnbaRoutes(app: Express): void {
  app.get("/api/wnba/all", async (req, res) => {
    try {
      const resolved = await resolveSnapshot();
      return res.json({
        success: true,
        data: resolved.snapshot.teams,
        source: resolved.source,
        stale: resolved.stale,
        fetchedAt: resolved.snapshot.fetchedAt,
      });
    } catch (error) {
      console.error("WNBA independent all error", error);
      return res.status(500).json({ success: false, error: "No se pudieron obtener datos WNBA independientes" });
    }
  });

  app.get("/api/wnba/fatigue", async (req, res) => {
    try {
      const resolved = await resolveSnapshot();
      return res.json({
        success: true,
        data: resolved.snapshot.fatigue,
        source: resolved.source,
        stale: resolved.stale,
        fetchedAt: resolved.snapshot.fetchedAt,
      });
    } catch (error) {
      console.error("WNBA independent fatigue error", error);
      return res.status(500).json({ success: false, error: "No se pudo calcular fatigue WNBA independiente" });
    }
  });

  app.get("/api/wnba/independent-status", async (req, res) => {
    try {
      const resolved = await resolveSnapshot();
      return res.json({
        success: true,
        source: resolved.source,
        stale: resolved.stale,
        fetchedAt: resolved.snapshot.fetchedAt,
        season: resolved.snapshot.season,
        teams: resolved.snapshot.teams.length,
        fatigueTeams: resolved.snapshot.fatigue.length,
        cacheFile: path.basename(CACHE_FILE),
      });
    } catch (error: any) {
      return res.status(500).json({ success: false, error: error?.message || "WNBA independent source unavailable" });
    }
  });
}
