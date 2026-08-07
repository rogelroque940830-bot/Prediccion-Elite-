import type { MlbMarketPeriod, MlbMarketType } from "./mlb-market-contract";

export const MLB_P1_M6A3A_SCHEMA = "courtedge-p1-m6a3a-probability-distribution-contract.v1" as const;
export const MLB_P1_M6A3A_MODEL_FAMILY = "NEGATIVE_BINOMIAL_INDEPENDENT_BASELINE" as const;

export type MlbProbabilityHorizon = "FIRST_INNING" | "FIRST_3" | "FIRST_5" | "FULL_GAME";
export type MlbProbabilityModelStatus = "EXPERIMENTAL_SHADOW";
export type MlbFullGameTieHandling = "CONDITION_ON_NON_TIE";
export type MlbMarketOutcome = "WIN" | "PUSH" | "LOSS";

export interface MlbTeamRunProcessInput {
  meanRuns: number;
  /**
   * NB2 dispersion parameter k. Variance = mean + mean^2 / k.
   * A3A does not estimate k; A3B must fit it from historical data.
   */
  dispersionK: number;
  /** Optional zero-inflation mass. A3B must justify any non-zero value. */
  zeroInflation?: number;
  sourceVersion: string;
  sourceDigest: string;
}

export interface MlbHorizonRunDistributionInput {
  horizon: MlbProbabilityHorizon;
  home: MlbTeamRunProcessInput;
  away: MlbTeamRunProcessInput;
  /** Finite support used for numerical evaluation; omitted tail is reported. */
  maxRunsPerTeam?: number;
  fullGameTieHandling?: MlbFullGameTieHandling;
}

export interface MlbRunPmfPoint {
  runs: number;
  probability: number;
}

export interface MlbJointRunPoint {
  homeRuns: number;
  awayRuns: number;
  probability: number;
}

export interface MlbMarginPmfPoint {
  homeMinusAway: number;
  probability: number;
}

export interface MlbHorizonRunDistribution {
  schemaVersion: typeof MLB_P1_M6A3A_SCHEMA;
  modelFamily: typeof MLB_P1_M6A3A_MODEL_FAMILY;
  modelStatus: MlbProbabilityModelStatus;
  actionabilityAllowed: false;
  horizon: MlbProbabilityHorizon;
  period: MlbMarketPeriod;
  homeInput: MlbTeamRunProcessInput;
  awayInput: MlbTeamRunProcessInput;
  maxRunsPerTeam: number;
  homeRuns: MlbRunPmfPoint[];
  awayRuns: MlbRunPmfPoint[];
  jointRuns: MlbJointRunPoint[];
  totalRuns: MlbRunPmfPoint[];
  runMargin: MlbMarginPmfPoint[];
  moneyline: {
    homeWin: number;
    draw: number;
    awayWin: number;
  };
  firstInningRuns: {
    nrfi: number | null;
    yrfi: number | null;
  };
  diagnostics: {
    homeTailMass: number;
    awayTailMass: number;
    rawJointMass: number;
    normalizedJointMass: number;
    fullGameTieMassRemoved: number;
    conditionedOnNonTie: boolean;
    independenceAssumption: true;
  };
}

export interface MlbExactMarketProbabilityRequest {
  marketType: MlbMarketType;
  side: "HOME" | "AWAY" | "OVER" | "UNDER" | "NRFI" | "YRFI";
  line?: number | null;
  variant?: "HOME" | "AWAY" | null;
}

export interface MlbExactMarketProbabilityResult {
  schemaVersion: typeof MLB_P1_M6A3A_SCHEMA;
  status: "OK" | "HORIZON_MISMATCH" | "UNSUPPORTED_MARKET" | "INVALID_REQUEST";
  marketType: MlbMarketType;
  side: MlbExactMarketProbabilityRequest["side"];
  line: number | null;
  horizon: MlbProbabilityHorizon;
  probabilities: Record<MlbMarketOutcome, number> | null;
  actionabilityAllowed: false;
  blockers: string[];
}

export interface MlbCalibrationPolicy {
  /** Must be versioned and produced/approved by A3B, never invented by A3A. */
  policyVersion: string;
  minimumSamples: number;
  maximumMulticlassBrier: number;
  maximumLogLoss: number;
  maximumMacroEce: number;
}

export function horizonToPeriod(horizon: MlbProbabilityHorizon): MlbMarketPeriod {
  if (horizon === "FIRST_INNING") return "FIRST_INNING";
  if (horizon === "FIRST_3") return "FIRST_3";
  if (horizon === "FIRST_5") return "FIRST_5";
  return "FULL_GAME";
}

export function validateRunProcessInput(input: MlbTeamRunProcessInput): void {
  if (!Number.isFinite(input.meanRuns) || input.meanRuns < 0) {
    throw new Error("P1_M6A3A_INVALID_MEAN_RUNS");
  }
  if (!Number.isFinite(input.dispersionK) || input.dispersionK <= 0) {
    throw new Error("P1_M6A3A_INVALID_DISPERSION");
  }
  const zeroInflation = input.zeroInflation ?? 0;
  if (!Number.isFinite(zeroInflation) || zeroInflation < 0 || zeroInflation >= 1) {
    throw new Error("P1_M6A3A_INVALID_ZERO_INFLATION");
  }
  if (!String(input.sourceVersion ?? "").trim() || !String(input.sourceDigest ?? "").trim()) {
    throw new Error("P1_M6A3A_INPUT_PROVENANCE_REQUIRED");
  }
}
