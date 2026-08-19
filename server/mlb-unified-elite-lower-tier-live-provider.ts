import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  assessFullModularLiveOperationalParity,
  type FullModularLiveOperationalAssessment,
} from "./mlb-full-modular-live-operational-bridge";
import {
  scoreMlbFullModularFrozenLiveSlate,
  type MlbFullModularFrozenLiveGame,
  type MlbFullModularFrozenSlateScore,
} from "./mlb-full-modular-frozen-live-scorer-v1";
import {
  scoreMlbPpHorizonFrozenLiveSlate,
  type MlbPpHorizonFrozenSlateScore,
} from "./mlb-pp-horizon-frozen-live-scorer-v1";
import { MlbV68ProspectiveStateLiveAdapter } from "./mlb-v68-prospective-state-live-adapter";
import { MlbFullModularBullpenLiveMaterializer } from "./mlb-full-modular-bullpen-live-materializer";
import { MlbFullModularTeamStrengthLiveMaterializer } from "./mlb-full-modular-team-strength-live-materializer";
import {
  MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE,
  type EliteSelectionInput,
} from "./mlb-unified-elite-router-v1";
import {
  unavailableLowerTierShadowDecisions,
  type MlbUnifiedEliteLowerTierShadowDecisions,
  type MlbUnifiedEliteLowerTierShadowProvider,
} from "./mlb-unified-elite-shadow-v1";

export const MLB_UNIFIED_ELITE_LOWER_TIER_LIVE_PROVIDER_VERSION =
  "mlb-unified-elite-lower-tier-live-provider-v1" as const;

export interface MlbUnifiedEliteLowerTierLiveProviderDependencies {
  full13Materializer?: Pick<MlbC4CertifiedMaterializer, "materializeFull13PregameInput">;
  stateAdapter?: Pick<MlbV68ProspectiveStateLiveAdapter, "buildFullModularEvidence">;
  bullpenMaterializer?: Pick<MlbFullModularBullpenLiveMaterializer, "materializeGame">;
  teamStrengthMaterializer?: Pick<MlbFullModularTeamStrengthLiveMaterializer, "materializeDate">;
  assessOperational?: typeof assessFullModularLiveOperationalParity;
  scoreFullModular?: typeof scoreMlbFullModularFrozenLiveSlate;
  scorePpHorizon?: typeof scoreMlbPpHorizonFrozenLiveSlate;
}

function selectionFromCandidate(candidate: {
  officialDate: string;
  gamePk: number;
  market: string;
  horizon: string;
  side: string;
  selectedLine: number | null;
}): EliteSelectionInput {
  return Object.freeze({
    officialDate: candidate.officialDate,
    gamePk: candidate.gamePk,
    market: candidate.market,
    horizon: candidate.horizon,
    side: candidate.side,
    selectedLine: candidate.selectedLine,
  });
}

function fullModularDecision(score: MlbFullModularFrozenSlateScore) {
  return score.selection
    ? Object.freeze({
      status: "SELECTION" as const,
      selection: selectionFromCandidate(score.selection),
    })
    : Object.freeze({
      status: "NO_PLAY" as const,
      reason: "FULL_MODULAR_FROZEN_SCORER_NO_SELECTION",
    });
}

function ppDecision(score: MlbPpHorizonFrozenSlateScore) {
  return score.selection
    ? Object.freeze({
      status: "SELECTION" as const,
      selection: selectionFromCandidate(score.selection),
    })
    : Object.freeze({
      status: "NO_PLAY" as const,
      reason: "PP_HORIZON_FROZEN_SCORER_NO_SELECTION",
    });
}

function noT5ReadyGames(): MlbUnifiedEliteLowerTierShadowDecisions {
  return Object.freeze({
    ppHorizon: Object.freeze({
      status: "NO_PLAY" as const,
      reason: "PP_HORIZON_NO_T5_READY_GAMES",
    }),
    fullModular: Object.freeze({
      status: "NO_PLAY" as const,
      reason: "FULL_MODULAR_NO_T5_READY_GAMES",
    }),
    sourceStatus: "LOWER_TIER_NO_T5_READY_GAMES",
  });
}

