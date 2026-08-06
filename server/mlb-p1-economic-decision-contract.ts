export const MLB_P1_M4A_SCHEMA = "courtedge-p1-m4a-economic-decision-contract.v1" as const;
export const MLB_P1_M4A_POLICY_VERSION = "mlb-economic-policy-v1-existing-signal-parity" as const;

export const MLB_P1_M4A_LEAN_EDGE_FLOOR_PP = 3;
export const MLB_P1_M4A_BET_EDGE_FLOOR_PP = 8;
export const MLB_P1_M4A_BET_CONFIDENCE_FLOOR = 0.70;
export const MLB_P1_M4A_KELLY_FRACTION = 0.25;
export const MLB_P1_M4A_MAX_SHADOW_STAKE_UNITS = 1;

export type MlbP1M4aMarket = "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL";
export type MlbP1M4aStage = "PROVISIONAL" | "FINAL";
export type MlbP1M4aGateStatus = "READY_PROVISIONAL" | "READY_FINAL";
export type MlbP1M4aSignal = "BET" | "LEAN" | "PASS";
export type MlbP1M4aActionability =
  | "ACTIONABLE_FINAL"
  | "WAIT_FOR_FINAL"
  | "OBSERVE_ONLY"
  | "BLOCKED";

export type MlbP1M4aReasonCode =
  | "GATE_STATUS_STAGE_MISMATCH"
  | "READINESS_HAS_BLOCKERS"
  | "CERTIFIED_QUOTE_MISMATCH"
  | "CERTIFIED_LINE_MISMATCH"
  | "MARKET_QUOTE_STALE"
  | "BILATERAL_PRICE_REQUIRED"
  | "MODEL_PROBABILITY_INVALID"
  | "CURRENT_ODDS_INVALID"
  | "NO_POSITIVE_EXPECTED_VALUE"
  | "EDGE_BELOW_LEAN_FLOOR"
  | "BET_CONFIDENCE_BELOW_FLOOR"
  | "PRICE_WORSE_THAN_MINIMUM"
  | "PROVISIONAL_REQUIRES_FINAL_CONFIRMATION";

export interface MlbP1M4aQuoteIntegrity {
  certifiedQuoteMatch: boolean;
  certifiedLineMatch: boolean;
  fresh: boolean;
  bilateral: boolean;
}

export interface MlbP1M4aDecisionInput {
  market: MlbP1M4aMarket;
  stage: MlbP1M4aStage;
  gateStatus: MlbP1M4aGateStatus;
  blockers: string[];
  warnings: string[];
  modelProbability: number;
  currentOddsAmerican: number;
  noVigProbability: number | null;
  quoteIntegrity: MlbP1M4aQuoteIntegrity;
}

export interface MlbP1M4aPricePoint {
  probability: number;
  decimal: number;
  american: number;
}

export interface MlbP1M4aMinimumPrice {
  requiredEdgePp: number;
  oddsAmerican: number | null;
  oddsDecimal: number | null;
  maximumImpliedProbability: number | null;
}

