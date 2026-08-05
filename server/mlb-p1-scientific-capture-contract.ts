import { createHash } from "node:crypto";

export const MLB_P1_M3A_SCHEMA = "courtedge-p1-m3a-scientific-capture-contract.v1" as const;
export const MLB_P1_M3A_TARGET_LEDGER_SCHEMA = "mlb-ledger.v1" as const;
export const MLB_P1_M3A_READINESS_RUNTIME_SCHEMA = "courtedge-p1-m2b-pregame-readiness.v1" as const;
export const MLB_P1_M3A_READINESS_CONTRACT_SCHEMA = "courtedge-p1-m2a-pregame-readiness-contract.v1" as const;
export const MLB_P1_M3A_SNAPSHOT_SCHEMA = "mlb-scientific-snapshot.v1" as const;
export const MLB_P1_M3A_MAX_QUOTE_AGE_SECONDS = 300;
export const MLB_P1_M3A_MAX_READINESS_AGE_SECONDS = 300;
export const MLB_P1_M3A_MAX_SNAPSHOT_BYTES = 280_000;

export type MlbP1M3aMarket = "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL";
export type MlbP1M3aSide = "HOME" | "AWAY" | "OVER" | "UNDER";
export type MlbP1M3aStage = "PROVISIONAL" | "FINAL";
export type MlbP1M3aGateStatus = "READY_PROVISIONAL" | "READY_FINAL";
export type MlbP1M3aSignal = "BET_FUERTE" | "BET" | "LEAN" | "PASS" | "INFO";
export type MlbP1M3aCategory = "ELITE" | "PREMIUM" | "LEAN" | "PASS" | "INFO";
export type MlbP1M3aDisposition = "ACCEPTED" | "BLOCKED" | "OBSERVED";
export type MlbP1M3aCaptureStatus = "READY_TO_APPEND" | "REJECTED";
export type MlbP1M3aRevisionDecision =
  | "NEW_CHAIN"
  | "IDEMPOTENT_RETRY"
  | "APPEND_SUPERSEDING_REVISION"
  | "REJECT_CHAIN_MISMATCH"
  | "REJECT_STAGE_REGRESSION"
  | "REJECT_STALE_REVISION";

export interface MlbP1M3aQuote {
  market: MlbP1M3aMarket;
  side: MlbP1M3aSide;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  oppositeOddsAmerican: number | null;
  book: string;
  sourceMode: "AUTOMATIC" | "CONSENSUS" | "MANUAL";
  capturedAt: string;
  providerLastUpdate: string | null;
  consensusMethod: string | null;
  provenanceDigest: string;
}

export interface MlbP1M3aReadinessBinding {
  runtimeSchemaVersion: typeof MLB_P1_M3A_READINESS_RUNTIME_SCHEMA;
  contractSchemaVersion: typeof MLB_P1_M3A_READINESS_CONTRACT_SCHEMA;
  generatedAt: string;
  market: MlbP1M3aMarket;
  gateStatus: MlbP1M3aGateStatus;
  analysisStage: MlbP1M3aStage;
  blockers: string[];
  warnings: string[];
  evidenceSummary: {
    fresh: number;
    stale: number;
    degraded: number;
    missing: number;
    conflict: number;
    unknown: number;
    requiredFields: string[];
  };
  evidenceDigest: string;
  certifiedQuote: MlbP1M3aQuote;
}

