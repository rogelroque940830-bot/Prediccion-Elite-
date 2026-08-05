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
  game: {
    gamePk: number;
    date: string;
    state: string;
    startTime: string | null;
    homeTeam: { id?: number | null; name: string };
    awayTeam: { id?: number | null; name: string };
  };
  market: MlbPregameMarket;
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

function finite(value: string): number | null {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function americanOdds(value: string): number | null {
  const parsed = finite(value);
  if (parsed == null || Math.abs(parsed) < 100) return null;
  return Math.round(parsed);
}

function lineValue(value: string): number | null {
  return finite(value);
}

export function buildMlbPregameManualOddsParams(
  market: MlbPregameMarket,
  lines: MlbPregameLineInputs,
  capturedAt: string,
): URLSearchParams | null {
  const params = new URLSearchParams();
  params.set("oddsMode", "manual");
  params.set("manualCapturedAt", capturedAt);

  if (market === "ML") {
    const home = americanOdds(lines.mlHome);
    const away = americanOdds(lines.mlAway);
    if (home == null || away == null) return null;
    params.set("manualBook", "Hard Rock formulario");
    params.set("manualHomeOdds", String(home));
    params.set("manualAwayOdds", String(away));
    return params;
  }

  if (market === "F5_ML") {
    const home = americanOdds(lines.f5MlHome);
    const away = americanOdds(lines.f5MlAway);
    if (home == null || away == null) return null;
    params.set("manualBook", lines.f5OddsSource === "consenso" ? "Consenso F5 formulario" : "Hard Rock F5 formulario");
    params.set("manualHomeOdds", String(home));
    params.set("manualAwayOdds", String(away));
    return params;
  }

  if (market === "RUN_LINE") {
    const line = lineValue(lines.runLine);
    const home = americanOdds(lines.runLineHomeOdds);
    const away = americanOdds(lines.runLineAwayOdds);
    if (line == null || home == null || away == null) return null;
    params.set("manualBook", "Hard Rock formulario");
    params.set("manualLine", String(line));
    params.set("manualHomeOdds", String(home));
    params.set("manualAwayOdds", String(away));
    return params;
  }

  if (market === "TOTAL") {
    const line = lineValue(lines.totalLine);
    const over = americanOdds(lines.overOdds);
    const under = americanOdds(lines.underOdds);
    if (line == null || over == null || under == null) return null;
    params.set("manualBook", "Hard Rock formulario");
    params.set("manualLine", String(line));
    params.set("manualOverOdds", String(over));
    params.set("manualUnderOdds", String(under));
    return params;
  }

  // The current predictor does not collect separate F5 total prices. Never reuse
  // full-game total prices as if they belonged to the F5 market.
  return null;
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
  if (manual) {
    for (const [key, value] of manual.entries()) params.set(key, value);
  }
  return {
    url: `/api/mlb/p1/v1/pregame-readiness?${params.toString()}`,
    oddsMode: manual ? "manual" : "automatic",
  };
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
  return reason
    .replaceAll("_", " ")
    .replace("MISSING", "faltante")
    .replace("DEGRADED", "degradado")
    .replace("STALE", "vencido")
    .replace("CONFLICT", "en conflicto")
    .replace("UNKNOWN", "sin certificar");
}
