import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import { MlbS5dGateMonitorService } from "./mlb-s5d-gate-monitor";

type FixtureOptions = {
  probability?: number;
  marketImplied?: number | null;
  result?: "WIN" | "LOSS" | "PUSH" | null;
  clvPp?: number | null;
  stage?: "PROVISIONAL" | "FINAL";
};

function fixture(index: number, options: FixtureOptions = {}): LedgerRecord {
  const probability = options.probability ?? 0.58;
  const marketImplied = options.marketImplied === undefined ? 0.5238 : options.marketImplied;
  const result = options.result === undefined ? (index % 5 < 3 ? "WIN" : "LOSS") : options.result;
  const stage = options.stage ?? "FINAL";
  const recordedAt = `2026-07-${String(1 + (index % 27)).padStart(2, "0")}T12:00:00.000Z`;
  const id = `s5d-${index}`;
  return {
    prediction: {
      id,
      clientRequestId: `s5d-request-${index}`,
      recordedAt,
      recordedAtMs: Date.parse(recordedAt),
      game: {
        gamePk: 950_000 + index,
        gameDate: recordedAt.slice(0, 10),
        commenceTime: `${recordedAt.slice(0, 10)}T23:00:00.000Z`,
        homeTeam: `Home ${index}`,
        awayTeam: `Away ${index}`,
      },
      market: {
        type: "F5_ML",
        selection: `Home ${index}`,
        line: null,
        oddsAmerican: -110,
        book: "Verified Consensus",
      },
      probabilities: {
        model: probability,
        marketImplied,
        noVig: marketImplied,
        edgePp: marketImplied == null ? null : (probability - marketImplied) * 100,
      },
      decision: {
        signal: "BET",
        confidenceLabel: "PREMIUM",
        confidencePct: probability * 100,
        stakeUnits: 0,
      },
      analysisStage: stage,
      model: {
        name: "CourtEdge MLB",
        version: "s5d-fixture-v1",
        gitCommit: "87b71ccecd586f4fd66d5e7573de3c7be9b1bc97",
        environment: "test",
      },
      supersedesId: null,
      source: "app",
      payloadSha256: `prediction-sha-${index}`,
      payload: {
        model: {
          name: "CourtEdge MLB",
          version: "s5d-fixture-v1",
          gitCommit: "87b71ccecd586f4fd66d5e7573de3c7be9b1bc97",
          environment: "test",
        },
        game: {
          gamePk: 950_000 + index,
          gameDate: recordedAt.slice(0, 10),
          commenceTime: `${recordedAt.slice(0, 10)}T23:00:00.000Z`,
          homeTeam: `Home ${index}`,
          awayTeam: `Away ${index}`,
        },
        market: {
          type: "F5_ML",
          selection: `Home ${index}`,
          oddsAmerican: -110,
          book: "Verified Consensus",
          capturedAt: recordedAt,
        },
        probabilities: { model: probability, marketImplied },
        decision: { signal: "BET", confidenceLabel: "PREMIUM", stakeUnits: 0 },
        analysis: {
          stage,
          warnings: [],
          factors: [{ name: "fixture", direction: "NEUTRAL", magnitude: index }],
          sources: [{ name: "fixture-source", status: "VERIFIED", fetchedAt: recordedAt }],
          layers: {},
          rawOutput: { filterReasons: [] },
        },
      },
    },
    settlement: result ? {
      eventId: `settlement-${index}`,
      predictionId: id,
      clientRequestId: `settlement-request-${index}`,
      recordedAt: `${recordedAt.slice(0, 10)}T23:59:00.000Z`,
      recordedAtMs: Date.parse(`${recordedAt.slice(0, 10)}T23:59:00.000Z`),
      settledAt: `${recordedAt.slice(0, 10)}T23:59:00.000Z`,
      result,
      closingOddsAmerican: -105,
      closingLine: null,
      closingImpliedProbability: 0.5122,
      clvPp: options.clvPp === undefined ? 0.6 : options.clvPp,
      outcomeValue: result === "WIN" ? 1 : result === "LOSS" ? 0 : 0.5,
      finalScore: { home: 5, away: 3 },
      profitUnits: 0,
      source: "official",
      correctionOfEventId: null,
      notes: null,
      payloadSha256: `settlement-sha-${index}`,
      payload: {},
    } : null,
  } as LedgerRecord;
}

class FakeStore {
  constructor(public records: LedgerRecord[]) {}

  listRecords(): LedgerRecord[] {
    return this.records;
  }

