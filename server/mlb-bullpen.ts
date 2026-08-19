// Bullpen Availability System (MLB)
// Mira los últimos 3 días de bullpen para cada equipo y predice quién está disponible HOY.
// P1-M3F1: la evidencia temporal solo se certifica cuando los inputs críticos
// usados por este mismo cálculo están completos. Los fallos ya no equivalen a []/descanso.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const MLB_BASE_V11 = "https://statsapi.mlb.com/api/v1.1";
const BULLPEN_ROSTER_TTL_MS = 30 * 60 * 1000;
const BULLPEN_SEASON_STATS_TTL_MS = 24 * 60 * 60 * 1000;

export const MLB_BULLPEN_EVIDENCE_SCHEMA = "courtedge-mlb-bullpen-evidence.v1" as const;

export interface BullpenPitcher {
  id: number;
  name: string;
  hand?: "L" | "R";
  saves?: number;
  holds?: number;
  era?: number;
  whip?: number;
  k9?: number;
  daysWorked: { date: string; pitches: number; battersFaced: number; inningsPitched: number }[];
  role: "CLOSER" | "SETUP" | "MIDDLE" | "LONG" | "UNKNOWN";
  availability: "DISPONIBLE" | "RIESGO" | "NO_DISPONIBLE";
  availabilityProb: number;
  reason: string;
  totalPitchesLast3Days: number;
  consecutiveDays: number;
  lastUsed?: string;
}

export interface BullpenEvidenceProvenance {
  schemaVersion: typeof MLB_BULLPEN_EVIDENCE_SCHEMA;
  status: "CERTIFIED";
  generatedAt: string;
  roster: {
    source: "MLB_STATS_ACTIVE_ROSTER";
    pitchersObserved: number;
    cacheMaxAgeSeconds: 1800;
  };
  seasonStats: {
    source: "MLB_STATS_SEASON_WITH_PRIOR_AND_CAREER_FALLBACK";
    pitchersRequested: number;
    pitchersVerified: number;
    roleModelPitchers: number;
    currentSeasonLines: number;
    previousSeasonFallbacks: number;
    careerFallbacks: number;
    noMlbStatLines: number;
    noMlbStatLineDisposition: "EXCLUDE_FROM_ROLE_MODEL";
    cacheMaxAgeSeconds: 86400;
  };
  recentUsage: {
    source: "MLB_STATS_SCHEDULE_AND_FEED_LIVE";
    lookbackDays: 3;
    finalGamesVerified: number;
    boxscoresVerified: number;
  };
  failureDisposition: "THROW_FAIL_CLOSED";
}

