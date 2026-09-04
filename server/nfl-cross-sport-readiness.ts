import type {
  NflFullElite2026Snapshot,
  NflFullEliteCard,
} from "./nfl-full-elite-operational-2026";

export const NFL_CROSS_SPORT_READINESS_SCHEMA = "courtedge-nfl-cross-sport-readiness.v1" as const;

export type CrossSportCalibrationStatus = "UNCALIBRATED" | "CERTIFIED";
export type GlobalRankerBlockReason =
  | "SPORT_ELITE_GATE_NOT_PASSED"
  | "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED"
  | "CALIBRATION_ARTIFACT_MISSING"
  | "CALIBRATED_PROBABILITY_INVALID";

export type GlobalRankerEligibility = {
  eligible: boolean;
  reason: GlobalRankerBlockReason | null;
};

export function evaluateGlobalRankerEligibility(input: {
  sportEliteGatePassed: boolean;
  calibrationStatus: CrossSportCalibrationStatus;
  calibrationArtifactDigest: string | null;
  calibratedProbability: number | null;
}): GlobalRankerEligibility {
  if (!input.sportEliteGatePassed) {
    return { eligible: false, reason: "SPORT_ELITE_GATE_NOT_PASSED" };
  }
  if (input.calibrationStatus !== "CERTIFIED") {
    return { eligible: false, reason: "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED" };
  }
  if (!input.calibrationArtifactDigest?.trim()) {
    return { eligible: false, reason: "CALIBRATION_ARTIFACT_MISSING" };
  }
  if (
    input.calibratedProbability === null
    || !Number.isFinite(input.calibratedProbability)
    || input.calibratedProbability <= 0
    || input.calibratedProbability >= 1
  ) {
    return { eligible: false, reason: "CALIBRATED_PROBABILITY_INVALID" };
  }
  return { eligible: true, reason: null };
}

export type NflCrossSportReadinessCandidate = {
  schemaVersion: typeof NFL_CROSS_SPORT_READINESS_SCHEMA;
  sport: "NFL";
  gameId: string;
  season: 2026;
  week: number;
  gameday: string;
  homeTeam: string;
  awayTeam: string;
  predictedTeam: string;
  predictedSide: "HOME" | "AWAY";
  routeModelProbability: number;
  routeSupportScore: number | null;
  sportEliteGate: {
    passed: true;
    decision: "NFL_ELITE";
    route: "R5H8_CORE" | "LATE_DOWN";
  };
  crossSportCalibration: {
    status: "UNCALIBRATED";
    calibratedProbability: null;
    artifactDigest: null;
  };
  globalRanker: {
    eligible: false;
    reason: "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED";
  };
  safety: {
    pregameOnly: true;
    sameGameOutcomeUsed: false;
    targetGamedayUpdatesAllowed: false;
    marketDataUsedAsModelFeature: false;
    targetSeasonRankingOrCapUsed: false;
    historicalAccuracyUsedAsGameProbability: false;
    automaticBetPlacement: false;
  };
};

export type NflCrossSportReadiness = {
  schemaVersion: typeof NFL_CROSS_SPORT_READINESS_SCHEMA;
  sport: "NFL";
  season: 2026;
  generatedAt: string;
  sourceState: NflFullElite2026Snapshot["state"];
  sourceSchemaVersion: NflFullElite2026Snapshot["schemaVersion"];
  calibrationStatus: "UNCALIBRATED";
  globalRankerEligible: false;
  globalRankerBlockReason: "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED";
  candidates: NflCrossSportReadinessCandidate[];
  globalRankerCandidates: [];
  rejectedEliteCards: number;
  reasons: string[];
  safety: {
    adapterReadOnly: true;
    sportModelChanged: false;
    sportThresholdsChanged: false;
    marketDataUsedAsModelFeature: false;
    targetSeasonRankingOrCapUsed: false;
    historicalAccuracyUsedAsGameProbability: false;
    automaticBetPlacement: false;
    automaticPromotion: false;
  };
};

type NflCrossSportCardInput = Pick<
  NflFullEliteCard,
  | "gameId"
  | "season"
  | "week"
  | "gameday"
  | "homeTeam"
  | "awayTeam"
  | "state"
  | "modelDecision"
  | "predictedTeam"
  | "predictedSide"
  | "predictedSideProbability"
  | "eliteRoute"
  | "lateDownScore"
>;

function finiteProbability(value: unknown): number | null {
  const probability = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  return probability;
}

function routeSignal(card: NflCrossSportCardInput): { probability: number; supportScore: number | null } | null {
  if (card.eliteRoute === "R5H8_CORE") {
    const probability = finiteProbability(card.predictedSideProbability);
    return probability === null ? null : { probability, supportScore: null };
  }
  if (card.eliteRoute !== "LATE_DOWN") return null;
  const late = card.lateDownScore;
  if (!late?.thresholdOnlySelected || late.predictedSide !== card.predictedSide) return null;
  const homeProbability = finiteProbability(late.lateDownProbability);
  if (homeProbability === null || !Number.isFinite(late.supportScore)) return null;
  return {
    probability: card.predictedSide === "HOME" ? homeProbability : 1 - homeProbability,
    supportScore: late.supportScore,
  };
}

