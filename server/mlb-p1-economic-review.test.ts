import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerRecord } from "./mlb-ledger-store";
import {
  MLB_P1_M3D_SCHEMA,
  buildMlbP1M3dEconomicReview,
} from "./mlb-p1-economic-review";
import { MLB_P1_M5A_SCHEMA } from "./mlb-p1-real-cohort-activation";

const NOW = "2026-08-06T04:50:00.000Z";

function record(input: {
  id: string;
  lifecycleKey?: string;
  supersedesId?: string | null;
  recordedAtMs?: number;
  stage?: "PROVISIONAL" | "FINAL";
  signal?: "BET_FUERTE" | "BET" | "LEAN" | "PASS" | "INFO";
  result?: "WIN" | "LOSS" | "PUSH" | "VOID" | "HALF_WIN" | "HALF_LOSS" | null;
  odds?: number;
  modelProbability?: number;
  effectiveDecision?: "BET" | "LEAN" | "PASS";
  actionability?: "ACTIONABLE_FINAL" | "WAIT_FOR_FINAL" | "OBSERVE_ONLY" | "BLOCKED";
  units?: number;
  interactive?: boolean;
  economicLayer?: boolean;
  gamePk?: number;
  market?: "ML" | "F5_ML" | "RUN_LINE" | "TOTAL";
  selection?: string;
  line?: number | null;
}): LedgerRecord {
  const recordedAtMs = input.recordedAtMs ?? Date.parse("2026-08-05T20:00:00.000Z");
  const odds = input.odds ?? 100;
  const modelProbability = input.modelProbability ?? 0.60;
  const stage = input.stage ?? "FINAL";
  const signal = input.signal ?? "BET";
  const lifecycleKey = input.lifecycleKey ?? `life:${input.id}`;
  const effectiveDecision = input.effectiveDecision ?? (signal === "BET" || signal === "BET_FUERTE" ? "BET" : signal === "LEAN" ? "LEAN" : "PASS");
  const actionability = input.actionability ?? (stage === "FINAL" && effectiveDecision === "BET" ? "ACTIONABLE_FINAL" : stage === "PROVISIONAL" ? "WAIT_FOR_FINAL" : "OBSERVE_ONLY");
  const units = input.units ?? (actionability === "ACTIONABLE_FINAL" && effectiveDecision === "BET" ? 0.5 : 0);
  const market = input.market ?? "ML";
  const line = input.line ?? null;
  const gamePk = input.gamePk ?? 900001;
  const selection = input.selection ?? "Home ML";
  const layers: Record<string, unknown> = {};
  if (input.interactive !== false) {
    layers.p1M3aCapture = {
      schemaVersion: "courtedge-p1-m3a-scientific-capture-contract.v1",
      identity: { lifecycleKey },
      origin: { channel: "INTERACTIVE_MLB_PREDICTOR", userAction: "GENERATE_PREDICTION" },
    };
  } else {
    layers.s5c = { schemaVersion: "mlb-s5c-shadow-ingestion.v1" };
  }
  if (input.economicLayer !== false && input.interactive !== false) {
    layers.p1M4bEconomicDecision = {
      schemaVersion: "courtedge-p1-m4b-economic-decision-adapter.v1",
      status: "ADAPTED",
      effectiveDecision: { decision: effectiveDecision, actionability, analyticalUnits: units },
      safety: {
        mode: "SHADOW_DECISION_SUPPORT",
        realFinancialExposure: 0,
        automaticBetPlacement: false,
        sportsbookIntegration: false,
        automaticModelChangesAllowed: false,
        automaticPromotionAllowed: false,
      },
    };
  }

  const settlement = input.result == null ? null : {
    eventId: `settle:${input.id}`,
    predictionId: input.id,
    clientRequestId: null,
    recordedAt: new Date(recordedAtMs + 10_000).toISOString(),
    recordedAtMs: recordedAtMs + 10_000,
    settledAt: new Date(recordedAtMs + 10_000).toISOString(),
    result: input.result,
    closingOddsAmerican: odds - 10,
    closingLine: line,
    closingImpliedProbability: 0.52,
    clvPp: 1.25,
    outcomeValue: input.result === "WIN" ? 1 : input.result === "LOSS" ? 0 : null,
    finalScore: { home: 5, away: 3 },
    profitUnits: input.result === "WIN" ? 1 : input.result === "LOSS" ? -1 : 0,
    source: "official",
    correctionOfEventId: null,
    notes: null,
    payloadSha256: "b".repeat(64),
    payload: {},
  } as any;

  return {
    prediction: {
      id: input.id,
      clientRequestId: `u1:${input.id}`,
      recordedAt: new Date(recordedAtMs).toISOString(),
      recordedAtMs,
      game: {
        gamePk,
        gameDate: "2026-08-05",
        commenceTime: "2026-08-05T23:00:00.000Z",
        homeTeam: "Home",
        awayTeam: "Away",
      },
      market: { type: market, selection, line, oddsAmerican: odds, book: "Hard Rock" },
      probabilities: {
        model: modelProbability,
        marketImplied: odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100),
        noVig: 0.51,
        edgePp: (modelProbability - (odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100))) * 100,
      },
      decision: {
        signal,
        confidenceLabel: signal === "BET" ? "PREMIUM" : signal,
        confidencePct: modelProbability * 100,
        stakeUnits: signal === "BET" || signal === "BET_FUERTE" ? units : 0,
      },
      analysisStage: stage,
      model: { name: "CourtEdge MLB", version: "v2", gitCommit: "abc123", environment: "test" },
      supersedesId: input.supersedesId ?? null,
      source: "app",
      payloadSha256: "a".repeat(64),
      payload: {
        schemaVersion: "mlb-ledger.v1",
        market: { capturedAt: "2026-08-05T19:59:00.000Z" },
        analysis: {
          stage,
          warnings: [],
          factors: [],
          sources: [{ name: "Hard Rock", status: "VERIFIED", fetchedAt: "2026-08-05T19:59:00.000Z" }],
          layers,
          rawInputs: {
            priceCapture: { capturedAt: "2026-08-05T19:59:00.000Z", consensusMethod: "MEDIAN_VALID_BOOKS_V1" },
            marketProvenance: { consensusMethod: "MEDIAN_VALID_BOOKS_V1", contributingBooks: ["Hard Rock"] },
          },
          rawOutput: {},
        },
      },
    } as any,
    settlement,
  };
}

