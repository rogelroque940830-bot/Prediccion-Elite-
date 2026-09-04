import type { MlbInjuryAuditSnapshot } from "./mlb-injury-audit";

export type MlbLedgerMarketType =
  | "ML"
  | "F5_ML"
  | "RUN_LINE"
  | "TOTAL"
  | "F5_TOTAL"
  | "TEAM_TOTAL"
  | "TT_OVER_15_F5"
  | "TT_UNDER_25_F5"
  | "INNING_1_ML"
  | "NRFI"
  | "YRFI"
  | "OTHER";

export type MlbSourceStatus =
  | "VERIFIED"
  | "PARTIAL"
  | "PROXY"
  | "PRIOR"
  | "MANUAL"
  | "MISSING"
  | "STALE"
  | "UNKNOWN";

export interface MlbScientificSnapshot {
  schemaVersion: "mlb-scientific-snapshot.v1";
  model: {
    name: string;
    version: string;
    gitCommit?: string;
    environment?: string;
  };
  game: {
    gamePk?: number;
    gameDate: string;
    commenceTime?: string;
    homeTeam: string;
    awayTeam: string;
    venue?: string;
  };
  market: {
    type: MlbLedgerMarketType;
    selection: string;
    line?: number;
    oddsAmerican: number;
    book?: string;
    capturedAt?: string;
  };
  probabilities: {
    model: number;
    marketImplied?: number;
    noVig?: number;
    edgePp?: number;
  };
  decision: {
    signal: "BET_FUERTE" | "BET" | "LEAN" | "PASS" | "INFO";
    confidenceLabel?: string;
    confidencePct?: number;
    stakeUnits: number;
    rationale?: string;
  };
  analysis: {
    stage: "PROVISIONAL" | "FINAL";
    warnings?: string[];
    factors?: Array<{
      name: string;
      direction: "HOME" | "AWAY" | "OVER" | "UNDER" | "FOR" | "AGAINST" | "NEUTRAL";
      magnitude?: number;
      units?: string;
      confidence?: "FULL" | "PARTIAL" | "LOW" | "UNKNOWN";
      source?: string;
      note?: string;
    }>;
    sources?: Array<{
      name: string;
      status: MlbSourceStatus;
      fetchedAt?: string;
      asOf?: string;
      sample?: number;
      latencyMs?: number;
      metadata?: Record<string, unknown>;
    }>;
    layers?: Record<string, unknown>;
    injuryAudit?: MlbInjuryAuditSnapshot;
    rawInputs?: unknown;
    rawOutput?: unknown;
  };
}

const MAX_SNAPSHOT_BYTES = 280_000;
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|session|csrf)/i;
const EARLY_MARKET_TYPES: readonly MlbLedgerMarketType[] = Object.freeze([
  "F5_ML",
  "F5_TOTAL",
  "TEAM_TOTAL",
  "TT_OVER_15_F5",
  "TT_UNDER_25_F5",
  "INNING_1_ML",
  "NRFI",
  "YRFI",
]);

interface CachedQueryStateBridge {
  data?: unknown;
  dataUpdatedAt?: number;
}

interface CachedQueryBridge {
  queryKey?: readonly unknown[];
  state?: CachedQueryStateBridge;
}

interface QueryCacheBridge {
  findAll?: (filters: { queryKey: readonly unknown[] }) => CachedQueryBridge[];
}

interface QueryClientBridge {
  getQueryCache?: () => QueryCacheBridge;
}

