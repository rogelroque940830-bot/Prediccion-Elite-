import {
  MLB_FROZEN_MATCHUP_PITCHMIX_LOOKBACK_DAYS,
  buildMlbFrozenMatchupLiveFeatures,
  type MlbFrozenHandSplitGameAggregate,
  type MlbFrozenHandSplitTeamTotal,
  type MlbFrozenMatchupLiveFeatureAssessment,
  type MlbFrozenPitcherMixTotal,
  type MlbFrozenPitchmixGameAggregate,
  type MlbFrozenTeamPitchFamilyTotal,
  type MlbPitchFamily,
  type MlbPitcherHand,
} from "./mlb-frozen-matchup-live-feature-builder";
import {
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE,
  MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE,
  loadMlbFrozenMatchupCanonicalSeed,
  type MlbFrozenMatchupCanonicalSeed,
} from "./mlb-frozen-matchup-canonical-seed";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";

export const MLB_FROZEN_MATCHUP_CERTIFIED_MATERIALIZER_SCHEMA =
  "courtedge-p0-v17-frozen-matchup-certified-materializer.v1" as const;

const MLB_STATS_API_BASE = "https://statsapi.mlb.com/api";
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_TIMEOUT_MS = 12_000;
const HIT_TB: Record<string, number> = { single: 1, double: 2, triple: 3, home_run: 4 };
const WALKS = new Set(["walk", "intent_walk"]);
const HBP = new Set(["hit_by_pitch"]);
const NON_AB = new Set([
  "walk",
  "intent_walk",
  "hit_by_pitch",
  "sac_bunt",
  "sac_bunt_double_play",
  "sac_fly",
  "sac_fly_double_play",
  "catcher_interf",
]);
const WHIFF_CODES = new Set(["S", "W", "M"]);
const SWING_CODES = new Set(["F", "T", "L", "X", "D", "E"]);
const PITCH_CODE_TO_FAMILY: Readonly<Record<string, MlbPitchFamily>> = Object.freeze({
  FF: "FASTBALL",
  SI: "FASTBALL",
  FC: "FASTBALL",
  FA: "FASTBALL",
  FT: "FASTBALL",
  SL: "BREAKING",
  ST: "BREAKING",
  CU: "BREAKING",
  KC: "BREAKING",
  SV: "BREAKING",
  CH: "OFFSPEED",
  FS: "OFFSPEED",
  FO: "OFFSPEED",
  SC: "OFFSPEED",
});

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MlbFrozenMatchupCertifiedMaterializerOptions {
  fetchImpl?: FetchLike;
  maxConcurrency?: number;
  timeoutMs?: number;
  apiBaseUrl?: string;
  seed?: Readonly<MlbFrozenMatchupCanonicalSeed>;
}

interface ScheduledHistoricalGame {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
}

interface IncrementalHistory {
  startDate: string | null;
  endDate: string | null;
  pitchmixGames: MlbFrozenPitchmixGameAggregate[];
  handSplitGames: MlbFrozenHandSplitGameAggregate[];
}

