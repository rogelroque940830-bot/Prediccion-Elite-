import crypto from "node:crypto";
import type { MlbDailyBestPickRuntimeEvaluation } from "./mlb-daily-best-pick-selector";
import { selectMlbDailyBestPickFromUnifiedPreprice } from "./mlb-daily-best-pick-runtime-adapter";
import type { MlbDailyOpportunityEntry, MlbDailyOpportunityContextResult } from "./mlb-daily-opportunity-context-v1";
import type { MlbDailyOpportunityLiveResult } from "./mlb-daily-opportunity-live-v1";
import type { MlbEarlySportingCandidate, MlbEarlyWholeSlateCandidates } from "./mlb-early-whole-slate-candidates";
import type { MlbP1DailySlate, MlbP1SlateGame } from "./mlb-p1-daily-slate";

export const MLB_NORMALIZED_CANDIDATE_POOL_SCHEMA = "courtedge-mlb-normalized-candidate-pool.v1" as const;
export const MLB_NORMALIZED_CANDIDATE_SCHEMA = "courtedge-mlb-normalized-sporting-candidate.v1" as const;

export type MlbNormalizedEngineFamily = "FULL_GAME" | "EARLY";
export type MlbNormalizedMarketFamily = "MONEYLINE" | "TEAM_TOTAL";
export type MlbNormalizedHorizon = "FULL_GAME" | "FIRST_5" | "INNING_1";
export type MlbNormalizedDirection = "HOME" | "AWAY" | "OVER" | "UNDER";
export type MlbNormalizedTeamSide = "HOME" | "AWAY" | null;
export type MlbCandidateSourceStatus = "READY" | "PARTIAL" | "BLOCKED" | "ERROR";

export interface MlbNormalizedMarketIdentity {
  family: MlbNormalizedMarketFamily;
  horizon: MlbNormalizedHorizon;
  teamSide: MlbNormalizedTeamSide;
  direction: MlbNormalizedDirection;
  line: number | null;
  sourceMarketType: string;
}

export interface MlbNormalizedSportingCandidate {
  schemaVersion: typeof MLB_NORMALIZED_CANDIDATE_SCHEMA;
  candidateSnapshotId: string;
  engineCandidateKey: string;
  bettingPropositionKey: string;
  marketIdentityKey: string;
  sport: "MLB";
  game: {
    gamePk: number;
    officialDate: string;
    commenceTime: string | null;
    awayTeam: string;
    homeTeam: string;
    inputStage: "FINAL" | "PROVISIONAL" | "UNKNOWN";
  };
  engine: {
    family: MlbNormalizedEngineFamily;
    name: "FROZEN_FULL_GAME_AUTHORITY" | "ERE";
    authority: string;
    tier: "A_PLUS" | "PREMIUM" | null;
    localRank: number | null;
  };
  market: MlbNormalizedMarketIdentity;
  sporting: {
    eligible: true;
    modelWinProbability: number | null;
    modelPushProbability: number | null;
    modelLossProbability: number | null;
    probabilitySemantics:
      | "EXPLICIT_WIN_PUSH_LOSS"
      | "TWO_WAY_WIN_LOSS"
      | "SOURCE_WIN_PROBABILITY_PUSH_UNMODELED";
    confidence: string | null;
    sourcePremiumFlag: boolean | null;
    reason: string;
  };
  pricing: {
    status: "UNPRICED";
    oddsAmerican: null;
    marketImpliedProbability: null;
    noVigProbability: null;
    edgePp: null;
    expectedValuePerUnit: null;
    capturedAt: null;
    freshnessSeconds: null;
  };
  calibration: {
    status: "NOT_ATTACHED";
    calibratedWinProbability: null;
    normalizedCrossEngineScore: null;
    sampleSize: null;
  };
  globalRank: {
    eligible: false;
    blockers: readonly string[];
  };
  provenance: {
    sourceSchemaVersion: string;
    sourceRunId: string | null;
    sourceCandidateId: string | null;
    sourceEvaluationId: string | null;
    sourceSnapshotSha256: string | null;
  };
}

