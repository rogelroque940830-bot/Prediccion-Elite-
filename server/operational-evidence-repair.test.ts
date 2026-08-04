import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activeMlbLedgerRecords, supersessionChainIntegrity } from "./mlb-active-records";
import {
  OperationalEvidenceRepairService,
  type EvidenceRepairDependencies,
  type OfficialMlbEvidence,
} from "./operational-evidence-repair";
import type {
  LedgerPrediction,
  LedgerRecord,
  MlbPredictionInput,
} from "./mlb-ledger-store";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function input(overrides: Partial<MlbPredictionInput> = {}): MlbPredictionInput {
  const base: MlbPredictionInput = {
    schemaVersion: "mlb-ledger.v1",
    clientRequestId: "seed-invalid",
    source: "migration",
    model: {
      name: "CourtEdge MLB",
      version: "test-v1",
      environment: "test",
    },
    game: {
      gamePk: 999001,
      gameDate: "2026-07-31",
      commenceTime: "2026-08-01T01:40:00.000Z",
      homeTeam: "Athletics",
      awayTeam: "Detroit Tigers",
    },
    market: {
      type: "ML",
      selection: "Detroit Tigers",
      oddsAmerican: 1,
      book: "migration",
      capturedAt: "2026-08-01T01:00:00.000Z",
    },
    probabilities: {
      model: 0.55,
      marketImplied: 0.5,
      edgePp: 5,
    },
    decision: {
      signal: "BET",
      confidenceLabel: "MEDIUM",
      confidencePct: 55,
      stakeUnits: 0,
      rationale: "Test record",
    },
    analysis: {
      stage: "FINAL",
      warnings: [],
      sources: [],
      factors: [],
      rawInputs: {},
      rawOutput: {},
    },
  };
  return {
    ...base,
    ...overrides,
    model: { ...base.model, ...(overrides.model ?? {}) },
    game: { ...base.game, ...(overrides.game ?? {}) },
    market: { ...base.market, ...(overrides.market ?? {}) },
    probabilities: { ...base.probabilities, ...(overrides.probabilities ?? {}) },
    decision: { ...base.decision, ...(overrides.decision ?? {}) },
    analysis: { ...base.analysis, ...(overrides.analysis ?? {}) },
  };
}

function prediction(id: string, payload: MlbPredictionInput): LedgerPrediction {
  return {
    id,
    clientRequestId: payload.clientRequestId ?? null,
    recordedAt: "2026-08-01T01:05:00.000Z",
    recordedAtMs: Date.parse("2026-08-01T01:05:00.000Z"),
    game: {
      gamePk: payload.game.gamePk ?? null,
      gameDate: payload.game.gameDate,
      commenceTime: payload.game.commenceTime ?? null,
      homeTeam: payload.game.homeTeam,
      awayTeam: payload.game.awayTeam,
    },
    market: {
      type: payload.market.type,
      selection: payload.market.selection,
      line: payload.market.line ?? null,
      oddsAmerican: payload.market.oddsAmerican,
      book: payload.market.book ?? null,
    },
    probabilities: {
      model: payload.probabilities.model,
      marketImplied: payload.probabilities.marketImplied ?? 0.5,
      noVig: payload.probabilities.noVig ?? null,
      edgePp: payload.probabilities.edgePp ?? 0,
    },
    decision: {
      signal: payload.decision.signal,
      confidenceLabel: payload.decision.confidenceLabel ?? null,
      confidencePct: payload.decision.confidencePct ?? null,
      stakeUnits: payload.decision.stakeUnits,
    },
    analysisStage: payload.analysis.stage,
    model: {
      name: payload.model.name,
      version: payload.model.version,
      gitCommit: payload.model.gitCommit ?? null,
      environment: payload.model.environment ?? null,
    },
    supersedesId: payload.supersedesId ?? null,
    source: payload.source,
    payloadSha256: digest(payload),
    payload,
  };
}

function record(id: string, payload = input()): LedgerRecord {
  return { prediction: prediction(id, payload), settlement: null };
}

