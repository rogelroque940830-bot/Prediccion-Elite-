import type { Express } from "express";
import {
  buildMlbP1M2bPregameReadiness,
  validateMlbP1M2bManualOdds,
  type MlbP1M2bManualOdds,
} from "./mlb-p1-pregame-readiness-service";
import type { MlbP1M2aMarket } from "./mlb-p1-pregame-readiness-contract";
import { registerMlbP1AdvancedComponentCertificationMiddleware } from "./mlb-p1-advanced-component-certification-routes";
import { registerMlbStatcastCertifierSourceAlignmentMiddleware } from "./mlb-statcast-certifier-source-alignment-routes";
import { registerMlbP1BoundedF5OddsRoutes } from "./mlb-p1-bounded-f5-odds-routes";

const MARKET_ALIASES: Record<string, MlbP1M2aMarket> = {
  ML: "ML",
  MONEYLINE: "ML",
  F5: "F5_ML",
  F5ML: "F5_ML",
  F5_ML: "F5_ML",
  RUNLINE: "RUN_LINE",
  RUN_LINE: "RUN_LINE",
  RL: "RUN_LINE",
  TOTAL: "TOTAL",
  OU: "TOTAL",
  "O/U": "TOTAL",
  F5TOTAL: "F5_TOTAL",
  F5_TOTAL: "F5_TOTAL",
  F5OU: "F5_TOTAL",
};

function parseMarket(value: unknown): MlbP1M2aMarket | null {
  const key = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  return MARKET_ALIASES[key] ?? null;
}

function queryNumber(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseManualOdds(req: any, market: MlbP1M2aMarket): MlbP1M2bManualOdds | null {
  const mode = String(req.query.oddsMode ?? "auto").trim().toLowerCase();
  if (mode !== "manual") return null;
  const manual: MlbP1M2bManualOdds = {
    mode: "MANUAL",
    book: String(req.query.manualBook ?? "").trim(),
    capturedAt: String(req.query.manualCapturedAt ?? "").trim(),
    line: queryNumber(req.query.manualLine),
    homeOdds: queryNumber(req.query.manualHomeOdds),
    awayOdds: queryNumber(req.query.manualAwayOdds),
    overOdds: queryNumber(req.query.manualOverOdds),
    underOdds: queryNumber(req.query.manualUnderOdds),
  };
  const errors = validateMlbP1M2bManualOdds(market, manual);
  if (errors.length) {
    const error: any = new Error("INVALID_MANUAL_ODDS");
    error.validationErrors = errors;
    throw error;
  }
  return manual;
}

export function registerMlbP1PregameReadinessRoutes(app: Express): void {
  // M2B owns readiness of the advanced evidence it consumes. Register these
  // GET-only certification interceptors before legacy MLB core routes are added.
  registerMlbStatcastCertifierSourceAlignmentMiddleware(app);
  registerMlbP1AdvancedComponentCertificationMiddleware(app);
  // P0 on-demand odds: bounded F5 acquisition is available as an internal/read-only
  // building block before M2B is switched from date-wide F5 provider fanout.
  registerMlbP1BoundedF5OddsRoutes(app);

  app.get("/api/mlb/p1/v1/pregame-readiness", async (req, res) => {
    const gamePk = Number(req.query.gamePk);
    const market = parseMarket(req.query.market);
    if (!Number.isInteger(gamePk) || gamePk <= 0) {
      return res.status(400).json({
        success: false,
        error: "gamePk debe ser un entero positivo.",
      });
    }
    if (!market) {
      return res.status(400).json({
        success: false,
        error: "market debe ser ML, F5_ML, RUN_LINE, TOTAL o F5_TOTAL.",
      });
    }

    try {
      const manualOdds = parseManualOdds(req, market);
      const data = await buildMlbP1M2bPregameReadiness({
        gamePk,
        market,
        dateHint: String(req.query.date ?? "").trim() || null,
        manualOdds,
      });
      return res.json({ success: true, data });
    } catch (error: any) {
      if (error?.message === "INVALID_MANUAL_ODDS") {
        return res.status(400).json({
          success: false,
          error: "La captura manual de cuotas está incompleta o es inválida.",
          validationErrors: error.validationErrors ?? [],
        });
      }
      if (error?.message === "INVALID_GAME_PK") {
        return res.status(400).json({ success: false, error: "gamePk inválido." });
      }
      console.error("P1-M2B MLB pregame readiness error:", error);
      return res.status(502).json({
        success: false,
        error: "No se pudo construir la evaluación pregame.",
      });
    }
  });
}
