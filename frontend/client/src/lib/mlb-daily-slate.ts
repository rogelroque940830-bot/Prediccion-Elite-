export type MlbDailySlateReadiness =
  | "READY_TO_ANALYZE"
  | "PROVISIONAL_WAITING_FOR_LINEUPS"
  | "WAITING_FOR_PITCHERS"
  | "GAME_ALREADY_STARTED"
  | "GAME_CLOSED"
  | "DATA_INSUFFICIENT";

export type MlbDailySlateView = "ready" | "provisional" | "all";

export interface MlbDailySlatePitcher {
  id: number | null;
  name: string | null;
  hand: "R" | "L" | null;
  confirmed: boolean;
}

export interface MlbDailySlateGame {
  gamePk: number;
  startTime: string | null;
  officialDate: string;
  venue: string | null;
  state: "SCHEDULED" | "PREGAME" | "IN_PROGRESS" | "FINAL" | "POSTPONED" | "CANCELLED" | "SUSPENDED" | "UNKNOWN";
  detailedState: string;
  homeTeam: { id: number | null; name: string };
  awayTeam: { id: number | null; name: string };
  homePitcher: MlbDailySlatePitcher;
  awayPitcher: MlbDailySlatePitcher;
  lineupState: "CONFIRMED" | "PARTIAL" | "NOT_POSTED" | "UNKNOWN";
  homeLineupCount: number;
  awayLineupCount: number;
  readiness: MlbDailySlateReadiness;
  analysisStage: "FINAL" | "PROVISIONAL" | "BLOCKED";
  analysisAllowed: boolean;
  blockers: string[];
  source: {
    name: "MLB_STATS_API";
    fetchedAt: string;
    quality: "AUTHORITATIVE" | "DEGRADED";
  };
}

export interface MlbDailySlateReport {
  schemaVersion: "courtedge-p1-mlb-daily-slate.v1";
  date: string;
  generatedAt: string;
  games: MlbDailySlateGame[];
  summary: {
    total: number;
    ready: number;
    provisional: number;
    waitingForPitchers: number;
    startedOrClosed: number;
    dataInsufficient: number;
  };
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export interface MlbDailySlateEnvelope {
  success: boolean;
  data: MlbDailySlateReport;
  cache: "HIT" | "MISS";
}

export function mlbDailySlateSafetyValid(report: MlbDailySlateReport | null | undefined): boolean {
  const safety = report?.safety;
  return Boolean(
    report?.schemaVersion === "courtedge-p1-mlb-daily-slate.v1"
    && safety?.mode === "SHADOW_DECISION_SUPPORT"
    && safety.realFinancialExposure === 0
    && safety.automaticBetPlacement === false
    && safety.automaticModelChangesAllowed === false
    && safety.automaticPromotionAllowed === false
  );
}

export function filterMlbDailySlateGames(
  games: readonly MlbDailySlateGame[],
  view: MlbDailySlateView,
): MlbDailySlateGame[] {
  if (view === "ready") return games.filter((game) => game.readiness === "READY_TO_ANALYZE");
  if (view === "provisional") return games.filter((game) => game.readiness === "PROVISIONAL_WAITING_FOR_LINEUPS");
  return [...games];
}

export function mlbDailySlateReadinessLabel(readiness: MlbDailySlateReadiness): string {
  const labels: Record<MlbDailySlateReadiness, string> = {
    READY_TO_ANALYZE: "Listo para analizar",
    PROVISIONAL_WAITING_FOR_LINEUPS: "Esperando lineups",
    WAITING_FOR_PITCHERS: "Esperando pitchers",
    GAME_ALREADY_STARTED: "Juego iniciado",
    GAME_CLOSED: "Juego cerrado",
    DATA_INSUFFICIENT: "Datos insuficientes",
  };
  return labels[readiness];
}

export function mlbDailySlateLineupLabel(game: MlbDailySlateGame): string {
  if (game.lineupState === "CONFIRMED") return "Lineups confirmados";
  if (game.lineupState === "PARTIAL") return `Lineups parciales (${game.awayLineupCount}/${game.homeLineupCount})`;
  if (game.lineupState === "NOT_POSTED") return "Lineups no publicados";
  return "Estado de lineups no verificable";
}

export function formatMlbSlateTime(raw: string | null): string {
  if (!raw) return "Hora no disponible";
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return "Hora no disponible";
  return new Intl.DateTimeFormat("es-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}
