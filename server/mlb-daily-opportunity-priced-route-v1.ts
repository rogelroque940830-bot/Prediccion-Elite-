import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { buildMlbP1DailySlate, isValidMlbP1Date } from "./mlb-p1-daily-slate";
import {
  assembleMlbUnifiedV16LiveInput,
  type MlbUnifiedV16LiveEvidenceProviders,
} from "./mlb-unified-v16-live-input-assembler";
import {
  buildMlbDailyOpportunityLive,
  type MlbDailyOpportunityProvisionalV16Provider,
} from "./mlb-daily-opportunity-live-v1";
import { runMlbDailyOpportunityPricedBridge } from "./mlb-daily-opportunity-priced-bridge-v1";
import { MlbSelectiveOddsAcquisitionService } from "./mlb-selective-odds-acquisition";
import { MlbSelectiveOddsSqliteCoordinator } from "./mlb-selective-odds-sqlite-coordinator";
import {
  MlbUnifiedPricedV16RuntimeConfigError,
  resolveMlbUnifiedPricedV16RuntimeConfig,
  type MlbUnifiedPricedV16RuntimeConfig,
} from "./mlb-unified-priced-v16-routes";

export const MLB_DAILY_OPPORTUNITY_PRICED_ROUTE =
  "/api/mlb/unified-v16/daily-opportunity/run-priced" as const;
export const MLB_DAILY_OPPORTUNITY_PRICED_ROUTE_SCHEMA =
  "courtedge-mlb-daily-opportunity-priced-command.v1" as const;

export interface MlbDailyOpportunityPricedRouteDependencies {
  liveEvidenceProviders: MlbUnifiedV16LiveEvidenceProviders;
  provisionalV16Provider: MlbDailyOpportunityProvisionalV16Provider;
  buildSlate?: typeof buildMlbP1DailySlate;
  assembleLiveInput?: typeof assembleMlbUnifiedV16LiveInput;
  buildOpportunityLive?: typeof buildMlbDailyOpportunityLive;
  oddsService?: MlbSelectiveOddsAcquisitionService;
  coordinator?: MlbSelectiveOddsSqliteCoordinator;
  resolveRuntimeConfig?: () => MlbUnifiedPricedV16RuntimeConfig;
  now?: () => Date;
  runIdFactory?: () => string;
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
  if (!isValidMlbP1Date(date)) throw new Error("MLB_DAILY_OPPORTUNITY_PRICED_INVALID_DATE");
  return date;
}

function requiresPaidPrice(live: Awaited<ReturnType<typeof buildMlbDailyOpportunityLive>>): boolean {
  const entries = live.priceConsultationShortlist.entries;
  return entries.length > 0 && entries.every((entry) => entry.priceTiming === "READY_IF_PRICE_LAYER_INVOKED");
}

