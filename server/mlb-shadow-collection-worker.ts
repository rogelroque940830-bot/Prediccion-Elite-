import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MlbLedgerStore } from "./mlb-ledger-store";
import {
  buildMlbShadowEvaluation,
  type MlbShadowEvaluation,
} from "./mlb-shadow-evaluation";

export const MLB_SHADOW_COLLECTION_VERSION = "mlb-shadow-collection.v1" as const;

export type MlbShadowCollectionEnvelope = {
  schemaVersion: typeof MLB_SHADOW_COLLECTION_VERSION;
  collectedAt: string;
  trigger: string;
  deploymentCommit: string;
  environment: string;
  semanticDigest: string;
  changed: boolean;
  snapshotCreated: boolean;
  source: {
    ledgerSchemaVersion: string;
    predictions: number;
    settlementEvents: number;
    immutable: boolean;
  };
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
  evaluation: MlbShadowEvaluation;
};

export type MlbShadowCollectionStatus = {
  schemaVersion: typeof MLB_SHADOW_COLLECTION_VERSION;
  enabled: boolean;
  root: string;
  intervalMs: number;
  retentionDays: number;
  maxSnapshots: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastSemanticDigest: string | null;
  lastSnapshotPath: string | null;
  lastError: string | null;
  snapshots: number;
};

type CollectionOptions = {
  root?: string;
  enabled?: boolean;
  intervalMs?: number;
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
  const configured = process.env.MLB_SHADOW_COLLECTION_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-shadow-collection");
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_SHADOW_COLLECTION_ENABLED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function stableDigest(evaluation: MlbShadowEvaluation): string {
  const { generatedAt: _generatedAt, ...semantic } = evaluation;
  return crypto.createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
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

function snapshotFiles(root: string): string[] {
  const directory = path.join(root, "snapshots");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

export class MlbShadowCollectionService {
  private readonly root: string;
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly retentionDays: number;
  private readonly maxSnapshots: number;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastSemanticDigest: string | null = null;
  private lastSnapshotPath: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    options: CollectionOptions = {},
  ) {
    this.root = options.root ?? defaultRoot();
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_SHADOW_COLLECTION_INTERVAL_MS, 6 * 60 * 60 * 1000, 15 * 60 * 1000);
    this.retentionDays = options.retentionDays
      ?? positiveInteger(process.env.MLB_SHADOW_COLLECTION_RETENTION_DAYS, 90, 1);
    this.maxSnapshots = options.maxSnapshots
      ?? positiveInteger(process.env.MLB_SHADOW_COLLECTION_MAX_SNAPSHOTS, 500, 1);
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.now = options.now ?? (() => new Date());
    const latest = readJson<MlbShadowCollectionEnvelope>(path.join(this.root, "latest.json"));
    this.lastSuccessAt = latest?.collectedAt ?? null;
    this.lastSemanticDigest = latest?.semanticDigest ?? null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }

  readLatest(): MlbShadowCollectionEnvelope | null {
    return readJson<MlbShadowCollectionEnvelope>(path.join(this.root, "latest.json"));
  }

  collect(trigger = "scheduled"): MlbShadowCollectionEnvelope {
    const collectedAt = this.now().toISOString();
    this.lastRunAt = collectedAt;
    try {
      const records = this.store.listRecords({ limit: 10_000 });
      const evaluation = buildMlbShadowEvaluation(records);
      if (evaluation.execution.realFinancialExposure !== 0
        || evaluation.execution.sportsbookIntegration
        || evaluation.execution.automaticBetPlacement
        || evaluation.execution.productionWrites) {
        throw new Error("Shadow safety invariant violated");
      }

      const semanticDigest = stableDigest(evaluation);
      const previous = this.readLatest();
      const changed = previous?.semanticDigest !== semanticDigest;
      const status = this.store.status();
      const envelope: MlbShadowCollectionEnvelope = {
        schemaVersion: MLB_SHADOW_COLLECTION_VERSION,
        collectedAt,
        trigger,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        semanticDigest,
        changed,
        snapshotCreated: changed,
        source: {
          ledgerSchemaVersion: status.schemaVersion,
          predictions: status.predictions,
          settlementEvents: status.settlementEvents,
          immutable: status.immutable,
        },
        safety: {
          mode: "SHADOW",
          realFinancialExposure: 0,
          sportsbookIntegration: false,
          automaticBetPlacement: false,
          productionWrites: false,
          formulasChanged: false,
          thresholdsChanged: false,
          stakePolicyChanged: false,
        },
        evaluation,
      };

      if (changed) {
        const stamp = collectedAt.replace(/[:.]/g, "-");
        const snapshotPath = path.join(this.root, "snapshots", `${stamp}-${semanticDigest.slice(0, 12)}.json`);
        atomicWriteJson(snapshotPath, envelope);
        this.lastSnapshotPath = snapshotPath;
      }
      atomicWriteJson(path.join(this.root, "latest.json"), envelope);
      this.prune(collectedAt);
      this.lastSuccessAt = collectedAt;
      this.lastSemanticDigest = semanticDigest;
      this.lastError = null;
      return envelope;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  status(): MlbShadowCollectionStatus {
    return {
      schemaVersion: MLB_SHADOW_COLLECTION_VERSION,
      enabled: this.enabled,
      root: this.root,
      intervalMs: this.intervalMs,
      retentionDays: this.retentionDays,
      maxSnapshots: this.maxSnapshots,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastSemanticDigest: this.lastSemanticDigest,
      lastSnapshotPath: this.lastSnapshotPath,
      lastError: this.lastError,
      snapshots: snapshotFiles(this.root).length,
    };
  }

  private prune(referenceIso: string): void {
    const cutoff = Date.parse(referenceIso) - this.retentionDays * 24 * 60 * 60 * 1000;
    const files = snapshotFiles(this.root);
    files.forEach((filePath, index) => {
      if (index >= this.maxSnapshots || fs.statSync(filePath).mtimeMs < cutoff) {
        fs.rmSync(filePath, { force: true });
      }
    });
  }
}

export function startMlbShadowCollectionWorker(
  store: MlbLedgerStore,
  options: CollectionOptions = {},
): { service: MlbShadowCollectionService; timer: NodeJS.Timeout | null } {
  const service = new MlbShadowCollectionService(store, options);
  if (!service.isEnabled()) return { service, timer: null };

  const run = () => {
    try {
      service.collect("scheduled");
    } catch (error) {
      console.error("[s5b] recurring shadow collection failed", error);
    }
  };
  const initial = setTimeout(run, 45_000);
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
