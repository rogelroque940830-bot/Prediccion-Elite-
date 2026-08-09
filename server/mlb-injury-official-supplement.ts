import {
  daysBetweenIsoDates,
  type MlbInjuryShadowResult,
  type MlbOfficialInjurySnapshot,
  type MlbOfficialRosterEvidence,
  type MlbOfficialTransactionEvidence,
} from "./mlb-injury-shadow";

export const MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE = "MLB_STATS_OFFICIAL_SUPPLEMENT" as const;
export const MLB_OFFICIAL_INJURY_SUPPLEMENT_REASON = "OFFICIAL_SOURCE_SUPPLEMENT_EVIDENCE_ONLY" as const;

export interface MlbOfficialInjurySupplementPlayer {
  playerId: number;
  name: string;
  position: string;
  status: string;
  isPitcher: boolean;
  source: typeof MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE;
  officialStatusCode: string | null;
  officialStatus: string | null;
  officialTransaction: MlbOfficialTransactionEvidence | null;
  shadow: MlbInjuryShadowResult;
}

export interface MlbOfficialInjurySupplementResult {
  sourceHealthy: boolean;
  rawOfficialOnlyCount: number;
  supplementedCount: number;
  unresolvedOfficialOnlyCount: number;
  coverageReconciled: boolean;
  supplements: MlbOfficialInjurySupplementPlayer[];
  reason:
    | "RECONCILED_WITH_MLB_OFFICIAL"
    | "NO_OFFICIAL_ONLY_GAP"
    | "SOURCE_NOT_HEALTHY"
    | "REJECTED_EXTERNAL_IDENTITY"
    | "ANOMALOUS_EXTERNAL_LIST";
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

export function isOfficialMlbInjuredRosterEntry(entry: MlbOfficialRosterEvidence): boolean {
  const code = normalize(entry.statusCode).toUpperCase();
  const description = normalize(entry.statusDescription);
  return /^D\d+$/i.test(code) || /injured/i.test(description);
}

function isPitcherPosition(position: unknown): boolean {
  const normalized = normalize(position).toUpperCase();
  return ["P", "SP", "RP", "LHP", "RHP"].includes(normalized) || /PITCHER/.test(normalized);
}

function evidenceOnlyShadow(
  roster: MlbOfficialRosterEvidence,
  transaction: MlbOfficialTransactionEvidence | null,
  asOfDate: string,
): MlbInjuryShadowResult {
  const transactionDate = transaction?.effectiveDate || transaction?.date || null;
  return {
    decision: "PENDING",
    confidence: "HIGH",
    impact: "NONE",
    reasonCode: MLB_OFFICIAL_INJURY_SUPPLEMENT_REASON,
    reason: "MLB official confirms the injured-roster identity. The record supplements source coverage only and is not eligible for automatic injury adjustment without the normal detector path.",
    officialStatusCode: normalize(roster.statusCode) || null,
    officialStatus: normalize(roster.statusDescription) || null,
    daysSinceOfficialTransaction: daysBetweenIsoDates(transactionDate, asOfDate),
    shadowOnly: true,
  };
}

export function reconcileMlbOfficialOnlyInjuries(input: {
  sourceStatus: string;
  stale?: boolean;
  anomalous?: boolean;
  rejectedCount?: number;
  officialSnapshot: MlbOfficialInjurySnapshot | null | undefined;
  existingPlayerIds: Iterable<number>;
  asOfDate: string;
}): MlbOfficialInjurySupplementResult {
  const existing = new Set(
    Array.from(input.existingPlayerIds)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
  const officialEntries = Object.values(input.officialSnapshot?.rosterByPlayerId ?? {})
    .filter(isOfficialMlbInjuredRosterEntry)
    .filter((entry) => !existing.has(Number(entry.playerId)))
    .filter((entry) => Number.isInteger(Number(entry.playerId)) && Number(entry.playerId) > 0)
    .filter((entry) => normalize(entry.name).length > 0)
    .sort((left, right) => Number(left.playerId) - Number(right.playerId));

  const rawOfficialOnlyCount = officialEntries.length;
  const sourceHealthy = input.sourceStatus === "VERIFIED"
    && input.officialSnapshot?.status === "VERIFIED"
    && input.stale !== true
    && (input.officialSnapshot?.errors?.length ?? 0) === 0;
  const rejectedCount = Math.max(0, Math.trunc(Number(input.rejectedCount) || 0));

  if (input.anomalous === true) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: rawOfficialOnlyCount,
      coverageReconciled: rawOfficialOnlyCount === 0,
      supplements: [],
      reason: "ANOMALOUS_EXTERNAL_LIST",
    };
  }
  if (rejectedCount > 0) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: rawOfficialOnlyCount,
      coverageReconciled: rawOfficialOnlyCount === 0,
      supplements: [],
      reason: "REJECTED_EXTERNAL_IDENTITY",
    };
  }
  if (!sourceHealthy) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: rawOfficialOnlyCount,
      coverageReconciled: rawOfficialOnlyCount === 0,
      supplements: [],
      reason: "SOURCE_NOT_HEALTHY",
    };
  }
  if (rawOfficialOnlyCount === 0) {
    return {
      sourceHealthy,
      rawOfficialOnlyCount: 0,
      supplementedCount: 0,
      unresolvedOfficialOnlyCount: 0,
      coverageReconciled: true,
      supplements: [],
      reason: "NO_OFFICIAL_ONLY_GAP",
    };
  }

  const supplements = officialEntries.map((entry): MlbOfficialInjurySupplementPlayer => {
    const transaction = input.officialSnapshot?.latestTransactionByPlayerId?.[entry.playerId] ?? null;
    return {
      playerId: Number(entry.playerId),
      name: normalize(entry.name),
      position: normalize(entry.position),
      status: normalize(entry.statusDescription) || normalize(entry.statusCode),
      isPitcher: isPitcherPosition(entry.position),
      source: MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE,
      officialStatusCode: normalize(entry.statusCode) || null,
      officialStatus: normalize(entry.statusDescription) || null,
      officialTransaction: transaction,
      shadow: evidenceOnlyShadow(entry, transaction, input.asOfDate),
    };
  });

  return {
    sourceHealthy,
    rawOfficialOnlyCount,
    supplementedCount: supplements.length,
    unresolvedOfficialOnlyCount: Math.max(0, rawOfficialOnlyCount - supplements.length),
    coverageReconciled: supplements.length === rawOfficialOnlyCount,
    supplements,
    reason: "RECONCILED_WITH_MLB_OFFICIAL",
  };
}
