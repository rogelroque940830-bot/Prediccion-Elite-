export const MLB_P1_M5A_SCHEMA = "courtedge-p1-m5a-real-cohort-activation.v1" as const;
export const MLB_P1_M5A_RELEASE = "p1-m5a-real-cohort-activation-2026-08-06" as const;

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

export interface MlbP1M5aActivationRow {
  predictionId: string;
  lifecycleKey: string;
  recordedAt: string;
  gameDate: string;
  gamePk: number | null;
  homeTeam: string;
  awayTeam: string;
  market: string;
  selection: string;
  stage: string;
  effectiveDecision: string | null;
  actionability: string | null;
  economicLayerValid: boolean;
  economicLayerErrors: string[];
  result: string | null;
  settledAt: string | null;
  clvPp: number | null;
}

export interface MlbP1M5aActivationInput {
  generatedAt: string;
  rows: MlbP1M5aActivationRow[];
  ownerScoped: boolean;
  terminalSupersessionLeavesOnly: boolean;
  lifecycleChains: number;
  terminalLeaves: number;
  analyticalDuplicatesExcluded: number;
  lifecycleBranchesExcluded: number;
  malformedInteractiveRecordsExcluded: number;
}

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

function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validOfficialSettlement(row: MlbP1M5aActivationRow): boolean {
  return row.result != null
    && row.result.trim().length > 0
    && row.settledAt != null
    && validIso(row.settledAt);
}

function eligibleEndToEnd(row: MlbP1M5aActivationRow): boolean {
  return row.gamePk != null
    && Number.isInteger(row.gamePk)
    && row.gamePk > 0
    && row.lifecycleKey.trim().length > 0
    && row.predictionId.trim().length > 0
    && validIso(row.recordedAt)
    && row.economicLayerValid
    && validOfficialSettlement(row);
}

function earliestCertificate(rows: MlbP1M5aActivationRow[]): MlbP1M5aActivationRow | null {
  const eligible = rows.filter(eligibleEndToEnd);
  eligible.sort((left, right) => String(left.settledAt).localeCompare(String(right.settledAt))
    || left.recordedAt.localeCompare(right.recordedAt)
    || left.predictionId.localeCompare(right.predictionId));
  return eligible[0] ?? null;
}

function certificateFor(row: MlbP1M5aActivationRow | null): MlbP1M5aCertificateEvidence | null {
  if (!row || row.gamePk == null || row.settledAt == null || row.result == null) return null;
  return {
    predictionId: row.predictionId,
    lifecycleKey: row.lifecycleKey,
    recordedAt: row.recordedAt,
    settledAt: row.settledAt,
    gameDate: row.gameDate,
    gamePk: row.gamePk,
    matchup: `${row.awayTeam} vs ${row.homeTeam}`,
    market: row.market,
    selection: row.selection,
    stage: row.stage,
    effectiveDecision: row.effectiveDecision,
    actionability: row.actionability,
    result: row.result,
    clvObserved: row.clvPp != null,
  };
}

