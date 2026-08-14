import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_ADVANCED_CONTEXT_EVIDENCE_SCHEMA,
  getAdvancedContextCertifiedSnapshot,
  resolveCertifiedParkFactor,
} from "./mlb-advanced-context-provenance";

const T0 = new Date("2026-08-07T20:00:00.000Z");
const GAME_PK = 765432;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function feed(options: {
  venueId?: number;
  venueName?: string;
  temp?: string | null;
  wind?: string | null;
  condition?: string | null;
  homePitcher?: boolean;
  awayPitcher?: boolean;
} = {}) {
  return {
    gameData: {
      venue: { id: options.venueId ?? 22, name: options.venueName ?? "Dodger Stadium" },
      weather: {
        ...(options.temp === null ? {} : { temp: options.temp ?? "80" }),
        ...(options.wind === null ? {} : { wind: options.wind ?? "10 mph, Out To RF" }),
        ...(options.condition === null ? {} : { condition: options.condition ?? "Clear" }),
      },
      probablePitchers: {
        ...(options.homePitcher === false ? {} : { home: { id: 11, fullName: "Home Starter" } }),
        ...(options.awayPitcher === false ? {} : { away: { id: 22, fullName: "Away Starter" } }),
      },
    },
  };
}

function venue(options: { id?: number; name?: string; roofType?: string } = {}) {
  return {
    venues: [{
      id: options.id ?? 22,
      name: options.name ?? "Dodger Stadium",
      fieldInfo: { roofType: options.roofType ?? "Open" },
    }],
  };
}

function pitcherStats(withSample = true) {
  return {
    stats: [{
      splits: withSample
        ? [{ stat: { gamesStarted: 20, gamesPlayed: 20, inningsPitched: "120.0" } }]
        : [],
    }],
  };
}

function sourceFetch(options: {
  feedStatus?: number;
  venueStatus?: number;
  pitcherStatus?: number;
  feedPayload?: unknown;
  venuePayload?: unknown;
  noPitcherSample?: boolean;
} = {}) {
  let calls = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    calls++;
    if (url.includes(`/v1.1/game/${GAME_PK}/feed/live`)) {
      const status = options.feedStatus ?? 200;
      if (status !== 200) return new Response("feed unavailable", { status });
      return json(options.feedPayload ?? feed());
    }
    if (url.includes("/v1/venues/")) {
      const status = options.venueStatus ?? 200;
      if (status !== 200) return new Response("venue unavailable", { status });
      return json(options.venuePayload ?? venue());
    }
    if (url.includes("/v1/people/") && url.includes("/stats?")) {
      const status = options.pitcherStatus ?? 200;
      if (status !== 200) return new Response("pitcher unavailable", { status });
      return json(pitcherStats(options.noPitcherSample !== true));
    }
    return new Response("unexpected", { status: 404 });
  };
  return { fetchImpl, calls: () => calls };
}

test("official venue name takes precedence over stale static venue ids", () => {
  const dodger = resolveCertifiedParkFactor("Dodger Stadium");
  assert.ok(dodger);
  assert.equal(dodger.name, "Dodger Stadium");
  assert.equal(dodger.runs, 99);

  const oracle = resolveCertifiedParkFactor("Oracle Park");
  assert.ok(oracle);
  assert.equal(oracle.name, "Oracle Park");

  const wrigley = resolveCertifiedParkFactor("Wrigley Field");
  assert.ok(wrigley);
  assert.equal(wrigley.name, "Wrigley Field");
});