  status() {
    return {
      schemaVersion: "mlb-ledger.v1",
      predictions: this.records.length,
      settlementEvents: this.records.filter((record) => record.settlement != null).length,
      immutable: true,
    };
  }
}

test("S5D persists EXTEND progress and deduplicates unchanged evaluations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s5d-gate-extend-"));
  const fake = new FakeStore([
    fixture(1, { result: "WIN" }),
    fixture(2, { result: "LOSS", marketImplied: null, stage: "PROVISIONAL", clvPp: null }),
  ]);
  const times = [
    new Date("2026-07-30T19:20:00.000Z"),
    new Date("2026-07-30T19:30:00.000Z"),
  ];
  let index = 0;
  const service = new MlbS5dGateMonitorService(fake as unknown as MlbLedgerStore, {
    root,
    enabled: true,
    environment: "p0-integration",
    deploymentCommit: "test-commit",
    now: () => times[Math.min(index++, times.length - 1)],
  });
  try {
    const first = service.collect("test-first");
    assert.equal(first.gate.status, "EXTEND");
    assert.equal(first.progress.settled.current, 2);
    assert.equal(first.progress.settled.minimum, 30);
    assert.equal(first.progress.settled.remaining, 28);
    assert.equal(first.transitionRecorded, true);
    assert.equal(first.reviewPackageCreated, false);
    assert.equal(first.humanReview.required, false);
    assert.equal(first.safety.automaticPromotion, false);

    const second = service.collect("test-repeat");
    assert.equal(second.changed, false);
    assert.equal(second.snapshotCreated, false);
    assert.equal(second.transitionRecorded, false);
    assert.equal(service.status().snapshots, 1);
    assert.equal(service.status().transitions, 1);
    assert.equal(service.status().reviewPackages, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("S5D creates human review packages for GO_REVIEW and NO_GO transitions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s5d-gate-review-"));
  const fake = new FakeStore([fixture(10, { result: "WIN" })]);
  const times = [
    new Date("2026-07-30T20:00:00.000Z"),
    new Date("2026-07-31T20:00:00.000Z"),
    new Date("2026-08-01T20:00:00.000Z"),
  ];
  let index = 0;
  const service = new MlbS5dGateMonitorService(fake as unknown as MlbLedgerStore, {
    root,
    enabled: true,
    environment: "p0-integration",
    deploymentCommit: "test-commit",
    now: () => times[Math.min(index++, times.length - 1)],
  });
  try {
    assert.equal(service.collect("initial").gate.status, "EXTEND");

    fake.records = Array.from({ length: 30 }, (_, row) => fixture(100 + row, {
      result: row % 5 < 3 ? "WIN" : "LOSS",
      probability: 0.58,
      marketImplied: 0.5238,
      clvPp: 0.6,
      stage: "FINAL",
    }));
    const goReview = service.collect("mature-positive");
    assert.equal(goReview.gate.status, "GO_REVIEW");
    assert.equal(goReview.progress.settled.met, true);
    assert.equal(goReview.progress.marketImpliedCoverage.met, true);
    assert.equal(goReview.progress.closingCoverage.met, true);
    assert.equal(goReview.progress.finalSnapshotCoverage.met, true);
    assert.equal(goReview.humanReview.required, true);
    assert.equal(goReview.humanReview.automaticPromotion, false);
    assert.equal(goReview.reviewPackageCreated, true);
    assert.ok(goReview.humanReview.packagePath);
    assert.equal(fs.existsSync(goReview.humanReview.packagePath as string), true);

    fake.records = Array.from({ length: 30 }, (_, row) => fixture(200 + row, {
      result: "LOSS",
      probability: 0.8,
      marketImplied: 0.55,
      clvPp: -2,
      stage: "FINAL",
    }));
    const noGo = service.collect("mature-negative");
    assert.equal(noGo.gate.status, "NO_GO");
    assert.equal(noGo.humanReview.required, true);
    assert.equal(noGo.reviewPackageCreated, true);
    assert.equal(noGo.safety.realFinancialExposure, 0);
    assert.equal(noGo.safety.automaticBetPlacement, false);
    assert.equal(noGo.safety.automaticPromotion, false);

    const transitions = service.readTransitions();
    assert.deepEqual(transitions.map((transition) => transition.toStatus), ["NO_GO", "GO_REVIEW", "EXTEND"]);
    assert.equal(service.status().transitions, 3);
    assert.equal(service.status().reviewPackages, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
