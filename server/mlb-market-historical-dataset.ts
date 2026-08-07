import crypto from "node:crypto";
import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";

export const MLB_P1_M6A3B1_DATASET_SCHEMA = "courtedge-p1-m6a3b1-historical-dataset.v1" as const;
export const MLB_P1_M6A3B1_SOURCE = "MLB_STATS_API_OFFICIAL" as const;

export interface MlbHistoricalOfficialInning {
  num: number;
  awayRuns: number | null;
  homeRuns: number | null;
}

export interface MlbHistoricalOfficialGame {
  gamePk: number;
  officialDate: string;
  season: number;
  gameType: string;
  finalState: string;
  homeTeamId: number;
  homeTeam: string;
  awayTeamId: number;
  awayTeam: string;
  homeFinalRuns: number;
  awayFinalRuns: number;
  innings: MlbHistoricalOfficialInning[];
  sourceVersion: string;
  sourceDigest: string;
}

export interface MlbHistoricalHorizonObservation {
  schemaVersion: typeof MLB_P1_M6A3B1_DATASET_SCHEMA;
  source: typeof MLB_P1_M6A3B1_SOURCE;
  gamePk: number;
  officialDate: string;
  season: number;
  horizon: MlbProbabilityHorizon;
  homeTeamId: number;
  homeTeam: string;
  awayTeamId: number;
  awayTeam: string;
  homeRuns: number;
  awayRuns: number;
  totalRuns: number;
  homeMinusAway: number;
  nrfi: boolean | null;
  sourceVersion: string;
  sourceDigest: string;
}

export interface MlbHistoricalDatasetBuildReport {
  schemaVersion: typeof MLB_P1_M6A3B1_DATASET_SCHEMA;
  source: typeof MLB_P1_M6A3B1_SOURCE;
  generatedAt: string;
  gamesReceived: number;
  regularSeasonFinalGames: number;
  observations: MlbHistoricalHorizonObservation[];
  observationsByHorizon: Record<MlbProbabilityHorizon, number>;
  exclusionCounts: Record<string, number>;
  /** Archival digest: includes raw-feed sourceDigest and therefore detects provider metadata drift. */
  datasetDigest: string;
  /** Statistical-equivalence digest: only canonical game identity and observed outcomes. */
  outcomeDigest: string;
  /** Raw-provider provenance digest over acquired games. */
  sourceProvenanceDigest: string;
  actionabilityAllowed: false;
  blockers: ["P1_M6A3B1_RESEARCH_ONLY", "P1_M6A3B2_COVARIATE_MODEL_REQUIRED", "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE"];
}

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

export function validateMlbHistoricalOfficialGame(game: MlbHistoricalOfficialGame): void {
  if (!positiveInteger(game.gamePk)) throw new Error("P1_M6A3B1_INVALID_GAME_PK");
  if (!isIsoDate(game.officialDate)) throw new Error("P1_M6A3B1_INVALID_OFFICIAL_DATE");
  if (!Number.isInteger(game.season) || game.season < 1900 || game.season > 2200) {
    throw new Error("P1_M6A3B1_INVALID_SEASON");
  }
  if (!String(game.gameType ?? "").trim()) throw new Error("P1_M6A3B1_GAME_TYPE_REQUIRED");
  if (!String(game.finalState ?? "").trim()) throw new Error("P1_M6A3B1_FINAL_STATE_REQUIRED");
  if (!positiveInteger(game.homeTeamId) || !positiveInteger(game.awayTeamId) || game.homeTeamId === game.awayTeamId) {
    throw new Error("P1_M6A3B1_INVALID_TEAM_IDENTITY");
  }
  if (!String(game.homeTeam ?? "").trim() || !String(game.awayTeam ?? "").trim()) {
    throw new Error("P1_M6A3B1_TEAM_NAME_REQUIRED");
  }
  if (!nonNegativeInteger(game.homeFinalRuns) || !nonNegativeInteger(game.awayFinalRuns)) {
    throw new Error("P1_M6A3B1_INVALID_FINAL_SCORE");
  }
  if (!String(game.sourceVersion ?? "").trim() || !/^[a-f0-9]{64}$/i.test(String(game.sourceDigest ?? ""))) {
    throw new Error("P1_M6A3B1_SOURCE_PROVENANCE_REQUIRED");
  }

  const seen = new Set<number>();
  for (const inning of game.innings) {
    if (!positiveInteger(inning.num) || seen.has(inning.num)) {
      throw new Error("P1_M6A3B1_INVALID_INNING_SEQUENCE");
    }
    seen.add(inning.num);
    for (const runs of [inning.awayRuns, inning.homeRuns]) {
      if (runs != null && !nonNegativeInteger(runs)) throw new Error("P1_M6A3B1_INVALID_INNING_RUNS");
    }
  }
}

function firstNComplete(game: MlbHistoricalOfficialGame, n: number): { home: number; away: number } | null {
  let home = 0;
  let away = 0;
  const byNum = new Map(game.innings.map((inning) => [inning.num, inning]));
  for (let inningNum = 1; inningNum <= n; inningNum += 1) {
    const inning = byNum.get(inningNum);
    if (!inning || inning.homeRuns == null || inning.awayRuns == null) return null;
    home += inning.homeRuns;
    away += inning.awayRuns;
  }
  return { home, away };
}

