import type { Express } from "express";
import { requireGlobalWorkerRole } from "./user-data-context";
import type { OperationalBackupService } from "./operational-backup";

export function registerOperationalRoutes(app: Express, service: OperationalBackupService): void {
  app.get("/api/ops/v1/status", (_req, res) => {
    res.json({ success: true, data: service.status() });
  });

  app.get("/api/ops/v1/backups", (_req, res) => {
    res.json({ success: true, data: service.listBackups() });
  });

  app.post("/api/ops/v1/backups", requireGlobalWorkerRole, async (_req, res) => {
    try {
      const data = await service.createBackup();
      res.status(201).json({ success: true, data });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || "Backup failed" });
    }
  });

  app.post("/api/ops/v1/backups/:id/verify", requireGlobalWorkerRole, (req, res) => {
    try {
      const data = service.verifyBackup(decodeURIComponent(String(req.params.id || "")));
      res.status(data.valid ? 200 : 409).json({ success: data.valid, data });
    } catch (error: any) {
      res.status(error?.status || 404).json({ success: false, error: error?.message || "Backup not found" });
    }
  });
}
