import assert from "node:assert/strict";
import test from "node:test";
import {
  O31_CONFIRMATION_PHRASE,
  buildO31IdempotencyKey,
  eligibleO31Incidents,
  o31ExecutionReady,
  o31ManualFields,
  o31PlanRequestReady,
  o31SafetyValid,
  type O31Inspection,
  type O31Plan,
  type O31Safety,
} from "./operations-evidence-repair";
import type { OperationalIncident } from "./operations-incident-center";

const safety: O31Safety = {
  mode: "SHADOW_EVIDENCE_REPAIR",
  shadowOnly: true,
  realFinancialExposure: 0,
  automaticRepair: false,
  requiresExplicitInspection: true,
  requiresSealedPlan: true,
  requiresAdminExecution: true,
  requiresConfirmationPhrase: true,
  singleGameOnly: true,
  appendOnlySupersedingPredictions: true,
  historicalLedgerMutation: false,
  settlementExecution: false,
  automaticBetPlacement: false,
  automaticModelChangesAllowed: false,
  automaticPromotionAllowed: false,
  supportedLeagues: ["MLB"],
};

const baseIncident: OperationalIncident = {
  id: "ops-MLB:1",
  league: "MLB",
  gameId: "1",
  gameDate: "2026-07-31",
  commenceTime: "2026-08-01T01:00:00.000Z",
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
  lastUpdatedAt: "2026-08-01T01:00:00.000Z",
  ageMinutes: 100,
  details: {},
};

function inspection(): O31Inspection {
  return {
    schemaVersion: "courtedge-o31-evidence-inspection.v1",
    inspectionId: "o31-inspection-1",
    ownerUserId: 1,
    createdAt: "2026-08-04T18:00:00.000Z",
    expiresAt: "2026-08-04T18:10:00.000Z",
    incident: {
      id: baseIncident.id,
      league: "MLB",
      gameId: "1",
      gameDate: "2026-07-31",
      commenceTime: baseIncident.commenceTime,
      homeTeam: baseIncident.homeTeam,
      awayTeam: baseIncident.awayTeam,
      state: baseIncident.state,
      evidenceConfidence: "AUTHORITATIVE",
    },
    officialEvidence: {
      gamePk: 1,
      gameDate: "2026-07-31",
      commenceTime: baseIncident.commenceTime,
      homeTeam: baseIncident.homeTeam,
      awayTeam: baseIncident.awayTeam,
      final: true,
      detailedState: "Final",
      finalScore: { home: 2, away: 5 },
      inningsDigest: "digest",
      fetchedAt: "2026-08-04T18:00:00.000Z",
      source: "MLB_STATS_API",
    },
    records: [{
      predictionId: "pred-1",
      payloadSha256: "a".repeat(64),
      supersedesId: null,
      analysisStage: "FINAL",
      game: {
        gamePk: 1,
        gameDate: "2026-07-31",
        commenceTime: baseIncident.commenceTime,
        homeTeam: baseIncident.homeTeam,
        awayTeam: baseIncident.awayTeam,
      },
      market: {
        type: "ML",
        selection: "Detroit Tigers",
        line: null,
        oddsAmerican: 1,
        book: "migration",
      },
      issues: [{
        predictionId: "pred-1",
        code: "INVALID_ODDS_AMERICAN",
        field: "oddsAmerican",
        severity: "BLOCKING",
        currentValue: 1,
        officialValue: null,
        repairMode: "MANUAL_EVIDENCE_REQUIRED",
        message: "Invalid odds",
      }],
    }],
    blockers: [],
    warnings: [],
    inspectionDigest: "b".repeat(64),
    safety,
  };
}

