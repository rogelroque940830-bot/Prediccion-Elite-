import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { MlbLedgerStore } from "./mlb-ledger-store";
import {
  MlbLedgerOwnershipStore,
  ownedRecordsForUser,
} from "./mlb-ledger-ownership-store";
import {
  MLB_P1_M3A_READINESS_CONTRACT_SCHEMA,
  MLB_P1_M3A_READINESS_RUNTIME_SCHEMA,
  MLB_P1_M3A_SCHEMA,
  MLB_P1_M3A_SNAPSHOT_SCHEMA,
  mlbP1M3aSha256,
  type MlbP1M3aCaptureCandidate,
  type MlbP1M3aStage,
} from "./mlb-p1-scientific-capture-contract";
import {
  MLB_P1_M3B_ENDPOINT,
  MLB_P1_M3B_SCHEMA,
  MlbP1M3bCaptureError,
  MlbP1ScientificCaptureService,
} from "./mlb-p1-scientific-capture-service";
import { requireInteractiveMlbCaptureSession } from "./mlb-p1-scientific-capture-routes";

const GAME_PK = 824999;

function implied(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function makeCandidate(input: {
  stage?: MlbP1M3aStage;
  capturedAt?: string;
  quoteCapturedAt?: string;
  oddsAmerican?: number;
  modelProbability?: number;
  gitCommit?: string;
  signal?: "BET_FUERTE" | "BET" | "LEAN" | "PASS" | "INFO";
} = {}): MlbP1M3aCaptureCandidate {
  const stage = input.stage ?? "PROVISIONAL";
  const capturedAt = input.capturedAt ?? "2026-08-05T19:54:00.000Z";
  const quoteCapturedAt = input.quoteCapturedAt ?? "2026-08-05T19:53:00.000Z";
  const oddsAmerican = input.oddsAmerican ?? -110;
  const modelProbability = input.modelProbability ?? 0.57;
  const marketImplied = implied(oddsAmerican);
  const signal = input.signal ?? "BET";
  const category = signal === "BET_FUERTE" ? "ELITE"
    : signal === "BET" ? "PREMIUM"
    : signal === "LEAN" ? "LEAN"
    : signal === "PASS" ? "PASS"
    : "INFO";
  const quote = {
    market: "F5_ML" as const,
    side: "HOME" as const,
    selection: "Texas Rangers F5 ML",
    line: null,
    oddsAmerican,
    oppositeOddsAmerican: 100,
    book: "Hard Rock",
    sourceMode: "MANUAL" as const,
    capturedAt: quoteCapturedAt,
    providerLastUpdate: null,
    consensusMethod: null,
    provenanceDigest: "b".repeat(64),
  };
  const snapshotPayload = {
    schemaVersion: MLB_P1_M3A_SNAPSHOT_SCHEMA,
    model: {
      name: "CourtEdge MLB",
      version: "predictor-full-snapshot-v2",
      gitCommit: input.gitCommit ?? "abc123",
    },
    game: {
      gamePk: GAME_PK,
      gameDate: "2026-08-05",
      commenceTime: "2026-08-05T21:00:00.000Z",
      homeTeam: "Texas Rangers",
      awayTeam: "San Francisco Giants",
    },
    market: quote,
    probabilities: {
      model: modelProbability,
      marketImplied,
      edgePp: (modelProbability - marketImplied) * 100,
    },
    decision: {
      signal,
      category,
      stakeUnits: signal === "BET" || signal === "BET_FUERTE" ? 1 : 0,
    },
    analysis: {
      stage,
      warnings: [],
      factors: [],
      sources: [],
      layers: {},
      rawInputs: { fixture: true },
      rawOutput: { fixture: true },
    },
  };
  return {
    schemaVersion: MLB_P1_M3A_SCHEMA,
    capturedAt,
    origin: {
      channel: "INTERACTIVE_MLB_PREDICTOR",
      userAction: "GENERATE_PREDICTION",
      clientEvaluationId: `fixture-${stage.toLowerCase()}`,
      frontendRelease: "p1-m2c.2",
    },
    game: {
      gamePk: GAME_PK,
      gameDate: "2026-08-05",
      commenceTime: "2026-08-05T21:00:00.000Z",
      homeTeam: "Texas Rangers",
      awayTeam: "San Francisco Giants",
      venue: "Globe Life Field",
    },
    readiness: {
      runtimeSchemaVersion: MLB_P1_M3A_READINESS_RUNTIME_SCHEMA,
      contractSchemaVersion: MLB_P1_M3A_READINESS_CONTRACT_SCHEMA,
      generatedAt: capturedAt,
      market: "F5_ML",
      gateStatus: stage === "FINAL" ? "READY_FINAL" : "READY_PROVISIONAL",
      analysisStage: stage,
      blockers: [],
      warnings: stage === "FINAL" ? [] : ["LINEUPS_MISSING"],
      evidenceSummary: {
        fresh: stage === "FINAL" ? 7 : 6,
        stale: 0,
        degraded: 0,
        missing: stage === "FINAL" ? 0 : 1,
        conflict: 0,
        unknown: 0,
        requiredFields: ["GAME_IDENTITY", "PITCHERS", "LINEUPS", "INJURIES", "MARKET_ODDS", "PITCHER_FORM", "LINEUP_MATCHUP"],
      },
      evidenceDigest: stage === "FINAL" ? "d".repeat(64) : "a".repeat(64),
      certifiedQuote: quote,
    },
    quote,
    model: {
      name: "CourtEdge MLB",
      version: "predictor-full-snapshot-v2",
      gitCommit: input.gitCommit ?? "abc123",
      environment: "p0-integration",
    },
    probabilities: {
      model: modelProbability,
      marketImplied,
      noVig: null,
      edgePp: (modelProbability - marketImplied) * 100,
    },
    decision: {
      signal,
      category,
      confidenceLabel: category,
      confidencePct: modelProbability * 100,
      recommendedStakeUnits: signal === "BET" || signal === "BET_FUERTE" ? 1 : 0,
      rationale: "Deterministic P1-M3B fixture",
      filterReasons: signal === "PASS" ? ["FILTER_BLOCKED"] : [],
    },
    scientificSnapshot: {
      schemaVersion: MLB_P1_M3A_SNAPSHOT_SCHEMA,
      payload: snapshotPayload,
      payloadDigest: mlbP1M3aSha256(snapshotPayload),
    },
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

async function withStores(
  run: (context: {
    store: MlbLedgerStore;
    ownership: MlbLedgerOwnershipStore;
    setClock: (value: string) => void;
    service: MlbP1ScientificCaptureService;
  }) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-m3b-"));
  const dbPath = path.join(root, "ledger.sqlite");
  const store = new MlbLedgerStore(dbPath);
  const ownership = new MlbLedgerOwnershipStore(dbPath);
  let clock = new Date("2026-08-05T19:55:00.000Z");
  const service = new MlbP1ScientificCaptureService(store, ownership, { now: () => clock });
  try {
    await run({
      store,
      ownership,
      service,
      setClock: (value) => { clock = new Date(value); },
    });
  } finally {
    ownership.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function expectCaptureError(
  operation: Promise<unknown>,
  status: number,
  code: string,
): Promise<MlbP1M3bCaptureError> {
  try {
    await operation;
    assert.fail("Expected capture error");
  } catch (error) {
    assert.equal(error instanceof MlbP1M3bCaptureError, true);
    const typed = error as MlbP1M3bCaptureError;
    assert.equal(typed.status, status);
    assert.equal(typed.code, code);
    return typed;
  }
}

test("valid interactive capture appends once with authenticated ownership and P1 layers", async () => {
  await withStores(async ({ service, store, ownership }) => {
    const result = await service.capture(makeCandidate(), 11);
    assert.equal(result.schemaVersion, MLB_P1_M3B_SCHEMA);
    assert.equal(result.endpoint, MLB_P1_M3B_ENDPOINT);
    assert.equal(result.outcome, "APPENDED");
    assert.equal(result.ownership.userId, 11);
    assert.equal(result.safety.realFinancialExposure, 0);

    const records = ownedRecordsForUser(store, ownership, 11, { limit: 100 });
    assert.equal(records.length, 1);
    const layers = (records[0].prediction.payload as any).analysis.layers;
    assert.equal(layers.p1M3aCapture.schemaVersion, MLB_P1_M3A_SCHEMA);
    assert.equal(layers.p1M3bCapture.schemaVersion, MLB_P1_M3B_SCHEMA);
    assert.equal(layers.p1M3bCapture.ownerAuthority, "AUTHENTICATED_SESSION");
    assert.equal(records[0].prediction.decision.stakeUnits, 1);
  });
});

test("identical retry is idempotent and does not inflate the sample", async () => {
  await withStores(async ({ service, store, ownership }) => {
    const candidate = makeCandidate();
    const first = await service.capture(candidate, 12);
    const second = await service.capture(candidate, 12);
    assert.equal(first.outcome, "APPENDED");
    assert.equal(second.outcome, "IDEMPOTENT");
    assert.equal(second.predictionId, first.predictionId);
    assert.equal(second.revision.decision, "IDEMPOTENT_RETRY");
    assert.equal(ownedRecordsForUser(store, ownership, 12, { limit: 100 }).length, 1);
  });
});

test("concurrent identical requests serialize to one append and one idempotent response", async () => {
  await withStores(async ({ service, store, ownership }) => {
    const candidate = makeCandidate();
    const results = await Promise.all([
      service.capture(candidate, 13),
      service.capture(candidate, 13),
    ]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ["APPENDED", "IDEMPOTENT"]);
    assert.equal(ownedRecordsForUser(store, ownership, 13, { limit: 100 }).length, 1);
  });
});

test("PROVISIONAL to FINAL appends a superseding immutable revision", async () => {
  await withStores(async ({ service, store, ownership, setClock }) => {
    const provisional = await service.capture(makeCandidate(), 14);
    setClock("2026-08-05T19:58:00.000Z");
    const final = await service.capture(makeCandidate({
      stage: "FINAL",
      capturedAt: "2026-08-05T19:57:00.000Z",
      quoteCapturedAt: "2026-08-05T19:57:00.000Z",
      oddsAmerican: -115,
      modelProbability: 0.59,
    }), 14);
    assert.equal(final.outcome, "APPENDED");
    assert.equal(final.revision.decision, "APPEND_SUPERSEDING_REVISION");
    assert.equal(final.revision.supersedesId, provisional.predictionId);

    const records = ownedRecordsForUser(store, ownership, 14, { limit: 100 });
    assert.equal(records.length, 2);
    assert.equal(records[1].prediction.supersedesId, provisional.predictionId);
    assert.equal(records[1].prediction.analysisStage, "FINAL");
  });
});

test("FINAL to PROVISIONAL stage regression is rejected without a ledger write", async () => {
  await withStores(async ({ service, store, ownership, setClock }) => {
    await service.capture(makeCandidate({
      stage: "FINAL",
      capturedAt: "2026-08-05T19:54:00.000Z",
      quoteCapturedAt: "2026-08-05T19:53:00.000Z",
    }), 15);
    setClock("2026-08-05T19:58:00.000Z");
    await expectCaptureError(service.capture(makeCandidate({
      stage: "PROVISIONAL",
      capturedAt: "2026-08-05T19:57:00.000Z",
      quoteCapturedAt: "2026-08-05T19:57:00.000Z",
      oddsAmerican: -115,
      modelProbability: 0.58,
    }), 15), 409, "REJECT_STAGE_REGRESSION");
    assert.equal(ownedRecordsForUser(store, ownership, 15, { limit: 100 }).length, 1);
  });
});

test("stale quote and client-supplied owner field are rejected before persistence", async () => {
  await withStores(async ({ service, store, ownership, setClock }) => {
    setClock("2026-08-05T20:00:00.000Z");
    const stale = makeCandidate({
      capturedAt: "2026-08-05T19:59:00.000Z",
      quoteCapturedAt: "2026-08-05T19:50:00.000Z",
    });
    const staleError = await expectCaptureError(service.capture(stale, 16), 422, "P1_M3A_CAPTURE_REJECTED");
    assert.equal((staleError.details as any).errors.includes("MARKET_QUOTE_STALE"), true);

    const forgedOwner = { ...makeCandidate({
      capturedAt: "2026-08-05T19:59:00.000Z",
      quoteCapturedAt: "2026-08-05T19:59:00.000Z",
    }), userId: 999 };
    await expectCaptureError(service.capture(forgedOwner, 16), 400, "MALFORMED_CAPTURE_CANDIDATE");
    assert.equal(ownedRecordsForUser(store, ownership, 16, { limit: 100 }).length, 0);
  });
});

test("the same semantic decision remains isolated by authenticated user", async () => {
  await withStores(async ({ service, store, ownership }) => {
    const candidate = makeCandidate();
    const first = await service.capture(candidate, 21);
    const second = await service.capture(candidate, 22);
    assert.notEqual(first.predictionId, second.predictionId);
    assert.equal(first.identity.semanticFingerprint, second.identity.semanticFingerprint);
    assert.equal(ownedRecordsForUser(store, ownership, 21, { limit: 100 }).length, 1);
    assert.equal(ownedRecordsForUser(store, ownership, 22, { limit: 100 }).length, 1);
  });
});

test("non-actionable controls are preserved only with zero analytical stake", async () => {
  await withStores(async ({ service, store, ownership }) => {
    const pass = await service.capture(makeCandidate({ signal: "PASS" }), 31);
    assert.equal(pass.validation.economicDisposition, "BLOCKED");
    const record = ownedRecordsForUser(store, ownership, 31, { limit: 10 })[0];
    assert.equal(record.prediction.decision.signal, "PASS");
    assert.equal(record.prediction.decision.stakeUnits, 0);
  });
});

test("interactive route middleware requires a real session identity", () => {
  const createResponse = () => {
    const state: { status: number; body: any } = { status: 200, body: null };
    const response = {
      status(code: number) { state.status = code; return response; },
      json(body: any) { state.body = body; return response; },
    } as unknown as Response;
    return { state, response };
  };

  const missing = createResponse();
  let missingNext = false;
  requireInteractiveMlbCaptureSession({ session: {} } as unknown as Request, missing.response, (() => { missingNext = true; }) as NextFunction);
  assert.equal(missingNext, false);
  assert.equal(missing.state.status, 401);
  assert.equal(missing.state.body.code, "INTERACTIVE_SESSION_REQUIRED");

  const authenticated = createResponse();
  let authenticatedNext = false;
  requireInteractiveMlbCaptureSession({
    session: {
      courtEdgeAuthenticated: true,
      courtEdgeUserId: 9,
      courtEdgeUser: "rogel-admin",
      courtEdgeRole: "admin",
    },
  } as unknown as Request, authenticated.response, (() => { authenticatedNext = true; }) as NextFunction);
  assert.equal(authenticatedNext, true);
});
