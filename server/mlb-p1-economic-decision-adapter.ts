import {
  MLB_P1_M3A_MAX_QUOTE_AGE_SECONDS,
  buildMlbP1M3aCaptureIdentity,
  mlbP1M3aSha256,
  validateMlbP1M3aCapture,
  type MlbP1M3aCaptureCandidate,
  type MlbP1M3aCaptureDecision,
  type MlbP1M3aMarket,
  type MlbP1M3aSignal,
} from "./mlb-p1-scientific-capture-contract";
import {
  MLB_P1_M4A_SCHEMA,
  evaluateMlbP1M4aEconomicDecision,
  isMlbP1M4aStandardAmericanOdds,
  type MlbP1M4aDecisionInput,
  type MlbP1M4aDecisionResult,
  type MlbP1M4aSignal,
} from "./mlb-p1-economic-decision-contract";

export const MLB_P1_M4B_SCHEMA = "courtedge-p1-m4b-economic-decision-adapter.v1" as const;
export const MLB_P1_M4B_ADAPTER_VERSION = "mlb-p1m3a-to-p1m4a-adapter.v1" as const;
export const MLB_P1_M4B_LAYER_KEY = "p1M4bEconomicDecision" as const;

export type MlbP1M4bStatus = "ADAPTED" | "REJECTED";
export type MlbP1M4bSourceSignalPolicy =
  | "ML_F5_EDGE_CONFIDENCE_V2"
  | "RUN_LINE_COVER_PROBABILITY_V1"
  | "TOTAL_RUN_DIFFERENTIAL_V1"
  | "F5_TOTAL_RUN_DIFFERENTIAL_V1";
export type MlbP1M4bSignalRelation =
  | "MATCH"
  | "ECONOMIC_DOWNGRADE"
  | "ECONOMIC_UPGRADE"
  | "NON_COMPARABLE_INFO";

export interface MlbP1M4bSignalCompatibility {
  sourceSignal: MlbP1M3aSignal;
  sourceSignalNormalized: MlbP1M4aSignal;
  economicModelSignal: MlbP1M4aSignal;
  relation: MlbP1M4bSignalRelation;
  sourcePolicy: MlbP1M4bSourceSignalPolicy;
  policyDifferenceExpected: boolean;
  originalDecisionPreserved: true;
}

export interface MlbP1M4bAdapterResult {
  schemaVersion: typeof MLB_P1_M4B_SCHEMA;
  adapterVersion: typeof MLB_P1_M4B_ADAPTER_VERSION;
  status: MlbP1M4bStatus;
  sourceDigest: string;
  economicInputDigest: string | null;
  source: {
    captureSchemaVersion: MlbP1M3aCaptureCandidate["schemaVersion"];
    captureStatus: MlbP1M3aCaptureDecision["status"];
    captureAllowed: boolean;
    captureIdentity: MlbP1M3aCaptureDecision["identity"];
    market: MlbP1M3aMarket;
    side: MlbP1M3aCaptureCandidate["quote"]["side"];
    selection: string;
    line: number | null;
    modelProbability: number;
    marketImpliedProbability: number;
    noVigProbability: number | null;
    sourceSignal: MlbP1M3aSignal;
    sourceCategory: MlbP1M3aCaptureCandidate["decision"]["category"];
    sourceRecommendedStakeUnits: number;
    sourcePolicy: MlbP1M4bSourceSignalPolicy;
  };
  economicDecision: MlbP1M4aDecisionResult | null;
  signalCompatibility: MlbP1M4bSignalCompatibility | null;
  errors: string[];
  warnings: string[];
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    sportsbookIntegration: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
    originalModelOutputMutated: false;
    ledgerWritePerformed: false;
  };
}

