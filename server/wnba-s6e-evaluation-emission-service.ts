import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const WNBA_EVALUATION_EMISSION_SCHEMA_VERSION = "wnba-evaluation-emission.v1" as const;
export const WNBA_EVALUATION_OUTPUT_SCHEMA_VERSION = "wnba-evaluation-output.v1" as const;

export type WnbaEvaluationMarket = "ML" | "SPREAD" | "TOTAL";

export interface WnbaEvaluationEmissionSafety {
  mode: "AUTOMATIC_EVALUATION_EMISSION";
  predictionsCreated: 0;
  recommendedStakeUnits: 0;
  realFinancialExposure: 0;
  sportsbookIntegration: false;
  automaticBetPlacement: false;
  productionWrites: false;
  automaticPromotion: false;
  predictorFormulasChanged: false;
  predictorFiltersChanged: false;
  predictorMarketsChanged: false;
  predictorProbabilitiesChanged: false;
  predictorThresholdsChanged: false;
  stakePolicyChanged: false;
  retrospectiveSyntheticEvaluations: false;
}

export interface WnbaEvaluationMarketOutput {
  market: WnbaEvaluationMarket;
  selection: string;
  selectedTeam: string | null;
  opponent: string | null;
  modelProbability: number;
  marketImpliedProbability: number;
  oddsAmerican: number;
  line: number | null;
  signal: "BET" | "LEAN" | "PASS";
  recommendation: "BET_FUERTE" | "BET" | "LEAN" | "PASS";
  accepted: boolean;
  confidencePct: number;
  edgePp: number;
  quality: {
    score: number;
    tier: string;
    shadowStakeUnits: number;
    warnings: string[];
    confirms: string[];
    reasoning: string;
  };
}

export interface WnbaEvaluationEnvelope {
  schemaVersion: typeof WNBA_EVALUATION_EMISSION_SCHEMA_VERSION;
  evaluationId: string;
  evaluatedAt: string;
  gameDate: string;
  homeTeam: string;
  awayTeam: string;
  gameId: string | null;
  source: "WNBA_PREDICTOR_UI";
  captureVersion: "s6e-ui.v1";
  model: {
    homeInput: Record<string, unknown>;
    awayInput: Record<string, unknown>;
    marketImpliedHomeProbability: number | null;
    homeProbability: number;
    awayProbability: number;
    estimatedTotal: number;
  };
  markets: WnbaEvaluationMarketOutput[];
  bestPlay: {
    market: WnbaEvaluationMarket | null;
    recommendation: string | null;
    signal: "BET" | "LEAN" | "PASS" | null;
    confidencePct: number | null;
    edgeLabel: string | null;
  };
  visibleMarket: {
    homeMoneyline: number;
    awayMoneyline: number;
    spreadLine: number;
    homeSpreadOdds: number;
    awaySpreadOdds: number;
    totalLine: number;
    overOdds: number;
    underOdds: number;
  };
  verification?: boolean;
}

export interface StoredWnbaEvaluation {
  schemaVersion: "wnba-evaluation-emission-record.v1";
  receivedAt: string;
  fingerprint: string;
  envelope: WnbaEvaluationEnvelope;
  safety: WnbaEvaluationEmissionSafety;
}

export interface WnbaEvaluationProjectedOutput {
  id: string;
  ts: number;
  sport: "wnba";
  date: string;
  homeTeam: string;
  awayTeam: string;
  team: string | null;
  opponent: string | null;
  pickType: string;
  pickSide: string;
  confidence: number;
  modelProbability: number;
  impliedProb: number;
  edge: number;
  odds: number;
  line: number | null;
  status: string;
  accepted: boolean;
  filterReasons: string[];
  notes: string;
  source: "s6e-direct-evaluation";
  evaluationId: string;
  market: string;
  pick: string;
  stake: 0;
  result: "SHADOW";
  outputSchemaVersion: typeof WNBA_EVALUATION_OUTPUT_SCHEMA_VERSION;
}

