import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const WNBA_SHADOW_SCHEMA_VERSION = "wnba-shadow.v1" as const;
export const WNBA_SHADOW_REPORT_VERSION = "wnba-shadow-report.v1" as const;

export type WnbaShadowStage = "PROVISIONAL" | "FINAL";
export type FetchLike = typeof fetch;

export interface WnbaShadowRecord {
  schemaVersion: typeof WNBA_SHADOW_SCHEMA_VERSION;
  id: string;
  fingerprint: string;
  recordedAt: string;
  recordedAtMs: number;
  supersedesId: string | null;
  game: {
    gameId: string;
    gameDate: string;
    commenceTime: string;
    homeTeam: string;
    awayTeam: string;
  };
  market: {
    type: "MONEYLINE";
    book: string;
    capturedAt: string;
    homeOddsAmerican: number;
    awayOddsAmerican: number;
    homeRawImpliedProbability: number;
    awayRawImpliedProbability: number;
    homeDevigProbability: number;
    awayDevigProbability: number;
  };
  baseline: {
    name: "WNBA_MARKET_BASELINE";
    version: "v1";
    homeWinProbability: number;
    awayWinProbability: number;
    edgePp: 0;
  };
  decision: {
    signal: "OBSERVE";
    stakeUnits: 0;
  };
  analysisStage: WnbaShadowStage;
  context: {
    home: Record<string, unknown>;
    away: Record<string, unknown>;
    sources: Record<string, string>;
    degradedSources: string[];
  };
  dataQuality: {
    checks: number;
    passed: number;
    coveragePct: number;
    missing: string[];
  };
  safety: WnbaShadowSafety;
}

export interface WnbaShadowSettlement {
  schemaVersion: "wnba-shadow-settlement.v1";
  id: string;
  predictionId: string;
  gameId: string;
  settledAt: string;
  homeScore: number;
  awayScore: number;
  homeOutcome: 0 | 1;
  result: "HOME_WIN" | "AWAY_WIN";
  brierScore: number;
  logLoss: number;
}

export interface WnbaShadowSafety {
  mode: "SHADOW_MARKET_BASELINE";
  predictionsCreated: 0;
  recommendedStakeUnits: 0;
  realFinancialExposure: 0;
  sportsbookIntegration: false;
  automaticBetPlacement: false;
  productionWrites: false;
  automaticPromotion: false;
  predictorFormulasChanged: false;
  predictorFiltersChanged: false;
  predictorMarketsChanged: false;
  predictorThresholdsChanged: false;
  stakePolicyChanged: false;
}

export interface WnbaShadowRunAudit {
  schemaVersion: "wnba-shadow-run.v1";
  ranAt: string;
  trigger: string;
  gameDate: string;
  deploymentCommit: string;
  environment: string;
  discoveredGames: number;
  pricedGames: number;
  recordsCreated: number;
  idempotentRecords: number;
  provisionalCreated: number;
  finalCreated: number;
  skippedStarted: number;
  unmatchedOdds: number;
  missingMoneyline: number;
  settlementsCreated: number;
  errors: string[];
  report: WnbaShadowReport;
  safety: WnbaShadowSafety;
}

export interface WnbaShadowReport {
  schemaVersion: typeof WNBA_SHADOW_REPORT_VERSION;
  generatedAt: string;
  records: number;
  terminalGames: number;
  trackedGames: number;
  officialFinalGames: number;
  awaitingOfficialFinal: number;
  supersededRecords: number;
  provisionalTerminal: number;
  finalTerminal: number;
  finalCoveragePct: number;
  settled: number;
  pending: number;
  settlementCoveragePct: number;
  marketCoveragePct: number;
  averageDataQualityPct: number | null;
  degradedSourceTerminalRecords: number;
  averageBrierScore: number | null;
  averageLogLoss: number | null;
  favoriteAccuracyPct: number | null;
  safety: WnbaShadowSafety;
}

