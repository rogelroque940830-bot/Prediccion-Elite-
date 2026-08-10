import type { Express, NextFunction, Request, Response } from "express";
import {
  consensusAmericanOdds,
  isStandardAmericanOdds,
  medianFinite,
  normalizeStandardAmericanOdds,
} from "./american-odds";
import { FL_TZ, invalidateCache, requireSecret, withCache } from "./route-runtime";

export const MLB_F5_ODDS_SCHEMA_VERSION = "mlb-f5-odds-consensus.v2" as const;
export const MLB_F5_CONSENSUS_METHOD = "median_implied_probability" as const;
const MLB_F5_CACHE_KEY = "mlb-f5-events-v2-probability-consensus";
const F5_BOOKS = ["fanduel", "betmgm", "draftkings"] as const;
const F5_BACKGROUND_CACHE_TTL_MS = 5 * 60 * 1000;
const f5BackgroundCache = new Map<string, { data: any; providerFetchedAt: number }>();

type RawPriceQuote = {
  bookKey: string;
  bookTitle: string;
  price: number;
  point: number | null;
  providerLastUpdate: string | null;
  capturedAt: string;
  accepted: boolean;
};

type PairedMarketQuote = {
  bookKey: string;
  bookTitle: string;
  line: number;
  sideA: number;
  sideB: number;
  providerLastUpdate: string | null;
  capturedAt: string;
};

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function commenceToFloridaDate(iso: string): string {
  try {
    const date = new Date(iso);
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: FL_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return "";
  }
}

function newestTimestamp(values: readonly (string | null | undefined)[], fallback: string): string {
  const candidates = values
    .map((value) => isoOrNull(value))
    .filter((value): value is string => value != null)
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return candidates[0] ?? fallback;
}

function rawQuote(
  book: any,
  outcome: any,
  capturedAt: string,
): RawPriceQuote | null {
  const price = finite(outcome?.price);
  if (price == null) return null;
  return {
    bookKey: String(book?.key ?? "unknown"),
    bookTitle: String(book?.title ?? book?.key ?? "Unknown book"),
    price,
    point: finite(outcome?.point),
    providerLastUpdate: isoOrNull(book?.last_update),
    capturedAt,
    accepted: isStandardAmericanOdds(price),
  };
}

function selectConsensusLine(quotes: readonly PairedMarketQuote[]): { line: number; quotes: PairedMarketQuote[] } | null {
  if (!quotes.length) return null;
  const groups = new Map<string, PairedMarketQuote[]>();
  for (const quote of quotes) {
    const key = String(quote.line);
    const group = groups.get(key) ?? [];
    group.push(quote);
    groups.set(key, group);
  }
  const overallMedian = medianFinite(quotes.map((quote) => quote.line)) ?? 0;
  const ranked = [...groups.entries()].map(([key, group]) => ({
    line: Number(key),
    quotes: group,
    distanceFromMedian: Math.abs(Number(key) - overallMedian),
  })).sort((left, right) => {
    return right.quotes.length - left.quotes.length
      || left.distanceFromMedian - right.distanceFromMedian
      || left.line - right.line;
  });
  return ranked[0] ?? null;
}

function pairedMarketConsensus(quotes: readonly PairedMarketQuote[]) {
  const selected = selectConsensusLine(quotes);
  if (!selected) {
    return {
      line: null,
      sideA: null,
      sideB: null,
      n: 0,
      rawN: quotes.length,
      selectedQuotes: [] as PairedMarketQuote[],
    };
  }
  return {
    line: selected.line,
    sideA: consensusAmericanOdds(selected.quotes.map((quote) => quote.sideA)),
    sideB: consensusAmericanOdds(selected.quotes.map((quote) => quote.sideB)),
    n: selected.quotes.length,
    rawN: quotes.length,
    selectedQuotes: selected.quotes,
  };
}

