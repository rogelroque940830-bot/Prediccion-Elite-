import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import type { MlbS5eCoverageService } from "./mlb-s5e-coverage-service";
import {
  buildMlbS6jFirstCycleCertification,
  type S6jFirstCycleReport,
} from "./mlb-s6j-first-cycle-certification";
import { MLB_S6I_CLEAN_COHORT_CUTOFF } from "./mlb-s6i-postfix-certification";
import type { OfficialMlbGame } from "./mlb-settlement-worker";

export const MLB_S6K_FIRST_TEN_VERSION = "mlb-s6k-first-ten-clean-cycles.v1" as const;
export const MLB_S6K_TARGET_COUNT = 10 as const;

const CUTOFF_MS = Date.parse(MLB_S6I_CLEAN_COHORT_CUTOFF);

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type S6kOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  now?: () => Date;
  fetcher?: FetchLike;
  deploymentCommit?: string;
  environment?: string;
};

export type S6kBatchState = "COLLECTING" | "READY_FOR_ANALYSIS" | "ACTION_REQUIRED";
export type S6kCycleStatus = "PASS" | "REVIEW" | "REJECT" | "WAITING";

export type S6kCycleSummary = {
  ordinal: number;
  rootPredictionId: string;
  terminalPredictionId: string | null;
  status: S6kCycleStatus;
  lifecycleState: S6jFirstCycleReport["state"];
  gamePk: number | null;
  gameDate: string | null;
  awayTeam: string | null;
  homeTeam: string | null;
  marketType: string | null;
  selection: string | null;
  line: number | null;
  chainLength: number;
  provisionalStages: number;
  finalStages: number;
  settled: boolean;
  result: string | null;
  officialVerified: boolean;
  comparableClosingCaptured: boolean;
  clvCaptured: boolean;
  criticalIssues: number;
  warningIssues: number;
  issueCodes: string[];
};

export type S6kBatchReport = {
  schemaVersion: typeof MLB_S6K_FIRST_TEN_VERSION;
  generatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  state: S6kBatchState;
  cohort: {
    cutoff: typeof MLB_S6I_CLEAN_COHORT_CUTOFF;
    targetCycles: typeof MLB_S6K_TARGET_COUNT;
  };
  summary: {
    selected: number;
    target: number;
    pass: number;
    review: number;
    reject: number;
    waiting: number;
    finalComplete: number;
    settled: number;
    officialVerified: number;
    closingCaptured: number;
    clvCaptured: number;
  };
  cycles: S6kCycleSummary[];
  persistence: {
    ledgerImmutable: true;
    previousOwnedLedgerRecords: number | null;
    currentOwnedLedgerRecords: number;
    countMonotonic: boolean;
    targetRegistryAppendOnly: true;
  };
  readyForAnalysis: boolean;
  evidence: S6jFirstCycleReport[];
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    historicalLedgerMutation: false;
    automaticPromotion: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type S6kStatus = {
  schemaVersion: typeof MLB_S6K_FIRST_TEN_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: S6kBatchReport | null;
};

type TargetRegistry = {
  schemaVersion: typeof MLB_S6K_FIRST_TEN_VERSION;
  createdAt: string;
  updatedAt: string;
  targetCount: typeof MLB_S6K_TARGET_COUNT;
  rootPredictionIds: string[];
};

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function sameOptionalNumber(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  return Math.abs(left - right) < 1e-9;
}

function isS5cRecord(record: LedgerRecord): boolean {
  return (record.prediction.payload as any)?.analysis?.layers?.s5c?.schemaVersion === "mlb-s5c-shadow-ingestion.v1";
}

function rootIdFor(record: LedgerRecord, byId: Map<string, LedgerRecord>): string {
  const visited = new Set<string>();
  let current = record;
  while (current.prediction.supersedesId && !visited.has(current.prediction.id)) {
    visited.add(current.prediction.id);
    const parent = byId.get(current.prediction.supersedesId);
    if (!parent) break;
    current = parent;
  }
  return current.prediction.id;
}

function groupS5cChains(records: LedgerRecord[]): Map<string, LedgerRecord[]> {
  const s5c = records.filter(isS5cRecord);
  const byId = new Map(s5c.map((record) => [record.prediction.id, record]));
  const groups = new Map<string, LedgerRecord[]>();
  for (const record of s5c) {
    const rootId = rootIdFor(record, byId);
    const values = groups.get(rootId) ?? [];
    values.push(record);
    groups.set(rootId, values);
  }
  for (const chain of groups.values()) {
    chain.sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs
      || left.prediction.id.localeCompare(right.prediction.id));
  }
  return groups;
}

