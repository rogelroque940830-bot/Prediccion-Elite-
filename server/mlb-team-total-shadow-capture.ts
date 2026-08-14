import { createHash } from "node:crypto";
import type { MlbP1SlateGame } from "./mlb-p1-daily-slate";
import { MlbC4CertifiedMaterializer } from "./mlb-c4-certified-materializer";
import {
  buildMlbMarketOddsUniverseGame,
  type MlbCanonicalMarketAvailability,
  type MlbNormalizedBookQuote,
  type MlbReferenceConsensusQuote,
} from "./mlb-market-odds-normalizer";
import {
  MlbOddsRunBudgetController,
  type MlbOddsBudgetSnapshot,
} from "./mlb-odds-budget-controller";
import {
  MLB_SELECTIVE_ODDS_BOOKMAKERS,
  MLB_SELECTIVE_ODDS_REQUEST_TIMEOUT_MS,
  buildMlbSelectiveEventOddsUrl,
  buildMlbSelectiveEventsProbeUrl,
  matchMlbDiscoveryGameToProviderEvent,
  type MlbSelectiveOddsSharedCoordinator,
} from "./mlb-selective-odds-acquisition";
import {
  assessMlbTeamTotalLine,
  MLB_TEAM_TOTAL_COUNT_MODEL_VERSION,
  type MlbTeamTotalBetSide,
  type MlbTeamTotalLineAssessment,
  type MlbTeamTotalTeamSide,
} from "./mlb-team-total-count-model";
import {
  mlbP1M4aAmericanToDecimal,
  mlbP1M4aAmericanToImpliedProbability,
} from "./mlb-p1-economic-decision-contract";

export const MLB_TEAM_TOTAL_SHADOW_CAPTURE_SCHEMA =
  "courtedge-p0-mlb-team-total-shadow-capture.v1" as const;
export const MLB_TEAM_TOTAL_SHADOW_PROVIDER_MARKET_KEY = "team_totals" as const;
export const MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_PER_RUN = 5;
export const MLB_TEAM_TOTAL_SHADOW_RUN_TTL_MS = 24 * 60 * 60 * 1000;

export type MlbTeamTotalShadowGameStatus =
  | "CAPTURED"
  | "ALREADY_CAPTURED"
  | "EVENT_NOT_FOUND"
  | "EVENT_MATCH_AMBIGUOUS"
  | "BUDGET_DENIED"
  | "PROVIDER_FAILED"
  | "PROVIDER_ACCOUNTING_BLOCKED"
  | "TARGET_STARTED"
  | "MODEL_UNAVAILABLE";

export interface MlbTeamTotalShadowEvSide {
  side: MlbTeamTotalBetSide;
  line: number;
  oddsAmerican: number;
  impliedProbability: number;
  modelWinProbability: number;
  modelPushProbability: number;
  modelLossProbability: number;
  expectedValuePerUnit: number;
}

export interface MlbTeamTotalShadowQuoteEvaluation {
  teamSide: MlbTeamTotalTeamSide;
  quoteSource: "EXECUTION" | "REFERENCE";
  quoteBookKey: string;
  quoteBookTitle: string;
  capturedAt: string;
  providerLastUpdate: string | null;
  line: number;
  model: MlbTeamTotalLineAssessment;
  over: MlbTeamTotalShadowEvSide;
  under: MlbTeamTotalShadowEvSide;
  descriptiveMaxEvSide: MlbTeamTotalBetSide;
  descriptiveMaxEvPerUnit: number;
  positiveEvEstablishedForPromotion: false;
}

export interface MlbTeamTotalShadowGameResult {
  gamePk: number;
  officialDate: string;
  startTime: string;
  homeTeam: string;
  awayTeam: string;
  status: MlbTeamTotalShadowGameStatus;
  providerEventId: string | null;
  providerCallMade: boolean;
  providerCreditsCharged: number;
  homeMarketAvailability: MlbCanonicalMarketAvailability["availability"] | null;
  awayMarketAvailability: MlbCanonicalMarketAvailability["availability"] | null;
  home: MlbTeamTotalShadowQuoteEvaluation | null;
  away: MlbTeamTotalShadowQuoteEvaluation | null;
  blockers: string[];
}

