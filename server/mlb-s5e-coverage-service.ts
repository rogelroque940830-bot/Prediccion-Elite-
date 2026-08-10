import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import type { MlbS5cShadowIngestionService } from "./mlb-s5c-shadow-ingestion";
import { terminalMlbLedgerRecords } from "./mlb-terminal-ledger-records";

export const MLB_S5E_COVERAGE_VERSION = "mlb-s5e-coverage.v1" as const;
export const MLB_S5E_CONSENSUS_CLOSING_VERSION = "mlb-s5e-consensus-closing.v1" as const;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ClosingClassification =
  | "COMPARABLE"
  | "SOURCE_SET_CHANGED"
  | "LINE_MOVED"
  | "NO_PRICE";

type S5eOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  selfBaseUrl?: string;
  deploymentCommit?: string;
  environment?: string;
  now?: () => Date;
  fetcher?: FetchLike;
};

export type S5eConsensusObservation = {
  schemaVersion: typeof MLB_S5E_CONSENSUS_CLOSING_VERSION;
  observationId: string;
  semanticDigest: string;
  predictionId: string;
  capturedAt: string;
  gamePk: number | null;
  gameDate: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selection: string;
  ticketLine: number | null;
  ticketOddsAmerican: number;
  openingSourceBooks: string[];
  closingSourceBooks: string[];
  closingOddsAmerican: number | null;
  closingLine: number | null;
  comparable: boolean;
  classification: ClosingClassification;
  source: "COURTEDGE_F5_CONSENSUS";
  safety: {
    syntheticOdds: false;
    realFinancialExposure: 0;
  };
};

export type S5eAudit = {
  schemaVersion: typeof MLB_S5E_COVERAGE_VERSION;
  ranAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  terminalPredictions: number;
  finalization: {
    finalCaptured: number;
    provisionalPendingLineups: number;
    finalMissedAfterStart: number;
    readyGamesDetected: number;
    triggerRuns: number;
  };
  closing: {
    comparableCoverage: number;
    comparableCoveragePct: number;
    nonComparableCaptured: number;
    pendingOutsideWindow: number;
    dueInsideWindow: number;
    missedAfterStart: number;
    observationsCreated: number;
    correctionsApplied: number;
  };
  settlement: {
    settled: number;
    pendingNatural: number;
    overdue: number;
  };
  diagnostics: {
    sourceSetChanged: number;
    lineMoved: number;
    noPrice: number;
    noOddsMatch: number;
    errors: string[];
  };
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    automaticPromotion: false;
    syntheticOdds: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type S5eStatus = {
  schemaVersion: typeof MLB_S5E_COVERAGE_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: S5eAudit | null;
  observationCount: number;
};

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S5E_COVERAGE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S5E_COVERAGE_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s5e-coverage");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function stableDigest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function americanOdds(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed !== 0 ? Math.round(parsed) : null;
}

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function sameTeam(left: unknown, right: unknown): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || (Math.min(a.length, b.length) >= 6 && (a.endsWith(b) || b.endsWith(a)))));
}

function sourceBooks(value: unknown): string[] {
  return [...new Set(String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))]
    .sort();
}

function sameSourceSet(left: string[], right: string[]): boolean {
  return left.length >= 2
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameLine(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  return Math.abs(left - right) < 1e-9;
}

function totalDirection(selection: string): "OVER" | "UNDER" | null {
  const text = selection.toLowerCase();
  if (text.includes("over") || text.includes("más") || text.includes("mas")) return "OVER";
  if (text.includes("under") || text.includes("menos")) return "UNDER";
  return null;
}

async function fetchJson(fetcher: FetchLike, url: string): Promise<any> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON content`);
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${payload?.error || payload?.message || "request failed"}`);
  return payload;
}

