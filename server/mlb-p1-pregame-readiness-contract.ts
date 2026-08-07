export const MLB_P1_M2A_SCHEMA = "courtedge-p1-m2a-pregame-readiness-contract.v1" as const;

export type MlbP1M2aMarket = "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL";

export type MlbP1M2aField =
  | "GAME_IDENTITY"
  | "PITCHERS"
  | "LINEUPS"
  | "INJURIES"
  | "MARKET_ODDS"
  | "BULLPEN"
  | "PITCHER_FORM"
  | "LINEUP_MATCHUP"
  | "ENVIRONMENT"
  | "UMPIRE"
  | "ADVANCED_FACTORS";

export type MlbP1M2aEvidenceState =
  | "FRESH"
  | "STALE"
  | "DEGRADED"
  | "MISSING"
  | "CONFLICT"
  | "UNKNOWN";

export type MlbP1M2aGateStatus = "READY_FINAL" | "READY_PROVISIONAL" | "BLOCKED";

export type MlbP1M2aAuthority =
  | "AUTHORITATIVE"
  | "VALIDATED_EXTERNAL"
  | "MARKET"
  | "DERIVED";

export type MlbP1M2aTimestampContract =
  | "EXPLICIT"
  | "REQUEST_TIME_ONLY"
  | "MISSING_UNIFORM_TIMESTAMP";

export interface MlbP1M2aSourceDefinition {
  id: string;
  field: MlbP1M2aField;
  endpoint: string;
  authority: MlbP1M2aAuthority;
  timestampContract: MlbP1M2aTimestampContract;
  currentCacheTtlSeconds: number | null;
  requiredMaxAgeSeconds: number;
  failureDisposition: "BLOCK" | "PROVISIONAL" | "WARN";
  notes: string;
}

export interface MlbP1M2aGateInput {
  market: MlbP1M2aMarket;
  gameState: "SCHEDULED" | "PREGAME" | "IN_PROGRESS" | "FINAL" | "CLOSED" | "UNKNOWN";
  evidence: Partial<Record<MlbP1M2aField, MlbP1M2aEvidenceState>>;
}

export interface MlbP1M2aGateDecision {
  schemaVersion: typeof MLB_P1_M2A_SCHEMA;
  status: MlbP1M2aGateStatus;
  analysisAllowed: boolean;
  analysisStage: "FINAL" | "PROVISIONAL" | "BLOCKED";
  blockers: string[];
  warnings: string[];
  requiredFields: MlbP1M2aField[];
}