export interface WnbaEvaluationEmissionStatus {
  schemaVersion: typeof WNBA_EVALUATION_EMISSION_SCHEMA_VERSION;
  enabled: boolean;
  refreshIntervalMs: number;
  lastProjectionAt: string | null;
  lastCaptureAt: string | null;
  lastError: string | null;
  scientificEvaluations: number;
  verificationEvaluations: number;
  projectedOutputs: number;
  projectionRows: number;
  projectionPath: string;
  latestCapture: {
    evaluationId: string;
    receivedAt: string;
    idempotent: boolean;
    verification: boolean;
    outputsCreated: number;
  } | null;
  safety: WnbaEvaluationEmissionSafety;
}

interface ServiceOptions {
  enabled?: boolean;
  root?: string;
  canonicalPicksPath?: string;
  refreshIntervalMs?: number;
  environment?: string;
  deploymentCommit?: string;
  now?: () => Date;
}

export class WnbaEvaluationCaptureError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WnbaEvaluationCaptureError";
  }
}

const SAFETY: WnbaEvaluationEmissionSafety = {
  mode: "AUTOMATIC_EVALUATION_EMISSION",
  predictionsCreated: 0,
  recommendedStakeUnits: 0,
  realFinancialExposure: 0,
  sportsbookIntegration: false,
  automaticBetPlacement: false,
  productionWrites: false,
  automaticPromotion: false,
  predictorFormulasChanged: false,
  predictorFiltersChanged: false,
  predictorMarketsChanged: false,
  predictorProbabilitiesChanged: false,
  predictorThresholdsChanged: false,
  stakePolicyChanged: false,
  retrospectiveSyntheticEvaluations: false,
};

function defaultEnabled(): boolean {
  if (process.env.WNBA_S6E_EVALUATION_EMISSION_ENABLED === "true") return true;
  if (process.env.WNBA_S6E_EVALUATION_EMISSION_ENABLED === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function positiveInteger(raw: unknown, fallback: number, minimum: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function ensureDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function atomicJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function appendJsonLine(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line) as T]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WnbaEvaluationCaptureError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 240): string {
  if (typeof value !== "string") throw new WnbaEvaluationCaptureError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new WnbaEvaluationCaptureError(`${label} is invalid`);
  }
  return normalized;
}

function nullableText(value: unknown, label: string, maximum = 240): string | null {
  if (value == null || value === "") return null;
  return text(value, label, maximum);
}

function finite(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new WnbaEvaluationCaptureError(`${label} must be finite`);
  return parsed;
}

function probability(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0 || parsed > 1) throw new WnbaEvaluationCaptureError(`${label} must be between 0 and 1`);
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new WnbaEvaluationCaptureError(`${label} must be an array`);
  return value.slice(0, 50).map((entry, index) => text(entry, `${label}[${index}]`, 300));
}

function parseMarket(value: unknown): WnbaEvaluationMarket {
  const normalized = text(value, "market", 20).toUpperCase();
  if (normalized === "ML" || normalized === "SPREAD" || normalized === "TOTAL") return normalized;
  throw new WnbaEvaluationCaptureError(`unsupported market ${normalized}`);
}

function parseSignal(value: unknown): "BET" | "LEAN" | "PASS" {
  const normalized = text(value, "signal", 20).toUpperCase();
  if (normalized === "BET" || normalized === "LEAN" || normalized === "PASS") return normalized;
  throw new WnbaEvaluationCaptureError(`unsupported signal ${normalized}`);
}

function parseRecommendation(value: unknown): "BET_FUERTE" | "BET" | "LEAN" | "PASS" {
  const normalized = text(value, "recommendation", 30).toUpperCase();
  if (["BET_FUERTE", "BET", "LEAN", "PASS"].includes(normalized)) {
    return normalized as "BET_FUERTE" | "BET" | "LEAN" | "PASS";
  }
  throw new WnbaEvaluationCaptureError(`unsupported recommendation ${normalized}`);
}

