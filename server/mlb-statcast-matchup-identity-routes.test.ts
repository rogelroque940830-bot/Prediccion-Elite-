import assert from "node:assert/strict";
import test from "node:test";
import { registerMlbStatcastMatchupIdentityMiddleware } from "./mlb-statcast-matchup-identity-routes";

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