export function buildMlbP1M5aRealCohortActivation(
  input: MlbP1M5aActivationInput,
): MlbP1M5aActivation {
  const rows = input.rows;
  const validEconomic = rows.filter((row) => row.economicLayerValid);
  const settled = rows.filter(validOfficialSettlement);
  const eligible = rows.filter(eligibleEndToEnd);
  const finalRows = rows.filter((row) => row.stage === "FINAL");
  const clvRows = rows.filter((row) => row.clvPp != null);
  const lifecycleIntegrityHealthy = input.lifecycleBranchesExcluded === 0
    && input.malformedInteractiveRecordsExcluded === 0
    && input.terminalLeaves === input.lifecycleChains;
  const analyticalIdentityProtected = input.analyticalDuplicatesExcluded === 0;
  const ownerScopeHealthy = input.ownerScoped && input.terminalSupersessionLeavesOnly;
  const certifyingRow = earliestCertificate(rows);
  const certified = ownerScopeHealthy
    && lifecycleIntegrityHealthy
    && analyticalIdentityProtected
    && certifyingRow != null;

  const blockingReasons: string[] = [];
  if (!input.ownerScoped) blockingReasons.push("OWNER_SCOPE_NOT_PROVEN");
  if (!input.terminalSupersessionLeavesOnly) blockingReasons.push("TERMINAL_LEAF_POLICY_NOT_PROVEN");
  if (input.lifecycleBranchesExcluded > 0) blockingReasons.push("LIFECYCLE_BRANCH_CONFLICT");
  if (input.malformedInteractiveRecordsExcluded > 0) blockingReasons.push("MALFORMED_INTERACTIVE_CAPTURE");
  if (input.terminalLeaves !== input.lifecycleChains) blockingReasons.push("TERMINAL_LIFECYCLE_COVERAGE_INCOMPLETE");
  if (input.analyticalDuplicatesExcluded > 0) blockingReasons.push("ANALYTICAL_DUPLICATES_EXCLUDED");
  if (rows.length === 0) blockingReasons.push("REAL_INTERACTIVE_CAPTURE_REQUIRED");
  else if (validEconomic.length === 0) blockingReasons.push("VALID_P1_M4B_ECONOMIC_LAYER_REQUIRED");
  else if (eligible.length === 0) blockingReasons.push("OFFICIAL_SETTLEMENT_FOR_VALID_ECONOMIC_CAPTURE_REQUIRED");

  const integrityBlocked = !ownerScopeHealthy || !lifecycleIntegrityHealthy || !analyticalIdentityProtected;
  let state: MlbP1M5aActivationState;
  let nextAction: MlbP1M5aNextAction;
  if (integrityBlocked) {
    state = "BLOCKED_INTEGRITY";
    nextAction = "RESOLVE_COHORT_INTEGRITY";
  } else if (rows.length === 0) {
    state = "WAITING_FOR_REAL_CAPTURE";
    nextAction = "GENERATE_FIRST_REAL_PREDICTION";
  } else if (validEconomic.length === 0) {
    state = "CAPTURE_REGISTERED";
    nextAction = "GENERATE_VALID_ECONOMIC_CAPTURE";
  } else if (!certified) {
    state = "ECONOMIC_DECISION_REGISTERED";
    nextAction = "WAIT_FOR_OFFICIAL_SETTLEMENT";
  } else {
    state = "END_TO_END_CERTIFIED";
    nextAction = "REVIEW_CERTIFIED_COHORT";
  }

  return {
    schemaVersion: MLB_P1_M5A_SCHEMA,
    release: MLB_P1_M5A_RELEASE,
    generatedAt: input.generatedAt,
    state,
    certified,
    checklist: {
      authenticatedOwnerScope: ownerScopeHealthy,
      interactiveCaptureObserved: rows.length > 0,
      terminalDecisionObserved: input.terminalLeaves > 0,
      validEconomicLayerObserved: validEconomic.length > 0,
      officialSettlementObserved: settled.length > 0,
      sameDecisionEndToEndObserved: eligible.length > 0,
      lifecycleIntegrityHealthy,
      analyticalIdentityProtected,
      finalCaptureObserved: finalRows.length > 0,
      clvEvidenceObserved: clvRows.length > 0,
    },
    counts: {
      terminalInteractiveDecisions: rows.length,
      validEconomicDecisions: validEconomic.length,
      officiallySettledDecisions: settled.length,
      endToEndEligibleDecisions: eligible.length,
      finalInteractiveDecisions: finalRows.length,
      clvCoveredDecisions: clvRows.length,
    },
    certificate: certified ? certificateFor(certifyingRow) : null,
    blockingReasons,
    nextAction,
    interpretation: {
      activationOnly: true,
      profitabilityConclusionAllowed: false,
      modelChangeAllowed: false,
      automaticPromotionAllowed: false,
      clvRequiredForActivation: false,
    },
    safety: {
      mode: "SHADOW_REAL_COHORT_ACTIVATION",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      settlementWrites: false,
      historicalLedgerMutation: false,
      syntheticCaptureCreation: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
