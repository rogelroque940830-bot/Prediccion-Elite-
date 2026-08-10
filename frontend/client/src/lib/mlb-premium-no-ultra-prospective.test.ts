import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_PREMIUM_NO_ULTRA_ENDPOINT,
  parseMlbPremiumNoUltraEnvelope,
} from "./mlb-premium-no-ultra-prospective";

function metric(overrides: Record<string, unknown> = {}) {
  return {
    observations: 0,
    settled: 0,
    pending: 0,
    dates: 0,
    wins: 0,
    losses: 0,
    hitRatePct: null,
    meanModelProbability: null,
    observedWinRate: null,
    calibrationGap: null,
    flatStakeProfitUnits: 0,
    flatStakeRoiPct: null,
    brierScore: null,
    logLoss: null,
    clvAvailable: 0,
    clvCoveragePct: null,
    meanClvPp: null,
    medianClvPp: null,
    ...overrides,
  };
}

function validEnvelope() {
  return {
    success: true,
    endpoint: MLB_PREMIUM_NO_ULTRA_ENDPOINT,
    data: {
      schemaVersion: "courtedge-p1-premium-no-ultra-prospective.v1",
      generatedAt: "2026-08-08T05:00:00Z",
      state: "COLLECTING_PROSPECTIVE_EVIDENCE",
      preregistration: {
        cutoff: "2026-08-08T04:32:33Z",
        cutoffEvidenceCommit: "a2bc70badc97251f2f0333beb1b2b954f841fad0",
        ruleSemanticsCommit: "a2bc70badc97251f2f0333beb1b2b954f841fad0",
        market: "F5_ML",
        requiredStage: "FINAL",
        requiredSource: "app",
        classificationSurface: "ANALYSIS_RAW_OUTPUT_MARKETS_FINAL_RECOMMENDATION",
        candidateRule: "FINAL_RECOMMENDATION_IS_PREMIUM_TRUE_AND_REASON_HAS_NO_ULTRA",
        unclassifiableExcluded: true,
        oneTerminalDecisionPerGame: true,
        alternativePicksExcluded: true,
        outcomeForbiddenFromMembership: true,
        minimumCandidateSettled: 50,
        minimumCandidateDates: 20,
        minimumControlSettled: 50,
        minimumControlDates: 20,
        bootstrapReplicates: 5000,
        maximumCalibrationGap: 0.05,
        maximumCalibrationDisadvantageVsControl: 0.01,
      },
      cohort: {
        inputReviewRows: 0,
        afterCutoff: 0,
        finalF5Rows: 0,
        unclassifiableRowsExcluded: 0,
        eligibleClassifiableRows: 0,
        independentGames: 0,
        duplicateGameRowsExcluded: 0,
        candidateGames: 0,
        controlGames: 0,
        candidateSettled: 0,
        controlSettled: 0,
        candidateDates: 0,
        controlDates: 0,
      },
      candidate: metric(),
      control: metric(),
      inference: {
        dateClusters: 0,
        candidateRoiPct: null,
        candidateMinusControlRoiPp: null,
      },
      criteria: {
        minimumCandidateSampleAccepted: false,
        minimumControlSampleAccepted: false,
        candidateRoiLower95Positive: false,
        candidateMinusControlRoiLower95Positive: false,
        meanClvPositive: false,
        properScoringNotWorse: false,
        calibrationAccepted: false,
        allAccepted: false,
      },
      blockers: ["PREMIUM_NO_ULTRA_CANDIDATE_SAMPLE_INSUFFICIENT"],
      interpretation: {
        prospectiveOnly: true,
        independentGameUnit: true,
        historicalThirteenAndFourIncludedInConfirmation: false,
        oldUltraMoneyGateRestored: false,
        economicProfitabilitySupported: false,
        operationalMoneyGateAllowed: false,
        stakeChangesAllowed: false,
        automaticBettingAllowed: false,
        automaticModelChangesAllowed: false,
        automaticPromotionAllowed: false,
      },
    },
  };
}

test("accepts frozen collecting response", () => {
  const parsed = parseMlbPremiumNoUltraEnvelope(validEnvelope());
  assert.equal(parsed.data.state, "COLLECTING_PROSPECTIVE_EVIDENCE");
  assert.equal(parsed.data.preregistration.minimumCandidateSettled, 50);
});

