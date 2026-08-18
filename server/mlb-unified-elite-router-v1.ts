export const MLB_UNIFIED_ELITE_ROUTER_VERSION = "mlb-unified-elite-router-v1" as const;
export const MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE = "2026-08-19" as const;

export const PP_TECHNICAL_UNAVAILABLE_REASONS = [
  "PP_SNAPSHOT_INTEGRITY_FAILED",
  "PP_REQUIRED_FEATURE_MISSING",
  "PP_PREGAME_SOURCE_UNAVAILABLE",
  "PP_SOURCE_PARITY_FAILED",
  "PP_RUNTIME_INTEGRITY_FAILED",
] as const;

export type PpTechnicalUnavailableReason =
  (typeof PP_TECHNICAL_UNAVAILABLE_REASONS)[number];

export type EliteTier = "A_PLUS" | "PREMIUM" | "PP_HORIZON" | "FULL_MODULAR";
export type EliteArm = "CONTROL" | "CHALLENGER";

export interface EliteSelectionInput {
  officialDate: string;
  gamePk: number;
  market: string;
  horizon: string;
  side: string;
  selectedLine?: number | null;
}

export interface CanonicalEliteSelection {
  officialDate: string;
  gamePk: number;
  market: string;
  horizon: string;
  side: string;
  selectedLine: number | null;
}

export type StandardTierDecision =
  | { status: "SELECTION"; selection: EliteSelectionInput }
  | { status: "NO_PLAY"; reason?: string };

export type PpHorizonDecision =
  | { status: "SELECTION"; selection: EliteSelectionInput }
  | { status: "NO_PLAY"; reason?: string }
  | { status: "TECHNICAL_UNAVAILABLE"; reason: PpTechnicalUnavailableReason };

export interface UnifiedEliteRouterInput {
  officialDate: string;
  aPlus: StandardTierDecision;
  premium: StandardTierDecision;
  ppHorizon: PpHorizonDecision;
  fullModular: StandardTierDecision;
}

export interface UnifiedEliteSelectionResult {
  status: "SELECTION";
  arm: EliteArm;
  routerVersion: typeof MLB_UNIFIED_ELITE_ROUTER_VERSION;
  selectedTier: EliteTier;
  selection: CanonicalEliteSelection;
  selectionCount: 1;
  trace: readonly string[];
}

export interface UnifiedEliteNoPlayResult {
  status: "NO_PLAY";
  arm: EliteArm;
  routerVersion: typeof MLB_UNIFIED_ELITE_ROUTER_VERSION;
  selectedTier: null;
  selectionCount: 0;
  reason: string;
  trace: readonly string[];
}

export type UnifiedEliteArmResult = UnifiedEliteSelectionResult | UnifiedEliteNoPlayResult;

export interface UnifiedEliteRouterResult {
  routerVersion: typeof MLB_UNIFIED_ELITE_ROUTER_VERSION;
  officialDate: string;
  control: UnifiedEliteArmResult;
  challenger: UnifiedEliteArmResult;
  maximumSelectionsPerArm: 1;
  mixedAcrossTiers: false;
  outcomeInputsUsed: false;
}

function validOfficialDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function validNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalSelection(
  selection: EliteSelectionInput,
  officialDate: string,
): CanonicalEliteSelection | null {
  if (!selection || typeof selection !== "object") return null;
  if (selection.officialDate !== officialDate) return null;
  if (!Number.isInteger(selection.gamePk) || selection.gamePk <= 0) return null;
  if (!validNonEmpty(selection.market) || !validNonEmpty(selection.horizon) || !validNonEmpty(selection.side)) return null;
  if (selection.selectedLine !== undefined && selection.selectedLine !== null && !Number.isFinite(selection.selectedLine)) return null;
  return Object.freeze({
    officialDate: selection.officialDate,
    gamePk: selection.gamePk,
    market: selection.market.trim(),
    horizon: selection.horizon.trim(),
    side: selection.side.trim(),
    selectedLine: selection.selectedLine ?? null,
  });
}