export interface MlbFullGameCandidateSource {
  status: MlbCandidateSourceStatus;
  sourceRunId: string | null;
  sourceSchemaVersion: string;
  evaluations: readonly MlbDailyBestPickRuntimeEvaluation[];
  opportunities: readonly MlbDailyOpportunityEntry[];
  blockers: readonly string[];
}

export interface MlbEarlyCandidatePoolSource {
  status: MlbCandidateSourceStatus;
  payload: MlbEarlyWholeSlateCandidates | null;
  blockers: readonly string[];
}

function finiteProbability(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function cleanLine(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableSha256(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function gameStage(game: MlbP1SlateGame | undefined): "FINAL" | "PROVISIONAL" | "UNKNOWN" {
  return game?.analysisStage === "FINAL" || game?.analysisStage === "PROVISIONAL"
    ? game.analysisStage
    : "UNKNOWN";
}

function marketIdentityKey(input: {
  date: string;
  gamePk: number;
  market: MlbNormalizedMarketIdentity;
}): string {
  const team = input.market.teamSide ?? "ANY";
  const line = input.market.line == null ? "NO_LINE" : String(input.market.line);
  return [
    "MLB",
    input.date,
    input.gamePk,
    input.market.family,
    input.market.horizon,
    team,
    line,
  ].join("|");
}

function bettingPropositionKey(input: {
  date: string;
  gamePk: number;
  market: MlbNormalizedMarketIdentity;
}): string {
  return `${marketIdentityKey(input)}|${input.market.direction}`;
}

function baseRankBlockers(settlementComplete: boolean, probabilityPresent: boolean): string[] {
  const blockers = ["PRICE_NOT_ATTACHED", "CROSS_ENGINE_CALIBRATION_NOT_ATTACHED"];
  if (!probabilityPresent) blockers.push("MODEL_PROBABILITY_NOT_ATTACHED");
  if (!settlementComplete) blockers.push("SETTLEMENT_MODEL_INCOMPLETE");
  return blockers;
}

function fullGameTier(route: string): "A_PLUS" | "PREMIUM" | null {
  if (route === "A_PLUS_BULLPEN_D1_F5_ELSE_FG_V1") return "A_PLUS";
  if (route === "PREMIUM_A_HOME_ML") return "PREMIUM";
  return null;
}

function fullGameMarket(evaluation: MlbDailyBestPickRuntimeEvaluation): MlbNormalizedMarketIdentity | null {
  if (evaluation.market === "FULL_GAME_ML") {
    return {
      family: "MONEYLINE",
      horizon: "FULL_GAME",
      teamSide: null,
      direction: evaluation.side,
      line: null,
      sourceMarketType: evaluation.market,
    };
  }
  if (evaluation.market === "FIRST_5_ML") {
    return {
      family: "MONEYLINE",
      horizon: "FIRST_5",
      teamSide: null,
      direction: evaluation.side,
      line: null,
      sourceMarketType: evaluation.market,
    };
  }
  return null;
}

function fullGameProbability(input: {
  evaluation: MlbDailyBestPickRuntimeEvaluation;
  opportunity: MlbDailyOpportunityEntry | undefined;
}): {
  win: number | null;
  push: number | null;
  loss: number | null;
  semantics: MlbNormalizedSportingCandidate["sporting"]["probabilitySemantics"];
} {
  const probabilities = input.opportunity?.probability.marketProbabilities;
  const side = input.evaluation.side;
  if (input.evaluation.market === "FIRST_5_ML") {
    const f5 = probabilities?.f5Ml;
    const win = finiteProbability(side === "HOME" ? f5?.homeWinProbability : f5?.awayWinProbability);
    const push = finiteProbability(f5?.pushProbability);
    const loss = win != null && push != null ? Math.max(0, Math.min(1, 1 - win - push)) : null;
    return { win, push, loss, semantics: "EXPLICIT_WIN_PUSH_LOSS" };
  }
  const ml = probabilities?.ml;
  const win = finiteProbability(side === "HOME" ? ml?.homeWinProbability : ml?.awayWinProbability);
  return {
    win,
    push: win == null ? null : 0,
    loss: win == null ? null : 1 - win,
    semantics: "TWO_WAY_WIN_LOSS",
  };
}

function normalizedFullGameCandidate(input: {
  date: string;
  slate: MlbP1DailySlate;
  source: MlbFullGameCandidateSource;
  evaluation: MlbDailyBestPickRuntimeEvaluation;
}): MlbNormalizedSportingCandidate | null {
  const { evaluation } = input;
  if (evaluation.evaluationState !== "READY") return null;
  const tier = fullGameTier(evaluation.route);
  if (!tier) return null;
  const market = fullGameMarket(evaluation);
  if (!market) return null;
  const game = input.slate.games.find((row) => row.gamePk === evaluation.gamePk);
  if (!game || game.officialDate !== input.date) return null;
  const opportunity = input.source.opportunities.find((row) => row.gamePk === evaluation.gamePk);
  const probability = fullGameProbability({ evaluation, opportunity });
  const identityKey = marketIdentityKey({ date: input.date, gamePk: game.gamePk, market });
  const propositionKey = bettingPropositionKey({ date: input.date, gamePk: game.gamePk, market });
  const sourceEvaluationId = evaluation.sourceEvaluationId ?? null;
  const engineCandidateKey = `${propositionKey}|FULL_GAME|${evaluation.route}`;
  const fingerprint = stableSha256({
    sourceRunId: input.source.sourceRunId,
    sourceEvaluationId,
    gamePk: game.gamePk,
    market,
    route: evaluation.route,
    prepriceRank: evaluation.prepriceRank,
    probability,
  });
  return Object.freeze({
    schemaVersion: MLB_NORMALIZED_CANDIDATE_SCHEMA,
    candidateSnapshotId: `${engineCandidateKey}|${fingerprint.slice(0, 20)}`,
    engineCandidateKey,
    bettingPropositionKey: propositionKey,
    marketIdentityKey: identityKey,
    sport: "MLB" as const,
    game: Object.freeze({
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      commenceTime: game.startTime,
      awayTeam: game.awayTeam.name,
      homeTeam: game.homeTeam.name,
      inputStage: gameStage(game),
    }),
    engine: Object.freeze({
      family: "FULL_GAME" as const,
      name: "FROZEN_FULL_GAME_AUTHORITY" as const,
      authority: evaluation.route,
      tier,
      localRank: typeof evaluation.prepriceRank === "number" ? evaluation.prepriceRank + 1 : null,
    }),
    market: Object.freeze(market),
    sporting: Object.freeze({
      eligible: true as const,
      modelWinProbability: probability.win,
      modelPushProbability: probability.push,
      modelLossProbability: probability.loss,
      probabilitySemantics: probability.semantics,
      confidence: null,
      sourcePremiumFlag: tier === "PREMIUM",
      reason: `Frozen ${tier} route evaluation is READY; pool normalization does not change its local authority.`,
    }),
    pricing: Object.freeze({
      status: "UNPRICED" as const,
      oddsAmerican: null,
      marketImpliedProbability: null,
      noVigProbability: null,
      edgePp: null,
      expectedValuePerUnit: null,
      capturedAt: null,
      freshnessSeconds: null,
    }),
    calibration: Object.freeze({
      status: "NOT_ATTACHED" as const,
      calibratedWinProbability: null,
      normalizedCrossEngineScore: null,
      sampleSize: null,
    }),
    globalRank: Object.freeze({
      eligible: false as const,
      blockers: Object.freeze(baseRankBlockers(true, probability.win != null)),
    }),
    provenance: Object.freeze({
      sourceSchemaVersion: input.source.sourceSchemaVersion,
      sourceRunId: input.source.sourceRunId,
      sourceCandidateId: null,
      sourceEvaluationId,
      sourceSnapshotSha256: fingerprint,
    }),
  });
}

function earlyMarket(candidate: MlbEarlySportingCandidate): {
  market: MlbNormalizedMarketIdentity;
  settlementComplete: boolean;
  semantics: MlbNormalizedSportingCandidate["sporting"]["probabilitySemantics"];
} | null {
  if (candidate.marketType === "F5_ML") {
    return {
      market: {
        family: "MONEYLINE",
        horizon: "FIRST_5",
        teamSide: null,
        direction: candidate.side,
        line: null,
        sourceMarketType: candidate.marketType,
      },
      settlementComplete: false,
      semantics: "SOURCE_WIN_PROBABILITY_PUSH_UNMODELED",
    };
  }
  if (candidate.marketType === "INNING_1_ML") {
    return {
      market: {
        family: "MONEYLINE",
        horizon: "INNING_1",
        teamSide: null,
        direction: candidate.side,
        line: null,
        sourceMarketType: candidate.marketType,
      },
      settlementComplete: false,
      semantics: "SOURCE_WIN_PROBABILITY_PUSH_UNMODELED",
    };
  }
  if (candidate.marketType === "TT_OVER_15_F5" || candidate.marketType === "TT_UNDER_25_F5") {
    return {
      market: {
        family: "TEAM_TOTAL",
        horizon: "FIRST_5",
        teamSide: candidate.side,
        direction: candidate.marketType === "TT_OVER_15_F5" ? "OVER" : "UNDER",
        line: cleanLine(candidate.line),
        sourceMarketType: candidate.marketType,
      },
      settlementComplete: true,
      semantics: "TWO_WAY_WIN_LOSS",
    };
  }
  return null;
}

function normalizedEarlyCandidate(input: {
  date: string;
  slate: MlbP1DailySlate;
  candidate: MlbEarlySportingCandidate;
}): MlbNormalizedSportingCandidate | null {
  const game = input.slate.games.find((row) => row.gamePk === input.candidate.gamePk);
  if (!game || game.officialDate !== input.date) return null;
  const mapped = earlyMarket(input.candidate);
  if (!mapped) return null;
  const win = finiteProbability(input.candidate.modelProbability);
  const push = mapped.settlementComplete && win != null ? 0 : null;
  const loss = mapped.settlementComplete && win != null ? 1 - win : null;
  const identityKey = marketIdentityKey({ date: input.date, gamePk: game.gamePk, market: mapped.market });
  const propositionKey = bettingPropositionKey({ date: input.date, gamePk: game.gamePk, market: mapped.market });
  const engineCandidateKey = `${propositionKey}|EARLY|ERE|${input.candidate.authority}`;
  return Object.freeze({
    schemaVersion: MLB_NORMALIZED_CANDIDATE_SCHEMA,
    candidateSnapshotId: `${engineCandidateKey}|${input.candidate.engineSnapshotSha256.slice(0, 20)}`,
    engineCandidateKey,
    bettingPropositionKey: propositionKey,
    marketIdentityKey: identityKey,
    sport: "MLB" as const,
    game: Object.freeze({
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      commenceTime: game.startTime,
      awayTeam: game.awayTeam.name,
      homeTeam: game.homeTeam.name,
      inputStage: gameStage(game),
    }),
    engine: Object.freeze({
      family: "EARLY" as const,
      name: "ERE" as const,
      authority: input.candidate.authority,
      tier: null,
      localRank: null,
    }),
    market: Object.freeze(mapped.market),
    sporting: Object.freeze({
      eligible: true as const,
      modelWinProbability: win,
      modelPushProbability: push,
      modelLossProbability: loss,
      probabilitySemantics: mapped.semantics,
      confidence: input.candidate.confidence,
      sourcePremiumFlag: input.candidate.isPremium,
      reason: input.candidate.reason,
    }),
    pricing: Object.freeze({
      status: "UNPRICED" as const,
      oddsAmerican: null,
      marketImpliedProbability: null,
      noVigProbability: null,
      edgePp: null,
      expectedValuePerUnit: null,
      capturedAt: null,
      freshnessSeconds: null,
    }),
    calibration: Object.freeze({
      status: "NOT_ATTACHED" as const,
      calibratedWinProbability: null,
      normalizedCrossEngineScore: null,
      sampleSize: null,
    }),
    globalRank: Object.freeze({
      eligible: false as const,
      blockers: Object.freeze(baseRankBlockers(mapped.settlementComplete, win != null)),
    }),
    provenance: Object.freeze({
      sourceSchemaVersion: input.candidate.schemaVersion,
      sourceRunId: null,
      sourceCandidateId: input.candidate.candidateId,
      sourceEvaluationId: null,
      sourceSnapshotSha256: input.candidate.engineSnapshotSha256,
    }),
  });
}

function candidateSort(left: MlbNormalizedSportingCandidate, right: MlbNormalizedSportingCandidate): number {
  return left.game.gamePk - right.game.gamePk
    || left.marketIdentityKey.localeCompare(right.marketIdentityKey)
    || left.market.direction.localeCompare(right.market.direction)
    || left.engine.family.localeCompare(right.engine.family)
    || left.engine.authority.localeCompare(right.engine.authority)
    || left.candidateSnapshotId.localeCompare(right.candidateSnapshotId);
}

function crossEngineDiagnostics(candidates: readonly MlbNormalizedSportingCandidate[]) {
  const byMarket = new Map<string, MlbNormalizedSportingCandidate[]>();
  for (const candidate of candidates) {
    const rows = byMarket.get(candidate.marketIdentityKey) ?? [];
    rows.push(candidate);
    byMarket.set(candidate.marketIdentityKey, rows);
  }
  const groups = [...byMarket.entries()].flatMap(([key, rows]) => {
    const engines = [...new Set(rows.map((row) => row.engine.family))].sort();
    if (engines.length < 2) return [];
    const directions = [...new Set(rows.map((row) => row.market.direction))].sort();
    return [Object.freeze({
      marketIdentityKey: key,
      state: directions.length === 1 ? "AGREEMENT" as const : "CONFLICT" as const,
      engines: Object.freeze(engines),
      directions: Object.freeze(directions),
      candidateSnapshotIds: Object.freeze(rows.map((row) => row.candidateSnapshotId).sort()),
    })];
  }).sort((left, right) => left.marketIdentityKey.localeCompare(right.marketIdentityKey));
  return Object.freeze({
    overlapMarketCount: groups.length,
    agreementMarketCount: groups.filter((group) => group.state === "AGREEMENT").length,
    conflictMarketCount: groups.filter((group) => group.state === "CONFLICT").length,
    groups: Object.freeze(groups),
  });
}

export function fullGameCandidateSourceFromLive(live: MlbDailyOpportunityLiveResult): MlbFullGameCandidateSource {
  const adapter = selectMlbDailyBestPickFromUnifiedPreprice({
    runtime: live.preprice,
    officialDate: live.preprice.date,
  });
  return Object.freeze({
    status: "READY" as const,
    sourceRunId: adapter.sourceRunId,
    sourceSchemaVersion: adapter.schemaVersion,
    evaluations: adapter.evaluations,
    opportunities: live.dailyOpportunity.rankedOpportunities,
    blockers: Object.freeze([]),
  });
}

export function earlyCandidatePoolSourceFromPayload(payload: MlbEarlyWholeSlateCandidates): MlbEarlyCandidatePoolSource {
  const partial = payload.summary.dataIncompleteGames > 0 || payload.summary.errorGames > 0;
  const blockers = payload.games.flatMap((game) =>
    game.status === "DATA_INCOMPLETE" || game.status === "ERROR"
      ? game.blockers.map((blocker) => `${game.gamePk}:${blocker}`)
      : [],
  );
  return Object.freeze({
    status: partial ? "PARTIAL" as const : "READY" as const,
    payload,
    blockers: Object.freeze(blockers),
  });
}

export function buildMlbNormalizedCandidatePool(input: {
  date: string;
  generatedAt: string;
  slate: MlbP1DailySlate;
  fullGame: MlbFullGameCandidateSource;
  early: MlbEarlyCandidatePoolSource;
}) {
  if (input.slate.date !== input.date) throw new Error("MLB_CANDIDATE_POOL_SLATE_DATE_MISMATCH");
  if (!Number.isFinite(Date.parse(input.generatedAt))) throw new Error("MLB_CANDIDATE_POOL_GENERATED_AT_INVALID");

  const fullGameCandidates = input.fullGame.evaluations.flatMap((evaluation) => {
    const candidate = normalizedFullGameCandidate({
      date: input.date,
      slate: input.slate,
      source: input.fullGame,
      evaluation,
    });
    return candidate ? [candidate] : [];
  });
  const earlyCandidates = (input.early.payload?.candidates ?? []).flatMap((candidate) => {
    const normalized = normalizedEarlyCandidate({ date: input.date, slate: input.slate, candidate });
    return normalized ? [normalized] : [];
  });
  const candidates = Object.freeze([...fullGameCandidates, ...earlyCandidates].sort(candidateSort));
  const diagnostics = crossEngineDiagnostics(candidates);

  return Object.freeze({
    schemaVersion: MLB_NORMALIZED_CANDIDATE_POOL_SCHEMA,
    date: input.date,
    generatedAt: input.generatedAt,
    candidates,
    sources: Object.freeze({
      fullGame: Object.freeze({
        status: input.fullGame.status,
        sourceRunId: input.fullGame.sourceRunId,
        candidateCount: fullGameCandidates.length,
        blockers: Object.freeze([...input.fullGame.blockers]),
        authorityScope: "FROZEN_A_PLUS_PREMIUM_READY_EVALUATIONS" as const,
      }),
      early: Object.freeze({
        status: input.early.status,
        candidateCount: earlyCandidates.length,
        blockers: Object.freeze([...input.early.blockers]),
        authorityScope: "CANONICAL_ERE_FINAL_RECOMMENDATION_AND_ALTERNATIVES" as const,
      }),
    }),
    crossEngineDiagnostics: diagnostics,
    summary: Object.freeze({
      slateGames: input.slate.games.length,
      normalizedCandidates: candidates.length,
      fullGameCandidates: fullGameCandidates.length,
      earlyCandidates: earlyCandidates.length,
      uniqueMarketIdentities: new Set(candidates.map((candidate) => candidate.marketIdentityKey)).size,
      globallyRankEligibleCandidates: candidates.filter((candidate) => candidate.globalRank.eligible).length,
      priceAttachedCandidates: candidates.filter((candidate) => candidate.pricing.status !== "UNPRICED").length,
      calibrationAttachedCandidates: candidates.filter((candidate) => candidate.calibration.status !== "NOT_ATTACHED").length,
      settlementIncompleteCandidates: candidates.filter((candidate) =>
        candidate.globalRank.blockers.includes("SETTLEMENT_MODEL_INCOMPLETE"),
      ).length,
    }),
    boundary: Object.freeze({
      phase: "NORMALIZED_SPORTING_CANDIDATE_POOL" as const,
      sourceEnginesRemainIndependent: true as const,
      fullGameHierarchyChanged: false as const,
      earlyRulesChanged: false as const,
      lowerTierFullGameNormalizationAttached: false as const,
      pricingAttached: false as const,
      noVigAttached: false as const,
      crossEngineCalibrationAttached: false as const,
      crossEngineRankPerformed: false as const,
      deterministicIdentitySortCarriesSportingWeight: false as const,
      oddsRead: false as const,
      outcomesRead: false as const,
      v68Changed: false as const,
      v80Changed: false as const,
      automaticBetPlacement: false as const,
      realFinancialExposure: 0 as const,
    }),
  });
}

export type MlbNormalizedCandidatePool = ReturnType<typeof buildMlbNormalizedCandidatePool>;
