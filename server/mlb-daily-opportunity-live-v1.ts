import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  buildMlbDailyOpportunityContext,
  type MlbDailyOpportunityContextResult,
} from "./mlb-daily-opportunity-context-v1";
import {
  buildMlbDailyOpportunityPriceShortlist,
  type MlbDailyOpportunityPriceShortlist,
} from "./mlb-daily-opportunity-price-shortlist-v1";
import {
  assessMlbProvisionalV16LineupProxy,
  type MlbProvisionalV16LineupProxyResult,
} from "./mlb-provisional-v16-lineup-proxy-v1";
import { scoreMlbV16SettlementEvidence } from "./mlb-pure-settlement-scorer";
import type { MlbV16SettlementEvidence } from "./mlb-pure-settlement-evidence-adapter";
import {
  runMlbUnifiedPrepriceStep11c,
  type MlbUnifiedRunnerResult,
} from "./mlb-unified-runner";
import type { MlbUnifiedV16AssembledRunnerInput } from "./mlb-unified-v16-live-input-assembler";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";

export const MLB_DAILY_OPPORTUNITY_LIVE_SCHEMA =
  "courtedge-mlb-daily-opportunity-live.v1" as const;

export type MlbDailyOpportunityProvisionalV16Provider = (
  game: MlbP1SlateGame,
  generatedAt: string,
) => Promise<MlbProvisionalV16LineupProxyResult>;

