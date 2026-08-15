import crypto from "node:crypto";
import type { MlbHistoricalOfficialGame } from "./mlb-market-historical-dataset";

export const MLB_BATTER_HISTORY_SCHEMA = "courtedge-mlb-historical-batter-history.v1" as const;
export const MLB_BATTER_HISTORY_SOURCE = "MLB_STATS_API_BOXSCORE" as const;

const MLB_API = "https://statsapi.mlb.com/api";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 6;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type MlbBatterSide = "home" | "away";

const REQUIRED_DIRECT_FIELDS = [
  "atBats",
  "runs",
  "hits",
  "doubles",
  "triples",
  "homeRuns",
  "rbi",
  "baseOnBalls",
  "strikeOuts",
  "plateAppearances",
  "totalBases",
  "stolenBases",
  "caughtStealing",
] as const;

type RequiredDirectField = (typeof REQUIRED_DIRECT_FIELDS)[number];

export interface MlbHistoricalBatterLine {
  gamePk: number;
  officialDate: string;
  side: MlbBatterSide;
  teamId: number;
  opponentTeamId: number;
  batterId: number;
  batterName: string;
  battingOrder: string | null;
  atBats: number;
  runs: number;
  hits: number;
  doubles: number;
  triples: number;
  homeRuns: number;
  rbi: number;
  baseOnBalls: number;
  strikeOuts: number;
  plateAppearances: number;
  totalBases: number;
  stolenBases: number;
  caughtStealing: number;
  intentionalWalks: number | null;
  hitByPitch: number | null;
  sacBunts: number | null;
  sacFlies: number | null;
  groundIntoDoublePlay: number | null;
  leftOnBase: number | null;
  singlesDerived: number;
  hitsRunsRbisDerived: number;
}

export interface MlbHistoricalBatterGame {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeBatters: MlbHistoricalBatterLine[];
  awayBatters: MlbHistoricalBatterLine[];
  boxscoreSourceDigest: string;
}

export interface MlbBatterHistoryFetchFailure {
  gamePk: number;
  error: string;
}

export interface MlbHistoricalBatterHistoryReport {
  schemaVersion: typeof MLB_BATTER_HISTORY_SCHEMA;
  source: typeof MLB_BATTER_HISTORY_SOURCE;
  generatedAt: string;
  officialGamesReceived: number;
  gamesWithBatterLines: number;
  batterLines: number;
  fetchFailures: MlbBatterHistoryFetchFailure[];
  teamAggregateReconciliationFailures: 0;
  games: MlbHistoricalBatterGame[];
  batterHistoryDigest: string;
  boxscoreProvenanceDigest: string;
  actionabilityAllowed: false;
  modelTrainingAllowed: false;
  historicalPropPricesUsed: false;
  automaticPromotionAllowed: false;
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

function requiredStat(stats: Record<string, unknown>, key: string): number {
  const parsed = nonNegativeInteger(stats?.[key]);
  if (parsed == null) throw new Error(`BATTER_HISTORY_INVALID_DIRECT_STAT:${key}`);
  return parsed;
}

function optionalStat(stats: Record<string, unknown>, key: string): number | null {
  const value = stats?.[key];
  if (value == null || value === "") return null;
  const parsed = nonNegativeInteger(value);
  if (parsed == null) throw new Error(`BATTER_HISTORY_INVALID_OPTIONAL_STAT:${key}`);
  return parsed;
}

function parseBattingOrder(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{3}$/.test(text)) throw new Error(`BATTER_HISTORY_INVALID_BATTING_ORDER:${text}`);
  return text;
}

function validateLineArithmetic(line: MlbHistoricalBatterLine): void {
  const extraBaseComponents = line.doubles + line.triples + line.homeRuns;
  if (line.hits < extraBaseComponents) throw new Error(`BATTER_HISTORY_HITS_COMPONENTS_INVALID:${line.batterId}`);
  if (line.atBats < line.hits) throw new Error(`BATTER_HISTORY_AT_BATS_LT_HITS:${line.batterId}`);
  if (line.plateAppearances < line.atBats) throw new Error(`BATTER_HISTORY_PA_LT_AB:${line.batterId}`);
  const expectedTotalBases = line.hits + line.doubles + 2 * line.triples + 3 * line.homeRuns;
  if (line.totalBases !== expectedTotalBases) {
    throw new Error(`BATTER_HISTORY_TOTAL_BASES_MISMATCH:${line.batterId}:${line.totalBases}:${expectedTotalBases}`);
  }
  if (line.singlesDerived < 0) throw new Error(`BATTER_HISTORY_NEGATIVE_SINGLES:${line.batterId}`);
}

