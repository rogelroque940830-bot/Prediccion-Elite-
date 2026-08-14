import { buildMlbMarketProbabilityAssessmentDigest, type MlbMarketProbabilityAssessment } from "./mlb-market-edge";

export const MLB_V16_SETTLEMENT_ADAPTER_SCHEMA = "courtedge-p0-mlb-v16-settlement-evidence-adapter.v1" as const;
export const MLB_V16_SETTLEMENT_MODEL_VERSION = "rogel-pure-settlement-ml-f5-v1" as const;
export const MLB_V16_MANIFEST_SHA256 = "059f84a7bf644eece80b40f772d5a0c92a188849012eadf7bbf17f93532b8cbb" as const;

export interface MlbV16SettlementEvidence {
  gamePk: number;
  generatedAt: string;
  modelVersion: typeof MLB_V16_SETTLEMENT_MODEL_VERSION;
  manifestSha256: typeof MLB_V16_MANIFEST_SHA256;
  priceIndependent: true;
  fullGame: { homeWinProbability: number; awayWinProbability: number; pushProbability: 0 };
  first5: { homeWinProbability: number; awayWinProbability: number; pushProbability: number };
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function closeToOne(value: number): boolean { return Math.abs(value - 1) <= 1e-10; }

function assessment(input: Omit<MlbMarketProbabilityAssessment, "modelInputDigest">): MlbMarketProbabilityAssessment {
  return Object.freeze({ ...input, modelInputDigest: buildMlbMarketProbabilityAssessmentDigest(input) });
}

export function adaptMlbV16SettlementEvidence(evidence: MlbV16SettlementEvidence): readonly MlbMarketProbabilityAssessment[] {
  if (!Number.isInteger(evidence.gamePk) || evidence.gamePk <= 0) throw new Error("MLB_V16_GAME_PK_INVALID");
  if (!Number.isFinite(Date.parse(evidence.generatedAt))) throw new Error("MLB_V16_GENERATED_AT_INVALID");
  if (evidence.modelVersion !== MLB_V16_SETTLEMENT_MODEL_VERSION || evidence.manifestSha256 !== MLB_V16_MANIFEST_SHA256 || evidence.priceIndependent !== true) {
    throw new Error("MLB_V16_PROVENANCE_INVALID");
  }
  const fg = evidence.fullGame, f5 = evidence.first5;
  if (![fg.homeWinProbability, fg.awayWinProbability, fg.pushProbability, f5.homeWinProbability, f5.awayWinProbability, f5.pushProbability].every(validProbability)) {
    throw new Error("MLB_V16_PROBABILITY_INVALID");
  }
  if (fg.pushProbability !== 0 || !closeToOne(fg.homeWinProbability + fg.awayWinProbability)) throw new Error("MLB_V16_FULL_GAME_VECTOR_INVALID");
  if (!closeToOne(f5.homeWinProbability + f5.awayWinProbability + f5.pushProbability)) throw new Error("MLB_V16_FIRST5_VECTOR_INVALID");

  const common = { gamePk: evidence.gamePk, line: null, status: "READY" as const, sourcePolicy: "ML_F5_EDGE_CONFIDENCE_V2" as const, generatedAt: evidence.generatedAt, probabilitySemantics: "UNCONDITIONAL_SETTLEMENT" as const, unavailableReason: null };
  return Object.freeze([
    assessment({ ...common, marketType: "ML", side: "HOME", modelVersion: `${evidence.modelVersion}:FULL_GAME`, winProbability: fg.homeWinProbability, pushProbability: 0 }),
    assessment({ ...common, marketType: "ML", side: "AWAY", modelVersion: `${evidence.modelVersion}:FULL_GAME`, winProbability: fg.awayWinProbability, pushProbability: 0 }),
    assessment({ ...common, marketType: "F5_ML", side: "HOME", modelVersion: `${evidence.modelVersion}:FIRST_5`, winProbability: f5.homeWinProbability, pushProbability: f5.pushProbability }),
    assessment({ ...common, marketType: "F5_ML", side: "AWAY", modelVersion: `${evidence.modelVersion}:FIRST_5`, winProbability: f5.awayWinProbability, pushProbability: f5.pushProbability }),
  ]);
}
