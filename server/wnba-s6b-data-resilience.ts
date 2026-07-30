import {
  NBA_HEADERS,
  WNBA_HEADERS,
  idx,
} from "./route-runtime";

export type FetchLike = typeof fetch;

export interface WnbaScheduleTeam {
  id: number | string;
  name: string;
  tricode: string;
}

export interface WnbaScheduleGame {
  gameId: string;
  gameTimeUTC: string;
  homeTeam: WnbaScheduleTeam;
  awayTeam: WnbaScheduleTeam;
}

export interface WnbaProviderResult<T> {
  data: T;
  source: string;
}

interface ReadonlyFallbackOptions<T> {
  url: string;
  currentHost?: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
  validate: (value: unknown) => value is T;
  label: string;
}

function finiteId(value: unknown): number | string {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : String(value ?? "");
}

function assertIsoDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid WNBA date: ${date}`);
  }
  return date;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWnbaStatsJson(
  url: string,
  fetcher: FetchLike = fetch,
  timeoutMs = 8_000,
): Promise<any> {
  const candidates = url.includes("stats.nba.com")
    ? [
        { url, headers: NBA_HEADERS },
        { url: url.replace("https://stats.nba.com", "https://stats.wnba.com"), headers: WNBA_HEADERS },
      ]
    : [{ url, headers: url.includes("stats.wnba.com") ? WNBA_HEADERS : NBA_HEADERS }];

  const attempts = await Promise.allSettled(
    candidates.map((candidate) => fetchJson(candidate.url, candidate.headers, fetcher, timeoutMs)),
  );
  const success = attempts.find((attempt): attempt is PromiseFulfilledResult<any> => attempt.status === "fulfilled");
  if (success) return success.value;

  const errors = attempts
    .filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")
    .map((attempt) => attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason));
  throw new Error(`WNBA Stats sources unavailable: ${errors.join(" | ")}`);
}

function parseStatsSchedule(payload: any): WnbaScheduleGame[] {
  const games = payload?.scoreboard?.games;
  if (!Array.isArray(games)) throw new Error("WNBA scoreboard payload is invalid");
  return games.map((game: any) => ({
    gameId: String(game?.gameId ?? ""),
    gameTimeUTC: String(game?.gameTimeUTC ?? game?.gameTimeUtc ?? ""),
    homeTeam: {
      id: finiteId(game?.homeTeam?.teamId),
      name: `${game?.homeTeam?.teamCity ?? ""} ${game?.homeTeam?.teamName ?? ""}`.trim(),
      tricode: String(game?.homeTeam?.teamTricode ?? ""),
    },
    awayTeam: {
      id: finiteId(game?.awayTeam?.teamId),
      name: `${game?.awayTeam?.teamCity ?? ""} ${game?.awayTeam?.teamName ?? ""}`.trim(),
      tricode: String(game?.awayTeam?.teamTricode ?? ""),
    },
  })).filter((game: WnbaScheduleGame) => game.gameId && game.homeTeam.name && game.awayTeam.name);
}

export function parseEspnWnbaSchedule(payload: any): WnbaScheduleGame[] {
  const events = payload?.events;
  if (!Array.isArray(events)) throw new Error("ESPN WNBA scoreboard payload is invalid");

  const games: WnbaScheduleGame[] = [];
  for (const event of events) {
    const competition = Array.isArray(event?.competitions) ? event.competitions[0] : null;
    const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
    const home = competitors.find((item: any) => item?.homeAway === "home");
    const away = competitors.find((item: any) => item?.homeAway === "away");
    if (!home?.team || !away?.team) continue;

    games.push({
      gameId: String(event?.id ?? competition?.id ?? ""),
      gameTimeUTC: String(event?.date ?? competition?.date ?? ""),
      homeTeam: {
        id: finiteId(home.team.id),
        name: String(home.team.displayName ?? home.team.shortDisplayName ?? home.team.name ?? ""),
        tricode: String(home.team.abbreviation ?? ""),
      },
      awayTeam: {
        id: finiteId(away.team.id),
        name: String(away.team.displayName ?? away.team.shortDisplayName ?? away.team.name ?? ""),
        tricode: String(away.team.abbreviation ?? ""),
      },
    });
  }
  return games.filter((game) => game.gameId && game.homeTeam.name && game.awayTeam.name);
}

async function fetchEspnSchedule(
  date: string,
  fetcher: FetchLike,
  timeoutMs: number,
): Promise<WnbaScheduleGame[]> {
  const compactDate = assertIsoDate(date).replace(/-/g, "");
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${compactDate}`;
  const payload = await fetchJson(url, {
    Accept: "application/json",
    "User-Agent": NBA_HEADERS["User-Agent"],
  }, fetcher, timeoutMs);
  return parseEspnWnbaSchedule(payload);
}