function terminalFor(chain: LedgerRecord[]): LedgerRecord | null {
  if (!chain.length) return null;
  const parentIds = new Set(chain.map((record) => record.prediction.supersedesId).filter(Boolean));
  const terminals = chain
    .filter((record) => !parentIds.has(record.prediction.id))
    .sort((left, right) => left.prediction.recordedAtMs - right.prediction.recordedAtMs
      || left.prediction.id.localeCompare(right.prediction.id));
  return terminals.at(-1) ?? null;
}

function cycleIdentity(chain: LedgerRecord[]): string {
  const first = chain[0]?.prediction;
  if (!first) return "";
  return JSON.stringify({
    gamePk: first.game.gamePk ?? null,
    gameDate: first.game.gameDate,
    homeTeam: normalize(first.game.homeTeam),
    awayTeam: normalize(first.game.awayTeam),
    marketType: first.market.type,
    selection: normalize(first.market.selection),
    line: first.market.line ?? null,
  });
}

function eligibleChain(chain: LedgerRecord[]): boolean {
  return chain.length > 0
    && chain.every((record) => record.prediction.recordedAtMs >= CUTOFF_MS)
    && chain.some((record) => record.prediction.analysisStage === "PROVISIONAL");
}

function candidateOrder(left: [string, LedgerRecord[]], right: [string, LedgerRecord[]]): number {
  const leftStart = Date.parse(String(left[1][0]?.prediction.game.commenceTime ?? ""));
  const rightStart = Date.parse(String(right[1][0]?.prediction.game.commenceTime ?? ""));
  const startOrder = (Number.isFinite(leftStart) ? leftStart : Number.MAX_SAFE_INTEGER)
    - (Number.isFinite(rightStart) ? rightStart : Number.MAX_SAFE_INTEGER);
  if (startOrder !== 0) return startOrder;
  const recordedOrder = (left[1][0]?.prediction.recordedAtMs ?? 0)
    - (right[1][0]?.prediction.recordedAtMs ?? 0);
  if (recordedOrder !== 0) return recordedOrder;
  return left[0].localeCompare(right[0]);
}

export function selectFirstTenCleanCycleTargets(
  records: LedgerRecord[],
  existingRootPredictionIds: string[] = [],
  limit = MLB_S6K_TARGET_COUNT,
): string[] {
  const groups = groupS5cChains(records);
  const selected = [...new Set(existingRootPredictionIds.map(String).filter(Boolean))].slice(0, limit);
  const identities = new Set(selected
    .map((rootId) => groups.get(rootId))
    .filter((chain): chain is LedgerRecord[] => Boolean(chain?.length))
    .map(cycleIdentity));

  const candidates = [...groups.entries()]
    .filter(([, chain]) => eligibleChain(chain))
    .sort(candidateOrder);

  for (const [rootId, chain] of candidates) {
    if (selected.length >= limit) break;
    if (selected.includes(rootId)) continue;
    const identity = cycleIdentity(chain);
    if (identity && identities.has(identity)) continue;
    selected.push(rootId);
    if (identity) identities.add(identity);
  }
  return selected;
}