test("P1-M3D separates flat and effective-policy accounting", () => {
  const report = buildMlbP1M3dEconomicReview([
    record({ id: "win", result: "WIN", odds: 100, units: 0.5 }),
    record({ id: "loss", lifecycleKey: "life:loss", gamePk: 900002, result: "LOSS", odds: -110, units: 0.25 }),
  ], { generatedAt: NOW });

  assert.equal(report.schemaVersion, MLB_P1_M3D_SCHEMA);
  assert.equal(report.overall.settled, 2);
  assert.equal(report.overall.flatStakeExposureUnits, 2);
  assert.equal(report.overall.flatStakeProfitUnits, 0);
  assert.equal(report.overall.policyStakeExposureUnits, 0.75);
  assert.equal(report.overall.policyStakeProfitUnits, 0.25);
  assert.equal(report.overall.policyStakeRoiPct, 33.3333);
  assert.equal(report.safety.realFinancialExposure, 0);
  assert.equal(report.safety.automaticBetPlacement, false);
  assert.equal(report.activation.schemaVersion, MLB_P1_M5A_SCHEMA);
  assert.equal(report.activation.state, "END_TO_END_CERTIFIED");
  assert.equal(report.activation.certified, true);
});

test("P1-M3D evaluates only the terminal revision of a PROVISIONAL to FINAL chain", () => {
  const report = buildMlbP1M3dEconomicReview([
    record({
      id: "provisional",
      lifecycleKey: "life:chain",
      stage: "PROVISIONAL",
      recordedAtMs: Date.parse("2026-08-05T18:00:00.000Z"),
      result: "LOSS",
      effectiveDecision: "LEAN",
      actionability: "WAIT_FOR_FINAL",
      units: 0,
    }),
    record({
      id: "final",
      lifecycleKey: "life:chain",
      supersedesId: "provisional",
      stage: "FINAL",
      recordedAtMs: Date.parse("2026-08-05T19:00:00.000Z"),
      result: "WIN",
      units: 0.5,
    }),
  ]);

  assert.equal(report.sample.lifecycleChains, 1);
  assert.equal(report.sample.terminalLeaves, 1);
  assert.equal(report.sample.uniqueAnalyticalDecisions, 1);
  assert.equal(report.lifecycle.provisionalToFinalChains, 1);
  assert.equal(report.overall.wins, 1);
  assert.equal(report.overall.losses, 0);
  assert.equal(report.rows[0].predictionId, "final");
});

