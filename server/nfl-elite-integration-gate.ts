import { getNflR5H21Artifact } from "./nfl-r5h21-artifact";

export const NFL_ELITE_INTEGRATION_SCHEMA = "courtedge-nfl-elite-integration.v3" as const;
export const NFL_ELITE_RESEARCH_PR = 663 as const;
export const NFL_R5H16_EVIDENCE = {
  protectedCore: { games: 158, wins: 125, losses: 33, accuracy: 0.7911392405063291 },
  lateDownMarginal: { games: 46, wins: 40, losses: 6, accuracy: 0.8695652173913043 },
  combined: { games: 204, wins: 165, losses: 39, accuracy: 0.8088235294117647 },
} as const;
export const NFL_R5H18_CERTIFIED_EVIDENCE = {
  protectedCore: { games: 158, wins: 125, losses: 33, accuracy: 0.7911392405063291 },
  lateDownThresholdOnly: { games: 53, wins: 46, losses: 7, accuracy: 0.8679245283018868 },
  combined: { games: 211, wins: 171, losses: 40, accuracy: 0.8104265402843602 },
} as const;

export type NflEliteIntegrationState = "BLOCKED" | "CORE_READY" | "FULL_READY";

export type NflEliteIntegrationStatus = {
  schemaVersion: typeof NFL_ELITE_INTEGRATION_SCHEMA;
  sport: "NFL";
  state: NflEliteIntegrationState;
  coreReady: boolean;
  lateDownEnabled: boolean;
  researchPr: typeof NFL_ELITE_RESEARCH_PR;
  protectedCore: "R5H8_INTERACTION_CONTRADICTION_ENGINE";
  marginalFamily: "LATE_DOWN_CONVERSION";
  productionPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING";
  r5h16HistoricalEvidence: typeof NFL_R5H16_EVIDENCE;
  r5h18CertifiedEvidence: typeof NFL_R5H18_CERTIFIED_EVIDENCE;
  r5h18ProspectiveDeployability: "PENDING" | "PASS" | "FAIL";
  frozen2026InferenceArtifact: "PENDING" | "VERIFIED";
  livePregameFeatureMaterializer: "PENDING" | "VERIFIED";
  parityGate: "PENDING" | "PASS" | "FAIL";
  r5h21RuntimeArtifact: "VERIFIED" | "FAIL";
  r5h21ParityGate: "PASS";
  marketDataUsedAsModelFeature: false;
  sameGameOutcomeAllowed: false;
  postKickoffEvidenceAllowed: false;
  targetSeasonRankingOrCapUsed: false;
  automaticBetPlacement: false;
  automaticPromotion: false;
  historicalAccuracyExposedAsGameProbability: false;
  reasons: string[];
};

/**
 * Fail-closed production custody gate. CI certifies R5H21 artifact/parity, while explicit
 * deployment environment gates still control promotion of the already-integrated code path.
 */
export function getNflEliteIntegrationStatus(): NflEliteIntegrationStatus {
  const r5h18 = String(process.env.NFL_R5H18_PROSPECTIVE_GATE ?? "").trim().toUpperCase();
  const artifact = String(process.env.NFL_ELITE_2026_ARTIFACT_VERIFIED ?? "").trim().toLowerCase() === "true";
  const materializer = String(process.env.NFL_ELITE_MATERIALIZER_VERIFIED ?? "").trim().toLowerCase() === "true";
  const parity = String(process.env.NFL_ELITE_PARITY_GATE ?? "").trim().toUpperCase();

  const r5h18State = r5h18 === "PASS" ? "PASS" : r5h18 === "FAIL" ? "FAIL" : "PENDING";
  const parityState = parity === "PASS" ? "PASS" : parity === "FAIL" ? "FAIL" : "PENDING";
  let r5h21Verified = false;
  const reasons: string[] = [];
  try {
    getNflR5H21Artifact();
    r5h21Verified = true;
  } catch (error) {
    reasons.push(`Frozen R5H21 late-down runtime artifact failed custody: ${error instanceof Error ? error.message : String(error)}`);
  }

  const coreReady = artifact && materializer && parityState === "PASS";
  const lateDownEnabled = coreReady && r5h18State === "PASS" && r5h21Verified;
  const state: NflEliteIntegrationState = !coreReady ? "BLOCKED" : lateDownEnabled ? "FULL_READY" : "CORE_READY";

  if (!artifact) reasons.push("Frozen 2026 NFL R5H8 inference artifact has not been verified in production custody.");
  if (!materializer) reasons.push("Live pregame NFL feature materializer has not passed leakage/cutoff verification.");
  if (parityState !== "PASS") reasons.push("Research-to-production R5H8 parity gate has not passed.");
  if (coreReady && r5h18State !== "PASS") reasons.push("R5H8 core is ready; R5H18 prospective deployability has not been promoted.");
  if (coreReady && r5h18State === "PASS" && !r5h21Verified) reasons.push("R5H8 core is ready; R5H21 runtime artifact failed custody and late-down remains disabled.");
  if (lateDownEnabled) reasons.push("R5H8 core + R5H21 threshold-only LATE_DOWN_CONVERSION are ready under explicit production custody gates.");

  return {
    schemaVersion: NFL_ELITE_INTEGRATION_SCHEMA,
    sport: "NFL",
    state,
    coreReady,
    lateDownEnabled,
    researchPr: NFL_ELITE_RESEARCH_PR,
    protectedCore: "R5H8_INTERACTION_CONTRADICTION_ENGINE",
    marginalFamily: "LATE_DOWN_CONVERSION",
    productionPolicy: "THRESHOLD_ONLY_NO_TARGET_SEASON_RANKING",
    r5h16HistoricalEvidence: NFL_R5H16_EVIDENCE,
    r5h18CertifiedEvidence: NFL_R5H18_CERTIFIED_EVIDENCE,
    r5h18ProspectiveDeployability: r5h18State,
    frozen2026InferenceArtifact: artifact ? "VERIFIED" : "PENDING",
    livePregameFeatureMaterializer: materializer ? "VERIFIED" : "PENDING",
    parityGate: parityState,
    r5h21RuntimeArtifact: r5h21Verified ? "VERIFIED" : "FAIL",
    r5h21ParityGate: "PASS",
    marketDataUsedAsModelFeature: false,
    sameGameOutcomeAllowed: false,
    postKickoffEvidenceAllowed: false,
    targetSeasonRankingOrCapUsed: false,
    automaticBetPlacement: false,
    automaticPromotion: false,
    historicalAccuracyExposedAsGameProbability: false,
    reasons,
  };
}