export interface MlbP1M4bAttachmentResult {
  adapter: MlbP1M4bAdapterResult;
  candidate: MlbP1M3aCaptureCandidate | null;
  attached: boolean;
  idempotent: boolean;
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function sameNullableNumber(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right;
  return Math.abs(left - right) <= 1e-9;
}

function quoteIdentityMatches(candidate: MlbP1M3aCaptureCandidate): boolean {
  const certified = candidate.readiness.certifiedQuote;
  const quote = candidate.quote;
  return certified.market === quote.market
    && certified.side === quote.side
    && normalizedText(certified.selection) === normalizedText(quote.selection)
    && certified.oddsAmerican === quote.oddsAmerican
    && certified.oppositeOddsAmerican === quote.oppositeOddsAmerican
    && normalizedText(certified.book) === normalizedText(quote.book)
    && certified.sourceMode === quote.sourceMode
    && certified.capturedAt === quote.capturedAt
    && certified.provenanceDigest === quote.provenanceDigest;
}

function quoteLineMatches(candidate: MlbP1M3aCaptureCandidate): boolean {
  return sameNullableNumber(candidate.readiness.certifiedQuote.line, candidate.quote.line);
}

function quoteIsFresh(candidate: MlbP1M3aCaptureCandidate, now: Date): boolean {
  const capturedMs = Date.parse(candidate.quote.capturedAt);
  if (!Number.isFinite(capturedMs)) return false;
  const ageSeconds = (now.getTime() - capturedMs) / 1000;
  return ageSeconds >= -60 && ageSeconds <= MLB_P1_M3A_MAX_QUOTE_AGE_SECONDS;
}

function bilateralPriceIsValid(candidate: MlbP1M3aCaptureCandidate): boolean {
  return candidate.quote.oppositeOddsAmerican != null
    && isMlbP1M4aStandardAmericanOdds(candidate.quote.oppositeOddsAmerican);
}

export function mlbP1M4bSourceSignalPolicy(market: MlbP1M3aMarket): MlbP1M4bSourceSignalPolicy {
  if (market === "ML" || market === "F5_ML") return "ML_F5_EDGE_CONFIDENCE_V2";
  if (market === "RUN_LINE") return "RUN_LINE_COVER_PROBABILITY_V1";
  if (market === "TOTAL") return "TOTAL_RUN_DIFFERENTIAL_V1";
  return "F5_TOTAL_RUN_DIFFERENTIAL_V1";
}

export function normalizeMlbP1M4bSourceSignal(signal: MlbP1M3aSignal): MlbP1M4aSignal {
  if (signal === "BET" || signal === "BET_FUERTE") return "BET";
  if (signal === "LEAN") return "LEAN";
  return "PASS";
}

function signalRank(signal: MlbP1M4aSignal): number {
  if (signal === "BET") return 2;
  if (signal === "LEAN") return 1;
  return 0;
}

function signalCompatibility(
  candidate: MlbP1M3aCaptureCandidate,
  economicDecision: MlbP1M4aDecisionResult,
): MlbP1M4bSignalCompatibility {
  const normalized = normalizeMlbP1M4bSourceSignal(candidate.decision.signal);
  const policy = mlbP1M4bSourceSignalPolicy(candidate.quote.market);
  let relation: MlbP1M4bSignalRelation;
  if (candidate.decision.signal === "INFO") relation = "NON_COMPARABLE_INFO";
  else if (normalized === economicDecision.modelSignal) relation = "MATCH";
  else if (signalRank(economicDecision.modelSignal) < signalRank(normalized)) relation = "ECONOMIC_DOWNGRADE";
  else relation = "ECONOMIC_UPGRADE";
  return {
    sourceSignal: candidate.decision.signal,
    sourceSignalNormalized: normalized,
    economicModelSignal: economicDecision.modelSignal,
    relation,
    sourcePolicy: policy,
    policyDifferenceExpected: policy !== "ML_F5_EDGE_CONFIDENCE_V2",
    originalDecisionPreserved: true,
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function sourceDigest(candidate: MlbP1M3aCaptureCandidate): string {
  return mlbP1M3aSha256({
    schemaVersion: MLB_P1_M4B_SCHEMA,
    captureSchemaVersion: candidate.schemaVersion,
    captureIdentity: buildMlbP1M3aCaptureIdentity(candidate),
    readiness: {
      gateStatus: candidate.readiness.gateStatus,
      analysisStage: candidate.readiness.analysisStage,
      evidenceDigest: candidate.readiness.evidenceDigest,
      blockers: candidate.readiness.blockers,
      warnings: candidate.readiness.warnings,
    },
    quote: candidate.quote,
    probabilities: candidate.probabilities,
    sourceDecision: candidate.decision,
  });
}

function safety(): MlbP1M4bAdapterResult["safety"] {
  return {
    mode: "SHADOW_DECISION_SUPPORT",
    realFinancialExposure: 0,
    automaticBetPlacement: false,
    sportsbookIntegration: false,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    originalModelOutputMutated: false,
    ledgerWritePerformed: false,
  };
}

function sourceSummary(
  candidate: MlbP1M3aCaptureCandidate,
  captureDecision: MlbP1M3aCaptureDecision,
): MlbP1M4bAdapterResult["source"] {
  return {
    captureSchemaVersion: candidate.schemaVersion,
    captureStatus: captureDecision.status,
    captureAllowed: captureDecision.captureAllowed,
    captureIdentity: captureDecision.identity,
    market: candidate.quote.market,
    side: candidate.quote.side,
    selection: candidate.quote.selection,
    line: candidate.quote.line,
    modelProbability: candidate.probabilities.model,
    marketImpliedProbability: candidate.probabilities.marketImplied,
    noVigProbability: candidate.probabilities.noVig,
    sourceSignal: candidate.decision.signal,
    sourceCategory: candidate.decision.category,
    sourceRecommendedStakeUnits: candidate.decision.recommendedStakeUnits,
    sourcePolicy: mlbP1M4bSourceSignalPolicy(candidate.quote.market),
  };
}

export function adaptMlbP1M4bEconomicDecision(
  candidate: MlbP1M3aCaptureCandidate,
  now = new Date(),
): MlbP1M4bAdapterResult {
  const captureDecision = validateMlbP1M3aCapture(candidate, now);
  const digest = sourceDigest(candidate);
  if (!captureDecision.captureAllowed) {
    return {
      schemaVersion: MLB_P1_M4B_SCHEMA,
      adapterVersion: MLB_P1_M4B_ADAPTER_VERSION,
      status: "REJECTED",
      sourceDigest: digest,
      economicInputDigest: null,
      source: sourceSummary(candidate, captureDecision),
      economicDecision: null,
      signalCompatibility: null,
      errors: captureDecision.errors.map((error) => `P1_M3A:${error}`),
      warnings: captureDecision.warnings,
      safety: safety(),
    };
  }

  const economicInput: MlbP1M4aDecisionInput = {
    market: candidate.quote.market,
    stage: candidate.readiness.analysisStage,
    gateStatus: candidate.readiness.gateStatus,
    blockers: [...candidate.readiness.blockers],
    warnings: unique([...candidate.readiness.warnings, ...captureDecision.warnings]),
    modelProbability: candidate.probabilities.model,
    currentOddsAmerican: candidate.quote.oddsAmerican,
    noVigProbability: candidate.probabilities.noVig,
    quoteIntegrity: {
      certifiedQuoteMatch: quoteIdentityMatches(candidate),
      certifiedLineMatch: quoteLineMatches(candidate),
      fresh: quoteIsFresh(candidate, now),
      bilateral: bilateralPriceIsValid(candidate),
    },
  };
  const economicDecision = evaluateMlbP1M4aEconomicDecision(economicInput);
  const compatibility = signalCompatibility(candidate, economicDecision);
  const warnings = [...economicInput.warnings];
  if (compatibility.relation !== "MATCH" && compatibility.relation !== "NON_COMPARABLE_INFO") {
    warnings.push(
      compatibility.policyDifferenceExpected
        ? `SOURCE_SIGNAL_POLICY_DIFFERENCE_EXPECTED:${compatibility.sourcePolicy}`
        : "ML_F5_SOURCE_SIGNAL_PARITY_MISMATCH",
    );
  }
  if (compatibility.relation === "NON_COMPARABLE_INFO") warnings.push("SOURCE_INFO_SIGNAL_RETAINED_AS_CONTROL");

  return {
    schemaVersion: MLB_P1_M4B_SCHEMA,
    adapterVersion: MLB_P1_M4B_ADAPTER_VERSION,
    status: "ADAPTED",
    sourceDigest: digest,
    economicInputDigest: mlbP1M3aSha256({
      schemaVersion: MLB_P1_M4A_SCHEMA,
      input: economicInput,
    }),
    source: sourceSummary(candidate, captureDecision),
    economicDecision,
    signalCompatibility: compatibility,
    errors: [],
    warnings: unique(warnings),
    safety: safety(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rejectedAttachment(
  adapter: MlbP1M4bAdapterResult,
  error: string,
): MlbP1M4bAttachmentResult {
  return {
    adapter: {
      ...adapter,
      status: "REJECTED",
      errors: unique([...adapter.errors, error]),
    },
    candidate: null,
    attached: false,
    idempotent: false,
  };
}

export function attachMlbP1M4bEconomicDecision(
  candidate: MlbP1M3aCaptureCandidate,
  now = new Date(),
): MlbP1M4bAttachmentResult {
  const adapter = adaptMlbP1M4bEconomicDecision(candidate, now);
  if (adapter.status !== "ADAPTED" || !adapter.economicDecision) {
    return { adapter, candidate: null, attached: false, idempotent: false };
  }

  const payload = candidate.scientificSnapshot.payload;
  const analysis = isRecord(payload.analysis) ? payload.analysis : {};
  const layers = isRecord(analysis.layers) ? analysis.layers : {};
  const existing = layers[MLB_P1_M4B_LAYER_KEY];
  if (existing !== undefined) {
    if (
      isRecord(existing)
      && existing.schemaVersion === MLB_P1_M4B_SCHEMA
      && existing.sourceDigest === adapter.sourceDigest
    ) {
      return { adapter, candidate, attached: false, idempotent: true };
    }
    return rejectedAttachment(adapter, "P1_M4B_LAYER_CONFLICT");
  }

  const enriched = cloneJson(candidate);
  const enrichedPayload = enriched.scientificSnapshot.payload;
  const enrichedAnalysis = isRecord(enrichedPayload.analysis) ? enrichedPayload.analysis : {};
  const enrichedLayers = isRecord(enrichedAnalysis.layers) ? enrichedAnalysis.layers : {};
  enrichedPayload.analysis = {
    ...enrichedAnalysis,
    layers: {
      ...enrichedLayers,
      [MLB_P1_M4B_LAYER_KEY]: adapter,
    },
  };
  enriched.scientificSnapshot.payloadDigest = mlbP1M3aSha256(enrichedPayload);

  const enrichedValidation = validateMlbP1M3aCapture(enriched, now);
  if (!enrichedValidation.captureAllowed) {
    return rejectedAttachment(
      adapter,
      `P1_M4B_ATTACHMENT_INVALID:${enrichedValidation.errors.join(",")}`,
    );
  }
  return {
    adapter,
    candidate: enriched,
    attached: true,
    idempotent: false,
  };
}
