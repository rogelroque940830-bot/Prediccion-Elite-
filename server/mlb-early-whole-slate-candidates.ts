import crypto from "node:crypto";
import { buildMlbP1DailySlate, type MlbP1DailySlate, type MlbP1SlateGame } from "./mlb-p1-daily-slate";
import {
  computeMlbEarlyEngine,
  type MlbEarlyEngineOutput,
  type MlbEarlyEngineRequest,
} from "./mlb-early-engine-service";

export const MLB_EARLY_WHOLE_SLATE_SCHEMA = "mlb-early-whole-slate-candidates.v1" as const;
export const MLB_EARLY_CANDIDATE_SCHEMA = "mlb-early-sporting-candidate.v1" as const;

type CandidateMarket = "F5_ML" | "INNING_1_ML" | "TT_OVER_15_F5" | "TT_UNDER_25_F5";
type Side = "HOME" | "AWAY";

type SlateProvider = (input: { date: string }) => Promise<MlbP1DailySlate>;
type EngineProvider = (input: MlbEarlyEngineRequest) => Promise<MlbEarlyEngineOutput>;

export interface MlbEarlySportingCandidate {
  schemaVersion: typeof MLB_EARLY_CANDIDATE_SCHEMA;
  candidateId: string;
  gamePk: number;
  gameDate: string;
  commenceTime: string | null;
  homeTeam: string;
  awayTeam: string;
  engine: "ERE";
  engineSnapshotSha256: string;
  authority: "FINAL_RECOMMENDATION" | "ALTERNATIVE_PICK";
  marketType: CandidateMarket;
  selection: string;
  side: Side;
  line: number | null;
  modelProbability: number;
  action: "BET";
  confidence: string;
  isPremium: boolean;
  reason: string;
  sportingEligible: true;
  globalRankEligible: false;
  globalRankBlockers: readonly ["UNPRICED_EARLY_CANDIDATE", "CROSS_ENGINE_CALIBRATION_NOT_ATTACHED"];
  price: {
    status: "UNPRICED";
    oddsAmerican: null;
    marketImpliedProbability: null;
    edgePp: null;
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function earlyEngineSnapshotSha256(output: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(output))).digest("hex");
}

function clampProbability(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.max(0.001, Math.min(0.999, number));
}

function selectionFor(game: MlbP1SlateGame, market: CandidateMarket, side: Side): { selection: string; line: number | null } {
  const team = side === "HOME" ? game.homeTeam.name : game.awayTeam.name;
  if (market === "F5_ML") return { selection: `${team} F5 ML`, line: null };
  if (market === "INNING_1_ML") return { selection: `${team} 1st Inning ML`, line: null };
  if (market === "TT_OVER_15_F5") return { selection: `${team} F5 Team Total Over 1.5`, line: 1.5 };
  return { selection: `${team} F5 Team Total Under 2.5`, line: 2.5 };
}

function probabilityFor(output: MlbEarlyEngineOutput, market: CandidateMarket, side: Side): number {
  const markets: any = output.markets;
  if (market === "F5_ML") {
    return clampProbability(side === "HOME" ? output.f5Unified.f5ProbHome : output.f5Unified.f5ProbAway);
  }
  if (market === "INNING_1_ML") {
    return clampProbability(side === "HOME" ? markets.inning1.homeProb : markets.inning1.awayProb);
  }
  if (market === "TT_OVER_15_F5") {
    return clampProbability(side === "HOME" ? markets.teamTotalOver15F5.homeProb : markets.teamTotalOver15F5.awayProb);
  }
  return clampProbability(side === "HOME" ? markets.teamTotalUnder25F5.homeProb : markets.teamTotalUnder25F5.awayProb);
}

