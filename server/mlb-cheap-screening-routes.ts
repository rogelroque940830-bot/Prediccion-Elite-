import type { Express } from "express";
import { buildMlbP1DailySlate, isValidMlbP1Date } from "./mlb-p1-daily-slate";
import { screenMlbDailySlateCheap } from "./mlb-cheap-screening";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expiresAt: number; payload: ReturnType<typeof screenMlbDailySlateCheap> }>();

function floridaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function registerMlbCheapScreeningRoutes(app: Express): void {
  app.get("/api/mlb/p1/v1/cheap-screen", async (req, res) => {
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

      // Internal orchestration only: build the authoritative MLB slate directly.
      // This route does not self-fetch another CourtEdge endpoint and never requests market odds.
      const slate = await buildMlbP1DailySlate({ date });
      const payload = screenMlbDailySlateCheap(slate);
      cache.set(date, { expiresAt: now + CACHE_TTL_MS, payload });
      return res.json({ success: true, data: payload, cache: "MISS" });
    } catch (error) {
      console.error("P0 MLB cheap screening error:", error);
      return res.status(502).json({
        success: false,
        error: "No se pudo completar el screening pre-odds con la fuente oficial MLB.",
      });
    }
  });
}
