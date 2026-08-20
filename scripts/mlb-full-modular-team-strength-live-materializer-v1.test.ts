import assert from "node:assert/strict";
import test from "node:test";
import { MlbFullModularTeamStrengthLiveMaterializer } from "../server/mlb-full-modular-team-strength-live-materializer";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function finalStatus() {
  return { abstractGameState: "Final", detailedState: "Final", codedGameState: "F" };
}

function schedulePayload(game: unknown) {
  return { dates: [{ date: "2026-04-03", games: [game] }] };
}

function liveFeed(input: {
  gamePk?: number;
  officialDate?: string;
  homeTeamId?: number;
  awayTeamId?: number;
  homeRuns?: number;
  awayRuns?: number;
  final?: boolean;
}) {
  return {
    gamePk: input.gamePk ?? 824621,
    gameData: {
      game: { pk: input.gamePk ?? 824621, type: "R" },
      datetime: { officialDate: input.officialDate ?? "2026-04-03" },
      status: input.final === false ? { abstractGameState: "Live", detailedState: "In Progress" } : finalStatus(),
      teams: {
        home: { id: input.homeTeamId ?? 145 },
        away: { id: input.awayTeamId ?? 141 },
      },
    },
    liveData: {
      linescore: {
        teams: {
          home: { runs: input.homeRuns ?? 5 },
          away: { runs: input.awayRuns ?? 4 },
        },
      },
    },
  };
}

test("valid schedule rows remain schedule-only and do not trigger fallback", async () => {
  const urls: string[] = [];
  const materializer = new MlbFullModularTeamStrengthLiveMaterializer({
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse(schedulePayload({
        gamePk: 1001,
        officialDate: "2026-04-03",
        status: finalStatus(),
        teams: {
          home: { team: { id: 10 }, score: 3 },
          away: { team: { id: 20 }, score: 1 },
        },
      }));
    },
  });

  const snapshot = await materializer.materializeDate("2026-08-19");
  assert.equal(snapshot.priorGames[10], 1);
  assert.equal(snapshot.priorGames[20], 1);
  assert.deepEqual(snapshot.quarantinedGamePks, []);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/schedule\?/);
  assert.equal(snapshot.provenance.sameDateOutcomesUsed, false);
});

test("structurally invalid final schedule row is recovered only from official live feed", async () => {
  const urls: string[] = [];
  const materializer = new MlbFullModularTeamStrengthLiveMaterializer({
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes("/schedule?")) {
        return jsonResponse(schedulePayload({
          gamePk: 824621,
          officialDate: "2026-04-03",
          status: finalStatus(),
          teams: {
            home: { team: { id: 145 }, score: null },
            away: { team: { id: 141 }, score: 4 },
          },
        }));
      }
      if (url.endsWith("/game/824621/feed/live")) {
        return jsonResponse(liveFeed({}));
      }
      return jsonResponse({}, 404);
    },
  });

  const snapshot = await materializer.materializeDate("2026-08-19");
  assert.equal(snapshot.priorGames[145], 1);
  assert.equal(snapshot.priorGames[141], 1);
  assert.deepEqual(snapshot.quarantinedGamePks, []);
  assert.equal(snapshot.provenance.structuralRecovery, "MLB_OFFICIAL_LIVE_FEED_FOR_INVALID_FINAL_SCHEDULE_ROWS");
  assert.equal(urls.filter((url) => url.endsWith("/game/824621/feed/live")).length, 1);
});

test("stale schedule FINAL contradicted by official non-final live feed is quarantined, not scored", async () => {
  const materializer = new MlbFullModularTeamStrengthLiveMaterializer({
    fetchImpl: async (url) => {
      if (url.includes("/schedule?")) {
        return jsonResponse(schedulePayload({
          gamePk: 823543,
          officialDate: "2026-04-03",
          status: finalStatus(),
          teams: {
            home: { team: { id: 145 }, score: null },
            away: { team: { id: 141 }, score: null },
          },
        }));
      }
      return jsonResponse(liveFeed({ gamePk: 823543, final: false }));
    },
  });

  const snapshot = await materializer.materializeDate("2026-08-19");
  assert.deepEqual(snapshot.quarantinedGamePks, [823543]);
  assert.equal(snapshot.priorGames[145], undefined);
  assert.equal(snapshot.priorGames[141], undefined);
  assert.equal(snapshot.provenance.historicalQuarantine, "OFFICIAL_LIVE_FEED_NON_FINAL_ROWS_EXCLUDED");
});

test("official live-feed recovery fails closed on schedule/live team conflict", async () => {
  const materializer = new MlbFullModularTeamStrengthLiveMaterializer({
    fetchImpl: async (url) => {
      if (url.includes("/schedule?")) {
        return jsonResponse(schedulePayload({
          gamePk: 824621,
          officialDate: "2026-04-03",
          status: finalStatus(),
          teams: {
            home: { team: { id: 145 }, score: null },
            away: { team: { id: 141 }, score: 4 },
          },
        }));
      }
      return jsonResponse(liveFeed({ homeTeamId: 999 }));
    },
  });

  await assert.rejects(
    () => materializer.materializeDate("2026-08-19"),
    /FULL_MODULAR_STRENGTH_SOURCE_TEAM_CONFLICT:824621/,
  );
});

test("official live-feed recovery rejects same-date outcomes", async () => {
  const materializer = new MlbFullModularTeamStrengthLiveMaterializer({
    fetchImpl: async (url) => {
      if (url.includes("/schedule?")) {
        return jsonResponse({ dates: [{ date: "2026-08-19", games: [{
          gamePk: 824621,
          officialDate: "2026-08-19",
          status: finalStatus(),
          teams: {
            home: { team: { id: 145 }, score: null },
            away: { team: { id: 141 }, score: 4 },
          },
        }] }] });
      }
      return jsonResponse(liveFeed({ officialDate: "2026-08-19" }));
    },
  });

  await assert.rejects(
    () => materializer.materializeDate("2026-08-19"),
    /FULL_MODULAR_STRENGTH_LIVE_FEED_GAME_INVALID:824621/,
  );
});