export const MLB_P1_M2A_SOURCE_INVENTORY: readonly MlbP1M2aSourceDefinition[] = [
  {
    id: "official-daily-slate",
    field: "GAME_IDENTITY",
    endpoint: "/api/mlb/p1/v1/slate?date=YYYY-MM-DD",
    authority: "AUTHORITATIVE",
    timestampContract: "EXPLICIT",
    currentCacheTtlSeconds: 60,
    requiredMaxAgeSeconds: 600,
    failureDisposition: "BLOCK",
    notes: "MLB Stats API schedule plus feed/live by gamePk; authoritative identity and game state.",
  },
  {
    id: "official-probable-pitchers",
    field: "PITCHERS",
    endpoint: "/api/mlb/p1/v1/slate?date=YYYY-MM-DD",
    authority: "AUTHORITATIVE",
    timestampContract: "EXPLICIT",
    currentCacheTtlSeconds: 60,
    requiredMaxAgeSeconds: 600,
    failureDisposition: "BLOCK",
    notes: "Probable pitchers are resolved from feed/live to avoid doubleheader identity drift.",
  },
  {
    id: "official-lineups",
    field: "LINEUPS",
    endpoint: "/api/mlb/p1/v1/slate?date=YYYY-MM-DD",
    authority: "AUTHORITATIVE",
    timestampContract: "EXPLICIT",
    currentCacheTtlSeconds: 60,
    requiredMaxAgeSeconds: 300,
    failureDisposition: "PROVISIONAL",
    notes: "FINAL requires two official batting orders with at least nine unique players each.",
  },
  {
    id: "aggregate-analysis-payload",
    field: "ADVANCED_FACTORS",
    endpoint: "/api/mlb/all?date=YYYY-MM-DD",
    authority: "DERIVED",
    timestampContract: "MISSING_UNIFORM_TIMESTAMP",
    currentCacheTtlSeconds: 1800,
    requiredMaxAgeSeconds: 600,
    failureDisposition: "PROVISIONAL",
    notes: "Existing autoload payload; its shared 30-minute cache is longer than the desired pregame freshness window.",
  },
  {
    id: "validated-injury-feed",
    field: "INJURIES",
    endpoint: "/api/mlb/all?date=YYYY-MM-DD",
    authority: "VALIDATED_EXTERNAL",
    timestampContract: "EXPLICIT",
    currentCacheTtlSeconds: 300,
    requiredMaxAgeSeconds: 600,
    failureDisposition: "PROVISIONAL",
    notes: "BALLDONTLIE injury feed with official MLB validation metadata; stale or unavailable evidence cannot support FINAL.",
  },
  {
    id: "bullpen-availability",
    field: "BULLPEN",
    endpoint: "/api/mlb/bullpen-status/:gamePk",
    authority: "DERIVED",
    timestampContract: "EXPLICIT",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 1800,
    failureDisposition: "PROVISIONAL",
    notes: "P1-M3F1 certifies generatedAt only after active roster, season-role evidence and every required recent final-game boxscore succeed; critical source failure is fail-closed instead of an empty rested-bullpen fallback.",
  },
  {
    id: "pitcher-form-and-recent",
    field: "PITCHER_FORM",
    endpoint: "/api/mlb/pitcher-form/:gamePk + /api/mlb/pitcher-recent/:gamePk",
    authority: "DERIVED",
    timestampContract: "MISSING_UNIFORM_TIMESTAMP",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 21600,
    failureDisposition: "PROVISIONAL",
    notes: "Rest, home/road splits, recent starts and early-exit risk; recent endpoint is the current recent-ERA source of truth.",
  },
  {
    id: "lineup-matchup",
    field: "LINEUP_MATCHUP",
    endpoint: "/api/mlb/lineup-matchup/:gamePk",
    authority: "DERIVED",
    timestampContract: "MISSING_UNIFORM_TIMESTAMP",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 300,
    failureDisposition: "PROVISIONAL",
    notes: "Batter-by-batter matchup depends on the current official lineup and opposing pitcher identity.",
  },
  {
    id: "environmental-context",
    field: "ENVIRONMENT",
    endpoint: "/api/mlb/wind-park/:gamePk + /api/mlb/team-fatigue/:gamePk + /api/mlb/context",
    authority: "DERIVED",
    timestampContract: "MISSING_UNIFORM_TIMESTAMP",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 1800,
    failureDisposition: "PROVISIONAL",
    notes: "Weather, park, travel, rest and contextual adjustments; especially material for total markets.",
  },
  {
    id: "umpire-context",
    field: "UMPIRE",
    endpoint: "/api/mlb/umpire/:gamePk",
    authority: "DERIVED",
    timestampContract: "MISSING_UNIFORM_TIMESTAMP",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 1800,
    failureDisposition: "PROVISIONAL",
    notes: "Umpire run and total adjustments are loaded during autofill but do not expose a uniform freshness envelope.",
  },
  {
    id: "full-game-market-odds",
    field: "MARKET_ODDS",
    endpoint: "/api/odds/mlb?date=YYYY-MM-DD",
    authority: "MARKET",
    timestampContract: "REQUEST_TIME_ONLY",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 300,
    failureDisposition: "BLOCK",
    notes: "Hard Rock full-game ML, run line and total. Selected side, line, price, book and capture time must be preserved.",
  },
  {
    id: "f5-market-consensus",
    field: "MARKET_ODDS",
    endpoint: "/api/odds/mlb/f5?date=YYYY-MM-DD",
    authority: "MARKET",
    timestampContract: "EXPLICIT",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 300,
    failureDisposition: "BLOCK",
    notes: "Protected multi-book consensus in implied-probability space with provenance; manual overrides must be labeled explicitly.",
  },
  {
    id: "advanced-pitching-and-batting-factors",
    field: "ADVANCED_FACTORS",
    endpoint: "/api/mlb/quality/:gamePk + /api/mlb/statcast-matchup/:gamePk + /api/mlb/discipline-speed/:gamePk + /api/mlb/sos/:gamePk",
    authority: "DERIVED",
    timestampContract: "MISSING_UNIFORM_TIMESTAMP",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 21600,
    failureDisposition: "WARN",
    notes: "Statcast quality, pitch-by-pitch matchup, discipline/speed and schedule strength; absence reduces confidence but does not replace core identity evidence.",
  },
  {
    id: "supporting-matchup-factors",
    field: "ADVANCED_FACTORS",
    endpoint: "/api/mlb/archetype-matchup/:gamePk + /api/mlb/pitcher-vs-team/:gamePk + /api/mlb/park-pitcher/:gamePk + /api/mlb/catcher-framing/:gamePk + /api/mlb/rookie-pitcher/:gamePk + /api/mlb/advanced/:gamePk",
    authority: "DERIVED",
    timestampContract: "MISSING_UNIFORM_TIMESTAMP",
    currentCacheTtlSeconds: null,
    requiredMaxAgeSeconds: 21600,
    failureDisposition: "WARN",
    notes: "Supporting context is advisory unless a future market-specific policy promotes one field to conditional blocking.",
  },
] as const;

export const MLB_P1_M2A_HARD_BLOCKING_FIELDS: readonly MlbP1M2aField[] = [
  "GAME_IDENTITY",
  "PITCHERS",
  "MARKET_ODDS",
] as const;

