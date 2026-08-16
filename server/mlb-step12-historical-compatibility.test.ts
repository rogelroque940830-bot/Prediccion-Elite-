import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbStep12HistoricalCompatibilityReport } from "./mlb-step12-historical-compatibility";

test("Step 12 preserves historical discovery without creating live filters", () => {
  const report = buildMlbStep12HistoricalCompatibilityReport();
  assert.equal(report.policy.historicalDiscoveryBeforeProspectivePromotion, true);
  assert.equal(report.policy.highHitRatePocketsMayBeInvestigated, true);
  assert.equal(report.policy.lowerHitRateStableSignalsRemainEligibleForResearch, true);
  assert.equal(report.policy.qualityAndFrequencyMustBeReportedTogether, true);
  assert.equal(report.policy.livePickFiltersChanged, false);
  assert.equal(report.policy.step11cCapturePopulationChanged, false);
  assert.equal(report.policy.betEliteLabelProduced, false);
  assert.equal(report.policy.automaticBetPlacement, false);
});

test("missing historical prices do not block sporting signal discovery but do block historical EV claims", () => {
  const report = buildMlbStep12HistoricalCompatibilityReport();
  assert.equal(report.policy.missingHistoricalPricesDoNotBlockSportingSignalDiscovery, true);
  assert.equal(report.policy.missingHistoricalPricesBlockHistoricalEvClaims, true);
  const prices = report.families.find((family) => family.key === "historical_execution_price")!;
  assert.equal(prices.status, "MARKET_PRICE_MISSING");
  assert.equal(prices.discoveryEligible, false);
  assert.equal(prices.priceAwareEconomicEligible, false);
});

test("official outcomes are labels only and never pregame discovery features", () => {
  const report = buildMlbStep12HistoricalCompatibilityReport();
  const outcomes = report.families.find((family) => family.key === "official_outcomes")!;
  assert.equal(outcomes.status, "OUTCOME_ONLY");
  assert.equal(outcomes.discoveryEligible, false);
  assert.equal(outcomes.settlementEligible, true);
});

test("verified pregame sporting families remain eligible even when prior standalone tests were inconclusive", () => {
  const report = buildMlbStep12HistoricalCompatibilityReport();
  for (const key of ["league_distribution_baseline", "team_strength", "starting_pitcher", "official_t5_lineup"]) {
    const family = report.families.find((candidate) => candidate.key === key)!;
    assert.equal(family.status, "PREGAME_COMPATIBLE");
    assert.equal(family.discoveryEligible, true);
  }
});

test("frozen 2025 cohort and T-5 lineup coverage remain explicit", () => {
  const report = buildMlbStep12HistoricalCompatibilityReport();
  assert.equal(report.cohort.officialRegularSeasonFinalGames, 2430);
  assert.equal(report.cohort.uniqueOfficialDates, 184);
  assert.equal(report.cohort.heldOutValidationGamesPerHorizon, 1507);
  const lineup = report.families.find((family) => family.key === "official_t5_lineup")!;
  assert.equal(lineup.historicalCoverageGames, 2423);
  assert.equal(lineup.historicalCoveragePct, 99.711934);
});
