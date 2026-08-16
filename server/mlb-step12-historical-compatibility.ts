export const MLB_STEP12_HISTORICAL_COMPATIBILITY_SCHEMA = "courtedge-p0-step12-historical-compatibility.v1" as const;

export type MlbStep12CompatibilityStatus =
  | "PREGAME_COMPATIBLE"
  | "OUTCOME_ONLY"
  | "MARKET_PRICE_MISSING"
  | "SCHEMA_TRANSLATION_REQUIRED"
  | "LEAKAGE_RISK"
  | "INCOMPATIBLE";

export interface MlbStep12HistoricalEvidenceFamily {
  key: string;
  label: string;
  status: MlbStep12CompatibilityStatus;
  sourceScope: string;
  asOfBoundary: string | null;
  historicalCoverageGames: number | null;
  historicalCoveragePct: number | null;
  discoveryEligible: boolean;
  settlementEligible: boolean;
  priceAwareEconomicEligible: boolean;
  notes: readonly string[];
}

export interface MlbStep12HistoricalCompatibilityReport {
  schemaVersion: typeof MLB_STEP12_HISTORICAL_COMPATIBILITY_SCHEMA;
  cohort: {
    season: 2025;
    startDate: "2025-03-01";
    endDate: "2025-10-01";
    officialRegularSeasonFinalGames: 2430;
    uniqueOfficialDates: 184;
    heldOutValidationGamesPerHorizon: 1507;
  };
  families: readonly MlbStep12HistoricalEvidenceFamily[];
  policy: {
    historicalDiscoveryBeforeProspectivePromotion: true;
    chronologicalOosRequired: true;
    postgameFeaturesForbiddenForDiscovery: true;
    missingHistoricalPricesDoNotBlockSportingSignalDiscovery: true;
    missingHistoricalPricesBlockHistoricalEvClaims: true;
    historicalHitRateCanDirectlyProduceBetElite: false;
    highHitRatePocketsMayBeInvestigated: true;
    lowerHitRateStableSignalsRemainEligibleForResearch: true;
    qualityAndFrequencyMustBeReportedTogether: true;
    livePickFiltersChanged: false;
    step11cCapturePopulationChanged: false;
    betEliteLabelProduced: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

const FAMILIES: readonly MlbStep12HistoricalEvidenceFamily[] = [
  {
    key: "official_outcomes",
    label: "MLB official final and horizon outcomes",
    status: "OUTCOME_ONLY",
    sourceScope: "MLB_STATS_API_OFFICIAL",
    asOfBoundary: null,
    historicalCoverageGames: 2430,
    historicalCoveragePct: 100,
    discoveryEligible: false,
    settlementEligible: true,
    priceAwareEconomicEligible: false,
    notes: [
      "Canonical sporting outcome identity is frozen by outcomeDigest.",
      "Outcomes are labels only and may never be used as pregame features.",
    ],
  },
  {
    key: "league_distribution_baseline",
    label: "League/home-away run distribution baseline",
    status: "PREGAME_COMPATIBLE",
    sourceScope: "P1-M6A3B1 rolling-origin Poisson/NB2 baseline",
    asOfBoundary: "training dates strictly precede validation dates",
    historicalCoverageGames: 2430,
    historicalCoveragePct: 100,
    discoveryEligible: true,
    settlementEligible: false,
    priceAwareEconomicEligible: false,
    notes: [
      "Existing rolling-origin folds are leakage-free.",
      "This is a benchmark feature family, not a betting rule.",
    ],
  },
  {
    key: "team_strength",
    label: "Historical as-of team-strength evidence",
    status: "PREGAME_COMPATIBLE",
    sourceScope: "P1-M6A3B2A team-strength OOS",
    asOfBoundary: "rolling-origin historical information only",
    historicalCoverageGames: 2430,
    historicalCoveragePct: 100,
    discoveryEligible: true,
    settlementEligible: false,
    priceAwareEconomicEligible: false,
    notes: [
      "2025 paired inference was inconclusive when team strength was tested alone.",
      "Inconclusive alone does not prohibit testing interactions with other pregame signals.",
    ],
  },
  {
    key: "starting_pitcher",
    label: "Historical as-of starting-pitcher evidence",
    status: "PREGAME_COMPATIBLE",
    sourceScope: "P1-M6A3B2B2/B2B2B starting-pitcher OOS",
    asOfBoundary: "pregame starter history available before target game",
    historicalCoverageGames: 2430,
    historicalCoveragePct: 100,
    discoveryEligible: true,
    settlementEligible: false,
    priceAwareEconomicEligible: false,
    notes: [
      "2025 paired inference produced small favorable point estimates but remained inconclusive family-wise.",
      "This feature may still participate in interaction/pocket discovery.",
    ],
  },
  {
    key: "official_t5_lineup",
    label: "Official batting-order snapshot at T-5",
    status: "PREGAME_COMPATIBLE",
    sourceScope: "P1-M6A3B2C1/C2 official pregame lineup history",
    asOfBoundary: "five minutes before scheduled/resolved historical start",
    historicalCoverageGames: 2423,
    historicalCoveragePct: 99.711934,
    discoveryEligible: true,
    settlementEligible: false,
    priceAwareEconomicEligible: false,
    notes: [
      "Seven of 2430 games lack certified complete T-5 lineups and must remain explicit missingness.",
      "Missing historical lineup evidence may not be imputed from postgame batting orders.",
    ],
  },
  {
    key: "historical_execution_price",
    label: "Historical sportsbook execution price comparable to Step 9",
    status: "MARKET_PRICE_MISSING",
    sourceScope: "No frozen comparable sportsbook execution-price cohort currently certified",
    asOfBoundary: "would require timestamped pregame quote compatible with Step 9 execution contract",
    historicalCoverageGames: null,
    historicalCoveragePct: null,
    discoveryEligible: false,
    settlementEligible: false,
    priceAwareEconomicEligible: false,
    notes: [
      "Missing historical prices do not block sporting-signal discovery.",
      "Historical EV, no-vig edge and ROI may not be manufactured without certified comparable prices.",
    ],
  },
  {
    key: "step11_current_economic_fields",
    label: "Current Step 9/11 EV and reference-agreement fields",
    status: "SCHEMA_TRANSLATION_REQUIRED",
    sourceScope: "Current price-aware pipeline",
    asOfBoundary: "pregame live execution quote",
    historicalCoverageGames: null,
    historicalCoveragePct: null,
    discoveryEligible: false,
    settlementEligible: false,
    priceAwareEconomicEligible: false,
    notes: [
      "These fields are prospectively valid through Step 11C.",
      "They cannot be backfilled into 2025 unless equivalent historical price evidence is certified.",
    ],
  },
];

export function buildMlbStep12HistoricalCompatibilityReport(): MlbStep12HistoricalCompatibilityReport {
  for (const family of FAMILIES) {
    if ((family.status === "LEAKAGE_RISK" || family.status === "INCOMPATIBLE" || family.status === "OUTCOME_ONLY")
      && family.discoveryEligible) {
      throw new Error(`MLB_STEP12_INVALID_DISCOVERY_ELIGIBILITY:${family.key}`);
    }
    if (family.priceAwareEconomicEligible && family.status !== "PREGAME_COMPATIBLE") {
      throw new Error(`MLB_STEP12_INVALID_PRICE_AWARE_ELIGIBILITY:${family.key}`);
    }
  }

  return {
    schemaVersion: MLB_STEP12_HISTORICAL_COMPATIBILITY_SCHEMA,
    cohort: {
      season: 2025,
      startDate: "2025-03-01",
      endDate: "2025-10-01",
      officialRegularSeasonFinalGames: 2430,
      uniqueOfficialDates: 184,
      heldOutValidationGamesPerHorizon: 1507,
    },
    families: FAMILIES,
    policy: {
      historicalDiscoveryBeforeProspectivePromotion: true,
      chronologicalOosRequired: true,
      postgameFeaturesForbiddenForDiscovery: true,
      missingHistoricalPricesDoNotBlockSportingSignalDiscovery: true,
      missingHistoricalPricesBlockHistoricalEvClaims: true,
      historicalHitRateCanDirectlyProduceBetElite: false,
      highHitRatePocketsMayBeInvestigated: true,
      lowerHitRateStableSignalsRemainEligibleForResearch: true,
      qualityAndFrequencyMustBeReportedTogether: true,
      livePickFiltersChanged: false,
      step11cCapturePopulationChanged: false,
      betEliteLabelProduced: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
}