export interface WnbaShadowStatus {
  schemaVersion: typeof WNBA_SHADOW_SCHEMA_VERSION;
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  finalWindowMinutes: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  records: number;
  settlements: number;
  latest: WnbaShadowRunAudit | null;
  report: WnbaShadowReport;
}

interface ServiceOptions {
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  finalWindowMinutes?: number;
  settlementLookbackDays?: number;
  root?: string;
  selfBaseUrl?: string;
  deploymentCommit?: string;
  environment?: string;
  now?: () => Date;
  fetcher?: FetchLike;
}

interface ScheduleGame {
  gameId: string;
  gameTimeUTC: string;
  homeTeam: { id?: number | string; name: string; tricode?: string };
  awayTeam: { id?: number | string; name: string; tricode?: string };
}

interface OddsGame {
  gameKey?: string;
  homeTeam: string;
  awayTeam: string;
  commence: string;
  source?: string;
  ml?: { home?: number; away?: number };
}

interface FinalGame {
  gameId: string;
  gameDate: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
}

const SAFETY: WnbaShadowSafety = {
  mode: "SHADOW_MARKET_BASELINE",
  predictionsCreated: 0,
  recommendedStakeUnits: 0,
  realFinancialExposure: 0,
  sportsbookIntegration: false,
  automaticBetPlacement: false,
  productionWrites: false,
  automaticPromotion: false,
  predictorFormulasChanged: false,
  predictorFiltersChanged: false,
  predictorMarketsChanged: false,
  predictorThresholdsChanged: false,
  stakePolicyChanged: false,
};

function positiveInteger(raw: unknown, fallback: number, minimum = 1): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
}

function defaultEnabled(): boolean {
  if (process.env.WNBA_S6C_SHADOW_ENABLED === "true") return true;
  if (process.env.WNBA_S6C_SHADOW_ENABLED === "false") return false;
  return process.env.RAILWAY_ENVIRONMENT_NAME === "p0-integration";
}

