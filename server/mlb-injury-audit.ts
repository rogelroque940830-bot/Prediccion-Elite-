import { z } from "zod";

const optionalIso = z.string().datetime().optional();
const optionalNullableText = z.string().max(1000).nullable().optional();

const officialTransactionSchema = z.object({
  date: optionalNullableText,
  effectiveDate: optionalNullableText,
  typeCode: optionalNullableText,
  typeDesc: optionalNullableText,
  description: optionalNullableText,
}).strict().nullable().optional();

const shadowEvidenceSchema = z.object({
  decision: z.enum(["APPLY_CANDIDATE", "ALREADY_REFLECTED", "IGNORE", "CONFLICT", "PENDING"]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  impact: z.enum(["HIGH", "MEDIUM", "LOW", "NONE"]),
  reasonCode: z.string().trim().min(1).max(160),
  reason: z.string().trim().min(1).max(2000),
  daysSinceOfficialTransaction: z.number().int().min(0).max(5000).nullable().optional(),
}).strict();

const playerEvidenceSchema = z.object({
  playerId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(160),
  position: z.string().max(40).optional(),
  isPitcher: z.boolean(),
  detectorSource: z.string().max(120).optional(),
  reportedStatus: z.string().max(500).optional(),
  officialStatusCode: z.string().max(40).nullable().optional(),
  officialStatus: z.string().max(160).nullable().optional(),
  officialTransaction: officialTransactionSchema,
  shadow: shadowEvidenceSchema.optional(),
  disposition: z.enum([
    "AUTO_APPLIED",
    "BACKEND_ELIGIBLE",
    "WITHHELD_BULLPEN",
    "WITHHELD_POLICY",
    "WITHHELD_MANUAL_OVERRIDE",
    "MANUAL_SELECTED",
    "ALREADY_REFLECTED",
    "IGNORED",
    "CONFLICT",
    "PENDING",
    "DETECTED",
  ]),
}).strict();

const sourceEvidenceSchema = z.object({
  detector: z.string().trim().min(1).max(120),
  detectorStatus: z.string().trim().min(1).max(80),
  detectorFetchedAt: optionalIso,
  detectorStale: z.boolean(),
  validator: z.string().trim().min(1).max(120),
  validatorStatus: z.string().trim().min(1).max(80),
  validatorFetchedAt: optionalIso,
  rejectedCount: z.number().int().nonnegative().max(500),
  officialOnly: z.number().int().nonnegative().max(500),
}).strict();

const phaseBPlanSchema = z.object({
  enabled: z.boolean(),
  mode: z.literal("AUTO_CONSERVATIVE"),
  coverage: z.enum(["FULL", "PARTIAL", "BLOCKED"]),
  candidateCount: z.number().int().nonnegative().max(500),
  eligiblePlayerNames: z.array(z.string().trim().min(1).max(160)).max(100),
  withheldCandidateNames: z.array(z.string().trim().min(1).max(160)).max(100),
  scale: z.number().finite().min(0).max(1),
  maxAbsRuns: z.number().finite().min(0).max(10),
  autoApplyAllowed: z.boolean(),
  requiresBullpenReconciliation: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
}).strict();

const reconciliationSchema = z.object({
  bullpenStatusAvailable: z.boolean(),
  bullpenRunsAdjustment: z.number().finite().min(-10).max(10).optional(),
  blockedReason: z.string().max(160).nullable().optional(),
  closerAvailable: z.boolean().optional(),
  bullpenCompromised: z.boolean().optional(),
  statusText: z.string().max(1000).optional(),
}).strict();

const adjustmentSchema = z.object({
  rawAutomaticRuns: z.number().finite().min(-20).max(20),
  scaledAutomaticRuns: z.number().finite().min(-20).max(20),
  finalRuns: z.number().finite().min(-20).max(20),
  manualOverride: z.boolean(),
  factorType: z.string().max(120),
  offenseFactor: z.number().finite().min(-10).max(10),
  defenseFactor: z.number().finite().min(-10).max(10),
  selectedPlayerNames: z.array(z.string().trim().min(1).max(160)).max(100),
  autoAppliedPlayerNames: z.array(z.string().trim().min(1).max(160)).max(100),
}).strict();

const countsSchema = z.object({
  detected: z.number().int().nonnegative().max(500),
  candidates: z.number().int().nonnegative().max(500),
  backendEligible: z.number().int().nonnegative().max(500),
  autoApplied: z.number().int().nonnegative().max(500),
  selected: z.number().int().nonnegative().max(500),
  retained: z.number().int().nonnegative().max(500),
  rejected: z.number().int().nonnegative().max(500),
  officialOnly: z.number().int().nonnegative().max(500),
}).strict();

const teamAuditSchema = z.object({
  side: z.enum(["HOME", "AWAY"]),
  teamName: z.string().trim().min(1).max(160),
  teamId: z.number().int().positive().optional(),
  source: sourceEvidenceSchema,
  phaseB: phaseBPlanSchema,
  reconciliation: reconciliationSchema,
  adjustment: adjustmentSchema,
  counts: countsSchema,
  players: z.array(playerEvidenceSchema).max(100),
}).strict();

export const mlbInjuryAuditSchema = z.object({
  schemaVersion: z.literal("mlb-injury-audit.v1"),
  capturedAt: z.string().datetime(),
  mode: z.literal("PHASE_B_AUTO_CONSERVATIVE"),
  home: teamAuditSchema,
  away: teamAuditSchema,
}).strict();

export type MlbInjuryAudit = z.infer<typeof mlbInjuryAuditSchema>;
