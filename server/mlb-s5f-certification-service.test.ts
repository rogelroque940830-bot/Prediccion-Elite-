import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MlbLedgerStore, type MlbPredictionInput } from "./mlb-ledger-store";
import { MlbLedgerOwnershipStore } from "./mlb-ledger-ownership-store";
import { MlbS5dGateMonitorService } from "./mlb-s5d-gate-monitor";
import type { MlbS5eCoverageService } from "./mlb-s5e-coverage-service";
import { MlbS5fCertificationService } from "./mlb-s5f-certification-service";

function prediction(
  clientRequestId: string,
  options: {
    gamePk?: number;
    homeTeam?: string;
    awayTeam?: string;
    stage?: "PROVISIONAL" | "FINAL";
    commenceTime?: string;
    supersedesId?: string;
    odds?: number;
    lineupHome?: number;
    lineupAway?: number;
  } = {},
): MlbPredictionInput {
  const gamePk = options.gamePk ?? 990001;
  const homeTeam = options.homeTeam ?? "Miami Marlins";
  const awayTeam = options.awayTeam ?? "Philadelphia Phillies";
  const stage = options.stage ?? "FINAL";
  return {
    schemaVersion: "mlb-ledger.v1",
    clientRequestId,
    source: "app",
    ...(options.supersedesId ? { supersedesId: options.supersedesId } : {}),
    model: {
      name: "CourtEdge MLB Early Markets",
      version: "s5c-shadow-v1",
      gitCommit: "s5f-test-commit",
      environment: "p0-integration",
    },
    game: {
      gamePk,
      gameDate: "2026-07-30",
      commenceTime: options.commenceTime ?? "2026-07-30T21:00:00.000Z",
      homeTeam,
      awayTeam,
      venue: "Fixture Park",
    },
    market: {
      type: "F5_ML",
      selection: homeTeam,
      oddsAmerican: options.odds ?? -110,
      book: "draftkings, fanduel, betmgm",
      capturedAt: "2026-07-30T18:00:00.000Z",
    },
    probabilities: {
      model: 0.61,
      marketImplied: 0.52381,
      edgePp: 8.619,
    },
    decision: {
      signal: "BET",
      confidenceLabel: "PREMIUM",
      confidencePct: 61,
      stakeUnits: 0,
      rationale: "fixture",
    },
    analysis: {
      stage,
      warnings: [],
      sources: [{ name: "fixture", status: "VERIFIED", fetchedAt: "2026-07-30T18:00:00.000Z" }],
      layers: {
        s5c: {
          lineupCounts: {
            home: options.lineupHome ?? (stage === "FINAL" ? 9 : 0),
            away: options.lineupAway ?? (stage === "FINAL" ? 9 : 0),
          },
        },
      },
    },
  };
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s5f-certification-"));
  const dbPath = path.join(root, "ledger.sqlite");
  const store = new MlbLedgerStore(dbPath);
  const ownership = new MlbLedgerOwnershipStore(dbPath);
  const ownerUserId = 1;
  const save = (input: MlbPredictionInput) => {
    const result = store.appendPrediction(input);
    ownership.bind(result.data.id, result.data.clientRequestId, ownerUserId, "service");
    return result.data;
  };
  const s5e = {
    readLatest: () => null,
    readObservations: () => [],
    status: () => ({ observationCount: 0 }),
  } as unknown as MlbS5eCoverageService;
  return { root, store, ownership, ownerUserId, save, s5e };
}

