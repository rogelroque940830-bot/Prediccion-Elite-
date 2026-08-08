import assert from "node:assert/strict";
import test from "node:test";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import { buildMlbP1M3e3OperatingEnvelopeFreeze } from "./mlb-p1-operating-envelope-freeze";

function isoDate(day: number): string {
  return new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
}

function row(input: {
  id: string;
  day: number;
  result?: "WIN" | "LOSS" | null;
}): MlbP1M3dReviewRow {
  const gameDate = isoDate(input.day);
  const result = input.result === undefined ? null : input.result;
  return {
    predictionId: input.id,
    lifecycleKey: `life:${input.id}`,
    recordedAt: `${gameDate}T14:00:00.000Z`,
    gameDate,
    gamePk: 900000 + input.day,
    homeTeam: "HOME",
    awayTeam: "AWAY",
    market: "F5_ML",
    selection: "HOME",
    line: null,
    oddsAmerican: -110,
    closingOddsAmerican: result == null ? null : -115,
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
    result,
    settledAt: result == null ? null : `${gameDate}T23:30:00.000Z`,
    flatProfitUnits: result === "WIN" ? 0.91 : result === "LOSS" ? -1 : 0,
    policyProfitUnits: result === "WIN" ? 0.455 : result === "LOSS" ? -0.5 : 0,
    brierScore: result == null ? null : result === "WIN" ? (0.62 - 1) ** 2 : 0.62 ** 2,
    logLoss: result == null ? null : result === "WIN" ? -Math.log(0.62) : -Math.log(0.38),
    clvPp: result == null ? null : 1.2,
    dataQualityCoveragePct: 100,
    dataQualityMissing: [],
  };
}

function makeRows(days: number, rowsPerDay = 3): MlbP1M3dReviewRow[] {
  const rows: MlbP1M3dReviewRow[] = [];
  for (let day = 0; day < days; day += 1) {
    for (let slot = 0; slot < rowsPerDay; slot += 1) {
      rows.push(row({ id: `p-${day}-${slot}`, day }));
    }
  }
  return rows;
}

const options = {
  minimumPregameDecisions: 120,
  minimumDistinctDates: 36,
  generatedAt: "2026-08-08T15:30:00.000Z",
} as const;

test("first threshold-reaching pregame window freezes before outcome evaluation", () => {
  const report = buildMlbP1M3e3OperatingEnvelopeFreeze(makeRows(48), options);
  assert.equal(report.state, "FROZEN_RESEARCH_WINDOW");
  assert.ok(report.freeze);
  assert.equal(report.freeze.cutoffDate, isoDate(39));
  assert.equal(report.freeze.frozenRows, 120);
  assert.equal(report.freeze.frozenDates, 40);
  assert.equal(report.freeze.futureRowsExcluded, 24);
  assert.equal(report.freeze.discovery.dates, 20);
  assert.equal(report.freeze.validation.dates, 10);
  assert.equal(report.freeze.confirmation.dates, 10);
  assert.ok(report.freeze.discovery.maxDate < report.freeze.validation.minDate);
  assert.ok(report.freeze.validation.maxDate < report.freeze.confirmation.minDate);
  assert.equal(report.hypothesisProtection.outcomesUsedToChooseFreezeBoundary, false);
  assert.equal(report.hypothesisProtection.futureRowsMayMoveBoundary, false);
  assert.equal(report.interpretation.researchWindowFrozen, true);
  assert.equal(report.interpretation.economicProfitabilityCertified, false);
  assert.equal(report.interpretation.operationalRecommendationGateAllowed, false);
  assert.equal(report.interpretation.bettingRecommendationAllowed, false);
  assert.equal(report.interpretation.stakeChangesAllowed, false);
  assert.equal(report.interpretation.automaticBettingAllowed, false);
});

