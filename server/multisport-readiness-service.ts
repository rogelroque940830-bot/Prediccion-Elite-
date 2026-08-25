import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MULTISPORT_READINESS_VERSION = "multisport-readiness.v1" as const;

export type ReadinessSport = "NBA" | "WNBA" | "NHL" | "NFL";
export type ReadinessProbeStatus = "HEALTHY" | "DEGRADED" | "EMPTY" | "FAILED";
export type ReadinessState = "READY" | "NO_GAMES" | "DEGRADED" | "BLOCKED";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ProbeKind = "SCHEDULE" | "CONTEXT" | "ODDS" | "SUPPORT" | "COMBINED";

type ProbeSpec = {
  key: string;
  sport: ReadinessSport;
  path: string;
  kind: ProbeKind;
  required: boolean;
};

export type ReadinessProbe = ProbeSpec & {
  checkedAt: string;
  httpStatus: number | null;
  status: ReadinessProbeStatus;
  itemCount: number | null;
  gameCount: number | null;
  source: string | null;
  code: string | null;
  error: string | null;
  latencyMs: number;
};

export type SportReadiness = {
  sport: ReadinessSport;
  state: ReadinessState;
  gamesScheduled: number;
  probes: ReadinessProbe[];
  requiredHealthy: number;
  requiredTotal: number;
  degradedSources: number;
  failedSources: number;
  reasons: string[];
};

export type MultisportReadinessAudit = {
  schemaVersion: typeof MULTISPORT_READINESS_VERSION;
  ranAt: string;
  trigger: string;
  auditDate: string;
  deploymentCommit: string;
  environment: string;
  semanticDigest: string;
  changed: boolean;
  snapshotCreated: boolean;
  sports: Record<ReadinessSport, SportReadiness>;
  summary: {
    ready: number;
    noGames: number;
    degraded: number;
    blocked: number;
    probes: number;
    healthyProbes: number;
    degradedProbes: number;
    emptyProbes: number;
    failedProbes: number;
  };
  safety: {
    mode: "READ_ONLY_AUDIT";
    predictionsCreated: 0;
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    automaticPromotion: false;
    formulasChanged: false;
    filtersChanged: false;
    marketsChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type MultisportReadinessStatus = {
  schemaVersion: typeof MULTISPORT_READINESS_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  snapshots: number;
  latest: MultisportReadinessAudit | null;
};

type ServiceOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  root?: string;
  selfBaseUrl?: string;
  deploymentCommit?: string;
  environment?: string;
  now?: () => Date;
  fetcher?: FetchLike;
};

const PROBES: ProbeSpec[] = [
  { key: "nba-schedule", sport: "NBA", path: "/api/nba/schedule", kind: "SCHEDULE", required: true },
  { key: "nba-context", sport: "NBA", path: "/api/nba/all", kind: "CONTEXT", required: true },
  { key: "nba-odds", sport: "NBA", path: "/api/odds/nba", kind: "ODDS", required: true },
  { key: "wnba-schedule", sport: "WNBA", path: "/api/wnba/games", kind: "SCHEDULE", required: true },
  { key: "wnba-context", sport: "WNBA", path: "/api/wnba/all", kind: "CONTEXT", required: true },
  { key: "wnba-injuries", sport: "WNBA", path: "/api/wnba/injuries", kind: "SUPPORT", required: false },
  { key: "wnba-fatigue", sport: "WNBA", path: "/api/wnba/fatigue", kind: "SUPPORT", required: false },
  { key: "wnba-sos", sport: "WNBA", path: "/api/wnba/sos", kind: "SUPPORT", required: false },
  { key: "wnba-players", sport: "WNBA", path: "/api/wnba/players", kind: "SUPPORT", required: false },
  { key: "wnba-odds", sport: "WNBA", path: "/api/odds/wnba", kind: "ODDS", required: true },
  { key: "nhl-context", sport: "NHL", path: "/api/nhl/all", kind: "COMBINED", required: true },
  { key: "nhl-odds", sport: "NHL", path: "/api/odds/nhl", kind: "ODDS", required: true },
  { key: "nfl-schedule", sport: "NFL", path: "/api/nfl/games", kind: "SCHEDULE", required: true },
  { key: "nfl-context", sport: "NFL", path: "/api/nfl/context", kind: "CONTEXT", required: true },
  { key: "nfl-elite-cards", sport: "NFL", path: "/api/nfl/elite/cards", kind: "SUPPORT", required: true },
];

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultEnabled(): boolean {
  const configured = process.env.MULTISPORT_READINESS_ENABLED?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  const configured = process.env.MULTISPORT_READINESS_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "multisport-readiness");
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function readJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")) as T; } catch { return null; }
}

