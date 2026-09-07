import {
  buildC4LiveFeatures,
  type C4LiveFeatureAssessment,
  type C4PriorLineupSnapshot,
  type C4PriorPitcherLine,
  type C4PriorTeamGame,
} from "./mlb-c4-live-feature-builder";
import {
  adaptCertifiedFinalC4ToR1bV16Baseline,
  type MlbR1bV16BaselineRow,
} from "./mlb-r1b-v16-final-baseline-adapter";
import type { MlbR1bV16HistoricalTargetInput } from "./mlb-r1b-v16-historical-target-bridge";

export const MLB_R1B_V16_HISTORICAL_BATCH_SCHEMA =
  "courtedge-mlb-r1b-v16-historical-batch-materializer.v1" as const;

const DEFAULT_API_BASE_URL = "https://statsapi.mlb.com/api";
const DEFAULT_CONCURRENCY = 18;
const DEFAULT_TIMEOUT_MS = 20_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
  homeStarter: C4PriorPitcherLine;
  awayStarter: C4PriorPitcherLine;
}

export interface MlbR1bV16HistoricalBatchTargetResult {
  officialDate: string;
  gamePk: number;
  assessment: C4LiveFeatureAssessment;
  rows: readonly MlbR1bV16BaselineRow[];
  provenance: {
    lineupArtifactSha256: string;
    starterArtifactSha256: string;
    requestedTimecode: string;
    generatedAt: string;
    targetIdentitySource: "FROZEN_T5_ONLY";
    externalTargetFeedRead: false;
    targetOutcomeUsedAsFeature: false;
    marketPricesRead: false;
  };
}

