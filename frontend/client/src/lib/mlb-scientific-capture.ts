import type {
  MlbPregameMarket,
  MlbPregameReadinessReport,
} from "./mlb-pregame-readiness";
import type { MlbScientificSnapshot } from "./mlb-scientific-snapshot";
import { prepareMlbP1M3cSnapshotForTransport } from "./mlb-scientific-capture-transport";

export const MLB_P1_M3C_FRONTEND_RELEASE = "p1-m3c1-json-digest-transport-2026-08-05" as const;
export const MLB_P1_M3A_SCHEMA = "courtedge-p1-m3a-scientific-capture-contract.v1" as const;
export const MLB_P1_M3B_SCHEMA = "courtedge-p1-m3b-scientific-capture-service.v1" as const;
export const MLB_P1_M3B_ENDPOINT = "/api/mlb/p1/v1/scientific-captures" as const;
export const MLB_P1_M3C_SCHEMA = "courtedge-p1-m3c-scientific-emission-ui.v1" as const;

export type MlbP1M3cSide = "HOME" | "AWAY" | "OVER" | "UNDER";
export type MlbP1M3cSignal = "BET_FUERTE" | "BET" | "LEAN" | "PASS" | "INFO";
export type MlbP1M3cCategory = "ELITE" | "PREMIUM" | "LEAN" | "PASS" | "INFO";

export interface MlbP1M3cAutomaticSelection {
  marketLabel: "ML" | "F5" | "Run Line" | "O/U";
  pick: string;
  oddsAmerican: number;
  modelProbPct: number;
}

export interface MlbP1M3cSelectionInput {
  market: MlbPregameMarket;
  homeTeam: string;
  awayTeam: string;
  lines: {
    mlHome: string;
    mlAway: string;
    runLineHomeOdds: string;
    runLineAwayOdds: string;
    overOdds: string;
    underOdds: string;
    f5MlHome: string;
    f5MlAway: string;
  };
  result: {
    homeProb: number;
    awayProb: number;
    f5HomeProb: number;
    f5AwayProb: number;
    pickedSide?: "home" | "away";
    recommendedOdds?: number;
    f5PickedSide?: "home" | "away";
    f5RecommendedOdds?: number;
    ouLine: number;
    runLine: {
      pickedSide: "home" | "away";
      side: string;
      coversRL: boolean;
      coverProb?: number;
    };
    ouResult: {
      side: "OVER" | "UNDER";
      hitProb?: number;
    };
  };
}

export interface MlbP1M3cEvaluation {
  market: MlbPregameMarket;
  side: MlbP1M3cSide;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  oppositeOddsAmerican: number | null;
  sourceModeHint: "AUTOMATIC" | "CONSENSUS" | "MANUAL" | null;
  modelProbability: number;
  marketImplied: number;
  noVig: number | null;
  edgePp: number;
  signal: MlbP1M3cSignal;
  category: MlbP1M3cCategory;
  confidenceLabel: string | null;
  confidencePct: number | null;
  recommendedStakeUnits: number;
  rationale: string | null;
  filterReasons: string[];
}

export interface MlbP1M3cCandidateInput {
  report: MlbPregameReadinessReport;
  scientificSnapshot: MlbScientificSnapshot;
  evaluation: MlbP1M3cEvaluation;
  capturedAt: string;
  clientEvaluationId: string;
  venue: string | null;
  model: {
    name: string;
    version: string;
    gitCommit: string | null;
    environment: string | null;
  };
}