function parseTeamBatters(
  game: MlbHistoricalOfficialGame,
  boxscore: any,
  side: MlbBatterSide,
): MlbHistoricalBatterLine[] {
  const teamBox = boxscore?.teams?.[side];
  const teamId = side === "home" ? game.homeTeamId : game.awayTeamId;
  const opponentTeamId = side === "home" ? game.awayTeamId : game.homeTeamId;
  if (positiveInteger(teamBox?.team?.id) !== teamId) throw new Error(`BATTER_HISTORY_TEAM_ID_MISMATCH:${side}`);

  const batterIds = Array.isArray(teamBox?.batters)
    ? teamBox.batters.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
    : [];
  if (!batterIds.length) throw new Error(`BATTER_HISTORY_NO_BATTERS:${side}`);
  if (new Set(batterIds).size !== batterIds.length) throw new Error(`BATTER_HISTORY_DUPLICATE_BATTER_ID:${side}`);

  const players = teamBox?.players ?? {};
  const lines = batterIds.flatMap((batterId: number) => {
    const player = players?.[`ID${batterId}`];
    const batting = player?.stats?.batting;
    if (!player || !batting || typeof batting !== "object" || Array.isArray(batting)) {
      throw new Error(`BATTER_HISTORY_STATS_MISSING:${side}:${batterId}`);
    }

    // MLB's team.batters can include roster participants (commonly pitchers)
    // with an empty batting object and no batting order. Those entries are not
    // zero-stat batter outcomes. Only a completely empty batting payload is
    // excluded; every non-empty payload remains subject to all fail-closed gates.
    if (Object.keys(batting).length === 0) return [];

    const batterName = String(player?.person?.fullName ?? "").trim();
    if (!batterName) throw new Error(`BATTER_HISTORY_NAME_MISSING:${side}:${batterId}`);

    const direct = Object.fromEntries(
      REQUIRED_DIRECT_FIELDS.map((key) => [key, requiredStat(batting, key)]),
    ) as Record<RequiredDirectField, number>;
    const singlesDerived = direct.hits - direct.doubles - direct.triples - direct.homeRuns;
    const line: MlbHistoricalBatterLine = {
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      side,
      teamId,
      opponentTeamId,
      batterId,
      batterName,
      battingOrder: parseBattingOrder(player?.battingOrder),
      ...direct,
      intentionalWalks: optionalStat(batting, "intentionalWalks"),
      hitByPitch: optionalStat(batting, "hitByPitch"),
      sacBunts: optionalStat(batting, "sacBunts"),
      sacFlies: optionalStat(batting, "sacFlies"),
      groundIntoDoublePlay: optionalStat(batting, "groundIntoDoublePlay"),
      leftOnBase: optionalStat(batting, "leftOnBase"),
      singlesDerived,
      hitsRunsRbisDerived: direct.hits + direct.runs + direct.rbi,
    };
    validateLineArithmetic(line);
    return [line];
  });
  if (!lines.length) throw new Error(`BATTER_HISTORY_NO_STATISTICAL_BATTER_LINES:${side}`);

  const teamBatting = teamBox?.teamStats?.batting;
  if (!teamBatting || typeof teamBatting !== "object") throw new Error(`BATTER_HISTORY_TEAM_STATS_MISSING:${side}`);
  for (const field of REQUIRED_DIRECT_FIELDS) {
    const expected = requiredStat(teamBatting, field);
    const actual = lines.reduce((sum, line) => sum + line[field], 0);
    if (actual !== expected) throw new Error(`BATTER_HISTORY_TEAM_RECONCILIATION_MISMATCH:${side}:${field}:${actual}:${expected}`);
  }
  return lines;
}

export function parseMlbHistoricalBatterBoxscore(
  game: MlbHistoricalOfficialGame,
  boxscore: any,
): MlbHistoricalBatterGame {
  if (!game || !Number.isInteger(game.gamePk) || game.gamePk <= 0) throw new Error("BATTER_HISTORY_INVALID_OFFICIAL_GAME");
  const homeBatters = parseTeamBatters(game, boxscore, "home");
  const awayBatters = parseTeamBatters(game, boxscore, "away");

  // Preserve side/team custody exactly as the official boxscore records it.
  // A suspended game resumed after a trade can legitimately contain the same
  // batter ID on both sides (Danny Jansen, gamePk 746942). The compound
  // identity is gamePk + side + teamId + batterId, so the lines remain distinct.
  return {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    homeTeamId: game.homeTeamId,
    awayTeamId: game.awayTeamId,
    homeBatters,
    awayBatters,
    boxscoreSourceDigest: digestPayload(boxscore),
  };
}

