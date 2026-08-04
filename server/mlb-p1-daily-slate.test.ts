import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbP1DailySlate,
  classifyMlbP1Readiness,
  isValidMlbP1Date,
  normalizeMlbP1GameState,
  type MlbP1Pitcher,
} from "./mlb-p1-daily-slate";

const pitcher = (name: string | null): MlbP1Pitcher => ({
  id: name ? 10 : null,
  name,
  hand: name ? "R" : null,
  confirmed: Boolean(name),
});

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scheduleGame(gamePk: number, status: Record<string, unknown> = { abstractGameState: "Preview", detailedState: "Scheduled" }) {
  return {
    gamePk,
    gameDate: "2026-08-04T23:10:00Z",
    officialDate: "2026-08-04",
    status,
    venue: { name: "Test Park" },
    teams: {
      home: { team: { id: 1, name: "Home Club" }, probablePitcher: { id: 11, fullName: "Home Starter" } },
      away: { team: { id: 2, name: "Away Club" }, probablePitcher: { id: 22, fullName: "Away Starter" } },
    },
  };
}

function liveFeed(options: {
  state?: string;
  detailed?: string;
  homePitcher?: boolean;
  awayPitcher?: boolean;
  homeLineup?: number;
  awayLineup?: number;
} = {}) {
  const {
    state = "Preview",
    detailed = "Scheduled",
    homePitcher = true,
    awayPitcher = true,
    homeLineup = 0,
    awayLineup = 0,
  } = options;
  const battingOrder = (count: number, start: number) => Array.from({ length: count }, (_, index) => start + index);
  return {
    gameData: {
      status: { abstractGameState: state, detailedState: detailed },
      datetime: { dateTime: "2026-08-04T23:10:00Z", officialDate: "2026-08-04" },
      venue: { name: "Test Park" },
      teams: { home: { id: 1, name: "Home Club" }, away: { id: 2, name: "Away Club" } },
      probablePitchers: {
        ...(homePitcher ? { home: { id: 11, fullName: "Home Starter" } } : {}),
        ...(awayPitcher ? { away: { id: 22, fullName: "Away Starter" } } : {}),
      },
      players: {
        ...(homePitcher ? { ID11: { fullName: "Home Starter", pitchHand: { code: "R" } } } : {}),
        ...(awayPitcher ? { ID22: { fullName: "Away Starter", pitchHand: { code: "L" } } } : {}),
      },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: battingOrder(homeLineup, 100) },
          away: { battingOrder: battingOrder(awayLineup, 200) },
        },
      },
    },
  };
}

test("validates calendar dates strictly", () => {
  assert.equal(isValidMlbP1Date("2026-08-04"), true);
  assert.equal(isValidMlbP1Date("2026-02-30"), false);
  assert.equal(isValidMlbP1Date("08/04/2026"), false);
});

test("normalizes official MLB states conservatively", () => {
  assert.equal(normalizeMlbP1GameState({ abstractGameState: "Preview", detailedState: "Scheduled" }), "SCHEDULED");
  assert.equal(normalizeMlbP1GameState({ abstractGameState: "Live", detailedState: "In Progress" }), "IN_PROGRESS");
  assert.equal(normalizeMlbP1GameState({ abstractGameState: "Final", detailedState: "Final" }), "FINAL");
  assert.equal(normalizeMlbP1GameState({ detailedState: "Postponed" }), "POSTPONED");
});

test("readiness is FINAL only with both pitchers and both nine-player lineups", () => {
  assert.deepEqual(classifyMlbP1Readiness({
    state: "SCHEDULED",
    homePitcher: pitcher("Home"),
    awayPitcher: pitcher("Away"),
    lineupState: "CONFIRMED",
    sourceQuality: "AUTHORITATIVE",
  }), {
    readiness: "READY_TO_ANALYZE",
    analysisStage: "FINAL",
    analysisAllowed: true,
    blockers: [],
  });
});

test("probable pitchers permit only a provisional analysis while lineups are absent", () => {
  const result = classifyMlbP1Readiness({
    state: "SCHEDULED",
    homePitcher: pitcher("Home"),
    awayPitcher: pitcher("Away"),
    lineupState: "NOT_POSTED",
    sourceQuality: "AUTHORITATIVE",
  });
  assert.equal(result.readiness, "PROVISIONAL_WAITING_FOR_LINEUPS");
  assert.equal(result.analysisStage, "PROVISIONAL");
  assert.equal(result.analysisAllowed, true);
  assert.match(result.blockers[0], /lineups oficiales/i);
});

test("missing pitchers and started games fail closed", () => {
  const missing = classifyMlbP1Readiness({
    state: "SCHEDULED",
    homePitcher: pitcher(null),
    awayPitcher: pitcher("Away"),
    lineupState: "NOT_POSTED",
    sourceQuality: "AUTHORITATIVE",
  });
  assert.equal(missing.readiness, "WAITING_FOR_PITCHERS");
  assert.equal(missing.analysisAllowed, false);

  const started = classifyMlbP1Readiness({
    state: "IN_PROGRESS",
    homePitcher: pitcher("Home"),
    awayPitcher: pitcher("Away"),
    lineupState: "CONFIRMED",
    sourceQuality: "AUTHORITATIVE",
  });
  assert.equal(started.readiness, "GAME_ALREADY_STARTED");
  assert.equal(started.analysisAllowed, false);
});

test("builds a sorted daily slate and exposes FINAL versus PROVISIONAL readiness", async () => {
  const schedule = {
    dates: [{ games: [scheduleGame(200), { ...scheduleGame(100), gameDate: "2026-08-04T20:10:00Z" }] }],
  };
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("/schedule?")) return response(schedule);
    if (url.includes("/game/100/")) return response(liveFeed({ homeLineup: 9, awayLineup: 9 }));
    if (url.includes("/game/200/")) return response(liveFeed({ homeLineup: 0, awayLineup: 0 }));
    return response({}, 404);
  };
  const report = await buildMlbP1DailySlate({
    date: "2026-08-04",
    fetchImpl,
    now: new Date("2026-08-04T16:00:00Z"),
  });
  assert.equal(report.schemaVersion, "courtedge-p1-mlb-daily-slate.v1");
  assert.deepEqual(report.games.map((game) => game.gamePk), [100, 200]);
  assert.equal(report.games[0].readiness, "READY_TO_ANALYZE");
  assert.equal(report.games[0].analysisStage, "FINAL");
  assert.equal(report.games[1].readiness, "PROVISIONAL_WAITING_FOR_LINEUPS");
  assert.equal(report.summary.ready, 1);
  assert.equal(report.summary.provisional, 1);
  assert.equal(report.safety.realFinancialExposure, 0);
});

test("degrades one game safely when its official live feed is unavailable", async () => {
  const fetchImpl = async (url: string): Promise<Response> => {
    if (url.includes("/schedule?")) return response({ dates: [{ games: [scheduleGame(300)] }] });
    return response({ error: "unavailable" }, 503);
  };
  const report = await buildMlbP1DailySlate({ date: "2026-08-04", fetchImpl });
  assert.equal(report.games.length, 1);
  assert.equal(report.games[0].source.quality, "DEGRADED");
  assert.equal(report.games[0].readiness, "DATA_INSUFFICIENT");
  assert.equal(report.games[0].analysisAllowed, false);
});
