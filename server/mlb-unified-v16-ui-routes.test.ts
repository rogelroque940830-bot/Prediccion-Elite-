import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_UNIFIED_V16_MANUAL_PRICE_ROUTE,
  MLB_UNIFIED_V16_UI_ROUTE,
} from "./mlb-unified-v16-ui-routes";

// The normal UI command still owns certified sporting assembly and the automatic
// provider/cache price attempt. Manual continuity is a separate explicit command
// that can only price an already-frozen server-custodied BEST PICK.
test("V16 UI and manual price commands remain explicit boundaries", () => {
  assert.equal(MLB_UNIFIED_V16_UI_ROUTE, "/api/mlb/unified-v16/ui-run");
  assert.equal(MLB_UNIFIED_V16_MANUAL_PRICE_ROUTE, "/api/mlb/unified-v16/manual-price");
});
