import type { Express, Request, Response } from "express";
import { buildMlbP1DailySlate, isValidMlbP1Date } from "./mlb-p1-daily-slate";
import {
  MLB_BATTER_PROSPECTIVE_CUSTODY_MAX_GAMES_PER_RUN,
  MlbBatterProspectiveCustodyService,
  type MlbBatterProspectiveCustodyCaptureResult,
} from "./mlb-batter-prospective-custody";
import { MlbBatterProspectiveCustodySqliteStore } from "./mlb-batter-prospective-custody-sqlite-store";

export const MLB_BATTER_PROSPECTIVE_CUSTODY_ROUTE =
  "/api/mlb/batter-prospective-custody/capture" as const;
export const MLB_BATTER_PROSPECTIVE_CUSTODY_ROUTE_SCHEMA =
  "courtedge-p0-mlb-batter-prospective-custody-command.v1" as const;

export interface MlbBatterProspectiveCustodyRouteDependencies {
  buildSlate?: typeof buildMlbP1DailySlate;
  capture?: (input: {
    date: string;
    games: Awaited<ReturnType<typeof buildMlbP1DailySlate>>["games"];
    maxGames: number;
  }) => Promise<MlbBatterProspectiveCustodyCaptureResult>;
}

function bodyDate(req: Request): string {
  const date = String((req.body as any)?.date ?? "").trim();
  if (!isValidMlbP1Date(date)) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_INVALID_DATE");
  return date;
}

function bodyMaxGames(req: Request): number {
  const parsed = Number((req.body as any)?.maxGames ?? MLB_BATTER_PROSPECTIVE_CUSTODY_MAX_GAMES_PER_RUN);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MLB_BATTER_PROSPECTIVE_CUSTODY_MAX_GAMES_PER_RUN) {
    throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_INVALID_MAX_GAMES");
  }
  return parsed;
}

export async function executeMlbBatterProspectiveCustodyCommand(
  input: { date: string; maxGames: number },
  deps: MlbBatterProspectiveCustodyRouteDependencies,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!isValidMlbP1Date(input.date)) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_INVALID_DATE");
  if (!Number.isInteger(input.maxGames) || input.maxGames < 1 || input.maxGames > MLB_BATTER_PROSPECTIVE_CUSTODY_MAX_GAMES_PER_RUN) {
    throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_INVALID_MAX_GAMES");
  }
  if (!deps.capture) throw new Error("MLB_BATTER_PROSPECTIVE_CUSTODY_CAPTURE_DEPENDENCY_REQUIRED");

  const slate = await (deps.buildSlate ?? buildMlbP1DailySlate)({ date: input.date });
  const capture = await deps.capture({
    date: input.date,
    games: slate.games,
    maxGames: input.maxGames,
  });

  return {
    httpStatus: 200,
    body: {
      schemaVersion: MLB_BATTER_PROSPECTIVE_CUSTODY_ROUTE_SCHEMA,
      date: input.date,
      status: capture.status === "NO_WORK" ? "NO_CANONICAL_WORK" : "PROSPECTIVE_CUSTODY_CAPTURE_COMPLETED",
      maxGames: input.maxGames,
      slateSummary: slate.summary,
      capture,
      policy: {
        explicitInvocationRequired: true,
        automaticPolling: false,
        providerOddsCallsAllowed: false,
        paidProviderCredits: 0,
        outcomeSettlementAllowed: false,
        modelScoringAllowed: false,
        priceCaptureAllowed: false,
        changesProductionLookupAuthorization: false,
        changesEliteCandidates: false,
        recommendsBet: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    },
  };
}

export function registerMlbBatterProspectiveCustodyRoutes(
  app: Express,
  deps: MlbBatterProspectiveCustodyRouteDependencies = {},
): void {
  const store = deps.capture ? null : new MlbBatterProspectiveCustodySqliteStore();
  const service = deps.capture ? null : new MlbBatterProspectiveCustodyService(store!);
  const capture = deps.capture ?? ((input) => service!.capture(input));

  app.post(MLB_BATTER_PROSPECTIVE_CUSTODY_ROUTE, async (req: Request, res: Response) => {
    try {
      const response = await executeMlbBatterProspectiveCustodyCommand(
        { date: bodyDate(req), maxGames: bodyMaxGames(req) },
        { ...deps, capture },
      );
      res.status(response.httpStatus).json(response.body);
    } catch (error: any) {
      const message = String(error?.message ?? "MLB_BATTER_PROSPECTIVE_CUSTODY_FAILED");
      const status = /INVALID_|_REQUIRED$/.test(message) ? 400 : 503;
      res.status(status).json({
        schemaVersion: MLB_BATTER_PROSPECTIVE_CUSTODY_ROUTE_SCHEMA,
        status: "PROSPECTIVE_CUSTODY_CAPTURE_FAILED",
        error: message,
        policy: {
          explicitInvocationRequired: true,
          automaticPolling: false,
          providerOddsCallsAllowed: false,
          paidProviderCredits: 0,
          outcomeSettlementAllowed: false,
          modelScoringAllowed: false,
          priceCaptureAllowed: false,
          changesEliteCandidates: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      });
    }
  });
}