function canonicalBatter(line: MlbHistoricalBatterLine): string {
  return JSON.stringify({
    gamePk: line.gamePk,
    officialDate: line.officialDate,
    side: line.side,
    teamId: line.teamId,
    opponentTeamId: line.opponentTeamId,
    batterId: line.batterId,
    atBats: line.atBats,
    runs: line.runs,
    hits: line.hits,
    doubles: line.doubles,
    triples: line.triples,
    homeRuns: line.homeRuns,
    rbi: line.rbi,
    baseOnBalls: line.baseOnBalls,
    strikeOuts: line.strikeOuts,
    plateAppearances: line.plateAppearances,
    totalBases: line.totalBases,
    stolenBases: line.stolenBases,
    caughtStealing: line.caughtStealing,
  });
}

export function digestMlbBatterHistory(games: MlbHistoricalBatterGame[]): string {
  return sha256(games
    .flatMap((game) => [...game.awayBatters, ...game.homeBatters])
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate)
      || a.gamePk - b.gamePk
      || a.side.localeCompare(b.side)
      || a.batterId - b.batterId)
    .map(canonicalBatter)
    .join("\n"));
}

export function digestMlbBatterBoxscoreProvenance(games: MlbHistoricalBatterGame[]): string {
  return sha256([...games]
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk)
    .map((game) => JSON.stringify({ gamePk: game.gamePk, officialDate: game.officialDate, boxscoreSourceDigest: game.boxscoreSourceDigest }))
    .join("\n"));
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
        headers: { "User-Agent": "CourtEdge-P0-Step12V41/1.0", Accept: "application/json" },
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
  throw lastError instanceof Error ? lastError : new Error("BATTER_HISTORY_FETCH_RETRY_EXHAUSTED");
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

export async function fetchMlbHistoricalBatterHistoryFromOfficialGames(options: {
  games: MlbHistoricalOfficialGame[];
  concurrency?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: FetchLike;
}): Promise<MlbHistoricalBatterHistoryReport> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error("BATTER_HISTORY_INVALID_CONCURRENCY");
  if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > 10_000) throw new Error("BATTER_HISTORY_INVALID_RETRY_DELAY");

  const games = [...options.games].sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  const gamePks = games.map((game) => game.gamePk);
  if (new Set(gamePks).size !== gamePks.length) throw new Error("BATTER_HISTORY_DUPLICATE_OFFICIAL_GAME_PK");
  const fetchImpl = options.fetchImpl ?? fetch;
  const fetchFailures: MlbBatterHistoryFetchFailure[] = [];
  const parsed = await mapWithConcurrency(games, concurrency, async (game) => {
    try {
      const boxscore = await fetchJson(fetchImpl, `${MLB_API}/v1/game/${game.gamePk}/boxscore`, retryBaseDelayMs);
      return parseMlbHistoricalBatterBoxscore(game, boxscore);
    } catch (error) {
      fetchFailures.push({ gamePk: game.gamePk, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });
  const parsedGames = parsed.filter((game): game is MlbHistoricalBatterGame => game != null);
  return {
    schemaVersion: MLB_BATTER_HISTORY_SCHEMA,
    source: MLB_BATTER_HISTORY_SOURCE,
    generatedAt: new Date().toISOString(),
    officialGamesReceived: games.length,
    gamesWithBatterLines: parsedGames.length,
    batterLines: parsedGames.reduce((sum, game) => sum + game.homeBatters.length + game.awayBatters.length, 0),
    fetchFailures: fetchFailures.sort((a, b) => a.gamePk - b.gamePk),
    teamAggregateReconciliationFailures: 0,
    games: parsedGames,
    batterHistoryDigest: digestMlbBatterHistory(parsedGames),
    boxscoreProvenanceDigest: digestMlbBatterBoxscoreProvenance(parsedGames),
    actionabilityAllowed: false,
    modelTrainingAllowed: false,
    historicalPropPricesUsed: false,
    automaticPromotionAllowed: false,
  };
}
