import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MlbLedgerStore, MlbPredictionInput } from "./mlb-ledger-store";
import { americanToProbability } from "./mlb-ledger-store";
import { normalizeStandardAmericanOdds } from "./american-odds";
import {
  appendOwnedPrediction,
  ownedRecordsForUser,
  type MlbLedgerOwnershipStore,
} from "./mlb-ledger-ownership-store";
import { findMlbSupersedesId } from "./mlb-scientific-snapshot";

export const MLB_S5C_INGESTION_VERSION = "mlb-s5c-shadow-ingestion.v1" as const;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const COMPLETE_LINEUP_SIZE = 9;

type AnalysisStage = "PROVISIONAL" | "FINAL";
type DecisionSignal = "BET_FUERTE" | "BET" | "LEAN" | "PASS";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type S5cOptions = {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  ownerUserId: number;
  root?: string;
  selfBaseUrl?: string;
  deploymentCommit?: string;
  environment?: string;
  now?: () => Date;
  fetcher?: FetchLike;
};

type PricedDecision = {
  market: "F5_ML" | "F5_TOTAL";
  selection: string;
  line?: number;
  oddsAmerican: number;
  modelProbability: number;
  signal: DecisionSignal;
  confidenceLabel: string;
  reason: string;
  book: string;
  capturedAt?: string;
  providerLastUpdate?: string;
  consensusMethod?: string;
  provenance?: unknown;
};

type UnpricedDecision = {
  market: string;
  side: string;
  reason: string;
};

export type S5cRunSummary = {
  schemaVersion: typeof MLB_S5C_INGESTION_VERSION;
  ranAt: string;
  trigger: string;
  gameDate: string;
  gamesDiscovered: number;
  gamesEligible: number;
  gamesAnalyzed: number;
  pricedDecisions: number;
  unpricedDecisions: number;
  recordsCreated: number;
  idempotentSkips: number;
  skippedGames: number;
  errors: string[];
  unpriced: UnpricedDecision[];
  safety: {
    mode: "SHADOW";
    realFinancialExposure: 0;
    sportsbookIntegration: false;
    automaticBetPlacement: false;
    productionWrites: false;
    formulasChanged: false;
    thresholdsChanged: false;
    stakePolicyChanged: false;
  };
};

export type S5cStatus = {
  schemaVersion: typeof MLB_S5C_INGESTION_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  ownerUserId: number;
  root: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  latest: S5cRunSummary | null;
};