function matchOddsGame(games: any[], record: LedgerRecord): any | null {
  const expected = record.prediction.game.commenceTime
    ? Date.parse(record.prediction.game.commenceTime)
    : NaN;
  const candidates = games.filter((game) => {
    const ordered = sameTeam(game?.homeTeam, record.prediction.game.homeTeam)
      && sameTeam(game?.awayTeam, record.prediction.game.awayTeam);
    if (!ordered) return false;
    if (!Number.isFinite(expected)) return true;
    const actual = Date.parse(String(game?.commence ?? ""));
    return Number.isFinite(actual) && Math.abs(actual - expected) <= 90 * 60 * 1000;
  });
  if (!candidates.length) return null;
  return candidates.sort((left, right) => {
    const leftStart = Date.parse(String(left?.commence ?? ""));
    const rightStart = Date.parse(String(right?.commence ?? ""));
    return Math.abs(leftStart - expected) - Math.abs(rightStart - expected);
  })[0] ?? null;
}

function quoteFor(record: LedgerRecord, odds: any, capturedAt: string): S5eConsensusObservation {
  const prediction = record.prediction;
  const openingSourceBooks = sourceBooks(prediction.market.book);
  const closingSourceBooks = sourceBooks(odds?.source);
  let closingOddsAmerican: number | null = null;
  let closingLine: number | null = null;

  if (prediction.market.type === "F5_ML") {
    if (sameTeam(prediction.market.selection, prediction.game.homeTeam)) {
      closingOddsAmerican = americanOdds(odds?.f5Ml?.home);
    } else if (sameTeam(prediction.market.selection, prediction.game.awayTeam)) {
      closingOddsAmerican = americanOdds(odds?.f5Ml?.away);
    }
  } else if (prediction.market.type === "F5_TOTAL") {
    const direction = totalDirection(prediction.market.selection);
    closingLine = finite(odds?.f5Total?.line);
    if (direction === "OVER") closingOddsAmerican = americanOdds(odds?.f5Total?.overOdds);
    if (direction === "UNDER") closingOddsAmerican = americanOdds(odds?.f5Total?.underOdds);
  }

  let classification: ClosingClassification = "COMPARABLE";
  if (closingOddsAmerican == null) classification = "NO_PRICE";
  else if (!sameSourceSet(openingSourceBooks, closingSourceBooks)) classification = "SOURCE_SET_CHANGED";
  else if (prediction.market.type === "F5_TOTAL" && !sameLine(prediction.market.line, closingLine)) classification = "LINE_MOVED";
  const comparable = classification === "COMPARABLE";
  const semantic = {
    predictionId: prediction.id,
    capturedAt,
    openingSourceBooks,
    closingSourceBooks,
    closingOddsAmerican,
    closingLine,
    classification,
  };
  const semanticDigest = stableDigest(semantic);
  return {
    schemaVersion: MLB_S5E_CONSENSUS_CLOSING_VERSION,
    observationId: `s5e-close-${semanticDigest.slice(0, 32)}`,
    semanticDigest,
    predictionId: prediction.id,
    capturedAt,
    gamePk: prediction.game.gamePk ?? null,
    gameDate: prediction.game.gameDate,
    commenceTime: String(prediction.game.commenceTime),
    homeTeam: prediction.game.homeTeam,
    awayTeam: prediction.game.awayTeam,
    marketType: prediction.market.type,
    selection: prediction.market.selection,
    ticketLine: prediction.market.line ?? null,
    ticketOddsAmerican: prediction.market.oddsAmerican,
    openingSourceBooks,
    closingSourceBooks,
    closingOddsAmerican,
    closingLine,
    comparable,
    classification,
    source: "COURTEDGE_F5_CONSENSUS",
    safety: { syntheticOdds: false, realFinancialExposure: 0 },
  };
}

function lineupCounts(feed: any): { home: number; away: number } {
  const home = feed?.liveData?.boxscore?.teams?.home?.battingOrder;
  const away = feed?.liveData?.boxscore?.teams?.away?.battingOrder;
  return {
    home: Array.isArray(home) ? home.length : 0,
    away: Array.isArray(away) ? away.length : 0,
  };
}