export function buildMlbF5ConsensusGame(providerGame: any, capturedAtInput?: string) {
  const capturedAt = isoOrNull(capturedAtInput) ?? new Date().toISOString();
  const homeTeam = String(providerGame?.home_team ?? "").trim();
  const awayTeam = String(providerGame?.away_team ?? "").trim();
  const commence = String(providerGame?.commence_time ?? "").trim();

  const mlHomeRaw: RawPriceQuote[] = [];
  const mlAwayRaw: RawPriceQuote[] = [];
  const spreadPairs: PairedMarketQuote[] = [];
  const totalPairs: PairedMarketQuote[] = [];
  const spreadRaw: RawPriceQuote[] = [];
  const totalRaw: RawPriceQuote[] = [];
  const sources = new Map<string, string>();

  for (const book of Array.isArray(providerGame?.bookmakers) ? providerGame.bookmakers : []) {
    for (const market of Array.isArray(book?.markets) ? book.markets : []) {
      const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
      if (market?.key === "h2h_1st_5_innings") {
        const home = outcomes.find((outcome: any) => outcome?.name === homeTeam);
        const away = outcomes.find((outcome: any) => outcome?.name === awayTeam);
        const homeQuote = rawQuote(book, home, capturedAt);
        const awayQuote = rawQuote(book, away, capturedAt);
        if (homeQuote) mlHomeRaw.push(homeQuote);
        if (awayQuote) mlAwayRaw.push(awayQuote);
        if (homeQuote?.accepted && awayQuote?.accepted) {
          sources.set(homeQuote.bookKey, homeQuote.bookTitle);
        }
      }

      if (market?.key === "spreads_1st_5_innings") {
        const home = outcomes.find((outcome: any) => outcome?.name === homeTeam);
        const away = outcomes.find((outcome: any) => outcome?.name === awayTeam);
        const homeQuote = rawQuote(book, home, capturedAt);
        const awayQuote = rawQuote(book, away, capturedAt);
        if (homeQuote) spreadRaw.push(homeQuote);
        if (awayQuote) spreadRaw.push(awayQuote);
        const homeLine = finite(home?.point);
        if (homeLine != null && homeQuote?.accepted && awayQuote?.accepted) {
          spreadPairs.push({
            bookKey: homeQuote.bookKey,
            bookTitle: homeQuote.bookTitle,
            line: homeLine,
            sideA: normalizeStandardAmericanOdds(homeQuote.price)!,
            sideB: normalizeStandardAmericanOdds(awayQuote.price)!,
            providerLastUpdate: homeQuote.providerLastUpdate,
            capturedAt,
          });
          sources.set(homeQuote.bookKey, homeQuote.bookTitle);
        }
      }

      if (market?.key === "totals_1st_5_innings") {
        const over = outcomes.find((outcome: any) => outcome?.name === "Over");
        const under = outcomes.find((outcome: any) => outcome?.name === "Under");
        const overQuote = rawQuote(book, over, capturedAt);
        const underQuote = rawQuote(book, under, capturedAt);
        if (overQuote) totalRaw.push(overQuote);
        if (underQuote) totalRaw.push(underQuote);
        const line = finite(over?.point);
        if (line != null && overQuote?.accepted && underQuote?.accepted) {
          totalPairs.push({
            bookKey: overQuote.bookKey,
            bookTitle: overQuote.bookTitle,
            line,
            sideA: normalizeStandardAmericanOdds(overQuote.price)!,
            sideB: normalizeStandardAmericanOdds(underQuote.price)!,
            providerLastUpdate: overQuote.providerLastUpdate,
            capturedAt,
          });
          sources.set(overQuote.bookKey, overQuote.bookTitle);
        }
      }
    }
  }

  const spread = pairedMarketConsensus(spreadPairs);
  const total = pairedMarketConsensus(totalPairs);
  const acceptedHomeMl = mlHomeRaw.filter((quote) => quote.accepted);
  const acceptedAwayMl = mlAwayRaw.filter((quote) => quote.accepted);
  const sourceKeys = [...sources.keys()];
  const sourceTitles = [...sources.values()];
  const selectedProviderTimes = [
    ...acceptedHomeMl.map((quote) => quote.providerLastUpdate),
    ...acceptedAwayMl.map((quote) => quote.providerLastUpdate),
    ...spread.selectedQuotes.map((quote) => quote.providerLastUpdate),
    ...total.selectedQuotes.map((quote) => quote.providerLastUpdate),
  ];

  return {
    schemaVersion: MLB_F5_ODDS_SCHEMA_VERSION,
    gameKey: `${awayTeam}@${homeTeam}@${commence}`,
    eventId: String(providerGame?.id ?? "") || null,
    homeTeam,
    awayTeam,
    commence,
    source: sourceKeys.join(", ") || "n/a",
    sourceTitles,
    capturedAt,
    providerLastUpdate: newestTimestamp(selectedProviderTimes, capturedAt),
    consensusMethod: MLB_F5_CONSENSUS_METHOD,
    f5Ml: {
      home: consensusAmericanOdds(acceptedHomeMl.map((quote) => quote.price)),
      away: consensusAmericanOdds(acceptedAwayMl.map((quote) => quote.price)),
      n: Math.min(acceptedHomeMl.length, acceptedAwayMl.length),
      rawN: Math.max(mlHomeRaw.length, mlAwayRaw.length),
      capturedAt,
      consensusMethod: MLB_F5_CONSENSUS_METHOD,
    },
    f5Spread: {
      line: spread.line,
      homeOdds: spread.sideA,
      awayOdds: spread.sideB,
      n: spread.n,
      rawN: spread.rawN,
      capturedAt,
      consensusMethod: MLB_F5_CONSENSUS_METHOD,
    },
    f5Total: {
      line: total.line,
      overOdds: total.sideA,
      underOdds: total.sideB,
      n: total.n,
      rawN: total.rawN,
      capturedAt,
      consensusMethod: MLB_F5_CONSENSUS_METHOD,
    },
    provenance: {
      provider: "the-odds-api",
      capturedAt,
      providerLastUpdate: newestTimestamp(selectedProviderTimes, capturedAt),
      consensusMethod: MLB_F5_CONSENSUS_METHOD,
      requestedBooks: [...F5_BOOKS],
      contributingBooks: sourceKeys,
      rawQuotes: {
        f5Ml: { home: mlHomeRaw, away: mlAwayRaw },
        f5Spread: spreadRaw,
        f5Total: totalRaw,
      },
      selectedLineQuotes: {
        f5Spread: spread.selectedQuotes,
        f5Total: total.selectedQuotes,
      },
    },
  };
}

