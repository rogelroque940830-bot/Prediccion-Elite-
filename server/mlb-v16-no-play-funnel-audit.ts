import type { MlbMarketEdgeClassification } from "./mlb-market-edge";
import type { MlbOperatingEnvelopeClassification } from "./mlb-operating-envelope";
import type { MlbUnifiedPricedV16RunnerResult } from "./mlb-unified-priced-v16-runner";

export const MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA = "courtedge-p0-v16-no-play-funnel-audit.v3" as const;

export type MlbV16NoPlayPrimaryBlocker =
  | "NONE"
  | "NO_FINAL_INPUTS"
  | "NO_V16_SCORED_FINAL_GAME"
  | "NO_SHORTLIST_SIGNAL_QUALIFICATION"
  | "EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP"
  | "NO_STRONG_INTRINSIC_THESIS_ON_V16_SCORED_GAMES"
  | "MIXED_PREPRICE_ROUTING_BLOCKERS"
  | "NO_PAID_LOOKUP_ELIGIBILITY"
  | "NO_FRESH_EXECUTABLE_PRICE"
  | "MARKET_OR_MODEL_BLOCKED"
  | "NO_POSITIVE_EV"
  | "POSITIVE_EV_ENVELOPE_BLOCKED"
  | "NO_ELITE_EVIDENCE_CANDIDATE";

export type MlbV16GameAuditBlocker =
  | "NONE"
  | "NO_V16_SCORE"
  | "NO_SHORTLIST_SIGNAL_QUALIFICATION"
  | "EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP"
  | "NO_STRONG_INTRINSIC_MARKET_THESIS"
  | "NO_PAID_LOOKUP_ELIGIBILITY"
  | "NO_FRESH_EXECUTABLE_PRICE"
  | "MARKET_OR_MODEL_BLOCKED"
  | "NO_POSITIVE_EV"
  | "POSITIVE_EV_ENVELOPE_BLOCKED"
  | "NO_ELITE_EVIDENCE_CANDIDATE";

export interface MlbV16NoPlayGameAudit {
  gamePk: number;
  sportsPrediction: {
    scoredByV16: boolean;
    fullGameHomeWinProbability: number | null;
    fullGameAwayWinProbability: number | null;
    first5HomeWinProbability: number | null;
    first5AwayWinProbability: number | null;
    first5TieProbability: number | null;
  };
  prePriceRouting: {
    shortlistEvaluated: boolean;
    shortlistQualified: boolean;
    shortlistSelected: boolean;
    certifiedComponentCount: number | null;
    independentSignalCount: number | null;
    intrinsicEvaluated: boolean;
    intrinsicResearchClassification: string | null;
    selectedForMarketDiscovery: boolean;
    intrinsicRank: number | null;
    plannedMarkets: readonly string[];
    paidLookupEligibleNow: boolean;
    paidLookupHoldReason: "OFFICIAL_FINAL_INPUTS_REQUIRED" | "NO_STRONG_INTRINSIC_MARKET_THESIS" | null;
  };
  bettingEconomics: {
    pricedMarkets: number;
    positiveEvMarkets: number;
    noPositiveEvMarkets: number;
    blockedOrUnavailableMarkets: number;
    eliteEvidenceCandidates: number;
    marketClassifications: readonly MlbMarketEdgeClassification[];
    operatingEnvelopeClassifications: readonly MlbOperatingEnvelopeClassification[];
  };
  earliestBlocker: MlbV16GameAuditBlocker;
}

