import type { LedgerRecord } from "./mlb-ledger-store";

/**
 * Returns only the current leaf records in immutable supersession chains.
 * Historical records remain in the ledger, but a record referenced by a newer
 * prediction's supersedesId is no longer operationally active.
 */
export function activeMlbLedgerRecords<T extends LedgerRecord>(records: T[]): T[] {
  const supersededIds = new Set(
    records
      .map((record) => record.prediction.supersedesId)
      .filter((value): value is string => Boolean(value)),
  );
  return records.filter((record) => !supersededIds.has(record.prediction.id));
}

export function supersessionChainIntegrity(records: LedgerRecord[]): {
  valid: boolean;
  missingParents: string[];
  duplicateChildren: string[];
  cycles: string[][];
} {
  const byId = new Map(records.map((record) => [record.prediction.id, record]));
  const children = new Map<string, string[]>();
  const missingParents: string[] = [];

  for (const record of records) {
    const parent = record.prediction.supersedesId;
    if (!parent) continue;
    if (!byId.has(parent)) missingParents.push(parent);
    const list = children.get(parent) ?? [];
    list.push(record.prediction.id);
    children.set(parent, list);
  }

  const duplicateChildren = Array.from(children.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([parent]) => parent);

  const cycles: string[][] = [];
  for (const record of records) {
    const seen = new Map<string, number>();
    const path: string[] = [];
    let current: LedgerRecord | undefined = record;
    while (current) {
      const id = current.prediction.id;
      const existing = seen.get(id);
      if (existing != null) {
        cycles.push(path.slice(existing).concat(id));
        break;
      }
      seen.set(id, path.length);
      path.push(id);
      const parent = current.prediction.supersedesId;
      current = parent ? byId.get(parent) : undefined;
    }
  }

  const uniqueCycles = Array.from(
    new Map(cycles.map((cycle) => [cycle.slice().sort().join("|"), cycle])).values(),
  );

  return {
    valid: missingParents.length === 0 && duplicateChildren.length === 0 && uniqueCycles.length === 0,
    missingParents: Array.from(new Set(missingParents)).sort(),
    duplicateChildren: duplicateChildren.sort(),
    cycles: uniqueCycles,
  };
}
