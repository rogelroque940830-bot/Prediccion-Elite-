import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { buildMlbP1DailySlate, isValidMlbP1Date, type MlbP1DailySlate } from "./mlb-p1-daily-slate";
import { MlbSelectiveOddsAcquisitionService } from "./mlb-selective-odds-acquisition";
import { MlbSelectiveOddsSqliteCoordinator } from "./mlb-selective-odds-sqlite-coordinator";
import {
  runMlbUnifiedPricedV16Step11c,
  type MlbUnifiedPricedV16RunnerResult,
} from "./mlb-unified-priced-v16-runner";
import {
  MLB_UNIFIED_PRICED_V16_ROUTE,
  MlbUnifiedPricedV16RuntimeConfigError,
  resolveMlbUnifiedPricedV16RuntimeConfig,
  type MlbUnifiedPricedV16RuntimeConfig,
} from "./mlb-unified-priced-v16-routes";
import {
  assembleMlbUnifiedV16LiveInput,
  type MlbUnifiedV16LiveEvidenceProviders,
  type MlbUnifiedV16LiveInputAssemblyResult,
} from "./mlb-unified-v16-live-input-assembler";
import { createMlbUnifiedV16DefaultLiveEvidenceProviders } from "./mlb-unified-v16-live-providers";
import { auditMlbV16NoPlayFunnel } from "./mlb-v16-no-play-funnel-audit";
import { buildMlbDailyBestPickUiView } from "./mlb-daily-best-pick-ui-view";
import { buildMlbDailyBestPickPriceViewFailClosed } from "./mlb-daily-best-pick-price-safe-view";
import {
  buildMlbDailyBestPickManualPriceContext,
  evaluateMlbDailyBestPickManualPrice,
  MlbDailyBestPickManualPriceError,
  type MlbDailyBestPickManualPriceRequest,
} from "./mlb-daily-best-pick-manual-price";
import { MlbDailyBestPickManualPriceStore } from "./mlb-daily-best-pick-manual-price-store";

export const MLB_UNIFIED_V16_UI_ROUTE = "/api/mlb/unified-v16/ui-run" as const;
export const MLB_UNIFIED_V16_MANUAL_PRICE_ROUTE = "/api/mlb/unified-v16/manual-price" as const;
export const MLB_UNIFIED_V16_UI_SCHEMA = "courtedge-p0-mlb-unified-v16-ui-command.v2" as const;
export const MLB_UNIFIED_V16_MANUAL_PRICE_SCHEMA = "courtedge-p0-mlb-unified-v16-manual-price-command.v1" as const;

function floridaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function bodyDate(req: Request): string {
  const date = String((req.body as any)?.date ?? floridaDate()).trim();
  if (!isValidMlbP1Date(date)) throw new Error("MLB_UNIFIED_V16_UI_INVALID_DATE");
  return date;
}

function slateSummary(slate: MlbP1DailySlate) {
  const analysisEligible = slate.games.filter((game) => game.analysisAllowed);
  const finalReady = analysisEligible.filter((game) => game.analysisStage === "FINAL");
  const provisional = analysisEligible.filter((game) => game.analysisStage === "PROVISIONAL");
  return {
    analysisEligible,
    finalReady,
    provisional,
    public: {
      total: slate.summary.total,
      finalReady: finalReady.length,
      provisional: provisional.length,
      waitingForPitchers: slate.summary.waitingForPitchers,
      startedOrClosed: slate.summary.startedOrClosed,
      dataInsufficient: slate.summary.dataInsufficient,
    },
  };
}

function publicGames(slate: MlbP1DailySlate) {
  return slate.games
    .filter((game) => game.analysisAllowed)
    .map((game) => ({
      gamePk: game.gamePk,
      startTime: game.startTime,
      awayTeam: game.awayTeam.name,
      homeTeam: game.homeTeam.name,
      analysisStage: game.analysisStage,
      readiness: game.readiness,
      blockers: game.blockers,
    }));
}

