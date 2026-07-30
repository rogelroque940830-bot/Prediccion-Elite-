import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OperationalAlertService } from "./operational-alerts";

function diagnostic(status: "HEALTHY" | "WARN" | "CRITICAL") {
  return {
    evaluate: () => ({
      schemaVersion: "courtedge-diagnostics.v1",
      checkedAt: new Date().toISOString(),
      status,
      checks: status === "HEALTHY" ? [{ code: "OK", status: "HEALTHY", message: "ok" }] : [{ code: "BACKUP_MISSING", status, message: "backup missing" }],
      counts: { healthy: status === "HEALTHY" ? 1 : 0, warnings: status === "WARN" ? 1 : 0, critical: status === "CRITICAL" ? 1 : 0 },
    }),
  } as any;
}

test("S4D appends alerts and deduplicates the same fingerprint during cooldown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s4d-"));
  try {
    const service = new OperationalAlertService(diagnostic("WARN"), root, 60_000);
    const first = await service.evaluate();
    const second = await service.evaluate();
    assert.equal(first.emitted, true);
    assert.equal(second.emitted, false);
    assert.equal(second.reason, "cooldown");
    assert.equal(service.list().length, 1);
    const lines = fs.readFileSync(path.join(root, "operational-alerts.jsonl"), "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("S4D emits no alert for healthy diagnostics", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-s4d-ok-"));
  try {
    const service = new OperationalAlertService(diagnostic("HEALTHY"), root, 60_000);
    const result = await service.evaluate();
    assert.equal(result.emitted, false);
    assert.equal(result.reason, "healthy");
    assert.equal(service.list().length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