function jsonCount(directory: string): number {
  try { return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length; } catch { return 0; }
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

function dated(pathname: string, date: string): string {
  return `${pathname}${pathname.includes("?") ? "&" : "?"}date=${encodeURIComponent(date)}`;
}

function firstArray(values: unknown[]): unknown[] | null {
  for (const value of values) if (Array.isArray(value)) return value;
  return null;
}

function countsFor(payload: any, kind: ProbeKind): { itemCount: number | null; gameCount: number | null } {
  const games = firstArray([
    payload?.games,
    payload?.data?.games,
    payload?.data?.schedule,
    payload?.data?.scoreboard?.games,
    payload?.data?.cards,
  ]);
  const items = firstArray([payload?.data, payload?.data?.teams, payload?.data?.players, payload?.data?.injuries, payload?.data?.items]);
  if (kind === "SCHEDULE" || kind === "ODDS") {
    const count = games?.length ?? items?.length ?? 0;
    return { itemCount: count, gameCount: count };
  }
  if (kind === "COMBINED") return { itemCount: items?.length ?? null, gameCount: games?.length ?? 0 };
  return { itemCount: items?.length ?? null, gameCount: games?.length ?? null };
}

function material(audit: MultisportReadinessAudit): unknown {
  return {
    schemaVersion: audit.schemaVersion,
    auditDate: audit.auditDate,
    sports: Object.fromEntries(Object.entries(audit.sports).map(([sport, value]) => [sport, {
      state: value.state,
      gamesScheduled: value.gamesScheduled,
      requiredHealthy: value.requiredHealthy,
      requiredTotal: value.requiredTotal,
      degradedSources: value.degradedSources,
      failedSources: value.failedSources,
      reasons: value.reasons,
      probes: value.probes.map((probe) => ({
        key: probe.key,
        status: probe.status,
        itemCount: probe.itemCount,
        gameCount: probe.gameCount,
        source: probe.source,
        code: probe.code,
        error: probe.error,
      })),
    }])),
    summary: audit.summary,
    safety: audit.safety,
  };
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class MultisportReadinessService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly root: string;
  private readonly selfBaseUrl: string;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private readonly fetcher: FetchLike;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: ServiceOptions = {}) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs ?? positiveInteger(process.env.MULTISPORT_READINESS_INTERVAL_MS, 21_600_000, 900_000);
    this.initialDelayMs = options.initialDelayMs ?? positiveInteger(process.env.MULTISPORT_READINESS_INITIAL_DELAY_MS, 180_000, 10_000);
    this.root = options.root ?? defaultRoot();
    this.selfBaseUrl = (options.selfBaseUrl ?? `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");
    this.deploymentCommit = options.deploymentCommit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown";
    this.environment = options.environment ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown";
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetcher ?? fetch;
    this.lastSuccessAt = this.readLatest()?.ranAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): MultisportReadinessAudit | null { return readJson(path.join(this.root, "latest.json")); }

  status(): MultisportReadinessStatus {
    return {
      schemaVersion: MULTISPORT_READINESS_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      snapshots: jsonCount(path.join(this.root, "snapshots")),
      latest: this.readLatest(),
    };
  }

  private async probe(spec: ProbeSpec, auditDate: string, checkedAt: string): Promise<ReadinessProbe> {
    const started = Date.now();
    let httpStatus: number | null = null;
    try {
      const withDate = spec.kind === "SCHEDULE" || spec.kind === "ODDS" || spec.kind === "COMBINED";
      const response = await this.fetcher(`${this.selfBaseUrl}${withDate ? dated(spec.path, auditDate) : spec.path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      httpStatus = response.status;
      const text = await response.text();
      let payload: any;
      try { payload = JSON.parse(text); } catch { throw new Error("non-JSON response"); }
      const counts = countsFor(payload, spec.kind);
      const source = String(payload?.source ?? payload?.data?.source ?? "").trim() || null;
      const code = String(payload?.code ?? payload?.error_code ?? "").trim() || null;
      if (!response.ok || payload?.success === false) {
        return { ...spec, checkedAt, httpStatus, status: "FAILED", ...counts, source, code,
          error: String(payload?.error ?? payload?.message ?? `HTTP ${response.status}`), latencyMs: Date.now() - started };
      }
      let status: ReadinessProbeStatus = "HEALTHY";
      if (String(source ?? "").toLowerCase().includes("fallback")) status = "DEGRADED";
      if ((spec.kind === "SCHEDULE" || spec.kind === "ODDS") && (counts.gameCount ?? 0) === 0) status = "EMPTY";
      if (spec.kind === "COMBINED" && (counts.gameCount ?? 0) === 0) status = "EMPTY";
      return { ...spec, checkedAt, httpStatus, status, ...counts, source, code, error: null, latencyMs: Date.now() - started };
    } catch (error) {
      return { ...spec, checkedAt, httpStatus, status: "FAILED", itemCount: null, gameCount: null,
        source: null, code: null, error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - started };
    }
  }

  private classify(sport: ReadinessSport, probes: ReadinessProbe[]): SportReadiness {
    const required = probes.filter((probe) => probe.required);
    const failed = probes.filter((probe) => probe.status === "FAILED");
    const degraded = probes.filter((probe) => probe.status === "DEGRADED");
    const schedule = probes.find((probe) => probe.kind === "SCHEDULE");
    const combined = probes.find((probe) => probe.kind === "COMBINED");
    const requiredOdds = required.find((probe) => probe.kind === "ODDS");
    const gamesScheduled = schedule?.gameCount ?? combined?.gameCount ?? 0;
    const coreFailures = required.filter((probe) =>
      probe.status === "FAILED"
      && probe.kind !== "ODDS"
      && !(sport === "NFL" && gamesScheduled === 0 && probe.key === "nfl-elite-cards"));
    const optionalFailures = failed.filter((probe) => !probe.required);
    const reasons: string[] = [];
    let state: ReadinessState;

    if (coreFailures.length) {
      state = "BLOCKED";
      coreFailures.forEach((probe) => reasons.push(`${probe.key}: ${probe.error ?? probe.code ?? "required source failed"}`));
    } else if (gamesScheduled === 0) {
      state = degraded.length ? "DEGRADED" : "NO_GAMES";
      reasons.push("No games scheduled for the audit date");
      degraded.forEach((probe) => reasons.push(`${probe.key}: fallback or degraded source`));
    } else if (requiredOdds?.status === "FAILED") {
      state = "BLOCKED";
      reasons.push(`${requiredOdds.key}: ${requiredOdds.error ?? requiredOdds.code ?? "required market source failed"}`);
    } else if (requiredOdds?.status === "EMPTY") {
      state = "DEGRADED";
      reasons.push("Games are scheduled but no market prices are currently available");
    } else if (degraded.length || optionalFailures.length) {
      state = "DEGRADED";
      degraded.forEach((probe) => reasons.push(`${probe.key}: fallback or degraded source`));
      optionalFailures.forEach((probe) => reasons.push(`${probe.key}: optional source failed`));
    } else {
      state = "READY";
      reasons.push(requiredOdds
        ? "Required context and market sources are available for the scheduled slate"
        : "Required model and context sources are available for the scheduled slate");
    }

    return {
      sport,
      state,
      gamesScheduled,
      probes,
      requiredHealthy: required.filter((probe) => probe.status !== "FAILED").length,
      requiredTotal: required.length,
      degradedSources: degraded.length,
      failedSources: failed.length,
      reasons: [...new Set(reasons)],
    };
  }

  async run(trigger = "scheduled"): Promise<MultisportReadinessAudit> {
    const now = this.now();
    const ranAt = now.toISOString();
    const auditDate = floridaDate(now);
    this.lastRunAt = ranAt;
    try {
      const probeResults = await Promise.all(PROBES.map((spec) => this.probe(spec, auditDate, ranAt)));
      const sports = {
        NBA: this.classify("NBA", probeResults.filter((probe) => probe.sport === "NBA")),
        WNBA: this.classify("WNBA", probeResults.filter((probe) => probe.sport === "WNBA")),
        NHL: this.classify("NHL", probeResults.filter((probe) => probe.sport === "NHL")),
        NFL: this.classify("NFL", probeResults.filter((probe) => probe.sport === "NFL")),
      } satisfies Record<ReadinessSport, SportReadiness>;
      const all = Object.values(sports).flatMap((entry) => entry.probes);
      const base = {
        schemaVersion: MULTISPORT_READINESS_VERSION,
        ranAt,
        trigger,
        auditDate,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        sports,
        summary: {
          ready: Object.values(sports).filter((entry) => entry.state === "READY").length,
          noGames: Object.values(sports).filter((entry) => entry.state === "NO_GAMES").length,
          degraded: Object.values(sports).filter((entry) => entry.state === "DEGRADED").length,
          blocked: Object.values(sports).filter((entry) => entry.state === "BLOCKED").length,
          probes: all.length,
          healthyProbes: all.filter((probe) => probe.status === "HEALTHY").length,
          degradedProbes: all.filter((probe) => probe.status === "DEGRADED").length,
          emptyProbes: all.filter((probe) => probe.status === "EMPTY").length,
          failedProbes: all.filter((probe) => probe.status === "FAILED").length,
        },
        safety: {
          mode: "READ_ONLY_AUDIT" as const,
          predictionsCreated: 0 as const,
          realFinancialExposure: 0 as const,
          sportsbookIntegration: false as const,
          automaticBetPlacement: false as const,
          productionWrites: false as const,
          automaticPromotion: false as const,
          formulasChanged: false as const,
          filtersChanged: false as const,
          marketsChanged: false as const,
          thresholdsChanged: false as const,
          stakePolicyChanged: false as const,
        },
      };
      const provisional = { ...base, semanticDigest: "", changed: false, snapshotCreated: false } as MultisportReadinessAudit;
      const semanticDigest = digest(material(provisional));
      const changed = this.readLatest()?.semanticDigest !== semanticDigest;
      const audit: MultisportReadinessAudit = { ...base, semanticDigest, changed, snapshotCreated: changed };
      atomicWriteJson(path.join(this.root, "latest.json"), audit);
      if (changed) {
        const stamp = ranAt.replace(/[:.]/g, "-");
        atomicWriteJson(path.join(this.root, "snapshots", `${stamp}-${semanticDigest.slice(0, 12)}.json`), audit);
      }
      this.lastSuccessAt = ranAt;
      this.lastError = null;
      return audit;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

export function startMultisportReadinessWorker(options: ServiceOptions = {}): {
  service: MultisportReadinessService;
  timer: NodeJS.Timeout | null;
} {
  const service = new MultisportReadinessService(options);
  if (!service.isEnabled()) return { service, timer: null };
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    service.run("scheduled")
      .catch((error) => console.error("[s6a] multisport readiness audit failed", error))
      .finally(() => { running = false; });
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