test("P1-M3D excludes automatic S5C records and retains PASS controls", () => {
  const report = buildMlbP1M3dEconomicReview([
    record({ id: "automatic", interactive: false, result: "WIN" }),
    record({
      id: "pass",
      lifecycleKey: "life:pass",
      gamePk: 900003,
      signal: "PASS",
      effectiveDecision: "PASS",
      actionability: "OBSERVE_ONLY",
      units: 0,
      result: "LOSS",
    }),
  ]);

  assert.equal(report.sample.ownedLedgerRecords, 2);
  assert.equal(report.sample.interactiveLedgerRecords, 1);
  assert.equal(report.overall.observations, 1);
  assert.equal(report.controls.acceptedSourceSignals.observations, 0);
  assert.equal(report.controls.leanPassInfoControls.observations, 1);
  assert.equal(report.controls.leanPassInfoControls.policyStakeExposureUnits, 0);
});

test("P1-M3D excludes branched lifecycles fail closed", () => {
  const report = buildMlbP1M3dEconomicReview([
    record({ id: "branch-a", lifecycleKey: "life:branch", result: "WIN" }),
    record({ id: "branch-b", lifecycleKey: "life:branch", recordedAtMs: Date.parse("2026-08-05T20:05:00.000Z"), result: "LOSS" }),
  ]);

  assert.equal(report.state, "ACTION_REQUIRED");
  assert.equal(report.sample.lifecycleBranchesExcluded, 1);
  assert.equal(report.sample.uniqueAnalyticalDecisions, 0);
  assert.equal(report.issues.some((issue) => issue.code === "INTERACTIVE_LIFECYCLE_BRANCH_CONFLICT"), true);
  assert.equal(report.activation.state, "BLOCKED_INTEGRITY");
  assert.equal(report.activation.certified, false);
});

test("P1-M3D keeps flat evidence but excludes invalid economic units from policy ROI", () => {
  const invalid = record({ id: "invalid-layer", result: "WIN", economicLayer: false });
  const report = buildMlbP1M3dEconomicReview([invalid]);

  assert.equal(report.overall.flatStakeProfitUnits, 1);
  assert.equal(report.overall.policyStakeExposureUnits, 0);
  assert.equal(report.overall.policyStakeProfitUnits, 0);
  assert.equal(report.sample.economicLayersInvalid, 1);
  assert.equal(report.rows[0].economicLayerValid, false);
  assert.equal(report.rows[0].economicLayerErrors.includes("P1_M4B_LAYER_MISSING"), true);
});

test("P1-M3D milestone states remain descriptive and never authorize automatic changes", () => {
  const records = Array.from({ length: 5 }, (_, index) => record({
    id: `five-${index}`,
    lifecycleKey: `life:five-${index}`,
    gamePk: 910000 + index,
    recordedAtMs: Date.parse("2026-08-05T18:00:00.000Z") + index * 1000,
    result: index % 2 ? "LOSS" : "WIN",
  }));
  const report = buildMlbP1M3dEconomicReview(records);

  assert.equal(report.state, "PRELIMINARY_REVIEW_ONLY");
  assert.equal(report.readiness.technicalFiveReached, true);
  assert.equal(report.readiness.preliminaryTwentyReached, false);
  assert.equal(report.readiness.conclusionsAllowed, false);
  assert.equal(report.readiness.automaticModelChangesAllowed, false);
  assert.equal(report.readiness.automaticPromotionAllowed, false);
});


test("P1-M3D exposes the P1-M5A activation sequence without changing review economics", () => {
  const empty = buildMlbP1M3dEconomicReview([], { generatedAt: NOW });
  assert.equal(empty.activation.state, "WAITING_FOR_REAL_CAPTURE");
  assert.equal(empty.activation.nextAction, "GENERATE_FIRST_REAL_PREDICTION");

  const pending = buildMlbP1M3dEconomicReview([record({ id: "pending", result: null })], { generatedAt: NOW });
  assert.equal(pending.activation.state, "ECONOMIC_DECISION_REGISTERED");
  assert.equal(pending.activation.nextAction, "WAIT_FOR_OFFICIAL_SETTLEMENT");
  assert.equal(pending.activation.checklist.validEconomicLayerObserved, true);
  assert.equal(pending.activation.checklist.officialSettlementObserved, false);
  assert.equal(pending.activation.safety.realFinancialExposure, 0);
  assert.equal(pending.activation.interpretation.profitabilityConclusionAllowed, false);
});
