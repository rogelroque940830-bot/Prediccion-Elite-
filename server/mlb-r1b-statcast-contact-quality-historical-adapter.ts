export const MLB_R1B_STATCAST_CONTACT_QUALITY_HISTORICAL_ADAPTER_VERSION =
  "mlb-r1b-statcast-contact-quality-historical-adapter-v1" as const;

export type MlbR1bStatcastContactQualitySemanticStatus =
  | "COUNT_BRIDGE_EXACT_DISPLAY_PARITY_PENDING"
  | "NO_PRIOR_BBE";

export interface MlbR1bStatcastTerminalBbeRow {
  gamePk: string | number;
  atBatNumber: string | number;
  pitchNumber: string | number;
  pitcherId: string | number;
  gameDate: string;
  description: string;
  launchSpeed: number | null;
  launchSpeedAngle: number | null;
}

export interface MlbR1bStatcastContactQualityHistoricalInput {
  targetDate: string;
  pitcherId: string | number;
  rows: readonly MlbR1bStatcastTerminalBbeRow[];
}

export interface MlbR1bStatcastContactQualityHistoricalResult {
  adapterVersion: typeof MLB_R1B_STATCAST_CONTACT_QUALITY_HISTORICAL_ADAPTER_VERSION;
  inputStage: "PREGAME";
  sourceAuthority: "BASEBALL_SAVANT_DATE_BOUNDED_RAW_BBE";
  targetDate: string;
  targetDatePolicy: "STRICTLY_PRIOR_GAME_DATE_ONLY";
  pitcherId: string;
  status: MlbR1bStatcastContactQualitySemanticStatus;
  countBridgeEligible: boolean;
  productionParityEligible: false;
  values: {
    attempts: number;
    ev95plus: number;
    barrels: number;
    hardHitPctCountDerived: number | null;
    barrelPctCountDerived: number | null;
  };
  diagnostics: {
    inputRows: number;
    pitcherRows: number;
    priorDateRows: number;
    uniqueTerminalBbeRows: number;
    duplicateTerminalPitchRowsDropped: number;
    nonHitIntoPlayRowsDropped: number;
    targetDateOrFutureRowsDropped: number;
    launchSpeedRows: number;
  };
  semanticContract: {
    attempts: "EXACT_COUNT_BRIDGE_PROVEN";
    ev95plus: "EXACT_COUNT_BRIDGE_PROVEN_LAUNCH_SPEED_GTE_95";
    barrels: "EXACT_COUNT_BRIDGE_PROVEN_LAUNCH_SPEED_ANGLE_EQ_6";
    hardHitPct: "COUNT_DERIVED_ROUND_1_DISPLAY_EDGE_CASES_UNRESOLVED";
    barrelPct: "COUNT_DERIVED_ROUND_1_NOT_USED_TO_CLAIM_FAMILY_PARITY";
    xera: "OUT_OF_SCOPE_EXACT_ERA_SCALE_REQUIRED_SEPARATELY";
  };
  warnings: readonly string[];
}

