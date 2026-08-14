import type { OperationalBackupService } from "./operational-backup";

function positiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}

export function startOperationalBackupWorker(service: OperationalBackupService): NodeJS.Timeout | null {
  if (process.env.COURTEDGE_BACKUP_ENABLED === "false") return null;
  const intervalMs = positiveMs(process.env.COURTEDGE_BACKUP_INTERVAL_MS, 24 * 60 * 60 * 1000);
  const run = async () => {
    try {
      const latest = service.listBackups()[0];
      if (!latest || Date.now() - latest.createdAtMs >= intervalMs) await service.createBackup();
    } catch (error) {
      console.error("[s4] operational backup failed", error);
    }
  };
  const initial = setTimeout(run, 30_000);
  initial.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
