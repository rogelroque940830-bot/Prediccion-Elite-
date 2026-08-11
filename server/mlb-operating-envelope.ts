import type {
  MlbMarketEdgeGameResult,
  MlbMarketEdgeMarketResult,
  MlbMarketEdgeResult,
} from "./mlb-market-edge";

export const MLB_OPERATING_ENVELOPE_SCHEMA = "courtedge-p0-mlb-operating-envelope.v1" as const;

export type MlbOperatingEnvelopeClassification =
  | "ELITE_EVIDENCE_CANDIDATE"
  | "POSITIVE_EV_ENVELOPE_BLOCKED"
  | "NO_POSITIVE_EV"
  | "UPSTREAM_BLOCKED";

export interface MlbOperatingEnvelopeMarketResult {
  marketType: MlbMarketEdgeMarketResult["marketType"];
  providerMarketKey: string;
  selectedSide: MlbMarketEdgeMarketResult["selectedSide"];
  selectedLine: number | null;
  classification: MlbOperatingEnvelopeClassification;
  eliteEvidenceCandidate: boolean;
  intrinsicProjectionScope: MlbMarketEdgeMarketResult["intrinsicProjectionScope"];
  intrinsicThesisKinds: MlbMarketEdgeMarketResult["intrinsicThesisKinds"];
  supportingComponents: MlbMarketEdgeMarketResult["supportingComponents"];
  modelWinProbability: number | null;
  modelPushProbability: number | null;
  expectedValuePerUnit: number | null;
  executionEdgePp: number | null;
  executionNoVigEdgePp: number | null;
  referenceNoVigEdgePp: number | null;
  referenceAgreement: MlbMarketEdgeMarketResult["economics"]["referenceAgreement"];
  blockers: readonly string[];
  warnings: readonly string[];
}

export interface MlbOperatingEnvelopeGameResult {
  gamePk: number;
  intrinsicRank: number;
  homeTeam: MlbMarketEdgeGameResult["homeTeam"];
  awayTeam: MlbMarketEdgeGameResult["awayTeam"];
  markets: readonly MlbOperatingEnvelopeMarketResult[];
  summary: {
    eliteEvidenceCandidates: number;
    positiveEvEnvelopeBlocked: number;
    noPositiveEv: number;
    upstreamBlocked: number;
  };
}