function parseMarketOutput(value: unknown, index: number): WnbaEvaluationMarketOutput {
  const row = object(value, `markets[${index}]`);
  const quality = object(row.quality, `markets[${index}].quality`);
  const selectedTeam = nullableText(row.selectedTeam, `markets[${index}].selectedTeam`);
  const opponent = nullableText(row.opponent, `markets[${index}].opponent`);
  const recommendation = parseRecommendation(row.recommendation);
  const accepted = row.accepted;
  if (typeof accepted !== "boolean") throw new WnbaEvaluationCaptureError(`markets[${index}].accepted must be boolean`);
  if (accepted !== (recommendation !== "PASS")) {
    throw new WnbaEvaluationCaptureError(`markets[${index}] accepted conflicts with recommendation`);
  }
  return {
    market: parseMarket(row.market),
    selection: text(row.selection, `markets[${index}].selection`),
    selectedTeam,
    opponent,
    modelProbability: probability(row.modelProbability, `markets[${index}].modelProbability`),
    marketImpliedProbability: probability(row.marketImpliedProbability, `markets[${index}].marketImpliedProbability`),
    oddsAmerican: finite(row.oddsAmerican, `markets[${index}].oddsAmerican`),
    line: row.line == null ? null : finite(row.line, `markets[${index}].line`),
    signal: parseSignal(row.signal),
    recommendation,
    accepted,
    confidencePct: finite(row.confidencePct, `markets[${index}].confidencePct`),
    edgePp: finite(row.edgePp, `markets[${index}].edgePp`),
    quality: {
      score: finite(quality.score, `markets[${index}].quality.score`),
      tier: text(quality.tier, `markets[${index}].quality.tier`, 20),
      shadowStakeUnits: finite(quality.shadowStakeUnits, `markets[${index}].quality.shadowStakeUnits`),
      warnings: stringArray(quality.warnings ?? [], `markets[${index}].quality.warnings`),
      confirms: stringArray(quality.confirms ?? [], `markets[${index}].quality.confirms`),
      reasoning: text(quality.reasoning, `markets[${index}].quality.reasoning`, 1000),
    },
  };
}

