import type { OperationalIncident } from "./operations-incident-center";

export const O3_CONFIRMATION_PHRASE = "REPROCESS_ONE_MLB_GAME" as const;

export type OperationalReprocessingPlanState = "READY" | "BLOCKED";
export type OperationalReprocessingExecutionState =
  | "COMPLETED"
  | "IDEMPOTENT_REPLAY"
  | "PARTIAL_FAILURE"
  | "BLOCKED";
export type OperationalReprocessingAuditType =
  | "PREVIEW_CREATED"
  | "PREVIEW_BLOCKED"
  | "EXECUTION_STARTED"
  | "SETTLEMENT_APPENDED"
  | "SETTLEMENT_IDEMPOTENT"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_BLOCKED"
  | "EXECUTION_FAILED";

export interface OperationalReprocessingSafety {
  mode: "SHADOW_CONTROLLED_REPROCESSING";
  shadowOnly: true;
  realFinancialExposure: 0;
  automaticExecution: false;
  requiresExplicitPreview: true;
  requiresPlanDigest: true;
  requiresAdminExecution: true;
  requiresConfirmationPhrase: true;
  singleGameOnly: true;
  appendOnlySettlementEvents: true;
  historicalLedgerMutation: false;
  automaticSettlementRetry: false;
  automaticBetPlacement: false;
  automaticModelChangesAllowed: false;
  automaticPromotionAllowed: false;
  supportedLeagues: ["MLB"];
}

export interface OperationalReprocessingStatus {
  schemaVersion: "courtedge-operational-reprocessing-status.v1";
  ownerUserId: number;
  plans: number;
  readyPlans: number;
  blockedPlans: number;
  executions: number;
  completedExecutions: number;
  partialFailures: number;
  latestPlanAt: string | null;
  latestExecutionAt: string | null;
  confirmationPhrase: typeof O3_CONFIRMATION_PHRASE;
  planTtlMs: number;
  maxTargetsPerPlan: number;
  supportedLeagues: ["MLB"];
  safety: OperationalReprocessingSafety;
}

export interface OperationalReprocessingTarget {
  predictionId: string;
  payloadSha256: string;
  analysisStage: string;
  marketType: string;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  currentSettlementEventId: string | null;
}

export interface OperationalReprocessingProposal {
  predictionId: string;
  result: "WIN" | "LOSS" | "PUSH" | "VOID";
  outcomeValue: number;
  finalScore: { home: number; away: number };
  notes: string;
  closingOddsAmerican: number | null;
  closingLine: number | null;
}

export interface OperationalReprocessingPlan {
  schemaVersion: "courtedge-operational-reprocessing-plan.v1";
  planId: string;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  state: OperationalReprocessingPlanState;
  incident: {
    id: string;
    league: "MLB" | "WNBA" | "NBA" | "NHL";
    gameId: string;
    gameDate: string | null;
    commenceTime: string | null;
    homeTeam: string;
    awayTeam: string;
    state: string;
    evidenceConfidence: string;
  };
  officialEvidence: {
    gamePk: number;
    gameDate: string;
    homeTeam: string;
    awayTeam: string;
    finalScore: { home: number; away: number };
    inningsDigest: string;
  } | null;
  targets: OperationalReprocessingTarget[];
  proposals: OperationalReprocessingProposal[];
  blockers: string[];
  warnings: string[];
  preconditionDigest: string;
  planDigest: string;
  confirmationPhrase: typeof O3_CONFIRMATION_PHRASE;
  safety: OperationalReprocessingSafety;
}

export interface OperationalReprocessingExecution {
  schemaVersion: "courtedge-operational-reprocessing-execution.v1";
  executionId: string;
  planId: string;
  planDigest: string;
  ownerUserId: number;
  idempotencyKey: string;
  requestDigest: string;
  startedAt: string;
  completedAt: string;
  state: OperationalReprocessingExecutionState;
  appended: number;
  idempotent: number;
  verified: number;
  failed: Array<{ predictionId: string; error: string }>;
  settlementEventIds: string[];
  safety: OperationalReprocessingSafety;
}