function publicEliteCandidates(result: MlbUnifiedPricedV16RunnerResult, slate: MlbP1DailySlate) {
  const teamsByGame = new Map(
    slate.games.map((game) => [game.gamePk, { awayTeam: game.awayTeam.name, homeTeam: game.homeTeam.name }]),
  );

  return result.eliteEvidenceLedger.entries.map((entry) => {
    const candidate = entry.candidate;
    const teams = teamsByGame.get(candidate.gamePk);
    return {
      predictionId: entry.predictionId,
      gamePk: candidate.gamePk,
      awayTeam: teams?.awayTeam ?? "Away",
      homeTeam: teams?.homeTeam ?? "Home",
      marketType: candidate.marketType,
      selectedSide: candidate.selectedSide,
      selectedLine: candidate.selectedLine,
      modelWinProbability: candidate.modelWinProbability,
      modelPushProbability: candidate.modelPushProbability,
      expectedValuePerUnit: candidate.expectedValuePerUnit,
      executionEdgePp: candidate.executionEdgePp,
      executionNoVigEdgePp: candidate.executionNoVigEdgePp,
      referenceNoVigEdgePp: candidate.referenceNoVigEdgePp,
      referenceAgreement: candidate.referenceAgreement,
      executionBookTitle: candidate.executionBookTitle,
      executionOddsAmerican: candidate.executionOddsAmerican,
      executionCapturedAt: candidate.executionCapturedAt,
      intrinsicProjectionScope: candidate.intrinsicProjectionScope,
      intrinsicThesisKinds: candidate.intrinsicThesisKinds,
      supportingComponents: candidate.supportingComponents,
    };
  });
}

function manualRequestFromBody(req: Request): MlbDailyBestPickManualPriceRequest {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new MlbDailyBestPickManualPriceError("REQUEST_BODY_INVALID", "manual price request body must be an object");
  }
  const body = req.body as Record<string, unknown>;
  const runId = String(body.runId ?? "").trim();
  const date = String(body.date ?? "").trim();
  const gamePk = Number(body.gamePk);
  const market = body.market;
  const side = body.side;
  const oddsAmerican = Number(body.oddsAmerican);
  if (!runId) throw new MlbDailyBestPickManualPriceError("RUN_ID_REQUIRED", "runId is required");
  if (!isValidMlbP1Date(date)) throw new MlbDailyBestPickManualPriceError("DATE_INVALID", "date must use YYYY-MM-DD");
  if (!Number.isInteger(gamePk) || gamePk <= 0) throw new MlbDailyBestPickManualPriceError("GAME_PK_INVALID", "gamePk must be a positive integer");
  if (market !== "FIRST_5_ML" && market !== "FULL_GAME_ML") {
    throw new MlbDailyBestPickManualPriceError("MARKET_INVALID", "manual price market must be the frozen Daily BEST PICK ML market");
  }
  if (side !== "HOME") throw new MlbDailyBestPickManualPriceError("SIDE_INVALID", "manual price side must match the frozen HOME selection");
  return { runId, date, gamePk, market, side, oddsAmerican };
}

export interface MlbUnifiedV16UiCommandDependencies {
  buildSlate?: typeof buildMlbP1DailySlate;
  assembleLiveInput?: typeof assembleMlbUnifiedV16LiveInput;
  liveEvidenceProviders?: MlbUnifiedV16LiveEvidenceProviders;
  resolveRuntimeConfig?: () => MlbUnifiedPricedV16RuntimeConfig;
  getOddsService?: () => MlbSelectiveOddsAcquisitionService;
  runPriced?: typeof runMlbUnifiedPricedV16Step11c;
  runIdFactory?: () => string;
  now?: () => Date;
  manualPriceStore?: MlbDailyBestPickManualPriceStore;
}

export interface MlbUnifiedV16UiCommandResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

function persistManualPriceContext(
  deps: MlbUnifiedV16UiCommandDependencies,
  runId: string,
  context: Parameters<MlbDailyBestPickManualPriceStore["put"]>[0] | null,
): void {
  const ownedStore = deps.manualPriceStore ? null : new MlbDailyBestPickManualPriceStore();
  const store = deps.manualPriceStore ?? ownedStore!;
  try {
    // Same runId can never retain an older manual fallback once a newer automatic
    // result has become executable or the exact model/pick trust boundary fails.
    store.delete(runId);
    if (context) store.put(context);
  } finally {
    ownedStore?.close();
  }
}

