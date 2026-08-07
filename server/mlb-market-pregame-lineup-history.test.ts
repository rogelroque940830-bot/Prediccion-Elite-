import test from "node:test";
import assert from "node:assert/strict";
import {
  digestMlbHistoricalPregameLineupHistory,
  digestMlbHistoricalPregameLineupProvenance,
  extractMlbHistoricalPregameScheduleGames,
  fetchMlbHistoricalPregameLineups,
  formatMlbHistoricalTimecode,
  parseMlbHistoricalPregameLineupSnapshot,
  type MlbHistoricalPregameScheduleGame,
} from "./mlb-market-pregame-lineup-history";

const scheduleGame: MlbHistoricalPregameScheduleGame = {
  gamePk: 777001,
  officialDate: "2025-06-15",
  scheduledStart: "2025-06-15T17:05:00.000Z",
  homeTeamId: 147,
  awayTeamId: 111,
  scheduleResolution: "DIRECT",
};

function feed(options: {
  home?: number[];
  away?: number[];
  abstractGameState?: string;
  codedGameState?: string;
  detailedState?: string;
  metadata?: string;
  gamePk?: number;
  homeTeamId?: number;
  awayTeamId?: number;
} = {}) {
  return {
    gamePk: options.gamePk ?? scheduleGame.gamePk,
    metaData: { timeStamp: options.metadata ?? "20250615_165950" },
    gameData: {
      status: {
        abstractGameState: options.abstractGameState ?? "Preview",
        codedGameState: options.codedGameState ?? "P",
        detailedState: options.detailedState ?? "Pre-Game",
      },
      teams: {
        home: { id: options.homeTeamId ?? scheduleGame.homeTeamId },
        away: { id: options.awayTeamId ?? scheduleGame.awayTeamId },
      },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: options.home ?? [1, 2, 3, 4, 5, 6, 7, 8, 9] },
          away: { battingOrder: options.away ?? [11, 12, 13, 14, 15, 16, 17, 18, 19] },
        },
      },
    },
  };
}

function schedulePayload() {
  return {
    dates: [
      {
        date: "2025-06-15",
        games: [
          {
            gamePk: 777001,
            gameType: "R",
            officialDate: "2025-06-15",
            gameDate: "2025-06-15T17:05:00Z",
            status: { codedGameState: "F", detailedState: "Final" },
            teams: { home: { team: { id: 147 } }, away: { team: { id: 111 } } },
          },
          {
            gamePk: 777002,
            gameType: "R",
            officialDate: "2025-06-15",
            gameDate: "2025-06-15T23:05:00Z",
            status: { codedGameState: "F", detailedState: "Final" },
            teams: { home: { team: { id: 147 } }, away: { team: { id: 111 } } },
          },
        ],
      },
    ],
  };
}

function rescheduledPayload(options: {
  postponedHomeTeamId?: number;
  postponedCodedState?: string;
  postponedDetailedState?: string;
  addSecondFinal?: boolean;
} = {}) {
  const finalEntry = {
    gamePk: 778443,
    gameType: "R",
    officialDate: "2025-04-06",
    gameDate: "2025-04-06T17:35:00Z",
    status: { codedGameState: "F", detailedState: "Final" },
    teams: { home: { team: { id: 111 } }, away: { team: { id: 138 } } },
  };
  const dates: any[] = [
    {
      date: "2025-04-05",
      games: [
        {
          gamePk: 778443,
          gameType: "R",
          officialDate: "2025-04-06",
          gameDate: "2025-04-05T20:10:00Z",
          status: {
            codedGameState: options.postponedCodedState ?? "D",
            detailedState: options.postponedDetailedState ?? "Postponed",
          },
          teams: {
            home: { team: { id: options.postponedHomeTeamId ?? 111 } },
            away: { team: { id: 138 } },
          },
        },
      ],
    },
    { date: "2025-04-06", games: [finalEntry] },
  ];
  if (options.addSecondFinal) {
    dates.push({
      date: "2025-04-07",
      games: [{ ...finalEntry, gameDate: "2025-04-07T17:35:00Z" }],
    });
  }
  return { dates };
}

test("formats MLB historical timecode in UTC and derives a strict T-5 cutoff", () => {
  assert.equal(formatMlbHistoricalTimecode("2025-06-15T17:00:00.000Z"), "20250615_170000");
  const snapshot = parseMlbHistoricalPregameLineupSnapshot({ scheduleGame, payload: feed() });
  assert.equal(snapshot.cutoffAt, "2025-06-15T17:00:00.000Z");
  assert.equal(snapshot.requestedTimecode, "20250615_170000");
  assert.equal(snapshot.scheduleResolution, "DIRECT");
  assert.equal(Date.parse(snapshot.cutoffAt) < Date.parse(snapshot.scheduledStart), true);
});