function candidateFromCard(card: NflCrossSportCardInput): NflCrossSportReadinessCandidate | null {
  if (card.state !== "NFL_ELITE" || card.modelDecision !== "NFL_ELITE" || !card.eliteRoute) return null;
  if (!card.predictedTeam || (card.predictedSide !== "HOME" && card.predictedSide !== "AWAY")) return null;
  const signal = routeSignal(card);
  if (!signal) return null;

  const globalRanker = evaluateGlobalRankerEligibility({
    sportEliteGatePassed: true,
    calibrationStatus: "UNCALIBRATED",
    calibrationArtifactDigest: null,
    calibratedProbability: null,
  });
  if (globalRanker.eligible || globalRanker.reason !== "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED") {
    throw new Error("NFL cross-sport readiness gate violated fail-closed calibration policy");
  }

  return {
    schemaVersion: NFL_CROSS_SPORT_READINESS_SCHEMA,
    sport: "NFL",
    gameId: card.gameId,
    season: card.season,
    week: card.week,
    gameday: card.gameday,
    homeTeam: card.homeTeam,
    awayTeam: card.awayTeam,
    predictedTeam: card.predictedTeam,
    predictedSide: card.predictedSide,
    routeModelProbability: signal.probability,
    routeSupportScore: signal.supportScore,
    sportEliteGate: {
      passed: true,
      decision: "NFL_ELITE",
      route: card.eliteRoute,
    },
    crossSportCalibration: {
      status: "UNCALIBRATED",
      calibratedProbability: null,
      artifactDigest: null,
    },
    globalRanker: {
      eligible: false,
      reason: "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED",
    },
    safety: {
      pregameOnly: true,
      sameGameOutcomeUsed: false,
      targetGamedayUpdatesAllowed: false,
      marketDataUsedAsModelFeature: false,
      targetSeasonRankingOrCapUsed: false,
      historicalAccuracyUsedAsGameProbability: false,
      automaticBetPlacement: false,
    },
  };
}

function snapshotSafetyPasses(snapshot: Pick<NflFullElite2026Snapshot, "safety" | "lateDown">): boolean {
  return snapshot.safety.pregameOnly === true
    && snapshot.safety.sameGameOutcomeUsed === false
    && snapshot.safety.targetGamedayUpdatesAllowed === false
    && snapshot.safety.marketDataUsedAsModelFeature === false
    && snapshot.safety.automaticBetPlacement === false
    && snapshot.lateDown.artifactPolicy === "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING";
}

export function buildNflCrossSportReadiness(
  snapshot: Pick<
    NflFullElite2026Snapshot,
    "schemaVersion" | "sport" | "season" | "generatedAt" | "state" | "cards" | "safety" | "lateDown"
  >,
): NflCrossSportReadiness {
  const reasons: string[] = ["CROSS_SPORT_CALIBRATION_NOT_CERTIFIED"];
  const safe = snapshotSafetyPasses(snapshot);
  if (snapshot.state === "BLOCKED") reasons.push("NFL_OPERATIONAL_SNAPSHOT_BLOCKED");
  if (!safe) reasons.push("NFL_SAFETY_CONTRACT_FAILED");

  const candidates = snapshot.state === "BLOCKED" || !safe
    ? []
    : snapshot.cards.map(candidateFromCard).filter((candidate): candidate is NflCrossSportReadinessCandidate => candidate !== null);
  const eligibleCardCount = snapshot.cards.filter((card) => card.state === "NFL_ELITE" && card.modelDecision === "NFL_ELITE").length;

  return {
    schemaVersion: NFL_CROSS_SPORT_READINESS_SCHEMA,
    sport: "NFL",
    season: snapshot.season,
    generatedAt: snapshot.generatedAt,
    sourceState: snapshot.state,
    sourceSchemaVersion: snapshot.schemaVersion,
    calibrationStatus: "UNCALIBRATED",
    globalRankerEligible: false,
    globalRankerBlockReason: "CROSS_SPORT_CALIBRATION_NOT_CERTIFIED",
    candidates,
    globalRankerCandidates: [],
    rejectedEliteCards: Math.max(0, eligibleCardCount - candidates.length),
    reasons: [...new Set(reasons)],
    safety: {
      adapterReadOnly: true,
      sportModelChanged: false,
      sportThresholdsChanged: false,
      marketDataUsedAsModelFeature: false,
      targetSeasonRankingOrCapUsed: false,
      historicalAccuracyUsedAsGameProbability: false,
      automaticBetPlacement: false,
      automaticPromotion: false,
    },
  };
}
