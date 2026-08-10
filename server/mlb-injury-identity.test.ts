import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";

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
