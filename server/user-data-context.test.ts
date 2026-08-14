import assert from "node:assert/strict";
import test from "node:test";
import {
  getRequestIdentity,
  requestCanRunGlobalWorkers,
  requestCanWriteOwnData,
} from "./user-data-context";

function requestWith(role: "admin" | "analyst" | "viewer") {
  return {
    session: {
      courtEdgeAuthenticated: true,
      courtEdgeUserId: role === "admin" ? 1 : role === "analyst" ? 2 : 3,
      courtEdgeUser: role,
      courtEdgeRole: role,
    },
  } as any;
}

test("S2 resolves authenticated identity and enforces role boundaries", () => {
  assert.deepEqual(getRequestIdentity(requestWith("analyst")), {
    id: 2,
    username: "analyst",
    role: "analyst",
  });
  assert.equal(requestCanWriteOwnData(requestWith("admin")), true);
  assert.equal(requestCanWriteOwnData(requestWith("analyst")), true);
  assert.equal(requestCanWriteOwnData(requestWith("viewer")), false);
  assert.equal(requestCanRunGlobalWorkers(requestWith("admin")), true);
  assert.equal(requestCanRunGlobalWorkers(requestWith("analyst")), false);
  assert.equal(requestCanRunGlobalWorkers(requestWith("viewer")), false);
});
