import assert from "node:assert/strict";
import test from "node:test";
import { buildMlbLedgerHistoryView } from "./mlb-ledger-history-view";

function record({
  id,
  recordedAtMs,
  marketType,
  selection,
  odds,
  stake,
  result,
  profitUnits,
}: {
  id: string;
  recordedAtMs: number;
  marketType: string;
  selection: string;
  odds: number;
  stake: number;
  result?: string;
  profitUnits?: number;
}) {
  return {
    prediction: {
      id,
      clientRequestId: `request-${id}`,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: {
        gamePk: 123,
        gameDate: "2026-07-28",
        commenceTime: "2026-07-28T23:10:00.000Z",
        homeTeam: "Detroit Tigers",
        awayTeam: "Baltimore Orioles",
      },
      market: {
        type: marketType,
        selection,
        line: null,
        oddsAmerican: odds,
        book: "Hard Rock",
      },
      probabilities: {
        model: 0.61,
        marketImplied: 0.56,
        noVig: 0.55,
        edgePp: 6,
      },
      decision: {
        signal: "BET",
        confidenceLabel: "A",
        confidencePct: 61,
        stakeUnits: stake,
      },
      analysisStage: "FINAL",
      model: { name: "CourtEdge MLB", version: "predictor-full-snapshot-v2" },
      source: "app",
      payloadSha256: `sha-${id}`,
      payload: {
        analysis: {
          injuryAudit: { schemaVersion: "mlb-injury-audit.v1" },
        },
      },
    },
    settlement: result ? {
      eventId: `event-${id}`,
      predictionId: id,
      recordedAt: new Date(recordedAtMs + 1000).toISOString(),
      recordedAtMs: recordedAtMs + 1000,
      settledAt: new Date(recordedAtMs + 1000).toISOString(),
      result,
      closingOddsAmerican: null,
      closingLine: null,
      closingImpliedProbability: null,
      clvPp: null,
      outcomeValue: null,
      finalScore: { home: 5, away: 3 },
      profitUnits: profitUnits ?? 0,
      source: "official",
      payloadSha256: `settlement-sha-${id}`,
      payload: {},
    } : null,
  } as any;
}

test("builds ledger-backed history summary and keeps pending picks", () => {
  const view = buildMlbLedgerHistoryView([
    record({ id: "old-loss", recordedAtMs: 1000, marketType: "ML", selection: "Seattle Mariners ML", odds: -140, stake: 1, result: "LOSS", profitUnits: -1 }),
    record({ id: "new-pending", recordedAtMs: 3000, marketType: "F5_ML", selection: "Detroit Tigers F5 ML", odds: -115, stake: 1 }),
    record({ id: "middle-win", recordedAtMs: 2000, marketType: "TOTAL", selection: "Under 8.5", odds: 110, stake: 1, result: "WIN", profitUnits: 1.1 }),
  ]);

  assert.equal(view.schemaVersion, "mlb-ledger-history-view.v1");
  assert.equal(view.source, "immutable-ledger");
  assert.deepEqual(view.summary, {
    total: 3,
    pending: 1,
    settled: 2,
    wins: 1,
    losses: 1,
    pushes: 0,
    voids: 0,
    winRatePct: 50,
    totalProfitUnits: 0.1,
    totalStakedUnits: 2,
    roiPct: 5,
  });
  assert.equal(view.picks[0].id, "new-pending");
  assert.equal(view.picks[0].result, "PENDING");
  assert.equal(view.picks[0].immutable, true);
  assert.equal(view.picks[1].result, "W");
  assert.equal(view.picks[2].result, "L");
});

test("excludes pushes and voids from ROI denominator", () => {
  const view = buildMlbLedgerHistoryView([
    record({ id: "push", recordedAtMs: 1000, marketType: "TOTAL", selection: "Over 8", odds: -110, stake: 2, result: "PUSH", profitUnits: 0 }),
    record({ id: "void", recordedAtMs: 2000, marketType: "ML", selection: "Detroit Tigers ML", odds: -120, stake: 3, result: "VOID", profitUnits: 0 }),
  ]);

  assert.equal(view.summary.settled, 2);
  assert.equal(view.summary.pushes, 1);
  assert.equal(view.summary.voids, 1);
  assert.equal(view.summary.totalStakedUnits, 0);
  assert.equal(view.summary.roiPct, 0);
});

