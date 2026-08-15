import { createHash } from "node:crypto";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";

export const MLB_BATTER_PROSPECTIVE_CUSTODY_SCHEMA =
  "courtedge-p0-mlb-batter-prospective-custody.v1" as const;
export const MLB_BATTER_PROSPECTIVE_CUSTODY_RESULT_SCHEMA =
  "courtedge-p0-mlb-batter-prospective-custody-result.v1" as const;
export const MLB_BATTER_PROSPECTIVE_CUSTODY_MAX_GAMES_PER_RUN = 15;

export interface MlbBatterProspectiveCustodySnapshot {
  schemaVersion: typeof MLB_BATTER_PROSPECTIVE_CUSTODY_SCHEMA;
  gamePk: number;
  officialDate: string;
  startTime: string;
  capturedAt: string;
  homeTeamId: number;
  awayTeamId: number;
  homeProbablePitcherId: number;
  awayProbablePitcherId: number;
  homeBattingOrder: number[];
  awayBattingOrder: number[];
  source: {
    name: "MLB_STATS_API";
    endpoint: string;
    fetchedAt: string;
  };
  sourceIdentityDigest: string;
}

export type MlbBatterProspectiveCustodyGameStatus =
  | "CAPTURED"
  | "ALREADY_CAPTURED"
  | "INELIGIBLE"
  | "NOT_SELECTED"
  | "SOURCE_FAILED"
  | "IDENTITY_MISMATCH"
  | "LINEUP_INVALID"
  | "STARTED_BEFORE_CAPTURE";

export interface MlbBatterProspectiveCustodyGameResult {
  gamePk: number;
  status: MlbBatterProspectiveCustodyGameStatus;
  snapshot: MlbBatterProspectiveCustodySnapshot | null;
  blockers: string[];
}

