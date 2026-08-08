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
type GameState = "SCHEDULED" | "PREGAME" | "IN_PROGRESS" | "FINAL" | "CLOSED" | "UNKNOWN";

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
    state: GameState;
    detailedState: string | null;
    homeTeam: { id: number | null; name: string | null };
    awayTeam: { id: number | null; name: string | null };
  };
  gate: ReturnType<typeof decideMlbP1M2aPregameGate>;
  evidence: MlbP1M2bEvidenceEnvelope[];
  summary: Record<"fresh" | "stale" | "degraded" | "missing" | "conflict" | "unknown", number> & {
    requiredFields: MlbP1M2aField[];
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

interface Call {
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
  "GAME_IDENTITY", "PITCHERS", "LINEUPS", "INJURIES", "MARKET_ODDS",
  "BULLPEN", "PITCHER_FORM", "LINEUP_MATCHUP", "ENVIRONMENT", "UMPIRE", "ADVANCED_FACTORS",
];

const TIMESTAMP_KEYS = new Set([
  "observedAt", "generatedAt", "fetchedAt", "capturedAt",
  "providerLastUpdate", "updatedAt", "lastUpdate", "lastUpdated",
]);

const clean = (value: unknown) => String(value ?? "").trim();
const finite = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
const positiveInt = (value: unknown) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

function iso(value: unknown): string | null {
  const text = clean(value);
  const parsed = text ? Date.parse(text) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function newest(values: readonly unknown[]): string | null {
  return values.map(iso).filter((value): value is string => value != null)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function oldest(values: readonly unknown[]): string | null {
  return values.map(iso).filter((value): value is string => value != null)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

function collectTimes(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 4 || !value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const result: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (TIMESTAMP_KEYS.has(key)) {
      const parsed = iso(child);
      if (parsed) result.push(parsed);
    }
    if (child && typeof child === "object") result.push(...collectTimes(child, depth + 1, seen));
  }
  return result;
}

function definitions(field: MlbP1M2aField) {
  return MLB_P1_M2A_SOURCE_INVENTORY.filter((source) => source.field === field);
}

function maxAge(field: MlbP1M2aField): number {
  const values = definitions(field).map((source) => source.requiredMaxAgeSeconds);
  return values.length ? Math.min(...values) : 300;
}

function detailedAdvancedDefinitions() {
  return definitions("ADVANCED_FACTORS").filter((source) => source.id !== "aggregate-analysis-payload");
}

function detailedAdvancedMaxAge(): number {
  const values = detailedAdvancedDefinitions().map((source) => source.requiredMaxAgeSeconds);
  return values.length ? Math.min(...values) : maxAge("ADVANCED_FACTORS");
}

function requiredFor(market: MlbP1M2aMarket): MlbP1M2aField[] {
  return Array.from(new Set([
    ...MLB_P1_M2A_HARD_BLOCKING_FIELDS,
    ...MLB_P1_M2A_FINAL_ONLY_FIELDS,
    ...MLB_P1_M2A_MARKET_REQUIREMENTS[market],
  ]));
}

function envelope(input: {
  field: MlbP1M2aField;
  required: boolean;
  state: MlbP1M2aEvidenceState;
  fetchedAt: string;
  now: Date;
  observedAt?: string | null;
  sourceStatus: string;
  quality: string;
  details?: Record<string, unknown>;
  errors?: string[];
  sourceIds?: string[];
  endpoints?: string[];
  authority?: string;
  maxAgeSeconds?: number;
}): MlbP1M2bEvidenceEnvelope {
  const sources = definitions(input.field);
  const observedAt = input.observedAt ?? null;
  return {
    field: input.field,
    required: input.required,
    state: input.state,
    sourceIds: input.sourceIds ?? sources.map((source) => source.id),
    endpoints: input.endpoints ?? sources.map((source) => source.endpoint),
    authority: input.authority ?? (sources.map((source) => source.authority).join("+") || "UNKNOWN"),
    fetchedAt: input.fetchedAt,
    observedAt,
    ageSeconds: observedAt ? Math.max(0, Math.round((input.now.getTime() - Date.parse(observedAt)) / 1000)) : null,
    maxAgeSeconds: input.maxAgeSeconds ?? maxAge(input.field),
    sourceStatus: input.sourceStatus,
    quality: input.quality,
    details: input.details ?? {},
    errors: input.errors ?? [],
  };
}

function usable(data: any): boolean {
  return data != null && data?.success !== false && !(data?.error && Object.keys(data).length <= 5);
}

async function fetchJson(fetchImpl: FetchLike, url: string, fetchedAt: string, timeoutMs: number): Promise<Call> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    let data: any;
    try { data = await response.json(); }
    catch {
      return { url, ok: false, status: response.status, data: null, fetchedAt, durationMs: Date.now() - started, error: "INVALID_JSON" };
    }
    const ok = response.ok && usable(data);
    return {
      url, ok, status: response.status, data, fetchedAt, durationMs: Date.now() - started,
      error: ok ? null : clean(data?.error || data?.message || `HTTP_${response.status}`),
    };
  } catch (error: any) {
    return {
      url, ok: false, status: 0, data: null, fetchedAt, durationMs: Date.now() - started,
      error: error?.name === "AbortError" ? "TIMEOUT" : clean(error?.message || error || "FETCH_FAILED"),
    };
  } finally {
    clearTimeout(timer);
  }
}

function gameState(value: unknown): GameState {
  const state = clean(value).toUpperCase();
  if (state === "SCHEDULED" || state === "PREGAME" || state === "IN_PROGRESS" || state === "FINAL") return state;
  if (["POSTPONED", "CANCELLED", "SUSPENDED", "CLOSED"].includes(state)) return "CLOSED";
  return "UNKNOWN";
}

function teamKey(value: unknown): string {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

const startTime = (game: any) => iso(game?.commence ?? game?.commenceTime ?? game?.startTime ?? game?.gameDate);

function chooseMarketGame(games: any[], official: OfficialGame): { game: any | null; conflict: string | null } {
  const matches = games.filter((game) =>
    teamKey(game?.homeTeam ?? game?.home_team ?? game?.home?.name) === teamKey(official.homeTeam.name)
    && teamKey(game?.awayTeam ?? game?.away_team ?? game?.away?.name) === teamKey(official.awayTeam.name)
  );
  if (!matches.length) return { game: null, conflict: null };
  if (matches.length === 1) {
    const candidate = startTime(matches[0]);
    if (official.startTime && candidate && Math.abs(Date.parse(candidate) - Date.parse(official.startTime)) > 21_600_000) {
      return { game: null, conflict: "MARKET_START_TIME_MISMATCH" };
    }
    return { game: matches[0], conflict: null };
  }
  if (!official.startTime) return { game: null, conflict: "AMBIGUOUS_DOUBLEHEADER_WITHOUT_START_TIME" };
  const ranked = matches.map((game) => {
    const candidate = startTime(game);
    return { game, delta: candidate ? Math.abs(Date.parse(candidate) - Date.parse(official.startTime!)) : Infinity };
  }).sort((a, b) => a.delta - b.delta);
  if (!Number.isFinite(ranked[0]?.delta) || ranked[0].delta > 21_600_000) {
    return { game: null, conflict: "AMBIGUOUS_OR_MISMATCHED_DOUBLEHEADER" };
  }
  if (ranked[1]?.delta === ranked[0].delta) return { game: null, conflict: "AMBIGUOUS_DOUBLEHEADER_TIME_TIE" };
  return { game: ranked[0].game, conflict: null };
}

function validMarket(market: MlbP1M2aMarket, game: any): boolean {
  if (market === "ML") return isStandardAmericanOdds(game?.ml?.home) && isStandardAmericanOdds(game?.ml?.away);
  if (market === "RUN_LINE") {
    return finite(game?.spread?.line) != null && isStandardAmericanOdds(game?.spread?.homeOdds) && isStandardAmericanOdds(game?.spread?.awayOdds);
  }
  if (market === "TOTAL") {
    return finite(game?.total?.line) != null && isStandardAmericanOdds(game?.total?.overOdds) && isStandardAmericanOdds(game?.total?.underOdds);
  }
  if (market === "F5_ML") return isStandardAmericanOdds(game?.f5Ml?.home) && isStandardAmericanOdds(game?.f5Ml?.away);
  return finite(game?.f5Total?.line) != null
    && isStandardAmericanOdds(game?.f5Total?.overOdds)
    && isStandardAmericanOdds(game?.f5Total?.underOdds);
}

export function validateMlbP1M2bManualOdds(market: MlbP1M2aMarket, manual: MlbP1M2bManualOdds): string[] {
  const errors: string[] = [];
  if (!clean(manual.book)) errors.push("MANUAL_BOOK_REQUIRED");
  if (!iso(manual.capturedAt)) errors.push("MANUAL_CAPTURED_AT_INVALID");
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

async function resolveDate(
  gamePk: number,
  hint: string | null,
  fetchImpl: FetchLike,
  fetchedAt: string,
  timeoutMs: number,
): Promise<{ date: string | null; error: string | null }> {
  if (hint) return isValidMlbP1Date(hint)
    ? { date: hint, error: null }
    : { date: null, error: "INVALID_DATE_HINT" };
  const call = await fetchJson(fetchImpl, `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`, fetchedAt, timeoutMs);
  const date = clean(call.data?.gameData?.datetime?.officialDate);
  return isValidMlbP1Date(date)
    ? { date, error: null }
    : { date: null, error: call.error || "OFFICIAL_DATE_UNAVAILABLE" };
}

function officialEvidence(
  game: OfficialGame | null,
  call: Call,
  required: Set<MlbP1M2aField>,
  now: Date,
): MlbP1M2bEvidenceEnvelope[] {
  if (!game) {
    return (["GAME_IDENTITY", "PITCHERS", "LINEUPS"] as const).map((field) => envelope({
      field, required: required.has(field), state: field === "GAME_IDENTITY" && call.ok ? "CONFLICT" : "MISSING",
      fetchedAt: call.fetchedAt, now, sourceStatus: call.ok ? "GAME_NOT_FOUND" : "SOURCE_UNAVAILABLE",
      quality: "UNAVAILABLE", errors: [call.error || "GAME_NOT_FOUND_IN_OFFICIAL_SLATE"],
    }));
  }

  const observedAt = iso(game.source?.fetchedAt) ?? iso(call.data?.data?.generatedAt);
  const quality = clean(game.source?.quality).toUpperCase();
  const freshness = (field: MlbP1M2aField) => classifyMlbP1M2aFreshness({ observedAt, now, maxAgeSeconds: maxAge(field) });
  const identity = quality === "DEGRADED" ? "DEGRADED" : freshness("GAME_IDENTITY");
  const pitchers = game.homePitcher?.confirmed && game.awayPitcher?.confirmed
    ? (quality === "DEGRADED" ? "DEGRADED" : freshness("PITCHERS"))
    : "MISSING";
  const lineupLabel = clean(game.lineupState).toUpperCase();
  const lineups: MlbP1M2aEvidenceState = lineupLabel === "CONFIRMED"
    ? (quality === "DEGRADED" ? "DEGRADED" : freshness("LINEUPS"))
    : lineupLabel === "PARTIAL" ? "DEGRADED"
      : lineupLabel === "UNKNOWN" ? "UNKNOWN" : "MISSING";

  return [
    envelope({
      field: "GAME_IDENTITY", required: required.has("GAME_IDENTITY"), state: identity,
      fetchedAt: call.fetchedAt, observedAt, now, sourceStatus: quality || "AUTHORITATIVE",
      quality: quality === "DEGRADED" ? "DEGRADED" : "AUTHORITATIVE",
      details: { gamePk: game.gamePk, officialDate: game.officialDate, state: game.state, detailedState: game.detailedState },
      errors: identity === "FRESH" ? [] : [`GAME_IDENTITY_${identity}`],
    }),
    envelope({
      field: "PITCHERS", required: required.has("PITCHERS"), state: pitchers,
      fetchedAt: call.fetchedAt, observedAt, now,
      sourceStatus: game.homePitcher?.confirmed && game.awayPitcher?.confirmed ? "BOTH_IDENTIFIED" : "PITCHER_MISSING",
      quality: quality === "DEGRADED" ? "DEGRADED" : "AUTHORITATIVE",
      details: { home: game.homePitcher ?? null, away: game.awayPitcher ?? null },
      errors: pitchers === "FRESH" ? [] : [`PITCHERS_${pitchers}`],
    }),
    envelope({
      field: "LINEUPS", required: required.has("LINEUPS"), state: lineups,
      fetchedAt: call.fetchedAt, observedAt, now, sourceStatus: lineupLabel || "UNKNOWN",
      quality: quality === "DEGRADED" ? "DEGRADED" : "AUTHORITATIVE",
      details: { lineupState: lineupLabel, homeLineupCount: game.homeLineupCount ?? 0, awayLineupCount: game.awayLineupCount ?? 0 },
      errors: lineups === "FRESH" ? [] : [`LINEUPS_${lineups}`],
    }),
  ];
}

function analysisGame(payload: any, gamePk: number): any | null {
  const games = Array.isArray(payload?.games) ? payload.games
    : Array.isArray(payload?.data?.games) ? payload.data.games : [];
  return games.find((game: any) => positiveInt(game?.gamePk ?? game?.gameId ?? game?.id) === gamePk) ?? null;
}

function injuries(call: Call, game: any | null, required: boolean, now: Date): MlbP1M2bEvidenceEnvelope {
  if (!call.ok || !game) {
    return envelope({
      field: "INJURIES", required, state: call.ok ? "CONFLICT" : "MISSING",
      fetchedAt: call.fetchedAt, now, sourceStatus: call.ok ? "GAME_NOT_FOUND" : "SOURCE_UNAVAILABLE",
      quality: "UNAVAILABLE", errors: [call.error || "INJURY_GAME_NOT_FOUND"],
    });
  }
  const home = game.homeInjuryData;
  const away = game.awayInjuryData;
  if (!home || !away) {
    return envelope({
      field: "INJURIES", required, state: "MISSING", fetchedAt: call.fetchedAt, now,
      sourceStatus: "METADATA_MISSING", quality: "UNAVAILABLE",
      details: { homePresent: Boolean(home), awayPresent: Boolean(away) }, errors: ["INJURY_METADATA_MISSING"],
    });
  }
  const statuses = [clean(home.status).toUpperCase(), clean(away.status).toUpperCase()];
  const observedAt = newest([home.fetchedAt, home.officialFetchedAt, away.fetchedAt, away.officialFetchedAt]);
  const freshness = classifyMlbP1M2aFreshness({ observedAt, now, maxAgeSeconds: maxAge("INJURIES") });
  let state: MlbP1M2aEvidenceState;
  if (statuses.includes("SOURCE_UNAVAILABLE")) state = "MISSING";
  else if (freshness === "STALE" || home.stale === true || away.stale === true) state = "STALE";
  else if (statuses.every((status) => status === "VERIFIED") && freshness === "FRESH") state = "FRESH";
  else state = observedAt ? "DEGRADED" : "UNKNOWN";
  return envelope({
    field: "INJURIES", required, state, fetchedAt: call.fetchedAt, observedAt, now,
    sourceStatus: statuses.join("+") || "UNKNOWN", quality: state === "FRESH" ? "VALIDATED_EXTERNAL" : "DEGRADED",
    details: {
      home: { status: home.status ?? null, stale: home.stale ?? null, count: home.count ?? game.homeInjuries?.length ?? null },
      away: { status: away.status ?? null, stale: away.stale ?? null, count: away.count ?? game.awayInjuries?.length ?? null },
    },
    errors: state === "FRESH" ? [] : [`INJURIES_${state}`],
  });
}

function manualOdds(
  market: MlbP1M2aMarket,
  snapshot: MlbP1M2bManualOdds,
  required: boolean,
  fetchedAt: string,
  now: Date,
): MlbP1M2bEvidenceEnvelope {
  const errors = validateMlbP1M2bManualOdds(market, snapshot);
  const observedAt = iso(snapshot.capturedAt);
  const freshness = classifyMlbP1M2aFreshness({ observedAt, now, maxAgeSeconds: maxAge("MARKET_ODDS") });
  const state: MlbP1M2aEvidenceState = errors.length ? "CONFLICT" : freshness;
  return envelope({
    field: "MARKET_ODDS", required, state, fetchedAt, observedAt, now,
    sourceStatus: "MANUAL_OVERRIDE", quality: "USER_VERIFIED_MARKET_SNAPSHOT",
    sourceIds: ["manual-market-odds"], endpoints: [], authority: "MARKET",
    details: {
      book: snapshot.book, market, line: snapshot.line ?? null,
      homeOdds: snapshot.homeOdds ?? null, awayOdds: snapshot.awayOdds ?? null,
      overOdds: snapshot.overOdds ?? null, underOdds: snapshot.underOdds ?? null,
    },
    errors: errors.length ? errors : state === "FRESH" ? [] : [`MARKET_ODDS_${state}`],
  });
}

async function autoOdds(input: {
  market: MlbP1M2aMarket;
  date: string;
  official: OfficialGame;
  fetchImpl: FetchLike;
  baseUrl: string;
  fetchedAt: string;
  timeoutMs: number;
  required: boolean;
  now: Date;
}): Promise<MlbP1M2bEvidenceEnvelope> {
  const endpoint = input.market.startsWith("F5_")
    ? `/api/odds/mlb/f5?date=${encodeURIComponent(input.date)}`
    : `/api/odds/mlb?date=${encodeURIComponent(input.date)}`;
  const call = await fetchJson(input.fetchImpl, `${input.baseUrl}${endpoint}`, input.fetchedAt, input.timeoutMs);
  if (!call.ok) {
    return envelope({
      field: "MARKET_ODDS", required: input.required, state: "MISSING", fetchedAt: call.fetchedAt, now: input.now,
      sourceStatus: "SOURCE_UNAVAILABLE", quality: "UNAVAILABLE", endpoints: [endpoint],
      details: { endpoint }, errors: [call.error || "MARKET_ODDS_UNAVAILABLE"],
    });
  }
  const games = Array.isArray(call.data?.games) ? call.data.games
    : Array.isArray(call.data?.data?.games) ? call.data.data.games : [];
  const selected = chooseMarketGame(games, input.official);
  if (selected.conflict || !selected.game) {
    const conflict = Boolean(selected.conflict);
    return envelope({
      field: "MARKET_ODDS", required: input.required, state: conflict ? "CONFLICT" : "MISSING",
      fetchedAt: call.fetchedAt, now: input.now, sourceStatus: conflict ? "IDENTITY_CONFLICT" : "GAME_MARKET_NOT_FOUND",
      quality: conflict ? "CONFLICT" : "UNAVAILABLE", endpoints: [endpoint],
      details: { endpoint, candidateCount: games.length }, errors: [selected.conflict || "MARKET_GAME_NOT_FOUND"],
    });
  }
  if (!validMarket(input.market, selected.game)) {
    return envelope({
      field: "MARKET_ODDS", required: input.required, state: "MISSING", fetchedAt: call.fetchedAt, now: input.now,
      sourceStatus: "SELECTED_MARKET_INCOMPLETE", quality: "UNAVAILABLE", endpoints: [endpoint],
      details: { endpoint, source: selected.game.source ?? call.data?.source ?? null },
      errors: ["SELECTED_MARKET_QUOTES_INCOMPLETE"],
    });
  }
  const explicit = newest([
    selected.game.providerLastUpdate, selected.game.capturedAt,
    selected.game.provenance?.providerLastUpdate, selected.game.provenance?.capturedAt,
    call.data?.generatedAt,
  ]);
  const observedAt = explicit ?? call.fetchedAt;
  const state = classifyMlbP1M2aFreshness({ observedAt, now: input.now, maxAgeSeconds: maxAge("MARKET_ODDS") });
  const quote = input.market === "ML" ? selected.game.ml
    : input.market === "RUN_LINE" ? selected.game.spread
      : input.market === "TOTAL" ? selected.game.total
        : input.market === "F5_ML" ? selected.game.f5Ml : selected.game.f5Total;
  return envelope({
    field: "MARKET_ODDS", required: input.required, state, fetchedAt: call.fetchedAt, observedAt, now: input.now,
    sourceStatus: explicit ? "EXPLICIT_PROVIDER_TIME" : "REQUEST_TIME_ONLY",
    quality: explicit ? "MARKET_PROVENANCE" : "REQUEST_TIME_ONLY", endpoints: [endpoint],
    details: { endpoint, source: selected.game.source ?? call.data?.source ?? null, commence: startTime(selected.game), quote },
    errors: state === "FRESH" ? [] : [`MARKET_ODDS_${state}`],
  });
}

function fieldUrls(field: MlbP1M2aField, base: string, gamePk: number, home: string, away: string): string[] {
  if (field === "BULLPEN") return [`${base}/api/mlb/bullpen-status/${gamePk}`];
  if (field === "PITCHER_FORM") return [`${base}/api/mlb/pitcher-form/${gamePk}`, `${base}/api/mlb/pitcher-recent/${gamePk}`];
  if (field === "LINEUP_MATCHUP") return [`${base}/api/mlb/lineup-matchup/${gamePk}`];
  if (field === "ENVIRONMENT") return [
    `${base}/api/mlb/wind-park/${gamePk}`,
    `${base}/api/mlb/team-fatigue/${gamePk}`,
    `${base}/api/mlb/context?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&gamePk=${gamePk}`,
  ];
  if (field === "UMPIRE") return [`${base}/api/mlb/umpire/${gamePk}`];
  if (field === "ADVANCED_FACTORS") return [
    `${base}/api/mlb/quality/${gamePk}`, `${base}/api/mlb/statcast-matchup/${gamePk}`,
    `${base}/api/mlb/discipline-speed/${gamePk}`, `${base}/api/mlb/sos/${gamePk}`,
    `${base}/api/mlb/advanced/${gamePk}`,
  ];
  return [];
}

function advancedComponentStatus(data: any): string | null {
  const status = clean(
    data?.sourceStatus
    ?? data?.provenance?.sourceStatus
    ?? data?.provenance?.status,
  ).toUpperCase();
  return status || null;
}

function advancedComponentTime(data: any): string | null {
  return oldest([
    data?.observedAt,
    data?.generatedAt,
    data?.fetchedAt,
    data?.providerLastUpdate,
    data?.provenance?.observedAt,
    data?.provenance?.generatedAt,
    data?.provenance?.fetchedAt,
    data?.provenance?.providerLastUpdate,
  ]);
}

async function advancedDerived(
  urls: string[],
  fetchImpl: FetchLike,
  fetchedAt: string,
  timeoutMs: number,
  required: boolean,
  now: Date,
): Promise<MlbP1M2bEvidenceEnvelope> {
  const calls = await Promise.all(urls.map((url) => fetchJson(fetchImpl, url, fetchedAt, timeoutMs)));
  const successful = calls.filter((call) => call.ok);
  const maxAgeSeconds = detailedAdvancedMaxAge();
  const components = calls.map((call) => {
    const explicitTimestamp = call.ok ? advancedComponentTime(call.data) : null;
    const sourceStatus = call.ok ? advancedComponentStatus(call.data) : null;
    const certified = sourceStatus === "CERTIFIED";
    const freshness = explicitTimestamp
      ? classifyMlbP1M2aFreshness({ observedAt: explicitTimestamp, now, maxAgeSeconds })
      : "UNKNOWN";
    return {
      endpoint: call.url,
      ok: call.ok,
      status: call.status,
      durationMs: call.durationMs,
      sourceStatus,
      certified,
      explicitTimestamp,
      freshness,
      error: call.error,
    };
  });
  const observedAt = oldest(components.map((component) => component.explicitTimestamp));
  const uncertified = components.filter((component) => component.ok && !component.certified);
  const untimed = components.filter((component) => component.ok && !component.explicitTimestamp);
  const stale = components.filter((component) => component.ok && component.explicitTimestamp && component.freshness === "STALE");
  const unknownFreshness = components.filter((component) => component.ok && component.explicitTimestamp && component.freshness === "UNKNOWN");

  let state: MlbP1M2aEvidenceState;
  let quality: string;
  if (!successful.length) {
    state = "MISSING";
    quality = "UNAVAILABLE";
  } else if (successful.length < calls.length) {
    state = "DEGRADED";
    quality = "PARTIAL_SOURCE_COVERAGE";
  } else if (uncertified.length > 0) {
    state = "DEGRADED";
    quality = "ADVANCED_COMPONENT_NOT_CERTIFIED";
  } else if (untimed.length > 0) {
    state = "DEGRADED";
    quality = "ADVANCED_COMPONENT_WITHOUT_EXPLICIT_TIMESTAMP";
  } else if (stale.length > 0) {
    state = "STALE";
    quality = "CERTIFIED_COMPONENT_SET_STALE";
  } else if (unknownFreshness.length > 0 || !observedAt) {
    state = "DEGRADED";
    quality = "CERTIFIED_COMPONENT_TIME_UNKNOWN";
  } else {
    state = "FRESH";
    quality = "CERTIFIED_COMPONENT_SET";
  }

  const detailedSources = detailedAdvancedDefinitions();
  const errors = [
    ...calls.filter((call) => !call.ok).map((call) => `${call.url}: ${call.error || "FAILED"}`),
    ...uncertified.map((component) => `${component.endpoint}: ADVANCED_COMPONENT_UNCERTIFIED:${component.sourceStatus || "MISSING"}`),
    ...untimed.map((component) => `${component.endpoint}: ADVANCED_COMPONENT_UNTIMED`),
    ...stale.map((component) => `${component.endpoint}: ADVANCED_COMPONENT_STALE`),
    ...unknownFreshness.map((component) => `${component.endpoint}: ADVANCED_COMPONENT_TIME_UNKNOWN`),
  ];
  if (state !== "FRESH") errors.push(`ADVANCED_FACTORS_${state}`);

  return envelope({
    field: "ADVANCED_FACTORS",
    required,
    state,
    fetchedAt,
    observedAt,
    now,
    sourceStatus: `${components.filter((component) => component.certified).length}/${calls.length}_COMPONENTS_CERTIFIED`,
    quality,
    endpoints: urls,
    sourceIds: detailedSources.map((source) => source.id),
    authority: detailedSources.map((source) => source.authority).join("+") || "DERIVED",
    maxAgeSeconds,
    details: {
      requested: calls.length,
      available: successful.length,
      certified: components.filter((component) => component.certified).length,
      timingPolicy: "OLDEST_CERTIFIED_COMPONENT",
      calls: components,
    },
    errors,
  });
}

async function derived(
  field: MlbP1M2aField,
  urls: string[],
  fetchImpl: FetchLike,
  fetchedAt: string,
  timeoutMs: number,
  required: boolean,
  now: Date,
): Promise<MlbP1M2bEvidenceEnvelope> {
  if (field === "ADVANCED_FACTORS") {
    return advancedDerived(urls, fetchImpl, fetchedAt, timeoutMs, required, now);
  }
  const calls = await Promise.all(urls.map((url) => fetchJson(fetchImpl, url, fetchedAt, timeoutMs)));
  const successful = calls.filter((call) => call.ok);
  const observedAt = newest(successful.flatMap((call) => collectTimes(call.data)));
  let state: MlbP1M2aEvidenceState;
  let quality: string;
  if (!successful.length) { state = "MISSING"; quality = "UNAVAILABLE"; }
  else if (successful.length < calls.length) { state = "DEGRADED"; quality = "PARTIAL_SOURCE_COVERAGE"; }
  else if (!observedAt) { state = "DEGRADED"; quality = "DERIVED_WITHOUT_EXPLICIT_TIMESTAMP"; }
  else {
    state = classifyMlbP1M2aFreshness({ observedAt, now, maxAgeSeconds: maxAge(field) });
    quality = state === "FRESH" ? "DERIVED_WITH_EXPLICIT_TIMESTAMP" : "DERIVED_STALE";
  }
  return envelope({
    field, required, state, fetchedAt, observedAt, now,
    sourceStatus: `${successful.length}/${calls.length}_SOURCES_AVAILABLE`, quality, endpoints: urls,
    details: {
      requested: calls.length, available: successful.length,
      calls: calls.map((call) => ({
        endpoint: call.url, ok: call.ok, status: call.status,
        durationMs: call.durationMs, explicitTimestamp: newest(collectTimes(call.data)),
      })),
    },
    errors: state === "FRESH"
      ? []
      : [...calls.filter((call) => !call.ok).map((call) => `${call.url}: ${call.error || "FAILED"}`), `${field}_${state}`],
  });
}

function teamCode(game: any, side: "home" | "away", fallback: string | null): string {
  const team = game?.[`${side}Team`] ?? game?.teams?.[side] ?? {};
  return clean(team.tricode ?? team.abbreviation ?? team.abbr ?? team.name ?? fallback);
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
  const gamePk = positiveInt(options.gamePk);
  if (!gamePk) throw new Error("INVALID_GAME_PK");
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? SELF_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 15_000);
  const required = new Set(requiredFor(options.market));
  const dateResult = await resolveDate(gamePk, options.dateHint ?? null, fetchImpl, fetchedAt, timeoutMs);
  const evidence = new Map<MlbP1M2aField, MlbP1M2bEvidenceEnvelope>();
  let official: OfficialGame | null = null;
  let aggregateGame: any | null = null;

  if (!dateResult.date) {
    for (const field of ["GAME_IDENTITY", "PITCHERS", "LINEUPS"] as const) {
      evidence.set(field, envelope({
        field, required: required.has(field), state: "MISSING", fetchedAt, now,
        sourceStatus: "OFFICIAL_DATE_UNAVAILABLE", quality: "UNAVAILABLE",
        errors: [dateResult.error || "OFFICIAL_DATE_UNAVAILABLE"],
      }));
    }
  } else {
    const slateCall = await fetchJson(
      fetchImpl, `${baseUrl}/api/mlb/p1/v1/slate?date=${encodeURIComponent(dateResult.date)}`, fetchedAt, timeoutMs,
    );
    const games = Array.isArray((slateCall.data?.data ?? slateCall.data)?.games)
      ? (slateCall.data?.data ?? slateCall.data).games : [];
    official = games.find((game: any) => positiveInt(game.gamePk) === gamePk) ?? null;
    for (const item of officialEvidence(official, slateCall, required, now)) evidence.set(item.field, item);

    const aggregateCall = await fetchJson(
      fetchImpl, `${baseUrl}/api/mlb/all?date=${encodeURIComponent(dateResult.date)}`, fetchedAt, timeoutMs,
    );
    aggregateGame = analysisGame(aggregateCall.data, gamePk);
    evidence.set("INJURIES", injuries(aggregateCall, aggregateGame, required.has("INJURIES"), now));

    if (official) {
      evidence.set("MARKET_ODDS", options.manualOdds
        ? manualOdds(options.market, options.manualOdds, required.has("MARKET_ODDS"), fetchedAt, now)
        : await autoOdds({
            market: options.market, date: dateResult.date, official, fetchImpl, baseUrl,
            fetchedAt, timeoutMs, required: required.has("MARKET_ODDS"), now,
          }));
    }
  }

  if (!evidence.has("INJURIES")) evidence.set("INJURIES", envelope({
    field: "INJURIES", required: required.has("INJURIES"), state: "MISSING", fetchedAt, now,
    sourceStatus: "OFFICIAL_GAME_UNAVAILABLE", quality: "UNAVAILABLE", errors: ["INJURY_LOOKUP_NOT_RUN"],
  }));
  if (!evidence.has("MARKET_ODDS")) evidence.set("MARKET_ODDS", envelope({
    field: "MARKET_ODDS", required: true, state: "MISSING", fetchedAt, now,
    sourceStatus: "OFFICIAL_GAME_UNAVAILABLE", quality: "UNAVAILABLE", errors: ["MARKET_LOOKUP_NOT_RUN"],
  }));

  const marketFields = MLB_P1_M2A_MARKET_REQUIREMENTS[options.market];
  if (official) {
    const home = teamCode(aggregateGame, "home", official.homeTeam.name);
    const away = teamCode(aggregateGame, "away", official.awayTeam.name);
    await Promise.all(marketFields.map(async (field) => {
      const urls = fieldUrls(field, baseUrl, gamePk, home, away);
      if (urls.length) evidence.set(field, await derived(field, urls, fetchImpl, fetchedAt, timeoutMs, required.has(field), now));
    }));
  } else {
    for (const field of marketFields) evidence.set(field, envelope({
      field, required: true, state: "MISSING", fetchedAt, now,
      sourceStatus: "OFFICIAL_GAME_UNAVAILABLE", quality: "UNAVAILABLE", errors: [`${field}_LOOKUP_NOT_RUN`],
    }));
  }

  for (const field of FIELD_ORDER) {
    if (!evidence.has(field)) evidence.set(field, envelope({
      field, required: false, state: "UNKNOWN", fetchedAt, now,
      sourceStatus: "NOT_REQUIRED_FOR_SELECTED_MARKET", quality: "NOT_LOADED",
    }));
  }

  const normalizedState = gameState(official?.state);
  const gate = decideMlbP1M2aPregameGate({
    market: options.market,
    gameState: normalizedState,
    evidence: Object.fromEntries([...evidence].map(([field, item]) => [field, item.state])),
  });
  const ordered = FIELD_ORDER.map((field) => evidence.get(field)!);
  const count = (state: MlbP1M2aEvidenceState) => ordered.filter((item) => item.required && item.state === state).length;

  return {
    schemaVersion: MLB_P1_M2B_SCHEMA,
    contractSchemaVersion: MLB_P1_M2A_SCHEMA,
    generatedAt: fetchedAt,
    market: options.market,
    game: {
      gamePk,
      officialDate: official?.officialDate ?? dateResult.date,
      startTime: official?.startTime ?? null,
      state: normalizedState,
      detailedState: official?.detailedState ?? null,
      homeTeam: official?.homeTeam ?? { id: null, name: null },
      awayTeam: official?.awayTeam ?? { id: null, name: null },
    },
    gate,
    evidence: ordered,
    summary: {
      requiredFields: requiredFor(options.market),
      fresh: count("FRESH"), stale: count("STALE"), degraded: count("DEGRADED"),
      missing: count("MISSING"), conflict: count("CONFLICT"), unknown: count("UNKNOWN"),
    },
    warnings: Array.from(new Set([
      ...ordered.filter((item) => item.required && item.state !== "FRESH").map((item) => `${item.field}_${item.state}`),
      ...ordered.filter((item) => item.quality === "REQUEST_TIME_ONLY").map((item) => `${item.field}_REQUEST_TIME_ONLY`),
    ])),
    safety: {
      mode: "SHADOW_DECISION_SUPPORT",
      realFinancialExposure: 0,
      automaticBetPlacement: false,
      automaticModelChangesAllowed: false,
      automaticPromotionAllowed: false,
    },
  };
}
