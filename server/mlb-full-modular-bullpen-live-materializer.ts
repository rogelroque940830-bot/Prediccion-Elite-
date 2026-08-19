import type { BullpenUsageGame } from "./mlb-full-modular-mechanistic-feature-builder";

export const MLB_FULL_MODULAR_BULLPEN_LIVE_MATERIALIZER_VERSION =
  "mlb-full-modular-bullpen-live-materializer-v1" as const;

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";
const LOOKBACK_DAYS = 30;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 8;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MlbFullModularBullpenLiveMaterializerOptions {
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
}

interface PriorGameIdentity {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
}

export interface MlbFullModularBullpenLiveEvidence {
  materializerVersion: typeof MLB_FULL_MODULAR_BULLPEN_LIVE_MATERIALIZER_VERSION;
  officialDate: string;
  homeHistory: BullpenUsageGame[];
  awayHistory: BullpenUsageGame[];
  provenance: {
    source: "MLB_STATS_SCHEDULE_AND_FINAL_BOXSCORE";
    rollingLookbackDays: 30;
    sameDateDataUsed: false;
    futureGameDataUsed: false;
    targetGameOutcomeUsed: false;
    historicalResearchStarterIdentity: "FROZEN_T5_PROBABLE_PITCHER";
    operationalStarterIdentity: "FINAL_BOXSCORE_FIRST_PITCHER";
    exactHistoricalStarterIdentityParityClaimed: false;
    bullpenPitchField: "pitchesThrown";
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
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function shiftIsoDate(value: string, days: number): string {
  if (!validIsoDate(value)) throw new Error(`FULL_MODULAR_BULLPEN_DATE_INVALID:${value}`);
  return new Date(Date.parse(`${value}T12:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function isFinalStatus(status: any): boolean {
  const abstract = clean(status?.abstractGameState).toLowerCase();
  const detailed = clean(status?.detailedState).toLowerCase();
  const coded = clean(status?.codedGameState).toUpperCase();
  return abstract === "final" || coded === "F" || /final|game over|completed early/.test(detailed);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
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

export class MlbFullModularBullpenLiveMaterializer {
  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly scheduleCache = new Map<string, Promise<PriorGameIdentity[]>>();
  private readonly boxscoreCache = new Map<number, Promise<any>>();

  constructor(options: MlbFullModularBullpenLiveMaterializerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = clean(options.apiBaseUrl) || MLB_API_BASE;
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxConcurrency = Math.max(1, Math.min(16, Math.floor(options.maxConcurrency ?? DEFAULT_CONCURRENCY)));
  }

  async materializeGame(input: {
    officialDate: string;
    homeTeamId: number;
    awayTeamId: number;
  }): Promise<MlbFullModularBullpenLiveEvidence> {
    if (!validIsoDate(input.officialDate)) throw new Error(`FULL_MODULAR_BULLPEN_TARGET_DATE_INVALID:${input.officialDate}`);
    if (!positiveInt(input.homeTeamId) || !positiveInt(input.awayTeamId) || input.homeTeamId === input.awayTeamId) {
      throw new Error("FULL_MODULAR_BULLPEN_TARGET_TEAM_INVALID");
    }
    const schedule = await this.priorFinalSchedule(input.officialDate);
    const relevant = schedule.filter((game) =>
      game.homeTeamId === input.homeTeamId
      || game.awayTeamId === input.homeTeamId
      || game.homeTeamId === input.awayTeamId
      || game.awayTeamId === input.awayTeamId,
    );
    const rows = await mapConcurrent(relevant, this.maxConcurrency, async (identity) => {
      const boxscore = await this.fetchBoxscore(identity.gamePk);
      return {
        identity,
        home: identity.homeTeamId === input.homeTeamId || identity.awayTeamId === input.homeTeamId
          ? this.parseTeamHistoryRow(identity, boxscore, input.homeTeamId)
          : null,
        away: identity.homeTeamId === input.awayTeamId || identity.awayTeamId === input.awayTeamId
          ? this.parseTeamHistoryRow(identity, boxscore, input.awayTeamId)
          : null,
      };
    });
    const homeHistory = rows.flatMap((row) => row.home ? [row.home] : [])
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate));
    const awayHistory = rows.flatMap((row) => row.away ? [row.away] : [])
      .sort((a, b) => a.officialDate.localeCompare(b.officialDate));
    return Object.freeze({
      materializerVersion: MLB_FULL_MODULAR_BULLPEN_LIVE_MATERIALIZER_VERSION,
      officialDate: input.officialDate,
      homeHistory,
      awayHistory,
      provenance: Object.freeze({
        source: "MLB_STATS_SCHEDULE_AND_FINAL_BOXSCORE" as const,
        rollingLookbackDays: LOOKBACK_DAYS as 30,
        sameDateDataUsed: false as const,
        futureGameDataUsed: false as const,
        targetGameOutcomeUsed: false as const,
        historicalResearchStarterIdentity: "FROZEN_T5_PROBABLE_PITCHER" as const,
        operationalStarterIdentity: "FINAL_BOXSCORE_FIRST_PITCHER" as const,
        exactHistoricalStarterIdentityParityClaimed: false as const,
        bullpenPitchField: "pitchesThrown" as const,
      }),
    });
  }

  private priorFinalSchedule(targetDate: string): Promise<PriorGameIdentity[]> {
    const cached = this.scheduleCache.get(targetDate);
    if (cached) return cached;
    const promise = this.fetchPriorFinalSchedule(targetDate).catch((error) => {
      this.scheduleCache.delete(targetDate);
      throw error;
    });
    this.scheduleCache.set(targetDate, promise);
    return promise;
  }

  private async fetchPriorFinalSchedule(targetDate: string): Promise<PriorGameIdentity[]> {
    const startDate = shiftIsoDate(targetDate, -LOOKBACK_DAYS);
    const endDate = shiftIsoDate(targetDate, -1);
    const url = `${this.apiBaseUrl}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}`;
    const payload = await this.fetchJson(url, "Full Modular bullpen schedule");
    if (!Array.isArray(payload?.dates)) throw new Error("FULL_MODULAR_BULLPEN_SCHEDULE_SHAPE_INVALID");
    const seen = new Set<number>();
    const games: PriorGameIdentity[] = [];
    for (const dateEntry of payload.dates) {
      const date = clean(dateEntry?.date);
      for (const raw of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
        if (!isFinalStatus(raw?.status)) continue;
        const gamePk = positiveInt(raw?.gamePk);
        const officialDate = clean(raw?.officialDate ?? date);
        const homeTeamId = positiveInt(raw?.teams?.home?.team?.id);
        const awayTeamId = positiveInt(raw?.teams?.away?.team?.id);
        if (!gamePk || !validIsoDate(officialDate) || officialDate >= targetDate || !homeTeamId || !awayTeamId) {
          throw new Error(`FULL_MODULAR_BULLPEN_SCHEDULE_GAME_INVALID:${String(raw?.gamePk ?? "missing")}`);
        }
        if (seen.has(gamePk)) continue;
        seen.add(gamePk);
        games.push({ gamePk, officialDate, homeTeamId, awayTeamId });
      }
    }
    games.sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    return games;
  }

  private parseTeamHistoryRow(identity: PriorGameIdentity, boxscore: any, teamId: number): BullpenUsageGame {
    const teams = boxscore?.teams;
    if (!teams) throw new Error(`FULL_MODULAR_BULLPEN_BOXSCORE_SHAPE_INVALID:${identity.gamePk}`);
    let teamBlob: any = null;
    for (const side of ["home", "away"] as const) {
      if (positiveInt(teams?.[side]?.team?.id) === teamId) {
        teamBlob = teams[side];
        break;
      }
    }
    if (!teamBlob) throw new Error(`FULL_MODULAR_BULLPEN_TEAM_NOT_FOUND:${identity.gamePk}:${teamId}`);
    const pitchers = Array.isArray(teamBlob.pitchers)
      ? teamBlob.pitchers.map(positiveInt).filter((value: number | null): value is number => value !== null)
      : [];
    if (pitchers.length === 0) throw new Error(`FULL_MODULAR_BULLPEN_PITCHERS_MISSING:${identity.gamePk}:${teamId}`);
    const players = teamBlob.players ?? {};
    const relievers: Record<string, number> = {};
    for (const pitcherId of pitchers.slice(1)) {
      const pitches = nonNegativeInt(players?.[`ID${pitcherId}`]?.stats?.pitching?.pitchesThrown);
      if (pitches === null) throw new Error(`FULL_MODULAR_BULLPEN_PITCH_COUNT_MISSING:${identity.gamePk}:${pitcherId}`);
      relievers[String(pitcherId)] = pitches;
    }
    return {
      officialDate: identity.officialDate,
      bullpenPitches: Object.values(relievers).reduce((sum, pitches) => sum + pitches, 0),
      relievers,
    };
  }

  private fetchBoxscore(gamePk: number): Promise<any> {
    const cached = this.boxscoreCache.get(gamePk);
    if (cached) return cached;
    const promise = this.fetchJson(`${this.apiBaseUrl}/game/${gamePk}/boxscore`, `Full Modular bullpen game ${gamePk}`).catch((error) => {
      this.boxscoreCache.delete(gamePk);
      throw error;
    });
    this.boxscoreCache.set(gamePk, promise);
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