export class MlbS5eCoverageService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly ownerUserId: number;
  private readonly root: string;
  private readonly selfBaseUrl: string;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private readonly fetcher: FetchLike;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    private readonly s5c: MlbS5cShadowIngestionService,
    options: S5eOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S5E_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S5E_INITIAL_DELAY_MS, 120_000, 10_000);
    this.ownerUserId = options.ownerUserId;
    this.root = options.root ?? defaultRoot();
    this.selfBaseUrl = (options.selfBaseUrl ?? `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetcher ?? fetch;
    this.lastSuccessAt = this.readLatest()?.ranAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): S5eAudit | null { return readJson<S5eAudit>(path.join(this.root, "latest.json")); }

  private observationRoot(predictionId: string): string {
    return path.join(this.root, "observations", safeId(predictionId));
  }

  readObservations(predictionId?: string): S5eConsensusObservation[] {
    const roots = predictionId
      ? [this.observationRoot(predictionId)]
      : (() => {
          const parent = path.join(this.root, "observations");
          try {
            return fs.readdirSync(parent, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => path.join(parent, entry.name));
          } catch {
            return [];
          }
        })();
    const observations: S5eConsensusObservation[] = [];
    for (const root of roots) {
      try {
        for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".json"))) {
          const parsed = readJson<S5eConsensusObservation>(path.join(root, file));
          if (parsed?.schemaVersion === MLB_S5E_CONSENSUS_CLOSING_VERSION) observations.push(parsed);
        }
      } catch {
        // Missing observation directory is a normal empty state.
      }
    }
    return observations.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }

  private latestObservation(predictionId: string): S5eConsensusObservation | null {
    const values = this.readObservations(predictionId);
    return values[values.length - 1] ?? null;
  }

  private persistObservation(observation: S5eConsensusObservation): boolean {
    const existing = this.readObservations(observation.predictionId)
      .some((item) => item.semanticDigest === observation.semanticDigest);
    if (existing) return false;
    const stamp = observation.capturedAt.replace(/[:.]/g, "-");
    const file = path.join(this.observationRoot(observation.predictionId), `${stamp}-${observation.semanticDigest.slice(0, 12)}.json`);
    atomicWriteJson(file, observation);
    return true;
  }

  status(): S5eStatus {
    return {
      schemaVersion: MLB_S5E_COVERAGE_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
      observationCount: this.readObservations().length,
    };
  }

  private ownedTerminalRecords(): LedgerRecord[] {
    return terminalMlbLedgerRecords(ownedRecordsForUser(
      this.store,
      this.ownershipStore,
      this.ownerUserId,
      { limit: 10_000 },
    ));
  }

  private async triggerReadyFinalizations(records: LedgerRecord[], nowMs: number, errors: string[]): Promise<{ ready: number; triggered: number }> {
    const gameIds = [...new Set(records
      .filter((record) => record.prediction.analysisStage === "PROVISIONAL")
      .filter((record) => {
        const start = Date.parse(String(record.prediction.game.commenceTime ?? ""));
        return Number.isFinite(start) && start > nowMs && start - nowMs <= 4 * 60 * 60 * 1000;
      })
      .map((record) => record.prediction.game.gamePk)
      .filter((value): value is number => Number.isInteger(value) && value > 0))];
    let ready = 0;
    for (const gamePk of gameIds) {
      try {
        const feed = await fetchJson(this.fetcher, `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
        const counts = lineupCounts(feed);
        if (counts.home >= 9 && counts.away >= 9) ready += 1;
      } catch (error) {
        errors.push(`finalization game ${gamePk}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!ready) return { ready, triggered: 0 };
    try {
      await this.s5c.run("s5e-finalization");
      return { ready, triggered: 1 };
    } catch (error) {
      errors.push(`S5C finalization trigger: ${error instanceof Error ? error.message : String(error)}`);
      return { ready, triggered: 1 };
    }
  }

  private async captureConsensusClosing(records: LedgerRecord[], now: Date, audit: S5eAudit): Promise<void> {
    const nowMs = now.getTime();
    const due = records.filter((record) => {
      if (record.prediction.market.type !== "F5_ML" && record.prediction.market.type !== "F5_TOTAL") return false;
      const start = Date.parse(String(record.prediction.game.commenceTime ?? ""));
      if (!Number.isFinite(start) || start <= nowMs || start - nowMs > 20 * 60 * 1000) return false;
      const latest = this.latestObservation(record.prediction.id);
      return !latest?.comparable;
    });
    const payloadByDate = new Map<string, any>();
    for (const record of due) {
      try {
        let payload = payloadByDate.get(record.prediction.game.gameDate);
        if (!payload) {
          payload = await fetchJson(this.fetcher, `${this.selfBaseUrl}/api/odds/mlb/f5?date=${encodeURIComponent(record.prediction.game.gameDate)}&background=cache-only`);
          payloadByDate.set(record.prediction.game.gameDate, payload);
        }
        const games = Array.isArray(payload?.games) ? payload.games : [];
        const matched = matchOddsGame(games, record);
        if (!matched) {
          audit.diagnostics.noOddsMatch += 1;
          continue;
        }
        const observation = quoteFor(record, matched, now.toISOString());
        if (this.persistObservation(observation)) audit.closing.observationsCreated += 1;
      } catch (error) {
        audit.diagnostics.errors.push(`closing ${record.prediction.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private applySettlementCorrections(records: LedgerRecord[], audit: S5eAudit): void {
    for (const record of records) {
      const settlement = record.settlement;
      if (!settlement || settlement.clvPp != null) continue;
      const observation = this.latestObservation(record.prediction.id);
      if (!observation?.comparable || observation.closingOddsAmerican == null) continue;
      try {
        const requestId = `s5e-close:${safeId(record.prediction.id).slice(0, 90)}:${observation.semanticDigest.slice(0, 24)}`;
        const result = this.store.appendSettlement(record.prediction.id, {
          clientRequestId: requestId,
          settledAt: settlement.settledAt,
          result: settlement.result,
          closingOddsAmerican: observation.closingOddsAmerican,
          ...(observation.closingLine != null ? { closingLine: observation.closingLine } : {}),
          ...(settlement.outcomeValue != null ? { outcomeValue: settlement.outcomeValue } : {}),
          ...(settlement.finalScore ? { finalScore: settlement.finalScore } : {}),
          profitUnitsOverride: settlement.profitUnits,
          source: "correction",
          correctionOfEventId: settlement.eventId,
          notes: `${String(settlement.notes ?? "Official settlement").slice(0, 1500)} · S5E comparable F5 consensus closing ${observation.closingOddsAmerican} from ${observation.closingSourceBooks.join(", ")}`,
        });
        if (!result.idempotent) audit.closing.correctionsApplied += 1;
      } catch (error) {
        audit.diagnostics.errors.push(`correction ${record.prediction.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private classify(records: LedgerRecord[], nowMs: number, audit: S5eAudit): void {
    audit.terminalPredictions = records.length;
    for (const record of records) {
      const start = Date.parse(String(record.prediction.game.commenceTime ?? ""));
      const started = Number.isFinite(start) && start <= nowMs;
      const minutesUntil = Number.isFinite(start) ? (start - nowMs) / 60_000 : Number.POSITIVE_INFINITY;

      if (record.prediction.analysisStage === "FINAL") audit.finalization.finalCaptured += 1;
      else if (!started) audit.finalization.provisionalPendingLineups += 1;
      else audit.finalization.finalMissedAfterStart += 1;

      if (record.settlement) audit.settlement.settled += 1;
      else if (!started || nowMs - start < 6 * 60 * 60 * 1000) audit.settlement.pendingNatural += 1;
      else audit.settlement.overdue += 1;

      const observation = this.latestObservation(record.prediction.id);
      if (record.settlement?.clvPp != null || observation?.comparable) {
        audit.closing.comparableCoverage += 1;
      } else if (observation) {
        audit.closing.nonComparableCaptured += 1;
        if (observation.classification === "SOURCE_SET_CHANGED") audit.diagnostics.sourceSetChanged += 1;
        if (observation.classification === "LINE_MOVED") audit.diagnostics.lineMoved += 1;
        if (observation.classification === "NO_PRICE") audit.diagnostics.noPrice += 1;
      } else if (!started && minutesUntil > 20) {
        audit.closing.pendingOutsideWindow += 1;
      } else if (!started) {
        audit.closing.dueInsideWindow += 1;
      } else {
        audit.closing.missedAfterStart += 1;
      }
    }
    audit.closing.comparableCoveragePct = records.length
      ? Math.round((audit.closing.comparableCoverage / records.length) * 10_000) / 100
      : 0;
  }

  async run(trigger = "scheduled"): Promise<S5eAudit> {
    const now = this.now();
    const ranAt = now.toISOString();
    this.lastRunAt = ranAt;
    const audit: S5eAudit = {
      schemaVersion: MLB_S5E_COVERAGE_VERSION,
      ranAt,
      trigger,
      deploymentCommit: this.deploymentCommit,
      environment: this.environment,
      terminalPredictions: 0,
      finalization: {
        finalCaptured: 0,
        provisionalPendingLineups: 0,
        finalMissedAfterStart: 0,
        readyGamesDetected: 0,
        triggerRuns: 0,
      },
      closing: {
        comparableCoverage: 0,
        comparableCoveragePct: 0,
        nonComparableCaptured: 0,
        pendingOutsideWindow: 0,
        dueInsideWindow: 0,
        missedAfterStart: 0,
        observationsCreated: 0,
        correctionsApplied: 0,
      },
      settlement: { settled: 0, pendingNatural: 0, overdue: 0 },
      diagnostics: { sourceSetChanged: 0, lineMoved: 0, noPrice: 0, noOddsMatch: 0, errors: [] },
      safety: {
        mode: "SHADOW",
        realFinancialExposure: 0,
        sportsbookIntegration: false,
        automaticBetPlacement: false,
        productionWrites: false,
        automaticPromotion: false,
        syntheticOdds: false,
        formulasChanged: false,
        thresholdsChanged: false,
        stakePolicyChanged: false,
      },
    };

    try {
      let records = this.ownedTerminalRecords();
      const finalization = await this.triggerReadyFinalizations(records, now.getTime(), audit.diagnostics.errors);
      audit.finalization.readyGamesDetected = finalization.ready;
      audit.finalization.triggerRuns = finalization.triggered;
      if (finalization.triggered) records = this.ownedTerminalRecords();
      await this.captureConsensusClosing(records, now, audit);
      this.applySettlementCorrections(records, audit);
      records = this.ownedTerminalRecords();
      this.classify(records, now.getTime(), audit);
      atomicWriteJson(path.join(this.root, "latest.json"), audit);
      this.lastSuccessAt = ranAt;
      this.lastError = null;
      return audit;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      audit.diagnostics.errors.push(this.lastError);
      atomicWriteJson(path.join(this.root, "latest.json"), audit);
      throw error;
    }
  }
}

export function startMlbS5eCoverageWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s5c: MlbS5cShadowIngestionService,
  options: S5eOptions,
): { service: MlbS5eCoverageService; timer: NodeJS.Timeout | null } {
  const service = new MlbS5eCoverageService(store, ownershipStore, s5c, options);
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s5e] coverage service failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
