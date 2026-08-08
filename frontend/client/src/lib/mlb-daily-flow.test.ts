import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbReviewQueue } from "./mlb-review-priority";
import {
  P1_M1_RELEASE,
  mlbDailyCanPrepare,
  mlbDailyGameTimeLabel,
  mlbDailyPitcherName,
  mlbDailyReadinessDetail,
  mlbDailyReadinessLabel,
  summarizeMlbDailySlate,
} from "./mlb-daily-flow";

const now = Date.parse("2026-08-04T16:00:00-04:00");
const games = [
  {
    gameId: 1,
    gameDate: "2026-08-04T19:10:00-04:00",
    homeTeam: { name: "Miami Marlins" },
    awayTeam: { name: "Atlanta Braves" },
    homePitcher: { name: "Home Starter" },
    awayPitcher: { fullName: "Away Starter" },
  },
  {
    gameId: 2,
    gameDate: "2026-08-04T20:10:00-04:00",
    homeTeam: { name: "New York Mets" },
    awayTeam: { name: "Philadelphia Phillies" },
    homePitcher: null,
    awayPitcher: { name: "Visitor Starter" },
  },
  {
    gameId: 3,
    gameDate: "2026-08-04T13:10:00-04:00",
    homeTeam: { name: "Chicago Cubs" },
    awayTeam: { name: "Milwaukee Brewers" },
    homePitcher: { name: "Started Home" },
    awayPitcher: { name: "Started Away" },
  },
];

test("summarizes ready, waiting and closed games", () => {
  const queue = buildMlbReviewQueue(games, now);
  assert.deepEqual(summarizeMlbDailySlate(queue), {
    total: 3,
    ready: 1,
    waitingPitchers: 1,
    closed: 1,
  });
});

test("labels readiness for the user-facing daily flow", () => {
  assert.equal(mlbDailyReadinessLabel("READY"), "LISTO PARA PREPARAR");
  assert.equal(mlbDailyReadinessLabel("PENDING"), "ESPERAR PITCHERS");
  assert.equal(mlbDailyReadinessLabel("CLOSED"), "JUEGO CERRADO");
  assert.match(mlbDailyReadinessDetail("READY"), /abridores/i);
  assert.match(mlbDailyReadinessDetail("PENDING"), /Falta confirmar/i);
  assert.match(mlbDailyReadinessDetail("CLOSED"), /ya comenzó/i);
});

test("allows preparation only before closure", () => {
  assert.equal(mlbDailyCanPrepare("READY"), true);
  assert.equal(mlbDailyCanPrepare("PENDING"), true);
  assert.equal(mlbDailyCanPrepare("CLOSED"), false);
});

test("formats pitchers, time and release deterministically", () => {
  assert.equal(mlbDailyPitcherName({ name: "  Spencer Strider  " }), "Spencer Strider");
  assert.equal(mlbDailyPitcherName(null), "TBD");
  assert.notEqual(mlbDailyGameTimeLabel("2026-08-04T19:10:00-04:00"), "Hora pendiente");
  assert.equal(mlbDailyGameTimeLabel("not-a-date"), "Hora pendiente");
  assert.equal(P1_M1_RELEASE, "p1-m1-mlb-daily-flow-2026-08-04");
});
