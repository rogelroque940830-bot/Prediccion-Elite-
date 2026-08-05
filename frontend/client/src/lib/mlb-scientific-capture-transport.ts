import type { MlbScientificSnapshot } from "./mlb-scientific-snapshot";

export const MLB_P1_M3A_MAX_SNAPSHOT_BYTES = 280_000;

const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|session|csrf)/i;

export class MlbP1M3cSnapshotTransportError extends Error {
  constructor(
    public readonly code: "P1_M3C_SNAPSHOT_NOT_JSON_SERIALIZABLE" | "P1_M3C_SNAPSHOT_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "MlbP1M3cSnapshotTransportError";
  }
}

export interface MlbP1M3cPreparedSnapshot {
  payload: MlbScientificSnapshot;
  bytes: number;
  redactedFieldNames: string[];
}

/**
 * Produces the exact payload that JSON.stringify will place on the wire.
 *
 * Object properties whose value is undefined are omitted, undefined array
 * entries become null, non-finite numbers become null, Date values use their
 * JSON representation, and sensitive values are redacted before hashing.
 * The returned object must be used both as the request payload and as the
 * SHA-256 input so the browser and server validate identical bytes/semantics.
 */
export function prepareMlbP1M3cSnapshotForTransport(
  snapshot: MlbScientificSnapshot,
): MlbP1M3cPreparedSnapshot {
  const redactedFieldNames = new Set<string>();
  let json: string | undefined;

  try {
    json = JSON.stringify(snapshot, (key, value) => {
      if (
        key
        && SENSITIVE_KEY.test(key)
        && value != null
        && value !== ""
        && value !== "[REDACTED]"
      ) {
        redactedFieldNames.add(key);
        return "[REDACTED]";
      }
      if (typeof value === "number" && !Number.isFinite(value)) return null;
      return value;
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown serialization error";
    throw new MlbP1M3cSnapshotTransportError(
      "P1_M3C_SNAPSHOT_NOT_JSON_SERIALIZABLE",
      `El snapshot científico no puede convertirse de forma segura a JSON: ${reason}`,
    );
  }

  if (!json) {
    throw new MlbP1M3cSnapshotTransportError(
      "P1_M3C_SNAPSHOT_NOT_JSON_SERIALIZABLE",
      "El snapshot científico produjo un documento JSON vacío.",
    );
  }

  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MLB_P1_M3A_MAX_SNAPSHOT_BYTES) {
    throw new MlbP1M3cSnapshotTransportError(
      "P1_M3C_SNAPSHOT_TOO_LARGE",
      `El snapshot científico ocupa ${bytes.toLocaleString("en-US")} bytes y el contrato permite ${MLB_P1_M3A_MAX_SNAPSHOT_BYTES.toLocaleString("en-US")}.`,
    );
  }

  return {
    payload: JSON.parse(json) as MlbScientificSnapshot,
    bytes,
    redactedFieldNames: Array.from(redactedFieldNames).sort(),
  };
}