export const MLB_P1_M2A_FINAL_ONLY_FIELDS: readonly MlbP1M2aField[] = [
  "LINEUPS",
  "INJURIES",
] as const;

export const MLB_P1_M2A_MARKET_REQUIREMENTS: Readonly<Record<MlbP1M2aMarket, readonly MlbP1M2aField[]>> = {
  ML: ["BULLPEN", "ADVANCED_FACTORS"],
  F5_ML: ["PITCHER_FORM", "LINEUP_MATCHUP"],
  RUN_LINE: ["BULLPEN", "ADVANCED_FACTORS"],
  TOTAL: ["BULLPEN", "ENVIRONMENT", "UMPIRE", "ADVANCED_FACTORS"],
  F5_TOTAL: ["PITCHER_FORM", "ENVIRONMENT", "UMPIRE"],
};

export const MLB_P1_M2A_AUDIT_FINDINGS = [
  {
    code: "NO_SINGLE_PREGAME_READINESS_CONTRACT",
    severity: "BLOCKING_FOR_M2B",
    finding: "P1-M1 classifies official identity, pitchers and lineups, while the advanced analysis loads the remaining sources independently.",
  },
  {
    code: "AGGREGATE_CACHE_EXCEEDS_DESIRED_FRESHNESS",
    severity: "BLOCKING_FOR_FINAL",
    finding: "/api/mlb/all uses a shared 30-minute cache although lineups, injuries and market inputs require shorter pregame windows.",
  },
  {
    code: "FACTOR_ENDPOINTS_LACK_UNIFORM_TIMESTAMPS",
    severity: "BLOCKING_FOR_FINAL",
    finding: "Most detailed factor endpoints do not expose a common observedAt, source status and stale flag envelope.",
  },
  {
    code: "ODDS_LOADING_REMAINS_EXPLICIT_AND_SEPARATE",
    severity: "EXPECTED_USER_CONTROL",
    finding: "Full-game and F5 market prices are loaded separately and must be tied to the selected game, market and capture time before prediction.",
  },
  {
    code: "SILENT_FACTOR_DEGRADATION",
    severity: "REQUIRES_VISIBLE_WARNING",
    finding: "The current autofill tolerates individual factor failures by setting null values; P1-M2 must surface those failures instead of hiding them.",
  },
] as const;

export function classifyMlbP1M2aFreshness(input: {
  observedAt: string | null | undefined;
  now: Date;
  maxAgeSeconds: number;
}): "FRESH" | "STALE" | "UNKNOWN" {
  if (!input.observedAt) return "UNKNOWN";
  const observedMs = Date.parse(input.observedAt);
  if (!Number.isFinite(observedMs)) return "UNKNOWN";
  const ageMs = input.now.getTime() - observedMs;
  if (ageMs < -60_000) return "UNKNOWN";
  return ageMs <= input.maxAgeSeconds * 1000 ? "FRESH" : "STALE";
}

function evidenceState(input: MlbP1M2aGateInput, field: MlbP1M2aField): MlbP1M2aEvidenceState {
  return input.evidence[field] ?? "MISSING";
}

function isHardFailure(state: MlbP1M2aEvidenceState): boolean {
  return state !== "FRESH";
}

function isFinalFailure(state: MlbP1M2aEvidenceState): boolean {
  return state !== "FRESH";
}

export function decideMlbP1M2aPregameGate(input: MlbP1M2aGateInput): MlbP1M2aGateDecision {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const requiredFields = Array.from(new Set([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS[input.market],
  ]));

  if (!["SCHEDULED", "PREGAME"].includes(input.gameState)) {
    blockers.push(`GAME_STATE_${input.gameState}`);
  }

  for (const field of MLB_P1_M2A_HARD_BLOCKING_FIELDS) {
    const state = evidenceState(input, field);
    if (isHardFailure(state)) blockers.push(`${field}_${state}`);
  }

  if (blockers.length > 0) {
    return {
      schemaVersion: MLB_P1_M2A_SCHEMA,
      status: "BLOCKED",
      analysisAllowed: false,
      analysisStage: "BLOCKED",
      blockers,
      warnings,
      requiredFields,
    };
  }

  for (const field of [...MLB_P1_M2A_FINAL_ONLY_FIELDS, ...MLB_P1_M2A_MARKET_REQUIREMENTS[input.market]]) {
    const state = evidenceState(input, field);
    if (isFinalFailure(state)) warnings.push(`${field}_${state}`);
  }

  if (warnings.length > 0) {
    return {
      schemaVersion: MLB_P1_M2A_SCHEMA,
      status: "READY_PROVISIONAL",
      analysisAllowed: true,
      analysisStage: "PROVISIONAL",
      blockers,
      warnings,
      requiredFields,
    };
  }

  return {
    schemaVersion: MLB_P1_M2A_SCHEMA,
    status: "READY_FINAL",
    analysisAllowed: true,
    analysisStage: "FINAL",
    blockers,
    warnings,
    requiredFields,
  };
}