export interface MlbP1M4aDecisionResult {
  schemaVersion: typeof MLB_P1_M4A_SCHEMA;
  policyVersion: typeof MLB_P1_M4A_POLICY_VERSION;
  market: MlbP1M4aMarket;
  stage: MlbP1M4aStage;
  modelSignal: MlbP1M4aSignal;
  decision: MlbP1M4aSignal;
  actionability: MlbP1M4aActionability;
  fairPrice: MlbP1M4aPricePoint | null;
  minimumPrices: {
    lean: MlbP1M4aMinimumPrice;
    bet: MlbP1M4aMinimumPrice;
    active: MlbP1M4aMinimumPrice | null;
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
    maximumUnits: typeof MLB_P1_M4A_MAX_SHADOW_STAKE_UNITS;
    realFinancialExposure: 0;
  };
  reasons: MlbP1M4aReasonCode[];
  warnings: string[];
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    automaticBetPlacement: false;
    sportsbookIntegration: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export const MLB_P1_M4A_AUDIT_FINDINGS = [
  {
    code: "SIGNAL_HAS_NO_VERSIONED_PRICE_FLOOR",
    finding: "The existing model classifies BET, LEAN and PASS, but does not expose the worst acceptable price that preserves the signal edge floor.",
  },
  {
    code: "AMERICAN_ODDS_ORDER_IS_ECONOMICALLY_AMBIGUOUS",
    finding: "Comparing American odds numerically is unsafe across negative and positive prices; payout quality must be compared in decimal-odds space.",
  },
  {
    code: "EXPECTED_VALUE_NOT_FIRST_CLASS",
    finding: "The current predictor stores edge but does not expose expected profit per one simulated unit as a versioned decision field.",
  },
  {
    code: "PROVISIONAL_ACTIONABILITY_NOT_CONTRACTED",
    finding: "A provisional model signal must be retained for measurement while remaining non-actionable with zero stake until FINAL confirmation.",
  },
  {
    code: "KELLY_CAP_NOT_VERSIONED_AS_POLICY",
    finding: "The existing quarter-Kelly fallback and one-unit cap need an explicit SHADOW-only contract before a recommendation card can rely on them.",
  },
] as const;

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function pushUnique<T>(target: T[], value: T): void {
  if (!target.includes(value)) target.push(value);
}

export function isMlbP1M4aStandardAmericanOdds(value: number): boolean {
  return Number.isInteger(value) && (value <= -100 || value >= 100);
}

export function mlbP1M4aAmericanToDecimal(oddsAmerican: number): number | null {
  if (!isMlbP1M4aStandardAmericanOdds(oddsAmerican)) return null;
  return oddsAmerican > 0
    ? 1 + oddsAmerican / 100
    : 1 + 100 / Math.abs(oddsAmerican);
}

export function mlbP1M4aAmericanToImpliedProbability(oddsAmerican: number): number | null {
  const decimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  return decimal == null ? null : 1 / decimal;
}

function probabilityToExactAmerican(probability: number): number | null {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) return null;
  return probability > 0.5
    ? -(probability / (1 - probability)) * 100
    : ((1 - probability) / probability) * 100;
}

export function mlbP1M4aFairPrice(modelProbability: number): MlbP1M4aPricePoint | null {
  if (!Number.isFinite(modelProbability) || modelProbability <= 0 || modelProbability >= 1) return null;
  const decimal = 1 / modelProbability;
  const exactAmerican = probabilityToExactAmerican(modelProbability);
  if (exactAmerican == null) return null;
  return {
    probability: round(modelProbability, 12),
    decimal: round(decimal, 6),
    american: Math.round(exactAmerican),
  };
}

/**
 * Returns the first standard integer American price whose implied probability
 * is strictly below modelProbability - requiredEdgePp.
 *
 * The strict inequality preserves existing mlbGetSignal semantics:
 * BET uses edge > 8pp and LEAN uses edge > 3pp, not >=.
 */
export function mlbP1M4aMinimumAcceptablePrice(
  modelProbability: number,
  requiredEdgePp: number,
): MlbP1M4aMinimumPrice {
  const maximumImpliedProbability = modelProbability - requiredEdgePp / 100;
  if (
    !Number.isFinite(modelProbability)
    || modelProbability <= 0
    || modelProbability >= 1
    || !Number.isFinite(requiredEdgePp)
    || requiredEdgePp < 0
    || maximumImpliedProbability <= 0
    || maximumImpliedProbability >= 1
  ) {
    return {
      requiredEdgePp,
      oddsAmerican: null,
      oddsDecimal: null,
      maximumImpliedProbability: null,
    };
  }

  const equalityAmerican = probabilityToExactAmerican(maximumImpliedProbability);
  if (equalityAmerican == null) {
    return {
      requiredEdgePp,
      oddsAmerican: null,
      oddsDecimal: null,
      maximumImpliedProbability: null,
    };
  }

  let oddsAmerican: number;
  if (equalityAmerican < -100) {
    oddsAmerican = Math.ceil(equalityAmerican);
    if (Math.abs(oddsAmerican - equalityAmerican) <= 1e-10) oddsAmerican += 1;
    if (oddsAmerican > -100) oddsAmerican = 100;
  } else {
    oddsAmerican = Math.floor(Math.max(100, equalityAmerican)) + 1;
  }

  const oddsDecimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  return {
    requiredEdgePp,
    oddsAmerican,
    oddsDecimal: oddsDecimal == null ? null : round(oddsDecimal, 6),
    maximumImpliedProbability: round(maximumImpliedProbability, 12),
  };
}

export function mlbP1M4aPriceMeetsMinimum(
  currentOddsAmerican: number,
  minimumOddsAmerican: number | null,
): boolean {
  if (minimumOddsAmerican == null) return false;
  const currentDecimal = mlbP1M4aAmericanToDecimal(currentOddsAmerican);
  const minimumDecimal = mlbP1M4aAmericanToDecimal(minimumOddsAmerican);
  if (currentDecimal == null || minimumDecimal == null) return false;
  return currentDecimal + 1e-12 >= minimumDecimal;
}