test("rejects old/post-hoc cutoff drift", () => {
  const value = validEnvelope();
  value.data.preregistration.cutoff = "2026-07-11T03:50:43Z";
  assert.throws(() => parseMlbPremiumNoUltraEnvelope(value), /cutoff/);
});

test("rejects unsafe operationalGateAllowed", () => {
  const value = validEnvelope();
  value.data.interpretation.operationalMoneyGateAllowed = true as false;
  assert.throws(() => parseMlbPremiumNoUltraEnvelope(value), /unsafe_operationalMoneyGateAllowed/);
});

test("rejects unsafe stake or betting flags", () => {
  const value = validEnvelope();
  value.data.interpretation.stakeChangesAllowed = true as false;
  assert.throws(() => parseMlbPremiumNoUltraEnvelope(value), /unsafe_stakeChangesAllowed/);
  const second = validEnvelope();
  second.data.interpretation.automaticBettingAllowed = true as false;
  assert.throws(() => parseMlbPremiumNoUltraEnvelope(second), /unsafe_automaticBettingAllowed/);
});

test("rejects independent-game accounting drift", () => {
  const value = validEnvelope();
  value.data.cohort.independentGames = 2;
  value.data.cohort.candidateGames = 1;
  value.data.cohort.controlGames = 0;
  assert.throws(() => parseMlbPremiumNoUltraEnvelope(value), /independent_accounting/);
});

test("supported state requires every registered criterion and remains research-only", () => {
  const value = validEnvelope();
  value.data.state = "ECONOMIC_EDGE_SUPPORTED_RESEARCH_ONLY";
  value.data.cohort = {
    inputReviewRows: 100,
    afterCutoff: 100,
    finalF5Rows: 100,
    unclassifiableRowsExcluded: 0,
    eligibleClassifiableRows: 100,
    independentGames: 100,
    duplicateGameRowsExcluded: 0,
    candidateGames: 50,
    controlGames: 50,
    candidateSettled: 50,
    controlSettled: 50,
    candidateDates: 20,
    controlDates: 20,
  };
  value.data.candidate = metric({
    observations: 50,
    settled: 50,
    pending: 0,
    dates: 20,
    wins: 32,
    losses: 18,
    hitRatePct: 64,
    meanModelProbability: 0.61,
    observedWinRate: 0.64,
    calibrationGap: 0.03,
    flatStakeProfitUnits: 7.5,
    flatStakeRoiPct: 15,
    brierScore: 0.21,
    logLoss: 0.61,
    clvAvailable: 50,
    clvCoveragePct: 100,
    meanClvPp: 1.8,
    medianClvPp: 1.5,
  });
  value.data.control = metric({
    observations: 50,
    settled: 50,
    pending: 0,
    dates: 20,
    wins: 26,
    losses: 24,
    hitRatePct: 52,
    meanModelProbability: 0.56,
    observedWinRate: 0.52,
    calibrationGap: 0.04,
    flatStakeProfitUnits: -0.5,
    flatStakeRoiPct: -1,
    brierScore: 0.24,
    logLoss: 0.69,
    clvAvailable: 50,
    clvCoveragePct: 100,
    meanClvPp: 0.2,
    medianClvPp: 0.1,
  });
  value.data.inference = {
    dateClusters: 20,
    candidateRoiPct: {
      confidenceLevel: 0.95,
      replicatesRequested: 5000,
      replicatesUsed: 5000,
      pointEstimate: 15,
      lower: 2,
      upper: 28,
    },
    candidateMinusControlRoiPp: {
      confidenceLevel: 0.95,
      replicatesRequested: 5000,
      replicatesUsed: 5000,
      pointEstimate: 16,
      lower: 1,
      upper: 31,
    },
  };
  for (const key of Object.keys(value.data.criteria)) {
    value.data.criteria[key as keyof typeof value.data.criteria] = true;
  }
  value.data.interpretation.economicProfitabilitySupported = true;
  value.data.blockers = ["PREMIUM_NO_ULTRA_RESEARCH_SUPPORT_ONLY", "PREMIUM_NO_ULTRA_OPERATIONAL_MONEY_GATE_NOT_ACTIVATED"];
  const parsed = parseMlbPremiumNoUltraEnvelope(value);
  assert.equal(parsed.data.interpretation.economicProfitabilitySupported, true);
  assert.equal(parsed.data.interpretation.operationalMoneyGateAllowed, false);
  assert.equal(parsed.data.interpretation.automaticBettingAllowed, false);
});
