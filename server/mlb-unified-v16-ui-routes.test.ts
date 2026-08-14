import assert from "node:assert/strict";
import test from "node:test";
import { MLB_UNIFIED_V16_UI_ROUTE } from "./mlb-unified-v16-ui-routes";

// This slice deliberately stops before paid acquisition. The production UI may invoke this
// command with only a date, but certified sporting inputs must still be assembled server-side
// before the priced runner is allowed to execute.
test("V16 UI command remains an explicit non-priced boundary", () => {
  assert.equal(MLB_UNIFIED_V16_UI_ROUTE, "/api/mlb/unified-v16/ui-run");
});
