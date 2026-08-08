export const MLB_P1_M4A_SCHEMA = "courtedge-p1-m4a-economic-decision-contract.v1" as const;
export const MLB_P1_M4B_SCHEMA = "courtedge-p1-m4b-economic-decision-adapter.v1" as const;
export const MLB_P1_M4C_FRONTEND_RELEASE = "p1-m4c-mlb-economic-decision-card-2026-08-06" as const;

export type MlbEconomicSignal = "BET" | "LEAN" | "PASS";
export type MlbEconomicActionability = "ACTIONABLE_FINAL" | "WAIT_FOR_FINAL" | "OBSERVE_ONLY" | "BLOCKED";
export type MlbEconomicMarket = "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL";
export type MlbEconomicStage = "FINAL" | "PROVISIONAL";

export interface MlbEconomicPricePoint {
  probability: number;
  decimal: number;
  american: number;
}

export interface MlbEconomicMinimumPrice {
  requiredEdgePp: number;
  oddsAmerican: number | null;
  oddsDecimal: number | null;
  maximumImpliedProbability: number | null;
}

export interface MlbEconomicDecisionResult {
  schemaVersion: typeof MLB_P1_M4A_SCHEMA;
  policyVersion: string;
  market: MlbEconomicMarket;
  stage: MlbEconomicStage;
  modelSignal: MlbEconomicSignal;
  decision: MlbEconomicSignal;
  actionability: MlbEconomicActionability;
  fairPrice: MlbEconomicPricePoint | null;
  minimumPrices: {
    lean: MlbEconomicMinimumPrice;
    bet: MlbEconomicMinimumPrice;
    active: MlbEconomicMinimumPrice | null;
  };
  currentPrice: {
    oddsAmerican: number;
    oddsDecimal: number | null;
    impliedProbability: number | null;
    meetsLeanMinimum: boolean;
    meetsBetMinimum: boolean;
  };
  economics: {
    edgePp: number | null;
    noVigEdgePp: number | null;
    expectedValuePerUnit: number | null;
    fullKellyFraction: number;
    quarterKellyFraction: number;
  };
  stake: {
    analyticalUnits: number;
    maximumUnits: number;
    realFinancialExposure: 0;
  };
  reasons: string[];
  warnings: string[];
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    automaticBetPlacement: false;
    sportsbookIntegration: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export interface MlbEffectiveEconomicDecision {
  decision: MlbEconomicSignal;
  actionability: MlbEconomicActionability;
  analyticalUnits: number;
  sourceSignalCeilingApplied: boolean;
  reasons: string[];
}

export interface MlbEconomicAdapterResult {
  schemaVersion: typeof MLB_P1_M4B_SCHEMA;
  adapterVersion: string;
  status: "ADAPTED";
  sourceDigest: string;
  economicInputDigest: string;
  source: {
    captureSchemaVersion: string;
    captureStatus: "READY_TO_APPEND";
    captureAllowed: true;
    captureIdentity: {
      lifecycleKey: string;
      semanticFingerprint: string;
      clientRequestId: string;
    };
    market: MlbEconomicMarket;
    side: "HOME" | "AWAY" | "OVER" | "UNDER";
    selection: string;
    line: number | null;
    modelProbability: number;
    marketImpliedProbability: number;
    noVigProbability: number | null;
    sourceSignal: "BET_FUERTE" | "BET" | "LEAN" | "PASS" | "INFO";
    sourceCategory: "ELITE" | "PREMIUM" | "LEAN" | "PASS" | "INFO";
    sourceRecommendedStakeUnits: number;
    sourcePolicy: string;
  };
  economicDecision: MlbEconomicDecisionResult;
  effectiveDecision: MlbEffectiveEconomicDecision;
  signalCompatibility: {
    sourceSignal: string;
    sourceSignalNormalized: MlbEconomicSignal;
    economicModelSignal: MlbEconomicSignal;
    relation: "MATCH" | "ECONOMIC_DOWNGRADE" | "ECONOMIC_UPGRADE" | "NON_COMPARABLE_INFO";
    sourcePolicy: string;
    policyDifferenceExpected: boolean;
    originalDecisionPreserved: true;
  };
  errors: [];
  warnings: string[];
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    sportsbookIntegration: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
    originalModelOutputMutated: false;
    ledgerWritePerformed: false;
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function signal(value: unknown): value is MlbEconomicSignal {
  return value === "BET" || value === "LEAN" || value === "PASS";
}

function actionability(value: unknown): value is MlbEconomicActionability {
  return value === "ACTIONABLE_FINAL" || value === "WAIT_FOR_FINAL" || value === "OBSERVE_ONLY" || value === "BLOCKED";
}

function pricePoint(value: unknown): value is MlbEconomicPricePoint {
  const data = object(value);
  return Boolean(data && finite(data.probability) && finite(data.decimal) && finite(data.american));
}

function minimumPrice(value: unknown): value is MlbEconomicMinimumPrice {
  const data = object(value);
  return Boolean(data
    && finite(data.requiredEdgePp)
    && (data.oddsAmerican === null || finite(data.oddsAmerican))
    && (data.oddsDecimal === null || finite(data.oddsDecimal))
    && (data.maximumImpliedProbability === null || finite(data.maximumImpliedProbability)));
}

function economicDecision(value: unknown): value is MlbEconomicDecisionResult {
  const data = object(value);
  const minimum = object(data?.minimumPrices);
  const current = object(data?.currentPrice);
  const economics = object(data?.economics);
  const stake = object(data?.stake);
  const safety = object(data?.safety);
  return Boolean(data
    && data.schemaVersion === MLB_P1_M4A_SCHEMA
    && (data.market === "ML" || data.market === "F5_ML" || data.market === "RUN_LINE" || data.market === "TOTAL" || data.market === "F5_TOTAL")
    && (data.stage === "FINAL" || data.stage === "PROVISIONAL")
    && signal(data.modelSignal)
    && signal(data.decision)
    && actionability(data.actionability)
    && (data.fairPrice === null || pricePoint(data.fairPrice))
    && minimum
    && minimumPrice(minimum.lean)
    && minimumPrice(minimum.bet)
    && (minimum.active === null || minimumPrice(minimum.active))
    && current
    && finite(current.oddsAmerican)
    && (current.oddsDecimal === null || finite(current.oddsDecimal))
    && (current.impliedProbability === null || finite(current.impliedProbability))
    && typeof current.meetsLeanMinimum === "boolean"
    && typeof current.meetsBetMinimum === "boolean"
    && economics
    && (economics.edgePp === null || finite(economics.edgePp))
    && (economics.noVigEdgePp === null || finite(economics.noVigEdgePp))
    && (economics.expectedValuePerUnit === null || finite(economics.expectedValuePerUnit))
    && finite(economics.fullKellyFraction)
    && finite(economics.quarterKellyFraction)
    && stake
    && finite(stake.analyticalUnits)
    && finite(stake.maximumUnits)
    && stake.realFinancialExposure === 0
    && stringArray(data.reasons)
    && stringArray(data.warnings)
    && safety?.mode === "SHADOW_DECISION_SUPPORT"
    && safety.automaticBetPlacement === false
    && safety.sportsbookIntegration === false);
}

export function parseMlbEconomicAdapterResult(value: unknown): MlbEconomicAdapterResult | null {
  const data = object(value);
  const source = object(data?.source);
  const effective = object(data?.effectiveDecision);
  const compatibility = object(data?.signalCompatibility);
  const safety = object(data?.safety);
  if (!data
    || data.schemaVersion !== MLB_P1_M4B_SCHEMA
    || data.status !== "ADAPTED"
    || typeof data.adapterVersion !== "string"
    || typeof data.sourceDigest !== "string"
    || typeof data.economicInputDigest !== "string"
    || !source
    || typeof source.selection !== "string"
    || !(source.market === "ML" || source.market === "F5_ML" || source.market === "RUN_LINE" || source.market === "TOTAL" || source.market === "F5_TOTAL")
    || !(source.side === "HOME" || source.side === "AWAY" || source.side === "OVER" || source.side === "UNDER")
    || (source.line !== null && !finite(source.line))
    || !finite(source.modelProbability)
    || !finite(source.marketImpliedProbability)
    || (source.noVigProbability !== null && !finite(source.noVigProbability))
    || typeof source.sourceSignal !== "string"
    || !economicDecision(data.economicDecision)
    || !effective
    || !signal(effective.decision)
    || !actionability(effective.actionability)
    || !finite(effective.analyticalUnits)
    || typeof effective.sourceSignalCeilingApplied !== "boolean"
    || !stringArray(effective.reasons)
    || !compatibility
    || !signal(compatibility.sourceSignalNormalized)
    || !signal(compatibility.economicModelSignal)
    || typeof compatibility.relation !== "string"
    || !stringArray(data.errors)
    || data.errors.length !== 0
    || !stringArray(data.warnings)
    || !safety
    || safety.mode !== "SHADOW_DECISION_SUPPORT"
    || safety.realFinancialExposure !== 0
    || safety.automaticBetPlacement !== false
    || safety.sportsbookIntegration !== false
    || safety.originalModelOutputMutated !== false
    || safety.ledgerWritePerformed !== false) {
    return null;
  }
  return data as unknown as MlbEconomicAdapterResult;
}

export function formatMlbAmericanOdds(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value > 0 ? `+${Math.round(value)}` : `${Math.round(value)}`;
}

export function formatMlbPercent(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatMlbSigned(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;
}