async function handleMlbF5Odds(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method !== "GET" || (req.path !== "/" && req.path !== "")) {
    next();
    return;
  }

  const dateParam = String(req.query.date ?? "").trim();
  const cacheKey = `${MLB_F5_CACHE_KEY}:${dateParam || "all"}`;
  const backgroundCacheOnly = String(req.query.background ?? "").trim().toLowerCase() === "cache-only";
  try {
    let data: any;
    if (backgroundCacheOnly) {
      const cached = f5BackgroundCache.get(cacheKey);
      if (!cached || Date.now() - cached.providerFetchedAt >= F5_BACKGROUND_CACHE_TTL_MS) {
        return void res.json({
          success: false,
          schemaVersion: MLB_F5_ODDS_SCHEMA_VERSION,
          games: [],
          source: "n/a",
          code: "BACKGROUND_CACHE_MISS",
          error: "No recent F5 cache is available; background provider refresh is disabled to conserve quota.",
          backgroundCacheOnly: true,
        });
      }
      data = cached.data;
    } else {
      const ODDS_API_KEY = requireSecret("ODDS_API_KEY");
      data = await withCache(cacheKey, async () => {
        const providerFetchedAt = Date.now();
        const eventsResponse = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${ODDS_API_KEY}`);
        const events = await eventsResponse.json();
        if (!Array.isArray(events)) {
          const error: any = new Error(events?.message || "Odds API error");
          error.code = events?.error_code;
          error.noCache = true;
          throw error;
        }

        const eligibleEvents = dateParam
          ? events.filter((event: any) => commenceToFloridaDate(String(event?.commence_time ?? "")) === dateParam)
          : events;
        const queue = [...eligibleEvents];
        const games: any[] = [];
        const eventFailures: Array<{ code: string | null; message: string; status: number | null }> = [];
        const workers = Array.from({ length: 4 }, async () => {
          while (queue.length > 0) {
            const event: any = queue.shift();
            if (!event) break;
            try {
              const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${event.id}/odds/?apiKey=${ODDS_API_KEY}&regions=us,us2&markets=h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings&oddsFormat=american&bookmakers=${F5_BOOKS.join(",")}`;
              const response = await fetch(url);
              if (!response.ok) {
                const body: any = await response.json().catch(() => null);
                eventFailures.push({
                  code: String(body?.error_code ?? "").trim() || null,
                  message: String(body?.message ?? `Odds API HTTP ${response.status}`),
                  status: response.status,
                });
                continue;
              }
              const providerGame = await response.json();
              games.push(buildMlbF5ConsensusGame(providerGame, new Date().toISOString()));
            } catch (error) {
              eventFailures.push({
                code: null,
                message: error instanceof Error ? error.message : String(error),
                status: null,
              });
            }
          }
        });
        await Promise.all(workers);
        if (eligibleEvents.length > 0 && games.length === 0 && eventFailures.length > 0) {
          const first = eventFailures[0];
          const error: any = new Error(first.message || "F5 event odds provider failure");
          error.code = first.code || "F5_EVENT_ODDS_PROVIDER_FAILURE";
          error.noCache = true;
          throw error;
        }
        return {
          games,
          providerFetchedAt,
          eligibleEventCount: eligibleEvents.length,
          providerFailureCount: eventFailures.length,
          providerErrorCodes: Array.from(new Set(eventFailures.map((failure) => failure.code).filter(Boolean))),
        };
      });
      const providerFetchedAt = Number(data?.providerFetchedAt);
      if (Number.isFinite(providerFetchedAt) && providerFetchedAt > 0) {
        f5BackgroundCache.set(cacheKey, { data, providerFetchedAt });
      }
    }
    let games = Array.isArray((data as any)?.games) ? (data as any).games : [];
    if (dateParam) {
      games = games.filter((game: any) => commenceToFloridaDate(String(game?.commence ?? "")) === dateParam);
    }
    const sources = Array.from(new Set(games.flatMap((game: any) => Array.isArray(game?.provenance?.contributingBooks)
      ? game.provenance.contributingBooks
      : [])));
    res.json({
      success: true,
      schemaVersion: MLB_F5_ODDS_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      games,
      source: sources.join(", ") || "n/a",
      consensusMethod: MLB_F5_CONSENSUS_METHOD,
      backgroundCacheOnly,
      coverageStatus: Number((data as any)?.providerFailureCount || 0) > 0 ? "PARTIAL" : "COMPLETE",
      eligibleEventCount: Number((data as any)?.eligibleEventCount || 0),
      providerFailureCount: Number((data as any)?.providerFailureCount || 0),
      providerErrorCodes: Array.isArray((data as any)?.providerErrorCodes) ? (data as any).providerErrorCodes : [],
      note: "Hard Rock no publica mercados F5. Consenso por mediana de probabilidad implícita de FanDuel/BetMGM/DraftKings; nunca se promedian cuotas americanas directamente.",
    });
  } catch (error: any) {
    if (error?.noCache) invalidateCache(cacheKey);
    const friendly = error?.code === "OUT_OF_USAGE_CREDITS"
      ? "Cuota mensual de The Odds API agotada — llénalas manualmente desde Hard Rock"
      : String(error?.message || error || "F5 odds request failed");
    res.json({ success: false, schemaVersion: MLB_F5_ODDS_SCHEMA_VERSION, error: friendly, code: error?.code });
  }
}

/**
 * Registers the S6H v2 F5 endpoint before the legacy market-support route.
 * app.use is intentional: it replaces only the exact GET path without changing
 * the historical route-contract registration count.
 */
export function registerMlbF5OddsProtectionRoutes(app: Express): void {
  app.use("/api/odds/mlb/f5", (req, res, next) => {
    void handleMlbF5Odds(req, res, next);
  });
}