function plan(): O31Plan {
  return {
    schemaVersion: "courtedge-o31-evidence-repair-plan.v1",
    planId: "o31-plan-1",
    inspectionId: "o31-inspection-1",
    inspectionDigest: "b".repeat(64),
    ownerUserId: 1,
    createdAt: "2026-08-04T18:00:00.000Z",
    expiresAt: "2026-08-04T18:10:00.000Z",
    state: "READY",
    incidentId: baseIncident.id,
    gameId: "1",
    officialEvidence: inspection().officialEvidence,
    repairSource: {
      sourceName: "Screenshot",
      evidenceReference: "upload:1",
      capturedAt: "2026-08-01T01:00:00.000Z",
      note: "Screenshot verifies the original sportsbook odds.",
    },
    targets: [{
      predictionId: "pred-1",
      originalPayloadSha256: "a".repeat(64),
      proposedInput: {},
      proposedPayloadSha256: "c".repeat(64),
      repairedFields: ["oddsAmerican"],
    }],
    blockers: [],
    warnings: [],
    preconditionDigest: "d".repeat(64),
    planDigest: "e".repeat(64),
    confirmationPhrase: O31_CONFIRMATION_PHRASE,
    safety,
  };
}

test("filters only authoritative MLB data-quality incidents", () => {
  const list = [
    baseIncident,
    { ...baseIncident, id: "nba", league: "NBA" as const },
    { ...baseIncident, id: "limited", evidenceConfidence: "LIMITED" as const },
    { ...baseIncident, id: "ready", state: "READY_FOR_SETTLEMENT" as const },
  ];
  assert.deepEqual(eligibleO31Incidents(list).map((item) => item.id), [baseIncident.id]);
});

test("safety validation fails closed", () => {
  assert.equal(o31SafetyValid(safety), true);
  assert.equal(o31SafetyValid({ ...safety, automaticRepair: true } as unknown as O31Safety), false);
  assert.equal(o31SafetyValid({ ...safety, settlementExecution: true } as unknown as O31Safety), false);
});

test("manual issue extraction is stable and deduplicated", () => {
  const value = inspection();
  value.records[0].issues.push({ ...value.records[0].issues[0] });
  assert.deepEqual(o31ManualFields(value), [{ predictionId: "pred-1", field: "oddsAmerican" }]);
});

test("plan request requires complete manual evidence and valid source", () => {
  const value = inspection();
  const source = {
    sourceName: "Screenshot",
    evidenceReference: "upload:1",
    capturedAt: "2026-08-01T01:00:00.000Z",
    note: "Screenshot verifies the sportsbook price.",
  };
  assert.equal(o31PlanRequestReady({
    inspection: value,
    patches: [{ predictionId: "pred-1" }],
    source,
    nowMs: Date.parse("2026-08-04T18:05:00.000Z"),
  }), false);
  assert.equal(o31PlanRequestReady({
    inspection: value,
    patches: [{ predictionId: "pred-1", oddsAmerican: -115 }],
    source,
    nowMs: Date.parse("2026-08-04T18:05:00.000Z"),
  }), true);
});

test("execution remains locked until every explicit control matches", () => {
  const value = plan();
  const base = {
    plan: value,
    confirmation: O31_CONFIRMATION_PHRASE,
    reason: "Reviewed official and manual evidence before append.",
    idempotencyKey: "o31-ui:plan:nonce",
    acknowledged: true,
    nowMs: Date.parse("2026-08-04T18:05:00.000Z"),
  };
  assert.equal(o31ExecutionReady(base), true);
  assert.equal(o31ExecutionReady({ ...base, confirmation: "wrong" }), false);
  assert.equal(o31ExecutionReady({ ...base, acknowledged: false }), false);
  assert.equal(o31ExecutionReady({ ...base, nowMs: Date.parse("2026-08-04T18:11:00.000Z") }), false);
});

test("idempotency keys are safe and bounded", () => {
  const key = buildO31IdempotencyKey("o31 plan/1", "nonce value/1");
  assert.match(key, /^[A-Za-z0-9._:-]{1,160}$/);
  assert.ok(key.startsWith("o31-ui:"));
});
