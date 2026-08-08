import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_SOS_EVIDENCE_SCHEMA,
  getTeamSosCertifiedSnapshot,
  resetSosCertifiedCacheForTests,
} from "./mlb-sos";

const T0 = new Date("2026-08-07T20:00:00.000Z");
const TEAM_ID = 112;
const OPP_ID = 116;

function schedule(finalGames = 5, missingPitcherIndex: number | null = null) {
  const games = Array.from({ length: finalGames }, (_, index) => ({
    gamePk: 700000 + index,
    status: { abstractGameState: "Final" },
    teams: {
      home: {
        team: { id: TEAM_ID },
        score: 4 + index,
      },
      away: {
        team: { id: OPP_ID },
        score: 3,
        probablePitcher: missingPitcherIndex === index ? undefined : { id: 201 + index },
      },
    },
  }));
  return { dates: [{ date: "2026-08-01", games }] };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sourceFetch(options: {
  scheduleStatus?: number;
  pitcherStatus?: number;
  teamEraStatus?: number;
  finalGames?: number;
  missingPitcherIndex?: number | null;
  missingPitcherEra?: boolean;
  missingTeamEra?: boolean;
} = {}) {
  let calls = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    calls++;
    if (url.includes("/schedule?")) {
      const status = options.scheduleStatus ?? 200;
      if (status !== 200) return new Response("schedule unavailable", { status });
      return json(schedule(options.finalGames ?? 5, options.missingPitcherIndex ?? null));
    }
    if (url.includes("/people/") && url.includes("/stats?")) {
      const status = options.pitcherStatus ?? 200;
      if (status !== 200) return new Response("pitcher unavailable", { status });
      return json({
        stats: [{ splits: options.missingPitcherEra ? [] : [{ stat: { era: "3.50" } }] }],
      });
    }
    if (url.includes(`/teams/${OPP_ID}/stats?`)) {
      const status = options.teamEraStatus ?? 200;
      if (status !== 200) return new Response("team era unavailable", { status });
      return json({
        stats: [{ splits: options.missingTeamEra ? [] : [{ stat: { era: "4.00" } }] }],
      });
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fetchImpl, calls: () => calls };
}

test("complete SOS source coverage emits certified provenance", async () => {
  resetSosCertifiedCacheForTests();
  const source = sourceFetch();
  const snapshot = await getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", {
    fetchImpl: source.fetchImpl,
    now: () => T0,
  });

  assert.equal(source.calls(), 7);
  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.generatedAt, T0.toISOString());
  assert.equal(snapshot.provenance.schemaVersion, MLB_SOS_EVIDENCE_SCHEMA);
  assert.equal(snapshot.provenance.status, "CERTIFIED");
  assert.equal(snapshot.provenance.failureDisposition, "THROW_FAIL_CLOSED");
  assert.equal(snapshot.provenance.cacheMaxAgeSeconds, 3600);
  assert.equal(snapshot.provenance.sampleStatus, "AVAILABLE");
  assert.equal(snapshot.provenance.selectedFinalGames, 5);
  assert.equal(snapshot.provenance.pitcherErasVerified, 5);
  assert.equal(snapshot.provenance.opponentStaffErasVerified, 1);
  assert.equal(snapshot.teamSos?.games, 5);
  assert.equal(snapshot.teamSos?.avgSpEraFaced, 3.5);
  assert.equal(snapshot.teamSos?.avgBullpenEraFaced, 4);
});

test("fewer than five final games is a certified insufficient-sample condition", async () => {
  resetSosCertifiedCacheForTests();
  const source = sourceFetch({ finalGames: 4 });
  const snapshot = await getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", {
    fetchImpl: source.fetchImpl,
    now: () => T0,
  });

  assert.equal(source.calls(), 1);
  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.teamSos, null);
  assert.equal(snapshot.provenance.sampleStatus, "INSUFFICIENT_GAMES");
  assert.equal(snapshot.provenance.selectedFinalGames, 4);
});

test("schedule transport failure blocks certification", async () => {
  resetSosCertifiedCacheForTests();
  const source = sourceFetch({ scheduleStatus: 503 });
  await assert.rejects(
    getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", { fetchImpl: source.fetchImpl, now: () => T0 }),
    /SOS_SOURCE_HTTP_503:SCHEDULE/,
  );
});

test("a selected final game without probable pitcher identity blocks certification", async () => {
  resetSosCertifiedCacheForTests();
  const source = sourceFetch({ missingPitcherIndex: 2 });
  await assert.rejects(
    getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", { fetchImpl: source.fetchImpl, now: () => T0 }),
    /SOS_PROBABLE_PITCHER_MISSING/,
  );
});

test("missing pitcher ERA blocks certification instead of silently dropping the game", async () => {
  resetSosCertifiedCacheForTests();
  const source = sourceFetch({ missingPitcherEra: true });
  await assert.rejects(
    getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", { fetchImpl: source.fetchImpl, now: () => T0 }),
    /SOS_PITCHER_ERA_MISSING/,
  );
});

test("missing opponent staff ERA blocks certification instead of using league-average fallback", async () => {
  resetSosCertifiedCacheForTests();
  const source = sourceFetch({ missingTeamEra: true });
  await assert.rejects(
    getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", { fetchImpl: source.fetchImpl, now: () => T0 }),
    /SOS_TEAM_STAFF_ERA_MISSING/,
  );
});

test("within-TTL certified SOS cache requires no source refetch", async () => {
  resetSosCertifiedCacheForTests();
  const first = sourceFetch();
  await getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", { fetchImpl: first.fetchImpl, now: () => T0 });

  const later = new Date(T0.getTime() + 30 * 60 * 1000);
  const forbidden = sourceFetch({ scheduleStatus: 503, pitcherStatus: 503, teamEraStatus: 503 });
  const snapshot = await getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", {
    fetchImpl: forbidden.fetchImpl,
    now: () => later,
  });

  assert.equal(forbidden.calls(), 0);
  assert.equal(snapshot.provenance.cacheHit, true);
  assert.equal(snapshot.provenance.cacheAgeSeconds, 1800);
  assert.equal(snapshot.generatedAt, T0.toISOString());
});

test("expired certified cache cannot be recertified after a refresh failure", async () => {
  resetSosCertifiedCacheForTests();
  const first = sourceFetch();
  await getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", { fetchImpl: first.fetchImpl, now: () => T0 });

  const expired = new Date(T0.getTime() + 2 * 60 * 60 * 1000);
  const failing = sourceFetch({ scheduleStatus: 503 });
  await assert.rejects(
    getTeamSosCertifiedSnapshot(TEAM_ID, "Chicago Cubs", { fetchImpl: failing.fetchImpl, now: () => expired }),
    /SOS_SOURCE_HTTP_503:SCHEDULE/,
  );
  assert.equal(failing.calls(), 1);
});
