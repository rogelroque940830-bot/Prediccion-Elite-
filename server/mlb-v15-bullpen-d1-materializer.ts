export const MLB_V15_BULLPEN_D1_EVIDENCE_SCHEMA =
  "courtedge-p0-mlb-v15-bullpen-d1-evidence.v1" as const;

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1";
const LOOKBACK_DAYS = 30;
const MIN_PRIOR_GAMES = 3;
const MIN_RELIEVER_POOL = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CONCURRENCY = 8;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MlbV15BullpenD1MaterializerOptions {
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
}

export interface MlbV15BullpenD1TeamProfile {
  teamId: number;
  priorGames30d: number;
  relieverPool: number;
  pitches1d: number;
  eligible: boolean;
  finalGamesVerified: number;
  boxscoresVerified: number;
}

export interface MlbV15BullpenD1Evidence {
  schemaVersion: typeof MLB_V15_BULLPEN_D1_EVIDENCE_SCHEMA;
  gamePk: number;
  officialDate: string;
  generatedAt: string;
  home: MlbV15BullpenD1TeamProfile;
  away: MlbV15BullpenD1TeamProfile;
  bullpenPitches1dAdv: number;
  eligible: boolean;
  provenance: {
    status: "CERTIFIED_PROSPECTIVE_OPERATIONAL";
    source: "MLB_STATS_SCHEDULE_AND_FINAL_BOXSCORE";
    rollingLookbackDays: 30;
    minimumPriorBullpenGames30dPerTeam: 3;
    minimumRelieverPool: 3;
    priorDayDefinition: "OFFICIAL_DATE_EXACTLY_D_MINUS_1";
    positiveConvention: "AWAY_MINUS_HOME_POSITIVE_FAVORS_HOME_FRESHNESS";
    historicalResearchStarterIdentity: "FROZEN_T5_PROBABLE_PITCHER";
    operationalStarterIdentity: "FINAL_BOXSCORE_FIRST_PITCHER";
    exactHistoricalStarterIdentityParityClaimed: false;
    sameDateDataUsed: false;
    futureGameDataUsed: false;
    targetGameOutcomeUsed: false;
    thresholdSearchUsed: false;
    failureDisposition: "THROW_FAIL_CLOSED";
  };
}

interface PriorGameIdentity {
  gamePk: number;
  officialDate: string;
}

interface PriorGameBullpen {
  gamePk: number;
  officialDate: string;
  relievers: ReadonlyArray<{ pitcherId: number; pitches: number }>;
  bullpenPitches: number;
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
  if (!validIsoDate(value)) throw new Error(`MLB_V15_D1_DATE_INVALID:${value}`);
  const parsed = Date.parse(`${value}T12:00:00.000Z`) + days * 86_400_000;
  return new Date(parsed).toISOString().slice(0, 10);
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

export class MlbV15BullpenD1Materializer {
  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly boxscoreCache = new Map<number, Promise<any>>();

  constructor(options: MlbV15BullpenD1MaterializerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = clean(options.apiBaseUrl) || MLB_API_BASE;
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxConcurrency = Math.max(1, Math.min(16, Math.floor(options.maxConcurrency ?? DEFAULT_CONCURRENCY)));
  }

  async assessGame(input: {
    gamePk: number;
    officialDate: string;
    homeTeamId: number;
    awayTeamId: number;
    now?: Date;
  }): Promise<MlbV15BullpenD1Evidence> {
    const gamePk = positiveInt(input.gamePk);
    const homeTeamId = positiveInt(input.homeTeamId);
    const awayTeamId = positiveInt(input.awayTeamId);
    if (!gamePk) throw new Error("MLB_V15_D1_TARGET_GAME_PK_INVALID");
    if (!validIsoDate(input.officialDate)) throw new Error(`MLB_V15_D1_TARGET_DATE_INVALID:${input.officialDate}`);
    if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) {
      throw new Error(`MLB_V15_D1_TARGET_TEAM_ID_INVALID:${gamePk}`);
    }
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("MLB_V15_D1_NOW_INVALID");

    const [home, away] = await Promise.all([
      this.teamProfile(homeTeamId, input.officialDate),
      this.teamProfile(awayTeamId, input.officialDate),
    ]);

    return Object.freeze({
      schemaVersion: MLB_V15_BULLPEN_D1_EVIDENCE_SCHEMA,
      gamePk,
      officialDate: input.officialDate,
      generatedAt: now.toISOString(),
      home: Object.freeze(home),
      away: Object.freeze(away),
      bullpenPitches1dAdv: away.pitches1d - home.pitches1d,
      eligible: home.eligible && away.eligible,
      provenance: Object.freeze({
        status: "CERTIFIED_PROSPECTIVE_OPERATIONAL" as const,
        source: "MLB_STATS_SCHEDULE_AND_FINAL_BOXSCORE" as const,
        rollingLookbackDays: LOOKBACK_DAYS as 30,
        minimumPriorBullpenGames30dPerTeam: MIN_PRIOR_GAMES as 3,
        minimumRelieverPool: MIN_RELIEVER_POOL as 3,
        priorDayDefinition: "OFFICIAL_DATE_EXACTLY_D_MINUS_1" as const,
        positiveConvention: "AWAY_MINUS_HOME_POSITIVE_FAVORS_HOME_FRESHNESS" as const,
        historicalResearchStarterIdentity: "FROZEN_T5_PROBABLE_PITCHER" as const,
        operationalStarterIdentity: "FINAL_BOXSCORE_FIRST_PITCHER" as const,
        exactHistoricalStarterIdentityParityClaimed: false as const,
        sameDateDataUsed: false as const,
        futureGameDataUsed: false as const,
        targetGameOutcomeUsed: false as const,
        thresholdSearchUsed: false as const,
        failureDisposition: "THROW_FAIL_CLOSED" as const,
      }),
    });
  }