const official: OfficialMlbEvidence = {
  gamePk: 999001,
  gameDate: "2026-07-31",
  commenceTime: "2026-08-01T01:40:00.000Z",
  homeTeam: "Athletics",
  awayTeam: "Detroit Tigers",
  final: true,
  detailedState: "Final",
  finalScore: { home: 2, away: 5 },
  inningsDigest: "innings-digest",
  fetchedAt: "2026-08-04T18:00:00.000Z",
  source: "MLB_STATS_API",
};

function incidentReport() {
  return {
    schemaVersion: "courtedge-operational-incident-center.v1",
    generatedAt: "2026-08-04T18:00:00.000Z",
    incidents: [{
      id: "ops-MLB:999001",
      league: "MLB",
      gameId: "999001",
      gameDate: "2026-07-31",
      commenceTime: "2026-08-01T01:40:00.000Z",
      homeTeam: "Athletics",
      awayTeam: "Detroit Tigers",
      state: "DATA_QUALITY_REVIEW",
      severity: "CRITICAL",
      reasonCode: "DATA_QUALITY_BLOCK",
      message: "blocked",
      nextAction: "inspect",
      worker: "mlb-auto-settlement",
      source: "MLB_LEDGER",
      evidenceConfidence: "AUTHORITATIVE",
      lastUpdatedAt: "2026-08-01T01:05:00.000Z",
      ageMinutes: 100,
      details: {},
    }],
    workers: [],
    summary: {},
    coverage: {},
    safety: {},
  } as any;
}

function harness(initial = [record("pred-1")]) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "o31-test-"));
  const records: LedgerRecord[] = [...initial];
  let sequence = 0;
  const deps: EvidenceRepairDependencies = {
    rootDir,
    incidentProvider: async () => incidentReport(),
    recordsProvider: () => records,
    officialEvidenceProvider: async () => official,
    appendSupersedingPrediction: (_owner, raw) => {
      const existing = records.find((entry) => entry.prediction.clientRequestId === raw.clientRequestId);
      if (existing) return { data: existing.prediction, idempotent: true };
      sequence += 1;
      const created = record(`pred-repair-${sequence}`, raw);
      records.push(created);
      return { data: created.prediction, idempotent: false };
    },
    now: () => new Date("2026-08-04T18:00:00.000Z"),
    ttlMs: 10 * 60 * 1000,
  };
  return {
    rootDir,
    records,
    service: new OperationalEvidenceRepairService(deps),
  };
}

const source = {
  sourceName: "Hard Rock Sportsbook screenshot",
  evidenceReference: "operator-upload:detroit-athletics-odds",
  capturedAt: "2026-08-01T01:00:00.000Z",
  note: "The screenshot verifies Detroit Tigers moneyline at American odds -115.",
};

test("active records keep immutable history but select only supersession leaves", () => {
  const original = record("pred-1");
  const repairedPayload = input({
    clientRequestId: "repair-1",
    supersedesId: "pred-1",
    market: { ...input().market, oddsAmerican: -115 },
  });
  const repaired = record("pred-2", repairedPayload);
  assert.deepEqual(activeMlbLedgerRecords([original, repaired]).map((entry) => entry.prediction.id), ["pred-2"]);
  assert.equal(supersessionChainIntegrity([original, repaired]).valid, true);
});

test("inspection identifies invalid American odds and seals official evidence", async () => {
  const { service } = harness();
  const inspection = await service.inspect(1, { incidentId: "ops-MLB:999001" });
  assert.equal(inspection.blockers.length, 0);
  assert.equal(inspection.records.length, 1);
  assert.equal(inspection.records[0].issues[0].code, "INVALID_ODDS_AMERICAN");
  assert.equal(inspection.records[0].issues[0].repairMode, "MANUAL_EVIDENCE_REQUIRED");
  assert.equal(inspection.officialEvidence?.finalScore?.away, 5);
  assert.match(inspection.inspectionDigest, /^[a-f0-9]{64}$/);
});

test("repair plan fails closed when manual odds evidence is missing", async () => {
  const { service } = harness();
  const inspection = await service.inspect(1, { incidentId: "ops-MLB:999001" });
  const plan = service.createPlan(1, {
    inspectionId: inspection.inspectionId,
    inspectionDigest: inspection.inspectionDigest,
    patches: [{ predictionId: "pred-1" }],
    repairSource: source,
  });
  assert.equal(plan.state, "BLOCKED");
  assert.ok(plan.blockers.some((value) => value.startsWith("VALID_AMERICAN_ODDS_REQUIRED")));
});