function defaultRoot(): string {
  return process.env.WNBA_S6C_SHADOW_ROOT
    ? path.resolve(process.env.WNBA_S6C_SHADOW_ROOT)
    : path.join(process.cwd(), "data", "wnba-shadow-v1");
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function floridaDate(date: Date, offsetDays = 0): string {
  const shifted = new Date(date.getTime() + offsetDays * 86_400_000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function ensureDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function atomicJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readJsonLines<T>(filePath: string): T[] {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function appendJsonLine(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const TEAM_ALIASES: Record<string, string> = {
  "la sparks": "los angeles sparks",
  "ny liberty": "new york liberty",
  "lv aces": "las vegas aces",
  "gs valkyries": "golden state valkyries",
  "washington mystic": "washington mystics",
};

function teamKey(value: unknown): string {
  const normalized = normalizedText(value);
  return TEAM_ALIASES[normalized] ?? normalized;
}

function sameTeam(left: unknown, right: unknown): boolean {
  const a = teamKey(left);
  const b = teamKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const aLast = a.split(" ").at(-1);
  const bLast = b.split(" ").at(-1);
  return Boolean(aLast && bLast && aLast.length >= 4 && aLast === bLast);
}

function americanImplied(odds: number): number {
  return odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100);
}

function devig(homeOdds: number, awayOdds: number): { home: number; away: number; homeRaw: number; awayRaw: number } {
  const homeRaw = americanImplied(homeOdds);
  const awayRaw = americanImplied(awayOdds);
  const total = homeRaw + awayRaw;
  if (!Number.isFinite(total) || total <= 0) throw new Error("Invalid two-sided moneyline");
  return {
    home: round(homeRaw / total),
    away: round(awayRaw / total),
    homeRaw: round(homeRaw),
    awayRaw: round(awayRaw),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]));
  }
  if (typeof value === "number") return Number.isFinite(value) ? round(value, 10) : null;
  return value;
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function properScores(probability: number, outcome: 0 | 1): { brierScore: number; logLoss: number } {
  const p = Math.min(0.999999, Math.max(0.000001, probability));
  return {
    brierScore: round((p - outcome) ** 2),
    logLoss: round(-(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p))),
  };
}

function sourceLabel(payload: any, fallback: string): string {
  const source = String(payload?.source ?? payload?.data?.source ?? "").trim();
  if (source) return source;
  if (payload?.stale === true) return `${fallback}-stale`;
  return fallback;
}

function isDegradedSource(source: string): boolean {
  return /fallback|stale|cache/i.test(source);
}

function extractArray(payload: any): any[] {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function findByTeamName(rows: any[], name: string): any | null {
  return rows.find((row) => sameTeam(row?.teamName ?? row?.name ?? row?.displayName, name)) ?? null;
}

function topPlayers(playersPayload: any, teamId: unknown): any[] {
  const data = playersPayload?.data;
  if (!data || typeof data !== "object") return [];
  const rows = data[String(teamId)] ?? data[Number(teamId)] ?? [];
  return Array.isArray(rows) ? rows.slice(0, 5).map((player) => ({
    playerId: player?.playerId ?? null,
    name: player?.name ?? null,
    min: player?.min ?? null,
    ppg: player?.ppg ?? null,
    apg: player?.apg ?? null,
    rpg: player?.rpg ?? null,
  })) : [];
}

function compactTeamContext(
  teamName: string,
  allRows: any[],
  fatigueRows: any[],
  sosRows: any[],
  playersPayload: any,
  injuryRows: any[],
): { context: Record<string, unknown>; missing: string[] } {
  const team = findByTeamName(allRows, teamName);
  const teamId = team?.teamId;
  const fatigue = fatigueRows.find((row) => Number(row?.teamId) === Number(teamId)) ?? null;
  const sos = sosRows.find((row) => Number(row?.teamId) === Number(teamId)) ?? null;
  const players = topPlayers(playersPayload, teamId);
  const injuries = injuryRows.find((row) => sameTeam(row?.teamName, teamName)) ?? null;
  const missing: string[] = [];
  if (!team) missing.push("teamStats");
  if (!fatigue) missing.push("fatigue");
  if (!sos) missing.push("sos");
  if (!players.length) missing.push("players");
  if (!injuries) missing.push("injuries");
  return {
    context: {
      teamId: teamId ?? null,
      teamName,
      ratings: team ? {
        netRtg: team.netRtg ?? null,
        offRtg: team.offRtg ?? null,
        defRtg: team.defRtg ?? null,
        pace: team.pace ?? null,
        recentNetRtg: team.recentNetRtg ?? null,
        recentOffRtg: team.recentOffRtg ?? null,
        recentDefRtg: team.recentDefRtg ?? null,
        recentPace: team.recentPace ?? null,
        winPct: team.winPct ?? null,
        recentWinPct: team.recentWinPct ?? null,
      } : null,
      fatigue: fatigue ? {
        daysRest: fatigue.daysRest ?? null,
        isB2B: Boolean(fatigue.isB2B),
        b2bWasRoad: Boolean(fatigue.b2bWasRoad),
        gamesLast7Days: fatigue.gamesLast7Days ?? null,
        streak: fatigue.streak ?? null,
      } : null,
      sos: sos ? {
        oppAvgNetRtg: sos.oppAvgNetRtg ?? null,
        sosLabel: sos.sosLabel ?? null,
      } : null,
      players,
      injuries: Array.isArray(injuries?.injuries) ? injuries.injuries.map((injury: any) => ({
        name: injury?.name ?? null,
        status: injury?.statusDesc ?? injury?.severityTier ?? null,
        severityTier: injury?.severityTier ?? null,
        daysOut: injury?.daysOut ?? null,
      })) : [],
    },
    missing,
  };
}

function terminalRecords(records: WnbaShadowRecord[]): WnbaShadowRecord[] {
  const latest = new Map<string, WnbaShadowRecord>();
  for (const record of [...records].sort((a, b) => a.recordedAtMs - b.recordedAtMs || a.id.localeCompare(b.id))) {
    latest.set(record.game.gameId, record);
  }
  return [...latest.values()].sort((a, b) => a.game.commenceTime.localeCompare(b.game.commenceTime));
}

function parseFinalGames(payload: any, gameDate: string): FinalGame[] {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const output: FinalGame[] = [];
  for (const event of events) {
    const competition = Array.isArray(event?.competitions) ? event.competitions[0] : null;
    const status = competition?.status?.type ?? event?.status?.type ?? {};
    const completed = status?.completed === true || String(status?.state ?? "").toLowerCase() === "post";
    if (!completed) continue;
    const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
    const home = competitors.find((item: any) => item?.homeAway === "home");
    const away = competitors.find((item: any) => item?.homeAway === "away");
    const homeScore = Number(home?.score);
    const awayScore = Number(away?.score);
    if (!home?.team || !away?.team || !Number.isFinite(homeScore) || !Number.isFinite(awayScore) || homeScore === awayScore) continue;
    output.push({
      gameId: String(event?.id ?? competition?.id ?? ""),
      gameDate,
      homeTeam: String(home.team.displayName ?? home.team.shortDisplayName ?? home.team.name ?? ""),
      awayTeam: String(away.team.displayName ?? away.team.shortDisplayName ?? away.team.name ?? ""),
      homeScore,
      awayScore,
    });
  }
  return output;
}

export class WnbaShadowService {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly finalWindowMinutes: number;
  private readonly settlementLookbackDays: number;
  private readonly root: string;
  private readonly selfBaseUrl: string;
  private readonly deploymentCommit: string;
  private readonly environment: string;
  private readonly now: () => Date;
  private readonly fetcher: FetchLike;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private officialFinalGameIds = new Set<string>();

  constructor(options: ServiceOptions = {}) {
    this.enabled = options.enabled ?? defaultEnabled();
    this.intervalMs = options.intervalMs ?? positiveInteger(process.env.WNBA_S6C_SHADOW_INTERVAL_MS, 300_000, 60_000);
    this.initialDelayMs = options.initialDelayMs ?? positiveInteger(process.env.WNBA_S6C_SHADOW_INITIAL_DELAY_MS, 240_000, 10_000);
    this.finalWindowMinutes = options.finalWindowMinutes ?? positiveInteger(process.env.WNBA_S6C_FINAL_WINDOW_MINUTES, 45, 5);
    this.settlementLookbackDays = options.settlementLookbackDays ?? positiveInteger(process.env.WNBA_S6C_SETTLEMENT_LOOKBACK_DAYS, 4, 1);
    this.root = options.root ?? defaultRoot();
    this.selfBaseUrl = (options.selfBaseUrl ?? `http://127.0.0.1:${process.env.PORT || 5000}`).replace(/\/$/, "");
    this.deploymentCommit = options.deploymentCommit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "unknown";
    this.environment = options.environment ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "unknown";
    this.now = options.now ?? (() => new Date());
    this.fetcher = options.fetcher ?? fetch;
    const latest = this.readLatest();
    this.lastSuccessAt = latest?.ranAt ?? null;
  }

  private recordsPath(): string { return path.join(this.root, "records.jsonl"); }
  private settlementsPath(): string { return path.join(this.root, "settlements.jsonl"); }
  private latestPath(): string { return path.join(this.root, "latest.json"); }
  private reportPath(): string { return path.join(this.root, "report.json"); }

  isEnabled(): boolean { return this.enabled; }
  getIntervalMs(): number { return this.intervalMs; }
  getInitialDelayMs(): number { return this.initialDelayMs; }
  readRecords(): WnbaShadowRecord[] { return readJsonLines<WnbaShadowRecord>(this.recordsPath()); }
  readSettlements(): WnbaShadowSettlement[] { return readJsonLines<WnbaShadowSettlement>(this.settlementsPath()); }
  readLatest(): WnbaShadowRunAudit | null { return readJson<WnbaShadowRunAudit>(this.latestPath()); }
  readReport(): WnbaShadowReport { return readJson<WnbaShadowReport>(this.reportPath()) ?? this.buildReport(); }

  status(): WnbaShadowStatus {
    return {
      schemaVersion: WNBA_SHADOW_SCHEMA_VERSION,
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      initialDelayMs: this.initialDelayMs,
      finalWindowMinutes: this.finalWindowMinutes,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      records: this.readRecords().length,
      settlements: this.readSettlements().length,
      latest: this.readLatest(),
      report: this.readReport(),
    };
  }

  private async fetchJson(url: string, timeoutMs = 25_000): Promise<any> {
    const response = await this.fetcher(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload: any;
    try { payload = JSON.parse(text); } catch { throw new Error(`Non-JSON response from ${url}`); }
    if (!response.ok || payload?.success === false) {
      throw new Error(String(payload?.error ?? payload?.message ?? `HTTP ${response.status}`));
    }
    return payload;
  }

  private async optionalEndpoint(pathname: string, fallbackSource: string): Promise<{ payload: any; source: string; error: string | null }> {
    try {
      const payload = await this.fetchJson(`${this.selfBaseUrl}${pathname}`);
      return { payload, source: sourceLabel(payload, fallbackSource), error: null };
    } catch (error) {
      return {
        payload: { success: false, data: [] },
        source: `${fallbackSource}-failed`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private findOdds(schedule: ScheduleGame, oddsGames: OddsGame[]): OddsGame | null {
    const commence = Date.parse(schedule.gameTimeUTC);
    const candidates = oddsGames.filter((game) =>
      sameTeam(game.homeTeam, schedule.homeTeam.name)
      && sameTeam(game.awayTeam, schedule.awayTeam.name),
    );
    if (!candidates.length) return null;
    return candidates.sort((left, right) =>
      Math.abs(Date.parse(left.commence) - commence) - Math.abs(Date.parse(right.commence) - commence),
    )[0];
  }

  private buildRecord(
    schedule: ScheduleGame,
    odds: OddsGame,
    stage: WnbaShadowStage,
    recordedAt: string,
    current: WnbaShadowRecord | null,
    contextPayloads: {
      all: { payload: any; source: string };
      fatigue: { payload: any; source: string };
      sos: { payload: any; source: string };
      players: { payload: any; source: string };
      injuries: { payload: any; source: string };
    },
  ): WnbaShadowRecord {
    const homeOdds = Number(odds.ml?.home);
    const awayOdds = Number(odds.ml?.away);
    const probabilities = devig(homeOdds, awayOdds);
    const allRows = extractArray(contextPayloads.all.payload);
    const fatigueRows = extractArray(contextPayloads.fatigue.payload);
    const sosRows = extractArray(contextPayloads.sos.payload);
    const injuryRows = extractArray(contextPayloads.injuries.payload);
    const home = compactTeamContext(schedule.homeTeam.name, allRows, fatigueRows, sosRows, contextPayloads.players.payload, injuryRows);
    const away = compactTeamContext(schedule.awayTeam.name, allRows, fatigueRows, sosRows, contextPayloads.players.payload, injuryRows);
    const sources = {
      schedule: "wnba-s6b-resilient",
      odds: String(odds.source ?? "unknown"),
      teamStats: contextPayloads.all.source,
      fatigue: contextPayloads.fatigue.source,
      sos: contextPayloads.sos.source,
      players: contextPayloads.players.source,
      injuries: contextPayloads.injuries.source,
    };
    const degradedSources = Object.entries(sources)
      .filter(([, source]) => isDegradedSource(source))
      .map(([name]) => name);
    const missing = [...home.missing.map((name) => `home.${name}`), ...away.missing.map((name) => `away.${name}`)];
    const checks = 10;
    const passed = checks - missing.length;
    const fingerprintBasis = {
      gameId: schedule.gameId,
      stage,
      homeOdds,
      awayOdds,
      probabilities,
      home: home.context,
      away: away.context,
      sources,
    };
    const fingerprint = sha256(fingerprintBasis);
    return {
      schemaVersion: WNBA_SHADOW_SCHEMA_VERSION,
      id: crypto.randomUUID(),
      fingerprint,
      recordedAt,
      recordedAtMs: Date.parse(recordedAt),
      supersedesId: current?.id ?? null,
      game: {
        gameId: schedule.gameId,
        gameDate: floridaDate(new Date(schedule.gameTimeUTC)),
        commenceTime: schedule.gameTimeUTC,
        homeTeam: schedule.homeTeam.name,
        awayTeam: schedule.awayTeam.name,
      },
      market: {
        type: "MONEYLINE",
        book: String(odds.source ?? "unknown"),
        capturedAt: recordedAt,
        homeOddsAmerican: homeOdds,
        awayOddsAmerican: awayOdds,
        homeRawImpliedProbability: probabilities.homeRaw,
        awayRawImpliedProbability: probabilities.awayRaw,
        homeDevigProbability: probabilities.home,
        awayDevigProbability: probabilities.away,
      },
      baseline: {
        name: "WNBA_MARKET_BASELINE",
        version: "v1",
        homeWinProbability: probabilities.home,
        awayWinProbability: probabilities.away,
        edgePp: 0,
      },
      decision: { signal: "OBSERVE", stakeUnits: 0 },
      analysisStage: stage,
      context: { home: home.context, away: away.context, sources, degradedSources },
      dataQuality: {
        checks,
        passed: Math.max(0, passed),
        coveragePct: round((Math.max(0, passed) / checks) * 100, 2),
        missing,
      },
      safety: SAFETY,
    };
  }

  private async finalScoreboards(now: Date): Promise<FinalGame[]> {
    const dates = Array.from({ length: this.settlementLookbackDays + 1 }, (_, index) => floridaDate(now, -index));
    const attempts = await Promise.allSettled(dates.map(async (date) => {
      const compact = date.replace(/-/g, "");
      const payload = await this.fetchJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard?dates=${compact}`, 15_000);
      return parseFinalGames(payload, date);
    }));
    return attempts.flatMap((attempt) => attempt.status === "fulfilled" ? attempt.value : []);
  }

  private findFinal(record: WnbaShadowRecord, finals: FinalGame[]): FinalGame | null {
    return finals.find((game) => game.gameId === record.game.gameId)
      ?? finals.find((game) => game.gameDate === record.game.gameDate
        && sameTeam(game.homeTeam, record.game.homeTeam)
        && sameTeam(game.awayTeam, record.game.awayTeam))
      ?? null;
  }

  private async settleTerminalRecords(now: Date): Promise<number> {
    const records = terminalRecords(this.readRecords());
    const settlements = this.readSettlements();
    this.officialFinalGameIds = new Set(settlements.map((event) => event.gameId));
    const settledIds = new Set(settlements.map((event) => event.predictionId));
    const candidates = records.filter((record) => !settledIds.has(record.id) && Date.parse(record.game.commenceTime) < now.getTime());
    if (!candidates.length) return 0;
    const finals = await this.finalScoreboards(now);
    let created = 0;
    for (const record of candidates) {
      const final = this.findFinal(record, finals);
      if (!final) continue;
      this.officialFinalGameIds.add(record.game.gameId);
      const homeOutcome: 0 | 1 = final.homeScore > final.awayScore ? 1 : 0;
      const scores = properScores(record.baseline.homeWinProbability, homeOutcome);
      const event: WnbaShadowSettlement = {
        schemaVersion: "wnba-shadow-settlement.v1",
        id: crypto.randomUUID(),
        predictionId: record.id,
        gameId: record.game.gameId,
        settledAt: now.toISOString(),
        homeScore: final.homeScore,
        awayScore: final.awayScore,
        homeOutcome,
        result: homeOutcome === 1 ? "HOME_WIN" : "AWAY_WIN",
        ...scores,
      };
      appendJsonLine(this.settlementsPath(), event);
      created += 1;
    }
    return created;
  }

  buildReport(): WnbaShadowReport {
    const records = this.readRecords();
    const terminal = terminalRecords(records);
    const settlements = this.readSettlements();
    const settlementByPrediction = new Map(settlements.map((event) => [event.predictionId, event]));
    const settledGameIds = new Set(settlements.map((event) => event.gameId));
    const officialFinal = terminal.filter((record) => (
      settledGameIds.has(record.game.gameId) || this.officialFinalGameIds.has(record.game.gameId)
    ));
    const settledRows = terminal.flatMap((record) => {
      const settlement = settlementByPrediction.get(record.id);
      return settlement ? [{ record, settlement }] : [];
    });
    const favoriteResults = settledRows.map(({ record, settlement }) => {
      const homeFavorite = record.baseline.homeWinProbability >= 0.5;
      return homeFavorite === (settlement.homeOutcome === 1) ? 1 : 0;
    });
    const degradedSourceTerminalRecords = terminal.filter((record) => record.context.degradedSources.length > 0).length;
    return {
      schemaVersion: WNBA_SHADOW_REPORT_VERSION,
      generatedAt: this.now().toISOString(),
      records: records.length,
      terminalGames: terminal.length,
      trackedGames: terminal.length,
      officialFinalGames: officialFinal.length,
      awaitingOfficialFinal: terminal.length - officialFinal.length,
      supersededRecords: Math.max(0, records.length - terminal.length),
      provisionalTerminal: terminal.filter((record) => record.analysisStage === "PROVISIONAL").length,
      finalTerminal: terminal.filter((record) => record.analysisStage === "FINAL").length,
      finalCoveragePct: terminal.length ? round((terminal.filter((record) => record.analysisStage === "FINAL").length / terminal.length) * 100, 2) : 0,
      settled: settledRows.length,
      pending: officialFinal.length - settledRows.length,
      settlementCoveragePct: officialFinal.length ? round((settledRows.length / officialFinal.length) * 100, 2) : 0,
      marketCoveragePct: terminal.length ? 100 : 0,
      averageDataQualityPct: average(terminal.map((record) => record.dataQuality.coveragePct)),
      degradedSourceTerminalRecords,
      averageBrierScore: average(settledRows.map(({ settlement }) => settlement.brierScore)),
      averageLogLoss: average(settledRows.map(({ settlement }) => settlement.logLoss)),
      favoriteAccuracyPct: favoriteResults.length ? round((favoriteResults.reduce((sum, value) => sum + value, 0) / favoriteResults.length) * 100, 2) : null,
      safety: SAFETY,
    };
  }

  async run(trigger = "scheduled"): Promise<WnbaShadowRunAudit> {
    const now = this.now();
    const ranAt = now.toISOString();
    const gameDate = floridaDate(now);
    this.lastRunAt = ranAt;
    const errors: string[] = [];
    let discoveredGames = 0;
    let pricedGames = 0;
    let recordsCreated = 0;
    let idempotentRecords = 0;
    let provisionalCreated = 0;
    let finalCreated = 0;
    let skippedStarted = 0;
    let unmatchedOdds = 0;
    let missingMoneyline = 0;

    try {
      const [scheduleResult, oddsResult, all, fatigue, sos, players, injuries] = await Promise.all([
        this.optionalEndpoint(`/api/wnba/games?date=${encodeURIComponent(gameDate)}`, "wnba-schedule"),
        this.optionalEndpoint(`/api/odds/wnba?date=${encodeURIComponent(gameDate)}`, "wnba-odds"),
        this.optionalEndpoint("/api/wnba/all", "wnba-team-stats"),
        this.optionalEndpoint("/api/wnba/fatigue", "wnba-fatigue"),
        this.optionalEndpoint("/api/wnba/sos", "wnba-sos"),
        this.optionalEndpoint("/api/wnba/players", "wnba-players"),
        this.optionalEndpoint("/api/wnba/injuries", "wnba-injuries"),
      ]);
      for (const [name, result] of Object.entries({ schedule: scheduleResult, odds: oddsResult, all, fatigue, sos, players, injuries })) {
        if (result.error) errors.push(`${name}: ${result.error}`);
      }
      const scheduleGames = extractArray(scheduleResult.payload) as ScheduleGame[];
      const oddsGames = Array.isArray(oddsResult.payload?.games) ? oddsResult.payload.games as OddsGame[] : [];
      discoveredGames = scheduleGames.length;
      const contextPayloads = { all, fatigue, sos, players, injuries };
      const existing = this.readRecords();
      const currentByGame = new Map(terminalRecords(existing).map((record) => [record.game.gameId, record]));

      for (const schedule of scheduleGames) {
        const commenceMs = Date.parse(schedule.gameTimeUTC);
        if (!Number.isFinite(commenceMs)) {
          errors.push(`schedule ${schedule.gameId}: invalid commence time`);
          continue;
        }
        const minutesToTip = (commenceMs - now.getTime()) / 60_000;
        if (minutesToTip < 0) {
          skippedStarted += 1;
          continue;
        }
        const odds = this.findOdds(schedule, oddsGames);
        if (!odds) {
          unmatchedOdds += 1;
          continue;
        }
        const homeOdds = Number(odds.ml?.home);
        const awayOdds = Number(odds.ml?.away);
        if (!Number.isFinite(homeOdds) || !Number.isFinite(awayOdds) || homeOdds === 0 || awayOdds === 0) {
          missingMoneyline += 1;
          continue;
        }
        pricedGames += 1;
        const stage: WnbaShadowStage = minutesToTip <= this.finalWindowMinutes ? "FINAL" : "PROVISIONAL";
        const current = currentByGame.get(schedule.gameId) ?? null;
        const record = this.buildRecord(schedule, odds, stage, ranAt, current, contextPayloads);
        if (current?.fingerprint === record.fingerprint) {
          idempotentRecords += 1;
          continue;
        }
        appendJsonLine(this.recordsPath(), record);
        currentByGame.set(schedule.gameId, record);
        recordsCreated += 1;
        if (stage === "FINAL") finalCreated += 1;
        else provisionalCreated += 1;
      }

      const settlementsCreated = await this.settleTerminalRecords(now);
      const report = this.buildReport();
      atomicJson(this.reportPath(), report);
      const audit: WnbaShadowRunAudit = {
        schemaVersion: "wnba-shadow-run.v1",
        ranAt,
        trigger,
        gameDate,
        deploymentCommit: this.deploymentCommit,
        environment: this.environment,
        discoveredGames,
        pricedGames,
        recordsCreated,
        idempotentRecords,
        provisionalCreated,
        finalCreated,
        skippedStarted,
        unmatchedOdds,
        missingMoneyline,
        settlementsCreated,
        errors,
        report,
        safety: SAFETY,
      };
      atomicJson(this.latestPath(), audit);
      this.lastSuccessAt = ranAt;
      this.lastError = null;
      return audit;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }
}

let singleton: { service: WnbaShadowService; stop: () => void } | null = null;

export function startWnbaShadowWorker(options: ServiceOptions = {}): { service: WnbaShadowService; stop: () => void } {
  if (singleton) return singleton;
  const service = new WnbaShadowService(options);
  let interval: NodeJS.Timeout | null = null;
  let initial: NodeJS.Timeout | null = null;
  const execute = () => service.run("scheduled").catch((error) => {
    console.error("[s6c] WNBA shadow cycle failed", error);
  });
  if (service.isEnabled()) {
    initial = setTimeout(() => {
      execute();
      interval = setInterval(execute, service.getIntervalMs());
      interval.unref();
    }, service.getInitialDelayMs());
    initial.unref();
  }
  singleton = {
    service,
    stop: () => {
      if (initial) clearTimeout(initial);
      if (interval) clearInterval(interval);
      singleton = null;
    },
  };
  return singleton;
}
