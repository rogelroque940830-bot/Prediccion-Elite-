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
import { buildMlbEarlyWholeSlateCandidates } from "./mlb-early-whole-slate-candidates";
import {
  buildMlbNormalizedCandidatePool,
  earlyCandidatePoolSourceFromPayload,
  fullGameCandidateSourceFromLive,
  type MlbEarlyCandidatePoolSource,
  type MlbFullGameCandidateSource,
} from "./mlb-normalized-candidate-pool-v1";

export const MLB_NORMALIZED_CANDIDATE_POOL_ROUTE = "/api/mlb/candidate-pool/v1" as const;

export interface MlbNormalizedCandidatePoolRouteDependencies {
  liveEvidenceProviders: MlbUnifiedV16LiveEvidenceProviders;
  provisionalV16Provider: MlbDailyOpportunityProvisionalV16Provider;
  buildSlate?: typeof buildMlbP1DailySlate;
  assembleLiveInput?: typeof assembleMlbUnifiedV16LiveInput;
  buildOpportunityLive?: typeof buildMlbDailyOpportunityLive;
  buildEarlyCandidates?: typeof buildMlbEarlyWholeSlateCandidates;
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
  const date = String((req.body as any)?.date ?? req.query?.date ?? floridaDate()).trim();
  if (!isValidMlbP1Date(date)) throw new Error("MLB_CANDIDATE_POOL_INVALID_DATE");
  return date;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableFullGameSource(
  status: "BLOCKED" | "ERROR",
  blockers: readonly string[],
): MlbFullGameCandidateSource {
  return Object.freeze({
    status,
    sourceRunId: null,
    sourceSchemaVersion: "UNAVAILABLE",
    evaluations: Object.freeze([]),
    opportunities: Object.freeze([]),
    blockers: Object.freeze([...blockers]),
  });
}

function unavailableEarlySource(blockers: readonly string[]): MlbEarlyCandidatePoolSource {
  return Object.freeze({
    status: "ERROR" as const,
    payload: null,
    blockers: Object.freeze([...blockers]),
  });
}

export async function executeMlbNormalizedCandidatePoolCommand(
  date: string,
  deps: MlbNormalizedCandidatePoolRouteDependencies,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  if (!isValidMlbP1Date(date)) throw new Error("MLB_CANDIDATE_POOL_INVALID_DATE");
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_CANDIDATE_POOL_NOW_INVALID");
  const runId = (deps.runIdFactory?.() ?? `mlb-candidate-pool-${date}-${randomUUID()}`).trim();
  if (!runId) throw new Error("MLB_CANDIDATE_POOL_RUN_ID_REQUIRED");

  const slate = await (deps.buildSlate ?? buildMlbP1DailySlate)({ date, now });
  const buildEarly = deps.buildEarlyCandidates ?? buildMlbEarlyWholeSlateCandidates;
  const assemble = deps.assembleLiveInput ?? assembleMlbUnifiedV16LiveInput;

  // Engine independence is deliberate. Early/ERE can still contribute a sporting
  // candidate when the Full Game evidence path is blocked, and vice versa.
  const [earlySettled, assemblySettled] = await Promise.allSettled([
    buildEarly({
      date,
      now,
      slateProvider: async () => slate,
    }),
    assemble(
      {
        runId,
        slate,
        now,
        requireCompleteProvisionalBullpenEvidence: true,
      },
      deps.liveEvidenceProviders,
    ),
  ]);

  const early = earlySettled.status === "fulfilled"
    ? earlyCandidatePoolSourceFromPayload(earlySettled.value)
    : unavailableEarlySource([`EARLY_ENGINE_FAILED:${message(earlySettled.reason)}`]);

  let fullGame: MlbFullGameCandidateSource;
  if (assemblySettled.status === "rejected") {
    fullGame = unavailableFullGameSource("ERROR", [
      `FULL_GAME_ASSEMBLY_FAILED:${message(assemblySettled.reason)}`,
    ]);
  } else if (assemblySettled.value.status === "BLOCKED") {
    fullGame = unavailableFullGameSource("BLOCKED", assemblySettled.value.blockers);
  } else {
    try {
      const live = await (deps.buildOpportunityLive ?? buildMlbDailyOpportunityLive)({
        assembled: assemblySettled.value.input,
        provisionalV16Provider: deps.provisionalV16Provider,
      });
      fullGame = fullGameCandidateSourceFromLive(live);
    } catch (error) {
      fullGame = unavailableFullGameSource("ERROR", [
        `FULL_GAME_LIVE_FAILED:${message(error)}`,
      ]);
    }
  }

  const pool = buildMlbNormalizedCandidatePool({
    date,
    generatedAt: now.toISOString(),
    slate,
    fullGame,
    early,
  });

  return {
    httpStatus: 200,
    body: {
      success: true,
      runId,
      data: pool,
      policy: {
        oneSlateFeedsBothEngines: true,
        engineFailureDoesNotEraseOtherEngine: true,
        paidOddsCalled: false,
        marketPricesRead: false,
        outcomesRead: false,
        crossEngineRankPerformed: false,
        automaticBetPlacement: false,
        realFinancialExposure: 0,
      },
    },
  };
}

function publicError(error: unknown): { status: number; code: string } {
  const text = message(error);
  if (text === "MLB_CANDIDATE_POOL_INVALID_DATE") return { status: 400, code: text };
  if (text.startsWith("MLB_CANDIDATE_POOL_")) return { status: 400, code: text.split(":")[0] };
  return { status: 502, code: "MLB_CANDIDATE_POOL_COMMAND_FAILED" };
}

export function registerMlbNormalizedCandidatePoolRoutes(
  app: Express,
  deps: MlbNormalizedCandidatePoolRouteDependencies,
): void {
  app.post(MLB_NORMALIZED_CANDIDATE_POOL_ROUTE, async (req: Request, res: Response) => {
    try {
      const response = await executeMlbNormalizedCandidatePoolCommand(requestDate(req), deps);
      return res.status(response.httpStatus).json(response.body);
    } catch (error) {
      const mapped = publicError(error);
      return res.status(mapped.status).json({
        success: false,
        error: mapped.code,
        message: mapped.status >= 500
          ? "MLB normalized candidate pool is unavailable."
          : "MLB normalized candidate pool input was rejected.",
      });
    }
  });
}