export interface MlbTeamTotalShadowCaptureResult {
  schemaVersion: typeof MLB_TEAM_TOTAL_SHADOW_CAPTURE_SCHEMA;
  runId: string;
  date: string;
  generatedAt: string;
  modelVersion: typeof MLB_TEAM_TOTAL_COUNT_MODEL_VERSION;
  status: "NO_WORK" | "COMPLETED" | "PARTIAL" | "BLOCKED";
  games: MlbTeamTotalShadowGameResult[];
  budget: MlbOddsBudgetSnapshot | null;
  summary: {
    requestedGames: number;
    capturedGames: number;
    alreadyCapturedGames: number;
    executableHomeTeamTotals: number;
    executableAwayTeamTotals: number;
    evaluatedTeamTotals: number;
    descriptivePositiveEvSides: number;
    providerCalls: number;
    providerCreditsCharged: number;
  };
  policy: {
    explicitInvocationRequired: true;
    shadowOnly: true;
    finalPregameInputsOnly: true;
    oneProviderMarketKeyOnly: true;
    providerMarketKey: typeof MLB_TEAM_TOTAL_SHADOW_PROVIDER_MARKET_KEY;
    maxGamesPerRun: typeof MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_PER_RUN;
    firstProspectiveCapturePerGameIsCanonical: true;
    modelIsPriceIndependent: true;
    historicalTeamTotalPricesUsed: false;
    positiveEvRowsAreDiagnosticOnly: true;
    changesProductionLookupAuthorization: false;
    changesEliteCandidates: false;
    recommendsBet: false;
    calculatesStake: false;
    automaticPolling: false;
    automaticBetPlacement: false;
    realFinancialExposure: 0;
  };
}

export type MlbTeamTotalShadowRunAdmission =
  | { status: "ADMITTED" }
  | { status: "COMPLETED"; result: MlbTeamTotalShadowCaptureResult }
  | { status: "IN_PROGRESS" }
  | { status: "FINGERPRINT_MISMATCH" };

