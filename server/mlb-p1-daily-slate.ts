export const MLB_P1_SLATE_SCHEMA = "courtedge-p1-mlb-daily-slate.v1" as const;

export type MlbP1GameState =
  | "SCHEDULED"
  | "PREGAME"
  | "IN_PROGRESS"
  | "FINAL"
  | "POSTPONED"
  | "CANCELLED"
  | "SUSPENDED"
  | "UNKNOWN";

export type MlbP1LineupState = "CONFIRMED" | "PARTIAL" | "NOT_POSTED" | "UNKNOWN";
export type MlbP1Readiness =
  | "READY_TO_ANALYZE"
  | "PROVISIONAL_WAITING_FOR_LINEUPS"
  | "WAITING_FOR_PITCHERS"
  | "GAME_ALREADY_STARTED"
  | "GAME_CLOSED"
  | "DATA_INSUFFICIENT";

export interface MlbP1Pitcher {
  id: number | null;
  name: string | null;
  hand: "R" | "L" | null;
  confirmed: boolean;
}

export interface MlbP1SlateGame {
  gamePk: number;
  startTime: string | null;
  officialDate: string;
  venue: string | null;
  state: MlbP1GameState;
  detailedState: string;
  homeTeam: { id: number | null; name: string };
  awayTeam: { id: number | null; name: string };
  homePitcher: MlbP1Pitcher;
  awayPitcher: MlbP1Pitcher;
  lineupState: MlbP1LineupState;
  homeLineupCount: number;
  awayLineupCount: number;
  readiness: MlbP1Readiness;
  analysisStage: "FINAL" | "PROVISIONAL" | "BLOCKED";
  analysisAllowed: boolean;
  blockers: string[];
  source: {
    name: "MLB_STATS_API";
    fetchedAt: string;
    quality: "AUTHORITATIVE" | "DEGRADED";
  };
}

