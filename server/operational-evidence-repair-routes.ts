import type { Express } from "express";
import {
  requireGlobalWorkerRole,
  requireOwnDataWriteRole,
  resolveRequestUserId,
} from "./user-data-context";
import type { OperationalEvidenceRepairService } from "./operational-evidence-repair";

function boundedLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 250;
  return Math.min(1_000, Math.floor(parsed));
}

function errorStatus(error: unknown): number {
  const value = Number((error as { status?: unknown })?.status);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "O3.1 evidence repair failed";
}

export function registerOperationalEvidenceRepairRoutes(
  app: Express,
  service: OperationalEvidenceRepairService,
): void {
  app.get("/api/ops/v1/evidence-repair/status", (req, res) => {
    const ownerUserId = resolveRequestUserId(req);
    res.json({ success: true, data: service.status(ownerUserId), ownerUserId });
  });

  app.get("/api/ops/v1/evidence-repair/audit", (req, res) => {
    const ownerUserId = resolveRequestUserId(req);
    res.json({
      success: true,
      data: service.audit(ownerUserId, boundedLimit(req.query.limit)),
      ownerUserId,
    });
  });

  app.get("/api/ops/v1/evidence-repair/inspections/:inspectionId", (req, res) => {
    const ownerUserId = resolveRequestUserId(req);
    try {
      res.json({
        success: true,
        data: service.getInspection(ownerUserId, req.params.inspectionId),
        ownerUserId,
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ success: false, error: errorMessage(error) });
    }
  });

  app.get("/api/ops/v1/evidence-repair/plans/:planId", (req, res) => {
    const ownerUserId = resolveRequestUserId(req);
    try {
      res.json({
        success: true,
        data: service.getPlan(ownerUserId, req.params.planId),
        ownerUserId,
      });
    } catch (error) {
      res.status(errorStatus(error)).json({ success: false, error: errorMessage(error) });
    }
  });

  app.post(
    "/api/ops/v1/evidence-repair/inspect",
    requireOwnDataWriteRole,
    async (req, res) => {
      const ownerUserId = resolveRequestUserId(req);
      try {
        const data = await service.inspect(ownerUserId, {
          incidentId: req.body?.incidentId,
        });
        res.status(201).json({ success: true, data, ownerUserId });
      } catch (error) {
        res.status(errorStatus(error)).json({ success: false, error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/ops/v1/evidence-repair/plan",
    requireOwnDataWriteRole,
    (req, res) => {
      const ownerUserId = resolveRequestUserId(req);
      try {
        const data = service.createPlan(ownerUserId, {
          inspectionId: req.body?.inspectionId,
          inspectionDigest: req.body?.inspectionDigest,
          patches: req.body?.patches,
          repairSource: req.body?.repairSource,
        });
        res.status(201).json({ success: true, data, ownerUserId });
      } catch (error) {
        res.status(errorStatus(error)).json({ success: false, error: errorMessage(error) });
      }
    },
  );

  app.post(
    "/api/ops/v1/evidence-repair/execute",
    requireGlobalWorkerRole,
    (req, res) => {
      const ownerUserId = resolveRequestUserId(req);
      try {
        const data = service.execute(ownerUserId, {
          planId: req.body?.planId,
          planDigest: req.body?.planDigest,
          idempotencyKey: req.body?.idempotencyKey,
          confirmation: req.body?.confirmation,
          reason: req.body?.reason,
        });
        res.json({ success: true, data, ownerUserId });
      } catch (error) {
        res.status(errorStatus(error)).json({ success: false, error: errorMessage(error) });
      }
    },
  );
}
