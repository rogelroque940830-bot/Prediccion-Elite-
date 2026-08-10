import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_OFFICIAL_INJURY_SUPPLEMENT_REASON,
  MLB_OFFICIAL_INJURY_SUPPLEMENT_SOURCE,
  buildMlbInjuryIdentityDiagnostic,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const diagnosticPlayerIds: Record<string, number> = {
  "Strict Player": 1001,
  "Roster Rescue": 1002,
  "Tx Rescue": 1003,
  "Unresolved Player": 1004,
  "Inactive Player": 1005,
  "Same Name": 1006,
};

function diagnosticInjury(name: string, position = "OF", overrides: Record<string, unknown> = {}) {
  const [first_name, ...rest] = name.split(" ");
  return {
    status: "10-day IL",
    player: {
      id: diagnosticPlayerIds[name] ?? 1999,
      first_name,
      last_name: rest.join(" "),
      full_name: name,
      position,
      team: { abbreviation: "NYY" },
    },
    ...overrides,
  };
}

function diagnosticBaseFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.balldontlie.io/mlb/v1/player_injuries")) {
      assert.equal((init?.headers as Record<string, string>)?.Authorization, "secret-test");
      return jsonResponse({
        data: [
          diagnosticInjury("Strict Player"),
          diagnosticInjury("Roster Rescue"),
          diagnosticInjury("Tx Rescue"),
          diagnosticInjury("Unresolved Player"),
          diagnosticInjury("Strict Player"),
          { ...diagnosticInjury("Inactive Player"), status: "Activated" },
        ],
        meta: { next_cursor: null },
      });
    }

    if (url.includes("/people/search?")) {
      const parsed = new URL(url);
      const name = parsed.searchParams.get("names");
      if (name === "Strict Player") {
        return jsonResponse({ people: [{ id: 201, fullName: "Strict Player", currentTeam: { id: 147 } }] });
      }
      if (name === "Roster Rescue") {
        return jsonResponse({ people: [{ id: 202, fullName: "Roster Rescue", currentTeam: { id: 111 } }] });
      }
      if (name === "Tx Rescue") {
        return jsonResponse({ people: [{ id: 203, fullName: "Tx Rescue" }] });
      }
      if (name === "Unresolved Player") return jsonResponse({ people: [] });
      return jsonResponse({ people: [] });
    }

    if (url.includes("/people/201/stats?")) {
      return jsonResponse({ stats: [{ splits: [{ stat: { ops: ".800" } }] }] });
    }

    if (url.includes("/teams/147/roster?")) {
      return jsonResponse({
        roster: [
          { person: { id: 201, fullName: "Strict Player" }, status: { code: "A", description: "Active" } },
          { person: { id: 302, fullName: "Roster Rescue" }, status: { code: "D10", description: "10-Day Injured List" } },
        ],
      });
    }

    if (url.includes("/transactions?teamId=147")) {
      return jsonResponse({
        transactions: [
          { person: { id: 303, fullName: "Tx Rescue" }, typeDesc: "Placed on Injured List", description: "Placed on injured list" },
        ],
      });
    }

    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;
}

test("aggregate diagnostic reproduces strict rejects and counts only unique official authority rescues", async () => {
  const report = await buildMlbInjuryIdentityDiagnostic({
    asOfDate: "2026-08-10",
    season: "2026",
    bdlKey: "secret-test",
    fetchImpl: diagnosticBaseFetch(),
  });

  assert.equal(report.source.bdlPages, 1);
  assert.equal(report.source.bdlTotalRecords, 6);
  assert.equal(report.source.activeMappedBeforeDedupe, 5);
  assert.equal(report.source.activeMappedAfterDedupe, 4);
  assert.equal(report.strictResolver.resolved, 1);
  assert.equal(report.strictResolver.rejected, 3);
  assert.equal(report.strictResolver.rejectionReasons.EXACT_NAME_WRONG_CURRENT_TEAM, 1);
  assert.equal(report.strictResolver.rejectionReasons.EXACT_NAME_NO_CURRENT_TEAM, 1);
  assert.equal(report.strictResolver.rejectionReasons.SEARCH_EMPTY, 1);

  assert.equal(report.officialAuthority.rejectedEvaluated, 3);
  assert.equal(report.officialAuthority.uniqueRosterExactName, 1);
  assert.equal(report.officialAuthority.uniqueRosterIlExactName, 1);
  assert.equal(report.officialAuthority.uniqueRosterNonIlExactName, 0);
  assert.equal(report.officialAuthority.uniqueTransactionExactNameOnly, 1);
  assert.equal(report.officialAuthority.noOfficialExactName, 1);
  assert.equal(report.officialAuthority.safelyResolvableIdentityTotal, 2);
  assert.equal(report.officialAuthority.remainingUnresolved, 1);

  const serialized = JSON.stringify(report);
  for (const forbidden of ["Strict Player", "Roster Rescue", "Tx Rescue", "Unresolved Player", "secret-test"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(report.privacy, {
    aggregateOnly: true,
    playerNamesReturned: false,
    playerIdsReturned: false,
    credentialReturned: false,
  });
});

test("official authority transport failure stays unresolved", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.balldontlie.io")) {
      assert.equal((init?.headers as Record<string, string>)?.Authorization, "secret-test");
      return jsonResponse({ data: [diagnosticInjury("Roster Rescue")], meta: { next_cursor: null } });
    }
    if (url.includes("/people/search?")) {
      return jsonResponse({ people: [{ id: 202, fullName: "Roster Rescue", currentTeam: { id: 111 } }] });
    }
    if (url.includes("/teams/147/roster?")) return jsonResponse({ error: "down" }, 503);
    if (url.includes("/transactions?teamId=147")) return jsonResponse({ transactions: [] });
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;

  const report = await buildMlbInjuryIdentityDiagnostic({
    asOfDate: "2026-08-10",
    season: "2026",
    bdlKey: "secret-test",
    fetchImpl,
  });

  assert.equal(report.strictResolver.rejected, 1);
  assert.equal(report.officialAuthority.authorityUnavailable, 1);
  assert.equal(report.officialAuthority.safelyResolvableIdentityTotal, 0);
  assert.equal(report.officialAuthority.remainingUnresolved, 1);
});

test("ambiguous official exact-name authority never counts as a safe rescue", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.balldontlie.io")) {
      return jsonResponse({ data: [diagnosticInjury("Same Name")], meta: { next_cursor: null } });
    }
    if (url.includes("/people/search?")) return jsonResponse({ people: [] });
    if (url.includes("/teams/147/roster?")) {
      return jsonResponse({ roster: [
        { person: { id: 401, fullName: "Same Name" }, status: { code: "D10", description: "10-Day Injured List" } },
        { person: { id: 402, fullName: "Same Name" }, status: { code: "A", description: "Active" } },
      ] });
    }
    if (url.includes("/transactions?teamId=147")) return jsonResponse({ transactions: [] });
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;

  const report = await buildMlbInjuryIdentityDiagnostic({
    asOfDate: "2026-08-10",
    season: "2026",
    bdlKey: "secret-test",
    fetchImpl,
  });

  assert.equal(report.strictResolver.rejected, 1);
  assert.equal(report.officialAuthority.ambiguousOfficialExactName, 1);
  assert.equal(report.officialAuthority.safelyResolvableIdentityTotal, 0);
  assert.equal(report.officialAuthority.remainingUnresolved, 1);
});
