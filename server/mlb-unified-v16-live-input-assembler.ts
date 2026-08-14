import type { C4LiveFeatureAssessment } from "./mlb-c4-live-feature-builder";
import { screenMlbDailySlateCheap } from "./mlb-cheap-screening";
import type { MlbFrozenResearchRouteAssessment } from "./mlb-frozen-research-route-ledger";
import type { MlbIntrinsicBullpenByGame } from "./mlb-intrinsic-edge";
import type { MlbP1DailySlate } from "./mlb-p1-daily-slate";
import type { MlbShortlistEvidenceByGame } from "./mlb-shortlist";
import type { MlbUnifiedPricedV16RunnerInput } from "./mlb-unified-priced-v16-runner";

export const MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA =
  "courtedge-p0-mlb-unified-v16-live-input-assembler.v1" as const;

export type MlbUnifiedV16LiveInputBlockerCode =
  | "SHORTLIST_EVIDENCE_UNAVAILABLE"
  | "BULLPEN_EVIDENCE_UNAVAILABLE"
  | "FROZEN_ROUTE_ASSESSMENT_UNAVAILABLE"
  | "C4_LIVE_INPUT_UNAVAILABLE";

export interface MlbUnifiedV16LiveInputBlocker {
  code: MlbUnifiedV16LiveInputBlockerCode;
  gamePks: readonly number[];
  message: string;
}

export interface MlbUnifiedV16LiveEvidenceContext {
  runId: string;
  slate: MlbP1DailySlate;
  now: Date;
  analysisEligibleGamePks: readonly number[];
  finalEligibleGamePks: readonly number[];
}

export interface MlbUnifiedV16LiveEvidenceLoad<T> {
  value?: T;
  blockers?: readonly MlbUnifiedV16LiveInputBlocker[];
}

export type MlbUnifiedV16LiveEvidenceProvider<T> = (
  context: MlbUnifiedV16LiveEvidenceContext,
) => Promise<MlbUnifiedV16LiveEvidenceLoad<T>>;

export interface MlbUnifiedV16LiveEvidenceProviders {
  shortlistEvidence?: MlbUnifiedV16LiveEvidenceProvider<MlbShortlistEvidenceByGame>;
  bullpenEvidence?: MlbUnifiedV16LiveEvidenceProvider<MlbIntrinsicBullpenByGame>;
  frozenRouteAssessments?: MlbUnifiedV16LiveEvidenceProvider<
    Readonly<Record<number, MlbFrozenResearchRouteAssessment | undefined>>
  >;
  c4Assessments?: MlbUnifiedV16LiveEvidenceProvider<
    Readonly<Record<number, C4LiveFeatureAssessment | undefined>>
  >;
}

export type MlbUnifiedV16AssembledRunnerInput = Omit<
  MlbUnifiedPricedV16RunnerInput,
  "oddsService" | "providerAccountScopeKey" | "apiKey" | "maxRunCredits" | "reserveCredits"
>;

export interface MlbUnifiedV16LiveInputReady {
  schemaVersion: typeof MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA;
  status: "READY";
  runId: string;
  input: MlbUnifiedV16AssembledRunnerInput;
  blockers: readonly [];
  policy: MlbUnifiedV16LiveInputPolicy;
}

export interface MlbUnifiedV16LiveInputBlocked {
  schemaVersion: typeof MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA;
  status: "BLOCKED";
  runId: string;
  input: null;
  blockers: readonly MlbUnifiedV16LiveInputBlocker[];
  policy: MlbUnifiedV16LiveInputPolicy;
}

export type MlbUnifiedV16LiveInputAssemblyResult =
  | MlbUnifiedV16LiveInputReady
  | MlbUnifiedV16LiveInputBlocked;

export interface MlbUnifiedV16LiveInputPolicy {
  serverSideAssemblyOnly: true;
  certifiedProviderContractRequired: true;
  browserMaySupplyCertifiedEvidence: false;
  paidOddsBoundaryCrossed: false;
  theOddsApiCreditsConsumed: 0;
  failClosedOnMissingEvidence: true;
  automaticPolling: false;
  automaticBetPlacement: false;
  realFinancialExposure: 0;
}

const POLICY: MlbUnifiedV16LiveInputPolicy = Object.freeze({
  serverSideAssemblyOnly: true,
  certifiedProviderContractRequired: true,
  browserMaySupplyCertifiedEvidence: false,
  paidOddsBoundaryCrossed: false,
  theOddsApiCreditsConsumed: 0,
  failClosedOnMissingEvidence: true,
  automaticPolling: false,
  automaticBetPlacement: false,
  realFinancialExposure: 0,
});

function blocker(
  code: MlbUnifiedV16LiveInputBlockerCode,
  gamePks: readonly number[],
  message: string,
): MlbUnifiedV16LiveInputBlocker {
  return Object.freeze({ code, gamePks: Object.freeze([...gamePks]), message });
}