function standardDecisionIntegrity(
  decision: StandardTierDecision,
  officialDate: string,
  label: string,
): string | null {
  if (!decision || typeof decision !== "object") return `INVALID_${label}_DECISION`;
  if (decision.status === "NO_PLAY") return null;
  if (decision.status !== "SELECTION") return `INVALID_${label}_STATUS`;
  return canonicalSelection(decision.selection, officialDate) ? null : `INVALID_${label}_SELECTION`;
}

function ppDecisionIntegrity(
  decision: PpHorizonDecision,
  officialDate: string,
): string | null {
  if (!decision || typeof decision !== "object") return "INVALID_PP_HORIZON_DECISION";
  if (decision.status === "NO_PLAY") return null;
  if (decision.status === "SELECTION") {
    return canonicalSelection(decision.selection, officialDate) ? null : "INVALID_PP_HORIZON_SELECTION";
  }
  if (decision.status === "TECHNICAL_UNAVAILABLE") {
    return PP_TECHNICAL_UNAVAILABLE_REASONS.includes(
      decision.reason as PpTechnicalUnavailableReason,
    ) ? null : "INVALID_PP_TECHNICAL_UNAVAILABLE_REASON";
  }
  return "INVALID_PP_HORIZON_STATUS";
}

function selectionResult(
  arm: EliteArm,
  tier: EliteTier,
  selection: CanonicalEliteSelection,
  trace: string[],
): UnifiedEliteSelectionResult {
  return Object.freeze({
    status: "SELECTION",
    arm,
    routerVersion: MLB_UNIFIED_ELITE_ROUTER_VERSION,
    selectedTier: tier,
    selection,
    selectionCount: 1,
    trace: Object.freeze([...trace]),
  });
}

function noPlayResult(
  arm: EliteArm,
  reason: string,
  trace: string[],
): UnifiedEliteNoPlayResult {
  return Object.freeze({
    status: "NO_PLAY",
    arm,
    routerVersion: MLB_UNIFIED_ELITE_ROUTER_VERSION,
    selectedTier: null,
    selectionCount: 0,
    reason,
    trace: Object.freeze([...trace]),
  });
}

function globalIntegrityFailure(input: UnifiedEliteRouterInput): string | null {
  if (!input || typeof input !== "object") return "INVALID_ROUTER_INPUT";
  if (!validOfficialDate(input.officialDate)) return "INVALID_ROUTER_OFFICIAL_DATE";
  if (input.officialDate < MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE) {
    return "BEFORE_FROZEN_PROSPECTIVE_BOUNDARY";
  }
  return standardDecisionIntegrity(input.aPlus, input.officialDate, "A_PLUS") ??
    standardDecisionIntegrity(input.premium, input.officialDate, "PREMIUM") ??
    ppDecisionIntegrity(input.ppHorizon, input.officialDate) ??
    standardDecisionIntegrity(input.fullModular, input.officialDate, "FULL_MODULAR");
}

function canonicalFromStandard(
  decision: StandardTierDecision,
  officialDate: string,
): CanonicalEliteSelection | null {
  return decision.status === "SELECTION"
    ? canonicalSelection(decision.selection, officialDate)
    : null;
}

function routeControlValidated(input: UnifiedEliteRouterInput): UnifiedEliteArmResult {
  const trace: string[] = [];
  const aPlus = canonicalFromStandard(input.aPlus, input.officialDate);
  if (aPlus) {
    trace.push("A_PLUS:SELECTION");
    return selectionResult("CONTROL", "A_PLUS", aPlus, trace);
  }
  trace.push("A_PLUS:NO_PLAY");

  const premium = canonicalFromStandard(input.premium, input.officialDate);
  if (premium) {
    trace.push("PREMIUM:SELECTION");
    return selectionResult("CONTROL", "PREMIUM", premium, trace);
  }
  trace.push("PREMIUM:NO_PLAY");

  const fullModular = canonicalFromStandard(input.fullModular, input.officialDate);
  if (fullModular) {
    trace.push("FULL_MODULAR:SELECTION");
    return selectionResult("CONTROL", "FULL_MODULAR", fullModular, trace);
  }
  trace.push("FULL_MODULAR:NO_PLAY");
  return noPlayResult("CONTROL", "NO_VALID_CONTROL_SELECTION", trace);
}

