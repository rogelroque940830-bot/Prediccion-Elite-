import { isStandardAmericanOdds } from "./american-odds";
import {
  MLB_P1_M2A_FINAL_ONLY_FIELDS,
  MLB_P1_M2A_HARD_BLOCKING_FIELDS,
  MLB_P1_M2A_MARKET_REQUIREMENTS,
  MLB_P1_M2A_SCHEMA,
  MLB_P1_M2A_SOURCE_INVENTORY,
  classifyMlbP1M2aFreshness,
  decideMlbP1M2aPregameGate,
  type MlbP1M2aEvidenceState,
  type MlbP1M2aField,
  type MlbP1M2aMarket,
} from "./mlb-p1-pregame-readiness-contract";
import { isValidMlbP1Date } from "./mlb-p1-daily-slate";
import { SELF_URL } from "./route-runtime";

export const MLB_P1_M2B_SCHEMA = "courtedge-p1-m2b-pregame-readiness.v1" as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MlbP1M2bManualOdds {
  mode: "MANUAL";
  book: string;
  capturedAt: string;
  line?: number | null;
  homeOdds?: number | null;
  awayOdds?: number | null;
  overOdds?: number | null;
  underOdds?: number | null;
}

export interface MlbP1M2bEvidenceEnvelope {
  field: MlbP1M2aField;
  required: boolean;
  state: MlbP1M2aEvidenceState;
  sourceIds: string[];
  endpoints: string[];
  authority: string;
  fetchedAt: string;
  observedAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  sourceStatus: string;
  quality: string;
  details: Record<string, unknown>;
  errors: string[];
}

export interface MlbP1M2bReadinessReport {
  schemaVersion: typeof MLB_P1_M2B_SCHEMA;
  contractSchemaVersion: typeof MLB_P1_M2A_SCHEMA;
  generatedAt: string;
  market: MlbP1M2aMarket;
  game: {
    gamePk: number;
    officialDate: string | null;
    startTime: string | null;
    state: "SCHEDULED" | "PREGAME" | "IN_PROGRESS" | "FINAL" | "CLOSED" | "UNKNOWN";
    detailedState: string | null;
    homeTeam: { id: number | null; name: string | null };
    awayTeam: { id: number | null; name: string | null };
  };
  gate: ReturnType<typeof decideMlbP1M2aPregameGate>;
  evidence: MlbP1M2bEvidenceEnvelope[];
  summary: {
    requiredFields: MlbP1M2aField[];
    fresh: number;
    stale: number;
    degraded: number;
    missing: number;
    conflict: number;
    unknown: number;
  };
  warnings: string[];
  safety: {
    mode: "SHADOW_DECISION_SUPPORT";
    realFinancialExposure: 0;
    automaticBetPlacement: false;
    automaticModelChangesAllowed: false;
    automaticPromotionAllowed: false;
  };
}

interface SourceCall {
  url: string;
  ok: boolean;
  status: number;
  data: any;
  fetchedAt: string;
  durationMs: number;
  error: string | null;
}

interface OfficialGame {
  gamePk: number;
  officialDate: string | null;
  startTime: string | null;
  state: string;
  detailedState: string | null;
  homeTeam: { id: number | null; name: string | null };
  awayTeam: { id: number | null; name: string | null };
  homePitcher?: { id?: number | null; name?: string | null; confirmed?: boolean };
  awayPitcher?: { id?: number | null; name?: string | null; confirmed?: boolean };
  lineupState?: string;
  homeLineupCount?: number;
  awayLineupCount?: number;
  source?: { fetchedAt?: string; quality?: string };
}

const FIELD_ORDER: readonly MlbP1M2aField[] = [
  "GAME_IDENTITY",
  "PITCHERS",
  "LINEUPS",
  "INJURIES",
  "MARKET_ODDS",
  "BULLPEN",
  "PITCHER_FORM",
  "LINEUP_MATCHUP",
  "ENVIRONMENT",
  "UMPIRE",
  "ADVANCED_FACTORS",
] as const;

const EXPLICIT_TIMESTAMP_KEYS = new Set([
  "observedAt",
  "generatedAt",
  "fetchedAt",
  "capturedAt",
  "providerLastUpdate",
  "updatedAt",
  "lastUpdate",
  "lastUpdated",
]);

function sourceDefinitions(field: MlbP1M2aField) {
  return MLB_P1_M2A_SOURCE_INVENTORY.filter((source) => source.field === field);
}

function maxAgeFor(field: MlbP1M2aField): number {
  const ages = sourceDefinitions(field).map((source) => source.requiredMaxAgeSeconds);
  return ages.length ? Math.min(...ages) : 300;
}

function requiredFieldsFor(market: MlbP1M2aMarket): MlbP1M2aField[] {
  return Array.from(new Set([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS[market],
  ]));
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isoOrNull(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function ageSeconds(observedAt: string | null, now: Date): number | null {
  if (!observedAt) return null;
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now.getTime() - parsed) / 1000));
}

function newestIso(values: readonly (string | null | undefined)[]): string | null {
  const parsed = values
    .map((value) => isoOrNull(value))
    .filter((value): value is string => value != null)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return parsed[0] ?? null;
}

