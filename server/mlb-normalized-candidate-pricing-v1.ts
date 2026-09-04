import crypto from "node:crypto";
import {
  MLB_EXECUTION_BOOK_PRIORITY,
  MLB_P1_M6A2_MAX_QUOTE_AGE_MS,
  type MlbCanonicalMarketAvailability,
  type MlbNormalizedBookQuote,
  type MlbReferenceConsensusQuote,
  type MlbSelectionSide,
} from "./mlb-market-odds-normalizer";
import type { MlbMarketType } from "./mlb-market-contract";
import {
  mlbP1M4aAmericanToDecimal,
  mlbP1M4aAmericanToImpliedProbability,
} from "./mlb-p1-economic-decision-contract";
import type { MlbSelectiveOddsAcquisitionResult } from "./mlb-selective-odds-acquisition";
import type {
  MlbNormalizedCandidatePool,
  MlbNormalizedSportingCandidate,
} from "./mlb-normalized-candidate-pool-v1";

export const MLB_NORMALIZED_CANDIDATE_PRICING_SCHEMA =
  "courtedge-mlb-normalized-candidate-pricing.v1" as const;
export const MLB_NORMALIZED_PRICED_CANDIDATE_SCHEMA =
  "courtedge-mlb-normalized-priced-candidate.v1" as const;

export type MlbNormalizedCandidatePriceStatus =
  | "ATTACHED"
  | "UNAVAILABLE"
  | "STALE"
  | "BLOCKED";

export interface MlbCandidatePriceEvidenceGame {
  gamePk: number;
  markets: readonly MlbCanonicalMarketAvailability[];
}

export interface MlbCandidatePriceEvidence {
  schemaVersion: string;
  sourceRunId: string | null;
  generatedAt: string;
  games: readonly MlbCandidatePriceEvidenceGame[];
  providerCalls: {
    paidEventOdds: number | null;
  };
}

export interface MlbNormalizedCandidatePricingSnapshot {
  status: MlbNormalizedCandidatePriceStatus;
  pricingSnapshotId: string | null;
  canonicalMarketType: MlbMarketType | null;
  providerMarketKey: string | null;
  executionBookKey: string | null;
  executionBookTitle: string | null;
  oddsAmerican: number | null;
  oppositeOddsAmerican: number | null;
  marketImpliedProbability: number | null;
  oppositeImpliedProbability: number | null;
  noVigProbability: number | null;
  referenceNoVigProbability: number | null;
  modelDecisiveWinProbability: number | null;
  currentBreakEvenWinProbability: number | null;
  edgePp: number | null;
  noVigEdgePp: number | null;
  referenceNoVigEdgePp: number | null;
  expectedValuePerUnit: number | null;
  capturedAt: string | null;
  providerLastUpdate: string | null;
  freshnessSeconds: number | null;
  maxFreshnessSeconds: number;
  blockers: readonly string[];
  warnings: readonly string[];
}

export type MlbNormalizedPricedCandidate = Omit<
  MlbNormalizedSportingCandidate,
  "schemaVersion" | "pricing" | "globalRank"
> & {
  schemaVersion: typeof MLB_NORMALIZED_PRICED_CANDIDATE_SCHEMA;
  sourceCandidateSnapshotId: string;
  pricing: MlbNormalizedCandidatePricingSnapshot;
  globalRank: {
    eligible: false;
    blockers: readonly string[];
  };
};