export function parseWnbaEvaluationEnvelope(input: unknown): WnbaEvaluationEnvelope {
  const raw = object(input, "evaluation");
  if (raw.schemaVersion !== WNBA_EVALUATION_EMISSION_SCHEMA_VERSION) {
    throw new WnbaEvaluationCaptureError("unsupported evaluation schemaVersion");
  }
  if (raw.source !== "WNBA_PREDICTOR_UI" || raw.captureVersion !== "s6e-ui.v1") {
    throw new WnbaEvaluationCaptureError("unsupported evaluation source");
  }
  const evaluatedAt = text(raw.evaluatedAt, "evaluatedAt", 80);
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw new WnbaEvaluationCaptureError("evaluatedAt is invalid");
  const gameDate = text(raw.gameDate, "gameDate", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) throw new WnbaEvaluationCaptureError("gameDate is invalid");
  const model = object(raw.model, "model");
  const marketsRaw = raw.markets;
  if (!Array.isArray(marketsRaw) || marketsRaw.length !== 3) {
    throw new WnbaEvaluationCaptureError("exactly three market outputs are required");
  }
  const markets = marketsRaw.map(parseMarketOutput);
  const uniqueMarkets = new Set(markets.map((market) => market.market));
  if (uniqueMarkets.size !== 3 || !["ML", "SPREAD", "TOTAL"].every((market) => uniqueMarkets.has(market as WnbaEvaluationMarket))) {
    throw new WnbaEvaluationCaptureError("ML, SPREAD and TOTAL outputs are required once each");
  }
  const bestPlayRaw = object(raw.bestPlay, "bestPlay");
  const visible = object(raw.visibleMarket, "visibleMarket");
  const homeProbability = probability(model.homeProbability, "model.homeProbability");
  const awayProbability = probability(model.awayProbability, "model.awayProbability");
  if (Math.abs(homeProbability + awayProbability - 1) > 0.0001) {
    throw new WnbaEvaluationCaptureError("home and away probabilities must sum to one");
  }
  const bestMarket = bestPlayRaw.market == null ? null : parseMarket(bestPlayRaw.market);
  const bestSignal = bestPlayRaw.signal == null ? null : parseSignal(bestPlayRaw.signal);
  return {
    schemaVersion: WNBA_EVALUATION_EMISSION_SCHEMA_VERSION,
    evaluationId: text(raw.evaluationId, "evaluationId", 100),
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    gameDate,
    homeTeam: text(raw.homeTeam, "homeTeam"),
    awayTeam: text(raw.awayTeam, "awayTeam"),
    gameId: nullableText(raw.gameId, "gameId", 150),
    source: "WNBA_PREDICTOR_UI",
    captureVersion: "s6e-ui.v1",
    model: {
      homeInput: object(model.homeInput, "model.homeInput"),
      awayInput: object(model.awayInput, "model.awayInput"),
      marketImpliedHomeProbability: model.marketImpliedHomeProbability == null
        ? null
        : probability(model.marketImpliedHomeProbability, "model.marketImpliedHomeProbability"),
      homeProbability,
      awayProbability,
      estimatedTotal: finite(model.estimatedTotal, "model.estimatedTotal"),
    },
    markets,
    bestPlay: {
      market: bestMarket,
      recommendation: nullableText(bestPlayRaw.recommendation, "bestPlay.recommendation", 300),
      signal: bestSignal,
      confidencePct: bestPlayRaw.confidencePct == null ? null : finite(bestPlayRaw.confidencePct, "bestPlay.confidencePct"),
      edgeLabel: nullableText(bestPlayRaw.edgeLabel, "bestPlay.edgeLabel", 300),
    },
    visibleMarket: {
      homeMoneyline: finite(visible.homeMoneyline, "visibleMarket.homeMoneyline"),
      awayMoneyline: finite(visible.awayMoneyline, "visibleMarket.awayMoneyline"),
      spreadLine: finite(visible.spreadLine, "visibleMarket.spreadLine"),
      homeSpreadOdds: finite(visible.homeSpreadOdds, "visibleMarket.homeSpreadOdds"),
      awaySpreadOdds: finite(visible.awaySpreadOdds, "visibleMarket.awaySpreadOdds"),
      totalLine: finite(visible.totalLine, "visibleMarket.totalLine"),
      overOdds: finite(visible.overOdds, "visibleMarket.overOdds"),
      underOdds: finite(visible.underOdds, "visibleMarket.underOdds"),
    },
    verification: raw.verification === true,
  };
}

function projectedOutput(envelope: WnbaEvaluationEnvelope, market: WnbaEvaluationMarketOutput): WnbaEvaluationProjectedOutput {
  const pickType = market.market === "TOTAL" ? "O/U" : market.market === "SPREAD" ? "Spread" : "ML";
  return {
    id: `s6e-${envelope.evaluationId}-${market.market.toLowerCase()}`,
    ts: Date.parse(envelope.evaluatedAt),
    sport: "wnba",
    date: envelope.gameDate,
    homeTeam: envelope.homeTeam,
    awayTeam: envelope.awayTeam,
    team: market.selectedTeam,
    opponent: market.opponent,
    pickType,
    pickSide: market.selection,
    confidence: market.confidencePct,
    modelProbability: market.modelProbability,
    impliedProb: market.marketImpliedProbability * 100,
    edge: market.edgePp,
    odds: market.oddsAmerican,
    line: market.line,
    status: market.recommendation,
    accepted: market.accepted,
    filterReasons: market.quality.warnings,
    notes: `Automatic S6E shadow evaluation; signal=${market.signal}; tier=${market.quality.tier}; score=${market.quality.score}`,
    source: "s6e-direct-evaluation",
    evaluationId: envelope.evaluationId,
    market: pickType,
    pick: market.selection,
    stake: 0,
    result: "SHADOW",
    outputSchemaVersion: WNBA_EVALUATION_OUTPUT_SCHEMA_VERSION,
  };
}

