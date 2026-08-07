import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_BULLPEN_EVIDENCE_SCHEMA,
  getBullpenStatus,
  resetMlbBullpenCachesForTests,
} from "./mlb-bullpen";

const NOW = new Date("2026-08-07T16:00:00.000Z");
const TEAM_ID = 112;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pitcherStats(input: {
  era: string;
  gamesPlayed: number;
  gamesStarted: number;
  inningsPitched: string;
  saves?: number;
  holds?: number;
}) {
  return {
    stats: [{
      splits: [{
        stat: {
          era: input.era,
          whip: "1.10",
          strikeoutsPer9Inn: "9.50",
          gamesPlayed: input.gamesPlayed,
          gamesStarted: input.gamesStarted,
          inningsPitched: input.inningsPitched,
          saves: input.saves ?? 0,
          holds: input.holds ?? 0,
        },
      }],
    }],
  };
}

function certifiedFetch(options: {
  rosterStatus?: number;
  boxscoreStatus?: number;
  missingStatsFor?: number | null;
} = {}) {
  return async (url: string): Promise<Response> => {
    if (url.includes(`/teams/${TEAM_ID}/roster?rosterType=Active`)) {
      if (options.rosterStatus && options.rosterStatus !== 200) return json({ error: "roster unavailable" }, options.rosterStatus);
      return json({
        roster: [
          { person: { id: 1, fullName: "Closer One" }, position: { code: "1" } },
          { person: { id: 2, fullName: "Setup Two" }, position: { code: "1" } },
          { person: { id: 3, fullName: "Starter Three" }, position: { code: "1" } },
        ],
      });
    }

    const statsMatch = url.match(/\/people\/(\d+)\/stats\?/);
    if (statsMatch) {
      const pitcherId = Number(statsMatch[1]);
      if (options.missingStatsFor === pitcherId) return json({ stats: [] });
      if (pitcherId === 1) return json(pitcherStats({ era: "2.40", gamesPlayed: 42, gamesStarted: 0, inningsPitched: "41.0", saves: 22 }));
      if (pitcherId === 2) return json(pitcherStats({ era: "3.10", gamesPlayed: 40, gamesStarted: 0, inningsPitched: "38.0", holds: 16 }));
      if (pitcherId === 3) return json(pitcherStats({ era: "3.50", gamesPlayed: 22, gamesStarted: 22, inningsPitched: "125.0" }));
    }

    if (url.includes(`/schedule?sportId=1&teamId=${TEAM_ID}`)) {
      return json({
        dates: [{
          date: "2026-08-06",
          games: [{ gamePk: 777001, status: { codedGameState: "F", detailedState: "Final" } }],
        }],
      });
    }

    if (url.includes("/game/777001/feed/live")) {
      if (options.boxscoreStatus && options.boxscoreStatus !== 200) return json({ error: "boxscore unavailable" }, options.boxscoreStatus);
      return json({
        liveData: {
          boxscore: {
            teams: {
              home: {
                team: { id: TEAM_ID },
                pitchers: [3, 1, 2],
                players: {
                  ID1: { person: { fullName: "Closer One" }, stats: { pitching: { pitchesThrown: 25, battersFaced: 5, inningsPitched: "1.0" } } },
                  ID2: { person: { fullName: "Setup Two" }, stats: { pitching: { pitchesThrown: 15, battersFaced: 4, inningsPitched: "1.0" } } },
                  ID3: { person: { fullName: "Starter Three" }, stats: { pitching: { pitchesThrown: 90, battersFaced: 25, inningsPitched: "6.0" } } },
                },
              },
              away: { team: { id: 999 }, pitchers: [9], players: {} },
            },
          },
        },
      });
    }

    return json({ error: `unexpected ${url}` }, 404);
  };
}

function runtime(fetchImpl: (url: string) => Promise<Response>) {
  return { fetchImpl, now: () => new Date(NOW) };
}

test("complete bullpen inputs produce explicit certified temporal evidence", async () => {
  resetMlbBullpenCachesForTests();
  const status = await getBullpenStatus(TEAM_ID, "Chicago Cubs", runtime(certifiedFetch()));

  assert.equal(status.sourceStatus, "CERTIFIED");
  assert.equal(status.generatedAt, NOW.toISOString());
  assert.equal(status.provenance.schemaVersion, MLB_BULLPEN_EVIDENCE_SCHEMA);
  assert.equal(status.provenance.status, "CERTIFIED");
  assert.equal(status.provenance.roster.pitchersObserved, 3);
  assert.equal(status.provenance.roster.cacheMaxAgeSeconds, 1800);
  assert.equal(status.provenance.seasonStats.pitchersRequested, 3);
  assert.equal(status.provenance.seasonStats.pitchersVerified, 3);
  assert.equal(status.provenance.recentUsage.finalGamesVerified, 1);
  assert.equal(status.provenance.recentUsage.boxscoresVerified, 1);
  assert.equal(status.closer?.id, 1);
  assert.equal(status.closer?.totalPitchesLast3Days, 25);
  assert.equal(status.setupMen[0]?.id, 2);
});

test("roster source failure rejects instead of becoming an empty rested bullpen", async () => {
  resetMlbBullpenCachesForTests();
  await assert.rejects(
    () => getBullpenStatus(TEAM_ID, "Chicago Cubs", runtime(certifiedFetch({ rosterStatus: 503 }))),
    /BULLPEN_SOURCE_HTTP_503/,
  );
});

test("missing season-role evidence rejects instead of silently classifying a pitcher as UNKNOWN", async () => {
  resetMlbBullpenCachesForTests();
  await assert.rejects(
    () => getBullpenStatus(TEAM_ID, "Chicago Cubs", runtime(certifiedFetch({ missingStatsFor: 2 }))),
    /BULLPEN_SEASON_STATS_UNAVAILABLE:2/,
  );
});

test("recent boxscore failure rejects instead of treating relievers as rested", async () => {
  resetMlbBullpenCachesForTests();
  await assert.rejects(
    () => getBullpenStatus(TEAM_ID, "Chicago Cubs", runtime(certifiedFetch({ boxscoreStatus: 503 }))),
    /BULLPEN_SOURCE_HTTP_503/,
  );
});
