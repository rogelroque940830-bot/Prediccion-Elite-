import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOperationalIncidentCenter,
  OPERATIONAL_INCIDENT_CENTER_VERSION,
} from "./operational-incident-center";
import type { LedgerRecord } from "./mlb-ledger-store";
import type {
  WnbaShadowRecord,
  WnbaShadowSettlement,
  WnbaShadowStatus,
} from "./wnba-s6c-shadow-service";
import type { StoredPickV2 } from "./picks-v2-multiuser";

function mlbRecord(input: {
  id: string;
  commenceTime: string;
  stage?: "PROVISIONAL" | "FINAL";
  odds?: number;
  settlement?: LedgerRecord["settlement"];
}): LedgerRecord {
  return {
    prediction: {
      id: input.id,
      clientRequestId: null,
      recordedAt: "2026-08-03T20:00:00.000Z",
      recordedAtMs: Date.parse("2026-08-03T20:00:00.000Z"),
      game: {
        gamePk: 777,
        gameDate: "2026-08-03",
        commenceTime: input.commenceTime,
        homeTeam: "Chicago Cubs",
        awayTeam: "Detroit Tigers",
      },
      market: {
        type: "ML",
        selection: "Chicago Cubs",
        line: null,
        oddsAmerican: input.odds ?? -115,
        book: "Hard Rock Bet",
      },
      probabilities: {
        model: 0.55,
        marketImplied: 0.53,
        noVig: 0.52,
        edgePp: 3,
      },
      decision: {
        signal: "LEAN",
        confidenceLabel: "MEDIUM",
        confidencePct: 55,
        stakeUnits: 0,
      },
      analysisStage: input.stage ?? "FINAL",
      model: {
        name: "test",
        version: "v1",
        gitCommit: null,
        environment: "test",
      },
      supersedesId: null,
      source: "app",
      payloadSha256: "abc",
      payload: {},
    },
    settlement: input.settlement ?? null,
  } as LedgerRecord;
}

function wnbaRecord(): WnbaShadowRecord {
  return {
    schemaVersion: "wnba-shadow.v1",
    id: "wnba-1",
    fingerprint: "fp",
    recordedAt: "2026-08-03T20:00:00.000Z",
    recordedAtMs: Date.parse("2026-08-03T20:00:00.000Z"),
    supersedesId: null,
    game: {
      gameId: "g-1",
      gameDate: "2026-08-03",
      commenceTime: "2026-08-03T22:00:00.000Z",
      homeTeam: "New York Liberty",
      awayTeam: "Las Vegas Aces",
    },
    market: {
      type: "MONEYLINE",
      book: "Hard Rock Bet",
      capturedAt: "2026-08-03T20:00:00.000Z",
      homeOddsAmerican: -120,
      awayOddsAmerican: 110,
      homeRawImpliedProbability: 0.545,
      awayRawImpliedProbability: 0.476,
      homeDevigProbability: 0.534,
      awayDevigProbability: 0.466,
    },
    baseline: {
      name: "WNBA_MARKET_BASELINE",
      version: "v1",
      homeWinProbability: 0.534,
      awayWinProbability: 0.466,
      edgePp: 0,
    },
    decision: { signal: "OBSERVE", stakeUnits: 0 },
    analysisStage: "FINAL",
    context: { home: {}, away: {}, sources: {}, degradedSources: [] },
    dataQuality: { checks: 5, passed: 5, coveragePct: 100, missing: [] },
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
  };
}

function wnbaStatus(lastSuccessAt: string): WnbaShadowStatus {
  return {
    schemaVersion: "wnba-shadow.v1",
    enabled: true,
    intervalMs: 15 * 60_000,
    initialDelayMs: 1_000,
    finalWindowMinutes: 20,
    lastRunAt: lastSuccessAt,
    lastSuccessAt,
    lastError: null,
    records: 1,
    settlements: 0,
    latest: null,
    report: {
      schemaVersion: "wnba-shadow-report.v1",
      generatedAt: lastSuccessAt,
      records: 1,
      terminalGames: 1,
      trackedGames: 1,
      officialFinalGames: 0,
      awaitingOfficialFinal: 1,
      supersededRecords: 0,
      provisionalTerminal: 0,
      finalTerminal: 1,
      finalCoveragePct: 100,
      settled: 0,
      pending: 0,
      settlementCoveragePct: 0,
      marketCoveragePct: 100,
      averageDataQualityPct: 100,
      degradedSourceTerminalRecords: 0,
      averageBrierScore: null,
      averageLogLoss: null,
      favoriteAccuracyPct: null,
      safety: wnbaRecord().safety,
    },
  };
}

