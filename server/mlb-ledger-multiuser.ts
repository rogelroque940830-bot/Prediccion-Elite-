import type { Express, Request } from "express";
import { z } from "zod";
import {
  buildMlbBacktestReport,
  canonicalJson,
  recordsToCsv,
} from "./mlb-ledger-store";
import { buildMlbInjuryCalibrationReport } from "./mlb-injury-calibration-report";
import { buildMlbInjuryOutcomesReport } from "./mlb-injury-outcomes-report";
import { buildMlbInjuryDecisionReport } from "./mlb-injury-decision-report";
import { buildMlbLedgerHistoryView } from "./mlb-ledger-history-view";
import { runMlbAutoSettlement } from "./mlb-settlement-worker";
import { buildMlbClosingLineReport, enrichRecordsForMlbReports } from "./mlb-closing-line-report";
import { runMlbClosingLineCapture } from "./mlb-closing-line-worker";
import { getMlbClosingLineStore, getMlbLedgerStore } from "./mlb-ledger";
import {
  appendOwnedPrediction,
  appendOwnedSettlement,
  getMlbLedgerOwnershipStore,
  getOwnedRecord,
  ownedRecordsForUser,
  type OwnedLedgerRecord,
  type OwnedRecordFilters,
} from "./mlb-ledger-ownership-store";
import {
  getRequestIdentity,
  requireGlobalWorkerRole,
  requireOwnDataWriteRole,
  resolveRequestUserId,
} from "./user-data-context";

