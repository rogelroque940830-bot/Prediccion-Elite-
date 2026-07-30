import type { LedgerRecord } from "./mlb-ledger-store";

/**
 * The immutable ledger retains every revision. Analytical sample size must only
 * count the terminal record in each supersedes chain, otherwise PROVISIONAL and
 * FINAL snapshots would inflate the number of independent decisions.
 */
export function terminalMlbLedgerRecords<T extends LedgerRecord>(records: T[]): T[] {
  const supersededIds = new Set(
    records
      .map((record) => record.prediction.supersedesId)
      .filter((value): value is string => Boolean(value)),
  );
  return records.filter((record) => !supersededIds.has(record.prediction.id));
}
