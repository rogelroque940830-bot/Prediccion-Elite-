import type { OperationalSlaAlertService } from "./operational-sla-alerts";

function positiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 60_000 ? Math.floor(parsed) : fallback;
}

export function startOperationalSlaAlertWorker(
  service: OperationalSlaAlertService,
  systemOwnerUserId: number,
): NodeJS.Timeout | null {
  if (process.env.COURTEDGE_O2_SLA_ALERTS_ENABLED === "false") return null;
  const intervalMs = positiveMs(
    process.env.COURTEDGE_O2_SLA_ALERT_INTERVAL_MS,
    5 * 60 * 1000,
  );
  const initialDelayMs = positiveMs(
    process.env.COURTEDGE_O2_SLA_ALERT_INITIAL_DELAY_MS,
    2 * 60 * 1000,
  );
  const run = () => service.evaluate(systemOwnerUserId).catch((error) => {
    console.error("[o2-sla] automatic evaluation failed", error);
  });
  const initial = setTimeout(run, initialDelayMs);
  initial.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
