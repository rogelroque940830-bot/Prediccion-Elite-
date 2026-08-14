import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LedgerRecord, LedgerSettlement, MlbSettlementInput } from "./mlb-ledger-store";
import type { OfficialMlbGame } from "./mlb-settlement-worker";
import type { OperationalIncidentCenterReport } from "./operational-incident-center";
import {
  O3_CONFIRMATION_PHRASE,
  OPERATIONAL_REPROCESSING_AUDIT_VERSION,
  OperationalReprocessingService,
} from "./operational-reprocessing";

function record(id = "pred-1"): LedgerRecord {
  return {
    prediction: {
      id,
      clientRequestId: null,
      recordedAt: "2026-08-03T17:00:00.000Z",
      recordedAtMs: Date.parse("2026-08-03T17:00:00.000Z"),
      game: {
        gamePk: 777,
        gameDate: "2026-08-03",
        commenceTime: "2026-08-03T23:00:00.000Z",
        homeTeam: "Chicago Cubs",
        awayTeam: "Detroit Tigers",
      },
      market: {
        type: "ML",
        selection: "Chicago Cubs",
        line: null,
        oddsAmerican: -110,
        book: "hard-rock",
      },
      probabilities: {
        model: 0.56,
        marketImplied: 0.52381,
        noVig: 0.52,
        edgePp: 4,
      },
      decision: {
        signal: "BET",
        confidenceLabel: "MEDIA",
        confidencePct: 56,
        stakeUnits: 0,
      },
      analysisStage: "FINAL",
      model: {
        name: "CourtEdge MLB",
        version: "shadow",
        gitCommit: "abc",
        environment: "p0-integration",
      },
      supersedesId: null,
      source: "app",
      payloadSha256: `sha-${id}`,
      payload: {},
    },
    settlement: null,
  } as unknown as LedgerRecord;
}

function officialGame(): OfficialMlbGame {
  return {
    gamePk: 777,
    gameDate: "2026-08-03",
    final: true,
    homeTeam: "Chicago Cubs",
    awayTeam: "Detroit Tigers",
    homeScore: 5,
    awayScore: 3,
    innings: Array.from({ length: 9 }, (_, index) => ({
      num: index + 1,
      home: index === 0 ? 1 : index === 4 ? 2 : index === 7 ? 2 : 0,
      away: index === 1 ? 1 : index === 5 ? 2 : 0,
    })),
  };
}

function report(overrides: Partial<OperationalIncidentCenterReport["incidents"][number]> = {}): OperationalIncidentCenterReport {
  return {
    schemaVersion: "courtedge-operational-incident-center.v1",
    generatedAt: "2026-08-04T15:00:00.000Z",
    incidents: [{
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
      message: "Settlement overdue",
      nextAction: "Create a controlled preview.",
      worker: "mlb-auto-settlement",
      source: "MLB_LEDGER",
      evidenceConfidence: "AUTHORITATIVE",
      lastUpdatedAt: "2026-08-03T17:00:00.000Z",
      ageMinutes: 1320,
      details: { pendingRecords: 1 },
      ...overrides,
    }],
    workers: [],
    summary: {
      total: 1,
      unresolved: 1,
      critical: 1,
      warnings: 0,
      byLeague: { MLB: 1, WNBA: 0, NBA: 0, NHL: 0 },
      byState: {
        WAITING_FOR_PREGAME_DATA: 0,
        WAITING_FOR_FINAL_CAPTURE: 0,
        GAME_IN_PROGRESS: 0,
        WAITING_FOR_OFFICIAL_FINAL: 0,
        READY_FOR_SETTLEMENT: 0,
        SETTLEMENT_OVERDUE: 1,
        DATA_QUALITY_REVIEW: 0,
        CORRECTION_REQUIRED: 0,
        RESOLVED: 0,
      },
    },
    coverage: {
      MLB: {
        source: "ledger",
        evidenceConfidence: "AUTHORITATIVE",
        settlementAutomationObserved: true,
        note: "authoritative",
      },
      WNBA: {
        source: "shadow",
        evidenceConfidence: "AUTHORITATIVE",
        settlementAutomationObserved: true,
        note: "authoritative",
      },
      NBA: {
        source: "manual",
        evidenceConfidence: "LIMITED",
        settlementAutomationObserved: false,
        note: "limited",
      },
      NHL: {
        source: "manual",
        evidenceConfidence: "LIMITED",
        settlementAutomationObserved: false,
        note: "limited",
      },
    },
    safety: {
      mode: "OBSERVE_ONLY",
      readOnly: true,
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
      historicalLedgerMutation: false,
      automaticSettlementRetry: false,
    },
  };
}

