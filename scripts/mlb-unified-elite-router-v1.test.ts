import assert from "node:assert/strict";
import {
  MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE,
  MLB_UNIFIED_ELITE_ROUTER_VERSION,
  PP_TECHNICAL_UNAVAILABLE_REASONS,
  routeUnifiedEliteBoth,
  routeUnifiedEliteChallenger,
  routeUnifiedEliteControl,
  type EliteSelectionInput,
  type PpHorizonDecision,
  type UnifiedEliteRouterInput,
} from "../server/mlb-unified-elite-router-v1";

const DATE = MLB_UNIFIED_ELITE_FIRST_PROSPECTIVE_DATE;

function pick(gamePk: number, market: string, horizon: string, side: string): EliteSelectionInput {
  return { officialDate: DATE, gamePk, market, horizon, side, selectedLine: null };
}

function base(): UnifiedEliteRouterInput {
  return {
    officialDate: DATE,
    aPlus: { status: "NO_PLAY", reason: "NO_A_PLUS" },
    premium: { status: "NO_PLAY", reason: "NO_PREMIUM" },
    ppHorizon: { status: "NO_PLAY", reason: "NO_PP_SELECTION" },
    fullModular: { status: "NO_PLAY", reason: "NO_FULL_MODULAR" },
  };
}

function expectTier(result: ReturnType<typeof routeUnifiedEliteChallenger>, tier: string, gamePk: number): void {
  assert.equal(result.status, "SELECTION");
  if (result.status !== "SELECTION") throw new Error("EXPECTED_SELECTION");
  assert.equal(result.selectedTier, tier);
  assert.equal(result.selection.gamePk, gamePk);
  assert.equal(result.selectionCount, 1);
}

{
  const x = base();
  x.aPlus = { status: "SELECTION", selection: pick(1001, "FG_ML", "FG", "HOME") };
  x.premium = { status: "SELECTION", selection: pick(1002, "FG_RL_HOME_PLUS_1_5", "FG", "HOME") };
  x.ppHorizon = { status: "SELECTION", selection: pick(1003, "F5_ML", "F5", "AWAY") };
  x.fullModular = { status: "SELECTION", selection: pick(1004, "F3_RL_HOME_PLUS_0_5", "F3", "HOME") };
  const r = routeUnifiedEliteBoth(x);
  expectTier(r.control, "A_PLUS", 1001);
  expectTier(r.challenger, "A_PLUS", 1001);
}

{
  const x = base();
  x.premium = { status: "SELECTION", selection: pick(1102, "FG_ML", "FG", "HOME") };
  x.ppHorizon = { status: "SELECTION", selection: pick(1103, "F5_ML", "F5", "AWAY") };
  x.fullModular = { status: "SELECTION", selection: pick(1104, "F3_RL_HOME_PLUS_0_5", "F3", "HOME") };
  const r = routeUnifiedEliteBoth(x);
  expectTier(r.control, "PREMIUM", 1102);
  expectTier(r.challenger, "PREMIUM", 1102);
}

{
  const x = base();
  x.ppHorizon = { status: "SELECTION", selection: pick(1203, "F5_ML", "F5", "AWAY") };
  x.fullModular = { status: "SELECTION", selection: pick(1204, "FG_ML", "FG", "HOME") };
  const r = routeUnifiedEliteBoth(x);
  expectTier(r.challenger, "PP_HORIZON", 1203);
  expectTier(r.control, "FULL_MODULAR", 1204);
}

{
  const x = base();
  x.ppHorizon = { status: "NO_PLAY", reason: "NO_PP_SELECTION" };
  x.fullModular = { status: "SELECTION", selection: pick(1304, "FG_ML", "FG", "HOME") };
  const r = routeUnifiedEliteBoth(x);
  assert.equal(r.challenger.status, "NO_PLAY");
  if (r.challenger.status === "NO_PLAY") assert.equal(r.challenger.reason, "PP_HORIZON_NO_PLAY");
  expectTier(r.control, "FULL_MODULAR", 1304);
}

for (const reason of PP_TECHNICAL_UNAVAILABLE_REASONS) {
  const x = base();
  x.ppHorizon = { status: "TECHNICAL_UNAVAILABLE", reason };
  x.fullModular = { status: "SELECTION", selection: pick(1404, "F3_RL_HOME_PLUS_0_5", "F3", "HOME") };
  const r = routeUnifiedEliteBoth(x);
  expectTier(r.challenger, "FULL_MODULAR", 1404);
  expectTier(r.control, "FULL_MODULAR", 1404);
  if (r.challenger.status === "SELECTION") {
    assert.equal(r.challenger.trace.some((entry) => entry.includes(reason)), true);
  }
}

