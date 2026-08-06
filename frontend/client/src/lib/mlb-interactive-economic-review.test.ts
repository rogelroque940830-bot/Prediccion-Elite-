import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M3D_ENDPOINT,
  MLB_P1_M3D_SCHEMA,
  parseMlbP1M3dEconomicReviewEnvelope,
} from "./mlb-interactive-economic-review";

function metric(overrides: Record<string, unknown> = {}) {
  return {
    observations: 2,
    settled: 1,
    pending: 1,
    wins: 1,
    losses: 0,
    pushesOrVoids: 0,
    hitRatePct: 100,
    flatStakeExposureUnits: 1,
    flatStakeProfitUnits: 0.83,
    flatStakeRoiPct: 83,
    policyStakeExposureUnits: 0.5,
    policyStakeProfitUnits: 0.415,
    policyStakeRoiPct: 83,
    brierScore: 0.1681,
    logLoss: 0.5276,
    meanModelProbability: 0.59,
    observedWinRate: 1,
    winRateWilson95: { low: 0.2065, high: 1 },
    meanMarketImpliedProbability: 0.545455,
    meanEdgePp: 4.4545,
    clvAvailable: 1,
    clvCoveragePct: 100,
    meanClvPp: 1.2,
    medianClvPp: 1.2,
    ...overrides,
  };
}

function envelope() {
  return {
    success: true,
    endpoint: MLB_P1_M3D_ENDPOINT,
    data: {
      schemaVersion: MLB_P1_M3D_SCHEMA,
      release: "p1-m3d-interactive-economic-review-2026-08-06",
      endpoint: MLB_P1_M3D_ENDPOINT,
      generatedAt: "2026-08-06T12:00:00.000Z",
      state: "TECHNICAL_SAMPLE_ONLY",
      cohort: {
        source: "INTERACTIVE_MLB_PREDICTOR",
        ownerScoped: true,
        terminalSupersessionLeavesOnly: true,
        immutableLedgerSchema: "mlb-ledger.v1",
        minimumTechnicalSample: 5,
        preliminaryReviewSample: 20,
        preferredHumanReviewSample: 50,
      },
      sample: {
        ownedLedgerRecords: 10,
        interactiveLedgerRecords: 2,
        lifecycleChains: 2,
        terminalLeaves: 2,
        uniqueAnalyticalDecisions: 2,
        analyticalDuplicatesExcluded: 0,
        lifecycleBranchesExcluded: 0,
        malformedInteractiveRecordsExcluded: 0,
        economicLayersValid: 2,
        economicLayersInvalid: 0,
        settledDecisions: 1,
        pendingDecisions: 1,
        clvCoveredDecisions: 1,
        exclusionCounts: {},
      },
      overall: metric(),
      economicallyActionable: metric({ observations: 1, pending: 0 }),
      controls: {
        acceptedSourceSignals: metric({ observations: 1, pending: 0 }),
        leanPassInfoControls: metric({ observations: 1, settled: 0, pending: 1 }),
      },
      breakdowns: {
        byMarket: [{ key: "ML", metrics: metric() }],
        bySourceSignal: [],
        byEffectiveDecision: [],
        byActionability: [],
        byStage: [],
        byProbabilityBand: [],
      },
      lifecycle: {
        provisionalToFinalChains: 0,
        finalOnlyChains: 1,
        provisionalOnlyChains: 1,
      },
      readiness: {
        firstSettlementReached: true,
        technicalFiveReached: false,
        preliminaryTwentyReached: false,
        preferredFiftyReached: false,
        humanReviewAvailable: false,
        conclusionsAllowed: false,
        automaticModelChangesAllowed: false,
        automaticPromotionAllowed: false,
        recommendation: "KEEP_COLLECTING_INTERACTIVE_SHADOW_EVIDENCE",
      },
      methodology: {
        flatAccounting: "one unit",
        policyAccounting: "effective SHADOW units",
        properScoring: "Brier and log loss",
        clvAccounting: "comparable close only",
        revisions: "terminal lifecycle leaves only",
        controlsRetained: true,
      },
      issues: [],
      rows: [],
      safety: {
        mode: "SHADOW_ECONOMIC_REVIEW",
        realFinancialExposure: 0,
        sportsbookIntegration: false,
        automaticBetPlacement: false,
        productionWrites: false,
        settlementWrites: false,
        historicalLedgerMutation: false,
        automaticModelChangesAllowed: false,
        automaticPromotionAllowed: false,
      },
    },
  };
}

test("P1-M3D-B accepts the exact owner-scoped read-only report", () => {
  const parsed = parseMlbP1M3dEconomicReviewEnvelope(envelope());
  assert.equal(parsed.data.schemaVersion, MLB_P1_M3D_SCHEMA);
  assert.equal(parsed.data.sample.uniqueAnalyticalDecisions, 2);
  assert.equal(parsed.data.safety.realFinancialExposure, 0);
});

test("P1-M3D-B rejects a report that permits conclusions", () => {
  const value = envelope();
  value.data.readiness.conclusionsAllowed = true;
  assert.throws(() => parseMlbP1M3dEconomicReviewEnvelope(value), /conclusions_allowed/);
});

test("P1-M3D-B rejects any real financial exposure", () => {
  const value = envelope();
  value.data.safety.realFinancialExposure = 1;
  assert.throws(() => parseMlbP1M3dEconomicReviewEnvelope(value), /real_exposure/);
});

test("P1-M3D-B rejects a writable or sportsbook-enabled response", () => {
  const writable = envelope();
  writable.data.safety.productionWrites = true;
  assert.throws(() => parseMlbP1M3dEconomicReviewEnvelope(writable), /writes/);

  const sportsbook = envelope();
  sportsbook.data.safety.sportsbookIntegration = true;
  assert.throws(() => parseMlbP1M3dEconomicReviewEnvelope(sportsbook), /sportsbook/);
});

test("P1-M3D-B rejects a foreign schema or endpoint", () => {
  const wrongSchema = envelope();
  wrongSchema.data.schemaVersion = "other" as typeof MLB_P1_M3D_SCHEMA;
  assert.throws(() => parseMlbP1M3dEconomicReviewEnvelope(wrongSchema), /schema/);

  const wrongEndpoint = envelope();
  wrongEndpoint.endpoint = "/other" as typeof MLB_P1_M3D_ENDPOINT;
  assert.throws(() => parseMlbP1M3dEconomicReviewEnvelope(wrongEndpoint), /envelope_endpoint/);
});