function optionalText(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

function optionalNumber(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queryFilters(query: Record<string, unknown>): OwnedRecordFilters {
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

function ownershipSource(req: Request): "session" | "service" {
  return getRequestIdentity(req) ? "session" : "service";
}

function csvWithOwnership(records: OwnedLedgerRecord[]): string {
  const base = recordsToCsv(records).split("\n");
  if (base.length === 0) return "user_id";
  const rows = records.map((record, index) => `${record.ownership.userId},${base[index + 1] || ""}`);
  return [`user_id,${base[0]}`, ...rows].join("\n");
}

export function registerMlbLedgerMultiuserRoutes(app: Express): void {
  const store = getMlbLedgerStore();
  const closingStore = getMlbClosingLineStore();
  const ownershipStore = getMlbLedgerOwnershipStore();

  const recordsForRequest = (req: Request, override?: Partial<OwnedRecordFilters>) => {
    const userId = resolveRequestUserId(req);
    const filters = { ...queryFilters(req.query as Record<string, unknown>), ...override };
    return {
      userId,
      records: ownedRecordsForUser(store, ownershipStore, userId, filters),
    };
  };

  app.get("/api/mlb/ledger/v1/status", (_req, res) => {
    res.json({
      success: true,
      data: {
        ...store.status(),
        closingLines: closingStore.status(),
        ownership: ownershipStore.status(),
      },
    });
  });

  app.post(
    "/api/mlb/ledger/v1/settle-pending",
    requireGlobalWorkerRole,
    async (_req, res) => {
      try {
        const data = await runMlbAutoSettlement(store, closingStore);
        res.json({ success: true, data });
      } catch (error: any) {
        res.status(500).json({
          success: false,
          error: error?.message || "Unable to settle pending MLB predictions",
        });
      }
    },
  );

  app.post(
    "/api/mlb/ledger/v1/capture-closing-lines",
    requireGlobalWorkerRole,
    async (_req, res) => {
      try {
        const data = await runMlbClosingLineCapture(store, closingStore);
        res.json({ success: true, data });
      } catch (error: any) {
        res.status(error?.status || 500).json({
          success: false,
          error: error?.message || "Unable to capture MLB closing lines",
        });
      }
    },
  );

  app.get("/api/mlb/ledger/v1/closing-lines", (req, res) => {
    try {
      const { userId, records } = recordsForRequest(req, { limit: optionalNumber(req.query.limit) ?? 10_000 });
      res.json({
        success: true,
        userId,
        data: buildMlbClosingLineReport(records, closingStore),
      });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB closing-line report",
      });
    }
  });

  app.post(
    "/api/mlb/ledger/v1/predictions",
    requireOwnDataWriteRole,
    (req, res) => {
      try {
        const userId = resolveRequestUserId(req);
        const result = appendOwnedPrediction(
          store,
          ownershipStore,
          req.body,
          userId,
          ownershipSource(req),
        );
        const owned = getOwnedRecord(store, ownershipStore, userId, result.data.id);
        res.status(result.idempotent ? 200 : 201).json({
          success: true,
          data: owned?.prediction ?? result.data,
          ownership: owned?.ownership ?? { userId },
          idempotent: result.idempotent,
        });
      } catch (error: any) {
        if (error instanceof z.ZodError) {
          res.status(400).json({
            success: false,
            error: "Invalid MLB ledger prediction",
            details: error.flatten(),
          });
          return;
        }
        res.status(error?.status || 500).json({
          success: false,
          error: error?.message || "Unable to record prediction",
        });
      }
    },
  );

  app.get("/api/mlb/ledger/v1/predictions", (req, res) => {
    const { userId, records } = recordsForRequest(req);
    res.json({ success: true, userId, data: records });
  });

  app.get("/api/mlb/ledger/v1/predictions/:id", (req, res) => {
    const userId = resolveRequestUserId(req);
    const record = getOwnedRecord(
      store,
      ownershipStore,
      userId,
      decodeURIComponent(Array.isArray(req.params.id) ? req.params.id[0] || "" : req.params.id || ""),
    );
    if (!record) {
      res.status(404).json({ success: false, error: "Prediction not found" });
      return;
    }
    res.json({ success: true, data: record });
  });

  app.post(
    "/api/mlb/ledger/v1/predictions/:id/settlements",
    requireOwnDataWriteRole,
    (req, res) => {
      try {
        const userId = resolveRequestUserId(req);
        const result = appendOwnedSettlement(
          store,
          ownershipStore,
          decodeURIComponent(Array.isArray(req.params.id) ? req.params.id[0] || "" : req.params.id || ""),
          req.body,
          userId,
        );
        res.status(result.idempotent ? 200 : 201).json({
          success: true,
          ...result,
          ownership: { userId },
        });
      } catch (error: any) {
        if (error instanceof z.ZodError) {
          res.status(400).json({
            success: false,
            error: "Invalid MLB settlement",
            details: error.flatten(),
          });
          return;
        }
        res.status(error?.status || 500).json({
          success: false,
          error: error?.message || "Unable to settle prediction",
        });
      }
    },
  );

  app.get("/api/mlb/ledger/v1/history", (req, res) => {
    try {
      const { userId, records } = recordsForRequest(req, {
        limit: optionalNumber(req.query.limit) ?? 10_000,
      });
      const enriched = enrichRecordsForMlbReports(records, closingStore);
      res.json({ success: true, userId, data: buildMlbLedgerHistoryView(enriched) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build immutable MLB history",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/injury-report", (req, res) => {
    try {
      const { userId, records } = recordsForRequest(req, {
        limit: optionalNumber(req.query.limit) ?? 10_000,
      });
      const targetSettled = optionalNumber(req.query.targetSettled) ?? 20;
      res.json({
        success: true,
        userId,
        data: buildMlbInjuryCalibrationReport(records, targetSettled),
      });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB injury calibration report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/injury-outcomes", (req, res) => {
    try {
      const { userId, records } = recordsForRequest(req, {
        limit: optionalNumber(req.query.limit) ?? 10_000,
      });
      const enriched = enrichRecordsForMlbReports(records, closingStore);
      res.json({ success: true, userId, data: buildMlbInjuryOutcomesReport(enriched) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB injury outcomes report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/injury-decisions", (req, res) => {
    try {
      const { userId, records } = recordsForRequest(req, {
        limit: optionalNumber(req.query.limit) ?? 10_000,
      });
      const enriched = enrichRecordsForMlbReports(records, closingStore);
      res.json({ success: true, userId, data: buildMlbInjuryDecisionReport(enriched) });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB injury decision report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/report", (req, res) => {
    try {
      const { userId, records } = recordsForRequest(req, {
        limit: optionalNumber(req.query.limit) ?? 10_000,
      });
      const enriched = enrichRecordsForMlbReports(records, closingStore);
      const trainPct = optionalNumber(req.query.trainPct) ?? 70;
      const validationPct = optionalNumber(req.query.validationPct) ?? 15;
      res.json({
        success: true,
        userId,
        data: buildMlbBacktestReport(enriched, trainPct, validationPct),
      });
    } catch (error: any) {
      res.status(error?.status || 500).json({
        success: false,
        error: error?.message || "Unable to build MLB report",
      });
    }
  });

  app.get("/api/mlb/ledger/v1/export", (req, res) => {
    const { records } = recordsForRequest(req, {
      limit: optionalNumber(req.query.limit) ?? 10_000,
    });
    const enriched = enrichRecordsForMlbReports(records, closingStore) as OwnedLedgerRecord[];
    const format = optionalText(req.query.format) || "jsonl";
    if (format === "csv") {
      res.type("text/csv").send(csvWithOwnership(enriched));
      return;
    }
    if (format !== "jsonl") {
      res.status(400).json({ success: false, error: "format must be jsonl or csv" });
      return;
    }
    res
      .type("application/x-ndjson")
      .send(enriched.map((record) => canonicalJson(record)).join("\n"));
  });
}