export interface MlbP1M3bCaptureResult {
  schemaVersion: typeof MLB_P1_M3B_SCHEMA;
  endpoint: typeof MLB_P1_M3B_ENDPOINT;
  outcome: "APPENDED" | "IDEMPOTENT";
  predictionId: string;
  recordedAt: string;
  idempotent: boolean;
  identity: {
    lifecycleKey: string;
    semanticFingerprint: string;
    clientRequestId: string;
  };
  revision: {
    decision: string;
    supersedesId: string | null;
    reason: string;
  };
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export type MlbP1M3cUiState =
  | { status: "IDLE" }
  | { status: "CAPTURING"; clientEvaluationId: string }
  | {
      status: "APPENDED" | "IDEMPOTENT";
      clientEvaluationId: string;
      predictionId: string;
      recordedAt: string;
      revisionDecision: string;
    }
  | {
      status: "REJECTED";
      clientEvaluationId: string | null;
      message: string;
      code: string | null;
    };

export const MLB_P1_M3C_IDLE_STATE: MlbP1M3cUiState = { status: "IDLE" };

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function americanOdds(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null || !Number.isInteger(parsed) || (parsed > -100 && parsed < 100)) return null;
  return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function iso(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function round(value: number, digits = 12): number {
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
  if (typeof value === "number") return Number.isFinite(value) ? round(value) : null;
  if (value === undefined) return null;
  return value;
}

export function mlbP1M3cCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function mlbP1M3cSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(mlbP1M3cCanonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createMlbP1M3cClientEvaluationId(gamePk: number, market: MlbPregameMarket): string {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replaceAll("-", "")
    : Math.random().toString(36).slice(2, 14);
  return `p1m3c:${gamePk}:${market}:${Date.now().toString(36)}:${random}`.slice(0, 160);
}

export function resolveMlbP1M3cAutomaticSelection(
  input: MlbP1M3cSelectionInput,
): MlbP1M3cAutomaticSelection | null {
  const home = input.homeTeam || "Local";
  const away = input.awayTeam || "Visitante";
  const parseOdds = (value: string, fallback?: number): number | null =>
    americanOdds(value) ?? (fallback != null ? americanOdds(fallback) : null);

  if (input.market === "ML") {
    const side = input.result.pickedSide ?? (input.result.homeProb >= input.result.awayProb ? "home" : "away");
    const odds = side === "home"
      ? parseOdds(input.lines.mlHome, input.result.recommendedOdds)
      : parseOdds(input.lines.mlAway, input.result.recommendedOdds);
    if (odds == null) return null;
    return {
      marketLabel: "ML",
      pick: `${side === "home" ? home : away} ML`,
      oddsAmerican: odds,
      modelProbPct: round((side === "home" ? input.result.homeProb : input.result.awayProb) * 100, 8),
    };
  }

  if (input.market === "F5_ML") {
    const side = input.result.f5PickedSide ?? (input.result.f5HomeProb >= input.result.f5AwayProb ? "home" : "away");
    const odds = side === "home"
      ? parseOdds(input.lines.f5MlHome, input.result.f5RecommendedOdds)
      : parseOdds(input.lines.f5MlAway, input.result.f5RecommendedOdds);
    if (odds == null) return null;
    return {
      marketLabel: "F5",
      pick: `${side === "home" ? home : away} F5`,
      oddsAmerican: odds,
      modelProbPct: round((side === "home" ? input.result.f5HomeProb : input.result.f5AwayProb) * 100, 8),
    };
  }

  if (input.market === "RUN_LINE") {
    const side = input.result.runLine.pickedSide;
    const odds = side === "home"
      ? parseOdds(input.lines.runLineHomeOdds)
      : parseOdds(input.lines.runLineAwayOdds);
    if (odds == null) return null;
    return {
      marketLabel: "Run Line",
      pick: `${input.result.runLine.side} (${side === "home" ? home : away})`,
      oddsAmerican: odds,
      modelProbPct: round((input.result.runLine.coverProb ?? (input.result.runLine.coversRL ? 0.56 : 0.44)) * 100, 8),
    };
  }

  if (input.market === "TOTAL") {
    const side = input.result.ouResult.side;
    const odds = side === "OVER"
      ? parseOdds(input.lines.overOdds)
      : parseOdds(input.lines.underOdds);
    if (odds == null) return null;
    return {
      marketLabel: "O/U",
      pick: `${side} ${input.result.ouLine}`,
      oddsAmerican: odds,
      modelProbPct: round((input.result.ouResult.hitProb ?? 0.55) * 100, 8),
    };
  }

  return null;
}

function selectedCertifiedOdds(
  market: MlbPregameMarket,
  side: MlbP1M3cSide,
  quote: Record<string, unknown>,
): number | null {
  if (market === "ML" || market === "F5_ML") {
    return side === "HOME"
      ? americanOdds(quote.home ?? quote.homeOdds)
      : americanOdds(quote.away ?? quote.awayOdds);
  }
  if (market === "RUN_LINE") {
    return side === "HOME" ? americanOdds(quote.homeOdds) : americanOdds(quote.awayOdds);
  }
  if (market === "TOTAL" || market === "F5_TOTAL") {
    return side === "OVER" ? americanOdds(quote.overOdds) : americanOdds(quote.underOdds);
  }
  return null;
}

function oppositeCertifiedOdds(
  market: MlbPregameMarket,
  side: MlbP1M3cSide,
  quote: Record<string, unknown>,
): number | null {
  if (market === "ML" || market === "F5_ML") {
    return side === "HOME"
      ? americanOdds(quote.away ?? quote.awayOdds)
      : americanOdds(quote.home ?? quote.homeOdds);
  }
  if (market === "RUN_LINE") {
    return side === "HOME" ? americanOdds(quote.awayOdds) : americanOdds(quote.homeOdds);
  }
  if (market === "TOTAL" || market === "F5_TOTAL") {
    return side === "OVER" ? americanOdds(quote.underOdds) : americanOdds(quote.overOdds);
  }
  return null;
}

function quoteSourceMode(input: {
  market: MlbPregameMarket;
  sourceStatus: string;
  sourceModeHint: MlbP1M3cEvaluation["sourceModeHint"];
  quote: Record<string, unknown>;
}): "AUTOMATIC" | "CONSENSUS" | "MANUAL" {
  if (input.sourceStatus === "MANUAL_OVERRIDE" || input.sourceModeHint === "MANUAL") return "MANUAL";
  const serialized = JSON.stringify(input.quote).toLowerCase();
  if (input.sourceModeHint === "CONSENSUS" || serialized.includes("consensus") || serialized.includes("consenso")) {
    return "CONSENSUS";
  }
  return "AUTOMATIC";
}

function categoryForSignal(signal: MlbP1M3cSignal): MlbP1M3cCategory {
  if (signal === "BET_FUERTE") return "ELITE";
  if (signal === "BET") return "PREMIUM";
  if (signal === "LEAN") return "LEAN";
  if (signal === "PASS") return "PASS";
  return "INFO";
}

export function normalizeMlbP1M3cEvaluationCategory(
  signal: MlbP1M3cSignal,
  category?: MlbP1M3cCategory | null,
): MlbP1M3cCategory {
  return category ?? categoryForSignal(signal);
}

export async function buildMlbP1M3cCandidate(input: MlbP1M3cCandidateInput) {
  const { report, evaluation } = input;
  if (!report.gate.analysisAllowed || !["READY_FINAL", "READY_PROVISIONAL"].includes(report.gate.status)) {
    throw new Error("P1_M3C_READINESS_NOT_EXECUTABLE");
  }
  if (report.market !== evaluation.market) throw new Error("P1_M3C_MARKET_MISMATCH");
  if (!report.game.startTime || !report.game.officialDate || !report.game.homeTeam.name || !report.game.awayTeam.name) {
    throw new Error("P1_M3C_GAME_IDENTITY_INCOMPLETE");
  }

  const marketEvidence = report.evidence.find((item) => item.field === "MARKET_ODDS");
  const details = record(marketEvidence?.details);
  const quote = record(details?.quote) ?? details;
  if (!marketEvidence || !quote) throw new Error("P1_M3C_CERTIFIED_QUOTE_MISSING");

  const certifiedSelected = selectedCertifiedOdds(report.market, evaluation.side, quote);
  const certifiedOpposite = oppositeCertifiedOdds(report.market, evaluation.side, quote);
  if (certifiedSelected == null || certifiedSelected !== evaluation.oddsAmerican) {
    throw new Error("P1_M3C_CERTIFIED_QUOTE_SELECTION_MISMATCH");
  }
  if (evaluation.oppositeOddsAmerican != null && certifiedOpposite !== evaluation.oppositeOddsAmerican) {
    throw new Error("P1_M3C_CERTIFIED_QUOTE_OPPOSITE_MISMATCH");
  }

  const certifiedBaseLine = finiteNumber(quote.line);
  if (report.market === "TOTAL" && evaluation.line !== certifiedBaseLine) {
    throw new Error("P1_M3C_CERTIFIED_TOTAL_LINE_MISMATCH");
  }
  if (report.market === "RUN_LINE" && evaluation.line != null && certifiedBaseLine != null
      && Math.abs(evaluation.line) !== Math.abs(certifiedBaseLine)) {
    throw new Error("P1_M3C_CERTIFIED_RUN_LINE_MISMATCH");
  }

  const quoteCapturedAt = iso(quote.capturedAt)
    ?? iso(quote.providerLastUpdate)
    ?? iso(marketEvidence.observedAt)
    ?? iso(report.generatedAt);
  if (!quoteCapturedAt) throw new Error("P1_M3C_CERTIFIED_QUOTE_TIMESTAMP_MISSING");

  const providerLastUpdate = iso(quote.providerLastUpdate) ?? iso(marketEvidence.observedAt);
  const book = text(quote.book)
    ?? text(details?.book)
    ?? text(record(details?.source)?.name)
    ?? text(record(details?.source)?.book)
    ?? "Certified market source";
  const sourceMode = quoteSourceMode({
    market: report.market,
    sourceStatus: marketEvidence.sourceStatus,
    sourceModeHint: evaluation.sourceModeHint,
    quote,
  });
  const consensusMethod = text(quote.consensusMethod) ?? text(details?.consensusMethod);

  const provenanceBasis = {
    field: marketEvidence.field,
    state: marketEvidence.state,
    sourceIds: marketEvidence.sourceIds,
    endpoints: marketEvidence.endpoints,
    authority: marketEvidence.authority,
    observedAt: marketEvidence.observedAt,
    fetchedAt: marketEvidence.fetchedAt,
    sourceStatus: marketEvidence.sourceStatus,
    quality: marketEvidence.quality,
    details: marketEvidence.details,
    selectedSide: evaluation.side,
    selectedLine: evaluation.line,
    selectedOddsAmerican: evaluation.oddsAmerican,
  };
  const provenanceDigest = await mlbP1M3cSha256(provenanceBasis);

  const certifiedQuote = {
    market: evaluation.market,
    side: evaluation.side,
    selection: evaluation.selection,
    line: evaluation.line,
    oddsAmerican: evaluation.oddsAmerican,
    oppositeOddsAmerican: certifiedOpposite,
    book,
    sourceMode,
    capturedAt: quoteCapturedAt,
    providerLastUpdate,
    consensusMethod,
    provenanceDigest,
  } as const;

  const evidenceDigest = await mlbP1M3cSha256({
    gamePk: report.game.gamePk,
    market: report.market,
    gate: report.gate,
    summary: report.summary,
    evidence: report.evidence,
  });
  const preparedSnapshot = prepareMlbP1M3cSnapshotForTransport(input.scientificSnapshot);
  const payloadDigest = await mlbP1M3cSha256(preparedSnapshot.payload);

  return {
    schemaVersion: MLB_P1_M3A_SCHEMA,
    capturedAt: input.capturedAt,
    origin: {
      channel: "INTERACTIVE_MLB_PREDICTOR" as const,
      userAction: "GENERATE_PREDICTION" as const,
      clientEvaluationId: input.clientEvaluationId,
      frontendRelease: MLB_P1_M3C_FRONTEND_RELEASE,
    },
    game: {
      gamePk: report.game.gamePk,
      gameDate: report.game.officialDate,
      commenceTime: new Date(report.game.startTime).toISOString(),
      homeTeam: report.game.homeTeam.name,
      awayTeam: report.game.awayTeam.name,
      venue: input.venue,
    },
    readiness: {
      runtimeSchemaVersion: report.schemaVersion,
      contractSchemaVersion: report.contractSchemaVersion,
      generatedAt: report.generatedAt,
      market: report.market,
      gateStatus: report.gate.status as "READY_FINAL" | "READY_PROVISIONAL",
      analysisStage: report.gate.analysisStage as "FINAL" | "PROVISIONAL",
      blockers: [...report.gate.blockers],
      warnings: [...report.gate.warnings],
      evidenceSummary: {
        fresh: report.summary.fresh,
        stale: report.summary.stale,
        degraded: report.summary.degraded,
        missing: report.summary.missing,
        conflict: report.summary.conflict,
        unknown: report.summary.unknown,
        requiredFields: [...report.summary.requiredFields],
      },
      evidenceDigest,
      certifiedQuote,
    },
    quote: certifiedQuote,
    model: input.model,
    probabilities: {
      model: evaluation.modelProbability,
      marketImplied: evaluation.marketImplied,
      noVig: evaluation.noVig,
      edgePp: evaluation.edgePp,
    },
    decision: {
      signal: evaluation.signal,
      category: normalizeMlbP1M3cEvaluationCategory(evaluation.signal, evaluation.category),
      confidenceLabel: evaluation.confidenceLabel,
      confidencePct: evaluation.confidencePct,
      recommendedStakeUnits: ["BET", "BET_FUERTE"].includes(evaluation.signal)
        ? evaluation.recommendedStakeUnits
        : 0,
      rationale: evaluation.rationale,
      filterReasons: Array.from(new Set(evaluation.filterReasons)).slice(0, 100),
    },
    scientificSnapshot: {
      schemaVersion: "mlb-scientific-snapshot.v1" as const,
      payload: preparedSnapshot.payload as unknown as Record<string, unknown>,
      payloadDigest,
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT" as const,
      realFinancialExposure: 0 as const,
      automaticBetPlacement: false as const,
      automaticModelChangesAllowed: false as const,
      automaticPromotionAllowed: false as const,
    },
  };
}

function validCaptureResult(value: unknown): value is MlbP1M3bCaptureResult {
  const data = record(value);
  const safety = record(data?.safety);
  return data?.schemaVersion === MLB_P1_M3B_SCHEMA
    && data?.endpoint === MLB_P1_M3B_ENDPOINT
    && (data?.outcome === "APPENDED" || data?.outcome === "IDEMPOTENT")
    && typeof data?.predictionId === "string"
    && typeof data?.recordedAt === "string"
    && safety?.mode === "SHADOW_DECISION_SUPPORT"
    && safety?.realFinancialExposure === 0
    && safety?.automaticBetPlacement === false
    && safety?.automaticModelChangesAllowed === false
    && safety?.automaticPromotionAllowed === false;
}

export async function postMlbP1M3cScientificCapture(candidate: unknown): Promise<MlbP1M3bCaptureResult> {
  const { apiRequest } = await import("./queryClient");
  const response = await apiRequest("POST", MLB_P1_M3B_ENDPOINT, candidate);
  const envelope = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (envelope.success !== true || !validCaptureResult(envelope.data)) {
    throw new Error(envelope.error || "P1_M3C_INVALID_CAPTURE_RESPONSE");
  }
  return envelope.data;
}

export function toMlbP1M3cUiSuccess(
  result: MlbP1M3bCaptureResult,
  clientEvaluationId: string,
): MlbP1M3cUiState {
  return {
    status: result.outcome,
    clientEvaluationId,
    predictionId: result.predictionId,
    recordedAt: result.recordedAt,
    revisionDecision: result.revision.decision,
  };
}
