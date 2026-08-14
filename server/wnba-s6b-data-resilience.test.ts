import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import {
  fetchReadonlyFallback,
  fetchWnbaPlayersDirect,
  fetchWnbaScheduleResilient,
  fetchWnbaSosDirect,
  parseEspnWnbaSchedule,
} from "./wnba-s6b-data-resilience";
import { registerWnbaS6bRoutes } from "./wnba-s6b-routes";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function espnEvent(id: string, date: string) {
  return {
    id,
    date,
    competitions: [{
      id,
      competitors: [
        { homeAway: "home", team: { id: "10", displayName: "New York Liberty", abbreviation: "NY" } },
        { homeAway: "away", team: { id: "20", displayName: "Las Vegas Aces", abbreviation: "LV" } },
      ],
    }],
  };
}

async function withServer(
  fetcher: typeof fetch,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  registerWnbaS6bRoutes(app, {
    fetcher,
    cache: async (_key, factory) => factory(),
    today: () => "2026-07-30",
    scheduleDirectTimeoutMs: 50,
    scheduleFallbackTimeoutMs: 50,
    statsTimeoutMs: 50,
    readonlyFallbackTimeoutMs: 50,
    sosFallbackUrl: "https://fallback.example/api/wnba/sos",
    playersFallbackUrl: "https://fallback.example/api/wnba/players",
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start S6B test server");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("S6B uses direct WNBA scoreboard data when available", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://stats.nba.com")) {
      return jsonResponse({
        scoreboard: {
          games: [{
            gameId: "direct-1",
            gameTimeUTC: "2026-07-31T00:00:00Z",
            homeTeam: { teamId: 10, teamCity: "New York", teamName: "Liberty", teamTricode: "NYL" },
            awayTeam: { teamId: 20, teamCity: "Las Vegas", teamName: "Aces", teamTricode: "LVA" },
          }],
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await fetchWnbaScheduleResilient("2026-07-30", { fetcher, directTimeoutMs: 50 });
  assert.equal(result.source, "wnba-stats-scoreboardV3");
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].homeTeam.name, "New York Liberty");
});

test("S6B normalizes ESPN schedule when both WNBA Stats hosts fail", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("stats.nba.com") || url.includes("stats.wnba.com")) throw new Error("provider timeout");
    if (url.includes("site.api.espn.com")) return jsonResponse({ events: [espnEvent("fallback-1", "2026-07-31T00:00:00Z")] });
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await fetchWnbaScheduleResilient("2026-07-30", {
    fetcher,
    directTimeoutMs: 50,
    fallbackTimeoutMs: 50,
  });
  assert.equal(result.source, "espn-readonly-fallback");
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].awayTeam.tricode, "LV");
  assert.equal(parseEspnWnbaSchedule({ events: [] }).length, 0);
});

test("S6B rejects recursive and invalid read-only fallbacks", async () => {
  await assert.rejects(
    fetchReadonlyFallback({
      url: "https://same.example/api/wnba/sos",
      currentHost: "same.example",
      fetcher: async () => jsonResponse({ success: true, data: [] }),
      validate: (value): value is any[] => Array.isArray(value) && value.length > 0,
      label: "WNBA SOS",
    }),
    /Refusing recursive WNBA SOS fallback/,
  );

  await assert.rejects(
    fetchReadonlyFallback({
      url: "https://fallback.example/api/wnba/sos",
      currentHost: "integration.example",
      fetcher: async () => jsonResponse({ success: true, data: [] }),
      validate: (value): value is any[] => Array.isArray(value) && value.length > 0,
      label: "WNBA SOS",
    }),
    /fallback returned invalid data/,
  );
});

test("S6B direct SOS and player parsers preserve existing contracts", async () => {
  const advancedHeaders = ["TEAM_ID", "OFF_RATING", "DEF_RATING"];
  const logHeaders = ["TEAM_ID", "TEAM_ABBREVIATION", "MATCHUP"];
  const playerHeaders = ["TEAM_ID", "GP", "MIN", "PLAYER_ID", "PLAYER_NAME", "TEAM_ABBREVIATION", "PTS", "AST", "REB", "STL", "BLK", "FG_PCT"];

  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("leaguedashplayerstats")) {
      return jsonResponse({ resultSets: [{ headers: playerHeaders, rowSet: [[10, 20, 31, 100, "Player One", "NYL", 20, 6, 5, 1.5, 0.5, 0.48]] }] });
    }
    if (url.includes("leaguegamelog")) {
      return jsonResponse({ resultSets: [{ headers: logHeaders, rowSet: [
        [10, "NYL", "NYL vs. LVA"],
        [20, "LVA", "LVA @ NYL"],
      ] }] });
    }
    if (url.includes("LastNGames=10")) {
      return jsonResponse({ resultSets: [{ headers: advancedHeaders, rowSet: [[10, 110, 100], [20, 105, 101]] }] });
    }
    if (url.includes("leaguedashteamstats")) {
      return jsonResponse({ resultSets: [{ headers: advancedHeaders, rowSet: [[10, 108, 102], [20, 106, 103]] }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const sos = await fetchWnbaSosDirect(fetcher, 50);
  assert.equal(sos.length, 2);
  assert.ok(Number.isFinite(sos[0].oppAvgNetRtg));

  const players = await fetchWnbaPlayersDirect(fetcher, 50);
  assert.equal(players[10][0].name, "Player One");
  assert.equal(players[10][0].ppg, 20);
});

test("S6B routes return attributed fallbacks instead of WNBA 500 responses", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("stats.nba.com") || url.includes("stats.wnba.com")) throw new Error("direct source unavailable");
    if (url.includes("site.api.espn.com")) {
      return jsonResponse({ events: [
        espnEvent("1", "2026-07-31T00:00:00Z"),
        espnEvent("2", "2026-07-31T01:00:00Z"),
        espnEvent("3", "2026-07-31T02:00:00Z"),
      ] });
    }
    if (url.endsWith("/api/wnba/sos")) {
      return jsonResponse({ success: true, data: [{ teamId: 10, oppAvgNetRtg: 1.2, oppAvgOffRtg: 108, oppAvgDefRtg: 106.8, sosLabel: "Agenda promedio" }] });
    }
    if (url.endsWith("/api/wnba/players")) {
      return jsonResponse({ success: true, data: { 10: [{ playerId: 100, name: "Player One", min: 30 }] } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await withServer(fetcher, async (baseUrl) => {
    const schedule = await fetch(`${baseUrl}/api/wnba/games`);
    const sos = await fetch(`${baseUrl}/api/wnba/sos`);
    const players = await fetch(`${baseUrl}/api/wnba/players`);

    assert.equal(schedule.status, 200);
    assert.equal(sos.status, 200);
    assert.equal(players.status, 200);

    const scheduleBody: any = await schedule.json();
    const sosBody: any = await sos.json();
    const playersBody: any = await players.json();
    assert.equal(scheduleBody.source, "espn-readonly-fallback");
    assert.equal(scheduleBody.data.length, 3);
    assert.equal(sosBody.source, "production-readonly-fallback");
    assert.equal(playersBody.source, "production-readonly-fallback");
  });
});
