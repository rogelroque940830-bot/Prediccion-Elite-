import type { Express, Request, Response } from "express";
import { MlbSelectiveOddsAcquisitionService } from "./mlb-selective-odds-acquisition";
import { MlbSelectiveOddsSqliteCoordinator } from "./mlb-selective-odds-sqlite-coordinator";
import {
  runMlbUnifiedPricedV16Step11c,
  type MlbUnifiedPricedV16RunnerInput,
} from "./mlb-unified-priced-v16-runner";

export const MLB_UNIFIED_PRICED_V16_ROUTE = "/api/mlb/unified-v16/run" as const;

export interface MlbUnifiedPricedV16RuntimeConfig {
  providerAccountScopeKey: string;
  apiKey: string;
  maxRunCredits: number;
  reserveCredits: number;
}

export class MlbUnifiedPricedV16RuntimeConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MlbUnifiedPricedV16RuntimeConfigError";
    this.code = code;
  }
}

function requiredEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new MlbUnifiedPricedV16RuntimeConfigError(`MISSING_${name}`, `${name} is required`);
  return value;
}

function nonNegativeIntegerEnv(name: string, env: NodeJS.ProcessEnv): number {
  const raw = requiredEnv(name, env);
  if (!/^\d+$/.test(raw)) {
    throw new MlbUnifiedPricedV16RuntimeConfigError(`INVALID_${name}`, `${name} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MlbUnifiedPricedV16RuntimeConfigError(`INVALID_${name}`, `${name} must be a safe non-negative integer`);
  }
  return value;
}

export function resolveMlbUnifiedPricedV16RuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): MlbUnifiedPricedV16RuntimeConfig {
  return Object.freeze({
    providerAccountScopeKey: requiredEnv("MLB_ODDS_PROVIDER_ACCOUNT_SCOPE_KEY", env),
    apiKey: requiredEnv("ODDS_API_KEY", env),
    maxRunCredits: nonNegativeIntegerEnv("MLB_ODDS_MAX_RUN_CREDITS", env),
    reserveCredits: nonNegativeIntegerEnv("MLB_ODDS_RESERVE_CREDITS", env),
  });
}

function bodyObject(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new Error("MLB_UNIFIED_PRICED_V16_BODY_OBJECT_REQUIRED");
  }
  return req.body as Record<string, unknown>;
}

function runnerInputFromBody(
  req: Request,
  runtime: MlbUnifiedPricedV16RuntimeConfig,
  oddsService: MlbSelectiveOddsAcquisitionService,
): MlbUnifiedPricedV16RunnerInput {
  const body = bodyObject(req);
  return {
    runId: String(body.runId ?? "").trim(),
    slate: body.slate as MlbUnifiedPricedV16RunnerInput["slate"],
    shortlistEvidenceByGame: (body.shortlistEvidenceByGame ?? {}) as MlbUnifiedPricedV16RunnerInput["shortlistEvidenceByGame"],
    bullpenByGame: body.bullpenByGame as MlbUnifiedPricedV16RunnerInput["bullpenByGame"],
    finalRouteAssessmentsByGame: (body.finalRouteAssessmentsByGame ?? {}) as MlbUnifiedPricedV16RunnerInput["finalRouteAssessmentsByGame"],
    c4ByGame: (body.c4ByGame ?? {}) as MlbUnifiedPricedV16RunnerInput["c4ByGame"],
    now: body.now ? new Date(String(body.now)) : undefined,
    oddsService,
    providerAccountScopeKey: runtime.providerAccountScopeKey,
    apiKey: runtime.apiKey,
    maxRunCredits: runtime.maxRunCredits,
    reserveCredits: runtime.reserveCredits,
  };
}

function publicError(error: unknown): { status: number; code: string } {
  if (error instanceof MlbUnifiedPricedV16RuntimeConfigError) {
    return { status: 503, code: error.code };
  }
  const message = String((error as any)?.message ?? "");
  if (
    message.startsWith("MLB_UNIFIED_")
    || message.startsWith("MLB_V16_")
    || message.startsWith("C4_")
    || message.startsWith("MLB_ELITE_")
  ) {
    return { status: 400, code: message.split(":")[0] || "MLB_UNIFIED_PRICED_V16_INVALID_INPUT" };
  }
  return { status: 500, code: "MLB_UNIFIED_PRICED_V16_RUN_FAILED" };
}

export function registerMlbUnifiedPricedV16Routes(
  app: Express,
  deps: {
    coordinator?: MlbSelectiveOddsSqliteCoordinator;
    oddsService?: MlbSelectiveOddsAcquisitionService;
    resolveRuntimeConfig?: () => MlbUnifiedPricedV16RuntimeConfig;
  } = {},
): void {
  const coordinator = deps.coordinator ?? new MlbSelectiveOddsSqliteCoordinator();
  const oddsService = deps.oddsService ?? new MlbSelectiveOddsAcquisitionService({ coordinator });
  const resolveRuntime = deps.resolveRuntimeConfig ?? (() => resolveMlbUnifiedPricedV16RuntimeConfig());

  app.post(MLB_UNIFIED_PRICED_V16_ROUTE, async (req: Request, res: Response) => {
    try {
      const runtime = resolveRuntime();
      const result = await runMlbUnifiedPricedV16Step11c(runnerInputFromBody(req, runtime, oddsService));
      return res.status(200).json(result);
    } catch (error) {
      const mapped = publicError(error);
      return res.status(mapped.status).json({
        error: mapped.code,
        message: mapped.status >= 500 ? "MLB unified analysis is unavailable" : "MLB unified analysis input was rejected",
      });
    }
  });
}
