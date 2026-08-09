import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_INJURY_IDENTITY_RESEARCH_DATE,
  runMlbInjuryIdentityRuntimeResearch,
} from "./mlb-injury-identity-runtime-research";

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("aggregate diagnostic measures strict baseline and exact team-scoped roster/transaction rescue", async () => {
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/schedule")) {
      return jsonResponse({ dates: [{ games: [{ teams: { home: { team: { id: 109 } }, away: { team: { id: 144 } } } }] }] });
    }
    if (url.hostname === "api.balldontlie.io") {
      return jsonResponse({
        data: [
          { status: "Out", player: { id: 1, full_name: "Accepted One", first_name: "Accepted", last_name: "One", team: { abbreviation: "ARI" } } },
          { status: "Out", player: { id: 2, full_name: "Roster Rescue", first_name: "Roster", last_name: "Rescue", team: { abbreviation: "ARI" } } },
          { status: "Out", player: { id: 3, full_name: "Tx Rescue", first_name: "Tx", last_name: "Rescue", team: { abbreviation: "ARI" } } },
        ],
        meta: { next_cursor: null },
      });
    }
    if (url.pathname.endsWith("/people/search")) {
      const name = url.searchParams.get("names");
      if (name === "Accepted One") return jsonResponse({ people: [{ id: 501, fullName: "Accepted One", currentTeam: { id: 109 } }] });
      return jsonResponse({ people: [] });
    }
    if (url.pathname === "/api/v1/teams/109/roster") {
      return jsonResponse({ roster: [{ person: { id: 502, fullName: "Roster Rescue" }, status: { code: "D10", description: "10-Day Injured List" } }] });
    }
    if (url.pathname === "/api/v1/teams/144/roster") return jsonResponse({ roster: [] });
    if (url.pathname.endsWith("/transactions")) {
      const teamId = url.searchParams.get("teamId");
      if (teamId === "109") {
        return jsonResponse({ transactions: [{ person: { id: 503, fullName: "Tx Rescue" }, typeDesc: "Placed on Injured List", description: "injured" }] });
      }
      return jsonResponse({ transactions: [] });
    }
    return jsonResponse({}, 404);
  };

  const result = await runMlbInjuryIdentityRuntimeResearch({
    date: MLB_INJURY_IDENTITY_RESEARCH_DATE,
    bdlApiKey: "test-key",
    fetcher,
  });

  assert.equal(result.state, "MEASURED");
  assert.deepEqual(result.sample, {
    slateTeams: 2,
    rawActiveMappedRecords: 3,
    dedupedRecords: 3,
    baselineAccepted: 1,
    baselineRejected: 2,
    rejectedTeams: 1,
  });
  assert.equal(result.baselineCauseCounts.NO_SEARCH_RESULTS, 2);
  assert.equal(result.teamAuthority.roster40ExactUnique, 1);
  assert.equal(result.teamAuthority.roster40InjuredExactUnique, 1);
  assert.equal(result.teamAuthority.relevantTransactionExactUnique, 1);
  assert.equal(result.teamAuthority.rosterOrTransactionExactUnique, 2);
  assert.equal(result.teamAuthority.rosterTransactionIdConflict, 0);
  assert.equal(result.teamAuthority.unmatched, 0);
  assert.equal(result.strictQueryVariantRescueCounts.currentSport1, 0);
  assert.equal(result.strictQueryVariantRescueCounts.structuredNoSport, 0);
  assert.equal(result.strictQueryVariantRescueCounts.structuredSport1, 0);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Accepted One|Roster Rescue|Tx Rescue/);
  assert.doesNotMatch(serialized, /"playerId"|"teamId"/);
  assert.equal(result.safety.rawPlayerIdentityReturned, false);
  assert.equal(result.safety.rawTeamIdentityReturned, false);
  assert.equal(result.safety.fuzzyMatchingUsed, false);
  assert.equal(result.safety.surnameOnlyMatchingUsed, false);
});

test("missing BDL credential fails closed without making requests", async () => {
  let calls = 0;
  const result = await runMlbInjuryIdentityRuntimeResearch({
    date: MLB_INJURY_IDENTITY_RESEARCH_DATE,
    bdlApiKey: "",
    fetcher: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  assert.equal(result.state, "SOURCE_UNAVAILABLE");
  assert.equal(calls, 0);
  assert.equal(result.safety.writesPerformed, 0);
});
