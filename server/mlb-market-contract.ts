import { z } from "zod";

export const MLB_MARKET_CONTRACT_VERSION = "courtedge-p1-m6a1-mlb-market-contract.v1" as const;

export const MLB_MARKET_TYPES = [
  "ML",
  "F5_ML",
  "F3_ML",
  "RUN_LINE",
  "F5_RUN_LINE",
  "F3_RUN_LINE",
  "TOTAL",
  "F5_TOTAL",
  "F3_TOTAL",
  "TEAM_TOTAL",
  "F5_TEAM_TOTAL",
  "F3_TEAM_TOTAL",
  "TT_OVER_15_F5",
  "TT_UNDER_25_F5",
  "INNING_1_ML",
  "NRFI",
  "YRFI",
  "OTHER",
] as const;

export const mlbMarketTypeSchema = z.enum(MLB_MARKET_TYPES);
export type MlbMarketType = z.infer<typeof mlbMarketTypeSchema>;

export type MlbMarketPeriod = "FULL_GAME" | "FIRST_5" | "FIRST_3" | "FIRST_INNING" | "OTHER";
export type MlbMarketFamily = "MONEYLINE" | "RUN_LINE" | "TOTAL" | "TEAM_TOTAL" | "FIRST_INNING_RUNS" | "OTHER";
export type MlbSettlementRule =
  | "TWO_WAY_PUSH_ON_TIE"
  | "RUN_LINE"
  | "TOTAL"
  | "TEAM_TOTAL"
  | "BINARY_FIRST_INNING_RUNS"
  | "UNSUPPORTED";
export type MlbQuoteContract = "TWO_WAY_PUSH_ON_TIE" | "TWO_WAY" | "BINARY" | "LEGACY_TWO_WAY" | "UNSUPPORTED";

export interface MlbMarketContract {
  type: MlbMarketType;
  period: MlbMarketPeriod;
  family: MlbMarketFamily;
  regulationInnings: number | null;
  settlementRule: MlbSettlementRule;
  quoteContract: MlbQuoteContract;
  requiresSelectionTeam: boolean;
  requiresLine: boolean;
  productionEligible: boolean;
}

function contract(
  type: MlbMarketType,
  period: MlbMarketPeriod,
  family: MlbMarketFamily,
  regulationInnings: number | null,
  settlementRule: MlbSettlementRule,
  quoteContract: MlbQuoteContract,
  requiresSelectionTeam: boolean,
  requiresLine: boolean,
  productionEligible = true,
): MlbMarketContract {
  return {
    type,
    period,
    family,
    regulationInnings,
    settlementRule,
    quoteContract,
    requiresSelectionTeam,
    requiresLine,
    productionEligible,
  };
}

export const MLB_MARKET_CONTRACTS: Readonly<Record<MlbMarketType, MlbMarketContract>> = Object.freeze({
  ML: contract("ML", "FULL_GAME", "MONEYLINE", null, "TWO_WAY_PUSH_ON_TIE", "TWO_WAY_PUSH_ON_TIE", true, false),
  F5_ML: contract("F5_ML", "FIRST_5", "MONEYLINE", 5, "TWO_WAY_PUSH_ON_TIE", "TWO_WAY_PUSH_ON_TIE", true, false),
  F3_ML: contract("F3_ML", "FIRST_3", "MONEYLINE", 3, "TWO_WAY_PUSH_ON_TIE", "TWO_WAY_PUSH_ON_TIE", true, false),
  RUN_LINE: contract("RUN_LINE", "FULL_GAME", "RUN_LINE", null, "RUN_LINE", "TWO_WAY", true, true),
  F5_RUN_LINE: contract("F5_RUN_LINE", "FIRST_5", "RUN_LINE", 5, "RUN_LINE", "TWO_WAY", true, true),
  F3_RUN_LINE: contract("F3_RUN_LINE", "FIRST_3", "RUN_LINE", 3, "RUN_LINE", "TWO_WAY", true, true),
  TOTAL: contract("TOTAL", "FULL_GAME", "TOTAL", null, "TOTAL", "TWO_WAY", false, true),
  F5_TOTAL: contract("F5_TOTAL", "FIRST_5", "TOTAL", 5, "TOTAL", "TWO_WAY", false, true),
  F3_TOTAL: contract("F3_TOTAL", "FIRST_3", "TOTAL", 3, "TOTAL", "TWO_WAY", false, true),
  TEAM_TOTAL: contract("TEAM_TOTAL", "FULL_GAME", "TEAM_TOTAL", null, "TEAM_TOTAL", "TWO_WAY", true, true),
  F5_TEAM_TOTAL: contract("F5_TEAM_TOTAL", "FIRST_5", "TEAM_TOTAL", 5, "TEAM_TOTAL", "TWO_WAY", true, true),
  F3_TEAM_TOTAL: contract("F3_TEAM_TOTAL", "FIRST_3", "TEAM_TOTAL", 3, "TEAM_TOTAL", "TWO_WAY", true, true),
  TT_OVER_15_F5: contract("TT_OVER_15_F5", "FIRST_5", "TEAM_TOTAL", 5, "TEAM_TOTAL", "LEGACY_TWO_WAY", true, true),
  TT_UNDER_25_F5: contract("TT_UNDER_25_F5", "FIRST_5", "TEAM_TOTAL", 5, "TEAM_TOTAL", "LEGACY_TWO_WAY", true, true),
  INNING_1_ML: contract("INNING_1_ML", "FIRST_INNING", "MONEYLINE", 1, "TWO_WAY_PUSH_ON_TIE", "TWO_WAY_PUSH_ON_TIE", true, false),
  NRFI: contract("NRFI", "FIRST_INNING", "FIRST_INNING_RUNS", 1, "BINARY_FIRST_INNING_RUNS", "BINARY", false, false),
  YRFI: contract("YRFI", "FIRST_INNING", "FIRST_INNING_RUNS", 1, "BINARY_FIRST_INNING_RUNS", "BINARY", false, false),
  OTHER: contract("OTHER", "OTHER", "OTHER", null, "UNSUPPORTED", "UNSUPPORTED", false, false, false),
});

export function getMlbMarketContract(type: MlbMarketType): MlbMarketContract {
  return MLB_MARKET_CONTRACTS[type];
}

export function parseMlbMarketType(value: unknown): MlbMarketType | null {
  const parsed = mlbMarketTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// P1-M6A1 intentionally supports only the quote/settlement contracts above.
// Three-way F3/F5 moneylines must fail closed in the odds-normalization phase and
// must never be coerced into the TWO_WAY_PUSH_ON_TIE canonical market types.