  private async teamProfile(teamId: number, targetDate: string): Promise<MlbV15BullpenD1TeamProfile> {
    const identities = await this.priorFinalGames(teamId, targetDate);
    const games = await mapConcurrent(identities, this.maxConcurrency, async (identity) =>
      this.readTeamBullpen(identity, teamId),
    );
    const relieverIds = new Set<number>();
    for (const game of games) {
      for (const reliever of game.relievers) relieverIds.add(reliever.pitcherId);
    }
    const d1 = shiftIsoDate(targetDate, -1);
    const pitches1d = games
      .filter((game) => game.officialDate === d1)
      .reduce((sum, game) => sum + game.bullpenPitches, 0);
    return {
      teamId,
      priorGames30d: games.length,
      relieverPool: relieverIds.size,
      pitches1d,
      eligible: games.length >= MIN_PRIOR_GAMES && relieverIds.size >= MIN_RELIEVER_POOL,
      finalGamesVerified: identities.length,
      boxscoresVerified: games.length,
    };
  }

  private async priorFinalGames(teamId: number, targetDate: string): Promise<PriorGameIdentity[]> {
    const startDate = shiftIsoDate(targetDate, -LOOKBACK_DAYS);
    const endDate = shiftIsoDate(targetDate, -1);
    const url = `${this.apiBaseUrl}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}`;
    const payload = await this.fetchJson(url, `MLB V15 D1 schedule ${teamId}`);
    if (!Array.isArray(payload?.dates)) throw new Error(`MLB_V15_D1_SCHEDULE_SHAPE_INVALID:${teamId}`);
    const games: PriorGameIdentity[] = [];
    const seen = new Set<number>();
    for (const dateEntry of payload.dates) {
      const officialDate = clean(dateEntry?.date);
      if (!validIsoDate(officialDate) || officialDate >= targetDate) continue;
      for (const raw of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
        if (!isFinalStatus(raw?.status)) continue;
        const gamePk = positiveInt(raw?.gamePk);
        if (!gamePk) throw new Error(`MLB_V15_D1_PRIOR_GAME_PK_INVALID:${teamId}`);
        if (seen.has(gamePk)) continue;
        seen.add(gamePk);
        games.push({ gamePk, officialDate });
      }
    }
    games.sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    return games;
  }

  private async readTeamBullpen(identity: PriorGameIdentity, teamId: number): Promise<PriorGameBullpen> {
    const boxscore = await this.fetchBoxscore(identity.gamePk);
    const teams = boxscore?.teams;
    if (!teams) throw new Error(`MLB_V15_D1_BOXSCORE_SHAPE_INVALID:${identity.gamePk}`);
    let teamBlob: any = null;
    for (const side of ["home", "away"] as const) {
      if (positiveInt(teams?.[side]?.team?.id) === teamId) {
        teamBlob = teams[side];
        break;
      }
    }
    if (!teamBlob) throw new Error(`MLB_V15_D1_TEAM_NOT_IN_BOXSCORE:${identity.gamePk}:${teamId}`);
    const pitcherIds = Array.isArray(teamBlob.pitchers)
      ? teamBlob.pitchers.map(positiveInt).filter((id: number | null): id is number => id !== null)
      : [];
    if (pitcherIds.length === 0) throw new Error(`MLB_V15_D1_PITCHERS_MISSING:${identity.gamePk}:${teamId}`);

    const operationalStarterId = pitcherIds[0];
    const players = teamBlob.players ?? {};
    const relievers = pitcherIds.slice(1).map((pitcherId) => {
      const pitching = players[`ID${pitcherId}`]?.stats?.pitching;
      const pitches = nonNegativeInt(pitching?.pitchesThrown);
      if (pitches === null) throw new Error(`MLB_V15_D1_PITCH_COUNT_MISSING:${identity.gamePk}:${pitcherId}`);
      return { pitcherId, pitches };
    });
    if (!positiveInt(operationalStarterId)) throw new Error(`MLB_V15_D1_STARTER_INVALID:${identity.gamePk}:${teamId}`);
    return {
      gamePk: identity.gamePk,
      officialDate: identity.officialDate,
      relievers: Object.freeze(relievers),
      bullpenPitches: relievers.reduce((sum, reliever) => sum + reliever.pitches, 0),
    };
  }

  private fetchBoxscore(gamePk: number): Promise<any> {
    const cached = this.boxscoreCache.get(gamePk);
    if (cached) return cached;
    const promise = this.fetchJson(`${this.apiBaseUrl}/game/${gamePk}/boxscore`, `MLB V15 D1 boxscore ${gamePk}`)
      .catch((error) => {
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
      try {
        return await response.json();
      } catch {
        throw new Error(`${label}:INVALID_JSON`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`${label}:TIMEOUT`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