export interface MlbTeamTotalShadowStore {
  beginRun(input: {
    providerAccountScopeKey: string;
    runId: string;
    fingerprint: string;
    nowMs: number;
    expiresAtMs: number;
  }): MlbTeamTotalShadowRunAdmission | Promise<MlbTeamTotalShadowRunAdmission>;
  hasCanonicalGameCapture(providerAccountScopeKey: string, gamePk: number): boolean | Promise<boolean>;
  saveCanonicalGameCapture(input: {
    providerAccountScopeKey: string;
    runId: string;
    gamePk: number;
    capturedAt: string;
    result: MlbTeamTotalShadowGameResult;
  }): void | Promise<void>;
  completeRun(input: {
    providerAccountScopeKey: string;
    runId: string;
    fingerprint: string;
    result: MlbTeamTotalShadowCaptureResult;
  }): void | Promise<void>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MlbTeamTotalShadowCaptureServiceOptions {
  fetchFn?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  coordinator: MlbSelectiveOddsSharedCoordinator;
  store: MlbTeamTotalShadowStore;
  materializer?: MlbC4CertifiedMaterializer;
}

export interface MlbTeamTotalShadowCaptureInput {
  runId: string;
  date: string;
  games: readonly MlbP1SlateGame[];
  maxGames: number;
  providerAccountScopeKey: string;
  apiKey: string;
  maxRunCredits: number;
  reserveCredits: number;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function exactNumber(value: number): string {
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Infinity";
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
  return value.toString();
}

function planFingerprint(input: Omit<MlbTeamTotalShadowCaptureInput, "apiKey">): string {
  return createHash("sha256").update(JSON.stringify({
    version: MLB_TEAM_TOTAL_SHADOW_CAPTURE_SCHEMA,
    runId: input.runId,
    date: input.date,
    maxGames: input.maxGames,
    providerAccountScopeKey: input.providerAccountScopeKey,
    maxRunCredits: input.maxRunCredits,
    reserveCredits: input.reserveCredits,
    games: input.games.map((game) => ({
      gamePk: game.gamePk,
      officialDate: game.officialDate,
      startTime: game.startTime,
      homeTeam: game.homeTeam.name,
      awayTeam: game.awayTeam.name,
      analysisStage: game.analysisStage,
      analysisAllowed: game.analysisAllowed,
    })),
    marketKey: MLB_TEAM_TOTAL_SHADOW_PROVIDER_MARKET_KEY,
  })).digest("hex");
}

function withTimeout(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function safeJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return null; }
}

function quoteForSide(
  market: MlbCanonicalMarketAvailability,
): { source: "EXECUTION" | "REFERENCE"; quote: MlbNormalizedBookQuote | MlbReferenceConsensusQuote } | null {
  if (market.execution.status === "FRESH" && market.execution.quote) {
    return { source: "EXECUTION", quote: market.execution.quote };
  }
  if (market.reference.status === "FRESH" && market.reference.quote) {
    return { source: "REFERENCE", quote: market.reference.quote };
  }
  return null;
}

function evSide(
  side: MlbTeamTotalBetSide,
  line: number,
  oddsAmerican: number,
  model: MlbTeamTotalLineAssessment,
): MlbTeamTotalShadowEvSide {
  const settlement = side === "OVER" ? model.over : model.under;
  const decimal = mlbP1M4aAmericanToDecimal(oddsAmerican);
  const implied = mlbP1M4aAmericanToImpliedProbability(oddsAmerican);
  if (decimal == null || implied == null) throw new Error("MLB_TEAM_TOTAL_SHADOW_PRICE_INVALID");
  const ev = settlement.winProbability * (decimal - 1) - settlement.lossProbability;
  if (!Number.isFinite(ev)) throw new Error("MLB_TEAM_TOTAL_SHADOW_EV_INVALID");
  return Object.freeze({
    side,
    line,
    oddsAmerican,
    impliedProbability: implied,
    modelWinProbability: settlement.winProbability,
    modelPushProbability: settlement.pushProbability,
    modelLossProbability: settlement.lossProbability,
    expectedValuePerUnit: ev,
  });
}

function evaluateQuote(input: {
  gamePk: number;
  generatedAt: string;
  teamSide: MlbTeamTotalTeamSide;
  market: MlbCanonicalMarketAvailability;
  featureVector: Parameters<typeof assessMlbTeamTotalLine>[0]["features"];
}): MlbTeamTotalShadowQuoteEvaluation | null {
  const chosen = quoteForSide(input.market);
  if (!chosen) return null;
  const overPrice = chosen.quote.selections.find((selection) => selection.side === "OVER");
  const underPrice = chosen.quote.selections.find((selection) => selection.side === "UNDER");
  if (!overPrice || !underPrice || overPrice.line == null || underPrice.line == null || overPrice.line !== underPrice.line) {
    return null;
  }
  const line = overPrice.line;
  const model = assessMlbTeamTotalLine({
    gamePk: input.gamePk,
    generatedAt: input.generatedAt,
    teamSide: input.teamSide,
    line,
    features: input.featureVector,
  });
  const over = evSide("OVER", line, overPrice.oddsAmerican, model);
  const under = evSide("UNDER", line, underPrice.oddsAmerican, model);
  const best = over.expectedValuePerUnit >= under.expectedValuePerUnit ? over : under;
  return Object.freeze({
    teamSide: input.teamSide,
    quoteSource: chosen.source,
    quoteBookKey: chosen.quote.bookKey,
    quoteBookTitle: chosen.quote.bookTitle,
    capturedAt: chosen.quote.capturedAt,
    providerLastUpdate: chosen.quote.providerLastUpdate,
    line,
    model,
    over,
    under,
    descriptiveMaxEvSide: best.side,
    descriptiveMaxEvPerUnit: best.expectedValuePerUnit,
    positiveEvEstablishedForPromotion: false,
  });
}

function emptyGame(
  game: MlbP1SlateGame,
  status: MlbTeamTotalShadowGameStatus,
  blockers: string[],
): MlbTeamTotalShadowGameResult {
  return {
    gamePk: game.gamePk,
    officialDate: game.officialDate,
    startTime: game.startTime,
    homeTeam: game.homeTeam.name,
    awayTeam: game.awayTeam.name,
    status,
    providerEventId: null,
    providerCallMade: false,
    providerCreditsCharged: 0,
    homeMarketAvailability: null,
    awayMarketAvailability: null,
    home: null,
    away: null,
    blockers,
  };
}

function resultSummary(games: readonly MlbTeamTotalShadowGameResult[]) {
  return {
    requestedGames: games.length,
    capturedGames: games.filter((game) => game.status === "CAPTURED").length,
    alreadyCapturedGames: games.filter((game) => game.status === "ALREADY_CAPTURED").length,
    executableHomeTeamTotals: games.filter((game) => game.homeMarketAvailability === "EXECUTABLE").length,
    executableAwayTeamTotals: games.filter((game) => game.awayMarketAvailability === "EXECUTABLE").length,
    evaluatedTeamTotals: games.reduce((sum, game) => sum + Number(game.home != null) + Number(game.away != null), 0),
    descriptivePositiveEvSides: games.reduce((sum, game) =>
      sum + Number((game.home?.descriptiveMaxEvPerUnit ?? 0) > 0) + Number((game.away?.descriptiveMaxEvPerUnit ?? 0) > 0), 0),
    providerCalls: games.filter((game) => game.providerCallMade).length,
    providerCreditsCharged: games.reduce((sum, game) => sum + game.providerCreditsCharged, 0),
  };
}

function classifyRun(games: readonly MlbTeamTotalShadowGameResult[], budget: MlbOddsBudgetSnapshot | null): MlbTeamTotalShadowCaptureResult["status"] {
  if (!games.length) return "NO_WORK";
  if (budget?.status === "BLOCKED") return games.some((game) => game.status === "CAPTURED") ? "PARTIAL" : "BLOCKED";
  const blocked = games.some((game) => !["CAPTURED", "ALREADY_CAPTURED"].includes(game.status));
  return blocked ? "PARTIAL" : "COMPLETED";
}

function buildResult(input: {
  runId: string;
  date: string;
  generatedAt: string;
  games: MlbTeamTotalShadowGameResult[];
  budget: MlbOddsBudgetSnapshot | null;
}): MlbTeamTotalShadowCaptureResult {
  return Object.freeze({
    schemaVersion: MLB_TEAM_TOTAL_SHADOW_CAPTURE_SCHEMA,
    runId: input.runId,
    date: input.date,
    generatedAt: input.generatedAt,
    modelVersion: MLB_TEAM_TOTAL_COUNT_MODEL_VERSION,
    status: classifyRun(input.games, input.budget),
    games: input.games,
    budget: input.budget,
    summary: resultSummary(input.games),
    policy: Object.freeze({
      explicitInvocationRequired: true,
      shadowOnly: true,
      finalPregameInputsOnly: true,
      oneProviderMarketKeyOnly: true,
      providerMarketKey: MLB_TEAM_TOTAL_SHADOW_PROVIDER_MARKET_KEY,
      maxGamesPerRun: MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_PER_RUN,
      firstProspectiveCapturePerGameIsCanonical: true,
      modelIsPriceIndependent: true,
      historicalTeamTotalPricesUsed: false,
      positiveEvRowsAreDiagnosticOnly: true,
      changesProductionLookupAuthorization: false,
      changesEliteCandidates: false,
      recommendsBet: false,
      calculatesStake: false,
      automaticPolling: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    }),
  });
}

export class MlbTeamTotalShadowCaptureService {
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly coordinator: MlbSelectiveOddsSharedCoordinator;
  private readonly store: MlbTeamTotalShadowStore;
  private readonly materializer: MlbC4CertifiedMaterializer;

