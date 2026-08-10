import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbPeopleSearchUrl,
  isOfficialMlbIlRosterIdentity,
  normalizeMlbInjuryIdentityName,
  resolveMlbInjuryIdentity,
} from "./mlb-injury-identity";

test("MLB injury identity lookup requests currentTeam hydration", () => {
  const url = new URL(
    buildMlbPeopleSearchUrl(
      "https://statsapi.mlb.com/api/v1/",
      "Julio Rodríguez",
      "2026",
    ),
  );

  assert.equal(url.pathname, "/api/v1/people/search");
  assert.equal(url.searchParams.get("names"), "Julio Rodríguez");
  assert.equal(url.searchParams.get("season"), "2026");
  assert.equal(url.searchParams.get("hydrate"), "currentTeam");
});

test("MLB injury identity lookup does not duplicate the trailing slash", () => {
  const url = buildMlbPeopleSearchUrl(
    "https://statsapi.mlb.com/api/v1/",
    "Adolis García",
    "2026",
  );
  assert.match(url, /^https:\/\/statsapi\.mlb\.com\/api\/v1\/people\/search\?/);
  assert.doesNotMatch(url, /api\/v1\/\/people/);
});

test("identity name normalization preserves strict equality across accents and punctuation", () => {
  assert.equal(normalizeMlbInjuryIdentityName("José Ramírez Jr."), "joseramirezjr");
  assert.equal(normalizeMlbInjuryIdentityName("Jose Ramirez Jr"), "joseramirezjr");
});

test("existing exact people/search currentTeam identity remains first priority", () => {
  const resolved = resolveMlbInjuryIdentity({
    playerName: "Exact Player",
    teamId: 147,
    people: [{
      id: 101,
      fullName: "Exact Player",
      currentTeam: { id: 147 },
      primaryPosition: { abbreviation: "OF" },
    }],
    officialRosterVerified: true,
    officialRosterByPlayerId: {
      202: {
        playerId: 202,
        name: "Exact Player",
        statusCode: "D10",
        statusDescription: "10-Day Injured List",
        position: "RF",
      },
    },
  });

  assert.deepEqual(resolved, {
    playerId: 101,
    position: "OF",
    source: "MLB_PEOPLE_CURRENT_TEAM",
  });
});

test("wrong people/search currentTeam can fall back only to one exact official team IL roster identity", () => {
  const resolved = resolveMlbInjuryIdentity({
    playerName: "Roster Injured",
    teamId: 147,
    people: [{
      id: 301,
      fullName: "Roster Injured",
      currentTeam: { id: 111 },
      primaryPosition: { abbreviation: "OF" },
    }],
    officialRosterVerified: true,
    officialRosterByPlayerId: {
      401: {
        playerId: 401,
        name: "Roster Injured",
        statusCode: "D10",
        statusDescription: "10-Day Injured List",
        position: "CF",
      },
    },
  });

  assert.deepEqual(resolved, {
    playerId: 401,
    position: "CF",
    source: "MLB_OFFICIAL_TEAM_IL_ROSTER",
  });
});

test("official roster fallback is blocked when official evidence is not verified", () => {
  const resolved = resolveMlbInjuryIdentity({
    playerName: "Roster Injured",
    teamId: 147,
    people: [{ id: 301, fullName: "Roster Injured", currentTeam: { id: 111 } }],
    officialRosterVerified: false,
    officialRosterByPlayerId: {
      401: {
        playerId: 401,
        name: "Roster Injured",
        statusCode: "D10",
        statusDescription: "10-Day Injured List",
      },
    },
  });
  assert.equal(resolved, null);
});

test("active official roster row cannot rescue a rejected BDL injury identity", () => {
  const resolved = resolveMlbInjuryIdentity({
    playerName: "Active Player",
    teamId: 147,
    people: [{ id: 301, fullName: "Active Player", currentTeam: { id: 111 } }],
    officialRosterVerified: true,
    officialRosterByPlayerId: {
      401: {
        playerId: 401,
        name: "Active Player",
        statusCode: "A",
        statusDescription: "Active",
      },
    },
  });
  assert.equal(resolved, null);
});

test("ambiguous exact official IL roster identities remain rejected", () => {
  const resolved = resolveMlbInjuryIdentity({
    playerName: "Same Name",
    teamId: 147,
    people: [],
    officialRosterVerified: true,
    officialRosterByPlayerId: {
      401: {
        playerId: 401,
        name: "Same Name",
        statusCode: "D10",
        statusDescription: "10-Day Injured List",
      },
      402: {
        playerId: 402,
        name: "Same Name",
        statusCode: "D60",
        statusDescription: "60-Day Injured List",
      },
    },
  });
  assert.equal(resolved, null);
});

test("similar but non-exact official names never invoke fuzzy matching", () => {
  const resolved = resolveMlbInjuryIdentity({
    playerName: "John Smith",
    teamId: 147,
    people: [],
    officialRosterVerified: true,
    officialRosterByPlayerId: {
      401: {
        playerId: 401,
        name: "Johnny Smith",
        statusCode: "D10",
        statusDescription: "10-Day Injured List",
      },
    },
  });
  assert.equal(resolved, null);
});

test("official IL detector accepts MLB disabled-list codes or explicit injured description only", () => {
  assert.equal(isOfficialMlbIlRosterIdentity({ playerId: 1, name: "A", statusCode: "D10" }), true);
  assert.equal(isOfficialMlbIlRosterIdentity({ playerId: 2, name: "B", statusDescription: "15-Day Injured List" }), true);
  assert.equal(isOfficialMlbIlRosterIdentity({ playerId: 3, name: "C", statusCode: "A", statusDescription: "Active" }), false);
});