function harness(input?: {
  report?: OperationalIncidentCenterReport;
  records?: LedgerRecord[];
  now?: Date;
}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "o3-reprocessing-"));
  const records = input?.records ?? [record()];
  const settlements = new Map<string, LedgerSettlement>();
  let eventSequence = 0;
  const service = new OperationalReprocessingService({
    rootDir,
    incidentProvider: async () => input?.report ?? report(),
    recordsProvider: () => records,
    officialGameProvider: async () => officialGame(),
    appendSettlement: (predictionId: string, settlementInput: MlbSettlementInput) => {
      const existing = settlements.get(predictionId);
      if (existing?.clientRequestId === settlementInput.clientRequestId) {
        return { data: existing, idempotent: true };
      }
      eventSequence++;
      const event = {
        eventId: `settlement-${eventSequence}`,
        predictionId,
        clientRequestId: settlementInput.clientRequestId ?? null,
        recordedAt: `2026-08-04T15:0${eventSequence}:00.000Z`,
        recordedAtMs: Date.parse(`2026-08-04T15:0${eventSequence}:00.000Z`),
        settledAt: settlementInput.settledAt ?? `2026-08-04T15:0${eventSequence}:00.000Z`,
        result: settlementInput.result,
        closingOddsAmerican: settlementInput.closingOddsAmerican ?? null,
        closingLine: settlementInput.closingLine ?? null,
        closingImpliedProbability: null,
        clvPp: null,
        outcomeValue: settlementInput.outcomeValue ?? null,
        finalScore: settlementInput.finalScore ?? null,
        profitUnits: 0,
        source: settlementInput.source ?? "official",
        correctionOfEventId: settlementInput.correctionOfEventId ?? null,
        notes: settlementInput.notes ?? null,
        payloadSha256: `settlement-sha-${eventSequence}`,
        payload: settlementInput,
      } as unknown as LedgerSettlement;
      settlements.set(predictionId, event);
      return { data: event, idempotent: false };
    },
    latestSettlement: (predictionId) => settlements.get(predictionId) ?? null,
    closingProvider: () => null,
    now: () => input?.now ?? new Date("2026-08-04T15:00:00.000Z"),
    planTtlMs: 10 * 60 * 1000,
  });
  return { rootDir, service, settlements };
}

test("O3 blocks unsupported or limited-evidence incidents", async () => {
  const limited = report({
    league: "NBA",
    source: "MANUAL_PICKS",
    evidenceConfidence: "LIMITED",
    gameId: "NBA:test",
  });
  const { service } = harness({ report: limited });
  const plan = await service.preview(1, {
    incidentId: "ops-MLB:777",
  });
  assert.equal(plan.state, "BLOCKED");
  assert.ok(plan.blockers.includes("UNSUPPORTED_LEAGUE"));
  assert.ok(plan.blockers.includes("AUTHORITATIVE_EVIDENCE_REQUIRED"));
  assert.equal(plan.proposals.length, 0);
});

test("O3 creates an immutable single-game preview with a digest", async () => {
  const { service } = harness();
  const plan = await service.preview(1, {
    incidentId: "ops-MLB:777",
    league: "MLB",
  });
  assert.equal(plan.state, "READY");
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.proposals[0]?.result, "WIN");
  assert.equal(plan.officialEvidence?.finalScore.home, 5);
  assert.equal(plan.confirmationPhrase, O3_CONFIRMATION_PHRASE);
  assert.equal(plan.safety.automaticExecution, false);
  assert.equal(plan.safety.appendOnlySettlementEvents, true);
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(service.getPlan(1, plan.planId), plan);
});

