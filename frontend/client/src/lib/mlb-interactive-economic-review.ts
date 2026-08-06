export const MLB_P1_M3D_SCHEMA = "courtedge-p1-m3d-interactive-economic-review.v1" as const;
export const MLB_P1_M3D_ENDPOINT = "/api/mlb/p1/v1/economic-review" as const;
export const MLB_P1_M3D_B_FRONTEND_RELEASE = "p1-m3d-b-interactive-economic-review-ui-2026-08-06" as const;

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
  release: string;
  endpoint: typeof MLB_P1_M3D_ENDPOINT;
  generatedAt: string;
  state: MlbP1M3dState;
  cohort: {
    source: "INTERACTIVE_MLB_PREDICTOR";
    ownerScoped: true;
    terminalSupersessionLeavesOnly: true;
    immutableLedgerSchema: "mlb-ledger.v1";
    minimumTechnicalSample: number;
    preliminaryReviewSample: number;
    preferredHumanReviewSample: number;
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

export interface MlbP1M3dEnvelope {
  success: true;
  data: MlbP1M3dReport;
  endpoint: typeof MLB_P1_M3D_ENDPOINT;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validMetricSummary(value: unknown): value is MlbP1M3dMetricSummary {
  const metric = record(value);
  return Boolean(metric)
    && nonNegativeInteger(metric?.observations)
    && nonNegativeInteger(metric?.settled)
    && nonNegativeInteger(metric?.pending)
    && nonNegativeInteger(metric?.wins)
    && nonNegativeInteger(metric?.losses)
    && nonNegativeInteger(metric?.pushesOrVoids)
    && typeof metric?.flatStakeExposureUnits === "number"
    && typeof metric?.flatStakeProfitUnits === "number"
    && typeof metric?.policyStakeExposureUnits === "number"
    && typeof metric?.policyStakeProfitUnits === "number";
}

export function parseMlbP1M3dEconomicReviewEnvelope(value: unknown): MlbP1M3dEnvelope {
  const envelope = record(value);
  const data = record(envelope?.data);
  const cohort = record(data?.cohort);
  const sample = record(data?.sample);
  const readiness = record(data?.readiness);
  const safety = record(data?.safety);
  const controls = record(data?.controls);
  const breakdowns = record(data?.breakdowns);

  const fail = (message: string): never => {
    throw new Error(`P1_M3D_B_INVALID_RESPONSE:${message}`);
  };

  if (envelope?.success !== true) fail("success");
  if (envelope?.endpoint !== MLB_P1_M3D_ENDPOINT) fail("envelope_endpoint");
  if (data?.schemaVersion !== MLB_P1_M3D_SCHEMA) fail("schema");
  if (data?.endpoint !== MLB_P1_M3D_ENDPOINT) fail("data_endpoint");
  if (typeof data?.generatedAt !== "string" || !Number.isFinite(Date.parse(data.generatedAt))) fail("generated_at");
  if (typeof data?.release !== "string" || !data.release.trim()) fail("release");
  if (![
    "WAITING_FOR_FIRST_SETTLEMENT",
    "TECHNICAL_SAMPLE_ONLY",
    "PRELIMINARY_REVIEW_ONLY",
    "COLLECTING_PREFERRED_SAMPLE",
    "READY_FOR_HUMAN_REVIEW",
    "ACTION_REQUIRED",
  ].includes(String(data?.state))) fail("state");

  if (cohort?.source !== "INTERACTIVE_MLB_PREDICTOR") fail("cohort_source");
  if (cohort?.ownerScoped !== true || cohort?.terminalSupersessionLeavesOnly !== true) fail("cohort_scope");
  if (cohort?.immutableLedgerSchema !== "mlb-ledger.v1") fail("ledger_schema");

  for (const key of [
    "ownedLedgerRecords",
    "interactiveLedgerRecords",
    "lifecycleChains",
    "terminalLeaves",
    "uniqueAnalyticalDecisions",
    "analyticalDuplicatesExcluded",
    "lifecycleBranchesExcluded",
    "malformedInteractiveRecordsExcluded",
    "economicLayersValid",
    "economicLayersInvalid",
    "settledDecisions",
    "pendingDecisions",
    "clvCoveredDecisions",
  ]) {
    if (!nonNegativeInteger(sample?.[key])) fail(`sample_${key}`);
  }

  if (!validMetricSummary(data?.overall)) fail("overall");
  if (!validMetricSummary(data?.economicallyActionable)) fail("economically_actionable");
  if (!validMetricSummary(controls?.acceptedSourceSignals)) fail("accepted_controls");
  if (!validMetricSummary(controls?.leanPassInfoControls)) fail("lean_pass_info_controls");

  for (const key of [
    "byMarket",
    "bySourceSignal",
    "byEffectiveDecision",
    "byActionability",
    "byStage",
    "byProbabilityBand",
  ]) {
    if (!Array.isArray(breakdowns?.[key])) fail(`breakdown_${key}`);
  }

  if (!Array.isArray(data?.issues) || !Array.isArray(data?.rows)) fail("collections");
  if (readiness?.conclusionsAllowed !== false) fail("conclusions_allowed");
  if (readiness?.automaticModelChangesAllowed !== false) fail("automatic_model_changes");
  if (readiness?.automaticPromotionAllowed !== false) fail("automatic_promotion");

  if (safety?.mode !== "SHADOW_ECONOMIC_REVIEW") fail("safety_mode");
  if (safety?.realFinancialExposure !== 0) fail("real_exposure");
  if (safety?.sportsbookIntegration !== false) fail("sportsbook");
  if (safety?.automaticBetPlacement !== false) fail("automatic_bet");
  if (safety?.productionWrites !== false || safety?.settlementWrites !== false) fail("writes");
  if (safety?.historicalLedgerMutation !== false) fail("historical_mutation");
  if (safety?.automaticModelChangesAllowed !== false) fail("safety_model_changes");
  if (safety?.automaticPromotionAllowed !== false) fail("safety_promotion");

  return value as MlbP1M3dEnvelope;
}
