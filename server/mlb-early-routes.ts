import type { Express } from "express";
import { computeMlbTesi } from "./mlb-tesi.js";
import { computeMlbEre } from "./mlb-ere.js";
import { computeMlbEarlyEngine } from "./mlb-early-engine-service";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";

export function registerMlbEarlyRoutes(app: Express): void {
  // ── Early Markets MLB ──────────────────────────────────
  // F5 ML, F5 O/U, NRFI/YRFI, 1ª-2ª-3ª inning ML.
  // The route and whole-slate producer share the same orchestration service so
  // there is no second sporting implementation.
  app.post("/api/mlb/early-markets", async (req, res) => {
    try {
      const { home, away, lines } = req.body || {};
      if (!home?.teamId || !away?.teamId) {
        return res.status(400).json({ success: false, error: "home y away requieren teamId" });
      }
      const data = await computeMlbEarlyEngine({
        home,
        away,
        lines,
        gameDate: req.body?.gameDate,
        disableMatchup: req.body?.disableMatchup === true || req.query?.disableMatchup === "1",
        homePitcherForm: req.body?.homePitcherForm,
        awayPitcherForm: req.body?.awayPitcherForm,
        umpire: req.body?.umpire,
      });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // ── Early Run Environment (ERE) MLB v3 ──────────────────────
  // Composite 0-100 score con 16 variables (8 offense + 8 pitcher)
  // GET /api/mlb/ere/:teamId?name=X&gamePk=Y&pitcherId=Z&hand=R&venue=X&tempF=Y&windMph=Z&windOut=true

  // ── Rotowire daily lineups (FUENTE 2) ────────────────────────────────────
  app.get("/api/mlb/rotowire/lineup/:gamePk", async (req, res) => {
    try {
      const gamePk = parseInt(req.params.gamePk, 10);
      if (isNaN(gamePk)) return res.status(400).json({ success: false, error: "gamePk inválido" });
      const { getRotowireLineupForGame } = await import("./mlb-rotowire-lineups.js");
      const data = await getRotowireLineupForGame(gamePk);
      if (!data) return res.json({ success: true, data: null, error: "No lineup en Rotowire para ese gamePk" });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/mlb/rotowire/all", async (_req, res) => {
    try {
      const { fetchAllRotowireGames } = await import("./mlb-rotowire-lineups.js");
      const games = await fetchAllRotowireGames();
      res.json({ success: true, data: games, count: games.length });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/mlb/ere/:teamId", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId, 10);
      if (isNaN(teamId)) return res.status(400).json({ success: false, error: "teamId inválido" });
      const teamName = String(req.query.name || "");
      const gamePk = req.query.gamePk ? parseInt(String(req.query.gamePk), 10) : undefined;
      const opposingPitcherId = req.query.pitcherId ? parseInt(String(req.query.pitcherId), 10) : undefined;
      const handStr = String(req.query.hand || "").toUpperCase();
      const opposingPitcherHand: "R" | "L" | undefined = handStr === "R" || handStr === "L" ? (handStr as "R" | "L") : undefined;
      const venue = req.query.venue ? String(req.query.venue) : undefined;
      const tempF = req.query.tempF ? parseFloat(String(req.query.tempF)) : undefined;
      const windMph = req.query.windMph ? parseFloat(String(req.query.windMph)) : undefined;
      const windDirOut = String(req.query.windOut || "false").toLowerCase() === "true";
      const gameDate = await resolveMlbAnalysisDate(req.query.date, gamePk);

      const data = await computeMlbEre({
        teamId,
        teamName,
        gamePk: isNaN(gamePk as any) ? undefined : gamePk,
        opposingPitcherId: isNaN(opposingPitcherId as any) ? undefined : opposingPitcherId,
        opposingPitcherHand,
        venue,
        tempF: isNaN(tempF as any) ? undefined : tempF,
        windMph: isNaN(windMph as any) ? undefined : windMph,
        windDirOut,
        gameDate,
      });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // ── Team Early Scoring Index (TESI v2) MLB ──────────────────────
  // GET /api/mlb/tesi/:teamId?name=X&gamePk=Y&pitcherId=Z&hand=R
  app.get("/api/mlb/tesi/:teamId", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId, 10);
      if (isNaN(teamId)) return res.status(400).json({ success: false, error: "teamId inválido" });
      const teamName = String(req.query.name || "");
      const gamePk = req.query.gamePk ? parseInt(String(req.query.gamePk), 10) : undefined;
      const opposingPitcherId = req.query.pitcherId ? parseInt(String(req.query.pitcherId), 10) : undefined;
      const handStr = String(req.query.hand || "").toUpperCase();
      const opposingPitcherHand: "R" | "L" | undefined = handStr === "R" || handStr === "L" ? (handStr as "R" | "L") : undefined;
      const gameDate = await resolveMlbAnalysisDate(req.query.date, gamePk);

      const data = await computeMlbTesi({
        teamId,
        teamName,
        gamePk: isNaN(gamePk as any) ? undefined : gamePk,
        opposingPitcherId: isNaN(opposingPitcherId as any) ? undefined : opposingPitcherId,
        opposingPitcherHand,
        gameDate,
      });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });
}
