import type { OperationalIncident } from "./operations-incident-center";

export const O31_CONFIRMATION_PHRASE = "APPEND_SUPERSEDING_MLB_EVIDENCE" as const;

export type O31RepairMode =
  | "AUTO_FROM_OFFICIAL"
  | "MANUAL_EVIDENCE_REQUIRED"
  | "NOT_REPAIRABLE_HERE";

export type O31RepairField =
  | "gamePk"
  | "gameDate"
  | "homeTeam"
  | "awayTeam"
  | "marketType"
  | "selection"
  | "oddsAmerican";

export interface O31Safety {
  mode: "SHADOW_EVIDENCE_REPAIR";
  shadowOnly: true;
  realFinancialExposure: 0;
  automaticRepair: false;
  requiresExplicitInspection: true;
  requiresSealedPlan: true;
  requiresAdminExecution: true;
  requiresConfirmationPhrase: true;
  singleGameOnly: true;
  appendOnlySupersedingPredictions: true;
  historicalLedgerMutation: false;
  settlementExecution: false;
  automaticBetPlacement: false;
  automaticModelChangesAllowed: false;
  automaticPromotionAllowed: false;
  supportedLeagues: ["MLB"];
}

export interface O31Status {
  schemaVersion: "courtedge-o31-evidence-repair-status.v1";
  ownerUserId: number;
  inspections: number;
  plans: number;
  readyPlans: number;
  blockedPlans: number;
  executions: number;
  completedExecutions: number;
  latestInspectionAt: string | null;
  latestExecutionAt: string | null;
  confirmationPhrase: typeof O31_CONFIRMATION_PHRASE;
  ttlMs: number;
  maxTargets: number;
  safety: O31Safety;
}

export interface O31OfficialEvidence {
  gamePk: number;
  gameDate: string;
  commenceTime: string | null;
  homeTeam: string;
  awayTeam: string;
  final: boolean;
  detailedState: string;
  finalScore: { home: number; away: number } | null;
  inningsDigest: string | null;
  fetchedAt: string;
  source: "MLB_STATS_API";
}

export interface O31Issue {
  predictionId: string;
  code: string;
  field: O31RepairField | "analysisStage" | "supersession";
  severity: "BLOCKING";
  currentValue: unknown;
  officialValue: unknown;
  repairMode: O31RepairMode;
  message: string;
}

export interface O31RecordSnapshot {
  predictionId: string;
  payloadSha256: string;
  supersedesId: string | null;
  analysisStage: string;
  game: {
    gamePk: number | null;
    gameDate: string;
    commenceTime: string | null;
    homeTeam: string;
    awayTeam: string;
  };
  market: {
    type: string;
    selection: string;
    line: number | null;
    oddsAmerican: number;
    book: string | null;
  };
  issues: O31Issue[];
}

export interface O31Inspection {
  schemaVersion: "courtedge-o31-evidence-inspection.v1";
  inspectionId: string;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  incident: {
    id: string;
    league: string;
    gameId: string;
    gameDate: string | null;
    commenceTime: string | null;
    homeTeam: string;
    awayTeam: string;
    state: string;
    evidenceConfidence: string;
  };
  officialEvidence: O31OfficialEvidence | null;
  records: O31RecordSnapshot[];
  blockers: string[];
  warnings: string[];
  inspectionDigest: string;
  safety: O31Safety;
}

export interface O31ManualPatch {
  predictionId: string;
  marketType?: string;
  selection?: string;
  oddsAmerican?: number;
  gamePk?: number;
  gameDate?: string;
  homeTeam?: string;
  awayTeam?: string;
}

export interface O31RepairSource {
  sourceName: string;
  evidenceReference: string;
  capturedAt: string;
  note: string;
}

export interface O31PlanTarget {
  predictionId: string;
  originalPayloadSha256: string;
  proposedInput: Record<string, unknown>;
  proposedPayloadSha256: string;
  repairedFields: O31RepairField[];
}