export interface MlbDailyOpportunityLiveResult {
  schemaVersion: typeof MLB_DAILY_OPPORTUNITY_LIVE_SCHEMA;
  generatedAt: string;
  preprice: MlbUnifiedRunnerResult;
  dailyOpportunity: MlbDailyOpportunityContextResult;
  priceConsultationShortlist: MlbDailyOpportunityPriceShortlist;
  provisionalV16: {
    attemptedGamePks: readonly number[];
    scoredGamePks: readonly number[];
    failed: readonly { gamePk: number; code: string }[];
  };
  policy: {
    wholeQualifiedSlateCompetes: true;
    provisionalGamesMayLead: true;
    provisionalProbabilityUsesPriorDateLineupProxy: true;
    provisionalProbabilityFailureDoesNotEraseIntrinsicContext: true;
    maximumPossiblePriceConsultations: 3;
    wholeSlateAnalysisDoesNotExpandPriceQuota: true;
    paidOddsBoundaryCrossed: false;
    outcomesRead: false;
    marketPricesRead: false;
    v68Changed: false;
    v80Changed: false;
    productionDailyBestPickChanged: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

function errorCode(error: unknown): string {
  const message = String((error as any)?.message ?? "MLB_PROVISIONAL_V16_UNKNOWN_FAILURE");
  return message.split(":")[0] || "MLB_PROVISIONAL_V16_UNKNOWN_FAILURE";
}

function finalV16Evidence(
  assembled: MlbUnifiedV16AssembledRunnerInput,
  preprice: MlbUnifiedRunnerResult,
): Readonly<Record<number, MlbV16SettlementEvidence | undefined>> {
  const finalPks = new Set(preprice.intrinsic.games
    .filter((game) => game.inputStage === "FINAL")
    .map((game) => game.gamePk));
  const output: Record<number, MlbV16SettlementEvidence> = {};
  for (const gamePk of finalPks) {
    const c4 = assembled.c4ByGame[gamePk];
    if (!c4) continue;
    output[gamePk] = scoreMlbV16SettlementEvidence(gamePk, preprice.generatedAt, c4);
  }
  return Object.freeze(output);
}

function defaultProvisionalProvider(): MlbDailyOpportunityProvisionalV16Provider {
  // One shared certified materializer means all same-date provisional games reuse the exact
  // same prior-date historical snapshot and cache rather than independently rebuilding a season.
  const materializer = new MlbC4CertifiedMaterializer();
  return (game, generatedAt) => assessMlbProvisionalV16LineupProxy(game, {
    certifiedMaterializer: materializer,
    generatedAt,
  });
}

export async function buildMlbDailyOpportunityLive(input: {
  assembled: MlbUnifiedV16AssembledRunnerInput;
  provisionalV16Provider?: MlbDailyOpportunityProvisionalV16Provider;
}): Promise<MlbDailyOpportunityLiveResult> {
  const preprice = runMlbUnifiedPrepriceStep11c(input.assembled);
  const finalByGame = finalV16Evidence(input.assembled, preprice);
  const provider = input.provisionalV16Provider ?? defaultProvisionalProvider();
  const slateByPk = new Map(input.assembled.slate.games.map((game) => [game.gamePk, game]));

  // Use the whole qualified intrinsic population, not only the top-8 paid market-discovery
  // population. A late provisional game cannot disappear because of an odds-quota cap.
  const provisionalIntrinsicPks = preprice.intrinsic.games
    .filter((game) => game.inputStage === "PROVISIONAL")
    .map((game) => game.gamePk);
  const provisionalByGame: Record<number, MlbV16SettlementEvidence> = {};
  const failures: Array<{ gamePk: number; code: string }> = [];

  await Promise.all(provisionalIntrinsicPks.map(async (gamePk) => {
    const game = slateByPk.get(gamePk);
    if (!game) {
      failures.push({ gamePk, code: "MLB_DAILY_OPPORTUNITY_PROVISIONAL_GAME_NOT_IN_SLATE" });
      return;
    }
    try {
      const result = await provider(game, preprice.generatedAt);
      if (result.gamePk !== gamePk || result.officialDate !== preprice.date) {
        throw new Error(`MLB_DAILY_OPPORTUNITY_PROVISIONAL_IDENTITY_MISMATCH:${gamePk}`);
      }
      provisionalByGame[gamePk] = result.v16Evidence;
    } catch (error) {
      // Probability failure is diagnostic only. The intrinsic sporting context was built from
      // independent certified evidence and stays eligible; it simply competes without pretending
      // that an unavailable provisional probability was measured.
      failures.push({ gamePk, code: errorCode(error) });
    }
  }));

  failures.sort((a, b) => a.gamePk - b.gamePk || a.code.localeCompare(b.code));
  const scoredGamePks = Object.keys(provisionalByGame).map(Number).sort((a, b) => a - b);
  const dailyOpportunity = buildMlbDailyOpportunityContext({
    slate: input.assembled.slate,
    intrinsic: preprice.intrinsic,
    finalV16ByGame: finalByGame,
    provisionalV16ByGame: provisionalByGame,
  });
  const priceConsultationShortlist = buildMlbDailyOpportunityPriceShortlist(dailyOpportunity);

  return Object.freeze({
    schemaVersion: MLB_DAILY_OPPORTUNITY_LIVE_SCHEMA,
    generatedAt: preprice.generatedAt,
    preprice,
    dailyOpportunity,
    priceConsultationShortlist,
    provisionalV16: Object.freeze({
      attemptedGamePks: Object.freeze([...provisionalIntrinsicPks].sort((a, b) => a - b)),
      scoredGamePks: Object.freeze(scoredGamePks),
      failed: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
    }),
    policy: Object.freeze({
      wholeQualifiedSlateCompetes: true as const,
      provisionalGamesMayLead: true as const,
      provisionalProbabilityUsesPriorDateLineupProxy: true as const,
      provisionalProbabilityFailureDoesNotEraseIntrinsicContext: true as const,
      maximumPossiblePriceConsultations: 3 as const,
      wholeSlateAnalysisDoesNotExpandPriceQuota: true as const,
      paidOddsBoundaryCrossed: false as const,
      outcomesRead: false as const,
      marketPricesRead: false as const,
      v68Changed: false as const,
      v80Changed: false as const,
      productionDailyBestPickChanged: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}
