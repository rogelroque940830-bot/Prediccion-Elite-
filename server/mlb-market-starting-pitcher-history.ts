import crypto from "node:crypto";
import { fetchMlbHistoricalOfficialGames } from "./mlb-market-historical-source";
import type { MlbHistoricalOfficialGame } from "./mlb-market-historical-dataset";

export const MLB_P1_M6A3B2B1_SCHEMA = "courtedge-p1-m6a3b2b1-starting-pitcher-history.v1" as const;
export const MLB_P1_M6A3B2B1_SOURCE = "MLB_STATS_API_BOXSCORE" as const;

const MLB_API = "https://statsapi.mlb.com/api";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 6;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type MlbStartingPitcherIdentityMethod =
  | "GAME_STARTED_FLAG_AND_ORDER"
  | "GAME_STARTED_FLAG_AFTER_ZERO_PARTICIPATION_PLACEHOLDER"
  | "PITCHING_ORDER_FIRST";
export type MlbPitcherSide = "home" | "away";

export interface MlbHistoricalStartingPitcherLine {
  gamePk: number;
  officialDate: string;
  side: MlbPitcherSide;
  teamId: number;
  opponentTeamId: number;
  pitcherId: number;
  pitcherName: string;
  identityMethod: MlbStartingPitcherIdentityMethod;
  outsRecorded: number;
  inningsPitched: string;
  battersFaced: number | null;
  runs: number;
  earnedRuns: number;
  hits: number;
  baseOnBalls: number;
  strikeOuts: number;
  homeRuns: number;
  hitByPitch: number | null;
  numberOfPitches: number | null;
  strikes: number | null;
}

export interface MlbHistoricalStartingPitcherGame {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeStarter: MlbHistoricalStartingPitcherLine;
  awayStarter: MlbHistoricalStartingPitcherLine;
  boxscoreSourceDigest: string;
}

export interface MlbStartingPitcherFetchFailure {
  gamePk: number;
  error: string;
}