type CourtEdgeGlobal = typeof globalThis & {
  __COURTEDGE_QUERY_CLIENT__?: QueryClientBridge;
};

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[MAX_DEPTH]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…[TRUNCATED]` : value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 250)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(child, depth + 1);
    }
    return output;
  }
  return String(value);
}

function snapshotBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeIdentity(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]/g, "")
    : "";
}

function savedSelectionSide(
  selection: string,
  homeTeam: string,
  awayTeam: string,
): "HOME" | "AWAY" | "OVER" | "UNDER" | null {
  const normalizedSelection = normalizeIdentity(selection);
  const home = normalizeIdentity(homeTeam);
  const away = normalizeIdentity(awayTeam);
  const lower = selection.toLowerCase();
  if ((home && normalizedSelection.includes(home)) || /\b(home|local)\b/i.test(selection)) return "HOME";
  if ((away && normalizedSelection.includes(away)) || /\b(away|visitante|visit)\b/i.test(selection)) return "AWAY";
  if (lower.includes("over") || lower.includes("más")) return "OVER";
  if (lower.includes("under") || lower.includes("menos")) return "UNDER";
  return null;
}

function isEarlyMarket(type: MlbLedgerMarketType): boolean {
  return EARLY_MARKET_TYPES.includes(type);
}

function cachedEarlyEngineCapture(
  input: Omit<MlbScientificSnapshot, "schemaVersion">,
): Record<string, unknown> | undefined {
  if (!isEarlyMarket(input.market.type) || typeof globalThis === "undefined") return undefined;
  const client = (globalThis as CourtEdgeGlobal).__COURTEDGE_QUERY_CLIENT__;
  const queries = client?.getQueryCache?.().findAll?.({ queryKey: ["early-markets"] }) ?? [];
  if (!queries.length) return undefined;

  const expectedGamePk = input.game.gamePk;
  const expectedDate = input.game.gameDate;
  const expectedHome = normalizeIdentity(input.game.homeTeam);
  const expectedAway = normalizeIdentity(input.game.awayTeam);

  const matches = queries.flatMap((query) => {
    const queryKey = Array.isArray(query.queryKey) ? query.queryKey : [];
    const envelope = record(query.state?.data);
    const payload = record(envelope?.data);
    if (!payload || envelope?.success === false) return [];

    const keyGamePk = finiteInteger(queryKey[3]);
    const keyGameDate = typeof queryKey[9] === "string" ? queryKey[9] : undefined;
    if (expectedGamePk != null && keyGamePk !== expectedGamePk) return [];
    if (keyGameDate && keyGameDate !== expectedDate) return [];

    const homeEre = record(payload.homeEre);
    const awayEre = record(payload.awayEre);
    const responseHome = normalizeIdentity(homeEre?.teamName);
    const responseAway = normalizeIdentity(awayEre?.teamName);
    if (responseHome && expectedHome && responseHome !== expectedHome) return [];
    if (responseAway && expectedAway && responseAway !== expectedAway) return [];
    if (expectedGamePk == null && !responseHome && !responseAway) return [];

    const updatedAt = Number(query.state?.dataUpdatedAt ?? 0);
    return [{ queryKey, payload, updatedAt, keyGamePk, keyGameDate }];
  }).sort((left, right) => right.updatedAt - left.updatedAt);

  const selected = matches[0];
  if (!selected) return undefined;

  const markets = record(selected.payload.markets);
  const finalRecommendation = record(markets?.finalRecommendation);
  const recommendationMarket = typeof finalRecommendation?.market === "string"
    ? finalRecommendation.market
    : null;
  const recommendationSide = typeof finalRecommendation?.side === "string"
    ? finalRecommendation.side
    : null;
  const savedSide = savedSelectionSide(
    input.market.selection,
    input.game.homeTeam,
    input.game.awayTeam,
  );
  const recommendationMatchesSavedPick = recommendationMarket && recommendationSide && savedSide
    ? recommendationMarket === input.market.type && recommendationSide === savedSide
    : null;

  const observedAt = selected.updatedAt > 0
    ? new Date(selected.updatedAt).toISOString()
    : undefined;
  const savedAtMs = input.market.capturedAt ? Date.parse(input.market.capturedAt) : Date.now();
  const ageMs = selected.updatedAt > 0 && Number.isFinite(savedAtMs)
    ? Math.max(0, savedAtMs - selected.updatedAt)
    : undefined;

  return {
    schemaVersion: "mlb-early-engine-capture.v1",
    source: "react-query:/api/mlb/early-markets",
    observedAt,
    ageMsAtSavedPick: ageMs,
    freshness: ageMs == null ? "UNKNOWN" : ageMs <= 30 * 60 * 1000 ? "FRESH" : "STALE",
    identity: {
      gamePk: selected.keyGamePk ?? expectedGamePk,
      gameDate: selected.keyGameDate ?? expectedDate,
      homeTeamId: finiteInteger(selected.queryKey[1]),
      awayTeamId: finiteInteger(selected.queryKey[2]),
      homeTeam: input.game.homeTeam,
      awayTeam: input.game.awayTeam,
    },
    savedPick: {
      marketType: input.market.type,
      selection: input.market.selection,
      side: savedSide,
      line: input.market.line,
      oddsAmerican: input.market.oddsAmerican,
    },
    recommendationRelation: {
      earlyMarket: recommendationMarket,
      earlySide: recommendationSide,
      matchesSavedPick: recommendationMatchesSavedPick,
      note: recommendationMatchesSavedPick === true
        ? "The saved pick matches the cached Early/ERE finalRecommendation."
        : "Early/ERE is preserved as exact contemporaneous context; a mismatch does not rewrite the saved sporting pick.",
    },
    queryKey: selected.queryKey,
    output: selected.payload,
  };
}

export function americanImpliedProbability(odds: number): number | undefined {
  if (!Number.isFinite(odds) || odds === 0) return undefined;
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

export function noVigSideProbability(selectedOdds: number, oppositeOdds?: number): number | undefined {
  const selected = americanImpliedProbability(selectedOdds);
  const opposite = oppositeOdds == null ? undefined : americanImpliedProbability(oppositeOdds);
  if (selected == null || opposite == null || selected + opposite <= 0) return undefined;
  return selected / (selected + opposite);
}

export function mapMlbLedgerMarket(label: string): MlbLedgerMarketType {
  const normalized = label.trim().toLowerCase();
  if (normalized === "ml" || normalized.includes("moneyline")) return "ML";
  if (normalized === "f5" || normalized.includes("f5 ml")) return "F5_ML";
  if (normalized.includes("run line") || normalized.includes("runline") || normalized.includes("spread")) return "RUN_LINE";
  if (normalized.includes("f5") && (normalized.includes("o/u") || normalized.includes("total"))) return "F5_TOTAL";
  if (normalized.includes("o/u") || normalized.includes("total")) return "TOTAL";
  return "OTHER";
}

export function parseMlbMarketLine(selection: string): number | undefined {
  const matches = selection.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!matches?.length) return undefined;
  const parsed = Number(matches[matches.length - 1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isoDateTimeOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function createMlbScientificSnapshot(
  input: Omit<MlbScientificSnapshot, "schemaVersion">,
): MlbScientificSnapshot {
  const existingLayers = input.analysis.layers ?? {};
  const hasExplicitEarlyCapture = existingLayers.earlyEngine != null;
  const earlyCapture = hasExplicitEarlyCapture ? undefined : cachedEarlyEngineCapture(input);
  const missingEarlyCapture = isEarlyMarket(input.market.type)
    && !hasExplicitEarlyCapture
    && !earlyCapture;
  const enrichedInput: Omit<MlbScientificSnapshot, "schemaVersion"> = {
    ...input,
    analysis: {
      ...input.analysis,
      warnings: missingEarlyCapture
        ? [
          ...(input.analysis.warnings || []),
          "EARLY_ENGINE_CAPTURE_MISSING: this early-market pick was saved without a matching cached /api/mlb/early-markets response.",
        ]
        : input.analysis.warnings,
      layers: earlyCapture
        ? { ...existingLayers, earlyEngine: earlyCapture }
        : input.analysis.layers,
    },
  };

  const sanitized = sanitizeValue({
    schemaVersion: "mlb-scientific-snapshot.v1",
    ...enrichedInput,
  }) as MlbScientificSnapshot;

  if (snapshotBytes(sanitized) <= MAX_SNAPSHOT_BYTES) return sanitized;

  const rawInputs = sanitized.analysis.rawInputs && typeof sanitized.analysis.rawInputs === "object"
    ? sanitized.analysis.rawInputs as Record<string, unknown>
    : {};
  const rawOutput = sanitized.analysis.rawOutput && typeof sanitized.analysis.rawOutput === "object"
    ? sanitized.analysis.rawOutput as Record<string, unknown>
    : {};
  const compacted: MlbScientificSnapshot = {
    ...sanitized,
    analysis: {
      ...sanitized.analysis,
      warnings: [
        ...(sanitized.analysis.warnings || []),
        "SNAPSHOT_COMPACTED: source payloads were omitted to remain below the scientific ledger size limit.",
      ].slice(0, 100),
      rawInputs: {
        compacted: true,
        selectedDate: rawInputs.selectedDate,
        selectedGameId: rawInputs.selectedGameId,
        gamePk: rawInputs.gamePk,
        teams: rawInputs.teams,
        pitchers: rawInputs.pitchers,
        bullpens: rawInputs.bullpens,
        lines: rawInputs.lines,
        context: rawInputs.context,
        injuries: rawInputs.injuries && typeof rawInputs.injuries === "object"
          ? sanitizeValue(rawInputs.injuries, 8)
          : rawInputs.injuries,
        omitted: ["sourcePayloads"],
      },
      rawOutput: {
        compacted: true,
        factorBreakdown: rawOutput.factorBreakdown,
        pickQualities: rawOutput.pickQualities,
        bestPlay: rawOutput.bestPlay,
        safePlay: rawOutput.safePlay,
        poisson: rawOutput.poisson,
      },
    },
  };
  if (snapshotBytes(compacted) <= MAX_SNAPSHOT_BYTES) return compacted;

  return {
    ...compacted,
    analysis: {
      ...compacted.analysis,
      rawInputs: { compacted: true, omitted: ["rawInputs", "sourcePayloads"] },
      rawOutput: { compacted: true, omitted: ["rawOutput"] },
    },
  };
}
