import assert from "node:assert/strict";
import test from "node:test";
import type { Express } from "express";
import {
  MLB_PREMIUM_NO_ULTRA_ENDPOINT,
  MLB_PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED,
  registerMlbPremiumNoUltraProspectiveRoutes,
  type MlbPremiumNoUltraReader,
} from "./mlb-premium-no-ultra-prospective-routes";

function harness(service: MlbPremiumNoUltraReader) {
  let path = "";
  let handlers: any[] = [];
  const app = {
    get(route: string, ...registered: any[]) {
      path = route;
      handlers = registered;
      return this;
    },
  } as unknown as Express;
  registerMlbPremiumNoUltraProspectiveRoutes(app, service);
  return { path, handler: () => handlers.at(-1) as (req: any, res: any) => any };
}

function responseHarness() {
  let statusCode = 200;
  let body: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: any) {
      body = value;
      return this;
    },
  };
  return { res, status: () => statusCode, body: () => body };
}

test("registers one GET-only prospective endpoint and returns owner-scoped report", () => {
  let reviewedUser: number | null = null;
  const report = { schemaVersion: "courtedge-p1-premium-no-ultra-prospective.v1", state: "COLLECTING_PROSPECTIVE_EVIDENCE" } as any;
  const route = harness({ review(userId) { reviewedUser = userId; return report; } });
  assert.equal(route.path, MLB_PREMIUM_NO_ULTRA_ENDPOINT);
  const response = responseHarness();
  route.handler()({ session: { courtEdgeAuthenticated: true, courtEdgeUserId: 17, courtEdgeUser: "owner", courtEdgeRole: "admin" } }, response.res);
  assert.equal(reviewedUser, 17);
  assert.equal(response.status(), 200);
  assert.deepEqual(response.body(), { success: true, data: report, endpoint: MLB_PREMIUM_NO_ULTRA_ENDPOINT });
});

test("rejects a request without an authenticated interactive identity", () => {
  let calls = 0;
  const route = harness({ review() { calls += 1; return {} as any; } });
  const response = responseHarness();
  route.handler()({ session: {} }, response.res);
  assert.equal(calls, 0);
  assert.equal(response.status(), 401);
  assert.equal(response.body().code, "INTERACTIVE_SESSION_REQUIRED");
});

test("fails closed when upstream economic-review coverage is truncated", () => {
  const route = harness({ review() { throw new Error(MLB_PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED); } });
  const response = responseHarness();
  route.handler()({ session: { courtEdgeAuthenticated: true, courtEdgeUserId: 17, courtEdgeUser: "owner", courtEdgeRole: "viewer" } }, response.res);
  assert.equal(response.status(), 409);
  assert.equal(response.body().code, MLB_PREMIUM_NO_ULTRA_SOURCE_WINDOW_TRUNCATED);
});

test("does not convert unexpected failures into a successful research report", () => {
  const original = console.error;
  console.error = () => undefined;
  try {
    const route = harness({ review() { throw new Error("boom"); } });
    const response = responseHarness();
    route.handler()({ session: { courtEdgeAuthenticated: true, courtEdgeUserId: 17, courtEdgeUser: "owner", courtEdgeRole: "analyst" } }, response.res);
    assert.equal(response.status(), 500);
    assert.equal(response.body().code, "PREMIUM_NO_ULTRA_INTERNAL_ERROR");
  } finally {
    console.error = original;
  }
});
