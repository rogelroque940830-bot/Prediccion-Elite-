import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import { terminalMlbLedgerRecords } from "./mlb-terminal-ledger-records";

function record(id: string, supersedesId?: string): LedgerRecord {
  return {
    prediction: { id, supersedesId } as LedgerRecord["prediction"],
    settlement: null,
  };
}

test("terminal ledger view keeps only the last record in each supersedes chain", () => {
  const rows = [
    record("provisional"),
    record("final-v1", "provisional"),
    record("final-v2", "final-v1"),
    record("independent"),
  ];
  assert.deepEqual(
    terminalMlbLedgerRecords(rows).map((row) => row.prediction.id),
    ["final-v2", "independent"],
  );
});
