import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MlbLedgerStore } from "./mlb-ledger-store";
import {
  buildMlbShadowEvaluation,
  type MlbShadowEvaluation,
  type MlbShadowGateStatus,
} from "./mlb-shadow-evaluation";
import { terminalMlbLedgerRecords } from "./mlb-terminal-ledger-records";

export const MLB_S5D_GATE_MONITOR_VERSION = "mlb-s5d-gate-monitor.v1" as const;

export type MlbS5dGateTransition = {
  observedAt: string;
  fromStatus: MlbShadowGateStatus | null;
  toStatus: MlbShadowGateStatus;
  semanticDigest: string;
  settled: number;
  uniqueDecisions: number;
  reasons: string[];
  coverage: MlbShadowEvaluation["decisionGate"]["coverage"];
  humanReviewRequired: boolean;
  automaticPromotion: false;
};

export type MlbS5dReviewPackage = {
  schemaVersion: typeof MLB_S5D_GATE_MONITOR_VERSION;
  createdAt: string;
  semanticDigest: string;
  status: Exclude<MlbShadowGateStatus, "EXTEND">;
  humanReviewRequired: true;
  promotionAuthorized: false;
  nextAction: "HUMAN_GO_REVIEW" | "HUMAN_NO_GO_REVIEW";
  gate: MlbShadowEvaluation["decisionGate"];
  summary: MlbShadowEvaluation["summary"];
  breakdowns: MlbShadowEvaluation["breakdowns"];
  dataQuality: MlbShadowEvaluation["dataQuality"];
  deduplication: MlbShadowEvaluation["deduplication"];
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    sportsbookIntegration: false;
    productionWrites: false;
    automaticPromotion: false;
  };
};

