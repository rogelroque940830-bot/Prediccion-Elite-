import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WnbaShadowRecord } from "./wnba-s6c-shadow-service";

export const WNBA_PREDICTOR_SHADOW_SCHEMA_VERSION = "wnba-predictor-shadow.v1" as const;
export const WNBA_PREDICTOR_SHADOW_REPORT_VERSION = "wnba-predictor-shadow-report.v1" as const;

type SourceKind = "MODERN_PICKS_V2" | "LEGACY_WNBA_PICKS";

export interface WnbaPredictorShadowSafety {
  mode: "PERSISTED_OUTPUT_SHADOW";
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
  retrospectiveSyntheticPredictions: false;
}

export interface WnbaPredictorShadowRecord {
  schemaVersion: typeof WNBA_PREDICTOR_SHADOW_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  chainKey: string;
  recordedAt: string;
  recordedAtMs: number;
  supersedesId: string | null;
  source: {
    primaryKind: SourceKind;
    primaryId: string;
    aliases: Array<{ kind: SourceKind; id: string }>;
    sourceObservedAt: string | null;
    sourceFingerprint: string;
  };
  game: {
    gameDate: string | null;
    homeTeam: string | null;
    awayTeam: string | null;
    selectedTeam: string | null;
    opponent: string | null;
  };
  predictor: {
    market: string | null;
    selection: string | null;
    confidence: number | null;
    modelProbability: number | null;
    modelProbabilitySourceField: string | null;
    edge: number | null;
    odds: string | number | null;
    line: string | number | null;
    status: string | null;
    accepted: boolean | null;
    filterReasons: string[];
    notes: string | null;
    sourcePayload: Record<string, unknown>;
  };
  marketBaseline: {
    linked: boolean;
    linkState: "LINKED" | "NO_MATCH" | "AMBIGUOUS" | "INSUFFICIENT_IDENTITY";
    s6cRecordId: string | null;
    s6cGameId: string | null;
    analysisStage: "PROVISIONAL" | "FINAL" | null;
    homeWinProbability: number | null;
    awayWinProbability: number | null;
    selectedWinProbability: number | null;
  };
  comparison: {
    edgeVsMarketPp: number | null;
  };
  missingEvidence: string[];
  safety: WnbaPredictorShadowSafety;
}

export interface WnbaPredictorShadowRunAudit {
  schemaVersion: "wnba-predictor-shadow-run.v1";
  ranAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  cutoverAt: string;
  sourceOutputsDiscovered: number;
  modernOutputs: number;
  legacyOutputs: number;
  preCutoverIgnored: number;
  newSourceOutputs: number;
  recordsCreated: number;
  idempotentOutputs: number;
  supersedingRecords: number;
  baselineLinked: number;
  baselineAmbiguous: number;
  explicitModelProbability: number;
  missingModelProbability: number;
  errors: string[];
  report: WnbaPredictorShadowReport;
  safety: WnbaPredictorShadowSafety;
}

export interface WnbaPredictorShadowReport {
  schemaVersion: typeof WNBA_PREDICTOR_SHADOW_REPORT_VERSION;
  generatedAt: string;
  records: number;
  terminalDecisions: number;
  supersededRecords: number;
  baselineLinkedTerminal: number;
  baselineLinkCoveragePct: number;
  explicitModelProbabilityTerminal: number;
  explicitModelProbabilityCoveragePct: number;
  acceptedStatusTerminal: number;
  acceptedStatusCoveragePct: number;
  comparableEdgeTerminal: number;
  averageEdgeVsMarketPp: number | null;
  missingEvidenceCounts: Record<string, number>;
  safety: WnbaPredictorShadowSafety;
}

export interface WnbaPredictorShadowStatus {
  schemaVersion: typeof WNBA_PREDICTOR_SHADOW_SCHEMA_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  cutoverAt: string | null;
  records: number;
  latest: WnbaPredictorShadowRunAudit | null;
  report: WnbaPredictorShadowReport;
}

interface ServiceOptions {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  root?: string;
  modernPicksPath?: string;
  legacyPicksPath?: string;
  s6cRecordsPath?: string;
  deploymentCommit?: string;
  environment?: string;
  now?: () => Date;
}

interface CursorState {
  schemaVersion: "wnba-predictor-shadow-cursor.v1";
  cutoverAt: string;
  seenSourceFingerprints: string[];
}

