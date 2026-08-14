import {
  buildC4LiveFeatures,
  type C4LiveFeatureAssessment,
  type C4PriorLineupSnapshot,
  type C4PriorTeamGame,
} from "./mlb-c4-live-feature-builder";
import {
  buildMlbFull13LiveFeatures,
  type MlbFull13LiveFeatureAssessment,
  type MlbFull13LivePregameInput,
  type MlbFull13PriorPitcherLine,
} from "./mlb-full13-live-feature-builder";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";

export const MLB_C4_CERTIFIED_MATERIALIZER_SCHEMA =
  "courtedge-p0-mlb-c4-certified-materializer.v1" as const;
export const MLB_FULL13_CERTIFIED_MATERIALIZER_SCHEMA =
  "courtedge-p0-mlb-full13-certified-materializer.v1" as const;

const MLB_STATS_API_BASE = "https://statsapi.mlb.com/api";
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_TIMEOUT_MS = 12_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MlbC4CertifiedMaterializerOptions {
  fetchImpl?: FetchLike;
  maxConcurrency?: number;
  timeoutMs?: number;
  apiBaseUrl?: string;
}

interface HistoricalSnapshot {
  season: number;
  cutoffDate: string;
  teamHistoryByTeam: Map<number, C4PriorTeamGame[]>;
  lineupHistoryByTeam: Map<number, C4PriorLineupSnapshot[]>;
  starterHistoryByPitcher: Map<number, MlbFull13PriorPitcherLine[]>;
  leagueStarterHistory: MlbFull13PriorPitcherLine[];
  priorGameCount: number;
}

interface ScheduledGameIdentity {
  gamePk: number;
  officialDate: string;
}

