import assert from "node:assert/strict";
import test from "node:test";
import {
  MlbV15BullpenD1Materializer,
  MLB_V15_BULLPEN_D1_EVIDENCE_SCHEMA,
} from "./mlb-v15-bullpen-d1-materializer";

type AnyRecord = Record<string, any>;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function schedule(teamId: number, rows: Array<{ date: string; gamePk: number }>): AnyRecord {
  return {
    dates: rows.map((row) => ({
      date: row.date,
      games: [{
        gamePk: row.gamePk,
        status: { abstractGameState: "Final", detailedState: "Final" },
        teams: { home: { team: { id: teamId } } },
      }],
    })),
  };
}

function boxscore(input: {
  teamId: number;
  opponentId: number;
  starterId: number;
  relievers: Array<{ id: number; pitches: number }>;
}): AnyRecord {
  const pitchers = [input.starterId, ...input.relievers.map((row) => row.id)];
  const players = Object.fromEntries([
    [input.starterId, 75],
    ...input.relievers.map((row) => [row.id, row.pitches] as [number, number]),
  ].map(([id, pitches]) => [
    `ID${id}`,
    { stats: { pitching: { pitchesThrown: pitches } } },
  ]));
  return {
    teams: {
      home: {
        team: { id: input.teamId },
        pitchers,
        players,
      },
      away: {
        team: { id: input.opponentId },
        pitchers: [900000 + input.opponentId],
        players: {
          [`ID${900000 + input.opponentId}`]: { stats: { pitching: { pitchesThrown: 80 } } },
        },
      },
    },
  };
}

function fixtureFetch(options: { missingPitchGamePk?: number } = {}) {
  const requests: string[] = [];
  const schedules: Record<number, AnyRecord> = {
    10: schedule(10, [
      { date: "2026-08-10", gamePk: 1001 },
      { date: "2026-08-11", gamePk: 1002 },
      { date: "2026-08-12", gamePk: 1003 },
    ]),
    20: schedule(20, [
      { date: "2026-08-09", gamePk: 2001 },
      { date: "2026-08-11", gamePk: 2002 },
      { date: "2026-08-12", gamePk: 2003 },
    ]),
  };
  const boxes: Record<number, AnyRecord> = {
    1001: boxscore({ teamId: 10, opponentId: 31, starterId: 1101, relievers: [{ id: 1111, pitches: 8 }] }),
    1002: boxscore({ teamId: 10, opponentId: 32, starterId: 1102, relievers: [{ id: 1112, pitches: 12 }] }),
    1003: boxscore({ teamId: 10, opponentId: 33, starterId: 1103, relievers: [{ id: 1113, pitches: 10 }, { id: 1114, pitches: 20 }] }),
    2001: boxscore({ teamId: 20, opponentId: 41, starterId: 2101, relievers: [{ id: 2111, pitches: 7 }] }),
    2002: boxscore({ teamId: 20, opponentId: 42, starterId: 2102, relievers: [{ id: 2112, pitches: 9 }] }),
    2003: boxscore({ teamId: 20, opponentId: 43, starterId: 2103, relievers: [{ id: 2113, pitches: 20 }, { id: 2114, pitches: 30 }] }),
  };
  if (options.missingPitchGamePk) {
    const box = boxes[options.missingPitchGamePk];
    const team = box?.teams?.home;
    if (team && team.pitchers.length > 1) {
      delete team.players[`ID${team.pitchers[1]}`].stats.pitching.pitchesThrown;
    }
  }

  const fetchImpl = async (input: string): Promise<Response> => {
    requests.push(input);
    const url = new URL(input);
    if (url.pathname.endsWith("/schedule")) {
      const teamId = Number(url.searchParams.get("teamId"));
      const payload = schedules[teamId];
      if (!payload) return jsonResponse({ error: "team missing" }, 404);
      return jsonResponse(payload);
    }
    const match = url.pathname.match(/\/game\/(\d+)\/boxscore$/);
    if (match) {
      const gamePk = Number(match[1]);
      const payload = boxes[gamePk];
      if (!payload) return jsonResponse({ error: "game missing" }, 404);
      return jsonResponse(payload);
    }
    return jsonResponse({ error: "unexpected" }, 404);
  };

  return { fetchImpl, requests };
}