export class WnbaEvaluationEmissionService {
  private readonly enabled: boolean;
  private readonly root: string;
  private readonly canonicalPicksPath: string;
  private readonly refreshIntervalMs: number;
  private readonly environment: string;
  private readonly deploymentCommit: string;
  private readonly now: () => Date;
  private lastProjectionAt: string | null = null;
  private lastCaptureAt: string | null = null;
  private lastError: string | null = null;
  private latestCapture: WnbaEvaluationEmissionStatus["latestCapture"] = null;

  constructor(options: ServiceOptions = {}) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.root = options.root ?? (process.env.WNBA_S6E_EVALUATION_EMISSION_ROOT
      ? path.resolve(process.env.WNBA_S6E_EVALUATION_EMISSION_ROOT)
      : path.join(process.cwd(), "data", "wnba-evaluation-emission-v1"));
    this.canonicalPicksPath = options.canonicalPicksPath ?? path.join(process.cwd(), "data", "picks.json");
    this.refreshIntervalMs = options.refreshIntervalMs
      ?? positiveInteger(process.env.WNBA_S6E_PROJECTION_REFRESH_INTERVAL_MS, 30_000, 10_000);
    this.environment = options.environment ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown";
    this.deploymentCommit = options.deploymentCommit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown";
    this.now = options.now ?? (() => new Date());
  }

  private evaluationsPath(): string { return path.join(this.root, "evaluations.jsonl"); }
  private verificationPath(): string { return path.join(this.root, "verification-evaluations.jsonl"); }
  private outputsPath(): string { return path.join(this.root, "outputs.jsonl"); }
  getProjectionPath(): string { return path.join(this.root, "s6d-source-projection.json"); }

  isEnabled(): boolean { return this.enabled; }
  getRefreshIntervalMs(): number { return this.refreshIntervalMs; }
  readEvaluations(): StoredWnbaEvaluation[] { return readJsonLines<StoredWnbaEvaluation>(this.evaluationsPath()); }
  readVerificationEvaluations(): StoredWnbaEvaluation[] { return readJsonLines<StoredWnbaEvaluation>(this.verificationPath()); }
  readOutputs(): WnbaEvaluationProjectedOutput[] { return readJsonLines<WnbaEvaluationProjectedOutput>(this.outputsPath()); }

  refreshProjection(): number {
    try {
      const canonical = readJson<unknown>(this.canonicalPicksPath);
      const canonicalWnba = Array.isArray(canonical)
        ? canonical.filter((row) => row && typeof row === "object" && String((row as Record<string, unknown>).sport ?? "").toLowerCase() === "wnba")
        : [];
      const directOutputs = this.readOutputs();
      const rows = [...canonicalWnba, ...directOutputs];
      atomicJson(this.getProjectionPath(), rows);
      this.lastProjectionAt = this.now().toISOString();
      this.lastError = null;
      return rows.length;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  initialize(): void {
    ensureDir(this.root);
    this.refreshProjection();
  }

  capture(input: unknown): { idempotent: boolean; verification: boolean; outputsCreated: number; evaluationId: string } {
    if (!this.enabled) throw new WnbaEvaluationCaptureError("S6E evaluation emission is disabled", 503);
    const envelope = parseWnbaEvaluationEnvelope(input);
    const receivedAt = this.now().toISOString();
    const fingerprint = sha256(envelope);
    const targetPath = envelope.verification ? this.verificationPath() : this.evaluationsPath();
    const existing = envelope.verification ? this.readVerificationEvaluations() : this.readEvaluations();
    const prior = existing.find((record) => record.envelope.evaluationId === envelope.evaluationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new WnbaEvaluationCaptureError("evaluationId is already bound to different immutable evidence", 409);
      }
      this.lastCaptureAt = receivedAt;
      this.latestCapture = {
        evaluationId: envelope.evaluationId,
        receivedAt,
        idempotent: true,
        verification: Boolean(envelope.verification),
        outputsCreated: 0,
      };
      return { idempotent: true, verification: Boolean(envelope.verification), outputsCreated: 0, evaluationId: envelope.evaluationId };
    }

    const stored: StoredWnbaEvaluation = {
      schemaVersion: "wnba-evaluation-emission-record.v1",
      receivedAt,
      fingerprint,
      envelope,
      safety: SAFETY,
    };
    appendJsonLine(targetPath, stored);
    let outputsCreated = 0;
    if (!envelope.verification) {
      for (const market of envelope.markets) {
        appendJsonLine(this.outputsPath(), projectedOutput(envelope, market));
        outputsCreated += 1;
      }
      this.refreshProjection();
    }
    this.lastCaptureAt = receivedAt;
    this.latestCapture = {
      evaluationId: envelope.evaluationId,
      receivedAt,
      idempotent: false,
      verification: Boolean(envelope.verification),
      outputsCreated,
    };
    this.lastError = null;
    return { idempotent: false, verification: Boolean(envelope.verification), outputsCreated, evaluationId: envelope.evaluationId };
  }

  status(): WnbaEvaluationEmissionStatus {
    const scientificEvaluations = this.readEvaluations().length;
    const verificationEvaluations = this.readVerificationEvaluations().length;
    const projectedOutputs = this.readOutputs().length;
    const projection = readJson<unknown>(this.getProjectionPath());
    return {
      schemaVersion: WNBA_EVALUATION_EMISSION_SCHEMA_VERSION,
      enabled: this.enabled,
      refreshIntervalMs: this.refreshIntervalMs,
      lastProjectionAt: this.lastProjectionAt,
      lastCaptureAt: this.lastCaptureAt,
      lastError: this.lastError,
      scientificEvaluations,
      verificationEvaluations,
      projectedOutputs,
      projectionRows: Array.isArray(projection) ? projection.length : 0,
      projectionPath: this.getProjectionPath(),
      latestCapture: this.latestCapture,
      safety: SAFETY,
    };
  }

  publicStatus(): Record<string, unknown> {
    const status = this.status();
    const healthy = !status.enabled || Boolean(status.lastProjectionAt && !status.lastError);
    return {
      status: healthy ? "healthy" : "starting",
      commit: this.deploymentCommit,
      environment: this.environment,
      schemaVersion: status.schemaVersion,
      enabled: status.enabled,
      refreshIntervalMs: status.refreshIntervalMs,
      lastProjectionAt: status.lastProjectionAt,
      lastCaptureAt: status.lastCaptureAt,
      lastError: status.lastError,
      scientificEvaluations: status.scientificEvaluations,
      verificationEvaluations: status.verificationEvaluations,
      projectedOutputs: status.projectedOutputs,
      projectionRows: status.projectionRows,
      latestCapture: status.latestCapture ? {
        receivedAt: status.latestCapture.receivedAt,
        idempotent: status.latestCapture.idempotent,
        verification: status.latestCapture.verification,
        outputsCreated: status.latestCapture.outputsCreated,
      } : null,
      safety: SAFETY,
    };
  }
}

let singleton: { service: WnbaEvaluationEmissionService; stop: () => void } | null = null;

export function startWnbaEvaluationEmissionWorker(options: ServiceOptions = {}): { service: WnbaEvaluationEmissionService; stop: () => void } {
  if (singleton) return singleton;
  const service = new WnbaEvaluationEmissionService(options);
  service.initialize();
  let interval: NodeJS.Timeout | null = null;
  if (service.isEnabled()) {
    interval = setInterval(() => {
      try { service.refreshProjection(); }
      catch (error) { console.error("[s6e] WNBA source projection refresh failed", error); }
    }, service.getRefreshIntervalMs());
    interval.unref();
  }
  singleton = {
    service,
    stop: () => {
      if (interval) clearInterval(interval);
      singleton = null;
    },
  };
  return singleton;
}
