import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildOperationalSlaCandidates,
  OperationalSlaAlertService,
} from "./operational-sla-alerts";
import type {
  OperationalIncident,
  OperationalIncidentCenterReport,
  OperationalWorkerSnapshot,
} from "./operational-incident-center";

function baseIncident(
  overrides: Partial<OperationalIncident> = {},
): OperationalIncident {
  return {
    id: "ops-MLB:777",
    league: "MLB",
    gameId: "777",
    gameDate: "2026-08-03",
    commenceTime: "2026-08-03T20:00:00.000Z",
    homeTeam: "Chicago Cubs",
    awayTeam: "Detroit Tigers",
    state: "SETTLEMENT_OVERDUE",
    severity: "WARNING",
    reasonCode: "SETTLEMENT_SLA_EXCEEDED",
    message: "Settlement overdue",
    nextAction: "Review official source",
    worker: "mlb-auto-settlement",
    source: "MLB_LEDGER",
    evidenceConfidence: "AUTHORITATIVE",
    lastUpdatedAt: "2026-08-03T20:00:00.000Z",
    ageMinutes: 1_090,
    details: {},
    ...overrides,
  };
}

function baseWorker(
  overrides: Partial<OperationalWorkerSnapshot> = {},
): OperationalWorkerSnapshot {
  return {
    id: "wnba-shadow-settlement",
    league: "WNBA",
    label: "WNBA shadow y settlement",
    state: "HEALTHY",
    enabled: true,
    intervalMs: 15 * 60_000,
    lastRunAt: "2026-08-04T14:20:00.000Z",
    lastSuccessAt: "2026-08-04T14:20:00.000Z",
    lastError: null,
    lagMinutes: 10,
    message: "Heartbeat within SLA",
    ...overrides,
  };
}

