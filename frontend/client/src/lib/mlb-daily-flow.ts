import type {
  MlbReviewQueue,
  MlbScheduleGameLike,
  MlbScheduleReadiness,
} from "./mlb-review-priority";

export const P1_M1_RELEASE = "p1-m1-mlb-daily-flow-2026-08-04" as const;

export interface MlbDailySlateSummary {
  total: number;
  ready: number;
  waitingPitchers: number;
  closed: number;
}

export function summarizeMlbDailySlate<T extends MlbScheduleGameLike>(
  queue: MlbReviewQueue<T>,
): MlbDailySlateSummary {
  return {
    total: queue.all.length,
    ready: queue.priority.length,
    waitingPitchers: queue.pending.length,
    closed: queue.all.filter((entry) => entry.readiness === "CLOSED").length,
  };
}

export function mlbDailyReadinessLabel(readiness: MlbScheduleReadiness): string {
  if (readiness === "READY") return "LISTO PARA PREPARAR";
  if (readiness === "PENDING") return "ESPERAR PITCHERS";
  return "JUEGO CERRADO";
}

export function mlbDailyReadinessDetail(readiness: MlbScheduleReadiness): string {
  if (readiness === "READY") {
    return "Ambos abridores están identificados. Puede cargar datos, factores y contexto.";
  }
  if (readiness === "PENDING") {
    return "Falta confirmar al menos un abridor. Se pueden revisar datos, pero no cerrar una decisión FINAL.";
  }
  return "El juego ya comenzó o no tiene identidad suficiente para una predicción pregame.";
}

export function mlbDailyGameTimeLabel(raw: string | null | undefined): string {
  if (!raw) return "Hora pendiente";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return "Hora pendiente";
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(parsed));
}

export function mlbDailyPitcherName(
  pitcher: MlbScheduleGameLike["homePitcher"],
): string {
  const name = String(pitcher?.name ?? pitcher?.fullName ?? "").trim();
  return name || "TBD";
}

export function mlbDailyCanPrepare(readiness: MlbScheduleReadiness): boolean {
  return readiness !== "CLOSED";
}
