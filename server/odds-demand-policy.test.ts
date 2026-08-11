import assert from "node:assert/strict";
import test from "node:test";
import {
  explicitOptInEnabled,
  isMlbClosingLineCaptureEnabled,
} from "./odds-demand-policy";

// Research-only deployment custody trigger after the lossless Market Edge identity hotfix.
test("provider-consuming background work is disabled unless explicitly opted in", () => {
  assert.equal(explicitOptInEnabled(undefined), false);
  assert.equal(explicitOptInEnabled(""), false);
  assert.equal(explicitOptInEnabled("false"), false);
  assert.equal(explicitOptInEnabled("1"), false);
  assert.equal(explicitOptInEnabled("yes"), false);
  assert.equal(explicitOptInEnabled("true"), true);
  assert.equal(explicitOptInEnabled(" TRUE "), true);
});

test("MLB closing-line capture defaults OFF", () => {
  assert.equal(isMlbClosingLineCaptureEnabled({}), false);
  assert.equal(isMlbClosingLineCaptureEnabled({ MLB_CLOSING_LINE_CAPTURE: "false" }), false);
  assert.equal(isMlbClosingLineCaptureEnabled({ MLB_CLOSING_LINE_CAPTURE: "true" }), true);
});
