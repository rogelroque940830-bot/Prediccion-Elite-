import type { MlbProbabilityHorizon } from "./mlb-market-probability-contract";
import {
  bootstrapMlbPairedDateClusters,
  type MlbBootstrapInterval,
  type MlbPairedDateCluster,
} from "./mlb-market-team-strength-inference";
import type {
  MlbStartingPitcherOosReport,
  MlbStartingPitcherPairedRow,
} from "./mlb-market-starting-pitcher-asof";

export const MLB_P1_M6A3B2B2B_SCHEMA = "courtedge-p1-m6a3b2b2b-paired-pitcher-inference.v1" as const;

const HORIZONS: MlbProbabilityHorizon[] = ["FIRST_INNING", "FIRST_3", "FIRST_5", "FULL_GAME"];
const DEFAULT_BOOTSTRAP_REPLICATES = 5000;
const DEFAULT_MINIMUM_DATE_CLUSTERS = 30;
const FAMILYWISE_HORIZONS = 4;

export type MlbPitcherComparisonEvidenceStatus =
  | "SUPPORTED_IMPROVEMENT"
  | "SUPPORTED_REGRESSION"
  | "INCONCLUSIVE"
  | "INSUFFICIENT_OOS_SAMPLE";

export type MlbStartingPitcherOverallEvidenceStatus =
  | "SUPPORTED_INCREMENTAL_IMPROVEMENT"
  | "SUPPORTED_REGRESSION"
  | "MIXED_EVIDENCE"
  | "INCONCLUSIVE"
  | "INSUFFICIENT_OOS_SAMPLE";

export interface MlbPitcherPairedComparisonInference {
  comparison: "TEAM_ONLY_MINUS_PITCHER" | "LEAGUE_NB2_MINUS_PITCHER";
  pointEstimateCountNll: number | null;
  unadjusted95: MlbBootstrapInterval | null;
  bonferroniFamilywise: MlbBootstrapInterval | null;
  evidenceStatus: MlbPitcherComparisonEvidenceStatus;
}

export interface MlbStartingPitcherInferenceHorizon {
  horizon: MlbProbabilityHorizon;
  validationGames: number;
  dateClusters: number;
  countObservations: number;
  bootstrapReplicates: number;
  familywiseHorizons: number;
  teamComparison: MlbPitcherPairedComparisonInference;
  leagueComparison: MlbPitcherPairedComparisonInference;
  overallEvidenceStatus: MlbStartingPitcherOverallEvidenceStatus;
  actionabilityAllowed: false;
  automaticPromotionAllowed: false;
  blockers: string[];
}

export interface MlbStartingPitcherPairedInferenceReport {
  schemaVersion: typeof MLB_P1_M6A3B2B2B_SCHEMA;
  generatedAt: string;
  configuration: {
    bootstrapReplicates: number;
    minimumDateClusters: number;
    familywiseHorizons: number;
  };
  horizons: MlbStartingPitcherInferenceHorizon[];
  actionabilityAllowed: false;
  automaticModelSelectionAllowed: false;
  automaticPromotionAllowed: false;
  blockers: [
    "P1_M6A3B2B2B_PAIRED_DATE_INFERENCE_RESEARCH_ONLY",
    "P1_M6A3B_FINAL_MODEL_CERTIFICATION_INCOMPLETE",
    "NO_AUTOMATIC_PROMOTION"
  ];
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validateRows(horizon: MlbProbabilityHorizon, rows: MlbStartingPitcherPairedRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.horizon !== horizon
      || !Number.isInteger(row.gamePk) || row.gamePk <= 0
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.officialDate)
      || !Number.isFinite(row.leagueNb2CountNll)
      || !Number.isFinite(row.teamOnlyCountNll)
      || !Number.isFinite(row.teamPlusPitcherCountNll)
      || !Number.isFinite(row.teamMinusPitcherCountNll)
      || !Number.isFinite(row.leagueMinusPitcherCountNll)) {
      throw new Error("P1_M6A3B2B2B_INVALID_PAIRED_ROW");
    }
    const key = `${horizon}:${row.gamePk}`;
    if (seen.has(key)) throw new Error("P1_M6A3B2B2B_DUPLICATE_VALIDATION_GAME");
    seen.add(key);
    const teamParity = row.teamOnlyCountNll - row.teamPlusPitcherCountNll;
    const leagueParity = row.leagueNb2CountNll - row.teamPlusPitcherCountNll;
    if (Math.abs(teamParity - row.teamMinusPitcherCountNll) > 2e-7
      || Math.abs(leagueParity - row.leagueMinusPitcherCountNll) > 2e-7) {
      throw new Error("P1_M6A3B2B2B_ROW_POINT_PARITY_FAILURE");
    }
  }
}