interface PersistedCandidate {
  sourceKind: SourceKind;
  sourceId: string;
  sourceFingerprint: string;
  sourceObservedAt: string | null;
  chainKey: string;
  gameDate: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  selectedTeam: string | null;
  opponent: string | null;
  market: string | null;
  selection: string | null;
  confidence: number | null;
  modelProbability: number | null;
  modelProbabilitySourceField: string | null;
  edge: number | null;
  odds: string | number | null;
  line: string | number | null;
  status: string | null;
  accepted: boolean | null;
  filterReasons: string[];
  notes: string | null;
  sourcePayload: Record<string, unknown>;
}

const SAFETY: WnbaPredictorShadowSafety = {
  mode: "PERSISTED_OUTPUT_SHADOW",
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
  retrospectiveSyntheticPredictions: false,
};

function positiveInteger(raw: unknown, fallback: number, minimum = 1): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

function defaultEnabled(): boolean {
  if (process.env.WNBA_S6D_PREDICTOR_SHADOW_ENABLED === "true") return true;
  if (process.env.WNBA_S6D_PREDICTOR_SHADOW_ENABLED === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
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

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeTeam(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameTeam(left: unknown, right: unknown): boolean {
  const a = normalizeTeam(left);
  const b = normalizeTeam(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function floridaDate(date: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseTimestamp(raw: Record<string, unknown>): string | null {
  for (const key of ["ts", "timestamp", "createdAt", "created_at", "savedAt", "recordedAt"]) {
    const value = raw[key];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number" || /^\d+$/.test(String(value))) {
      let milliseconds = Number(value);
      if (milliseconds > 0 && milliseconds < 10_000_000_000) milliseconds *= 1000;
      if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
    }
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function explicitProbability(raw: Record<string, unknown>): { value: number | null; field: string | null } {
  for (const key of ["modelProbability", "probability", "winProbability", "predictedProbability"]) {
    const value = numeric(raw[key]);
    if (value === null) continue;
    if (value >= 0 && value <= 1) return { value: round(value), field: key };
    if (value > 1 && value <= 100) return { value: round(value / 100), field: key };
  }
  return { value: null, field: null };
}

function explicitAccepted(raw: Record<string, unknown>): boolean | null {
  if (typeof raw.accepted === "boolean") return raw.accepted;
  const status = text(raw.status)?.toUpperCase();
  if (!status) return null;
  if (["ACCEPTED", "APPROVED", "ACTIVE", "BET", "PLAY"].includes(status)) return true;
  if (["BLOCKED", "PASS", "REJECTED", "SKIP"].includes(status)) return false;
  return null;
}

function stringArray(...values: unknown[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = text(item);
        if (normalized) result.add(normalized);
      }
    }
  }
  return [...result];
}

function gameDate(raw: Record<string, unknown>, observedAt: string | null): string | null {
  const direct = text(raw.date ?? raw.gameDate);
  if (direct && /^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  return observedAt ? floridaDate(new Date(observedAt)) : null;
}

function canonicalChainKey(candidate: Omit<PersistedCandidate, "chainKey">): string {
  const teams = [candidate.homeTeam, candidate.awayTeam, candidate.selectedTeam, candidate.opponent]
    .map(normalizeTeam)
    .filter(Boolean)
    .sort();
  if (candidate.gameDate && teams.length >= 2 && candidate.market && candidate.selection) {
    return sha256({
      date: candidate.gameDate,
      teams: [...new Set(teams)],
      market: candidate.market.toUpperCase(),
      selection: normalizeTeam(candidate.selection) || candidate.selection.toUpperCase(),
    });
  }
  return sha256({ sourceKind: candidate.sourceKind, sourceId: candidate.sourceId });
}

function normalizeCandidate(rawInput: unknown, sourceKind: SourceKind): PersistedCandidate | null {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const raw = JSON.parse(JSON.stringify(rawInput)) as Record<string, unknown>;
  if (sourceKind === "MODERN_PICKS_V2" && String(raw.sport ?? "").toLowerCase() !== "wnba") return null;
  const sourceObservedAt = parseTimestamp(raw);
  const probability = explicitProbability(raw);
  const homeTeam = text(raw.homeTeam ?? raw.home_team);
  const awayTeam = text(raw.awayTeam ?? raw.away_team);
  const selectedTeam = text(raw.team ?? raw.selectedTeam ?? raw.pickSide ?? raw.selection);
  const opponent = text(raw.opponent);
  const market = text(raw.pickType ?? raw.market)?.toUpperCase() ?? null;
  const selection = text(raw.pickSide ?? raw.pick ?? raw.selection ?? raw.team);
  const sourceId = text(raw.id ?? raw.pickId) ?? sha256(raw).slice(0, 24);
  const base: Omit<PersistedCandidate, "chainKey"> = {
    sourceKind,
    sourceId,
    sourceFingerprint: sha256({ sourceKind, raw }),
    sourceObservedAt,
    gameDate: gameDate(raw, sourceObservedAt),
    homeTeam,
    awayTeam,
    selectedTeam,
    opponent,
    market,
    selection,
    confidence: numeric(raw.confidence),
    modelProbability: probability.value,
    modelProbabilitySourceField: probability.field,
    edge: numeric(raw.edge),
    odds: typeof raw.odds === "string" || typeof raw.odds === "number" ? raw.odds : null,
    line: typeof raw.line === "string" || typeof raw.line === "number" ? raw.line : null,
    status: text(raw.status),
    accepted: explicitAccepted(raw),
    filterReasons: stringArray(raw.filterReasons, raw.blockedReasons, raw.reasons),
    notes: text(raw.notes),
    sourcePayload: raw,
  };
  return { ...base, chainKey: canonicalChainKey(base) };
}

function terminalS6cRecords(records: WnbaShadowRecord[]): WnbaShadowRecord[] {
  const superseded = new Set(records.map((record) => record.supersedesId).filter((id): id is string => Boolean(id)));
  return records.filter((record) => !superseded.has(record.id));
}

function matchCandidateToBaseline(candidate: PersistedCandidate, records: WnbaShadowRecord[]): {
  state: "LINKED" | "NO_MATCH" | "AMBIGUOUS" | "INSUFFICIENT_IDENTITY";
  record: WnbaShadowRecord | null;
} {
  if (!candidate.gameDate) return { state: "INSUFFICIENT_IDENTITY", record: null };
  const hasOrderedPair = Boolean(candidate.homeTeam && candidate.awayTeam);
  const hasUnorderedPair = Boolean(candidate.selectedTeam && candidate.opponent);
  if (!hasOrderedPair && !hasUnorderedPair) return { state: "INSUFFICIENT_IDENTITY", record: null };
  const matches = records.filter((record) => {
    if (record.game.gameDate !== candidate.gameDate) return false;
    if (hasOrderedPair) {
      return sameTeam(record.game.homeTeam, candidate.homeTeam) && sameTeam(record.game.awayTeam, candidate.awayTeam);
    }
    const pair = [candidate.selectedTeam, candidate.opponent];
    return pair.every((team) => sameTeam(team, record.game.homeTeam) || sameTeam(team, record.game.awayTeam));
  });
  if (matches.length === 1) return { state: "LINKED", record: matches[0] };
  if (matches.length > 1) return { state: "AMBIGUOUS", record: null };
  return { state: "NO_MATCH", record: null };
}

function selectedBaselineProbability(candidate: PersistedCandidate, record: WnbaShadowRecord): number | null {
  const selection = candidate.selectedTeam ?? candidate.selection;
  if (!selection) return null;
  const upper = String(selection).trim().toUpperCase();
  if (upper === "HOME" || sameTeam(selection, record.game.homeTeam)) return record.baseline.homeWinProbability;
  if (upper === "AWAY" || sameTeam(selection, record.game.awayTeam)) return record.baseline.awayWinProbability;
  return null;
}

function terminalPredictorRecords(records: WnbaPredictorShadowRecord[]): WnbaPredictorShadowRecord[] {
  const superseded = new Set(records.map((record) => record.supersedesId).filter((id): id is string => Boolean(id)));
  return records.filter((record) => !superseded.has(record.id));
}

export class WnbaPredictorShadowService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly root: string;
  private readonly modernPicksPath: string;
  private readonly legacyPicksPath: string;
  private readonly s6cRecordsPath: string;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: ServiceOptions = {}) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs ?? positiveInteger(process.env.WNBA_S6D_PREDICTOR_SHADOW_INTERVAL_MS, 60_000, 30_000);
    this.initialDelayMs = options.initialDelayMs ?? positiveInteger(process.env.WNBA_S6D_PREDICTOR_SHADOW_INITIAL_DELAY_MS, 300_000, 10_000);
    this.root = options.root ?? (process.env.WNBA_S6D_PREDICTOR_SHADOW_ROOT
      ? path.resolve(process.env.WNBA_S6D_PREDICTOR_SHADOW_ROOT)
      : path.join(process.cwd(), "data", "wnba-predictor-shadow-v1"));
    this.modernPicksPath = options.modernPicksPath ?? path.join(process.cwd(), "data", "picks.json");
    this.legacyPicksPath = options.legacyPicksPath ?? path.join(process.cwd(), "data", "picks-data.json");
    this.s6cRecordsPath = options.s6cRecordsPath ?? path.join(process.cwd(), "data", "wnba-shadow-v1", "records.jsonl");
    this.deploymentCommit = options.deploymentCommit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown";
    this.environment = options.environment ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown";
    this.now = options.now ?? (() => new Date());
    const latest = this.readLatest();
    this.lastSuccessAt = latest?.ranAt ?? null;
  }

  private recordsPath(): string { return path.join(this.root, "records.jsonl"); }
  private latestPath(): string { return path.join(this.root, "latest.json"); }
  private reportPath(): string { return path.join(this.root, "report.json"); }
  private cursorPath(): string { return path.join(this.root, "cursor.json"); }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readRecords(): WnbaPredictorShadowRecord[] { return readJsonLines<WnbaPredictorShadowRecord>(this.recordsPath()); }
  readLatest(): WnbaPredictorShadowRunAudit | null { return readJson<WnbaPredictorShadowRunAudit>(this.latestPath()); }
  readReport(): WnbaPredictorShadowReport { return readJson<WnbaPredictorShadowReport>(this.reportPath()) ?? this.buildReport(); }
  readCursor(): CursorState | null { return readJson<CursorState>(this.cursorPath()); }

  status(): WnbaPredictorShadowStatus {
    return {
      schemaVersion: WNBA_PREDICTOR_SHADOW_SCHEMA_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      cutoverAt: this.readCursor()?.cutoverAt ?? null,
      records: this.readRecords().length,
      latest: this.readLatest(),
      report: this.readReport(),
    };
  }

  private readCandidates(): PersistedCandidate[] {
    const modernRaw = readJson<unknown>(this.modernPicksPath);
    const legacyRaw = readJson<any>(this.legacyPicksPath);
    const modern = Array.isArray(modernRaw) ? modernRaw.flatMap((row) => {
      const candidate = normalizeCandidate(row, "MODERN_PICKS_V2");
      return candidate ? [candidate] : [];
    }) : [];
    const legacyRows = Array.isArray(legacyRaw?.wnbaPicks) ? legacyRaw.wnbaPicks : [];
    const legacy = legacyRows.flatMap((row: unknown) => {
      const candidate = normalizeCandidate(row, "LEGACY_WNBA_PICKS");
      return candidate ? [candidate] : [];
    });
    return [...modern, ...legacy];
  }

  private buildRecord(
    candidate: PersistedCandidate,
    aliases: PersistedCandidate[],
    baselineRecords: WnbaShadowRecord[],
    current: WnbaPredictorShadowRecord | null,
    recordedAt: string,
  ): WnbaPredictorShadowRecord {
    const baselineMatch = matchCandidateToBaseline(candidate, baselineRecords);
    const baseline = baselineMatch.record;
    const selectedProbability = baseline ? selectedBaselineProbability(candidate, baseline) : null;
    const edgeVsMarketPp = candidate.modelProbability !== null && selectedProbability !== null
      ? round((candidate.modelProbability - selectedProbability) * 100, 4)
      : null;
    const missingEvidence: string[] = [];
    if (!candidate.gameDate) missingEvidence.push("gameDate");
    if (!(candidate.homeTeam && candidate.awayTeam) && !(candidate.selectedTeam && candidate.opponent)) missingEvidence.push("teamPair");
    if (!candidate.selection) missingEvidence.push("selection");
    if (candidate.modelProbability === null) missingEvidence.push("modelProbability");
    if (candidate.accepted === null) missingEvidence.push("acceptedStatus");
    if (!baseline) missingEvidence.push("s6cBaseline");
    if (baseline && selectedProbability === null) missingEvidence.push("selectedMarketProbability");

    const normalizedEvidence = {
      chainKey: candidate.chainKey,
      gameDate: candidate.gameDate,
      homeTeam: candidate.homeTeam,
      awayTeam: candidate.awayTeam,
      selectedTeam: candidate.selectedTeam,
      opponent: candidate.opponent,
      market: candidate.market,
      selection: candidate.selection,
      confidence: candidate.confidence,
      modelProbability: candidate.modelProbability,
      modelProbabilitySourceField: candidate.modelProbabilitySourceField,
      edge: candidate.edge,
      odds: candidate.odds,
      line: candidate.line,
      status: candidate.status,
      accepted: candidate.accepted,
      filterReasons: candidate.filterReasons,
      notes: candidate.notes,
      s6cRecordId: baseline?.id ?? null,
      selectedProbability,
    };

    return {
      schemaVersion: WNBA_PREDICTOR_SHADOW_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      fingerprint: sha256(normalizedEvidence),
      chainKey: candidate.chainKey,
      recordedAt,
      recordedAtMs: Date.parse(recordedAt),
      supersedesId: current?.id ?? null,
      source: {
        primaryKind: candidate.sourceKind,
        primaryId: candidate.sourceId,
        aliases: aliases.map((alias) => ({ kind: alias.sourceKind, id: alias.sourceId })),
        sourceObservedAt: candidate.sourceObservedAt,
        sourceFingerprint: candidate.sourceFingerprint,
      },
      game: {
        gameDate: candidate.gameDate,
        homeTeam: candidate.homeTeam,
        awayTeam: candidate.awayTeam,
        selectedTeam: candidate.selectedTeam,
        opponent: candidate.opponent,
      },
      predictor: {
        market: candidate.market,
        selection: candidate.selection,
        confidence: candidate.confidence,
        modelProbability: candidate.modelProbability,
        modelProbabilitySourceField: candidate.modelProbabilitySourceField,
        edge: candidate.edge,
        odds: candidate.odds,
        line: candidate.line,
        status: candidate.status,
        accepted: candidate.accepted,
        filterReasons: candidate.filterReasons,
        notes: candidate.notes,
        sourcePayload: candidate.sourcePayload,
      },
      marketBaseline: {
        linked: Boolean(baseline),
        linkState: baselineMatch.state,
        s6cRecordId: baseline?.id ?? null,
        s6cGameId: baseline?.game.gameId ?? null,
        analysisStage: baseline?.analysisStage ?? null,
        homeWinProbability: baseline?.baseline.homeWinProbability ?? null,
        awayWinProbability: baseline?.baseline.awayWinProbability ?? null,
        selectedWinProbability: selectedProbability,
      },
      comparison: { edgeVsMarketPp },
      missingEvidence,
      safety: SAFETY,
    };
  }

  buildReport(): WnbaPredictorShadowReport {
    const records = this.readRecords();
    const terminal = terminalPredictorRecords(records);
    const linked = terminal.filter((record) => record.marketBaseline.linked).length;
    const explicit = terminal.filter((record) => record.predictor.modelProbability !== null).length;
    const accepted = terminal.filter((record) => record.predictor.accepted !== null).length;
    const comparable = terminal.filter((record) => record.comparison.edgeVsMarketPp !== null);
    const missingEvidenceCounts: Record<string, number> = {};
    for (const record of terminal) {
      for (const missing of record.missingEvidence) {
        missingEvidenceCounts[missing] = (missingEvidenceCounts[missing] ?? 0) + 1;
      }
    }
    return {
      schemaVersion: WNBA_PREDICTOR_SHADOW_REPORT_VERSION,
      generatedAt: this.now().toISOString(),
      records: records.length,
      terminalDecisions: terminal.length,
      supersededRecords: Math.max(0, records.length - terminal.length),
      baselineLinkedTerminal: linked,
      baselineLinkCoveragePct: terminal.length ? round((linked / terminal.length) * 100, 2) : 0,
      explicitModelProbabilityTerminal: explicit,
      explicitModelProbabilityCoveragePct: terminal.length ? round((explicit / terminal.length) * 100, 2) : 0,
      acceptedStatusTerminal: accepted,
      acceptedStatusCoveragePct: terminal.length ? round((accepted / terminal.length) * 100, 2) : 0,
      comparableEdgeTerminal: comparable.length,
      averageEdgeVsMarketPp: average(comparable.map((record) => record.comparison.edgeVsMarketPp as number)),
      missingEvidenceCounts,
      safety: SAFETY,
    };
  }

  async run(trigger = "scheduled"): Promise<WnbaPredictorShadowRunAudit> {
    const ranAt = this.now().toISOString();
    this.lastRunAt = ranAt;
    const errors: string[] = [];
    try {
      const candidates = this.readCandidates();
      const modernOutputs = candidates.filter((candidate) => candidate.sourceKind === "MODERN_PICKS_V2").length;
      const legacyOutputs = candidates.length - modernOutputs;
      let cursor = this.readCursor();
      let preCutoverIgnored = 0;
      let newCandidates: PersistedCandidate[] = [];

      if (!cursor) {
        cursor = {
          schemaVersion: "wnba-predictor-shadow-cursor.v1",
          cutoverAt: ranAt,
          seenSourceFingerprints: [...new Set(candidates.map((candidate) => candidate.sourceFingerprint))],
        };
        preCutoverIgnored = candidates.length;
      } else {
        const seen = new Set(cursor.seenSourceFingerprints);
        newCandidates = candidates.filter((candidate) => !seen.has(candidate.sourceFingerprint));
        for (const candidate of candidates) seen.add(candidate.sourceFingerprint);
        cursor = { ...cursor, seenSourceFingerprints: [...seen].slice(-20_000) };
      }

      atomicJson(this.cursorPath(), cursor);
      const grouped = new Map<string, PersistedCandidate[]>();
      for (const candidate of newCandidates) {
        const rows = grouped.get(candidate.chainKey) ?? [];
        rows.push(candidate);
        grouped.set(candidate.chainKey, rows);
      }

      const baselineRecords = terminalS6cRecords(readJsonLines<WnbaShadowRecord>(this.s6cRecordsPath));
      const existing = this.readRecords();
      const currentByChain = new Map(terminalPredictorRecords(existing).map((record) => [record.chainKey, record]));
      let recordsCreated = 0;
      let idempotentOutputs = 0;
      let supersedingRecords = 0;
      let baselineLinked = 0;
      let baselineAmbiguous = 0;
      let explicitModelProbability = 0;
      let missingModelProbability = 0;

      for (const [chainKey, aliases] of grouped.entries()) {
        const candidate = [...aliases].sort((left, right) => {
          const leftTime = left.sourceObservedAt ? Date.parse(left.sourceObservedAt) : 0;
          const rightTime = right.sourceObservedAt ? Date.parse(right.sourceObservedAt) : 0;
          if (leftTime !== rightTime) return rightTime - leftTime;
          return left.sourceKind === "MODERN_PICKS_V2" ? -1 : 1;
        })[0];
        const current = currentByChain.get(chainKey) ?? null;
        const record = this.buildRecord(candidate, aliases, baselineRecords, current, ranAt);
        if (current?.fingerprint === record.fingerprint) {
          idempotentOutputs += aliases.length;
          continue;
        }
        appendJsonLine(this.recordsPath(), record);
        currentByChain.set(chainKey, record);
        recordsCreated += 1;
        if (record.supersedesId) supersedingRecords += 1;
        if (record.marketBaseline.linked) baselineLinked += 1;
        if (record.marketBaseline.linkState === "AMBIGUOUS") baselineAmbiguous += 1;
        if (record.predictor.modelProbability !== null) explicitModelProbability += 1;
        else missingModelProbability += 1;
      }

      const report = this.buildReport();
      atomicJson(this.reportPath(), report);
      const audit: WnbaPredictorShadowRunAudit = {
        schemaVersion: "wnba-predictor-shadow-run.v1",
        ranAt,
        trigger,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        cutoverAt: cursor.cutoverAt,
        sourceOutputsDiscovered: candidates.length,
        modernOutputs,
        legacyOutputs,
        preCutoverIgnored,
        newSourceOutputs: newCandidates.length,
        recordsCreated,
        idempotentOutputs,
        supersedingRecords,
        baselineLinked,
        baselineAmbiguous,
        explicitModelProbability,
        missingModelProbability,
        errors,
        report,
        safety: SAFETY,
      };
      atomicJson(this.latestPath(), audit);
      this.lastSuccessAt = ranAt;
      this.lastError = null;
      return audit;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

let singleton: { service: WnbaPredictorShadowService; stop: () => void } | null = null;

export function startWnbaPredictorShadowWorker(options: ServiceOptions = {}): { service: WnbaPredictorShadowService; stop: () => void } {
  if (singleton) return singleton;
  const service = new WnbaPredictorShadowService(options);
  let interval: NodeJS.Timeout | null = null;
  let initial: NodeJS.Timeout | null = null;
  const execute = () => service.run("scheduled").catch((error) => {
    console.error("[s6d] WNBA predictor shadow cycle failed", error);
  });
  if (service.isEnabled()) {
    initial = setTimeout(() => {
      execute();
      interval = setInterval(execute, service.getIntervalMs());
      interval.unref();
    }, service.getInitialDelayMs());
    initial.unref();
  }
  singleton = {
    service,
    stop: () => {
      if (initial) clearTimeout(initial);
      if (interval) clearInterval(interval);
      singleton = null;
    },
  };
  return singleton;
}