function bridgeFailureStatus(assessment: FullModularLiveOperationalAssessment): string {
  return assessment.status === "NO_PLAY"
    ? `LOWER_TIER_OPERATIONAL_BRIDGE_${assessment.reason}`
    : "LOWER_TIER_OPERATIONAL_BRIDGE_FAILED";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireTargetIdentity(game: {
  gamePk: number;
  startTime: string | null;
  homeTeam: { id: number | null };
  awayTeam: { id: number | null };
}): { homeTeamId: number; awayTeamId: number; startTime: string } {
  const homeTeamId = game.homeTeam.id;
  const awayTeamId = game.awayTeam.id;
  const startTime = game.startTime;
  if (
    typeof homeTeamId !== "number" || !Number.isInteger(homeTeamId) || homeTeamId <= 0
    || typeof awayTeamId !== "number" || !Number.isInteger(awayTeamId) || awayTeamId <= 0
    || homeTeamId === awayTeamId
    || typeof startTime !== "string" || !Number.isFinite(Date.parse(startTime))
  ) {
    throw new Error(`LOWER_TIER_TARGET_IDENTITY_INCOMPLETE:${game.gamePk}`);
  }
  return { homeTeamId, awayTeamId, startTime };
}

export function createMlbUnifiedEliteLowerTierLiveProvider(
  deps: MlbUnifiedEliteLowerTierLiveProviderDependencies = {},
): MlbUnifiedEliteLowerTierShadowProvider {
  const full13Materializer = deps.full13Materializer ?? new MlbC4CertifiedMaterializer();
  const stateAdapter = deps.stateAdapter ?? new MlbV68ProspectiveStateLiveAdapter();
  const bullpenMaterializer = deps.bullpenMaterializer ?? new MlbFullModularBullpenLiveMaterializer();
  const teamStrengthMaterializer = deps.teamStrengthMaterializer ?? new MlbFullModularTeamStrengthLiveMaterializer();
  const assessOperational = deps.assessOperational ?? assessFullModularLiveOperationalParity;
  const scoreFullModular = deps.scoreFullModular ?? scoreMlbFullModularFrozenLiveSlate;
  const scorePpHorizon = deps.scorePpHorizon ?? scoreMlbPpHorizonFrozenLiveSlate;

  return async (context): Promise<MlbUnifiedEliteLowerTierShadowDecisions> => {
    if (context.officialDate < MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE) {
      return unavailableLowerTierShadowDecisions("BEFORE_FROZEN_PROSPECTIVE_BOUNDARY");
    }

    const finalReady = context.slate.games.filter((game) =>
      game.officialDate === context.officialDate
      && game.analysisAllowed
      && game.analysisStage === "FINAL",
    );
    if (finalReady.length === 0) return noT5ReadyGames();

    let strength: Awaited<ReturnType<typeof teamStrengthMaterializer.materializeDate>>;
    try {
      strength = await teamStrengthMaterializer.materializeDate(context.officialDate);
    } catch (error) {
      console.error("Unified Elite lower-tier team strength source failed closed:", error);
      return unavailableLowerTierShadowDecisions(
        `LOWER_TIER_TEAM_STRENGTH_SOURCE_FAILED_CLOSED:${message(error)}`,
      );
    }

    const games: MlbFullModularFrozenLiveGame[] = [];
    for (const game of finalReady) {
      try {
        const target = requireTargetIdentity(game);
        const full13 = await full13Materializer.materializeFull13PregameInput(game);
        const [state, bullpen] = await Promise.all([
          stateAdapter.buildFullModularEvidence(context.officialDate, full13),
          bullpenMaterializer.materializeGame({
            officialDate: context.officialDate,
            homeTeamId: target.homeTeamId,
            awayTeamId: target.awayTeamId,
          }),
        ]);
        const assessment = assessOperational({
          observedAtUtc: context.now.toISOString(),
          scheduledFirstPitchUtc: target.startTime,
          full13,
          v39: state.v39,
          pitchQualityHistory: state.pitchQualityHistory,
          bullpen: {
            homeHistory: bullpen.homeHistory,
            awayHistory: bullpen.awayHistory,
          },
        });

        if (assessment.status === "NO_PLAY") {
          if (assessment.reason === "DECISION_TIMESTAMP_MISSING_OR_LATE") continue;
          console.error(
            `Unified Elite lower-tier operational bridge failed closed for ${game.gamePk}:`,
            assessment.reason,
            assessment.detail ?? "",
          );
          return unavailableLowerTierShadowDecisions(bridgeFailureStatus(assessment));
        }

        games.push(Object.freeze({
          assessment,
          homeStrengthTier: strength.tiers[target.homeTeamId] ?? "UNSTABLE",
          awayStrengthTier: strength.tiers[target.awayTeamId] ?? "UNSTABLE",
        }));
      } catch (error) {
        console.error(`Unified Elite lower-tier source failed closed for ${game.gamePk}:`, error);
        return unavailableLowerTierShadowDecisions(
          `LOWER_TIER_CERTIFIED_SOURCE_FAILED_CLOSED:${message(error)}`,
        );
      }
    }

    if (games.length === 0) return noT5ReadyGames();

    let fullScore: MlbFullModularFrozenSlateScore;
    try {
      fullScore = scoreFullModular({
        officialDate: context.officialDate,
        games,
      });
    } catch (error) {
      console.error("Unified Elite Full Modular frozen scorer failed closed:", error);
      return unavailableLowerTierShadowDecisions(
        `FULL_MODULAR_RUNTIME_INTEGRITY_FAILED:${message(error)}`,
      );
    }

    let ppHorizon: MlbUnifiedEliteLowerTierShadowDecisions["ppHorizon"];
    try {
      ppHorizon = ppDecision(scorePpHorizon({
        officialDate: context.officialDate,
        games,
      }));
    } catch (error) {
      console.error("Unified Elite PP_HORIZON frozen scorer failed closed:", error);
      ppHorizon = Object.freeze({
        status: "TECHNICAL_UNAVAILABLE" as const,
        reason: "PP_RUNTIME_INTEGRITY_FAILED" as const,
      });
    }

    return Object.freeze({
      ppHorizon,
      fullModular: fullModularDecision(fullScore),
      sourceStatus: `CERTIFIED_LOWER_TIER_LIVE_V1:${games.length}`,
    });
  };
}
