import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_DISCIPLINE_SPEED_EVIDENCE_SCHEMA,
  getDisciplineSpeedCertifiedSnapshot,
  resetDisciplineSpeedCachesForTests,
} from "./mlb-discipline-speed";

const T0 = new Date("2026-08-07T20:00:00.000Z");

const speedCsv = [
  'player_id,player_name,team_name,position_name,hp_to_1b,sprint_speed,bolts_count',
  '101,"Fast, Batter",CHC,CF,4.20,29.1,10',
  '102,"Slow, Batter",DET,1B,4.80,25.9,2',
].join("\n");

function pitcherPayload(withSample = true) {
  return withSample
    ? { stats: [{ splits: [{ stat: { strikePercentage: ".66", strikeOuts: "100", battersFaced: "400", inningsPitched: "100.0" } }] }] }
    : { stats: [{ splits: [] }] };
}

function sourceFetch(options: {
  pitcherStatus?: number;
  speedStatus?: number;
  emptySpeed?: boolean;
  noPitcherSample?: boolean;
} = {}) {
  let totalCalls = 0;
  let speedCalls = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    totalCalls++;
    if (url.includes("baseballsavant.mlb.com/leaderboard/sprint_speed")) {
      speedCalls++;
      const status = options.speedStatus ?? 200;
      if (status !== 200) return new Response("speed unavailable", { status });
      return new Response(options.emptySpeed ? "player_id\n" : speedCsv, { status: 200 });
    }
    if (url.includes("statsapi.mlb.com/api/v1/people/")) {
      const status = options.pitcherStatus ?? 200;
      if (status !== 200) return new Response("pitcher unavailable", { status });
      return new Response(JSON.stringify(pitcherPayload(options.noPitcherSample !== true)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fetchImpl, totalCalls: () => totalCalls, speedCalls: () => speedCalls };
}

function args() {
  return {
    homePitcherId: 11,
    homePitcherName: "Home Starter",
    awayPitcherId: 22,
    awayPitcherName: "Away Starter",
    homeBatterIds: [101],
    awayBatterIds: [102],
  };
}

test("complete MLB pitcher acquisition plus Savant speed emits certified provenance", async () => {
  resetDisciplineSpeedCachesForTests();
  const source = sourceFetch();
  const snapshot = await getDisciplineSpeedCertifiedSnapshot({
    ...args(),
    runtime: { fetchImpl: source.fetchImpl, now: () => T0 },
  });

  assert.equal(source.totalCalls(), 3);
  assert.equal(source.speedCalls(), 1);
  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.generatedAt, T0.toISOString());
  assert.equal(snapshot.provenance.schemaVersion, MLB_DISCIPLINE_SPEED_EVIDENCE_SCHEMA);
  assert.equal(snapshot.provenance.status, "CERTIFIED");
  assert.equal(snapshot.provenance.failureDisposition, "THROW_FAIL_CLOSED");
  assert.equal(snapshot.provenance.speedCacheMaxAgeSeconds, 21_600);
  assert.equal(snapshot.homeSPDiscipline?.strikePct, 66);
  assert.equal(snapshot.homeBatterSpeed[0]?.sprintSpeed, 29.1);
});

test("valid MLB response with no season split is a certified no-sample result, not a source failure", async () => {
  resetDisciplineSpeedCachesForTests();
  const source = sourceFetch({ noPitcherSample: true });
  const snapshot = await getDisciplineSpeedCertifiedSnapshot({
    ...args(),
    runtime: { fetchImpl: source.fetchImpl, now: () => T0 },
  });

  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.homeSPDiscipline, null);
  assert.equal(snapshot.awaySPDiscipline, null);
  assert.equal(snapshot.provenance.homePitcherSampleStatus, "NO_SEASON_SAMPLE");
  assert.equal(snapshot.provenance.awayPitcherSampleStatus, "NO_SEASON_SAMPLE");
});

test("MLB pitcher transport failure blocks certification instead of becoming a harmless null", async () => {
  resetDisciplineSpeedCachesForTests();
  const source = sourceFetch({ pitcherStatus: 503 });
  await assert.rejects(
    getDisciplineSpeedCertifiedSnapshot({ ...args(), runtime: { fetchImpl: source.fetchImpl, now: () => T0 } }),
    /DISCIPLINE_SPEED_SOURCE_HTTP_503:PITCHER_SEASON/,
  );
});

test("within-TTL Savant speed cache stays certified while pitcher evidence is reacquired", async () => {
  resetDisciplineSpeedCachesForTests();
  const first = sourceFetch();
  await getDisciplineSpeedCertifiedSnapshot({ ...args(), runtime: { fetchImpl: first.fetchImpl, now: () => T0 } });

  const later = new Date(T0.getTime() + 60 * 60 * 1000);
  const second = sourceFetch({ speedStatus: 503 });
  const snapshot = await getDisciplineSpeedCertifiedSnapshot({
    ...args(),
    runtime: { fetchImpl: second.fetchImpl, now: () => later },
  });

  assert.equal(second.speedCalls(), 0);
  assert.equal(second.totalCalls(), 2);
  assert.equal(snapshot.provenance.speedCacheHit, true);
  assert.equal(snapshot.provenance.speedCacheAgeSeconds, 3600);
  assert.equal(snapshot.generatedAt, T0.toISOString());
});

test("expired speed cache cannot be recertified when Savant refresh fails", async () => {
  resetDisciplineSpeedCachesForTests();
  const initial = sourceFetch();
  await getDisciplineSpeedCertifiedSnapshot({ ...args(), runtime: { fetchImpl: initial.fetchImpl, now: () => T0 } });

  const expired = new Date(T0.getTime() + 7 * 60 * 60 * 1000);
  const failing = sourceFetch({ speedStatus: 503 });
  await assert.rejects(
    getDisciplineSpeedCertifiedSnapshot({ ...args(), runtime: { fetchImpl: failing.fetchImpl, now: () => expired } }),
    /DISCIPLINE_SPEED_SOURCE_HTTP_503:SPRINT_SPEED/,
  );
  assert.equal(failing.speedCalls(), 1);
});

test("empty Savant speed leaderboard fails closed", async () => {
  resetDisciplineSpeedCachesForTests();
  const source = sourceFetch({ emptySpeed: true });
  await assert.rejects(
    getDisciplineSpeedCertifiedSnapshot({ ...args(), runtime: { fetchImpl: source.fetchImpl, now: () => T0 } }),
    /DISCIPLINE_SPEED_SPRINT_SPEED_EMPTY/,
  );
});