export interface MlbR1bV16HistoricalBatchResult {
  schemaVersion: typeof MLB_R1B_V16_HISTORICAL_BATCH_SCHEMA;
  season: number;
  source: {
    scheduleFetchedOnce: true;
    priorFinalFeedCount: number;
    priorFinalFeedsFetchedOnceEach: true;
    maxTargetDate: string;
  };
  targets: readonly MlbR1bV16HistoricalBatchTargetResult[];
  policy: typeof MLB_R1B_V16_HISTORICAL_BATCH_POLICY;
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
  if (!validIsoDate(value)) throw new Error(`MLB_R1B_V16_BATCH_INVALID_DATE:${value}`);
  return new Date(Date.parse(`${value}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

function validTimecode(value: string): boolean {
  return /^\d{8}_\d{6}$/.test(value);
}

function timecodeToIso(value: string): string {
  if (!validTimecode(value)) throw new Error("MLB_R1B_V16_BATCH_TIMECODE_INVALID");
  const compact = value.replace("_", "");
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(8, 10)}:${compact.slice(10, 12)}:${compact.slice(12, 14)}.000Z`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error("MLB_R1B_V16_BATCH_TIMECODE_INVALID");
  return iso;
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

function starterLine(feed: any, side: "home" | "away", officialDate: string, gamePk: number): C4PriorPitcherLine {
  const pitchers = feed?.liveData?.boxscore?.teams?.[side]?.pitchers;
  const pitcherId = Array.isArray(pitchers) ? positiveInt(pitchers[0]) : null;
  if (!pitcherId) throw new Error(`MLB_R1B_V16_BATCH_STARTER_MISSING:${gamePk}:${side}`);
  const pitching = feed?.liveData?.boxscore?.teams?.[side]?.players?.[`ID${pitcherId}`]?.stats?.pitching;
  const battersFaced = nonNegativeFinite(pitching?.battersFaced);
  const strikeOuts = nonNegativeFinite(pitching?.strikeOuts);
  const baseOnBalls = nonNegativeFinite(pitching?.baseOnBalls);
  if (battersFaced === null || strikeOuts === null || baseOnBalls === null) {
    throw new Error(`MLB_R1B_V16_BATCH_STARTER_STATS_MISSING:${gamePk}:${side}:${pitcherId}`);
  }
  return { officialDate, gamePk, pitcherId, battersFaced, strikeOuts, baseOnBalls };
}

function parseHistoricalGame(feed: any, expected: ScheduledGameIdentity): ParsedHistoricalGame {
  const gamePk = positiveInt(feed?.gamePk ?? feed?.gameData?.game?.pk) ?? expected.gamePk;
  if (gamePk !== expected.gamePk) throw new Error(`MLB_R1B_V16_BATCH_GAME_ID_MISMATCH:${expected.gamePk}:${gamePk}`);
  const officialDate = clean(feed?.gameData?.datetime?.officialDate) || expected.officialDate;
  if (officialDate !== expected.officialDate) {
    throw new Error(`MLB_R1B_V16_BATCH_GAME_DATE_MISMATCH:${gamePk}:${expected.officialDate}:${officialDate}`);
  }
  if (!isFinalStatus(feed?.gameData?.status)) throw new Error(`MLB_R1B_V16_BATCH_GAME_NOT_FINAL:${gamePk}`);

  const homeTeamId = positiveInt(feed?.gameData?.teams?.home?.id);
  const awayTeamId = positiveInt(feed?.gameData?.teams?.away?.id);
  const homeRuns = nonNegativeFinite(feed?.liveData?.linescore?.teams?.home?.runs);
  const awayRuns = nonNegativeFinite(feed?.liveData?.linescore?.teams?.away?.runs);
  if (!homeTeamId || !awayTeamId || homeRuns === null || awayRuns === null) {
    throw new Error(`MLB_R1B_V16_BATCH_GAME_RESULT_INCOMPLETE:${gamePk}`);
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

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await work(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

function validateOrder(order: readonly number[], label: string): void {
  if (!Array.isArray(order) || order.length !== 9 || !order.every((id) => positiveInt(id) !== null) || new Set(order).size !== 9) {
    throw new Error(`MLB_R1B_V16_BATCH_LINEUP_INVALID:${label}`);
  }
}

function validateTarget(target: MlbR1bV16HistoricalTargetInput, season: number): void {
  const { lineup, starter } = target;
  if (!validIsoDate(lineup.officialDate) || lineup.officialDate.slice(0, 4) !== String(season)) {
    throw new Error(`MLB_R1B_V16_BATCH_TARGET_DATE_INVALID:${lineup.gamePk}`);
  }
  if (lineup.complete !== true || lineup.availability !== "COMPLETE" || starter.usable !== true || starter.reason !== null) {
    throw new Error(`MLB_R1B_V16_BATCH_TARGET_CUSTODY_NOT_USABLE:${lineup.gamePk}`);
  }
  if (lineup.gamePk !== starter.gamePk || lineup.officialDate !== starter.officialDate
      || lineup.homeTeamId !== starter.homeTeamId || lineup.awayTeamId !== starter.awayTeamId
      || lineup.requestedTimecode !== starter.requestedTimecode) {
    throw new Error(`MLB_R1B_V16_BATCH_TARGET_IDENTITY_MISMATCH:${lineup.gamePk}`);
  }
  if (!positiveInt(lineup.gamePk) || !positiveInt(lineup.homeTeamId) || !positiveInt(lineup.awayTeamId)
      || !positiveInt(starter.homePitcherId) || !positiveInt(starter.awayPitcherId)) {
    throw new Error(`MLB_R1B_V16_BATCH_TARGET_ID_INVALID:${lineup.gamePk}`);
  }
  validateOrder(lineup.homeBattingOrder, `${lineup.gamePk}:HOME`);
  validateOrder(lineup.awayBattingOrder, `${lineup.gamePk}:AWAY`);
  if (!validTimecode(lineup.requestedTimecode)) throw new Error(`MLB_R1B_V16_BATCH_TARGET_TIMECODE_INVALID:${lineup.gamePk}`);
}

function historyForTarget(parsed: readonly ParsedHistoricalGame[], target: MlbR1bV16HistoricalTargetInput): {
  homeTeamHistory: C4PriorTeamGame[];
  awayTeamHistory: C4PriorTeamGame[];
  leagueStarterHistory: C4PriorPitcherLine[];
  homeStarterHistory: C4PriorPitcherLine[];
  awayStarterHistory: C4PriorPitcherLine[];
  homePriorLineups: C4PriorLineupSnapshot[];
  awayPriorLineups: C4PriorLineupSnapshot[];
} {
  const prior = parsed.filter((game) => game.officialDate < target.lineup.officialDate);
  const homeTeamHistory: C4PriorTeamGame[] = [];
  const awayTeamHistory: C4PriorTeamGame[] = [];
  const leagueStarterHistory: C4PriorPitcherLine[] = [];
  const homeStarterHistory: C4PriorPitcherLine[] = [];
  const awayStarterHistory: C4PriorPitcherLine[] = [];
  const homePriorLineups: C4PriorLineupSnapshot[] = [];
  const awayPriorLineups: C4PriorLineupSnapshot[] = [];

  for (const game of prior) {
    leagueStarterHistory.push(game.homeStarter, game.awayStarter);
    if (game.homeStarter.pitcherId === target.starter.homePitcherId) homeStarterHistory.push(game.homeStarter);
    if (game.awayStarter.pitcherId === target.starter.homePitcherId) homeStarterHistory.push(game.awayStarter);
    if (game.homeStarter.pitcherId === target.starter.awayPitcherId) awayStarterHistory.push(game.homeStarter);
    if (game.awayStarter.pitcherId === target.starter.awayPitcherId) awayStarterHistory.push(game.awayStarter);

    if (game.homeTeamId === target.lineup.homeTeamId) {
      homeTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.homeRuns, runsAgainst: game.awayRuns });
      if (game.homeLineup) homePriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.homeLineup });
    } else if (game.awayTeamId === target.lineup.homeTeamId) {
      homeTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.awayRuns, runsAgainst: game.homeRuns });
      if (game.awayLineup) homePriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.awayLineup });
    }

    if (game.homeTeamId === target.lineup.awayTeamId) {
      awayTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.homeRuns, runsAgainst: game.awayRuns });
      if (game.homeLineup) awayPriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.homeLineup });
    } else if (game.awayTeamId === target.lineup.awayTeamId) {
      awayTeamHistory.push({ officialDate: game.officialDate, gamePk: game.gamePk, runsFor: game.awayRuns, runsAgainst: game.homeRuns });
      if (game.awayLineup) awayPriorLineups.push({ officialDate: game.officialDate, gamePk: game.gamePk, battingOrder: game.awayLineup });
    }
  }

  if (homePriorLineups.length !== homeTeamHistory.length) {
    throw new Error(`MLB_R1B_V16_BATCH_HOME_LINEUP_HISTORY_INCOMPLETE:${target.lineup.gamePk}:${homePriorLineups.length}:${homeTeamHistory.length}`);
  }
  if (awayPriorLineups.length !== awayTeamHistory.length) {
    throw new Error(`MLB_R1B_V16_BATCH_AWAY_LINEUP_HISTORY_INCOMPLETE:${target.lineup.gamePk}:${awayPriorLineups.length}:${awayTeamHistory.length}`);
  }

  return {
    homeTeamHistory,
    awayTeamHistory,
    leagueStarterHistory,
    homeStarterHistory,
    awayStarterHistory,
    homePriorLineups,
    awayPriorLineups,
  };
}

