import assert from "node:assert/strict";
import test from "node:test";
import {
  filterOperationalIncidents,
  incidentStateLabel,
  operationalAgeLabel,
  operationalSafetyValid,
  workerStateLabel,
  type OperationalIncident,
} from "./operations-incident-center";

const incidents: OperationalIncident[] = [
  {
    id: "1",
    league: "MLB",
    gameId: "777",
    gameDate: "2026-08-03",
    commenceTime: "2026-08-03T23:00:00.000Z",
    homeTeam: "Chicago Cubs",
    awayTeam: "Detroit Tigers",
    state: "SETTLEMENT_OVERDUE",
    severity: "WARNING",
    reasonCode: "SETTLEMENT_SLA_EXCEEDED",
    message: "Settlement vencido",
    nextAction: "Revisar worker",
    worker: "mlb-auto-settlement",
    source: "MLB_LEDGER",
    evidenceConfidence: "AUTHORITATIVE",
    lastUpdatedAt: "2026-08-03T20:00:00.000Z",
    ageMinutes: 180,
    details: {},
  },
  {
    id: "2",
    league: "WNBA",
    gameId: "g-2",
    gameDate: "2026-08-03",
    commenceTime: "2026-08-03T23:30:00.000Z",
    homeTeam: "New York Liberty",
    awayTeam: "Las Vegas Aces",
    state: "GAME_IN_PROGRESS",
    severity: "INFO",
    reasonCode: "GAME_ACTIVE",
    message: "Juego activo",
    nextAction: "Esperar final",
    worker: "wnba-shadow-settlement",
    source: "WNBA_SHADOW",
    evidenceConfidence: "AUTHORITATIVE",
    lastUpdatedAt: "2026-08-03T23:00:00.000Z",
    ageMinutes: 30,
    details: {},
  },
];

test("filters operational incidents by league, state, severity and search", () => {
  assert.deepEqual(filterOperationalIncidents(incidents, {
    league: "MLB",
    state: "ALL",
    severity: "ALL",
    search: "",
  }).map((entry) => entry.id), ["1"]);

  assert.deepEqual(filterOperationalIncidents(incidents, {
    league: "ALL",
    state: "GAME_IN_PROGRESS",
    severity: "INFO",
    search: "liberty",
  }).map((entry) => entry.id), ["2"]);
});

test("labels are human-readable", () => {
  assert.equal(incidentStateLabel("WAITING_FOR_FINAL_CAPTURE"), "Falta captura FINAL");
  assert.equal(workerStateLabel("UNINSTRUMENTED"), "Sin heartbeat");
  assert.equal(operationalAgeLabel(0.2), "Actualizado ahora");
  assert.equal(operationalAgeLabel(90), "Hace 1.5 h");
});

test("safety validation fails closed", () => {
  assert.equal(operationalSafetyValid({
    mode: "OBSERVE_ONLY",
    readOnly: true,
    realFinancialExposure: 0,
    automaticBetPlacement: false,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    historicalLedgerMutation: false,
    automaticSettlementRetry: false,
  }), true);

  assert.equal(operationalSafetyValid({
    mode: "OBSERVE_ONLY",
    readOnly: true,
    realFinancialExposure: 1,
    automaticBetPlacement: false,
    automaticModelChangesAllowed: false,
    automaticPromotionAllowed: false,
    historicalLedgerMutation: false,
    automaticSettlementRetry: false,
  }), false);
});
