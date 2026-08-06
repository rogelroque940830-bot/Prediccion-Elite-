export const MLB_HISTORY_FOCUS_PRIORITY_LIMIT = 5;
export const MLB_HISTORY_FOCUS_WAITING_LIMIT = 8;
export const MLB_HISTORY_FOCUS_VERIFY_LIMIT = 12;
export const MLB_HISTORY_EDGE_REVIEW_THRESHOLD_PP = 15;
export const MLB_HISTORY_ARITHMETIC_TOLERANCE_PP = 0.75;

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
  economicLayerSchemaVersion?: string | null;
  economicLayerStatus?: string | null;
  economicSourceSignal?: string | null;
  economicEffectiveDecision?: string | null;
  economicActionability?: string | null;
  economicAnalyticalUnits?: number;
  economicReasons?: string[];
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
export type MlbMarketIntegrityStatus = "PASS" | "REVIEW" | "REJECT";
export type MlbMarketIntegritySeverity = "REVIEW" | "REJECT";
export type MlbMarketIntegrityIssueCode =
  | "INVALID_AMERICAN_ODDS"
  | "INVALID_MODEL_PROBABILITY"
  | "IMPLIED_PROBABILITY_MISMATCH"
  | "EDGE_ARITHMETIC_MISMATCH"
  | "EDGE_OUTLIER"
  | "MARKET_SELECTION_MISMATCH"
  | "MISSING_TOTAL_LINE"
  | "NON_STANDARD_LINE_INCREMENT"
  | "MISSING_BOOK";

export interface MlbMarketIntegrityIssue {
  code: MlbMarketIntegrityIssueCode;
  severity: MlbMarketIntegritySeverity;
  message: string;
}

export interface MlbMarketIntegrityAudit {
  status: MlbMarketIntegrityStatus;
  issues: MlbMarketIntegrityIssue[];
  impliedFromOddsPct: number | null;
  recomputedEdgePp: number | null;
}

export interface MlbHistoryIntegrityItem<T extends MlbHistoryFocusPick = MlbHistoryFocusPick> {
  pick: T;
  audit: MlbMarketIntegrityAudit;
}

