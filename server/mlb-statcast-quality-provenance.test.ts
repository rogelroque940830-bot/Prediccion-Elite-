import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_STATCAST_QUALITY_EVIDENCE_SCHEMA,
  getStatcastQualityCertifiedSnapshot,
  resetStatcastQualityCachesForTests,
} from "./mlb-statcast-quality";

const T0 = new Date("2026-08-07T20:00:00.000Z");

const expectedPitchersCsv = [
  'player_id,"last_name, first_name",pa,era,xera,era_minus_xera_diff,woba,est_woba,est_woba_minus_woba_diff',
  '11,"Starter, Home",150,3.20,3.60,-0.40,0.290,0.315,0.025',
].join("\n");

const qualityPitchersCsv = [
  'player_id,ev95percent,brl_percent',
  '11,42.0,8.5',
].join("\n");

const expectedBattersCsv = [
  'player_id,"last_name, first_name",pa,woba,est_woba',
  '101,"Batter, One",200,0.330,0.350',
].join("\n");

function okText(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/csv" } });
}

function sourceFetch(options: { fail?: boolean; empty?: "pitcher" | "quality" | "batter" } = {}) {
  let calls = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    calls++;
    if (options.fail) return new Response("upstream failure", { status: 503 });
    if (url.includes("expected_statistics?type=pitcher")) {
      return okText(options.empty === "pitcher" ? "player_id\n" : expectedPitchersCsv);
    }
    if (url.includes("leaderboard/statcast?type=pitcher")) {
      return okText(options.empty === "quality" ? "player_id\n" : qualityPitchersCsv);
    }
    if (url.includes("expected_statistics?type=batter")) {
      return okText(options.empty === "batter" ? "player_id\n" : expectedBattersCsv);
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fetchImpl, calls: () => calls };
}

test("complete Savant acquisition emits certified provenance without changing quality values", async () => {
  resetStatcastQualityCachesForTests();
  const source = sourceFetch();
  const snapshot = await getStatcastQualityCertifiedSnapshot({
    fetchImpl: source.fetchImpl,
    now: () => T0,
  });

  assert.equal(source.calls(), 3);
  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.generatedAt, T0.toISOString());
  assert.equal(snapshot.provenance.schemaVersion, MLB_STATCAST_QUALITY_EVIDENCE_SCHEMA);
  assert.equal(snapshot.provenance.status, "CERTIFIED");
  assert.equal(snapshot.provenance.failureDisposition, "THROW_FAIL_CLOSED");
  assert.equal(snapshot.provenance.cacheMaxAgeSeconds, 21_600);
  assert.equal(snapshot.pitcherMap[11]?.xera, 3.6);
  assert.equal(snapshot.pitcherMap[11]?.hardHitPct, 42);
  assert.equal(snapshot.batterMap[101]?.xwOBA, 0.35);
});

test("a within-TTL certified cache remains certified and does not refetch", async () => {
  resetStatcastQualityCachesForTests();
  const initial = sourceFetch();
  await getStatcastQualityCertifiedSnapshot({ fetchImpl: initial.fetchImpl, now: () => T0 });

  const later = new Date(T0.getTime() + 60 * 60 * 1000);
  const forbidden = sourceFetch({ fail: true });
  const snapshot = await getStatcastQualityCertifiedSnapshot({ fetchImpl: forbidden.fetchImpl, now: () => later });

  assert.equal(forbidden.calls(), 0);
  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.generatedAt, T0.toISOString());
  assert.equal(snapshot.provenance.pitcherCacheHit, true);
  assert.equal(snapshot.provenance.batterCacheHit, true);
  assert.equal(snapshot.provenance.pitcherCacheAgeSeconds, 3600);
  assert.equal(snapshot.provenance.batterCacheAgeSeconds, 3600);
});

test("an expired cache cannot be recertified when Savant refresh fails", async () => {
  resetStatcastQualityCachesForTests();
  const initial = sourceFetch();
  await getStatcastQualityCertifiedSnapshot({ fetchImpl: initial.fetchImpl, now: () => T0 });

  const expired = new Date(T0.getTime() + 7 * 60 * 60 * 1000);
  const failing = sourceFetch({ fail: true });
  await assert.rejects(
    getStatcastQualityCertifiedSnapshot({ fetchImpl: failing.fetchImpl, now: () => expired }),
    /STATCAST_QUALITY_SOURCE_HTTP_503/,
  );
  assert.ok(failing.calls() >= 1);
});

test("empty required pitcher leaderboard fails closed instead of certifying an empty map", async () => {
  resetStatcastQualityCachesForTests();
  const source = sourceFetch({ empty: "pitcher" });
  await assert.rejects(
    getStatcastQualityCertifiedSnapshot({ fetchImpl: source.fetchImpl, now: () => T0 }),
    /STATCAST_QUALITY_EXPECTED_PITCHERS_EMPTY/,
  );
});

test("empty required quality leaderboard fails closed instead of filling a certified source with defaults", async () => {
  resetStatcastQualityCachesForTests();
  const source = sourceFetch({ empty: "quality" });
  await assert.rejects(
    getStatcastQualityCertifiedSnapshot({ fetchImpl: source.fetchImpl, now: () => T0 }),
    /STATCAST_QUALITY_PITCHER_QUALITY_EMPTY/,
  );
});

test("empty required batter leaderboard fails closed", async () => {
  resetStatcastQualityCachesForTests();
  const source = sourceFetch({ empty: "batter" });
  await assert.rejects(
    getStatcastQualityCertifiedSnapshot({ fetchImpl: source.fetchImpl, now: () => T0 }),
    /STATCAST_QUALITY_EXPECTED_BATTERS_EMPTY/,
  );
});