export interface O31Plan {
  schemaVersion: "courtedge-o31-evidence-repair-plan.v1";
  planId: string;
  inspectionId: string;
  inspectionDigest: string;
  ownerUserId: number;
  createdAt: string;
  expiresAt: string;
  state: "READY" | "BLOCKED";
  incidentId: string;
  gameId: string;
  officialEvidence: O31OfficialEvidence | null;
  repairSource: O31RepairSource;
  targets: O31PlanTarget[];
  blockers: string[];
  warnings: string[];
  preconditionDigest: string;
  planDigest: string;
  confirmationPhrase: typeof O31_CONFIRMATION_PHRASE;
  safety: O31Safety;
}

export interface O31Execution {
  schemaVersion: "courtedge-o31-evidence-repair-execution.v1";
  executionId: string;
  planId: string;
  planDigest: string;
  ownerUserId: number;
  idempotencyKey: string;
  requestDigest: string;
  startedAt: string;
  completedAt: string;
  state: "COMPLETED" | "IDEMPOTENT_REPLAY" | "PARTIAL_FAILURE" | "BLOCKED";
  appended: number;
  idempotent: number;
  verified: number;
  supersedingPredictionIds: string[];
  failed: Array<{ predictionId: string; error: string }>;
  safety: O31Safety;
}

export interface O31AuditEvent {
  schemaVersion: "courtedge-o31-evidence-repair-audit.v1";
  eventId: string;
  ownerUserId: number;
  recordedAt: string;
  recordedAtMs: number;
  eventType: string;
  inspectionId: string | null;
  planId: string | null;
  executionId: string | null;
  incidentId: string;
  predictionId: string | null;
  message: string;
  metadata: Record<string, unknown>;
  previousDigest: string | null;
  eventDigest: string;
}

export interface O31StatusEnvelope { success: boolean; data: O31Status; ownerUserId: number; }
export interface O31InspectionEnvelope { success: boolean; data: O31Inspection; ownerUserId: number; }
export interface O31PlanEnvelope { success: boolean; data: O31Plan; ownerUserId: number; }
export interface O31ExecutionEnvelope { success: boolean; data: O31Execution; ownerUserId: number; }
export interface O31AuditEnvelope { success: boolean; data: O31AuditEvent[]; ownerUserId: number; }

export function eligibleO31Incidents(incidents: OperationalIncident[]): OperationalIncident[] {
  return incidents.filter((incident) => (
    incident.league === "MLB"
    && incident.state === "DATA_QUALITY_REVIEW"
    && incident.evidenceConfidence === "AUTHORITATIVE"
  ));
}

export function o31SafetyValid(safety: O31Safety | null | undefined): boolean {
  return Boolean(
    safety
    && safety.mode === "SHADOW_EVIDENCE_REPAIR"
    && safety.shadowOnly === true
    && safety.realFinancialExposure === 0
    && safety.automaticRepair === false
    && safety.requiresExplicitInspection === true
    && safety.requiresSealedPlan === true
    && safety.requiresAdminExecution === true
    && safety.requiresConfirmationPhrase === true
    && safety.singleGameOnly === true
    && safety.appendOnlySupersedingPredictions === true
    && safety.historicalLedgerMutation === false
    && safety.settlementExecution === false
    && safety.automaticBetPlacement === false
    && safety.automaticModelChangesAllowed === false
    && safety.automaticPromotionAllowed === false
    && safety.supportedLeagues.length === 1
    && safety.supportedLeagues[0] === "MLB"
  );
}

export function o31Expired(value: { expiresAt: string } | null | undefined, nowMs = Date.now()): boolean {
  if (!value) return true;
  const parsed = Date.parse(value.expiresAt);
  return !Number.isFinite(parsed) || parsed <= nowMs;
}

