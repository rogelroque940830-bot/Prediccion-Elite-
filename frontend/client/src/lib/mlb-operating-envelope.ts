export const MLB_P1_M3E_SCHEMA = "courtedge-p1-m3e-operating-envelope.v1" as const;
export const MLB_P1_M3E_ENDPOINT = "/api/mlb/p1/v1/operating-envelope" as const;
export const MLB_P1_M3E_FRONTEND_RELEASE = "p1-m3e-operating-envelope-ui-2026-08-07" as const;

export type MlbP1M3eState =
  | "INSUFFICIENT_SAMPLE"
  | "NO_DISCOVERY_RULE"
  | "CANDIDATE_NOT_CONFIRMED"
  | "ELITE_MODEL_QUALITY_SUPPORTED";

export type MlbP1M3eAtom =
  | { kind: "MARKET_IS"; value: "ML" | "F5_ML" | "RUN_LINE" | "TOTAL" | "F5_TOTAL" }
  | { kind: "STAGE_IS_FINAL" }
  | { kind: "SIGNAL_IS"; value: "BET_FUERTE" | "BET" }
  | { kind: "CATEGORY_IS"; value: "ELITE" | "PREMIUM" }
  | { kind: "ACTIONABILITY_IS_FINAL" }
  | { kind: "ECONOMIC_LAYER_VALID" }
  | { kind: "MODEL_PROBABILITY_AT_LEAST"; value: number }
  | { kind: "EDGE_PP_AT_LEAST"; value: number }
  | { kind: "NO_VIG_EDGE_PP_AT_LEAST"; value: number }
  | { kind: "DATA_QUALITY_AT_LEAST"; value: number }
  | { kind: "NO_DATA_QUALITY_MISSING" }
  | { kind: "MARKET_IMPLIED_AT_LEAST"; value: number }
  | { kind: "MARKET_IMPLIED_AT_MOST"; value: number };

export interface MlbP1M3eRule {
  atoms: MlbP1M3eAtom[];
  ruleKey: string;
}

export interface MlbP1M3eMetricSummary {
  observations: number;
  dates: number;
  wins: number;
  losses: number;
  meanModelProbability: number | null;
  observedWinRate: number | null;
  calibrationGap: number | null;
  meanLogLoss: number | null;
  meanBrierScore: number | null;
  flatStakeRoiPct: number | null;
  clvAvailable: number;
  meanClvPp: number | null;
}

export interface MlbP1M3eComparison {
  selected: MlbP1M3eMetricSummary;
  rejected: MlbP1M3eMetricSummary;
  coveragePct: number;
  rejectedCoveragePct: number;
  rejectedMinusSelectedLogLoss: number | null;
  rejectedMinusSelectedBrier: number | null;
}

export interface MlbP1M3eBootstrapInterval {
  confidenceLevel: 0.95;
  replicatesRequested: number;
  replicatesUsed: number;
  pointEstimate: number;
  lower: number;
  upper: number;
}

export interface MlbP1M3eConfirmationInference {
  dateClusters: number;
  selectedDateClusters: number;
  rejectedDateClusters: number;
  logLossImprovement: MlbP1M3eBootstrapInterval | null;
  brierImprovement: MlbP1M3eBootstrapInterval | null;
  calibrationAccepted: boolean;
  minimumCoverageAccepted: boolean;
  minimumSampleAccepted: boolean;
}