function report(input: {
  generatedAt?: string;
  incidents?: OperationalIncident[];
  workers?: OperationalWorkerSnapshot[];
} = {}): OperationalIncidentCenterReport {
  const incidents = input.incidents ?? [];
  return {
    schemaVersion: "courtedge-operational-incident-center.v1",
    generatedAt: input.generatedAt ?? "2026-08-04T14:30:00.000Z",
    incidents,
    workers: input.workers ?? [],
    summary: {
      total: incidents.length,
      unresolved: incidents.length,
      critical: incidents.filter((item) => item.severity === "CRITICAL").length,
      warnings: incidents.filter((item) => item.severity === "WARNING").length,
      byLeague: {
        MLB: incidents.filter((item) => item.league === "MLB").length,
        WNBA: incidents.filter((item) => item.league === "WNBA").length,
        NBA: incidents.filter((item) => item.league === "NBA").length,
        NHL: incidents.filter((item) => item.league === "NHL").length,
      },
      byState: {
        WAITING_FOR_PREGAME_DATA: 0,
        WAITING_FOR_FINAL_CAPTURE: 0,
        GAME_IN_PROGRESS: 0,
        WAITING_FOR_OFFICIAL_FINAL: 0,
        READY_FOR_SETTLEMENT: 0,
        SETTLEMENT_OVERDUE: incidents.filter((item) => item.state === "SETTLEMENT_OVERDUE").length,
        DATA_QUALITY_REVIEW: incidents.filter((item) => item.state === "DATA_QUALITY_REVIEW").length,
        CORRECTION_REQUIRED: incidents.filter((item) => item.state === "CORRECTION_REQUIRED").length,
        RESOLVED: 0,
      },
    },
    coverage: {
      MLB: {
        source: "immutable MLB ledger",
        evidenceConfidence: "AUTHORITATIVE",
        settlementAutomationObserved: true,
        note: "test",
      },
      WNBA: {
        source: "WNBA shadow",
        evidenceConfidence: "AUTHORITATIVE",
        settlementAutomationObserved: true,
        note: "test",
      },
      NBA: {
        source: "manual picks",
        evidenceConfidence: "LIMITED",
        settlementAutomationObserved: false,
        note: "test",
      },
      NHL: {
        source: "manual picks",
        evidenceConfidence: "LIMITED",
        settlementAutomationObserved: false,
        note: "test",
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

test("O2 creates immediate critical candidates for data-quality and correction blocks", () => {
  const built = buildOperationalSlaCandidates(report({
    incidents: [
      baseIncident({
        id: "ops-NBA:bad",
        league: "NBA",
        gameId: "bad",
        source: "MANUAL_PICKS",
        evidenceConfidence: "LIMITED",
        state: "DATA_QUALITY_REVIEW",
        severity: "CRITICAL",
      }),
      baseIncident({
        id: "ops-MLB:correction",
        state: "CORRECTION_REQUIRED",
        severity: "CRITICAL",
      }),
    ],
  }));
  assert.equal(built.candidates.length, 2);
  assert.equal(built.candidates.every((item) => item.severity === "CRITICAL"), true);
  assert.deepEqual(
    built.candidates.map((item) => item.sla.policyCode).sort(),
    ["CORRECTION_IMMEDIATE", "DATA_QUALITY_IMMEDIATE"],
  );
});

test("O2 suppresses timed SLA alerts when the evidence is explicitly limited", () => {
  const built = buildOperationalSlaCandidates(report({
    incidents: [baseIncident({
      id: "ops-NBA:manual",
      league: "NBA",
      gameId: "manual",
      source: "MANUAL_PICKS",
      evidenceConfidence: "LIMITED",
      homeTeam: "Miami Heat",
      awayTeam: "Boston Celtics",
    })],
    workers: [baseWorker({
      id: "nba-manual-result-entry",
      league: "NBA",
      state: "MANUAL_ONLY",
      enabled: null,
      intervalMs: null,
      lastRunAt: null,
      lastSuccessAt: null,
      lagMinutes: null,
    })],
  }));
  assert.equal(built.candidates.length, 0);
  assert.equal(built.suppressed.limitedEvidence, 1);
  assert.equal(built.suppressed.manualOrUninstrumentedWorkers, 1);
});

test("O2 opens, reminds and resolves an alert using append-only lifecycle events", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-o2-lifecycle-"));
  try {
    const ownerUserId = 7;
    const firstReport = report({
      generatedAt: "2026-08-04T14:30:00.000Z",
      incidents: [baseIncident()],
    });
    const emptyReport = report({ generatedAt: "2026-08-04T16:00:00.000Z" });
    const service = new OperationalSlaAlertService(
      async () => firstReport,
      root,
      60_000,
      60_000,
    );

    const opened = await service.evaluate(
      ownerUserId,
      firstReport,
      new Date("2026-08-04T14:30:00.000Z"),
    );
    assert.equal(opened.emitted.length, 1);
    assert.equal(opened.emitted[0]?.eventType, "OPENED");

    const cooldown = await service.evaluate(
      ownerUserId,
      firstReport,
      new Date("2026-08-04T14:30:30.000Z"),
    );
    assert.equal(cooldown.emitted.length, 0);
    assert.equal(cooldown.suppressed.cooldown, 1);

    const reminder = await service.evaluate(
      ownerUserId,
      firstReport,
      new Date("2026-08-04T14:31:01.000Z"),
    );
    assert.equal(reminder.emitted.length, 1);
    assert.equal(reminder.emitted[0]?.eventType, "REMINDER");

    const resolved = await service.evaluate(
      ownerUserId,
      emptyReport,
      new Date("2026-08-04T16:00:00.000Z"),
    );
    assert.equal(resolved.emitted.length, 1);
    assert.equal(resolved.emitted[0]?.eventType, "RESOLVED");
    assert.equal(service.active(ownerUserId).length, 0);

    const filename = path.join(root, `operational-sla-alerts-user-${ownerUserId}.jsonl`);
    const lines = fs.readFileSync(filename, "utf-8").trim().split("\n");
    assert.equal(lines.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("O2 escalates the same settlement alert instead of opening a duplicate lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-o2-escalation-"));
  try {
    const ownerUserId = 9;
    const warningReport = report({
      generatedAt: "2026-08-04T14:30:00.000Z",
      incidents: [baseIncident({
        commenceTime: "2026-08-03T20:00:00.000Z",
      })],
    });
    const criticalReport = report({
      generatedAt: "2026-08-04T22:30:00.000Z",
      incidents: [baseIncident({
        commenceTime: "2026-08-03T20:00:00.000Z",
      })],
    });
    const service = new OperationalSlaAlertService(async () => warningReport, root);

    const warning = await service.evaluate(
      ownerUserId,
      warningReport,
      new Date(warningReport.generatedAt),
    );
    assert.equal(warning.emitted[0]?.severity, "WARNING");
    assert.equal(warning.emitted[0]?.eventType, "OPENED");

    const critical = await service.evaluate(
      ownerUserId,
      criticalReport,
      new Date(criticalReport.generatedAt),
    );
    assert.equal(critical.emitted[0]?.severity, "CRITICAL");
    assert.equal(critical.emitted[0]?.eventType, "ESCALATED");
    assert.equal(service.active(ownerUserId).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("O2 alerts on stale and errored instrumented workers without treating gaps as failures", () => {
  const built = buildOperationalSlaCandidates(report({
    workers: [
      baseWorker({ state: "STALE", lagMinutes: 80 }),
      baseWorker({
        id: "worker-error",
        state: "ERROR",
        lastError: "scoreboard unavailable",
      }),
      baseWorker({
        id: "mlb-auto-settlement",
        league: "MLB",
        state: "UNINSTRUMENTED",
        enabled: null,
        intervalMs: null,
        lastRunAt: null,
        lastSuccessAt: null,
        lagMinutes: null,
      }),
    ],
  }));
  assert.equal(built.candidates.length, 2);
  assert.equal(built.candidates.find((item) => item.workerId === "worker-error")?.severity, "CRITICAL");
  assert.equal(built.suppressed.manualOrUninstrumentedWorkers, 1);
});

test("O2 stores alerts separately for each owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "courtedge-o2-owners-"));
  try {
    const current = report({ incidents: [baseIncident()] });
    const service = new OperationalSlaAlertService(async () => current, root);
    await service.evaluate(1, current, new Date(current.generatedAt));
    assert.equal(service.list(1).length, 1);
    assert.equal(service.list(2).length, 0);
    assert.equal(fs.existsSync(path.join(root, "operational-sla-alerts-user-1.jsonl")), true);
    assert.equal(fs.existsSync(path.join(root, "operational-sla-alerts-user-2.jsonl")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