function assertIsoDate(value: string, code: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${code}:${value}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${code}:${value}`);
  }
}

function normalizeId(value: string | number): string {
  const out = String(value).trim();
  if (!out) throw new Error("MLB_R1B_STATCAST_CONTACT_PITCHER_ID_MISSING");
  return out;
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function terminalPitchIdentity(row: MlbR1bStatcastTerminalBbeRow): string | null {
  const gamePk = String(row.gamePk).trim();
  const atBat = String(row.atBatNumber).trim();
  const pitch = String(row.pitchNumber).trim();
  const pitcher = String(row.pitcherId).trim();
  if (!gamePk || !atBat || !pitch || !pitcher) return null;
  return `${gamePk}:${atBat}:${pitch}:${pitcher}`;
}

/**
 * Frozen R1B research-only adapter for date-bounded Statcast contact-quality custody.
 *
 * Proven semantics carried forward from the corrected 2025 raw-BBE parity probe:
 * - attempts = unique terminal hit-into-play rows;
 * - ev95plus = attempts with launch_speed >= 95 mph;
 * - barrels = attempts with launch_speed_angle === 6.
 *
 * The adapter deliberately does NOT claim production-equivalent `ev95percent` yet.
 * Five 2025 leaderboard display edge cases remain unresolved even though attempts and
 * ev95plus match exactly. Therefore the percentage is exposed only as a count-derived
 * diagnostic and `productionParityEligible` is hard-frozen to false.
 *
 * Pregame integrity is enforced inside the adapter: only rows with gameDate strictly
 * earlier than targetDate are admitted, so same-date completed-game evidence cannot leak
 * into a target-date feature even if an upstream query over-returns rows.
 */
export function buildMlbR1bStatcastContactQualityHistorical(
  input: MlbR1bStatcastContactQualityHistoricalInput,
): MlbR1bStatcastContactQualityHistoricalResult {
  assertIsoDate(input.targetDate, "MLB_R1B_STATCAST_CONTACT_TARGET_DATE_INVALID");
  const pitcherId = normalizeId(input.pitcherId);

  let pitcherRows = 0;
  let priorDateRows = 0;
  let nonHitIntoPlayRowsDropped = 0;
  let targetDateOrFutureRowsDropped = 0;
  let duplicateTerminalPitchRowsDropped = 0;
  const unique = new Map<string, MlbR1bStatcastTerminalBbeRow>();

  for (const row of input.rows) {
    if (String(row.pitcherId).trim() !== pitcherId) continue;
    pitcherRows++;
    assertIsoDate(row.gameDate, "MLB_R1B_STATCAST_CONTACT_ROW_DATE_INVALID");
    if (row.gameDate >= input.targetDate) {
      targetDateOrFutureRowsDropped++;
      continue;
    }
    priorDateRows++;
    if (!String(row.description ?? "").includes("hit_into_play")) {
      nonHitIntoPlayRowsDropped++;
      continue;
    }
    const identity = terminalPitchIdentity(row);
    if (!identity) {
      throw new Error("MLB_R1B_STATCAST_CONTACT_TERMINAL_IDENTITY_MISSING");
    }
    if (unique.has(identity)) {
      duplicateTerminalPitchRowsDropped++;
      continue;
    }
    unique.set(identity, row);
  }

  let ev95plus = 0;
  let barrels = 0;
  let launchSpeedRows = 0;
  for (const row of unique.values()) {
    if (typeof row.launchSpeed === "number" && Number.isFinite(row.launchSpeed)) {
      launchSpeedRows++;
      if (row.launchSpeed >= 95) ev95plus++;
    }
    if (row.launchSpeedAngle === 6) barrels++;
  }

  const attempts = unique.size;
  const hardHitPctCountDerived = attempts > 0 ? round1((100 * ev95plus) / attempts) : null;
  const barrelPctCountDerived = attempts > 0 ? round1((100 * barrels) / attempts) : null;
  const warnings = Object.freeze([
    "EV95PERCENT_DISPLAY_PARITY_NOT_PROVEN: count bridge is exact but five 2025 leaderboard display edge cases remain unresolved.",
    "XERA_NOT_DERIVED_HERE: exact Savant xERA/ERA-scale reconstruction is a separate mandatory gate.",
  ]);

  return Object.freeze({
    adapterVersion: MLB_R1B_STATCAST_CONTACT_QUALITY_HISTORICAL_ADAPTER_VERSION,
    inputStage: "PREGAME",
    sourceAuthority: "BASEBALL_SAVANT_DATE_BOUNDED_RAW_BBE",
    targetDate: input.targetDate,
    targetDatePolicy: "STRICTLY_PRIOR_GAME_DATE_ONLY",
    pitcherId,
    status: attempts > 0 ? "COUNT_BRIDGE_EXACT_DISPLAY_PARITY_PENDING" : "NO_PRIOR_BBE",
    countBridgeEligible: attempts > 0,
    productionParityEligible: false,
    values: Object.freeze({
      attempts,
      ev95plus,
      barrels,
      hardHitPctCountDerived,
      barrelPctCountDerived,
    }),
    diagnostics: Object.freeze({
      inputRows: input.rows.length,
      pitcherRows,
      priorDateRows,
      uniqueTerminalBbeRows: attempts,
      duplicateTerminalPitchRowsDropped,
      nonHitIntoPlayRowsDropped,
      targetDateOrFutureRowsDropped,
      launchSpeedRows,
    }),
    semanticContract: Object.freeze({
      attempts: "EXACT_COUNT_BRIDGE_PROVEN",
      ev95plus: "EXACT_COUNT_BRIDGE_PROVEN_LAUNCH_SPEED_GTE_95",
      barrels: "EXACT_COUNT_BRIDGE_PROVEN_LAUNCH_SPEED_ANGLE_EQ_6",
      hardHitPct: "COUNT_DERIVED_ROUND_1_DISPLAY_EDGE_CASES_UNRESOLVED",
      barrelPct: "COUNT_DERIVED_ROUND_1_NOT_USED_TO_CLAIM_FAMILY_PARITY",
      xera: "OUT_OF_SCOPE_EXACT_ERA_SCALE_REQUIRED_SEPARATELY",
    }),
    warnings,
  });
}