export function deriveMlbHistoricalHorizonObservation(
  game: MlbHistoricalOfficialGame,
  horizon: MlbProbabilityHorizon,
): MlbHistoricalHorizonObservation | null {
  validateMlbHistoricalOfficialGame(game);
  if (game.gameType !== "R") return null;
  if (game.finalState !== "Final") return null;

  let score: { home: number; away: number } | null = null;
  if (horizon === "FIRST_INNING") score = firstNComplete(game, 1);
  else if (horizon === "FIRST_3") score = firstNComplete(game, 3);
  else if (horizon === "FIRST_5") score = firstNComplete(game, 5);
  else score = { home: game.homeFinalRuns, away: game.awayFinalRuns };
  if (!score) return null;

  return {
    schemaVersion: MLB_P1_M6A3B1_DATASET_SCHEMA,
    source: MLB_P1_M6A3B1_SOURCE,
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    season: game.season,
    horizon,
    homeTeamId: game.homeTeamId,
    homeTeam: game.homeTeam,
    awayTeamId: game.awayTeamId,
    awayTeam: game.awayTeam,
    homeRuns: score.home,
    awayRuns: score.away,
    totalRuns: score.home + score.away,
    homeMinusAway: score.home - score.away,
    nrfi: horizon === "FIRST_INNING" ? score.home + score.away === 0 : null,
    sourceVersion: game.sourceVersion,
    sourceDigest: game.sourceDigest,
  };
}

function sortObservations(observations: MlbHistoricalHorizonObservation[]): MlbHistoricalHorizonObservation[] {
  return [...observations].sort((a, b) => a.officialDate.localeCompare(b.officialDate)
    || a.gamePk - b.gamePk
    || HORIZONS.indexOf(a.horizon) - HORIZONS.indexOf(b.horizon));
}

function canonicalObservation(observation: MlbHistoricalHorizonObservation): string {
  return JSON.stringify({
    gamePk: observation.gamePk,
    officialDate: observation.officialDate,
    season: observation.season,
    horizon: observation.horizon,
    homeTeamId: observation.homeTeamId,
    awayTeamId: observation.awayTeamId,
    homeRuns: observation.homeRuns,
    awayRuns: observation.awayRuns,
    sourceDigest: observation.sourceDigest,
  });
}

function canonicalOutcomeObservation(observation: MlbHistoricalHorizonObservation): string {
  return JSON.stringify({
    gamePk: observation.gamePk,
    officialDate: observation.officialDate,
    season: observation.season,
    horizon: observation.horizon,
    homeTeamId: observation.homeTeamId,
    awayTeamId: observation.awayTeamId,
    homeRuns: observation.homeRuns,
    awayRuns: observation.awayRuns,
  });
}

export function digestMlbHistoricalObservations(observations: MlbHistoricalHorizonObservation[]): string {
  const canonical = sortObservations(observations).map(canonicalObservation).join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function digestMlbHistoricalOutcomeObservations(observations: MlbHistoricalHorizonObservation[]): string {
  const canonical = sortObservations(observations).map(canonicalOutcomeObservation).join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function digestMlbHistoricalSourceProvenance(games: MlbHistoricalOfficialGame[]): string {
  const canonical = [...games]
    .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk)
    .map((game) => JSON.stringify({
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      sourceVersion: game.sourceVersion,
      sourceDigest: game.sourceDigest,
    }))
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function buildMlbHistoricalDataset(
  games: MlbHistoricalOfficialGame[],
  options: { generatedAt?: string } = {},
): MlbHistoricalDatasetBuildReport {
  const observations: MlbHistoricalHorizonObservation[] = [];
  const exclusionCounts: Record<string, number> = {};
  let regularSeasonFinalGames = 0;

  const increment = (reason: string) => {
    exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1;
  };

  for (const game of games) {
    validateMlbHistoricalOfficialGame(game);
    if (game.gameType !== "R") {
      increment("NON_REGULAR_SEASON_GAME");
      continue;
    }
    if (game.finalState !== "Final") {
      increment("NOT_OFFICIAL_FINAL");
      continue;
    }
    regularSeasonFinalGames += 1;
    for (const horizon of HORIZONS) {
      const observation = deriveMlbHistoricalHorizonObservation(game, horizon);
      if (observation) observations.push(observation);
      else increment(`INCOMPLETE_${horizon}`);
    }
  }

  observations.sort((a, b) => a.officialDate.localeCompare(b.officialDate)
    || a.gamePk - b.gamePk
    || HORIZONS.indexOf(a.horizon) - HORIZONS.indexOf(b.horizon));

  const observationsByHorizon = Object.fromEntries(
    HORIZONS.map((horizon) => [horizon, observations.filter((row) => row.horizon === horizon).length]),
  ) as Record<MlbProbabilityHorizon, number>;

  return {
    schemaVersion: MLB_P1_M6A3B1_DATASET_SCHEMA,
    source: MLB_P1_M6A3B1_SOURCE,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    gamesReceived: games.length,
    regularSeasonFinalGames,
    observations,
    observationsByHorizon,
    exclusionCounts,
    datasetDigest: digestMlbHistoricalObservations(observations),
    outcomeDigest: digestMlbHistoricalOutcomeObservations(observations),
    sourceProvenanceDigest: digestMlbHistoricalSourceProvenance(games),
    actionabilityAllowed: false,
    blockers: [
      "P1_M6A3B1_RESEARCH_ONLY",
      "P1_M6A3B2_COVARIATE_MODEL_REQUIRED",
      "P1_M6A3B_OUT_OF_SAMPLE_CERTIFICATION_INCOMPLETE",
    ],
  };
}
