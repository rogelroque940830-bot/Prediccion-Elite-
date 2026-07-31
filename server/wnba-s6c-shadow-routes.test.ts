import assert from "node:assert/strict";
import test from "node:test";
import { buildPublicWnbaShadowHealth } from "./wnba-s6c-shadow-routes";

test("S6C public health accounts for every audit outcome without leaking private evidence", () => {
  const payload = buildPublicWnbaShadowHealth({
    schemaVersion: "wnba-shadow.v1",
    enabled: true,
    intervalMs: 300_000,
    initialDelayMs: 240_000,
    finalWindowMinutes: 45,
    lastRunAt: "2026-07-31T02:23:27.723Z",
    lastSuccessAt: "2026-07-31T02:23:27.723Z",
    lastError: null,
    records: 0,
    settlements: 0,
    latest: {
      schemaVersion: "wnba-shadow-run.v1",
      ranAt: "2026-07-31T02:23:27.723Z",
      trigger: "scheduled",
      gameDate: "2026-07-30",
      deploymentCommit: "test-sha",
      environment: "p0-integration",
      discoveredGames: 3,
      pricedGames: 0,
      recordsCreated: 0,
      idempotentRecords: 0,
      provisionalCreated: 0,
      finalCreated: 0,
      skippedStarted: 3,
      unmatchedOdds: 0,
      missingMoneyline: 0,
      settlementsCreated: 0,
      errors: [],
      report: {} as any,
      safety: {} as any,
    },
    report: {
      schemaVersion: "wnba-shadow-report.v1",
      generatedAt: "2026-07-31T02:23:27.723Z",
      records: 0,
      terminalGames: 0,
      supersededRecords: 0,
      provisionalTerminal: 0,
      finalTerminal: 0,
      finalCoveragePct: 0,
      settled: 0,
      pending: 0,
      settlementCoveragePct: 0,
      marketCoveragePct: 0,
      averageDataQualityPct: null,
      degradedSourceTerminalRecords: 0,
      averageBrierScore: null,
      averageLogLoss: null,
      favoriteAccuracyPct: null,
      safety: {
        mode: "SHADOW_MARKET_BASELINE",
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
        predictorThresholdsChanged: false,
        stakePolicyChanged: false,
      },
    },
  });

  const latest = payload.latest as Record<string, unknown>;
  assert.equal(payload.status, "healthy");
  assert.equal(latest.discoveredGames, 3);
  assert.equal(latest.skippedStarted, 3);
  assert.equal(latest.unmatchedOdds, 0);
  assert.equal(latest.missingMoneyline, 0);

  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "homeTeam",
    "awayTeam",
    "homeOddsAmerican",
    "awayOddsAmerican",
    "homeWinProbability",
    "gameId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
