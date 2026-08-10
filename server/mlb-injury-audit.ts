import { z } from "zod";

function trimmedText(max: number, min = 0) {
  let schema = z.string().trim();
  if (min > 0) schema = schema.min(min);
  return schema.transform((value) => value.slice(0, max));
}

const optionalIso = z.preprocess((raw) => {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}, z.string().datetime().optional());

const optionalNullableText = z.union([
  z.null(),
  z.string().transform((value) => value.slice(0, 1000)),
]).optional();

const officialTransactionSchema = z.object({
  date: optionalNullableText,
  effectiveDate: optionalNullableText,
  typeCode: optionalNullableText,
  typeDesc: optionalNullableText,
  description: optionalNullableText,
}).strip().nullable().optional();

const shadowEvidenceSchema = z.object({
  decision: z.enum(["APPLY_CANDIDATE", "ALREADY_REFLECTED", "IGNORE", "CONFLICT", "PENDING"]),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  impact: z.enum(["HIGH", "MEDIUM", "LOW", "NONE"]),
  reasonCode: trimmedText(160, 1),
  reason: trimmedText(2000, 1),
  daysSinceOfficialTransaction: z.number().int().min(0).max(5000).nullable().optional(),
  shadowOnly: z.literal(true).optional(),
}).strip();

const playerEvidenceSchema = z.object({
  playerId: z.number().int().positive().optional(),
  name: trimmedText(160, 1),
  position: z.string().transform((value) => value.slice(0, 40)).optional(),
  isPitcher: z.boolean(),
  detectorSource: z.string().transform((value) => value.slice(0, 120)).optional(),
  reportedStatus: z.string().transform((value) => value.slice(0, 500)).optional(),
  officialStatusCode: z.union([z.null(), z.string().transform((value) => value.slice(0, 40))]).optional(),
  officialStatus: z.union([z.null(), z.string().transform((value) => value.slice(0, 160))]).optional(),
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
}).strip();

const sourceEvidenceSchema = z.object({
  detector: trimmedText(120, 1),
  detectorStatus: trimmedText(80, 1),
  detectorFetchedAt: optionalIso,
  detectorStale: z.boolean(),
  validator: trimmedText(120, 1),
  validatorStatus: trimmedText(80, 1),
  validatorFetchedAt: optionalIso,
  rejectedCount: z.number().int().nonnegative().max(500),
  officialOnly: z.number().int().nonnegative().max(500),
}).strip();

const phaseBPlanSchema = z.object({
  enabled: z.boolean(),
  mode: z.literal("AUTO_CONSERVATIVE"),
  coverage: z.enum(["FULL", "PARTIAL", "BLOCKED"]),
  candidateCount: z.number().int().nonnegative().max(500),
  eligiblePlayerNames: z.array(trimmedText(160, 1)).max(100),
  withheldCandidateNames: z.array(trimmedText(160, 1)).max(100),
  scale: z.number().finite().min(0).max(1),
  maxAbsRuns: z.number().finite().min(0).max(10),
  autoApplyAllowed: z.boolean(),
  requiresBullpenReconciliation: z.boolean(),
  reason: trimmedText(2000, 1),
}).strip();

const reconciliationSchema = z.object({
  bullpenStatusAvailable: z.boolean(),
  bullpenRunsAdjustment: z.number().finite().min(-10).max(10).optional(),
  blockedReason: z.union([z.null(), z.string().transform((value) => value.slice(0, 160))]).optional(),
  closerAvailable: z.boolean().optional(),
  bullpenCompromised: z.boolean().optional(),
  statusText: z.string().transform((value) => value.slice(0, 1000)).optional(),
}).strip();

const adjustmentSchema = z.object({
  rawAutomaticRuns: z.number().finite().min(-20).max(20),
  scaledAutomaticRuns: z.number().finite().min(-20).max(20),
  finalRuns: z.number().finite().min(-20).max(20),
  manualOverride: z.boolean(),
  factorType: z.string().transform((value) => value.slice(0, 120)),
  offenseFactor: z.number().finite().min(-10).max(10),
  defenseFactor: z.number().finite().min(-10).max(10),
  selectedPlayerNames: z.array(trimmedText(160, 1)).max(100),
  autoAppliedPlayerNames: z.array(trimmedText(160, 1)).max(100),
}).strip();

const countsSchema = z.object({
  detected: z.number().int().nonnegative().max(500),
  candidates: z.number().int().nonnegative().max(500),
  backendEligible: z.number().int().nonnegative().max(500),
  autoApplied: z.number().int().nonnegative().max(500),
  selected: z.number().int().nonnegative().max(500),
  retained: z.number().int().nonnegative().max(500),
  rejected: z.number().int().nonnegative().max(500),
  officialOnly: z.number().int().nonnegative().max(500),
}).strip();

const teamAuditSchema = z.object({
  side: z.enum(["HOME", "AWAY"]),
  teamName: trimmedText(160, 1),
  teamId: z.number().int().positive().optional(),
  source: sourceEvidenceSchema,
  phaseB: phaseBPlanSchema,
  reconciliation: reconciliationSchema,
  adjustment: adjustmentSchema,
  counts: countsSchema,
  players: z.array(playerEvidenceSchema).max(100),
}).strip();

export const mlbInjuryAuditSchema = z.object({
  schemaVersion: z.literal("mlb-injury-audit.v1"),
  capturedAt: z.string().datetime(),
  mode: z.literal("PHASE_B_AUTO_CONSERVATIVE"),
  home: teamAuditSchema,
  away: teamAuditSchema,
}).strip();

export type MlbInjuryAudit = z.infer<typeof mlbInjuryAuditSchema>;