export async function fetchWnbaScheduleResilient(
  date: string,
  options: { fetcher?: FetchLike; directTimeoutMs?: number; fallbackTimeoutMs?: number } = {},
): Promise<WnbaProviderResult<WnbaScheduleGame[]>> {
  const validDate = assertIsoDate(date);
  const fetcher = options.fetcher ?? fetch;
  let directGames: WnbaScheduleGame[] | null = null;
  let directError: unknown;

  try {
    const encoded = encodeURIComponent(validDate);
    const payload = await fetchWnbaStatsJson(
      `https://stats.nba.com/stats/scoreboardV3?LeagueID=10&gameDate=${encoded}&DayOffset=0`,
      fetcher,
      options.directTimeoutMs ?? 8_000,
    );
    directGames = parseStatsSchedule(payload);
    if (directGames.length > 0) {
      return { data: directGames, source: "wnba-stats-scoreboardV3" };
    }
  } catch (error) {
    directError = error;
  }

  try {
    const fallbackGames = await fetchEspnSchedule(validDate, fetcher, options.fallbackTimeoutMs ?? 8_000);
    if (fallbackGames.length > 0 || directGames == null) {
      return { data: fallbackGames, source: "espn-readonly-fallback" };
    }
  } catch (fallbackError) {
    if (directGames == null) {
      const directMessage = directError instanceof Error ? directError.message : String(directError ?? "unknown direct error");
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`WNBA schedule unavailable: direct=${directMessage}; fallback=${fallbackMessage}`);
    }
  }

  return { data: directGames ?? [], source: "wnba-stats-scoreboardV3" };
}

export async function fetchReadonlyFallback<T>(options: ReadonlyFallbackOptions<T>): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const currentHost = String(options.currentHost ?? "").trim().toLowerCase();
  const parsed = new URL(options.url);
  if (currentHost && parsed.host.toLowerCase() === currentHost) {
    throw new Error(`Refusing recursive ${options.label} fallback`);
  }

  const payload = await fetchJson(options.url, { Accept: "application/json" }, fetcher, options.timeoutMs ?? 10_000);
  if (!payload?.success || !options.validate(payload.data)) {
    throw new Error(`${options.label} fallback returned invalid data`);
  }
  return payload.data;
}

function resultSet(payload: any): { headers: string[]; rows: unknown[][] } {
  const set = payload?.resultSets?.[0];
  if (!set || !Array.isArray(set.headers) || !Array.isArray(set.rowSet)) {
    throw new Error("WNBA Stats result set is invalid");
  }
  return { headers: set.headers, rows: set.rowSet };
}

function requiredIndex(headers: string[], name: string): number {
  const position = idx(headers, name);
  if (position < 0) throw new Error(`WNBA Stats field missing: ${name}`);
  return position;
}

