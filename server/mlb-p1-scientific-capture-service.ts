import { z } from "zod";
import type { MlbLedgerStore } from "./mlb-ledger-store";
import {
  appendOwnedPrediction,
  getOwnedRecord,
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
  type OwnedLedgerRecord,
} from "./mlb-ledger-ownership-store";
import {
  MLB_P1_M3A_READINESS_CONTRACT_SCHEMA,
  MLB_P1_M3A_READINESS_RUNTIME_SCHEMA,
  MLB_P1_M3A_SCHEMA,
  MLB_P1_M3A_SNAPSHOT_SCHEMA,
  buildMlbP1M3aCaptureIdentity,
  decideMlbP1M3aRevision,
  toMlbP1M3aLedgerCompatibleInput,
  validateMlbP1M3aCapture,
  type MlbP1M3aCaptureCandidate,
  type MlbP1M3aCaptureIdentity,
  type MlbP1M3aCaptureDecision,
  type MlbP1M3aExistingCaptureRef,
  type MlbP1M3aRevisionDecision,
  type MlbP1M3aRevisionResult,
} from "./mlb-p1-scientific-capture-contract";

export const MLB_P1_M3B_SCHEMA = "courtedge-p1-m3b-scientific-capture-service.v1" as const;
export const MLB_P1_M3B_ENDPOINT = "/api/mlb/p1/v1/scientific-captures" as const;

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const isoText = z.string().datetime();
const nullableText = z.string().nullable();

const quoteSchema = z.object({
  market: z.enum(["ML", "F5_ML", "RUN_LINE", "TOTAL", "F5_TOTAL"]),
  side: z.enum(["HOME", "AWAY", "OVER", "UNDER"]),
  selection: z.string().min(1).max(200),
  line: z.number().finite().nullable(),
  oddsAmerican: z.number().int(),
  oppositeOddsAmerican: z.number().int().nullable(),
  book: z.string().min(1).max(80),
  sourceMode: z.enum(["AUTOMATIC", "CONSENSUS", "MANUAL"]),
  capturedAt: isoText,
  providerLastUpdate: isoText.nullable(),
  consensusMethod: nullableText,
  provenanceDigest: hex64,
}).strict();

const readinessSchema = z.object({
  runtimeSchemaVersion: z.literal(MLB_P1_M3A_READINESS_RUNTIME_SCHEMA),
  contractSchemaVersion: z.literal(MLB_P1_M3A_READINESS_CONTRACT_SCHEMA),
  generatedAt: isoText,
  market: z.enum(["ML", "F5_ML", "RUN_LINE", "TOTAL", "F5_TOTAL"]),
  gateStatus: z.enum(["READY_PROVISIONAL", "READY_FINAL"]),
  analysisStage: z.enum(["PROVISIONAL", "FINAL"]),
  blockers: z.array(z.string().max(300)).max(100),
  warnings: z.array(z.string().max(500)).max(100),
  evidenceSummary: z.object({
    fresh: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    degraded: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    conflict: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    requiredFields: z.array(z.string().min(1).max(80)).max(64),
  }).strict(),
  evidenceDigest: hex64,
  certifiedQuote: quoteSchema,
}).strict();

export const mlbP1M3bCaptureCandidateSchema = z.object({
  schemaVersion: z.literal(MLB_P1_M3A_SCHEMA),
  capturedAt: isoText,
  origin: z.object({
    channel: z.literal("INTERACTIVE_MLB_PREDICTOR"),
    userAction: z.literal("GENERATE_PREDICTION"),
    clientEvaluationId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
    frontendRelease: nullableText,
  }).strict(),
  game: z.object({
    gamePk: z.number().int().positive(),
    gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    commenceTime: isoText,
    homeTeam: z.string().min(1).max(120),
    awayTeam: z.string().min(1).max(120),
    venue: z.string().max(160).nullable(),
  }).strict(),
  readiness: readinessSchema,
  quote: quoteSchema,
  model: z.object({
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(120),
    gitCommit: z.string().max(80).nullable(),
    environment: z.string().max(80).nullable(),
  }).strict(),
  probabilities: z.object({
    model: z.number().finite(),
    marketImplied: z.number().finite(),
    noVig: z.number().finite().nullable(),
    edgePp: z.number().finite(),
  }).strict(),
  decision: z.object({
    signal: z.enum(["BET_FUERTE", "BET", "LEAN", "PASS", "INFO"]),
    category: z.enum(["ELITE", "PREMIUM", "LEAN", "PASS", "INFO"]),
    confidenceLabel: z.string().max(40).nullable(),
    confidencePct: z.number().finite().nullable(),
    recommendedStakeUnits: z.number().finite(),
    rationale: z.string().max(4000).nullable(),
    filterReasons: z.array(z.string().max(500)).max(100),
  }).strict(),
  scientificSnapshot: z.object({
    schemaVersion: z.literal(MLB_P1_M3A_SNAPSHOT_SCHEMA),
    payload: z.record(z.unknown()),
    payloadDigest: hex64,
  }).strict(),
  safety: z.object({
    mode: z.literal("SHADOW_DECISION_SUPPORT"),
    realFinancialExposure: z.literal(0),
    automaticBetPlacement: z.literal(false),
    automaticModelChangesAllowed: z.literal(false),
    automaticPromotionAllowed: z.literal(false),
  }).strict(),
}).strict();

