import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Express, Request } from "express";
import { z } from "zod";
import { computeCLV, getAllSnapshots, type LineSnapshot } from "./sharp-signals";
import { getMlbLedgerStore } from "./mlb-ledger";
import {
  appendOwnedPrediction,
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import {
  buildMlbLedgerPredictionFromPick,
  canonicalMlbPickFingerprint,
  findMlbSupersedesId,
} from "./mlb-scientific-snapshot";
import {
  getRequestIdentity,
  requireOwnDataWriteRole,
  resolveRequestUserId,
} from "./user-data-context";
import { savedPickSchema, type SavedPickV2 } from "./picks-v2";

const DEFAULT_PICKS_FILE = path.join(process.cwd(), "data", "picks.json");
const idPattern = /^[A-Za-z0-9._:-]{1,120}$/;
const sportSchema = z.enum(["mlb", "nba", "nhl", "wnba"]);

const patchSchema = savedPickSchema
  .omit({
    id: true,
    ts: true,
    sport: true,
    homeTeam: true,
    awayTeam: true,
    pickType: true,
    pickSide: true,
    confidence: true,
    scientificSnapshot: true,
  })
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

export type StoredPickV2 = SavedPickV2 & { userId: number };

function positiveUserId(value: unknown, fallback?: number): number {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  if (fallback && Number.isInteger(fallback) && fallback > 0) return fallback;
  throw new Error("Invalid pick owner user id");
}

function generatedId(): string {
  return `p-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

export class UserPickFileStore {
  constructor(private readonly filename = process.env.COURTEDGE_PICKS_FILE || DEFAULT_PICKS_FILE) {}

  private ensureParent(): void {
    fs.mkdirSync(path.dirname(path.resolve(this.filename)), { recursive: true });
  }

  private write(picks: StoredPickV2[]): void {
    this.ensureParent();
    const tempFile = `${this.filename}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(picks, null, 2), "utf-8");
    fs.renameSync(tempFile, this.filename);
  }

  load(defaultOwnerUserId: number): StoredPickV2[] {
    const fallback = positiveUserId(defaultOwnerUserId);
    this.ensureParent();
    if (!fs.existsSync(this.filename)) return [];

    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, "utf-8"));
      if (!Array.isArray(parsed)) return [];
      let migrated = false;
      const data = parsed
        .filter((item) => item && typeof item.id === "string" && typeof item.ts === "number")
        .map((item) => {
          const userId = positiveUserId(item.userId, fallback);
          if (item.userId !== userId) migrated = true;
          return { ...item, userId } as StoredPickV2;
        });
      if (migrated) this.write(data);
      return data;
    } catch (error) {
      console.error("multiuser picks load failed", error);
      return [];
    }
  }

  listForUser(userId: number, defaultOwnerUserId: number): StoredPickV2[] {
    const owner = positiveUserId(userId);
    return this.load(defaultOwnerUserId).filter((pick) => pick.userId === owner);
  }

  upsert(
    pick: SavedPickV2,
    userId: number,
    defaultOwnerUserId: number,
  ): { data: StoredPickV2; created: boolean; previous: StoredPickV2[] } {
    const owner = positiveUserId(userId);
    const previous = this.load(defaultOwnerUserId);
    const next = previous.map((item) => ({ ...item }));
    const stored = { ...pick, userId: owner } as StoredPickV2;
    const index = next.findIndex((item) => item.id === pick.id && item.userId === owner);
    if (index >= 0) next[index] = { ...next[index], ...stored, userId: owner };
    else next.push(stored);
    this.write(next);
    return { data: stored, created: index < 0, previous };
  }

  restore(picks: StoredPickV2[]): void {
    this.write(picks);
  }

  patch(
    id: string,
    userId: number,
    patch: Record<string, unknown>,
    defaultOwnerUserId: number,
  ): StoredPickV2 | null {
    const owner = positiveUserId(userId);
    const picks = this.load(defaultOwnerUserId);
    const index = picks.findIndex((item) => item.id === id && item.userId === owner);
    if (index < 0) return null;
    picks[index] = {
      ...picks[index],
      ...patch,
      id: picks[index].id,
      ts: picks[index].ts,
      userId: owner,
    } as StoredPickV2;
    this.write(picks);
    return picks[index];
  }

  delete(id: string, userId: number, defaultOwnerUserId: number): boolean {
    const owner = positiveUserId(userId);
    const picks = this.load(defaultOwnerUserId);
    const next = picks.filter((item) => !(item.id === id && item.userId === owner));
    if (next.length === picks.length) return false;
    this.write(next);
    return true;
  }

  migrationStatus(defaultOwnerUserId: number): {
    records: number;
    owners: number;
    unowned: number;
  } {
    const picks = this.load(defaultOwnerUserId);
    return {
      records: picks.length,
      owners: new Set(picks.map((pick) => pick.userId)).size,
      unowned: picks.filter((pick) => !Number.isInteger(pick.userId) || pick.userId <= 0).length,
    };
  }
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

