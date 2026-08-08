import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import {
  createMlbP1AdvancedComponentRouteService,
  registerMlbP1AdvancedComponentCertificationMiddleware,
} from "./mlb-p1-advanced-component-certification-routes";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function feed() {
  return {
    gameData: {
      teams: {
        home: { id: 10, name: "Home Club" },
        away: { id: 20, name: "Away Club" },
      },
      probablePitchers: {
        home: { id: 101, fullName: "Home Starter" },
        away: { id: 202, fullName: "Away Starter" },
      },
    },
    liveData: {
      boxscore: {
        teams: {
          home: { battingOrder: [1001, 1002, 1003] },
          away: { battingOrder: [2001, 2002, 2003] },
        },
      },
    },
  };
}

test("discipline route exposes certified top-level provenance without changing certified numeric output", async () => {
  let certifiedInput: any = null;
  const service = createMlbP1AdvancedComponentRouteService({
    fetchImpl: async () => jsonResponse(feed()),
    disciplineCertifier: (async (input: any) => {
      certifiedInput = input;
      return {
        homeSPDiscipline: null,
        awaySPDiscipline: null,
        homeBatterSpeed: [],
        awayBatterSpeed: [],
        homeRunsDelta: 0.12,
        awayRunsDelta: -0.08,
        sourceStatus: "CERTIFIED",
        generatedAt: "2026-08-08T17:00:00.000Z",
        provenance: { status: "CERTIFIED", generatedAt: "2026-08-08T17:00:00.000Z" },
      } as any;
    }) as any,
    disciplineLegacy: (async () => {
      throw new Error("legacy must not run on certified path");
    }) as any,
  });

  const result = await service.discipline(123456);
  assert.equal(result.success, true);
  assert.equal(result.sourceStatus, "CERTIFIED");
  assert.equal(result.generatedAt, "2026-08-08T17:00:00.000Z");
  assert.equal(result.homeRunsDelta, 0.12);
  assert.equal(result.awayRunsDelta, -0.08);
  assert.deepEqual(certifiedInput.homeBatterIds, [1001, 1002, 1003]);
  assert.deepEqual(certifiedInput.awayBatterIds, [2001, 2002, 2003]);
  assert.equal(certifiedInput.homePitcherId, 101);
  assert.equal(certifiedInput.awayPitcherId, 202);
});

test("discipline certifier failure preserves legacy numbers but cannot certify", async () => {
  const service = createMlbP1AdvancedComponentRouteService({
    fetchImpl: async () => jsonResponse(feed()),
    disciplineCertifier: (async () => {
      throw new Error("SPRINT_SPEED_SOURCE_UNAVAILABLE");
    }) as any,
    disciplineLegacy: (async () => ({
      homeSPDiscipline: null,
      awaySPDiscipline: null,
      homeBatterSpeed: [],
      awayBatterSpeed: [],
      homeRunsDelta: 0.04,
      awayRunsDelta: -0.02,
    })) as any,
    now: () => new Date("2026-08-08T18:00:00.000Z"),
  });

  const result = await service.discipline(123456);
  assert.equal(result.success, true);
  assert.equal(result.sourceStatus, "DEGRADED");
  assert.equal(result.generatedAt, undefined);
  assert.equal(result.homeRunsDelta, 0.04);
  assert.equal(result.awayRunsDelta, -0.02);
  assert.equal(result.provenance.status, "DEGRADED");
  assert.match(result.provenance.blockers[0], /SPRINT_SPEED_SOURCE_UNAVAILABLE/);
});

test("SOS route certifies only when both team snapshots certify and uses oldest evidence time", async () => {
  const service = createMlbP1AdvancedComponentRouteService({
    fetchImpl: async () => jsonResponse(feed()),
    sosCertifier: (async (teamId: number) => ({
      sourceStatus: "CERTIFIED",
      generatedAt: teamId === 10 ? "2026-08-08T16:55:00.000Z" : "2026-08-08T16:50:00.000Z",
      teamSos: { teamId, teamName: teamId === 10 ? "Home Club" : "Away Club", sosFactor: teamId === 10 ? 1.03 : 0.97 },
      provenance: { status: "CERTIFIED", generatedAt: teamId === 10 ? "2026-08-08T16:55:00.000Z" : "2026-08-08T16:50:00.000Z" },
    })) as any,
    sosLegacy: (async () => {
      throw new Error("legacy must not run on certified path");
    }) as any,
  });

  const result = await service.sos(123456);
  assert.equal(result.success, true);
  assert.equal(result.sourceStatus, "CERTIFIED");
  assert.equal(result.generatedAt, "2026-08-08T16:50:00.000Z");
  assert.equal(result.home.sosFactor, 1.03);
  assert.equal(result.away.sosFactor, 0.97);
  assert.equal(result.provenance.home.status, "CERTIFIED");
  assert.equal(result.provenance.away.status, "CERTIFIED");
});

test("SOS certifier failure falls back for compatibility but stays degraded and untimed", async () => {
  const service = createMlbP1AdvancedComponentRouteService({
    fetchImpl: async () => jsonResponse(feed()),
    sosCertifier: (async (teamId: number) => {
      if (teamId === 20) throw new Error("SOS_TEAM_STAFF_ERA_MISSING");
      return { sourceStatus: "CERTIFIED", generatedAt: "2026-08-08T16:55:00.000Z", teamSos: null, provenance: {} } as any;
    }) as any,
    sosLegacy: (async (teamId: number, teamName: string) => ({ teamId, teamName, sosFactor: 1 })) as any,
    now: () => new Date("2026-08-08T18:00:00.000Z"),
  });

  const result = await service.sos(123456);
  assert.equal(result.success, true);
  assert.equal(result.sourceStatus, "DEGRADED");
  assert.equal(result.generatedAt, undefined);
  assert.equal(result.home.sosFactor, 1);
  assert.equal(result.away.sosFactor, 1);
  assert.match(result.provenance.blockers[0], /SOS_TEAM_STAFF_ERA_MISSING/);
});

test("middleware intercepts only GET on the two historical endpoint paths", async () => {
  const uses = new Map<string, any>();
  const app = {
    use(path: string, handler: any) { uses.set(path, handler); },
  } as unknown as Express;
  const calls: string[] = [];
  registerMlbP1AdvancedComponentCertificationMiddleware(app, {
    async discipline(gamePk: number) { calls.push(`discipline:${gamePk}`); return { success: true, sourceStatus: "CERTIFIED", generatedAt: "2026-08-08T17:00:00.000Z" }; },
    async sos(gamePk: number) { calls.push(`sos:${gamePk}`); return { success: true, sourceStatus: "CERTIFIED", generatedAt: "2026-08-08T17:00:00.000Z" }; },
  });

  assert.ok(uses.has("/api/mlb/discipline-speed/:gamePk"));
  assert.ok(uses.has("/api/mlb/sos/:gamePk"));

  let body: any = null;
  await uses.get("/api/mlb/discipline-speed/:gamePk")(
    { method: "GET", params: { gamePk: "777" } },
    { status() { return this; }, json(value: any) { body = value; return value; } },
    () => { throw new Error("GET should not fall through"); },
  );
  assert.equal(body.sourceStatus, "CERTIFIED");
  assert.deepEqual(calls, ["discipline:777"]);

  let fellThrough = false;
  await uses.get("/api/mlb/sos/:gamePk")(
    { method: "POST", params: { gamePk: "777" } },
    { status() { return this; }, json(value: any) { return value; } },
    () => { fellThrough = true; },
  );
  assert.equal(fellThrough, true);
  assert.deepEqual(calls, ["discipline:777"]);
});