test("classifies future provisional MLB evidence as waiting for FINAL capture", () => {
  const report = buildOperationalIncidentCenter({
    now: new Date("2026-08-03T21:00:00.000Z"),
    mlbRecords: [mlbRecord({
      id: "mlb-1",
      commenceTime: "2026-08-04T00:00:00.000Z",
      stage: "PROVISIONAL",
    })],
  });
  assert.equal(report.schemaVersion, OPERATIONAL_INCIDENT_CENTER_VERSION);
  assert.equal(report.incidents[0]?.state, "WAITING_FOR_FINAL_CAPTURE");
  assert.equal(report.incidents[0]?.worker, "mlb-auto-settlement");
});

test("does not call an active MLB game a failed settlement", () => {
  const report = buildOperationalIncidentCenter({
    now: new Date("2026-08-03T23:00:00.000Z"),
    mlbRecords: [mlbRecord({
      id: "mlb-2",
      commenceTime: "2026-08-03T22:00:00.000Z",
    })],
  });
  assert.equal(report.incidents[0]?.state, "GAME_IN_PROGRESS");
  assert.equal(report.summary.byState.SETTLEMENT_OVERDUE, 0);
});

test("flags overdue settlement and malformed American odds separately", () => {
  const overdue = buildOperationalIncidentCenter({
    now: new Date("2026-08-04T20:00:00.000Z"),
    mlbRecords: [mlbRecord({
      id: "mlb-3",
      commenceTime: "2026-08-03T20:00:00.000Z",
    })],
  });
  assert.equal(overdue.incidents[0]?.state, "SETTLEMENT_OVERDUE");
  assert.equal(overdue.incidents[0]?.severity, "WARNING");

  const malformed = buildOperationalIncidentCenter({
    now: new Date("2026-08-03T21:00:00.000Z"),
    mlbRecords: [mlbRecord({
      id: "mlb-4",
      commenceTime: "2026-08-04T00:00:00.000Z",
      odds: -9,
    })],
  });
  assert.equal(malformed.incidents[0]?.state, "DATA_QUALITY_REVIEW");
  assert.equal(malformed.incidents[0]?.severity, "CRITICAL");
});

test("settled WNBA cycles are hidden by default and available for audit", () => {
  const record = wnbaRecord();
  const settlement: WnbaShadowSettlement = {
    schemaVersion: "wnba-shadow-settlement.v1",
    id: "settle-1",
    predictionId: record.id,
    gameId: record.game.gameId,
    settledAt: "2026-08-04T02:00:00.000Z",
    homeScore: 90,
    awayScore: 88,
    homeOutcome: 1,
    result: "HOME_WIN",
    brierScore: 0.217,
    logLoss: 0.627,
  };
  const hidden = buildOperationalIncidentCenter({
    now: new Date("2026-08-04T03:00:00.000Z"),
    wnbaRecords: [record],
    wnbaSettlements: [settlement],
  });
  assert.equal(hidden.incidents.length, 0);

  const audit = buildOperationalIncidentCenter({
    now: new Date("2026-08-04T03:00:00.000Z"),
    wnbaRecords: [record],
    wnbaSettlements: [settlement],
    includeResolved: true,
  });
  assert.equal(audit.incidents[0]?.state, "RESOLVED");
});

test("manual NBA and NHL history is explicit about limited evidence", () => {
  const pick = {
    id: "p-1",
    ts: Date.parse("2026-08-01T12:00:00.000Z"),
    userId: 1,
    sport: "nba",
    homeTeam: "Miami Heat",
    awayTeam: "Boston Celtics",
    pickType: "ML",
    pickSide: "Miami Heat",
    confidence: 60,
    date: "2026-08-01",
  } as StoredPickV2;
  const report = buildOperationalIncidentCenter({
    now: new Date("2026-08-03T12:00:00.000Z"),
    manualPicks: [pick],
  });
  assert.equal(report.incidents[0]?.league, "NBA");
  assert.equal(report.incidents[0]?.state, "SETTLEMENT_OVERDUE");
  assert.equal(report.incidents[0]?.evidenceConfidence, "LIMITED");
});

test("worker health marks stale WNBA heartbeat and preserves zero-exposure safety", () => {
  const report = buildOperationalIncidentCenter({
    now: new Date("2026-08-03T23:00:00.000Z"),
    wnbaStatus: wnbaStatus("2026-08-03T20:00:00.000Z"),
  });
  const worker = report.workers.find((entry) => entry.id === "wnba-shadow-settlement");
  assert.equal(worker?.state, "STALE");
  assert.deepEqual(report.safety, {
    mode: "OBSERVE_ONLY",
    readOnly: true,
    realFinancialExposure: 0,
    automaticBetPlacement: false,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    historicalLedgerMutation: false,
    automaticSettlementRetry: false,
  });
});
