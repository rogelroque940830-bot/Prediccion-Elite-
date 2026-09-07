import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMlbR1bStatcastContactQualityHistorical,
  MLB_R1B_STATCAST_CONTACT_QUALITY_HISTORICAL_ADAPTER_VERSION,
  type MlbR1bStatcastTerminalBbeRow,
} from "./mlb-r1b-statcast-contact-quality-historical-adapter";

function row(overrides: Partial<MlbR1bStatcastTerminalBbeRow> = {}): MlbR1bStatcastTerminalBbeRow {
  return {
    gamePk: 1,
    atBatNumber: 1,
    pitchNumber: 1,
    pitcherId: 123,
    gameDate: "2025-05-01",
    description: "hit_into_play",
    launchSpeed: 100,
    launchSpeedAngle: 6,
    ...overrides,
  };
}

test("freezes exact count bridge while failing closed on production display parity", () => {
  const duplicate = row({ gamePk: 10, atBatNumber: 1, pitchNumber: 3, launchSpeed: 101, launchSpeedAngle: 6 });
  const result = buildMlbR1bStatcastContactQualityHistorical({
    targetDate: "2025-06-01",
    pitcherId: 123,
    rows: [
      duplicate,
      { ...duplicate },
      row({ gamePk: 11, atBatNumber: 2, pitchNumber: 4, launchSpeed: 95, launchSpeedAngle: 4 }),
      row({ gamePk: 12, atBatNumber: 3, pitchNumber: 2, launchSpeed: 88, launchSpeedAngle: 3 }),
      row({ gamePk: 13, atBatNumber: 4, pitchNumber: 2, description: "foul", launchSpeed: 105, launchSpeedAngle: 6 }),
      row({ gamePk: 14, atBatNumber: 5, pitchNumber: 1, gameDate: "2025-06-01", launchSpeed: 110, launchSpeedAngle: 6 }),
      row({ gamePk: 15, atBatNumber: 6, pitchNumber: 1, pitcherId: 999, launchSpeed: 111, launchSpeedAngle: 6 }),
    ],
  });

  assert.equal(result.adapterVersion, MLB_R1B_STATCAST_CONTACT_QUALITY_HISTORICAL_ADAPTER_VERSION);
  assert.equal(result.inputStage, "PREGAME");
  assert.equal(result.targetDatePolicy, "STRICTLY_PRIOR_GAME_DATE_ONLY");
  assert.equal(result.status, "COUNT_BRIDGE_EXACT_DISPLAY_PARITY_PENDING");
  assert.equal(result.countBridgeEligible, true);
  assert.equal(result.productionParityEligible, false);
  assert.deepEqual(result.values, {
    attempts: 3,
    ev95plus: 2,
    barrels: 1,
    hardHitPctCountDerived: 66.7,
    barrelPctCountDerived: 33.3,
  });
  assert.equal(result.diagnostics.inputRows, 7);
  assert.equal(result.diagnostics.pitcherRows, 6);
  assert.equal(result.diagnostics.priorDateRows, 5);
  assert.equal(result.diagnostics.uniqueTerminalBbeRows, 3);
  assert.equal(result.diagnostics.duplicateTerminalPitchRowsDropped, 1);
  assert.equal(result.diagnostics.nonHitIntoPlayRowsDropped, 1);
  assert.equal(result.diagnostics.targetDateOrFutureRowsDropped, 1);
  assert.equal(result.diagnostics.launchSpeedRows, 3);
  assert.equal(result.semanticContract.attempts, "EXACT_COUNT_BRIDGE_PROVEN");
  assert.equal(result.semanticContract.ev95plus, "EXACT_COUNT_BRIDGE_PROVEN_LAUNCH_SPEED_GTE_95");
  assert.equal(result.semanticContract.barrels, "EXACT_COUNT_BRIDGE_PROVEN_LAUNCH_SPEED_ANGLE_EQ_6");
  assert.equal(result.semanticContract.hardHitPct, "COUNT_DERIVED_ROUND_1_DISPLAY_EDGE_CASES_UNRESOLVED");
  assert.equal(result.semanticContract.xera, "OUT_OF_SCOPE_EXACT_ERA_SCALE_REQUIRED_SEPARATELY");
  assert.match(result.warnings[0], /five 2025 leaderboard display edge cases/i);
});

test("same-date and future evidence are structurally excluded before dedupe/counting", () => {
  const result = buildMlbR1bStatcastContactQualityHistorical({
    targetDate: "2025-07-04",
    pitcherId: "123",
    rows: [
      row({ gameDate: "2025-07-04", gamePk: 20 }),
      row({ gameDate: "2025-07-05", gamePk: 21 }),
    ],
  });

  assert.equal(result.status, "NO_PRIOR_BBE");
  assert.equal(result.countBridgeEligible, false);
  assert.equal(result.productionParityEligible, false);
  assert.deepEqual(result.values, {
    attempts: 0,
    ev95plus: 0,
    barrels: 0,
    hardHitPctCountDerived: null,
    barrelPctCountDerived: null,
  });
  assert.equal(result.diagnostics.targetDateOrFutureRowsDropped, 2);
});

test("missing canonical terminal-pitch identity fails closed", () => {
  assert.throws(
    () => buildMlbR1bStatcastContactQualityHistorical({
      targetDate: "2025-06-01",
      pitcherId: 123,
      rows: [row({ gamePk: "" })],
    }),
    /MLB_R1B_STATCAST_CONTACT_TERMINAL_IDENTITY_MISSING/,
  );
});

test("invalid target or source date fails closed", () => {
  assert.throws(
    () => buildMlbR1bStatcastContactQualityHistorical({
      targetDate: "2025-02-31",
      pitcherId: 123,
      rows: [],
    }),
    /MLB_R1B_STATCAST_CONTACT_TARGET_DATE_INVALID/,
  );

  assert.throws(
    () => buildMlbR1bStatcastContactQualityHistorical({
      targetDate: "2025-06-01",
      pitcherId: 123,
      rows: [row({ gameDate: "bad-date" })],
    }),
    /MLB_R1B_STATCAST_CONTACT_ROW_DATE_INVALID/,
  );
});