export function classifyS6kCycle(report: S6jFirstCycleReport): S6kCycleStatus {
  const critical = report.issues.some((entry) => entry.severity === "CRITICAL");
  if (report.state === "ACTION_REQUIRED" || critical) return "REJECT";
  if (report.state === "CERTIFIED") return "PASS";
  if (report.state === "WAITING_FOR_OFFICIAL_VERIFICATION" || report.state === "WAITING_FOR_CLOSING") {
    return "REVIEW";
  }
  return "WAITING";
}

export function buildMlbS6kFirstTenReport(
  reports: S6jFirstCycleReport[],
  options: {
    rootPredictionIds: string[];
    generatedAt?: string;
    trigger?: string;
    deploymentCommit?: string;
    environment?: string;
    previousOwnedLedgerRecords?: number | null;
    currentOwnedLedgerRecords: number;
  },
): S6kBatchReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const previousCount = options.previousOwnedLedgerRecords ?? null;
  const countMonotonic = previousCount == null || options.currentOwnedLedgerRecords >= previousCount;
  const cycles = reports.map((report, index): S6kCycleSummary => {
    const status = classifyS6kCycle(report);
    return {
      ordinal: index + 1,
      rootPredictionId: options.rootPredictionIds[index] ?? report.target.rootPredictionId ?? "missing",
      terminalPredictionId: report.target.terminalPredictionId,
      status,
      lifecycleState: report.state,
      gamePk: report.target.gamePk,
      gameDate: report.target.gameDate,
      awayTeam: report.target.awayTeam,
      homeTeam: report.target.homeTeam,
      marketType: report.target.marketType,
      selection: report.target.selection,
      line: report.target.line,
      chainLength: report.lifecycle.chainLength,
      provisionalStages: report.lifecycle.provisionalStages,
      finalStages: report.lifecycle.finalStages,
      settled: report.lifecycle.settled,
      result: report.lifecycle.settlementResult,
      officialVerified: report.officialVerification.gameFinal && report.lifecycle.officialGradeResult != null,
      comparableClosingCaptured: report.lifecycle.comparableClosingCaptured,
      clvCaptured: report.lifecycle.clvCaptured,
      criticalIssues: report.issues.filter((entry) => entry.severity === "CRITICAL").length,
      warningIssues: report.issues.filter((entry) => entry.severity === "WARNING").length,
      issueCodes: [...new Set(report.issues.map((entry) => entry.code))],
    };
  });

  const count = (status: S6kCycleStatus) => cycles.filter((cycle) => cycle.status === status).length;
  const summary = {
    selected: options.rootPredictionIds.length,
    target: MLB_S6K_TARGET_COUNT,
    pass: count("PASS"),
    review: count("REVIEW"),
    reject: count("REJECT"),
    waiting: count("WAITING"),
    finalComplete: cycles.filter((cycle) => cycle.finalStages > 0).length,
    settled: cycles.filter((cycle) => cycle.settled).length,
    officialVerified: cycles.filter((cycle) => cycle.officialVerified).length,
    closingCaptured: cycles.filter((cycle) => cycle.comparableClosingCaptured).length,
    clvCaptured: cycles.filter((cycle) => cycle.clvCaptured).length,
  };
  const readyForAnalysis = options.rootPredictionIds.length === MLB_S6K_TARGET_COUNT
    && summary.pass === MLB_S6K_TARGET_COUNT
    && countMonotonic;
  const state: S6kBatchState = !countMonotonic || summary.reject > 0
    ? "ACTION_REQUIRED"
    : readyForAnalysis
      ? "READY_FOR_ANALYSIS"
      : "COLLECTING";

  return {
    schemaVersion: MLB_S6K_FIRST_TEN_VERSION,
    generatedAt,
    trigger: options.trigger ?? "manual",
    deploymentCommit: options.deploymentCommit ?? "unknown",
    environment: options.environment ?? "unknown",
    state,
    cohort: {
      cutoff: MLB_S6I_CLEAN_COHORT_CUTOFF,
      targetCycles: MLB_S6K_TARGET_COUNT,
    },
    summary,
    cycles,
    persistence: {
      ledgerImmutable: true,
      previousOwnedLedgerRecords: previousCount,
      currentOwnedLedgerRecords: options.currentOwnedLedgerRecords,
      countMonotonic,
      targetRegistryAppendOnly: true,
    },
    readyForAnalysis,
    evidence: reports,
    safety: {
      mode: "SHADOW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      historicalLedgerMutation: false,
      automaticPromotion: false,
      formulasChanged: false,
      thresholdsChanged: false,
      stakePolicyChanged: false,
    },
  };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
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

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S6K_FIRST_TEN?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MLB_S6K_FIRST_TEN_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s6k-first-ten-cycles");
}

