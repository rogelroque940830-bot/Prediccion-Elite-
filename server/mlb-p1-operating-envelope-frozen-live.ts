import type { MlbP1M3dReviewRow } from "./mlb-p1-economic-review";
import {
  buildMlbP1M3e3OperatingEnvelopeFreeze,
  type MlbP1M3e3Report,
} from "./mlb-p1-operating-envelope-freeze";
import {
  buildMlbP1M3e4FrozenManifestEvaluation,
  type MlbP1M3e4Report,
} from "./mlb-p1-operating-envelope-frozen-evaluation";

export const MLB_P1_M3E5_SCHEMA = "courtedge-p1-m3e5-live-frozen-operating-envelope.v1" as const;
export const MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED = "P1_M3E5_SOURCE_WINDOW_TRUNCATED" as const;

export interface MlbP1M3e5SourceSummary {
  ownedLedgerRecords: number;
  uniqueAnalyticalDecisions: number;
}

export interface MlbP1M3e5Report {
  schemaVersion: typeof MLB_P1_M3E5_SCHEMA;
  generatedAt: string;
  state: MlbP1M3e4Report["state"];
  source: {
    ownerScoped: true;
    immutableLedgerRequired: true;
    terminalInteractiveRowsOnly: true;
    sourceWindowComplete: true;
    ownedLedgerRecords: number;
    uniqueAnalyticalDecisions: number;
    terminalReviewRows: number;
  };
  freeze: MlbP1M3e3Report;
  evaluation: MlbP1M3e4Report;
  interpretation: {
    researchWindowFrozen: boolean;
    stableModelQualityEnvelopeSupported: boolean;
    economicProfitabilityCertified: false;
    operationalRecommendationGateAllowed: false;
    bettingRecommendationAllowed: false;
    stakeChangesAllowed: false;
    automaticBettingAllowed: false;
    modelProbabilityChanged: false;
    existingEconomicThresholdsChanged: false;
    premiumNoUltraProspectiveHypothesisChanged: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

export interface MlbP1M3e5Options {
  generatedAt?: string;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export function buildMlbP1M3e5LiveFrozenEnvelope(
  rows: MlbP1M3dReviewRow[],
  source: MlbP1M3e5SourceSummary,
  options: MlbP1M3e5Options = {},
): MlbP1M3e5Report {
  if (!nonNegativeInteger(source.ownedLedgerRecords)
    || !nonNegativeInteger(source.uniqueAnalyticalDecisions)) {
    throw new Error("P1_M3E5_INVALID_SOURCE_SUMMARY");
  }
  if (source.uniqueAnalyticalDecisions > rows.length) {
    throw new Error(MLB_P1_M3E5_SOURCE_WINDOW_TRUNCATED);
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const freeze = buildMlbP1M3e3OperatingEnvelopeFreeze(rows, { generatedAt });
  const evaluation = buildMlbP1M3e4FrozenManifestEvaluation(rows, freeze, { generatedAt });
  const researchWindowFrozen = freeze.state === "FROZEN_RESEARCH_WINDOW";
  const stableModelQualityEnvelopeSupported = evaluation.state === "STABLE_MODEL_QUALITY_ENVELOPE_RESEARCH_ONLY";

  return {
    schemaVersion: MLB_P1_M3E5_SCHEMA,
    generatedAt,
    state: evaluation.state,
    source: {
      ownerScoped: true,
      immutableLedgerRequired: true,
      terminalInteractiveRowsOnly: true,
      sourceWindowComplete: true,
      ownedLedgerRecords: source.ownedLedgerRecords,
      uniqueAnalyticalDecisions: source.uniqueAnalyticalDecisions,
      terminalReviewRows: rows.length,
    },
    freeze,
    evaluation,
    interpretation: {
      researchWindowFrozen,
      stableModelQualityEnvelopeSupported,
      economicProfitabilityCertified: false,
      operationalRecommendationGateAllowed: false,
      bettingRecommendationAllowed: false,
      stakeChangesAllowed: false,
      automaticBettingAllowed: false,
      modelProbabilityChanged: false,
      existingEconomicThresholdsChanged: false,
      premiumNoUltraProspectiveHypothesisChanged: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
