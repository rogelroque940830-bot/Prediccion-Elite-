import assert from "node:assert/strict";
import test from "node:test";
import { OperationalObservabilityService, normalizeOperationalRoute } from "./operational-observability";

test("S4C normalizes high-cardinality route identifiers", () => {
  assert.equal(normalizeOperationalRoute("/api/mlb/ledger/v1/predictions/123456"), "/api/mlb/ledger/v1/predictions/:id");
  assert.equal(normalizeOperationalRoute("/api/items/abcdef0123456789abcdef0123456789"), "/api/items/:id");
});

test("S4C records bounded request, latency and error metrics", () => {
  const service = new OperationalObservabilityService(2, 2);
  try {
    service.recordRequest("GET", "/api/a/1", 200, 10);
    service.recordRequest("GET", "/api/a/2", 500, 30);
    service.recordRequest("POST", "/api/b", 401, 5);
    service.recordError("GET", "/api/a/2", 500, new Error("provider failed"));
    const snapshot = service.snapshot();
    assert.equal(snapshot.requests.total, 3);
    assert.equal(snapshot.requests.success2xx, 1);
    assert.equal(snapshot.requests.serverErrors5xx, 1);
    assert.equal(snapshot.requests.clientErrors4xx, 1);
    assert.equal(snapshot.requests.maxLatencyMs, 30);
    assert.ok(snapshot.routes.length <= 2);
    assert.equal(snapshot.recentErrors[0].message, "provider failed");
  } finally { service.close(); }
});