export function mlbP1M4aExpectedValuePerUnit(
  modelProbability: number,
  oddsAmerican: number,
): number | null {
  const decimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  if (decimal == null || !Number.isFinite(modelProbability) || modelProbability <= 0 || modelProbability >= 1) {
    return null;
  }
  return round(modelProbability * decimal - 1, 8);
}

export function mlbP1M4aKellyFractions(
  modelProbability: number,
  oddsAmerican: number,
): { full: number; quarter: number } {
  const decimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  if (decimal == null || !Number.isFinite(modelProbability) || modelProbability <= 0 || modelProbability >= 1) {
    return { full: 0, quarter: 0 };
  }
  const b = decimal - 1;
  const q = 1 - modelProbability;
  const full = Math.max(0, (b * modelProbability - q) / b);
  return {
    full: round(full, 8),
    quarter: round(full * MLB_P1_M4A_KELLY_FRACTION, 8),
  };
}

export function mlbP1M4aModelSignal(modelProbability: number, edgePp: number): MlbP1M4aSignal {
  if (edgePp > MLB_P1_M4A_BET_EDGE_FLOOR_PP && modelProbability >= MLB_P1_M4A_BET_CONFIDENCE_FLOOR) {
    return "BET";
  }
  if (edgePp > MLB_P1_M4A_LEAN_EDGE_FLOOR_PP) return "LEAN";
  return "PASS";
}

function gateMatchesStage(stage: MlbP1M4aStage, gateStatus: MlbP1M4aGateStatus): boolean {
  return (stage === "FINAL" && gateStatus === "READY_FINAL")
    || (stage === "PROVISIONAL" && gateStatus === "READY_PROVISIONAL");
}

