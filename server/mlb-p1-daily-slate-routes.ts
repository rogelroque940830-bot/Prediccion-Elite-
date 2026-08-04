import type { Express } from "express";
import { buildMlbP1DailySlate, isValidMlbP1Date } from "./mlb-p1-daily-slate";

const CACHE_TTL_MS = 60_000;
const slateCache = new Map<string, { expiresAt: number; payload: Awaited<ReturnType<typeof buildMlbP1DailySlate>> }>();

function floridaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function registerMlbP1DailySlateRoutes(app: Express): void {
  app.get("/api/mlb/p1/v1/slate", async (req, res) => {
    const date = String(req.query.date ?? floridaDate()).trim();
    if (!isValidMlbP1Date(date)) {
      return res.status(400).json({
        success: false,
        error: "La fecha debe usar el formato YYYY-MM-DD.",
      });
    }

    try {
      const now = Date.now();
      const cached = slateCache.get(date);
      if (cached && cached.expiresAt > now) {
        return res.json({ success: true, data: cached.payload, cache: "HIT" });
      }
      const payload = await buildMlbP1DailySlate({ date });
      slateCache.set(date, { expiresAt: now + CACHE_TTL_MS, payload });
      return res.json({ success: true, data: payload, cache: "MISS" });
    } catch (error) {
      console.error("P1 MLB daily slate error:", error);
      return res.status(502).json({
        success: false,
        error: "No se pudo verificar la jornada MLB con la fuente oficial.",
      });
    }
  });
}
