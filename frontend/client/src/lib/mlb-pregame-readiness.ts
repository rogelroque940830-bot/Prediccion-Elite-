export const MLB_P1_M2B_READINESS_SCHEMA = "courtedge-p1-m2b-pregame-readiness.v1" as const;
export const MLB_P1_M2A_CONTRACT_SCHEMA = "courtedge-p1-m2a-pregame-readiness-contract.v1" as const;

export type MlbPregameMarket = "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL";
export type MlbPregameEvidenceState = "FRESH" | "STALE" | "DEGRADED" | "MISSING" | "CONFLICT" | "UNKNOWN";
export type MlbPregameGateStatus = "READY_FINAL" | "READY_PROVISIONAL" | "BLOCKED";
export type MlbPregameAnalysisStage = "FINAL" | "PROVISIONAL" | "BLOCKED";

export interface MlbPregameEvidence {
  field: string;
  required: boolean;
  state: MlbPregameEvidenceState;
  sourceIds: string[];
  endpoints: string[];
  authority: string;
  fetchedAt: string;
  observedAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  sourceStatus: string;
  quality: string;
  details: Record<string, unknown>;
  errors: string[];
}

export interface MlbPregameReadinessReport {
  schemaVersion: typeof MLB_P1_M2B_READINESS_SCHEMA;
  contractSchemaVersion: typeof MLB_P1_M2A_CONTRACT_SCHEMA;
  generatedAt: string;
  market: MlbPregameMarket;
  game: {
    gamePk: number;
    officialDate: string | null;
    startTime: string | null;
    state: string;
    detailedState: string | null;
    homeTeam: { id: number | null; name: string | null };
    awayTeam: { id: number | null; name: string | null };
  };
  gate: {
    schemaVersion: typeof MLB_P1_M2A_CONTRACT_SCHEMA;
    status: MlbPregameGateStatus;
    analysisAllowed: boolean;
    analysisStage: MlbPregameAnalysisStage;
    blockers: string[];
    warnings: string[];
    requiredFields: string[];
  };
  summary: {
    requiredFields: string[];
    fresh: number;
    stale: number;
    degraded: number;
    missing: number;
    conflict: number;
    unknown: number;
  };
  evidence: MlbPregameEvidence[];
  warnings?: string[];
  safety: {
    mode: string;
    realFinancialExposure: number;
    automaticBetPlacement: boolean;
    automaticModelChangesAllowed: boolean;
    automaticPromotionAllowed: boolean;
  };
}

export interface MlbPregameReadinessEnvelope {
  success: boolean;
  data?: MlbPregameReadinessReport;
  error?: string;
}

export interface MlbPregameLineInputs {
  mlHome: string;
  mlAway: string;
  runLine: string;
  runLineHomeOdds: string;
  runLineAwayOdds: string;
  totalLine: string;
  overOdds: string;
  underOdds: string;
  f5MlHome: string;
  f5MlAway: string;
  f5TotalLine: string;
  f5OddsSource: "manual" | "consenso" | "none";
}

export interface MlbPregameGateSnapshot {
  gamePk: number;
  market: MlbPregameMarket;
  status: MlbPregameGateStatus;
  analysisAllowed: boolean;
  analysisStage: MlbPregameAnalysisStage;
  blockers: string[];
  warnings: string[];
  generatedAt: string;
}

export interface MlbPregameQuoteCompatibility {
  matches: boolean;
  reasons: string[];
  sourceStatus: string | null;
  certifiedQuote: Record<string, unknown> | null;
}

