import type { LedgerRecord, MlbLedgerStore } from "./mlb-ledger-store";
import {
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import {
  buildMlbShadowRows,
  type MlbShadowRow,
} from "./mlb-shadow-evaluation";
import { MLB_P1_M3A_SCHEMA } from "./mlb-p1-scientific-capture-contract";
import { MLB_P1_M4B_SCHEMA } from "./mlb-p1-economic-decision-adapter";
import {
  buildMlbP1M5aRealCohortActivation,
  type MlbP1M5aActivation,
} from "./mlb-p1-real-cohort-activation";

export const MLB_P1_M3D_SCHEMA = "courtedge-p1-m3d-interactive-economic-review.v1" as const;
export const MLB_P1_M3D_ENDPOINT = "/api/mlb/p1/v1/economic-review" as const;
export const MLB_P1_M3D_RELEASE = "p1-m3d-interactive-economic-review-2026-08-06" as const;

export type MlbP1M3dState =
  | "WAITING_FOR_FIRST_SETTLEMENT"
  | "TECHNICAL_SAMPLE_ONLY"
  | "PRELIMINARY_REVIEW_ONLY"
  | "COLLECTING_PREFERRED_SAMPLE"
  | "READY_FOR_HUMAN_REVIEW"
  | "ACTION_REQUIRED";

export type MlbP1M3dEconomicDecision = "BET" | "LEAN" | "PASS";
export type MlbP1M3dActionability = "ACTIONABLE_FINAL" | "WAIT_FOR_FINAL" | "OBSERVE_ONLY" | "BLOCKED";

export interface MlbP1M3dMetricSummary {
  observations: number;
  settled: number;
  pending: number;
  wins: number;
  losses: number;
  pushesOrVoids: number;
  hitRatePct: number | null;
  flatStakeExposureUnits: number;
  flatStakeProfitUnits: number;
  flatStakeRoiPct: number | null;
  policyStakeExposureUnits: number;
  policyStakeProfitUnits: number;
  policyStakeRoiPct: number | null;
  brierScore: number | null;
  logLoss: number | null;
  meanModelProbability: number | null;
  observedWinRate: number | null;
  winRateWilson95: { low: number; high: number } | null;
  meanMarketImpliedProbability: number | null;
  meanEdgePp: number | null;
  clvAvailable: number;
  clvCoveragePct: number | null;
  meanClvPp: number | null;
  medianClvPp: number | null;
}

export interface MlbP1M3dReviewRow {
  predictionId: string;
  lifecycleKey: string;
  recordedAt: string;
  gameDate: string;
  gamePk: number | null;
  homeTeam: string;
  awayTeam: string;
  market: string;
  selection: string;
  line: number | null;
  oddsAmerican: number;
  closingOddsAmerican: number | null;
  stage: string;
  sourceSignal: string;
  sourceCategory: string;
  disposition: "ACCEPTED" | "BLOCKED" | "OBSERVED";
  effectiveDecision: MlbP1M3dEconomicDecision | null;
  actionability: MlbP1M3dActionability | null;
  effectiveAnalyticalUnits: number;
  economicLayerValid: boolean;
  economicLayerErrors: string[];
  modelProbability: number;
  marketImpliedProbability: number | null;
  noVigProbability: number | null;
  edgePp: number | null;
  result: string | null;
  settledAt: string | null;
  flatProfitUnits: number;
  policyProfitUnits: number;
  brierScore: number | null;
  logLoss: number | null;
  clvPp: number | null;
  dataQualityCoveragePct: number;
  dataQualityMissing: string[];
}

export interface MlbP1M3dBreakdown {
  key: string;
  metrics: MlbP1M3dMetricSummary;
}

export interface MlbP1M3dReport {
  schemaVersion: typeof MLB_P1_M3D_SCHEMA;
  release: typeof MLB_P1_M3D_RELEASE;
  endpoint: typeof MLB_P1_M3D_ENDPOINT;
  generatedAt: string;
  state: MlbP1M3dState;
  cohort: {
    source: "INTERACTIVE_MLB_PREDICTOR";
    ownerScoped: true;
    terminalSupersessionLeavesOnly: true;
    immutableLedgerSchema: "mlb-ledger.v1";
    minimumTechnicalSample: 5;
    preliminaryReviewSample: 20;
    preferredHumanReviewSample: 50;
  };
  sample: {
    ownedLedgerRecords: number;
    interactiveLedgerRecords: number;
    lifecycleChains: number;
    terminalLeaves: number;
    uniqueAnalyticalDecisions: number;
    analyticalDuplicatesExcluded: number;
    lifecycleBranchesExcluded: number;
    malformedInteractiveRecordsExcluded: number;
    economicLayersValid: number;
    economicLayersInvalid: number;
    settledDecisions: number;
    pendingDecisions: number;
    clvCoveredDecisions: number;
    exclusionCounts: Record<string, number>;
  };
  overall: MlbP1M3dMetricSummary;
  economicallyActionable: MlbP1M3dMetricSummary;
  controls: {
    acceptedSourceSignals: MlbP1M3dMetricSummary;
    leanPassInfoControls: MlbP1M3dMetricSummary;
  };
  breakdowns: {
    byMarket: MlbP1M3dBreakdown[];
    bySourceSignal: MlbP1M3dBreakdown[];
    byEffectiveDecision: MlbP1M3dBreakdown[];
    byActionability: MlbP1M3dBreakdown[];
    byStage: MlbP1M3dBreakdown[];
    byProbabilityBand: MlbP1M3dBreakdown[];
  };
  lifecycle: {
    provisionalToFinalChains: number;
    finalOnlyChains: number;
    provisionalOnlyChains: number;
  };
  activation: MlbP1M5aActivation;
  readiness: {
    firstSettlementReached: boolean;
    technicalFiveReached: boolean;
    preliminaryTwentyReached: boolean;
    preferredFiftyReached: boolean;
    humanReviewAvailable: boolean;
    conclusionsAllowed: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
    recommendation: "KEEP_COLLECTING_INTERACTIVE_SHADOW_EVIDENCE" | "HUMAN_REVIEW_ONLY_NO_AUTOMATIC_CHANGE";
  };
  methodology: {
    flatAccounting: string;
    policyAccounting: string;
    properScoring: string;
    clvAccounting: string;
    revisions: string;
    controlsRetained: true;
  };
  issues: Array<{ code: string; severity: "INFO" | "WARNING" | "CRITICAL"; message: string }>;
  rows: MlbP1M3dReviewRow[];
  safety: {
    mode: "SHADOW_ECONOMIC_REVIEW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    settlementWrites: false;
    historicalLedgerMutation: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

type EconomicLayer = {
  schemaVersion?: unknown;
  status?: unknown;
  effectiveDecision?: {
    decision?: unknown;
    actionability?: unknown;
    analyticalUnits?: unknown;
  };
  safety?: {
    mode?: unknown;
    realFinancialExposure?: unknown;
    automaticBetPlacement?: unknown;
    sportsbookIntegration?: unknown;
    automaticModelChangesAllowed?: unknown;
    automaticPromotionAllowed?: unknown;
  };
};

type InteractiveRecord = {
  record: LedgerRecord;
  lifecycleKey: string;
};

const ECONOMIC_DECISIONS = new Set<MlbP1M3dEconomicDecision>(["BET", "LEAN", "PASS"]);
const ACTIONABILITY = new Set<MlbP1M3dActionability>([
  "ACTIONABLE_FINAL",
  "WAIT_FOR_FINAL",
  "OBSERVE_ONLY",
  "BLOCKED",
]);

function object(value: unknown): Record<string, any> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function wilson95(wins: number, total: number): { low: number; high: number } | null {
  if (total <= 0) return null;
  const z = 1.959963984540054;
  const probability = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (probability + (z * z) / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (probability * (1 - probability) + (z * z) / (4 * total)) / total,
  ) / denominator;
  return {
    low: round(Math.max(0, center - margin)),
    high: round(Math.min(1, center + margin)),
  };
}

function p1M3aLayer(record: LedgerRecord): Record<string, any> | null {
  const payload = object(record.prediction.payload);
  const analysis = object(payload?.analysis);
  const layers = object(analysis?.layers);
  return object(layers?.p1M3aCapture);
}

function p1M4bLayer(record: LedgerRecord): EconomicLayer | null {
  const payload = object(record.prediction.payload);
  const analysis = object(payload?.analysis);
  const layers = object(analysis?.layers);
  return object(layers?.p1M4bEconomicDecision) as EconomicLayer | null;
}

function interactiveRecord(record: LedgerRecord): InteractiveRecord | null {
  const layer = p1M3aLayer(record);
  const origin = object(layer?.origin);
  const identity = object(layer?.identity);
  const lifecycleKey = typeof identity?.lifecycleKey === "string" ? identity.lifecycleKey.trim() : "";
  if (
    layer?.schemaVersion !== MLB_P1_M3A_SCHEMA
    || origin?.channel !== "INTERACTIVE_MLB_PREDICTOR"
    || !lifecycleKey
  ) return null;
  return { record, lifecycleKey };
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function terminalInteractiveRecords(records: LedgerRecord[]): {
  terminals: InteractiveRecord[];
  lifecycleChains: number;
  branchesExcluded: number;
  malformedExcluded: number;
  provisionalToFinalChains: number;
  finalOnlyChains: number;
  provisionalOnlyChains: number;
  exclusions: Record<string, number>;
} {
  const exclusions: Record<string, number> = {};
  const interactive: InteractiveRecord[] = [];
  let malformedExcluded = 0;
  for (const record of records) {
    const payload = object(record.prediction.payload);
    const layers = object(object(payload?.analysis)?.layers);
    if (!layers?.p1M3aCapture) continue;
    const parsed = interactiveRecord(record);
    if (!parsed) {
      malformedExcluded += 1;
      increment(exclusions, "MALFORMED_INTERACTIVE_CAPTURE");
      continue;
    }
    interactive.push(parsed);
  }

  const groups = new Map<string, InteractiveRecord[]>();
  for (const entry of interactive) {
    const values = groups.get(entry.lifecycleKey) ?? [];
    values.push(entry);
    groups.set(entry.lifecycleKey, values);
  }

  const terminals: InteractiveRecord[] = [];
  let branchesExcluded = 0;
  let provisionalToFinalChains = 0;
  let finalOnlyChains = 0;
  let provisionalOnlyChains = 0;

  for (const values of groups.values()) {
    values.sort((left, right) => left.record.prediction.recordedAtMs - right.record.prediction.recordedAtMs
      || left.record.prediction.id.localeCompare(right.record.prediction.id));
    const ids = new Set(values.map((entry) => entry.record.prediction.id));
    const parentIds = new Set(
      values
        .map((entry) => entry.record.prediction.supersedesId)
        .filter((id): id is string => Boolean(id && ids.has(id))),
    );
    const leaves = values.filter((entry) => !parentIds.has(entry.record.prediction.id));
    if (leaves.length !== 1) {
      branchesExcluded += 1;
      increment(exclusions, "BRANCHED_OR_MISSING_LIFECYCLE_LEAF");
      continue;
    }
    const hasProvisional = values.some((entry) => entry.record.prediction.analysisStage === "PROVISIONAL");
    const hasFinal = values.some((entry) => entry.record.prediction.analysisStage === "FINAL");
    if (hasProvisional && hasFinal) provisionalToFinalChains += 1;
    else if (hasFinal) finalOnlyChains += 1;
    else provisionalOnlyChains += 1;
    terminals.push(leaves[0]);
  }

  return {
    terminals,
    lifecycleChains: groups.size,
    branchesExcluded,
    malformedExcluded,
    provisionalToFinalChains,
    finalOnlyChains,
    provisionalOnlyChains,
    exclusions,
  };
}

function economicInterpretation(record: LedgerRecord): {
  valid: boolean;
  decision: MlbP1M3dEconomicDecision | null;
  actionability: MlbP1M3dActionability | null;
  units: number;
  errors: string[];
} {
  const layer = p1M4bLayer(record);
  const errors: string[] = [];
  if (!layer) errors.push("P1_M4B_LAYER_MISSING");
  if (layer?.schemaVersion !== MLB_P1_M4B_SCHEMA) errors.push("P1_M4B_SCHEMA_INVALID");
  if (layer?.status !== "ADAPTED") errors.push("P1_M4B_STATUS_NOT_ADAPTED");

  const decisionValue = layer?.effectiveDecision?.decision;
  const actionabilityValue = layer?.effectiveDecision?.actionability;
  const units = finite(layer?.effectiveDecision?.analyticalUnits);
  const decision = ECONOMIC_DECISIONS.has(decisionValue as MlbP1M3dEconomicDecision)
    ? decisionValue as MlbP1M3dEconomicDecision
    : null;
  const actionability = ACTIONABILITY.has(actionabilityValue as MlbP1M3dActionability)
    ? actionabilityValue as MlbP1M3dActionability
    : null;
  if (!decision) errors.push("EFFECTIVE_DECISION_INVALID");
  if (!actionability) errors.push("ACTIONABILITY_INVALID");
  if (units == null || units < 0 || units > 1) errors.push("EFFECTIVE_UNITS_INVALID");
  if (units != null && units > 0 && (decision !== "BET" || actionability !== "ACTIONABLE_FINAL")) {
    errors.push("NON_ACTIONABLE_EFFECTIVE_UNITS_NONZERO");
  }

  const safety = layer?.safety;
  if (safety?.mode !== "SHADOW_DECISION_SUPPORT") errors.push("P1_M4B_SAFETY_MODE_INVALID");
  if (safety?.realFinancialExposure !== 0) errors.push("P1_M4B_REAL_EXPOSURE_NONZERO");
  if (safety?.automaticBetPlacement !== false) errors.push("P1_M4B_AUTOMATIC_BETTING_ENABLED");
  if (safety?.sportsbookIntegration !== false) errors.push("P1_M4B_SPORTSBOOK_ENABLED");
  if (safety?.automaticModelChangesAllowed !== false) errors.push("P1_M4B_MODEL_CHANGES_ENABLED");
  if (safety?.automaticPromotionAllowed !== false) errors.push("P1_M4B_PROMOTION_ENABLED");

  return {
    valid: errors.length === 0,
    decision,
    actionability,
    units: errors.length === 0 ? units as number : 0,
    errors,
  };
}

function probabilityBand(probability: number): string {
  if (probability < 0.55) return "P_LT_55";
  if (probability < 0.60) return "P_55_60";
  if (probability < 0.65) return "P_60_65";
  if (probability < 0.70) return "P_65_70";
  return "P_GE_70";
}

function reviewRows(terminals: InteractiveRecord[]): {
  rows: MlbP1M3dReviewRow[];
  duplicatesExcluded: number;
} {
  const byId = new Map(terminals.map((entry) => [entry.record.prediction.id, entry]));
  const shadowRows = buildMlbShadowRows(terminals.map((entry) => entry.record));
  const rows = shadowRows.map((shadow): MlbP1M3dReviewRow => {
    const interactive = byId.get(shadow.predictionId);
    if (!interactive) throw new Error(`P1_M3D_TERMINAL_RECORD_MISSING:${shadow.predictionId}`);
    const record = interactive.record;
    const economic = economicInterpretation(record);
    const policyProfitUnits = economic.units > 0 ? round(shadow.flatProfitUnits * economic.units, 6) : 0;
    return {
      predictionId: shadow.predictionId,
      lifecycleKey: interactive.lifecycleKey,
      recordedAt: shadow.recordedAt,
      gameDate: shadow.gameDate,
      gamePk: shadow.gamePk,
      homeTeam: shadow.homeTeam,
      awayTeam: shadow.awayTeam,
      market: shadow.marketType,
      selection: shadow.selection,
      line: shadow.line,
      oddsAmerican: shadow.oddsAmerican,
      closingOddsAmerican: finite(record.settlement?.closingOddsAmerican),
      stage: shadow.analysisStage,
      sourceSignal: shadow.signal,
      sourceCategory: shadow.category,
      disposition: shadow.disposition,
      effectiveDecision: economic.decision,
      actionability: economic.actionability,
      effectiveAnalyticalUnits: economic.units,
      economicLayerValid: economic.valid,
      economicLayerErrors: economic.errors,
      modelProbability: shadow.modelProbability,
      marketImpliedProbability: shadow.marketImpliedProbability,
      noVigProbability: finite(record.prediction.probabilities.noVig),
      edgePp: shadow.edgePp,
      result: shadow.result,
      settledAt: shadow.settledAt,
      flatProfitUnits: shadow.flatProfitUnits,
      policyProfitUnits,
      brierScore: shadow.brierScore,
      logLoss: shadow.logLoss,
      clvPp: shadow.clvPp,
      dataQualityCoveragePct: shadow.dataQuality.coveragePct,
      dataQualityMissing: shadow.dataQuality.missing,
    };
  });
  return {
    rows,
    duplicatesExcluded: Math.max(0, terminals.length - shadowRows.length),
  };
}

function summarize(rows: MlbP1M3dReviewRow[]): MlbP1M3dMetricSummary {
  const settled = rows.filter((row) => row.result != null);
  const binary = settled.filter((row) => row.brierScore != null && row.logLoss != null);
  const wins = settled.filter((row) => row.result === "WIN" || row.result === "HALF_WIN").length;
  const losses = settled.filter((row) => row.result === "LOSS" || row.result === "HALF_LOSS").length;
  const pushesOrVoids = settled.length - wins - losses;
  const flatProfit = settled.reduce((sum, row) => sum + row.flatProfitUnits, 0);
  const flatExposure = settled.length;
  const policyRows = settled.filter((row) => row.effectiveAnalyticalUnits > 0);
  const policyExposure = policyRows.reduce((sum, row) => sum + row.effectiveAnalyticalUnits, 0);
  const policyProfit = policyRows.reduce((sum, row) => sum + row.policyProfitUnits, 0);
  const clv = settled.map((row) => row.clvPp).filter((value): value is number => value != null);
  const scoredWins = binary.filter((row) => row.result === "WIN").length;
  const modelProbabilities = binary.map((row) => row.modelProbability);
  const implied = rows.map((row) => row.marketImpliedProbability).filter((value): value is number => value != null);
  const edges = rows.map((row) => row.edgePp).filter((value): value is number => value != null);
  return {
    observations: rows.length,
    settled: settled.length,
    pending: rows.length - settled.length,
    wins,
    losses,
    pushesOrVoids,
    hitRatePct: wins + losses ? round((wins / (wins + losses)) * 100, 2) : null,
    flatStakeExposureUnits: round(flatExposure, 4),
    flatStakeProfitUnits: round(flatProfit, 4),
    flatStakeRoiPct: flatExposure ? round((flatProfit / flatExposure) * 100, 4) : null,
    policyStakeExposureUnits: round(policyExposure, 4),
    policyStakeProfitUnits: round(policyProfit, 4),
    policyStakeRoiPct: policyExposure ? round((policyProfit / policyExposure) * 100, 4) : null,
    brierScore: binary.length ? round(average(binary.map((row) => row.brierScore as number)) as number) : null,
    logLoss: binary.length ? round(average(binary.map((row) => row.logLoss as number)) as number) : null,
    meanModelProbability: modelProbabilities.length ? round(average(modelProbabilities) as number) : null,
    observedWinRate: binary.length ? round(scoredWins / binary.length) : null,
    winRateWilson95: wilson95(scoredWins, binary.length),
    meanMarketImpliedProbability: implied.length ? round(average(implied) as number) : null,
    meanEdgePp: edges.length ? round(average(edges) as number, 4) : null,
    clvAvailable: clv.length,
    clvCoveragePct: settled.length ? round((clv.length / settled.length) * 100, 2) : null,
    meanClvPp: clv.length ? round(average(clv) as number, 4) : null,
    medianClvPp: clv.length ? round(median(clv) as number, 4) : null,
  };
}

function breakdown(rows: MlbP1M3dReviewRow[], keyFor: (row: MlbP1M3dReviewRow) => string): MlbP1M3dBreakdown[] {
  const groups = new Map<string, MlbP1M3dReviewRow[]>();
  for (const row of rows) {
    const key = keyFor(row) || "UNKNOWN";
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  return Array.from(groups.entries())
    .map(([key, values]) => ({ key, metrics: summarize(values) }))
    .sort((left, right) => right.metrics.settled - left.metrics.settled
      || right.metrics.observations - left.metrics.observations
      || left.key.localeCompare(right.key));
}

function stateFor(settled: number, critical: boolean): MlbP1M3dState {
  if (critical) return "ACTION_REQUIRED";
  if (settled === 0) return "WAITING_FOR_FIRST_SETTLEMENT";
  if (settled < 5) return "TECHNICAL_SAMPLE_ONLY";
  if (settled < 20) return "PRELIMINARY_REVIEW_ONLY";
  if (settled < 50) return "COLLECTING_PREFERRED_SAMPLE";
  return "READY_FOR_HUMAN_REVIEW";
}

export function buildMlbP1M3dEconomicReview(
  records: LedgerRecord[],
  options: { generatedAt?: string } = {},
): MlbP1M3dReport {
  const terminal = terminalInteractiveRecords(records);
  const built = reviewRows(terminal.terminals);
  const rows = built.rows;
  const overall = summarize(rows);
  const economicValid = rows.filter((row) => row.economicLayerValid).length;
  const economicInvalid = rows.length - economicValid;
  const exclusions = { ...terminal.exclusions };
  if (built.duplicatesExcluded) increment(exclusions, "ANALYTICAL_DUPLICATE", built.duplicatesExcluded);
  if (economicInvalid) increment(exclusions, "P1_M4B_LAYER_INVALID", economicInvalid);

  const issues: MlbP1M3dReport["issues"] = [];
  if (terminal.branchesExcluded > 0) {
    issues.push({
      code: "INTERACTIVE_LIFECYCLE_BRANCH_CONFLICT",
      severity: "CRITICAL",
      message: `${terminal.branchesExcluded} interactive lifecycle(s) have zero or multiple terminal leaves and were excluded.`,
    });
  }
  if (economicInvalid > 0) {
    issues.push({
      code: "ECONOMIC_LAYER_COVERAGE_INCOMPLETE",
      severity: "WARNING",
      message: `${economicInvalid} terminal capture(s) have an invalid or missing P1-M4B layer; policy ROI excludes their units.`,
    });
  }
  if (overall.settled === 0) {
    issues.push({
      code: "NO_INTERACTIVE_SETTLEMENTS_YET",
      severity: "INFO",
      message: "No unique terminal interactive capture has an official settlement yet.",
    });
  } else if (overall.settled < 20) {
    issues.push({
      code: "INTERACTIVE_SAMPLE_BELOW_PRELIMINARY_REVIEW",
      severity: "INFO",
      message: `${overall.settled} settled interactive decisions are available; 20 are required for a preliminary descriptive review.`,
    });
  } else if (overall.settled < 50) {
    issues.push({
      code: "INTERACTIVE_PREFERRED_SAMPLE_PENDING",
      severity: "INFO",
      message: `${overall.settled} settled interactive decisions are available; 50 are preferred before formal human review.`,
    });
  }

  const critical = issues.some((issue) => issue.severity === "CRITICAL");
  const state = stateFor(overall.settled, critical);
  const humanReviewAvailable = state === "READY_FOR_HUMAN_REVIEW";
  const acceptedRows = rows.filter((row) => row.sourceSignal === "BET" || row.sourceSignal === "BET_FUERTE");
  const controlRows = rows.filter((row) => !acceptedRows.includes(row));
  const actionableRows = rows.filter((row) => row.economicLayerValid
    && row.effectiveDecision === "BET"
    && row.actionability === "ACTIONABLE_FINAL");
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const activation = buildMlbP1M5aRealCohortActivation({
    generatedAt,
    rows,
    ownerScoped: true,
    terminalSupersessionLeavesOnly: true,
    lifecycleChains: terminal.lifecycleChains,
    terminalLeaves: terminal.terminals.length,
    analyticalDuplicatesExcluded: built.duplicatesExcluded,
    lifecycleBranchesExcluded: terminal.branchesExcluded,
    malformedInteractiveRecordsExcluded: terminal.malformedExcluded,
  });

  return {
    schemaVersion: MLB_P1_M3D_SCHEMA,
    release: MLB_P1_M3D_RELEASE,
    endpoint: MLB_P1_M3D_ENDPOINT,
    generatedAt,
    state,
    cohort: {
      source: "INTERACTIVE_MLB_PREDICTOR",
      ownerScoped: true,
      terminalSupersessionLeavesOnly: true,
      immutableLedgerSchema: "mlb-ledger.v1",
      minimumTechnicalSample: 5,
      preliminaryReviewSample: 20,
      preferredHumanReviewSample: 50,
    },
    sample: {
      ownedLedgerRecords: records.length,
      interactiveLedgerRecords: records.filter((record) => Boolean(p1M3aLayer(record))).length,
      lifecycleChains: terminal.lifecycleChains,
      terminalLeaves: terminal.terminals.length,
      uniqueAnalyticalDecisions: rows.length,
      analyticalDuplicatesExcluded: built.duplicatesExcluded,
      lifecycleBranchesExcluded: terminal.branchesExcluded,
      malformedInteractiveRecordsExcluded: terminal.malformedExcluded,
      economicLayersValid: economicValid,
      economicLayersInvalid: economicInvalid,
      settledDecisions: overall.settled,
      pendingDecisions: overall.pending,
      clvCoveredDecisions: overall.clvAvailable,
      exclusionCounts: exclusions,
    },
    overall,
    economicallyActionable: summarize(actionableRows),
    controls: {
      acceptedSourceSignals: summarize(acceptedRows),
      leanPassInfoControls: summarize(controlRows),
    },
    breakdowns: {
      byMarket: breakdown(rows, (row) => row.market),
      bySourceSignal: breakdown(rows, (row) => row.sourceSignal),
      byEffectiveDecision: breakdown(rows, (row) => row.effectiveDecision ?? "INVALID_P1_M4B"),
      byActionability: breakdown(rows, (row) => row.actionability ?? "INVALID_P1_M4B"),
      byStage: breakdown(rows, (row) => row.stage),
      byProbabilityBand: breakdown(rows, (row) => probabilityBand(row.modelProbability)),
    },
    lifecycle: {
      provisionalToFinalChains: terminal.provisionalToFinalChains,
      finalOnlyChains: terminal.finalOnlyChains,
      provisionalOnlyChains: terminal.provisionalOnlyChains,
    },
    activation,
    readiness: {
      firstSettlementReached: overall.settled >= 1,
      technicalFiveReached: overall.settled >= 5,
      preliminaryTwentyReached: overall.settled >= 20,
      preferredFiftyReached: overall.settled >= 50,
      humanReviewAvailable,
      conclusionsAllowed: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
      recommendation: humanReviewAvailable
        ? "HUMAN_REVIEW_ONLY_NO_AUTOMATIC_CHANGE"
        : "KEEP_COLLECTING_INTERACTIVE_SHADOW_EVIDENCE",
    },
    methodology: {
      flatAccounting: "Every settled unique terminal interactive decision is simulated at one unit using its saved pregame American odds.",
      policyAccounting: "Only a valid P1-M4B ACTIONABLE_FINAL BET contributes its bounded SHADOW analytical units; no wager is placed.",
      properScoring: "Brier score and natural-log loss reuse the S5B immutable settlement classification and pregame model probability.",
      clvAccounting: "CLV is read only from append-only settlement evidence when a comparable closing price exists.",
      revisions: "Only the single terminal leaf of each P1-M3A lifecycle is evaluated; superseded revisions do not inflate the sample.",
      controlsRetained: true,
    },
    issues,
    rows: rows
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)
        || left.predictionId.localeCompare(right.predictionId))
      .slice(0, 500),
    safety: {
      mode: "SHADOW_ECONOMIC_REVIEW",
      realFinancialExposure: 0,
      sportsbookIntegration: false,
      automaticBetPlacement: false,
      productionWrites: false,
      settlementWrites: false,
      historicalLedgerMutation: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}

export class MlbP1EconomicReviewService {
  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  review(userId: number): MlbP1M3dReport {
    const records = ownedRecordsForUser(this.store, this.ownershipStore, userId, { limit: 10_000 });
    return buildMlbP1M3dEconomicReview(records, { generatedAt: this.now().toISOString() });
  }
}
