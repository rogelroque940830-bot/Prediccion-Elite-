import { predictFrozenLogit } from "./nfl-frozen-logit";
import {
  getNflR5H21Artifact,
  NFL_R5H21_ARTIFACT_DIGEST,
  NFL_R5H21_FROZEN_2026_THRESHOLD,
  type NflR5H21LateDownTeamState,
} from "./nfl-r5h21-artifact";

export type NflLateDownFeatureMap = {
  home_off_late_down_conversion: number | null;
  home_def_late_down_conversion_allowed: number | null;
  away_off_late_down_conversion: number | null;
  away_def_late_down_conversion_allowed: number | null;
};

export type NflLateDownCompletedMetrics = {
  home: { offLateDownConversion: number | null; defLateDownConversionAllowed: number | null };
  away: { offLateDownConversion: number | null; defLateDownConversionAllowed: number | null };
};

export type NflR5H21LateDownScore = {
  schemaVersion: "courtedge-nfl-r5h21-late-down-score.v1";
  artifactDigest: typeof NFL_R5H21_ARTIFACT_DIGEST;
  gameId: string;
  season: 2026;
  week: number;
  gameday: string;
  lateDownProbability: number;
  supportScore: number;
  threshold: typeof NFL_R5H21_FROZEN_2026_THRESHOLD;
  thresholdOnlySelected: boolean;
  predictedSide: "HOME" | "AWAY";
  safety: {
    pregameOnly: true;
    sameGameOutcomeUsed: false;
    postKickoffEvidenceUsed: false;
    marketDataUsedAsModelFeature: false;
    targetSeasonRankingOrCapUsed: false;
    historicalAccuracyExposedAsGameProbability: false;
    automaticBetPlacement: false;
  };
};

type TeamState = {
  offLateDownConversion: number | null;
  defLateDownConversionAllowed: number | null;
};

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function updateEwma(oldValue: number | null, observed: number | null, alpha: number): number | null {
  if (observed === null || !Number.isFinite(observed)) return oldValue;
  if (oldValue === null || !Number.isFinite(oldValue)) return observed;
  return (1 - alpha) * oldValue + alpha * observed;
}

function logit(probability: number): number {
  const p = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(p / (1 - p));
}

/** Stateful 2026 late-down materializer frozen from the R5H21 end-2025 checkpoint. */
export class NflR5H21LateDownRuntime {
  private readonly teamState = new Map<string, TeamState>();
  private currentSeason: number;
  private processedCompletedGames: number;
  private lastAppliedGameId: string | null;
  private readonly ewmaAlpha: number;
  private readonly seasonDecay: number;

  constructor() {
    const artifact = getNflR5H21Artifact();
    for (const row of artifact.end2025State.teamState) {
      this.teamState.set(row.team, {
        offLateDownConversion: finite(row.offLateDownConversion),
        defLateDownConversionAllowed: finite(row.defLateDownConversionAllowed),
      });
    }
    this.currentSeason = artifact.end2025State.currentSeason;
    this.processedCompletedGames = artifact.end2025State.processedCompletedGames;
    this.lastAppliedGameId = artifact.end2025State.lastAppliedGameId;
    this.ewmaAlpha = artifact.end2025State.ewmaAlpha;
    this.seasonDecay = artifact.end2025State.seasonDecay;
  }

  private ensureSeason(season: number): void {
    if (!Number.isInteger(season) || season < this.currentSeason) {
      throw new Error(`NFL R5H21 late-down runtime rejected non-forward season ${season}`);
    }
    while (this.currentSeason < season) {
      for (const state of this.teamState.values()) {
        if (state.offLateDownConversion !== null) state.offLateDownConversion *= this.seasonDecay;
        if (state.defLateDownConversionAllowed !== null) state.defLateDownConversionAllowed *= this.seasonDecay;
      }
      this.currentSeason += 1;
    }
  }

