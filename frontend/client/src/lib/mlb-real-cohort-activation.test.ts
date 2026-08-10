import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M5A_RELEASE,
  MLB_P1_M5A_SCHEMA,
  parseMlbP1M5aActivation,
} from "./mlb-real-cohort-activation";

export function activationFixture() {
  return {
    schemaVersion: MLB_P1_M5A_SCHEMA,
    release: MLB_P1_M5A_RELEASE,
    generatedAt: "2026-08-06T14:00:00.000Z",
    state: "END_TO_END_CERTIFIED",
    certified: true,
    checklist: {
      authenticatedOwnerScope: true,
      interactiveCaptureObserved: true,
      terminalDecisionObserved: true,
      validEconomicLayerObserved: true,
      officialSettlementObserved: true,
      sameDecisionEndToEndObserved: true,
      lifecycleIntegrityHealthy: true,
      analyticalIdentityProtected: true,
      finalCaptureObserved: true,
      clvEvidenceObserved: false,
    },
    counts: {
      terminalInteractiveDecisions: 2,
      validEconomicDecisions: 2,
      officiallySettledDecisions: 1,
      endToEndEligibleDecisions: 1,
      finalInteractiveDecisions: 1,
      clvCoveredDecisions: 0,
    },
    certificate: {
      predictionId: "mlb-pred-real-1",
      lifecycleKey: "824806:ML:HOME",
      recordedAt: "2026-08-05T20:30:00.000Z",
      settledAt: "2026-08-06T03:10:00.000Z",
      gameDate: "2026-08-05",
      gamePk: 824806,
      matchup: "Los Angeles Angels vs Baltimore Orioles",
      market: "ML",
      selection: "Baltimore Orioles ML",
      stage: "FINAL",
      effectiveDecision: "BET",
      actionability: "ACTIONABLE_FINAL",
      result: "WIN",
      clvObserved: false,
    },
    blockingReasons: [],
    nextAction: "REVIEW_CERTIFIED_COHORT",
    interpretation: {
      activationOnly: true,
      profitabilityConclusionAllowed: false,
      modelChangeAllowed: false,
      automaticPromotionAllowed: false,
      clvRequiredForActivation: false,
    },
    safety: {
      mode: "SHADOW_REAL_COHORT_ACTIVATION",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      settlementWrites: false,
      historicalLedgerMutation: false,
      syntheticCaptureCreation: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

test("P1-M5A frontend accepts the exact certified zero-exposure activation", () => {
  const parsed = parseMlbP1M5aActivation(activationFixture());
  assert.equal(parsed.certified, true);
  assert.equal(parsed.state, "END_TO_END_CERTIFIED");
  assert.equal(parsed.certificate?.gamePk, 824806);
  assert.equal(parsed.safety.realFinancialExposure, 0);
});

test("P1-M5A frontend accepts the waiting activation state without a certificate", () => {
  const value = activationFixture();
  value.state = "WAITING_FOR_REAL_CAPTURE";
  value.certified = false;
  value.certificate = null as unknown as typeof value.certificate;
  value.nextAction = "GENERATE_FIRST_REAL_PREDICTION";
  value.checklist.interactiveCaptureObserved = false;
  value.checklist.terminalDecisionObserved = false;
  value.checklist.validEconomicLayerObserved = false;
  value.checklist.officialSettlementObserved = false;
  value.checklist.sameDecisionEndToEndObserved = false;
  value.counts.terminalInteractiveDecisions = 0;
  value.counts.validEconomicDecisions = 0;
  value.counts.officiallySettledDecisions = 0;
  value.counts.endToEndEligibleDecisions = 0;
  assert.equal(parseMlbP1M5aActivation(value).state, "WAITING_FOR_REAL_CAPTURE");
});

test("P1-M5A frontend rejects a certified state without same-row evidence", () => {
  const value = activationFixture();
  value.checklist.sameDecisionEndToEndObserved = false;
  assert.throws(() => parseMlbP1M5aActivation(value), /certified_checklist/);
});

test("P1-M5A frontend rejects a certificate attached to an uncertified state", () => {
  const value = activationFixture();
  value.state = "ECONOMIC_DECISION_REGISTERED";
  value.certified = false;
  value.nextAction = "WAIT_FOR_OFFICIAL_SETTLEMENT";
  assert.throws(() => parseMlbP1M5aActivation(value), /certificate_for_uncertified_state/);
});

test("P1-M5A frontend rejects state and next-action drift", () => {
  const value = activationFixture();
  value.state = "BLOCKED_INTEGRITY";
  value.certified = false;
  value.certificate = null as unknown as typeof value.certificate;
  value.nextAction = "WAIT_FOR_OFFICIAL_SETTLEMENT";
  assert.throws(() => parseMlbP1M5aActivation(value), /blocked_next_action/);
});

test("P1-M5A frontend rejects conclusions, promotion and model changes", () => {
  const conclusions = activationFixture();
  conclusions.interpretation.profitabilityConclusionAllowed = true;
  assert.throws(() => parseMlbP1M5aActivation(conclusions), /profitability_conclusion/);

  const promotion = activationFixture();
  promotion.interpretation.automaticPromotionAllowed = true;
  assert.throws(() => parseMlbP1M5aActivation(promotion), /promotion/);

  const model = activationFixture();
  model.interpretation.modelChangeAllowed = true;
  assert.throws(() => parseMlbP1M5aActivation(model), /model_change/);
});

test("P1-M5A frontend rejects exposure, sportsbook, writes and synthetic captures", () => {
  const exposure = activationFixture();
  exposure.safety.realFinancialExposure = 1;
  assert.throws(() => parseMlbP1M5aActivation(exposure), /real_exposure/);

  const sportsbook = activationFixture();
  sportsbook.safety.sportsbookIntegration = true;
  assert.throws(() => parseMlbP1M5aActivation(sportsbook), /sportsbook/);

  const writes = activationFixture();
  writes.safety.settlementWrites = true;
  assert.throws(() => parseMlbP1M5aActivation(writes), /writes/);

  const synthetic = activationFixture();
  synthetic.safety.syntheticCaptureCreation = true;
  assert.throws(() => parseMlbP1M5aActivation(synthetic), /synthetic_capture/);
});

test("P1-M5A frontend keeps CLV optional for technical activation", () => {
  const value = activationFixture();
  value.checklist.clvEvidenceObserved = false;
  value.counts.clvCoveredDecisions = 0;
  value.certificate.clvObserved = false;
  assert.equal(parseMlbP1M5aActivation(value).certified, true);
});
