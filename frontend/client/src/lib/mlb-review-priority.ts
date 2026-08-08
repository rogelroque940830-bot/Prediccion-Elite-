export type MlbGameQueueView = "priority" | "pending" | "all";
export type MlbScheduleReadiness = "READY" | "PENDING" | "CLOSED";
export type MlbDecisionReviewStatus = "ACTIONABLE" | "REVIEW" | "PASS" | "UNAVAILABLE";

export interface MlbScheduleGameLike {
  gameId: number | string;
  gameTime?: string | null;
  gameDate?: string | null;
  homeTeam?: { id?: number | string | null; name?: string | null } | null;
  awayTeam?: { id?: number | string | null; name?: string | null } | null;
  homePitcher?: { id?: number | string | null; name?: string | null; fullName?: string | null } | null;
  awayPitcher?: { id?: number | string | null; name?: string | null; fullName?: string | null } | null;
}

export interface MlbReviewQueueEntry<T extends MlbScheduleGameLike = MlbScheduleGameLike> {
  game: T;
  readiness: MlbScheduleReadiness;
  startMs: number | null;
}

export interface MlbReviewQueue<T extends MlbScheduleGameLike = MlbScheduleGameLike> {
  priority: Array<MlbReviewQueueEntry<T>>;
  pending: Array<MlbReviewQueueEntry<T>>;
  all: Array<MlbReviewQueueEntry<T>>;
}

export interface MlbPickQualityLike {
  recommendation?: string | null;
  edgeReal?: number | null;
  warnings?: unknown[] | null;
  market?: string | null;
}

export interface MlbDecisionReview {
  status: MlbDecisionReviewStatus;
  label: string;
  detail: string;
  market: string | null;
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function pitcherIdentity(pitcher: MlbScheduleGameLike["homePitcher"]): string {
  return cleanText(pitcher?.name || pitcher?.fullName || pitcher?.id);
}

function parseStartMs(game: MlbScheduleGameLike): number | null {
  for (const candidate of [game.gameDate, game.gameTime]) {
    const parsed = Date.parse(cleanText(candidate));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function classifyMlbScheduleGame(
  game: MlbScheduleGameLike,
  nowMs = Date.now(),
): MlbReviewQueueEntry {
  const startMs = parseStartMs(game);
  const validTeams = Boolean(cleanText(game.homeTeam?.name) && cleanText(game.awayTeam?.name));
  const alreadyStarted = startMs != null && startMs <= nowMs + 60_000;

  if (!validTeams || alreadyStarted) {
    return { game, readiness: "CLOSED", startMs };
  }

  const bothPitchersKnown = Boolean(pitcherIdentity(game.homePitcher) && pitcherIdentity(game.awayPitcher));
  return {
    game,
    readiness: bothPitchersKnown ? "READY" : "PENDING",
    startMs,
  };
}

function sortEntries<T extends MlbScheduleGameLike>(
  left: MlbReviewQueueEntry<T>,
  right: MlbReviewQueueEntry<T>,
): number {
  if (left.readiness !== right.readiness) {
    const rank: Record<MlbScheduleReadiness, number> = { READY: 0, PENDING: 1, CLOSED: 2 };
    return rank[left.readiness] - rank[right.readiness];
  }
  if (left.startMs == null && right.startMs == null) return String(left.game.gameId).localeCompare(String(right.game.gameId));
  if (left.startMs == null) return 1;
  if (right.startMs == null) return -1;
  return left.startMs - right.startMs;
}

export function buildMlbReviewQueue<T extends MlbScheduleGameLike>(
  games: readonly T[],
  nowMs = Date.now(),
): MlbReviewQueue<T> {
  const all = games
    .map((game) => classifyMlbScheduleGame(game, nowMs) as MlbReviewQueueEntry<T>)
    .sort(sortEntries);

  return {
    priority: all.filter((entry) => entry.readiness === "READY"),
    pending: all.filter((entry) => entry.readiness === "PENDING"),
    all,
  };
}

function normalizedWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((warning) => cleanText(warning)).filter(Boolean) : [];
}

export function classifyMlbDecisionReview(
  pickQualities: Record<string, MlbPickQualityLike | null | undefined> | null | undefined,
): MlbDecisionReview {
  const qualities = Object.values(pickQualities ?? {}).filter(Boolean) as MlbPickQualityLike[];
  if (!qualities.length) {
    return {
      status: "UNAVAILABLE",
      label: "Sin clasificación todavía",
      detail: "Genera la predicción para clasificar el partido con las señales existentes.",
      market: null,
    };
  }

  const actionable = qualities.find((quality) => {
    const recommendation = cleanText(quality.recommendation).toUpperCase();
    const edge = Number(quality.edgeReal);
    const hasVeto = normalizedWarnings(quality.warnings).some((warning) => /\bVETO\b/i.test(warning));
    return ["BET", "BET_FUERTE"].includes(recommendation) && Number.isFinite(edge) && edge > 0 && !hasVeto;
  });
  if (actionable) {
    return {
      status: "ACTIONABLE",
      label: "Prioridad alta para revisión",
      detail: "Existe al menos un mercado BET/BET_FUERTE con edge positivo y sin veto registrado.",
      market: cleanText(actionable.market) || null,
    };
  }

  const lean = qualities.find((quality) => {
    const recommendation = cleanText(quality.recommendation).toUpperCase();
    const edge = Number(quality.edgeReal);
    return recommendation === "LEAN" && Number.isFinite(edge) && edge > 0;
  });
  if (lean) {
    return {
      status: "REVIEW",
      label: "Revisión secundaria",
      detail: "Hay una señal LEAN con edge positivo, pero no una recomendación fuerte.",
      market: cleanText(lean.market) || null,
    };
  }

  return {
    status: "PASS",
    label: "Descartar por ahora",
    detail: "Los mercados quedaron en PASS, con edge no positivo o bloqueados por un veto existente.",
    market: null,
  };
}