export interface BullpenStatus {
  teamId: number;
  teamName: string;
  closer: BullpenPitcher | null;
  setupMen: BullpenPitcher[];
  middleRelievers: BullpenPitcher[];
  closerAvailable: boolean;
  setupAvailable: number;
  bullpenCompromised: boolean;
  predictedCloser: BullpenPitcher | null;
  runsAdjustment: number;
  signal: string;
  sourceStatus: "CERTIFIED";
  generatedAt: string;
  provenance: BullpenEvidenceProvenance;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface BullpenRuntime {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

type SourceResult<T> = {
  data: T;
  cacheHit: boolean;
  cacheAgeSeconds: number;
};

type PitcherStatsSource = "CURRENT_SEASON" | "PREVIOUS_SEASON" | "CAREER" | "NO_MLB_STAT_LINE";
type PitcherStatsResult = SourceResult<any | null> & { source: PitcherStatsSource };

const teamRosterCache: Record<number, { ts: number; data: any[] }> = {};
const seasonStatsCache: Record<number, { ts: number; data: any | null; source: PitcherStatsSource }> = {};

function runtimeNow(runtime: BullpenRuntime): Date {
  return runtime.now ? runtime.now() : new Date();
}

function runtimeFetch(runtime: BullpenRuntime): FetchLike {
  return runtime.fetchImpl ?? ((input, init) => fetch(input, init));
}

async function fetchJson(url: string, runtime: BullpenRuntime): Promise<any> {
  let response: Response;
  try {
    response = await runtimeFetch(runtime)(url, { headers: { accept: "application/json" } });
  } catch (error: any) {
    throw new Error(`BULLPEN_SOURCE_FETCH_FAILED:${url}:${String(error?.message || error || "UNKNOWN")}`);
  }
  if (!response.ok) throw new Error(`BULLPEN_SOURCE_HTTP_${response.status}:${url}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`BULLPEN_SOURCE_INVALID_JSON:${url}`);
  }
}

function parseIP(ip: string | undefined): number {
  if (!ip) return 0;
  const parts = String(ip).split(".");
  return parseInt(parts[0]) + (parseInt(parts[1] || "0") / 3);
}

function dateNDaysAgo(n: number, now: Date): string {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function getBullpenRoster(teamId: number, runtime: BullpenRuntime): Promise<SourceResult<any[]>> {
  const nowMs = runtimeNow(runtime).getTime();
  const cached = teamRosterCache[teamId];
  if (cached && nowMs - cached.ts <= BULLPEN_ROSTER_TTL_MS) {
    return {
      data: cached.data,
      cacheHit: true,
      cacheAgeSeconds: Math.max(0, Math.round((nowMs - cached.ts) / 1000)),
    };
  }

  const url = `${MLB_BASE}/teams/${teamId}/roster?rosterType=Active`;
  const payload = await fetchJson(url, runtime);
  if (!Array.isArray(payload?.roster)) throw new Error(`BULLPEN_ROSTER_SHAPE_INVALID:${teamId}`);
  const pitchers = payload.roster.filter((p: any) => p.position?.code === "1" && Number.isInteger(Number(p.person?.id)));
  if (!pitchers.length) throw new Error(`BULLPEN_ROSTER_EMPTY:${teamId}`);
  teamRosterCache[teamId] = { ts: nowMs, data: pitchers };
  return { data: pitchers, cacheHit: false, cacheAgeSeconds: 0 };
}

async function getPitcherSeasonStats(pitcherId: number, runtime: BullpenRuntime): Promise<PitcherStatsResult> {
  const now = runtimeNow(runtime);
  const nowMs = now.getTime();
  const cached = seasonStatsCache[pitcherId];
  if (cached && nowMs - cached.ts <= BULLPEN_SEASON_STATS_TTL_MS) {
    return {
      data: cached.data,
      source: cached.source,
      cacheHit: true,
      cacheAgeSeconds: Math.max(0, Math.round((nowMs - cached.ts) / 1000)),
    };
  }

  const currentSeason = now.getFullYear();
  const previousSeason = currentSeason - 1;
  const loadSeason = async (season: number) => {
    const payload = await fetchJson(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`, runtime);
    return payload?.stats?.[0]?.splits?.[0]?.stat ?? null;
  };
  const loadCareer = async () => {
    const payload = await fetchJson(`${MLB_BASE}/people/${pitcherId}/stats?stats=career&group=pitching`, runtime);
    return payload?.stats?.[0]?.splits?.[0]?.stat ?? null;
  };

  let stats = await loadSeason(currentSeason);
  let source: PitcherStatsSource = "CURRENT_SEASON";
  if (!stats) {
    stats = await loadSeason(previousSeason);
    source = "PREVIOUS_SEASON";
  }
  if (!stats) {
    stats = await loadCareer();
    source = "CAREER";
  }
  if (!stats) {
    source = "NO_MLB_STAT_LINE";
    stats = null;
  }
  seasonStatsCache[pitcherId] = { ts: nowMs, data: stats, source };
  return { data: stats, source, cacheHit: false, cacheAgeSeconds: 0 };
}

async function getRecentGamePks(
  teamId: number,
  daysBack: number,
  runtime: BullpenRuntime,
): Promise<{ gamePk: number; date: string }[]> {
  const now = runtimeNow(runtime);
  const today = dateNDaysAgo(0, now);
  const start = dateNDaysAgo(daysBack, now);
  const payload = await fetchJson(`${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${today}`, runtime);
  if (!Array.isArray(payload?.dates)) throw new Error(`BULLPEN_RECENT_SCHEDULE_SHAPE_INVALID:${teamId}`);
  const games: { gamePk: number; date: string }[] = [];
  for (const dt of payload.dates) {
    for (const game of (Array.isArray(dt?.games) ? dt.games : [])) {
      if (game.status?.codedGameState === "F" || game.status?.detailedState === "Final") {
        const gamePk = Number(game.gamePk);
        if (!Number.isInteger(gamePk) || gamePk <= 0) throw new Error(`BULLPEN_RECENT_GAME_PK_INVALID:${teamId}`);
        games.push({ gamePk, date: String(dt.date) });
      }
    }
  }
  return games;
}

async function getBoxscorePitchers(
  gamePk: number,
  teamId: number,
  runtime: BullpenRuntime,
): Promise<{ id: number; name: string; pitches: number; bf: number; ip: number }[]> {
  const payload = await fetchJson(`${MLB_BASE_V11}/game/${gamePk}/feed/live`, runtime);
  const boxscore = payload?.liveData?.boxscore;
  if (!boxscore?.teams) throw new Error(`BULLPEN_BOXSCORE_SHAPE_INVALID:${gamePk}`);
  for (const side of ["home", "away"] as const) {
    const team = boxscore.teams?.[side];
    if (team?.team?.id !== teamId) continue;
    const pitcherIds = Array.isArray(team.pitchers) ? team.pitchers : null;
    if (!pitcherIds?.length) throw new Error(`BULLPEN_BOXSCORE_PITCHERS_MISSING:${gamePk}:${teamId}`);
    const players = team.players ?? {};
    return pitcherIds.map((pid: number) => {
      const player = players[`ID${pid}`] ?? {};
      const stats = player.stats?.pitching ?? {};
      return {
        id: pid,
        name: player.person?.fullName ?? "?",
        pitches: parseInt(stats.pitchesThrown ?? "0") || 0,
        bf: parseInt(stats.battersFaced ?? "0") || 0,
        ip: parseIP(stats.inningsPitched),
      };
    });
  }
  throw new Error(`BULLPEN_TEAM_NOT_FOUND_IN_BOXSCORE:${gamePk}:${teamId}`);
}

function determineRole(stats: any): BullpenPitcher["role"] {
  if (!stats) return "UNKNOWN";
  const saves = parseInt(stats.saves ?? "0") || 0;
  const holds = parseInt(stats.holds ?? "0") || 0;
  const games = parseInt(stats.gamesPlayed ?? "0") || 0;
  const ip = parseIP(stats.inningsPitched);
  const ipPerGame = games > 0 ? ip / games : 0;
  if (saves >= 5) return "CLOSER";
  if (holds >= 8 && ipPerGame < 1.3) return "SETUP";
  if (ipPerGame >= 1.5 && games >= 5) return "LONG";
  if (games >= 5) return "MIDDLE";
  return "UNKNOWN";
}

function analyzeAvailability(daysWorked: BullpenPitcher["daysWorked"], now: Date): {
  availability: BullpenPitcher["availability"];
  availabilityProb: number;
  reason: string;
  consecutiveDays: number;
  totalPitchesLast3Days: number;
} {
  const yesterday = dateNDaysAgo(1, now);
  const dayBefore = dateNDaysAgo(2, now);
  const threeDaysAgo = dateNDaysAgo(3, now);
  const yesterdayWork = daysWorked.find((d) => d.date === yesterday);
  const dayBeforeWork = daysWorked.find((d) => d.date === dayBefore);
  const threeDaysAgoWork = daysWorked.find((d) => d.date === threeDaysAgo);
  const totalPitchesLast3Days = (yesterdayWork?.pitches ?? 0) + (dayBeforeWork?.pitches ?? 0) + (threeDaysAgoWork?.pitches ?? 0);

  let consecutive = 0;
  if (yesterdayWork && yesterdayWork.pitches > 0) {
    consecutive = 1;
    if (dayBeforeWork && dayBeforeWork.pitches > 0) {
      consecutive = 2;
      if (threeDaysAgoWork && threeDaysAgoWork.pitches > 0) consecutive = 3;
    }
  }

  if (consecutive >= 3) {
    return {
      availability: "NO_DISPONIBLE",
      availabilityProb: 0.05,
      reason: `Lanzó 3 días seguidos (${threeDaysAgoWork?.pitches ?? 0}p · ${dayBeforeWork?.pitches ?? 0}p · ${yesterdayWork?.pitches ?? 0}p)`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }

  const yesterdayPitches = yesterdayWork?.pitches ?? 0;
  if (yesterdayPitches >= 36) {
    return {
      availability: "NO_DISPONIBLE",
      availabilityProb: 0.15,
      reason: `Lanzó ${yesterdayPitches} pitches ayer (extended outing)`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }
  if (yesterdayPitches >= 26) {
    const probability = consecutive === 2 ? 0.20 : 0.50;
    return {
      availability: probability < 0.40 ? "NO_DISPONIBLE" : "RIESGO",
      availabilityProb: probability,
      reason: `Lanzó ${yesterdayPitches} pitches ayer${consecutive === 2 ? " + back-to-back" : ""}`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }
  if (yesterdayPitches >= 16) {
    const probability = consecutive === 2 ? 0.45 : 0.75;
    return {
      availability: consecutive === 2 ? "RIESGO" : "DISPONIBLE",
      availabilityProb: probability,
      reason: `Lanzó ${yesterdayPitches} pitches ayer${consecutive === 2 ? " + back-to-back" : ""}`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }
  if (yesterdayPitches >= 1) {
    const probability = consecutive === 2 ? 0.60 : 0.90;
    return {
      availability: "DISPONIBLE",
      availabilityProb: probability,
      reason: `Lanzó ${yesterdayPitches} pitches ayer (1 inning ligero)${consecutive === 2 ? " + back-to-back" : ""}`,
      consecutiveDays: consecutive,
      totalPitchesLast3Days,
    };
  }
  return {
    availability: "DISPONIBLE",
    availabilityProb: 0.95,
    reason: "Descansó ayer",
    consecutiveDays: 0,
    totalPitchesLast3Days,
  };
}

export async function getBullpenStatus(
  teamId: number,
  teamName: string,
  runtime: BullpenRuntime = {},
): Promise<BullpenStatus> {
  const rosterResult = await getBullpenRoster(teamId, runtime);
  const roster = rosterResult.data.slice(0, 18);

  const pitcherEntries = await Promise.all(roster.map(async (item: any) => {
    const pitcherId = Number(item.person?.id);
    if (!Number.isInteger(pitcherId) || pitcherId <= 0) throw new Error(`BULLPEN_PITCHER_ID_INVALID:${teamId}`);
    const statsResult = await getPitcherSeasonStats(pitcherId, runtime);
    const stats = statsResult.data;
    if (statsResult.source === "NO_MLB_STAT_LINE") {
      return { pitcher: null, statsSource: statsResult.source };
    }
    const gamesStarted = parseInt(stats?.gamesStarted ?? "0") || 0;
    const inningsPitched = parseIP(stats?.inningsPitched);
    const isStarter = gamesStarted >= 5 && inningsPitched >= 30 && (inningsPitched / Math.max(gamesStarted, 1)) >= 4.5;
    const pitcher = isStarter ? null : {
      id: pitcherId,
      name: item.person?.fullName ?? "?",
      saves: parseInt(stats?.saves ?? "0") || 0,
      holds: parseInt(stats?.holds ?? "0") || 0,
      era: parseFloat(stats?.era) || undefined,
      whip: parseFloat(stats?.whip) || undefined,
      k9: parseFloat(stats?.strikeoutsPer9Inn) || undefined,
      role: determineRole(stats),
      daysWorked: [],
      availability: "DISPONIBLE",
      availabilityProb: 0.95,
      reason: "",
      totalPitchesLast3Days: 0,
      consecutiveDays: 0,
    } as BullpenPitcher;
    return { pitcher, statsSource: statsResult.source };
  }));
  const allPitchers = pitcherEntries
    .map((entry) => entry.pitcher)
    .filter((value): value is BullpenPitcher => value != null);
  if (!allPitchers.length) throw new Error(`BULLPEN_RELIEVERS_EMPTY:${teamId}`);

  const recentGames = await getRecentGamePks(teamId, 3, runtime);
  const usage = await Promise.all(recentGames.map(async (game) => ({
    game,
    pitchers: await getBoxscorePitchers(game.gamePk, teamId, runtime),
  })));
  for (const item of usage) {
    for (const used of item.pitchers) {
      const pitcher = allPitchers.find((candidate) => candidate.id === used.id);
      if (!pitcher) continue;
      pitcher.daysWorked.push({
        date: item.game.date,
        pitches: used.pitches,
        battersFaced: used.bf,
        inningsPitched: used.ip,
      });
    }
  }

  const now = runtimeNow(runtime);
  for (const pitcher of allPitchers) {
    const analysis = analyzeAvailability(pitcher.daysWorked, now);
    pitcher.availability = analysis.availability;
    pitcher.availabilityProb = analysis.availabilityProb;
    pitcher.reason = analysis.reason;
    pitcher.consecutiveDays = analysis.consecutiveDays;
    pitcher.totalPitchesLast3Days = analysis.totalPitchesLast3Days;
    if (pitcher.daysWorked.length > 0) {
      const sorted = [...pitcher.daysWorked].sort((left, right) => right.date.localeCompare(left.date));
      pitcher.lastUsed = sorted[0]?.date;
    }
  }

  const closer = [...allPitchers].sort((left, right) => (right.saves ?? 0) - (left.saves ?? 0))[0] ?? null;
  const setupMen = allPitchers
    .filter((pitcher) => pitcher.id !== closer?.id && pitcher.role === "SETUP")
    .sort((left, right) => (right.holds ?? 0) - (left.holds ?? 0))
    .slice(0, 3);
  const middleRelievers = allPitchers
    .filter((pitcher) => pitcher.id !== closer?.id && !setupMen.includes(pitcher))
    .slice(0, 4);

  const closerAvailable = closer ? closer.availability !== "NO_DISPONIBLE" : false;
  const setupAvailable = setupMen.filter((pitcher) => pitcher.availability !== "NO_DISPONIBLE").length;
  const bullpenCompromised = !closerAvailable && setupAvailable === 0;

  let predictedCloser: BullpenPitcher | null = null;
  if (closer && closer.availability === "DISPONIBLE") {
    predictedCloser = closer;
  } else {
    const candidates = [...setupMen, ...middleRelievers].filter((pitcher) => pitcher.availability === "DISPONIBLE");
    candidates.sort((left, right) => (left.era ?? 5.0) - (right.era ?? 5.0));
    predictedCloser = candidates[0] ?? null;
  }

  let runsAdjustment = 0;
  let signal = "";
  if (bullpenCompromised) {
    runsAdjustment = 0.7;
    signal = "🚨 Bullpen comprometido — top 3 (closer + 2 setup) NO disponibles. Rival anotará más en 7-9.";
  } else if (!closerAvailable && setupAvailable <= 1) {
    runsAdjustment = 0.5;
    signal = `⚠️ Closer NO disponible y solo ${setupAvailable} setup disponible. Cerrará probablemente ${predictedCloser?.name ?? "relevista débil"}.`;
  } else if (!closerAvailable) {
    runsAdjustment = 0.3;
    signal = `⚠️ Closer NO disponible. Cerrará probablemente ${predictedCloser?.name ?? "?"} (setup man).`;
  } else if (closer && closer.availability === "RIESGO") {
    runsAdjustment = 0.15;
    signal = `🔶 Closer disponible pero arriesgado (${closer.reason}). Rendimiento puede caer.`;
  } else {
    signal = `✅ Bullpen completo. ${closer?.name ?? "Closer"} disponible.`;
  }

  const generatedAt = runtimeNow(runtime).toISOString();
  const currentSeasonLines = pitcherEntries.filter((entry) => entry.statsSource === "CURRENT_SEASON").length;
  const previousSeasonFallbacks = pitcherEntries.filter((entry) => entry.statsSource === "PREVIOUS_SEASON").length;
  const careerFallbacks = pitcherEntries.filter((entry) => entry.statsSource === "CAREER").length;
  const noMlbStatLines = pitcherEntries.filter((entry) => entry.statsSource === "NO_MLB_STAT_LINE").length;
  return {
    teamId,
    teamName,
    closer,
    setupMen,
    middleRelievers,
    closerAvailable,
    setupAvailable,
    bullpenCompromised,
    predictedCloser,
    runsAdjustment,
    signal,
    sourceStatus: "CERTIFIED",
    generatedAt,
    provenance: {
      schemaVersion: MLB_BULLPEN_EVIDENCE_SCHEMA,
      status: "CERTIFIED",
      generatedAt,
      roster: {
        source: "MLB_STATS_ACTIVE_ROSTER",
        pitchersObserved: roster.length,
        cacheMaxAgeSeconds: 1800,
      },
      seasonStats: {
        source: "MLB_STATS_SEASON_WITH_PRIOR_AND_CAREER_FALLBACK",
        pitchersRequested: roster.length,
        pitchersVerified: pitcherEntries.length,
        roleModelPitchers: allPitchers.length,
        currentSeasonLines,
        previousSeasonFallbacks,
        careerFallbacks,
        noMlbStatLines,
        noMlbStatLineDisposition: "EXCLUDE_FROM_ROLE_MODEL",
        cacheMaxAgeSeconds: 86400,
      },
      recentUsage: {
        source: "MLB_STATS_SCHEDULE_AND_FEED_LIVE",
        lookbackDays: 3,
        finalGamesVerified: recentGames.length,
        boxscoresVerified: usage.length,
      },
      failureDisposition: "THROW_FAIL_CLOSED",
    },
  };
}

export function resetMlbBullpenCachesForTests(): void {
  for (const key of Object.keys(teamRosterCache)) delete teamRosterCache[Number(key)];
  for (const key of Object.keys(seasonStatsCache)) delete seasonStatsCache[Number(key)];
}