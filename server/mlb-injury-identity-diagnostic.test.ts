import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbInjuryIdentityDiagnostic } from "./mlb-injury-identity-diagnostic";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function injury(name: string, position = "OF", overrides: Record<string, unknown> = {}) {
  const [first_name, ...rest] = name.split(" ");
  return {
    status: "10-day IL",
    player: {
      id: name.length * 100,
      first_name,
      last_name: rest.join(" "),
      full_name: name,
      position,
      team: { abbreviation: "NYY" },
    },
    ...overrides,
  };
}

function baseFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.balldontlie.io/mlb/v1/player_injuries")) {
      assert.equal((init?.headers as Record<string, string>)?.Authorization, "secret-test");
      return jsonResponse({
        data: [
          injury("Strict Player"),
          injury("Roster Rescue"),
          injury("Tx Rescue"),
          injury("Unresolved Player"),
          injury("Strict Player"),
          { ...injury("Inactive Player"), status: "Activated" },
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
    fetchImpl: baseFetch(),
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
      return jsonResponse({ data: [injury("Roster Rescue")], meta: { next_cursor: null } });
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
      return jsonResponse({ data: [injury("Same Name")], meta: { next_cursor: null } });
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
