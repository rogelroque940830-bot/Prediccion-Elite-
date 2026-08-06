export const MLB_P1_M5A_SCHEMA = "courtedge-p1-m5a-real-cohort-activation.v1" as const;
export const MLB_P1_M5A_RELEASE = "p1-m5a-real-cohort-activation-2026-08-06" as const;
export const MLB_P1_M5A_FRONTEND_RELEASE = "p1-m5a-real-cohort-activation-ui-2026-08-06" as const;

export type MlbP1M5aActivationState =
  | "WAITING_FOR_REAL_CAPTURE"
  | "CAPTURE_REGISTERED"
  | "ECONOMIC_DECISION_REGISTERED"
  | "END_TO_END_CERTIFIED"
  | "BLOCKED_INTEGRITY";

export type MlbP1M5aNextAction =
  | "GENERATE_FIRST_REAL_PREDICTION"
  | "GENERATE_VALID_ECONOMIC_CAPTURE"
  | "WAIT_FOR_OFFICIAL_SETTLEMENT"
  | "REVIEW_CERTIFIED_COHORT"
  | "RESOLVE_COHORT_INTEGRITY";

export interface MlbP1M5aCertificateEvidence {
  predictionId: string;
  lifecycleKey: string;
  recordedAt: string;
  settledAt: string;
  gameDate: string;
  gamePk: number;
  matchup: string;
  market: string;
  selection: string;
  stage: string;
  effectiveDecision: string | null;
  actionability: string | null;
  result: string;
  clvObserved: boolean;
}

