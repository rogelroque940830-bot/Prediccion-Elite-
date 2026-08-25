import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import {
  adaptMlbV16SettlementEvidence,
  type MlbV16SettlementEvidence,
} from "./mlb-pure-settlement-evidence-adapter";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";
import {
  MlbSelectiveOddsAcquisitionService,
  type MlbSelectiveOddsAcquisitionResult,
} from "./mlb-selective-odds-acquisition";
import { evaluateMlbMarketEdges, type MlbMarketEdgeResult, type MlbMarketProbabilityAssessment } from "./mlb-market-edge";
import { buildMlbOperatingEnvelope, type MlbOperatingEnvelopeResult } from "./mlb-operating-envelope";
import { captureMlbEliteEvidenceLedger, type MlbEliteEvidenceLedger } from "./mlb-elite-evidence-ledger";
import {
  runMlbUnifiedPrepriceStep11c,
  type MlbUnifiedRunnerInput,
  type MlbUnifiedRunnerResult,
} from "./mlb-unified-runner";
import {
  captureMlbDailyBestPickProspective,
  type MlbDailyBestPickProspectiveCustodyStore,
} from "./mlb-daily-best-pick-prospective-custody-v1";

export const MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA = "courtedge-p0-mlb-unified-priced-v16-runner.v1" as const;

export interface MlbUnifiedPricedV16RunnerInput extends MlbUnifiedRunnerInput {
  c4ByGame: Readonly<Record<number, C4LiveFeatureAssessment | undefined>>;
  oddsService: MlbSelectiveOddsAcquisitionService;
  providerAccountScopeKey: string;
  apiKey: string;
  maxRunCredits: number;
  reserveCredits: number;
  dailyBestPickProspectiveCustody?: Pick<MlbDailyBestPickProspectiveCustodyStore, "putFirstCanonical">;
}

