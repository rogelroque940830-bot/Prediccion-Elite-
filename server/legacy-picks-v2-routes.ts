import type { Express } from "express";
import { loadPicks, savePicks, type SavedPick } from "./legacy-picks-store";

/** Compatibility-only history endpoints retained until the old dashboard is retired. */
export function registerLegacyPicksV2Routes(app: Express): void {
  // ── Picks history endpoints (SISTEMA NUEVO en /api/picks/v2) ────────────
  // Renombrados de /api/picks a /api/picks/v2 para no chocar con el sistema viejo
  // de más abajo (línea ~3490+) que el frontend usa con LOAD_STATE/sync.
  // POST /api/picks/v2  body: SavedPick (sin id, sin ts)
  app.post("/api/picks/v2", async (req, res) => {
    try {
      const body = req.body as Omit<SavedPick, "id" | "ts">;
      if (!body || !body.sport || !body.homeTeam || !body.awayTeam || !body.pickType || !body.pickSide || typeof body.confidence !== "number") {
        return res.status(400).json({ success: false, error: "Faltan campos obligatorios" });
      }
      const picks = loadPicks();
      const pick: SavedPick = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        ...body,
      };
      picks.push(pick);
      savePicks(picks);
      res.json({ success: true, data: pick });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // GET /api/picks/v2?sport=mlb&days=7&minConfidence=70
  app.get("/api/picks/v2", async (req, res) => {
    try {
      const sport = (req.query.sport as string | undefined)?.toLowerCase();
      const days = parseInt((req.query.days as string) || "30", 10);
      const minConf = parseFloat((req.query.minConfidence as string) || "0");
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      let picks = loadPicks().filter((p) => p.ts >= cutoff && p.confidence >= minConf);
      if (sport) picks = picks.filter((p) => p.sport === sport);
      picks.sort((a, b) => b.confidence - a.confidence);
      res.json({ success: true, data: picks, count: picks.length });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // DELETE /api/picks/v2/:id
  app.delete("/api/picks/v2/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const picks = loadPicks();
      const filtered = picks.filter((p) => p.id !== id);
      if (filtered.length === picks.length) {
        return res.status(404).json({ success: false, error: "No encontrado" });
      }
      savePicks(filtered);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

}
