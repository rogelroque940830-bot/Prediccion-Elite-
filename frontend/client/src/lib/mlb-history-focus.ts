export const MLB_HISTORY_FOCUS_PRIORITY_LIMIT = 5;
export const MLB_HISTORY_FOCUS_WAITING_LIMIT = 8;
export const MLB_HISTORY_FOCUS_RESULTS_LIMIT = 8;

export interface MlbHistoryFocusPick {
  id: string;
  recordedAt: string;
  gameDate: string;
  commenceTime: string | null;
  gamePk: number | null;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  marketLabel: string;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  book: string | null;
  modelProbabilityPct: number;
  marketImpliedProbabilityPct: number;
  edgePp: number;
  signal: string;
  confidenceLabel: string | null;
  analysisStage: string;
  result: string;
  settlementResult: string | null;
  settledAt: string | null;
  profitUnits: number;
  closingOddsAmerican: number | null;
  clvPp: number | null;
  finalScore: { home: number; away: number } | null;
  analyticalDuplicate: boolean;
}

export type MlbHistoryFocusTier = "HIGH" | "SECONDARY" | "HIDDEN";

export interface MlbHistoryFocusView<T extends MlbHistoryFocusPick = MlbHistoryFocusPick> {
  priority: T[];
  waiting: T[];
  results: T[];
  uniqueDecisions: number;
  collapsedRevisions: number;
  hiddenStudyRecords: number;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsedMs(value: unknown): number | null {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function floridaDateKey(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

function startMs(pick: MlbHistoryFocusPick): number | null {
  const exact = parsedMs(pick.commenceTime);
  if (exact != null) return exact;
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean(pick.gameDate))) {
    const fallback = Date.parse(`${pick.gameDate}T23:59:59-04:00`);
    return Number.isFinite(fallback) ? fallback : null;
  }
  return null;
}

function isPregame(pick: MlbHistoryFocusPick, nowMs: number): boolean {
  const start = startMs(pick);
  if (start != null) return start > nowMs + 60_000;
  return clean(pick.gameDate) >= floridaDateKey(nowMs);
}

function signalStrength(signal: unknown): number {
  const value = clean(signal).toUpperCase().replace(/[\s-]+/g, "_");
  if (["BET_FUERTE", "STRONG_BET", "BEST_BET", "PREMIUM"].includes(value)) return 4;
  if (["BET", "PLAY", "ACTIONABLE"].includes(value)) return 3;
  if (["LEAN", "REVIEW"].includes(value)) return 2;
  if (["INFO", "WATCH"].includes(value)) return 1;
  return 0;
}

function confidenceStrength(confidence: unknown): number {
  const value = clean(confidence).toUpperCase();
  if (["PREMIUM", "VERY_HIGH", "ELITE"].includes(value)) return 3;
  if (["HIGH", "ALTA"].includes(value)) return 2;
  if (["MEDIUM", "MEDIA"].includes(value)) return 1;
  return 0;
}

function stageStrength(stage: unknown): number {
  const value = clean(stage).toUpperCase();
  if (value === "FINAL") return 3;
  if (value === "LOCAL") return 2;
  if (value === "PROVISIONAL") return 1;
  return 0;
}

function versionStrength(pick: MlbHistoryFocusPick): number {
  const settled = pick.settlementResult != null || clean(pick.result).toUpperCase() !== "PENDING";
  return (settled ? 100 : 0) + stageStrength(pick.analysisStage) * 10;
}

export function mlbHistoryDecisionKey(pick: MlbHistoryFocusPick): string {
  const game = pick.gamePk != null
    ? `pk:${pick.gamePk}`
    : [pick.gameDate, normalized(pick.awayTeam), normalized(pick.homeTeam)].join(":");
  return [
    game,
    normalized(pick.marketType || pick.marketLabel),
    normalized(pick.selection),
    pick.line == null ? "na" : String(pick.line),
  ].join("|");
}

export function collapseMlbHistoryRevisions<T extends MlbHistoryFocusPick>(picks: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const pick of picks) {
    if (pick.analyticalDuplicate) continue;
    const key = mlbHistoryDecisionKey(pick);
    const current = latest.get(key);
    if (!current) {
      latest.set(key, pick);
      continue;
    }
    const candidateStrength = versionStrength(pick);
    const currentStrength = versionStrength(current);
    const candidateRecorded = parsedMs(pick.recordedAt) ?? 0;
    const currentRecorded = parsedMs(current.recordedAt) ?? 0;
    if (candidateStrength > currentStrength || (candidateStrength === currentStrength && candidateRecorded > currentRecorded)) {
      latest.set(key, pick);
    }
  }
  return Array.from(latest.values());
}

