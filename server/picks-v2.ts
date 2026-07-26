import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Express } from "express";
import { z } from "zod";
import { computeCLV, getAllSnapshots, type LineSnapshot } from "./sharp-signals";
import { getMlbLedgerStore } from "./mlb-ledger";

const DATA_DIR = path.join(process.cwd(), "data");
const PICKS_FILE = path.join(DATA_DIR, "picks.json");

const idPattern = /^[A-Za-z0-9._:-]{1,120}$/;
const sportSchema = z.enum(["mlb", "nba", "nhl", "wnba"]);

const savedPickSchema = z.object({
  id: z.string().regex(idPattern).optional(),
  ts: z.number().int().positive().optional(),
  sport: sportSchema,
  homeTeam: z.string().trim().min(1).max(120),
  awayTeam: z.string().trim().min(1).max(120),
  pickType: z.string().trim().min(1).max(80),
  pickSide: z.string().trim().min(1).max(160),
  confidence: z.number().finite().min(0).max(100),
  edge: z.number().finite().optional(),
  odds: z.union([z.string().max(24), z.number().finite()]).optional(),
  line: z.string().max(80).optional(),
  notes: z.string().max(2_000).optional(),
  source: z.enum(["app", "manual", "migration"]).optional(),
  clientId: z.number().int().positive().optional(),
  date: z.string().max(40).optional(),
  team: z.string().max(120).optional(),
  opponent: z.string().max(120).optional(),
  market: z.string().max(120).optional(),
  pick: z.string().max(200).optional(),
  modelProb: z.number().finite().min(0).max(100).optional(),
  impliedProb: z.number().finite().min(0).max(100).optional(),
  stake: z.number().finite().min(0).optional(),
  result: z.string().max(12).optional(),
  profit: z.number().finite().optional(),
  closingOdds: z.number().finite().optional(),
  closingImpliedProb: z.number().finite().min(0).max(100).optional(),
  clvPercent: z.number().finite().optional(),
}).strict();

const patchSchema = savedPickSchema
  .omit({ id: true, ts: true, sport: true, homeTeam: true, awayTeam: true, pickType: true, pickSide: true, confidence: true })
  .partial()
  .extend({
    sport: sportSchema.optional(),
    homeTeam: z.string().trim().min(1).max(120).optional(),
    awayTeam: z.string().trim().min(1).max(120).optional(),
    pickType: z.string().trim().min(1).max(80).optional(),
    pickSide: z.string().trim().min(1).max(160).optional(),
    confidence: z.number().finite().min(0).max(100).optional(),
  })
  .strict();

export type SavedPickV2 = z.infer<typeof savedPickSchema> & { id: string; ts: number };

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadPicks(): SavedPickV2[] {
  ensureDataDir();
  if (!fs.existsSync(PICKS_FILE)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(PICKS_FILE, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedPickV2 => {
      return Boolean(item && typeof item.id === "string" && typeof item.ts === "number");
    });
  } catch (error) {
    console.error("picks-v2 load failed", error);
    return [];
  }
}

