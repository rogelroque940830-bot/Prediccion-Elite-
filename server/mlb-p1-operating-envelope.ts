import crypto from "node:crypto";
import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";

export const MLB_P1_M3E_SCHEMA = "courtedge-p1-m3e-operating-envelope.v1" as const;

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
  hypothesis: {
    alternative: "A pregame-identifiable operating envelope has persistently better proper scoring and calibration on later decisions.";
    null: "Any apparent elite operating envelope does not survive chronological confirmation.";
  };
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

export interface MlbP1M3eOptions {
  discoveryDateFraction?: number;
  minimumTotalObservations?: number;
  minimumTotalDates?: number;
  minimumDiscoverySelected?: number;
  minimumDiscoveryRejected?: number;
  minimumConfirmationSelected?: number;
  minimumConfirmationRejected?: number;
  minimumConfirmationSelectedDates?: number;
  minimumConfirmationCoveragePct?: number;
  bootstrapReplicates?: number;
  generatedAt?: string;
}

const DEFAULTS = {
  discoveryDateFraction: 0.6,
  minimumTotalObservations: 80,
  minimumTotalDates: 30,
  minimumDiscoverySelected: 20,
  minimumDiscoveryRejected: 20,
  minimumConfirmationSelected: 15,
  minimumConfirmationRejected: 15,
  minimumConfirmationSelectedDates: 10,
  minimumConfirmationCoveragePct: 10,
  bootstrapReplicates: 5000,
} as const;