export type MlbP1M3bCaptureOutcome = "APPENDED" | "IDEMPOTENT";

export interface MlbP1M3bCaptureResult {
  schemaVersion: typeof MLB_P1_M3B_SCHEMA;
  endpoint: typeof MLB_P1_M3B_ENDPOINT;
  outcome: MlbP1M3bCaptureOutcome;
  predictionId: string;
  recordedAt: string;
  idempotent: boolean;
  identity: MlbP1M3aCaptureIdentity;
  validation: MlbP1M3aCaptureDecision;
  revision: MlbP1M3aRevisionResult;
  ownership: {
    userId: number;
    source: "AUTHENTICATED_SESSION";
  };
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export class MlbP1M3bCaptureError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = "MlbP1M3bCaptureError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type CaptureRecordRef = {
  record: OwnedLedgerRecord;
  ref: MlbP1M3aExistingCaptureRef;
};

type ServiceOptions = {
  now?: () => Date;
};

function positiveUserId(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MlbP1M3bCaptureError(400, "INVALID_AUTHENTICATED_USER", "Authenticated user id is invalid.");
  }
  return parsed;
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function parseCandidate(raw: unknown): MlbP1M3aCaptureCandidate {
  const parsed = mlbP1M3bCaptureCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new MlbP1M3bCaptureError(
      400,
      "MALFORMED_CAPTURE_CANDIDATE",
      "The scientific capture candidate does not match the P1-M3B request schema.",
      parsed.error.flatten(),
    );
  }
  return parsed.data as MlbP1M3aCaptureCandidate;
}

function captureRef(record: OwnedLedgerRecord): CaptureRecordRef | null {
  const payload = asObject(record.prediction.payload);
  const analysis = asObject(payload?.analysis);
  const layers = asObject(analysis?.layers);
  const p1M3a = asObject(layers?.p1M3aCapture);
  const identity = asObject(p1M3a?.identity);
  if (p1M3a?.schemaVersion !== MLB_P1_M3A_SCHEMA) return null;
  if (typeof identity?.lifecycleKey !== "string" || !/^[a-f0-9]{64}$/.test(identity.lifecycleKey)) return null;
  if (typeof identity?.semanticFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(identity.semanticFingerprint)) return null;
  if (record.prediction.analysisStage !== "PROVISIONAL" && record.prediction.analysisStage !== "FINAL") return null;

  const p1M3b = asObject(layers?.p1M3bCapture);
  const candidateCapturedAt = typeof p1M3b?.candidateCapturedAt === "string"
    && Number.isFinite(Date.parse(p1M3b.candidateCapturedAt))
    ? p1M3b.candidateCapturedAt
    : record.prediction.recordedAt;

  return {
    record,
    ref: {
      predictionId: record.prediction.id,
      lifecycleKey: identity.lifecycleKey,
      semanticFingerprint: identity.semanticFingerprint,
      analysisStage: record.prediction.analysisStage,
      capturedAt: candidateCapturedAt,
    },
  };
}

function latestCaptureForLifecycle(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  userId: number,
  lifecycleKey: string,
): CaptureRecordRef | null {
  return ownedRecordsForUser(store, ownershipStore, userId, { limit: 10_000 })
    .map(captureRef)
    .filter((entry): entry is CaptureRecordRef => Boolean(entry))
    .filter((entry) => entry.ref.lifecycleKey === lifecycleKey)
    .sort((left, right) =>
      right.record.prediction.recordedAtMs - left.record.prediction.recordedAtMs
      || right.record.prediction.id.localeCompare(left.record.prediction.id),
    )[0] ?? null;
}

