import type { Express } from "express";
import {
  MLB_EXECUTION_BOOK_PRIORITY,
  MLB_P1_M6A2_MAX_QUOTE_AGE_MS,
  MLB_P1_M6A2_PROVIDER_MARKETS,
  MLB_P1_M6A2_SCHEMA,
  MLB_REFERENCE_BOOKS,
  buildMlbMarketOddsUniverseGame,
  type MlbMarketOddsUniverseGame,
} from "./mlb-market-odds-normalizer";
import { FL_TZ, requireSecret } from "./route-runtime";

export const MLB_P1_M6A2_ENDPOINT = "/api/mlb/p1/v1/market-universe-odds" as const;
export const MLB_P1_M6A2_CACHE_TTL_MS = 60_000;
export const MLB_P1_M6A2_MAX_EVENTS_PER_REQUEST = 20;

export const MLB_P1_M6A2_BOOKMAKERS = [
  ...MLB_EXECUTION_BOOK_PRIORITY,
  ...MLB_REFERENCE_BOOKS,
] as const;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type ServiceOptions = {
  fetchFn?: FetchLike;
  now?: () => Date;
  cacheTtlMs?: number;
};

export interface MlbP1M6a2ProviderUsageSample {
  eventId: string;
  requestsLast: number | null;
  requestsRemaining: number | null;
  requestsUsed: number | null;
}

export interface MlbP1M6a2UniverseResponse {
  schemaVersion: typeof MLB_P1_M6A2_SCHEMA;
  generatedAt: string;
  date: string;
  games: MlbMarketOddsUniverseGame[];
  coverage: {
    eligibleEvents: number;
    fetchedGames: number;
    failedEvents: Array<{ eventId: string; code: string }>;
    complete: boolean;
  };
  providerUsage: {
    samples: MlbP1M6a2ProviderUsageSample[];
    totalReportedCost: number | null;
    minimumReportedRemaining: number | null;
  };
  policy: {
    executionBooks: readonly string[];
    referenceBooks: readonly string[];
    providerMarkets: readonly string[];
    maxQuoteAgeMs: number;
    bookmakerRegionEquivalents: 1;
    providerCostModel: "unique_markets_returned_x_bookmaker_region_equivalents";
    referenceQuotesExecutable: false;
    undocumentedMarketsInvented: false;
    threeWayCoercedToTwoWay: false;
    partialSlateCached: false;
  };
}

function floridaDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: FL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function eventFloridaDate(value: unknown): string {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? floridaDate(new Date(parsed)) : "";
}

