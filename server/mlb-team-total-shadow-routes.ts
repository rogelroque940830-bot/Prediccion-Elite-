import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { buildMlbP1DailySlate, isValidMlbP1Date, type MlbP1DailySlate, type MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { resolveMlbUnifiedPricedV16RuntimeConfig } from "./mlb-unified-priced-v16-routes";
import { MlbSelectiveOddsSqliteCoordinator } from "./mlb-selective-odds-sqlite-coordinator";
import {
  MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_PER_RUN,
  MlbTeamTotalShadowCaptureService,
  type MlbTeamTotalShadowCaptureResult,
} from "./mlb-team-total-shadow-capture";
import { MlbTeamTotalShadowSqliteStore } from "./mlb-team-total-shadow-sqlite-store";

export const MLB_TEAM_TOTAL_SHADOW_CAPTURE_ROUTE = "/api/mlb/team-total-shadow/capture" as const;
export const MLB_TEAM_TOTAL_SHADOW_ROUTE_SCHEMA = "courtedge-p0-mlb-team-total-shadow-command.v1" as const;

type FinalPregameGame = MlbP1SlateGame & { startTime: string };

export interface MlbTeamTotalShadowRouteDependencies {
  buildSlate?: typeof buildMlbP1DailySlate;
  capture?: (input: {
    runId: string;
    date: string;
    games: MlbP1DailySlate["games"];
    maxGames: number;
    providerAccountScopeKey: string;
    apiKey: string;
    maxRunCredits: number;
    reserveCredits: number;
  }) => Promise<MlbTeamTotalShadowCaptureResult>;
  resolveRuntime?: typeof resolveMlbUnifiedPricedV16RuntimeConfig;
  now?: () => Date;
  runIdFactory?: () => string;
}

function bodyDate(req: Request): string {
  const date = String((req.body as any)?.date ?? "").trim();
  if (!isValidMlbP1Date(date)) throw new Error("MLB_TEAM_TOTAL_SHADOW_INVALID_DATE");
  return date;
}

function bodyMaxGames(req: Request): number {
  const parsed = Number((req.body as any)?.maxGames ?? 1);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_PER_RUN) {
    throw new Error("MLB_TEAM_TOTAL_SHADOW_INVALID_MAX_GAMES");
  }
  return parsed;
}

function isFinalPregame(game: MlbP1SlateGame, nowMs: number): game is FinalPregameGame {
  return game.analysisAllowed
    && game.analysisStage === "FINAL"
    && typeof game.startTime === "string"
    && game.startTime.trim().length > 0
    && Number.isFinite(Date.parse(game.startTime))
    && Date.parse(game.startTime) > nowMs;
}

export async function executeMlbTeamTotalShadowCaptureCommand(
  input: { date: string; maxGames: number },
  deps: MlbTeamTotalShadowRouteDependencies,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!isValidMlbP1Date(input.date)) throw new Error("MLB_TEAM_TOTAL_SHADOW_INVALID_DATE");
  if (!Number.isInteger(input.maxGames) || input.maxGames < 1 || input.maxGames > MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_PER_RUN) {
    throw new Error("MLB_TEAM_TOTAL_SHADOW_INVALID_MAX_GAMES");
  }
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_TEAM_TOTAL_SHADOW_NOW_INVALID");
  const buildSlate = deps.buildSlate ?? buildMlbP1DailySlate;
  const slate = await buildSlate({ date: input.date, now });
  const finalPregame = slate.games.filter((game): game is FinalPregameGame => isFinalPregame(game, now.getTime()));

  if (!finalPregame.length) {
    return {
      httpStatus: 200,
      body: {
        schemaVersion: MLB_TEAM_TOTAL_SHADOW_ROUTE_SCHEMA,
        date: input.date,
        status: "NO_FINAL_PREGAME_WORK",
        maxGames: input.maxGames,
        finalPregameGames: 0,
        providerCreditsConsumed: 0,
        nextBoundary: "Wait for FINAL pregame inputs; Team Total shadow never queries started games.",
        policy: {
          explicitInvocationRequired: true,
          shadowOnly: true,
          automaticPolling: false,
          changesEliteCandidates: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      },
    };
  }

  if (!deps.capture) throw new Error("MLB_TEAM_TOTAL_SHADOW_CAPTURE_DEPENDENCY_REQUIRED");
  const runtime = (deps.resolveRuntime ?? resolveMlbUnifiedPricedV16RuntimeConfig)();
  const runId = String(deps.runIdFactory?.() ?? `mlb-team-total-shadow-${input.date}-${randomUUID()}`).trim();
  if (!runId) throw new Error("MLB_TEAM_TOTAL_SHADOW_RUN_ID_REQUIRED");
  const result = await deps.capture({
    runId,
    date: input.date,
    games: finalPregame,
    maxGames: input.maxGames,
    providerAccountScopeKey: runtime.providerAccountScopeKey,
    apiKey: runtime.apiKey,
    maxRunCredits: Math.min(input.maxGames, runtime.maxRunCredits),
    reserveCredits: runtime.reserveCredits,
  });

  return {
    httpStatus: 200,
    body: {
      schemaVersion: MLB_TEAM_TOTAL_SHADOW_ROUTE_SCHEMA,
      date: input.date,
      status: "SHADOW_CAPTURE_COMPLETED",
      maxGames: input.maxGames,
      finalPregameGames: finalPregame.length,
      capture: result,
      providerCreditsConsumed: result.summary.providerCreditsCharged,
      policy: {
        explicitInvocationRequired: true,
        shadowOnly: true,
        providerSecretReturned: false,
        changesProductionLookupAuthorization: false,
        changesEliteCandidates: false,
        recommendsBet: false,
        automaticPolling: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    },
  };
}

export function registerMlbTeamTotalShadowRoutes(
  app: Express,
  deps: MlbTeamTotalShadowRouteDependencies = {},
): void {
  const coordinator = deps.capture ? null : new MlbSelectiveOddsSqliteCoordinator();
  const store = deps.capture ? null : new MlbTeamTotalShadowSqliteStore();
  const service = deps.capture ? null : new MlbTeamTotalShadowCaptureService({ coordinator: coordinator!, store: store! });
  const capture = deps.capture ?? ((input) => service!.capture(input));

  app.post(MLB_TEAM_TOTAL_SHADOW_CAPTURE_ROUTE, async (req: Request, res: Response) => {
    try {
      const response = await executeMlbTeamTotalShadowCaptureCommand(
        { date: bodyDate(req), maxGames: bodyMaxGames(req) },
        { ...deps, capture },
      );
      res.status(response.httpStatus).json(response.body);
    } catch (error: any) {
      const message = String(error?.message ?? "MLB_TEAM_TOTAL_SHADOW_CAPTURE_FAILED");
      const status = /INVALID_|_REQUIRED$/.test(message) ? 400 : 503;
      res.status(status).json({
        schemaVersion: MLB_TEAM_TOTAL_SHADOW_ROUTE_SCHEMA,
        status: "SHADOW_CAPTURE_FAILED",
        error: message,
        policy: {
          explicitInvocationRequired: true,
          shadowOnly: true,
          automaticPolling: false,
          changesEliteCandidates: false,
          automaticBetPlacement: false,
          realFinancialExposure: 0,
        },
      });
    }
  });
}