export interface MlbP1M5aActivation {
  schemaVersion: typeof MLB_P1_M5A_SCHEMA;
  release: typeof MLB_P1_M5A_RELEASE;
  generatedAt: string;
  state: MlbP1M5aActivationState;
  certified: boolean;
  checklist: {
    authenticatedOwnerScope: boolean;
    interactiveCaptureObserved: boolean;
    terminalDecisionObserved: boolean;
    validEconomicLayerObserved: boolean;
    officialSettlementObserved: boolean;
    sameDecisionEndToEndObserved: boolean;
    lifecycleIntegrityHealthy: boolean;
    analyticalIdentityProtected: boolean;
    finalCaptureObserved: boolean;
    clvEvidenceObserved: boolean;
  };
  counts: {
    terminalInteractiveDecisions: number;
    validEconomicDecisions: number;
    officiallySettledDecisions: number;
    endToEndEligibleDecisions: number;
    finalInteractiveDecisions: number;
    clvCoveredDecisions: number;
  };
  certificate: MlbP1M5aCertificateEvidence | null;
  blockingReasons: string[];
  nextAction: MlbP1M5aNextAction;
  interpretation: {
    activationOnly: true;
    profitabilityConclusionAllowed: false;
    modelChangeAllowed: false;
    automaticPromotionAllowed: false;
    clvRequiredForActivation: false;
  };
  safety: {
    mode: "SHADOW_REAL_COHORT_ACTIVATION";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    settlementWrites: false;
    historicalLedgerMutation: false;
    syntheticCaptureCreation: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const STATES: MlbP1M5aActivationState[] = [
  "WAITING_FOR_REAL_CAPTURE",
  "CAPTURE_REGISTERED",
  "ECONOMIC_DECISION_REGISTERED",
  "END_TO_END_CERTIFIED",
  "BLOCKED_INTEGRITY",
];

const NEXT_ACTIONS: MlbP1M5aNextAction[] = [
  "GENERATE_FIRST_REAL_PREDICTION",
  "GENERATE_VALID_ECONOMIC_CAPTURE",
  "WAIT_FOR_OFFICIAL_SETTLEMENT",
  "REVIEW_CERTIFIED_COHORT",
  "RESOLVE_COHORT_INTEGRITY",
];

const CHECKLIST_KEYS = [
  "authenticatedOwnerScope",
  "interactiveCaptureObserved",
  "terminalDecisionObserved",
  "validEconomicLayerObserved",
  "officialSettlementObserved",
  "sameDecisionEndToEndObserved",
  "lifecycleIntegrityHealthy",
  "analyticalIdentityProtected",
  "finalCaptureObserved",
  "clvEvidenceObserved",
] as const;

const COUNT_KEYS = [
  "terminalInteractiveDecisions",
  "validEconomicDecisions",
  "officiallySettledDecisions",
  "endToEndEligibleDecisions",
  "finalInteractiveDecisions",
  "clvCoveredDecisions",
] as const;

function validCertificate(value: unknown): value is MlbP1M5aCertificateEvidence {
  const certificate = record(value);
  return Boolean(certificate)
    && nonEmptyText(certificate?.predictionId)
    && nonEmptyText(certificate?.lifecycleKey)
    && validIso(certificate?.recordedAt)
    && validIso(certificate?.settledAt)
    && nonEmptyText(certificate?.gameDate)
    && Number.isInteger(certificate?.gamePk)
    && Number(certificate?.gamePk) > 0
    && nonEmptyText(certificate?.matchup)
    && nonEmptyText(certificate?.market)
    && nonEmptyText(certificate?.selection)
    && nonEmptyText(certificate?.stage)
    && (certificate?.effectiveDecision == null || nonEmptyText(certificate.effectiveDecision))
    && (certificate?.actionability == null || nonEmptyText(certificate.actionability))
    && nonEmptyText(certificate?.result)
    && typeof certificate?.clvObserved === "boolean";
}

export function parseMlbP1M5aActivation(value: unknown): MlbP1M5aActivation {
  const activation = record(value);
  const checklist = record(activation?.checklist);
  const counts = record(activation?.counts);
  const interpretation = record(activation?.interpretation);
  const safety = record(activation?.safety);

  const fail = (message: string): never => {
    throw new Error(`P1_M5A_INVALID_ACTIVATION:${message}`);
  };

  if (!activation) throw new Error("P1_M5A_INVALID_ACTIVATION:object");
  if (activation.schemaVersion !== MLB_P1_M5A_SCHEMA) fail("schema");
  if (activation.release !== MLB_P1_M5A_RELEASE) fail("release");
  if (!validIso(activation.generatedAt)) fail("generated_at");
  if (!STATES.includes(String(activation.state) as MlbP1M5aActivationState)) fail("state");
  if (typeof activation.certified !== "boolean") fail("certified");
  if (!NEXT_ACTIONS.includes(String(activation.nextAction) as MlbP1M5aNextAction)) fail("next_action");

  for (const key of CHECKLIST_KEYS) {
    if (typeof checklist?.[key] !== "boolean") fail(`checklist_${key}`);
  }
  for (const key of COUNT_KEYS) {
    if (!nonNegativeInteger(counts?.[key])) fail(`counts_${key}`);
  }

  if (!Array.isArray(activation.blockingReasons)
    || !activation.blockingReasons.every(nonEmptyText)) fail("blocking_reasons");

  if (interpretation?.activationOnly !== true) fail("activation_only");
  if (interpretation?.profitabilityConclusionAllowed !== false) fail("profitability_conclusion");
  if (interpretation?.modelChangeAllowed !== false) fail("model_change");
  if (interpretation?.automaticPromotionAllowed !== false) fail("promotion");
  if (interpretation?.clvRequiredForActivation !== false) fail("clv_requirement");

  if (safety?.mode !== "SHADOW_REAL_COHORT_ACTIVATION") fail("safety_mode");
  if (safety?.realFinancialExposure !== 0) fail("real_exposure");
  if (safety?.sportsbookIntegration !== false) fail("sportsbook");
  if (safety?.automaticBetPlacement !== false) fail("automatic_bet");
  if (safety?.productionWrites !== false || safety?.settlementWrites !== false) fail("writes");
  if (safety?.historicalLedgerMutation !== false) fail("historical_mutation");
  if (safety?.syntheticCaptureCreation !== false) fail("synthetic_capture");
  if (safety?.automaticModelChangesAllowed !== false) fail("automatic_model_change");
  if (safety?.automaticPromotionAllowed !== false) fail("automatic_promotion");

  const state = activation.state as MlbP1M5aActivationState;
  const certified = activation.certified;
  const certificate = activation.certificate;
  const nextAction = activation.nextAction as MlbP1M5aNextAction;

  if (certified !== (state === "END_TO_END_CERTIFIED")) fail("state_certified_mismatch");
  if (certified && !validCertificate(certificate)) fail("certificate_required");
  if (!certified && certificate != null) fail("certificate_for_uncertified_state");
  if (certified && nextAction !== "REVIEW_CERTIFIED_COHORT") fail("certified_next_action");
  if (state === "WAITING_FOR_REAL_CAPTURE" && nextAction !== "GENERATE_FIRST_REAL_PREDICTION") fail("waiting_next_action");
  if (state === "CAPTURE_REGISTERED" && nextAction !== "GENERATE_VALID_ECONOMIC_CAPTURE") fail("capture_next_action");
  if (state === "ECONOMIC_DECISION_REGISTERED" && nextAction !== "WAIT_FOR_OFFICIAL_SETTLEMENT") fail("economic_next_action");
  if (state === "BLOCKED_INTEGRITY" && nextAction !== "RESOLVE_COHORT_INTEGRITY") fail("blocked_next_action");

  if (certified) {
    if (checklist?.authenticatedOwnerScope !== true
      || checklist?.interactiveCaptureObserved !== true
      || checklist?.terminalDecisionObserved !== true
      || checklist?.validEconomicLayerObserved !== true
      || checklist?.officialSettlementObserved !== true
      || checklist?.sameDecisionEndToEndObserved !== true
      || checklist?.lifecycleIntegrityHealthy !== true
      || checklist?.analyticalIdentityProtected !== true) {
      fail("certified_checklist");
    }
    if (Number(counts?.endToEndEligibleDecisions) < 1) fail("certified_count");
  }

  return value as MlbP1M5aActivation;
}
