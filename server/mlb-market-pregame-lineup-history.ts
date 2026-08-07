import crypto from "node:crypto";

export const MLB_P1_M6A3B2C1_SOURCE_VERSION = "statsapi.mlb.com-v1.1-timecode-pregame-lineup.v2" as const;
export const MLB_P1_M6A3B2C1_DEFAULT_CUTOFF_SECONDS = 300;

const MLB_API = "https://statsapi.mlb.com/api";
const MAX_RANGE_DAYS = 370;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const MAX_RETRY_BASE_DELAY_MS = 10_000;

export type MlbPregameLineupAvailability =
  | "COMPLETE"
  | "HOME_INCOMPLETE"
  | "AWAY_INCOMPLETE"
  | "BOTH_INCOMPLETE"
  | "NOT_PREGAME_AT_CUTOFF"
  | "IDENTITY_CONFLICT";

export type MlbHistoricalPregameScheduleResolution =
  | "DIRECT"
  | "RESCHEDULED_FINAL_SELECTED";

export interface MlbHistoricalPregameScheduleGame {
  gamePk: number;
  officialDate: string;
  scheduledStart: string;
  homeTeamId: number;
  awayTeamId: number;
  scheduleResolution: MlbHistoricalPregameScheduleResolution;
}

export interface MlbHistoricalPregameLineupSnapshot {
  sourceVersion: typeof MLB_P1_M6A3B2C1_SOURCE_VERSION;
  gamePk: number;
  officialDate: string;
  scheduledStart: string;
  scheduleResolution: MlbHistoricalPregameScheduleResolution;
  cutoffAt: string;
  requestedTimecode: string;
  sourceMetadataTimecode: string | null;
  homeTeamId: number;
  awayTeamId: number;
  gameState: {
    abstractGameState: string;
    codedGameState: string;
    detailedState: string;
  };
  homeBattingOrder: number[];
  awayBattingOrder: number[];
  availability: MlbPregameLineupAvailability;
  complete: boolean;
  sourceDigest: string;
}

export interface MlbHistoricalPregameLineupFetchFailure {
  gamePk: number | null;
  url: string;
  error: string;
}

export interface MlbHistoricalPregameLineupReport {
  sourceVersion: typeof MLB_P1_M6A3B2C1_SOURCE_VERSION;
  startDate: string;
  endDate: string;
  cutoffSecondsBeforeScheduledStart: number;
  scheduleGames: number;
  scheduleResolutionCounts: Record<MlbHistoricalPregameScheduleResolution, number>;
  snapshotsFetched: number;
  completeLineupGames: number;
  availabilityCounts: Record<MlbPregameLineupAvailability, number>;
  failures: MlbHistoricalPregameLineupFetchFailure[];
  snapshots: MlbHistoricalPregameLineupSnapshot[];
  lineupHistoryDigest: string;
  sourceProvenanceDigest: string;
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  automaticPromotionAllowed: false;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ScheduleCandidate = Omit<MlbHistoricalPregameScheduleGame, "scheduleResolution"> & {
  codedGameState: string;
  detailedState: string;
};

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("P1_M6A3B2C1_INVALID_DATE_RANGE");
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error("P1_M6A3B2C1_INVALID_DATE_RANGE");
  }
  return value;
}

function validateRange(startDate: string, endDate: string): void {
  const start = Date.parse(`${isoDate(startDate)}T00:00:00Z`);
  const end = Date.parse(`${isoDate(endDate)}T00:00:00Z`);
  if (end < start) throw new Error("P1_M6A3B2C1_INVALID_DATE_RANGE");
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days > MAX_RANGE_DAYS) throw new Error("P1_M6A3B2C1_DATE_RANGE_TOO_LARGE");
}

function transientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000));
  const absolute = Date.parse(raw);
  if (Number.isFinite(absolute)) return Math.max(0, Math.min(30_000, absolute - Date.now()));
  return null;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(fetchImpl: FetchLike, url: string, retryBaseDelayMs: number): Promise<any> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "User-Agent": "CourtEdge-P1-M6A3B2C1/1.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return response.json();
      const error = new Error(`MLB_STATS_API_HTTP_${response.status}`);
      if (!transientHttpStatus(response.status) || attempt === MAX_FETCH_ATTEMPTS) throw error;
      lastError = error;
      await sleep(retryAfterMs(response) ?? retryBaseDelayMs * 2 ** (attempt - 1));
    } catch (error) {
      if (error instanceof Error && /^MLB_STATS_API_HTTP_\d+$/.test(error.message)) {
        const status = Number(error.message.split("_").at(-1));
        if (!transientHttpStatus(status) || attempt === MAX_FETCH_ATTEMPTS) throw error;
      } else if (attempt === MAX_FETCH_ATTEMPTS) {
        throw error;
      }
      lastError = error;
      await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("P1_M6A3B2C1_FETCH_RETRY_EXHAUSTED");
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validIsoInstant(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function formatMlbHistoricalTimecode(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("P1_M6A3B2C1_INVALID_TIMECODE_INSTANT");
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function parseMlbMetadataTimecode(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return /^\d{8}_\d{6}$/.test(text) ? text : null;
}

function normalizeBattingOrder(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map(positiveInteger);
  if (ids.some((id) => id == null)) return [];
  return ids as number[];
}

function completeBattingOrder(order: number[]): boolean {
  return order.length === 9 && new Set(order).size === 9;
}

function pregameState(payload: any): boolean {
  const abstract = String(payload?.gameData?.status?.abstractGameState ?? "").trim();
  const coded = String(payload?.gameData?.status?.codedGameState ?? "").trim().toUpperCase();
  const detailed = String(payload?.gameData?.status?.detailedState ?? "").trim();
  if (["Live", "Final"].includes(abstract) || ["I", "F", "O"].includes(coded)) return false;
  if (abstract === "Preview" || ["S", "P"].includes(coded)) return true;
  return /^(Scheduled|Pre-Game|Warmup|Delayed Start)$/i.test(detailed);
}

function scheduleCandidateKey(candidate: ScheduleCandidate): string {
  return JSON.stringify(candidate);
}

function sameScheduleTeams(a: ScheduleCandidate, b: ScheduleCandidate): boolean {
  return a.homeTeamId === b.homeTeamId && a.awayTeamId === b.awayTeamId;
}

function isPlayedFinalScheduleCandidate(candidate: ScheduleCandidate): boolean {
  return candidate.codedGameState.toUpperCase() === "F";
}

function isExplicitlyObsoleteScheduleCandidate(candidate: ScheduleCandidate): boolean {
  const coded = candidate.codedGameState.toUpperCase();
  const detailed = candidate.detailedState.trim();
  return coded === "D" || /^(Postponed|Canceled|Cancelled|Suspended)$/i.test(detailed);
}

function resolveScheduleCandidateGroup(gamePk: number, rawCandidates: ScheduleCandidate[]): MlbHistoricalPregameScheduleGame {
  const candidates = [...new Map(rawCandidates.map((candidate) => [scheduleCandidateKey(candidate), candidate])).values()];
  if (!candidates.length) throw new Error(`P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT:${gamePk}`);

  const first = candidates[0];
  if (candidates.some((candidate) => !sameScheduleTeams(first, candidate))) {
    throw new Error(`P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT:${gamePk}`);
  }

  if (candidates.length === 1) {
    const { codedGameState: _coded, detailedState: _detailed, ...game } = first;
    return { ...game, scheduleResolution: "DIRECT" };
  }

  const playedFinals = candidates.filter(isPlayedFinalScheduleCandidate);
  if (playedFinals.length === 1) {
    const selected = playedFinals[0];
    const others = candidates.filter((candidate) => candidate !== selected);
    if (others.length > 0 && others.every(isExplicitlyObsoleteScheduleCandidate)) {
      const { codedGameState: _coded, detailedState: _detailed, ...game } = selected;
      return { ...game, scheduleResolution: "RESCHEDULED_FINAL_SELECTED" };
    }
  }

  throw new Error(`P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT:${gamePk}`);
}

export function extractMlbHistoricalPregameScheduleGames(payload: any): MlbHistoricalPregameScheduleGame[] {
  const grouped = new Map<number, ScheduleCandidate[]>();
  for (const dateEntry of Array.isArray(payload?.dates) ? payload.dates : []) {
    for (const game of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
      const gamePk = positiveInteger(game?.gamePk);
      const gameType = String(game?.gameType ?? game?.game?.type ?? "");
      const scheduledStart = validIsoInstant(game?.gameDate);
      const officialDate = String(game?.officialDate ?? dateEntry?.date ?? scheduledStart ?? "").slice(0, 10);
      const homeTeamId = positiveInteger(game?.teams?.home?.team?.id);
      const awayTeamId = positiveInteger(game?.teams?.away?.team?.id);
      if (gameType && gameType !== "R") continue;
      if (!gamePk || !scheduledStart || !/^\d{4}-\d{2}-\d{2}$/.test(officialDate) || !homeTeamId || !awayTeamId) continue;
      const candidate: ScheduleCandidate = {
        gamePk,
        officialDate,
        scheduledStart,
        homeTeamId,
        awayTeamId,
        codedGameState: String(game?.status?.codedGameState ?? "").trim(),
        detailedState: String(game?.status?.detailedState ?? "").trim(),
      };
      const group = grouped.get(gamePk) ?? [];
      group.push(candidate);
      grouped.set(gamePk, group);
    }
  }

  return [...grouped.entries()]
    .map(([gamePk, candidates]) => resolveScheduleCandidateGroup(gamePk, candidates))
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.scheduledStart.localeCompare(b.scheduledStart) || a.gamePk - b.gamePk);
}

function availabilityFor(home: number[], away: number[], isPregame: boolean, identityMatches: boolean): MlbPregameLineupAvailability {
  if (!identityMatches) return "IDENTITY_CONFLICT";
  if (!isPregame) return "NOT_PREGAME_AT_CUTOFF";
  const homeComplete = completeBattingOrder(home);
  const awayComplete = completeBattingOrder(away);
  if (homeComplete && awayComplete) return "COMPLETE";
  if (!homeComplete && !awayComplete) return "BOTH_INCOMPLETE";
  return homeComplete ? "AWAY_INCOMPLETE" : "HOME_INCOMPLETE";
}

export function parseMlbHistoricalPregameLineupSnapshot(input: {
  scheduleGame: MlbHistoricalPregameScheduleGame;
  payload: any;
  cutoffSecondsBeforeScheduledStart?: number;
}): MlbHistoricalPregameLineupSnapshot {
  const cutoffSeconds = input.cutoffSecondsBeforeScheduledStart ?? MLB_P1_M6A3B2C1_DEFAULT_CUTOFF_SECONDS;
  if (!Number.isInteger(cutoffSeconds) || cutoffSeconds < 60 || cutoffSeconds > 7200) {
    throw new Error("P1_M6A3B2C1_INVALID_CUTOFF_SECONDS");
  }
  const startMs = Date.parse(input.scheduleGame.scheduledStart);
  if (!Number.isFinite(startMs)) throw new Error("P1_M6A3B2C1_INVALID_SCHEDULE_START");
  const cutoffAt = new Date(startMs - cutoffSeconds * 1000).toISOString();
  if (!(Date.parse(cutoffAt) < startMs)) throw new Error("P1_M6A3B2C1_CUTOFF_NOT_PREGAME");
  const requestedTimecode = formatMlbHistoricalTimecode(cutoffAt);

  const payloadGamePk = positiveInteger(input.payload?.gamePk);
  const homeTeamId = positiveInteger(input.payload?.gameData?.teams?.home?.id);
  const awayTeamId = positiveInteger(input.payload?.gameData?.teams?.away?.id);
  const identityMatches = payloadGamePk === input.scheduleGame.gamePk
    && homeTeamId === input.scheduleGame.homeTeamId
    && awayTeamId === input.scheduleGame.awayTeamId;
  const homeBattingOrder = normalizeBattingOrder(input.payload?.liveData?.boxscore?.teams?.home?.battingOrder);
  const awayBattingOrder = normalizeBattingOrder(input.payload?.liveData?.boxscore?.teams?.away?.battingOrder);
  const isPregame = pregameState(input.payload);
  const availability = availabilityFor(homeBattingOrder, awayBattingOrder, isPregame, identityMatches);

  return {
    sourceVersion: MLB_P1_M6A3B2C1_SOURCE_VERSION,
    gamePk: input.scheduleGame.gamePk,
    officialDate: input.scheduleGame.officialDate,
    scheduledStart: input.scheduleGame.scheduledStart,
    scheduleResolution: input.scheduleGame.scheduleResolution,
    cutoffAt,
    requestedTimecode,
    sourceMetadataTimecode: parseMlbMetadataTimecode(input.payload?.metaData?.timeStamp),
    homeTeamId: input.scheduleGame.homeTeamId,
    awayTeamId: input.scheduleGame.awayTeamId,
    gameState: {
      abstractGameState: String(input.payload?.gameData?.status?.abstractGameState ?? ""),
      codedGameState: String(input.payload?.gameData?.status?.codedGameState ?? ""),
      detailedState: String(input.payload?.gameData?.status?.detailedState ?? ""),
    },
    homeBattingOrder,
    awayBattingOrder,
    availability,
    complete: availability === "COMPLETE",
    sourceDigest: sha256(input.payload),
  };
}

function canonicalLineupIdentity(snapshot: MlbHistoricalPregameLineupSnapshot): Record<string, unknown> {
  return {
    gamePk: snapshot.gamePk,
    officialDate: snapshot.officialDate,
    scheduledStart: snapshot.scheduledStart,
    scheduleResolution: snapshot.scheduleResolution,
    cutoffAt: snapshot.cutoffAt,
    requestedTimecode: snapshot.requestedTimecode,
    homeTeamId: snapshot.homeTeamId,
    awayTeamId: snapshot.awayTeamId,
    homeBattingOrder: snapshot.homeBattingOrder,
    awayBattingOrder: snapshot.awayBattingOrder,
    availability: snapshot.availability,
    complete: snapshot.complete,
  };
}

export function digestMlbHistoricalPregameLineupHistory(snapshots: MlbHistoricalPregameLineupSnapshot[]): string {
  const canonical = [...snapshots]
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk)
    .map(canonicalLineupIdentity);
  return sha256(canonical);
}

export function digestMlbHistoricalPregameLineupProvenance(input: {
  schedulePayload: unknown;
  snapshots: MlbHistoricalPregameLineupSnapshot[];
}): string {
  return sha256({
    scheduleDigest: sha256(input.schedulePayload),
    snapshots: [...input.snapshots]
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk)
      .map((snapshot) => ({ gamePk: snapshot.gamePk, sourceDigest: snapshot.sourceDigest, sourceMetadataTimecode: snapshot.sourceMetadataTimecode })),
  });
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
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

function emptyAvailabilityCounts(): Record<MlbPregameLineupAvailability, number> {
  return {
    COMPLETE: 0,
    HOME_INCOMPLETE: 0,
    AWAY_INCOMPLETE: 0,
    BOTH_INCOMPLETE: 0,
    NOT_PREGAME_AT_CUTOFF: 0,
    IDENTITY_CONFLICT: 0,
  };
}

function emptyScheduleResolutionCounts(): Record<MlbHistoricalPregameScheduleResolution, number> {
  return {
    DIRECT: 0,
    RESCHEDULED_FINAL_SELECTED: 0,
  };
}

export async function fetchMlbHistoricalPregameLineups(options: {
  startDate: string;
  endDate: string;
  cutoffSecondsBeforeScheduledStart?: number;
  concurrency?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: FetchLike;
}): Promise<MlbHistoricalPregameLineupReport> {
  validateRange(options.startDate, options.endDate);
  const cutoffSeconds = options.cutoffSecondsBeforeScheduledStart ?? MLB_P1_M6A3B2C1_DEFAULT_CUTOFF_SECONDS;
  if (!Number.isInteger(cutoffSeconds) || cutoffSeconds < 60 || cutoffSeconds > 7200) {
    throw new Error("P1_M6A3B2C1_INVALID_CUTOFF_SECONDS");
  }
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("P1_M6A3B2C1_INVALID_CONCURRENCY");
  }
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  if (!Number.isFinite(retryBaseDelayMs) || retryBaseDelayMs < 0 || retryBaseDelayMs > MAX_RETRY_BASE_DELAY_MS) {
    throw new Error("P1_M6A3B2C1_INVALID_RETRY_DELAY");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const scheduleUrl = `${MLB_API}/v1/schedule?sportId=1&gameTypes=R&startDate=${encodeURIComponent(options.startDate)}&endDate=${encodeURIComponent(options.endDate)}`;
  const schedulePayload = await fetchJson(fetchImpl, scheduleUrl, retryBaseDelayMs);
  const games = extractMlbHistoricalPregameScheduleGames(schedulePayload);
  const failures: MlbHistoricalPregameLineupFetchFailure[] = [];

  const results = await mapWithConcurrency(games, concurrency, async (scheduleGame) => {
    const cutoffAt = new Date(Date.parse(scheduleGame.scheduledStart) - cutoffSeconds * 1000).toISOString();
    const timecode = formatMlbHistoricalTimecode(cutoffAt);
    const url = `${MLB_API}/v1.1/game/${scheduleGame.gamePk}/feed/live?timecode=${encodeURIComponent(timecode)}`;
    try {
      const payload = await fetchJson(fetchImpl, url, retryBaseDelayMs);
      return parseMlbHistoricalPregameLineupSnapshot({
        scheduleGame,
        payload,
        cutoffSecondsBeforeScheduledStart: cutoffSeconds,
      });
    } catch (error) {
      failures.push({
        gamePk: scheduleGame.gamePk,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  });

  const snapshots = results.filter((snapshot): snapshot is MlbHistoricalPregameLineupSnapshot => snapshot != null)
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  const availabilityCounts = emptyAvailabilityCounts();
  for (const snapshot of snapshots) availabilityCounts[snapshot.availability] += 1;
  const scheduleResolutionCounts = emptyScheduleResolutionCounts();
  for (const game of games) scheduleResolutionCounts[game.scheduleResolution] += 1;

  return {
    sourceVersion: MLB_P1_M6A3B2C1_SOURCE_VERSION,
    startDate: options.startDate,
    endDate: options.endDate,
    cutoffSecondsBeforeScheduledStart: cutoffSeconds,
    scheduleGames: games.length,
    scheduleResolutionCounts,
    snapshotsFetched: snapshots.length,
    completeLineupGames: availabilityCounts.COMPLETE,
    availabilityCounts,
    failures,
    snapshots,
    lineupHistoryDigest: digestMlbHistoricalPregameLineupHistory(snapshots),
    sourceProvenanceDigest: digestMlbHistoricalPregameLineupProvenance({ schedulePayload, snapshots }),
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
  };
}
