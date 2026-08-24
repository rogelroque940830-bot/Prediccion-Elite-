export const NFL_ELITE_INTEGRATION_SCHEMA = "courtedge-nfl-elite-integration.v1" as const;
export const NFL_ELITE_RESEARCH_PR = 663 as const;
export const NFL_R5H16_EVIDENCE = {
  protectedCore: { games: 158, wins: 125, losses: 33, accuracy: 0.7911392405063291 },
  lateDownMarginal: { games: 46, wins: 40, losses: 6, accuracy: 0.8695652173913043 },
  combined: { games: 204, wins: 165, losses: 39, accuracy: 0.8088235294117647 },
} as const;

export type NflEliteIntegrationState = "BLOCKED" | "SHADOW" | "READY";

export type NflEliteIntegrationStatus = {
  schemaVersion: typeof NFL_ELITE_INTEGRATION_SCHEMA;
  sport: "NFL";
  state: NflEliteIntegrationState;
  researchPr: typeof NFL_ELITE_RESEARCH_PR;
  protectedCore: "R5H8_INTERACTION_CONTRADICTION_ENGINE";
  marginalFamily: "LATE_DOWN_CONVERSION";
  r5h16HistoricalEvidence: typeof NFL_R5H16_EVIDENCE;
  r5h18ProspectiveDeployability: "PENDING" | "PASS" | "FAIL";
  frozen2026InferenceArtifact: "PENDING" | "VERIFIED";
  livePregameFeatureMaterializer: "PENDING" | "VERIFIED";
  parityGate: "PENDING" | "PASS" | "FAIL";
  marketDataUsedAsModelFeature: false;
  sameGameOutcomeAllowed: false;
  postKickoffEvidenceAllowed: false;
  automaticBetPlacement: false;
  automaticPromotion: false;
  historicalAccuracyExposedAsGameProbability: false;
  reasons: string[];
};

/**
 * Fail-closed custody gate for NFL Elite production integration.
 * Historical results are evidence only. They are never emitted as a per-game probability.
 */
export function getNflEliteIntegrationStatus(): NflEliteIntegrationStatus {
  const r5h18 = String(process.env.NFL_R5H18_PROSPECTIVE_GATE ?? "").trim().toUpperCase();
  const artifact = String(process.env.NFL_ELITE_2026_ARTIFACT_VERIFIED ?? "").trim().toLowerCase() === "true";
  const materializer = String(process.env.NFL_ELITE_MATERIALIZER_VERIFIED ?? "").trim().toLowerCase() === "true";
  const parity = String(process.env.NFL_ELITE_PARITY_GATE ?? "").trim().toUpperCase();

  const r5h18State = r5h18 === "PASS" ? "PASS" : r5h18 === "FAIL" ? "FAIL" : "PENDING";
  const parityState = parity === "PASS" ? "PASS" : parity === "FAIL" ? "FAIL" : "PENDING";
  const reasons: string[] = [];
  if (r5h18State !== "PASS") reasons.push("Late-down prospective deployability is not certified for production.");
  if (!artifact) reasons.push("Frozen 2026 NFL inference artifact has not been verified in production custody.");
  if (!materializer) reasons.push("Live pregame NFL feature materializer has not passed leakage/cutoff verification.");
  if (parityState !== "PASS") reasons.push("Research-to-production parity gate has not passed.");

  const ready = r5h18State === "PASS" && artifact && materializer && parityState === "PASS";
  return {
    schemaVersion: NFL_ELITE_INTEGRATION_SCHEMA,
    sport: "NFL",
    state: ready ? "READY" : "BLOCKED",
    researchPr: NFL_ELITE_RESEARCH_PR,
    protectedCore: "R5H8_INTERACTION_CONTRADICTION_ENGINE",
    marginalFamily: "LATE_DOWN_CONVERSION",
    r5h16HistoricalEvidence: NFL_R5H16_EVIDENCE,
    r5h18ProspectiveDeployability: r5h18State,
    frozen2026InferenceArtifact: artifact ? "VERIFIED" : "PENDING",
    livePregameFeatureMaterializer: materializer ? "VERIFIED" : "PENDING",
    parityGate: parityState,
    marketDataUsedAsModelFeature: false,
    sameGameOutcomeAllowed: false,
    postKickoffEvidenceAllowed: false,
    automaticBetPlacement: false,
    automaticPromotion: false,
    historicalAccuracyExposedAsGameProbability: false,
    reasons: ready ? ["All NFL Elite production custody gates are verified."] : reasons,
  };
}