function snapshotsForPick(pick: StoredPickV2, all: LineSnapshot[]): LineSnapshot[] {
  const exactPrefix = `${pick.awayTeam}@${pick.homeTeam}@`;
  const exact = all.filter(
    (snapshot) => snapshot.sport === pick.sport && snapshot.gameKey.startsWith(exactPrefix),
  );
  if (exact.length > 0) return exact;

  const home = normalize(pick.homeTeam);
  const away = normalize(pick.awayTeam);
  return all.filter((snapshot) => {
    if (snapshot.sport !== pick.sport) return false;
    const firstAt = snapshot.gameKey.indexOf("@");
    const lastAt = snapshot.gameKey.lastIndexOf("@");
    if (firstAt < 0 || lastAt <= firstAt) return false;
    return (
      normalize(snapshot.gameKey.slice(0, firstAt)) === away &&
      normalize(snapshot.gameKey.slice(firstAt + 1, lastAt)) === home
    );
  });
}

function closingSnapshotForPick(pick: StoredPickV2, all: LineSnapshot[]): LineSnapshot | null {
  const candidates = snapshotsForPick(pick, all);
  if (candidates.length === 0) return null;
  const commence = snapshotCommence(candidates[0]);
  if (commence == null) return [...candidates].sort((a, b) => b.ts - a.ts)[0] || null;
  const before = candidates
    .filter((snapshot) => snapshot.ts <= commence)
    .sort((a, b) => b.ts - a.ts);
  return before[0] || null;
}