function candidateFromRecommendation(input: {
  game: MlbP1SlateGame;
  output: MlbEarlyEngineOutput;
  digest: string;
  authority: "FINAL_RECOMMENDATION" | "ALTERNATIVE_PICK";
  recommendation: any;
}): MlbEarlySportingCandidate | null {
  const { game, output, digest, authority, recommendation } = input;
  const market = String(recommendation?.market ?? "") as CandidateMarket;
  const side = String(recommendation?.side ?? "") as Side;
  if (!["F5_ML", "INNING_1_ML", "TT_OVER_15_F5", "TT_UNDER_25_F5"].includes(market)) return null;
  if (side !== "HOME" && side !== "AWAY") return null;
  if (authority === "FINAL_RECOMMENDATION" && recommendation?.action !== "BET") return null;

  const { selection, line } = selectionFor(game, market, side);
  const probability = Number.isFinite(Number(recommendation?.prob))
    ? clampProbability(recommendation.prob)
    : probabilityFor(output, market, side);
  const candidateId = `${game.gamePk}:${market}:${side}:${digest.slice(0, 16)}`;
  return {
    schemaVersion: MLB_EARLY_CANDIDATE_SCHEMA,
    candidateId,
    gamePk: game.gamePk,
    gameDate: game.officialDate,
    commenceTime: game.startTime,
    homeTeam: game.homeTeam.name,
    awayTeam: game.awayTeam.name,
    engine: "ERE",
    engineSnapshotSha256: digest,
    authority,
    marketType: market,
    selection,
    side,
    line,
    modelProbability: probability,
    action: "BET",
    confidence: String(output.markets.confidence ?? "LOW"),
    isPremium: recommendation?.isPremium === true,
    reason: String(recommendation?.reason ?? "Canonical Early/ERE recommendation"),
    sportingEligible: true,
    globalRankEligible: false,
    globalRankBlockers: ["UNPRICED_EARLY_CANDIDATE", "CROSS_ENGINE_CALIBRATION_NOT_ATTACHED"],
    price: {
      status: "UNPRICED",
      oddsAmerican: null,
      marketImpliedProbability: null,
      edgePp: null,
    },
  };
}

function candidatesFromOutput(game: MlbP1SlateGame, output: MlbEarlyEngineOutput, digest: string): MlbEarlySportingCandidate[] {
  const rows: MlbEarlySportingCandidate[] = [];
  const finalCandidate = candidateFromRecommendation({
    game,
    output,
    digest,
    authority: "FINAL_RECOMMENDATION",
    recommendation: output.markets.finalRecommendation,
  });
  if (finalCandidate) rows.push(finalCandidate);
  for (const alternative of output.markets.alternativePicks ?? []) {
    const candidate = candidateFromRecommendation({
      game,
      output,
      digest,
      authority: "ALTERNATIVE_PICK",
      recommendation: { ...alternative, action: "BET" },
    });
    if (candidate && !rows.some((row) => row.marketType === candidate.marketType && row.side === candidate.side)) {
      rows.push(candidate);
    }
  }
  return rows;
}

function evaluatedMarkets(output: MlbEarlyEngineOutput) {
  const markets: any = output.markets;
  return {
    f5Ml: {
      homeProbability: output.f5Unified.f5ProbHome,
      awayProbability: output.f5Unified.f5ProbAway,
      recommendedSide: markets.f5RecommendedSide,
      edgePp: markets.f5MlEdge ?? null,
      currentAuthority: "CORE_EARLY_MARKET",
    },
    f5Total: {
      estimatedRuns: markets.f5TotalRunsEstimated,
      line: null,
      overProbability: markets.f5OverProb ?? null,
      underProbability: markets.f5UnderProb ?? null,
      recommendedSide: markets.f5TotalSide ?? "NOT_EVALUATED",
      currentAuthority: "PRICE_LINE_REQUIRED_FOR_SIDE",
    },
    nrfiYrfi: {
      nrfiProbability: markets.probNoRun1stInn,
      yrfiProbability: markets.probAnyRun1stInn,
      recommendedSide: markets.nrfiYrfiRec,
      currentAuthority: "EVALUATED_NON_CORE_NOT_FINAL_RECOMMENDATION",
    },
    inning1: { ...markets.inning1, currentAuthority: "CORE_EARLY_MARKET" },
    inning2: { ...markets.inning2, currentAuthority: "EVALUATED_NON_CORE_NOT_FINAL_RECOMMENDATION" },
    inning3: { ...markets.inning3, currentAuthority: "EVALUATED_NON_CORE_NOT_FINAL_RECOMMENDATION" },
    teamTotalOver15F5: { ...markets.teamTotalOver15F5, currentAuthority: "CORE_EARLY_MARKET" },
    teamTotalUnder25F5: { ...markets.teamTotalUnder25F5, currentAuthority: "CORE_EARLY_MARKET" },
  };
}

