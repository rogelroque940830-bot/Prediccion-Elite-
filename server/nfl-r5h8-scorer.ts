import { predictFrozenLogit } from "./nfl-frozen-logit";
import { getNflR5H19Artifact, NFL_R5H19_ARTIFACT_DIGEST } from "./nfl-r5h19-artifact";
import { evaluateNflR5H8, type NflR5H8Evaluation } from "./nfl-r5h8-engine";
import {
  NFL_PREGAME_MATERIALIZER_SCHEMA,
  type NflPregameMaterialization,
} from "./nfl-pregame-materializer";

export type NflR5H8Score = {
  schemaVersion: "courtedge-nfl-r5h8-runtime-score.v1";
  artifactDigest: typeof NFL_R5H19_ARTIFACT_DIGEST;
  gameId: string;
  season: number;
  week: number;
  gameday: string;
  decision: "NFL_ELITE" | "NO_ELITE";
  predictedSide: "HOME" | "AWAY";
  referenceHomeWinProbability: number;
  predictedSideProbability: number;
  expertProbabilities: Record<string, number>;
  evaluation: NflR5H8Evaluation;
  safety: {
    pregameOnly: true;
    sameGameOutcomeUsed: false;
    postKickoffEvidenceUsed: false;
    marketDataUsedAsModelFeature: false;
    historicalAccuracyExposedAsGameProbability: false;
    automaticBetPlacement: false;
  };
};

function assertPregameCustody(materialization: NflPregameMaterialization): void {
  if (materialization.schemaVersion !== NFL_PREGAME_MATERIALIZER_SCHEMA) {
    throw new Error("NFL R5H8 scorer rejected unknown materializer schema");
  }
  if (
    materialization.provenance.mode !== "PREGAME_ONLY"
    || materialization.provenance.sameGameObservationUsed !== false
    || materialization.provenance.targetGamedayUpdatesAllowed !== false
    || materialization.provenance.marketDataUsedAsFeature !== false
  ) {
    throw new Error("NFL R5H8 scorer rejected non-pregame materialization");
  }
}

/**
 * Scores one already-materialized NFL pregame card with the exact frozen 2026 R5H8 artifact.
 * This function does not accept odds, final scores, same-game PBP, or post-kickoff evidence.
 */
export function scoreNflR5H8Pregame(materialization: NflPregameMaterialization): NflR5H8Score {
  assertPregameCustody(materialization);
  const artifact = getNflR5H19Artifact();
  if (materialization.season !== artifact.targetSeason) {
    throw new Error(`NFL R5H8 frozen artifact targets ${artifact.targetSeason}; received ${materialization.season}`);
  }

  const referenceHomeWinProbability = predictFrozenLogit(
    artifact.models.reference.pipeline,
    materialization.features,
  );
  const expertProbabilities: Record<string, number> = {};
  for (const rule of artifact.ruleOrder) {
    const spec = artifact.models.experts[rule];
    if (!spec) throw new Error(`NFL R5H8 frozen artifact missing expert ${rule}`);
    expertProbabilities[rule] = predictFrozenLogit(spec, materialization.features);
  }

  const evaluation = evaluateNflR5H8(
    referenceHomeWinProbability,
    expertProbabilities,
    artifact.reliability,
    artifact.pairStructure,
    artifact.coreConfig,
  );
  const predictedSide = referenceHomeWinProbability >= 0.5 ? "HOME" : "AWAY";
  const predictedSideProbability = predictedSide === "HOME"
    ? referenceHomeWinProbability
    : 1 - referenceHomeWinProbability;

  return {
    schemaVersion: "courtedge-nfl-r5h8-runtime-score.v1",
    artifactDigest: NFL_R5H19_ARTIFACT_DIGEST,
    gameId: materialization.gameId,
    season: materialization.season,
    week: materialization.week,
    gameday: materialization.gameday,
    decision: evaluation.coreSelected ? "NFL_ELITE" : "NO_ELITE",
    predictedSide,
    referenceHomeWinProbability,
    predictedSideProbability,
    expertProbabilities,
    evaluation,
    safety: {
      pregameOnly: true,
      sameGameOutcomeUsed: false,
      postKickoffEvidenceUsed: false,
      marketDataUsedAsModelFeature: false,
      historicalAccuracyExposedAsGameProbability: false,
      automaticBetPlacement: false,
    },
  };
}