export interface MlbP1DailySlate {
  schemaVersion: typeof MLB_P1_SLATE_SCHEMA;
  date: string;
  generatedAt: string;
  games: MlbP1SlateGame[];
  summary: {
    total: number;
    ready: number;
    provisional: number;
    waitingForPitchers: number;
    startedOrClosed: number;
    dataInsufficient: number;
  };
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RawScheduleGame {
  gamePk?: number;
  gameDate?: string;
  officialDate?: string;
  status?: Record<string, unknown>;
  venue?: { name?: string };
  teams?: {
    home?: { team?: { id?: number; name?: string }; probablePitcher?: { id?: number; fullName?: string } };
    away?: { team?: { id?: number; name?: string }; probablePitcher?: { id?: number; fullName?: string } };
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function finiteId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isValidMlbP1Date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

export function normalizeMlbP1GameState(status: Record<string, unknown> | null | undefined): MlbP1GameState {
  const abstract = clean(status?.abstractGameState).toLowerCase();
  const detailed = clean(status?.detailedState).toLowerCase();
  const coded = clean(status?.codedGameState).toLowerCase();
  const text = `${abstract} ${detailed} ${coded}`;
  if (/cancel/.test(text)) return "CANCELLED";
  if (/postpon/.test(text)) return "POSTPONED";
  if (/suspend/.test(text)) return "SUSPENDED";
  if (abstract === "final" || /final|game over|completed early/.test(detailed)) return "FINAL";
  if (abstract === "live" || /in progress|warmup|delayed/.test(detailed)) return "IN_PROGRESS";
  if (abstract === "preview" || /scheduled|pre-game|pregame/.test(text)) return detailed.includes("pre-game") || detailed.includes("pregame") ? "PREGAME" : "SCHEDULED";
  return "UNKNOWN";
}

function pitcherFromFeed(feed: any, side: "home" | "away", fallback: RawScheduleGame): MlbP1Pitcher {
  const probable = feed?.gameData?.probablePitchers?.[side] ?? fallback.teams?.[side]?.probablePitcher;
  const id = finiteId(probable?.id);
  const indexed = id ? feed?.gameData?.players?.[`ID${id}`] : null;
  const hand = clean(indexed?.pitchHand?.code ?? probable?.pitchHand?.code).toUpperCase();
  return {
    id,
    name: clean(indexed?.fullName ?? probable?.fullName) || null,
    hand: hand === "R" || hand === "L" ? hand : null,
    confirmed: Boolean(id && clean(indexed?.fullName ?? probable?.fullName)),
  };
}

function lineupCount(feed: any, side: "home" | "away"): number {
  const order = feed?.liveData?.boxscore?.teams?.[side]?.battingOrder;
  return Array.isArray(order) ? new Set(order.map(Number).filter(Number.isFinite)).size : 0;
}

function lineupState(home: number, away: number, feedAvailable: boolean): MlbP1LineupState {
  if (!feedAvailable) return "UNKNOWN";
  if (home >= 9 && away >= 9) return "CONFIRMED";
  if (home > 0 || away > 0) return "PARTIAL";
  return "NOT_POSTED";
}

export function classifyMlbP1Readiness(input: {
  state: MlbP1GameState;
  homePitcher: MlbP1Pitcher;
  awayPitcher: MlbP1Pitcher;
  lineupState: MlbP1LineupState;
  sourceQuality: "AUTHORITATIVE" | "DEGRADED";
}): Pick<MlbP1SlateGame, "readiness" | "analysisStage" | "analysisAllowed" | "blockers"> {
  const blockers: string[] = [];
  if (["FINAL", "POSTPONED", "CANCELLED", "SUSPENDED"].includes(input.state)) {
    blockers.push(`El juego está ${input.state.toLowerCase()}.`);
    return { readiness: "GAME_CLOSED", analysisStage: "BLOCKED", analysisAllowed: false, blockers };
  }
  if (input.state === "IN_PROGRESS") {
    blockers.push("El juego ya comenzó; no corresponde crear una predicción pregame nueva.");
    return { readiness: "GAME_ALREADY_STARTED", analysisStage: "BLOCKED", analysisAllowed: false, blockers };
  }
  if (input.sourceQuality === "DEGRADED" || input.state === "UNKNOWN") {
    blockers.push("La identidad oficial del juego no pudo verificarse completamente.");
    return { readiness: "DATA_INSUFFICIENT", analysisStage: "BLOCKED", analysisAllowed: false, blockers };
  }
  if (!input.homePitcher.confirmed || !input.awayPitcher.confirmed) {
    if (!input.homePitcher.confirmed) blockers.push("Falta el pitcher probable del equipo local.");
    if (!input.awayPitcher.confirmed) blockers.push("Falta el pitcher probable del equipo visitante.");
    return { readiness: "WAITING_FOR_PITCHERS", analysisStage: "BLOCKED", analysisAllowed: false, blockers };
  }
  if (input.lineupState !== "CONFIRMED") {
    blockers.push(input.lineupState === "PARTIAL" ? "Los lineups están publicados parcialmente." : "Los lineups oficiales todavía no están publicados.");
    return {
      readiness: "PROVISIONAL_WAITING_FOR_LINEUPS",
      analysisStage: "PROVISIONAL",
      analysisAllowed: true,
      blockers,
    };
  }
  return { readiness: "READY_TO_ANALYZE", analysisStage: "FINAL", analysisAllowed: true, blockers };
}

async function jsonOrThrow(response: Response, label: string): Promise<any> {
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
  return response.json();
}

export async function buildMlbP1DailySlate(options: {
  date: string;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<MlbP1DailySlate> {
  const { date } = options;
  if (!isValidMlbP1Date(date)) throw new Error("INVALID_DATE");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const scheduleUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}&hydrate=team,probablePitcher,venue`;
  const schedule = await jsonOrThrow(await fetchImpl(scheduleUrl), "MLB schedule");
  const rawGames: RawScheduleGame[] = Array.isArray(schedule?.dates)
    ? schedule.dates.flatMap((entry: any) => Array.isArray(entry?.games) ? entry.games : [])
    : [];

  const games = await Promise.all(rawGames.map(async (game): Promise<MlbP1SlateGame | null> => {
    const gamePk = finiteId(game.gamePk);
    if (!gamePk) return null;
    let feed: any = null;
    let quality: "AUTHORITATIVE" | "DEGRADED" = "AUTHORITATIVE";
    try {
      feed = await jsonOrThrow(
        await fetchImpl(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`),
        `MLB game ${gamePk}`,
      );
    } catch {
      quality = "DEGRADED";
    }

    const gameData = feed?.gameData;
    const status = gameData?.status ?? game.status ?? {};
    const state = normalizeMlbP1GameState(status);
    const homePitcher = pitcherFromFeed(feed, "home", game);
    const awayPitcher = pitcherFromFeed(feed, "away", game);
    const homeLineupCount = lineupCount(feed, "home");
    const awayLineupCount = lineupCount(feed, "away");
    const currentLineupState = lineupState(homeLineupCount, awayLineupCount, Boolean(feed));
    const readiness = classifyMlbP1Readiness({
      state,
      homePitcher,
      awayPitcher,
      lineupState: currentLineupState,
      sourceQuality: quality,
    });
    const homeTeam = gameData?.teams?.home ?? game.teams?.home?.team ?? {};
    const awayTeam = gameData?.teams?.away ?? game.teams?.away?.team ?? {};
    return {
      gamePk,
      startTime: clean(gameData?.datetime?.dateTime ?? game.gameDate) || null,
      officialDate: clean(gameData?.datetime?.officialDate ?? game.officialDate) || date,
      venue: clean(gameData?.venue?.name ?? game.venue?.name) || null,
      state,
      detailedState: clean(status?.detailedState ?? status?.abstractGameState) || "Estado no disponible",
      homeTeam: { id: finiteId(homeTeam?.id), name: clean(homeTeam?.name) || "Equipo local no disponible" },
      awayTeam: { id: finiteId(awayTeam?.id), name: clean(awayTeam?.name) || "Equipo visitante no disponible" },
      homePitcher,
      awayPitcher,
      lineupState: currentLineupState,
      homeLineupCount,
      awayLineupCount,
      ...readiness,
      source: { name: "MLB_STATS_API", fetchedAt: generatedAt, quality },
    };
  }));

  const validGames = games.filter((game): game is MlbP1SlateGame => game != null)
    .sort((left, right) => {
      const leftMs = left.startTime ? Date.parse(left.startTime) : Number.POSITIVE_INFINITY;
      const rightMs = right.startTime ? Date.parse(right.startTime) : Number.POSITIVE_INFINITY;
      return leftMs - rightMs || left.gamePk - right.gamePk;
    });

  return {
    schemaVersion: MLB_P1_SLATE_SCHEMA,
    date,
    generatedAt,
    games: validGames,
    summary: {
      total: validGames.length,
      ready: validGames.filter((game) => game.readiness === "READY_TO_ANALYZE").length,
      provisional: validGames.filter((game) => game.readiness === "PROVISIONAL_WAITING_FOR_LINEUPS").length,
      waitingForPitchers: validGames.filter((game) => game.readiness === "WAITING_FOR_PITCHERS").length,
      startedOrClosed: validGames.filter((game) => ["GAME_ALREADY_STARTED", "GAME_CLOSED"].includes(game.readiness)).length,
      dataInsufficient: validGames.filter((game) => game.readiness === "DATA_INSUFFICIENT").length,
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
