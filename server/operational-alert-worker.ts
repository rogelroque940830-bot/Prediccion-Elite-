import type { OperationalAlertService } from "./operational-alerts";

function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}

export function startOperationalAlertWorker(service: OperationalAlertService): NodeJS.Timeout | null {
  if (process.env.COURTEDGE_ALERTS_ENABLED === "false") return null;
  const intervalMs = positiveMs(process.env.COURTEDGE_ALERT_INTERVAL_MS, 5 * 60 * 1000);
  const run = () => service.evaluate().catch((error) => console.error("[s4] alert evaluation failed", error));
  const initial = setTimeout(run, 90_000);
  initial.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
