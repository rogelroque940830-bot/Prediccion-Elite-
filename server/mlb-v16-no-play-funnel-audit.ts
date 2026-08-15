import type { MlbUnifiedPricedV16RunnerResult } from "./mlb-unified-priced-v16-runner";

export const MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA = "courtedge-p0-v16-no-play-funnel-audit.v1" as const;

export type MlbV16NoPlayPrimaryBlocker =
  | "NONE"
  | "NO_FINAL_INPUTS"
  | "NO_DEEP_PREFILTER_ELIGIBILITY"
  | "NO_INTRINSIC_THESIS"
  | "NO_PAID_LOOKUP_ELIGIBILITY"
  | "NO_PRICE_OR_STALE_PRICE"
  | "NO_POSITIVE_EV"
  | "POSITIVE_EV_ENVELOPE_BLOCKED"
  | "NO_ELITE_EVIDENCE_CANDIDATE";

export interface MlbV16NoPlayFunnelAudit {
  schemaVersion: typeof MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA;
  generatedAt: string;
  runId: string;
  date: string;
  counts: {
    slateGames: number;
    analysisAllowedGames: number;
    finalInputGames: number;
    deepPrefilterEligibleGames: number;
    v16ScoredGames: number;
    intrinsicThesisGames: number;
    paidLookupEligibleGames: number;
    pricedThesisMarkets: number;
    positiveEvMarkets: number;
    positiveEvEnvelopeBlocked: number;
    eliteEvidenceCandidates: number;
    eliteEvidenceRowsCaptured: number;
  };
  primaryBlocker: MlbV16NoPlayPrimaryBlocker;
  diagnostics: {
    blockedOrUnavailableMarkets: number;
    noPositiveEvMarkets: number;
    upstreamBlockedMarkets: number;
  };
  policy: {
    diagnosticsOnly: true;
    changesModel: false;
    changesThresholds: false;
    changesRecommendation: false;
    changesStake: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function countAnalysisAllowedGames(result: MlbUnifiedPricedV16RunnerResult): number {
  const games = result.preprice.cheapScreen.games as readonly Record<string, unknown>[];
  return games.filter((game) => game.analysisAllowed === true || game.eligibleForDeepPrefilterNow === true).length;
}

function countFinalInputGames(result: MlbUnifiedPricedV16RunnerResult): number {
  return result.preprice.cheapScreen.games.filter((game) => game.finalInputsAvailable).length;
}

function countDeepPrefilterEligibleGames(result: MlbUnifiedPricedV16RunnerResult): number {
  return result.preprice.cheapScreen.games.filter((game) => game.eligibleForDeepPrefilterNow).length;
}

function countIntrinsicThesisGames(result: MlbUnifiedPricedV16RunnerResult): number {
  const games = result.preprice.discovery.games as readonly Record<string, unknown>[];
  return games.filter((game) => {
    const thesisMarkets = game.thesisMarkets;
    if (Array.isArray(thesisMarkets)) return thesisMarkets.length > 0;
    const markets = game.markets;
    if (Array.isArray(markets)) return markets.length > 0;
    const intrinsicThesis = game.intrinsicThesis;
    if (Array.isArray(intrinsicThesis)) return intrinsicThesis.length > 0;
    return game.paidLookupEligibleNow === true || game.eligibleForPaidLookupNow === true;
  }).length;
}

function countPricedThesisMarkets(result: MlbUnifiedPricedV16RunnerResult): number {
  return result.marketEdge.games
    .flatMap((game) => game.markets)
    .filter((market) => market.execution != null).length;
}

function earliestPrimaryBlocker(
  counts: MlbV16NoPlayFunnelAudit["counts"],
  diagnostics: MlbV16NoPlayFunnelAudit["diagnostics"],
): MlbV16NoPlayPrimaryBlocker {
  if (counts.eliteEvidenceRowsCaptured > 0) return "NONE";
  if (counts.finalInputGames === 0) return "NO_FINAL_INPUTS";
  if (counts.deepPrefilterEligibleGames === 0) return "NO_DEEP_PREFILTER_ELIGIBILITY";
  if (counts.intrinsicThesisGames === 0) return "NO_INTRINSIC_THESIS";
  if (counts.paidLookupEligibleGames === 0) return "NO_PAID_LOOKUP_ELIGIBILITY";
  if (counts.pricedThesisMarkets === 0 || diagnostics.blockedOrUnavailableMarkets > 0 && counts.positiveEvMarkets === 0 && counts.noPositiveEvMarkets === 0) {
    return "NO_PRICE_OR_STALE_PRICE";
  }
  if (counts.positiveEvMarkets === 0) return "NO_POSITIVE_EV";
  if (counts.positiveEvEnvelopeBlocked > 0 && counts.eliteEvidenceCandidates === 0) return "POSITIVE_EV_ENVELOPE_BLOCKED";
  return "NO_ELITE_EVIDENCE_CANDIDATE";
}

export function auditMlbV16NoPlayFunnel(result: MlbUnifiedPricedV16RunnerResult): MlbV16NoPlayFunnelAudit {
  const slateGames = result.preprice.cheapScreen.games.length;
  const allEnvelopeMarkets = result.operatingEnvelope.games.flatMap((game) => game.markets);
  const diagnostics = {
    blockedOrUnavailableMarkets: result.marketEdge.summary.blockedOrUnavailableMarkets,
    noPositiveEvMarkets: result.marketEdge.summary.noPositiveEvMarkets,
    upstreamBlockedMarkets: allEnvelopeMarkets.filter((market) => market.classification === "UPSTREAM_BLOCKED").length,
  };
  const counts = {
    slateGames,
    analysisAllowedGames: countAnalysisAllowedGames(result),
    finalInputGames: countFinalInputGames(result),
    deepPrefilterEligibleGames: countDeepPrefilterEligibleGames(result),
    v16ScoredGames: result.summary.finalGamesScoredByV16,
    intrinsicThesisGames: countIntrinsicThesisGames(result),
    paidLookupEligibleGames: result.summary.paidLookupEligibleGames,
    pricedThesisMarkets: countPricedThesisMarkets(result),
    positiveEvMarkets: result.summary.positiveEvMarkets,
    positiveEvEnvelopeBlocked: result.operatingEnvelope.summary.positiveEvEnvelopeBlocked,
    eliteEvidenceCandidates: result.summary.eliteEvidenceCandidates,
    eliteEvidenceRowsCaptured: result.summary.eliteEvidenceRowsCaptured,
  };

  return Object.freeze({
    schemaVersion: MLB_V16_NO_PLAY_FUNNEL_AUDIT_SCHEMA,
    generatedAt: result.generatedAt,
    runId: result.runId,
    date: result.date,
    counts: Object.freeze(counts),
    primaryBlocker: earliestPrimaryBlocker(counts, diagnostics),
    diagnostics: Object.freeze(diagnostics),
    policy: Object.freeze({
      diagnosticsOnly: true as const,
      changesModel: false as const,
      changesThresholds: false as const,
      changesRecommendation: false as const,
      changesStake: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
