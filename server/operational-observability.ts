import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";

interface RouteMetric {
  requests: number;
  errors4xx: number;
  errors5xx: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

export interface OperationalMetricsSnapshot {
  schemaVersion: "courtedge-metrics.v1";
  startedAt: string;
  uptimeSeconds: number;
  requests: {
    total: number;
    success2xx: number;
    redirects3xx: number;
    clientErrors4xx: number;
    serverErrors5xx: number;
    averageLatencyMs: number;
    maxLatencyMs: number;
    active: number;
  };
  eventLoop: { meanLagMs: number; p95LagMs: number; maxLagMs: number };
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };
  routes: Array<{ route: string; requests: number; errors4xx: number; errors5xx: number; averageLatencyMs: number; maxLatencyMs: number }>;
  recentErrors: Array<{ at: string; method: string; route: string; status: number; message: string }>;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mb(bytes: number): number { return round(bytes / 1024 / 1024, 1); }

export function normalizeOperationalRoute(rawPath: string): string {
  const clean = rawPath.split("?")[0] || "/";
  return clean.split("/").map((segment) => {
    if (!segment) return segment;
    if (/^\d+$/.test(segment)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(segment)) return ":id";
    if (/^[A-Za-z0-9._:-]{32,}$/.test(segment)) return ":id";
    return segment.slice(0, 80);
  }).join("/");
}

export class OperationalObservabilityService {
  private readonly startedAtMs = Date.now();
  private readonly routes = new Map<string, RouteMetric>();
  private readonly errors: OperationalMetricsSnapshot["recentErrors"] = [];
  private total = 0;
  private success2xx = 0;
  private redirects3xx = 0;
  private errors4xx = 0;
  private errors5xx = 0;
  private totalLatencyMs = 0;
  private maxLatencyMs = 0;
  private active = 0;
  private readonly eventLoop: IntervalHistogram;

  constructor(private readonly maxRoutes = 100, private readonly maxErrors = 40) {
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoop.enable();
  }

  close(): void { this.eventLoop.disable(); }

  middleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
      const started = process.hrtime.bigint();
      this.active += 1;
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        this.active = Math.max(0, this.active - 1);
        const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        const routePath = typeof req.route?.path === "string"
          ? `${req.baseUrl || ""}${req.route.path}`
          : req.path;
        this.recordRequest(req.method, routePath, res.statusCode, durationMs);
      };
      res.once("finish", finish);
      res.once("close", finish);
      next();
    };
  }

  recordRequest(method: string, rawPath: string, status: number, durationMs: number): void {
    const route = `${method.toUpperCase()} ${normalizeOperationalRoute(rawPath)}`;
    this.total += 1;
    this.totalLatencyMs += durationMs;
    this.maxLatencyMs = Math.max(this.maxLatencyMs, durationMs);
    if (status >= 500) this.errors5xx += 1;
    else if (status >= 400) this.errors4xx += 1;
    else if (status >= 300) this.redirects3xx += 1;
    else if (status >= 200) this.success2xx += 1;

    let metric = this.routes.get(route);
    if (!metric) {
      if (this.routes.size >= this.maxRoutes) {
        const least = [...this.routes.entries()].sort((a, b) => a[1].requests - b[1].requests)[0];
        if (least) this.routes.delete(least[0]);
      }
      metric = { requests: 0, errors4xx: 0, errors5xx: 0, totalLatencyMs: 0, maxLatencyMs: 0 };
      this.routes.set(route, metric);
    }
    metric.requests += 1;
    metric.totalLatencyMs += durationMs;
    metric.maxLatencyMs = Math.max(metric.maxLatencyMs, durationMs);
    if (status >= 500) metric.errors5xx += 1;
    else if (status >= 400) metric.errors4xx += 1;
  }

  recordError(method: string, rawPath: string, status: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error || "Unknown error");
    this.errors.push({
      at: new Date().toISOString(),
      method: method.toUpperCase(),
      route: normalizeOperationalRoute(rawPath),
      status,
      message: message.slice(0, 300),
    });
    if (this.errors.length > this.maxErrors) this.errors.splice(0, this.errors.length - this.maxErrors);
  }

  snapshot(): OperationalMetricsSnapshot {
    const memory = process.memoryUsage();
    const nanosecondsToMs = (value: number): number => Number.isFinite(value) ? round(value / 1_000_000, 2) : 0;
    const routes = [...this.routes.entries()]
      .map(([route, metric]) => ({
        route,
        requests: metric.requests,
        errors4xx: metric.errors4xx,
        errors5xx: metric.errors5xx,
        averageLatencyMs: round(metric.totalLatencyMs / Math.max(1, metric.requests), 1),
        maxLatencyMs: round(metric.maxLatencyMs, 1),
      }))
      .sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route));
    return {
      schemaVersion: "courtedge-metrics.v1",
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeSeconds: round((Date.now() - this.startedAtMs) / 1000, 1),
      requests: {
        total: this.total,
        success2xx: this.success2xx,
        redirects3xx: this.redirects3xx,
        clientErrors4xx: this.errors4xx,
        serverErrors5xx: this.errors5xx,
        averageLatencyMs: round(this.totalLatencyMs / Math.max(1, this.total), 1),
        maxLatencyMs: round(this.maxLatencyMs, 1),
        active: this.active,
      },
      eventLoop: {
        meanLagMs: nanosecondsToMs(this.eventLoop.mean),
        p95LagMs: nanosecondsToMs(this.eventLoop.percentile(95)),
        maxLagMs: nanosecondsToMs(this.eventLoop.max),
      },
      memory: { rssMb: mb(memory.rss), heapUsedMb: mb(memory.heapUsed), heapTotalMb: mb(memory.heapTotal), externalMb: mb(memory.external) },
      routes,
      recentErrors: [...this.errors].reverse(),
    };
  }
}

let singleton: OperationalObservabilityService | null = null;
export function getOperationalObservabilityService(): OperationalObservabilityService {
  if (!singleton) singleton = new OperationalObservabilityService();
  return singleton;
}