test("O3 requires the exact confirmation phrase and an operator reason", async () => {
  const { service } = harness();
  const plan = await service.preview(1, { incidentId: "ops-MLB:777" });
  await assert.rejects(
    service.execute(1, {
      planId: plan.planId,
      planDigest: plan.planDigest,
      idempotencyKey: "request-1",
      confirmation: "YES",
      reason: "settle",
    }),
    /confirmation phrase/i,
  );
});

test("O3 appends and verifies one controlled settlement", async () => {
  const { service, settlements } = harness();
  const plan = await service.preview(1, { incidentId: "ops-MLB:777" });
  const execution = await service.execute(1, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    idempotencyKey: "request-1",
    confirmation: O3_CONFIRMATION_PHRASE,
    reason: "Official final confirmed after the normal worker missed the cycle.",
  });
  assert.equal(execution.state, "COMPLETED");
  assert.equal(execution.appended, 1);
  assert.equal(execution.verified, 1);
  assert.equal(settlements.get("pred-1")?.result, "WIN");
  assert.equal(settlements.get("pred-1")?.source, "official");
  assert.match(settlements.get("pred-1")?.clientRequestId ?? "", /^o3:o3-plan-/);
});

test("O3 returns an idempotent replay for the same execution request", async () => {
  const { service } = harness();
  const plan = await service.preview(1, { incidentId: "ops-MLB:777" });
  const request = {
    planId: plan.planId,
    planDigest: plan.planDigest,
    idempotencyKey: "request-replay",
    confirmation: O3_CONFIRMATION_PHRASE,
    reason: "Official final confirmed and controlled reprocessing approved.",
  };
  const first = await service.execute(1, request);
  const replay = await service.execute(1, request);
  assert.equal(first.state, "COMPLETED");
  assert.equal(replay.state, "IDEMPOTENT_REPLAY");
  assert.equal(replay.executionId, first.executionId);
  await assert.rejects(
    service.execute(1, { ...request, reason: `${request.reason} changed` }),
    /idempotency key/i,
  );
});

test("O3 blocks settlement drift introduced after preview", async () => {
  const { service, settlements } = harness();
  const plan = await service.preview(1, { incidentId: "ops-MLB:777" });
  settlements.set("pred-1", {
    eventId: "outside-event",
    predictionId: "pred-1",
    clientRequestId: "outside-request",
    result: "LOSS",
  } as unknown as LedgerSettlement);
  const execution = await service.execute(1, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    idempotencyKey: "request-drift",
    confirmation: O3_CONFIRMATION_PHRASE,
    reason: "Attempt controlled execution after a concurrent settlement event.",
  });
  assert.equal(execution.state, "BLOCKED");
  assert.equal(execution.appended, 0);
  assert.equal(execution.failed[0]?.error, "SETTLED_BY_DIFFERENT_EVENT_AFTER_PREVIEW");
});

test("O3 audit journal forms an append-only digest chain", async () => {
  const { service } = harness();
  const plan = await service.preview(1, { incidentId: "ops-MLB:777" });
  await service.execute(1, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    idempotencyKey: "request-audit",
    confirmation: O3_CONFIRMATION_PHRASE,
    reason: "Controlled settlement requested to validate the append-only audit chain.",
  });
  const events = service.audit(1, 100).sort((a, b) => a.recordedAtMs - b.recordedAtMs);
  assert.ok(events.length >= 4);
  assert.equal(events[0]?.schemaVersion, OPERATIONAL_REPROCESSING_AUDIT_VERSION);
  for (let index = 1; index < events.length; index++) {
    assert.equal(events[index]?.previousDigest, events[index - 1]?.eventDigest);
  }
  assert.equal(service.status(1).completedExecutions, 1);
});
