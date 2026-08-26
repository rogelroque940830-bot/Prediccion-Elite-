import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { buildMlbDailyOpportunityLive } from "./mlb-daily-opportunity-live-v1";
import { buildMlbP1DailySlate, isValidMlbP1Date } from "./mlb-p1-daily-slate";
import {
  assembleMlbUnifiedV16LiveInput,
  type MlbUnifiedV16LiveEvidenceProviders,
} from "./mlb-unified-v16-live-input-assembler";

export const MLB_DAILY_OPPORTUNITY_UI_ROUTE = "/api/mlb/unified-v16/daily-opportunity" as const;
export const MLB_DAILY_OPPORTUNITY_UI_SCHEMA =
  "courtedge-mlb-daily-opportunity-ui-command.v1" as const;

export interface MlbDailyOpportunityUiDependencies {
  buildSlate?: typeof buildMlbP1DailySlate;
  assembleLiveInput?: typeof assembleMlbUnifiedV16LiveInput;
  buildOpportunityLive?: typeof buildMlbDailyOpportunityLive;
  liveEvidenceProviders?: MlbUnifiedV16LiveEvidenceProviders;
  runIdFactory?: () => string;
  now?: () => Date;
}

function floridaDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function requestDate(req: Request): string {
  const date = String((req.body as any)?.date ?? floridaDate()).trim();
  if (!isValidMlbP1Date(date)) throw new Error("MLB_DAILY_OPPORTUNITY_UI_INVALID_DATE");
  return date;
}

export async function executeMlbDailyOpportunityUiCommand(
  date: string,
  deps: MlbDailyOpportunityUiDependencies = {},
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!isValidMlbP1Date(date)) throw new Error("MLB_DAILY_OPPORTUNITY_UI_INVALID_DATE");
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_DAILY_OPPORTUNITY_UI_NOW_INVALID");
  const runId = (deps.runIdFactory?.() ?? `mlb-opportunity-${date}-${randomUUID()}`).trim();
  if (!runId) throw new Error("MLB_DAILY_OPPORTUNITY_UI_RUN_ID_REQUIRED");

  const slate = await (deps.buildSlate ?? buildMlbP1DailySlate)({ date, now });
  const assembly = await (deps.assembleLiveInput ?? assembleMlbUnifiedV16LiveInput)(
    { runId, slate, now },
    deps.liveEvidenceProviders ?? {},
  );

  const common = {
    schemaVersion: MLB_DAILY_OPPORTUNITY_UI_SCHEMA,
    runId,
    date,
    generatedAt: slate.generatedAt,
    slate: {
      total: slate.summary.total,
      finalReady: slate.games.filter((game) => game.analysisAllowed && game.analysisStage === "FINAL").length,
      provisional: slate.games.filter((game) => game.analysisAllowed && game.analysisStage === "PROVISIONAL").length,
      waitingForPitchers: slate.summary.waitingForPitchers,
      startedOrClosed: slate.summary.startedOrClosed,
    },
  };

  if (assembly.status === "BLOCKED") {
    return {
      httpStatus: 202,
      body: {
        ...common,
        status: "OPPORTUNITY_INPUTS_BLOCKED",
        blockers: assembly.blockers,
        policy: {
          wholeSlateOpportunityEvaluated: false,
          maximumPossiblePriceConsultations: 3,
          wholeSlateAnalysisDoesNotExpandPriceQuota: true,
          paidOddsCalled: false,
          theOddsApiCreditsConsumed: 0,
          v68Changed: false,
          v80Changed: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      },
    };
  }

  const live = await (deps.buildOpportunityLive ?? buildMlbDailyOpportunityLive)({
    assembled: assembly.input,
  });

  return {
    httpStatus: 200,
    body: {
      ...common,
      generatedAt: live.generatedAt,
      status: "OPPORTUNITY_EVALUATED",
      dailyOpportunity: live.dailyOpportunity,
      priceConsultationShortlist: live.priceConsultationShortlist,
      provisionalV16: live.provisionalV16,
      policy: {
        wholeSlateOpportunityEvaluated: true,
        wholeQualifiedSlateCompetes: live.policy.wholeQualifiedSlateCompetes,
        provisionalGamesMayLead: live.policy.provisionalGamesMayLead,
        provisionalProbabilityUsesPriorDateLineupProxy: live.policy.provisionalProbabilityUsesPriorDateLineupProxy,
        maximumPossiblePriceConsultations: live.policy.maximumPossiblePriceConsultations,
        wholeSlateAnalysisDoesNotExpandPriceQuota: live.policy.wholeSlateAnalysisDoesNotExpandPriceQuota,
        paidOddsCalled: false,
        theOddsApiCreditsConsumed: 0,
        marketPricesRead: false,
        outcomesRead: false,
        v68Changed: false,
        v80Changed: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    },
  };
}

export function registerMlbDailyOpportunityUiRoutes(
  app: Express,
  deps: MlbDailyOpportunityUiDependencies = {},
): void {
  app.post(MLB_DAILY_OPPORTUNITY_UI_ROUTE, async (req: Request, res: Response) => {
    try {
      const response = await executeMlbDailyOpportunityUiCommand(requestDate(req), deps);
      return res.status(response.httpStatus).json(response.body);
    } catch (error) {
      const message = String((error as any)?.message ?? "");
      if (message === "MLB_DAILY_OPPORTUNITY_UI_INVALID_DATE") {
        return res.status(400).json({
          error: message,
          message: "date must use YYYY-MM-DD",
        });
      }
      console.error("MLB Daily Opportunity UI command failed:", error);
      return res.status(502).json({
        error: "MLB_DAILY_OPPORTUNITY_UI_COMMAND_FAILED",
        message: "MLB Daily Opportunity evaluation is unavailable.",
      });
    }
  });
}
