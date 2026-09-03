import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  MLB_UNIFIED_V16_MANUAL_PRICE_ROUTE,
  MLB_UNIFIED_V16_UI_ROUTE,
} from "./mlb-unified-v16-ui-routes";

// The normal UI command owns the sporting authority. Price remains a separate explicit
// downstream boundary and manual continuity can only price an already-frozen server pick.
test("V16 UI and manual price commands remain explicit boundaries", () => {
  assert.equal(MLB_UNIFIED_V16_UI_ROUTE, "/api/mlb/unified-v16/ui-run");
  assert.equal(MLB_UNIFIED_V16_MANUAL_PRICE_ROUTE, "/api/mlb/unified-v16/manual-price");
});

test("visible V16 analyzes the whole slate before any paid odds boundary", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "server/mlb-unified-v16-ui-routes.ts"), "utf8");

  assert.equal(
    source.includes("if (summary.finalReady.length === 0)"),
    false,
    "zero FINAL games must no longer short-circuit whole-slate sporting analysis",
  );
  assert.match(source, /requireCompleteProvisionalBullpenEvidence:\s*true/);
  assert.match(source, /status:\s*"WAITING_FOR_SPORTING_FINALIZATION"/);
  assert.match(source, /researchEliteCandidateIsProductionHardGate:\s*false/);
  assert.match(source, /priceMayChangeSportingSelection:\s*false/);

  const wholeSlateIndex = source.indexOf("const live = await buildOpportunityLive");
  const finalizationIndex = source.indexOf("const sportingFinalization = finalizeMlbWholeSlateSportingAuthority");
  const runtimeIndex = source.indexOf("const runtime = resolveRuntime()");
  const pricedIndex = source.indexOf("const result: MlbUnifiedPricedV16RunnerResult = await runPriced");
  assert.ok(wholeSlateIndex >= 0);
  assert.ok(finalizationIndex > wholeSlateIndex);
  assert.ok(runtimeIndex > finalizationIndex);
  assert.ok(pricedIndex > runtimeIndex);
});