const MODEL_PROBABILITY_THRESHOLDS = [0.55, 0.6, 0.65, 0.7, 0.75] as const;
const EDGE_THRESHOLDS = [3, 5, 8, 10, 12] as const;
const NO_VIG_EDGE_THRESHOLDS = [0, 2, 4, 6, 8] as const;
const DATA_QUALITY_THRESHOLDS = [80, 90, 95, 100] as const;

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values: number[], probability: number): number {
  if (!values.length) throw new Error("P1_M3E_EMPTY_QUANTILE");
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function scoreable(row: MlbP1M3dReviewRow): boolean {
  return validDate(row.gameDate)
    && (row.result === "WIN" || row.result === "LOSS")
    && Number.isFinite(row.modelProbability)
    && row.modelProbability > 0
    && row.modelProbability < 1
    && row.logLoss != null
    && Number.isFinite(row.logLoss)
    && row.logLoss >= 0
    && row.brierScore != null
    && Number.isFinite(row.brierScore)
    && row.brierScore >= 0;
}

function scoreableRows(rows: MlbP1M3dReviewRow[]): MlbP1M3dReviewRow[] {
  const seen = new Set<string>();
  const filtered: MlbP1M3dReviewRow[] = [];
  for (const row of rows) {
    if (!scoreable(row)) continue;
    if (seen.has(row.predictionId)) throw new Error(`P1_M3E_DUPLICATE_PREDICTION_ID:${row.predictionId}`);
    seen.add(row.predictionId);
    filtered.push(row);
  }
  return filtered.sort((a, b) => a.gameDate.localeCompare(b.gameDate)
    || a.recordedAt.localeCompare(b.recordedAt)
    || a.predictionId.localeCompare(b.predictionId));
}

function atomFamily(atom: MlbP1M3eAtom): string {
  if (atom.kind === "MODEL_PROBABILITY_AT_LEAST") return "MODEL_PROBABILITY";
  if (atom.kind === "EDGE_PP_AT_LEAST") return "EDGE";
  if (atom.kind === "NO_VIG_EDGE_PP_AT_LEAST") return "NO_VIG_EDGE";
  if (atom.kind === "DATA_QUALITY_AT_LEAST" || atom.kind === "NO_DATA_QUALITY_MISSING") return "DATA_QUALITY";
  if (atom.kind === "MARKET_IMPLIED_AT_LEAST" || atom.kind === "MARKET_IMPLIED_AT_MOST") return "MARKET_IMPLIED";
  if (atom.kind === "SIGNAL_IS") return "SIGNAL";
  if (atom.kind === "CATEGORY_IS") return "CATEGORY";
  return atom.kind;
}

function atomKey(atom: MlbP1M3eAtom): string {
  if ("value" in atom) return `${atom.kind}:${String(atom.value)}`;
  return atom.kind;
}

function ruleKey(atoms: MlbP1M3eAtom[]): string {
  return atoms.map(atomKey).sort().join("&&");
}

export function buildMlbP1M3eCandidateAtoms(): MlbP1M3eAtom[] {
  const atoms: MlbP1M3eAtom[] = [
    ...(["ML", "F5_ML", "RUN_LINE", "TOTAL", "F5_TOTAL"] as const).map((value) => ({ kind: "MARKET_IS", value } as const)),
    { kind: "STAGE_IS_FINAL" },
    { kind: "SIGNAL_IS", value: "BET_FUERTE" },
    { kind: "SIGNAL_IS", value: "BET" },
    { kind: "CATEGORY_IS", value: "ELITE" },
    { kind: "CATEGORY_IS", value: "PREMIUM" },
    { kind: "ACTIONABILITY_IS_FINAL" },
    { kind: "ECONOMIC_LAYER_VALID" },
    ...MODEL_PROBABILITY_THRESHOLDS.map((value) => ({ kind: "MODEL_PROBABILITY_AT_LEAST", value } as const)),
    ...EDGE_THRESHOLDS.map((value) => ({ kind: "EDGE_PP_AT_LEAST", value } as const)),
    ...NO_VIG_EDGE_THRESHOLDS.map((value) => ({ kind: "NO_VIG_EDGE_PP_AT_LEAST", value } as const)),
    ...DATA_QUALITY_THRESHOLDS.map((value) => ({ kind: "DATA_QUALITY_AT_LEAST", value } as const)),
    { kind: "NO_DATA_QUALITY_MISSING" },
    { kind: "MARKET_IMPLIED_AT_LEAST", value: 0.55 },
    { kind: "MARKET_IMPLIED_AT_MOST", value: 0.45 },
  ];
  return atoms;
}

export function buildMlbP1M3eCandidateRules(): MlbP1M3eRule[] {
  const atoms = buildMlbP1M3eCandidateAtoms();
  const rules: MlbP1M3eRule[] = atoms.map((atom) => ({ atoms: [atom], ruleKey: ruleKey([atom]) }));
  for (let left = 0; left < atoms.length; left += 1) {
    for (let right = left + 1; right < atoms.length; right += 1) {
      if (atomFamily(atoms[left]) === atomFamily(atoms[right])) continue;
      const pair = [atoms[left], atoms[right]];
      rules.push({ atoms: pair, ruleKey: ruleKey(pair) });
    }
  }
  return rules.sort((a, b) => a.atoms.length - b.atoms.length || a.ruleKey.localeCompare(b.ruleKey));
}

function noVigEdgePp(row: MlbP1M3dReviewRow): number | null {
  if (row.noVigProbability == null || !Number.isFinite(row.noVigProbability)) return null;
  return (row.modelProbability - row.noVigProbability) * 100;
}

export function matchesMlbP1M3eAtom(row: MlbP1M3dReviewRow, atom: MlbP1M3eAtom): boolean {
  switch (atom.kind) {
    case "MARKET_IS": return row.market === atom.value;
    case "STAGE_IS_FINAL": return row.stage === "FINAL";
    case "SIGNAL_IS": return row.sourceSignal === atom.value;
    case "CATEGORY_IS": return row.sourceCategory === atom.value;
    case "ACTIONABILITY_IS_FINAL": return row.actionability === "ACTIONABLE_FINAL";
    case "ECONOMIC_LAYER_VALID": return row.economicLayerValid === true;
    case "MODEL_PROBABILITY_AT_LEAST": return row.modelProbability >= atom.value;
    case "EDGE_PP_AT_LEAST": return row.edgePp != null && Number.isFinite(row.edgePp) && row.edgePp >= atom.value;
    case "NO_VIG_EDGE_PP_AT_LEAST": {
      const edge = noVigEdgePp(row);
      return edge != null && edge >= atom.value;
    }
    case "DATA_QUALITY_AT_LEAST": return Number.isFinite(row.dataQualityCoveragePct) && row.dataQualityCoveragePct >= atom.value;
    case "NO_DATA_QUALITY_MISSING": return row.dataQualityMissing.length === 0;
    case "MARKET_IMPLIED_AT_LEAST": return row.marketImpliedProbability != null && row.marketImpliedProbability >= atom.value;
    case "MARKET_IMPLIED_AT_MOST": return row.marketImpliedProbability != null && row.marketImpliedProbability <= atom.value;
  }
}

export function matchesMlbP1M3eRule(row: MlbP1M3dReviewRow, rule: MlbP1M3eRule): boolean {
  if (!rule.atoms.length || rule.atoms.length > 2) throw new Error("P1_M3E_INVALID_RULE_COMPLEXITY");
  return rule.atoms.every((atom) => matchesMlbP1M3eAtom(row, atom));
}

export function summarizeMlbP1M3eRows(rows: MlbP1M3dReviewRow[]): MlbP1M3eMetricSummary {
  if (!rows.length) {
    return {
      observations: 0,
      dates: 0,
      wins: 0,
      losses: 0,
      meanModelProbability: null,
      observedWinRate: null,
      calibrationGap: null,
      meanLogLoss: null,
      meanBrierScore: null,
      flatStakeRoiPct: null,
      clvAvailable: 0,
      meanClvPp: null,
    };
  }
  const wins = rows.filter((row) => row.result === "WIN").length;
  const losses = rows.filter((row) => row.result === "LOSS").length;
  const meanProbability = average(rows.map((row) => row.modelProbability)) as number;
  const observedWinRate = wins / (wins + losses);
  const flatProfit = rows.reduce((sum, row) => sum + row.flatProfitUnits, 0);
  const clv = rows.map((row) => row.clvPp).filter((value): value is number => value != null && Number.isFinite(value));
  return {
    observations: rows.length,
    dates: new Set(rows.map((row) => row.gameDate)).size,
    wins,
    losses,
    meanModelProbability: round(meanProbability),
    observedWinRate: round(observedWinRate),
    calibrationGap: round(Math.abs(meanProbability - observedWinRate)),
    meanLogLoss: round(average(rows.map((row) => row.logLoss as number)) as number),
    meanBrierScore: round(average(rows.map((row) => row.brierScore as number)) as number),
    flatStakeRoiPct: round((flatProfit / rows.length) * 100, 4),
    clvAvailable: clv.length,
    meanClvPp: clv.length ? round(average(clv) as number, 4) : null,
  };
}

function comparison(rows: MlbP1M3dReviewRow[], rule: MlbP1M3eRule): MlbP1M3eComparison {
  const selected = rows.filter((row) => matchesMlbP1M3eRule(row, rule));
  const rejected = rows.filter((row) => !matchesMlbP1M3eRule(row, rule));
  const selectedSummary = summarizeMlbP1M3eRows(selected);
  const rejectedSummary = summarizeMlbP1M3eRows(rejected);
  return {
    selected: selectedSummary,
    rejected: rejectedSummary,
    coveragePct: rows.length ? round((selected.length / rows.length) * 100, 4) : 0,
    rejectedCoveragePct: rows.length ? round((rejected.length / rows.length) * 100, 4) : 0,
    rejectedMinusSelectedLogLoss: selectedSummary.meanLogLoss != null && rejectedSummary.meanLogLoss != null
      ? round(rejectedSummary.meanLogLoss - selectedSummary.meanLogLoss)
      : null,
    rejectedMinusSelectedBrier: selectedSummary.meanBrierScore != null && rejectedSummary.meanBrierScore != null
      ? round(rejectedSummary.meanBrierScore - selectedSummary.meanBrierScore)
      : null,
  };
}

function discoveryScore(value: MlbP1M3eComparison, complexity: number): number | null {
  if (value.rejectedMinusSelectedLogLoss == null || value.rejectedMinusSelectedBrier == null) return null;
  if (value.rejectedMinusSelectedLogLoss <= 0 || value.rejectedMinusSelectedBrier <= 0) return null;
  if (value.coveragePct < 15 || value.coveragePct > 70) return null;
  const selectedCalibration = value.selected.calibrationGap;
  const rejectedCalibration = value.rejected.calibrationGap;
  if (selectedCalibration == null || rejectedCalibration == null) return null;
  if (selectedCalibration > rejectedCalibration + 0.02) return null;
  const calibrationPenalty = Math.max(0, selectedCalibration - rejectedCalibration) * 0.5;
  const complexityPenalty = complexity === 2 ? 0.0005 : 0;
  return value.rejectedMinusSelectedLogLoss
    + 0.5 * value.rejectedMinusSelectedBrier
    - calibrationPenalty
    - complexityPenalty;
}

function splitDates(rows: MlbP1M3dReviewRow[], fraction: number): {
  discovery: MlbP1M3dReviewRow[];
  confirmation: MlbP1M3dReviewRow[];
  discoveryDates: string[];
  confirmationDates: string[];
} {
  const dates = [...new Set(rows.map((row) => row.gameDate))].sort();
  const discoveryDateCount = Math.max(1, Math.min(dates.length - 1, Math.floor(dates.length * fraction)));
  const discoveryDates = dates.slice(0, discoveryDateCount);
  const confirmationDates = dates.slice(discoveryDateCount);
  const discoverySet = new Set(discoveryDates);
  const confirmationSet = new Set(confirmationDates);
  return {
    discovery: rows.filter((row) => discoverySet.has(row.gameDate)),
    confirmation: rows.filter((row) => confirmationSet.has(row.gameDate)),
    discoveryDates,
    confirmationDates,
  };
}

function seededRandom(seedText: string): () => number {
  const seedHex = crypto.createHash("sha256").update(seedText).digest("hex").slice(0, 8);
  let state = Number.parseInt(seedHex, 16) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function bootstrapImprovement(
  rows: MlbP1M3dReviewRow[],
  rule: MlbP1M3eRule,
  metric: "logLoss" | "brierScore",
  replicates: number,
): MlbP1M3eBootstrapInterval | null {
  const dates = [...new Set(rows.map((row) => row.gameDate))].sort();
  if (dates.length < 2) return null;
  const byDate = new Map<string, MlbP1M3dReviewRow[]>();
  for (const date of dates) byDate.set(date, rows.filter((row) => row.gameDate === date));
  const base = comparison(rows, rule);
  const pointEstimate = metric === "logLoss"
    ? base.rejectedMinusSelectedLogLoss
    : base.rejectedMinusSelectedBrier;
  if (pointEstimate == null) return null;

  const random = seededRandom(`${MLB_P1_M3E_SCHEMA}:${rule.ruleKey}:${metric}:${replicates}`);
  const values: number[] = [];
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const selected: MlbP1M3dReviewRow[] = [];
    const rejected: MlbP1M3dReviewRow[] = [];
    for (let draw = 0; draw < dates.length; draw += 1) {
      const sampledDate = dates[Math.floor(random() * dates.length)];
      for (const row of byDate.get(sampledDate) ?? []) {
        if (matchesMlbP1M3eRule(row, rule)) selected.push(row);
        else rejected.push(row);
      }
    }
    if (!selected.length || !rejected.length) continue;
    const selectedValues = selected.map((row) => metric === "logLoss" ? row.logLoss as number : row.brierScore as number);
    const rejectedValues = rejected.map((row) => metric === "logLoss" ? row.logLoss as number : row.brierScore as number);
    const improvement = (average(rejectedValues) as number) - (average(selectedValues) as number);
    if (Number.isFinite(improvement)) values.push(improvement);
  }
  if (values.length < Math.max(500, Math.floor(replicates * 0.8))) return null;
  return {
    confidenceLevel: 0.95,
    replicatesRequested: replicates,
    replicatesUsed: values.length,
    pointEstimate: round(pointEstimate),
    lower: round(quantile(values, 0.025)),
    upper: round(quantile(values, 0.975)),
  };
}

function emptyReport(
  rows: MlbP1M3dReviewRow[],
  scoreable: MlbP1M3dReviewRow[],
  configuration: MlbP1M3eReport["configuration"],
  generatedAt: string,
  blocker: string,
): MlbP1M3eReport {
  const uniqueDates = [...new Set(scoreable.map((row) => row.gameDate))].sort();
  return {
    schemaVersion: MLB_P1_M3E_SCHEMA,
    generatedAt,
    hypothesis: {
      alternative: "A pregame-identifiable operating envelope has persistently better proper scoring and calibration on later decisions.",
      null: "Any apparent elite operating envelope does not survive chronological confirmation.",
    },
    state: "INSUFFICIENT_SAMPLE",
    configuration,
    cohort: {
      inputRows: rows.length,
      scoreableRows: scoreable.length,
      excludedRows: rows.length - scoreable.length,
      uniqueDates: uniqueDates.length,
    },
    temporalSplit: {
      leakageFree: true,
      discoveryMinDate: null,
      discoveryMaxDate: null,
      confirmationMinDate: null,
      confirmationMaxDate: null,
      discoveryRows: 0,
      confirmationRows: 0,
      discoveryDates: 0,
      confirmationDates: 0,
    },
    selectedRule: null,
    discovery: null,
    confirmation: null,
    confirmationInference: null,
    interpretation: {
      modelQualityOperatingEnvelopeSupported: false,
      economicProfitabilityCertified: false,
      operationalGateAllowed: false,
      modelProbabilityChanged: false,
      existingEconomicThresholdsChanged: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
    blockers: [blocker],
  };
}

export function buildMlbP1M3eOperatingEnvelope(
  inputRows: MlbP1M3dReviewRow[],
  options: MlbP1M3eOptions = {},
): MlbP1M3eReport {
  const discoveryDateFraction = options.discoveryDateFraction ?? DEFAULTS.discoveryDateFraction;
  const minimumTotalObservations = options.minimumTotalObservations ?? DEFAULTS.minimumTotalObservations;
  const minimumTotalDates = options.minimumTotalDates ?? DEFAULTS.minimumTotalDates;
  const minimumDiscoverySelected = options.minimumDiscoverySelected ?? DEFAULTS.minimumDiscoverySelected;
  const minimumDiscoveryRejected = options.minimumDiscoveryRejected ?? DEFAULTS.minimumDiscoveryRejected;
  const minimumConfirmationSelected = options.minimumConfirmationSelected ?? DEFAULTS.minimumConfirmationSelected;
  const minimumConfirmationRejected = options.minimumConfirmationRejected ?? DEFAULTS.minimumConfirmationRejected;
  const minimumConfirmationSelectedDates = options.minimumConfirmationSelectedDates ?? DEFAULTS.minimumConfirmationSelectedDates;
  const minimumConfirmationCoveragePct = options.minimumConfirmationCoveragePct ?? DEFAULTS.minimumConfirmationCoveragePct;
  const bootstrapReplicates = options.bootstrapReplicates ?? DEFAULTS.bootstrapReplicates;
  if (!(discoveryDateFraction > 0.4 && discoveryDateFraction < 0.8)
    || ![minimumTotalObservations, minimumTotalDates, minimumDiscoverySelected, minimumDiscoveryRejected,
      minimumConfirmationSelected, minimumConfirmationRejected, minimumConfirmationSelectedDates, bootstrapReplicates]
      .every((value) => Number.isInteger(value) && value > 0)
    || !(minimumConfirmationCoveragePct > 0 && minimumConfirmationCoveragePct < 100)
    || bootstrapReplicates < 500 || bootstrapReplicates > 50_000) {
    throw new Error("P1_M3E_INVALID_CONFIGURATION");
  }

  const atoms = buildMlbP1M3eCandidateAtoms();
  const rules = buildMlbP1M3eCandidateRules();
  const configuration: MlbP1M3eReport["configuration"] = {
    discoveryDateFraction,
    minimumTotalObservations,
    minimumTotalDates,
    minimumDiscoverySelected,
    minimumDiscoveryRejected,
    minimumConfirmationSelected,
    minimumConfirmationRejected,
    minimumConfirmationSelectedDates,
    minimumConfirmationCoveragePct,
    maximumRuleAtoms: 2,
    bootstrapReplicates,
    candidateAtomCount: atoms.length,
    candidateRuleCount: rules.length,
  };
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const eligible = scoreableRows(inputRows);
  const uniqueDates = [...new Set(eligible.map((row) => row.gameDate))].sort();
  if (eligible.length < minimumTotalObservations) {
    return emptyReport(inputRows, eligible, configuration, generatedAt, "P1_M3E_MINIMUM_TOTAL_OBSERVATIONS_NOT_REACHED");
  }
  if (uniqueDates.length < minimumTotalDates) {
    return emptyReport(inputRows, eligible, configuration, generatedAt, "P1_M3E_MINIMUM_TOTAL_DATES_NOT_REACHED");
  }

  const split = splitDates(eligible, discoveryDateFraction);
  const discoveryMaxDate = split.discoveryDates.at(-1) as string;
  const confirmationMinDate = split.confirmationDates[0];
  if (!(discoveryMaxDate < confirmationMinDate)) throw new Error("P1_M3E_TIME_LEAKAGE_DETECTED");

  let best: { rule: MlbP1M3eRule; comparison: MlbP1M3eComparison; score: number } | null = null;
  for (const rule of rules) {
    const candidate = comparison(split.discovery, rule);
    if (candidate.selected.observations < minimumDiscoverySelected
      || candidate.rejected.observations < minimumDiscoveryRejected) continue;
    const score = discoveryScore(candidate, rule.atoms.length);
    if (score == null) continue;
    if (!best
      || score > best.score + 1e-12
      || (Math.abs(score - best.score) <= 1e-12 && rule.atoms.length < best.rule.atoms.length)
      || (Math.abs(score - best.score) <= 1e-12 && rule.atoms.length === best.rule.atoms.length
        && candidate.selected.observations > best.comparison.selected.observations)
      || (Math.abs(score - best.score) <= 1e-12 && rule.atoms.length === best.rule.atoms.length
        && candidate.selected.observations === best.comparison.selected.observations
        && rule.ruleKey < best.rule.ruleKey)) {
      best = { rule, comparison: candidate, score };
    }
  }

  const base = {
    schemaVersion: MLB_P1_M3E_SCHEMA,
    generatedAt,
    hypothesis: {
      alternative: "A pregame-identifiable operating envelope has persistently better proper scoring and calibration on later decisions." as const,
      null: "Any apparent elite operating envelope does not survive chronological confirmation." as const,
    },
    configuration,
    cohort: {
      inputRows: inputRows.length,
      scoreableRows: eligible.length,
      excludedRows: inputRows.length - eligible.length,
      uniqueDates: uniqueDates.length,
    },
    temporalSplit: {
      leakageFree: true,
      discoveryMinDate: split.discoveryDates[0] ?? null,
      discoveryMaxDate: split.discoveryDates.at(-1) ?? null,
      confirmationMinDate: split.confirmationDates[0] ?? null,
      confirmationMaxDate: split.confirmationDates.at(-1) ?? null,
      discoveryRows: split.discovery.length,
      confirmationRows: split.confirmation.length,
      discoveryDates: split.discoveryDates.length,
      confirmationDates: split.confirmationDates.length,
    },
  };

  if (!best) {
    return {
      ...base,
      state: "NO_DISCOVERY_RULE",
      selectedRule: null,
      discovery: null,
      confirmation: null,
      confirmationInference: null,
      interpretation: {
        modelQualityOperatingEnvelopeSupported: false,
        economicProfitabilityCertified: false,
        operationalGateAllowed: false,
        modelProbabilityChanged: false,
        existingEconomicThresholdsChanged: false,
        automaticModelChangesAllowed: false,
        automaticPromotionAllowed: false,
      },
      blockers: ["P1_M3E_NO_PRE_REGISTERED_RULE_IMPROVED_DISCOVERY_PROPER_SCORES"],
    };
  }

  const confirmation = comparison(split.confirmation, best.rule);
  const selectedConfirmationRows = split.confirmation.filter((row) => matchesMlbP1M3eRule(row, best.rule));
  const rejectedConfirmationRows = split.confirmation.filter((row) => !matchesMlbP1M3eRule(row, best.rule));
  const selectedDates = new Set(selectedConfirmationRows.map((row) => row.gameDate)).size;
  const rejectedDates = new Set(rejectedConfirmationRows.map((row) => row.gameDate)).size;
  const minimumSampleAccepted = selectedConfirmationRows.length >= minimumConfirmationSelected
    && rejectedConfirmationRows.length >= minimumConfirmationRejected
    && selectedDates >= minimumConfirmationSelectedDates;
  const minimumCoverageAccepted = confirmation.coveragePct >= minimumConfirmationCoveragePct;
  const selectedCalibration = confirmation.selected.calibrationGap;
  const rejectedCalibration = confirmation.rejected.calibrationGap;
  const calibrationAccepted = selectedCalibration != null
    && rejectedCalibration != null
    && selectedCalibration <= 0.05
    && selectedCalibration <= rejectedCalibration + 0.01;
  const logLossInterval = minimumSampleAccepted
    ? bootstrapImprovement(split.confirmation, best.rule, "logLoss", bootstrapReplicates)
    : null;
  const brierInterval = minimumSampleAccepted
    ? bootstrapImprovement(split.confirmation, best.rule, "brierScore", bootstrapReplicates)
    : null;
  const confirmed = minimumSampleAccepted
    && minimumCoverageAccepted
    && calibrationAccepted
    && logLossInterval != null
    && brierInterval != null
    && logLossInterval.pointEstimate > 0
    && logLossInterval.lower > 0
    && brierInterval.pointEstimate > 0
    && brierInterval.lower > 0;

  const inference: MlbP1M3eConfirmationInference = {
    dateClusters: split.confirmationDates.length,
    selectedDateClusters: selectedDates,
    rejectedDateClusters: rejectedDates,
    logLossImprovement: logLossInterval,
    brierImprovement: brierInterval,
    calibrationAccepted,
    minimumCoverageAccepted,
    minimumSampleAccepted,
  };
  const blockers = confirmed ? [
    "P1_M3E_RESEARCH_SUPPORT_ONLY",
    "P1_M3E_ECONOMIC_PROFITABILITY_NOT_CERTIFIED",
    "P1_M3E_OPERATIONAL_GATE_NOT_ACTIVATED",
  ] : [
    !minimumSampleAccepted ? "P1_M3E_CONFIRMATION_SAMPLE_INSUFFICIENT" : null,
    !minimumCoverageAccepted ? "P1_M3E_CONFIRMATION_COVERAGE_INSUFFICIENT" : null,
    !calibrationAccepted ? "P1_M3E_CONFIRMATION_CALIBRATION_NOT_ACCEPTED" : null,
    logLossInterval == null || logLossInterval.lower <= 0 ? "P1_M3E_LOG_LOSS_IMPROVEMENT_NOT_CONFIRMED" : null,
    brierInterval == null || brierInterval.lower <= 0 ? "P1_M3E_BRIER_IMPROVEMENT_NOT_CONFIRMED" : null,
  ].filter((value): value is string => value != null);

  return {
    ...base,
    state: confirmed ? "ELITE_MODEL_QUALITY_SUPPORTED" : "CANDIDATE_NOT_CONFIRMED",
    selectedRule: best.rule,
    discovery: best.comparison,
    confirmation,
    confirmationInference: inference,
    interpretation: {
      modelQualityOperatingEnvelopeSupported: confirmed,
      economicProfitabilityCertified: false,
      operationalGateAllowed: false,
      modelProbabilityChanged: false,
      existingEconomicThresholdsChanged: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
    blockers,
  };
}
