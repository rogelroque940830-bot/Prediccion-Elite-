import {
  rankMlbIntrinsicGames,
  type MlbIntrinsicEdgeResult,
  type MlbIntrinsicGameProfile,
  type MlbIntrinsicThesisKind,
  type MlbIntrinsicThesisStructure,
} from "./mlb-intrinsic-edge";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import type { MlbV16SettlementEvidence } from "./mlb-pure-settlement-evidence-adapter";
import type {
  MlbShortlistCoreComponent,
  MlbShortlistCoreEvidenceState,
  MlbShortlistQualificationDisposition,
} from "./mlb-shortlist";

export const MLB_DAILY_OPPORTUNITY_CONTEXT_SCHEMA =
  "courtedge-mlb-daily-opportunity-context.v1" as const;

export const MLB_DAILY_OPPORTUNITY_LINEUP_P95_DELTA = 0.0533 as const;

export type MlbDailyOpportunityAction = "WAIT" | "PLAY_NOW_CANDIDATE" | "NO_PLAY";
export type MlbDailyOpportunityProbabilityStage =
  | "CONFIRMED_V16"
  | "PROVISIONAL_V16"
  | "INTRINSIC_ONLY";

export interface MlbDailyOpportunityMarketProbabilities {
  ml: {
    homeWinProbability: number;
    awayWinProbability: number;
  };
  f5Ml: {
    homeWinProbability: number;
    awayWinProbability: number;
    pushProbability: number;
  } | null;
}

export interface MlbDailyOpportunityEvidenceCoverage {
  coreState: MlbShortlistCoreEvidenceState;
  qualificationDisposition: MlbShortlistQualificationDisposition;
  pending: boolean;
  certifiedCoreComponents: readonly MlbShortlistCoreComponent[];
  signalCoreComponents: readonly MlbShortlistCoreComponent[];
  neutralCoreComponents: readonly MlbShortlistCoreComponent[];
  unavailableCoreComponents: readonly MlbShortlistCoreComponent[];
  missingDataCountsAsNegativeEvidence: false;
}

export type MlbDailyOpportunityEvidenceCoverageByGame = Readonly<Record<
  number,
  MlbDailyOpportunityEvidenceCoverage | undefined
>>;

export interface MlbDailyOpportunityEntry {
  gamePk: number;
  officialDate: string;
  startTime: string | null;
  awayTeam: string;
  homeTeam: string;
  inputStage: "FINAL" | "PROVISIONAL";
  contextRank: number;
  intrinsicClassification: MlbIntrinsicGameProfile["researchClassification"];
  eligibleSportingOpportunity: boolean;
  evidenceCoverage: MlbDailyOpportunityEvidenceCoverage | null;
  context: {
    thesisKinds: readonly MlbIntrinsicThesisKind[];
    thesisStructures: readonly MlbIntrinsicThesisStructure[];
    supportingComponents: readonly string[];
    fullGameElite: boolean;
    earlyWindowElite: boolean;
    maxAbsoluteNativeRunSignal: number;
  };
  probability: {
    stage: MlbDailyOpportunityProbabilityStage;
    selectedSide: "HOME" | "AWAY" | null;
    selectedSideProbability: number | null;
    lineupUncertaintyP95: number;
    robustSelectedSideProbability: number | null;
    marketProbabilities?: MlbDailyOpportunityMarketProbabilities | null;
  };
}