export interface MlbBatterProspectiveCustodyCaptureResult {
  schemaVersion: typeof MLB_BATTER_PROSPECTIVE_CUSTODY_RESULT_SCHEMA;
  date: string;
  generatedAt: string;
  status: "NO_WORK" | "COMPLETED" | "PARTIAL";
  games: MlbBatterProspectiveCustodyGameResult[];
  summary: {
    inputGames: number;
    eligibleGames: number;
    selectedUncapturedGames: number;
    capturedGames: number;
    alreadyCapturedGames: number;
    failedGames: number;
    canonicalSnapshotsReturned: number;
    mlbStatsApiCalls: number;
    providerOddsCalls: 0;
    paidProviderCredits: 0;
  };
  policy: {
    explicitInvocationRequired: true;
    firstCanonicalCapturePerGameIsImmutable: true;
    overwriteCanonicalSnapshotAllowed: false;
    finalPregameInputsOnly: true;
    outcomeSettlementAllowed: false;
    modelScoringAllowed: false;
    priceCaptureAllowed: false;
    providerOddsCallsAllowed: false;
    automaticPolling: false;
    changesProductionLookupAuthorization: false;
    changesEliteCandidates: false;
    recommendsBet: false;
    calculatesStake: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export type MlbBatterProspectiveCustodySaveResult =
  | { status: "SAVED"; snapshot: MlbBatterProspectiveCustodySnapshot }
  | { status: "EXISTS"; snapshot: MlbBatterProspectiveCustodySnapshot };

export interface MlbBatterProspectiveCustodyStore {
  getCanonicalGame(gamePk: number): MlbBatterProspectiveCustodySnapshot | null | Promise<MlbBatterProspectiveCustodySnapshot | null>;
  saveCanonicalGame(snapshot: MlbBatterProspectiveCustodySnapshot): MlbBatterProspectiveCustodySaveResult | Promise<MlbBatterProspectiveCustodySaveResult>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type EligibleGame = MlbP1SlateGame & {
  startTime: string;
  homeTeam: { id: number; name: string };
  awayTeam: { id: number; name: string };
  homePitcher: { id: number; name: string | null; hand: "R" | "L" | null; confirmed: true };
  awayPitcher: { id: number; name: string | null; hand: "R" | "L" | null; confirmed: true };
};

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function normalizedNine(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(positiveInt);
  if (ids.some((id) => id == null)) return null;
  const exact = ids as number[];
  if (exact.length !== 9 || new Set(exact).size !== 9) return null;
  return exact;
}

function isEligible(game: MlbP1SlateGame, date: string): game is EligibleGame {
  return game.officialDate === date
    && game.analysisAllowed === true
    && game.analysisStage === "FINAL"
    && game.lineupState === "CONFIRMED"
    && game.homeLineupCount === 9
    && game.awayLineupCount === 9
    && game.source.name === "MLB_STATS_API"
    && game.source.quality === "AUTHORITATIVE"
    && typeof game.startTime === "string"
    && Number.isFinite(Date.parse(game.startTime))
    && positiveInt(game.homeTeam.id) != null
    && positiveInt(game.awayTeam.id) != null
    && game.homePitcher.confirmed === true
    && game.awayPitcher.confirmed === true
    && positiveInt(game.homePitcher.id) != null
    && positiveInt(game.awayPitcher.id) != null;
}

function identityDigest(input: Omit<MlbBatterProspectiveCustodySnapshot, "capturedAt" | "sourceIdentityDigest" | "source">): string {
  const canonical = JSON.stringify({
    schemaVersion: input.schemaVersion,
    gamePk: input.gamePk,
    officialDate: input.officialDate,
    startTime: input.startTime,
    homeTeamId: input.homeTeamId,
    awayTeamId: input.awayTeamId,
    homeProbablePitcherId: input.homeProbablePitcherId,
    awayProbablePitcherId: input.awayProbablePitcherId,
    homeBattingOrder: input.homeBattingOrder,
    awayBattingOrder: input.awayBattingOrder,
    sourceName: "MLB_STATS_API",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function ineligible(game: MlbP1SlateGame, date: string): string[] {
  const blockers: string[] = [];
  if (game.officialDate !== date) blockers.push("OFFICIAL_DATE_MISMATCH");
  if (!game.analysisAllowed || game.analysisStage !== "FINAL") blockers.push("FINAL_ANALYSIS_REQUIRED");
  if (game.lineupState !== "CONFIRMED" || game.homeLineupCount !== 9 || game.awayLineupCount !== 9) blockers.push("CONFIRMED_9X9_LINEUP_REQUIRED");
  if (game.source.quality !== "AUTHORITATIVE") blockers.push("AUTHORITATIVE_SOURCE_REQUIRED");
  if (positiveInt(game.homeTeam.id) == null || positiveInt(game.awayTeam.id) == null) blockers.push("TEAM_IDS_REQUIRED");
  if (!game.homePitcher.confirmed || !game.awayPitcher.confirmed || positiveInt(game.homePitcher.id) == null || positiveInt(game.awayPitcher.id) == null) blockers.push("CONFIRMED_PITCHER_IDS_REQUIRED");
  if (typeof game.startTime !== "string" || !Number.isFinite(Date.parse(game.startTime))) blockers.push("VALID_START_TIME_REQUIRED");
  return blockers;
}

export class MlbBatterProspectiveCustodyService {
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;

  constructor(
    private readonly store: MlbBatterProspectiveCustodyStore,
    options: { fetchFn?: FetchLike; now?: () => Date } = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async capture(input: {
    date: string;
    games: readonly MlbP1SlateGame[];
    maxGames: number;
  }): Promise<MlbBatterProspectiveCustodyCaptureResult> {
    if (!validDate(input.date)) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_INVALID_DATE");
    if (!Number.isInteger(input.maxGames) || input.maxGames < 1 || input.maxGames > MLB_BATTER_PROSPECTIVE_CUSTODY_MAX_GAMES_PER_RUN) {
      throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_INVALID_MAX_GAMES");
    }

    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_NOW_INVALID");
    const generatedAt = now.toISOString();
    const games = [...input.games].sort((left, right) => {
      const leftMs = left.startTime ? Date.parse(left.startTime) : Number.POSITIVE_INFINITY;
      const rightMs = right.startTime ? Date.parse(right.startTime) : Number.POSITIVE_INFINITY;
      return leftMs - rightMs || left.gamePk - right.gamePk;
    });

    const results: MlbBatterProspectiveCustodyGameResult[] = [];
    let eligibleGames = 0;
    let selectedUncapturedGames = 0;
    let mlbStatsApiCalls = 0;

    for (const game of games) {
      const existing = await this.store.getCanonicalGame(game.gamePk);
      if (existing) {
        results.push({ gamePk: game.gamePk, status: "ALREADY_CAPTURED", snapshot: existing, blockers: [] });
        continue;
      }

      if (!isEligible(game, input.date)) {
        results.push({ gamePk: game.gamePk, status: "INELIGIBLE", snapshot: null, blockers: ineligible(game, input.date) });
        continue;
      }
      eligibleGames += 1;

      if (Date.parse(game.startTime) <= now.getTime()) {
        results.push({ gamePk: game.gamePk, status: "STARTED_BEFORE_CAPTURE", snapshot: null, blockers: ["CAPTURE_MUST_PRECEDE_START_TIME"] });
        continue;
      }

      if (selectedUncapturedGames >= input.maxGames) {
        results.push({ gamePk: game.gamePk, status: "NOT_SELECTED", snapshot: null, blockers: ["MAX_GAMES_REACHED"] });
        continue;
      }
      selectedUncapturedGames += 1;

      const endpoint = `https://statsapi.mlb.com/api/v1.1/game/${game.gamePk}/feed/live`;
      let feed: any;
      try {
        mlbStatsApiCalls += 1;
        const response = await this.fetchFn(endpoint);
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        feed = await response.json();
      } catch (error: any) {
        results.push({
          gamePk: game.gamePk,
          status: "SOURCE_FAILED",
          snapshot: null,
          blockers: [`MLB_STATS_API_FAILED:${String(error?.message ?? "UNKNOWN")}`],
        });
        continue;
      }

      const homeTeamId = positiveInt(feed?.gameData?.teams?.home?.id);
      const awayTeamId = positiveInt(feed?.gameData?.teams?.away?.id);
      const homeProbablePitcherId = positiveInt(feed?.gameData?.probablePitchers?.home?.id);
      const awayProbablePitcherId = positiveInt(feed?.gameData?.probablePitchers?.away?.id);
      const officialDate = String(feed?.gameData?.datetime?.officialDate ?? "").trim();
      const sourceStartTime = String(feed?.gameData?.datetime?.dateTime ?? "").trim();

      if (
        homeTeamId !== game.homeTeam.id
        || awayTeamId !== game.awayTeam.id
        || homeProbablePitcherId !== game.homePitcher.id
        || awayProbablePitcherId !== game.awayPitcher.id
        || officialDate !== game.officialDate
        || !Number.isFinite(Date.parse(sourceStartTime))
        || Date.parse(sourceStartTime) !== Date.parse(game.startTime)
      ) {
        results.push({ gamePk: game.gamePk, status: "IDENTITY_MISMATCH", snapshot: null, blockers: ["SLATE_AND_LIVE_FEED_IDENTITY_MUST_MATCH"] });
        continue;
      }

      const homeBattingOrder = normalizedNine(feed?.liveData?.boxscore?.teams?.home?.battingOrder);
      const awayBattingOrder = normalizedNine(feed?.liveData?.boxscore?.teams?.away?.battingOrder);
      if (!homeBattingOrder || !awayBattingOrder) {
        results.push({ gamePk: game.gamePk, status: "LINEUP_INVALID", snapshot: null, blockers: ["EXACT_NINE_UNIQUE_BATTERS_PER_SIDE_REQUIRED"] });
        continue;
      }

      const capturedAtDate = this.now();
      if (!Number.isFinite(capturedAtDate.getTime()) || capturedAtDate.getTime() >= Date.parse(game.startTime)) {
        results.push({ gamePk: game.gamePk, status: "STARTED_BEFORE_CAPTURE", snapshot: null, blockers: ["CAPTURE_MUST_PRECEDE_START_TIME"] });
        continue;
      }
      const capturedAt = capturedAtDate.toISOString();
      const core = {
        schemaVersion: MLB_BATTER_PROSPECTIVE_CUSTODY_SCHEMA,
        gamePk: game.gamePk,
        officialDate: game.officialDate,
        startTime: new Date(game.startTime).toISOString(),
        homeTeamId,
        awayTeamId,
        homeProbablePitcherId,
        awayProbablePitcherId,
        homeBattingOrder,
        awayBattingOrder,
      } as const;
      const snapshot: MlbBatterProspectiveCustodySnapshot = {
        ...core,
        capturedAt,
        source: { name: "MLB_STATS_API", endpoint, fetchedAt: capturedAt },
        sourceIdentityDigest: identityDigest(core),
      };
      const saved = await this.store.saveCanonicalGame(snapshot);
      results.push({
        gamePk: game.gamePk,
        status: saved.status === "SAVED" ? "CAPTURED" : "ALREADY_CAPTURED",
        snapshot: saved.snapshot,
        blockers: [],
      });
    }

    const capturedGames = results.filter((row) => row.status === "CAPTURED").length;
    const alreadyCapturedGames = results.filter((row) => row.status === "ALREADY_CAPTURED").length;
    const failedGames = results.filter((row) => ["SOURCE_FAILED", "IDENTITY_MISMATCH", "LINEUP_INVALID", "STARTED_BEFORE_CAPTURE"].includes(row.status)).length;
    const canonicalSnapshotsReturned = results.filter((row) => row.snapshot != null).length;
    const status = selectedUncapturedGames === 0 && alreadyCapturedGames === 0
      ? "NO_WORK"
      : failedGames > 0
        ? "PARTIAL"
        : "COMPLETED";

    return {
      schemaVersion: MLB_BATTER_PROSPECTIVE_CUSTODY_RESULT_SCHEMA,
      date: input.date,
      generatedAt,
      status,
      games: results,
      summary: {
        inputGames: games.length,
        eligibleGames,
        selectedUncapturedGames,
        capturedGames,
        alreadyCapturedGames,
        failedGames,
        canonicalSnapshotsReturned,
        mlbStatsApiCalls,
        providerOddsCalls: 0,
        paidProviderCredits: 0,
      },
      policy: {
        explicitInvocationRequired: true,
        firstCanonicalCapturePerGameIsImmutable: true,
        overwriteCanonicalSnapshotAllowed: false,
        finalPregameInputsOnly: true,
        outcomeSettlementAllowed: false,
        modelScoringAllowed: false,
        priceCaptureAllowed: false,
        providerOddsCallsAllowed: false,
        automaticPolling: false,
        changesProductionLookupAuthorization: false,
        changesEliteCandidates: false,
        recommendsBet: false,
        calculatesStake: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    };
  }
}