export async function materializeR1bV16HistoricalBatch(options: {
  season: number;
  targets: readonly MlbR1bV16HistoricalTargetInput[];
  fetchImpl?: FetchLike;
  apiBaseUrl?: string;
  maxConcurrency?: number;
  timeoutMs?: number;
}): Promise<MlbR1bV16HistoricalBatchResult> {
  const season = Number(options.season);
  if (!Number.isInteger(season) || season < 2000 || season > 2100) throw new Error("MLB_R1B_V16_BATCH_SEASON_INVALID");
  if (!Array.isArray(options.targets) || options.targets.length === 0) throw new Error("MLB_R1B_V16_BATCH_TARGETS_EMPTY");
  for (const target of options.targets) validateTarget(target, season);

  const sortedTargets = [...options.targets].sort((a, b) =>
    a.lineup.officialDate.localeCompare(b.lineup.officialDate) || a.lineup.gamePk - b.lineup.gamePk,
  );
  if (new Set(sortedTargets.map((target) => target.lineup.gamePk)).size !== sortedTargets.length) {
    throw new Error("MLB_R1B_V16_BATCH_DUPLICATE_TARGET_GAME_PK");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = clean(options.apiBaseUrl) || DEFAULT_API_BASE_URL;
  if (!/^https?:\/\//.test(apiBaseUrl)) throw new Error("MLB_R1B_V16_BATCH_API_BASE_INVALID");
  const maxConcurrency = Math.max(1, Math.min(24, Math.floor(options.maxConcurrency ?? DEFAULT_CONCURRENCY)));
  const timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  const fetchJson = async (url: string, label: string): Promise<any> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`MLB_R1B_V16_BATCH_FETCH_FAILED:${label}:${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const maxTargetDate = sortedTargets[sortedTargets.length - 1].lineup.officialDate;
  const scheduleUrl = `${apiBaseUrl.replace(/\/$/, "")}/v1/schedule?sportId=1&gameType=R&startDate=${season}-03-01&endDate=${previousIsoDate(maxTargetDate)}`;
  const schedule = await fetchJson(scheduleUrl, "season-schedule");
  const identities: ScheduledGameIdentity[] = [];
  for (const dateEntry of Array.isArray(schedule?.dates) ? schedule.dates : []) {
    for (const raw of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
      const gamePk = positiveInt(raw?.gamePk);
      const officialDate = clean(raw?.officialDate ?? dateEntry?.date);
      if (!gamePk || !validIsoDate(officialDate) || officialDate >= maxTargetDate || officialDate.slice(0, 4) !== String(season)) continue;
      if (!isFinalStatus(raw?.status)) continue;
      identities.push({ gamePk, officialDate });
    }
  }
  identities.sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  const unique = [...new Map(identities.map((entry) => [entry.gamePk, entry])).values()]
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
  if (unique.length === 0) throw new Error(`MLB_R1B_V16_BATCH_NO_PRIOR_FINAL_GAMES:${season}`);

  const parsedRows = await mapConcurrent(unique, maxConcurrency, async (identity): Promise<ParsedHistoricalGame | null> => {
    try {
      const feed = await fetchJson(
        `${apiBaseUrl.replace(/\/$/, "")}/v1.1/game/${identity.gamePk}/feed/live`,
        `prior-game-${identity.gamePk}`,
      );
      return parseHistoricalGame(feed, identity);
    } catch (error) {
      if (error instanceof Error && error.message === `MLB_R1B_V16_BATCH_GAME_NOT_FINAL:${identity.gamePk}`) return null;
      throw error;
    }
  });
  const parsed = parsedRows.filter((game): game is ParsedHistoricalGame => game !== null);
  if (parsed.length === 0) throw new Error(`MLB_R1B_V16_BATCH_NO_FEED_VERIFIED_PRIOR_FINAL_GAMES:${season}`);

  const targets = sortedTargets.map((target): MlbR1bV16HistoricalBatchTargetResult => {
    const history = historyForTarget(parsed, target);
    const assessment = buildC4LiveFeatures({
      officialDate: target.lineup.officialDate,
      gamePk: target.lineup.gamePk,
      homeTeamId: target.lineup.homeTeamId,
      awayTeamId: target.lineup.awayTeamId,
      ...history,
      homeStarterId: target.starter.homePitcherId,
      awayStarterId: target.starter.awayPitcherId,
      homeBattingOrder: [...target.lineup.homeBattingOrder],
      awayBattingOrder: [...target.lineup.awayBattingOrder],
    });
    if (Object.values(assessment.featureVector).some((value) => value === null || !Number.isFinite(value))) {
      throw new Error(`MLB_R1B_V16_BATCH_FEATURE_VECTOR_INCOMPLETE:${target.lineup.gamePk}`);
    }
    const generatedAt = timecodeToIso(target.lineup.requestedTimecode);
    const rows = adaptCertifiedFinalC4ToR1bV16Baseline({
      officialDate: target.lineup.officialDate,
      gamePk: target.lineup.gamePk,
      generatedAt,
      inputStage: "FINAL",
      c4: assessment,
    });
    return Object.freeze({
      officialDate: target.lineup.officialDate,
      gamePk: target.lineup.gamePk,
      assessment,
      rows,
      provenance: Object.freeze({
        lineupArtifactSha256: target.lineupArtifactSha256.toLowerCase(),
        starterArtifactSha256: target.starterArtifactSha256.toLowerCase(),
        requestedTimecode: target.lineup.requestedTimecode,
        generatedAt,
        targetIdentitySource: "FROZEN_T5_ONLY" as const,
        externalTargetFeedRead: false as const,
        targetOutcomeUsedAsFeature: false as const,
        marketPricesRead: false as const,
      }),
    });
  });

  return Object.freeze({
    schemaVersion: MLB_R1B_V16_HISTORICAL_BATCH_SCHEMA,
    season,
    source: Object.freeze({
      scheduleFetchedOnce: true as const,
      priorFinalFeedCount: parsed.length,
      priorFinalFeedsFetchedOnceEach: true as const,
      maxTargetDate,
    }),
    targets: Object.freeze(targets),
    policy: MLB_R1B_V16_HISTORICAL_BATCH_POLICY,
  });
}

export const MLB_R1B_V16_HISTORICAL_BATCH_POLICY = Object.freeze({
  researchOnly: true as const,
  scheduleFetchedOncePerSeasonBatch: true as const,
  eachPriorFinalFeedFetchedAtMostOncePerBatch: true as const,
  targetIdentityFromFrozenT5Only: true as const,
  externalTargetFeedRead: false as const,
  strictlyPriorOfficialDateHistory: true as const,
  sameDateHistoryAllowed: false as const,
  seasonResetHistory: true as const,
  sharedCurrentC4Builder: "buildC4LiveFeatures" as const,
  lockedV16Adapter: "adaptCertifiedFinalC4ToR1bV16Baseline" as const,
  targetOutcomeUsedAsFeature: false as const,
  historicalPriorResultsReadForTeamForm: true as const,
  marketPricesRead: false as const,
  modelRefit: false as const,
  newWeightsCreated: false as const,
  thresholdSearch: false as const,
  productionChanged: false as const,
  v16Changed: false as const,
  v68Changed: false as const,
  v80Changed: false as const,
});
