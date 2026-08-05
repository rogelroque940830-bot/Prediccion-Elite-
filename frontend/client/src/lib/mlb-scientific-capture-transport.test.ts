import assert from "node:assert/strict";
import test from "node:test";
import { mlbP1M3cSha256 } from "./mlb-scientific-capture";
import {
  MLB_P1_M3A_MAX_SNAPSHOT_BYTES,
  MlbP1M3cSnapshotTransportError,
  prepareMlbP1M3cSnapshotForTransport,
} from "./mlb-scientific-capture-transport";
import type { MlbScientificSnapshot } from "./mlb-scientific-snapshot";

function snapshotWithTransportEdgeCases(): MlbScientificSnapshot {
  return {
    schemaVersion: "mlb-scientific-snapshot.v1",
    model: { name: "CourtEdge MLB", version: "transport-regression" },
    game: {
      gamePk: 824806,
      gameDate: "2026-08-05",
      commenceTime: "2026-08-05T23:05:00.000Z",
      homeTeam: "Baltimore Orioles",
      awayTeam: "Los Angeles Angels",
    },
    market: {
      type: "ML",
      selection: "Los Angeles Angels ML",
      oddsAmerican: 110,
      book: "Certified market source",
      capturedAt: "2026-08-05T21:45:00.000Z",
    },
    probabilities: {
      model: 0.53,
      marketImplied: 100 / 210,
      noVig: 0.49,
      edgePp: 5.38095238,
    },
    decision: {
      signal: "LEAN",
      confidenceLabel: "B",
      confidencePct: 53,
      stakeUnits: 0,
    },
    analysis: {
      stage: "PROVISIONAL",
      warnings: [],
      rawInputs: {
        omittedObjectField: undefined,
        arrayTransport: [1, undefined, 3],
        csrfToken: "must-not-leave-browser",
        nested: {
          api_key: "must-also-be-redacted",
          safeValue: 7,
        },
      },
      rawOutput: {
        optionalValue: undefined,
        finite: 1.25,
        notFinite: Number.NaN,
      },
    },
  } as MlbScientificSnapshot;
}

test("P1-M3C.1 hashes the same snapshot object that crosses JSON transport", async () => {
  const prepared = prepareMlbP1M3cSnapshotForTransport(snapshotWithTransportEdgeCases());
  const payload = prepared.payload as any;

  assert.equal(Object.hasOwn(payload.analysis.rawInputs, "omittedObjectField"), false);
  assert.deepEqual(payload.analysis.rawInputs.arrayTransport, [1, null, 3]);
  assert.equal(payload.analysis.rawInputs.csrfToken, "[REDACTED]");
  assert.equal(payload.analysis.rawInputs.nested.api_key, "[REDACTED]");
  assert.equal(Object.hasOwn(payload.analysis.rawOutput, "optionalValue"), false);
  assert.equal(payload.analysis.rawOutput.notFinite, null);
  assert.deepEqual(prepared.redactedFieldNames, ["api_key", "csrfToken"]);

  const digest = await mlbP1M3cSha256(prepared.payload);
  const wire = JSON.parse(JSON.stringify({ payload: prepared.payload, digest }));
  assert.equal(await mlbP1M3cSha256(wire.payload), wire.digest);
});

test("P1-M3C.1 fails closed before POST when the transported snapshot exceeds the contract", () => {
  const snapshot = snapshotWithTransportEdgeCases() as any;
  snapshot.analysis.rawInputs.oversized = "x".repeat(MLB_P1_M3A_MAX_SNAPSHOT_BYTES + 1);

  assert.throws(
    () => prepareMlbP1M3cSnapshotForTransport(snapshot),
    (error: unknown) => error instanceof MlbP1M3cSnapshotTransportError
      && error.code === "P1_M3C_SNAPSHOT_TOO_LARGE",
  );
});
