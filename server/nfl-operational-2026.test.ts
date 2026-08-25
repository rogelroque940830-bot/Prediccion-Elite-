import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateNflPbpCsvText,
  buildNflOperational2026SnapshotFromData,
  parseCsvLine,
  parseNflOperationalDepthCsv,
  parseNflOperationalScheduleCsv,
} from "./nfl-operational-2026";

function withCoreReady<T>(fn: () => T): T {
  const keys = [
    "NFL_R5H18_PROSPECTIVE_GATE",
    "NFL_ELITE_2026_ARTIFACT_VERIFIED",
    "NFL_ELITE_MATERIALIZER_VERIFIED",
    "NFL_ELITE_PARITY_GATE",
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.NFL_R5H18_PROSPECTIVE_GATE = "FAIL";
    process.env.NFL_ELITE_2026_ARTIFACT_VERIFIED = "true";
    process.env.NFL_ELITE_MATERIALIZER_VERIFIED = "true";
    process.env.NFL_ELITE_PARITY_GATE = "PASS";
    return fn();
  } finally {
    for (const key of keys) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const scheduleHeader = "game_id,season,game_type,week,gameday,away_team,home_team,away_score,home_score";
const depthHeader = "dt,team,gsis_id,pos_abb,pos_name,pos_rank";

function depthFor(at = "2026-08-20"): string {
  return [
    depthHeader,
    `${at},BUF,QB_BUF,QB,Quarterback,1`,
    `${at},MIA,QB_MIA,QB,Quarterback,1`,
    `${at},KC,QB_KC,QB,Quarterback,1`,
    `${at},DEN,QB_DEN,QB,Quarterback,1`,
  ].join("\n");
}

test("NFL operational CSV parser preserves commas and escaped quotes", () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ["a", "b,c", 'd"e']);
});

test("NFL operational schedule accepts only 2026 regular-season rows", () => {
  const text = [
    scheduleHeader,
    "2026_01_BUF_MIA,2026,REG,1,2026-09-10,BUF,MIA,,",
    "2026_PRE_BUF_MIA,2026,PRE,1,2026-08-20,BUF,MIA,20,17",
    "2025_18_BUF_MIA,2025,REG,18,2026-01-04,BUF,MIA,20,17",
  ].join("\n");
  const rows = parseNflOperationalScheduleCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gameId, "2026_01_BUF_MIA");
  assert.equal(rows[0].completed, false);
});

test("NFL operational depth groups timestamped QB snapshots and ignores non-QBs", () => {
  const text = [
    depthHeader,
    "2026-08-20,BUF,QB2,QB,Quarterback,2",
    "2026-08-20,BUF,QB1,QB,Quarterback,1",
    "2026-08-20,BUF,WR1,WR,Wide Receiver,1",
  ].join("\n");
  const rows = parseNflOperationalDepthCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].team, "BUF");
  assert.deepEqual(rows[0].qbs, [{ qbId: "QB1", rank: 1 }, { qbId: "QB2", rank: 2 }]);
});