function routeChallengerValidated(input: UnifiedEliteRouterInput): UnifiedEliteArmResult {
  const trace: string[] = [];
  const aPlus = canonicalFromStandard(input.aPlus, input.officialDate);
  if (aPlus) {
    trace.push("A_PLUS:SELECTION");
    return selectionResult("CHALLENGER", "A_PLUS", aPlus, trace);
  }
  trace.push("A_PLUS:NO_PLAY");

  const premium = canonicalFromStandard(input.premium, input.officialDate);
  if (premium) {
    trace.push("PREMIUM:SELECTION");
    return selectionResult("CHALLENGER", "PREMIUM", premium, trace);
  }
  trace.push("PREMIUM:NO_PLAY");

  if (input.ppHorizon.status === "SELECTION") {
    const pp = canonicalSelection(input.ppHorizon.selection, input.officialDate) as CanonicalEliteSelection;
    trace.push("PP_HORIZON:SELECTION");
    return selectionResult("CHALLENGER", "PP_HORIZON", pp, trace);
  }

  if (input.ppHorizon.status === "NO_PLAY") {
    trace.push("PP_HORIZON:NO_PLAY");
    trace.push("FULL_MODULAR:FALLBACK_FORBIDDEN");
    return noPlayResult("CHALLENGER", "PP_HORIZON_NO_PLAY", trace);
  }

  trace.push(`PP_HORIZON:TECHNICAL_UNAVAILABLE:${input.ppHorizon.reason}`);
  const fullModular = canonicalFromStandard(input.fullModular, input.officialDate);
  if (fullModular) {
    trace.push("FULL_MODULAR:TECHNICAL_FALLBACK_SELECTION");
    return selectionResult("CHALLENGER", "FULL_MODULAR", fullModular, trace);
  }
  trace.push("FULL_MODULAR:TECHNICAL_FALLBACK_NO_PLAY");
  return noPlayResult("CHALLENGER", "NO_VALID_TECHNICAL_FALLBACK_SELECTION", trace);
}

export function routeUnifiedEliteBoth(input: UnifiedEliteRouterInput): UnifiedEliteRouterResult {
  const integrity = globalIntegrityFailure(input);
  if (integrity) {
    const trace = [`INTEGRITY_FAIL:${integrity}`];
    return Object.freeze({
      routerVersion: MLB_UNIFIED_ELITE_ROUTER_VERSION,
      officialDate: validOfficialDate(input?.officialDate) ? input.officialDate : "INVALID",
      control: noPlayResult("CONTROL", integrity, trace),
      challenger: noPlayResult("CHALLENGER", integrity, trace),
      maximumSelectionsPerArm: 1,
      mixedAcrossTiers: false,
      outcomeInputsUsed: false,
    });
  }

  return Object.freeze({
    routerVersion: MLB_UNIFIED_ELITE_ROUTER_VERSION,
    officialDate: input.officialDate,
    control: routeControlValidated(input),
    challenger: routeChallengerValidated(input),
    maximumSelectionsPerArm: 1,
    mixedAcrossTiers: false,
    outcomeInputsUsed: false,
  });
}

export function routeUnifiedEliteControl(input: UnifiedEliteRouterInput): UnifiedEliteArmResult {
  return routeUnifiedEliteBoth(input).control;
}

export function routeUnifiedEliteChallenger(input: UnifiedEliteRouterInput): UnifiedEliteArmResult {
  return routeUnifiedEliteBoth(input).challenger;
}