{
  const x = base();
  x.ppHorizon = {
    status: "TECHNICAL_UNAVAILABLE",
    reason: "LOW_SIGNAL" as never,
  } as PpHorizonDecision;
  x.fullModular = { status: "SELECTION", selection: pick(1504, "FG_ML", "FG", "HOME") };
  const r = routeUnifiedEliteBoth(x);
  assert.equal(r.control.status, "NO_PLAY");
  assert.equal(r.challenger.status, "NO_PLAY");
  if (r.challenger.status === "NO_PLAY") assert.equal(r.challenger.reason, "INVALID_PP_TECHNICAL_UNAVAILABLE_REASON");
}

{
  const x = base();
  x.ppHorizon = { status: "TECHNICAL_UNAVAILABLE", reason: "PP_PREGAME_SOURCE_UNAVAILABLE" };
  const r = routeUnifiedEliteBoth(x);
  assert.equal(r.challenger.status, "NO_PLAY");
  if (r.challenger.status === "NO_PLAY") assert.equal(r.challenger.reason, "NO_VALID_TECHNICAL_FALLBACK_SELECTION");
}

for (const ppHorizon of [
  { status: "NO_PLAY", reason: "NO_PP_SELECTION" },
  { status: "TECHNICAL_UNAVAILABLE", reason: "PP_REQUIRED_FEATURE_MISSING" },
  { status: "SELECTION", selection: pick(1603, "F5_ML", "F5", "AWAY") },
] as PpHorizonDecision[]) {
  const x = base();
  x.ppHorizon = ppHorizon;
  x.fullModular = { status: "SELECTION", selection: pick(1604, "FG_ML", "FG", "HOME") };
  expectTier(routeUnifiedEliteControl(x), "FULL_MODULAR", 1604);
}

{
  const r = routeUnifiedEliteBoth(base());
  assert.equal(r.control.status, "NO_PLAY");
  assert.equal(r.challenger.status, "NO_PLAY");
  assert.equal(r.control.selectionCount, 0);
  assert.equal(r.challenger.selectionCount, 0);
  assert.equal(r.maximumSelectionsPerArm, 1);
  assert.equal(r.mixedAcrossTiers, false);
  assert.equal(r.outcomeInputsUsed, false);
}

{
  const x = base();
  x.fullModular = {
    status: "SELECTION",
    selection: { ...pick(1704, "FG_ML", "FG", "HOME"), officialDate: "2026-08-20" },
  };
  const r = routeUnifiedEliteBoth(x);
  assert.equal(r.control.status, "NO_PLAY");
  assert.equal(r.challenger.status, "NO_PLAY");
  if (r.control.status === "NO_PLAY") assert.equal(r.control.reason, "INVALID_FULL_MODULAR_SELECTION");
}

{
  const x = base();
  x.officialDate = "2026-08-18";
  const r = routeUnifiedEliteBoth(x);
  assert.equal(r.control.status, "NO_PLAY");
  assert.equal(r.challenger.status, "NO_PLAY");
  if (r.control.status === "NO_PLAY") assert.equal(r.control.reason, "BEFORE_FROZEN_PROSPECTIVE_BOUNDARY");
}

{
  const x = base();
  x.ppHorizon = {
    status: "SELECTION",
    selection: { ...pick(1803, "FG_ML", "FG", "AWAY"), unregisteredMetric: 0.99 } as EliteSelectionInput,
  };
  const r = routeUnifiedEliteChallenger(x);
  expectTier(r, "PP_HORIZON", 1803);
  if (r.status === "SELECTION") {
    assert.deepEqual(Object.keys(r.selection).sort(), ["gamePk","horizon","market","officialDate","selectedLine","side"].sort());
  }
}

{
  const x = base();
  x.ppHorizon = { status: "TECHNICAL_UNAVAILABLE", reason: "PP_RUNTIME_INTEGRITY_FAILED" };
  x.fullModular = { status: "SELECTION", selection: pick(1904, "F5_ML", "F5", "HOME") };
  const both = routeUnifiedEliteBoth(x);
  assert.deepEqual(routeUnifiedEliteControl(x), both.control);
  assert.deepEqual(routeUnifiedEliteChallenger(x), both.challenger);
  assert.equal(both.routerVersion, MLB_UNIFIED_ELITE_ROUTER_VERSION);
}

console.log("MLB_UNIFIED_ELITE_ROUTER_V1_TESTS_PASSED");
