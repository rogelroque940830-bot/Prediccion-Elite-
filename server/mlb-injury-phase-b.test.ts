import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbInjuryPhaseBPlan, type MlbInjuryPhaseBPlayer } from "./mlb-injury-phase-b";
import type { MlbInjuryShadowResult } from "./mlb-injury-shadow";

function shadow(overrides: Partial<MlbInjuryShadowResult> = {}): MlbInjuryShadowResult {
  return {
    decision: "APPLY_CANDIDATE",
    confidence: "HIGH",
    impact: "MEDIUM",
    reasonCode: "OFFICIAL_IL_HIGH_LEVERAGE_RELIEVER",
    reason: "test",
    officialStatusCode: "D15",
    officialStatus: "Injured 15-Day",
    daysSinceOfficialTransaction: 4,
    shadowOnly: true,
    ...overrides,
  };
}

function player(overrides: Partial<MlbInjuryPhaseBPlayer> = {}): MlbInjuryPhaseBPlayer {
  return {
    playerId: 10,
    name: "High Leverage Reliever",
    isPitcher: true,
    shadow: shadow(),
    ...overrides,
  };
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    sourceStatus: "VERIFIED",
    officialValidationStatus: "VERIFIED" as const,
    stale: false,
    anomalous: false,
    rejectedCount: 0,
    officialOnly: 0,
    players: [player()],
    ...overrides,
  };
}

test("recent officially confirmed high-leverage reliever is eligible", () => {
  const plan = buildMlbInjuryPhaseBPlan(base());
  assert.equal(plan.autoApplyAllowed, true);
  assert.deepEqual(plan.eligiblePlayerNames, ["High Leverage Reliever"]);
  assert.equal(plan.coverage, "FULL");
  assert.equal(plan.scale, 0.50);
  assert.equal(plan.maxAbsRuns, 0.50);
});

test("high-impact hitter remains withheld to avoid lineup double counting", () => {
  const hitter = player({
    name: "High Impact Hitter",
    isPitcher: false,
    shadow: shadow({ reasonCode: "OFFICIAL_IL_HIGH_IMPACT_HITTER", impact: "HIGH" }),
  });
  const plan = buildMlbInjuryPhaseBPlan(base({ players: [hitter] }));
  assert.equal(plan.autoApplyAllowed, false);
  assert.deepEqual(plan.withheldCandidateNames, ["High Impact Hitter"]);
});

test("missing official transaction age prevents automatic activation", () => {
  const undated = player({ shadow: shadow({ daysSinceOfficialTransaction: null }) });
  const plan = buildMlbInjuryPhaseBPlan(base({ players: [undated] }));
  assert.equal(plan.autoApplyAllowed, false);
});

test("stale or partially verified sources block all automatic adjustments", () => {
  const stalePlan = buildMlbInjuryPhaseBPlan(base({ stale: true }));
  const partialPlan = buildMlbInjuryPhaseBPlan(base({ officialValidationStatus: "PARTIAL" }));
  assert.equal(stalePlan.coverage, "BLOCKED");
  assert.equal(stalePlan.autoApplyAllowed, false);
  assert.equal(partialPlan.autoApplyAllowed, false);
});

test("known reliever may activate with stricter cap when cross-source coverage is partial", () => {
  const plan = buildMlbInjuryPhaseBPlan(base({ rejectedCount: 2, officialOnly: 3 }));
  assert.equal(plan.autoApplyAllowed, true);
  assert.equal(plan.coverage, "PARTIAL");
  assert.equal(plan.scale, 0.35);
  assert.equal(plan.maxAbsRuns, 0.35);
});

test("conflicts and pending records are never eligible", () => {
  const conflict = player({ name: "Conflict", shadow: shadow({ decision: "CONFLICT" }) });
  const pending = player({ playerId: 11, name: "Pending", shadow: shadow({ decision: "PENDING" }) });
  const plan = buildMlbInjuryPhaseBPlan(base({ players: [conflict, pending] }));
  assert.equal(plan.autoApplyAllowed, false);
  assert.deepEqual(plan.eligiblePlayerNames, []);
});
