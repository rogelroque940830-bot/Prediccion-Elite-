import crypto from "node:crypto";
import { auditValid, type Json } from "./p0-full13-live-parity-state";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child) => {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      return Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b)));
    }
    return child;
  });
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

export function mergeV80UniqueHistoryRows<T extends Json>(left: T[], right: T[], label: string): T[] {
  const out = new Map<number, T>();
  for (const row of [...left, ...right]) {
    const gp = Number(row.gamePk);
    if (!Number.isInteger(gp) || gp <= 0) throw new Error(`V80_LIVE_CONTEXT_INVALID_GAME_PK:${label}`);
    const existing = out.get(gp);
    if (existing && digest(existing) !== digest(row)) {
      throw new Error(`V80_LIVE_CONTEXT_IMMUTABLE_CONFLICT:${label}:${gp}`);
    }
    if (!existing) out.set(gp, row);
  }
  return [...out.values()].sort(
    (a, b) => String(a.officialDate).localeCompare(String(b.officialDate)) || Number(a.gamePk) - Number(b.gamePk),
  );
}

/**
 * V80 only consumes audit rows that satisfy the already-frozen historical/pregame
 * validity predicate. The frozen V68 base can contain future-game audit placeholders
 * (identityOk=true but sourceHistorical=false/pregame=false) that are intentionally
 * non-evidence and are ignored downstream by auditValid(). When the cumulative V68
 * gap later contains the real historical T-5 audit for the same gamePk, the placeholder
 * must not block that valid evidence.
 *
 * We therefore discard non-evidence placeholders before the immutable merge. Once a
 * row is valid historical/pregame evidence, duplicate gamePk rows remain digest-strict:
 * any drift still fails closed.
 */
export function mergeV80AuditHistoryRows<T extends Json>(baseAudits: T[], gapAudits: T[]): T[] {
  const baseHistorical = baseAudits.filter((row) => auditValid(row));
  const gapHistorical = gapAudits.filter((row) => auditValid(row));
  return mergeV80UniqueHistoryRows(baseHistorical, gapHistorical, "AUDIT");
}
