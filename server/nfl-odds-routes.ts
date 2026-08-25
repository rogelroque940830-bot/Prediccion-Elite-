import type { Express } from "express";
import { FL_TZ, invalidateCache, requireSecret, withCache } from "./route-runtime";

const NFL_ODDS_SPORT_KEY = "americanfootball_nfl";
const BOOK_PRIORITY = [
  "hardrockbet_fl", "hardrockbet", "hardrockbet_az",
  "draftkings", "fanduel", "betmgm",
];

function commenceToFloridaDate(iso: string): string {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: FL_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return "";
  }
}

/** Exact NFL odds route registered before the generic /api/odds/:sport handler. */
export function registerNflOddsRoutes(app: Express): void {
  const apiKey = requireSecret("ODDS_API_KEY");

  app.get("/api/odds/nfl", async (req, res) => {
    const dateParam = String(req.query.date ?? "").trim();
    try {
      const oddsData = await withCache("odds-v1-nfl", async () => {
        const url = `https://api.the-odds-api.com/v4/sports/${NFL_ODDS_SPORT_KEY}/odds/?apiKey=${apiKey}&regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=hardrockbet_fl,hardrockbet,hardrockbet_az,draftkings,fanduel,betmgm`;
        const response = await fetch(url);
        const payload: any = await response.json();
        if (!Array.isArray(payload)) {
          const error: any = new Error(payload?.message || "Odds API error");
          error.code = payload?.error_code;
          error.noCache = true;
          throw error;
        }
        return payload;
      });

      const games: any[] = [];
      for (const game of oddsData as any[]) {
        if (dateParam && commenceToFloridaDate(String(game.commence_time)) !== dateParam) continue;
        let bestBook: any = null;
        for (const key of BOOK_PRIORITY) {
          bestBook = game.bookmakers?.find((book: any) => book.key === key);
          if (bestBook) break;
        }
        if (!bestBook && game.bookmakers?.length) bestBook = game.bookmakers[0];
        if (!bestBook) continue;

        const markets: Record<string, Record<string, { price?: number; point?: number }>> = {};
        for (const market of bestBook.markets ?? []) {
          markets[market.key] = {};
          for (const outcome of market.outcomes ?? []) {
            markets[market.key][outcome.name] = { price: outcome.price, point: outcome.point };
          }
        }
        const h2h = markets.h2h ?? {};
        const spreads = markets.spreads ?? {};
        const totals = markets.totals ?? {};
        games.push({
          gameKey: `${game.away_team}@${game.home_team}@${game.commence_time}`,
          homeTeam: game.home_team,
          awayTeam: game.away_team,
          commence: game.commence_time,
          source: bestBook.title,
          ml: { home: h2h[game.home_team]?.price, away: h2h[game.away_team]?.price },
          spread: {
            line: spreads[game.home_team]?.point,
            homeOdds: spreads[game.home_team]?.price,
            awayOdds: spreads[game.away_team]?.price,
          },
          total: {
            line: totals.Over?.point,
            overOdds: totals.Over?.price,
            underOdds: totals.Under?.price,
          },
        });
      }

      const usedBooks = Array.from(new Set(games.map((game) => game.source).filter(Boolean))).slice(0, 3);
      return res.json({ success: true, games, source: usedBooks.join(", ") || "n/a" });
    } catch (error: any) {
      if (error?.noCache) invalidateCache("odds-v1-nfl");
      const friendly = error?.code === "OUT_OF_USAGE_CREDITS"
        ? "Cuota mensual de The Odds API agotada — usa precios manuales de Hard Rock"
        : error?.message || "NFL odds unavailable";
      return res.json({ success: false, error: friendly, code: error?.code });
    }
  });
}