export async function executeMlbUnifiedV16UiCommand(
  date: string,
  deps: MlbUnifiedV16UiCommandDependencies = {},
): Promise<MlbUnifiedV16UiCommandResponse> {
  if (!isValidMlbP1Date(date)) throw new Error("MLB_UNIFIED_V16_UI_INVALID_DATE");

  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_UNIFIED_V16_UI_NOW_INVALID");
  const buildSlate = deps.buildSlate ?? buildMlbP1DailySlate;
  const assembleLiveInput = deps.assembleLiveInput ?? assembleMlbUnifiedV16LiveInput;
  const resolveRuntime = deps.resolveRuntimeConfig ?? (() => resolveMlbUnifiedPricedV16RuntimeConfig());
  const runPriced = deps.runPriced ?? runMlbUnifiedPricedV16Step11c;
  const runId = (deps.runIdFactory?.() ?? `mlb-v16-${date}-${randomUUID()}`).trim();
  if (!runId) throw new Error("MLB_UNIFIED_V16_UI_RUN_ID_REQUIRED");

  const slate = await buildSlate({ date, now });
  const summary = slateSummary(slate);
  const common = {
    schemaVersion: MLB_UNIFIED_V16_UI_SCHEMA,
    date,
    generatedAt: slate.generatedAt,
    runId,
    runnerEndpoint: MLB_UNIFIED_PRICED_V16_ROUTE,
    slate: summary.public,
    games: publicGames(slate),
  };

  if (summary.finalReady.length === 0) {
    return {
      httpStatus: 200,
      body: {
        ...common,
        status: "WAITING_FOR_FINAL_INPUTS",
        blockers: [],
        nextBoundary: "Wait for final pregame inputs; no paid odds boundary is crossed.",
        policy: {
          explicitInvocationRequired: true,
          certifiedServerAssemblyComplete: false,
          pricedRunnerCalled: false,
          paidOddsCalled: false,
          browserReceivesProviderSecret: false,
          browserMayForgeCertifiedInputs: false,
          automaticPolling: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      },
    };
  }

  const assembly: MlbUnifiedV16LiveInputAssemblyResult = await assembleLiveInput(
    { runId, slate, now },
    deps.liveEvidenceProviders ?? {},
  );

  if (assembly.status === "BLOCKED") {
    return {
      httpStatus: 202,
      body: {
        ...common,
        status: "CERTIFIED_INPUT_ASSEMBLY_BLOCKED",
        blockers: assembly.blockers,
        nextBoundary: "Complete the missing certified server evidence before Step 8. No paid odds call was made.",
        policy: {
          explicitInvocationRequired: true,
          certifiedServerAssemblyComplete: false,
          pricedRunnerCalled: false,
          paidOddsCalled: false,
          theOddsApiCreditsConsumed: 0,
          browserReceivesProviderSecret: false,
          browserMayForgeCertifiedInputs: false,
          automaticPolling: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      },
    };
  }

  const runtime = resolveRuntime();
  const oddsService = deps.getOddsService?.()
    ?? new MlbSelectiveOddsAcquisitionService({ coordinator: new MlbSelectiveOddsSqliteCoordinator() });
  const result: MlbUnifiedPricedV16RunnerResult = await runPriced({
    ...assembly.input,
    oddsService,
    providerAccountScopeKey: runtime.providerAccountScopeKey,
    apiKey: runtime.apiKey,
    maxRunCredits: runtime.maxRunCredits,
    reserveCredits: runtime.reserveCredits,
  });
  const noPlayAudit = auditMlbV16NoPlayFunnel(result);
  const dailyBestPick = buildMlbDailyBestPickUiView({ preprice: result.preprice, slate });
  const dailyBestPickPrice = buildMlbDailyBestPickPriceViewFailClosed({
    priced: result,
    dailyBestPick,
    onRejected: (error) => console.error("Daily BEST PICK price visibility rejected:", error),
  });
  const manualPrice = buildMlbDailyBestPickManualPriceContext({
    priced: result,
    dailyBestPick,
    automaticPrice: dailyBestPickPrice,
    now,
  });
  persistManualPriceContext(deps, result.runId, manualPrice.context);

  return {
    httpStatus: 200,
    body: {
      ...common,
      generatedAt: result.generatedAt,
      status: "RUN_COMPLETED",
      blockers: [],
      result: {
        schemaVersion: result.schemaVersion,
        summary: result.summary,
        prepriceSummary: result.preprice.summary,
        dailyBestPick,
        dailyBestPickPrice,
        manualPriceContinuity: manualPrice.availability,
        noPlayAudit,
        eliteCandidates: publicEliteCandidates(result, slate),
      },
      nextBoundary: "Priced V16 evidence run completed. Daily BEST PICK remains frozen pre-price. A trusted provider/cache price has priority; only when no automatic execution price exists may the exact same pick accept a short-lived user-reported Hard Rock price for visibility-only EV math. Manual price cannot create BET_ELITE, fallback, stake, or an automatic wager.",
      policy: {
        explicitInvocationRequired: true,
        certifiedServerAssemblyComplete: true,
        pricedRunnerCalled: true,
        dailyBestPickDerivedFromTrustedPreprice: true,
        dailyBestPickBrowserInputAllowed: false,
        dailyBestPickChangesFrozenRouting: false,
        dailyBestPickGeneralV68FallbackAllowed: false,
        dailyBestPickV80DependencyAllowed: false,
        dailyBestPickPriceExactIdentityOnly: true,
        dailyBestPickPriceMayChangeSportingSelection: false,
        dailyBestPickPriceFallbackAllowed: false,
        dailyBestPickPriceAddsThreshold: false,
        dailyBestPickPriceProducesBetElite: false,
        providerOrFreshCachePricePrecedesManual: true,
        manualPriceExactFrozenPickOnly: true,
        manualPriceMayChangeSportingSelection: false,
        manualPriceCallsTheOddsApi: false,
        manualPriceTheOddsApiCreditsConsumed: 0,
        browserReceivesProviderSecret: false,
        browserMayForgeCertifiedInputs: false,
        automaticPolling: false,
        finalBetRecommendationProduced: false,
        stakeCalculated: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    },
  };
}

function manualPriceHttpError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof MlbDailyBestPickManualPriceError) {
    if (error.code === "CONTEXT_NOT_FOUND_OR_EXPIRED" || error.code === "CONTEXT_EXPIRED") {
      return { status: 409, code: error.code, message: "The trusted automatic-run context is unavailable or expired. Run V16 again before entering a manual price." };
    }
    return { status: 400, code: error.code, message: "The manual Hard Rock price was rejected by the exact-pick safety contract." };
  }
  return { status: 500, code: "MLB_UNIFIED_V16_MANUAL_PRICE_FAILED", message: "Manual price evaluation is unavailable." };
}

export function registerMlbUnifiedV16UiRoutes(
  app: Express,
  deps: MlbUnifiedV16UiCommandDependencies = {},
): void {
  const manualPriceStore = deps.manualPriceStore ?? new MlbDailyBestPickManualPriceStore();
  const registeredDeps: MlbUnifiedV16UiCommandDependencies = {
    ...deps,
    manualPriceStore,
    liveEvidenceProviders: deps.liveEvidenceProviders ?? createMlbUnifiedV16DefaultLiveEvidenceProviders(),
  };

  app.post(MLB_UNIFIED_V16_UI_ROUTE, async (req: Request, res: Response) => {
    try {
      const date = bodyDate(req);
      const response = await executeMlbUnifiedV16UiCommand(date, registeredDeps);
      return res.status(response.httpStatus).json(response.body);
    } catch (error) {
      if (error instanceof MlbUnifiedPricedV16RuntimeConfigError) {
        return res.status(503).json({
          error: error.code,
          message: "V16 runtime configuration is incomplete.",
        });
      }
      const message = String((error as any)?.message ?? "");
      if (message === "MLB_UNIFIED_V16_UI_INVALID_DATE") {
        return res.status(400).json({
          error: "MLB_UNIFIED_V16_UI_INVALID_DATE",
          message: "date must use YYYY-MM-DD",
        });
      }
      if (message.startsWith("MLB_UNIFIED_V16_LIVE_ASSEMBLER_")) {
        return res.status(400).json({
          error: message.split(":")[0],
          message: "Certified V16 live input assembly was rejected.",
        });
      }
      console.error("MLB unified V16 UI command failed:", error);
      return res.status(502).json({
        error: "MLB_UNIFIED_V16_UI_COMMAND_FAILED",
        message: "MLB unified V16 command is unavailable.",
      });
    }
  });

  app.post(MLB_UNIFIED_V16_MANUAL_PRICE_ROUTE, async (req: Request, res: Response) => {
    try {
      const request = manualRequestFromBody(req);
      const now = registeredDeps.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new MlbDailyBestPickManualPriceError("NOW_INVALID", "manual quote time is invalid");
      const context = manualPriceStore.get(request.runId, now.getTime());
      if (!context) {
        throw new MlbDailyBestPickManualPriceError(
          "CONTEXT_NOT_FOUND_OR_EXPIRED",
          "trusted manual-price context is missing or expired",
        );
      }
      const result = evaluateMlbDailyBestPickManualPrice({ context, request, now });
      return res.status(200).json({
        schemaVersion: MLB_UNIFIED_V16_MANUAL_PRICE_SCHEMA,
        status: "MANUAL_PRICE_EVALUATED",
        runId: request.runId,
        date: request.date,
        result,
        policy: {
          providerOrFreshCachePricePrecedesManual: true,
          exactFrozenDailyBestPickOnly: true,
          browserCannotSupplyModelProbability: true,
          manualPriceMayChangeSportingSelection: false,
          callsTheOddsApi: false,
          theOddsApiCreditsConsumed: 0,
          operatingEnvelopeClassificationProduced: false,
          betEliteProduced: false,
          finalBetRecommendationProduced: false,
          stakeCalculated: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      });
    } catch (error) {
      const mapped = manualPriceHttpError(error);
      if (mapped.status >= 500) console.error("MLB manual price evaluation failed:", error);
      return res.status(mapped.status).json({ error: mapped.code, message: mapped.message });
    }
  });
}
