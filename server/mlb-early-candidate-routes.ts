import type { Express } from "express";
import { isValidMlbP1Date } from "./mlb-p1-daily-slate";
import { buildMlbEarlyWholeSlateCandidates } from "./mlb-early-whole-slate-candidates";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; payload: Awaited<ReturnType<typeof buildMlbEarlyWholeSlateCandidates>> }>();

function floridaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function registerMlbEarlyCandidateRoutes(app: Express): void {
  app.get("/api/mlb/early-candidates/v1", async (req, res) => {
    const date = String(req.query.date ?? floridaDate()).trim();
    if (!isValidMlbP1Date(date)) {
      return res.status(400).json({ success: false, error: "La fecha debe usar el formato YYYY-MM-DD." });
    }

    try {
      const now = Date.now();
      const cached = cache.get(date);
      if (cached && cached.expiresAt > now) {
        return res.json({ success: true, data: cached.payload, cache: "HIT" });
      }
      const payload = await buildMlbEarlyWholeSlateCandidates({ date });
      cache.set(date, { expiresAt: now + CACHE_TTL_MS, payload });
      return res.json({ success: true, data: payload, cache: "MISS" });
    } catch (error) {
      console.error("MLB Early whole-slate candidate producer error:", error);
      return res.status(502).json({
        success: false,
        error: "No se pudo construir el slate Early/ERE con la evidencia oficial disponible.",
      });
    }
  });
}
