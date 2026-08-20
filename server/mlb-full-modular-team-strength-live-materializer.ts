import type { MlbFullModularStrengthTier } from "./mlb-full-modular-frozen-live-scorer-v1";

export const MLB_FULL_MODULAR_TEAM_STRENGTH_LIVE_MATERIALIZER_VERSION =
  "mlb-full-modular-team-strength-live-materializer-v1" as const;

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";
const MLB_LIVE_API_BASE = "https://statsapi.mlb.com/api/v1.1";
const MINIMUM_PRIOR_GAMES_FOR_STABLE_TIER = 20;
const DEFAULT_TIMEOUT_MS = 12_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface TeamRecord {
  games: number;
  wins: number;
  runsFor: number;
  runsAgainst: number;
}

interface FinalRegularSeasonGame {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  homeRuns: number;
  awayRuns: number;
}

export interface MlbFullModularTeamStrengthLiveMaterializerOptions {
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
  liveApiBaseUrl?: string;
  timeoutMs?: number;
}

export interface MlbFullModularTeamStrengthSnapshot {
  materializerVersion: typeof MLB_FULL_MODULAR_TEAM_STRENGTH_LIVE_MATERIALIZER_VERSION;
  officialDate: string;
  tiers: Readonly<Record<number, MlbFullModularStrengthTier>>;
  priorGames: Readonly<Record<number, number>>;
  provenance: {
    source: "MLB_STATS_PRIOR_FINAL_REGULAR_SEASON_SCHEDULE";
    structuralRecovery: "MLB_OFFICIAL_LIVE_FEED_FOR_INVALID_FINAL_SCHEDULE_ROWS";
    cutoff: "PREVIOUS_CALENDAR_DATE_ONLY";
    minimumPriorGamesForStableTier: 20;
    ranking: "WIN_PCT_DESC_RUN_DIFF_PER_GAME_DESC_TEAM_ID_ASC";
    stableTierGeometry: "TOP_THIRD_STRONG_MIDDLE_THIRD_MIDDLE_BOTTOM_THIRD_WEAK";
    sameDateOutcomesUsed: false;
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || clean(value) === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function previousIsoDate(value: string): string {
  if (!validIsoDate(value)) throw new Error(`FULL_MODULAR_STRENGTH_DATE_INVALID:${value}`);
  return new Date(Date.parse(`${value}T12:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

function isFinalStatus(status: any): boolean {
  const abstract = clean(status?.abstractGameState).toLowerCase();
  const detailed = clean(status?.detailedState).toLowerCase();
  const coded = clean(status?.codedGameState).toUpperCase();
  return abstract === "final" || coded === "F" || /final|game over|completed early/.test(detailed);
}

function getRecord(records: Map<number, TeamRecord>, teamId: number): TeamRecord {
  const existing = records.get(teamId);
  if (existing) return existing;
  const created = { games: 0, wins: 0, runsFor: 0, runsAgainst: 0 };
  records.set(teamId, created);
  return created;
}

function validFinalGame(
  game: FinalRegularSeasonGame,
  targetOfficialDate: string,
  season: string,
): boolean {
  return Number.isInteger(game.gamePk) && game.gamePk > 0
    && validIsoDate(game.officialDate)
    && game.officialDate < targetOfficialDate
    && game.officialDate.slice(0, 4) === season
    && Number.isInteger(game.homeTeamId) && game.homeTeamId > 0
    && Number.isInteger(game.awayTeamId) && game.awayTeamId > 0
    && game.homeTeamId !== game.awayTeamId
    && Number.isInteger(game.homeRuns) && game.homeRuns >= 0
    && Number.isInteger(game.awayRuns) && game.awayRuns >= 0
    && game.homeRuns !== game.awayRuns;
}

function scheduleFinalGame(
  raw: any,
  dateEntryDate: unknown,
  targetOfficialDate: string,
  season: string,
): FinalRegularSeasonGame | null {
  const gamePk = positiveInt(raw?.gamePk);
  const officialDate = clean(raw?.officialDate ?? dateEntryDate);
  const homeTeamId = positiveInt(raw?.teams?.home?.team?.id);
  const awayTeamId = positiveInt(raw?.teams?.away?.team?.id);
  const homeRuns = nonNegativeInt(raw?.teams?.home?.score);
  const awayRuns = nonNegativeInt(raw?.teams?.away?.score);
  if (!gamePk || !homeTeamId || !awayTeamId || homeRuns === null || awayRuns === null) return null;
  const candidate: FinalRegularSeasonGame = {
    gamePk,
    officialDate,
    homeTeamId,
    awayTeamId,
    homeRuns,
    awayRuns,
  };
  return validFinalGame(candidate, targetOfficialDate, season) ? candidate : null;
}

export class MlbFullModularTeamStrengthLiveMaterializer {
  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly liveApiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, Promise<MlbFullModularTeamStrengthSnapshot>>();
  private readonly liveFeedCache = new Map<number, Promise<any>>();

  constructor(options: MlbFullModularTeamStrengthLiveMaterializerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = clean(options.apiBaseUrl) || MLB_API_BASE;
    this.liveApiBaseUrl = clean(options.liveApiBaseUrl) || MLB_LIVE_API_BASE;
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  }

  materializeDate(officialDate: string): Promise<MlbFullModularTeamStrengthSnapshot> {
    const cached = this.cache.get(officialDate);
    if (cached) return cached;
    const promise = this.buildSnapshot(officialDate).catch((error) => {
      this.cache.delete(officialDate);
      throw error;
    });
    this.cache.set(officialDate, promise);
    return promise;
  }

  private async buildSnapshot(officialDate: string): Promise<MlbFullModularTeamStrengthSnapshot> {
    if (!validIsoDate(officialDate)) throw new Error(`FULL_MODULAR_STRENGTH_TARGET_DATE_INVALID:${officialDate}`);
    const season = officialDate.slice(0, 4);
    const startDate = `${season}-03-01`;
    const endDate = previousIsoDate(officialDate);
    const url = `${this.apiBaseUrl}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}`;
    const payload = await this.fetchJson(url, "Full Modular team strength schedule");
    if (!Array.isArray(payload?.dates)) throw new Error("FULL_MODULAR_STRENGTH_SCHEDULE_SHAPE_INVALID");
    const records = new Map<number, TeamRecord>();
    const seen = new Set<number>();
    for (const dateEntry of payload.dates) {
      for (const raw of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
        if (!isFinalStatus(raw?.status)) continue;
        const gamePk = positiveInt(raw?.gamePk);
        if (!gamePk) throw new Error("FULL_MODULAR_STRENGTH_GAME_PK_MISSING");
        if (seen.has(gamePk)) continue;

        let game = scheduleFinalGame(raw, dateEntry?.date, officialDate, season);
        if (!game) {
          game = await this.recoverOfficialFinalGame({
            gamePk,
            raw,
            dateEntryDate: dateEntry?.date,
            targetOfficialDate: officialDate,
            season,
          });
        }
        seen.add(gamePk);
        const home = getRecord(records, game.homeTeamId);
        const away = getRecord(records, game.awayTeamId);
        home.games += 1;
        away.games += 1;
        home.runsFor += game.homeRuns;
        home.runsAgainst += game.awayRuns;
        away.runsFor += game.awayRuns;
        away.runsAgainst += game.homeRuns;
        if (game.homeRuns > game.awayRuns) home.wins += 1;
        else away.wins += 1;
      }
    }

    const stable = [...records.entries()]
      .filter(([, record]) => record.games >= MINIMUM_PRIOR_GAMES_FOR_STABLE_TIER)
      .map(([teamId, record]) => ({
        teamId,
        winPct: record.wins / record.games,
        runDiffPerGame: (record.runsFor - record.runsAgainst) / record.games,
      }))
      .sort((a, b) =>
        b.winPct - a.winPct
        || b.runDiffPerGame - a.runDiffPerGame
        || a.teamId - b.teamId,
      );

    const stableTier = new Map<number, MlbFullModularStrengthTier>();
    for (let index = 0; index < stable.length; index += 1) {
      const fraction = stable.length ? index / stable.length : 1;
      const tier: MlbFullModularStrengthTier = fraction < 1 / 3
        ? "STRONG"
        : fraction < 2 / 3
          ? "MIDDLE"
          : "WEAK";
      stableTier.set(stable[index].teamId, tier);
    }

    const tiers: Record<number, MlbFullModularStrengthTier> = {};
    const priorGames: Record<number, number> = {};
    for (const [teamId, record] of records.entries()) {
      priorGames[teamId] = record.games;
      tiers[teamId] = record.games >= MINIMUM_PRIOR_GAMES_FOR_STABLE_TIER
        ? (stableTier.get(teamId) ?? "UNSTABLE")
        : "UNSTABLE";
    }

    return Object.freeze({
      materializerVersion: MLB_FULL_MODULAR_TEAM_STRENGTH_LIVE_MATERIALIZER_VERSION,
      officialDate,
      tiers: Object.freeze(tiers),
      priorGames: Object.freeze(priorGames),
      provenance: Object.freeze({
        source: "MLB_STATS_PRIOR_FINAL_REGULAR_SEASON_SCHEDULE" as const,
        structuralRecovery: "MLB_OFFICIAL_LIVE_FEED_FOR_INVALID_FINAL_SCHEDULE_ROWS" as const,
        cutoff: "PREVIOUS_CALENDAR_DATE_ONLY" as const,
        minimumPriorGamesForStableTier: MINIMUM_PRIOR_GAMES_FOR_STABLE_TIER as 20,
        ranking: "WIN_PCT_DESC_RUN_DIFF_PER_GAME_DESC_TEAM_ID_ASC" as const,
        stableTierGeometry: "TOP_THIRD_STRONG_MIDDLE_THIRD_MIDDLE_BOTTOM_THIRD_WEAK" as const,
        sameDateOutcomesUsed: false as const,
      }),
    });
  }

  private async recoverOfficialFinalGame(input: {
    gamePk: number;
    raw: any;
    dateEntryDate: unknown;
    targetOfficialDate: string;
    season: string;
  }): Promise<FinalRegularSeasonGame> {
    const feed = await this.fetchLiveFeed(input.gamePk);
    const feedPk = positiveInt(feed?.gamePk ?? feed?.gameData?.game?.pk);
    const feedType = clean(feed?.gameData?.game?.type).toUpperCase();
    const officialDate = clean(feed?.gameData?.datetime?.officialDate);
    const homeTeamId = positiveInt(feed?.gameData?.teams?.home?.id);
    const awayTeamId = positiveInt(feed?.gameData?.teams?.away?.id);
    const homeRuns = nonNegativeInt(feed?.liveData?.linescore?.teams?.home?.runs);
    const awayRuns = nonNegativeInt(feed?.liveData?.linescore?.teams?.away?.runs);
    if (feedPk !== input.gamePk) {
      throw new Error(`FULL_MODULAR_STRENGTH_LIVE_FEED_GAME_ID_MISMATCH:${input.gamePk}:${String(feedPk ?? "missing")}`);
    }
    if (!isFinalStatus(feed?.gameData?.status)) {
      throw new Error(`FULL_MODULAR_STRENGTH_LIVE_FEED_NOT_FINAL:${input.gamePk}`);
    }
    if (feedType && feedType !== "R") {
      throw new Error(`FULL_MODULAR_STRENGTH_LIVE_FEED_NOT_REGULAR_SEASON:${input.gamePk}:${feedType}`);
    }
    if (!homeTeamId || !awayTeamId || homeRuns === null || awayRuns === null) {
      throw new Error(`FULL_MODULAR_STRENGTH_LIVE_FEED_RESULT_INCOMPLETE:${input.gamePk}`);
    }

    const scheduleHome = positiveInt(input.raw?.teams?.home?.team?.id);
    const scheduleAway = positiveInt(input.raw?.teams?.away?.team?.id);
    if ((scheduleHome && scheduleHome !== homeTeamId) || (scheduleAway && scheduleAway !== awayTeamId)) {
      throw new Error(`FULL_MODULAR_STRENGTH_SOURCE_TEAM_CONFLICT:${input.gamePk}`);
    }
    const scheduleDate = clean(input.raw?.officialDate ?? input.dateEntryDate);
    if (validIsoDate(scheduleDate) && scheduleDate !== officialDate) {
      throw new Error(`FULL_MODULAR_STRENGTH_SOURCE_DATE_CONFLICT:${input.gamePk}:${scheduleDate}:${officialDate}`);
    }

    const recovered: FinalRegularSeasonGame = {
      gamePk: input.gamePk,
      officialDate,
      homeTeamId,
      awayTeamId,
      homeRuns,
      awayRuns,
    };
    if (!validFinalGame(recovered, input.targetOfficialDate, input.season)) {
      throw new Error(`FULL_MODULAR_STRENGTH_LIVE_FEED_GAME_INVALID:${input.gamePk}`);
    }
    return recovered;
  }

  private fetchLiveFeed(gamePk: number): Promise<any> {
    const cached = this.liveFeedCache.get(gamePk);
    if (cached) return cached;
    const promise = this.fetchJson(
      `${this.liveApiBaseUrl}/game/${gamePk}/feed/live`,
      `Full Modular team strength live feed ${gamePk}`,
    ).catch((error) => {
      this.liveFeedCache.delete(gamePk);
      throw error;
    });
    this.liveFeedCache.set(gamePk, promise);
    return promise;
  }

  private async fetchJson(url: string, label: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`${label}:HTTP_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}