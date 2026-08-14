import type { Express } from "express";
import { requireGlobalWorkerRole } from "./user-data-context";
import type { OperationalObservabilityService } from "./operational-observability";
import type { OperationalDiagnosticsService } from "./operational-diagnostics";
import type { OperationalAlertService } from "./operational-alerts";

export function registerOperationalObservabilityRoutes(
  app: Express,
  metrics: OperationalObservabilityService,
  diagnostics: OperationalDiagnosticsService,
  alerts: OperationalAlertService,
): void {
  app.get("/api/ops/v1/metrics", (_req, res) => {
    res.json({ success: true, data: metrics.snapshot() });
  });

  app.get("/api/ops/v1/diagnostics", (_req, res) => {
    const data = diagnostics.evaluate();
    res.status(data.status === "CRITICAL" ? 503 : 200).json({ success: data.status !== "CRITICAL", data });
  });

  app.get("/api/ops/v1/alerts", (req, res) => {
    const limit = Number(req.query.limit || 100);
    res.json({ success: true, data: alerts.list(Number.isFinite(limit) ? limit : 100), status: alerts.status() });
  });

  app.post("/api/ops/v1/alerts/evaluate", requireGlobalWorkerRole, async (_req, res) => {
    try {
      const data = await alerts.evaluate();
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || "Alert evaluation failed" });
    }
  });
}
