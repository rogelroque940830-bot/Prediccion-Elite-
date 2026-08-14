import { createHash } from "node:crypto";
import type { MlbP1DailySlate, MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { screenMlbDailySlateCheap, type MlbCheapScreeningResult } from "./mlb-cheap-screening";
import {
  buildMlbShortlist,
  type MlbShortlistEvidenceByGame,
  type MlbShortlistResult,
} from "./mlb-shortlist";
import {
  buildMlbIntrinsicEdge,
  type MlbIntrinsicBullpenByGame,
  type MlbIntrinsicEdgeResult,
} from "./mlb-intrinsic-edge";
import { buildMlbMarketDiscovery, type MlbMarketDiscoveryResult } from "./mlb-market-discovery";
import {
  captureMlbFrozenResearchRouteLedger,
  MLB_FROZEN_RESEARCH_ROUTE_IDS,
  MLB_FROZEN_RESEARCH_ROUTER_IDS,
  type MlbFrozenResearchRouteAssessment,
  type MlbFrozenResearchRouteLedger,
  type MlbFrozenResearchRouteState,
  type MlbFrozenResearchRouterDecision,
} from "./mlb-frozen-research-route-ledger";

export const MLB_UNIFIED_RUNNER_SCHEMA = "courtedge-p0-mlb-unified-runner.preprice-step11c.v2" as const;
export const MLB_UNIFIED_RUNNER_PROVISIONAL_SCORER_VERSION = "mlb-frozen-routes-routers-provisional-not-evaluated.v2" as const;

export interface MlbUnifiedRunnerInput {
  runId: string;
  slate: MlbP1DailySlate;
  shortlistEvidenceByGame: MlbShortlistEvidenceByGame;
  bullpenByGame?: MlbIntrinsicBullpenByGame;
  finalRouteAssessmentsByGame?: Readonly<Record<number, MlbFrozenResearchRouteAssessment | undefined>>;
  now?: Date;
}

export interface MlbUnifiedRunnerResult {
  schemaVersion: typeof MLB_UNIFIED_RUNNER_SCHEMA;
  runId: string;
  generatedAt: string;
  date: string;
  cheapScreen: MlbCheapScreeningResult;
  shortlist: MlbShortlistResult;
  intrinsic: MlbIntrinsicEdgeResult;
  discovery: MlbMarketDiscoveryResult;
  frozenRouteLedger: MlbFrozenResearchRouteLedger;
  summary: {
    slateGames: number;
    analysisEligibleGames: number;
    finalAnalysisEligibleGames: number;
    provisionalAnalysisEligibleGames: number;
    intrinsicResearchEliteCandidates: number;
    gamesWithMarketDiscoveryPlan: number;
    gamesPaidLookupEligibleNow: number;
    frozenRouteRowsCaptured: number;
  };
  policy: {
    explicitInvocationRequired: true;
    automaticPolling: false;
    officialSlateUsed: true;
    provisionalGamesPreserved: true;
    provisionalGamesCanCreateFinalRouteMatch: false;
    provisionalGamesCanCreateRouterDecision: false;
    finalGamesRequireFrozenRouteAssessment: true;
    finalAPlusGamesRequireFrozenRouterDecision: true;
    intrinsicRankIndependentOfGameStartTime: true;
    priceBoundaryCrossed: false;
    callsTheOddsApi: false;
    theOddsApiCreditsConsumed: 0;
    originalStep11cPopulationChanged: false;
    frozenRouteLedgerChangesRecommendation: false;
    frozenRouterDecisionChangesRecommendation: false;
    betEliteProduced: false;
    finalBetRecommendationProduced: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function validIso(value: string | null | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function provisionalDigest(game: MlbP1SlateGame): string {
  const material = {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    startTime: game.startTime,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homePitcher: game.homePitcher,
    awayPitcher: game.awayPitcher,
    lineupState: game.lineupState,
    homeLineupCount: game.homeLineupCount,
    awayLineupCount: game.awayLineupCount,
    readiness: game.readiness,
    analysisStage: game.analysisStage,
    source: game.source,
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

function allRoutesNotEvaluated(): Record<(typeof MLB_FROZEN_RESEARCH_ROUTE_IDS)[number], MlbFrozenResearchRouteState> {
  return Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTE_IDS.map((routeId) => [routeId, "NOT_EVALUATED"])) as Record<
    (typeof MLB_FROZEN_RESEARCH_ROUTE_IDS)[number],
    MlbFrozenResearchRouteState
  >;
}

function allRoutersNotEvaluated(): Record<(typeof MLB_FROZEN_RESEARCH_ROUTER_IDS)[number], MlbFrozenResearchRouterDecision> {
  return Object.fromEntries(MLB_FROZEN_RESEARCH_ROUTER_IDS.map((routerId) => [routerId, "NOT_EVALUATED"])) as Record<
    (typeof MLB_FROZEN_RESEARCH_ROUTER_IDS)[number],
    MlbFrozenResearchRouterDecision
  >;
}

function assertFinalAssessmentIdentity(
  game: MlbP1SlateGame,
  assessment: MlbFrozenResearchRouteAssessment,
  capturedAt: string,
): void {
  if (assessment.gamePk !== game.gamePk
    || assessment.gameDate !== game.officialDate
    || assessment.scheduledStartTime !== game.startTime
    || assessment.finalInputs !== true) {
    throw new Error(`MLB_UNIFIED_RUNNER_FINAL_ROUTE_IDENTITY_MISMATCH:${game.gamePk}`);
  }
  if (!validIso(assessment.evaluatedAt) || Date.parse(assessment.evaluatedAt) > Date.parse(capturedAt)) {
    throw new Error(`MLB_UNIFIED_RUNNER_FINAL_ROUTE_EVALUATED_AFTER_CAPTURE:${game.gamePk}`);
  }
}

function buildRouteAssessments(input: {
  slate: MlbP1DailySlate;
  cheapScreen: MlbCheapScreeningResult;
  finalRouteAssessmentsByGame: Readonly<Record<number, MlbFrozenResearchRouteAssessment | undefined>>;
  capturedAt: string;
}): MlbFrozenResearchRouteAssessment[] {
  const gameByPk = new Map(input.slate.games.map((game) => [game.gamePk, game]));
  const eligible = input.cheapScreen.games.filter((game) => game.eligibleForDeepPrefilterNow);
  const eligiblePks = new Set(eligible.map((game) => game.gamePk));

  for (const rawKey of Object.keys(input.finalRouteAssessmentsByGame)) {
    const gamePk = Number(rawKey);
    if (!Number.isInteger(gamePk) || !eligiblePks.has(gamePk)) {
      throw new Error(`MLB_UNIFIED_RUNNER_EXTRA_ROUTE_ASSESSMENT:${rawKey}`);
    }
    const cheap = eligible.find((game) => game.gamePk === gamePk)!;
    if (!cheap.finalInputsAvailable) {
      throw new Error(`MLB_UNIFIED_RUNNER_PROVISIONAL_ROUTE_ASSESSMENT_FORBIDDEN:${gamePk}`);
    }
  }

  return eligible.map((cheap) => {
    const game = gameByPk.get(cheap.gamePk);
    if (!game || !validIso(game.startTime)) {
      throw new Error(`MLB_UNIFIED_RUNNER_ELIGIBLE_START_TIME_INVALID:${cheap.gamePk}`);
    }
    if (Date.parse(input.capturedAt) >= Date.parse(game.startTime)) {
      throw new Error(`MLB_UNIFIED_RUNNER_CAPTURE_NOT_PREGAME:${cheap.gamePk}`);
    }

    if (!cheap.finalInputsAvailable) {
      return {
        gamePk: game.gamePk,
        gameDate: game.officialDate,
        scheduledStartTime: game.startTime,
        evaluatedAt: input.capturedAt,
        finalInputs: false,
        featureSnapshotDigest: provisionalDigest(game),
        scorerVersion: MLB_UNIFIED_RUNNER_PROVISIONAL_SCORER_VERSION,
        routes: allRoutesNotEvaluated(),
        routers: allRoutersNotEvaluated(),
      };
    }

    const assessment = input.finalRouteAssessmentsByGame[game.gamePk];
    if (!assessment) throw new Error(`MLB_UNIFIED_RUNNER_FINAL_ROUTE_ASSESSMENT_REQUIRED:${game.gamePk}`);
    assertFinalAssessmentIdentity(game, assessment, input.capturedAt);
    return assessment;
  });
}

export function runMlbUnifiedPrepriceStep11c(input: MlbUnifiedRunnerInput): MlbUnifiedRunnerResult {
  const runId = String(input.runId ?? "").trim();
  if (!runId) throw new Error("MLB_UNIFIED_RUNNER_RUN_ID_REQUIRED");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_UNIFIED_RUNNER_NOW_INVALID");
  const generatedAt = now.toISOString();

  const cheapScreen = screenMlbDailySlateCheap(input.slate);
  const shortlist = buildMlbShortlist({ cheapScreen, evidenceByGame: input.shortlistEvidenceByGame });
  const intrinsic = buildMlbIntrinsicEdge({ shortlist, bullpenByGame: input.bullpenByGame });
  const discovery = buildMlbMarketDiscovery({ intrinsic });

  const routeAssessments = buildRouteAssessments({
    slate: input.slate,
    cheapScreen,
    finalRouteAssessmentsByGame: input.finalRouteAssessmentsByGame ?? {},
    capturedAt: generatedAt,
  });
  const analysisEligibleGamePks = cheapScreen.games
    .filter((game) => game.eligibleForDeepPrefilterNow)
    .map((game) => game.gamePk);
  const frozenRouteLedger = captureMlbFrozenResearchRouteLedger({
    sourceRunId: runId,
    capturedAt: generatedAt,
    analysisEligibleGamePks,
    assessments: routeAssessments,
  });

  const finalAnalysisEligibleGames = cheapScreen.games.filter(
    (game) => game.eligibleForDeepPrefilterNow && game.finalInputsAvailable,
  ).length;
  const provisionalAnalysisEligibleGames = cheapScreen.games.filter(
    (game) => game.eligibleForDeepPrefilterNow && !game.finalInputsAvailable,
  ).length;

  return Object.freeze({
    schemaVersion: MLB_UNIFIED_RUNNER_SCHEMA,
    runId,
    generatedAt,
    date: input.slate.date,
    cheapScreen,
    shortlist,
    intrinsic,
    discovery,
    frozenRouteLedger,
    summary: Object.freeze({
      slateGames: input.slate.games.length,
      analysisEligibleGames: analysisEligibleGamePks.length,
      finalAnalysisEligibleGames,
      provisionalAnalysisEligibleGames,
      intrinsicResearchEliteCandidates: intrinsic.summary.researchEliteCandidates,
      gamesWithMarketDiscoveryPlan: discovery.summary.gamesWithDiscoveryPlan,
      gamesPaidLookupEligibleNow: discovery.summary.gamesPaidLookupEligibleNow,
      frozenRouteRowsCaptured: frozenRouteLedger.entries.length,
    }),
    policy: Object.freeze({
      explicitInvocationRequired: true,
      automaticPolling: false,
      officialSlateUsed: true,
      provisionalGamesPreserved: true,
      provisionalGamesCanCreateFinalRouteMatch: false,
      provisionalGamesCanCreateRouterDecision: false,
      finalGamesRequireFrozenRouteAssessment: true,
      finalAPlusGamesRequireFrozenRouterDecision: true,
      intrinsicRankIndependentOfGameStartTime: true,
      priceBoundaryCrossed: false,
      callsTheOddsApi: false,
      theOddsApiCreditsConsumed: 0,
      originalStep11cPopulationChanged: false,
      frozenRouteLedgerChangesRecommendation: false,
      frozenRouterDecisionChangesRecommendation: false,
      betEliteProduced: false,
      finalBetRecommendationProduced: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    }),
  });
}