test("materializes the frozen V15 D1 sign feature as away D-1 bullpen pitches minus home D-1 bullpen pitches", async () => {
  const fixture = fixtureFetch();
  const materializer = new MlbV15BullpenD1Materializer({
    fetchImpl: fixture.fetchImpl,
    apiBaseUrl: "https://statsapi.mlb.com/api/v1",
  });
  const evidence = await materializer.assessGame({
    gamePk: 777001,
    officialDate: "2026-08-13",
    homeTeamId: 10,
    awayTeamId: 20,
    now: new Date("2026-08-13T18:00:00.000Z"),
  });

  assert.equal(evidence.schemaVersion, MLB_V15_BULLPEN_D1_EVIDENCE_SCHEMA);
  assert.equal(evidence.home.pitches1d, 30);
  assert.equal(evidence.away.pitches1d, 50);
  assert.equal(evidence.bullpenPitches1dAdv, 20);
  assert.equal(evidence.home.priorGames30d, 3);
  assert.equal(evidence.away.priorGames30d, 3);
  assert.equal(evidence.home.relieverPool, 4);
  assert.equal(evidence.away.relieverPool, 4);
  assert.equal(evidence.eligible, true);
  assert.equal(evidence.provenance.positiveConvention, "AWAY_MINUS_HOME_POSITIVE_FAVORS_HOME_FRESHNESS");
  assert.equal(evidence.provenance.thresholdSearchUsed, false);
});

test("queries only the frozen prior 30-day window ending at D-1", async () => {
  const fixture = fixtureFetch();
  const materializer = new MlbV15BullpenD1Materializer({ fetchImpl: fixture.fetchImpl });
  await materializer.assessGame({
    gamePk: 777001,
    officialDate: "2026-08-13",
    homeTeamId: 10,
    awayTeamId: 20,
  });
  const scheduleRequests = fixture.requests.filter((url) => url.includes("/schedule?"));
  assert.equal(scheduleRequests.length, 2);
  for (const raw of scheduleRequests) {
    const url = new URL(raw);
    assert.equal(url.searchParams.get("startDate"), "2026-07-14");
    assert.equal(url.searchParams.get("endDate"), "2026-08-12");
    assert.equal(url.searchParams.has("date"), false);
  }
});

test("preserves the V14/V15 eligibility floor and reports ineligible instead of inventing coverage", async () => {
  const fixture = fixtureFetch();
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.pathname.endsWith("/schedule") && url.searchParams.get("teamId") === "10") {
      return jsonResponse(schedule(10, [
        { date: "2026-08-11", gamePk: 1002 },
        { date: "2026-08-12", gamePk: 1003 },
      ]));
    }
    return fixture.fetchImpl(input, init);
  };
  const materializer = new MlbV15BullpenD1Materializer({ fetchImpl });
  const evidence = await materializer.assessGame({
    gamePk: 777001,
    officialDate: "2026-08-13",
    homeTeamId: 10,
    awayTeamId: 20,
  });
  assert.equal(evidence.home.priorGames30d, 2);
  assert.equal(evidence.home.eligible, false);
  assert.equal(evidence.eligible, false);
});

test("fails closed when an official prior boxscore cannot certify reliever pitch workload", async () => {
  const fixture = fixtureFetch({ missingPitchGamePk: 1003 });
  const materializer = new MlbV15BullpenD1Materializer({ fetchImpl: fixture.fetchImpl });
  await assert.rejects(
    materializer.assessGame({
      gamePk: 777001,
      officialDate: "2026-08-13",
      homeTeamId: 10,
      awayTeamId: 20,
    }),
    /MLB_V15_D1_PITCH_COUNT_MISSING:1003/,
  );
});

test("does not claim exact historical T-5 starter identity parity", async () => {
  const fixture = fixtureFetch();
  const materializer = new MlbV15BullpenD1Materializer({ fetchImpl: fixture.fetchImpl });
  const evidence = await materializer.assessGame({
    gamePk: 777001,
    officialDate: "2026-08-13",
    homeTeamId: 10,
    awayTeamId: 20,
  });
  assert.equal(evidence.provenance.historicalResearchStarterIdentity, "FROZEN_T5_PROBABLE_PITCHER");
  assert.equal(evidence.provenance.operationalStarterIdentity, "FINAL_BOXSCORE_FIRST_PITCHER");
  assert.equal(evidence.provenance.exactHistoricalStarterIdentityParityClaimed, false);
  assert.equal(evidence.provenance.sameDateDataUsed, false);
  assert.equal(evidence.provenance.futureGameDataUsed, false);
  assert.equal(evidence.provenance.targetGameOutcomeUsed, false);
});
