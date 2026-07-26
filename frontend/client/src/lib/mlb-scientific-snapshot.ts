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
    rawInputs?: unknown;
    rawOutput?: unknown;
  };
}

const MAX_SNAPSHOT_BYTES = 280_000;
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|session|csrf)/i;

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
  const sanitized = sanitizeValue({
    schemaVersion: "mlb-scientific-snapshot.v1",
    ...input,
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
