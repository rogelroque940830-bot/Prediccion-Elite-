import type { Express } from "express";
import { canonicalJson, recordsToCsv } from "./mlb-ledger-store";
import { enrichRecordsForMlbReports } from "./mlb-closing-line-report";
import { getMlbClosingLineStore, getMlbLedgerStore } from "./mlb-ledger";
import {
  getMlbLedgerOwnershipStore,
  ownedRecordsForUser,
  type OwnedLedgerRecord,
} from "./mlb-ledger-ownership-store";
import { resolveRequestUserId } from "./user-data-context";

function optionalText(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

function optionalNumber(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function csvWithOwnership(records: OwnedLedgerRecord[]): string {
  const base = recordsToCsv(records).split("\n");
  if (!base.length) return "user_id";
  return [
    `user_id,${base[0]}`,
    ...records.map((record, index) => `${record.ownership.userId},${base[index + 1] || ""}`),
  ].join("\n");
}

export function registerMlbOwnedExportRoute(app: Express): void {
  const store = getMlbLedgerStore();
  const closingStore = getMlbClosingLineStore();
  const ownershipStore = getMlbLedgerOwnershipStore();

  app.get("/api/mlb/ledger/v1/export", (req, res) => {
    const userId = resolveRequestUserId(req);
    const owned = ownedRecordsForUser(store, ownershipStore, userId, {
      from: optionalText(req.query.from),
      to: optionalText(req.query.to),
      market: optionalText(req.query.market),
      confidence: optionalText(req.query.confidence),
      signal: optionalText(req.query.signal),
      stage: optionalText(req.query.stage),
      settled:
        optionalText(req.query.settled) == null
          ? undefined
          : optionalText(req.query.settled) === "true",
      limit: optionalNumber(req.query.limit) ?? 10_000,
    });
    const ownershipByPrediction = new Map(
      owned.map((record) => [record.prediction.id, record.ownership]),
    );
    const enriched = enrichRecordsForMlbReports(owned, closingStore).map((record) => ({
      ...record,
      ownership: ownershipByPrediction.get(record.prediction.id)!,
    })) as OwnedLedgerRecord[];
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
