// CI trigger and static safety proof for the P0 on-demand odds policy.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("backend starts provider-consuming MLB closing worker only behind explicit opt-in", () => {
  const source = fs.readFileSync("server/index.ts", "utf8");
  assert.match(source, /const mlbClosingLineCaptureEnabled = isMlbClosingLineCaptureEnabled\(\);/);
  assert.match(source, /if \(mlbClosingLineCaptureEnabled\) \{\s*startMlbClosingLineWorker/);
  assert.doesNotMatch(source, /mlbClosingLineCapture:\s*process\.env\.MLB_CLOSING_LINE_CAPTURE !== "false"/);
});