test("appending future decisions cannot move the frozen cutoff, partitions or manifest digest", () => {
  const initial = buildMlbP1M3e3OperatingEnvelopeFreeze(makeRows(40), options);
  const appended = buildMlbP1M3e3OperatingEnvelopeFreeze(makeRows(55), options);
  assert.ok(initial.freeze && appended.freeze);
  assert.equal(appended.freeze.cutoffDate, initial.freeze.cutoffDate);
  assert.equal(appended.freeze.frozenRows, initial.freeze.frozenRows);
  assert.equal(appended.freeze.frozenDates, initial.freeze.frozenDates);
  assert.equal(appended.freeze.decisionIdentityDigest, initial.freeze.decisionIdentityDigest);
  assert.equal(appended.freeze.discovery.dateDigest, initial.freeze.discovery.dateDigest);
  assert.equal(appended.freeze.validation.dateDigest, initial.freeze.validation.dateDigest);
  assert.equal(appended.freeze.confirmation.dateDigest, initial.freeze.confirmation.dateDigest);
  assert.equal(appended.freeze.manifestDigest, initial.freeze.manifestDigest);
  assert.equal(initial.freeze.futureRowsExcluded, 0);
  assert.ok(appended.freeze.futureRowsExcluded > 0);
});

test("outcomes, settlement, proper scores, profit, closing price and CLV cannot alter freeze identity", () => {
  const pending = makeRows(40);
  const settled = pending.map((value, index): MlbP1M3dReviewRow => ({
    ...value,
    result: index % 2 ? "LOSS" : "WIN",
    settledAt: `${value.gameDate}T23:59:00.000Z`,
    brierScore: index % 2 ? 0.91 : 0.01,
    logLoss: index % 2 ? 4.2 : 0.02,
    flatProfitUnits: index % 2 ? -10 : 20,
    policyProfitUnits: index % 2 ? -5 : 10,
    closingOddsAmerican: index % 2 ? -500 : 400,
    clvPp: index % 2 ? -20 : 25,
  }));
  const before = buildMlbP1M3e3OperatingEnvelopeFreeze(pending, options);
  const after = buildMlbP1M3e3OperatingEnvelopeFreeze(settled, options);
  assert.ok(before.freeze && after.freeze);
  assert.equal(after.freeze.cutoffDate, before.freeze.cutoffDate);
  assert.equal(after.freeze.decisionIdentityDigest, before.freeze.decisionIdentityDigest);
  assert.equal(after.freeze.manifestDigest, before.freeze.manifestDigest);
});

test("pending pregame decisions count toward freezing because outcomes are intentionally irrelevant", () => {
  const report = buildMlbP1M3e3OperatingEnvelopeFreeze(makeRows(40), options);
  assert.equal(report.cohort.eligiblePregameRows, 120);
  assert.equal(report.state, "FROZEN_RESEARCH_WINDOW");
  assert.ok(report.freeze);
});

test("insufficient pregame decision count or date diversity cannot freeze research partitions", () => {
  const report = buildMlbP1M3e3OperatingEnvelopeFreeze(makeRows(35), options);
  assert.equal(report.state, "WAITING_FOR_FREEZE");
  assert.equal(report.freeze, null);
  assert.equal(report.interpretation.researchWindowFrozen, false);
  assert.ok(report.blockers.includes("P1_M3E3_MINIMUM_PREGAME_DECISIONS_NOT_REACHED"));
  assert.ok(report.blockers.includes("P1_M3E3_MINIMUM_DISTINCT_DATES_NOT_REACHED"));
});

test("duplicate prediction identity fails closed instead of inflating the freeze sample", () => {
  const rows = makeRows(40);
  rows.push({ ...rows[0] });
  assert.throws(
    () => buildMlbP1M3e3OperatingEnvelopeFreeze(rows, options),
    /P1_M3E3_DUPLICATE_PREDICTION_ID/,
  );
});

test("invalid pregame identity rows are excluded and cannot create a freeze", () => {
  const rows = makeRows(40);
  rows[0] = { ...rows[0], recordedAt: "not-a-timestamp" };
  const report = buildMlbP1M3e3OperatingEnvelopeFreeze(rows, options);
  assert.equal(report.state, "WAITING_FOR_FREEZE");
  assert.equal(report.cohort.eligiblePregameRows, 119);
  assert.equal(report.cohort.excludedRows, 1);
});