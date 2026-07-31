import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicWnbaPredictorShadowHealth } from "./wnba-s6d-predictor-shadow-routes";

test("S6D public health exposes only aggregate counts and safety", () => {
  const payload = buildPublicWnbaPredictorShadowHealth({
    schemaVersion: "wnba-predictor-shadow.v1",
    enabled: true,
    intervalMs: 60_000,
    initialDelayMs: 300_000,
    lastRunAt: "2026-07-31T14:40:00.000Z",
    lastSuccessAt: "2026-07-31T14:40:00.000Z",
    lastError: null,
    cutoverAt: "2026-07-31T14:35:00.000Z",
    records: 1,
    latest: {
      schemaVersion: "wnba-predictor-shadow-run.v1",
      ranAt: "2026-07-31T14:40:00.000Z",
      trigger: "scheduled",
      deploymentCommit: "test-sha",
      environment: "p0-integration",
      cutoverAt: "2026-07-31T14:35:00.000Z",
      sourceOutputsDiscovered: 4,
      modernOutputs: 3,
      legacyOutputs: 1,
      preCutoverIgnored: 3,
      newSourceOutputs: 1,
      recordsCreated: 1,
      idempotentOutputs: 0,
      supersedingRecords: 0,
      baselineLinked: 1,
      baselineAmbiguous: 0,
      explicitModelProbability: 0,
      missingModelProbability: 1,
      errors: [],
      report: {} as any,
      safety: {} as any,
    },
    report: {
      schemaVersion: "wnba-predictor-shadow-report.v1",
      generatedAt: "2026-07-31T14:40:00.000Z",
      records: 1,
      terminalDecisions: 1,
      supersededRecords: 0,
      baselineLinkedTerminal: 1,
      baselineLinkCoveragePct: 100,
      explicitModelProbabilityTerminal: 0,
      explicitModelProbabilityCoveragePct: 0,
      acceptedStatusTerminal: 1,
      acceptedStatusCoveragePct: 100,
      comparableEdgeTerminal: 0,
      averageEdgeVsMarketPp: null,
      missingEvidenceCounts: { modelProbability: 1 },
      safety: {
        mode: "PERSISTED_OUTPUT_SHADOW",
        predictionsCreated: 0,
        recommendedStakeUnits: 0,
        realFinancialExposure: 0,
        sportsbookIntegration: false,
        automaticBetPlacement: false,
        productionWrites: false,
        automaticPromotion: false,
        predictorFormulasChanged: false,
        predictorFiltersChanged: false,
        predictorMarketsChanged: false,
        predictorProbabilitiesChanged: false,
        predictorThresholdsChanged: false,
        stakePolicyChanged: false,
        retrospectiveSyntheticPredictions: false,
      },
    },
  });

  assert.equal(payload.status, "healthy");
  assert.equal((payload.latest as any).recordsCreated, 1);
  assert.equal((payload.report as any).terminalDecisions, 1);
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "homeTeam",
    "awayTeam",
    "selectedTeam",
    "opponent",
    "selection",
    "sourcePayload",
    "modelProbabilitySourceField",
    "s6cRecordId",
    "odds",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