export interface MlbP1M3aCaptureCandidate {
  schemaVersion: typeof MLB_P1_M3A_SCHEMA;
  capturedAt: string;
  origin: {
    channel: "INTERACTIVE_MLB_PREDICTOR";
    userAction: "GENERATE_PREDICTION";
    clientEvaluationId: string;
    frontendRelease: string | null;
  };
  game: {
    gamePk: number;
    gameDate: string;
    commenceTime: string;
    homeTeam: string;
    awayTeam: string;
    venue: string | null;
  };
  readiness: MlbP1M3aReadinessBinding;
  quote: MlbP1M3aQuote;
  model: {
    name: string;
    version: string;
    gitCommit: string | null;
    environment: string | null;
  };
  probabilities: {
    model: number;
    marketImplied: number;
    noVig: number | null;
    edgePp: number;
  };
  decision: {
    signal: MlbP1M3aSignal;
    category: MlbP1M3aCategory;
    confidenceLabel: string | null;
    confidencePct: number | null;
    recommendedStakeUnits: number;
    rationale: string | null;
    filterReasons: string[];
  };
  scientificSnapshot: {
    schemaVersion: typeof MLB_P1_M3A_SNAPSHOT_SCHEMA;
    payload: Record<string, unknown>;
    payloadDigest: string;
  };
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export interface MlbP1M3aCaptureIdentity {
  lifecycleKey: string;
  semanticFingerprint: string;
  clientRequestId: string;
}

export interface MlbP1M3aCaptureDecision {
  schemaVersion: typeof MLB_P1_M3A_SCHEMA;
  status: MlbP1M3aCaptureStatus;
  captureAllowed: boolean;
  economicDisposition: MlbP1M3aDisposition;
  errors: string[];
  warnings: string[];
  identity: MlbP1M3aCaptureIdentity | null;
  targetLedgerSchema: typeof MLB_P1_M3A_TARGET_LEDGER_SCHEMA;
}

export interface MlbP1M3aExistingCaptureRef {
  predictionId: string;
  lifecycleKey: string;
  semanticFingerprint: string;
  analysisStage: MlbP1M3aStage;
  capturedAt: string;
}

export interface MlbP1M3aRevisionResult {
  decision: MlbP1M3aRevisionDecision;
  supersedesId: string | null;
  reason: string;
}

export const MLB_P1_M3A_AUDIT_FINDINGS = [
  {
    code: "INTERACTIVE_EVALUATIONS_NOT_AUTOMATICALLY_LEDGERED",
    severity: "BLOCKING_FOR_M3B",
    finding: "The predictor can calculate a complete scientific snapshot without automatically appending that exact interactive evaluation to the owned immutable MLB ledger.",
  },
  {
    code: "S5C_IS_INDEPENDENT_RECOMPUTATION",
    severity: "REQUIRES_SEPARATE_PROVENANCE",
    finding: "S5C creates valuable automated shadow observations, but it recomputes through backend routes and is not proof of the exact user-triggered predictor execution.",
  },
  {
    code: "READINESS_BINDING_NOT_PERSISTED_UNIFORMLY",
    severity: "BLOCKING_FOR_ECONOMIC_ANALYSIS",
    finding: "The ledger schema can hold analytical layers, but the P1-M2B gate, evidence digest and exact certified quote are not yet mandatory capture fields.",
  },
  {
    code: "QUOTE_MODEL_EQUALITY_MUST_SURVIVE_CAPTURE",
    severity: "BLOCKING_FOR_ROI",
    finding: "P1-M2C prevents execution on a mismatched quote; P1-M3 must preserve proof that the stored quote is the same quote used by the model.",
  },
  {
    code: "DEPLOYMENT_COMMIT_IS_AUDIT_NOT_SPORTING_IDENTITY",
    severity: "IDEMPOTENCY_REQUIREMENT",
    finding: "A deployment commit must remain auditable but cannot make an otherwise identical sports decision count as a new sample.",
  },
  {
    code: "CONTROL_DECISIONS_MUST_BE_RETAINED",
    severity: "REQUIRED_FOR_CAUSAL_REVIEW",
    finding: "PASS, LEAN and INFO outputs must be captured alongside accepted recommendations so filters can be evaluated instead of only studying winners and selected bets.",
  },
] as const;

const HEX_64 = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|session|csrf)/i;

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  if (typeof value === "number") return Number.isFinite(value) ? round(value, 12) : null;
  if (value === undefined) return null;
  return value;
}