export interface MlbP1M3eReport {
  schemaVersion: typeof MLB_P1_M3E_SCHEMA;
  generatedAt: string;
  state: MlbP1M3eState;
  configuration: {
    discoveryDateFraction: number;
    minimumTotalObservations: number;
    minimumTotalDates: number;
    minimumDiscoverySelected: number;
    minimumDiscoveryRejected: number;
    minimumConfirmationSelected: number;
    minimumConfirmationRejected: number;
    minimumConfirmationSelectedDates: number;
    minimumConfirmationCoveragePct: number;
    maximumRuleAtoms: 2;
    bootstrapReplicates: number;
    candidateAtomCount: number;
    candidateRuleCount: number;
  };
  cohort: {
    inputRows: number;
    scoreableRows: number;
    excludedRows: number;
    uniqueDates: number;
  };
  temporalSplit: {
    leakageFree: boolean;
    discoveryMinDate: string | null;
    discoveryMaxDate: string | null;
    confirmationMinDate: string | null;
    confirmationMaxDate: string | null;
    discoveryRows: number;
    confirmationRows: number;
    discoveryDates: number;
    confirmationDates: number;
  };
  selectedRule: MlbP1M3eRule | null;
  discovery: MlbP1M3eComparison | null;
  confirmation: MlbP1M3eComparison | null;
  confirmationInference: MlbP1M3eConfirmationInference | null;
  interpretation: {
    modelQualityOperatingEnvelopeSupported: boolean;
    economicProfitabilityCertified: false;
    operationalGateAllowed: false;
    modelProbabilityChanged: false;
    existingEconomicThresholdsChanged: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
  blockers: string[];
}

export interface MlbP1M3eEnvelope {
  success: true;
  data: MlbP1M3eReport;
  endpoint: typeof MLB_P1_M3E_ENDPOINT;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}

function finiteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function validMetricSummary(value: unknown): value is MlbP1M3eMetricSummary {
  const metric = record(value);
  if (!metric) return false;
  for (const key of ["observations", "dates", "wins", "losses", "clvAvailable"]) {
    if (!nonNegativeInteger(metric[key])) return false;
  }
  for (const key of [
    "meanModelProbability",
    "observedWinRate",
    "calibrationGap",
    "meanLogLoss",
    "meanBrierScore",
    "flatStakeRoiPct",
    "meanClvPp",
  ]) {
    if (!finiteOrNull(metric[key])) return false;
  }
  return true;
}

function validComparison(value: unknown): value is MlbP1M3eComparison {
  const comparison = record(value);
  return Boolean(comparison)
    && validMetricSummary(comparison?.selected)
    && validMetricSummary(comparison?.rejected)
    && typeof comparison?.coveragePct === "number"
    && Number.isFinite(comparison.coveragePct)
    && typeof comparison?.rejectedCoveragePct === "number"
    && Number.isFinite(comparison.rejectedCoveragePct)
    && finiteOrNull(comparison?.rejectedMinusSelectedLogLoss)
    && finiteOrNull(comparison?.rejectedMinusSelectedBrier);
}

function validInterval(value: unknown): value is MlbP1M3eBootstrapInterval {
  const interval = record(value);
  return Boolean(interval)
    && interval?.confidenceLevel === 0.95
    && nonNegativeInteger(interval?.replicatesRequested)
    && nonNegativeInteger(interval?.replicatesUsed)
    && typeof interval?.pointEstimate === "number"
    && Number.isFinite(interval.pointEstimate)
    && typeof interval?.lower === "number"
    && Number.isFinite(interval.lower)
    && typeof interval?.upper === "number"
    && Number.isFinite(interval.upper)
    && interval.lower <= interval.upper;
}

function validInference(value: unknown): value is MlbP1M3eConfirmationInference {
  const inference = record(value);
  return Boolean(inference)
    && nonNegativeInteger(inference?.dateClusters)
    && nonNegativeInteger(inference?.selectedDateClusters)
    && nonNegativeInteger(inference?.rejectedDateClusters)
    && (inference?.logLossImprovement === null || validInterval(inference?.logLossImprovement))
    && (inference?.brierImprovement === null || validInterval(inference?.brierImprovement))
    && typeof inference?.calibrationAccepted === "boolean"
    && typeof inference?.minimumCoverageAccepted === "boolean"
    && typeof inference?.minimumSampleAccepted === "boolean";
}

function validAtom(value: unknown): value is MlbP1M3eAtom {
  const atom = record(value);
  if (!atom || typeof atom.kind !== "string") return false;
  const noValueKinds = new Set([
    "STAGE_IS_FINAL",
    "ACTIONABILITY_IS_FINAL",
    "ECONOMIC_LAYER_VALID",
    "NO_DATA_QUALITY_MISSING",
  ]);
  if (noValueKinds.has(atom.kind)) return true;
  if (["MARKET_IS", "SIGNAL_IS", "CATEGORY_IS"].includes(atom.kind)) return typeof atom.value === "string";
  return [
    "MODEL_PROBABILITY_AT_LEAST",
    "EDGE_PP_AT_LEAST",
    "NO_VIG_EDGE_PP_AT_LEAST",
    "DATA_QUALITY_AT_LEAST",
    "MARKET_IMPLIED_AT_LEAST",
    "MARKET_IMPLIED_AT_MOST",
  ].includes(atom.kind) && typeof atom.value === "number" && Number.isFinite(atom.value);
}

function validRule(value: unknown): value is MlbP1M3eRule {
  const rule = record(value);
  return Boolean(rule)
    && typeof rule?.ruleKey === "string"
    && rule.ruleKey.length > 0
    && Array.isArray(rule?.atoms)
    && rule.atoms.length >= 1
    && rule.atoms.length <= 2
    && rule.atoms.every(validAtom);
}

export function parseMlbP1M3eEnvelope(value: unknown): MlbP1M3eEnvelope {
  const envelope = record(value);
  const data = record(envelope?.data);
  const configuration = record(data?.configuration);
  const cohort = record(data?.cohort);
  const temporal = record(data?.temporalSplit);
  const interpretation = record(data?.interpretation);

  const fail = (message: string): never => {
    throw new Error(`P1_M3E_UI_INVALID_RESPONSE:${message}`);
  };

  if (envelope?.success !== true) fail("success");
  if (envelope?.endpoint !== MLB_P1_M3E_ENDPOINT) fail("envelope_endpoint");
  if (data?.schemaVersion !== MLB_P1_M3E_SCHEMA) fail("schema");
  if (typeof data?.generatedAt !== "string" || !Number.isFinite(Date.parse(data.generatedAt))) fail("generated_at");
  if (![
    "INSUFFICIENT_SAMPLE",
    "NO_DISCOVERY_RULE",
    "CANDIDATE_NOT_CONFIRMED",
    "ELITE_MODEL_QUALITY_SUPPORTED",
  ].includes(String(data?.state))) fail("state");

  for (const key of [
    "minimumTotalObservations",
    "minimumTotalDates",
    "minimumDiscoverySelected",
    "minimumDiscoveryRejected",
    "minimumConfirmationSelected",
    "minimumConfirmationRejected",
    "minimumConfirmationSelectedDates",
    "bootstrapReplicates",
    "candidateAtomCount",
    "candidateRuleCount",
  ]) {
    if (!nonNegativeInteger(configuration?.[key])) fail(`configuration_${key}`);
  }
  if (configuration?.maximumRuleAtoms !== 2) fail("maximum_rule_atoms");
  if (typeof configuration?.discoveryDateFraction !== "number" || configuration.discoveryDateFraction <= 0 || configuration.discoveryDateFraction >= 1) fail("discovery_fraction");
  if (typeof configuration?.minimumConfirmationCoveragePct !== "number" || !Number.isFinite(configuration.minimumConfirmationCoveragePct)) fail("minimum_confirmation_coverage");

  for (const key of ["inputRows", "scoreableRows", "excludedRows", "uniqueDates"]) {
    if (!nonNegativeInteger(cohort?.[key])) fail(`cohort_${key}`);
  }
  if (Number(cohort?.scoreableRows) + Number(cohort?.excludedRows) !== Number(cohort?.inputRows)) fail("cohort_accounting");

  if (temporal?.leakageFree !== true) fail("temporal_leakage");
  for (const key of ["discoveryRows", "confirmationRows", "discoveryDates", "confirmationDates"]) {
    if (!nonNegativeInteger(temporal?.[key])) fail(`temporal_${key}`);
  }
  if (Number(temporal?.discoveryRows) + Number(temporal?.confirmationRows) !== Number(cohort?.scoreableRows)) fail("temporal_accounting");

  if (data?.selectedRule !== null && !validRule(data?.selectedRule)) fail("selected_rule");
  if (data?.discovery !== null && !validComparison(data?.discovery)) fail("discovery");
  if (data?.confirmation !== null && !validComparison(data?.confirmation)) fail("confirmation");
  if (data?.confirmationInference !== null && !validInference(data?.confirmationInference)) fail("confirmation_inference");
  if (!Array.isArray(data?.blockers) || !data.blockers.every((item) => typeof item === "string")) fail("blockers");

  if (typeof interpretation?.modelQualityOperatingEnvelopeSupported !== "boolean") fail("supported_flag");
  for (const key of [
    "economicProfitabilityCertified",
    "operationalGateAllowed",
    "modelProbabilityChanged",
    "existingEconomicThresholdsChanged",
    "automaticModelChangesAllowed",
    "automaticPromotionAllowed",
  ]) {
    if (interpretation?.[key] !== false) fail(`unsafe_${key}`);
  }
  if ((data?.state === "ELITE_MODEL_QUALITY_SUPPORTED") !== interpretation?.modelQualityOperatingEnvelopeSupported) fail("supported_state_parity");

  return value as MlbP1M3eEnvelope;
}

export function formatMlbP1M3eAtom(atom: MlbP1M3eAtom): string {
  switch (atom.kind) {
    case "MARKET_IS": return `Mercado = ${atom.value}`;
    case "STAGE_IS_FINAL": return "Etapa = FINAL";
    case "SIGNAL_IS": return `Señal = ${atom.value.replaceAll("_", " ")}`;
    case "CATEGORY_IS": return `Categoría = ${atom.value}`;
    case "ACTIONABILITY_IS_FINAL": return "Accionabilidad = FINAL";
    case "ECONOMIC_LAYER_VALID": return "Capa económica válida";
    case "MODEL_PROBABILITY_AT_LEAST": return `Prob. modelo ≥ ${(atom.value * 100).toFixed(0)}%`;
    case "EDGE_PP_AT_LEAST": return `Edge ≥ ${atom.value.toFixed(0)} pp`;
    case "NO_VIG_EDGE_PP_AT_LEAST": return `Edge no-vig ≥ ${atom.value.toFixed(0)} pp`;
    case "DATA_QUALITY_AT_LEAST": return `Calidad datos ≥ ${atom.value.toFixed(0)}%`;
    case "NO_DATA_QUALITY_MISSING": return "Sin datos críticos faltantes";
    case "MARKET_IMPLIED_AT_LEAST": return `Mercado implícito ≥ ${(atom.value * 100).toFixed(0)}%`;
    case "MARKET_IMPLIED_AT_MOST": return `Mercado implícito ≤ ${(atom.value * 100).toFixed(0)}%`;
  }
}
