import type { Express } from "express";
import { buildMlbF5ConsensusGame, MLB_F5_CONSENSUS_METHOD, MLB_F5_ODDS_SCHEMA_VERSION } from "./mlb-f5-odds-routes";
import { FL_TZ, requireSecret } from "./route-runtime";

export const MLB_P1_BOUNDED_F5_SCHEMA_VERSION = "p0-bounded-f5-single-game.v1" as const;
export const MLB_P1_BOUNDED_F5_BOOKS = ["fanduel", "betmgm", "draftkings"] as const;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_START_DELTA_MS = 6 * 60 * 60 * 1000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ProviderEventSelection = {
  event: any | null;
  candidateCount: number;
  conflict: string | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function teamKey(value: unknown): string {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function iso(value: unknown): string | null {
  const text = clean(value);
  const parsed = text ? Date.parse(text) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function validDate(value: unknown): string | null {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === text ? text : null;
}

function floridaDate(value: unknown): string {
  const parsed = Date.parse(clean(value));
  if (!Number.isFinite(parsed)) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: FL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(parsed)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function selectMlbP1BoundedF5ProviderEvent(input: {
  events: any[];
  date: string;
  homeTeam: string;
  awayTeam: string;
  startTime?: string | null;
}): ProviderEventSelection {
  const home = teamKey(input.homeTeam);
  const away = teamKey(input.awayTeam);
  const candidates = (Array.isArray(input.events) ? input.events : []).filter((event) =>
    floridaDate(event?.commence_time) === input.date
    && teamKey(event?.home_team) === home
    && teamKey(event?.away_team) === away
  );
  if (candidates.length === 0) return { event: null, candidateCount: 0, conflict: null };
  if (candidates.length === 1) return { event: candidates[0], candidateCount: 1, conflict: null };

  const start = iso(input.startTime);
  if (!start) return { event: null, candidateCount: candidates.length, conflict: "AMBIGUOUS_MATCHUP_WITHOUT_START_TIME" };
  const startMs = Date.parse(start);
  const ranked = candidates.map((event) => {
    const eventStart = iso(event?.commence_time);
    return { event, delta: eventStart ? Math.abs(Date.parse(eventStart) - startMs) : Infinity };
  }).sort((left, right) => left.delta - right.delta);
  if (!Number.isFinite(ranked[0]?.delta) || ranked[0].delta > MAX_START_DELTA_MS) {
    return { event: null, candidateCount: candidates.length, conflict: "MATCHUP_START_TIME_MISMATCH" };
  }
  if (ranked[1]?.delta === ranked[0].delta) {
    return { event: null, candidateCount: candidates.length, conflict: "AMBIGUOUS_MATCHUP_START_TIME_TIE" };
  }
  return { event: ranked[0].event, candidateCount: candidates.length, conflict: null };
}

export function registerMlbP1BoundedF5OddsRoutes(
  app: Express,
  options: { fetchImpl?: FetchLike; apiKey?: string; now?: () => number } = {},
): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let eventCache: { fetchedAtMs: number; events: any[] } | null = null;
  const quoteCache = new Map<string, { fetchedAtMs: number; data: any }>();

  app.get("/api/mlb/p1/v1/bounded-f5-odds", async (req, res) => {
    const date = validDate(req.query.date);
    const homeTeam = clean(req.query.home);
    const awayTeam = clean(req.query.away);
    const startTime = clean(req.query.start) || null;
    if (!date || !homeTeam || !awayTeam || (startTime && !iso(startTime))) {
      return res.status(400).json({
        success: false,
        schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
        code: "INVALID_SINGLE_GAME_SCOPE",
        games: [],
      });
    }

    const key = `${date}|${teamKey(awayTeam)}@${teamKey(homeTeam)}|${iso(startTime) ?? "no-start"}`;
    const nowMs = now();
    for (const [cacheKey, cached] of quoteCache) {
      if (nowMs - cached.fetchedAtMs >= CACHE_TTL_MS) quoteCache.delete(cacheKey);
    }
    const cachedQuote = quoteCache.get(key);
    if (cachedQuote && nowMs - cachedQuote.fetchedAtMs < CACHE_TTL_MS) {
      return res.json({
        success: true,
        schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
        generatedAt: new Date(nowMs).toISOString(),
        games: [cachedQuote.data],
        source: cachedQuote.data?.source ?? "n/a",
        consensusMethod: MLB_F5_CONSENSUS_METHOD,
        acquisition: { mode: "SINGLE_GAME_ON_DEMAND", providerRequests: 0, eventListCacheHit: true, quoteCacheHit: true },
      });
    }

    try {
      const apiKey = options.apiKey ?? requireSecret("ODDS_API_KEY");
      let providerRequests = 0;
      let eventListCacheHit = false;
      let events: any[];
      if (eventCache && nowMs - eventCache.fetchedAtMs < CACHE_TTL_MS) {
        events = eventCache.events;
        eventListCacheHit = true;
      } else {
        providerRequests += 1;
        const response = await fetchImpl(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${apiKey}`);
        const body: any = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(body)) {
          return res.status(503).json({
            success: false,
            schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
            code: clean(body?.error_code) || `EVENT_LIST_HTTP_${response.status}`,
            games: [],
            acquisition: { mode: "SINGLE_GAME_ON_DEMAND", providerRequests, eventListCacheHit: false, quoteCacheHit: false },
          });
        }
        events = body;
        eventCache = { fetchedAtMs: nowMs, events };
      }

      const selected = selectMlbP1BoundedF5ProviderEvent({ events, date, homeTeam, awayTeam, startTime });
      if (selected.conflict) {
        return res.status(409).json({
          success: false,
          schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
          code: selected.conflict,
          games: [],
          candidateCount: selected.candidateCount,
          acquisition: { mode: "SINGLE_GAME_ON_DEMAND", providerRequests, eventListCacheHit, quoteCacheHit: false },
        });
      }
      if (!selected.event) {
        return res.json({
          success: true,
          schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
          generatedAt: new Date(nowMs).toISOString(),
          games: [],
          source: "n/a",
          consensusMethod: MLB_F5_CONSENSUS_METHOD,
          candidateCount: 0,
          acquisition: { mode: "SINGLE_GAME_ON_DEMAND", providerRequests, eventListCacheHit, quoteCacheHit: false },
        });
      }

      providerRequests += 1;
      const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${encodeURIComponent(String(selected.event.id))}/odds/?apiKey=${apiKey}&regions=us,us2&markets=h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings&oddsFormat=american&bookmakers=${MLB_P1_BOUNDED_F5_BOOKS.join(",")}`;
      const response = await fetchImpl(url);
      const body: any = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== "object") {
        return res.status(503).json({
          success: false,
          schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
          code: clean(body?.error_code) || `EVENT_ODDS_HTTP_${response.status}`,
          games: [],
          acquisition: { mode: "SINGLE_GAME_ON_DEMAND", providerRequests, eventListCacheHit, quoteCacheHit: false },
        });
      }

      const capturedAt = new Date(nowMs).toISOString();
      const game = buildMlbF5ConsensusGame(body, capturedAt);
      quoteCache.set(key, { fetchedAtMs: nowMs, data: game });
      return res.json({
        success: true,
        schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
        upstreamSchemaVersion: MLB_F5_ODDS_SCHEMA_VERSION,
        generatedAt: capturedAt,
        games: [game],
        source: game.source ?? "n/a",
        consensusMethod: MLB_F5_CONSENSUS_METHOD,
        candidateCount: selected.candidateCount,
        acquisition: { mode: "SINGLE_GAME_ON_DEMAND", providerRequests, eventListCacheHit, quoteCacheHit: false },
      });
    } catch (error: any) {
      return res.status(503).json({
        success: false,
        schemaVersion: MLB_P1_BOUNDED_F5_SCHEMA_VERSION,
        code: clean(error?.code) || "BOUNDED_F5_PROVIDER_FAILURE",
        games: [],
      });
    }
  });
}
