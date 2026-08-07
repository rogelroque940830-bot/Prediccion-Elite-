import assert from "node:assert/strict";
import test from "node:test";
import {
  MLB_P1_M3E_ENDPOINT,
  MLB_P1_M3E_SCHEMA,
  formatMlbP1M3eAtom,
  parseMlbP1M3eEnvelope,
} from "./mlb-operating-envelope";

function metric(observations = 20) {
  return {
    observations,
    dates: 12,
    wins: 12,
    losses: 8,
    meanModelProbability: 0.61,
    observedWinRate: 0.6,
    calibrationGap: -0.01,
    meanLogLoss: 0.64,
    meanBrierScore: 0.22,
    flatStakeRoiPct: 2.5,
    clvAvailable: observations,
    meanClvPp: 1.2,
  };
}

function validEnvelope(state: "INSUFFICIENT_SAMPLE" | "NO_DISCOVERY_RULE" | "CANDIDATE_NOT_CONFIRMED" | "ELITE_MODEL_QUALITY_SUPPORTED" = "CANDIDATE_NOT_CONFIRMED") {
  const selectedRule = state === "INSUFFICIENT_SAMPLE" || state === "NO_DISCOVERY_RULE"
    ? null
    : { atoms: [{ kind: "MODEL_PROBABILITY_AT_LEAST", value: 0.6 }], ruleKey: "MODEL_PROBABILITY_AT_LEAST:0.6" };
  const comparison = selectedRule
    ? {
        selected: metric(20),
        rejected: metric(30),
        coveragePct: 40,
        rejectedCoveragePct: 60,
        rejectedMinusSelectedLogLoss: 0.03,
        rejectedMinusSelectedBrier: 0.02,
      }
    : null;
  const inference = state === "CANDIDATE_NOT_CONFIRMED" || state === "ELITE_MODEL_QUALITY_SUPPORTED"
    ? {
        dateClusters: 20,
        selectedDateClusters: 12,
        rejectedDateClusters: 18,
        logLossImprovement: {
          confidenceLevel: 0.95,
          replicatesRequested: 5000,
          replicatesUsed: 5000,
          pointEstimate: 0.03,
          lower: state === "ELITE_MODEL_QUALITY_SUPPORTED" ? 0.01 : -0.01,
          upper: 0.05,
        },
        brierImprovement: {
          confidenceLevel: 0.95,
          replicatesRequested: 5000,
          replicatesUsed: 5000,
          pointEstimate: 0.02,
          lower: state === "ELITE_MODEL_QUALITY_SUPPORTED" ? 0.005 : -0.005,
          upper: 0.04,
        },
        calibrationAccepted: true,
        minimumCoverageAccepted: true,
        minimumSampleAccepted: true,
      }
    : null;

  return {
    success: true,
    endpoint: MLB_P1_M3E_ENDPOINT,
    data: {
      schemaVersion: MLB_P1_M3E_SCHEMA,
      generatedAt: "2026-08-07T23:00:00.000Z",
      state,
      configuration: {
        discoveryDateFraction: 0.6,
        minimumTotalObservations: 80,
        minimumTotalDates: 30,
        minimumDiscoverySelected: 20,
        minimumDiscoveryRejected: 20,
        minimumConfirmationSelected: 15,
        minimumConfirmationRejected: 15,
        minimumConfirmationSelectedDates: 10,
        minimumConfirmationCoveragePct: 10,
        maximumRuleAtoms: 2,
        bootstrapReplicates: 5000,
        candidateAtomCount: 40,
        candidateRuleCount: 500,
      },
      cohort: {
        inputRows: 100,
        scoreableRows: 80,
        excludedRows: 20,
        uniqueDates: 40,
      },
      temporalSplit: {
        leakageFree: true,
        discoveryMinDate: "2026-05-01",
        discoveryMaxDate: "2026-06-15",
        confirmationMinDate: "2026-06-16",
        confirmationMaxDate: "2026-08-01",
        discoveryRows: 48,
        confirmationRows: 32,
        discoveryDates: 24,
        confirmationDates: 16,
      },
      selectedRule,
      discovery: comparison,
      confirmation: comparison,
      confirmationInference: inference,
      interpretation: {
        modelQualityOperatingEnvelopeSupported: state === "ELITE_MODEL_QUALITY_SUPPORTED",
        economicProfitabilityCertified: false,
        operationalGateAllowed: false,
        modelProbabilityChanged: false,
        existingEconomicThresholdsChanged: false,
        automaticModelChangesAllowed: false,
        automaticPromotionAllowed: false,
      },
      blockers: state === "ELITE_MODEL_QUALITY_SUPPORTED" ? [] : ["NO_AUTOMATIC_PROMOTION"],
    },
  };
}

test("accepts a safe chronological M3E report and preserves the exact elite state", () => {
  const parsed = parseMlbP1M3eEnvelope(validEnvelope("ELITE_MODEL_QUALITY_SUPPORTED"));
  assert.equal(parsed.data.state, "ELITE_MODEL_QUALITY_SUPPORTED");
  assert.equal(parsed.data.temporalSplit.leakageFree, true);
  assert.equal(parsed.data.interpretation.operationalGateAllowed, false);
  assert.equal(parsed.data.interpretation.automaticPromotionAllowed, false);
});

test("rejects any response that tries to turn research support into an operational gate", () => {
  const unsafe = validEnvelope("ELITE_MODEL_QUALITY_SUPPORTED");
  (unsafe.data.interpretation as any).operationalGateAllowed = true;
  assert.throws(
    () => parseMlbP1M3eEnvelope(unsafe),
    /P1_M3E_UI_INVALID_RESPONSE:unsafe_operationalGateAllowed/,
  );
});

test("rejects temporal leakage or inconsistent cohort accounting", () => {
  const leaked = validEnvelope();
  leaked.data.temporalSplit.leakageFree = false;
  assert.throws(() => parseMlbP1M3eEnvelope(leaked), /temporal_leakage/);

  const inconsistent = validEnvelope();
  inconsistent.data.cohort.excludedRows = 19;
  assert.throws(() => parseMlbP1M3eEnvelope(inconsistent), /cohort_accounting/);
});

test("renders pregame rule atoms without settlement or profit language", () => {
  assert.equal(
    formatMlbP1M3eAtom({ kind: "MODEL_PROBABILITY_AT_LEAST", value: 0.65 }),
    "Prob. modelo ≥ 65%",
  );
  assert.equal(formatMlbP1M3eAtom({ kind: "EDGE_PP_AT_LEAST", value: 8 }), "Edge ≥ 8 pp");
  assert.equal(formatMlbP1M3eAtom({ kind: "NO_DATA_QUALITY_MISSING" }), "Sin datos críticos faltantes");
});