export function classifyMlbHistoryFocus(pick: MlbHistoryFocusPick): MlbHistoryFocusTier {
  const edge = finite(pick.edgePp);
  if (edge <= 0) return "HIDDEN";
  const signal = signalStrength(pick.signal);
  const confidence = confidenceStrength(pick.confidenceLabel);
  const final = clean(pick.analysisStage).toUpperCase() === "FINAL";

  if (signal >= 3) return "HIGH";
  if (signal === 2 && final && edge >= 2.5) return "SECONDARY";
  if (final && confidence >= 2 && edge >= 4) return "SECONDARY";
  return "HIDDEN";
}

function reviewScore(pick: MlbHistoryFocusPick, nowMs: number): number {
  const start = startMs(pick);
  const hoursUntil = start == null ? Number.POSITIVE_INFINITY : Math.max(0, (start - nowMs) / 3_600_000);
  const soonBonus = hoursUntil <= 2 ? 12 : hoursUntil <= 6 ? 8 : hoursUntil <= 12 ? 4 : 0;
  return signalStrength(pick.signal) * 30
    + Math.min(15, Math.max(0, finite(pick.edgePp))) * 2
    + stageStrength(pick.analysisStage) * 5
    + confidenceStrength(pick.confidenceLabel) * 4
    + soonBonus;
}

function resultTime(pick: MlbHistoryFocusPick): number {
  return parsedMs(pick.settledAt) ?? parsedMs(pick.recordedAt) ?? 0;
}

export function buildMlbHistoryFocus<T extends MlbHistoryFocusPick>(
  picks: readonly T[],
  nowMs = Date.now(),
): MlbHistoryFocusView<T> {
  const unique = collapseMlbHistoryRevisions(picks);
  const pendingPregame = unique.filter((pick) => clean(pick.result).toUpperCase() === "PENDING" && isPregame(pick, nowMs));

  const ranked = pendingPregame
    .filter((pick) => classifyMlbHistoryFocus(pick) !== "HIDDEN")
    .sort((left, right) => reviewScore(right, nowMs) - reviewScore(left, nowMs));
  const priority = ranked.slice(0, MLB_HISTORY_FOCUS_PRIORITY_LIMIT);
  const priorityIds = new Set(priority.map((pick) => pick.id));

  const waiting = pendingPregame
    .filter((pick) => !priorityIds.has(pick.id))
    .filter((pick) => {
      const edge = finite(pick.edgePp);
      const signal = signalStrength(pick.signal);
      const confidence = confidenceStrength(pick.confidenceLabel);
      return edge > 0 && (signal >= 1 || confidence >= 1);
    })
    .sort((left, right) => {
      const leftStart = startMs(left) ?? Number.MAX_SAFE_INTEGER;
      const rightStart = startMs(right) ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart || reviewScore(right, nowMs) - reviewScore(left, nowMs);
    })
    .slice(0, MLB_HISTORY_FOCUS_WAITING_LIMIT);

  const results = unique
    .filter((pick) => clean(pick.result).toUpperCase() !== "PENDING")
    .sort((left, right) => resultTime(right) - resultTime(left))
    .slice(0, MLB_HISTORY_FOCUS_RESULTS_LIMIT);

  const shownIds = new Set([...priority, ...waiting, ...results].map((pick) => pick.id));
  const hiddenStudyRecords = Math.max(0, picks.length - shownIds.size);

  return {
    priority,
    waiting,
    results,
    uniqueDecisions: unique.length,
    collapsedRevisions: Math.max(0, picks.length - unique.length),
    hiddenStudyRecords,
  };
}
