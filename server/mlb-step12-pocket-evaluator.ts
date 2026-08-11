import type {
  MlbStep12HistoricalFeatureRow,
  MlbStep12HistoricalFeatureTable,
  MlbStep12PregameFeatureVector,
} from "./mlb-step12-historical-feature-table";

export const MLB_STEP12_POCKET_EVALUATOR_SCHEMA = "courtedge-p0-step12-pocket-evaluator.v1" as const;

export type MlbStep12PocketSide = "HOME" | "AWAY";
export type MlbStep12PocketFeature = keyof MlbStep12PregameFeatureVector;

export interface MlbStep12PocketAtom {
  feature: MlbStep12PocketFeature;
  operator: "GTE" | "LTE";
  threshold: number;
  thresholdSource: "DISCOVERY_ONLY";
}

export interface MlbStep12PocketRule {
  ruleKey: string;
  horizon: MlbStep12HistoricalFeatureRow["horizon"];
  side: MlbStep12PocketSide;
  atoms: readonly MlbStep12PocketAtom[];
}

export interface MlbStep12PocketMetrics {
  baselineRows: number;
  selectedRows: number;
  decisiveRows: number;
  hits: number;
  losses: number;
  pushes: number;
  decisiveHitRate: number | null;
  uniqueDates: number;
  retentionPct: number;
  noPickDates: number;
  noPickDatePct: number;
  averageSelectionsPerActiveDate: number;
  observedHitRateBand: "GE_90" | "GE_80" | "GE_70" | "BELOW_70" | "NO_DECISIVE_SAMPLE";
}

export interface MlbStep12PocketEvaluation {
  schemaVersion: typeof MLB_STEP12_POCKET_EVALUATOR_SCHEMA;
  rule: MlbStep12PocketRule;
  discovery: MlbStep12PocketMetrics;
  holdout: MlbStep12PocketMetrics;
  policy: {
    ruleThresholdsMustComeFromDiscoveryOnly: true;
    holdoutThresholdTuningAllowed: false;
    maximumAtomsPerRule: 3;
    hitRateBandIsDescriptiveNotPromotion: true;
    pocketsBelow80RemainResearchEligible: true;
    sampleAndFrequencyAlwaysReported: true;
    historicalPricesRequired: false;
    historicalEvClaimProduced: false;
    livePickFiltersChanged: false;
    betEliteLabelProduced: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function validRule(rule: MlbStep12PocketRule): void {
  if (!rule.ruleKey.trim() || rule.atoms.length < 1 || rule.atoms.length > 3) {
    throw new Error("MLB_STEP12_POCKET_RULE_COMPLEXITY_INVALID");
  }
  const features = new Set<string>();
  for (const atom of rule.atoms) {
    if (!Number.isFinite(atom.threshold) || atom.thresholdSource !== "DISCOVERY_ONLY") {
      throw new Error("MLB_STEP12_POCKET_THRESHOLD_SOURCE_INVALID");
    }
    if (features.has(atom.feature)) throw new Error("MLB_STEP12_POCKET_DUPLICATE_FEATURE");
    features.add(atom.feature);
  }
}

function matches(row: MlbStep12HistoricalFeatureRow, rule: MlbStep12PocketRule): boolean {
  if (row.horizon !== rule.horizon) return false;
  return rule.atoms.every((atom) => {
    const value = row.features[atom.feature];
    if (value == null || !Number.isFinite(value)) return false;
    return atom.operator === "GTE" ? value >= atom.threshold : value <= atom.threshold;
  });
}

function band(hitRate: number | null): MlbStep12PocketMetrics["observedHitRateBand"] {
  if (hitRate == null) return "NO_DECISIVE_SAMPLE";
  if (hitRate >= 0.9) return "GE_90";
  if (hitRate >= 0.8) return "GE_80";
  if (hitRate >= 0.7) return "GE_70";
  return "BELOW_70";
}

function metrics(
  rows: readonly MlbStep12HistoricalFeatureRow[],
  rule: MlbStep12PocketRule,
): MlbStep12PocketMetrics {
  const baseline = rows.filter((row) => row.horizon === rule.horizon);
  const selected = baseline.filter((row) => matches(row, rule));
  const baselineDates = new Set(baseline.map((row) => row.officialDate));
  const selectedDates = new Set(selected.map((row) => row.officialDate));
  const expectedHit = rule.side === "HOME" ? "WIN" : "LOSS";
  const hits = selected.filter((row) => row.outcome.homeResult === expectedHit).length;
  const losses = selected.filter((row) => row.outcome.homeResult !== expectedHit && row.outcome.homeResult !== "PUSH").length;
  const pushes = selected.filter((row) => row.outcome.homeResult === "PUSH").length;
  const decisiveRows = hits + losses;
  const decisiveHitRate = decisiveRows ? hits / decisiveRows : null;
  const noPickDates = Math.max(0, baselineDates.size - selectedDates.size);
  return {
    baselineRows: baseline.length,
    selectedRows: selected.length,
    decisiveRows,
    hits,
    losses,
    pushes,
    decisiveHitRate,
    uniqueDates: selectedDates.size,
    retentionPct: baseline.length ? (selected.length / baseline.length) * 100 : 0,
    noPickDates,
    noPickDatePct: baselineDates.size ? (noPickDates / baselineDates.size) * 100 : 0,
    averageSelectionsPerActiveDate: selectedDates.size ? selected.length / selectedDates.size : 0,
    observedHitRateBand: band(decisiveHitRate),
  };
}

export function evaluateMlbStep12PocketRule(input: {
  table: MlbStep12HistoricalFeatureTable;
  rule: MlbStep12PocketRule;
}): MlbStep12PocketEvaluation {
  validRule(input.rule);
  const discoveryRows = input.table.rows.filter((row) => row.partition === "DISCOVERY");
  const holdoutRows = input.table.rows.filter((row) => row.partition === "HOLDOUT");
  if (!discoveryRows.length || !holdoutRows.length) throw new Error("MLB_STEP12_POCKET_BOTH_PARTITIONS_REQUIRED");

  return {
    schemaVersion: MLB_STEP12_POCKET_EVALUATOR_SCHEMA,
    rule: input.rule,
    discovery: metrics(discoveryRows, input.rule),
    holdout: metrics(holdoutRows, input.rule),
    policy: {
      ruleThresholdsMustComeFromDiscoveryOnly: true,
      holdoutThresholdTuningAllowed: false,
      maximumAtomsPerRule: 3,
      hitRateBandIsDescriptiveNotPromotion: true,
      pocketsBelow80RemainResearchEligible: true,
      sampleAndFrequencyAlwaysReported: true,
      historicalPricesRequired: false,
      historicalEvClaimProduced: false,
      livePickFiltersChanged: false,
      betEliteLabelProduced: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}