export interface MlbV16NoPlayFunnelAudit {
  schemaVersion: typeof MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA;
  generatedAt: string;
  runId: string;
  date: string;
  counts: {
    slateGames: number;
    analysisEligibleGames: number;
    finalAnalysisEligibleGames: number;
    provisionalAnalysisEligibleGames: number;
    v16ScoredGames: number;
    v16ScoredWithoutShortlistQualification: number;
    v16ScoredExcludedByIntrinsicDiscoveryCap: number;
    v16ScoredSelectedForMarketDiscovery: number;
    v16ScoredWithoutStrongIntrinsicThesis: number;
    v16ScoredWithIntrinsicThesis: number;
    paidLookupEligibleGames: number;
    pricedThesisMarkets: number;
    positiveEvMarkets: number;
    noPositiveEvMarkets: number;
    blockedOrUnavailableMarkets: number;
    positiveEvEnvelopeBlocked: number;
    eliteEvidenceCandidates: number;
    eliteEvidenceRowsCaptured: number;
  };
  blockerCounts: Readonly<Record<MlbV16GameAuditBlocker, number>>;
  primaryBlocker: MlbV16NoPlayPrimaryBlocker;
  marketClassificationCounts: Readonly<Record<MlbMarketEdgeClassification, number>>;
  gameAudits: readonly MlbV16NoPlayGameAudit[];
  policy: {
    diagnosticsOnly: true;
    predictionRemainsPriceIndependent: true;
    changesModel: false;
    changesFeatures: false;
    changesThresholds: false;
    changesShortlistQualification: false;
    changesIntrinsicDiscoveryCap: false;
    changesIntrinsicThesisRules: false;
    changesOddsAcquisition: false;
    changesMarketEconomics: false;
    changesOperatingEnvelope: false;
    changesRecommendation: false;
    changesStake: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

const MARKET_CLASSIFICATIONS: readonly MlbMarketEdgeClassification[] = [
  "POSITIVE_EV",
  "NO_POSITIVE_EV",
  "MODEL_UNAVAILABLE",
  "MODEL_INVALID",
  "PUSH_PROBABILITY_REQUIRED",
  "PRICE_UNUSABLE",
  "QUOTE_STALE",
  "THESIS_AMBIGUOUS",
  "CONTRACT_BLOCKED",
] as const;

const GAME_BLOCKERS: readonly MlbV16GameAuditBlocker[] = [
  "NONE",
  "NO_V16_SCORE",
  "NO_SHORTLIST_SIGNAL_QUALIFICATION",
  "EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP",
  "NO_STRONG_INTRINSIC_MARKET_THESIS",
  "NO_PAID_LOOKUP_ELIGIBILITY",
  "NO_FRESH_EXECUTABLE_PRICE",
  "MARKET_OR_MODEL_BLOCKED",
  "NO_POSITIVE_EV",
  "POSITIVE_EV_ENVELOPE_BLOCKED",
  "NO_ELITE_EVIDENCE_CANDIDATE",
] as const;

function marketClassificationCounts(result: MlbUnifiedPricedV16RunnerResult): Record<MlbMarketEdgeClassification, number> {
  const counts = Object.fromEntries(MARKET_CLASSIFICATIONS.map((classification) => [classification, 0])) as Record<
    MlbMarketEdgeClassification,
    number
  >;
  for (const market of result.marketEdge.games.flatMap((game) => game.markets)) counts[market.classification] += 1;
  return counts;
}

function buildGameAudit(
  result: MlbUnifiedPricedV16RunnerResult,
  gamePk: number,
): MlbV16NoPlayGameAudit {
  const evidence = result.settlementEvidence.find((row) => row.gamePk === gamePk);
  const shortlist = result.preprice.shortlist.candidates.find((row) => row.gamePk === gamePk);
  const shortlistSelected = result.preprice.shortlist.selected.some((row) => row.gamePk === gamePk);
  const intrinsic = result.preprice.intrinsic.games.find((row) => row.gamePk === gamePk);
  const intrinsicRankIndex = result.preprice.intrinsic.rankedGames.findIndex((row) => row.gamePk === gamePk);
  const selectedForMarketDiscovery = intrinsicRankIndex >= 0;
  const discovery = result.preprice.discovery.games.find((row) => row.gamePk === gamePk);
  const edgeGame = result.marketEdge.games.find((row) => row.gamePk === gamePk);
  const envelopeGame = result.operatingEnvelope.games.find((row) => row.gamePk === gamePk);
  const edgeMarkets = edgeGame?.markets ?? [];
  const envelopeMarkets = envelopeGame?.markets ?? [];
  const pricedMarkets = edgeMarkets.filter((market) => market.execution != null).length;
  const positiveEvMarkets = edgeMarkets.filter((market) => market.classification === "POSITIVE_EV").length;
  const noPositiveEvMarkets = edgeMarkets.filter((market) => market.classification === "NO_POSITIVE_EV").length;
  const blockedOrUnavailableMarkets = edgeMarkets.length - positiveEvMarkets - noPositiveEvMarkets;
  const eliteEvidenceCandidates = envelopeMarkets.filter((market) => market.classification === "ELITE_EVIDENCE_CANDIDATE").length;
  const positiveEvEnvelopeBlocked = envelopeMarkets.filter(
    (market) => market.classification === "POSITIVE_EV_ENVELOPE_BLOCKED",
  ).length;
  const plannedMarkets = discovery?.plannedMarkets.map((market) => market.canonicalMarketType) ?? [];

  let earliestBlocker: MlbV16GameAuditBlocker = "NONE";
  if (!evidence) earliestBlocker = "NO_V16_SCORE";
  else if (!shortlist?.qualifiedForShortlist) earliestBlocker = "NO_SHORTLIST_SIGNAL_QUALIFICATION";
  else if (!selectedForMarketDiscovery) earliestBlocker = "EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP";
  else if (plannedMarkets.length === 0) earliestBlocker = "NO_STRONG_INTRINSIC_MARKET_THESIS";
  else if (!discovery?.paidLookupEligibleNow) earliestBlocker = "NO_PAID_LOOKUP_ELIGIBILITY";
  else if (pricedMarkets === 0) earliestBlocker = "NO_FRESH_EXECUTABLE_PRICE";
  else if (positiveEvMarkets === 0 && noPositiveEvMarkets > 0) earliestBlocker = "NO_POSITIVE_EV";
  else if (positiveEvMarkets === 0 && blockedOrUnavailableMarkets > 0) earliestBlocker = "MARKET_OR_MODEL_BLOCKED";
  else if (positiveEvEnvelopeBlocked > 0 && eliteEvidenceCandidates === 0) earliestBlocker = "POSITIVE_EV_ENVELOPE_BLOCKED";
  else if (eliteEvidenceCandidates === 0) earliestBlocker = "NO_ELITE_EVIDENCE_CANDIDATE";

  return Object.freeze({
    gamePk,
    sportsPrediction: Object.freeze({
      scoredByV16: evidence != null,
      fullGameHomeWinProbability: evidence?.fullGame.homeWinProbability ?? null,
      fullGameAwayWinProbability: evidence?.fullGame.awayWinProbability ?? null,
      first5HomeWinProbability: evidence?.first5.homeWinProbability ?? null,
      first5AwayWinProbability: evidence?.first5.awayWinProbability ?? null,
      first5TieProbability: evidence?.first5.pushProbability ?? null,
    }),
    prePriceRouting: Object.freeze({
      shortlistEvaluated: shortlist != null,
      shortlistQualified: shortlist?.qualifiedForShortlist ?? false,
      shortlistSelected,
      certifiedComponentCount: shortlist?.certifiedComponentCount ?? null,
      independentSignalCount: shortlist?.independentSignalCount ?? null,
      intrinsicEvaluated: intrinsic != null,
      intrinsicResearchClassification: intrinsic?.researchClassification ?? null,
      selectedForMarketDiscovery,
      intrinsicRank: selectedForMarketDiscovery ? intrinsicRankIndex + 1 : null,
      plannedMarkets: Object.freeze([...plannedMarkets]),
      paidLookupEligibleNow: discovery?.paidLookupEligibleNow ?? false,
      paidLookupHoldReason: discovery?.paidLookupHoldReason ?? null,
    }),
    bettingEconomics: Object.freeze({
      pricedMarkets,
      positiveEvMarkets,
      noPositiveEvMarkets,
      blockedOrUnavailableMarkets,
      eliteEvidenceCandidates,
      marketClassifications: Object.freeze(edgeMarkets.map((market) => market.classification)),
      operatingEnvelopeClassifications: Object.freeze(envelopeMarkets.map((market) => market.classification)),
    }),
    earliestBlocker,
  });
}

function countBlockers(gameAudits: readonly MlbV16NoPlayGameAudit[]): Record<MlbV16GameAuditBlocker, number> {
  const counts = Object.fromEntries(GAME_BLOCKERS.map((blocker) => [blocker, 0])) as Record<MlbV16GameAuditBlocker, number>;
  for (const game of gameAudits) counts[game.earliestBlocker] += 1;
  return counts;
}

function primaryBlocker(
  counts: MlbV16NoPlayFunnelAudit["counts"],
  blockers: Readonly<Record<MlbV16GameAuditBlocker, number>>,
): MlbV16NoPlayPrimaryBlocker {
  if (counts.eliteEvidenceRowsCaptured > 0) return "NONE";
  if (counts.finalAnalysisEligibleGames === 0) return "NO_FINAL_INPUTS";
  if (counts.v16ScoredGames === 0 || blockers.NO_V16_SCORE === counts.finalAnalysisEligibleGames) return "NO_V16_SCORED_FINAL_GAME";

  if (counts.v16ScoredWithIntrinsicThesis === 0) {
    const activePreprice = [
      ["NO_SHORTLIST_SIGNAL_QUALIFICATION", blockers.NO_SHORTLIST_SIGNAL_QUALIFICATION],
      ["EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP", blockers.EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP],
      ["NO_STRONG_INTRINSIC_THESIS_ON_V16_SCORED_GAMES", blockers.NO_STRONG_INTRINSIC_MARKET_THESIS],
    ] as const;
    const nonzero = activePreprice.filter(([, count]) => count > 0);
    if (nonzero.length === 1) return nonzero[0][0];
    if (nonzero.length > 1) return "MIXED_PREPRICE_ROUTING_BLOCKERS";
  }

  if (counts.paidLookupEligibleGames === 0) return "NO_PAID_LOOKUP_ELIGIBILITY";
  if (counts.pricedThesisMarkets === 0) return "NO_FRESH_EXECUTABLE_PRICE";
  if (counts.positiveEvMarkets === 0 && counts.noPositiveEvMarkets > 0) return "NO_POSITIVE_EV";
  if (counts.positiveEvMarkets === 0 && counts.blockedOrUnavailableMarkets > 0) return "MARKET_OR_MODEL_BLOCKED";
  if (counts.positiveEvEnvelopeBlocked > 0 && counts.eliteEvidenceCandidates === 0) return "POSITIVE_EV_ENVELOPE_BLOCKED";
  return "NO_ELITE_EVIDENCE_CANDIDATE";
}

export function auditMlbV16NoPlayFunnel(result: MlbUnifiedPricedV16RunnerResult): MlbV16NoPlayFunnelAudit {
  const finalEligibleGamePks = result.preprice.cheapScreen.games
    .filter((game) => game.eligibleForDeepPrefilterNow && game.finalInputsAvailable)
    .map((game) => game.gamePk);
  const gameAudits = finalEligibleGamePks.map((gamePk) => buildGameAudit(result, gamePk));
  const blockers = countBlockers(gameAudits);
  const allEdgeMarkets = result.marketEdge.games.flatMap((game) => game.markets);
  const scoredAudits = gameAudits.filter((game) => game.sportsPrediction.scoredByV16);
  const counts = {
    slateGames: result.preprice.summary.slateGames,
    analysisEligibleGames: result.preprice.summary.analysisEligibleGames,
    finalAnalysisEligibleGames: result.preprice.summary.finalAnalysisEligibleGames,
    provisionalAnalysisEligibleGames: result.preprice.summary.provisionalAnalysisEligibleGames,
    v16ScoredGames: result.summary.finalGamesScoredByV16,
    v16ScoredWithoutShortlistQualification: scoredAudits.filter(
      (game) => game.earliestBlocker === "NO_SHORTLIST_SIGNAL_QUALIFICATION",
    ).length,
    v16ScoredExcludedByIntrinsicDiscoveryCap: scoredAudits.filter(
      (game) => game.earliestBlocker === "EXCLUDED_BY_INTRINSIC_DISCOVERY_CAP",
    ).length,
    v16ScoredSelectedForMarketDiscovery: scoredAudits.filter(
      (game) => game.prePriceRouting.selectedForMarketDiscovery,
    ).length,
    v16ScoredWithoutStrongIntrinsicThesis: scoredAudits.filter(
      (game) => game.earliestBlocker === "NO_STRONG_INTRINSIC_MARKET_THESIS",
    ).length,
    v16ScoredWithIntrinsicThesis: scoredAudits.filter(
      (game) => game.prePriceRouting.plannedMarkets.length > 0,
    ).length,
    paidLookupEligibleGames: result.preprice.discovery.summary.gamesPaidLookupEligibleNow,
    pricedThesisMarkets: allEdgeMarkets.filter((market) => market.execution != null).length,
    positiveEvMarkets: result.marketEdge.summary.positiveEvMarkets,
    noPositiveEvMarkets: result.marketEdge.summary.noPositiveEvMarkets,
    blockedOrUnavailableMarkets: result.marketEdge.summary.blockedOrUnavailableMarkets,
    positiveEvEnvelopeBlocked: result.operatingEnvelope.summary.positiveEvEnvelopeBlocked,
    eliteEvidenceCandidates: result.operatingEnvelope.summary.eliteEvidenceCandidates,
    eliteEvidenceRowsCaptured: result.eliteEvidenceLedger.summary.capturedCandidates,
  };
  const classifications = marketClassificationCounts(result);

  return Object.freeze({
    schemaVersion: MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA,
    generatedAt: result.generatedAt,
    runId: result.runId,
    date: result.date,
    counts: Object.freeze(counts),
    blockerCounts: Object.freeze(blockers),
    primaryBlocker: primaryBlocker(counts, blockers),
    marketClassificationCounts: Object.freeze(classifications),
    gameAudits: Object.freeze(gameAudits),
    policy: Object.freeze({
      diagnosticsOnly: true as const,
      predictionRemainsPriceIndependent: true as const,
      changesModel: false as const,
      changesFeatures: false as const,
      changesThresholds: false as const,
      changesShortlistQualification: false as const,
      changesIntrinsicDiscoveryCap: false as const,
      changesIntrinsicThesisRules: false as const,
      changesOddsAcquisition: false as const,
      changesMarketEconomics: false as const,
      changesOperatingEnvelope: false as const,
      changesRecommendation: false as const,
      changesStake: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