function savePicks(picks: SavedPickV2[]): void {
  ensureDataDir();
  const tempFile = `${PICKS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(picks, null, 2), "utf-8");
  fs.renameSync(tempFile, PICKS_FILE);
}

function generatedId(): string {
  return `p-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

function parseAmericanOdds(value: string | number | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim().replace(/^\+/, ""));
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function impliedProbabilityPercent(odds: number): number {
  const probability = odds > 0 ? 100 / (odds + 100) : -odds / (-odds + 100);
  return Math.round(probability * 10_000) / 100;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function snapshotCommence(snapshot: LineSnapshot): number | null {
  const lastAt = snapshot.gameKey.lastIndexOf("@");
  if (lastAt < 0) return null;
  const value = Date.parse(snapshot.gameKey.slice(lastAt + 1));
  return Number.isFinite(value) ? value : null;
}

function snapshotsForPick(pick: SavedPickV2, all: LineSnapshot[]): LineSnapshot[] {
  const exactPrefix = `${pick.awayTeam}@${pick.homeTeam}@`;
  const exact = all.filter((snapshot) => snapshot.sport === pick.sport && snapshot.gameKey.startsWith(exactPrefix));
  if (exact.length > 0) return exact;

  const home = normalize(pick.homeTeam);
  const away = normalize(pick.awayTeam);
  return all.filter((snapshot) => {
    if (snapshot.sport !== pick.sport) return false;
    const firstAt = snapshot.gameKey.indexOf("@");
    const lastAt = snapshot.gameKey.lastIndexOf("@");
    if (firstAt < 0 || lastAt <= firstAt) return false;
    const snapshotAway = normalize(snapshot.gameKey.slice(0, firstAt));
    const snapshotHome = normalize(snapshot.gameKey.slice(firstAt + 1, lastAt));
    return snapshotAway === away && snapshotHome === home;
  });
}

function closingSnapshotForPick(pick: SavedPickV2, all: LineSnapshot[]): LineSnapshot | null {
  const candidates = snapshotsForPick(pick, all);
  if (candidates.length === 0) return null;

  const commence = snapshotCommence(candidates[0]);
  if (commence == null) return [...candidates].sort((a, b) => b.ts - a.ts)[0] || null;

  const before = candidates.filter((snapshot) => snapshot.ts <= commence).sort((a, b) => b.ts - a.ts);
  if (before.length > 0) return before[0];

  return [...candidates].sort((a, b) => Math.abs(a.ts - commence) - Math.abs(b.ts - commence))[0] || null;
}

function closingOddsForPick(pick: SavedPickV2, snapshot: LineSnapshot): number | null {
  const market = pick.pickType.toLowerCase();
  const side = normalize(pick.pickSide);
  const home = normalize(pick.homeTeam);
  const away = normalize(pick.awayTeam);

  const homeSide = side.includes("home") || side.includes("local") || side.includes(home);
  const awaySide = side.includes("away") || side.includes("visit") || side.includes(away);

  if ((market === "ml" || market.includes("moneyline")) && snapshot.ml) {
    if (homeSide) return snapshot.ml.home;
    if (awaySide) return snapshot.ml.away;
  }

  if ((market.includes("spread") || market.includes("runline") || market.includes("run line")) && snapshot.spread) {
    if (homeSide) return snapshot.spread.homeOdds;
    if (awaySide) return snapshot.spread.awayOdds;
  }

  if ((market.includes("total") || market.includes("o/u") || market.includes("over") || market.includes("under")) && snapshot.total) {
    if (side.includes("over")) return snapshot.total.overOdds;
    if (side.includes("under")) return snapshot.total.underOdds;
  }

  return null;
}

function parseNumberQuery(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapLedgerMarket(pickType: string): "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL" | "OTHER" {
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

function normalizedModelProbability(pick: SavedPickV2): number {
  const raw = pick.modelProb ?? pick.confidence;
  const probability = raw > 1 ? raw / 100 : raw;
  return Math.min(0.999, Math.max(0.001, probability));
}

function normalizedOptionalProbability(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const probability = value > 1 ? value / 100 : value;
  return probability > 0 && probability < 1 ? probability : undefined;
}

function mirrorMlbPickToScientificLedger(pick: SavedPickV2): void {
  if (pick.sport !== "mlb") return;
  const parsedOdds = parseAmericanOdds(pick.odds);
  if (parsedOdds == null) {
    console.warn(`[mlb-ledger] pick ${pick.id} not mirrored: missing valid American odds`);
    return;
  }

  const gameDate = /^\d{4}-\d{2}-\d{2}$/.test(pick.date || "")
    ? String(pick.date)
    : new Date(pick.ts).toISOString().slice(0, 10);
  const modelProbability = normalizedModelProbability(pick);
  const impliedProbability = normalizedOptionalProbability(pick.impliedProb);

  getMlbLedgerStore().appendPrediction({
    schemaVersion: "mlb-ledger.v1",
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
      oddsAmerican: Math.round(parsedOdds),
      book: pick.source === "manual" ? "Manual" : undefined,
      capturedAt: new Date(pick.ts).toISOString(),
    },
    probabilities: {
      model: modelProbability,
      marketImplied: impliedProbability,
      edgePp: pick.edge,
    },
    decision: {
      signal: "INFO",
      confidenceLabel: "LEGACY_SAVED_PICK",
      confidencePct: pick.confidence,
      stakeUnits: pick.stake ?? 0,
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
      rawInputs: pick,
      rawOutput: {
        pickType: pick.pickType,
        pickSide: pick.pickSide,
        confidence: pick.confidence,
        edge: pick.edge,
      },
    },
  });
}

export function registerPicksV2Routes(app: Express): void {
  app.get("/api/picks/v2", (req, res) => {
    const sport = typeof req.query.sport === "string" ? req.query.sport.toLowerCase() : undefined;
    const days = parseNumberQuery(req.query.days);
    const minConfidence = parseNumberQuery(req.query.minConfidence);
    const cutoff = days != null && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

    const data = loadPicks()
      .filter((pick) => !sport || pick.sport === sport)
      .filter((pick) => cutoff == null || pick.ts >= cutoff)
      .filter((pick) => minConfidence == null || pick.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence || b.ts - a.ts);

    res.json({ success: true, data });
  });

  app.post("/api/picks/v2", (req, res) => {
    const parsed = savedPickSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid pick payload", details: parsed.error.flatten() });
      return;
    }

    const pick: SavedPickV2 = {
      ...parsed.data,
      id: parsed.data.id || generatedId(),
      ts: parsed.data.ts || Date.now(),
    };

    const picks = loadPicks();
    const existingIndex = picks.findIndex((item) => item.id === pick.id);
    if (existingIndex >= 0) picks[existingIndex] = { ...picks[existingIndex], ...pick };
    else picks.push(pick);
    savePicks(picks);

    try {
      mirrorMlbPickToScientificLedger(pick);
    } catch (error) {
      // The editable user history remains available even if scientific mirroring fails.
      // The ledger error is visible in logs and can be repaired with an explicit backfill.
      console.error(`[mlb-ledger] mirror failed for canonical pick ${pick.id}`, error);
    }

    res.status(existingIndex >= 0 ? 200 : 201).json({ success: true, data: pick });
  });

  app.patch("/api/picks/v2/:id", (req, res) => {
    const id = decodeURIComponent(req.params.id || "");
    if (!idPattern.test(id)) {
      res.status(400).json({ success: false, error: "Invalid pick id" });
      return;
    }

    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid pick patch", details: parsed.error.flatten() });
      return;
    }

    const picks = loadPicks();
    const index = picks.findIndex((item) => item.id === id);
    if (index < 0) {
      res.status(404).json({ success: false, error: "Pick not found" });
      return;
    }

    picks[index] = { ...picks[index], ...parsed.data, id: picks[index].id, ts: picks[index].ts };
    savePicks(picks);
    res.json({ success: true, data: picks[index] });
  });

  app.delete("/api/picks/v2/:id", (req, res) => {
    const id = decodeURIComponent(req.params.id || "");
    if (!idPattern.test(id)) {
      res.status(400).json({ success: false, error: "Invalid pick id" });
      return;
    }

    const picks = loadPicks();
    const next = picks.filter((item) => item.id !== id);
    if (next.length === picks.length) {
      res.status(404).json({ success: false, error: "Pick not found" });
      return;
    }

    savePicks(next);
    res.json({ success: true });
  });

  app.post("/api/clv/refresh", (_req, res) => {
    const picks = loadPicks();
    const snapshots = getAllSnapshots();
    let updated = 0;

    const next = picks.map((pick) => {
      if (pick.clvPercent != null && pick.closingOdds != null) return pick;
      const bettingOdds = parseAmericanOdds(pick.odds);
      if (bettingOdds == null) return pick;

      const closingSnapshot = closingSnapshotForPick(pick, snapshots);
      if (!closingSnapshot) return pick;
      const closingOdds = closingOddsForPick(pick, closingSnapshot);
      if (closingOdds == null) return pick;

      const clv = computeCLV(bettingOdds, closingOdds, pick.id, pick.pickType);
      updated += 1;
      return {
        ...pick,
        closingOdds,
        closingImpliedProb: impliedProbabilityPercent(closingOdds),
        clvPercent: clv.clvPct,
      };
    });

    if (updated > 0) savePicks(next);
    res.json({ success: true, updated, totalProcessed: picks.length });
  });
}
