import assert from "node:assert/strict";
import test from "node:test";
import {
  createStatcastIdentityRouteService,
  registerMlbStatcastMatchupIdentityMiddleware,
} from "./mlb-statcast-matchup-identity-routes";

function captureMiddleware(service: { review(gamePk: number): Promise<any> }) {
  let registeredPath = "";
  let handler: any = null;
  const app = {
    use(path: string, fn: any) {
      registeredPath = path;
      handler = fn;
    },
  } as any;
  registerMlbStatcastMatchupIdentityMiddleware(app, service);
  assert.equal(registeredPath, "/api/mlb/statcast-matchup/:gamePk");
  assert.equal(typeof handler, "function");
  return handler;
}

function responseCapture() {
  const state: { status: number; body: any } = { status: 200, body: null };
  const res = {
    status(code: number) { state.status = code; return res; },
    json(body: any) { state.body = body; return res; },
  } as any;
  return { res, state };
}

function feed() {
  return {
    gameData: {
      datetime: { officialDate: "2026-08-08" },
      teams: {
        home: { id: 112, abbreviation: "CHC" },
        away: { id: 116, abbreviation: "DET" },
      },
      probablePitchers: {
        home: { id: 101, fullName: "Home SP" },
        away: { id: 201, fullName: "Away SP" },
      },
    },
    liveData: { boxscore: { teams: { home: { battingOrder: Array(9).fill(1) }, away: { battingOrder: Array(9).fill(2) } } } },
  };
}

test("GET statcast matchup is intercepted by identity-safe service", async () => {
  const reviewed: number[] = [];
  const handler = captureMiddleware({
    async review(gamePk: number) {
      reviewed.push(gamePk);
      return { gamePk, identityCorrection: { opposingTeamIdContract: "NUMERIC_MLB_TEAM_ID" } };
    },
  });
  const { res, state } = responseCapture();
  let nextCalls = 0;
  await handler({ method: "GET", params: { gamePk: "765432" } } as any, res, () => { nextCalls++; });

  assert.deepEqual(reviewed, [765432]);
  assert.equal(nextCalls, 0);
  assert.equal(state.status, 200);
  assert.equal(state.body.identityCorrection.opposingTeamIdContract, "NUMERIC_MLB_TEAM_ID");
});

test("identity route exposes CERTIFIED only when the strict certifier returns it and preserves numeric output", async () => {
  const certificationInputs: any[] = [];
  const service = createStatcastIdentityRouteService(
    async () => new Response(JSON.stringify(feed()), { status: 200, headers: { "content-type": "application/json" } }),
    {
      now: () => new Date("2026-08-08T02:45:00.000Z"),
      identityEngine: (async (input: any) => ({
        homeRunsDelta: 0.12,
        awayRunsDelta: -0.08,
        engineGamePk: input.gamePk,
        identityCorrection: { opposingTeamIdContract: "NUMERIC_MLB_TEAM_ID" },
      })) as any,
      certifier: (async (input: any) => {
        certificationInputs.push(input);
        return {
          sourceStatus: "CERTIFIED",
          generatedAt: "2026-08-08T02:44:55.000Z",
          provenance: {
            schemaVersion: "courtedge-mlb-statcast-matchup-certification.v1",
            status: "CERTIFIED",
            generatedAt: "2026-08-08T02:44:55.000Z",
            verifiedAt: "2026-08-08T02:45:00.000Z",
            blockers: [],
          },
        };
      }) as any,
    },
  );

  const result = await service.review(765432);
  assert.equal(certificationInputs.length, 1);
  assert.equal(certificationInputs[0].gamePk, 765432);
  assert.equal(certificationInputs[0].season, 2026);
  assert.equal(result.sourceStatus, "CERTIFIED");
  assert.equal(result.generatedAt, "2026-08-08T02:44:55.000Z");
  assert.equal(result.provenance.status, "CERTIFIED");
  assert.equal(result.homeRunsDelta, 0.12);
  assert.equal(result.awayRunsDelta, -0.08);
  assert.equal(result.engineGamePk, 765432);
});

test("unexpected certification failure degrades metadata but keeps the identity-safe numeric result", async () => {
  const service = createStatcastIdentityRouteService(
    async () => new Response(JSON.stringify(feed()), { status: 200, headers: { "content-type": "application/json" } }),
    {
      now: () => new Date("2026-08-08T02:45:00.000Z"),
      identityEngine: (async () => ({ homeRunsDelta: 0.33, awayRunsDelta: -0.22, marker: "PRESERVED" })) as any,
      certifier: (async () => { throw new Error("boom"); }) as any,
    },
  );

  const result = await service.review(765432);
  assert.equal(result.sourceStatus, "DEGRADED");
  assert.equal(result.generatedAt, undefined);
  assert.equal(result.provenance.status, "DEGRADED");
  assert.ok(result.provenance.blockers.includes("STATCAST_CERTIFIER_UNEXPECTED_FAILURE:boom"));
  assert.equal(result.homeRunsDelta, 0.33);
  assert.equal(result.awayRunsDelta, -0.22);
  assert.equal(result.marker, "PRESERVED");
});

test("non-GET requests continue to legacy routing instead of being intercepted", async () => {
  const handler = captureMiddleware({
    async review() { throw new Error("should not run"); },
  });
  const { res } = responseCapture();
  let nextCalls = 0;
  await handler({ method: "POST", params: { gamePk: "765432" } } as any, res, () => { nextCalls++; });
  assert.equal(nextCalls, 1);
});

test("invalid gamePk fails before the service is called", async () => {
  let called = false;
  const handler = captureMiddleware({
    async review() { called = true; return {}; },
  });
  const { res, state } = responseCapture();
  await handler({ method: "GET", params: { gamePk: "DET" } } as any, res, () => {});
  assert.equal(called, false);
  assert.equal(state.status, 400);
  assert.deepEqual(state.body, { error: "Invalid gamePk" });
});