export interface OperationalReprocessingAuditEvent {
  schemaVersion: "courtedge-operational-reprocessing-audit.v1";
  eventId: string;
  ownerUserId: number;
  recordedAt: string;
  recordedAtMs: number;
  eventType: OperationalReprocessingAuditType;
  planId: string;
  executionId: string | null;
  incidentId: string;
  gameId: string;
  predictionId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  previousDigest: string | null;
  eventDigest: string;
}

export interface OperationalReprocessingStatusEnvelope {
  success: boolean;
  data: OperationalReprocessingStatus;
  ownerUserId: number;
}

export interface OperationalReprocessingAuditEnvelope {
  success: boolean;
  data: OperationalReprocessingAuditEvent[];
  ownerUserId: number;
}

export interface OperationalReprocessingPlanEnvelope {
  success: boolean;
  data: OperationalReprocessingPlan;
  ownerUserId: number;
}

export interface OperationalReprocessingExecutionEnvelope {
  success: boolean;
  data: OperationalReprocessingExecution;
  ownerUserId: number;
}

export function eligibleOperationalReprocessingIncidents(
  incidents: OperationalIncident[],
): OperationalIncident[] {
  return incidents.filter((incident) => (
    incident.league === "MLB"
    && incident.evidenceConfidence === "AUTHORITATIVE"
    && ["READY_FOR_SETTLEMENT", "SETTLEMENT_OVERDUE"].includes(incident.state)
  ));
}

export function operationalReprocessingSafetyValid(
  safety: OperationalReprocessingSafety | null | undefined,
): boolean {
  return Boolean(
    safety
    && safety.mode === "SHADOW_CONTROLLED_REPROCESSING"
    && safety.shadowOnly === true
    && safety.realFinancialExposure === 0
    && safety.automaticExecution === false
    && safety.requiresExplicitPreview === true
    && safety.requiresPlanDigest === true
    && safety.requiresAdminExecution === true
    && safety.requiresConfirmationPhrase === true
    && safety.singleGameOnly === true
    && safety.appendOnlySettlementEvents === true
    && safety.historicalLedgerMutation === false
    && safety.automaticSettlementRetry === false
    && safety.automaticBetPlacement === false
    && safety.automaticModelChangesAllowed === false
    && safety.automaticPromotionAllowed === false
    && safety.supportedLeagues.length === 1
    && safety.supportedLeagues[0] === "MLB"
  );
}

export function reprocessingPlanExpired(
  plan: OperationalReprocessingPlan | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!plan) return true;
  const expiresAt = Date.parse(plan.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs;
}

export function reprocessingExecutionReady(input: {
  plan: OperationalReprocessingPlan | null | undefined;
  confirmation: string;
  reason: string;
  idempotencyKey: string;
  nowMs?: number;
}): boolean {
  const { plan, confirmation, reason, idempotencyKey } = input;
  return Boolean(
    plan
    && plan.state === "READY"
    && plan.planDigest.length === 64
    && plan.confirmationPhrase === O3_CONFIRMATION_PHRASE
    && !reprocessingPlanExpired(plan, input.nowMs)
    && confirmation.trim() === O3_CONFIRMATION_PHRASE
    && reason.trim().length >= 10
    && reason.trim().length <= 500
    && /^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)
    && operationalReprocessingSafetyValid(plan.safety)
  );
}

export function buildOperationalReprocessingIdempotencyKey(
  planId: string,
  nonce: string,
): string {
  const cleanPlan = planId.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 100);
  const cleanNonce = nonce.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 40);
  return `o3-ui:${cleanPlan}:${cleanNonce}`.slice(0, 160);
}

export const O3_AUDIT_LABELS: Record<OperationalReprocessingAuditType, string> = {
  PREVIEW_CREATED: "Vista previa creada",
  PREVIEW_BLOCKED: "Vista previa bloqueada",
  EXECUTION_STARTED: "Ejecución iniciada",
  SETTLEMENT_APPENDED: "Settlement agregado",
  SETTLEMENT_IDEMPOTENT: "Settlement idempotente",
  EXECUTION_COMPLETED: "Ejecución completada",
  EXECUTION_BLOCKED: "Ejecución bloqueada",
  EXECUTION_FAILED: "Ejecución con fallo",
};

export function operationalReprocessingAuditLabel(
  eventType: OperationalReprocessingAuditType,
): string {
  return O3_AUDIT_LABELS[eventType] ?? eventType.replace(/_/g, " ");
}
