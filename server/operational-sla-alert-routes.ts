import type { Express } from "express";
import { resolveRequestUserId, requireGlobalWorkerRole } from "./user-data-context";
import type { OperationalSlaAlertService } from "./operational-sla-alerts";

function boundedLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.min(1_000, Math.floor(parsed));
}

export function registerOperationalSlaAlertRoutes(
  app: Express,
  service: OperationalSlaAlertService,
): void {
  app.get("/api/ops/v1/sla-alerts", (req, res) => {
    const ownerUserId = resolveRequestUserId(req);
    const activeOnly = req.query.activeOnly === "true";
    const limit = boundedLimit(req.query.limit);
    const data = activeOnly
      ? service.active(ownerUserId).slice(0, limit)
      : service.list(ownerUserId, limit);
    res.json({
      success: true,
      data,
      status: service.status(ownerUserId),
      ownerUserId,
    });
  });

  app.get("/api/ops/v1/sla-status", (req, res) => {
    const ownerUserId = resolveRequestUserId(req);
    res.json({
      success: true,
      data: service.status(ownerUserId),
      ownerUserId,
    });
  });

  app.post(
    "/api/ops/v1/sla-alerts/evaluate",
    requireGlobalWorkerRole,
    async (req, res) => {
      const ownerUserId = resolveRequestUserId(req);
      try {
        const data = await service.evaluate(ownerUserId);
        res.json({ success: true, data, ownerUserId });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : "O2 SLA evaluation failed",
        });
      }
    },
  );
}
