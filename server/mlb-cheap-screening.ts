import type { MlbP1DailySlate, MlbP1SlateGame } from "./mlb-p1-daily-slate";

export const MLB_CHEAP_SCREENING_SCHEMA = "courtedge-p0-mlb-cheap-screening.v1" as const;

export type MlbCheapScreenDisposition =
  | "ADVANCE_FINAL"
  | "ADVANCE_PROVISIONAL"
  | "DEFER"
  | "DROP";

export type MlbCheapScreenReasonCode =
  | "OFFICIAL_PREGAME_INPUTS_FINAL"
  | "OFFICIAL_LINEUPS_PENDING"
  | "OFFICIAL_PITCHERS_PENDING"
  | "OFFICIAL_DATA_INSUFFICIENT"
  | "GAME_ALREADY_STARTED"
  | "GAME_CLOSED";

export interface MlbCheapScreenGameResult {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  homeTeam: MlbP1SlateGame["homeTeam"];
  awayTeam: MlbP1SlateGame["awayTeam"];
  homePitcher: MlbP1SlateGame["homePitcher"];
  awayPitcher: MlbP1SlateGame["awayPitcher"];
  lineupState: MlbP1SlateGame["lineupState"];
  sourceQuality: MlbP1SlateGame["source"]["quality"];
  sourceFetchedAt: string;
  disposition: MlbCheapScreenDisposition;
  reasonCode: MlbCheapScreenReasonCode;
  reasons: readonly string[];
  eligibleForDeepPrefilterNow: boolean;
  finalInputsAvailable: boolean;
}

export interface MlbCheapScreeningResult {
  schemaVersion: typeof MLB_CHEAP_SCREENING_SCHEMA;
  date: string;
  generatedAt: string;
  sourceSlateSchemaVersion: MlbP1DailySlate["schemaVersion"];
  games: MlbCheapScreenGameResult[];
  summary: {
    total: number;
    advanceFinal: number;
    advanceProvisional: number;
    deferred: number;
    dropped: number;
    deepPrefilterEligibleNow: number;
  };
  policy: {
    marketAgnostic: true;
    ranksGames: false;
    capsCandidateCount: false;
    requiresMarketOdds: false;
    callsTheOddsApi: false;
    theOddsApiCreditsConsumed: 0;
    automaticRetryOrPolling: false;
    deferredGamesRequireNewExplicitRun: true;
  };
  safety: MlbP1DailySlate["safety"];
}

export function screenMlbSlateGameCheap(game: MlbP1SlateGame): MlbCheapScreenGameResult {
  let disposition: MlbCheapScreenDisposition;
  let reasonCode: MlbCheapScreenReasonCode;

  switch (game.readiness) {
    case "READY_TO_ANALYZE":
      disposition = "ADVANCE_FINAL";
      reasonCode = "OFFICIAL_PREGAME_INPUTS_FINAL";
      break;
    case "PROVISIONAL_WAITING_FOR_LINEUPS":
      disposition = "ADVANCE_PROVISIONAL";
      reasonCode = "OFFICIAL_LINEUPS_PENDING";
      break;
    case "WAITING_FOR_PITCHERS":
      disposition = "DEFER";
      reasonCode = "OFFICIAL_PITCHERS_PENDING";
      break;
    case "DATA_INSUFFICIENT":
      disposition = "DEFER";
      reasonCode = "OFFICIAL_DATA_INSUFFICIENT";
      break;
    case "GAME_ALREADY_STARTED":
      disposition = "DROP";
      reasonCode = "GAME_ALREADY_STARTED";
      break;
    case "GAME_CLOSED":
      disposition = "DROP";
      reasonCode = "GAME_CLOSED";
      break;
  }

  const reasons = game.blockers.length > 0
    ? [...game.blockers]
    : reasonCode === "OFFICIAL_PREGAME_INPUTS_FINAL"
      ? ["Identidad, pitchers y lineups oficiales están listos para el prefiltrado profundo sin cuotas."]
      : ["El juego puede avanzar solo de forma provisional hasta que se publiquen los lineups oficiales."];

  return {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    startTime: game.startTime,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homePitcher: game.homePitcher,
    awayPitcher: game.awayPitcher,
    lineupState: game.lineupState,
    sourceQuality: game.source.quality,
    sourceFetchedAt: game.source.fetchedAt,
    disposition,
    reasonCode,
    reasons,
    eligibleForDeepPrefilterNow: disposition === "ADVANCE_FINAL" || disposition === "ADVANCE_PROVISIONAL",
    finalInputsAvailable: disposition === "ADVANCE_FINAL",
  };
}

export function screenMlbDailySlateCheap(slate: MlbP1DailySlate): MlbCheapScreeningResult {
  const games = slate.games.map(screenMlbSlateGameCheap);
  return {
    schemaVersion: MLB_CHEAP_SCREENING_SCHEMA,
    date: slate.date,
    generatedAt: new Date().toISOString(),
    sourceSlateSchemaVersion: slate.schemaVersion,
    games,
    summary: {
      total: games.length,
      advanceFinal: games.filter((game) => game.disposition === "ADVANCE_FINAL").length,
      advanceProvisional: games.filter((game) => game.disposition === "ADVANCE_PROVISIONAL").length,
      deferred: games.filter((game) => game.disposition === "DEFER").length,
      dropped: games.filter((game) => game.disposition === "DROP").length,
      deepPrefilterEligibleNow: games.filter((game) => game.eligibleForDeepPrefilterNow).length,
    },
    policy: {
      marketAgnostic: true,
      ranksGames: false,
      capsCandidateCount: false,
      requiresMarketOdds: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      automaticRetryOrPolling: false,
      deferredGamesRequireNewExplicitRun: true,
    },
    safety: slate.safety,
  };
}
