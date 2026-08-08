import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3e5LiveFrozenEnvelope,
  MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED,
} from "./mlb-p1-operating-envelope-frozen-live";

function isoDate(day: number): string {
  return new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
}

function row(id: string, day: number): MlbP1M3dReviewRow {
  const gameDate = isoDate(day);
  return {
    predictionId: id,
    lifecycleKey: `life:${id}`,
    recordedAt: `${gameDate}T14:00:00.000Z`,
    gameDate,
    gamePk: 910000 + day,
    homeTeam: "HOME",
    awayTeam: "AWAY",
    market: "F5_ML",
    selection: "HOME",
    line: null,
    oddsAmerican: -110,
    closingOddsAmerican: null,
    stage: "FINAL",
    sourceSignal: "BET",
    sourceCategory: "PREMIUM",
    disposition: "ACCEPTED",
    effectiveDecision: "BET",
    actionability: "ACTIONABLE_FINAL",
    effectiveAnalyticalUnits: 0.5,
    economicLayerValid: true,
    economicLayerErrors: [],
    modelProbability: 0.62,
    marketImpliedProbability: 0.5238,
    noVigProbability: 0.51,
    edgePp: 9.62,
    result: null,
    settledAt: null,
    flatProfitUnits: 0,
    policyProfitUnits: 0,
    brierScore: null,
    logLoss: null,
    clvPp: null,
    dataQualityCoveragePct: 100,
    dataQualityMissing: [],
  };
}

function rows(days: number, rowsPerDay = 3): MlbP1M3dReviewRow[] {
  const output: MlbP1M3dReviewRow[] = [];
  for (let day = 0; day < days; day += 1) {
    for (let slot = 0; slot < rowsPerDay; slot += 1) {
      output.push(row(`p-${day}-${slot}`, day));
    }
  }
  return output;
}

function source(values: MlbP1M3dReviewRow[]) {
  return {
    ownedLedgerRecords: values.length + 20,
    uniqueAnalyticalDecisions: values.length,
  };
}

const generatedAt = "2026-08-08T16:30:00.000Z";

test("live adapter waits without weakening the preregistered freeze minimums", () => {
  const values = rows(35);
  const report = buildMlbP1M3e5LiveFrozenEnvelope(values, source(values), { generatedAt });
  assert.equal(report.state, "WAITING_FOR_FREEZE");
  assert.equal(report.freeze.state, "WAITING_FOR_FREEZE");
  assert.equal(report.evaluation.state, "WAITING_FOR_FREEZE");
  assert.equal(report.freeze.configuration.minimumPregameDecisions, 120);
  assert.equal(report.freeze.configuration.minimumDistinctDates, 36);
  assert.equal(report.interpretation.researchWindowFrozen, false);
});

test("first qualifying owner cohort freezes and then waits for all frozen settlements", () => {
  const values = rows(40);
  const report = buildMlbP1M3e5LiveFrozenEnvelope(values, source(values), { generatedAt });
  assert.equal(report.freeze.state, "FROZEN_RESEARCH_WINDOW");
  assert.equal(report.state, "FROZEN_WAITING_FOR_SETTLEMENTS");
  assert.equal(report.evaluation.manifest.verified, true);
  assert.equal(report.evaluation.cohort.frozenRows, 120);
  assert.equal(report.evaluation.cohort.unresolvedFrozenRows, 120);
  assert.equal(report.interpretation.researchWindowFrozen, true);
  assert.equal(report.interpretation.stableModelQualityEnvelopeSupported, false);
});

test("future owner decisions cannot move the frozen live manifest", () => {
  const initialRows = rows(40);
  const appendedRows = rows(50);
  const initial = buildMlbP1M3e5LiveFrozenEnvelope(initialRows, source(initialRows), { generatedAt });
  const appended = buildMlbP1M3e5LiveFrozenEnvelope(appendedRows, source(appendedRows), { generatedAt });
  assert.ok(initial.freeze.freeze && appended.freeze.freeze);
  assert.equal(appended.freeze.freeze.cutoffDate, initial.freeze.freeze.cutoffDate);
  assert.equal(appended.freeze.freeze.manifestDigest, initial.freeze.freeze.manifestDigest);
  assert.equal(appended.freeze.freeze.discovery.dateDigest, initial.freeze.freeze.discovery.dateDigest);
  assert.equal(appended.freeze.freeze.validation.dateDigest, initial.freeze.freeze.validation.dateDigest);
  assert.equal(appended.freeze.freeze.confirmation.dateDigest, initial.freeze.freeze.confirmation.dateDigest);
  assert.equal(appended.evaluation.cohort.frozenRows, initial.evaluation.cohort.frozenRows);
  assert.ok(appended.evaluation.cohort.futureRowsExcluded > 0);
});

test("truncated upstream review fails closed before any freeze conclusion", () => {
  const values = rows(40);
  assert.throws(
    () => buildMlbP1M3e5LiveFrozenEnvelope(values, {
      ownedLedgerRecords: values.length + 100,
      uniqueAnalyticalDecisions: values.length + 1,
    }, { generatedAt }),
    new RegExp(MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED),
  );
});

test("live composition cannot activate money, model changes or automatic promotion", () => {
  const values = rows(40);
  const report = buildMlbP1M3e5LiveFrozenEnvelope(values, source(values), { generatedAt });
  assert.equal(report.interpretation.economicProfitabilityCertified, false);
  assert.equal(report.interpretation.operationalRecommendationGateAllowed, false);
  assert.equal(report.interpretation.bettingRecommendationAllowed, false);
  assert.equal(report.interpretation.stakeChangesAllowed, false);
  assert.equal(report.interpretation.automaticBettingAllowed, false);
  assert.equal(report.interpretation.modelProbabilityChanged, false);
  assert.equal(report.interpretation.existingEconomicThresholdsChanged, false);
  assert.equal(report.interpretation.premiumNoUltraProspectiveHypothesisChanged, false);
  assert.equal(report.interpretation.automaticModelChangesAllowed, false);
  assert.equal(report.interpretation.automaticPromotionAllowed, false);
});