function collectTimestamps(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 4 || value == null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const result: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (EXPLICIT_TIMESTAMP_KEYS.has(key)) {
      const timestamp = isoOrNull(child);
      if (timestamp) result.push(timestamp);
    }
    if (child && typeof child === "object") {
      result.push(...collectTimestamps(child, depth + 1, seen));
    }
  }
  return result;
}

function payloadUsable(data: any): boolean {
  if (data == null) return false;
  if (data?.success === false) return false;
  if (data?.error && Object.keys(data).length <= 5) return false;
  return true;
}

async function fetchJson(
  fetchImpl: FetchLike,
  url: string,
  fetchedAt: string,
  timeoutMs: number,
): Promise<SourceCall> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    let data: any = null;
    try {
      data = await response.json();
    } catch {
      return {
        url,
        ok: false,
        status: response.status,
        data: null,
        fetchedAt,
        durationMs: Date.now() - started,
        error: "INVALID_JSON",
      };
    }
    const usable = response.ok && payloadUsable(data);
    return {
      url,
      ok: usable,
      status: response.status,
      data,
      fetchedAt,
      durationMs: Date.now() - started,
      error: usable ? null : cleanText(data?.error || data?.message || `HTTP_${response.status}`),
    };
  } catch (error: any) {
    return {
      url,
      ok: false,
      status: 0,
      data: null,
      fetchedAt,
      durationMs: Date.now() - started,
      error: error?.name === "AbortError" ? "TIMEOUT" : cleanText(error?.message || error || "FETCH_FAILED"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function evidenceEnvelope(input: {
  field: MlbP1M2aField;
  required: boolean;
  state: MlbP1M2aEvidenceState;
  fetchedAt: string;
  observedAt?: string | null;
  sourceStatus: string;
  quality: string;
  details?: Record<string, unknown>;
  errors?: string[];
  sourceIds?: string[];
  endpoints?: string[];
  authority?: string;
  now: Date;
}): MlbP1M2bEvidenceEnvelope {
  const definitions = sourceDefinitions(input.field);
  return {
    field: input.field,
    required: input.required,
    state: input.state,
    sourceIds: input.sourceIds ?? definitions.map((source) => source.id),
    endpoints: input.endpoints ?? definitions.map((source) => source.endpoint),
    authority: input.authority ?? definitions.map((source) => source.authority).join("+") || "UNKNOWN",
    fetchedAt: input.fetchedAt,
    observedAt: input.observedAt ?? null,
    ageSeconds: ageSeconds(input.observedAt ?? null, input.now),
    maxAgeSeconds: maxAgeFor(input.field),
    sourceStatus: input.sourceStatus,
    quality: input.quality,
    details: input.details ?? {},
    errors: input.errors ?? [],
  };
}

function notRequiredEvidence(field: MlbP1M2aField, fetchedAt: string, now: Date): MlbP1M2bEvidenceEnvelope {
  return evidenceEnvelope({
    field,
    required: false,
    state: "UNKNOWN",
    fetchedAt,
    observedAt: null,
    sourceStatus: "NOT_REQUIRED_FOR_SELECTED_MARKET",
    quality: "NOT_LOADED",
    details: {},
    errors: [],
    now,
  });
}

function normalizeGameState(state: string): MlbP1M2bReadinessReport["game"]["state"] {
  const normalized = cleanText(state).toUpperCase();
  if (normalized === "SCHEDULED") return "SCHEDULED";
  if (normalized === "PREGAME") return "PREGAME";
  if (normalized === "IN_PROGRESS") return "IN_PROGRESS";
  if (normalized === "FINAL") return "FINAL";
  if (["POSTPONED", "CANCELLED", "SUSPENDED", "CLOSED"].includes(normalized)) return "CLOSED";
  return "UNKNOWN";
}

function teamKey(value: unknown): string {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function gameStart(value: any): string | null {
  return isoOrNull(value?.commence ?? value?.commenceTime ?? value?.startTime ?? value?.gameDate);
}

function chooseMarketGame(
  games: any[],
  officialGame: OfficialGame,
): { game: any | null; conflict: string | null } {
  const homeKey = teamKey(officialGame.homeTeam.name);
  const awayKey = teamKey(officialGame.awayTeam.name);
  const matches = games.filter((game) =>
    teamKey(game?.homeTeam ?? game?.home_team ?? game?.home?.name) === homeKey
    && teamKey(game?.awayTeam ?? game?.away_team ?? game?.away?.name) === awayKey
  );
  if (matches.length === 0) return { game: null, conflict: null };
  if (matches.length === 1) {
    const candidateStart = gameStart(matches[0]);
    if (officialGame.startTime && candidateStart) {
      const deltaMs = Math.abs(Date.parse(candidateStart) - Date.parse(officialGame.startTime));
      if (deltaMs > 6 * 60 * 60 * 1000) return { game: null, conflict: "MARKET_START_TIME_MISMATCH" };
    }
    return { game: matches[0], conflict: null };
  }
  if (!officialGame.startTime) return { game: null, conflict: "AMBIGUOUS_DOUBLEHEADER_WITHOUT_START_TIME" };
  const ranked = matches
    .map((game) => ({
      game,
      start: gameStart(game),
      delta: gameStart(game)
        ? Math.abs(Date.parse(gameStart(game)!) - Date.parse(officialGame.startTime!))
        : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.delta - right.delta);
  if (!Number.isFinite(ranked[0]?.delta) || ranked[0].delta > 6 * 60 * 60 * 1000) {
    return { game: null, conflict: "AMBIGUOUS_OR_MISMATCHED_DOUBLEHEADER" };
  }
  if (ranked[1] && ranked[1].delta === ranked[0].delta) {
    return { game: null, conflict: "AMBIGUOUS_DOUBLEHEADER_TIME_TIE" };
  }
  return { game: ranked[0].game, conflict: null };
}

function validMarketNumbers(market: MlbP1M2aMarket, game: any): boolean {
  if (market === "ML") {
    return isStandardAmericanOdds(game?.ml?.home) && isStandardAmericanOdds(game?.ml?.away);
  }
  if (market === "RUN_LINE") {
    return finite(game?.spread?.line) != null
      && isStandardAmericanOdds(game?.spread?.homeOdds)
      && isStandardAmericanOdds(game?.spread?.awayOdds);
  }
  if (market === "TOTAL") {
    return finite(game?.total?.line) != null
      && isStandardAmericanOdds(game?.total?.overOdds)
      && isStandardAmericanOdds(game?.total?.underOdds);
  }
  if (market === "F5_ML") {
    return isStandardAmericanOdds(game?.f5Ml?.home) && isStandardAmericanOdds(game?.f5Ml?.away);
  }
  return finite(game?.f5Total?.line) != null
    && isStandardAmericanOdds(game?.f5Total?.overOdds)
    && isStandardAmericanOdds(game?.f5Total?.underOdds);
}

export function validateMlbP1M2bManualOdds(
  market: MlbP1M2aMarket,
  manual: MlbP1M2bManualOdds,
): string[] {
  const errors: string[] = [];
  if (!cleanText(manual.book)) errors.push("MANUAL_BOOK_REQUIRED");
  if (!isoOrNull(manual.capturedAt)) errors.push("MANUAL_CAPTURED_AT_INVALID");
  if (market === "ML" || market === "F5_ML") {
    if (!isStandardAmericanOdds(manual.homeOdds)) errors.push("MANUAL_HOME_ODDS_INVALID");
    if (!isStandardAmericanOdds(manual.awayOdds)) errors.push("MANUAL_AWAY_ODDS_INVALID");
  } else if (market === "RUN_LINE") {
    if (finite(manual.line) == null) errors.push("MANUAL_LINE_INVALID");
    if (!isStandardAmericanOdds(manual.homeOdds)) errors.push("MANUAL_HOME_ODDS_INVALID");
    if (!isStandardAmericanOdds(manual.awayOdds)) errors.push("MANUAL_AWAY_ODDS_INVALID");
  } else {
    if (finite(manual.line) == null) errors.push("MANUAL_LINE_INVALID");
    if (!isStandardAmericanOdds(manual.overOdds)) errors.push("MANUAL_OVER_ODDS_INVALID");
    if (!isStandardAmericanOdds(manual.underOdds)) errors.push("MANUAL_UNDER_ODDS_INVALID");
  }
  return errors;
}

async function resolveDateByGamePk(
  gamePk: number,
  dateHint: string | null,
  fetchImpl: FetchLike,
  fetchedAt: string,
  timeoutMs: number,
): Promise<{ date: string | null; call: SourceCall | null; error: string | null }> {
  if (dateHint) {
    return isValidMlbP1Date(dateHint)
      ? { date: dateHint, call: null, error: null }
      : { date: null, call: null, error: "INVALID_DATE_HINT" };
  }
  const call = await fetchJson(
    fetchImpl,
    `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
    fetchedAt,
    timeoutMs,
  );
  const date = cleanText(call.data?.gameData?.datetime?.officialDate);
  return isValidMlbP1Date(date)
    ? { date, call, error: null }
    : { date: null, call, error: call.error || "OFFICIAL_DATE_UNAVAILABLE" };
}

function officialEvidence(
  officialGame: OfficialGame | null,
  slateCall: SourceCall,
  required: Set<MlbP1M2aField>,
  now: Date,
): MlbP1M2bEvidenceEnvelope[] {
  const fetchedAt = slateCall.fetchedAt;
  if (!officialGame) {
    const error = slateCall.error || "GAME_NOT_FOUND_IN_OFFICIAL_SLATE";
    return (["GAME_IDENTITY", "PITCHERS", "LINEUPS"] as const).map((field) => evidenceEnvelope({
      field,
      required: required.has(field),
      state: field === "GAME_IDENTITY" && slateCall.ok ? "CONFLICT" : "MISSING",
      fetchedAt,
      sourceStatus: slateCall.ok ? "GAME_NOT_FOUND" : "SOURCE_UNAVAILABLE",
      quality: "UNAVAILABLE",
      errors: [error],
      now,
    }));
  }

  const observedAt = isoOrNull(officialGame.source?.fetchedAt) ?? isoOrNull(slateCall.data?.data?.generatedAt);
  const identityFreshness = classifyMlbP1M2aFreshness({
    observedAt,
    now,
    maxAgeSeconds: maxAgeFor("GAME_IDENTITY"),
  });
  const sourceQuality = cleanText(officialGame.source?.quality).toUpperCase();
  const identityState: MlbP1M2aEvidenceState = sourceQuality === "DEGRADED"
    ? "DEGRADED"
    : identityFreshness;

  const homePitcherConfirmed = Boolean(officialGame.homePitcher?.confirmed);
  const awayPitcherConfirmed = Boolean(officialGame.awayPitcher?.confirmed);
  const pitcherFreshness = classifyMlbP1M2aFreshness({
    observedAt,
    now,
    maxAgeSeconds: maxAgeFor("PITCHERS"),
  });
  const pitcherState: MlbP1M2aEvidenceState = homePitcherConfirmed && awayPitcherConfirmed
    ? (sourceQuality === "DEGRADED" ? "DEGRADED" : pitcherFreshness)
    : "MISSING";

  const lineupState = cleanText(officialGame.lineupState).toUpperCase();
  const lineupFreshness = classifyMlbP1M2aFreshness({
    observedAt,
    now,
    maxAgeSeconds: maxAgeFor("LINEUPS"),
  });
  let lineupsState: MlbP1M2aEvidenceState = "MISSING";
  if (lineupState === "CONFIRMED") {
    lineupsState = sourceQuality === "DEGRADED" ? "DEGRADED" : lineupFreshness;
  } else if (lineupState === "PARTIAL") {
    lineupsState = "DEGRADED";
  } else if (lineupState === "UNKNOWN") {
    lineupsState = "UNKNOWN";
  }

  return [
    evidenceEnvelope({
      field: "GAME_IDENTITY",
      required: required.has("GAME_IDENTITY"),
      state: identityState,
      fetchedAt,
      observedAt,
      sourceStatus: sourceQuality || "AUTHORITATIVE",
      quality: sourceQuality === "DEGRADED" ? "DEGRADED" : "AUTHORITATIVE",
      details: {
        gamePk: officialGame.gamePk,
        officialDate: officialGame.officialDate,
        state: officialGame.state,
        detailedState: officialGame.detailedState,
      },
      errors: identityState === "FRESH" ? [] : [`GAME_IDENTITY_${identityState}`],
      now,
    }),
    evidenceEnvelope({
      field: "PITCHERS",
      required: required.has("PITCHERS"),
      state: pitcherState,
      fetchedAt,
      observedAt,
      sourceStatus: homePitcherConfirmed && awayPitcherConfirmed ? "BOTH_IDENTIFIED" : "PITCHER_MISSING",
      quality: sourceQuality === "DEGRADED" ? "DEGRADED" : "AUTHORITATIVE",
      details: {
        home: officialGame.homePitcher ?? null,
        away: officialGame.awayPitcher ?? null,
      },
      errors: pitcherState === "FRESH" ? [] : [`PITCHERS_${pitcherState}`],
      now,
    }),
    evidenceEnvelope({
      field: "LINEUPS",
      required: required.has("LINEUPS"),
      state: lineupsState,
      fetchedAt,
      observedAt,
      sourceStatus: lineupState || "UNKNOWN",
      quality: sourceQuality === "DEGRADED" ? "DEGRADED" : "AUTHORITATIVE",
      details: {
        lineupState,
        homeLineupCount: officialGame.homeLineupCount ?? 0,
        awayLineupCount: officialGame.awayLineupCount ?? 0,
      },
      errors: lineupsState === "FRESH" ? [] : [`LINEUPS_${lineupsState}`],
      now,
    }),
  ];
}

function findAnalysisGame(payload: any, gamePk: number): any | null {
  const games = Array.isArray(payload?.games)
    ? payload.games
    : Array.isArray(payload?.data?.games)
      ? payload.data.games
      : [];
  return games.find((game: any) =>
    positiveInteger(game?.gamePk ?? game?.gameId ?? game?.id) === gamePk
  ) ?? null;
}

function injuryEvidence(
  analysisCall: SourceCall,
  analysisGame: any | null,
  required: boolean,
  now: Date,
): MlbP1M2bEvidenceEnvelope {
  if (!analysisCall.ok || !analysisGame) {
    return evidenceEnvelope({
      field: "INJURIES",
      required,
      state: analysisCall.ok ? "CONFLICT" : "MISSING",
      fetchedAt: analysisCall.fetchedAt,
      observedAt: null,
      sourceStatus: analysisCall.ok ? "GAME_NOT_FOUND" : "SOURCE_UNAVAILABLE",
      quality: "UNAVAILABLE",
      details: {},
      errors: [analysisCall.error || "INJURY_GAME_NOT_FOUND"],
      now,
    });
  }
  const home = analysisGame?.homeInjuryData ?? null;
  const away = analysisGame?.awayInjuryData ?? null;
  if (!home || !away) {
    return evidenceEnvelope({
      field: "INJURIES",
      required,
      state: "MISSING",
      fetchedAt: analysisCall.fetchedAt,
      observedAt: null,
      sourceStatus: "METADATA_MISSING",
      quality: "UNAVAILABLE",
      details: {
        homePresent: Boolean(home),
        awayPresent: Boolean(away),
      },
      errors: ["INJURY_METADATA_MISSING"],
      now,
    });
  }

  const statuses = [cleanText(home.status).toUpperCase(), cleanText(away.status).toUpperCase()];
  const observedAt = newestIso([home.fetchedAt, home.officialFetchedAt, away.fetchedAt, away.officialFetchedAt]);
  const freshness = classifyMlbP1M2aFreshness({
    observedAt,
    now,
    maxAgeSeconds: maxAgeFor("INJURIES"),
  });
  let state: MlbP1M2aEvidenceState;
  if (statuses.some((status) => status === "SOURCE_UNAVAILABLE")) state = "MISSING";
  else if (freshness === "STALE" || home.stale === true || away.stale === true) state = "STALE";
  else if (statuses.every((status) => status === "VERIFIED") && freshness === "FRESH") state = "FRESH";
  else if (!observedAt) state = "UNKNOWN";
  else state = "DEGRADED";

  return evidenceEnvelope({
    field: "INJURIES",
    required,
    state,
    fetchedAt: analysisCall.fetchedAt,
    observedAt,
    sourceStatus: statuses.join("+") || "UNKNOWN",
    quality: state === "FRESH" ? "VALIDATED_EXTERNAL" : "DEGRADED",
    details: {
      home: {
        status: home.status ?? null,
        stale: home.stale ?? null,
        count: home.count ?? analysisGame?.homeInjuries?.length ?? null,
        officialValidationStatus: home.officialValidationStatus ?? null,
      },
      away: {
        status: away.status ?? null,
        stale: away.stale ?? null,
        count: away.count ?? analysisGame?.awayInjuries?.length ?? null,
        officialValidationStatus: away.officialValidationStatus ?? null,
      },
    },
    errors: state === "FRESH"
      ? []
      : [
          ...((Array.isArray(home.sourceErrors) ? home.sourceErrors : []).map(cleanText)),
          ...((Array.isArray(away.sourceErrors) ? away.sourceErrors : []).map(cleanText)),
          `INJURIES_${state}`,
        ].filter(Boolean),
    now,
  });
}

function manualOddsEvidence(
  market: MlbP1M2aMarket,
  manual: MlbP1M2bManualOdds,
  required: boolean,
  fetchedAt: string,
  now: Date,
): MlbP1M2bEvidenceEnvelope {
  const validationErrors = validateMlbP1M2bManualOdds(market, manual);
  const observedAt = isoOrNull(manual.capturedAt);
  const freshness = classifyMlbP1M2aFreshness({
    observedAt,
    now,
    maxAgeSeconds: maxAgeFor("MARKET_ODDS"),
  });
  const state: MlbP1M2aEvidenceState = validationErrors.length
    ? "CONFLICT"
    : freshness;
  return evidenceEnvelope({
    field: "MARKET_ODDS",
    required,
    state,
    fetchedAt,
    observedAt,
    sourceStatus: "MANUAL_OVERRIDE",
    quality: "USER_VERIFIED_MARKET_SNAPSHOT",
    details: {
      book: manual.book,
      market,
      line: manual.line ?? null,
      homeOdds: manual.homeOdds ?? null,
      awayOdds: manual.awayOdds ?? null,
      overOdds: manual.overOdds ?? null,
      underOdds: manual.underOdds ?? null,
    },
    errors: validationErrors.length ? validationErrors : (state === "FRESH" ? [] : [`MARKET_ODDS_${state}`]),
    sourceIds: ["manual-market-odds"],
    endpoints: [],
    authority: "MARKET",
    now,
  });
}

async function automaticOddsEvidence(input: {
  market: MlbP1M2aMarket;
  date: string;
  officialGame: OfficialGame;
  fetchImpl: FetchLike;
  baseUrl: string;
  fetchedAt: string;
  timeoutMs: number;
  required: boolean;
  now: Date;
}): Promise<MlbP1M2bEvidenceEnvelope> {
  const f5 = input.market === "F5_ML" || input.market === "F5_TOTAL";
  const endpoint = f5
    ? `/api/odds/mlb/f5?date=${encodeURIComponent(input.date)}`
    : `/api/odds/mlb?date=${encodeURIComponent(input.date)}`;
  const call = await fetchJson(input.fetchImpl, `${input.baseUrl}${endpoint}`, input.fetchedAt, input.timeoutMs);
  if (!call.ok) {
    return evidenceEnvelope({
      field: "MARKET_ODDS",
      required: input.required,
      state: "MISSING",
      fetchedAt: call.fetchedAt,
      observedAt: null,
      sourceStatus: "SOURCE_UNAVAILABLE",
      quality: "UNAVAILABLE",
      details: { endpoint },
      errors: [call.error || "MARKET_ODDS_UNAVAILABLE"],
      endpoints: [endpoint],
      now: input.now,
    });
  }

  const games = Array.isArray(call.data?.games)
    ? call.data.games
    : Array.isArray(call.data?.data?.games)
      ? call.data.data.games
      : [];
  const selected = chooseMarketGame(games, input.officialGame);
  if (selected.conflict) {
    return evidenceEnvelope({
      field: "MARKET_ODDS",
      required: input.required,
      state: "CONFLICT",
      fetchedAt: call.fetchedAt,
      observedAt: null,
      sourceStatus: "IDENTITY_CONFLICT",
      quality: "CONFLICT",
      details: { endpoint, candidateCount: games.length },
      errors: [selected.conflict],
      endpoints: [endpoint],
      now: input.now,
    });
  }
  if (!selected.game) {
    return evidenceEnvelope({
      field: "MARKET_ODDS",
      required: input.required,
      state: "MISSING",
      fetchedAt: call.fetchedAt,
      observedAt: null,
      sourceStatus: "GAME_MARKET_NOT_FOUND",
      quality: "UNAVAILABLE",
      details: { endpoint },
      errors: ["MARKET_GAME_NOT_FOUND"],
      endpoints: [endpoint],
      now: input.now,
    });
  }
  if (!validMarketNumbers(input.market, selected.game)) {
    return evidenceEnvelope({
      field: "MARKET_ODDS",
      required: input.required,
      state: "MISSING",
      fetchedAt: call.fetchedAt,
      observedAt: null,
      sourceStatus: "SELECTED_MARKET_INCOMPLETE",
      quality: "UNAVAILABLE",
      details: { endpoint, source: selected.game?.source ?? call.data?.source ?? null },
      errors: ["SELECTED_MARKET_QUOTES_INCOMPLETE"],
      endpoints: [endpoint],
      now: input.now,
    });
  }

  const explicitObservedAt = newestIso([
    selected.game?.providerLastUpdate,
    selected.game?.capturedAt,
    selected.game?.provenance?.providerLastUpdate,
    selected.game?.provenance?.capturedAt,
    call.data?.generatedAt,
  ]);
  const observedAt = explicitObservedAt ?? call.fetchedAt;
  const freshness = classifyMlbP1M2aFreshness({
    observedAt,
    now: input.now,
    maxAgeSeconds: maxAgeFor("MARKET_ODDS"),
  });
  const requestTimeOnly = !explicitObservedAt;
  return evidenceEnvelope({
    field: "MARKET_ODDS",
    required: input.required,
    state: freshness,
    fetchedAt: call.fetchedAt,
    observedAt,
    sourceStatus: requestTimeOnly ? "REQUEST_TIME_ONLY" : "EXPLICIT_PROVIDER_TIME",
    quality: requestTimeOnly ? "REQUEST_TIME_ONLY" : "MARKET_PROVENANCE",
    details: {
      endpoint,
      source: selected.game?.source ?? call.data?.source ?? null,
      commence: gameStart(selected.game),
      market: input.market,
      quote: input.market === "ML"
        ? selected.game.ml
        : input.market === "RUN_LINE"
          ? selected.game.spread
          : input.market === "TOTAL"
            ? selected.game.total
            : input.market === "F5_ML"
              ? selected.game.f5Ml
              : selected.game.f5Total,
      requestTimeOnly,
    },
    errors: freshness === "FRESH" ? [] : [`MARKET_ODDS_${freshness}`],
    endpoints: [endpoint],
    now: input.now,
  });
}

function explicitTimestampFromCalls(calls: readonly SourceCall[]): string | null {
  return newestIso(calls.flatMap((call) => collectTimestamps(call.data)));
}

async function derivedEvidence(input: {
  field: MlbP1M2aField;
  urls: string[];
  fetchImpl: FetchLike;
  fetchedAt: string;
  timeoutMs: number;
  required: boolean;
  now: Date;
}): Promise<MlbP1M2bEvidenceEnvelope> {
  const calls = await Promise.all(
    input.urls.map((url) => fetchJson(input.fetchImpl, url, input.fetchedAt, input.timeoutMs)),
  );
  const successful = calls.filter((call) => call.ok);
  const observedAt = explicitTimestampFromCalls(successful);
  const errors = calls.filter((call) => !call.ok).map((call) => `${call.url}: ${call.error || "FAILED"}`);
  let state: MlbP1M2aEvidenceState;
  let quality: string;
  if (successful.length === 0) {
    state = "MISSING";
    quality = "UNAVAILABLE";
  } else if (successful.length < calls.length) {
    state = "DEGRADED";
    quality = "PARTIAL_SOURCE_COVERAGE";
  } else if (!observedAt) {
    state = "DEGRADED";
    quality = "DERIVED_WITHOUT_EXPLICIT_TIMESTAMP";
  } else {
    state = classifyMlbP1M2aFreshness({
      observedAt,
      now: input.now,
      maxAgeSeconds: maxAgeFor(input.field),
    });
    quality = state === "FRESH" ? "DERIVED_WITH_EXPLICIT_TIMESTAMP" : "DERIVED_STALE";
  }
  return evidenceEnvelope({
    field: input.field,
    required: input.required,
    state,
    fetchedAt: input.fetchedAt,
    observedAt,
    sourceStatus: `${successful.length}/${calls.length}_SOURCES_AVAILABLE`,
    quality,
    details: {
      requested: calls.length,
      available: successful.length,
      calls: calls.map((call) => ({
        endpoint: call.url,
        ok: call.ok,
        status: call.status,
        durationMs: call.durationMs,
        explicitTimestamp: newestIso(collectTimestamps(call.data)),
      })),
    },
    errors: state === "FRESH" ? [] : [...errors, `${input.field}_${state}`],
    endpoints: input.urls,
    now: input.now,
  });
}

function fieldUrls(input: {
  field: MlbP1M2aField;
  baseUrl: string;
  gamePk: number;
  homeCode: string;
  awayCode: string;
}): string[] {
  const root = input.baseUrl;
  const gamePk = input.gamePk;
  if (input.field === "BULLPEN") {
    return [`${root}/api/mlb/bullpen-status/${gamePk}`];
  }
  if (input.field === "PITCHER_FORM") {
    return [
      `${root}/api/mlb/pitcher-form/${gamePk}`,
      `${root}/api/mlb/pitcher-recent/${gamePk}`,
    ];
  }
  if (input.field === "LINEUP_MATCHUP") {
    return [`${root}/api/mlb/lineup-matchup/${gamePk}`];
  }
  if (input.field === "ENVIRONMENT") {
    return [
      `${root}/api/mlb/wind-park/${gamePk}`,
      `${root}/api/mlb/team-fatigue/${gamePk}`,
      `${root}/api/mlb/context?home=${encodeURIComponent(input.homeCode)}&away=${encodeURIComponent(input.awayCode)}&gamePk=${gamePk}`,
    ];
  }
  if (input.field === "UMPIRE") {
    return [`${root}/api/mlb/umpire/${gamePk}`];
  }
  if (input.field === "ADVANCED_FACTORS") {
    return [
      `${root}/api/mlb/quality/${gamePk}`,
      `${root}/api/mlb/statcast-matchup/${gamePk}`,
      `${root}/api/mlb/discipline-speed/${gamePk}`,
      `${root}/api/mlb/sos/${gamePk}`,
      `${root}/api/mlb/advanced/${gamePk}`,
    ];
  }
  return [];
}

function analysisTeamCode(analysisGame: any, side: "home" | "away", fallback: string | null): string {
  const team = analysisGame?.[`${side}Team`] ?? analysisGame?.teams?.[side] ?? {};
  return cleanText(team?.tricode ?? team?.abbreviation ?? team?.abbr ?? team?.name ?? fallback);
}

export async function buildMlbP1M2bPregameReadiness(options: {
  gamePk: number;
  market: MlbP1M2aMarket;
  dateHint?: string | null;
  manualOdds?: MlbP1M2bManualOdds | null;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  now?: Date;
  timeoutMs?: number;
}): Promise<MlbP1M2bReadinessReport> {
  const gamePk = positiveInteger(options.gamePk);
  if (!gamePk) throw new Error("INVALID_GAME_PK");
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? SELF_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 15_000);
  const required = new Set(requiredFieldsFor(options.market));

  const dateResolution = await resolveDateByGamePk(
    gamePk,
    options.dateHint ?? null,
    fetchImpl,
    generatedAt,
    timeoutMs,
  );
  const officialDate = dateResolution.date;
  const evidence = new Map<MlbP1M2aField, MlbP1M2bEvidenceEnvelope>();
  let officialGame: OfficialGame | null = null;
  let analysisGame: any | null = null;

  if (!officialDate) {
    for (const field of ["GAME_IDENTITY", "PITCHERS", "LINEUPS"] as const) {
      evidence.set(field, evidenceEnvelope({
        field,
        required: required.has(field),
        state: "MISSING",
        fetchedAt: generatedAt,
        observedAt: null,
        sourceStatus: "OFFICIAL_DATE_UNAVAILABLE",
        quality: "UNAVAILABLE",
        errors: [dateResolution.error || "OFFICIAL_DATE_UNAVAILABLE"],
        now,
      }));
    }
  } else {
    const slateEndpoint = `/api/mlb/p1/v1/slate?date=${encodeURIComponent(officialDate)}`;
    const slateCall = await fetchJson(fetchImpl, `${baseUrl}${slateEndpoint}`, generatedAt, timeoutMs);
    const slate = slateCall.data?.data ?? slateCall.data;
    const games: any[] = Array.isArray(slate?.games) ? slate.games : [];
    officialGame = games.find((game: any) => positiveInteger(game?.gamePk) === gamePk) ?? null;
    for (const item of officialEvidence(officialGame, slateCall, required, now)) {
      evidence.set(item.field, item);
    }

    const analysisEndpoint = `/api/mlb/all?date=${encodeURIComponent(officialDate)}`;
    const analysisCall = await fetchJson(fetchImpl, `${baseUrl}${analysisEndpoint}`, generatedAt, timeoutMs);
    analysisGame = findAnalysisGame(analysisCall.data, gamePk);
    evidence.set("INJURIES", injuryEvidence(analysisCall, analysisGame, required.has("INJURIES"), now));

    if (officialGame) {
      const odds = options.manualOdds
        ? manualOddsEvidence(options.market, options.manualOdds, required.has("MARKET_ODDS"), generatedAt, now)
        : await automaticOddsEvidence({
            market: options.market,
            date: officialDate,
            officialGame,
            fetchImpl,
            baseUrl,
            fetchedAt: generatedAt,
            timeoutMs,
            required: required.has("MARKET_ODDS"),
            now,
          });
      evidence.set("MARKET_ODDS", odds);
    }
  }

  if (!evidence.has("INJURIES")) {
    evidence.set("INJURIES", evidenceEnvelope({
      field: "INJURIES",
      required: required.has("INJURIES"),
      state: "MISSING",
      fetchedAt: generatedAt,
      sourceStatus: "OFFICIAL_GAME_UNAVAILABLE",
      quality: "UNAVAILABLE",
      errors: ["INJURY_LOOKUP_NOT_RUN"],
      now,
    }));
  }
  if (!evidence.has("MARKET_ODDS")) {
    evidence.set("MARKET_ODDS", evidenceEnvelope({
      field: "MARKET_ODDS",
      required: required.has("MARKET_ODDS"),
      state: "MISSING",
      fetchedAt: generatedAt,
      sourceStatus: "OFFICIAL_GAME_UNAVAILABLE",
      quality: "UNAVAILABLE",
      errors: ["MARKET_LOOKUP_NOT_RUN"],
      now,
    }));
  }

  const homeCode = analysisTeamCode(analysisGame, "home", officialGame?.homeTeam.name ?? null);
  const awayCode = analysisTeamCode(analysisGame, "away", officialGame?.awayTeam.name ?? null);
  const derivedFields = MLB_P1_M2A_MARKET_REQUIREMENTS[options.market];
  if (officialGame) {
    await Promise.all(derivedFields.map(async (field) => {
      const urls = fieldUrls({ field, baseUrl, gamePk, homeCode, awayCode });
      if (urls.length === 0) return;
      evidence.set(field, await derivedEvidence({
        field,
        urls,
        fetchImpl,
        fetchedAt: generatedAt,
        timeoutMs,
        required: required.has(field),
        now,
      }));
    }));
  } else {
    for (const field of derivedFields) {
      evidence.set(field, evidenceEnvelope({
        field,
        required: required.has(field),
        state: "MISSING",
        fetchedAt: generatedAt,
        sourceStatus: "OFFICIAL_GAME_UNAVAILABLE",
        quality: "UNAVAILABLE",
        errors: [`${field}_LOOKUP_NOT_RUN`],
        now,
      }));
    }
  }

  for (const field of FIELD_ORDER) {
    if (!evidence.has(field)) evidence.set(field, notRequiredEvidence(field, generatedAt, now));
  }

  const normalizedState = normalizeGameState(officialGame?.state ?? "UNKNOWN");
  const evidenceStates = Object.fromEntries(
    [...evidence.entries()].map(([field, item]) => [field, item.state]),
  ) as Partial<Record<MlbP1M2aField, MlbP1M2aEvidenceState>>;
  const gate = decideMlbP1M2aPregameGate({
    market: options.market,
    gameState: normalizedState,
    evidence: evidenceStates,
  });

  const orderedEvidence = FIELD_ORDER.map((field) => evidence.get(field)!);
  const warnings = [
    ...orderedEvidence
      .filter((item) => item.required && item.state !== "FRESH")
      .map((item) => `${item.field}_${item.state}`),
    ...orderedEvidence
      .filter((item) => item.quality === "REQUEST_TIME_ONLY")
      .map((item) => `${item.field}_REQUEST_TIME_ONLY`),
  ];
  const count = (state: MlbP1M2aEvidenceState) =>
    orderedEvidence.filter((item) => item.required && item.state === state).length;

  return {
    schemaVersion: MLB_P1_M2B_SCHEMA,
    contractSchemaVersion: MLB_P1_M2A_SCHEMA,
    generatedAt,
    market: options.market,
    game: {
      gamePk,
      officialDate: officialGame?.officialDate ?? officialDate,
      startTime: officialGame?.startTime ?? null,
      state: normalizedState,
      detailedState: officialGame?.detailedState ?? null,
      homeTeam: officialGame?.homeTeam ?? { id: null, name: null },
      awayTeam: officialGame?.awayTeam ?? { id: null, name: null },
    },
    gate,
    evidence: orderedEvidence,
    summary: {
      requiredFields: requiredFieldsFor(options.market),
      fresh: count("FRESH"),
      stale: count("STALE"),
      degraded: count("DEGRADED"),
      missing: count("MISSING"),
      conflict: count("CONFLICT"),
      unknown: count("UNKNOWN"),
    },
    warnings: Array.from(new Set(warnings)),
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
