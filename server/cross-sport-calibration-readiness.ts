import type { CalibrationSport } from "./cross-sport-calibration";

export const CROSS_SPORT_CALIBRATION_READINESS_SCHEMA = "courtedge-cross-sport-calibration-readiness.v1" as const;

export type CalibrationEvidenceState =
  | "PROSPECTIVE_LABELED_ONLY"
  | "PREGAME_SIGNAL_WITHOUT_OUTCOME_CUSTODY"
  | "CANDIDATE_CUSTODY_MISSING"
  | "CERTIFIED_AGGREGATES_WITHOUT_CALIBRATION_ROWSET"
  | "READY_FOR_FIT"
  | "CERTIFIED";

export type SportCalibrationReadiness = {
  sport: CalibrationSport;
  state: CalibrationEvidenceState;
  evidenceSources: string[];
  rawSignalCustody: boolean;
  binaryOutcomeCustody: boolean;
  multiSeasonOosRowset: boolean;
  candidatePolicyFrozen: boolean;
  calibrationArtifactDigest: string | null;
  blockers: string[];
};

export const CROSS_SPORT_CALIBRATION_PROTOCOL = {
  method: "PLATT_LOGIT_1D" as const,
  methodSelectionUsesTargetOutcomes: false as const,
  split: "ROLLING_ORIGIN_SEASON" as const,
  minimumTargetSeasonsWhenApplicable: 5 as const,
  minimumFitObservationsPerSignalFamily: 20 as const,
  requiredMetrics: ["BRIER", "LOG_LOSS", "ECE10"] as const,
  targetSeasonRankingOrCapAllowed: false as const,
  aggregateHitRateAcceptedAsGameProbability: false as const,
  sameGameOutcomeAtDecisionTimeAllowed: false as const,
  certificationRequiresMachineReadableLabeledRows: true as const,
} as const;

const SPORTS: Record<CalibrationSport, SportCalibrationReadiness> = {
  MLB: {
    sport: "MLB",
    state: "PROSPECTIVE_LABELED_ONLY",
    evidenceSources: ["server/mlb-shadow-evaluation.ts", "server/mlb-s6l-scientific-metrics.ts"],
    rawSignalCustody: true,
    binaryOutcomeCustody: true,
    multiSeasonOosRowset: false,
    candidatePolicyFrozen: true,
    calibrationArtifactDigest: null,
    blockers: ["No frozen multi-season OOS cross-sport calibration rowset is currently registered for the Elite candidate definition."],
  },
  NBA: {
    sport: "NBA",
    state: "CANDIDATE_CUSTODY_MISSING",
    evidenceSources: ["server/nba-independent-routes.ts"],
    rawSignalCustody: false,
    binaryOutcomeCustody: false,
    multiSeasonOosRowset: false,
    candidatePolicyFrozen: false,
    calibrationArtifactDigest: null,
    blockers: ["Operational context transport exists, but no machine-readable Elite candidate probability/outcome custody was identified."],
  },
  WNBA: {
    sport: "WNBA",
    state: "PREGAME_SIGNAL_WITHOUT_OUTCOME_CUSTODY",
    evidenceSources: ["server/wnba-s6d-predictor-shadow-service.ts", "server/wnba-s6e-evaluation-emission-service.ts"],
    rawSignalCustody: true,
    binaryOutcomeCustody: false,
    multiSeasonOosRowset: false,
    candidatePolicyFrozen: false,
    calibrationArtifactDigest: null,
    blockers: ["Pregame model probabilities are persisted, but an equivalent certified settlement/outcome chain was not identified for calibration labels."],
  },
  NHL: {
    sport: "NHL",
    state: "CANDIDATE_CUSTODY_MISSING",
    evidenceSources: ["server/nhl-manual-routes.ts"],
    rawSignalCustody: false,
    binaryOutcomeCustody: false,
    multiSeasonOosRowset: false,
    candidatePolicyFrozen: false,
    calibrationArtifactDigest: null,
    blockers: ["Verified context transport exists, but no machine-readable Elite candidate probability/outcome custody was identified."],
  },
  NFL: {
    sport: "NFL",
    state: "CERTIFIED_AGGREGATES_WITHOUT_CALIBRATION_ROWSET",
    evidenceSources: ["server/nfl-cross-sport-readiness.ts", "server/nfl-r5h19-artifact.ts", "server/nfl-r5h21-artifact.ts"],
    rawSignalCustody: true,
    binaryOutcomeCustody: false,
    multiSeasonOosRowset: false,
    candidatePolicyFrozen: true,
    calibrationArtifactDigest: null,
    blockers: ["Certified historical aggregate performance is not a substitute for a machine-readable rowset containing each Elite raw signal and binary outcome."],
  },
};

export type CrossSportCalibrationReadiness = {
  schemaVersion: typeof CROSS_SPORT_CALIBRATION_READINESS_SCHEMA;
  state: "BLOCKED" | "READY_FOR_FIT" | "CERTIFIED";
  sports: Record<CalibrationSport, SportCalibrationReadiness>;
  protocol: typeof CROSS_SPORT_CALIBRATION_PROTOCOL;
  globalRankerCalibrationCertified: boolean;
  reasons: string[];
  safety: {
    automaticPromotion: false;
    automaticBetPlacement: false;
    historicalAccuracyUsedAsGameProbability: false;
    targetSeasonRankingOrCapUsed: false;
  };
};

export function getCrossSportCalibrationReadiness(): CrossSportCalibrationReadiness {
  const sports = structuredClone(SPORTS);
  const values = Object.values(sports);
  const allCertified = values.every((entry) => entry.state === "CERTIFIED" && Boolean(entry.calibrationArtifactDigest));
  const allFitReady = values.every((entry) => entry.state === "READY_FOR_FIT" || entry.state === "CERTIFIED");
  return {
    schemaVersion: CROSS_SPORT_CALIBRATION_READINESS_SCHEMA,
    state: allCertified ? "CERTIFIED" : allFitReady ? "READY_FOR_FIT" : "BLOCKED",
    sports,
    protocol: CROSS_SPORT_CALIBRATION_PROTOCOL,
    globalRankerCalibrationCertified: allCertified,
    reasons: values.flatMap((entry) => entry.blockers.map((blocker) => `${entry.sport}: ${blocker}`)),
    safety: {
      automaticPromotion: false,
      automaticBetPlacement: false,
      historicalAccuracyUsedAsGameProbability: false,
      targetSeasonRankingOrCapUsed: false,
    },
  };
}