interface ParsedHistoricalGame {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeRuns: number;
  awayRuns: number;
  homeLineup: number[] | null;
  awayLineup: number[] | null;
  homeStarter: MlbFull13PriorPitcherLine;
  awayStarter: MlbFull13PriorPitcherLine;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeFinite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function previousIsoDate(value: string): string {
  if (!validIsoDate(value)) throw new Error(`C4_CERTIFIED_INVALID_DATE:${value}`);
  return new Date(Date.parse(`${value}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

function isFinalStatus(status: any): boolean {
  const abstract = clean(status?.abstractGameState).toLowerCase();
  const detailed = clean(status?.detailedState).toLowerCase();
  return abstract === "final" || /final|game over|completed early/.test(detailed);
}

function battingOrder(feed: any, side: "home" | "away"): number[] | null {
  const raw = feed?.liveData?.boxscore?.teams?.[side]?.battingOrder;
  if (!Array.isArray(raw)) return null;
  const order = raw.map(positiveInt).filter((id): id is number => id !== null);
  if (order.length !== 9 || new Set(order).size !== 9) return null;
  return order;
}

function starterLine(
  feed: any,
  side: "home" | "away",
  officialDate: string,
  gamePk: number,
): MlbFull13PriorPitcherLine {
  const pitchers = feed?.liveData?.boxscore?.teams?.[side]?.pitchers;
  const pitcherId = Array.isArray(pitchers) ? positiveInt(pitchers[0]) : null;
  if (!pitcherId) throw new Error(`C4_CERTIFIED_STARTER_MISSING:${gamePk}:${side}`);
  const pitching = feed?.liveData?.boxscore?.teams?.[side]?.players?.[`ID${pitcherId}`]?.stats?.pitching;
  const battersFaced = nonNegativeFinite(pitching?.battersFaced);
  const strikeOuts = nonNegativeFinite(pitching?.strikeOuts);
  const baseOnBalls = nonNegativeFinite(pitching?.baseOnBalls);
  if (battersFaced === null || strikeOuts === null || baseOnBalls === null) {
    throw new Error(`C4_CERTIFIED_STARTER_STATS_MISSING:${gamePk}:${side}:${pitcherId}`);
  }
  return {
    officialDate,
    gamePk,
    pitcherId,
    battersFaced,
    strikeOuts,
    baseOnBalls,
    earnedRuns: nonNegativeFinite(pitching?.earnedRuns),
    homeRuns: nonNegativeFinite(pitching?.homeRuns),
  };
}

function parseHistoricalGame(feed: any, expected: ScheduledGameIdentity): ParsedHistoricalGame {
  const gamePk = positiveInt(feed?.gamePk ?? feed?.gameData?.game?.pk) ?? expected.gamePk;
  if (gamePk !== expected.gamePk) throw new Error(`C4_CERTIFIED_GAME_ID_MISMATCH:${expected.gamePk}:${gamePk}`);
  const officialDate = clean(feed?.gameData?.datetime?.officialDate) || expected.officialDate;
  if (officialDate !== expected.officialDate) {
    throw new Error(`C4_CERTIFIED_GAME_DATE_MISMATCH:${gamePk}:${expected.officialDate}:${officialDate}`);
  }
  if (!isFinalStatus(feed?.gameData?.status)) throw new Error(`C4_CERTIFIED_GAME_NOT_FINAL:${gamePk}`);

  const homeTeamId = positiveInt(feed?.gameData?.teams?.home?.id);
  const awayTeamId = positiveInt(feed?.gameData?.teams?.away?.id);
  const homeRuns = nonNegativeFinite(feed?.liveData?.linescore?.teams?.home?.runs);
  const awayRuns = nonNegativeFinite(feed?.liveData?.linescore?.teams?.away?.runs);
  if (!homeTeamId || !awayTeamId || homeRuns === null || awayRuns === null) {
    throw new Error(`C4_CERTIFIED_GAME_RESULT_INCOMPLETE:${gamePk}`);
  }

  return {
    gamePk,
    officialDate,
    homeTeamId,
    awayTeamId,
    homeRuns,
    awayRuns,
    homeLineup: battingOrder(feed, "home"),
    awayLineup: battingOrder(feed, "away"),
    homeStarter: starterLine(feed, "home", officialDate, gamePk),
    awayStarter: starterLine(feed, "away", officialDate, gamePk),
  };
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const rows = map.get(key);
  if (rows) rows.push(value);
  else map.set(key, [value]);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await work(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

export class MlbC4CertifiedMaterializer {
  private readonly fetchImpl: FetchLike;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private readonly apiBaseUrl: string;
  private readonly snapshotCache = new Map<string, Promise<HistoricalSnapshot>>();
  private readonly feedCache = new Map<number, Promise<any>>();

  constructor(options: MlbC4CertifiedMaterializerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxConcurrency = Math.max(1, Math.min(24, Math.floor(options.maxConcurrency ?? DEFAULT_CONCURRENCY)));
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.apiBaseUrl = clean(options.apiBaseUrl) || MLB_STATS_API_BASE;
  }

  async assessGame(game: MlbP1SlateGame): Promise<C4LiveFeatureAssessment> {
    const materialized = await this.materializePregameInput(game);
    const assessment = buildC4LiveFeatures(materialized);
    if (Object.values(assessment.featureVector).some((value) => value === null || !Number.isFinite(value))) {
      throw new Error(`C4_CERTIFIED_FEATURE_VECTOR_INCOMPLETE:${game.gamePk}`);
    }
    return assessment;
  }

  async assessFull13Game(game: MlbP1SlateGame): Promise<MlbFull13LiveFeatureAssessment> {
    const materialized = await this.materializePregameInput(game);
    const assessment = buildMlbFull13LiveFeatures(materialized);
    if (Object.values(assessment.featureVector).some((value) => value === null || !Number.isFinite(value))) {
      throw new Error(`FULL13_CERTIFIED_FEATURE_VECTOR_INCOMPLETE:${game.gamePk}`);
    }
    return assessment;
  }

  private async materializePregameInput(game: MlbP1SlateGame): Promise<MlbFull13LivePregameInput> {
    if (!positiveInt(game.gamePk)) throw new Error("C4_CERTIFIED_TARGET_GAME_PK_INVALID");
    if (!validIsoDate(game.officialDate)) throw new Error(`C4_CERTIFIED_TARGET_DATE_INVALID:${game.officialDate}`);
    const homeTeamId = positiveInt(game.homeTeam.id);
    const awayTeamId = positiveInt(game.awayTeam.id);
    const homeStarterId = positiveInt(game.homePitcher.id);
    const awayStarterId = positiveInt(game.awayPitcher.id);
    if (!homeTeamId || !awayTeamId) throw new Error(`C4_CERTIFIED_TARGET_TEAM_ID_MISSING:${game.gamePk}`);
    if (!homeStarterId || !awayStarterId) throw new Error(`C4_CERTIFIED_TARGET_STARTER_MISSING:${game.gamePk}`);
    if (game.lineupState !== "CONFIRMED") throw new Error(`C4_CERTIFIED_TARGET_LINEUP_NOT_CONFIRMED:${game.gamePk}`);

    const season = Number(game.officialDate.slice(0, 4));
    const snapshot = await this.getHistoricalSnapshot(season, game.officialDate);
    const currentFeed = await this.fetchGameFeed(game.gamePk);
    this.assertTargetIdentity(currentFeed, game, homeTeamId, awayTeamId, homeStarterId, awayStarterId);
    const homeBattingOrder = battingOrder(currentFeed, "home");
    const awayBattingOrder = battingOrder(currentFeed, "away");
    if (!homeBattingOrder || !awayBattingOrder) {
      throw new Error(`C4_CERTIFIED_TARGET_LINEUP_INCOMPLETE:${game.gamePk}`);
    }

    const homeTeamHistory = snapshot.teamHistoryByTeam.get(homeTeamId) ?? [];
    const awayTeamHistory = snapshot.teamHistoryByTeam.get(awayTeamId) ?? [];
    const homePriorLineups = snapshot.lineupHistoryByTeam.get(homeTeamId) ?? [];
    const awayPriorLineups = snapshot.lineupHistoryByTeam.get(awayTeamId) ?? [];
    if (homePriorLineups.length !== homeTeamHistory.length) {
      throw new Error(`C4_CERTIFIED_HOME_LINEUP_HISTORY_INCOMPLETE:${game.gamePk}:${homePriorLineups.length}:${homeTeamHistory.length}`);
    }
    if (awayPriorLineups.length !== awayTeamHistory.length) {
      throw new Error(`C4_CERTIFIED_AWAY_LINEUP_HISTORY_INCOMPLETE:${game.gamePk}:${awayPriorLineups.length}:${awayTeamHistory.length}`);
    }

    return {
      officialDate: game.officialDate,
      gamePk: game.gamePk,
      homeTeamId,
      awayTeamId,
      homeTeamHistory,
      awayTeamHistory,
      leagueStarterHistory: snapshot.leagueStarterHistory,
      homeStarterHistory: snapshot.starterHistoryByPitcher.get(homeStarterId) ?? [],
      awayStarterHistory: snapshot.starterHistoryByPitcher.get(awayStarterId) ?? [],
      homeStarterId,
      awayStarterId,
      homePriorLineups,
      awayPriorLineups,
      homeBattingOrder,
      awayBattingOrder,
    };
  }

  private assertTargetIdentity(
    feed: any,
    game: MlbP1SlateGame,
    homeTeamId: number,
    awayTeamId: number,
    homeStarterId: number,
    awayStarterId: number,
  ): void {
    const feedPk = positiveInt(feed?.gamePk ?? feed?.gameData?.game?.pk) ?? game.gamePk;
    const feedDate = clean(feed?.gameData?.datetime?.officialDate);
    const feedHome = positiveInt(feed?.gameData?.teams?.home?.id);
    const feedAway = positiveInt(feed?.gameData?.teams?.away?.id);
    const feedHomeStarter = positiveInt(feed?.gameData?.probablePitchers?.home?.id);
    const feedAwayStarter = positiveInt(feed?.gameData?.probablePitchers?.away?.id);
    if (feedPk !== game.gamePk || feedDate !== game.officialDate || feedHome !== homeTeamId || feedAway !== awayTeamId) {
      throw new Error(`C4_CERTIFIED_TARGET_IDENTITY_MISMATCH:${game.gamePk}`);
    }
    if (feedHomeStarter !== homeStarterId || feedAwayStarter !== awayStarterId) {
      throw new Error(`C4_CERTIFIED_TARGET_STARTER_IDENTITY_MISMATCH:${game.gamePk}`);
    }
  }

  private getHistoricalSnapshot(season: number, cutoffDate: string): Promise<HistoricalSnapshot> {
    const key = `${season}:${cutoffDate}`;
    const cached = this.snapshotCache.get(key);
    if (cached) return cached;
    const promise = this.buildHistoricalSnapshot(season, cutoffDate).catch((error) => {
      this.snapshotCache.delete(key);
      throw error;
    });
    this.snapshotCache.set(key, promise);
    return promise;
  }

  private async buildHistoricalSnapshot(season: number, cutoffDate: string): Promise<HistoricalSnapshot> {
    const endDate = previousIsoDate(cutoffDate);
    const startDate = `${season}-03-01`;
    const url = `${this.apiBaseUrl}/v1/schedule?sportId=1&gameType=R&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
    const schedule = await this.fetchJson(url, "C4 season schedule");
    const identities: ScheduledGameIdentity[] = [];
    for (const dateEntry of Array.isArray(schedule?.dates) ? schedule.dates : []) {
      for (const raw of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
        const gamePk = positiveInt(raw?.gamePk);
        const officialDate = clean(raw?.officialDate ?? dateEntry?.date);
        if (!gamePk || !validIsoDate(officialDate) || officialDate >= cutoffDate || officialDate.slice(0, 4) !== String(season)) continue;
        if (!isFinalStatus(raw?.status)) continue;
        identities.push({ gamePk, officialDate });
      }
    }
    identities.sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    const unique = identities.filter((entry, index) => index === 0 || entry.gamePk !== identities[index - 1].gamePk);
    if (unique.length === 0) throw new Error(`C4_CERTIFIED_NO_PRIOR_FINAL_GAMES:${cutoffDate}`);

    const parsed = await mapConcurrent(unique, this.maxConcurrency, async (identity) =>
      parseHistoricalGame(await this.fetchGameFeed(identity.gamePk), identity),
    );

    const teamHistoryByTeam = new Map<number, C4PriorTeamGame[]>();
    const lineupHistoryByTeam = new Map<number, C4PriorLineupSnapshot[]>();
    const starterHistoryByPitcher = new Map<number, MlbFull13PriorPitcherLine[]>();
    const leagueStarterHistory: MlbFull13PriorPitcherLine[] = [];

    for (const game of parsed) {
      append(teamHistoryByTeam, game.homeTeamId, {
        officialDate: game.officialDate,
        gamePk: game.gamePk,
        runsFor: game.homeRuns,
        runsAgainst: game.awayRuns,
      });
      append(teamHistoryByTeam, game.awayTeamId, {
        officialDate: game.officialDate,
        gamePk: game.gamePk,
        runsFor: game.awayRuns,
        runsAgainst: game.homeRuns,
      });
      if (game.homeLineup) append(lineupHistoryByTeam, game.homeTeamId, {
        officialDate: game.officialDate,
        gamePk: game.gamePk,
        battingOrder: game.homeLineup,
      });
      if (game.awayLineup) append(lineupHistoryByTeam, game.awayTeamId, {
        officialDate: game.officialDate,
        gamePk: game.gamePk,
        battingOrder: game.awayLineup,
      });
      append(starterHistoryByPitcher, game.homeStarter.pitcherId, game.homeStarter);
      append(starterHistoryByPitcher, game.awayStarter.pitcherId, game.awayStarter);
      leagueStarterHistory.push(game.homeStarter, game.awayStarter);
    }

    return {
      season,
      cutoffDate,
      teamHistoryByTeam,
      lineupHistoryByTeam,
      starterHistoryByPitcher,
      leagueStarterHistory,
      priorGameCount: parsed.length,
    };
  }

  private fetchGameFeed(gamePk: number): Promise<any> {
    const cached = this.feedCache.get(gamePk);
    if (cached) return cached;
    const promise = this.fetchJson(`${this.apiBaseUrl}/v1.1/game/${gamePk}/feed/live`, `C4 game ${gamePk}`).catch((error) => {
      this.feedCache.delete(gamePk);
      throw error;
    });
    this.feedCache.set(gamePk, promise);
    return promise;
  }

  private async fetchJson(url: string, label: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`${label}:HTTP_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