export interface MlbHistoricalStartingPitcherHistoryReport {
  schemaVersion: typeof MLB_P1_M6A3B2B1_SCHEMA;
  source: typeof MLB_P1_M6A3B2B1_SOURCE;
  generatedAt: string;
  startDate: string;
  endDate: string;
  officialGamesReceived: number;
  gamesWithBothStarters: number;
  starterLines: number;
  identityMethodCounts: Record<MlbStartingPitcherIdentityMethod, number>;
  failures: MlbStartingPitcherFetchFailure[];
  games: MlbHistoricalStartingPitcherGame[];
  starterHistoryDigest: string;
  boxscoreProvenanceDigest: string;
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  automaticPromotionAllowed: false;
  blockers: [
    "P1_M6A3B2B1_RESEARCH_HISTORY_ONLY",
    "P1_M6A3B2B2_ASOF_PITCHER_MODEL_REQUIRED",
    "NO_AUTOMATIC_PROMOTION"
  ];
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function digestPayload(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  return nonNegativeInteger(value);
}

export function mlbInningsPitchedToOuts(value: unknown): number {
  const text = String(value ?? "").trim();
  const match = /^(\d+)\.([012])$/.exec(text);
  if (!match) throw new Error("P1_M6A3B2B1_INVALID_INNINGS_PITCHED");
  const innings = Number(match[1]);
  const partialOuts = Number(match[2]);
  return innings * 3 + partialOuts;
}

function requiredGameStat(stats: Record<string, unknown>, key: string): number {
  const parsed = nonNegativeInteger(stats[key]);
  if (parsed == null) throw new Error(`P1_M6A3B2B1_INVALID_STARTER_STAT:${key}`);
  return parsed;
}

function explicitStarterIds(players: Record<string, any>): number[] {
  const ids: number[] = [];
  for (const player of Object.values(players ?? {})) {
    const gamesStarted = Number((player as any)?.stats?.pitching?.gamesStarted);
    const id = positiveInteger((player as any)?.person?.id);
    if (gamesStarted === 1 && id != null) ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function confirmedZeroPitchingParticipation(players: Record<string, any>, pitcherId: number): boolean {
  const player = players?.[`ID${pitcherId}`];
  const pitching = player?.stats?.pitching;
  if (!pitching || typeof pitching !== "object") return false;
  const gamesPitched = nonNegativeInteger(pitching.gamesPitched);
  const battersFaced = nonNegativeInteger(pitching.battersFaced);
  const inningsPitched = String(pitching.inningsPitched ?? "").trim();
  let outsRecorded: number;
  try {
    outsRecorded = mlbInningsPitchedToOuts(inningsPitched);
  } catch {
    return false;
  }
  return gamesPitched === 0 && outsRecorded === 0 && battersFaced === 0;
}

function parseStarter(
  game: MlbHistoricalOfficialGame,
  boxscore: any,
  side: MlbPitcherSide,
): MlbHistoricalStartingPitcherLine {
  const teamBox = boxscore?.teams?.[side];
  const expectedTeamId = side === "home" ? game.homeTeamId : game.awayTeamId;
  const opponentTeamId = side === "home" ? game.awayTeamId : game.homeTeamId;
  const boxTeamId = positiveInteger(teamBox?.team?.id);
  if (boxTeamId !== expectedTeamId) throw new Error(`P1_M6A3B2B1_TEAM_ID_MISMATCH:${side}`);

  const pitchingOrder = Array.isArray(teamBox?.pitchers)
    ? teamBox.pitchers.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  if (!pitchingOrder.length) throw new Error(`P1_M6A3B2B1_NO_PITCHING_ORDER:${side}`);
  const firstPitcherId = pitchingOrder[0];
  const players = teamBox?.players ?? {};
  const explicit = explicitStarterIds(players);

  let pitcherId = firstPitcherId;
  let identityMethod: MlbStartingPitcherIdentityMethod = "PITCHING_ORDER_FIRST";
  if (explicit.length > 1) throw new Error(`P1_M6A3B2B1_MULTIPLE_GAME_STARTED_FLAGS:${side}`);
  if (explicit.length === 1) {
    const explicitPitcherId = explicit[0];
    const explicitOrderIndex = pitchingOrder.indexOf(explicitPitcherId);
    if (explicitOrderIndex < 0) throw new Error(`P1_M6A3B2B1_STARTER_ORDER_CONFLICT:${side}`);
    if (explicitPitcherId === firstPitcherId) {
      pitcherId = explicitPitcherId;
      identityMethod = "GAME_STARTED_FLAG_AND_ORDER";
    } else {
      const precedingPitchers = pitchingOrder.slice(0, explicitOrderIndex);
      const allPrecedingConfirmedNonParticipants = precedingPitchers.length > 0
        && precedingPitchers.every((id) => confirmedZeroPitchingParticipation(players, id));
      if (!allPrecedingConfirmedNonParticipants) {
        throw new Error(`P1_M6A3B2B1_STARTER_ORDER_CONFLICT:${side}`);
      }
      pitcherId = explicitPitcherId;
      identityMethod = "GAME_STARTED_FLAG_AFTER_ZERO_PARTICIPATION_PLACEHOLDER";
    }
  } else if (confirmedZeroPitchingParticipation(players, firstPitcherId)) {
    throw new Error(`P1_M6A3B2B1_ZERO_PARTICIPATION_FIRST_WITHOUT_STARTER_FLAG:${side}`);
  }

  const player = players?.[`ID${pitcherId}`];
  const pitching = player?.stats?.pitching;
  if (!player || !pitching || typeof pitching !== "object") {
    throw new Error(`P1_M6A3B2B1_STARTER_STATS_MISSING:${side}`);
  }
  const pitcherName = String(player?.person?.fullName ?? "").trim();
  if (!pitcherName) throw new Error(`P1_M6A3B2B1_STARTER_NAME_MISSING:${side}`);
  const inningsPitched = String(pitching.inningsPitched ?? "").trim();
  const outsRecorded = mlbInningsPitchedToOuts(inningsPitched);

  return {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    side,
    teamId: expectedTeamId,
    opponentTeamId,
    pitcherId,
    pitcherName,
    identityMethod,
    outsRecorded,
    inningsPitched,
    battersFaced: optionalNonNegativeInteger(pitching.battersFaced),
    runs: requiredGameStat(pitching, "runs"),
    earnedRuns: requiredGameStat(pitching, "earnedRuns"),
    hits: requiredGameStat(pitching, "hits"),
    baseOnBalls: requiredGameStat(pitching, "baseOnBalls"),
    strikeOuts: requiredGameStat(pitching, "strikeOuts"),
    homeRuns: requiredGameStat(pitching, "homeRuns"),
    hitByPitch: optionalNonNegativeInteger(pitching.hitByPitch),
    numberOfPitches: optionalNonNegativeInteger(pitching.numberOfPitches),
    strikes: optionalNonNegativeInteger(pitching.strikes),
  };
}

export function parseMlbHistoricalStartingPitcherBoxscore(
  game: MlbHistoricalOfficialGame,
  boxscore: any,
): MlbHistoricalStartingPitcherGame {
  if (!game || !Number.isInteger(game.gamePk) || game.gamePk <= 0) {
    throw new Error("P1_M6A3B2B1_INVALID_OFFICIAL_GAME");
  }
  const homeStarter = parseStarter(game, boxscore, "home");
  const awayStarter = parseStarter(game, boxscore, "away");
  if (homeStarter.pitcherId === awayStarter.pitcherId) {
    throw new Error("P1_M6A3B2B1_SAME_STARTER_BOTH_SIDES");
  }
  return {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    homeStarter,
    awayStarter,
    boxscoreSourceDigest: digestPayload(boxscore),
  };
}

function canonicalStarter(line: MlbHistoricalStartingPitcherLine): string {
  return JSON.stringify({
    gamePk: line.gamePk,
    officialDate: line.officialDate,
    side: line.side,
    teamId: line.teamId,
    opponentTeamId: line.opponentTeamId,
    pitcherId: line.pitcherId,
    outsRecorded: line.outsRecorded,
    runs: line.runs,
    earnedRuns: line.earnedRuns,
    hits: line.hits,
    baseOnBalls: line.baseOnBalls,
    strikeOuts: line.strikeOuts,
    homeRuns: line.homeRuns,
    battersFaced: line.battersFaced,
  });
}

export function digestMlbStartingPitcherHistory(games: MlbHistoricalStartingPitcherGame[]): string {
  const lines = games
    .flatMap((game) => [game.awayStarter, game.homeStarter])
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate)
      || a.gamePk - b.gamePk
      || a.side.localeCompare(b.side))
    .map(canonicalStarter)
    .join("\n");
  return sha256(lines);
}

export function digestMlbStartingPitcherBoxscoreProvenance(games: MlbHistoricalStartingPitcherGame[]): string {
  const canonical = [...games]
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk)
    .map((game) => JSON.stringify({
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      boxscoreSourceDigest: game.boxscoreSourceDigest,
    }))
    .join("\n");
  return sha256(canonical);
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(fetchImpl: FetchLike, url: string, retryBaseDelayMs: number): Promise<any> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "CourtEdge-P1-M6A3B2B1/1.0", Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response.json();
      const error = new Error(`MLB_STATS_API_HTTP_${response.status}`);
      if (!transientStatus(response.status) || attempt === MAX_FETCH_ATTEMPTS) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === MAX_FETCH_ATTEMPTS) throw error;
    }
    await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
  }
  throw lastError instanceof Error ? lastError : new Error("P1_M6A3B2B1_FETCH_RETRY_EXHAUSTED");
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, () => worker()));
  return output;
}