function responseFor(input: {
  outcome: MlbP1M3bCaptureOutcome;
  record: OwnedLedgerRecord;
  identity: MlbP1M3aCaptureIdentity;
  validation: MlbP1M3aCaptureDecision;
  revision: MlbP1M3aRevisionResult;
  userId: number;
}): MlbP1M3bCaptureResult {
  return {
    schemaVersion: MLB_P1_M3B_SCHEMA,
    endpoint: MLB_P1_M3B_ENDPOINT,
    outcome: input.outcome,
    predictionId: input.record.prediction.id,
    recordedAt: input.record.prediction.recordedAt,
    idempotent: input.outcome === "IDEMPOTENT",
    identity: input.identity,
    validation: input.validation,
    revision: input.revision,
    ownership: {
      userId: input.userId,
      source: "AUTHENTICATED_SESSION",
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

function rejectedRevision(revision: MlbP1M3aRevisionResult): never {
  const status = revision.decision === "REJECT_STAGE_REGRESSION" || revision.decision === "REJECT_STALE_REVISION"
    ? 409
    : 400;
  throw new MlbP1M3bCaptureError(status, revision.decision, revision.reason, revision);
}

export class MlbP1ScientificCaptureService {
  private readonly now: () => Date;
  private readonly lifecycleLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async withLifecycleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const currentGate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => currentGate);
    this.lifecycleLocks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleLocks.get(key) === current) this.lifecycleLocks.delete(key);
    }
  }

  async capture(raw: unknown, authenticatedUserId: number): Promise<MlbP1M3bCaptureResult> {
    const userId = positiveUserId(authenticatedUserId);
    const candidate = parseCandidate(raw);
    const serverNow = this.now();
    const validation = validateMlbP1M3aCapture(candidate, serverNow);
    if (!validation.captureAllowed || !validation.identity) {
      throw new MlbP1M3bCaptureError(
        422,
        "P1_M3A_CAPTURE_REJECTED",
        "The scientific capture failed the P1-M3A economic-integrity contract.",
        { errors: validation.errors, warnings: validation.warnings },
      );
    }

    const identity = validation.identity;
    return this.withLifecycleLock(`${userId}:${identity.lifecycleKey}`, async () => {
      const previous = latestCaptureForLifecycle(
        this.store,
        this.ownershipStore,
        userId,
        identity.lifecycleKey,
      );
      const revision = decideMlbP1M3aRevision(previous?.ref ?? null, candidate);

      if (revision.decision === "IDEMPOTENT_RETRY" && previous) {
        return responseFor({
          outcome: "IDEMPOTENT",
          record: previous.record,
          identity,
          validation,
          revision,
          userId,
        });
      }
      if (
        revision.decision === "REJECT_CHAIN_MISMATCH"
        || revision.decision === "REJECT_STAGE_REGRESSION"
        || revision.decision === "REJECT_STALE_REVISION"
      ) {
        return rejectedRevision(revision);
      }

      const ledgerInput = toMlbP1M3aLedgerCompatibleInput(
        candidate,
        identity,
        revision.supersedesId ?? undefined,
      ) as Record<string, any>;
      const analysis = asObject(ledgerInput.analysis) ?? {};
      const layers = asObject(analysis.layers) ?? {};
      const warnings = Array.isArray(analysis.warnings)
        ? [...new Set(analysis.warnings.map((value: unknown) => String(value)).filter(Boolean))].slice(0, 100)
        : [];
      ledgerInput.analysis = {
        ...analysis,
        warnings,
        layers: {
          ...layers,
          p1M3bCapture: {
            schemaVersion: MLB_P1_M3B_SCHEMA,
            endpoint: MLB_P1_M3B_ENDPOINT,
            candidateCapturedAt: candidate.capturedAt,
            serverReceivedAt: serverNow.toISOString(),
            ownerAuthority: "AUTHENTICATED_SESSION",
            lifecycleSerializedInProcess: true,
            revisionDecision: revision.decision,
            supersedesId: revision.supersedesId,
          },
        },
      };

      const appended = appendOwnedPrediction(
        this.store,
        this.ownershipStore,
        ledgerInput,
        userId,
        "session",
      );
      const owned = getOwnedRecord(this.store, this.ownershipStore, userId, appended.data.id);
      if (!owned) {
        throw new MlbP1M3bCaptureError(
          500,
          "OWNERSHIP_BINDING_FAILED",
          "The capture was appended but its authenticated ownership could not be verified.",
        );
      }

      const effectiveRevision: MlbP1M3aRevisionResult = appended.idempotent
        ? {
            decision: "IDEMPOTENT_RETRY",
            supersedesId: owned.prediction.id,
            reason: "SQLite clientRequestId idempotency returned the existing semantic capture.",
          }
        : revision;
      return responseFor({
        outcome: appended.idempotent ? "IDEMPOTENT" : "APPENDED",
        record: owned,
        identity,
        validation,
        revision: effectiveRevision,
        userId,
      });
    });
  }
}

export function isMlbP1M3bCaptureError(error: unknown): error is MlbP1M3bCaptureError {
  return error instanceof MlbP1M3bCaptureError;
}

export function isRejectedRevisionDecision(decision: MlbP1M3aRevisionDecision): boolean {
  return decision.startsWith("REJECT_");
}

export function recomputeMlbP1M3bIdentity(raw: unknown): MlbP1M3aCaptureIdentity {
  return buildMlbP1M3aCaptureIdentity(parseCandidate(raw));
}
