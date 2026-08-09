import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_OFFICIAL_INJURY_SUPPLEMENT_REASON,
  MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE,
  reconcileMlbOfficialOnlyInjuries,
} from "./mlb-injury-official-supplement";
import type { MlbOfficialInjurySnapshot } from "./mlb-injury-shadow";

function snapshot(options: {
  status?: "VERIFIED" | "PARTIAL";
  errors?: string[];
} = {}): MlbOfficialInjurySnapshot {
  return {
    status: options.status ?? "VERIFIED",
    source: "MLB_STATS",
    fetchedAt: "2026-08-09T16:00:00.000Z",
    errors: options.errors ?? [],
    rosterByPlayerId: {
      101: {
        playerId: 101,
        name: "Official Pitcher",
        statusCode: "D15",
        statusDescription: "15-Day Injured List",
        position: "P",
      },
      102: {
        playerId: 102,
        name: "Official Hitter",
        statusCode: "D10",
        statusDescription: "10-Day Injured List",
        position: "OF",
      },
      103: {
        playerId: 103,
        name: "Active Player",
        statusCode: "A",
        statusDescription: "Active",
        position: "SS",
      },
    },
    latestTransactionByPlayerId: {
      101: {
        effectiveDate: "2026-08-07",
        typeDesc: "Placed on 15-Day Injured List",
      },
      102: {
        effectiveDate: "2026-08-06",
        typeDesc: "Placed on 10-Day Injured List",
      },
    },
  };
}

test("healthy official-only gap with no rejected identities is fully reconciled as evidence-only", () => {
  const result = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: false,
    anomalous: false,
    rejectedCount: 0,
    officialSnapshot: snapshot(),
    existingPlayerIds: [],
    asOfDate: "2026-08-09",
  });

  assert.equal(result.sourceHealthy, true);
  assert.equal(result.rawOfficialOnlyCount, 2);
  assert.equal(result.supplementedCount, 2);
  assert.equal(result.unresolvedOfficialOnlyCount, 0);
  assert.equal(result.coverageReconciled, true);
  assert.equal(result.reason, "RECONCILED_WITH_MLB_OFFICIAL");
  assert.deepEqual(result.supplements.map((player) => player.playerId), [101, 102]);
  assert.equal(result.supplements[0]?.source, MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE);
  assert.equal(result.supplements[0]?.isPitcher, true);
  assert.equal(result.supplements[1]?.isPitcher, false);
  for (const player of result.supplements) {
    assert.equal(player.shadow.decision, "PENDING");
    assert.equal(player.shadow.impact, "NONE");
    assert.equal(player.shadow.reasonCode, MLB_OFFICIAL_INJURY_SUPPLEMENT_REASON);
    assert.equal(player.shadow.shadowOnly, true);
  }
});

test("existing externally reconciled player is not duplicated", () => {
  const result = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: false,
    rejectedCount: 0,
    officialSnapshot: snapshot(),
    existingPlayerIds: [101],
    asOfDate: "2026-08-09",
  });

  assert.equal(result.rawOfficialOnlyCount, 1);
  assert.equal(result.supplementedCount, 1);
  assert.equal(result.supplements[0]?.playerId, 102);
});

test("any rejected external identity keeps the official-only gap unresolved", () => {
  const result = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: false,
    rejectedCount: 1,
    officialSnapshot: snapshot(),
    existingPlayerIds: [],
    asOfDate: "2026-08-09",
  });

  assert.equal(result.reason, "REJECTED_EXTERNAL_IDENTITY");
  assert.equal(result.supplementedCount, 0);
  assert.equal(result.unresolvedOfficialOnlyCount, 2);
  assert.equal(result.coverageReconciled, false);
  assert.deepEqual(result.supplements, []);
});

test("stale or partially validated sources never supplement", () => {
  const stale = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: true,
    rejectedCount: 0,
    officialSnapshot: snapshot(),
    existingPlayerIds: [],
    asOfDate: "2026-08-09",
  });
  assert.equal(stale.reason, "SOURCE_NOT_HEALTHY");
  assert.equal(stale.supplementedCount, 0);

  const partial = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: false,
    rejectedCount: 0,
    officialSnapshot: snapshot({ status: "PARTIAL", errors: ["official roster degraded"] }),
    existingPlayerIds: [],
    asOfDate: "2026-08-09",
  });
  assert.equal(partial.reason, "SOURCE_NOT_HEALTHY");
  assert.equal(partial.supplementedCount, 0);
});

test("anomalous external list remains fail-closed", () => {
  const result = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: false,
    anomalous: true,
    rejectedCount: 0,
    officialSnapshot: snapshot(),
    existingPlayerIds: [],
    asOfDate: "2026-08-09",
  });

  assert.equal(result.reason, "ANOMALOUS_EXTERNAL_LIST");
  assert.equal(result.supplementedCount, 0);
  assert.equal(result.coverageReconciled, false);
});

test("no official-only gap remains verified without synthetic rows", () => {
  const result = reconcileMlbOfficialOnlyInjuries({
    sourceStatus: "VERIFIED",
    stale: false,
    rejectedCount: 0,
    officialSnapshot: snapshot(),
    existingPlayerIds: [101, 102],
    asOfDate: "2026-08-09",
  });

  assert.equal(result.reason, "NO_OFFICIAL_ONLY_GAP");
  assert.equal(result.rawOfficialOnlyCount, 0);
  assert.equal(result.supplementedCount, 0);
  assert.equal(result.coverageReconciled, true);
});