export interface MlbHistoryFocusView<T extends MlbHistoryFocusPick = MlbHistoryFocusPick> {
  priority: T[];
  waiting: T[];
  verify: Array<MlbHistoryIntegrityItem<T>>;
  verifyTotal: number;
  results: T[];
  uniqueDecisions: number;
  collapsedRevisions: number;
  hiddenStudyRecords: number;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function upper(value: unknown): string {
  return clean(value).toUpperCase().replace(/[\s-]+/g, "_");
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

function finiteOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
  const value = upper(signal);
  if (["BET_FUERTE", "STRONG_BET", "BEST_BET", "PREMIUM"].includes(value)) return 4;
  if (["BET", "PLAY", "ACTIONABLE"].includes(value)) return 3;
  if (["LEAN", "REVIEW"].includes(value)) return 2;
  if (["INFO", "WATCH"].includes(value)) return 1;
  return 0;
}

function economicDecisionStrength(decision: unknown): number {
  const value = upper(decision);
  if (value === "BET") return 3;
  if (value === "LEAN") return 2;
  if (value === "PASS") return 0;
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

function normalizedMarket(value: unknown): string {
  return clean(value).toUpperCase().replace(/[\s-]+/g, "_");
}

function isTotalMarket(value: unknown): boolean {
  const market = normalizedMarket(value);
  return market.includes("TOTAL") || market.includes("O/U") || market.endsWith("_OU");
}

function isMoneylineMarket(value: unknown): boolean {
  const market = normalizedMarket(value);
  return market === "ML" || market.endsWith("_ML") || market.includes("MONEYLINE");
}

function selectionDirection(value: unknown): "OVER" | "UNDER" | "TEAM" {
  const selection = clean(value).toUpperCase();
  if (/^OVER(?:\s|$)/.test(selection)) return "OVER";
  if (/^UNDER(?:\s|$)/.test(selection)) return "UNDER";
  return "TEAM";
}

function hasWholeOrHalfIncrement(line: number): boolean {
  return Math.abs(line * 2 - Math.round(line * 2)) < 1e-8;
}

function issue(
  code: MlbMarketIntegrityIssueCode,
  severity: MlbMarketIntegritySeverity,
  message: string,
): MlbMarketIntegrityIssue {
  return { code, severity, message };
}

export function isMlbHistoryEconomicLayerAdapted(pick: MlbHistoryFocusPick): boolean {
  return upper(pick.economicLayerStatus) === "ADAPTED"
    && upper(pick.economicLayerSchemaVersion) === "COURTEDGE_P1_M4B_ECONOMIC_DECISION_ADAPTER.V1";
}

export function isMlbHistoryEconomicallyActionable(pick: MlbHistoryFocusPick): boolean {
  return isMlbHistoryEconomicLayerAdapted(pick)
    && upper(pick.analysisStage) === "FINAL"
    && upper(pick.economicEffectiveDecision) === "BET"
    && upper(pick.economicActionability) === "ACTIONABLE_FINAL"
    && finite(pick.economicAnalyticalUnits) > 0;
}

export function isMlbHistoryWaitingForFinal(pick: MlbHistoryFocusPick): boolean {
  return isMlbHistoryEconomicLayerAdapted(pick)
    && upper(pick.analysisStage) !== "FINAL"
    && upper(pick.economicActionability) === "WAIT_FOR_FINAL"
    && economicDecisionStrength(pick.economicEffectiveDecision) > 0;
}

export function isStandardAmericanOdds(value: unknown): boolean {
  const odds = finiteOrNull(value);
  return odds != null
    && (odds <= -100 || odds >= 100)
    && Math.abs(odds) <= 10_000;
}

export function americanOddsToImpliedPct(value: unknown): number | null {
  const odds = finiteOrNull(value);
  if (odds == null || odds === 0) return null;
  return odds < 0
    ? (Math.abs(odds) / (Math.abs(odds) + 100)) * 100
    : (100 / (odds + 100)) * 100;
}

export function auditMlbHistoryMarketIntegrity(
  pick: MlbHistoryFocusPick,
  tolerancePp = MLB_HISTORY_ARITHMETIC_TOLERANCE_PP,
  edgeReviewThresholdPp = MLB_HISTORY_EDGE_REVIEW_THRESHOLD_PP,
): MlbMarketIntegrityAudit {
  const issues: MlbMarketIntegrityIssue[] = [];
  const odds = finiteOrNull(pick.oddsAmerican);
  const modelProbabilityPct = finiteOrNull(pick.modelProbabilityPct);
  const storedImpliedPct = finiteOrNull(pick.marketImpliedProbabilityPct);
  const storedEdgePp = finiteOrNull(pick.edgePp);
  const impliedFromOddsPct = americanOddsToImpliedPct(odds);

  if (!isStandardAmericanOdds(odds)) {
    issues.push(issue(
      "INVALID_AMERICAN_ODDS",
      "REJECT",
      `Cuota americana inválida: ${odds == null ? "sin valor" : odds}.`,
    ));
  }

  if (modelProbabilityPct == null || modelProbabilityPct <= 0 || modelProbabilityPct >= 100) {
    issues.push(issue(
      "INVALID_MODEL_PROBABILITY",
      "REJECT",
      "La probabilidad del modelo falta o está fuera del rango válido.",
    ));
  }

  if (impliedFromOddsPct != null && storedImpliedPct != null
    && Math.abs(storedImpliedPct - impliedFromOddsPct) > tolerancePp) {
    issues.push(issue(
      "IMPLIED_PROBABILITY_MISMATCH",
      "REJECT",
      `Mercado guardado ${storedImpliedPct.toFixed(2)}% vs recálculo ${impliedFromOddsPct.toFixed(2)}%.`,
    ));
  }

  const recomputedEdgePp = modelProbabilityPct != null && impliedFromOddsPct != null
    ? modelProbabilityPct - impliedFromOddsPct
    : null;

  if (recomputedEdgePp != null && storedEdgePp != null
    && Math.abs(storedEdgePp - recomputedEdgePp) > tolerancePp) {
    issues.push(issue(
      "EDGE_ARITHMETIC_MISMATCH",
      "REJECT",
      `Edge guardado ${storedEdgePp.toFixed(2)} pp vs recálculo ${recomputedEdgePp.toFixed(2)} pp.`,
    ));
  }

  if (recomputedEdgePp != null && recomputedEdgePp > edgeReviewThresholdPp) {
    issues.push(issue(
      "EDGE_OUTLIER",
      "REVIEW",
      `Edge extraordinario de ${recomputedEdgePp.toFixed(2)} pp; requiere revisar fuente y calibración.`,
    ));
  }

  const direction = selectionDirection(pick.selection);
  if (isTotalMarket(pick.marketType || pick.marketLabel)) {
    if (direction === "TEAM") {
      issues.push(issue(
        "MARKET_SELECTION_MISMATCH",
        "REJECT",
        "Un total debe seleccionar OVER o UNDER.",
      ));
    }
    if (pick.line == null || !Number.isFinite(Number(pick.line))) {
      issues.push(issue(
        "MISSING_TOTAL_LINE",
        "REJECT",
        "El mercado total no contiene una línea válida.",
      ));
    } else if (!hasWholeOrHalfIncrement(Number(pick.line))) {
      issues.push(issue(
        "NON_STANDARD_LINE_INCREMENT",
        "REVIEW",
        `La línea ${pick.line} no está en un incremento de carrera completa o media carrera.`,
      ));
    }
  }

  if (isMoneylineMarket(pick.marketType || pick.marketLabel) && direction !== "TEAM") {
    issues.push(issue(
      "MARKET_SELECTION_MISMATCH",
      "REJECT",
      "Un moneyline no puede seleccionar OVER o UNDER.",
    ));
  }

  if (!clean(pick.book)) {
    issues.push(issue(
      "MISSING_BOOK",
      "REVIEW",
      "La casa o fuente de la cuota no está identificada.",
    ));
  }

  const status: MlbMarketIntegrityStatus = issues.some((entry) => entry.severity === "REJECT")
    ? "REJECT"
    : issues.some((entry) => entry.severity === "REVIEW")
      ? "REVIEW"
      : "PASS";

  return { status, issues, impliedFromOddsPct, recomputedEdgePp };
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
  if (edge <= 0 || !isMlbHistoryEconomicLayerAdapted(pick)) return "HIDDEN";
  const final = upper(pick.analysisStage) === "FINAL";
  const effectiveDecision = upper(pick.economicEffectiveDecision);

  if (isMlbHistoryEconomicallyActionable(pick)) return "HIGH";
  if (final && effectiveDecision === "LEAN" && edge >= 2.5) return "SECONDARY";
  return "HIDDEN";
}

function reviewScore(pick: MlbHistoryFocusPick, nowMs: number): number {
  const start = startMs(pick);
  const hoursUntil = start == null ? Number.POSITIVE_INFINITY : Math.max(0, (start - nowMs) / 3_600_000);
  const soonBonus = hoursUntil <= 2 ? 12 : hoursUntil <= 6 ? 8 : hoursUntil <= 12 ? 4 : 0;
  return economicDecisionStrength(pick.economicEffectiveDecision) * 30
    + Math.min(15, Math.max(0, finite(pick.edgePp))) * 2
    + stageStrength(pick.analysisStage) * 5
    + confidenceStrength(pick.confidenceLabel) * 4
    + Math.min(10, Math.max(0, finite(pick.economicAnalyticalUnits)) * 10)
    + soonBonus;
}

function resultTime(pick: MlbHistoryFocusPick): number {
  return parsedMs(pick.settledAt) ?? parsedMs(pick.recordedAt) ?? 0;
}

function integritySeverity(audit: MlbMarketIntegrityAudit): number {
  if (audit.status === "REJECT") return 2;
  if (audit.status === "REVIEW") return 1;
  return 0;
}

export function buildMlbHistoryFocus<T extends MlbHistoryFocusPick>(
  picks: readonly T[],
  nowMs = Date.now(),
): MlbHistoryFocusView<T> {
  const unique = collapseMlbHistoryRevisions(picks);
  const pendingPregame = unique.filter((pick) => clean(pick.result).toUpperCase() === "PENDING" && isPregame(pick, nowMs));
  const auditedPending = pendingPregame.map((pick) => ({
    pick,
    audit: auditMlbHistoryMarketIntegrity(pick),
  }));
  const integrityPassed = auditedPending
    .filter((entry) => entry.audit.status === "PASS")
    .map((entry) => entry.pick);

  const ranked = integrityPassed
    .filter((pick) => classifyMlbHistoryFocus(pick) !== "HIDDEN")
    .sort((left, right) => reviewScore(right, nowMs) - reviewScore(left, nowMs));
  const priority = ranked.slice(0, MLB_HISTORY_FOCUS_PRIORITY_LIMIT);
  const priorityIds = new Set(priority.map((pick) => pick.id));

  const waiting = integrityPassed
    .filter((pick) => !priorityIds.has(pick.id))
    .filter((pick) => finite(pick.edgePp) > 0 && isMlbHistoryWaitingForFinal(pick))
    .sort((left, right) => {
      const leftStart = startMs(left) ?? Number.MAX_SAFE_INTEGER;
      const rightStart = startMs(right) ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart || reviewScore(right, nowMs) - reviewScore(left, nowMs);
    })
    .slice(0, MLB_HISTORY_FOCUS_WAITING_LIMIT);

  const verifyCandidates = auditedPending
    .filter((entry) => entry.audit.status !== "PASS")
    .sort((left, right) => {
      const severity = integritySeverity(right.audit) - integritySeverity(left.audit);
      if (severity !== 0) return severity;
      const leftStart = startMs(left.pick) ?? Number.MAX_SAFE_INTEGER;
      const rightStart = startMs(right.pick) ?? Number.MAX_SAFE_INTEGER;
      return leftStart - rightStart || reviewScore(right.pick, nowMs) - reviewScore(left.pick, nowMs);
    });
  const verify = verifyCandidates.slice(0, MLB_HISTORY_FOCUS_VERIFY_LIMIT);

  const results = unique
    .filter((pick) => clean(pick.result).toUpperCase() !== "PENDING")
    .sort((left, right) => resultTime(right) - resultTime(left));

  const shownIds = new Set([
    ...priority.map((pick) => pick.id),
    ...waiting.map((pick) => pick.id),
    ...verify.map((entry) => entry.pick.id),
    ...results.map((pick) => pick.id),
  ]);
  const hiddenStudyRecords = Math.max(0, picks.length - shownIds.size);

  return {
    priority,
    waiting,
    verify,
    verifyTotal: verifyCandidates.length,
    results,
    uniqueDecisions: unique.length,
    collapsedRevisions: Math.max(0, picks.length - unique.length),
    hiddenStudyRecords,
  };
}