function positiveInteger(value: unknown, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function defaultRoot(): string {
  const configured = process.env.MLB_S5C_INGESTION_DIR?.trim();
  if (configured) return configured;
  const dataRoot = process.env.COURTEDGE_DATA_ROOT?.trim()
    || (process.env.RAILWAY_ENVIRONMENT_NAME ? "/app/data" : path.join(process.cwd(), "data"));
  return path.join(dataRoot, "mlb-s5c-shadow-ingestion");
}

function defaultEnabled(): boolean {
  const configured = process.env.MLB_S5C_AUTO_CAPTURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function floridaDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizedTeam(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function teamsMatch(left: unknown, right: unknown): boolean {
  const a = normalizedTeam(left);
  const b = normalizedTeam(right);
  return Boolean(a && b && (a === b || (Math.min(a.length, b.length) >= 6 && (a.endsWith(b) || b.endsWith(a)))));
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validAmericanOdds(value: unknown): number | null {
  return normalizeStandardAmericanOdds(value);
}

function validIso(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function priceMetadata(odds: any, market: "F5_ML" | "F5_TOTAL") {
  const marketSnapshot = market === "F5_ML" ? odds?.f5Ml : odds?.f5Total;
  return {
    capturedAt: validIso(marketSnapshot?.capturedAt) ?? validIso(odds?.capturedAt),
    providerLastUpdate: validIso(odds?.providerLastUpdate) ?? validIso(odds?.provenance?.providerLastUpdate),
    consensusMethod: String(marketSnapshot?.consensusMethod ?? odds?.consensusMethod ?? odds?.provenance?.consensusMethod ?? "").trim() || undefined,
    provenance: odds?.provenance ?? null,
  };
}

function clampProbability(value: unknown): number | null {
  const parsed = finite(value);
  if (parsed == null) return null;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return normalized > 0 && normalized < 1 ? Math.min(0.999, Math.max(0.001, normalized)) : null;
}

function semanticHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function fetchJson(fetcher: FetchLike, url: string, init?: RequestInit): Promise<any> {
  const response = await fetcher(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(120_000),
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${url} returned non-JSON content`);
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${payload?.error || payload?.message || "request failed"}`);
  return payload;
}

async function safeJson(fetcher: FetchLike, url: string): Promise<any | null> {
  try {
    return await fetchJson(fetcher, url);
  } catch {
    return null;
  }
}

function scheduleGames(payload: any): any[] {
  return (Array.isArray(payload?.dates) ? payload.dates : [])
    .flatMap((entry: any) => Array.isArray(entry?.games) ? entry.games : []);
}

function isPregame(game: any, nowMs: number): boolean {
  const commenceMs = Date.parse(String(game?.gameDate ?? ""));
  const abstract = String(game?.status?.abstractGameState ?? "").toLowerCase();
  const detailed = String(game?.status?.detailedState ?? "").toLowerCase();
  if (!Number.isFinite(commenceMs) || commenceMs <= nowMs + 60_000) return false;
  if (abstract && abstract !== "preview") return false;
  return !/(postponed|cancelled|canceled|suspended|final|game over)/i.test(detailed);
}

function extractWeather(game: any, feed: any): { tempF?: number; windMph?: number; windDirOut?: boolean } {
  const weather = feed?.gameData?.weather ?? game?.weather ?? {};
  const tempF = finite(String(weather?.temp ?? "").match(/-?\d+(?:\.\d+)?/)?.[0]);
  const windText = String(weather?.wind ?? "");
  const windMph = finite(windText.match(/\d+(?:\.\d+)?/)?.[0]);
  const windDirOut = /out to|toward|to center|to left|to right/i.test(windText) && !/in from/i.test(windText);
  return {
    ...(tempF != null ? { tempF } : {}),
    ...(windMph != null ? { windMph } : {}),
    ...(windText ? { windDirOut } : {}),
  };
}

function pitcher(feed: any, game: any, side: "home" | "away") {
  const probable = feed?.gameData?.probablePitchers?.[side] ?? game?.teams?.[side]?.probablePitcher;
  const id = finite(probable?.id);
  const player = id != null ? feed?.gameData?.players?.[`ID${id}`] : null;
  const hand = String(player?.pitchHand?.code ?? probable?.pitchHand?.code ?? "").toUpperCase();
  return {
    id: id != null ? Math.trunc(id) : null,
    name: String(player?.fullName ?? probable?.fullName ?? "").trim(),
    hand: hand === "L" || hand === "R" ? hand as "L" | "R" : undefined,
  };
}

function gameContext(gameDate: string, game: any, feed: any) {
  const gamePk = Math.trunc(Number(game?.gamePk ?? feed?.gamePk));
  const commenceTime = String(feed?.gameData?.datetime?.dateTime ?? game?.gameDate ?? "");
  const homeTeam = feed?.gameData?.teams?.home ?? game?.teams?.home?.team ?? {};
  const awayTeam = feed?.gameData?.teams?.away ?? game?.teams?.away?.team ?? {};
  const homeOrder = feed?.liveData?.boxscore?.teams?.home?.battingOrder ?? [];
  const awayOrder = feed?.liveData?.boxscore?.teams?.away?.battingOrder ?? [];
  const stage: AnalysisStage = Array.isArray(homeOrder)
    && homeOrder.length >= COMPLETE_LINEUP_SIZE
    && Array.isArray(awayOrder)
    && awayOrder.length >= COMPLETE_LINEUP_SIZE
    ? "FINAL"
    : "PROVISIONAL";
  return {
    gamePk,
    gameDate,
    commenceTime,
    venue: String(feed?.gameData?.venue?.name ?? game?.venue?.name ?? "").trim() || undefined,
    home: { id: Math.trunc(Number(homeTeam?.id)), name: String(homeTeam?.name ?? "").trim() },
    away: { id: Math.trunc(Number(awayTeam?.id)), name: String(awayTeam?.name ?? "").trim() },
    homePitcher: pitcher(feed, game, "home"),
    awayPitcher: pitcher(feed, game, "away"),
    stage,
    lineupCounts: { home: Array.isArray(homeOrder) ? homeOrder.length : 0, away: Array.isArray(awayOrder) ? awayOrder.length : 0 },
    weather: extractWeather(game, feed),
  };
}

function matchF5Odds(games: any[], context: ReturnType<typeof gameContext>): any | null {
  const candidates = games.filter((candidate) => teamsMatch(candidate?.homeTeam, context.home.name) && teamsMatch(candidate?.awayTeam, context.away.name));
  if (!candidates.length) return null;
  const commenceMs = Date.parse(context.commenceTime);
  return candidates.sort((left, right) => {
    const leftDiff = Math.abs(Date.parse(String(left?.commence ?? "")) - commenceMs);
    const rightDiff = Math.abs(Date.parse(String(right?.commence ?? "")) - commenceMs);
    return leftDiff - rightDiff;
  })[0] ?? null;
}

function pickProbability(markets: any, market: string, side: string): number | null {
  if (market === "F5_ML") return clampProbability(side === "HOME" ? markets?.f5ProbHome : markets?.f5ProbAway);
  if (market === "F5_TOTAL") return clampProbability(side === "OVER" ? markets?.f5OverProb : markets?.f5UnderProb);
  if (market === "INNING_1_ML") return clampProbability(side === "HOME" ? markets?.inning1?.homeProb : markets?.inning1?.awayProb);
  if (market === "TT_OVER_15_F5") return clampProbability(side === "HOME" ? markets?.teamTotalOver15F5?.homeProb : markets?.teamTotalOver15F5?.awayProb);
  if (market === "TT_UNDER_25_F5") return clampProbability(side === "HOME" ? markets?.teamTotalUnder25F5?.homeProb : markets?.teamTotalUnder25F5?.awayProb);
  if (market === "NRFI") return clampProbability(markets?.probNoRun1stInn);
  if (market === "YRFI") return clampProbability(markets?.probAnyRun1stInn);
  return null;
}

function recommendationMatch(markets: any, market: string, side: string): { matched: boolean; premium: boolean; reason: string } {
  const final = markets?.finalRecommendation ?? {};
  if (final?.action === "BET" && final?.market === market && final?.side === side) {
    return { matched: true, premium: final?.isPremium === true, reason: String(final?.reason ?? "Final recommendation") };
  }
  const alternative = (Array.isArray(markets?.alternativePicks) ? markets.alternativePicks : [])
    .find((candidate: any) => candidate?.market === market && candidate?.side === side);
  if (alternative) {
    return { matched: true, premium: alternative?.isPremium === true, reason: String(alternative?.reason ?? "Alternative recommendation") };
  }
  return { matched: false, premium: false, reason: String(final?.reason ?? "Directional model observation") };
}

function laneSignal(markets: any, market: string, side: string): { signal: DecisionSignal; label: string; reason: string } {
  const match = recommendationMatch(markets, market, side);
  if (match.matched) {
    return { signal: match.premium ? "BET_FUERTE" : "BET", label: match.premium ? "PREMIUM" : String(markets?.confidence ?? "MODEL"), reason: match.reason };
  }
  const finalReason = String(markets?.finalRecommendation?.reason ?? "");
  const blocked = market === "F5_ML" && /F5 ML bloqueado/i.test(finalReason)
    || market === "INNING_1_ML" && /(I1 ML bloqueado|INNING_1_ML)/i.test(finalReason);
  if (blocked) return { signal: "PASS", label: "BLOCKED", reason: finalReason };
  return { signal: "LEAN", label: String(markets?.confidence ?? "MODEL"), reason: `Directional lane not selected as the final priced recommendation. ${finalReason}`.trim() };
}

function buildDecisionLanes(context: ReturnType<typeof gameContext>, odds: any, markets: any): { priced: PricedDecision[]; unpriced: UnpricedDecision[] } {
  const priced: PricedDecision[] = [];
  const unpriced: UnpricedDecision[] = [];
  const book = String(odds?.source ?? "F5 consensus").trim() || "F5 consensus";

  const f5Side = String(markets?.f5RecommendedSide ?? "PASS");
  if (f5Side === "HOME" || f5Side === "AWAY") {
    const rawOdds = f5Side === "HOME" ? odds?.f5Ml?.home : odds?.f5Ml?.away;
    const oddsAmerican = validAmericanOdds(rawOdds);
    const probability = pickProbability(markets, "F5_ML", f5Side);
    if (oddsAmerican != null && probability != null) {
      const signal = laneSignal(markets, "F5_ML", f5Side);
      const metadata = priceMetadata(odds, "F5_ML");
      priced.push({
        market: "F5_ML",
        selection: f5Side === "HOME" ? context.home.name : context.away.name,
        oddsAmerican,
        modelProbability: probability,
        signal: signal.signal,
        confidenceLabel: signal.label,
        reason: signal.reason,
        book,
        ...metadata,
      });
    } else {
      const invalid = finite(rawOdds);
      unpriced.push({
        market: "F5_ML",
        side: f5Side,
        reason: invalid != null && oddsAmerican == null
          ? `Rejected invalid American odds ${invalid}; standard prices must be <= -100 or >= +100.`
          : "Verified F5 moneyline price unavailable",
      });
    }
  }

  const totalSide = String(markets?.f5TotalSide ?? "PASS");
  const totalLine = finite(odds?.f5Total?.line);
  if ((totalSide === "OVER" || totalSide === "UNDER") && totalLine != null) {
    const rawOdds = totalSide === "OVER" ? odds?.f5Total?.overOdds : odds?.f5Total?.underOdds;
    const oddsAmerican = validAmericanOdds(rawOdds);
    const probability = pickProbability(markets, "F5_TOTAL", totalSide);
    if (oddsAmerican != null && probability != null) {
      const signal = laneSignal(markets, "F5_TOTAL", totalSide);
      const metadata = priceMetadata(odds, "F5_TOTAL");
      priced.push({
        market: "F5_TOTAL",
        selection: `${totalSide} ${totalLine}`,
        line: totalLine,
        oddsAmerican,
        modelProbability: probability,
        signal: signal.signal,
        confidenceLabel: signal.label,
        reason: signal.reason,
        book,
        ...metadata,
      });
    } else {
      const invalid = finite(rawOdds);
      unpriced.push({
        market: "F5_TOTAL",
        side: totalSide,
        reason: invalid != null && oddsAmerican == null
          ? `Rejected invalid American odds ${invalid}; standard prices must be <= -100 or >= +100.`
          : "Verified F5 total price unavailable",
      });
    }
  }

  const unpricedLanes: Array<[string, string]> = [
    ["INNING_1_ML", String(markets?.inning1?.side ?? "PASS")],
    ["TT_OVER_15_F5", String(markets?.teamTotalOver15F5?.side ?? "PASS")],
    ["TT_UNDER_25_F5", String(markets?.teamTotalUnder25F5?.side ?? "PASS")],
    [String(markets?.nrfiYrfiRec ?? "PASS"), String(markets?.nrfiYrfiRec ?? "PASS")],
  ];
  for (const [market, side] of unpricedLanes) {
    if (side === "PASS") continue;
    unpriced.push({ market, side, reason: "Model decision retained as unpriced evidence; no verified market quote was available and no synthetic odds were created." });
  }

  return { priced, unpriced };
}

function stableRecordFingerprint(record: any): string | null {
  const prediction = record?.prediction;
  if (!prediction) return null;
  return semanticHash({
    schemaVersion: MLB_S5C_INGESTION_VERSION,
    gamePk: prediction.game?.gamePk,
    gameDate: prediction.game?.gameDate,
    stage: prediction.analysisStage,
    market: prediction.market?.type,
    selection: prediction.market?.selection,
    line: prediction.market?.line ?? null,
    oddsAmerican: prediction.market?.oddsAmerican,
    modelProbability: prediction.probabilities?.model,
    signal: prediction.decision?.signal,
    confidenceLabel: prediction.decision?.confidenceLabel,
    reason: prediction.decision?.rationale,
    consensusMethod: prediction.payload?.analysis?.layers?.marketPriceIntegrity?.consensusMethod ?? null,
  });
}

export class MlbS5cShadowIngestionService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly ownerUserId: number;
  private readonly root: string;
  private readonly selfBaseUrl: string;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private readonly fetcher: FetchLike;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly store: MlbLedgerStore,
    private readonly ownershipStore: MlbLedgerOwnershipStore,
    options: S5cOptions,
  ) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs
      ?? positiveInteger(process.env.MLB_S5C_INTERVAL_MS, DEFAULT_INTERVAL_MS, DEFAULT_INTERVAL_MS);
    this.initialDelayMs = options.initialDelayMs
      ?? positiveInteger(process.env.MLB_S5C_INITIAL_DELAY_MS, 60_000, 10_000);
    this.ownerUserId = options.ownerUserId;
    this.root = options.root ?? defaultRoot();
    this.selfBaseUrl = (options.selfBaseUrl ?? `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");
    this.deploymentCommit = options.deploymentCommit
      ?? process.env.RAILWAY_GIT_COMMIT_SHA
      ?? process.env.GIT_COMMIT_SHA
      ?? "unknown";
    this.environment = options.environment
      ?? process.env.RAILWAY_ENVIRONMENT_NAME
      ?? process.env.NODE_ENV
      ?? "unknown";
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetcher ?? fetch;
    const latest = this.readLatest();
    this.lastSuccessAt = latest?.ranAt ?? null;
  }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readLatest(): S5cRunSummary | null { return readJson<S5cRunSummary>(path.join(this.root, "latest.json")); }

  status(): S5cStatus {
    return {
      schemaVersion: MLB_S5C_INGESTION_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      ownerUserId: this.ownerUserId,
      root: this.root,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      latest: this.readLatest(),
    };
  }

  async run(trigger = "scheduled"): Promise<S5cRunSummary> {
    const now = this.now();
    const ranAt = now.toISOString();
    const gameDate = floridaDate(now);
    this.lastRunAt = ranAt;
    const summary: S5cRunSummary = {
      schemaVersion: MLB_S5C_INGESTION_VERSION,
      ranAt,
      trigger,
      gameDate,
      gamesDiscovered: 0,
      gamesEligible: 0,
      gamesAnalyzed: 0,
      pricedDecisions: 0,
      unpricedDecisions: 0,
      recordsCreated: 0,
      idempotentSkips: 0,
      skippedGames: 0,
      errors: [],
      unpriced: [],
      safety: {
        mode: "SHADOW",
        realFinancialExposure: 0,
        sportsbookIntegration: false,
        automaticBetPlacement: false,
        productionWrites: false,
        formulasChanged: false,
        thresholdsChanged: false,
        stakePolicyChanged: false,
      },
    };

    try {
      const [schedule, oddsPayload] = await Promise.all([
        fetchJson(this.fetcher, `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(gameDate)}&hydrate=team,probablePitcher,venue,weather`),
        fetchJson(this.fetcher, `${this.selfBaseUrl}/api/odds/mlb/f5?date=${encodeURIComponent(gameDate)}`),
      ]);
      const games = scheduleGames(schedule);
      const oddsGames = Array.isArray(oddsPayload?.games) ? oddsPayload.games : [];
      summary.gamesDiscovered = games.length;

      for (const game of games) {
        if (!isPregame(game, now.getTime())) {
          summary.skippedGames += 1;
          continue;
        }
        summary.gamesEligible += 1;
        try {
          const gamePk = Math.trunc(Number(game?.gamePk));
          const feed = await fetchJson(this.fetcher, `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
          const context = gameContext(gameDate, game, feed);
          if (!context.gamePk || !context.home.id || !context.away.id || !context.homePitcher.id || !context.awayPitcher.id) {
            summary.skippedGames += 1;
            summary.errors.push(`game ${gamePk || "unknown"}: missing team or probable pitcher identity`);
            continue;
          }
          if (Date.parse(context.commenceTime) <= now.getTime() + 60_000) {
            summary.skippedGames += 1;
            continue;
          }
          const odds = matchF5Odds(oddsGames, context);
          if (!odds) {
            summary.skippedGames += 1;
            summary.errors.push(`game ${context.gamePk}: no verified F5 odds match`);
            continue;
          }

          const [recentPayload, umpirePayload] = await Promise.all([
            safeJson(this.fetcher, `${this.selfBaseUrl}/api/mlb/pitcher-recent/${context.gamePk}`),
            safeJson(this.fetcher, `${this.selfBaseUrl}/api/mlb/umpire/${context.gamePk}`),
          ]);
          const recent = recentPayload?.data ?? recentPayload ?? {};
          const umpire = umpirePayload?.data ?? umpirePayload ?? undefined;
          const requestBody = {
            gameDate,
            home: {
              teamId: context.home.id,
              teamName: context.home.name,
              gamePk: context.gamePk,
              opposingPitcherId: context.awayPitcher.id,
              opposingPitcherHand: context.awayPitcher.hand,
              venue: context.venue,
              ...context.weather,
            },
            away: {
              teamId: context.away.id,
              teamName: context.away.name,
              gamePk: context.gamePk,
              opposingPitcherId: context.homePitcher.id,
              opposingPitcherHand: context.homePitcher.hand,
              venue: context.venue,
              ...context.weather,
            },
            lines: {
              f5OverLine: finite(odds?.f5Total?.line) ?? undefined,
              f5OverOdds: validAmericanOdds(odds?.f5Total?.overOdds) ?? undefined,
              f5UnderOdds: validAmericanOdds(odds?.f5Total?.underOdds) ?? undefined,
              f5HomeMlOdds: validAmericanOdds(odds?.f5Ml?.home) ?? undefined,
              f5AwayMlOdds: validAmericanOdds(odds?.f5Ml?.away) ?? undefined,
            },
            homePitcherForm: recent?.home ?? recent?.homePitcher ?? recent?.homeForm,
            awayPitcherForm: recent?.away ?? recent?.awayPitcher ?? recent?.awayForm,
            umpire,
          };
          const analysisPayload = await fetchJson(this.fetcher, `${this.selfBaseUrl}/api/mlb/early-markets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
          });
          const data = analysisPayload?.data ?? {};
          const markets = data?.markets ?? {};
          const lanes = buildDecisionLanes(context, odds, markets);
          summary.gamesAnalyzed += 1;
          summary.pricedDecisions += lanes.priced.length;
          summary.unpricedDecisions += lanes.unpriced.length;
          summary.unpriced.push(...lanes.unpriced.map((entry) => ({ ...entry, reason: `gamePk=${context.gamePk}: ${entry.reason}` })));

          for (const lane of lanes.priced) {
            const semantic = {
              schemaVersion: MLB_S5C_INGESTION_VERSION,
              gamePk: context.gamePk,
              gameDate,
              stage: context.stage,
              market: lane.market,
              selection: lane.selection,
              line: lane.line ?? null,
              oddsAmerican: lane.oddsAmerican,
              modelProbability: lane.modelProbability,
              signal: lane.signal,
              confidenceLabel: lane.confidenceLabel,
              reason: lane.reason,
              consensusMethod: lane.consensusMethod ?? null,
            };
            const fingerprint = semanticHash(semantic);
            const owned = ownedRecordsForUser(this.store, this.ownershipStore, this.ownerUserId, {
              from: gameDate,
              to: gameDate,
              limit: 10_000,
            });
            if (owned.some((record) => stableRecordFingerprint(record) === fingerprint)) {
              summary.idempotentSkips += 1;
              continue;
            }
            const priceCapturedAt = lane.capturedAt ?? ranAt;
            const prediction: MlbPredictionInput = {
              schemaVersion: "mlb-ledger.v1",
              clientRequestId: `s5c:${context.gamePk}:${context.stage.toLowerCase()}:${lane.market.toLowerCase()}:${fingerprint.slice(0, 32)}`,
              source: "app",
              model: {
                name: "CourtEdge MLB Early Markets",
                version: "s5c-shadow-v2-price-integrity",
                gitCommit: this.deploymentCommit,
                environment: this.environment,
              },
              game: {
                gamePk: context.gamePk,
                gameDate,
                commenceTime: context.commenceTime,
                homeTeam: context.home.name,
                awayTeam: context.away.name,
                venue: context.venue,
              },
              market: {
                type: lane.market,
                selection: lane.selection,
                ...(lane.line != null ? { line: lane.line } : {}),
                oddsAmerican: lane.oddsAmerican,
                book: lane.book,
                capturedAt: priceCapturedAt,
              },
              probabilities: {
                model: lane.modelProbability,
                marketImplied: americanToProbability(lane.oddsAmerican),
                edgePp: (lane.modelProbability - americanToProbability(lane.oddsAmerican)) * 100,
              },
              decision: {
                signal: lane.signal,
                confidenceLabel: lane.confidenceLabel,
                confidencePct: lane.modelProbability * 100,
                stakeUnits: 0,
                rationale: lane.reason,
              },
              analysis: {
                stage: context.stage,
                warnings: [
                  ...(Array.isArray(markets?.warnings) ? markets.warnings.map(String) : []),
                  ...(context.stage === "PROVISIONAL" ? ["Lineups are not yet confirmed; this snapshot must be superseded by a FINAL snapshot when both official batting orders are available."] : []),
                  ...(!lane.capturedAt ? ["The odds response did not expose an original capture timestamp; the ingestion run time was used as a fallback."] : []),
                ],
                factors: [
                  { name: "HOME_ERE", direction: "HOME", magnitude: finite(data?.homeEre?.ereScore) ?? undefined, units: "score", confidence: String(data?.homeEre?.dataStatus ?? "UNKNOWN") === "VERIFIED" ? "FULL" : "PARTIAL", source: "CourtEdge ERE" },
                  { name: "AWAY_ERE", direction: "AWAY", magnitude: finite(data?.awayEre?.ereScore) ?? undefined, units: "score", confidence: String(data?.awayEre?.dataStatus ?? "UNKNOWN") === "VERIFIED" ? "FULL" : "PARTIAL", source: "CourtEdge ERE" },
                ],
                sources: [
                  { name: "MLB Stats official schedule/feed", status: context.stage === "FINAL" ? "VERIFIED" : "PARTIAL", fetchedAt: ranAt, metadata: { gamePk: context.gamePk, lineupCounts: context.lineupCounts } },
                  {
                    name: lane.book,
                    status: "VERIFIED",
                    fetchedAt: priceCapturedAt,
                    asOf: lane.providerLastUpdate,
                    metadata: {
                      market: lane.market,
                      oddsAmerican: lane.oddsAmerican,
                      consensusMethod: lane.consensusMethod ?? null,
                    },
                  },
                  { name: "CourtEdge /api/mlb/early-markets", status: "VERIFIED", fetchedAt: ranAt },
                ],
                layers: {
                  f5Unified: data?.f5Unified ?? null,
                  uncertainty: data?.uncertainty ?? null,
                  marketPriceIntegrity: {
                    capturedAt: priceCapturedAt,
                    providerLastUpdate: lane.providerLastUpdate ?? null,
                    consensusMethod: lane.consensusMethod ?? null,
                    standardAmericanOddsValidated: true,
                  },
                  s5c: {
                    schemaVersion: MLB_S5C_INGESTION_VERSION,
                    semanticFingerprint: fingerprint,
                    trigger,
                    stage: context.stage,
                    lineupCounts: context.lineupCounts,
                    realFinancialExposure: 0,
                    sportsbookIntegration: false,
                    automaticBetPlacement: false,
                  },
                },
                rawInputs: {
                  game: context,
                  lines: requestBody.lines,
                  priceCapture: {
                    capturedAt: priceCapturedAt,
                    providerLastUpdate: lane.providerLastUpdate ?? null,
                    consensusMethod: lane.consensusMethod ?? null,
                    book: lane.book,
                  },
                  marketProvenance: lane.provenance ?? null,
                  pitcherRecentAvailable: Boolean(recentPayload),
                  umpireAvailable: Boolean(umpirePayload),
                },
                rawOutput: {
                  markets,
                  selectedLane: lane,
                },
              },
            };
            const supersedesId = findMlbSupersedesId(owned, prediction);
            const result = appendOwnedPrediction(
              this.store,
              this.ownershipStore,
              supersedesId ? { ...prediction, supersedesId } : prediction,
              this.ownerUserId,
              "service",
            );
            if (result.idempotent) summary.idempotentSkips += 1;
            else summary.recordsCreated += 1;
          }
        } catch (error) {
          summary.errors.push(`game ${game?.gamePk ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      atomicWriteJson(path.join(this.root, "latest.json"), summary);
      this.lastSuccessAt = ranAt;
      this.lastError = null;
      return summary;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      summary.errors.push(this.lastError);
      atomicWriteJson(path.join(this.root, "latest.json"), summary);
      throw error;
    }
  }
}

export function startMlbS5cShadowIngestionWorker(
  store: MlbLedgerStore,
  ownershipStore: MlbLedgerOwnershipStore,
  options: S5cOptions,
): { service: MlbS5cShadowIngestionService; timer: NodeJS.Timeout | null } {
  const service = new MlbS5cShadowIngestionService(store, ownershipStore, options);
  if (!service.isEnabled()) return { service, timer: null };
  const run = () => {
    service.run("scheduled").catch((error) => console.error("[s5c] MLB shadow ingestion failed", error));
  };
  const initial = setTimeout(run, service.getInitialDelayMs());
  initial.unref();
  const timer = setInterval(run, service.getIntervalMs());
  timer.unref();
  return { service, timer };
}