export interface MlbFrozenMatchupCertifiedAssessment {
  sourceStatus: "CERTIFIED";
  featureAssessment: MlbFrozenMatchupLiveFeatureAssessment;
  provenance: {
    schemaVersion: typeof MLB_FROZEN_MATCHUP_CERTIFIED_MATERIALIZER_SCHEMA;
    source: "MLB_STATS_API_FINAL_PLAY_BY_PLAY_PLUS_FROZEN_V9_V12_SEED";
    generatedAt: string;
    targetGamePk: number;
    targetOfficialDate: string;
    seedRawSha256: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256;
    seedThroughDate: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE;
    supportedTargetDateGte: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE;
    supportedTargetDateLte: typeof MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE;
    incrementalStartDate: string | null;
    incrementalEndDate: string | null;
    incrementalFinalGames: number;
    sameDateOutcomeLeakageAllowed: false;
    targetOutcomeUsed: false;
    sportsbookPriceUsed: false;
    failureDisposition: "THROW_FAIL_CLOSED";
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function shiftDate(value: string, days: number): string {
  if (!validIsoDate(value)) throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_DATE_INVALID:${value}`);
  return new Date(Date.parse(`${value}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function isFinalStatus(status: any): boolean {
  const abstract = clean(status?.abstractGameState).toLowerCase();
  const detailed = clean(status?.detailedState).toLowerCase();
  return abstract === "final" || /final|game over|completed early/.test(detailed);
}

function blankHand(teamId: number, vsHand: MlbPitcherHand): MlbFrozenHandSplitTeamTotal {
  return { teamId, vsHand, pa: 0, ab: 0, tb: 0 };
}

function blankPitcher(pitcherId: number): MlbFrozenPitcherMixTotal {
  return { pitcherId, allPitches: 0, categorizedPitches: 0, FASTBALL: 0, BREAKING: 0, OFFSPEED: 0 };
}

function blankFamily(teamId: number, pitchFamily: MlbPitchFamily): MlbFrozenTeamPitchFamilyTotal {
  return { teamId, pitchFamily, swings: 0, whiffs: 0, contacts: 0, terminalPa: 0, tb: 0, hr: 0 };
}

function isWhiff(details: any): boolean {
  const description = clean(details?.description).toLowerCase();
  const code = clean(details?.code).toUpperCase();
  return description.includes("swinging strike") || description.includes("missed bunt") || WHIFF_CODES.has(code);
}

function isSwing(details: any): boolean {
  const description = clean(details?.description).toLowerCase();
  const code = clean(details?.code).toUpperCase();
  if (isWhiff(details)) return true;
  if (Boolean(details?.isInPlay)) return true;
  return description.includes("foul") || description.includes("in play") || SWING_CODES.has(code);
}

function addHandPlateAppearance(row: MlbFrozenHandSplitTeamTotal, eventType: string): void {
  row.pa += 1;
  if (!NON_AB.has(eventType)) row.ab += 1;
  if (HIT_TB[eventType]) row.tb += HIT_TB[eventType];
  void WALKS.has(eventType);
  void HBP.has(eventType);
}

function parseHistoricalPlayByPlay(
  payload: any,
  identity: ScheduledHistoricalGame,
): { pitchmix: MlbFrozenPitchmixGameAggregate; hand: MlbFrozenHandSplitGameAggregate } {
  const plays = payload?.allPlays;
  if (!Array.isArray(plays)) throw new Error(`MLB_FROZEN_MATCHUP_PLAY_BY_PLAY_MISSING:${identity.gamePk}`);

  const hands = new Map<string, MlbFrozenHandSplitTeamTotal>();
  for (const teamId of [identity.homeTeamId, identity.awayTeamId]) {
    hands.set(`${teamId}:R`, blankHand(teamId, "R"));
    hands.set(`${teamId}:L`, blankHand(teamId, "L"));
  }
  const pitchers = new Map<number, MlbFrozenPitcherMixTotal>();
  const families = new Map<string, MlbFrozenTeamPitchFamilyTotal>();
  for (const teamId of [identity.homeTeamId, identity.awayTeamId]) {
    for (const family of ["FASTBALL", "BREAKING", "OFFSPEED"] as const) {
      families.set(`${teamId}:${family}`, blankFamily(teamId, family));
    }
  }

  for (const play of plays) {
    const about = play?.about ?? {};
    const matchup = play?.matchup ?? {};
    const result = play?.result ?? {};
    const half = clean(about?.halfInning).toLowerCase();
    if (half !== "top" && half !== "bottom") continue;
    const battingTeam = half === "top" ? identity.awayTeamId : identity.homeTeamId;
    const pitcherId = positiveInt(matchup?.pitcher?.id);
    const batterId = positiveInt(matchup?.batter?.id);
    const pitchHand = clean(matchup?.pitchHand?.code).toUpperCase();
    const eventType = clean(result?.eventType);

    if (pitcherId && batterId && eventType && (pitchHand === "R" || pitchHand === "L")) {
      addHandPlateAppearance(hands.get(`${battingTeam}:${pitchHand}`) as MlbFrozenHandSplitTeamTotal, eventType);
    }

    let lastFamily: MlbPitchFamily | null = null;
    if (pitcherId) {
      let pitcher = pitchers.get(pitcherId);
      if (!pitcher) {
        pitcher = blankPitcher(pitcherId);
        pitchers.set(pitcherId, pitcher);
      }
      for (const rawEvent of Array.isArray(play?.playEvents) ? play.playEvents : []) {
        if (!Boolean(rawEvent?.isPitch)) continue;
        const details = rawEvent?.details ?? {};
        const pitchType = clean(details?.type?.code).toUpperCase();
        pitcher.allPitches += 1;
        const family = PITCH_CODE_TO_FAMILY[pitchType];
        if (!family) continue;
        lastFamily = family;
        pitcher.categorizedPitches += 1;
        pitcher[family] += 1;
        const familyRow = families.get(`${battingTeam}:${family}`) as MlbFrozenTeamPitchFamilyTotal;
        if (isSwing(details)) {
          familyRow.swings += 1;
          if (isWhiff(details)) familyRow.whiffs += 1;
          else familyRow.contacts += 1;
        }
      }
    }

    if (lastFamily && eventType) {
      const familyRow = families.get(`${battingTeam}:${lastFamily}`) as MlbFrozenTeamPitchFamilyTotal;
      familyRow.terminalPa += 1;
      if (HIT_TB[eventType]) {
        familyRow.tb += HIT_TB[eventType];
        if (eventType === "home_run") familyRow.hr += 1;
      }
    }
  }

  return {
    pitchmix: {
      gamePk: identity.gamePk,
      officialDate: identity.officialDate,
      pitcherTotals: [...pitchers.values()].sort((a, b) => a.pitcherId - b.pitcherId),
      teamPitchFamilyTotals: [...families.values()].sort((a, b) => a.teamId - b.teamId || a.pitchFamily.localeCompare(b.pitchFamily)),
    },
    hand: {
      gamePk: identity.gamePk,
      officialDate: identity.officialDate,
      teamHandTotals: [...hands.values()].sort((a, b) => a.teamId - b.teamId || a.vsHand.localeCompare(b.vsHand)),
    },
  };
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

export class MlbFrozenMatchupCertifiedMaterializer {
  private readonly fetchImpl: FetchLike;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private readonly apiBaseUrl: string;
  private readonly seed: Readonly<MlbFrozenMatchupCanonicalSeed>;
  private readonly incrementalCache = new Map<string, Promise<IncrementalHistory>>();

  constructor(options: MlbFrozenMatchupCertifiedMaterializerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxConcurrency = Math.max(1, Math.min(24, Math.floor(options.maxConcurrency ?? DEFAULT_CONCURRENCY)));
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.apiBaseUrl = clean(options.apiBaseUrl) || MLB_STATS_API_BASE;
    this.seed = options.seed ?? loadMlbFrozenMatchupCanonicalSeed();
  }

  async assessGame(game: MlbP1SlateGame): Promise<MlbFrozenMatchupCertifiedAssessment> {
    this.assertTarget(game);
    const incremental = await this.getIncrementalHistory(game.officialDate);
    const featureAssessment = buildMlbFrozenMatchupLiveFeatures({
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      homeTeamId: game.homeTeam.id as number,
      awayTeamId: game.awayTeam.id as number,
      homeStarterId: game.homePitcher.id as number,
      awayStarterId: game.awayPitcher.id as number,
      homeStarterHand: game.homePitcher.hand as MlbPitcherHand,
      awayStarterHand: game.awayPitcher.hand as MlbPitcherHand,
      handSplitGames: [...this.seed.handSplitGames, ...incremental.handSplitGames],
      pitchmixGames: [...this.seed.pitchmixGames, ...incremental.pitchmixGames],
    });

    return Object.freeze({
      sourceStatus: "CERTIFIED",
      featureAssessment,
      provenance: Object.freeze({
        schemaVersion: MLB_FROZEN_MATCHUP_CERTIFIED_MATERIALIZER_SCHEMA,
        source: "MLB_STATS_API_FINAL_PLAY_BY_PLAY_PLUS_FROZEN_V9_V12_SEED",
        generatedAt: new Date().toISOString(),
        targetGamePk: game.gamePk,
        targetOfficialDate: game.officialDate,
        seedRawSha256: MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256,
        seedThroughDate: MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE,
        supportedTargetDateGte: MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE,
        supportedTargetDateLte: MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE,
        incrementalStartDate: incremental.startDate,
        incrementalEndDate: incremental.endDate,
        incrementalFinalGames: incremental.pitchmixGames.length,
        sameDateOutcomeLeakageAllowed: false,
        targetOutcomeUsed: false,
        sportsbookPriceUsed: false,
        failureDisposition: "THROW_FAIL_CLOSED",
      }),
    });
  }

  private assertTarget(game: MlbP1SlateGame): void {
    if (!positiveInt(game.gamePk)) throw new Error("MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_GAME_PK_INVALID");
    if (!validIsoDate(game.officialDate)) throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_DATE_INVALID:${game.officialDate}`);
    if (game.officialDate < MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE) {
      throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_BEFORE_SUPPORTED_DATE:${game.officialDate}`);
    }
    if (game.officialDate > MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE) {
      throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_AFTER_SUPPORTED_DATE:${game.officialDate}`);
    }
    if (!positiveInt(game.homeTeam.id) || !positiveInt(game.awayTeam.id)) throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_TEAM_ID_MISSING:${game.gamePk}`);
    if (!positiveInt(game.homePitcher.id) || !positiveInt(game.awayPitcher.id)) throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_STARTER_ID_MISSING:${game.gamePk}`);
    if ((game.homePitcher.hand !== "R" && game.homePitcher.hand !== "L") || (game.awayPitcher.hand !== "R" && game.awayPitcher.hand !== "L")) {
      throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_STARTER_HAND_MISSING:${game.gamePk}`);
    }
    if (game.lineupState !== "CONFIRMED") throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_LINEUP_NOT_CONFIRMED:${game.gamePk}`);
    if (game.source.name !== "MLB_STATS_API" || game.source.quality !== "AUTHORITATIVE") {
      throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_TARGET_SOURCE_NOT_AUTHORITATIVE:${game.gamePk}`);
    }
  }

  private getIncrementalHistory(targetDate: string): Promise<IncrementalHistory> {
    const cached = this.incrementalCache.get(targetDate);
    if (cached) return cached;
    const promise = this.buildIncrementalHistory(targetDate).catch((error) => {
      this.incrementalCache.delete(targetDate);
      throw error;
    });
    this.incrementalCache.set(targetDate, promise);
    return promise;
  }

  private async buildIncrementalHistory(targetDate: string): Promise<IncrementalHistory> {
    const endDate = shiftDate(targetDate, -1);
    const pitchWindowStart = shiftDate(targetDate, -MLB_FROZEN_MATCHUP_PITCHMIX_LOOKBACK_DAYS);
    const afterSeed = shiftDate(MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE, 1);
    const startDate = pitchWindowStart > afterSeed ? pitchWindowStart : afterSeed;
    if (startDate > endDate) return { startDate: null, endDate: null, pitchmixGames: [], handSplitGames: [] };

    const scheduleUrl = `${this.apiBaseUrl}/v1/schedule?sportId=1&gameType=R&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
    const schedule = await this.fetchJson(scheduleUrl, "MLB frozen matchup incremental schedule");
    const identities: ScheduledHistoricalGame[] = [];
    for (const dateEntry of Array.isArray(schedule?.dates) ? schedule.dates : []) {
      for (const raw of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
        const gamePk = positiveInt(raw?.gamePk);
        const officialDate = clean(raw?.officialDate ?? dateEntry?.date);
        const homeTeamId = positiveInt(raw?.teams?.home?.team?.id);
        const awayTeamId = positiveInt(raw?.teams?.away?.team?.id);
        if (!gamePk || !validIsoDate(officialDate) || !homeTeamId || !awayTeamId) continue;
        if (officialDate < startDate || officialDate > endDate || !isFinalStatus(raw?.status)) continue;
        identities.push({ gamePk, officialDate, homeTeamId, awayTeamId });
      }
    }
    identities.sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
    const deduped = identities.filter((entry, index) => index === 0 || entry.gamePk !== identities[index - 1].gamePk);

    // Keep only the compact pitchmix/hand aggregates in incrementalCache. Full
    // play-by-play responses are intentionally transient so V16 cannot pin raw
    // historical pitch-by-pitch JSON for every game in the process heap.
    const parsed = await mapConcurrent(deduped, this.maxConcurrency, async (identity) => {
      const payload = await this.fetchJson(
        `${this.apiBaseUrl}/v1/game/${identity.gamePk}/playByPlay`,
        `MLB frozen matchup game ${identity.gamePk}`,
      );
      return parseHistoricalPlayByPlay(payload, identity);
    });
    return {
      startDate,
      endDate,
      pitchmixGames: parsed.map((row) => row.pitchmix),
      handSplitGames: parsed.map((row) => row.hand),
    };
  }

  private async fetchJson(url: string, label: string): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "CourtEdge-P0-V17/1.0" },
      });
      if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
      return await response.json();
    } catch (error: any) {
      throw new Error(`MLB_FROZEN_MATCHUP_CERTIFIED_SOURCE_FAILED:${label}:${String(error?.message || error || "UNKNOWN")}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
