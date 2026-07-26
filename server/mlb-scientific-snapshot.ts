import crypto from "crypto";
import { z } from "zod";
import {
  MLB_LEDGER_SCHEMA_VERSION,
  mlbPredictionInputSchema,
  type MlbPredictionInput,
} from "./mlb-ledger-store";

const MAX_SNAPSHOT_BYTES = 300_000;
const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|session|csrf)/i;

export const mlbScientificSnapshotSchema = mlbPredictionInputSchema
  .omit({
    schemaVersion: true,
    clientRequestId: true,
    source: true,
    supersedesId: true,
  })
  .extend({
    schemaVersion: z.literal("mlb-scientific-snapshot.v1"),
  })
  .strict();

export type MlbScientificSnapshot = z.infer<typeof mlbScientificSnapshotSchema>;

export interface SavedMlbPickLike {
  id: string;
  ts: number;
  sport?: "mlb" | "nba" | "nhl" | "wnba";
  homeTeam: string;
  awayTeam: string;
  pickType: string;
  pickSide: string;
  confidence: number;
  edge?: number;
  odds?: string | number;
  line?: string;
  notes?: string;
  source?: "app" | "manual" | "migration";
  date?: string;
  modelProb?: number;
  impliedProb?: number;
  stake?: number;
  scientificSnapshot?: MlbScientificSnapshot;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseAmericanOdds(value: string | number | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value !== 0 ? Math.round(value) : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim().replace(/^\+/, ""));
  return Number.isFinite(parsed) && parsed !== 0 ? Math.round(parsed) : null;
}

function normalizedProbability(value: number): number {
  const probability = value > 1 ? value / 100 : value;
  return Math.min(0.999, Math.max(0.001, probability));
}

function optionalProbability(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const probability = value > 1 ? value / 100 : value;
  return probability > 0 && probability < 1 ? probability : undefined;
}

function mapLedgerMarket(pickType: string): MlbPredictionInput["market"]["type"] {
  const normalized = pickType.trim().toLowerCase();
  if (normalized === "ml" || normalized.includes("moneyline")) return "ML";
  if (normalized === "f5" || normalized.includes("f5 ml")) return "F5_ML";
  if (normalized.includes("run line") || normalized.includes("runline") || normalized.includes("spread")) return "RUN_LINE";
  if (normalized.includes("f5") && (normalized.includes("o/u") || normalized.includes("total"))) return "F5_TOTAL";
  if (normalized.includes("o/u") || normalized.includes("total")) return "TOTAL";
  return "OTHER";
}

function parseLineNumber(line: string | undefined): number | undefined {
  if (!line) return undefined;
  const matches = line.match(/[+-]?\d+(?:\.\d+)?/g);
  if (!matches?.length) return undefined;
  const value = Number(matches[matches.length - 1]);
  return Number.isFinite(value) ? value : undefined;
}