export async function fetchMlbHistoricalStartingPitcherHistory(options: {
  startDate: string;
  endDate: string;
  concurrency?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: FetchLike;
}): Promise<MlbHistoricalStartingPitcherHistoryReport> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("P1_M6A3B2B1_INVALID_CONCURRENCY");
  }
  if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > 10_000) {
    throw new Error("P1_M6A3B2B1_INVALID_RETRY_DELAY");
  }

  const official = await fetchMlbHistoricalOfficialGames({
    startDate: options.startDate,
    endDate: options.endDate,
    concurrency,
    retryBaseDelayMs,
    fetchImpl: options.fetchImpl,
  });
  if (official.failures.length > 0) {
    throw new Error(`P1_M6A3B2B1_OFFICIAL_HISTORY_INCOMPLETE:${official.failures.length}`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const failures: MlbStartingPitcherFetchFailure[] = [];
  const parsed = await mapWithConcurrency(official.games, concurrency, async (game) => {
    const url = `${MLB_API}/v1/game/${game.gamePk}/boxscore`;
    try {
      const boxscore = await fetchJson(fetchImpl, url, retryBaseDelayMs);
      return parseMlbHistoricalStartingPitcherBoxscore(game, boxscore);
    } catch (error) {
      failures.push({ gamePk: game.gamePk, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });

  const games = parsed.filter((game): game is MlbHistoricalStartingPitcherGame => game != null)
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  const identityMethodCounts: Record<MlbStartingPitcherIdentityMethod, number> = {
    GAME_STARTED_FLAG_AND_ORDER: 0,
    GAME_STARTED_FLAG_AFTER_ZERO_PARTICIPATION_PLACEHOLDER: 0,
    PITCHING_ORDER_FIRST: 0,
  };
  for (const game of games) {
    identityMethodCounts[game.homeStarter.identityMethod] += 1;
    identityMethodCounts[game.awayStarter.identityMethod] += 1;
  }

  return {
    schemaVersion: MLB_P1_M6A3B2B1_SCHEMA,
    source: MLB_P1_M6A3B2B1_SOURCE,
    generatedAt: new Date().toISOString(),
    startDate: options.startDate,
    endDate: options.endDate,
    officialGamesReceived: official.games.length,
    gamesWithBothStarters: games.length,
    starterLines: games.length * 2,
    identityMethodCounts,
    failures: failures.sort((a, b) => a.gamePk - b.gamePk),
    games,
    starterHistoryDigest: digestMlbStartingPitcherHistory(games),
    boxscoreProvenanceDigest: digestMlbStartingPitcherBoxscoreProvenance(games),
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2B1_RESEARCH_HISTORY_ONLY",
      "P1_M6A3B2B2_ASOF_PITCHER_MODEL_REQUIRED",
      "NO_AUTOMATIC_PROMOTION",
    ],
  };
}