test("schedule parser preserves gamePk, scheduled start and doubleheader identity", () => {
  const games = extractMlbHistoricalPregameScheduleGames(schedulePayload());
  assert.equal(games.length, 2);
  assert.deepEqual(games.map((game) => game.gamePk), [777001, 777002]);
  assert.notEqual(games[0].scheduledStart, games[1].scheduledStart);
  assert.deepEqual(games.map((game) => game.scheduleResolution), ["DIRECT", "DIRECT"]);
});

test("postponed listing may be superseded only by one played final with the same team identity", () => {
  const games = extractMlbHistoricalPregameScheduleGames(rescheduledPayload());
  assert.equal(games.length, 1);
  assert.equal(games[0].gamePk, 778443);
  assert.equal(games[0].officialDate, "2025-04-06");
  assert.equal(games[0].scheduledStart, "2025-04-06T17:35:00.000Z");
  assert.equal(games[0].homeTeamId, 111);
  assert.equal(games[0].awayTeamId, 138);
  assert.equal(games[0].scheduleResolution, "RESCHEDULED_FINAL_SELECTED");
});

test("rescheduled duplicate with team identity drift fails closed", () => {
  assert.throws(
    () => extractMlbHistoricalPregameScheduleGames(rescheduledPayload({ postponedHomeTeamId: 999 })),
    /P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT:778443/,
  );
});

test("final plus a non-obsolete active schedule listing remains an identity conflict", () => {
  assert.throws(
    () => extractMlbHistoricalPregameScheduleGames(rescheduledPayload({
      postponedCodedState: "P",
      postponedDetailedState: "Pre-Game",
    })),
    /P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT:778443/,
  );
});

test("two distinct played finals for one gamePk remain an identity conflict", () => {
  assert.throws(
    () => extractMlbHistoricalPregameScheduleGames(rescheduledPayload({ addSecondFinal: true })),
    /P1_M6A3B2C1_SCHEDULE_IDENTITY_CONFLICT:778443/,
  );
});

test("two official nine-player batting orders at a pregame snapshot are complete", () => {
  const snapshot = parseMlbHistoricalPregameLineupSnapshot({ scheduleGame, payload: feed() });
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.availability, "COMPLETE");
  assert.equal(snapshot.homeBattingOrder.length, 9);
  assert.equal(snapshot.awayBattingOrder.length, 9);
  assert.equal(new Set(snapshot.homeBattingOrder).size, 9);
});

test("incomplete or duplicated batting orders fail closed instead of being fabricated", () => {
  const homeIncomplete = parseMlbHistoricalPregameLineupSnapshot({
    scheduleGame,
    payload: feed({ home: [1, 2, 3, 4, 5, 6, 7, 8] }),
  });
  assert.equal(homeIncomplete.complete, false);
  assert.equal(homeIncomplete.availability, "HOME_INCOMPLETE");

  const duplicated = parseMlbHistoricalPregameLineupSnapshot({
    scheduleGame,
    payload: feed({ away: [11, 12, 13, 14, 15, 16, 17, 18, 18] }),
  });
  assert.equal(duplicated.complete, false);
  assert.equal(duplicated.availability, "AWAY_INCOMPLETE");
});

test("a live or final payload at the requested cutoff is rejected as non-pregame evidence", () => {
  const live = parseMlbHistoricalPregameLineupSnapshot({
    scheduleGame,
    payload: feed({ abstractGameState: "Live", codedGameState: "I", detailedState: "In Progress" }),
  });
  assert.equal(live.complete, false);
  assert.equal(live.availability, "NOT_PREGAME_AT_CUTOFF");
});

test("official team or game identity drift is a conflict even if batting orders are populated", () => {
  const snapshot = parseMlbHistoricalPregameLineupSnapshot({
    scheduleGame,
    payload: feed({ homeTeamId: 999 }),
  });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.availability, "IDENTITY_CONFLICT");
});

test("provider metadata drift changes provenance but not canonical lineup identity", () => {
  const a = parseMlbHistoricalPregameLineupSnapshot({ scheduleGame, payload: feed({ metadata: "20250615_165950" }) });
  const b = parseMlbHistoricalPregameLineupSnapshot({ scheduleGame, payload: feed({ metadata: "20250615_165959" }) });
  assert.notEqual(a.sourceDigest, b.sourceDigest);
  assert.equal(digestMlbHistoricalPregameLineupHistory([a]), digestMlbHistoricalPregameLineupHistory([b]));
  assert.notEqual(
    digestMlbHistoricalPregameLineupProvenance({ schedulePayload: schedulePayload(), snapshots: [a] }),
    digestMlbHistoricalPregameLineupProvenance({ schedulePayload: schedulePayload(), snapshots: [b] }),
  );
});