export interface MlbOperatingEnvelopeResult {
  schemaVersion: typeof MLB_OPERATING_ENVELOPE_SCHEMA;
  generatedAt: string;
  sourceMarketEdgeSchemaVersion: MlbMarketEdgeResult["schemaVersion"];
  sourceRunId: string;
  games: readonly MlbOperatingEnvelopeGameResult[];
  summary: {
    games: number;
    markets: number;
    eliteEvidenceCandidates: number;
    positiveEvEnvelopeBlocked: number;
    noPositiveEv: number;
    upstreamBlocked: number;
  };
  policy: {
    positiveEvRequired: true;
    upstreamOperatingEnvelopeEligibilityRequired: true;
    readyModelRequired: true;
    freshExecutablePriceRequired: true;
    intrinsicResearchEliteThesisRequiredUpstream: true;
    intactIntrinsicThesisRequired: true;
    intactSupportingComponentsRequired: true;
    noUpstreamBlockersRequired: true;
    positiveExpectedValueMustBeFinite: true;
    fixedEvThresholdApplied: false;
    fixedProbabilityThresholdApplied: false;
    referenceConsensusCanCreateEliteCandidate: false;
    referenceConsensusCanVetoEliteCandidate: false;
    referenceConsensusRemainsDiagnosticOnly: true;
    marketRankingProduced: false;
    numericEliteScoreProduced: false;
    outcomeProfitabilityCertified: false;
    finalBetRecommendationProduced: false;
    betEliteLabelProduced: false;
    stakeCalculated: false;
    callsTheOddsApi: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
  safety: MlbMarketEdgeResult["safety"];
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function classifyMarket(market: MlbMarketEdgeMarketResult): MlbOperatingEnvelopeMarketResult {
  const upstreamBlocked = market.classification !== "POSITIVE_EV" && market.classification !== "NO_POSITIVE_EV";
  const positiveEv = market.classification === "POSITIVE_EV";
  const intactThesis = market.intrinsicThesisKinds.length > 0 && market.supportingComponents.length > 0;
  const readyModel = market.model.status === "READY";
  const freshExecutablePrice = market.execution != null;
  const positiveFiniteEv = finitePositive(market.economics.expectedValuePerUnit);
  const noBlockers = market.blockers.length === 0;

  const eliteEvidenceCandidate = positiveEv
    && market.eligibleForOperatingEnvelope
    && intactThesis
    && readyModel
    && freshExecutablePrice
    && positiveFiniteEv
    && noBlockers;

  const classification: MlbOperatingEnvelopeClassification = eliteEvidenceCandidate
    ? "ELITE_EVIDENCE_CANDIDATE"
    : positiveEv
      ? "POSITIVE_EV_ENVELOPE_BLOCKED"
      : upstreamBlocked
        ? "UPSTREAM_BLOCKED"
        : "NO_POSITIVE_EV";

  return {
    marketType: market.marketType,
    providerMarketKey: market.providerMarketKey,
    selectedSide: market.selectedSide,
    selectedLine: market.selectedLine,
    classification,
    eliteEvidenceCandidate,
    intrinsicProjectionScope: market.intrinsicProjectionScope,
    intrinsicThesisKinds: market.intrinsicThesisKinds,
    supportingComponents: market.supportingComponents,
    modelWinProbability: market.model.winProbability,
    modelPushProbability: market.model.pushProbability,
    expectedValuePerUnit: market.economics.expectedValuePerUnit,
    executionEdgePp: market.economics.executionEdgePp,
    executionNoVigEdgePp: market.economics.executionNoVigEdgePp,
    referenceNoVigEdgePp: market.economics.referenceNoVigEdgePp,
    referenceAgreement: market.economics.referenceAgreement,
    blockers: market.blockers,
    warnings: market.warnings,
  };
}

function summarize(markets: readonly MlbOperatingEnvelopeMarketResult[]) {
  return {
    eliteEvidenceCandidates: markets.filter((market) => market.classification === "ELITE_EVIDENCE_CANDIDATE").length,
    positiveEvEnvelopeBlocked: markets.filter((market) => market.classification === "POSITIVE_EV_ENVELOPE_BLOCKED").length,
    noPositiveEv: markets.filter((market) => market.classification === "NO_POSITIVE_EV").length,
    upstreamBlocked: markets.filter((market) => market.classification === "UPSTREAM_BLOCKED").length,
  };
}

export function buildMlbOperatingEnvelope(input: { marketEdge: MlbMarketEdgeResult }): MlbOperatingEnvelopeResult {
  const games = input.marketEdge.games.map((game) => {
    const markets = game.markets.map(classifyMarket);
    return {
      gamePk: game.gamePk,
      intrinsicRank: game.intrinsicRank,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      markets,
      summary: summarize(markets),
    };
  });
  const allMarkets = games.flatMap((game) => game.markets);
  const totals = summarize(allMarkets);

  return {
    schemaVersion: MLB_OPERATING_ENVELOPE_SCHEMA,
    generatedAt: new Date().toISOString(),
    sourceMarketEdgeSchemaVersion: input.marketEdge.schemaVersion,
    sourceRunId: input.marketEdge.sourceRunId,
    games,
    summary: {
      games: games.length,
      markets: allMarkets.length,
      ...totals,
    },
    policy: {
      positiveEvRequired: true,
      upstreamOperatingEnvelopeEligibilityRequired: true,
      readyModelRequired: true,
      freshExecutablePriceRequired: true,
      intrinsicResearchEliteThesisRequiredUpstream: true,
      intactIntrinsicThesisRequired: true,
      intactSupportingComponentsRequired: true,
      noUpstreamBlockersRequired: true,
      positiveExpectedValueMustBeFinite: true,
      fixedEvThresholdApplied: false,
      fixedProbabilityThresholdApplied: false,
      referenceConsensusCanCreateEliteCandidate: false,
      referenceConsensusCanVetoEliteCandidate: false,
      referenceConsensusRemainsDiagnosticOnly: true,
      marketRankingProduced: false,
      numericEliteScoreProduced: false,
      outcomeProfitabilityCertified: false,
      finalBetRecommendationProduced: false,
      betEliteLabelProduced: false,
      stakeCalculated: false,
      callsTheOddsApi: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
    safety: input.marketEdge.safety,
  };
}
