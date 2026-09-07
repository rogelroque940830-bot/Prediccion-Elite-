import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";

export const MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA =
  "courtedge-mlb-r1b-v16-final-baseline-adapter.v1" as const;

export type MlbR1bV16BaselineStage = "FINAL" | "PROVISIONAL";
export type MlbR1bV16BaselineSide = "HOME" | "AWAY";
export type MlbR1bV16BaselineMarket = "FG_ML" | "F5_ML";
export type MlbR1bV16BaselineHorizon = "FULL_GAME" | "EARLY_WINDOW";

export interface MlbR1bV16BaselineRow {
  schemaVersion: typeof MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA;
  officialDate: string;
  gamePk: number;
  side: MlbR1bV16BaselineSide;
  market: MlbR1bV16BaselineMarket;
  horizon: MlbR1bV16BaselineHorizon;
  inputStage: "FINAL";
  probability: number;
  pushProbability: number;
  generatedAt: string;
  priceIndependent: true;
  outcomeFieldsRead: false;
  marketPricesRead: false;
}

function validIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00.000Z`));
}

export function adaptCertifiedFinalC4ToR1bV16Baseline(input: {
  officialDate: string;
  gamePk: number;
  generatedAt: string;
  inputStage: MlbR1bV16BaselineStage;
  c4: C4LiveFeatureAssessment;
}): readonly MlbR1bV16BaselineRow[] {
  if (!validIsoDate(input.officialDate)) throw new Error("MLB_R1B_V16_OFFICIAL_DATE_INVALID");
  if (!Number.isInteger(input.gamePk) || input.gamePk <= 0) throw new Error("MLB_R1B_V16_GAME_PK_INVALID");
  if (input.inputStage !== "FINAL") {
    throw new Error("MLB_R1B_V16_PROVISIONAL_NOT_CERTIFIED_BY_FINAL_ADAPTER");
  }

  const evidence = scoreMlbV16SettlementEvidence(input.gamePk, input.generatedAt, input.c4);
  const base = {
    schemaVersion: MLB_R1B_V16_FINAL_BASELINE_ADAPTER_SCHEMA,
    officialDate: input.officialDate,
    gamePk: input.gamePk,
    inputStage: "FINAL" as const,
    generatedAt: input.generatedAt,
    priceIndependent: true as const,
    outcomeFieldsRead: false as const,
    marketPricesRead: false as const,
  };

  return Object.freeze([
    Object.freeze({ ...base, side: "HOME" as const, market: "FG_ML" as const, horizon: "FULL_GAME" as const, probability: evidence.fullGame.homeWinProbability, pushProbability: 0 }),
    Object.freeze({ ...base, side: "AWAY" as const, market: "FG_ML" as const, horizon: "FULL_GAME" as const, probability: evidence.fullGame.awayWinProbability, pushProbability: 0 }),
    Object.freeze({ ...base, side: "HOME" as const, market: "F5_ML" as const, horizon: "EARLY_WINDOW" as const, probability: evidence.first5.homeWinProbability, pushProbability: evidence.first5.pushProbability }),
    Object.freeze({ ...base, side: "AWAY" as const, market: "F5_ML" as const, horizon: "EARLY_WINDOW" as const, probability: evidence.first5.awayWinProbability, pushProbability: evidence.first5.pushProbability }),
  ]);
}

export const MLB_R1B_V16_FINAL_BASELINE_ADAPTER_POLICY = Object.freeze({
  finalStageOnly: true as const,
  provisionalStageCertified: false as const,
  outcomeFieldsRead: false as const,
  marketPricesRead: false as const,
  modelRefit: false as const,
  newWeightsCreated: false as const,
  thresholdSearch: false as const,
  productionChanged: false as const,
});
