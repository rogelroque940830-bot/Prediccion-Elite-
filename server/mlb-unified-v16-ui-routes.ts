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

export const MLB_UNIFIED_V16_UI_ROUTE = "/api/mlb/unified-v16/ui-run" as const;
export const MLB_UNIFIED_V16_UI_SCHEMA = "courtedge-p0-mlb-unified-v16-ui-command.v2" as const;

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

export interface MlbUnifiedV16UiCommandDependencies {
  buildSlate?: typeof buildMlbP1DailySlate;
  assembleLiveInput?: typeof assembleMlbUnifiedV16LiveInput;
  liveEvidenceProviders?: MlbUnifiedV16LiveEvidenceProviders;
  resolveRuntimeConfig?: () => MlbUnifiedPricedV16RuntimeConfig;
  getOddsService?: () => MlbSelectiveOddsAcquisitionService;
  runPriced?: typeof runMlbUnifiedPricedV16Step11c;
  runIdFactory?: () => string;
  now?: () => Date;
}

export interface MlbUnifiedV16UiCommandResponse {
  httpStatus: number;
  body: Record<string, unknown>;
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
      },
      nextBoundary: "Priced V16 evidence run completed. No stake or final bet recommendation is produced by this slice.",
      policy: {
        explicitInvocationRequired: true,
        certifiedServerAssemblyComplete: true,
        pricedRunnerCalled: true,
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

export function registerMlbUnifiedV16UiRoutes(
  app: Express,
  deps: MlbUnifiedV16UiCommandDependencies = {},
): void {
  app.post(MLB_UNIFIED_V16_UI_ROUTE, async (req: Request, res: Response) => {
    try {
      const date = bodyDate(req);
      const response = await executeMlbUnifiedV16UiCommand(date, deps);
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
}