function buildClusters(
  horizon: MlbProbabilityHorizon,
  rows: MlbStartingPitcherPairedRow[],
  comparison: "TEAM_ONLY_MINUS_PITCHER" | "LEAGUE_NB2_MINUS_PITCHER",
): MlbPairedDateCluster[] {
  validateRows(horizon, rows);
  const map = new Map<string, {
    games: number;
    countObservations: number;
    baselineNllTotal: number;
    challengerNllTotal: number;
    deltaTotal: number;
  }>();
  for (const row of rows) {
    let value = map.get(row.officialDate);
    if (!value) {
      value = { games: 0, countObservations: 0, baselineNllTotal: 0, challengerNllTotal: 0, deltaTotal: 0 };
      map.set(row.officialDate, value);
    }
    const baseline = comparison === "TEAM_ONLY_MINUS_PITCHER"
      ? row.teamOnlyCountNll
      : row.leagueNb2CountNll;
    const delta = comparison === "TEAM_ONLY_MINUS_PITCHER"
      ? row.teamMinusPitcherCountNll
      : row.leagueMinusPitcherCountNll;
    value.games += 1;
    value.countObservations += 2;
    value.baselineNllTotal += baseline * 2;
    value.challengerNllTotal += row.teamPlusPitcherCountNll * 2;
    value.deltaTotal += delta * 2;
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([officialDate, value]) => ({
      officialDate,
      games: value.games,
      countObservations: value.countObservations,
      baselineNllTotal: value.baselineNllTotal,
      challengerNllTotal: value.challengerNllTotal,
      baselineMinusChallengerNllTotal: value.deltaTotal,
      baselineMinusChallengerMeanCountNll: round(value.deltaTotal / value.countObservations),
    }));
}

function comparisonStatus(interval: MlbBootstrapInterval | null): MlbPitcherComparisonEvidenceStatus {
  if (!interval) return "INSUFFICIENT_OOS_SAMPLE";
  if (interval.lower > 0) return "SUPPORTED_IMPROVEMENT";
  if (interval.upper < 0) return "SUPPORTED_REGRESSION";
  return "INCONCLUSIVE";
}

function overallStatus(
  team: MlbPitcherComparisonEvidenceStatus,
  league: MlbPitcherComparisonEvidenceStatus,
): MlbStartingPitcherOverallEvidenceStatus {
  if (team === "INSUFFICIENT_OOS_SAMPLE" || league === "INSUFFICIENT_OOS_SAMPLE") {
    return "INSUFFICIENT_OOS_SAMPLE";
  }
  if (team === "SUPPORTED_REGRESSION") return "SUPPORTED_REGRESSION";
  if (team === "SUPPORTED_IMPROVEMENT" && league !== "SUPPORTED_REGRESSION") {
    return "SUPPORTED_INCREMENTAL_IMPROVEMENT";
  }
  if (team === "SUPPORTED_IMPROVEMENT" && league === "SUPPORTED_REGRESSION") {
    return "MIXED_EVIDENCE";
  }
  return "INCONCLUSIVE";
}

function pointFromRows(
  rows: MlbStartingPitcherPairedRow[],
  comparison: "TEAM_ONLY_MINUS_PITCHER" | "LEAGUE_NB2_MINUS_PITCHER",
): number | null {
  if (!rows.length) return null;
  const total = rows.reduce((sum, row) => sum + (comparison === "TEAM_ONLY_MINUS_PITCHER"
    ? row.teamMinusPitcherCountNll
    : row.leagueMinusPitcherCountNll), 0);
  return round(total / rows.length);
}