test("complete official game, venue, weather and pitcher evidence emits certified advanced context", async () => {
  const source = sourceFetch();
  const snapshot = await getAdvancedContextCertifiedSnapshot(GAME_PK, {
    fetchImpl: source.fetchImpl,
    now: () => T0,
  });

  assert.equal(source.calls(), 4);
  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.generatedAt, T0.toISOString());
  assert.equal(snapshot.provenance.schemaVersion, MLB_ADVANCED_CONTEXT_EVIDENCE_SCHEMA);
  assert.equal(snapshot.provenance.status, "CERTIFIED");
  assert.equal(snapshot.provenance.venueIdentityVerified, true);
  assert.equal(snapshot.provenance.venueId, 22);
  assert.equal(snapshot.provenance.venueName, "Dodger Stadium");
  assert.equal(snapshot.provenance.failureDisposition, "THROW_FAIL_CLOSED");
  assert.equal(snapshot.provenance.cacheMaxAgeSeconds, 21_600);
  assert.equal(snapshot.park.name, "Dodger Stadium");
  assert.equal(snapshot.homePitcher.confidenceLabel, "Starter");
  assert.equal(snapshot.awayPitcher.confidenceLabel, "Starter");
  assert.equal(snapshot.breakdown.temp, 0.3);
  assert.equal(snapshot.breakdown.wind, 0.7);
});

test("game feed transport failure blocks certification", async () => {
  const source = sourceFetch({ feedStatus: 503 });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: source.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_SOURCE_HTTP_503:GAME_FEED/,
  );
});

test("official game-feed and venue-resource identity mismatch blocks certification", async () => {
  const source = sourceFetch({ venuePayload: venue({ id: 22, name: "Oracle Park" }) });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: source.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_VENUE_IDENTITY_CONFLICT/,
  );
});

test("venue metadata failure cannot silently default roof to open", async () => {
  const source = sourceFetch({ venueStatus: 503 });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: source.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_SOURCE_HTTP_503:VENUE/,
  );
});

test("unknown official venue cannot receive a neutral certified park adjustment", async () => {
  const source = sourceFetch({
    feedPayload: feed({ venueId: 9999, venueName: "Unmapped Ballpark" }),
    venuePayload: venue({ id: 9999, name: "Unmapped Ballpark", roofType: "Open" }),
  });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: source.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_PARK_FACTOR_UNMAPPED/,
  );
});

test("open venue requires explicit temperature and wind instead of neutral defaults", async () => {
  const missingTemp = sourceFetch({ feedPayload: feed({ temp: null }) });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: missingTemp.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_WEATHER_TEMP_MISSING/,
  );

  const missingWind = sourceFetch({ feedPayload: feed({ wind: null }) });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: missingWind.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_WEATHER_WIND_MISSING/,
  );
});

test("retractable venue requires explicit current roof status", async () => {
  const source = sourceFetch({
    feedPayload: feed({ venueId: 32, venueName: "Daikin Park", condition: "Clear" }),
    venuePayload: venue({ id: 32, name: "Daikin Park", roofType: "Retractable" }),
  });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: source.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_RETRACTABLE_ROOF_STATUS_UNVERIFIED/,
  );
});

test("pitcher source failure blocks certification instead of producing neutral opener adjustment", async () => {
  const source = sourceFetch({ pitcherStatus: 503 });
  await assert.rejects(
    getAdvancedContextCertifiedSnapshot(GAME_PK, { fetchImpl: source.fetchImpl, now: () => T0 }),
    /ADVANCED_CONTEXT_SOURCE_HTTP_503:(HOME|AWAY)_PITCHER_SEASON/,
  );
});

test("valid pitcher source with no season split is certified as no-sample", async () => {
  const source = sourceFetch({ noPitcherSample: true });
  const snapshot = await getAdvancedContextCertifiedSnapshot(GAME_PK, {
    fetchImpl: source.fetchImpl,
    now: () => T0,
  });

  assert.equal(snapshot.sourceStatus, "CERTIFIED");
  assert.equal(snapshot.provenance.homePitcherSampleStatus, "NO_SEASON_SAMPLE");
  assert.equal(snapshot.provenance.awayPitcherSampleStatus, "NO_SEASON_SAMPLE");
  assert.equal(snapshot.homePitcher.confidenceLabel, "Unknown");
  assert.equal(snapshot.awayPitcher.confidenceLabel, "Unknown");
});