  constructor(options: MlbTeamTotalShadowCaptureServiceOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = Math.max(1_000, Math.floor(options.timeoutMs ?? MLB_SELECTIVE_ODDS_REQUEST_TIMEOUT_MS));
    this.coordinator = options.coordinator;
    this.store = options.store;
    this.materializer = options.materializer ?? new MlbC4CertifiedMaterializer();
    if (!this.coordinator || this.coordinator.coordinationScope !== "PROVIDER_ACCOUNT_SHARED") {
      throw new Error("MLB_TEAM_TOTAL_SHADOW_SHARED_COORDINATOR_REQUIRED");
    }
    if (!this.store) throw new Error("MLB_TEAM_TOTAL_SHADOW_STORE_REQUIRED");
  }

  async capture(rawInput: MlbTeamTotalShadowCaptureInput): Promise<MlbTeamTotalShadowCaptureResult> {
    const input: MlbTeamTotalShadowCaptureInput = {
      ...rawInput,
      runId: clean(rawInput.runId),
      date: clean(rawInput.date),
      providerAccountScopeKey: clean(rawInput.providerAccountScopeKey),
      apiKey: clean(rawInput.apiKey),
      games: [...rawInput.games],
    };
    if (!input.runId) throw new Error("MLB_TEAM_TOTAL_SHADOW_RUN_ID_REQUIRED");
    if (!validIsoDate(input.date)) throw new Error("MLB_TEAM_TOTAL_SHADOW_DATE_INVALID");
    if (!input.providerAccountScopeKey) throw new Error("MLB_TEAM_TOTAL_SHADOW_PROVIDER_SCOPE_REQUIRED");
    if (!input.apiKey) throw new Error("MLB_TEAM_TOTAL_SHADOW_API_KEY_REQUIRED");
    if (!Number.isInteger(input.maxGames) || input.maxGames < 1 || input.maxGames > MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_PER_RUN) {
      throw new Error("MLB_TEAM_TOTAL_SHADOW_MAX_GAMES_INVALID");
    }
    if (!Number.isInteger(input.maxRunCredits) || input.maxRunCredits < 0 || input.maxRunCredits > input.maxGames) {
      throw new Error("MLB_TEAM_TOTAL_SHADOW_MAX_CREDITS_INVALID");
    }
    if (!Number.isInteger(input.reserveCredits) || input.reserveCredits < 0) {
      throw new Error("MLB_TEAM_TOTAL_SHADOW_RESERVE_INVALID");
    }
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("MLB_TEAM_TOTAL_SHADOW_NOW_INVALID");

    const candidates = input.games
      .filter((game) => game.officialDate === input.date && game.analysisAllowed && game.analysisStage === "FINAL")
      .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) || a.gamePk - b.gamePk)
      .slice(0, input.maxGames);
    const fingerprint = planFingerprint({ ...input, apiKey: undefined as never });