test("S5F represents a PROVISIONAL to FINAL chain once and prepares the aggregate review package", () => {
  const fixture = setup();
  const provisional = fixture.save(prediction("s5f-provisional", {
    stage: "PROVISIONAL",
    odds: -105,
  }));
  const final = fixture.save(prediction("s5f-final", {
    stage: "FINAL",
    supersedesId: provisional.id,
    odds: -110,
  }));
  fixture.store.appendSettlement(final.id, {
    clientRequestId: "s5f-official-settlement",
    settledAt: "2026-07-31T01:00:00.000Z",
    result: "WIN",
    closingOddsAmerican: -120,
    outcomeValue: 1,
    finalScore: { home: 4, away: 2 },
    source: "official",
    notes: "fixture settlement",
  });

  const s5d = new MlbS5dGateMonitorService(fixture.store, {
    enabled: true,
    root: path.join(fixture.root, "s5d"),
    now: () => new Date("2026-07-31T02:00:00.000Z"),
  });
  s5d.collect("fixture");
  const service = new MlbS5fCertificationService(
    fixture.store,
    fixture.ownership,
    fixture.s5e,
    s5d,
    {
      enabled: true,
      ownerUserId: fixture.ownerUserId,
      root: path.join(fixture.root, "s5f"),
      now: () => new Date("2026-07-31T02:00:00.000Z"),
    },
  );

  const result = service.collect("test-lineage");
  assert.equal(result.dashboard.rows.length, 1);
  assert.equal(result.source.predictions, 2);
  assert.equal(result.source.terminalPredictions, 1);
  assert.equal(result.source.supersededPredictions, 1);
  const row = result.dashboard.rows[0];
  assert.equal(row.terminalPredictionId, final.id);
  assert.equal(row.chain.length, 2);
  assert.deepEqual(row.chain.stages.map((stage) => stage.analysisStage), ["PROVISIONAL", "FINAL"]);
  assert.equal(row.originOpening.predictionId, provisional.id);
  assert.equal(row.originOpening.oddsAmerican, -105);
  assert.equal(row.analyticalOpening.predictionId, final.id);
  assert.equal(row.finalization.state, "FINAL_CAPTURED");
  assert.equal(row.closing.state, "COMPARABLE_CAPTURED");
  assert.equal(row.settlement.state, "SETTLED");
  assert.equal(row.readiness, "READY");
  assert.equal(result.reviewPackage.partial, true);
  assert.equal(result.reviewPackage.gate.status, "EXTEND");
  assert.equal(result.reviewPackage.evidenceReadiness.terminalPredictions, 1);
  assert.equal(result.reviewPackage.evidenceReadiness.ready, 1);
  assert.ok(result.reviewPackage.breakdowns);
  assert.ok(result.reviewPackage.dataQuality);
  assert.ok(result.reviewPackage.deduplication);
  assert.equal(result.reviewPackage.s5dConsistency.gateStatusMatches, true);
  assert.equal(result.safety.realFinancialExposure, 0);
  assert.equal(result.safety.automaticPromotion, false);

  fixture.ownership.close();
  fixture.store.close();
});

test("S5F separates natural pending evidence from actionable missed coverage and overdue settlement", () => {
  const fixture = setup();
  fixture.save(prediction("s5f-future-provisional", {
    gamePk: 990002,
    homeTeam: "Boston Red Sox",
    awayTeam: "New York Yankees",
    stage: "PROVISIONAL",
    commenceTime: "2026-07-30T23:00:00.000Z",
  }));
  fixture.save(prediction("s5f-past-provisional", {
    gamePk: 990003,
    homeTeam: "Chicago Cubs",
    awayTeam: "St. Louis Cardinals",
    stage: "PROVISIONAL",
    commenceTime: "2026-07-30T10:00:00.000Z",
  }));

  const s5d = new MlbS5dGateMonitorService(fixture.store, {
    enabled: true,
    root: path.join(fixture.root, "s5d"),
    now: () => new Date("2026-07-30T20:00:00.000Z"),
  });
  s5d.collect("fixture");
  const service = new MlbS5fCertificationService(
    fixture.store,
    fixture.ownership,
    fixture.s5e,
    s5d,
    {
      enabled: true,
      ownerUserId: fixture.ownerUserId,
      root: path.join(fixture.root, "s5f"),
      now: () => new Date("2026-07-30T20:00:00.000Z"),
    },
  );

  const first = service.collect("test-alerts");
  assert.equal(first.dashboard.rows.length, 2);
  const future = first.dashboard.rows.find((row) => row.game.gamePk === 990002)!;
  const past = first.dashboard.rows.find((row) => row.game.gamePk === 990003)!;
  assert.equal(future.finalization.state, "PROVISIONAL_PENDING");
  assert.equal(future.closing.state, "PENDING_OUTSIDE_WINDOW");
  assert.equal(future.settlement.state, "PENDING_NATURAL");
  assert.equal(future.readiness, "PENDING");
  assert.equal(past.finalization.state, "FINAL_MISSED_AFTER_START");
  assert.equal(past.closing.state, "MISSED_AFTER_START");
  assert.equal(past.settlement.state, "OVERDUE");
  assert.equal(past.readiness, "ACTION_REQUIRED");
  assert.ok(first.alerts.some((item) => item.code === "FINAL_PENDING_LINEUPS" && !item.actionable));
  assert.ok(first.alerts.some((item) => item.code === "CLOSING_PENDING_WINDOW" && !item.actionable));
  assert.ok(first.alerts.some((item) => item.code === "FINAL_MISSED_AFTER_START" && item.actionable));
  assert.ok(first.alerts.some((item) => item.code === "SETTLEMENT_OVERDUE" && item.severity === "CRITICAL"));
  assert.equal(new Set(first.alerts.map((item) => item.alertId)).size, first.alerts.length);
  assert.equal(first.reviewPackage.evidenceReadiness.pending, 1);
  assert.equal(first.reviewPackage.evidenceReadiness.actionRequired, 1);

  const second = service.collect("test-alerts-repeat");
  assert.equal(second.changed, false);
  assert.equal(second.snapshotCreated, false);
  assert.equal(service.status().snapshots, 1);

  fixture.ownership.close();
  fixture.store.close();
});