export function normalizeRequestedFloridaDate(value: unknown, now: Date): string {
  const text = String(value ?? "").trim();
  if (!text) return floridaDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error("INVALID_DATE");
  }
  const parsed = Date.parse(`${text}T12:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text) {
    throw new Error("INVALID_DATE");
  }
  return text;
}

export function buildMlbP1M6a2EventOddsUrl(eventId: string, apiKey: string): string {
  const params = new URLSearchParams({
    apiKey,
    bookmakers: MLB_P1_M6A2_BOOKMAKERS.join(","),
    markets: MLB_P1_M6A2_PROVIDER_MARKETS.join(","),
    oddsFormat: "american",
    dateFormat: "iso",
  });
  return `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${encodeURIComponent(eventId)}/odds/?${params.toString()}`;
}

async function readJson(response: Response): Promise<any> {
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(String(payload?.message ?? `The Odds API HTTP ${response.status}`)) as Error & {
      code?: string;
      status?: number;
    };
    error.code = String(payload?.error_code ?? "ODDS_PROVIDER_ERROR");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function numericHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw == null || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function usageSample(eventId: string, response: Response): MlbP1M6a2ProviderUsageSample {
  return {
    eventId,
    requestsLast: numericHeader(response, "x-requests-last"),
    requestsRemaining: numericHeader(response, "x-requests-remaining"),
    requestsUsed: numericHeader(response, "x-requests-used"),
  };
}

function sumReported(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) : null;
}

function minimumReported(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  return finite.length ? Math.min(...finite) : null;
}

export class MlbP1M6a2MarketOddsService {
  private readonly fetchFn: FetchLike;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, { storedAtMs: number; data: MlbP1M6a2UniverseResponse }>();

  constructor(options: ServiceOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? MLB_P1_M6A2_CACHE_TTL_MS;
  }

  async load(dateInput: unknown, apiKey: string): Promise<MlbP1M6a2UniverseResponse> {
    const now = this.now();
    const date = normalizeRequestedFloridaDate(dateInput, now);
    const cached = this.cache.get(date);
    if (cached && now.getTime() - cached.storedAtMs < this.cacheTtlMs) return cached.data;

    const eventsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${encodeURIComponent(apiKey)}&dateFormat=iso`;
    const eventsPayload = await readJson(await this.fetchFn(eventsUrl));
    if (!Array.isArray(eventsPayload)) throw new Error("ODDS_PROVIDER_EVENTS_NOT_ARRAY");

    const eligible = eventsPayload
      .filter((event: any) => eventFloridaDate(event?.commence_time) === date)
      .slice(0, MLB_P1_M6A2_MAX_EVENTS_PER_REQUEST);
    const capturedAt = now.toISOString();
    const queue = [...eligible];
    const games: MlbMarketOddsUniverseGame[] = [];
    const eventErrors: Array<{ eventId: string; code: string }> = [];
    const providerUsageSamples: MlbP1M6a2ProviderUsageSample[] = [];

    const workers = Array.from({ length: Math.min(3, Math.max(1, queue.length)) }, async () => {
      while (queue.length > 0) {
        const event = queue.shift();
        if (!event) break;
        const eventId = String(event?.id ?? "").trim();
        if (!eventId) {
          eventErrors.push({ eventId: "", code: "MISSING_EVENT_ID" });
          continue;
        }
        try {
          const response = await this.fetchFn(buildMlbP1M6a2EventOddsUrl(eventId, apiKey));
          providerUsageSamples.push(usageSample(eventId, response));
          const payload = await readJson(response);
          games.push(buildMlbMarketOddsUniverseGame(payload, capturedAt));
        } catch (error: any) {
          eventErrors.push({ eventId, code: String(error?.code ?? "EVENT_ODDS_UNAVAILABLE") });
        }
      }
    });
    await Promise.all(workers);

    games.sort((left, right) =>
      Date.parse(left.commence) - Date.parse(right.commence)
      || left.gameKey.localeCompare(right.gameKey));
    eventErrors.sort((left, right) => left.eventId.localeCompare(right.eventId) || left.code.localeCompare(right.code));
    providerUsageSamples.sort((left, right) => left.eventId.localeCompare(right.eventId));

    const complete = eventErrors.length === 0 && games.length === eligible.length;
    const data: MlbP1M6a2UniverseResponse = {
      schemaVersion: MLB_P1_M6A2_SCHEMA,
      generatedAt: capturedAt,
      date,
      games,
      coverage: {
        eligibleEvents: eligible.length,
        fetchedGames: games.length,
        failedEvents: eventErrors,
        complete,
      },
      providerUsage: {
        samples: providerUsageSamples,
        totalReportedCost: sumReported(providerUsageSamples.map((sample) => sample.requestsLast)),
        minimumReportedRemaining: minimumReported(providerUsageSamples.map((sample) => sample.requestsRemaining)),
      },
      policy: {
        executionBooks: [...MLB_EXECUTION_BOOK_PRIORITY],
        referenceBooks: [...MLB_REFERENCE_BOOKS],
        providerMarkets: [...MLB_P1_M6A2_PROVIDER_MARKETS],
        maxQuoteAgeMs: MLB_P1_M6A2_MAX_QUOTE_AGE_MS,
        bookmakerRegionEquivalents: 1,
        providerCostModel: "unique_markets_returned_x_bookmaker_region_equivalents",
        referenceQuotesExecutable: false,
        undocumentedMarketsInvented: false,
        threeWayCoercedToTwoWay: false,
        partialSlateCached: false,
      },
    };

    // Do not cache partial or fully failed coverage. Missing provider events are
    // operationally retryable and must never masquerade as a complete daily universe.
    if (eligible.length > 0 && games.length === 0 && eventErrors.length === eligible.length) {
      const error = new Error("ALL_EVENT_ODDS_REQUESTS_FAILED") as Error & { details?: unknown };
      error.details = eventErrors;
      throw error;
    }
    if (complete) {
      this.cache.set(date, { storedAtMs: now.getTime(), data });
    }
    return data;
  }
}

export function registerMlbP1M6a2MarketUniverseOddsRoutes(
  app: Express,
  service = new MlbP1M6a2MarketOddsService(),
): void {
  app.get(MLB_P1_M6A2_ENDPOINT, async (req, res) => {
    try {
      const apiKey = requireSecret("ODDS_API_KEY");
      const data = await service.load(req.query.date, apiKey);
      return res.json({ success: true, data });
    } catch (error: any) {
      if (error?.message === "INVALID_DATE") {
        return res.status(400).json({
          success: false,
          error: "date must be a real YYYY-MM-DD date in the Florida slate convention.",
          code: "P1_M6A2_INVALID_DATE",
        });
      }
      if (String(error?.code ?? "") === "OUT_OF_USAGE_CREDITS") {
        return res.status(503).json({
          success: false,
          error: "The Odds API usage credits are exhausted; market availability was not inferred.",
          code: "P1_M6A2_PROVIDER_CREDITS_EXHAUSTED",
        });
      }
      console.error("P1-M6A2 market-universe odds error:", error);
      return res.status(503).json({
        success: false,
        error: "Unable to verify the current MLB market universe from the odds provider.",
        code: "P1_M6A2_ODDS_UNAVAILABLE",
      });
    }
  });
}
