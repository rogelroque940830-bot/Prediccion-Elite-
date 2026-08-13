import type { Express, Request, Response } from "express";
import { buildMlbP1DailySlate, isValidMlbP1Date } from "./mlb-p1-daily-slate";
import {
  MLB_UNIFIED_PRICED_V16_ROUTE,
  MlbUnifiedPricedV16RuntimeConfigError,
  resolveMlbUnifiedPricedV16RuntimeConfig,
} from "./mlb-unified-priced-v16-routes";

export const MLB_UNIFIED_V16_UI_ROUTE = "/api/mlb/unified-v16/ui-run" as const;

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

export function registerMlbUnifiedV16UiRoutes(
  app: Express,
  deps: {
    buildSlate?: typeof buildMlbP1DailySlate;
    resolveRuntimeConfig?: typeof resolveMlbUnifiedPricedV16RuntimeConfig;
  } = {},
): void {
  const buildSlate = deps.buildSlate ?? buildMlbP1DailySlate;
  const resolveRuntime = deps.resolveRuntimeConfig ?? resolveMlbUnifiedPricedV16RuntimeConfig;

  app.post(MLB_UNIFIED_V16_UI_ROUTE, async (req: Request, res: Response) => {
    try {
      const date = bodyDate(req);
      resolveRuntime();
      const slate = await buildSlate({ date });
      const analysisEligible = slate.games.filter((game) => game.analysisAllowed);
      const finalReady = analysisEligible.filter((game) => game.analysisStage === "FINAL");
      const provisional = analysisEligible.filter((game) => game.analysisStage === "PROVISIONAL");

      return res.status(finalReady.length > 0 ? 202 : 200).json({
        schemaVersion: "courtedge-p0-mlb-unified-v16-ui-command.v1",
        date,
        generatedAt: slate.generatedAt,
        status: finalReady.length > 0 ? "CERTIFIED_INPUT_ASSEMBLY_REQUIRED" : "WAITING_FOR_FINAL_INPUTS",
        runnerEndpoint: MLB_UNIFIED_PRICED_V16_ROUTE,
        slate: {
          total: slate.summary.total,
          finalReady: finalReady.length,
          provisional: provisional.length,
          waitingForPitchers: slate.summary.waitingForPitchers,
          startedOrClosed: slate.summary.startedOrClosed,
          dataInsufficient: slate.summary.dataInsufficient,
        },
        games: analysisEligible.map((game) => ({
          gamePk: game.gamePk,
          startTime: game.startTime,
          awayTeam: game.awayTeam.name,
          homeTeam: game.homeTeam.name,
          analysisStage: game.analysisStage,
          readiness: game.readiness,
          blockers: game.blockers,
        })),
        nextBoundary: finalReady.length > 0
          ? "Build the certified shortlist/bullpen/C4/frozen-route input pack on the server, then invoke the priced V16 runner."
          : "Wait for final pregame inputs; no paid odds boundary is crossed.",
        policy: {
          explicitInvocationRequired: true,
          paidOddsCalled: false,
          browserReceivesProviderSecret: false,
          browserMayForgeCertifiedInputs: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      });
    } catch (error) {
      if (error instanceof MlbUnifiedPricedV16RuntimeConfigError) {
        return res.status(503).json({
          error: error.code,
          message: "V16 runtime configuration is incomplete.",
        });
      }
      if (String((error as any)?.message ?? "") === "MLB_UNIFIED_V16_UI_INVALID_DATE") {
        return res.status(400).json({
          error: "MLB_UNIFIED_V16_UI_INVALID_DATE",
          message: "date must use YYYY-MM-DD",
        });
      }
      console.error("MLB unified V16 UI command failed:", error);
      return res.status(502).json({
        error: "MLB_UNIFIED_V16_UI_COMMAND_FAILED",
        message: "MLB unified V16 preflight is unavailable.",
      });
    }
  });
}