export function mlbP1M3aCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function mlbP1M3aSha256(value: unknown): string {
  return createHash("sha256").update(mlbP1M3aCanonicalJson(value)).digest("hex");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function isStandardAmericanOdds(value: number): boolean {
  return Number.isInteger(value) && (value <= -100 || value >= 100);
}

function americanImpliedProbability(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function sideAllowed(market: MlbP1M3aMarket, side: MlbP1M3aSide): boolean {
  if (market === "TOTAL" || market === "F5_TOTAL") return side === "OVER" || side === "UNDER";
  return side === "HOME" || side === "AWAY";
}

function lineRequired(market: MlbP1M3aMarket): boolean {
  return market === "RUN_LINE" || market === "TOTAL" || market === "F5_TOTAL";
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right;
  return Math.abs(left - right) <= 1e-9;
}

function quoteEqual(left: MlbP1M3aQuote, right: MlbP1M3aQuote): boolean {
  return left.market === right.market
    && left.side === right.side
    && normalizedText(left.selection) === normalizedText(right.selection)
    && sameNullableNumber(left.line, right.line)
    && left.oddsAmerican === right.oddsAmerican
    && left.oppositeOddsAmerican === right.oppositeOddsAmerican
    && normalizedText(left.book) === normalizedText(right.book)
    && left.sourceMode === right.sourceMode
    && left.capturedAt === right.capturedAt
    && left.provenanceDigest === right.provenanceDigest;
}

function ageSeconds(value: string, now: Date): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return (now.getTime() - parsed) / 1000;
}

function economicDisposition(signal: MlbP1M3aSignal): MlbP1M3aDisposition {
  if (signal === "BET" || signal === "BET_FUERTE") return "ACCEPTED";
  if (signal === "PASS") return "BLOCKED";
  return "OBSERVED";
}

function snapshotBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function findSensitiveValue(value: unknown, path = "snapshot", depth = 0): string | null {
  if (depth > 14 || value == null) return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findSensitiveValue(value[index], `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) && child !== "[REDACTED]" && child != null && child !== "") return `${path}.${key}`;
    const found = findSensitiveValue(child, `${path}.${key}`, depth + 1);
    if (found) return found;
  }
  return null;
}

function categoryCompatible(signal: MlbP1M3aSignal, category: MlbP1M3aCategory): boolean {
  if (signal === "BET_FUERTE") return category === "ELITE" || category === "PREMIUM";
  if (signal === "BET") return category === "PREMIUM" || category === "INFO";
  if (signal === "LEAN") return category === "LEAN";
  if (signal === "PASS") return category === "PASS";
  return category === "INFO";
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

export function buildMlbP1M3aCaptureIdentity(candidate: MlbP1M3aCaptureCandidate): MlbP1M3aCaptureIdentity {
  const lifecycleBasis = {
    version: "p1-m3a-lifecycle.v1",
    gamePk: candidate.game.gamePk,
    market: candidate.quote.market,
    side: candidate.quote.side,
    selection: normalizedText(candidate.quote.selection),
    line: candidate.quote.line,
  };
  const semanticBasis = {
    version: "p1-m3a-semantic-evaluation.v1",
    lifecycle: lifecycleBasis,
    gameDate: candidate.game.gameDate,
    commenceTime: candidate.game.commenceTime,
    homeTeam: normalizedText(candidate.game.homeTeam),
    awayTeam: normalizedText(candidate.game.awayTeam),
    readiness: {
      gateStatus: candidate.readiness.gateStatus,
      analysisStage: candidate.readiness.analysisStage,
      evidenceDigest: candidate.readiness.evidenceDigest,
      warnings: [...candidate.readiness.warnings].sort(),
    },
    quote: {
      oddsAmerican: candidate.quote.oddsAmerican,
      oppositeOddsAmerican: candidate.quote.oppositeOddsAmerican,
      book: normalizedText(candidate.quote.book),
      sourceMode: candidate.quote.sourceMode,
      provenanceDigest: candidate.quote.provenanceDigest,
    },
    model: {
      name: normalizedText(candidate.model.name),
      version: normalizedText(candidate.model.version),
      probability: candidate.probabilities.model,
      marketImplied: candidate.probabilities.marketImplied,
      noVig: candidate.probabilities.noVig,
      edgePp: candidate.probabilities.edgePp,
    },
    decision: {
      signal: candidate.decision.signal,
      category: candidate.decision.category,
      confidencePct: candidate.decision.confidencePct,
      recommendedStakeUnits: candidate.decision.recommendedStakeUnits,
      filterReasons: [...candidate.decision.filterReasons].sort(),
    },
    scientificSnapshotDigest: candidate.scientificSnapshot.payloadDigest,
  };
  const lifecycleKey = mlbP1M3aSha256(lifecycleBasis);
  const semanticFingerprint = mlbP1M3aSha256(semanticBasis);
  return {
    lifecycleKey,
    semanticFingerprint,
    clientRequestId: `p1m3a:${semanticFingerprint}`,
  };
}

export function validateMlbP1M3aCapture(
  candidate: MlbP1M3aCaptureCandidate,
  now = new Date(),
): MlbP1M3aCaptureDecision {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (candidate.schemaVersion !== MLB_P1_M3A_SCHEMA) pushUnique(errors, "CAPTURE_SCHEMA_MISMATCH");
  if (!validIso(candidate.capturedAt)) pushUnique(errors, "CAPTURE_TIMESTAMP_INVALID");
  if (!ID_PATTERN.test(candidate.origin.clientEvaluationId)) pushUnique(errors, "CLIENT_EVALUATION_ID_INVALID");
  if (!candidate.origin.frontendRelease && !candidate.model.gitCommit) pushUnique(errors, "MODEL_CODE_IDENTITY_MISSING");

  if (!Number.isInteger(candidate.game.gamePk) || candidate.game.gamePk <= 0) pushUnique(errors, "GAME_PK_INVALID");
  if (!DATE_PATTERN.test(candidate.game.gameDate)) pushUnique(errors, "GAME_DATE_INVALID");
  if (!validIso(candidate.game.commenceTime)) pushUnique(errors, "COMMENCE_TIME_INVALID");
  if (!candidate.game.homeTeam.trim() || !candidate.game.awayTeam.trim()) pushUnique(errors, "TEAM_IDENTITY_MISSING");
  if (normalizedText(candidate.game.homeTeam) === normalizedText(candidate.game.awayTeam)) pushUnique(errors, "TEAM_IDENTITY_CONFLICT");

  if (candidate.readiness.runtimeSchemaVersion !== MLB_P1_M3A_READINESS_RUNTIME_SCHEMA) pushUnique(errors, "READINESS_RUNTIME_SCHEMA_MISMATCH");
  if (candidate.readiness.contractSchemaVersion !== MLB_P1_M3A_READINESS_CONTRACT_SCHEMA) pushUnique(errors, "READINESS_CONTRACT_SCHEMA_MISMATCH");
  if (candidate.readiness.blockers.length > 0) pushUnique(errors, "READINESS_HAS_BLOCKERS");
  if (candidate.readiness.market !== candidate.quote.market) pushUnique(errors, "READINESS_MARKET_MISMATCH");
  if (candidate.readiness.gateStatus === "READY_FINAL" && candidate.readiness.analysisStage !== "FINAL") pushUnique(errors, "READINESS_STAGE_MISMATCH");
  if (candidate.readiness.gateStatus === "READY_PROVISIONAL" && candidate.readiness.analysisStage !== "PROVISIONAL") pushUnique(errors, "READINESS_STAGE_MISMATCH");
  if (!HEX_64.test(candidate.readiness.evidenceDigest)) pushUnique(errors, "EVIDENCE_DIGEST_INVALID");
  if (!quoteEqual(candidate.readiness.certifiedQuote, candidate.quote)) pushUnique(errors, "CERTIFIED_QUOTE_MISMATCH");

  const readinessAge = ageSeconds(candidate.readiness.generatedAt, now);
  if (readinessAge == null) pushUnique(errors, "READINESS_TIMESTAMP_INVALID");
  else if (readinessAge < -60) pushUnique(errors, "READINESS_TIMESTAMP_IN_FUTURE");
  else if (readinessAge > MLB_P1_M3A_MAX_READINESS_AGE_SECONDS) pushUnique(errors, "READINESS_STALE");

  if (!sideAllowed(candidate.quote.market, candidate.quote.side)) pushUnique(errors, "MARKET_SIDE_INCOMPATIBLE");
  if (!candidate.quote.selection.trim()) pushUnique(errors, "MARKET_SELECTION_MISSING");
  if (lineRequired(candidate.quote.market) && !finite(candidate.quote.line)) pushUnique(errors, "MARKET_LINE_REQUIRED");
  if (!isStandardAmericanOdds(candidate.quote.oddsAmerican)) pushUnique(errors, "MARKET_ODDS_INVALID");
  if (candidate.quote.oppositeOddsAmerican != null && !isStandardAmericanOdds(candidate.quote.oppositeOddsAmerican)) pushUnique(errors, "OPPOSITE_MARKET_ODDS_INVALID");
  if (!candidate.quote.book.trim()) pushUnique(errors, "MARKET_BOOK_MISSING");
  if (!HEX_64.test(candidate.quote.provenanceDigest)) pushUnique(errors, "MARKET_PROVENANCE_DIGEST_INVALID");

  const quoteAge = ageSeconds(candidate.quote.capturedAt, now);
  if (quoteAge == null) pushUnique(errors, "MARKET_CAPTURE_TIMESTAMP_INVALID");
  else if (quoteAge < -60) pushUnique(errors, "MARKET_CAPTURE_TIMESTAMP_IN_FUTURE");
  else if (quoteAge > MLB_P1_M3A_MAX_QUOTE_AGE_SECONDS) pushUnique(errors, "MARKET_QUOTE_STALE");

  const captureMs = Date.parse(candidate.capturedAt);
  const commenceMs = Date.parse(candidate.game.commenceTime);
  if (Number.isFinite(captureMs) && Number.isFinite(commenceMs) && captureMs >= commenceMs) pushUnique(errors, "GAME_ALREADY_STARTED_AT_CAPTURE");

  if (!candidate.model.name.trim() || !candidate.model.version.trim()) pushUnique(errors, "MODEL_IDENTITY_MISSING");
  if (!finite(candidate.probabilities.model) || candidate.probabilities.model <= 0 || candidate.probabilities.model >= 1) pushUnique(errors, "MODEL_PROBABILITY_INVALID");
  if (!finite(candidate.probabilities.marketImplied) || candidate.probabilities.marketImplied <= 0 || candidate.probabilities.marketImplied >= 1) pushUnique(errors, "MARKET_IMPLIED_PROBABILITY_INVALID");
  if (candidate.probabilities.noVig != null && (!finite(candidate.probabilities.noVig) || candidate.probabilities.noVig <= 0 || candidate.probabilities.noVig >= 1)) pushUnique(errors, "NO_VIG_PROBABILITY_INVALID");
  if (!finite(candidate.probabilities.edgePp)) pushUnique(errors, "EDGE_INVALID");

  if (isStandardAmericanOdds(candidate.quote.oddsAmerican) && finite(candidate.probabilities.marketImplied)) {
    const expected = americanImpliedProbability(candidate.quote.oddsAmerican);
    if (Math.abs(expected - candidate.probabilities.marketImplied) * 100 > 0.75) pushUnique(errors, "MARKET_IMPLIED_ARITHMETIC_MISMATCH");
  }
  if (finite(candidate.probabilities.model) && finite(candidate.probabilities.marketImplied) && finite(candidate.probabilities.edgePp)) {
    const expectedEdge = (candidate.probabilities.model - candidate.probabilities.marketImplied) * 100;
    if (Math.abs(expectedEdge - candidate.probabilities.edgePp) > 0.75) pushUnique(errors, "EDGE_ARITHMETIC_MISMATCH");
  }

  if (!categoryCompatible(candidate.decision.signal, candidate.decision.category)) pushUnique(errors, "DECISION_CATEGORY_MISMATCH");
  if (!finite(candidate.decision.recommendedStakeUnits) || candidate.decision.recommendedStakeUnits < 0 || candidate.decision.recommendedStakeUnits > 100) pushUnique(errors, "RECOMMENDED_STAKE_INVALID");
  if (!["BET", "BET_FUERTE"].includes(candidate.decision.signal) && candidate.decision.recommendedStakeUnits !== 0) pushUnique(errors, "NON_ACTIONABLE_STAKE_MUST_BE_ZERO");
  if (candidate.decision.confidencePct != null && (!finite(candidate.decision.confidencePct) || candidate.decision.confidencePct < 0 || candidate.decision.confidencePct > 100)) pushUnique(errors, "CONFIDENCE_INVALID");

  if (candidate.scientificSnapshot.schemaVersion !== MLB_P1_M3A_SNAPSHOT_SCHEMA) pushUnique(errors, "SCIENTIFIC_SNAPSHOT_SCHEMA_MISMATCH");
  if (!HEX_64.test(candidate.scientificSnapshot.payloadDigest)) pushUnique(errors, "SCIENTIFIC_SNAPSHOT_DIGEST_INVALID");
  else if (mlbP1M3aSha256(candidate.scientificSnapshot.payload) !== candidate.scientificSnapshot.payloadDigest) pushUnique(errors, "SCIENTIFIC_SNAPSHOT_DIGEST_MISMATCH");
  if (snapshotBytes(candidate.scientificSnapshot.payload) > MLB_P1_M3A_MAX_SNAPSHOT_BYTES) pushUnique(errors, "SCIENTIFIC_SNAPSHOT_TOO_LARGE");
  const sensitivePath = findSensitiveValue(candidate.scientificSnapshot.payload);
  if (sensitivePath) pushUnique(errors, `SCIENTIFIC_SNAPSHOT_SENSITIVE_FIELD:${sensitivePath}`);

  if (candidate.safety.mode !== "SHADOW_DECISION_SUPPORT") pushUnique(errors, "SAFETY_MODE_INVALID");
  if (candidate.safety.realFinancialExposure !== 0) pushUnique(errors, "REAL_FINANCIAL_EXPOSURE_NONZERO");
  if (candidate.safety.automaticBetPlacement !== false) pushUnique(errors, "AUTOMATIC_BETTING_ENABLED");
  if (candidate.safety.automaticModelChangesAllowed !== false) pushUnique(errors, "AUTOMATIC_MODEL_CHANGES_ENABLED");
  if (candidate.safety.automaticPromotionAllowed !== false) pushUnique(errors, "AUTOMATIC_PROMOTION_ENABLED");

  if (candidate.readiness.gateStatus === "READY_PROVISIONAL") pushUnique(warnings, "PROVISIONAL_EVALUATION");
  for (const warning of candidate.readiness.warnings) pushUnique(warnings, `READINESS:${warning}`);
  if (!candidate.model.gitCommit) pushUnique(warnings, "MODEL_GIT_COMMIT_MISSING_USING_FRONTEND_RELEASE");
  if (candidate.quote.sourceMode === "MANUAL") pushUnique(warnings, "MANUAL_MARKET_QUOTE");

  const identity = errors.length === 0 ? buildMlbP1M3aCaptureIdentity(candidate) : null;
  return {
    schemaVersion: MLB_P1_M3A_SCHEMA,
    status: errors.length === 0 ? "READY_TO_APPEND" : "REJECTED",
    captureAllowed: errors.length === 0,
    economicDisposition: economicDisposition(candidate.decision.signal),
    errors,
    warnings,
    identity,
    targetLedgerSchema: MLB_P1_M3A_TARGET_LEDGER_SCHEMA,
  };
}

export function decideMlbP1M3aRevision(
  previous: MlbP1M3aExistingCaptureRef | null,
  candidate: MlbP1M3aCaptureCandidate,
): MlbP1M3aRevisionResult {
  const identity = buildMlbP1M3aCaptureIdentity(candidate);
  if (!previous) return { decision: "NEW_CHAIN", supersedesId: null, reason: "No prior capture exists for this lifecycle." };
  if (previous.lifecycleKey !== identity.lifecycleKey) {
    return { decision: "REJECT_CHAIN_MISMATCH", supersedesId: null, reason: "The previous record belongs to a different game/market/selection/line lifecycle." };
  }
  if (previous.semanticFingerprint === identity.semanticFingerprint) {
    return { decision: "IDEMPOTENT_RETRY", supersedesId: previous.predictionId, reason: "The semantic sports decision is unchanged." };
  }
  const previousMs = Date.parse(previous.capturedAt);
  const candidateMs = Date.parse(candidate.capturedAt);
  if (!Number.isFinite(previousMs) || !Number.isFinite(candidateMs) || candidateMs <= previousMs) {
    return { decision: "REJECT_STALE_REVISION", supersedesId: null, reason: "A newer immutable revision cannot be replaced by an older or equal capture timestamp." };
  }
  if (previous.analysisStage === "FINAL" && candidate.readiness.analysisStage === "PROVISIONAL") {
    return { decision: "REJECT_STAGE_REGRESSION", supersedesId: null, reason: "A PROVISIONAL evaluation cannot supersede a FINAL evaluation." };
  }
  return {
    decision: "APPEND_SUPERSEDING_REVISION",
    supersedesId: previous.predictionId,
    reason: "The lifecycle is stable and the quote, evidence, stage or model output changed materially.",
  };
}

export function toMlbP1M3aLedgerCompatibleInput(
  candidate: MlbP1M3aCaptureCandidate,
  identity: MlbP1M3aCaptureIdentity,
  supersedesId?: string,
) {
  const snapshot = candidate.scientificSnapshot.payload as Record<string, any>;
  const snapshotAnalysis = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : {};
  const p1M3aLayer = {
    schemaVersion: MLB_P1_M3A_SCHEMA,
    identity,
    origin: candidate.origin,
    readiness: candidate.readiness,
    quote: candidate.quote,
    safety: candidate.safety,
  };
  return {
    schemaVersion: MLB_P1_M3A_TARGET_LEDGER_SCHEMA,
    clientRequestId: identity.clientRequestId,
    source: "app" as const,
    ...(supersedesId ? { supersedesId } : {}),
    model: {
      name: candidate.model.name,
      version: candidate.model.version,
      ...(candidate.model.gitCommit ? { gitCommit: candidate.model.gitCommit } : {}),
      ...(candidate.model.environment ? { environment: candidate.model.environment } : {}),
    },
    game: {
      gamePk: candidate.game.gamePk,
      gameDate: candidate.game.gameDate,
      commenceTime: candidate.game.commenceTime,
      homeTeam: candidate.game.homeTeam,
      awayTeam: candidate.game.awayTeam,
      ...(candidate.game.venue ? { venue: candidate.game.venue } : {}),
    },
    market: {
      type: candidate.quote.market,
      selection: candidate.quote.selection,
      ...(candidate.quote.line != null ? { line: candidate.quote.line } : {}),
      oddsAmerican: candidate.quote.oddsAmerican,
      book: candidate.quote.book,
      capturedAt: candidate.quote.capturedAt,
    },
    probabilities: {
      model: candidate.probabilities.model,
      marketImplied: candidate.probabilities.marketImplied,
      ...(candidate.probabilities.noVig != null ? { noVig: candidate.probabilities.noVig } : {}),
      edgePp: candidate.probabilities.edgePp,
    },
    decision: {
      signal: candidate.decision.signal,
      confidenceLabel: candidate.decision.confidenceLabel ?? candidate.decision.category,
      ...(candidate.decision.confidencePct != null ? { confidencePct: candidate.decision.confidencePct } : {}),
      stakeUnits: candidate.decision.recommendedStakeUnits,
      ...(candidate.decision.rationale ? { rationale: candidate.decision.rationale } : {}),
    },
    analysis: {
      stage: candidate.readiness.analysisStage,
      warnings: [...new Set([...(snapshotAnalysis.warnings ?? []), ...candidate.readiness.warnings])],
      ...(Array.isArray(snapshotAnalysis.factors) ? { factors: snapshotAnalysis.factors } : {}),
      ...(Array.isArray(snapshotAnalysis.sources) ? { sources: snapshotAnalysis.sources } : {}),
      layers: {
        ...(snapshotAnalysis.layers && typeof snapshotAnalysis.layers === "object" ? snapshotAnalysis.layers : {}),
        p1M3aCapture: p1M3aLayer,
        filterReasons: candidate.decision.filterReasons,
      },
      ...(snapshotAnalysis.injuryAudit ? { injuryAudit: snapshotAnalysis.injuryAudit } : {}),
      rawInputs: snapshotAnalysis.rawInputs ?? null,
      rawOutput: snapshotAnalysis.rawOutput ?? null,
    },
  };
}