  materializePregame(game: { season: number; homeTeam: string; awayTeam: string }): NflLateDownFeatureMap {
    this.ensureSeason(game.season);
    const home = this.teamState.get(game.homeTeam) ?? { offLateDownConversion: null, defLateDownConversionAllowed: null };
    const away = this.teamState.get(game.awayTeam) ?? { offLateDownConversion: null, defLateDownConversionAllowed: null };
    return {
      home_off_late_down_conversion: home.offLateDownConversion,
      home_def_late_down_conversion_allowed: home.defLateDownConversionAllowed,
      away_off_late_down_conversion: away.offLateDownConversion,
      away_def_late_down_conversion_allowed: away.defLateDownConversionAllowed,
    };
  }

  applyCompletedGame(
    game: { gameId: string; season: number; homeTeam: string; awayTeam: string },
    metrics: NflLateDownCompletedMetrics,
  ): void {
    this.ensureSeason(game.season);
    const home = this.teamState.get(game.homeTeam) ?? { offLateDownConversion: null, defLateDownConversionAllowed: null };
    const away = this.teamState.get(game.awayTeam) ?? { offLateDownConversion: null, defLateDownConversionAllowed: null };
    home.offLateDownConversion = updateEwma(home.offLateDownConversion, finite(metrics.home.offLateDownConversion), this.ewmaAlpha);
    home.defLateDownConversionAllowed = updateEwma(home.defLateDownConversionAllowed, finite(metrics.home.defLateDownConversionAllowed), this.ewmaAlpha);
    away.offLateDownConversion = updateEwma(away.offLateDownConversion, finite(metrics.away.offLateDownConversion), this.ewmaAlpha);
    away.defLateDownConversionAllowed = updateEwma(away.defLateDownConversionAllowed, finite(metrics.away.defLateDownConversionAllowed), this.ewmaAlpha);
    this.teamState.set(game.homeTeam, home);
    this.teamState.set(game.awayTeam, away);
    this.processedCompletedGames += 1;
    this.lastAppliedGameId = game.gameId;
  }

  snapshot(): { currentSeason: number; processedCompletedGames: number; lastAppliedGameId: string | null; teamState: NflR5H21LateDownTeamState[] } {
    return {
      currentSeason: this.currentSeason,
      processedCompletedGames: this.processedCompletedGames,
      lastAppliedGameId: this.lastAppliedGameId,
      teamState: [...this.teamState.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([team, state]) => ({ team, ...state })),
    };
  }
}

export function scoreNflR5H21LateDownPregame(args: {
  gameId: string;
  season: number;
  week: number;
  gameday: string;
  features: NflLateDownFeatureMap;
  referenceHomeWinProbability: number;
  coreSelected: boolean;
}): NflR5H21LateDownScore {
  const artifact = getNflR5H21Artifact();
  if (args.season !== artifact.targetSeason) throw new Error(`NFL R5H21 artifact targets ${artifact.targetSeason}; received ${args.season}`);
  if (!Number.isFinite(args.referenceHomeWinProbability)) throw new Error("NFL R5H21 reference probability is not finite");
  const lateDownProbability = predictFrozenLogit(artifact.model, args.features);
  const direction = args.referenceHomeWinProbability >= 0.5 ? 1 : -1;
  const supportScore = direction * logit(lateDownProbability);
  const thresholdOnlySelected = !args.coreSelected
    && Number.isFinite(supportScore)
    && supportScore > 0
    && supportScore >= NFL_R5H21_FROZEN_2026_THRESHOLD;
  return {
    schemaVersion: "courtedge-nfl-r5h21-late-down-score.v1",
    artifactDigest: NFL_R5H21_ARTIFACT_DIGEST,
    gameId: args.gameId,
    season: 2026,
    week: args.week,
    gameday: args.gameday,
    lateDownProbability,
    supportScore,
    threshold: NFL_R5H21_FROZEN_2026_THRESHOLD,
    thresholdOnlySelected,
    predictedSide: args.referenceHomeWinProbability >= 0.5 ? "HOME" : "AWAY",
    safety: {
      pregameOnly: true,
      sameGameOutcomeUsed: false,
      postKickoffEvidenceUsed: false,
      marketDataUsedAsModelFeature: false,
      targetSeasonRankingOrCapUsed: false,
      historicalAccuracyExposedAsGameProbability: false,
      automaticBetPlacement: false,
    },
  };
}