export interface MlbUnifiedPricedV16RunnerResult {
  schemaVersion: typeof MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA;
  runId: string;
  generatedAt: string;
  date: string;
  preprice: MlbUnifiedRunnerResult;
  settlementEvidence: readonly MlbV16SettlementEvidence[];
  modelAssessments: readonly MlbMarketProbabilityAssessment[];
  acquisition: MlbSelectiveOddsAcquisitionResult;
  marketEdge: MlbMarketEdgeResult;
  operatingEnvelope: MlbOperatingEnvelopeResult;
  eliteEvidenceLedger: MlbEliteEvidenceLedger;
  summary: {
    finalGamesScoredByV16: number;
    modelAssessments: number;
    paidLookupEligibleGames: number;
    positiveEvMarkets: number;
    eliteEvidenceCandidates: number;
    eliteEvidenceRowsCaptured: number;
  };
  policy: {
    explicitInvocationRequired: true;
    automaticPolling: false;
    v16PriceIndependent: true;
    provisionalGamesScoredByV16: false;
    missingFinalC4FailsClosed: true;
    nonMlF5MarketsRemainFailClosedWithoutAnotherValidatedAdapter: true;
    discoveryPlanMutatedBeforeOddsAcquisition: false;
    priceCanCreateIntrinsicThesis: false;
    additionalEliteFilterApplied: false;
    betEliteProduced: false;
    finalBetRecommendationProduced: false;
    stakeCalculated: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function buildV16Evidence(input: MlbUnifiedPricedV16RunnerInput, preprice: MlbUnifiedRunnerResult): MlbV16SettlementEvidence[] {
  const finalEligible = preprice.cheapScreen.games.filter(
    (game) => game.eligibleForDeepPrefilterNow && game.finalInputsAvailable,
  );
  const finalEligiblePks = new Set(finalEligible.map((game) => game.gamePk));

  for (const rawKey of Object.keys(input.c4ByGame)) {
    const gamePk = Number(rawKey);
    if (!Number.isInteger(gamePk) || !finalEligiblePks.has(gamePk)) {
      throw new Error(`MLB_UNIFIED_PRICED_V16_EXTRA_C4_ASSESSMENT:${rawKey}`);
    }
  }

  return finalEligible.map((game) => {
    const c4 = input.c4ByGame[game.gamePk];
    if (!c4) throw new Error(`MLB_UNIFIED_PRICED_V16_C4_REQUIRED:${game.gamePk}`);
    return scoreMlbV16SettlementEvidence(game.gamePk, preprice.generatedAt, c4);
  });
}

function gameDateMap(preprice: MlbUnifiedRunnerResult): Record<number, string> {
  return Object.fromEntries(preprice.cheapScreen.games.map((game) => [game.gamePk, preprice.date]));
}

export async function runMlbUnifiedPricedV16Step11c(
  input: MlbUnifiedPricedV16RunnerInput,
): Promise<MlbUnifiedPricedV16RunnerResult> {
  const preprice = runMlbUnifiedPrepriceStep11c(input);

  // Freeze the exact current Step11c population and Daily BEST PICK selector state
  // immediately after the trusted preprice runtime is created and before any paid
  // odds acquisition. Custody failure is logged but cannot change the sporting
  // selection or downstream production behavior.
  try {
    captureMlbDailyBestPickProspective({
      preprice,
      capturedAtUtc: preprice.generatedAt,
      custody: input.dailyBestPickProspectiveCustody,
    });
  } catch (error) {
    console.error("[mlb-daily-best-pick-prospective] capture failed closed", error);
  }

  const settlementEvidence = buildV16Evidence(input, preprice);
  const modelAssessments = settlementEvidence.flatMap((evidence) => adaptMlbV16SettlementEvidence(evidence));

  const acquisition = await input.oddsService.acquire({
    runId: input.runId,
    providerAccountScopeKey: input.providerAccountScopeKey,
    discovery: preprice.discovery,
    maxRunCredits: input.maxRunCredits,
    reserveCredits: input.reserveCredits,
    apiKey: input.apiKey,
  });

  const marketEdge = evaluateMlbMarketEdges({
    acquisition,
    modelAssessments,
    now: new Date(preprice.generatedAt),
  });
  const operatingEnvelope = buildMlbOperatingEnvelope({ marketEdge });
  const eliteEvidenceLedger = captureMlbEliteEvidenceLedger({
    operatingEnvelope,
    marketEdge,
    capturedAt: preprice.generatedAt,
    gameDateByGamePk: gameDateMap(preprice),
  });

  return Object.freeze({
    schemaVersion: MLB_UNIFIED_PRICED_V16_RUNNER_SCHEMA,
    runId: input.runId,
    generatedAt: preprice.generatedAt,
    date: preprice.date,
    preprice,
    settlementEvidence: Object.freeze([...settlementEvidence]),
    modelAssessments: Object.freeze([...modelAssessments]),
    acquisition,
    marketEdge,
    operatingEnvelope,
    eliteEvidenceLedger,
    summary: Object.freeze({
      finalGamesScoredByV16: settlementEvidence.length,
      modelAssessments: modelAssessments.length,
      paidLookupEligibleGames: preprice.discovery.summary.gamesPaidLookupEligibleNow,
      positiveEvMarkets: marketEdge.summary.positiveEvMarkets,
      eliteEvidenceCandidates: operatingEnvelope.summary.eliteEvidenceCandidates,
      eliteEvidenceRowsCaptured: eliteEvidenceLedger.summary.capturedCandidates,
    }),
    policy: Object.freeze({
      explicitInvocationRequired: true as const,
      automaticPolling: false as const,
      v16PriceIndependent: true as const,
      provisionalGamesScoredByV16: false as const,
      missingFinalC4FailsClosed: true as const,
      nonMlF5MarketsRemainFailClosedWithoutAnotherValidatedAdapter: true as const,
      discoveryPlanMutatedBeforeOddsAcquisition: false as const,
      priceCanCreateIntrinsicThesis: false as const,
      additionalEliteFilterApplied: false as const,
      betEliteProduced: false as const,
      finalBetRecommendationProduced: false as const,
      stakeCalculated: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
