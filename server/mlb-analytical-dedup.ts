import { createHash } from "node:crypto";
import type { LedgerRecord } from "./mlb-ledger-store";

export const MLB_ANALYTICAL_FINGERPRINT_VERSION = "mlb-analytical-fingerprint.v1" as const;

export type MlbAnalyticalDuplicateStatus = {
  fingerprint: string | null;
  analyticalDuplicate: boolean;
  analyticalDuplicateOfPredictionId: string | null;
};

const OMIT_AUDIT_KEYS = new Set([
  "capturedAt",
  "detectorFetchedAt",
  "validatorFetchedAt",
]);

function normalizedText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizedNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1e12) / 1e12 : null;
}

function stableValue(value: any, key = ""): any {
  if (OMIT_AUDIT_KEYS.has(key)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => stableValue(item))
      .filter((item) => item !== undefined)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((childKey) => [childKey, stableValue(value[childKey], childKey)] as const)
        .filter(([, childValue]) => childValue !== undefined),
    );
  }
  if (typeof value === "number") return normalizedNumber(value);
  return value;
}

function injuryAuditFrom(record: LedgerRecord): any | null {
  const audit = (record.prediction.payload as any)?.analysis?.injuryAudit;
  return audit?.schemaVersion === "mlb-injury-audit.v1" ? audit : null;
}

export function buildMlbAnalyticalFingerprint(record: LedgerRecord): string | null {
  const audit = injuryAuditFrom(record);
  if (!audit) return null;
  const prediction = record.prediction;
  const basis = stableValue({
    version: MLB_ANALYTICAL_FINGERPRINT_VERSION,
    game: {
      gamePk: prediction.game.gamePk ?? null,
      gameDate: prediction.game.gameDate,
      homeTeam: normalizedText(prediction.game.homeTeam),
      awayTeam: normalizedText(prediction.game.awayTeam),
    },
    market: {
      type: prediction.market.type,
      selection: normalizedText(prediction.market.selection),
      line: normalizedNumber(prediction.market.line),
      oddsAmerican: normalizedNumber(prediction.market.oddsAmerican),
      book: normalizedText(prediction.market.book),
    },
    model: {
      name: normalizedText(prediction.model.name),
      version: normalizedText(prediction.model.version),
      probability: normalizedNumber(prediction.probabilities.model),
    },
    injuryAudit: audit,
  });
  return createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

export function classifyMlbAnalyticalDuplicates(
  records: LedgerRecord[],
): Map<string, MlbAnalyticalDuplicateStatus> {
  const ordered = [...records].sort((left, right) =>
    left.prediction.recordedAtMs - right.prediction.recordedAtMs
    || left.prediction.id.localeCompare(right.prediction.id)
  );
  const firstByFingerprint = new Map<string, string>();
  const result = new Map<string, MlbAnalyticalDuplicateStatus>();

  for (const record of ordered) {
    const fingerprint = buildMlbAnalyticalFingerprint(record);
    if (!fingerprint) {
      result.set(record.prediction.id, {
        fingerprint: null,
        analyticalDuplicate: false,
        analyticalDuplicateOfPredictionId: null,
      });
      continue;
    }
    const originalId = firstByFingerprint.get(fingerprint) ?? null;
    if (!originalId) firstByFingerprint.set(fingerprint, record.prediction.id);
    result.set(record.prediction.id, {
      fingerprint,
      analyticalDuplicate: Boolean(originalId),
      analyticalDuplicateOfPredictionId: originalId,
    });
  }
  return result;
}