function finite(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function americanOdds(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed == null || Math.abs(parsed) < 100 || Math.abs(parsed) > 100_000) return null;
  return Math.round(parsed);
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameNumber(left: unknown, right: unknown, tolerance = 0.001): boolean {
  const a = finite(left);
  const b = finite(right);
  return a != null && b != null && Math.abs(a - b) <= tolerance;
}

export function buildMlbPregameManualOddsParams(
  market: MlbPregameMarket,
  lines: MlbPregameLineInputs,
  capturedAt: string,
): URLSearchParams | null {
  // The existing full-game fields have seeded defaults and do not yet carry an
  // explicit observedAt/source transition. Treating those values as a newly
  // captured manual quote would manufacture freshness. ML, Run Line and Total
  // therefore use the backend market source until the form records provenance.
  if (market !== "F5_ML" || lines.f5OddsSource !== "manual") return null;

  const home = americanOdds(lines.f5MlHome);
  const away = americanOdds(lines.f5MlAway);
  if (home == null || away == null) return null;

  const params = new URLSearchParams();
  params.set("oddsMode", "manual");
  params.set("manualCapturedAt", capturedAt);
  params.set("manualBook", "Hard Rock F5 formulario");
  params.set("manualHomeOdds", String(home));
  params.set("manualAwayOdds", String(away));
  return params;
}

export function buildMlbPregameReadinessUrl(input: {
  gamePk: string;
  date: string;
  market: MlbPregameMarket;
  lines: MlbPregameLineInputs;
  capturedAt: string;
}): { url: string; oddsMode: "manual" | "automatic" } {
  const params = new URLSearchParams({
    gamePk: input.gamePk,
    date: input.date,
    market: input.market,
  });
  const manual = buildMlbPregameManualOddsParams(input.market, input.lines, input.capturedAt);
  if (manual) manual.forEach((value, key) => params.set(key, value));
  return {
    url: `/api/mlb/p1/v1/pregame-readiness?${params.toString()}`,
    oddsMode: manual ? "manual" : "automatic",
  };
}

export function validateMlbPregameModelQuote(
  report: MlbPregameReadinessReport,
  lines: MlbPregameLineInputs,
): MlbPregameQuoteCompatibility {
  const marketEvidence = report.evidence.find((item) => item.field === "MARKET_ODDS") ?? null;
  const details = record(marketEvidence?.details);
  const certifiedQuote = record(details?.quote) ?? details;
  const reasons: string[] = [];

  if (!marketEvidence || !certifiedQuote) {
    reasons.push("CERTIFIED_MARKET_QUOTE_MISSING");
  } else if (report.market === "ML") {
    if (!sameNumber(lines.mlHome, certifiedQuote.home ?? certifiedQuote.homeOdds)) reasons.push("MODEL_HOME_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
    if (!sameNumber(lines.mlAway, certifiedQuote.away ?? certifiedQuote.awayOdds)) reasons.push("MODEL_AWAY_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
  } else if (report.market === "F5_ML") {
    if (!sameNumber(lines.f5MlHome, certifiedQuote.home ?? certifiedQuote.homeOdds)) reasons.push("MODEL_HOME_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
    if (!sameNumber(lines.f5MlAway, certifiedQuote.away ?? certifiedQuote.awayOdds)) reasons.push("MODEL_AWAY_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
  } else if (report.market === "RUN_LINE") {
    if (!sameNumber(lines.runLine, certifiedQuote.line)) reasons.push("MODEL_LINE_DOES_NOT_MATCH_CERTIFIED_QUOTE");
    if (!sameNumber(lines.runLineHomeOdds, certifiedQuote.homeOdds)) reasons.push("MODEL_HOME_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
    if (!sameNumber(lines.runLineAwayOdds, certifiedQuote.awayOdds)) reasons.push("MODEL_AWAY_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
  } else if (report.market === "TOTAL") {
    if (!sameNumber(lines.totalLine, certifiedQuote.line)) reasons.push("MODEL_LINE_DOES_NOT_MATCH_CERTIFIED_QUOTE");
    if (!sameNumber(lines.overOdds, certifiedQuote.overOdds)) reasons.push("MODEL_OVER_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
    if (!sameNumber(lines.underOdds, certifiedQuote.underOdds)) reasons.push("MODEL_UNDER_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE");
  } else {
    // The predictor has only an F5 total line and currently reuses full-game
    // prices. Until a separate F5 over/under pair is captured, this market
    // cannot be certified for model execution or saving.
    reasons.push("F5_TOTAL_EXACT_PRICES_NOT_CAPTURED");
  }

  return {
    matches: reasons.length === 0,
    reasons,
    sourceStatus: marketEvidence?.sourceStatus ?? null,
    certifiedQuote,
  };
}

export function buildMlbPregameCertifiedLinePatch(
  market: MlbPregameMarket,
  certifiedQuote: Record<string, unknown> | null,
): Partial<MlbPregameLineInputs> | null {
  if (!certifiedQuote) return null;
  const first = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = finite(certifiedQuote[key]);
      if (value != null) return value;
    }
    return null;
  };
  const text = (value: number): string => String(value);

  if (market === "ML") {
    const home = first("home", "homeOdds");
    const away = first("away", "awayOdds");
    return home != null && away != null ? { mlHome: text(home), mlAway: text(away) } : null;
  }
  if (market === "F5_ML") {
    const home = first("home", "homeOdds");
    const away = first("away", "awayOdds");
    return home != null && away != null
      ? { f5MlHome: text(home), f5MlAway: text(away), f5OddsSource: "consenso" }
      : null;
  }
  if (market === "RUN_LINE") {
    const line = first("line");
    const homeOdds = first("homeOdds");
    const awayOdds = first("awayOdds");
    return line != null && homeOdds != null && awayOdds != null
      ? { runLine: text(line), runLineHomeOdds: text(homeOdds), runLineAwayOdds: text(awayOdds) }
      : null;
  }
  if (market === "TOTAL") {
    const line = first("line");
    const overOdds = first("overOdds");
    const underOdds = first("underOdds");
    return line != null && overOdds != null && underOdds != null
      ? { totalLine: text(line), overOdds: text(overOdds), underOdds: text(underOdds) }
      : null;
  }
  return null;
}

export function mlbPregameSafetyValid(report: MlbPregameReadinessReport | null | undefined): boolean {
  return Boolean(
    report
      && report.schemaVersion === MLB_P1_M2B_READINESS_SCHEMA
      && report.contractSchemaVersion === MLB_P1_M2A_CONTRACT_SCHEMA
      && report.safety?.mode === "SHADOW_DECISION_SUPPORT"
      && report.safety?.realFinancialExposure === 0
      && report.safety?.automaticBetPlacement === false
      && report.safety?.automaticModelChangesAllowed === false
      && report.safety?.automaticPromotionAllowed === false,
  );
}

export function toMlbPregameGateSnapshot(report: MlbPregameReadinessReport): MlbPregameGateSnapshot {
  return {
    gamePk: report.game.gamePk,
    market: report.market,
    status: report.gate.status,
    analysisAllowed: report.gate.analysisAllowed && mlbPregameSafetyValid(report),
    analysisStage: report.gate.analysisStage,
    blockers: [...report.gate.blockers],
    warnings: [...report.gate.warnings],
    generatedAt: report.generatedAt,
  };
}

export function mlbPregameMarketLabel(market: MlbPregameMarket): string {
  if (market === "ML") return "Moneyline";
  if (market === "F5_ML") return "F5 Moneyline";
  if (market === "RUN_LINE") return "Run Line";
  if (market === "TOTAL") return "Total O/U";
  return "F5 Total";
}

export function mlbPregameFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    GAME_IDENTITY: "Identidad del juego",
    PITCHERS: "Pitchers",
    LINEUPS: "Lineups",
    INJURIES: "Lesiones",
    MARKET_ODDS: "Cuotas del mercado",
    BULLPEN: "Bullpen",
    PITCHER_FORM: "Forma de pitchers",
    LINEUP_MATCHUP: "Matchup de lineups",
    ENVIRONMENT: "Clima y parque",
    UMPIRE: "Umpire",
    ADVANCED_FACTORS: "Factores avanzados",
  };
  return labels[field] ?? field;
}

export function mlbPregameReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    CERTIFIED_MARKET_QUOTE_MISSING: "La respuesta no contiene la cuota certificada del mercado.",
    MODEL_HOME_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE: "La cuota local del formulario no coincide con la cuota certificada.",
    MODEL_AWAY_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE: "La cuota visitante del formulario no coincide con la cuota certificada.",
    MODEL_LINE_DOES_NOT_MATCH_CERTIFIED_QUOTE: "La línea del formulario no coincide con la línea certificada.",
    MODEL_OVER_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE: "La cuota Over del formulario no coincide con la cuota certificada.",
    MODEL_UNDER_ODDS_DO_NOT_MATCH_CERTIFIED_QUOTE: "La cuota Under del formulario no coincide con la cuota certificada.",
    F5_TOTAL_EXACT_PRICES_NOT_CAPTURED: "F5 Total permanece bloqueado hasta capturar precios Over y Under específicos de F5.",
  };
  if (labels[reason]) return labels[reason];
  return reason
    .replaceAll("_", " ")
    .replace("MISSING", "faltante")
    .replace("DEGRADED", "degradado")
    .replace("STALE", "vencido")
    .replace("CONFLICT", "en conflicto")
    .replace("UNKNOWN", "sin certificar");
}