function closingOddsForPick(pick: StoredPickV2, snapshot: LineSnapshot): number | null {
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
  if (
    (market.includes("spread") || market.includes("runline") || market.includes("run line")) &&
    snapshot.spread
  ) {
    if (homeSide) return snapshot.spread.homeOdds;
    if (awaySide) return snapshot.spread.awayOdds;
  }
  if (
    (market.includes("total") || market.includes("o/u") || market.includes("over") || market.includes("under")) &&
    snapshot.total
  ) {
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

function ownershipSource(req: Request): "session" | "service" {
  return getRequestIdentity(req) ? "session" : "service";
}

function mirrorMlbPickToScientificLedger(pick: SavedPickV2, userId: number, req: Request): void {
  if (pick.sport !== "mlb") return;
  const store = getMlbLedgerStore();
  const ownershipStore = getMlbLedgerOwnershipStore();
  const prediction = buildMlbLedgerPredictionFromPick(
    pick as Parameters<typeof buildMlbLedgerPredictionFromPick>[0],
  );
  const records = ownedRecordsForUser(store, ownershipStore, userId, {
    from: prediction.game.gameDate,
    to: prediction.game.gameDate,
    market: prediction.market.type,
    limit: 1_000,
  });
  const supersedesId = pick.scientificSnapshot
    ? findMlbSupersedesId(records, prediction)
    : undefined;
  appendOwnedPrediction(
    store,
    ownershipStore,
    supersedesId ? { ...prediction, supersedesId } : prediction,
    userId,
    ownershipSource(req),
  );
}

let singletonPickStore: UserPickFileStore | undefined;

export function getUserPickFileStore(): UserPickFileStore {
  if (!singletonPickStore) singletonPickStore = new UserPickFileStore();
  return singletonPickStore;
}

export function registerPicksV2MultiuserRoutes(
  app: Express,
  defaultOwnerUserId: number,
  pickStore = getUserPickFileStore(),
): void {
  pickStore.load(defaultOwnerUserId);

  app.get("/api/picks/v2", (req, res) => {
    const userId = resolveRequestUserId(req);
    const sport = typeof req.query.sport === "string" ? req.query.sport.toLowerCase() : undefined;
    const days = parseNumberQuery(req.query.days);
    const minConfidence = parseNumberQuery(req.query.minConfidence);
    const cutoff = days != null && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
    const data = pickStore
      .listForUser(userId, defaultOwnerUserId)
      .filter((pick) => !sport || pick.sport === sport)
      .filter((pick) => cutoff == null || pick.ts >= cutoff)
      .filter((pick) => minConfidence == null || pick.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence || b.ts - a.ts);
    res.json({ success: true, data, userId });
  });

  app.post("/api/picks/v2", requireOwnDataWriteRole, (req, res) => {
    const userId = resolveRequestUserId(req);
    const parsed = savedPickSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issuePath = firstIssue?.path?.length ? firstIssue.path.join(".") : "payload";
      const issueMessage = firstIssue?.message || "validation failed";
      res.status(400).json({
        success: false,
        error: `Invalid pick payload: ${issuePath} — ${issueMessage}`,
        details: parsed.error.flatten(),
      });
      return;
    }

    const pick: SavedPickV2 = {
      ...parsed.data,
      id: parsed.data.id || generatedId(),
      ts: parsed.data.ts || Date.now(),
    };
    const originalPicks = pickStore.load(defaultOwnerUserId);
    if (pick.scientificSnapshot) {
      const incomingFingerprint = canonicalMlbPickFingerprint(
        pick as Parameters<typeof canonicalMlbPickFingerprint>[0],
      );
      const duplicate = originalPicks.find((item) => {
        if (item.userId !== userId || item.id === pick.id || item.sport !== "mlb") return false;
        try {
          return (
            canonicalMlbPickFingerprint(
              item as Parameters<typeof canonicalMlbPickFingerprint>[0],
            ) === incomingFingerprint
          );
        } catch {
          return false;
        }
      });
      if (duplicate) {
        res.status(409).json({
          success: false,
          error: "This canonical MLB pick is already saved for this user",
          existingPickId: duplicate.id,
        });
        return;
      }
    }

    const { scientificSnapshot: _scientificSnapshot, ...historyData } = pick;
    const storedPick = historyData as SavedPickV2;
    const write = pickStore.upsert(storedPick, userId, defaultOwnerUserId);
    try {
      mirrorMlbPickToScientificLedger(pick, userId, req);
    } catch (error: any) {
      if (pick.scientificSnapshot) {
        pickStore.restore(write.previous);
        res.status(error?.status || 500).json({
          success: false,
          error: error?.message || "Scientific MLB snapshot could not be recorded",
        });
        return;
      }
      console.error(`[mlb-ledger] provisional mirror failed for pick ${pick.id}`, error);
    }

    res.status(write.created ? 201 : 200).json({
      success: true,
      data: write.data,
      ledger:
        pick.sport === "mlb"
          ? {
              mode: pick.scientificSnapshot ? "FULL_SNAPSHOT" : "PROVISIONAL_MIRROR",
              ownerUserId: userId,
            }
          : undefined,
    });
  });

  app.patch("/api/picks/v2/:id", requireOwnDataWriteRole, (req, res) => {
    const userId = resolveRequestUserId(req);
    const id = decodeURIComponent(req.params.id || "");
    if (!idPattern.test(id)) {
      res.status(400).json({ success: false, error: "Invalid pick id" });
      return;
    }
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: "Invalid pick patch",
        details: parsed.error.flatten(),
      });
      return;
    }
    const data = pickStore.patch(id, userId, parsed.data, defaultOwnerUserId);
    if (!data) {
      res.status(404).json({ success: false, error: "Pick not found" });
      return;
    }
    res.json({ success: true, data });
  });

  app.delete("/api/picks/v2/:id", requireOwnDataWriteRole, (req, res) => {
    const userId = resolveRequestUserId(req);
    const id = decodeURIComponent(req.params.id || "");
    if (!idPattern.test(id)) {
      res.status(400).json({ success: false, error: "Invalid pick id" });
      return;
    }
    if (!pickStore.delete(id, userId, defaultOwnerUserId)) {
      res.status(404).json({ success: false, error: "Pick not found" });
      return;
    }
    res.json({ success: true });
  });

  app.post("/api/clv/refresh", requireOwnDataWriteRole, (req, res) => {
    const userId = resolveRequestUserId(req);
    const allPicks = pickStore.load(defaultOwnerUserId);
    const snapshots = getAllSnapshots();
    let updated = 0;
    const next = allPicks.map((pick) => {
      if (pick.userId !== userId) return pick;
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
    if (updated > 0) pickStore.restore(next);
    res.json({
      success: true,
      updated,
      totalProcessed: allPicks.filter((pick) => pick.userId === userId).length,
      userId,
    });
  });
}