export type MlbS5dGateMonitorEnvelope = {
  schemaVersion: typeof MLB_S5D_GATE_MONITOR_VERSION;
  evaluatedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  semanticDigest: string;
  changed: boolean;
  snapshotCreated: boolean;
  transitionRecorded: boolean;
  reviewPackageCreated: boolean;
  source: {
    ledgerSchemaVersion: string;
    predictions: number;
    terminalPredictions: number;
    supersededPredictions: number;
    settlementEvents: number;
    immutable: boolean;
  };
  gate: MlbShadowEvaluation["decisionGate"];
  progress: {
    settled: { current: number; minimum: number; remaining: number; progressPct: number; met: boolean };
    marketImpliedCoverage: { currentPct: number; minimumPct: number; gapPct: number; met: boolean };
    closingCoverage: { currentPct: number; minimumPct: number; gapPct: number; met: boolean };
    finalSnapshotCoverage: { currentPct: number; minimumPct: number; gapPct: number; met: boolean };
  };
  summary: MlbShadowEvaluation["summary"];
  dataQuality: MlbShadowEvaluation["dataQuality"];
  deduplication: MlbShadowEvaluation["deduplication"];
  humanReview: {
    required: boolean;
    status: MlbShadowGateStatus;
    automaticPromotion: false;
    packagePath: string | null;
  };
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    automaticPromotion: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type MlbS5dGateMonitorStatus = {
  schemaVersion: typeof MLB_S5D_GATE_MONITOR_VERSION;
  enabled: boolean;
  root: string;
  intervalMs: number;
  initialDelayMs: number;
  retentionDays: number;
  maxSnapshots: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  snapshots: number;
  reviewPackages: number;
  transitions: number;
  latest: MlbS5dGateMonitorEnvelope | null;
};

type MonitorOptions = {
  root?: string;
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  retentionDays?: number;
  maxSnapshots?: number;
  deploymentCommit?: string;
  environment?: string;
  now?: () => Date;
};

function positiveInteger(raw: unknown, fallback: number, minimum: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultRoot(): string {
  const configured = process.env.MLB_S5D_GATE_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s5d-gate-monitor");
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S5D_GATE_ENABLED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
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

function jsonFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function progressFor(evaluation: MlbShadowEvaluation): MlbS5dGateMonitorEnvelope["progress"] {
  const policy = evaluation.decisionGate.policy;
  const coverage = evaluation.decisionGate.coverage;
  const settled = evaluation.summary.settled;
  const coverageProgress = (currentPct: number, minimumPct: number) => ({
    currentPct,
    minimumPct,
    gapPct: round(Math.max(0, minimumPct - currentPct)),
    met: currentPct >= minimumPct,
  });
  return {
    settled: {
      current: settled,
      minimum: policy.minimumSettled,
      remaining: Math.max(0, policy.minimumSettled - settled),
      progressPct: round(Math.min(100, (settled / policy.minimumSettled) * 100)),
      met: settled >= policy.minimumSettled,
    },
    marketImpliedCoverage: coverageProgress(
      coverage.marketImpliedCoveragePct,
      policy.minimumMarketImpliedCoveragePct,
    ),
    closingCoverage: coverageProgress(
      coverage.closingCoveragePct,
      policy.minimumClosingCoveragePct,
    ),
    finalSnapshotCoverage: coverageProgress(
      coverage.finalSnapshotCoveragePct,
      policy.minimumFinalSnapshotCoveragePct,
    ),
  };
}

function semanticDigest(evaluation: MlbShadowEvaluation, progress: MlbS5dGateMonitorEnvelope["progress"]): string {
  const basis = {
    gate: evaluation.decisionGate,
    progress,
    summary: evaluation.summary,
    dataQuality: evaluation.dataQuality,
    deduplication: evaluation.deduplication,
    breakdowns: evaluation.breakdowns,
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

export class MlbS5dGateMonitorService {
  private readonly root: string;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly retentionDays: number;
  private readonly maxSnapshots: number;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    options: MonitorOptions = {},
  ) {
    this.root = options.root ?? defaultRoot();
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S5D_GATE_INTERVAL_MS, 30 * 60 * 1000, 5 * 60 * 1000);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S5D_GATE_INITIAL_DELAY_MS, 90_000, 10_000);
    this.retentionDays = options.retentionDays
      ?? positiveInteger(process.env.MLB_S5D_GATE_RETENTION_DAYS, 180, 1);
    this.maxSnapshots = options.maxSnapshots
      ?? positiveInteger(process.env.MLB_S5D_GATE_MAX_SNAPSHOTS, 1_000, 1);
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.now = options.now ?? (() => new Date());
    const latest = this.readLatest();
    this.lastSuccessAt = latest?.evaluatedAt ?? null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }

  getInitialDelayMs(): number {
    return this.initialDelayMs;
  }

  readLatest(): MlbS5dGateMonitorEnvelope | null {
    return readJson<MlbS5dGateMonitorEnvelope>(path.join(this.root, "latest.json"));
  }

  readTransitions(limit = 100): MlbS5dGateTransition[] {
    const safeLimit = Math.min(1_000, Math.max(1, Math.floor(limit)));
    return readJsonLines<MlbS5dGateTransition>(path.join(this.root, "transitions.jsonl"))
      .slice(-safeLimit)
      .reverse();
  }

  collect(trigger = "scheduled"): MlbS5dGateMonitorEnvelope {
    const evaluatedAt = this.now().toISOString();
    this.lastRunAt = evaluatedAt;
    try {
      const ledgerRecords = this.store.listRecords({ limit: 10_000 });
      const records = terminalMlbLedgerRecords(ledgerRecords);
      const evaluation = buildMlbShadowEvaluation(records);
      if (evaluation.execution.realFinancialExposure !== 0
        || evaluation.execution.sportsbookIntegration
        || evaluation.execution.automaticBetPlacement
        || evaluation.execution.productionWrites
        || evaluation.decisionGate.automaticPromotion
        || evaluation.decisionGate.formulasChanged
        || evaluation.decisionGate.thresholdsChanged
        || evaluation.decisionGate.stakePolicyChanged) {
        throw new Error("S5D scientific safety invariant violated");
      }

      const progress = progressFor(evaluation);
      const digest = semanticDigest(evaluation, progress);
      const previous = this.readLatest();
      const changed = previous?.semanticDigest !== digest;
      const transitionRecorded = previous?.gate.status !== evaluation.decisionGate.status;
      const status = this.store.status();
      const humanReviewRequired = evaluation.decisionGate.status !== "EXTEND";
      let packagePath: string | null = previous?.humanReview.packagePath ?? null;
      let reviewPackageCreated = false;

      if (humanReviewRequired && changed) {
        const reviewPackage: MlbS5dReviewPackage = {
          schemaVersion: MLB_S5D_GATE_MONITOR_VERSION,
          createdAt: evaluatedAt,
          semanticDigest: digest,
          status: evaluation.decisionGate.status as Exclude<MlbShadowGateStatus, "EXTEND">,
          humanReviewRequired: true,
          promotionAuthorized: false,
          nextAction: evaluation.decisionGate.status === "GO_REVIEW"
            ? "HUMAN_GO_REVIEW"
            : "HUMAN_NO_GO_REVIEW",
          gate: evaluation.decisionGate,
          summary: evaluation.summary,
          breakdowns: evaluation.breakdowns,
          dataQuality: evaluation.dataQuality,
          deduplication: evaluation.deduplication,
          safety: {
            mode: "SHADOW",
            realFinancialExposure: 0,
            automaticBetPlacement: false,
            sportsbookIntegration: false,
            productionWrites: false,
            automaticPromotion: false,
          },
        };
        const stamp = evaluatedAt.replace(/[:.]/g, "-");
        packagePath = path.join(
          this.root,
          "review-packages",
          `${stamp}-${evaluation.decisionGate.status.toLowerCase()}-${digest.slice(0, 12)}.json`,
        );
        atomicWriteJson(packagePath, reviewPackage);
        reviewPackageCreated = true;
      }

      const envelope: MlbS5dGateMonitorEnvelope = {
        schemaVersion: MLB_S5D_GATE_MONITOR_VERSION,
        evaluatedAt,
        trigger,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        semanticDigest: digest,
        changed,
        snapshotCreated: changed,
        transitionRecorded,
        reviewPackageCreated,
        source: {
          ledgerSchemaVersion: status.schemaVersion,
          predictions: status.predictions,
          terminalPredictions: records.length,
          supersededPredictions: Math.max(0, ledgerRecords.length - records.length),
          settlementEvents: status.settlementEvents,
          immutable: status.immutable,
        },
        gate: evaluation.decisionGate,
        progress,
        summary: evaluation.summary,
        dataQuality: evaluation.dataQuality,
        deduplication: evaluation.deduplication,
        humanReview: {
          required: humanReviewRequired,
          status: evaluation.decisionGate.status,
          automaticPromotion: false,
          packagePath,
        },
        safety: {
          mode: "SHADOW",
          realFinancialExposure: 0,
          sportsbookIntegration: false,
          automaticBetPlacement: false,
          productionWrites: false,
          automaticPromotion: false,
          formulasChanged: false,
          thresholdsChanged: false,
          stakePolicyChanged: false,
        },
      };

      if (changed) {
        const stamp = evaluatedAt.replace(/[:.]/g, "-");
        atomicWriteJson(
          path.join(this.root, "snapshots", `${stamp}-${digest.slice(0, 12)}.json`),
          envelope,
        );
      }
      if (transitionRecorded) {
        const transition: MlbS5dGateTransition = {
          observedAt: evaluatedAt,
          fromStatus: previous?.gate.status ?? null,
          toStatus: evaluation.decisionGate.status,
          semanticDigest: digest,
          settled: evaluation.summary.settled,
          uniqueDecisions: evaluation.deduplication.uniqueAnalyticalDecisions,
          reasons: evaluation.decisionGate.reasons,
          coverage: evaluation.decisionGate.coverage,
          humanReviewRequired,
          automaticPromotion: false,
        };
        appendJsonLine(path.join(this.root, "transitions.jsonl"), transition);
      }

      atomicWriteJson(path.join(this.root, "latest.json"), envelope);
      this.prune(evaluatedAt);
      this.lastSuccessAt = evaluatedAt;
      this.lastError = null;
      return envelope;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  status(): MlbS5dGateMonitorStatus {
    return {
      schemaVersion: MLB_S5D_GATE_MONITOR_VERSION,
      enabled: this.enabled,
      root: this.root,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      retentionDays: this.retentionDays,
      maxSnapshots: this.maxSnapshots,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      snapshots: jsonFiles(path.join(this.root, "snapshots")).length,
      reviewPackages: jsonFiles(path.join(this.root, "review-packages")).length,
      transitions: readJsonLines(path.join(this.root, "transitions.jsonl")).length,
      latest: this.readLatest(),
    };
  }

  private prune(referenceIso: string): void {
    const cutoff = Date.parse(referenceIso) - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const directory of ["snapshots", "review-packages"]) {
      jsonFiles(path.join(this.root, directory)).forEach((filePath, index) => {
        if (index >= this.maxSnapshots || fs.statSync(filePath).mtimeMs < cutoff) {
          fs.rmSync(filePath, { force: true });
        }
      });
    }
  }
}

export function startMlbS5dGateMonitorWorker(
  store: MlbLedgerStore,
  options: MonitorOptions = {},
): { service: MlbS5dGateMonitorService; timer: NodeJS.Timeout | null } {
  const service = new MlbS5dGateMonitorService(store, options);
  if (!service.isEnabled()) return { service, timer: null };

  const run = () => {
    try {
      service.collect("scheduled");
    } catch (error) {
      console.error("[s5d] scientific gate monitor failed", error);
    }
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