export function o31ManualFields(inspection: O31Inspection | null | undefined): Array<{
  predictionId: string;
  field: O31RepairField;
}> {
  if (!inspection) return [];
  const unique = new Map<string, { predictionId: string; field: O31RepairField }>();
  for (const record of inspection.records) {
    for (const issue of record.issues) {
      if (issue.repairMode !== "MANUAL_EVIDENCE_REQUIRED") continue;
      if (!["gamePk", "gameDate", "homeTeam", "awayTeam", "marketType", "selection", "oddsAmerican"].includes(issue.field)) continue;
      const field = issue.field as O31RepairField;
      unique.set(`${record.predictionId}:${field}`, { predictionId: record.predictionId, field });
    }
  }
  return Array.from(unique.values());
}

export function o31SourceValid(source: O31RepairSource): boolean {
  return source.sourceName.trim().length >= 2
    && source.sourceName.trim().length <= 120
    && source.evidenceReference.trim().length >= 3
    && source.evidenceReference.trim().length <= 500
    && Number.isFinite(Date.parse(source.capturedAt))
    && source.note.trim().length >= 10
    && source.note.trim().length <= 1000;
}

export function o31PlanRequestReady(input: {
  inspection: O31Inspection | null | undefined;
  patches: O31ManualPatch[];
  source: O31RepairSource;
  nowMs?: number;
}): boolean {
  const { inspection, patches, source } = input;
  if (!inspection || inspection.blockers.length > 0 || o31Expired(inspection, input.nowMs) || !o31SafetyValid(inspection.safety)) return false;
  if (!o31SourceValid(source)) return false;
  const patchMap = new Map(patches.map((patch) => [patch.predictionId, patch]));
  return o31ManualFields(inspection).every(({ predictionId, field }) => {
    const patch = patchMap.get(predictionId);
    if (!patch) return false;
    const value = patch[field];
    if (field === "oddsAmerican") {
      return typeof value === "number" && Number.isInteger(value) && value !== 0 && Math.abs(value) >= 100;
    }
    if (field === "gamePk") return typeof value === "number" && Number.isInteger(value) && value > 0;
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function o31ExecutionReady(input: {
  plan: O31Plan | null | undefined;
  confirmation: string;
  reason: string;
  idempotencyKey: string;
  acknowledged: boolean;
  nowMs?: number;
}): boolean {
  const { plan, confirmation, reason, idempotencyKey, acknowledged } = input;
  return Boolean(
    plan
    && plan.state === "READY"
    && plan.planDigest.length === 64
    && plan.confirmationPhrase === O31_CONFIRMATION_PHRASE
    && !o31Expired(plan, input.nowMs)
    && confirmation.trim() === O31_CONFIRMATION_PHRASE
    && reason.trim().length >= 10
    && reason.trim().length <= 500
    && /^[A-Za-z0-9._:-]{1,160}$/.test(idempotencyKey)
    && acknowledged
    && o31SafetyValid(plan.safety)
  );
}

export function buildO31IdempotencyKey(planId: string, nonce: string): string {
  const cleanPlan = planId.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 100);
  const cleanNonce = nonce.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 40);
  return `o31-ui:${cleanPlan}:${cleanNonce}`.slice(0, 160);
}

export function o31AuditLabel(eventType: string): string {
  const labels: Record<string, string> = {
    INSPECTION_CREATED: "Inspección creada",
    INSPECTION_BLOCKED: "Inspección bloqueada",
    PLAN_CREATED: "Plan creado",
    PLAN_BLOCKED: "Plan bloqueado",
    EXECUTION_STARTED: "Ejecución iniciada",
    SUPERSEDING_PREDICTION_APPENDED: "Versión superseding agregada",
    SUPERSEDING_PREDICTION_IDEMPOTENT: "Versión superseding idempotente",
    EXECUTION_COMPLETED: "Reparación completada",
    EXECUTION_FAILED: "Reparación con fallo",
    EXECUTION_BLOCKED: "Ejecución bloqueada",
  };
  return labels[eventType] ?? eventType.replace(/_/g, " ");
}
