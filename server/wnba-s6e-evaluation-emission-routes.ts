import type { Express } from "express";
import {
  WnbaEvaluationCaptureError,
  type WnbaEvaluationEmissionService,
} from "./wnba-s6e-evaluation-emission-service";

function integerQuery(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

export function registerWnbaEvaluationEmissionRoutes(app: Express, service: WnbaEvaluationEmissionService): void {
  app.get("/health/s6e-wnba-evaluation-emission", (_req, res) => {
    const payload = service.publicStatus();
    res.status(payload.status === "starting" ? 503 : 200).json(payload);
  });

  app.get("/api/wnba/predictor-shadow/v1/emission/status", (_req, res) => {
    res.json({ success: true, data: service.status() });
  });

  app.get("/api/wnba/predictor-shadow/v1/emission/evaluations", (req, res) => {
    const limit = integerQuery(req.query.limit, 100, 1000);
    const rows = service.readEvaluations();
    res.json({ success: true, data: rows.slice(Math.max(0, rows.length - limit)) });
  });

  app.get("/api/wnba/predictor-shadow/v1/emission/outputs", (req, res) => {
    const limit = integerQuery(req.query.limit, 300, 3000);
    const rows = service.readOutputs();
    res.json({ success: true, data: rows.slice(Math.max(0, rows.length - limit)) });
  });

  app.post("/api/wnba/predictor-shadow/v1/evaluations", (req, res) => {
    try {
      const result = service.capture(req.body);
      res.status(result.idempotent ? 200 : 201).json({ success: true, data: result });
    } catch (error) {
      const status = error instanceof WnbaEvaluationCaptureError ? error.status : 500;
      const message = status >= 500
        ? "Unable to capture WNBA evaluation"
        : error instanceof Error ? error.message : "Invalid WNBA evaluation";
      if (status >= 500) console.error("[s6e] WNBA evaluation capture failed", error);
      res.status(status).json({ success: false, error: message });
    }
  });
}