test("marks equivalent C1 ledger records as analytical duplicates without removing them", () => {
  const first = record({ id: "first", recordedAtMs: 1000, marketType: "ML", selection: "Detroit Tigers ML", odds: -140, stake: 1, result: "WIN", profitUnits: 0.7143 });
  const duplicate = record({ id: "duplicate", recordedAtMs: 2000, marketType: "ML", selection: "Detroit Tigers ML", odds: -140, stake: 1, result: "WIN", profitUnits: 0.7143 });
  const view = buildMlbLedgerHistoryView([first, duplicate]);
  assert.equal(view.summary.total, 2);
  assert.equal(view.analyticalCalibration.auditedLedgerRecords, 2);
  assert.equal(view.analyticalCalibration.uniqueDecisions, 1);
  assert.equal(view.analyticalCalibration.duplicatesExcluded, 1);
  const duplicatePick = view.picks.find((pick) => pick.id === "duplicate");
  assert.equal(duplicatePick?.analyticalDuplicate, true);
  assert.equal(duplicatePick?.analyticalDuplicateOfPredictionId, "first");
});

test("exposes compact price provenance without expanding raw quote arrays", () => {
  const priced = record({
    id: "priced-v2",
    recordedAtMs: 4000,
    marketType: "F5_TOTAL",
    selection: "OVER 4.5",
    odds: -110,
    stake: 0,
  });
  priced.prediction.payload.market = {
    type: "F5_TOTAL",
    selection: "OVER 4.5",
    line: 4.5,
    oddsAmerican: -110,
    book: "fanduel, draftkings",
    capturedAt: "2026-07-28T20:00:00.000Z",
  };
  priced.prediction.payload.analysis.rawInputs = {
    priceCapture: {
      capturedAt: "2026-07-28T20:00:00.000Z",
      providerLastUpdate: "2026-07-28T19:59:00.000Z",
      consensusMethod: "median_implied_probability",
    },
    marketProvenance: {
      contributingBooks: ["fanduel", "draftkings"],
      rawQuotes: { f5Total: [{ bookKey: "fanduel", price: -110 }] },
    },
  };
  priced.prediction.payload.analysis.layers = {
    marketPriceIntegrity: { standardAmericanOddsValidated: true },
  };

  const view = buildMlbLedgerHistoryView([priced]);
  const pick = view.picks[0];
  assert.equal(pick.priceCapturedAt, "2026-07-28T20:00:00.000Z");
  assert.equal(pick.providerLastUpdate, "2026-07-28T19:59:00.000Z");
  assert.equal(pick.consensusMethod, "median_implied_probability");
  assert.deepEqual(pick.priceContributingBooks, ["fanduel", "draftkings"]);
  assert.equal(pick.standardAmericanOddsValidated, true);
  assert.equal("rawQuotes" in pick, false);
});

test("exposes only compact P1-M4 effective actionability fields", () => {
  const actionable = record({
    id: "actionable-p1m4",
    recordedAtMs: 5000,
    marketType: "ML",
    selection: "Detroit Tigers",
    odds: -118,
    stake: 0,
  });
  actionable.prediction.payload.analysis.layers = {
    p1M4bEconomicDecision: {
      schemaVersion: "courtedge-p1-m4b-economic-decision-adapter.v1",
      status: "ADAPTED",
      source: { sourceSignal: "BET_FUERTE" },
      effectiveDecision: {
        decision: "BET",
        actionability: "ACTIONABLE_FINAL",
        analyticalUnits: 0.625,
        reasons: ["POSITIVE_EXPECTED_VALUE", "PRICE_ACCEPTABLE"],
      },
      economicDecision: { internalDiagnostics: { shouldNotLeak: true } },
    },
  };

  const view = buildMlbLedgerHistoryView([actionable]);
  const pick = view.picks[0];
  assert.equal(pick.economicLayerSchemaVersion, "courtedge-p1-m4b-economic-decision-adapter.v1");
  assert.equal(pick.economicLayerStatus, "ADAPTED");
  assert.equal(pick.economicSourceSignal, "BET_FUERTE");
  assert.equal(pick.economicEffectiveDecision, "BET");
  assert.equal(pick.economicActionability, "ACTIONABLE_FINAL");
  assert.equal(pick.economicAnalyticalUnits, 0.625);
  assert.deepEqual(pick.economicReasons, ["POSITIVE_EXPECTED_VALUE", "PRICE_ACCEPTABLE"]);
  assert.equal("economicDecision" in pick, false);
  assert.equal("internalDiagnostics" in pick, false);
});
