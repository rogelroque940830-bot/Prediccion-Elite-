import type { Express } from "express";
import { z } from "zod";
import {
  MlbLedgerStore,
  buildMlbBacktestReport,
  canonicalJson,
} from "./mlb-ledger-store";
import { recordsToMlbCsv } from "./mlb-ledger-csv-export";
import { buildMlbInjuryCalibrationReport } from "./mlb-injury-calibration-report";
import { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";
import { buildMlbInjuryDecisionReport } from "./mlb-injury-decision-report";
import { buildMlbLedgerHistoryView } from "./mlb-ledger-history-view";
import { runMlbAutoSettlement } from "./mlb-settlement-worker";
import { createMlbSettlementStoreView } from "./mlb-settlement-lightweight-store";
import { MlbClosingLineStore } from "./mlb-closing-line-store";
import { buildMlbClosingLineReport, enrichRecordsForMlbReports } from "./mlb-closing-line-report";
import { runMlbClosingLineCapture } from "./mlb-closing-line-worker";

let singletonStore: MlbLedgerStore | null = null;
let singletonClosingStore: MlbClosingLineStore | null = null;

export function getMlbLedgerStore(): MlbLedgerStore {
  if (!singletonStore) singletonStore = new MlbLedgerStore();
  return singletonStore;
}

export function getMlbClosingLineStore(): MlbClosingLineStore {
  if (!singletonClosingStore) singletonClosingStore = new MlbClosingLineStore();
  return singletonClosingStore;
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
  const settlementStore = createMlbSettlementStoreView(store);
  const closingStore = getMlbClosingLineStore();

  app.get("/api/mlb/ledger/v1/status", (_req, res) => {
    res.json({ success: true, data: { ...store.status(), closingLines: closingStore.status() } });
  });

  app.post("/api/mlb/ledger/v1/settle-pending", async (_req, res) => {
    try {
      const data = await runMlbAutoSettlement(settlementStore, closingStore);
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error?.message || "Unable to settle pending MLB predictions",
      });
    }
  });

  app.post("/api/mlb/ledger/v1/capture-closing-lines", async (_req, res) => {
    try {
      const data = await runMlbClosingLineCapture(store, closingStore);
      res.json({ success: true, data });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || "Unable to capture MLB closing lines" });
    }
  });

  app.get("/api/mlb/ledger/v1/closing-lines", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = store.listRecords({ ...filters, limit: filters.limit ?? 10_000 });
      res.json({ success: true, data: buildMlbClosingLineReport(records, closingStore) });
    } catch (error: any) {
      res.status(error?.status || 500).json({ success: false, error: error?.message || "Unable to build MLB closing-line report" });
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

  app.get("/api/mlb/ledger/v1/history", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = enrichRecordsForMlbReports(
        store.listRecords({ ...filters, limit: filters.limit ?? 10_000 }),
        closingStore,
      );
      res.json({ success: true, data: buildMlbLedgerHistoryView(records) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build immutable MLB history",
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

  app.get("/api/mlb/ledger/v1/injury-outcomes", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = enrichRecordsForMlbReports(
        store.listRecords({ ...filters, limit: filters.limit ?? 10_000 }),
        closingStore,
      );
      res.json({ success: true, data: buildMlbInjuryOutcomesReport(records) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB injury outcomes report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/injury-decisions", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = enrichRecordsForMlbReports(
        store.listRecords({ ...filters, limit: filters.limit ?? 10_000 }),
        closingStore,
      );
      res.json({ success: true, data: buildMlbInjuryDecisionReport(records) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB injury decision report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/report", (req, res) => {
    try {
      const filters = queryFilters(req.query as Record<string, unknown>);
      const records = enrichRecordsForMlbReports(
        store.listRecords({ ...filters, limit: filters.limit ?? 10_000 }),
        closingStore,
      );
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
    const records = enrichRecordsForMlbReports(
      store.listRecords({ ...filters, limit: filters.limit ?? 10_000 }),
      closingStore,
    );
    const format = optionalText(req.query.format) || "jsonl";

    if (format === "csv") {
      res.type("text/csv").send(recordsToMlbCsv(records));
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
export { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";
export { buildMlbInjuryDecisionReport } from "./mlb-injury-decision-report";
export { buildMlbLedgerHistoryView } from "./mlb-ledger-history-view";
export { MlbClosingLineStore } from "./mlb-closing-line-store";
export { buildMlbClosingLineReport } from "./mlb-closing-line-report";
export { recordsToMlbCsv } from "./mlb-ledger-csv-export";