function parseOfficialGame(gamePk: number, payload: any): OfficialMlbGame | null {
  const status = payload?.gameData?.status;
  const final = status?.abstractGameState === "Final"
    || status?.codedGameState === "F"
    || status?.detailedState === "Final";
  if (!final) return null;
  const innings = (payload?.liveData?.linescore?.innings ?? [])
    .map((inning: any) => ({
      num: Number(inning?.num),
      home: Number(inning?.home?.runs ?? 0),
      away: Number(inning?.away?.runs ?? 0),
    }))
    .filter((inning: { num: number }) => Number.isFinite(inning.num));
  const homeScore = Number(
    payload?.liveData?.linescore?.teams?.home?.runs
      ?? innings.reduce((sum: number, inning: { home: number }) => sum + inning.home, 0),
  );
  const awayScore = Number(
    payload?.liveData?.linescore?.teams?.away?.runs
      ?? innings.reduce((sum: number, inning: { away: number }) => sum + inning.away, 0),
  );
  return {
    gamePk,
    gameDate: String(payload?.gameData?.datetime?.officialDate ?? "").slice(0, 10),
    final,
    homeTeam: String(payload?.gameData?.teams?.home?.name ?? "Home"),
    awayTeam: String(payload?.gameData?.teams?.away?.name ?? "Away"),
    homeScore,
    awayScore,
    innings,
  };
}

