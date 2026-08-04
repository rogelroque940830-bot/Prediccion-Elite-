import assert from "node:assert/strict";
import test from "node:test";
import type { OperationalIncident } from "./operations-incident-center";
import {
  O3_CONFIRMATION_PHRASE,
  buildOperationalReprocessingIdempotencyKey,
  eligibleOperationalReprocessingIncidents,
  operationalReprocessingAuditLabel,
  operationalReprocessingSafetyValid,
  reprocessingExecutionReady,
  reprocessingPlanExpired,
  type OperationalReprocessingPlan,
  type OperationalReprocessingSafety,
} from "./operations-reprocessing";

const safe: OperationalReprocessingSafety = {
  mode: "SHADOW_CONTROLLED_REPROCESSING",
  shadowOnly: true,
  realFinancialExposure: 0,
  automaticExecution: false,
  requiresExplicitPreview: true,
  requiresPlanDigest: true,
  requiresAdminExecution: true,
  requiresConfirmationPhrase: true,
  singleGameOnly: true,
  appendOnlySettlementEvents: true,
  historicalLedgerMutation: false,
  automaticSettlementRetry: false,
  automaticBetPlacement: false,
  automaticModelChangesAllowed: false,
  automaticPromotionAllowed: false,
  supportedLeagues: ["MLB"],
};

function incident(overrides: Partial<OperationalIncident> = {}): OperationalIncident {
  return {
    id: "ops-MLB:777",
    league: "MLB",
    gameId: "777",
    gameDate: "2026-08-03",
    commenceTime: "2026-08-03T23:00:00.000Z",
    homeTeam: "Chicago Cubs",
    awayTeam: "Detroit Tigers",
    state: "SETTLEMENT_OVERDUE",
    severity: "CRITICAL",
    reasonCode: "SETTLEMENT_SLA_EXCEEDED",
    message: "Settlement vencido",
    nextAction: "Crear vista previa O3",
    worker: "mlb-auto-settlement",
    source: "MLB_LEDGER",
    evidenceConfidence: "AUTHORITATIVE",
    lastUpdatedAt: "2026-08-04T15:00:00.000Z",
    ageMinutes: 120,
    details: {},
    ...overrides,
  };
}

function plan(overrides: Partial<OperationalReprocessingPlan> = {}): OperationalReprocessingPlan {
  return {
    schemaVersion: "courtedge-operational-reprocessing-plan.v1",
    planId: "o3-plan-1",
    ownerUserId: 1,
    createdAt: "2026-08-04T15:00:00.000Z",
    expiresAt: "2026-08-04T15:10:00.000Z",
    state: "READY",
    incident: {
      id: "ops-MLB:777",
      league: "MLB",
      gameId: "777",
      gameDate: "2026-08-03",
      commenceTime: "2026-08-03T23:00:00.000Z",
      homeTeam: "Chicago Cubs",
      awayTeam: "Detroit Tigers",
      state: "SETTLEMENT_OVERDUE",
      evidenceConfidence: "AUTHORITATIVE",
    },
    officialEvidence: {
      gamePk: 777,
      gameDate: "2026-08-03",
      homeTeam: "Chicago Cubs",
      awayTeam: "Detroit Tigers",
      finalScore: { home: 5, away: 3 },
      inningsDigest: "a".repeat(64),
    },
    targets: [],
    proposals: [],
    blockers: [],
    warnings: [],
    preconditionDigest: "b".repeat(64),
    planDigest: "c".repeat(64),
    confirmationPhrase: O3_CONFIRMATION_PHRASE,
    safety: safe,
    ...overrides,
  };
}

test("shows only authoritative MLB incidents eligible for O3", () => {
  const result = eligibleOperationalReprocessingIncidents([
    incident(),
    incident({ id: "ready", state: "READY_FOR_SETTLEMENT" }),
    incident({ id: "limited", evidenceConfidence: "LIMITED" }),
    incident({ id: "wnba", league: "WNBA" }),
    incident({ id: "waiting", state: "WAITING_FOR_OFFICIAL_FINAL" }),
  ]);
  assert.deepEqual(result.map((item) => item.id), ["ops-MLB:777", "ready"]);
});

test("O3 safety validation fails closed", () => {
  assert.equal(operationalReprocessingSafetyValid(safe), true);
  assert.equal(operationalReprocessingSafetyValid({
    ...safe,
    automaticExecution: true,
  } as unknown as OperationalReprocessingSafety), false);
  assert.equal(operationalReprocessingSafetyValid({
    ...safe,
    supportedLeagues: ["WNBA"],
  } as unknown as OperationalReprocessingSafety), false);
});

test("execution unlocks only with a live READY plan and exact controls", () => {
  const readyPlan = plan();
  const input = {
    plan: readyPlan,
    confirmation: O3_CONFIRMATION_PHRASE,
    reason: "Final oficial revisado y reprocesamiento aprobado.",
    idempotencyKey: "o3-ui:o3-plan-1:nonce",
    nowMs: Date.parse("2026-08-04T15:05:00.000Z"),
  };
  assert.equal(reprocessingExecutionReady(input), true);
  assert.equal(reprocessingExecutionReady({ ...input, confirmation: "YES" }), false);
  assert.equal(reprocessingExecutionReady({ ...input, reason: "corto" }), false);
  assert.equal(reprocessingExecutionReady({ ...input, plan: plan({ state: "BLOCKED" }) }), false);
  assert.equal(reprocessingExecutionReady({ ...input, nowMs: Date.parse("2026-08-04T15:11:00.000Z") }), false);
});

test("expiration and idempotency helpers are deterministic", () => {
  const readyPlan = plan();
  assert.equal(reprocessingPlanExpired(readyPlan, Date.parse("2026-08-04T15:09:59.000Z")), false);
  assert.equal(reprocessingPlanExpired(readyPlan, Date.parse("2026-08-04T15:10:00.000Z")), true);
  assert.equal(
    buildOperationalReprocessingIdempotencyKey("o3-plan-1", "nonce value!"),
    "o3-ui:o3-plan-1:noncevalue",
  );
  assert.equal(operationalReprocessingAuditLabel("SETTLEMENT_APPENDED"), "Settlement agregado");
});