export function canonicalMlbPickFingerprint(pick: SavedMlbPickLike): string {
  const odds = parseAmericanOdds(pick.odds);
  const gameDate = /^\d{4}-\d{2}-\d{2}$/.test(pick.date || "")
    ? String(pick.date)
    : new Date(pick.ts).toISOString().slice(0, 10);
  const identity = JSON.stringify({
    sport: pick.sport,
    gameDate,
    homeTeam: normalize(pick.homeTeam),
    awayTeam: normalize(pick.awayTeam),
    market: mapLedgerMarket(pick.pickType),
    selection: normalize(pick.pickSide),
    line: parseLineNumber(pick.line || pick.pickSide),
    odds,
    modelProbability: Math.round(normalizedProbability(pick.modelProb ?? pick.confidence) * 100_000) / 100_000,
  });
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[MAX_DEPTH]";
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…[TRUNCATED]` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeValue(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 250)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeValue(child, depth + 1);
    }
    return output;
  }
  return String(value);
}

function sanitizeSnapshot(snapshot: MlbScientificSnapshot): MlbScientificSnapshot {
  const sanitized = sanitizeValue(snapshot) as MlbScientificSnapshot;
  const size = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (size > MAX_SNAPSHOT_BYTES) {
    const error = new Error(`MLB scientific snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes (${size})`);
    (error as Error & { status?: number }).status = 413;
    throw error;
  }
  return mlbScientificSnapshotSchema.parse(sanitized);
}

function assertSnapshotMatchesPick(pick: SavedMlbPickLike, snapshot: MlbScientificSnapshot): void {
  if (normalize(snapshot.game.homeTeam) !== normalize(pick.homeTeam)
    || normalize(snapshot.game.awayTeam) !== normalize(pick.awayTeam)) {
    const error = new Error("Scientific snapshot venue orientation does not match canonical Picks V2 orientation");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  const odds = parseAmericanOdds(pick.odds);
  if (odds == null || snapshot.market.oddsAmerican !== odds) {
    const error = new Error("Scientific snapshot odds do not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  if (normalize(snapshot.market.selection) !== normalize(pick.pickSide)) {
    const error = new Error("Scientific snapshot selection does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  const expectedDate = /^\d{4}-\d{2}-\d{2}$/.test(pick.date || "")
    ? String(pick.date)
    : new Date(pick.ts).toISOString().slice(0, 10);
  if (snapshot.game.gameDate !== expectedDate) {
    const error = new Error("Scientific snapshot game date does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }
  if (snapshot.market.type !== mapLedgerMarket(pick.pickType)) {
    const error = new Error("Scientific snapshot market type does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }

  if (snapshot.analysis.stage === "FINAL") {
    if (!snapshot.game.gamePk || !snapshot.game.commenceTime || !snapshot.market.capturedAt) {
      const error = new Error("FINAL scientific snapshots require gamePk, commenceTime and capturedAt");
      (error as Error & { status?: number }).status = 409;
      throw error;
    }
    if (Date.parse(snapshot.market.capturedAt) > Date.parse(snapshot.game.commenceTime)) {
      const error = new Error("FINAL scientific snapshot was captured after the official game start");
      (error as Error & { status?: number }).status = 409;
      throw error;
    }
  }

  const canonicalModel = normalizedProbability(pick.modelProb ?? pick.confidence);
  if (Math.abs(snapshot.probabilities.model - canonicalModel) > 0.002) {
    const error = new Error("Scientific snapshot model probability does not match the canonical saved pick");
    (error as Error & { status?: number }).status = 409;
    throw error;
  }
}

function fullSnapshotPrediction(pick: SavedMlbPickLike): MlbPredictionInput {
  const snapshot = sanitizeSnapshot(mlbScientificSnapshotSchema.parse(pick.scientificSnapshot));
  assertSnapshotMatchesPick(pick, snapshot);

  return mlbPredictionInputSchema.parse({
    schemaVersion: MLB_LEDGER_SCHEMA_VERSION,
    clientRequestId: `picks-v2:${pick.id}`,
    source: "app",
    model: {
      ...snapshot.model,
      gitCommit: snapshot.model.gitCommit
        || process.env.RAILWAY_GIT_COMMIT_SHA
        || process.env.GIT_COMMIT_SHA
        || undefined,
      environment: snapshot.model.environment
        || process.env.RAILWAY_ENVIRONMENT_NAME
        || process.env.NODE_ENV
        || undefined,
    },
    game: snapshot.game,
    market: snapshot.market,
    probabilities: snapshot.probabilities,
    decision: snapshot.decision,
    analysis: snapshot.analysis,
  });
}

function provisionalMirrorPrediction(pick: SavedMlbPickLike): MlbPredictionInput {
  const parsedOdds = parseAmericanOdds(pick.odds);
  if (parsedOdds == null) {
    const error = new Error(`pick ${pick.id} cannot be mirrored: missing valid American odds`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }

  const gameDate = /^\d{4}-\d{2}-\d{2}$/.test(pick.date || "")
    ? String(pick.date)
    : new Date(pick.ts).toISOString().slice(0, 10);

  return mlbPredictionInputSchema.parse({
    schemaVersion: MLB_LEDGER_SCHEMA_VERSION,
    clientRequestId: `picks-v2:${pick.id}`,
    source: "app",
    model: {
      name: "CourtEdge MLB",
      version: "picks-v2-mirror-v1",
    },
    game: {
      gameDate,
      homeTeam: pick.homeTeam,
      awayTeam: pick.awayTeam,
    },
    market: {
      type: mapLedgerMarket(pick.pickType),
      selection: pick.pickSide,
      line: parseLineNumber(pick.line || pick.pickSide),
      oddsAmerican: parsedOdds,
      book: pick.source === "manual" ? "Manual" : undefined,
      capturedAt: new Date(pick.ts).toISOString(),
    },
    probabilities: {
      model: normalizedProbability(pick.modelProb ?? pick.confidence),
      marketImplied: optionalProbability(pick.impliedProb),
      edgePp: pick.edge,
    },
    decision: {
      signal: "INFO",
      confidenceLabel: "LEGACY_SAVED_PICK",
      confidencePct: pick.confidence,
      stakeUnits: Math.min(100, Math.max(0, pick.stake ?? 0)),
      rationale: "Immutable mirror of a user-selected canonical MLB history pick. Exact model authorization was not present in the legacy save payload.",
    },
    analysis: {
      stage: "PROVISIONAL",
      warnings: [
        "Legacy picks-v2 mirror: full factor snapshot and final authorization were not included in the original save payload.",
      ],
      sources: [
        {
          name: "Canonical Picks V2",
          status: "MANUAL",
          fetchedAt: new Date(pick.ts).toISOString(),
          metadata: { canonicalPickId: pick.id },
        },
      ],
      rawInputs: sanitizeValue(pick),
      rawOutput: {
        pickType: pick.pickType,
        pickSide: pick.pickSide,
        confidence: pick.confidence,
        edge: pick.edge,
      },
    },
  });
}

export function buildMlbLedgerPredictionFromPick(pick: SavedMlbPickLike): MlbPredictionInput {
  if (pick.sport !== "mlb") {
    throw new Error("Only MLB picks can be converted to the MLB scientific ledger");
  }
  return pick.scientificSnapshot ? fullSnapshotPrediction(pick) : provisionalMirrorPrediction(pick);
}

export function containsSensitiveSnapshotValue(value: unknown): boolean {
  return JSON.stringify(value).includes("[REDACTED]");
}