export interface MlbDailyOpportunityContextResult {
  schemaVersion: typeof MLB_DAILY_OPPORTUNITY_CONTEXT_SCHEMA;
  date: string;
  generatedAt: string;
  action: MlbDailyOpportunityAction;
  primaryOpportunity: MlbDailyOpportunityEntry | null;
  nonDominatedFrontier: readonly MlbDailyOpportunityEntry[];
  rankedOpportunities: readonly MlbDailyOpportunityEntry[];
  summary: {
    intrinsicEvaluatedGames: number;
    eligibleSportingOpportunities: number;
    provisionalEligibleOpportunities: number;
    finalEligibleOpportunities: number;
    frontierSize: number;
    evidencePendingGames: number;
    provisionalEvidencePendingGames: number;
  };
  decisionReason:
    | "NO_CONTEXT_QUALIFIED_OPPORTUNITY"
    | "PROVISIONAL_OPPORTUNITY_REMAINS_NON_DOMINATED"
    | "BEST_NON_DOMINATED_OPPORTUNITY_IS_FINAL";
  policy: {
    outcomesRead: false;
    marketPricesRead: false;
    oneUniversalWeightedScoreUsed: false;
    contextRankUsesExistingIntrinsicEngine: true;
    wholeQualifiedIntrinsicPopulationRanked: true;
    marketDiscoveryCapMayHideDailyOpportunity: false;
    finalInputStatusAffectsContextRank: false;
    gameStartTimeAffectsContextRank: false;
    provisionalGamesMayLeadDailyOpportunity: true;
    empiricalLineupUncertaintyAppliedToProvisionalV16Only: true;
    probabilityThresholdCreatesOpportunityEligibility: false;
    confirmationMayDowngradeToNoPlay: true;
    missingDataCountsAsNegativeEvidence: false;
    incompleteEvidenceRemainsExplicitlyUnresolved: true;
    v68Changed: false;
    v80Changed: false;
    productionDailyBestPickChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

type EvidenceByGame = Readonly<Record<number, MlbV16SettlementEvidence | undefined>>;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validF5Vector(evidence: MlbV16SettlementEvidence): boolean {
  const first5 = evidence.first5;
  return [
    first5.homeWinProbability,
    first5.awayWinProbability,
    first5.pushProbability,
  ].every(validProbability)
    && Math.abs(
      first5.homeWinProbability
      + first5.awayWinProbability
      + first5.pushProbability
      - 1,
    ) <= 1e-10;
}

function marketProbabilitiesFor(
  evidence: MlbV16SettlementEvidence,
): MlbDailyOpportunityMarketProbabilities {
  return Object.freeze({
    ml: Object.freeze({
      homeWinProbability: evidence.fullGame.homeWinProbability,
      awayWinProbability: evidence.fullGame.awayWinProbability,
    }),
    f5Ml: validF5Vector(evidence)
      ? Object.freeze({
          homeWinProbability: evidence.first5.homeWinProbability,
          awayWinProbability: evidence.first5.awayWinProbability,
          pushProbability: evidence.first5.pushProbability,
        })
      : null,
  });
}

function probabilityFor(
  game: MlbIntrinsicGameProfile,
  finalV16ByGame: EvidenceByGame,
  provisionalV16ByGame: EvidenceByGame,
): MlbDailyOpportunityEntry["probability"] {
  const evidence = game.inputStage === "FINAL"
    ? finalV16ByGame[game.gamePk]
    : provisionalV16ByGame[game.gamePk];

  if (!evidence) {
    return {
      stage: "INTRINSIC_ONLY",
      selectedSide: null,
      selectedSideProbability: null,
      lineupUncertaintyP95: game.inputStage === "PROVISIONAL"
        ? MLB_DAILY_OPPORTUNITY_LINEUP_P95_DELTA
        : 0,
      robustSelectedSideProbability: null,
      marketProbabilities: null,
    };
  }

  const home = evidence.fullGame.homeWinProbability;
  const away = evidence.fullGame.awayWinProbability;
  if (!Number.isFinite(home) || !Number.isFinite(away) || Math.abs(home + away - 1) > 1e-10) {
    throw new Error(`MLB_DAILY_OPPORTUNITY_V16_VECTOR_INVALID:${game.gamePk}`);
  }
  const selectedSide = home >= away ? "HOME" as const : "AWAY" as const;
  const selectedSideProbability = Math.max(home, away);
  const lineupUncertaintyP95 = game.inputStage === "PROVISIONAL"
    ? MLB_DAILY_OPPORTUNITY_LINEUP_P95_DELTA
    : 0;
  const robustSelectedSideProbability = Math.max(
    0,
    selectedSideProbability - lineupUncertaintyP95,
  );

  return {
    stage: game.inputStage === "FINAL" ? "CONFIRMED_V16" : "PROVISIONAL_V16",
    selectedSide,
    selectedSideProbability,
    lineupUncertaintyP95,
    robustSelectedSideProbability,
    marketProbabilities: marketProbabilitiesFor(evidence),
  };
}

function entryFor(
  game: MlbIntrinsicGameProfile,
  contextRank: number,
  finalV16ByGame: EvidenceByGame,
  provisionalV16ByGame: EvidenceByGame,
  coverageByGame: MlbDailyOpportunityEvidenceCoverageByGame,
): MlbDailyOpportunityEntry {
  const eliteTheses = [
    ...game.projections.fullGame.theses,
    ...game.projections.earlyWindow.theses,
  ].filter((thesis) => thesis.researchEliteEligible);

  return Object.freeze({
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    startTime: game.startTime,
    awayTeam: game.awayTeam.name,
    homeTeam: game.homeTeam.name,
    inputStage: game.inputStage,
    contextRank,
    intrinsicClassification: game.researchClassification,
    eligibleSportingOpportunity:
      game.researchEliteCandidate
      && game.researchClassification === "GAME_ELITE_RESEARCH_CANDIDATE",
    evidenceCoverage: coverageByGame[game.gamePk] ?? null,
    context: Object.freeze({
      thesisKinds: Object.freeze(uniqueSorted(eliteTheses.map((thesis) => thesis.kind))) as readonly MlbIntrinsicThesisKind[],
      thesisStructures: Object.freeze(uniqueSorted(eliteTheses.map((thesis) => thesis.structure))) as readonly MlbIntrinsicThesisStructure[],
      supportingComponents: Object.freeze(uniqueSorted(eliteTheses.flatMap((thesis) => thesis.supportingComponents))),
      fullGameElite: game.projections.fullGame.researchEliteCandidate,
      earlyWindowElite: game.projections.earlyWindow.researchEliteCandidate,
      maxAbsoluteNativeRunSignal: game.maxAbsoluteNativeRunSignal,
    }),
    probability: Object.freeze(probabilityFor(game, finalV16ByGame, provisionalV16ByGame)),
  });
}

function dominates(a: MlbDailyOpportunityEntry, b: MlbDailyOpportunityEntry): boolean {
  if (!a.eligibleSportingOpportunity || !b.eligibleSportingOpportunity) return false;
  if (a.contextRank > b.contextRank) return false;

  const ap = a.probability.robustSelectedSideProbability;
  const bp = b.probability.robustSelectedSideProbability;

  if (ap === null && bp !== null) return false;
  if (ap !== null && bp === null) return true;
  if (ap === null && bp === null) return a.contextRank < b.contextRank;

  return (ap as number) >= (bp as number)
    && (a.contextRank < b.contextRank || (ap as number) > (bp as number));
}

function validateIdentity(slate: MlbP1DailySlate, intrinsic: MlbIntrinsicEdgeResult): void {
  if (slate.date !== intrinsic.date) {
    throw new Error(`MLB_DAILY_OPPORTUNITY_DATE_MISMATCH:${slate.date}:${intrinsic.date}`);
  }
  const slatePks = new Set(slate.games.map((game) => game.gamePk));
  const seen = new Set<number>();
  for (const game of intrinsic.games) {
    if (!slatePks.has(game.gamePk)) {
      throw new Error(`MLB_DAILY_OPPORTUNITY_GAME_NOT_IN_SLATE:${game.gamePk}`);
    }
    if (seen.has(game.gamePk)) {
      throw new Error(`MLB_DAILY_OPPORTUNITY_DUPLICATE_GAME:${game.gamePk}`);
    }
    seen.add(game.gamePk);
  }
}

export function buildMlbDailyOpportunityContext(input: {
  slate: MlbP1DailySlate;
  intrinsic: MlbIntrinsicEdgeResult;
  finalV16ByGame?: EvidenceByGame;
  provisionalV16ByGame?: EvidenceByGame;
  evidenceCoverageByGame?: MlbDailyOpportunityEvidenceCoverageByGame;
}): MlbDailyOpportunityContextResult {
  validateIdentity(input.slate, input.intrinsic);
  const finalV16ByGame = input.finalV16ByGame ?? {};
  const provisionalV16ByGame = input.provisionalV16ByGame ?? {};
  const evidenceCoverageByGame = input.evidenceCoverageByGame ?? {};

  // Market discovery intentionally keeps a top-8 quota-control cap. The Daily Opportunity
  // decision has a different job: identify the best sporting opportunity of the entire
  // qualified slate. Re-rank the full intrinsic population here so a ninth or later game
  // can never disappear merely because it was not needed for paid market discovery.
  const fullContextRanking = rankMlbIntrinsicGames(input.intrinsic.games);
  const rankedOpportunities = Object.freeze(fullContextRanking.map((game, index) =>
    entryFor(game, index + 1, finalV16ByGame, provisionalV16ByGame, evidenceCoverageByGame),
  ));
  const eligible = rankedOpportunities.filter((entry) => entry.eligibleSportingOpportunity);
  const frontier = Object.freeze(eligible.filter((candidate) =>
    !eligible.some((other) => other.gamePk !== candidate.gamePk && dominates(other, candidate)),
  ));
  const primaryOpportunity = frontier[0] ?? null;
  const evidencePending = rankedOpportunities.filter((entry) => entry.evidenceCoverage?.pending === true);

  let action: MlbDailyOpportunityAction = "NO_PLAY";
  let decisionReason: MlbDailyOpportunityContextResult["decisionReason"] =
    "NO_CONTEXT_QUALIFIED_OPPORTUNITY";

  if (primaryOpportunity) {
    if (frontier.some((entry) => entry.inputStage === "PROVISIONAL")) {
      action = "WAIT";
      decisionReason = "PROVISIONAL_OPPORTUNITY_REMAINS_NON_DOMINATED";
    } else {
      action = "PLAY_NOW_CANDIDATE";
      decisionReason = "BEST_NON_DOMINATED_OPPORTUNITY_IS_FINAL";
    }
  }

  return Object.freeze({
    schemaVersion: MLB_DAILY_OPPORTUNITY_CONTEXT_SCHEMA,
    date: input.slate.date,
    generatedAt: input.intrinsic.generatedAt,
    action,
    primaryOpportunity,
    nonDominatedFrontier: frontier,
    rankedOpportunities,
    summary: Object.freeze({
      intrinsicEvaluatedGames: rankedOpportunities.length,
      eligibleSportingOpportunities: eligible.length,
      provisionalEligibleOpportunities: eligible.filter((entry) => entry.inputStage === "PROVISIONAL").length,
      finalEligibleOpportunities: eligible.filter((entry) => entry.inputStage === "FINAL").length,
      frontierSize: frontier.length,
      evidencePendingGames: evidencePending.length,
      provisionalEvidencePendingGames: evidencePending.filter((entry) => entry.inputStage === "PROVISIONAL").length,
    }),
    decisionReason,
    policy: Object.freeze({
      outcomesRead: false as const,
      marketPricesRead: false as const,
      oneUniversalWeightedScoreUsed: false as const,
      contextRankUsesExistingIntrinsicEngine: true as const,
      wholeQualifiedIntrinsicPopulationRanked: true as const,
      marketDiscoveryCapMayHideDailyOpportunity: false as const,
      finalInputStatusAffectsContextRank: false as const,
      gameStartTimeAffectsContextRank: false as const,
      provisionalGamesMayLeadDailyOpportunity: true as const,
      empiricalLineupUncertaintyAppliedToProvisionalV16Only: true as const,
      probabilityThresholdCreatesOpportunityEligibility: false as const,
      confirmationMayDowngradeToNoPlay: true as const,
      missingDataCountsAsNegativeEvidence: false as const,
      incompleteEvidenceRemainsExplicitlyUnresolved: true as const,
      v68Changed: false as const,
      v80Changed: false as const,
      productionDailyBestPickChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