export interface MlbNormalizedCandidatePricingResult {
  schemaVersion: typeof MLB_NORMALIZED_CANDIDATE_PRICING_SCHEMA;
  date: string;
  generatedAt: string;
  sourcePoolSchemaVersion: MlbNormalizedCandidatePool["schemaVersion"];
  sourcePriceEvidenceSchemaVersion: string;
  sourcePriceRunId: string | null;
  candidates: readonly MlbNormalizedPricedCandidate[];
  summary: {
    normalizedCandidates: number;
    pricesAttached: number;
    unavailable: number;
    stale: number;
    blocked: number;
    economicsReady: number;
    settlementIncomplete: number;
    globallyRankEligibleCandidates: 0;
  };
  policy: {
    sourceSportingCandidateIdentityPreserved: true;
    priceCanCreateCandidate: false;
    referenceConsensusCanSubstituteExecution: false;
    exactMarketIdentityRequired: true;
    exactLineIdentityRequired: true;
    executionBookPriorityPreserved: true;
    quoteFreshnessRecheckedAtAttachment: true;
    pushAwareEconomicsRequired: true;
    settlementIncompleteEconomicsFailClosed: true;
    noVigUsesBilateralPair: true;
    crossEngineCalibrationAttached: false;
    crossEngineRankPerformed: false;
    recommendsBet: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function round(value: number, digits = 12): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function stableSha256(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function sameLine(left: number | null, right: number | null): boolean {
  if (left == null || right == null) return left === right;
  return Math.abs(left - right) <= 1e-12;
}

function candidateCanonicalMarket(candidate: MlbNormalizedSportingCandidate): MlbMarketType | null {
  if (candidate.market.family === "MONEYLINE" && candidate.market.horizon === "FULL_GAME") return "ML";
  if (candidate.market.family === "MONEYLINE" && candidate.market.horizon === "FIRST_5") return "F5_ML";
  if (candidate.market.family === "MONEYLINE" && candidate.market.horizon === "INNING_1") return "INNING_1_ML";
  if (
    candidate.market.family === "TEAM_TOTAL"
    && candidate.market.horizon === "FIRST_5"
    && candidate.market.sourceMarketType === "TT_OVER_15_F5"
  ) return "TT_OVER_15_F5";
  if (
    candidate.market.family === "TEAM_TOTAL"
    && candidate.market.horizon === "FIRST_5"
    && candidate.market.sourceMarketType === "TT_UNDER_25_F5"
  ) return "TT_UNDER_25_F5";
  return null;
}

function verifiedProviderMapping(marketType: MlbMarketType): string | null {
  if (marketType === "ML") return "h2h";
  if (marketType === "F5_ML") return "h2h_1st_5_innings";
  if (marketType === "INNING_1_ML") return "h2h_1st_1_innings";
  // Registry v1 explicitly records these legacy Early team-total aliases as gaps.
  if (marketType === "TT_OVER_15_F5" || marketType === "TT_UNDER_25_F5") return null;
  return null;
}

function quoteFreshNow(
  quote: MlbNormalizedBookQuote | MlbReferenceConsensusQuote,
  now: Date,
): { fresh: boolean; freshnessSeconds: number | null } {
  const capturedMs = Date.parse(quote.capturedAt);
  const providerMs = Date.parse(String(quote.providerLastUpdate ?? ""));
  if (!Number.isFinite(capturedMs) || !Number.isFinite(providerMs)) {
    return { fresh: false, freshnessSeconds: null };
  }
  const nowMs = now.getTime();
  const captureAgeMs = nowMs - capturedMs;
  const providerAgeMs = nowMs - providerMs;
  const captureFresh = captureAgeMs >= -60_000 && captureAgeMs <= MLB_P1_M6A2_MAX_QUOTE_AGE_MS;
  const providerFresh = providerAgeMs >= -120_000 && providerAgeMs <= MLB_P1_M6A2_MAX_QUOTE_AGE_MS;
  return {
    fresh: captureFresh && providerFresh,
    freshnessSeconds: Math.max(0, providerAgeMs) / 1000,
  };
}

function selectionPair(
  quote: MlbNormalizedBookQuote | MlbReferenceConsensusQuote,
  candidate: MlbNormalizedSportingCandidate,
): {
  selected: MlbNormalizedBookQuote["selections"][number];
  opposite: MlbNormalizedBookQuote["selections"][number];
} | null {
  const side = candidate.market.direction as MlbSelectionSide;
  const selected = quote.selections.find((selection) => selection.side === side);
  const opposite = quote.selections.find((selection) => selection.side !== side);
  if (!selected || !opposite) return null;
  if (!sameLine(selected.line, candidate.market.line) || !sameLine(opposite.line, candidate.market.line)) return null;
  return { selected, opposite };
}

function bilateralProbabilities(pair: {
  selected: MlbNormalizedBookQuote["selections"][number];
  opposite: MlbNormalizedBookQuote["selections"][number];
}): {
  selectedImplied: number;
  oppositeImplied: number;
  noVig: number;
} | null {
  const selectedImplied = mlbP1M4aAmericanToImpliedProbability(pair.selected.oddsAmerican);
  const oppositeImplied = mlbP1M4aAmericanToImpliedProbability(pair.opposite.oddsAmerican);
  if (selectedImplied == null || oppositeImplied == null || selectedImplied + oppositeImplied <= 0) return null;
  return {
    selectedImplied: round(selectedImplied),
    oppositeImplied: round(oppositeImplied),
    noVig: round(selectedImplied / (selectedImplied + oppositeImplied)),
  };
}

function settlementEconomics(candidate: MlbNormalizedSportingCandidate, oddsAmerican: number, noVig: number) {
  const win = candidate.sporting.modelWinProbability;
  const push = candidate.sporting.modelPushProbability;
  const loss = candidate.sporting.modelLossProbability;
  if (!finiteProbability(win) || !finiteProbability(push) || !finiteProbability(loss)) return null;
  if (Math.abs(win + push + loss - 1) > 1e-9) return null;
  const decisiveDenominator = 1 - push;
  if (decisiveDenominator <= 0) return null;
  const decisiveWin = win / decisiveDenominator;
  if (!finiteProbability(decisiveWin) || decisiveWin <= 0 || decisiveWin >= 1) return null;
  const decimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  if (decimal == null) return null;
  const breakEvenWin = decisiveDenominator / decimal;
  const expectedValuePerUnit = win * (decimal - 1) - loss;
  return {
    decisiveWin: round(decisiveWin),
    breakEvenWin: round(breakEvenWin),
    edgePp: round((win - breakEvenWin) * 100, 8),
    noVigEdgePp: round((decisiveWin - noVig) * 100, 8),
    expectedValuePerUnit: round(expectedValuePerUnit, 10),
  };
}

function emptyPricing(
  status: MlbNormalizedCandidatePriceStatus,
  marketType: MlbMarketType | null,
  providerMarketKey: string | null,
  blockers: readonly string[],
): MlbNormalizedCandidatePricingSnapshot {
  return Object.freeze({
    status,
    pricingSnapshotId: null,
    canonicalMarketType: marketType,
    providerMarketKey,
    executionBookKey: null,
    executionBookTitle: null,
    oddsAmerican: null,
    oppositeOddsAmerican: null,
    marketImpliedProbability: null,
    oppositeImpliedProbability: null,
    noVigProbability: null,
    referenceNoVigProbability: null,
    modelDecisiveWinProbability: null,
    currentBreakEvenWinProbability: null,
    edgePp: null,
    noVigEdgePp: null,
    referenceNoVigEdgePp: null,
    expectedValuePerUnit: null,
    capturedAt: null,
    providerLastUpdate: null,
    freshnessSeconds: null,
    maxFreshnessSeconds: MLB_P1_M6A2_MAX_QUOTE_AGE_MS / 1000,
    blockers: Object.freeze([...blockers]),
    warnings: Object.freeze([]),
  });
}

function attachPricing(input: {
  candidate: MlbNormalizedSportingCandidate;
  gameEvidence: MlbCandidatePriceEvidenceGame | undefined;
  now: Date;
}): MlbNormalizedCandidatePricingSnapshot {
  const marketType = candidateCanonicalMarket(input.candidate);
  if (!marketType) {
    return emptyPricing("BLOCKED", null, null, ["CANDIDATE_MARKET_NOT_MAPPED_TO_CANONICAL_PRICE_CONTRACT"]);
  }
  const providerMarketKey = verifiedProviderMapping(marketType);
  if (!providerMarketKey) {
    return emptyPricing("BLOCKED", marketType, null, ["VERIFIED_PROVIDER_MARKET_MAPPING_MISSING"]);
  }
  if (!input.gameEvidence) {
    return emptyPricing("UNAVAILABLE", marketType, providerMarketKey, ["PRICE_EVIDENCE_GAME_MISSING"]);
  }
  const matchingMarkets = input.gameEvidence.markets.filter((market) =>
    market.marketType === marketType && market.providerMarketKey === providerMarketKey);
  if (matchingMarkets.length !== 1) {
    return emptyPricing(
      matchingMarkets.length > 1 ? "BLOCKED" : "UNAVAILABLE",
      marketType,
      providerMarketKey,
      [matchingMarkets.length > 1 ? "PRICE_MARKET_IDENTITY_DUPLICATE" : "PRICE_MARKET_IDENTITY_MISSING"],
    );
  }
  const market = matchingMarkets[0];
  const execution = market.execution.quote;
  if (!execution) {
    const stale = market.execution.status === "STALE";
    return emptyPricing(
      stale ? "STALE" : "UNAVAILABLE",
      marketType,
      providerMarketKey,
      [stale ? "EXECUTION_QUOTE_STALE" : "FRESH_EXECUTION_QUOTE_REQUIRED"],
    );
  }
  if (!MLB_EXECUTION_BOOK_PRIORITY.includes(execution.bookKey as any)) {
    return emptyPricing("BLOCKED", marketType, providerMarketKey, ["EXECUTION_BOOK_NOT_AUTHORIZED"]);
  }
  const executionFreshness = quoteFreshNow(execution, input.now);
  if (!executionFreshness.fresh) {
    return emptyPricing("STALE", marketType, providerMarketKey, ["EXECUTION_QUOTE_EXPIRED_AT_ATTACHMENT"]);
  }
  const pair = selectionPair(execution, input.candidate);
  if (!pair) {
    return emptyPricing("BLOCKED", marketType, providerMarketKey, ["EXECUTION_SELECTION_OR_LINE_IDENTITY_MISMATCH"]);
  }
  const probabilities = bilateralProbabilities(pair);
  if (!probabilities) {
    return emptyPricing("BLOCKED", marketType, providerMarketKey, ["EXECUTION_BILATERAL_PRICE_PAIR_INVALID"]);
  }

  const economics = settlementEconomics(input.candidate, pair.selected.oddsAmerican, probabilities.noVig);
  const warnings: string[] = [];
  let referenceNoVigProbability: number | null = null;
  let referenceNoVigEdgePp: number | null = null;
  const reference = market.reference.quote;
  if (reference && quoteFreshNow(reference, input.now).fresh) {
    const referencePair = selectionPair(reference, input.candidate);
    const referenceProbabilities = referencePair ? bilateralProbabilities(referencePair) : null;
    if (referenceProbabilities) {
      referenceNoVigProbability = referenceProbabilities.noVig;
      if (economics) {
        referenceNoVigEdgePp = round((economics.decisiveWin - referenceProbabilities.noVig) * 100, 8);
      }
    } else {
      warnings.push("REFERENCE_SELECTION_OR_LINE_IDENTITY_MISMATCH");
    }
  } else {
    warnings.push("REFERENCE_CONSENSUS_NOT_FRESH_OR_UNAVAILABLE");
  }

  const pricingIdentity = {
    candidateSnapshotId: input.candidate.candidateSnapshotId,
    marketType,
    providerMarketKey,
    bookKey: execution.bookKey,
    selected: pair.selected,
    opposite: pair.opposite,
    capturedAt: execution.capturedAt,
    providerLastUpdate: execution.providerLastUpdate,
  };
  const pricingSnapshotId = stableSha256(pricingIdentity);
  const blockers = economics ? [] : ["SETTLEMENT_ECONOMICS_NOT_COMPUTABLE"];

  return Object.freeze({
    status: "ATTACHED" as const,
    pricingSnapshotId,
    canonicalMarketType: marketType,
    providerMarketKey,
    executionBookKey: execution.bookKey,
    executionBookTitle: execution.bookTitle,
    oddsAmerican: pair.selected.oddsAmerican,
    oppositeOddsAmerican: pair.opposite.oddsAmerican,
    marketImpliedProbability: probabilities.selectedImplied,
    oppositeImpliedProbability: probabilities.oppositeImplied,
    noVigProbability: probabilities.noVig,
    referenceNoVigProbability,
    modelDecisiveWinProbability: economics?.decisiveWin ?? null,
    currentBreakEvenWinProbability: economics?.breakEvenWin ?? null,
    edgePp: economics?.edgePp ?? null,
    noVigEdgePp: economics?.noVigEdgePp ?? null,
    referenceNoVigEdgePp,
    expectedValuePerUnit: economics?.expectedValuePerUnit ?? null,
    capturedAt: execution.capturedAt,
    providerLastUpdate: execution.providerLastUpdate,
    freshnessSeconds: executionFreshness.freshnessSeconds == null
      ? null
      : round(executionFreshness.freshnessSeconds, 3),
    maxFreshnessSeconds: MLB_P1_M6A2_MAX_QUOTE_AGE_MS / 1000,
    blockers: Object.freeze(blockers),
    warnings: Object.freeze(warnings),
  });
}

function updatedGlobalRankBlockers(
  candidate: MlbNormalizedSportingCandidate,
  pricing: MlbNormalizedCandidatePricingSnapshot,
): readonly string[] {
  const blockers = candidate.globalRank.blockers.filter((blocker) => blocker !== "PRICE_NOT_ATTACHED");
  if (pricing.status !== "ATTACHED") blockers.push("PRICE_NOT_ATTACHED");
  if (pricing.status === "ATTACHED" && pricing.blockers.includes("SETTLEMENT_ECONOMICS_NOT_COMPUTABLE")) {
    if (!blockers.includes("SETTLEMENT_MODEL_INCOMPLETE")) blockers.push("SETTLEMENT_MODEL_INCOMPLETE");
  }
  return Object.freeze([...new Set(blockers)].sort((left, right) => left.localeCompare(right)));
}

export function buildMlbNormalizedCandidatePricing(input: {
  pool: MlbNormalizedCandidatePool;
  priceEvidence: MlbCandidatePriceEvidence;
  now?: Date;
}): MlbNormalizedCandidatePricingResult {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_NORMALIZED_CANDIDATE_PRICING_NOW_INVALID");
  if (input.pool.date !== input.priceEvidence.generatedAt.slice(0, 10) && !Number.isFinite(Date.parse(input.priceEvidence.generatedAt))) {
    throw new Error("MLB_NORMALIZED_CANDIDATE_PRICE_EVIDENCE_TIME_INVALID");
  }
  const evidenceByGame = new Map<number, MlbCandidatePriceEvidenceGame>();
  for (const game of input.priceEvidence.games) {
    if (!Number.isInteger(game.gamePk) || game.gamePk <= 0 || evidenceByGame.has(game.gamePk)) {
      throw new Error(`MLB_NORMALIZED_CANDIDATE_PRICE_EVIDENCE_GAME_INVALID:${game.gamePk}`);
    }
    evidenceByGame.set(game.gamePk, game);
  }

  const candidates = Object.freeze(input.pool.candidates.map((candidate): MlbNormalizedPricedCandidate => {
    const pricing = attachPricing({
      candidate,
      gameEvidence: evidenceByGame.get(candidate.game.gamePk),
      now,
    });
    return Object.freeze({
      ...candidate,
      schemaVersion: MLB_NORMALIZED_PRICED_CANDIDATE_SCHEMA,
      sourceCandidateSnapshotId: candidate.candidateSnapshotId,
      pricing,
      globalRank: Object.freeze({
        eligible: false as const,
        blockers: updatedGlobalRankBlockers(candidate, pricing),
      }),
    });
  }));

  return Object.freeze({
    schemaVersion: MLB_NORMALIZED_CANDIDATE_PRICING_SCHEMA,
    date: input.pool.date,
    generatedAt: now.toISOString(),
    sourcePoolSchemaVersion: input.pool.schemaVersion,
    sourcePriceEvidenceSchemaVersion: input.priceEvidence.schemaVersion,
    sourcePriceRunId: input.priceEvidence.sourceRunId,
    candidates,
    summary: Object.freeze({
      normalizedCandidates: candidates.length,
      pricesAttached: candidates.filter((candidate) => candidate.pricing.status === "ATTACHED").length,
      unavailable: candidates.filter((candidate) => candidate.pricing.status === "UNAVAILABLE").length,
      stale: candidates.filter((candidate) => candidate.pricing.status === "STALE").length,
      blocked: candidates.filter((candidate) => candidate.pricing.status === "BLOCKED").length,
      economicsReady: candidates.filter((candidate) => candidate.pricing.expectedValuePerUnit != null).length,
      settlementIncomplete: candidates.filter((candidate) =>
        candidate.globalRank.blockers.includes("SETTLEMENT_MODEL_INCOMPLETE"),
      ).length,
      globallyRankEligibleCandidates: 0 as const,
    }),
    policy: Object.freeze({
      sourceSportingCandidateIdentityPreserved: true as const,
      priceCanCreateCandidate: false as const,
      referenceConsensusCanSubstituteExecution: false as const,
      exactMarketIdentityRequired: true as const,
      exactLineIdentityRequired: true as const,
      executionBookPriorityPreserved: true as const,
      quoteFreshnessRecheckedAtAttachment: true as const,
      pushAwareEconomicsRequired: true as const,
      settlementIncompleteEconomicsFailClosed: true as const,
      noVigUsesBilateralPair: true as const,
      crossEngineCalibrationAttached: false as const,
      crossEngineRankPerformed: false as const,
      recommendsBet: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}

export function candidatePriceEvidenceFromSelectiveOddsAcquisition(
  acquisition: MlbSelectiveOddsAcquisitionResult,
): MlbCandidatePriceEvidence {
  return Object.freeze({
    schemaVersion: acquisition.schemaVersion,
    sourceRunId: acquisition.runId,
    generatedAt: acquisition.generatedAt,
    games: Object.freeze(acquisition.games.map((game) => Object.freeze({
      gamePk: game.gamePk,
      markets: game.quoteMarkets,
    }))),
    providerCalls: Object.freeze({
      paidEventOdds: acquisition.providerCalls.paidEventOdds,
    }),
  });
}