export class MlbS6kFirstTenCyclesCertificationService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly ownerUserId: number;
  private readonly root: string;
  private readonly now: () => Date;
  private readonly fetcher: FetchLike;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    private readonly s5eCoverage: MlbS5eCoverageService,
    options: S6kOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S6K_INTERVAL_MS, 5 * 60 * 1000, 60_000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S6K_INITIAL_DELAY_MS, 180_000, 10_000);
    this.ownerUserId = options.ownerUserId;
    this.root = options.root ?? defaultRoot();
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetcher ?? fetch;
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.lastSuccessAt = this.readLatest()?.generatedAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): S6kBatchReport | null {
    return readJson<S6kBatchReport>(path.join(this.root, "latest.json"));
  }
  readTargets(): TargetRegistry | null {
    const registry = readJson<TargetRegistry>(path.join(this.root, "targets.json"));
    return registry?.schemaVersion === MLB_S6K_FIRST_TEN_VERSION ? registry : null;
  }
  status(): S6kStatus {
    return {
      schemaVersion: MLB_S6K_FIRST_TEN_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
    };
  }

  private records(): LedgerRecord[] {
    return ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, { limit: 10_000 });
  }

  private ensureTargets(records: LedgerRecord[], now: Date): TargetRegistry {
    const existing = this.readTargets();
    const roots = selectFirstTenCleanCycleTargets(records, existing?.rootPredictionIds ?? []);
    const registry: TargetRegistry = {
      schemaVersion: MLB_S6K_FIRST_TEN_VERSION,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      targetCount: MLB_S6K_TARGET_COUNT,
      rootPredictionIds: roots,
    };
    if (!existing || JSON.stringify(existing.rootPredictionIds) !== JSON.stringify(roots)) {
      atomicWriteJson(path.join(this.root, "targets.json"), registry);
    }
    return existing && JSON.stringify(existing.rootPredictionIds) === JSON.stringify(roots)
      ? { ...existing, updatedAt: now.toISOString() }
      : registry;
  }

  private async officialGamesFor(records: LedgerRecord[], roots: string[]): Promise<Map<string, { game: OfficialMlbGame | null; error: string | null }>> {
    const groups = groupS5cChains(records);
    const gamePks = [...new Set(roots
      .map((rootId) => terminalFor(groups.get(rootId) ?? []))
      .filter((record): record is LedgerRecord => Boolean(record?.settlement && record.prediction.game.gamePk))
      .map((record) => Number(record.prediction.game.gamePk))
      .filter((gamePk) => Number.isInteger(gamePk) && gamePk > 0))];
    const byGamePk = new Map<number, { game: OfficialMlbGame | null; error: string | null }>();
    await Promise.all(gamePks.map(async (gamePk) => {
      try {
        const response = await this.fetcher(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`, {
          headers: { Accept: "application/json", "User-Agent": "CourtEdge-S6K/1.0" },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          byGamePk.set(gamePk, { game: null, error: `Official MLB feed returned HTTP ${response.status}.` });
          return;
        }
        byGamePk.set(gamePk, { game: parseOfficialGame(gamePk, await response.json()), error: null });
      } catch (error) {
        byGamePk.set(gamePk, { game: null, error: error instanceof Error ? error.message : String(error) });
      }
    }));

    const result = new Map<string, { game: OfficialMlbGame | null; error: string | null }>();
    for (const rootId of roots) {
      const terminal = terminalFor(groups.get(rootId) ?? []);
      const gamePk = terminal?.prediction.game.gamePk ?? null;
      result.set(rootId, gamePk ? byGamePk.get(gamePk) ?? { game: null, error: null } : { game: null, error: null });
    }
    return result;
  }

  async run(trigger = "scheduled"): Promise<S6kBatchReport> {
    const now = this.now();
    this.lastRunAt = now.toISOString();
    try {
      const previous = this.readLatest();
      const records = this.records();
      const registry = this.ensureTargets(records, now);
      const official = await this.officialGamesFor(records, registry.rootPredictionIds);
      const observations = this.s5eCoverage.readObservations();
      const reports = registry.rootPredictionIds.map((rootId) => {
        const evidence = official.get(rootId) ?? { game: null, error: null };
        return buildMlbS6jFirstCycleCertification(records, {
          targetRootId: rootId,
          observations,
          officialGame: evidence.game,
          officialFetchError: evidence.error,
          now,
          trigger: `s6k:${trigger}`,
          previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
          deploymentCommit: this.deploymentCommit,
          environment: this.environment,
        });
      });
      const report = buildMlbS6kFirstTenReport(reports, {
        rootPredictionIds: registry.rootPredictionIds,
        generatedAt: now.toISOString(),
        trigger,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        previousOwnedLedgerRecords: previous?.persistence.currentOwnedLedgerRecords ?? null,
        currentOwnedLedgerRecords: records.length,
      });
      atomicWriteJson(path.join(this.root, "latest.json"), report);
      const previousDigest = previous ? stableDigest({ ...previous, generatedAt: undefined, trigger: undefined }) : null;
      const currentDigest = stableDigest({ ...report, generatedAt: undefined, trigger: undefined });
      if (currentDigest !== previousDigest) {
        atomicWriteJson(
          path.join(this.root, "snapshots", `${report.generatedAt.replace(/[:.]/g, "-")}-${currentDigest.slice(0, 12)}.json`),
          report,
        );
      }
      this.lastSuccessAt = report.generatedAt;
      this.lastError = null;
      return report;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function startMlbS6kFirstTenCyclesCertificationWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  s5eCoverage: MlbS5eCoverageService,
  options: S6kOptions,
): { service: MlbS6kFirstTenCyclesCertificationService; timer: NodeJS.Timeout | null } {
  const service = new MlbS6kFirstTenCyclesCertificationService(store, ownershipStore, s5eCoverage, options);
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6k] first ten clean cycle certification failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