export async function executeMlbDailyOpportunityPricedCommand(
  date: string,
  deps: MlbDailyOpportunityPricedRouteDependencies,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!isValidMlbP1Date(date)) throw new Error("MLB_DAILY_OPPORTUNITY_PRICED_INVALID_DATE");
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_DAILY_OPPORTUNITY_PRICED_NOW_INVALID");
  const runId = (deps.runIdFactory?.() ?? `mlb-opportunity-priced-${date}-${randomUUID()}`).trim();
  if (!runId) throw new Error("MLB_DAILY_OPPORTUNITY_PRICED_RUN_ID_REQUIRED");

  const slate = await (deps.buildSlate ?? buildMlbP1DailySlate)({ date, now });
  const assembly = await (deps.assembleLiveInput ?? assembleMlbUnifiedV16LiveInput)(
    {
      runId,
      slate,
      now,
      requireCompleteProvisionalBullpenEvidence: true,
    },
    deps.liveEvidenceProviders,
  );

  if (assembly.status === "BLOCKED") {
    return {
      httpStatus: 202,
      body: {
        schemaVersion: MLB_DAILY_OPPORTUNITY_PRICED_ROUTE_SCHEMA,
        status: "OPPORTUNITY_INPUTS_BLOCKED",
        runId,
        date,
        blockers: assembly.blockers,
        policy: {
          wholeSlateAnalysisPrecedesPrice: true,
          completeProvisionalBullpenEvidenceRequired: true,
          paidOddsCalled: false,
          theOddsApiCreditsConsumed: 0,
          maximumPriceConsultationCandidates: 3,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      },
    };
  }

  const live = await (deps.buildOpportunityLive ?? buildMlbDailyOpportunityLive)({
    assembled: assembly.input,
    provisionalV16Provider: deps.provisionalV16Provider,
  });

  // Do not even resolve paid-provider credentials while a provisional frontier candidate remains
  // or there is no sporting shortlist. Price is the last boundary, not a prerequisite for sports analysis.
  const runtime = requiresPaidPrice(live)
    ? (deps.resolveRuntimeConfig ?? (() => resolveMlbUnifiedPricedV16RuntimeConfig()))()
    : { providerAccountScopeKey: "NOT_ACCESSED", apiKey: "NOT_ACCESSED", maxRunCredits: 0, reserveCredits: 0 };

  const coordinator = deps.coordinator ?? new MlbSelectiveOddsSqliteCoordinator();
  const oddsService = deps.oddsService ?? new MlbSelectiveOddsAcquisitionService({ coordinator });
  const priced = await runMlbDailyOpportunityPricedBridge({
    assembled: assembly.input,
    live,
    runtime,
    dependencies: { oddsService, now: deps.now },
  });

  return {
    httpStatus: 200,
    body: {
      schemaVersion: MLB_DAILY_OPPORTUNITY_PRICED_ROUTE_SCHEMA,
      status: "OPPORTUNITY_PRICED_EVALUATED",
      runId,
      date,
      generatedAt: priced.generatedAt,
      dailyOpportunity: live.dailyOpportunity,
      priceConsultationShortlist: live.priceConsultationShortlist,
      decision: priced.decision,
      priceDiscovery: priced.priceDiscovery,
      acquisition: priced.acquisition,
      marketEdge: priced.marketEdge,
      operatingEnvelope: priced.operatingEnvelope,
      summary: priced.summary,
      policy: priced.policy,
    },
  };
}

function publicError(error: unknown): { status: number; code: string } {
  if (error instanceof MlbUnifiedPricedV16RuntimeConfigError) return { status: 503, code: error.code };
  const message = String((error as any)?.message ?? "");
  if (message === "MLB_DAILY_OPPORTUNITY_PRICED_INVALID_DATE") return { status: 400, code: message };
  if (
    message.startsWith("MLB_DAILY_OPPORTUNITY_")
    || message.startsWith("MLB_UNIFIED_")
    || message.startsWith("MLB_V16_")
    || message.startsWith("C4_")
  ) {
    return { status: 400, code: message.split(":")[0] || "MLB_DAILY_OPPORTUNITY_PRICED_INVALID_INPUT" };
  }
  return { status: 502, code: "MLB_DAILY_OPPORTUNITY_PRICED_COMMAND_FAILED" };
}

export function registerMlbDailyOpportunityPricedRoute(
  app: Express,
  deps: MlbDailyOpportunityPricedRouteDependencies,
): void {
  // The paid-odds coordinator/service are process resources. Construct them once when routes are
  // registered and reuse them across explicit commands; do not leak a SQLite handle per request.
  const coordinator = deps.coordinator ?? new MlbSelectiveOddsSqliteCoordinator();
  const oddsService = deps.oddsService ?? new MlbSelectiveOddsAcquisitionService({ coordinator });
  const commandDeps: MlbDailyOpportunityPricedRouteDependencies = Object.freeze({
    ...deps,
    coordinator,
    oddsService,
  });

  app.post(MLB_DAILY_OPPORTUNITY_PRICED_ROUTE, async (req: Request, res: Response) => {
    try {
      const response = await executeMlbDailyOpportunityPricedCommand(requestDate(req), commandDeps);
      return res.status(response.httpStatus).json(response.body);
    } catch (error) {
      const mapped = publicError(error);
      return res.status(mapped.status).json({
        error: mapped.code,
        message: mapped.status >= 500
          ? "MLB Daily Opportunity priced evaluation is unavailable"
          : "MLB Daily Opportunity priced input was rejected",
      });
    }
  });
}