test("NFL operational PBP aggregator matches the frozen team/QB metric semantics", () => {
  const header = [
    "game_id","season_type","posteam","defteam","epa","success","pass_attempt","rush_attempt",
    "qb_dropback","sack","yards_gained","drive","no_play","qb_kneel","qb_spike","passer_player_id","cpoe",
  ].join(",");
  const text = [
    header,
    "G1,REG,BUF,MIA,0.4,1,1,0,1,0,25,1,0,0,0,Q1,5",
    "G1,REG,BUF,MIA,-0.2,0,1,0,1,1,-8,2,0,0,0,Q1,-4",
    "G1,REG,BUF,MIA,0.1,1,0,1,0,0,12,2,0,0,0,,",
    "G1,REG,MIA,BUF,-0.1,0,1,0,1,0,8,1,0,0,0,Q2,-1",
    "G1,REG,MIA,BUF,0.2,1,0,1,0,0,4,1,0,0,0,,",
  ].join("\n");
  const out = aggregateNflPbpCsvText(text);
  const game = out.observations.get("G1");
  assert.ok(game);
  const buf = game.teams.get("BUF");
  assert.ok(buf);
  assert.ok(Math.abs((buf.off_epa ?? 0) - 0.1) < 1e-12);
  assert.ok(Math.abs((buf.off_success ?? 0) - 2 / 3) < 1e-12);
  assert.equal(buf.plays, 3);
  assert.equal(buf.drives, 2);
  assert.ok(Math.abs((buf.pass_epa ?? 0) - 0.1) < 1e-12);
  assert.equal(buf.pass_success, 0.5);
  assert.equal(buf.sack_rate, 0.5);
  assert.equal(buf.explosive_pass, 0.5);
  assert.equal(buf.rush_epa, 0.1);
  assert.equal(buf.rush_success, 1);
  assert.equal(buf.explosive_rush, 1);
  const q1 = game.qbs.find((qb) => qb.qbId === "Q1");
  assert.ok(q1);
  assert.equal(q1.qbDropbacks, 2);
  assert.ok(Math.abs((q1.qbEpa ?? 0) - 0.1) < 1e-12);
  assert.equal(q1.qbCpoe, 0.5);
  assert.equal(q1.qbSackRate, 0.5);
});

test("NFL operational snapshot scores only the current frontier week from the frozen end-2025 state", () => {
  withCoreReady(() => {
    const scheduleCsv = [
      scheduleHeader,
      "2026_01_BUF_MIA,2026,REG,1,2026-09-10,BUF,MIA,,",
      "2026_02_KC_DEN,2026,REG,2,2026-09-17,KC,DEN,,",
    ].join("\n");
    const snapshot = buildNflOperational2026SnapshotFromData({
      scheduleCsv,
      depthCsv: depthFor(),
      pbp: null,
      generatedAt: "2026-08-24T23:00:00Z",
    });
    assert.equal(snapshot.activeWeek, 1);
    assert.equal(snapshot.cards.length, 1);
    assert.equal(snapshot.cards[0].gameId, "2026_01_BUF_MIA");
    assert.notEqual(snapshot.cards[0].state, "BLOCKED");
    assert.ok(snapshot.cards[0].score);
    assert.equal(snapshot.cards[0].score?.safety.marketDataUsedAsModelFeature, false);
    assert.equal(snapshot.cards[0].materialization?.processedCompletedGames, 3663);
  });
});

test("NFL operational snapshot rejects depth snapshots that were not available as of generatedAt", () => {
  withCoreReady(() => {
    const scheduleCsv = [scheduleHeader, "2026_01_BUF_MIA,2026,REG,1,2026-09-10,BUF,MIA,,"].join("\n");
    const snapshot = buildNflOperational2026SnapshotFromData({
      scheduleCsv,
      depthCsv: depthFor("2026-09-01"),
      pbp: null,
      generatedAt: "2026-08-24T23:00:00Z",
    });
    assert.equal(snapshot.cards[0].state, "BLOCKED");
    assert.match(snapshot.cards[0].reasons.join(" "), /timestamped QB depth/i);
  });
});

test("NFL operational snapshot fails closed when a prior completed game has no certified PBP observation", () => {
  withCoreReady(() => {
    const scheduleCsv = [
      scheduleHeader,
      "2026_01_BUF_MIA,2026,REG,1,2026-09-10,BUF,MIA,20,27",
      "2026_02_KC_DEN,2026,REG,2,2026-09-17,KC,DEN,,",
    ].join("\n");
    const snapshot = buildNflOperational2026SnapshotFromData({
      scheduleCsv,
      depthCsv: depthFor(),
      pbp: null,
      generatedAt: "2026-09-15T12:00:00Z",
    });
    assert.equal(snapshot.activeWeek, 2);
    assert.equal(snapshot.cards.length, 1);
    assert.equal(snapshot.cards[0].state, "BLOCKED");
    assert.match(snapshot.cards[0].reasons.join(" "), /incomplete completed-game observation/i);
    assert.equal(snapshot.completedGamesApplied, 0);
    assert.equal(snapshot.state, "BLOCKED");
  });
});
