import type { Express } from "express";
import { requireGlobalWorkerRole } from "./user-data-context";
import type { OperationalRestoreDrillService } from "./operational-restore-drill";

export function registerOperationalRestoreDrillRoutes(app: Express, service: OperationalRestoreDrillService): void {
  app.post("/api/ops/v1/backups/:id/restore-drill", requireGlobalWorkerRole, (req, res) => {
    try {
      const data = service.run(decodeURIComponent(String(req.params.id || "")));
      res.json({ success: data.valid, data });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || "Restore drill failed", details: error?.details });
    }
  });
}