test("a real batting-order change changes canonical lineup identity", () => {
  const a = parseMlbHistoricalPregameLineupSnapshot({ scheduleGame, payload: feed() });
  const b = parseMlbHistoricalPregameLineupSnapshot({
    scheduleGame,
    payload: feed({ home: [2, 1, 3, 4, 5, 6, 7, 8, 9] }),
  });
  assert.notEqual(digestMlbHistoricalPregameLineupHistory([a]), digestMlbHistoricalPregameLineupHistory([b]));
});

test("fetch report requests exactly one historical T-5 snapshot per resolved scheduled game", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/schedule?")) {
      return new Response(JSON.stringify(schedulePayload()), { status: 200, headers: { "content-type": "application/json" } });
    }
    const match = url.match(/\/game\/(\d+)\/feed\/live\?timecode=(\d{8}_\d{6})/);
    assert.ok(match);
    const gamePk = Number(match[1]);
    if (gamePk === 777001) {
      assert.equal(match[2], "20250615_170000");
      return new Response(JSON.stringify(feed()), { status: 200 });
    }
    assert.equal(gamePk, 777002);
    assert.equal(match[2], "20250615_230000");
    return new Response(JSON.stringify(feed({ gamePk: 777002 })), { status: 200 });
  };

  const report = await fetchMlbHistoricalPregameLineups({
    startDate: "2025-06-15",
    endDate: "2025-06-15",
    concurrency: 2,
    retryBaseDelayMs: 0,
    fetchImpl,
  });
  assert.equal(report.scheduleGames, 2);
  assert.deepEqual(report.scheduleResolutionCounts, { DIRECT: 2, RESCHEDULED_FINAL_SELECTED: 0 });
  assert.equal(report.snapshotsFetched, 2);
  assert.equal(report.completeLineupGames, 2);
  assert.equal(report.failures.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(report.actionabilityAllowed, false);
  assert.equal(report.automaticModelSelectionAllowed, false);
  assert.equal(report.automaticPromotionAllowed, false);
});

test("resolved reschedule uses only the final played start for the historical cutoff", async () => {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/schedule?")) return new Response(JSON.stringify(rescheduledPayload()), { status: 200 });
    assert.match(url, /\/game\/778443\/feed\/live\?timecode=20250406_173000$/);
    return new Response(JSON.stringify(feed({ gamePk: 778443, homeTeamId: 111, awayTeamId: 138 })), { status: 200 });
  };
  const report = await fetchMlbHistoricalPregameLineups({
    startDate: "2025-04-05",
    endDate: "2025-04-06",
    concurrency: 1,
    retryBaseDelayMs: 0,
    fetchImpl,
  });
  assert.equal(report.scheduleGames, 1);
  assert.deepEqual(report.scheduleResolutionCounts, { DIRECT: 0, RESCHEDULED_FINAL_SELECTED: 1 });
  assert.equal(report.snapshotsFetched, 1);
  assert.equal(report.snapshots[0].scheduleResolution, "RESCHEDULED_FINAL_SELECTED");
  assert.equal(report.snapshots[0].scheduledStart, "2025-04-06T17:35:00.000Z");
  assert.equal(calls.length, 2);
});

test("persistent acquisition failure is recorded and never converted into lineup evidence", async () => {
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.includes("/v1/schedule?")) {
      const oneGame = schedulePayload();
      oneGame.dates[0].games = [oneGame.dates[0].games[0]];
      return new Response(JSON.stringify(oneGame), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
  };
  const report = await fetchMlbHistoricalPregameLineups({
    startDate: "2025-06-15",
    endDate: "2025-06-15",
    concurrency: 1,
    retryBaseDelayMs: 0,
    fetchImpl,
  });
  assert.equal(report.scheduleGames, 1);
  assert.equal(report.snapshotsFetched, 0);
  assert.equal(report.completeLineupGames, 0);
  assert.equal(report.failures.length, 1);
});

test("range, cutoff and concurrency guards fail before historical acquisition", async () => {
  await assert.rejects(
    fetchMlbHistoricalPregameLineups({ startDate: "2025-06-15", endDate: "2024-06-15" }),
    /INVALID_DATE_RANGE/,
  );
  await assert.rejects(
    fetchMlbHistoricalPregameLineups({ startDate: "2025-06-15", endDate: "2025-06-15", cutoffSecondsBeforeScheduledStart: 0 }),
    /INVALID_CUTOFF_SECONDS/,
  );
  await assert.rejects(
    fetchMlbHistoricalPregameLineups({ startDate: "2025-06-15", endDate: "2025-06-15", concurrency: 99 }),
    /INVALID_CONCURRENCY/,
  );
});