function engineRequestFor(game: MlbP1SlateGame): MlbEarlyEngineRequest {
  if (!game.homeTeam.id || !game.awayTeam.id || !game.homePitcher.id || !game.awayPitcher.id) {
    throw new Error("GAME_IDENTITY_OR_PITCHER_INCOMPLETE");
  }
  return {
    gameDate: game.officialDate,
    home: {
      teamId: game.homeTeam.id,
      teamName: game.homeTeam.name,
      gamePk: game.gamePk,
      opposingPitcherId: game.awayPitcher.id,
      opposingPitcherHand: game.awayPitcher.hand ?? undefined,
      venue: game.venue ?? undefined,
    },
    away: {
      teamId: game.awayTeam.id,
      teamName: game.awayTeam.name,
      gamePk: game.gamePk,
      opposingPitcherId: game.homePitcher.id,
      opposingPitcherHand: game.homePitcher.hand ?? undefined,
      venue: game.venue ?? undefined,
    },
  };
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function buildMlbEarlyWholeSlateCandidates(options: {
  date: string;
  slateProvider?: SlateProvider;
  engineProvider?: EngineProvider;
  now?: Date;
  concurrency?: number;
}) {
  const slateProvider = options.slateProvider ?? ((input) => buildMlbP1DailySlate(input));
  const engineProvider = options.engineProvider ?? computeMlbEarlyEngine;
  const generatedAt = (options.now ?? new Date()).toISOString();
  const slate = await slateProvider({ date: options.date });

  const games = await mapWithConcurrency(slate.games, options.concurrency ?? 3, async (game) => {
    const identity = {
      gamePk: game.gamePk,
      gameDate: game.officialDate,
      commenceTime: game.startTime,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homePitcher: game.homePitcher,
      awayPitcher: game.awayPitcher,
      readiness: game.readiness,
      analysisStage: game.analysisStage,
    };

    if (!game.analysisAllowed) {
      return {
        ...identity,
        status: "BLOCKED" as const,
        blockers: [...game.blockers],
        candidates: [] as MlbEarlySportingCandidate[],
        evaluatedMarkets: null,
        engineSnapshotSha256: null,
        earlyEngine: null,
      };
    }

    try {
      const output = await engineProvider(engineRequestFor(game));
      const digest = earlyEngineSnapshotSha256(output);
      const candidates = output.markets.dataIncomplete ? [] : candidatesFromOutput(game, output, digest);
      const status = output.markets.dataIncomplete
        ? "DATA_INCOMPLETE"
        : candidates.length > 0
          ? "CANDIDATES_READY"
          : "PASS";
      const blockers = output.markets.dataIncomplete
        ? ["EARLY_DATA_INCOMPLETE", ...output.markets.warnings]
        : candidates.length === 0
          ? [String(output.markets.finalRecommendation?.reason ?? "EARLY_ENGINE_PASS")]
          : [];
      return {
        ...identity,
        status,
        blockers,
        candidates,
        evaluatedMarkets: evaluatedMarkets(output),
        engineSnapshotSha256: digest,
        // Exact canonical output is retained so a later pool/save step can use
        // the evaluated snapshot without recomputing ERE.
        earlyEngine: output,
      };
    } catch (error) {
      return {
        ...identity,
        status: "ERROR" as const,
        blockers: [error instanceof Error ? error.message : String(error)],
        candidates: [] as MlbEarlySportingCandidate[],
        evaluatedMarkets: null,
        engineSnapshotSha256: null,
        earlyEngine: null,
      };
    }
  });

  const candidates = games.flatMap((game) => game.candidates);
  return {
    schemaVersion: MLB_EARLY_WHOLE_SLATE_SCHEMA,
    date: options.date,
    generatedAt,
    sourceSlateSchemaVersion: slate.schemaVersion,
    games,
    candidates,
    summary: {
      totalGames: games.length,
      candidateGames: games.filter((game) => game.status === "CANDIDATES_READY").length,
      passGames: games.filter((game) => game.status === "PASS").length,
      blockedGames: games.filter((game) => game.status === "BLOCKED").length,
      dataIncompleteGames: games.filter((game) => game.status === "DATA_INCOMPLETE").length,
      errorGames: games.filter((game) => game.status === "ERROR").length,
      sportingCandidates: candidates.length,
      globallyRankEligibleCandidates: 0,
    },
    boundary: {
      phase: "EARLY_SPORTING_CANDIDATE_PRODUCER",
      pricingAttached: false,
      crossEngineRankingAttached: false,
      fullGameAuthorityChanged: false,
      automaticBetPlacement: false,
    },
  };
}

export type MlbEarlyWholeSlateCandidates = Awaited<ReturnType<typeof buildMlbEarlyWholeSlateCandidates>>;
