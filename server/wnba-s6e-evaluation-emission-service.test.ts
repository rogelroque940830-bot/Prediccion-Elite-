import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WnbaEvaluationCaptureError,
  WnbaEvaluationEmissionService,
  parseWnbaEvaluationEnvelope,
} from "./wnba-s6e-evaluation-emission-service";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "s6e-wnba-"));
}

function sampleEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "wnba-evaluation-emission.v1",
    evaluationId: "eval-wnba-001",
    evaluatedAt: "2026-07-31T15:30:00.000Z",
    gameDate: "2026-07-31",
    homeTeam: "New York Liberty",
    awayTeam: "Las Vegas Aces",
    gameId: "game-1",
    source: "WNBA_PREDICTOR_UI",
    captureVersion: "s6e-ui.v1",
    model: {
      homeInput: { netRtg: 7.2, pace: 98.1 },
      awayInput: { netRtg: 4.8, pace: 97.4 },
      marketImpliedHomeProbability: 0.56,
      homeProbability: 0.61,
      awayProbability: 0.39,
      estimatedTotal: 166.4,
    },
    markets: [
      {
        market: "ML",
        selection: "New York Liberty ML",
        selectedTeam: "New York Liberty",
        opponent: "Las Vegas Aces",
        modelProbability: 0.61,
        marketImpliedProbability: 0.56,
        oddsAmerican: -127,
        line: null,
        signal: "BET",
        recommendation: "BET",
        accepted: true,
        confidencePct: 61,
        edgePp: 5,
        quality: { score: 7, tier: "A", shadowStakeUnits: 2.1, warnings: [], confirms: ["edge"], reasoning: "Exact existing output" },
      },
      {
        market: "SPREAD",
        selection: "New York Liberty -3.5",
        selectedTeam: "New York Liberty",
        opponent: "Las Vegas Aces",
        modelProbability: 0.64,
        marketImpliedProbability: 0.52381,
        oddsAmerican: -110,
        line: -3.5,
        signal: "BET",
        recommendation: "BET",
        accepted: true,
        confidencePct: 64,
        edgePp: 11.6,
        quality: { score: 8, tier: "S", shadowStakeUnits: 3, warnings: [], confirms: ["margin"], reasoning: "Exact existing output" },
      },
      {
        market: "TOTAL",
        selection: "OVER 164.5",
        selectedTeam: null,
        opponent: null,
        modelProbability: 0.6357,
        marketImpliedProbability: 0.52381,
        oddsAmerican: -110,
        line: 164.5,
        signal: "LEAN",
        recommendation: "LEAN",
        accepted: true,
        confidencePct: 63.57,
        edgePp: 11.2,
        quality: { score: 6, tier: "B", shadowStakeUnits: 1, warnings: [], confirms: [], reasoning: "Exact existing output" },
      },
    ],
    bestPlay: {
      market: "SPREAD",
      recommendation: "New York Liberty -3.5",
      signal: "BET",
      confidencePct: 64,
      edgeLabel: "Margen 5.1 pts",
    },
    visibleMarket: {
      homeMoneyline: -127,
      awayMoneyline: 108,
      spreadLine: -3.5,
      homeSpreadOdds: -110,
      awaySpreadOdds: -110,
      totalLine: 164.5,
      overOdds: -110,
      underOdds: -110,
    },
    ...overrides,
  };
}

test("S6E validates the three exact market outputs", () => {
  const parsed = parseWnbaEvaluationEnvelope(sampleEnvelope());
  assert.equal(parsed.markets.length, 3);
  assert.deepEqual(parsed.markets.map((row) => row.market), ["ML", "SPREAD", "TOTAL"]);
  assert.equal(parsed.model.homeProbability, 0.61);
  assert.equal(parsed.markets[2].modelProbability, 0.6357);
});

test("S6E appends one immutable envelope, three outputs and a S6D-compatible projection", () => {
  const root = tempRoot();
  const canonicalPicksPath = path.join(root, "canonical-picks.json");
  fs.writeFileSync(canonicalPicksPath, JSON.stringify([
    { id: "existing-wnba", sport: "wnba", ts: 1, homeTeam: "A", awayTeam: "B" },
    { id: "existing-mlb", sport: "mlb", ts: 2 },
  ]));
  const service = new WnbaEvaluationEmissionService({
    enabled: true,
    root: path.join(root, "emission"),
    canonicalPicksPath,
    now: () => new Date("2026-07-31T15:31:00.000Z"),
  });
  service.initialize();
  const captured = service.capture(sampleEnvelope());
  assert.equal(captured.idempotent, false);
  assert.equal(captured.outputsCreated, 3);
  assert.equal(service.readEvaluations().length, 1);
  assert.equal(service.readOutputs().length, 3);
  const projection = JSON.parse(fs.readFileSync(service.getProjectionPath(), "utf8"));
  assert.equal(projection.length, 4);
  const ml = projection.find((row: any) => row.id === "s6e-eval-wnba-001-ml");
  assert.equal(ml.modelProbability, 0.61);
  assert.equal(ml.accepted, true);
  assert.equal(ml.stake, 0);
  assert.equal(ml.source, "s6e-direct-evaluation");
  assert.equal(projection.some((row: any) => row.sport === "mlb"), false);
});

test("S6E retries are idempotent and conflicting reuse of an evaluationId is rejected", () => {
  const root = tempRoot();
  const service = new WnbaEvaluationEmissionService({ enabled: true, root, canonicalPicksPath: path.join(root, "none.json") });
  service.initialize();
  service.capture(sampleEnvelope());
  const retry = service.capture(sampleEnvelope());
  assert.equal(retry.idempotent, true);
  assert.equal(service.readEvaluations().length, 1);
  assert.equal(service.readOutputs().length, 3);
  const conflicting = sampleEnvelope({
    model: {
      ...(sampleEnvelope().model as Record<string, unknown>),
      homeProbability: 0.62,
      awayProbability: 0.38,
    },
  });
  assert.throws(
    () => service.capture(conflicting),
    (error: unknown) => error instanceof WnbaEvaluationCaptureError && error.status === 409,
  );
});

test("S6E verification evidence is segregated from scientific outputs and projection", () => {
  const root = tempRoot();
  const service = new WnbaEvaluationEmissionService({ enabled: true, root, canonicalPicksPath: path.join(root, "none.json") });
  service.initialize();
  const result = service.capture(sampleEnvelope({ evaluationId: "verify-1", verification: true }));
  assert.equal(result.verification, true);
  assert.equal(result.outputsCreated, 0);
  assert.equal(service.readEvaluations().length, 0);
  assert.equal(service.readVerificationEvaluations().length, 1);
  assert.equal(service.readOutputs().length, 0);
  assert.equal(JSON.parse(fs.readFileSync(service.getProjectionPath(), "utf8")).length, 0);
});

test("S6E rejects partial market evidence instead of inventing a missing output", () => {
  const partial = sampleEnvelope();
  partial.markets = (partial.markets as unknown[]).slice(0, 2);
  assert.throws(() => parseWnbaEvaluationEnvelope(partial), /exactly three market outputs/);
});
