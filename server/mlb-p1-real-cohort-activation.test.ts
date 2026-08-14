import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbP1M5aRealCohortActivation,
  type MlbP1M5aActivationInput,
  type MlbP1M5aActivationRow,
} from "./mlb-p1-real-cohort-activation";

const NOW = "2026-08-06T13:40:00.000Z";

function row(overrides: Partial<MlbP1M5aActivationRow> = {}): MlbP1M5aActivationRow {
  return {
    predictionId: "mlb-pred-real-1",
    lifecycleKey: "824806:ML:HOME",
    recordedAt: "2026-08-05T20:30:00.000Z",
    gameDate: "2026-08-05",
    gamePk: 824806,
    homeTeam: "Baltimore Orioles",
    awayTeam: "Los Angeles Angels",
    market: "ML",
    selection: "Baltimore Orioles ML",
    stage: "FINAL",
    effectiveDecision: "BET",
    actionability: "ACTIONABLE_FINAL",
    economicLayerValid: true,
    economicLayerErrors: [],
    result: "WIN",
    settledAt: "2026-08-06T03:10:00.000Z",
    clvPp: 1.2,
    ...overrides,
  };
}

function input(overrides: Partial<MlbP1M5aActivationInput> = {}): MlbP1M5aActivationInput {
  return {
    generatedAt: NOW,
    rows: [],
    ownerScoped: true,
    terminalSupersessionLeavesOnly: true,
    lifecycleChains: 0,
    terminalLeaves: 0,
    analyticalDuplicatesExcluded: 0,
    lifecycleBranchesExcluded: 0,
    malformedInteractiveRecordsExcluded: 0,
    ...overrides,
  };
}

test("P1-M5A waits for the first real interactive capture", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input());
  assert.equal(activation.state, "WAITING_FOR_REAL_CAPTURE");
  assert.equal(activation.certified, false);
  assert.equal(activation.nextAction, "GENERATE_FIRST_REAL_PREDICTION");
  assert.deepEqual(activation.blockingReasons, ["REAL_INTERACTIVE_CAPTURE_REQUIRED"]);
});

test("P1-M5A records capture but requires a valid P1-M4B layer", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [row({ economicLayerValid: false, economicLayerErrors: ["P1_M4B_MISSING"], result: null, settledAt: null })],
    lifecycleChains: 1,
    terminalLeaves: 1,
  }));
  assert.equal(activation.state, "CAPTURE_REGISTERED");
  assert.equal(activation.nextAction, "GENERATE_VALID_ECONOMIC_CAPTURE");
  assert.equal(activation.checklist.interactiveCaptureObserved, true);
  assert.equal(activation.checklist.validEconomicLayerObserved, false);
});

test("P1-M5A waits for official settlement after a valid economic decision", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [row({ result: null, settledAt: null, clvPp: null })],
    lifecycleChains: 1,
    terminalLeaves: 1,
  }));
  assert.equal(activation.state, "ECONOMIC_DECISION_REGISTERED");
  assert.equal(activation.nextAction, "WAIT_FOR_OFFICIAL_SETTLEMENT");
  assert.equal(activation.checklist.validEconomicLayerObserved, true);
  assert.equal(activation.checklist.officialSettlementObserved, false);
});

test("P1-M5A certifies one same-decision capture, economics and settlement chain", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [row()],
    lifecycleChains: 1,
    terminalLeaves: 1,
  }));
  assert.equal(activation.state, "END_TO_END_CERTIFIED");
  assert.equal(activation.certified, true);
  assert.equal(activation.nextAction, "REVIEW_CERTIFIED_COHORT");
  assert.equal(activation.certificate?.predictionId, "mlb-pred-real-1");
  assert.equal(activation.certificate?.result, "WIN");
  assert.equal(activation.certificate?.matchup, "Los Angeles Angels vs Baltimore Orioles");
  assert.equal(activation.safety.realFinancialExposure, 0);
  assert.equal(activation.safety.syntheticCaptureCreation, false);
});

test("P1-M5A does not require CLV for pipeline activation", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [row({ clvPp: null })],
    lifecycleChains: 1,
    terminalLeaves: 1,
  }));
  assert.equal(activation.certified, true);
  assert.equal(activation.checklist.clvEvidenceObserved, false);
  assert.equal(activation.interpretation.clvRequiredForActivation, false);
  assert.equal(activation.certificate?.clvObserved, false);
});

test("P1-M5A requires the same row to have valid economics and settlement", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [
      row({ predictionId: "pending-valid", lifecycleKey: "1:ML:HOME", result: null, settledAt: null }),
      row({ predictionId: "settled-invalid", lifecycleKey: "2:ML:AWAY", economicLayerValid: false }),
    ],
    lifecycleChains: 2,
    terminalLeaves: 2,
  }));
  assert.equal(activation.certified, false);
  assert.equal(activation.state, "ECONOMIC_DECISION_REGISTERED");
  assert.equal(activation.checklist.officialSettlementObserved, true);
  assert.equal(activation.checklist.sameDecisionEndToEndObserved, false);
});

test("P1-M5A blocks lifecycle branches", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [row()],
    lifecycleChains: 2,
    terminalLeaves: 1,
    lifecycleBranchesExcluded: 1,
  }));
  assert.equal(activation.state, "BLOCKED_INTEGRITY");
  assert.equal(activation.certified, false);
  assert.equal(activation.nextAction, "RESOLVE_COHORT_INTEGRITY");
  assert.ok(activation.blockingReasons.includes("LIFECYCLE_BRANCH_CONFLICT"));
});

test("P1-M5A blocks analytical duplicates even when an eligible row exists", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [row()],
    lifecycleChains: 1,
    terminalLeaves: 1,
    analyticalDuplicatesExcluded: 1,
  }));
  assert.equal(activation.state, "BLOCKED_INTEGRITY");
  assert.equal(activation.certified, false);
  assert.ok(activation.blockingReasons.includes("ANALYTICAL_DUPLICATES_EXCLUDED"));
});

test("P1-M5A picks the earliest eligible official settlement deterministically", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [
      row({ predictionId: "later", settledAt: "2026-08-06T05:00:00.000Z" }),
      row({ predictionId: "earlier", lifecycleKey: "824807:TOTAL:OVER", settledAt: "2026-08-06T02:00:00.000Z" }),
    ],
    lifecycleChains: 2,
    terminalLeaves: 2,
  }));
  assert.equal(activation.certificate?.predictionId, "earlier");
});

test("P1-M5A preserves activation-only and zero-exposure invariants", () => {
  const activation = buildMlbP1M5aRealCohortActivation(input({
    rows: [row()],
    lifecycleChains: 1,
    terminalLeaves: 1,
  }));
  assert.equal(activation.interpretation.profitabilityConclusionAllowed, false);
  assert.equal(activation.interpretation.modelChangeAllowed, false);
  assert.equal(activation.interpretation.automaticPromotionAllowed, false);
  assert.equal(activation.safety.automaticBetPlacement, false);
  assert.equal(activation.safety.productionWrites, false);
  assert.equal(activation.safety.settlementWrites, false);
  assert.equal(activation.safety.historicalLedgerMutation, false);
});
