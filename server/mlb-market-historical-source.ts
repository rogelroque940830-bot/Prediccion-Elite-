import crypto from "node:crypto";
import type { MlbHistoricalOfficialGame, MlbHistoricalOfficialInning } from "./mlb-market-historical-dataset";

export const MLB_P1_M6A3B1_STATS_API_VERSION = "statsapi.mlb.com-v1.1" as const;
const MLB_API = "https://statsapi.mlb.com/api";
const MAX_RANGE_DAYS = 370;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;

export interface MlbHistoricalFetchFailure {
  gamePk: number | null;
  url: string;
  error: string;
}

export interface MlbHistoricalFetchReport {
  sourceVersion: typeof MLB_P1_M6A3B1_STATS_API_VERSION;
  startDate: string;
  endDate: string;
  scheduleGames: number;
  officialFinalGames: number;
  excluded: Record<string, number>;
  failures: MlbHistoricalFetchFailure[];
  games: MlbHistoricalOfficialGame[];
  actionabilityAllowed: false;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("P1_M6A3B1_INVALID_DATE_RANGE");
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error("P1_M6A3B1_INVALID_DATE_RANGE");
  }
  return value;
}

function validateRange(startDate: string, endDate: string): void {
  const start = Date.parse(`${isoDate(startDate)}T00:00:00Z`);
  const end = Date.parse(`${isoDate(endDate)}T00:00:00Z`);
  if (end < start) throw new Error("P1_M6A3B1_INVALID_DATE_RANGE");
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) throw new Error("P1_M6A3B1_DATE_RANGE_TOO_LARGE");
}

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<any> {
  const response = await fetchImpl(url, {
    headers: {
      "User-Agent": "CourtEdge-P1-M6A3B1/1.0",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`MLB_STATS_API_HTTP_${response.status}`);
  return response.json();
}

function digestPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function finalState(payload: any): string {
  const status = payload?.gameData?.status;
  const isFinal = status?.abstractGameState === "Final"
    || status?.codedGameState === "F"
    || status?.detailedState === "Final";
  return isFinal ? "Final" : String(status?.detailedState ?? status?.abstractGameState ?? "Unknown");
}

function halfRuns(half: any): number | null {
  if (!half || !Object.prototype.hasOwnProperty.call(half, "runs")) return null;
  const runs = Number(half.runs);
  return Number.isInteger(runs) && runs >= 0 ? runs : null;
}

export function parseMlbHistoricalOfficialFeed(gamePk: number, payload: any): MlbHistoricalOfficialGame | null {
  const state = finalState(payload);
  if (state !== "Final") return null;

  const officialDate = String(
    payload?.gameData?.datetime?.officialDate
    ?? payload?.gameData?.datetime?.dateTime
    ?? "",
  ).slice(0, 10);
  const season = Number(payload?.gameData?.game?.season ?? officialDate.slice(0, 4));
  const gameType = String(payload?.gameData?.game?.type ?? "");
  const homeTeamId = Number(payload?.gameData?.teams?.home?.id);
  const awayTeamId = Number(payload?.gameData?.teams?.away?.id);
  const homeTeam = String(payload?.gameData?.teams?.home?.name ?? "");
  const awayTeam = String(payload?.gameData?.teams?.away?.name ?? "");
  const linescore = payload?.liveData?.linescore;

  const innings: MlbHistoricalOfficialInning[] = (Array.isArray(linescore?.innings) ? linescore.innings : [])
    .map((inning: any) => ({
      num: Number(inning?.num),
      awayRuns: halfRuns(inning?.away),
      homeRuns: halfRuns(inning?.home),
    }))
    .filter((inning: MlbHistoricalOfficialInning) => Number.isInteger(inning.num) && inning.num > 0)
    .sort((a: MlbHistoricalOfficialInning, b: MlbHistoricalOfficialInning) => a.num - b.num);

  const homeFinalRuns = Number(linescore?.teams?.home?.runs);
  const awayFinalRuns = Number(linescore?.teams?.away?.runs);
  if (!Number.isInteger(homeFinalRuns) || homeFinalRuns < 0 || !Number.isInteger(awayFinalRuns) || awayFinalRuns < 0) {
    return null;
  }

  return {
    gamePk,
    officialDate,
    season,
    gameType,
    finalState: state,
    homeTeamId,
    homeTeam,
    awayTeamId,
    awayTeam,
    homeFinalRuns,
    awayFinalRuns,
    innings,
    sourceVersion: MLB_P1_M6A3B1_STATS_API_VERSION,
    sourceDigest: digestPayload(payload),
  };
}

export function extractMlbScheduleGamePks(payload: any): number[] {
  const values: number[] = [];
  for (const date of Array.isArray(payload?.dates) ? payload.dates : []) {
    for (const game of Array.isArray(date?.games) ? date.games : []) {
      const gamePk = Number(game?.gamePk);
      if (Number.isInteger(gamePk) && gamePk > 0) values.push(gamePk);
    }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length || 1) }, () => worker()));
  return output;
}

export async function fetchMlbHistoricalOfficialGames(options: {
  startDate: string;
  endDate: string;
  concurrency?: number;
  fetchImpl?: FetchLike;
}): Promise<MlbHistoricalFetchReport> {
  validateRange(options.startDate, options.endDate);
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("P1_M6A3B1_INVALID_CONCURRENCY");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const scheduleUrl = `${MLB_API}/v1/schedule?sportId=1&gameTypes=R&startDate=${encodeURIComponent(options.startDate)}&endDate=${encodeURIComponent(options.endDate)}`;
  const schedulePayload = await fetchJson(fetchImpl, scheduleUrl);
  const gamePks = extractMlbScheduleGamePks(schedulePayload);
  const failures: MlbHistoricalFetchFailure[] = [];
  const excluded: Record<string, number> = {};

  const results = await mapWithConcurrency(gamePks, concurrency, async (gamePk) => {
    const url = `${MLB_API}/v1.1/game/${gamePk}/feed/live`;
    try {
      const payload = await fetchJson(fetchImpl, url);
      const game = parseMlbHistoricalOfficialFeed(gamePk, payload);
      if (!game) {
        excluded.NOT_OFFICIAL_FINAL = (excluded.NOT_OFFICIAL_FINAL ?? 0) + 1;
        return null;
      }
      if (game.gameType !== "R") {
        excluded.NON_REGULAR_SEASON_GAME = (excluded.NON_REGULAR_SEASON_GAME ?? 0) + 1;
        return null;
      }
      return game;
    } catch (error) {
      failures.push({
        gamePk,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });

  const games = results.filter((game): game is MlbHistoricalOfficialGame => game != null)
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);

  return {
    sourceVersion: MLB_P1_M6A3B1_STATS_API_VERSION,
    startDate: options.startDate,
    endDate: options.endDate,
    scheduleGames: gamePks.length,
    officialFinalGames: games.length,
    excluded,
    failures,
    games,
    actionabilityAllowed: false,
  };
}