async function load<T>(input: {
  provider: MlbUnifiedV16LiveEvidenceProvider<T> | undefined;
  context: MlbUnifiedV16LiveEvidenceContext;
  missingCode: MlbUnifiedV16LiveInputBlockerCode;
  gamePks: readonly number[];
  missingMessage: string;
}): Promise<MlbUnifiedV16LiveEvidenceLoad<T>> {
  if (!input.provider) {
    return {
      blockers: [blocker(input.missingCode, input.gamePks, input.missingMessage)],
    };
  }

  const result = await input.provider(input.context);
  if (result.value === undefined && (!result.blockers || result.blockers.length === 0)) {
    return {
      blockers: [blocker(input.missingCode, input.gamePks, input.missingMessage)],
    };
  }
  return result;
}

function uniqueBlockers(
  blockers: readonly MlbUnifiedV16LiveInputBlocker[],
): readonly MlbUnifiedV16LiveInputBlocker[] {
  const seen = new Set<string>();
  const output: MlbUnifiedV16LiveInputBlocker[] = [];
  for (const entry of blockers) {
    const key = `${entry.code}:${[...entry.gamePks].sort((a, b) => a - b).join(",")}:${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(Object.freeze({
      code: entry.code,
      gamePks: Object.freeze([...entry.gamePks]),
      message: entry.message,
    }));
  }
  return Object.freeze(output);
}

export async function assembleMlbUnifiedV16LiveInput(
  input: {
    runId: string;
    slate: MlbP1DailySlate;
    now?: Date;
  },
  providers: MlbUnifiedV16LiveEvidenceProviders = {},
): Promise<MlbUnifiedV16LiveInputAssemblyResult> {
  const runId = String(input.runId ?? "").trim();
  if (!runId) throw new Error("MLB_UNIFIED_V16_LIVE_ASSEMBLER_RUN_ID_REQUIRED");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MLB_UNIFIED_V16_LIVE_ASSEMBLER_NOW_INVALID");

  const cheapScreen = screenMlbDailySlateCheap(input.slate);
  const analysisEligible = cheapScreen.games.filter((game) => game.eligibleForDeepPrefilterNow);
  const analysisEligibleGamePks = Object.freeze(analysisEligible.map((game) => game.gamePk));
  const finalEligibleGamePks = Object.freeze(
    analysisEligible.filter((game) => game.finalInputsAvailable).map((game) => game.gamePk),
  );

  const context: MlbUnifiedV16LiveEvidenceContext = Object.freeze({
    runId,
    slate: input.slate,
    now,
    analysisEligibleGamePks,
    finalEligibleGamePks,
  });

  if (analysisEligibleGamePks.length === 0) {
    return Object.freeze({
      schemaVersion: MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA,
      status: "READY" as const,
      runId,
      input: Object.freeze({
        runId,
        slate: input.slate,
        shortlistEvidenceByGame: {},
        bullpenByGame: {},
        finalRouteAssessmentsByGame: {},
        c4ByGame: {},
        now,
      }),
      blockers: Object.freeze([]) as readonly [],
      policy: POLICY,
    });
  }

  const [shortlist, bullpen, frozenRoutes, c4] = await Promise.all([
    load({
      provider: providers.shortlistEvidence,
      context,
      missingCode: "SHORTLIST_EVIDENCE_UNAVAILABLE",
      gamePks: analysisEligibleGamePks,
      missingMessage: "Certified shortlist evidence is not available from a server-side provider.",
    }),
    load({
      provider: providers.bullpenEvidence,
      context,
      missingCode: "BULLPEN_EVIDENCE_UNAVAILABLE",
      gamePks: analysisEligibleGamePks,
      missingMessage: "Certified bullpen evidence is not available from a server-side provider.",
    }),
    load({
      provider: providers.frozenRouteAssessments,
      context,
      missingCode: "FROZEN_ROUTE_ASSESSMENT_UNAVAILABLE",
      gamePks: finalEligibleGamePks,
      missingMessage: "Frozen FINAL route assessments are not available from a server-side provider.",
    }),
    load({
      provider: providers.c4Assessments,
      context,
      missingCode: "C4_LIVE_INPUT_UNAVAILABLE",
      gamePks: finalEligibleGamePks,
      missingMessage: "Canonical C4 live assessments are not available from a server-side provider.",
    }),
  ]);

  const blockers = uniqueBlockers([
    ...(shortlist.blockers ?? []),
    ...(bullpen.blockers ?? []),
    ...(frozenRoutes.blockers ?? []),
    ...(c4.blockers ?? []),
  ]);

  if (
    blockers.length > 0
    || shortlist.value === undefined
    || bullpen.value === undefined
    || frozenRoutes.value === undefined
    || c4.value === undefined
  ) {
    return Object.freeze({
      schemaVersion: MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA,
      status: "BLOCKED" as const,
      runId,
      input: null,
      blockers,
      policy: POLICY,
    });
  }

  return Object.freeze({
    schemaVersion: MLB_UNIFIED_V16_LIVE_INPUT_ASSEMBLER_SCHEMA,
    status: "READY" as const,
    runId,
    input: Object.freeze({
      runId,
      slate: input.slate,
      shortlistEvidenceByGame: shortlist.value,
      bullpenByGame: bullpen.value,
      finalRouteAssessmentsByGame: frozenRoutes.value,
      c4ByGame: c4.value,
      now,
    }),
    blockers: Object.freeze([]) as readonly [],
    policy: POLICY,
  });
}