    return this.coordinator.runExclusive(input.providerAccountScopeKey, async () => {
      const admission = await this.store.beginRun({
        providerAccountScopeKey: input.providerAccountScopeKey,
        runId: input.runId,
        fingerprint,
        nowMs: now.getTime(),
        expiresAtMs: now.getTime() + MLB_TEAM_TOTAL_SHADOW_RUN_TTL_MS,
      });
      if (admission.status === "COMPLETED") return admission.result;
      if (admission.status === "IN_PROGRESS") throw new Error("MLB_TEAM_TOTAL_SHADOW_RUN_ALREADY_IN_PROGRESS");
      if (admission.status === "FINGERPRINT_MISMATCH") throw new Error("MLB_TEAM_TOTAL_SHADOW_RUN_ID_REUSED_WITH_DIFFERENT_PLAN");

      const results: MlbTeamTotalShadowGameResult[] = [];
      const queryable: MlbP1SlateGame[] = [];
      for (const game of candidates) {
        if (Date.parse(game.startTime) <= now.getTime()) {
          const result = emptyGame(game, "TARGET_STARTED", ["CAPTURE_MUST_PRECEDE_GAME_START"]);
          results.push(result);
          await this.store.saveCanonicalGameCapture({
            providerAccountScopeKey: input.providerAccountScopeKey,
            runId: input.runId,
            gamePk: game.gamePk,
            capturedAt: now.toISOString(),
            result,
          });
          continue;
        }
        if (await this.store.hasCanonicalGameCapture(input.providerAccountScopeKey, game.gamePk)) {
          results.push(emptyGame(game, "ALREADY_CAPTURED", ["FIRST_PROSPECTIVE_CAPTURE_ALREADY_EXISTS"]));
          continue;
        }
        queryable.push(game);
      }

      if (!queryable.length) {
        const completed = buildResult({ runId: input.runId, date: input.date, generatedAt: now.toISOString(), games: results, budget: null });
        await this.store.completeRun({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, fingerprint, result: completed });
        return completed;
      }

      const budget = new MlbOddsRunBudgetController({
        runId: input.runId,
        maxRunCredits: input.maxRunCredits,
        reserveCredits: input.reserveCredits,
      });
      const probeResponse = await this.fetchFn(buildMlbSelectiveEventsProbeUrl(input.apiKey), { signal: withTimeout(this.timeoutMs) });
      const probePayload = await safeJson(probeResponse);
      budget.ingestZeroCostProbe(probeResponse.headers);
      if (!probeResponse.ok || !Array.isArray(probePayload) || budget.snapshot().status !== "ACTIVE") {
        const blocker = !probeResponse.ok ? `EVENTS_PROBE_HTTP_${probeResponse.status}` : "EVENTS_PROBE_OR_ACCOUNTING_INVALID";
        for (const game of queryable) {
          const result = emptyGame(game, "PROVIDER_ACCOUNTING_BLOCKED", [blocker]);
          results.push(result);
          await this.store.saveCanonicalGameCapture({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, gamePk: game.gamePk, capturedAt: now.toISOString(), result });
        }
        const completed = buildResult({ runId: input.runId, date: input.date, generatedAt: now.toISOString(), games: results, budget: budget.snapshot() });
        await this.store.completeRun({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, fingerprint, result: completed });
        return completed;
      }

      for (const game of queryable) {
        const matched = matchMlbDiscoveryGameToProviderEvent({
          officialDate: game.officialDate,
          startTime: game.startTime,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
        }, probePayload);
        if (matched.status !== "MATCHED") {
          const result = emptyGame(game, matched.status === "NOT_FOUND" ? "EVENT_NOT_FOUND" : "EVENT_MATCH_AMBIGUOUS", [`PROVIDER_EVENT_${matched.status}`]);
          results.push(result);
          await this.store.saveCanonicalGameCapture({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, gamePk: game.gamePk, capturedAt: now.toISOString(), result });
          continue;
        }

        const operationId = `${input.runId}:team_totals:${game.gamePk}`;
        const authorization = budget.authorizePaidOperation({
          operationId,
          endpoint: "EVENT_ODDS",
          marketKeys: [MLB_TEAM_TOTAL_SHADOW_PROVIDER_MARKET_KEY],
          bookmakerCount: MLB_SELECTIVE_ODDS_BOOKMAKERS.length,
        });
        if (!authorization.ok) {
          const result = emptyGame(game, "BUDGET_DENIED", [authorization.code]);
          result.providerEventId = matched.eventId;
          results.push(result);
          await this.store.saveCanonicalGameCapture({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, gamePk: game.gamePk, capturedAt: now.toISOString(), result });
          break;
        }

        const beforeCharged = budget.snapshot().runCreditsCharged;
        let response: Response;
        try {
          response = await this.fetchFn(
            buildMlbSelectiveEventOddsUrl(matched.eventId, input.apiKey, [MLB_TEAM_TOTAL_SHADOW_PROVIDER_MARKET_KEY]),
            { signal: withTimeout(this.timeoutMs) },
          );
        } catch (error: any) {
          budget.releaseUnissuedOperation(operationId);
          const result = emptyGame(game, "PROVIDER_FAILED", [String(error?.name ?? "PROVIDER_REQUEST_FAILED")]);
          result.providerEventId = matched.eventId;
          results.push(result);
          await this.store.saveCanonicalGameCapture({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, gamePk: game.gamePk, capturedAt: now.toISOString(), result });
          break;
        }
        const payload = await safeJson(response);
        budget.settlePaidOperation(operationId, response.headers);
        const charged = budget.snapshot().runCreditsCharged - beforeCharged;
        if (!response.ok || !payload || String(payload?.id ?? "").trim() !== matched.eventId) {
          const result = emptyGame(game, "PROVIDER_FAILED", [!response.ok ? `EVENT_ODDS_HTTP_${response.status}` : "PAID_EVENT_IDENTITY_MISMATCH"]);
          result.providerEventId = matched.eventId;
          result.providerCallMade = true;
          result.providerCreditsCharged = charged;
          results.push(result);
          await this.store.saveCanonicalGameCapture({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, gamePk: game.gamePk, capturedAt: now.toISOString(), result });
          if (budget.snapshot().status === "BLOCKED") break;
          continue;
        }

        const capturedAt = this.now().toISOString();
        const universe = buildMlbMarketOddsUniverseGame(payload, capturedAt);
        const homeMarket = universe.markets.find((market) => market.canonicalKey === "TEAM_TOTAL:HOME") ?? null;
        const awayMarket = universe.markets.find((market) => market.canonicalKey === "TEAM_TOTAL:AWAY") ?? null;
        let home: MlbTeamTotalShadowQuoteEvaluation | null = null;
        let away: MlbTeamTotalShadowQuoteEvaluation | null = null;
        const blockers: string[] = [];
        try {
          if (homeMarket || awayMarket) {
            const full13 = await this.materializer.assessFull13Game(game);
            if (homeMarket) home = evaluateQuote({ gamePk: game.gamePk, generatedAt: capturedAt, teamSide: "HOME", market: homeMarket, featureVector: full13.featureVector });
            if (awayMarket) away = evaluateQuote({ gamePk: game.gamePk, generatedAt: capturedAt, teamSide: "AWAY", market: awayMarket, featureVector: full13.featureVector });
          }
        } catch (error: any) {
          blockers.push(String(error?.message ?? "TEAM_TOTAL_MODEL_UNAVAILABLE"));
        }

        const result: MlbTeamTotalShadowGameResult = {
          gamePk: game.gamePk,
          officialDate: game.officialDate,
          startTime: game.startTime,
          homeTeam: game.homeTeam.name,
          awayTeam: game.awayTeam.name,
          status: blockers.length ? "MODEL_UNAVAILABLE" : "CAPTURED",
          providerEventId: matched.eventId,
          providerCallMade: true,
          providerCreditsCharged: charged,
          homeMarketAvailability: homeMarket?.availability ?? null,
          awayMarketAvailability: awayMarket?.availability ?? null,
          home,
          away,
          blockers,
        };
        results.push(result);
        await this.store.saveCanonicalGameCapture({
          providerAccountScopeKey: input.providerAccountScopeKey,
          runId: input.runId,
          gamePk: game.gamePk,
          capturedAt,
          result,
        });
        if (budget.snapshot().status === "BLOCKED") break;
      }

      const completed = buildResult({ runId: input.runId, date: input.date, generatedAt: this.now().toISOString(), games: results, budget: budget.snapshot() });
      await this.store.completeRun({ providerAccountScopeKey: input.providerAccountScopeKey, runId: input.runId, fingerprint, result: completed });
      return completed;
    });
  }
}