export async function fetchWnbaSosDirect(
  fetcher: FetchLike = fetch,
  timeoutMs = 8_000,
): Promise<any[]> {
  const buildUrl = (lastN: number) =>
    `https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&LastNGames=${lastN}&LeagueID=10&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2026&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
  const [seasonPayload, recentPayload, logPayload] = await Promise.all([
    fetchWnbaStatsJson(buildUrl(0), fetcher, timeoutMs),
    fetchWnbaStatsJson(buildUrl(10), fetcher, timeoutMs),
    fetchWnbaStatsJson("https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=10&PlayerOrTeam=T&Season=2026&SeasonType=Regular+Season&Sorter=DATE", fetcher, timeoutMs),
  ]);

  const season = resultSet(seasonPayload);
  const recent = resultSet(recentPayload);
  const logs = resultSet(logPayload);
  const seasonById: Record<number, { offRtg: number; defRtg: number }> = {};
  const recentById: Record<number, { offRtg: number; defRtg: number }> = {};

  for (const row of season.rows) {
    const teamId = Number(row[requiredIndex(season.headers, "TEAM_ID")]);
    seasonById[teamId] = {
      offRtg: Number(row[requiredIndex(season.headers, "OFF_RATING")]),
      defRtg: Number(row[requiredIndex(season.headers, "DEF_RATING")]),
    };
  }
  for (const row of recent.rows) {
    const teamId = Number(row[requiredIndex(recent.headers, "TEAM_ID")]);
    recentById[teamId] = {
      offRtg: Number(row[requiredIndex(recent.headers, "OFF_RATING")]),
      defRtg: Number(row[requiredIndex(recent.headers, "DEF_RATING")]),
    };
  }

  const teamIdIndex = requiredIndex(logs.headers, "TEAM_ID");
  const abbreviationIndex = requiredIndex(logs.headers, "TEAM_ABBREVIATION");
  const matchupIndex = requiredIndex(logs.headers, "MATCHUP");
  const abbreviationToId: Record<string, number> = {};
  for (const row of logs.rows) {
    const abbreviation = String(row[abbreviationIndex] ?? "");
    const teamId = Number(row[teamIdIndex]);
    if (abbreviation && !abbreviationToId[abbreviation]) abbreviationToId[abbreviation] = teamId;
  }

  const opponentsByTeam: Record<number, string[]> = {};
  for (const row of logs.rows) {
    const teamId = Number(row[teamIdIndex]);
    if (!opponentsByTeam[teamId]) opponentsByTeam[teamId] = [];
    if (opponentsByTeam[teamId].length >= 10) continue;
    const matchup = String(row[matchupIndex] ?? "");
    const parts = matchup.includes("vs.") ? matchup.split(" vs. ") : matchup.split(" @ ");
    if (parts.length === 2) opponentsByTeam[teamId].push(parts[1].trim());
  }

  const output: any[] = [];
  for (const [teamIdText, opponents] of Object.entries(opponentsByTeam)) {
    let sumOff = 0;
    let sumDef = 0;
    let count = 0;
    for (const abbreviation of opponents) {
      const opponentId = abbreviationToId[abbreviation];
      const seasonStats = seasonById[opponentId];
      if (!seasonStats) continue;
      const recentStats = recentById[opponentId];
      sumOff += recentStats ? seasonStats.offRtg * 0.4 + recentStats.offRtg * 0.6 : seasonStats.offRtg;
      sumDef += recentStats ? seasonStats.defRtg * 0.4 + recentStats.defRtg * 0.6 : seasonStats.defRtg;
      count += 1;
    }
    if (!count) continue;
    const averageNet = (sumOff - sumDef) / count;
    const label = averageNet > 4 ? "Agenda MUY dificil"
      : averageNet > 1.5 ? "Agenda dificil"
      : averageNet > -1.5 ? "Agenda promedio"
      : averageNet > -4 ? "Agenda facil"
      : "Agenda MUY facil";
    output.push({
      teamId: Number(teamIdText),
      oppAvgNetRtg: Math.round(averageNet * 10) / 10,
      oppAvgOffRtg: Math.round((sumOff / count) * 10) / 10,
      oppAvgDefRtg: Math.round((sumDef / count) * 10) / 10,
      sosLabel: label,
    });
  }
  if (!output.length) throw new Error("WNBA SOS direct source returned no usable teams");
  return output;
}

export function validWnbaSos(value: unknown): value is any[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) =>
    Number.isFinite(Number(item?.teamId)) && Number.isFinite(Number(item?.oppAvgNetRtg)),
  );
}

export async function fetchWnbaPlayersDirect(
  fetcher: FetchLike = fetch,
  timeoutMs = 8_000,
): Promise<Record<number, any[]>> {
  const url = "https://stats.nba.com/stats/leaguedashplayerstats?College=&Conference=&Country=&DateFrom=&DateTo=&Division=&DraftPick=&DraftYear=&GameScope=&GameSegment=&Height=&LastNGames=0&LeagueID=10&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2026&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=&Weight=";
  const payload = await fetchWnbaStatsJson(url, fetcher, timeoutMs);
  const set = resultSet(payload);
  const fields = {
    teamId: requiredIndex(set.headers, "TEAM_ID"),
    games: requiredIndex(set.headers, "GP"),
    minutes: requiredIndex(set.headers, "MIN"),
    playerId: requiredIndex(set.headers, "PLAYER_ID"),
    name: requiredIndex(set.headers, "PLAYER_NAME"),
    abbreviation: requiredIndex(set.headers, "TEAM_ABBREVIATION"),
    points: requiredIndex(set.headers, "PTS"),
    assists: requiredIndex(set.headers, "AST"),
    rebounds: requiredIndex(set.headers, "REB"),
    steals: requiredIndex(set.headers, "STL"),
    blocks: requiredIndex(set.headers, "BLK"),
    fieldGoalPct: requiredIndex(set.headers, "FG_PCT"),
  };
  const players: Record<number, any[]> = {};
  for (const row of set.rows) {
    const teamId = Number(row[fields.teamId]);
    const games = Number(row[fields.games]) || 0;
    const minutes = Number(row[fields.minutes]) || 0;
    if (!teamId || games < 5 || minutes < 5) continue;
    if (!players[teamId]) players[teamId] = [];
    players[teamId].push({
      playerId: Number(row[fields.playerId]),
      name: String(row[fields.name] ?? ""),
      teamId,
      teamAbbr: String(row[fields.abbreviation] ?? ""),
      gp: games,
      min: minutes,
      ppg: Number(row[fields.points]) || 0,
      apg: Number(row[fields.assists]) || 0,
      rpg: Number(row[fields.rebounds]) || 0,
      spg: Number(row[fields.steals]) || 0,
      bpg: Number(row[fields.blocks]) || 0,
      fgPct: Number(row[fields.fieldGoalPct]) || 0,
    });
  }
  for (const roster of Object.values(players)) roster.sort((left, right) => right.min - left.min);
  if (!Object.keys(players).length) throw new Error("WNBA players direct source returned no usable players");
  return players;
}

export function validWnbaPlayers(value: unknown): value is Record<number, any[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rosters = Object.values(value as Record<string, unknown>);
  return rosters.length > 0 && rosters.every((roster) => Array.isArray(roster));
}
