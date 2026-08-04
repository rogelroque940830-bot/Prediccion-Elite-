import assert from "node:assert/strict";
import test from "node:test";
import {
  activeOperationalSlaAlerts,
  filterOperationalSlaEvents,
  operationalSlaSafetyValid,
  slaDurationLabel,
  slaEventTypeLabel,
  type OperationalSlaAlertEvent,
} from "./operations-sla-alerts";

function event(overrides: Partial<OperationalSlaAlertEvent> = {}): OperationalSlaAlertEvent {
  return {
    schemaVersion: "courtedge-operational-sla-alert.v1",
    policyVersion: "courtedge-operational-sla-policy.v1",
    eventId: "evt-1",
    ownerUserId: 1,
    emittedAt: "2026-08-04T14:30:00.000Z",
    emittedAtMs: Date.parse("2026-08-04T14:30:00.000Z"),
    eventType: "OPENED",
    alertKey: "INCIDENT:ops-MLB:777:SETTLEMENT_OVERDUE",
    severity: "WARNING",
    sourceType: "INCIDENT",
    league: "MLB",
    incidentId: "ops-MLB:777",
    workerId: null,
    gameId: "777",
    gameDate: "2026-08-03",
    commenceTime: "2026-08-03T20:00:00.000Z",
    homeTeam: "Chicago Cubs",
    awayTeam: "Detroit Tigers",
    state: "SETTLEMENT_OVERDUE",
    reasonCode: "O2_SETTLEMENT_SLA_BREACH",
    summary: "Detroit Tigers vs Chicago Cubs: settlement vencido.",
    nextAction: "Revisar fuente oficial.",
    evidenceConfidence: "AUTHORITATIVE",
    sla: {
      policyCode: "SETTLEMENT_AFTER_OFFICIAL_FINAL_WINDOW",
      targetMinutes: 1080,
      observedMinutes: 1110,
      breachedByMinutes: 30,
      deadlineAt: "2026-08-04T14:00:00.000Z",
    },
    fingerprint: "fp",
    delivered: { console: true, webhook: false },
    ...overrides,
  };
}

test("derives active alerts from the latest append-only lifecycle event", () => {
  const opened = event();
  const resolved = event({
    eventId: "evt-2",
    eventType: "RESOLVED",
    emittedAt: "2026-08-04T15:00:00.000Z",
    emittedAtMs: Date.parse("2026-08-04T15:00:00.000Z"),
  });
  const other = event({
    eventId: "evt-3",
    alertKey: "WORKER:wnba-shadow-settlement",
    sourceType: "WORKER",
    workerId: "wnba-shadow-settlement",
    incidentId: null,
    gameId: null,
    homeTeam: null,
    awayTeam: null,
    league: "WNBA",
    severity: "CRITICAL",
  });
  assert.deepEqual(activeOperationalSlaAlerts([opened, resolved, other]).map((item) => item.eventId), ["evt-3"]);
});

test("filters SLA events by mode, league, severity and search", () => {
  const mlb = event();
  const wnba = event({
    eventId: "evt-wnba",
    alertKey: "WORKER:wnba-shadow-settlement",
    sourceType: "WORKER",
    workerId: "wnba-shadow-settlement",
    incidentId: null,
    gameId: null,
    homeTeam: null,
    awayTeam: null,
    league: "WNBA",
    severity: "CRITICAL",
    summary: "WNBA worker error",
  });
  const filtered = filterOperationalSlaEvents([mlb, wnba], {
    mode: "HISTORY",
    league: "WNBA",
    severity: "CRITICAL",
    search: "worker",
  });
  assert.deepEqual(filtered.map((item) => item.eventId), ["evt-wnba"]);
});

test("SLA labels and durations are human-readable", () => {
  assert.equal(slaEventTypeLabel("ESCALATED"), "Escalada");
  assert.equal(slaDurationLabel(30), "30 min");
  assert.equal(slaDurationLabel(90), "1.5 h");
});

test("O2 safety validation fails closed", () => {
  const safe = {
    mode: "OBSERVE_ONLY" as const,
    readOnly: true as const,
    realFinancialExposure: 0 as const,
    automaticBetPlacement: false as const,
    automaticSettlementRetry: false as const,
    historicalLedgerMutation: false as const,
    automaticModelChangesAllowed: false as const,
    automaticPromotionAllowed: false as const,
  };
  assert.equal(operationalSlaSafetyValid(safe), true);
  assert.equal(operationalSlaSafetyValid({ ...safe, automaticSettlementRetry: true as false }), false);
});
