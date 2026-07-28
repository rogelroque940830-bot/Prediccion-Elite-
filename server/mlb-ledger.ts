import type { Express } from "express";
import { z } from "zod";
import {
  MlbLedgerStore,
  buildMlbBacktestReport,
  canonicalJson,
  recordsToCsv,
} from "./mlb-ledger-store";
import { buildMlbInjuryCalibrationReport } from "./mlb-injury-calibration-report";
import { runMlbAutoSettlement } from "./mlb-settlement-worker";

let singletonStore: MlbLedgerStore | null = null;

export function getMlbLedgerStore(): MlbLedgerStore {
  if (!singletonStore) singletonStore = new MlbLedgerStore();
  return singletonStore;
}

function optionalText(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

function optionalNumber(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queryFilters(query: Record<string, unknown>) {
  const settledText = optionalText(query.settled);
  return {
    from: optionalText(query.from),
    to: optionalText(query.to),
    market: optionalText(query.market),
    confidence: optionalText(query.confidence),
    signal: optionalText(query.signal),
    stage: optionalText(query.stage),
    settled: settledText == null ? undefined : settledText === "true",
    limit: optionalNumber(query.limit),
  };
}

export function registerMlbLedgerRoutes(app: Express): void {
  const store = getMlbLedgerStore();

  app.get("/api/mlb/ledger/v1/status", (_req, res) => {
    res.json({ success: true, data: store.status() });
  });

  app.post("/api/mlb/ledger/v1/settle-pending", async (_req, res) => {
    try {
      const data = await runMlbAutoSettlement(store);
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error?.message || "Unable to settle pending MLB predictions",
      });
    }
  });

  app.post("/api/mlb/ledger/v1/predictions", (req, res) => {
    try {
      const result = store.appendPrediction(req.body);
      res.status(result.idempotent ? 200 : 201).json({ success: true, ...result });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Invalid MLB ledger prediction",
          details: error.flatten(),
        });
      }
      return res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to record prediction",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/predictions", (req, res) => {
    const records = store.listRecords(queryFilters(req.query as Record<string, unknown>));
    res.json({ success: true, data: records });
  });

  app.get("/api/mlb/ledger/v1/predictions/:id", (req, res) => {
    const record = store.getRecord(decodeURIComponent(req.params.id || ""));
    if (!record) return res.status(404).json({ success: false, error: "Prediction not found" });
    return res.json({ success: true, data: record });
  });

  app.post("/api/mlb/ledger/v1/predictions/:id/settlements", (req, res) => {
    try {
      const result = store.appendSettlement(decodeURIComponent(req.params.id || ""), req.body);
      res.status(result.idempotent ? 200 : 201).json({ success: true, ...result });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          error: "Invalid MLB settlement",
          details: error.flatten(),
        });
      }
      return res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to settle prediction",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/injury-report", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = store.listRecords({ ...filters, limit: filters.limit ?? 10_000 });
      const targetSettled = optionalNumber(req.query.targetSettled) ?? 20;
      res.json({ success: true, data: buildMlbInjuryCalibrationReport(records, targetSettled) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB injury calibration report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/report", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = store.listRecords({ ...filters, limit: filters.limit ?? 10_000 });
      const trainPct = optionalNumber(req.query.trainPct) ?? 70;
      const validationPct = optionalNumber(req.query.validationPct) ?? 15;
      res.json({ success: true, data: buildMlbBacktestReport(records, trainPct, validationPct) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/export", (req, res) => {
    const filters = queryFilters(req.query as Record<string, unknown>);
    const records = store.listRecords({ ...filters, limit: filters.limit ?? 10_000 });
    const format = optionalText(req.query.format) || "jsonl";

    if (format === "csv") {
      res.type("text/csv").send(recordsToCsv(records));
      return;
    }
    if (format !== "jsonl") {
      res.status(400).json({ success: false, error: "format must be jsonl or csv" });
      return;
    }
    res.type("application/x-ndjson").send(records.map((record) => canonicalJson(record)).join("\n"));
  });
}

export { MlbLedgerStore, buildMlbBacktestReport } from "./mlb-ledger-store";
export { buildMlbInjuryCalibrationReport } from "./mlb-injury-calibration-report";