export function evaluateMlbP1M4aEconomicDecision(
  input: MlbP1M4aDecisionInput,
): MlbP1M4aDecisionResult {
  const reasons: MlbP1M4aReasonCode[] = [];
  const warnings = Array.from(new Set(input.warnings.map((value) => String(value)).filter(Boolean)));
  const validProbability = Number.isFinite(input.modelProbability)
    && input.modelProbability > 0
    && input.modelProbability < 1;
  const currentDecimal = mlbP1M4aAmericanToDecimal(input.currentOddsAmerican);
  const implied = mlbP1M4aAmericanToImpliedProbability(input.currentOddsAmerican);
  const edgePp = validProbability && implied != null
    ? round((input.modelProbability - implied) * 100, 8)
    : null;
  const noVigEdgePp = validProbability && input.noVigProbability != null
    && Number.isFinite(input.noVigProbability)
    && input.noVigProbability > 0
    && input.noVigProbability < 1
    ? round((input.modelProbability - input.noVigProbability) * 100, 8)
    : null;
  const expectedValuePerUnit = validProbability
    ? mlbP1M4aExpectedValuePerUnit(input.modelProbability, input.currentOddsAmerican)
    : null;
  const kelly = validProbability
    ? mlbP1M4aKellyFractions(input.modelProbability, input.currentOddsAmerican)
    : { full: 0, quarter: 0 };

  const leanMinimum = mlbP1M4aMinimumAcceptablePrice(
    input.modelProbability,
    MLB_P1_M4A_LEAN_EDGE_FLOOR_PP,
  );
  const betMinimum = mlbP1M4aMinimumAcceptablePrice(
    input.modelProbability,
    MLB_P1_M4A_BET_EDGE_FLOOR_PP,
  );
  const meetsLeanMinimum = mlbP1M4aPriceMeetsMinimum(
    input.currentOddsAmerican,
    leanMinimum.oddsAmerican,
  );
  const meetsBetMinimum = mlbP1M4aPriceMeetsMinimum(
    input.currentOddsAmerican,
    betMinimum.oddsAmerican,
  );

  if (!gateMatchesStage(input.stage, input.gateStatus)) pushUnique(reasons, "GATE_STATUS_STAGE_MISMATCH");
  if (input.blockers.length > 0) pushUnique(reasons, "READINESS_HAS_BLOCKERS");
  if (!input.quoteIntegrity.certifiedQuoteMatch) pushUnique(reasons, "CERTIFIED_QUOTE_MISMATCH");
  if (!input.quoteIntegrity.certifiedLineMatch) pushUnique(reasons, "CERTIFIED_LINE_MISMATCH");
  if (!input.quoteIntegrity.fresh) pushUnique(reasons, "MARKET_QUOTE_STALE");
  if (!input.quoteIntegrity.bilateral) pushUnique(reasons, "BILATERAL_PRICE_REQUIRED");
  if (!validProbability) pushUnique(reasons, "MODEL_PROBABILITY_INVALID");
  if (currentDecimal == null || implied == null) pushUnique(reasons, "CURRENT_ODDS_INVALID");

  const hardBlocked = reasons.length > 0;
  const modelSignal = !hardBlocked && edgePp != null
    ? mlbP1M4aModelSignal(input.modelProbability, edgePp)
    : "PASS";

  if (!hardBlocked && expectedValuePerUnit != null && expectedValuePerUnit <= 0) {
    pushUnique(reasons, "NO_POSITIVE_EXPECTED_VALUE");
  }
  if (!hardBlocked && modelSignal === "PASS") pushUnique(reasons, "EDGE_BELOW_LEAN_FLOOR");
  if (
    !hardBlocked
    && edgePp != null
    && edgePp > MLB_P1_M4A_BET_EDGE_FLOOR_PP
    && input.modelProbability < MLB_P1_M4A_BET_CONFIDENCE_FLOOR
  ) {
    pushUnique(reasons, "BET_CONFIDENCE_BELOW_FLOOR");
  }
  if (!hardBlocked && modelSignal === "BET" && !meetsBetMinimum) pushUnique(reasons, "PRICE_WORSE_THAN_MINIMUM");
  if (!hardBlocked && modelSignal === "LEAN" && !meetsLeanMinimum) pushUnique(reasons, "PRICE_WORSE_THAN_MINIMUM");

  let decision: MlbP1M4aSignal = modelSignal;
  let actionability: MlbP1M4aActionability = "OBSERVE_ONLY";
  if (hardBlocked) {
    decision = "PASS";
    actionability = "BLOCKED";
  } else if (modelSignal === "PASS" || expectedValuePerUnit == null || expectedValuePerUnit <= 0) {
    decision = "PASS";
    actionability = "OBSERVE_ONLY";
  } else if (input.stage === "PROVISIONAL") {
    decision = "LEAN";
    actionability = "WAIT_FOR_FINAL";
    pushUnique(reasons, "PROVISIONAL_REQUIRES_FINAL_CONFIRMATION");
  } else if (
    (modelSignal === "BET" && meetsBetMinimum)
    || (modelSignal === "LEAN" && meetsLeanMinimum)
  ) {
    decision = modelSignal;
    actionability = modelSignal === "BET" ? "ACTIONABLE_FINAL" : "OBSERVE_ONLY";
  } else {
    decision = "PASS";
    actionability = "OBSERVE_ONLY";
  }

  const analyticalUnits = decision === "BET" && actionability === "ACTIONABLE_FINAL"
    ? round(Math.min(
        MLB_P1_M4A_MAX_SHADOW_STAKE_UNITS,
        Math.max(0, kelly.quarter * 100),
      ), 2)
    : 0;
  const activeMinimum = modelSignal === "BET"
    ? betMinimum
    : modelSignal === "LEAN"
      ? leanMinimum
      : null;

  return {
    schemaVersion: MLB_P1_M4A_SCHEMA,
    policyVersion: MLB_P1_M4A_POLICY_VERSION,
    market: input.market,
    stage: input.stage,
    modelSignal,
    decision,
    actionability,
    fairPrice: mlbP1M4aFairPrice(input.modelProbability),
    minimumPrices: {
      lean: leanMinimum,
      bet: betMinimum,
      active: activeMinimum,
    },
    currentPrice: {
      oddsAmerican: input.currentOddsAmerican,
      oddsDecimal: currentDecimal == null ? null : round(currentDecimal, 6),
      impliedProbability: implied == null ? null : round(implied, 12),
      meetsLeanMinimum,
      meetsBetMinimum,
    },
    economics: {
      edgePp,
      noVigEdgePp,
      expectedValuePerUnit,
      fullKellyFraction: kelly.full,
      quarterKellyFraction: kelly.quarter,
    },
    stake: {
      analyticalUnits,
      maximumUnits: MLB_P1_M4A_MAX_SHADOW_STAKE_UNITS,
      realFinancialExposure: 0,
    },
    reasons,
    warnings,
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      automaticBetPlacement: false,
      sportsbookIntegration: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