export function buildMlbStartingPitcherPairedInferenceReport(
  oosReport: MlbStartingPitcherOosReport,
  options: {
    bootstrapReplicates?: number;
    minimumDateClusters?: number;
    generatedAt?: string;
  } = {},
): MlbStartingPitcherPairedInferenceReport {
  if (!oosReport || oosReport.schemaVersion !== "courtedge-p1-m6a3b2b2-starting-pitcher-asof-oos.v1") {
    throw new Error("P1_M6A3B2B2B_INVALID_OOS_REPORT");
  }
  if (!oosReport.allFoldsLeakageFree) throw new Error("P1_M6A3B2B2B_UPSTREAM_LEAKAGE_DETECTED");
  const bootstrapReplicates = options.bootstrapReplicates ?? DEFAULT_BOOTSTRAP_REPLICATES;
  const minimumDateClusters = options.minimumDateClusters ?? DEFAULT_MINIMUM_DATE_CLUSTERS;
  if (!Number.isInteger(bootstrapReplicates) || bootstrapReplicates < 500 || bootstrapReplicates > 50_000) {
    throw new Error("P1_M6A3B2B2B_INVALID_BOOTSTRAP_REPLICATES");
  }
  if (!Number.isInteger(minimumDateClusters) || minimumDateClusters <= 0 || minimumDateClusters > 500) {
    throw new Error("P1_M6A3B2B2B_INVALID_MINIMUM_DATE_CLUSTERS");
  }

  const horizons: MlbStartingPitcherInferenceHorizon[] = [];
  for (const horizon of HORIZONS) {
    const source = oosReport.horizons.find((entry) => entry.horizon === horizon);
    if (!source) throw new Error(`P1_M6A3B2B2B_HORIZON_MISSING:${horizon}`);
    const rows = source.pairedRows;
    validateRows(horizon, rows);
    const teamPoint = pointFromRows(rows, "TEAM_ONLY_MINUS_PITCHER");
    const leaguePoint = pointFromRows(rows, "LEAGUE_NB2_MINUS_PITCHER");
    if (teamPoint != null && source.teamMinusPitcherCountNll != null
      && Math.abs(teamPoint - source.teamMinusPitcherCountNll) > 2e-7) {
      throw new Error(`P1_M6A3B2B2B_TEAM_POINT_PARITY_FAILURE:${horizon}`);
    }
    if (leaguePoint != null && source.leagueMinusPitcherCountNll != null
      && Math.abs(leaguePoint - source.leagueMinusPitcherCountNll) > 2e-7) {
      throw new Error(`P1_M6A3B2B2B_LEAGUE_POINT_PARITY_FAILURE:${horizon}`);
    }

    const teamClusters = buildClusters(horizon, rows, "TEAM_ONLY_MINUS_PITCHER");
    const leagueClusters = buildClusters(horizon, rows, "LEAGUE_NB2_MINUS_PITCHER");
    if (teamClusters.length !== leagueClusters.length) throw new Error("P1_M6A3B2B2B_CLUSTER_PARITY_FAILURE");
    const sufficient = rows.length > 0 && teamClusters.length >= minimumDateClusters;
    const teamBootstrap = sufficient
      ? bootstrapMlbPairedDateClusters(horizon, teamClusters, {
        replicates: bootstrapReplicates,
        familywiseHorizons: FAMILYWISE_HORIZONS,
      })
      : null;
    const leagueBootstrap = sufficient
      ? bootstrapMlbPairedDateClusters(horizon, leagueClusters, {
        replicates: bootstrapReplicates,
        familywiseHorizons: FAMILYWISE_HORIZONS,
      })
      : null;
    if (teamBootstrap && teamPoint != null && Math.abs(teamBootstrap.pointEstimate - teamPoint) > 2e-7) {
      throw new Error(`P1_M6A3B2B2B_TEAM_BOOTSTRAP_POINT_PARITY_FAILURE:${horizon}`);
    }
    if (leagueBootstrap && leaguePoint != null && Math.abs(leagueBootstrap.pointEstimate - leaguePoint) > 2e-7) {
      throw new Error(`P1_M6A3B2B2B_LEAGUE_BOOTSTRAP_POINT_PARITY_FAILURE:${horizon}`);
    }

    const teamEvidence = comparisonStatus(teamBootstrap?.bonferroniFamilywise ?? null);
    const leagueEvidence = comparisonStatus(leagueBootstrap?.bonferroniFamilywise ?? null);
    const overall = overallStatus(teamEvidence, leagueEvidence);
    horizons.push({
      horizon,
      validationGames: rows.length,
      dateClusters: teamClusters.length,
      countObservations: rows.length * 2,
      bootstrapReplicates,
      familywiseHorizons: FAMILYWISE_HORIZONS,
      teamComparison: {
        comparison: "TEAM_ONLY_MINUS_PITCHER",
        pointEstimateCountNll: teamPoint,
        unadjusted95: teamBootstrap?.unadjusted95 ?? null,
        bonferroniFamilywise: teamBootstrap?.bonferroniFamilywise ?? null,
        evidenceStatus: teamEvidence,
      },
      leagueComparison: {
        comparison: "LEAGUE_NB2_MINUS_PITCHER",
        pointEstimateCountNll: leaguePoint,
        unadjusted95: leagueBootstrap?.unadjusted95 ?? null,
        bonferroniFamilywise: leagueBootstrap?.bonferroniFamilywise ?? null,
        evidenceStatus: leagueEvidence,
      },
      overallEvidenceStatus: overall,
      actionabilityAllowed: false,
      automaticPromotionAllowed: false,
      blockers: overall === "SUPPORTED_INCREMENTAL_IMPROVEMENT"
        ? ["P1_M6A3B2B2B_RESEARCH_SUPPORT_ONLY", "P1_M6A3B_FINAL_MODEL_CERTIFICATION_INCOMPLETE", "NO_AUTOMATIC_PROMOTION"]
        : overall === "SUPPORTED_REGRESSION"
          ? ["P1_M6A3B2B2B_PITCHER_SUPPORTED_REGRESSION", "NO_AUTOMATIC_PROMOTION"]
          : ["P1_M6A3B2B2B_PITCHER_EVIDENCE_NOT_DECISIVE", "NO_AUTOMATIC_PROMOTION"],
    });
  }

  return {
    schemaVersion: MLB_P1_M6A3B2B2B_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    configuration: {
      bootstrapReplicates,
      minimumDateClusters,
      familywiseHorizons: FAMILYWISE_HORIZONS,
    },
    horizons,
    actionabilityAllowed: false,
    automaticModelSelectionAllowed: false,
    automaticPromotionAllowed: false,
    blockers: [
      "P1_M6A3B2B2B_PAIRED_DATE_INFERENCE_RESEARCH_ONLY",
      "P1_M6A3B_FINAL_MODEL_CERTIFICATION_INCOMPLETE",
      "NO_AUTOMATIC_PROMOTION",
    ],
  };
}