test("ready plan preserves model decisions and changes only repaired evidence fields", async () => {
  const { service } = harness();
  const inspection = await service.inspect(1, { incidentId: "ops-MLB:999001" });
  const plan = service.createPlan(1, {
    inspectionId: inspection.inspectionId,
    inspectionDigest: inspection.inspectionDigest,
    patches: [{ predictionId: "pred-1", oddsAmerican: -115 }],
    repairSource: source,
  });
  assert.equal(plan.state, "READY");
  assert.equal(plan.targets[0].proposedInput.supersedesId, "pred-1");
  assert.equal(plan.targets[0].proposedInput.market.oddsAmerican, -115);
  assert.equal(plan.targets[0].proposedInput.probabilities.model, 0.55);
  assert.equal(plan.targets[0].proposedInput.decision.signal, "BET");
  assert.deepEqual(plan.targets[0].repairedFields, ["oddsAmerican"]);
});

test("execution appends a verified superseding prediction without mutating original", async () => {
  const { service, records } = harness();
  const originalHash = records[0].prediction.payloadSha256;
  const inspection = await service.inspect(1, { incidentId: "ops-MLB:999001" });
  const plan = service.createPlan(1, {
    inspectionId: inspection.inspectionId,
    inspectionDigest: inspection.inspectionDigest,
    patches: [{ predictionId: "pred-1", oddsAmerican: -115 }],
    repairSource: source,
  });
  const execution = service.execute(1, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    idempotencyKey: "repair-detroit-athletics-1",
    confirmation: "APPEND_SUPERSEDING_MLB_EVIDENCE",
    reason: "Repair invalid migrated odds using reviewed sportsbook evidence.",
  });
  assert.equal(execution.state, "COMPLETED");
  assert.equal(execution.appended, 1);
  assert.equal(execution.verified, 1);
  assert.equal(records[0].prediction.payloadSha256, originalHash);
  assert.equal(records[1].prediction.supersedesId, "pred-1");
  assert.equal(records[1].prediction.market.oddsAmerican, -115);
  assert.deepEqual(activeMlbLedgerRecords(records).map((entry) => entry.prediction.id), ["pred-repair-1"]);
  assert.ok(service.audit(1).some((event) => event.eventType === "SUPERSEDING_PREDICTION_APPENDED"));
});

test("execution is idempotent and rejects idempotency key drift", async () => {
  const { service } = harness();
  const inspection = await service.inspect(1, { incidentId: "ops-MLB:999001" });
  const plan = service.createPlan(1, {
    inspectionId: inspection.inspectionId,
    inspectionDigest: inspection.inspectionDigest,
    patches: [{ predictionId: "pred-1", oddsAmerican: -115 }],
    repairSource: source,
  });
  const request = {
    planId: plan.planId,
    planDigest: plan.planDigest,
    idempotencyKey: "repair-idempotent-1",
    confirmation: "APPEND_SUPERSEDING_MLB_EVIDENCE",
    reason: "Repair invalid migrated odds using reviewed sportsbook evidence.",
  };
  const first = service.execute(1, request);
  const replay = service.execute(1, request);
  assert.equal(first.state, "COMPLETED");
  assert.equal(replay.state, "IDEMPOTENT_REPLAY");
  assert.throws(() => service.execute(1, { ...request, reason: "Different evidence reason for the same key." }), /idempotency key/i);
});

test("status exposes conservative safety gates", () => {
  const { service } = harness();
  const status = service.status(1);
  assert.equal(status.safety.mode, "SHADOW_EVIDENCE_REPAIR");
  assert.equal(status.safety.realFinancialExposure, 0);
  assert.equal(status.safety.automaticRepair, false);
  assert.equal(status.safety.historicalLedgerMutation, false);
  assert.equal(status.safety.settlementExecution, false);
  assert.equal(status.confirmationPhrase, "APPEND_SUPERSEDING_MLB_EVIDENCE");
});
