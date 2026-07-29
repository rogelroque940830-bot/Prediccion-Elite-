import type { Express } from "express";
import {
  getNBARefImpact,
  getMLBUmpireImpact,
  type NBARefImpact,
  type MLBUmpireImpact,
} from "./referee-data";
import { getParkFactor, computeWeatherImpact, analyzeOpener } from "./mlb-advanced";
import {
  recordSnapshot,
  getHistoryForGame,
  getAllGameKeys,
  analyzeLineMovement,
  detectSteamMoves,
  detectReverseLineMovement,
  computeCLV,
} from "./sharp-signals";
import { computeContextual } from "./nba-contextual";
import { computeMLBContextual } from "./mlb-contextual";
import {
  FL_TZ,
  invalidateCache,
  requireSecret,
  withCache,
} from "./route-runtime";

/** Odds, officials, advanced context, sharp movement, CLV and health routes. */
export function registerMarketSupportRoutes(app: Express): void {
  // ── GET /api/odds/:sport ───────────────────────────────────────────────
  // Fetches odds from The Odds API (DraftKings = same platform as Hard Rock)
  const ODDS_API_KEY = requireSecret("ODDS_API_KEY");
  const SPORT_MAP: Record<string, string> = {
    nba: "basketball_nba", nhl: "icehockey_nhl", mlb: "baseball_mlb", wnba: "basketball_wnba",
  };
  // Hard Rock Bet is in region 'us2'. Prioritize Hard Rock FL (user's casa),
  // then generic Hard Rock, then DraftKings/FanDuel/BetMGM as fallbacks.
  const BOOK_PRIORITY = [
    "hardrockbet_fl", "hardrockbet", "hardrockbet_az",
    "draftkings", "fanduel", "betmgm",
  ];

  app.get("/api/odds/:sport", async (req, res) => {
    try {
      const sport = req.params.sport.toLowerCase();
      const apiSport = SPORT_MAP[sport];
      if (!apiSport) return res.json({ success: false, error: "Sport not found" });

      // Optional date filter (YYYY-MM-DD in Florida timezone)
      const dateParam = (req.query.date as string) || "";

      // v2: now includes us2 region for Hard Rock Bet
      const oddsData = await withCache(`odds-v2-${sport}`, async () => {
        const url = `https://api.the-odds-api.com/v4/sports/${apiSport}/odds/?apiKey=${ODDS_API_KEY}&regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=hardrockbet_fl,hardrockbet,hardrockbet_az,draftkings,fanduel,betmgm`;
        const resp = await fetch(url);
        const j = await resp.json();
        // The Odds API devuelve {message,error_code} cuando se acaba la cuota — no cachear
        if (!Array.isArray(j)) {
          const err: any = new Error(j?.message || "Odds API error");
          err.code = j?.error_code; err.noCache = true;
          throw err;
        }
        return j;
      });

      // Helper: get YYYY-MM-DD of commence_time in Florida timezone
      const commenceToFL = (iso: string): string => {
        try {
          const d = new Date(iso);
          const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: FL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
          });
          const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
          return `${parts.year}-${parts.month}-${parts.day}`;
        } catch { return ""; }
      };

      const games: any[] = [];
      const nowTs = Date.now();
      for (const g of oddsData as any[]) {
        // Filter by date (Florida timezone) if requested
        if (dateParam && commenceToFL(g.commence_time) !== dateParam) continue;
        const gameKey = `${g.away_team}@${g.home_team}@${g.commence_time}`;

        // Record snapshots for ALL books (for line movement / steam detection)
        for (const book of g.bookmakers || []) {
          const mkts: any = {};
          for (const mkt of book.markets || []) {
            mkts[mkt.key] = {};
            for (const o of mkt.outcomes || []) {
              mkts[mkt.key][o.name] = { price: o.price, point: o.point };
            }
          }
          const h = mkts.h2h || {}, s = mkts.spreads || {}, t = mkts.totals || {};
          recordSnapshot({
            ts: nowTs,
            sport,
            gameKey,
            book: book.key,
            ml: (h[g.home_team] && h[g.away_team]) ? { home: h[g.home_team].price, away: h[g.away_team].price } : null,
            spread: (s[g.home_team] && s[g.away_team]) ? { line: s[g.home_team].point, homeOdds: s[g.home_team].price, awayOdds: s[g.away_team].price } : null,
            total: (t["Over"] && t["Under"]) ? { line: t["Over"].point, overOdds: t["Over"].price, underOdds: t["Under"].price } : null,
          });
        }

        // Return best book (Hard Rock preferred)
        let bestBook: any = null;
        for (const pref of BOOK_PRIORITY) {
          bestBook = g.bookmakers?.find((b: any) => b.key === pref);
          if (bestBook) break;
        }
        if (!bestBook && g.bookmakers?.length > 0) bestBook = g.bookmakers[0];
        if (!bestBook) continue;

        const markets: any = {};
        for (const mkt of bestBook.markets || []) {
          markets[mkt.key] = {};
          for (const o of mkt.outcomes || []) {
            markets[mkt.key][o.name] = { price: o.price, point: o.point };
          }
        }

        const h2h = markets.h2h || {};
        const spreads = markets.spreads || {};
        const totals = markets.totals || {};

        games.push({
          gameKey,
          homeTeam: g.home_team,
          awayTeam: g.away_team,
          commence: g.commence_time,
          source: bestBook.title,
          ml: { home: h2h[g.home_team]?.price, away: h2h[g.away_team]?.price },
          spread: {
            line: spreads[g.home_team]?.point,
            homeOdds: spreads[g.home_team]?.price,
            awayOdds: spreads[g.away_team]?.price,
          },
          total: {
            line: totals["Over"]?.point,
            overOdds: totals["Over"]?.price,
            underOdds: totals["Under"]?.price,
          },
        });
      }

      // Show which books actually fed the data (first two unique)
      const usedBooks = Array.from(new Set(games.map((g: any) => g.source).filter(Boolean))).slice(0, 3);
      res.json({ success: true, games, source: usedBooks.join(", ") || "n/a" });
    } catch (e: any) {
      // Si fue error temporal (cuota), invalidar el cache para reintentar luego
      if (e?.noCache) { invalidateCache(`odds-v2-${String(req.params.sport).toLowerCase()}`) }
      const friendly = e?.code === "OUT_OF_USAGE_CREDITS"
        ? "Cuota mensual de The Odds API agotada — llénalas manualmente desde Hard Rock"
        : e.message;
      res.json({ success: false, error: friendly, code: e?.code });
    }
  });

  // ── GET /api/odds/mlb/f5 ───────────────────────────────────────────────
  // Hard Rock NO publica mercados F5 en the-odds-api.
  // Pedimos h2h_1st_5_innings / spreads_1st_5_innings / totals_1st_5_innings
  // a FanDuel/BetMGM/DraftKings y devolvemos consenso (mediana). El usuario
  // puede sobrescribir manualmente con la cuota real de Hard Rock.
  app.get("/api/odds/mlb/f5", async (req, res) => {
    try {
      const F5_BOOKS = ["fanduel", "betmgm", "draftkings"];
      const dateParam = (req.query.date as string) || "";
      const median = (arr: number[]): number | null => {
        const xs = arr.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
        if (xs.length === 0) return null;
        const m = Math.floor(xs.length / 2);
        return xs.length % 2 ? xs[m] : Math.round((xs[m - 1] + xs[m]) / 2);
      };
      const data = await withCache(`mlb-f5-events-v1`, async () => {
        const evResp = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/?apiKey=${ODDS_API_KEY}`);
        const events = await evResp.json();
        if (!Array.isArray(events)) {
          const err: any = new Error(events?.message || "Odds API error");
          err.code = events?.error_code; err.noCache = true;
          throw err;
        }
        const out: any[] = [];
        // Run with concurrency 4 to respect API quota
        const queue = [...events];
        const workers = Array.from({ length: 4 }, async () => {
          while (queue.length > 0) {
            const g: any = queue.shift();
            if (!g) break;
            try {
              const url = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${g.id}/odds/?apiKey=${ODDS_API_KEY}&regions=us,us2&markets=h2h_1st_5_innings,spreads_1st_5_innings,totals_1st_5_innings&oddsFormat=american&bookmakers=${F5_BOOKS.join(",")}`;
              const r = await fetch(url);
              if (!r.ok) continue;
              const d: any = await r.json();
              const h2hHome: number[] = [], h2hAway: number[] = [];
              const slHome: number[] = [], slAway: number[] = [], slLine: number[] = [];
              const tOver: number[] = [], tUnder: number[] = [], tLine: number[] = [];
              const sources = new Set<string>();
              for (const b of d.bookmakers || []) {
                for (const m of b.markets || []) {
                  if (m.key === "h2h_1st_5_innings") {
                    const oh = m.outcomes?.find((o: any) => o.name === d.home_team);
                    const oa = m.outcomes?.find((o: any) => o.name === d.away_team);
                    if (oh?.price != null && oa?.price != null) {
                      h2hHome.push(oh.price); h2hAway.push(oa.price); sources.add(b.key);
                    }
                  }
                  if (m.key === "spreads_1st_5_innings") {
                    const oh = m.outcomes?.find((o: any) => o.name === d.home_team);
                    const oa = m.outcomes?.find((o: any) => o.name === d.away_team);
                    if (oh?.price != null && oa?.price != null && oh.point != null) {
                      slHome.push(oh.price); slAway.push(oa.price); slLine.push(oh.point); sources.add(b.key);
                    }
                  }
                  if (m.key === "totals_1st_5_innings") {
                    const ov = m.outcomes?.find((o: any) => o.name === "Over");
                    const un = m.outcomes?.find((o: any) => o.name === "Under");
                    if (ov?.price != null && un?.price != null && ov.point != null) {
                      tOver.push(ov.price); tUnder.push(un.price); tLine.push(ov.point); sources.add(b.key);
                    }
                  }
                }
              }
              out.push({
                gameKey: `${d.away_team}@${d.home_team}@${d.commence_time}`,
                homeTeam: d.home_team,
                awayTeam: d.away_team,
                commence: d.commence_time,
                source: Array.from(sources).join(", ") || "n/a",
                f5Ml: { home: median(h2hHome), away: median(h2hAway), n: h2hHome.length },
                f5Spread: { line: median(slLine), homeOdds: median(slHome), awayOdds: median(slAway), n: slLine.length },
                f5Total: { line: median(tLine), overOdds: median(tOver), underOdds: median(tUnder), n: tLine.length },
              });
            } catch {}
          }
        });
        await Promise.all(workers);
        return { games: out };
      });

      const commenceToFL = (iso: string): string => {
        try {
          const dt = new Date(iso);
          const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: FL_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
          const parts = Object.fromEntries(fmt.formatToParts(dt).map((p) => [p.type, p.value]));
          return `${parts.year}-${parts.month}-${parts.day}`;
        } catch { return ""; }
      };
      let games = (data as any).games || [];
      if (dateParam) games = games.filter((g: any) => commenceToFL(g.commence) === dateParam);
      const sources = Array.from(new Set(games.map((g: any) => g.source).filter(Boolean)));
      res.json({ success: true, games, source: sources.join(", ") || "n/a", note: "Hard Rock no publica mercados F5. Consenso de FanDuel/BetMGM/DraftKings." });
    } catch (e: any) {
      if (e?.noCache) { invalidateCache("mlb-f5-events-v1") }
      const friendly = e?.code === "OUT_OF_USAGE_CREDITS"
        ? "Cuota mensual de The Odds API agotada — llénalas manualmente desde Hard Rock"
        : e.message;
      res.json({ success: false, error: friendly, code: e?.code });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ÉLITE FACTORS — Referees, Umpires, Confirmed Goalies
  // ═══════════════════════════════════════════════════════════════════════════

  // NBA referees for a game
  app.get("/api/nba/refs/:gameId", async (req, res) => {
    try {
      const gameId = req.params.gameId;
      const data = await withCache(`nba-refs-${gameId}`, async () => {
        const url = `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`;
        const r = await fetch(url);
        if (!r.ok) return { game: { officials: [] } };
        return r.json();
      });
      const officials: any[] = (data as any)?.game?.officials ?? [];
      const enriched = officials.map((o: any) => ({
        name: o.name,
        assignment: o.assignment,
        ...getNBARefImpact(o.name),
      }));
      let totalW = 0, hWP = 0, oP = 0, pB = 0, fR = 0;
      for (const r of enriched) {
        const w = r.assignment === "OFFICIAL1" ? 1.0 : 0.5;
        totalW += w;
        hWP += r.homeWinPct * w;
        oP += r.overPct * w;
        pB += r.paceBoost * w;
        fR += r.foulRate * w;
      }
      const composite = totalW > 0 ? {
        homeWinPct: hWP / totalW,
        overPct: oP / totalW,
        paceBoost: pB / totalW,
        foulRate: fR / totalW,
      } : null;
      res.json({ success: true, officials: enriched, composite });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // MLB home plate umpire for a game
  app.get("/api/mlb/umpire/:gamePk", async (req, res) => {
    try {
      const pk = req.params.gamePk;
      const data = await withCache(`mlb-ump-${pk}`, async () => {
        const url = `https://statsapi.mlb.com/api/v1/game/${pk}/boxscore`;
        const r = await fetch(url);
        if (!r.ok) return { officials: [] };
        return r.json();
      });
      const officials: any[] = (data as any)?.officials ?? [];
      const hp = officials.find((o: any) => o.officialType === "Home Plate");
      if (!hp) return res.json({ success: true, umpire: null, note: "not yet announced" });
      const impact = getMLBUmpireImpact(hp.official?.fullName || "");
      res.json({ success: true, umpire: { name: hp.official?.fullName, ...impact } });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // NHL confirmed starting goalies
  app.get("/api/nhl/goalies/:gameId", async (req, res) => {
    try {
      const gid = req.params.gameId;
      const data = await withCache(`nhl-goalies-${gid}`, async () => {
        const r = await fetch(`https://api-web.nhle.com/v1/gamecenter/${gid}/landing`);
        if (!r.ok) return {};
        return r.json();
      }) as any;
      const gc = data?.matchup?.goalieComparison;
      const homeStarter = gc?.homeTeam?.leaders?.[0] ?? null;
      const awayStarter = gc?.awayTeam?.leaders?.[0] ?? null;
      // goalieComparison exposes statistical leaders/candidates. It does not prove who starts.
      const confirmed = false;
      const minutesUntilGame = data?.startTimeUTC ? (new Date(data.startTimeUTC).getTime() - Date.now()) / 60000 : null;
      const name = (p: any) => p ? `${p.firstName?.default || p.firstName || ""} ${p.lastName?.default || p.lastName || ""}`.trim() : null;
      res.json({
        success: true,
        confirmed,
        minutesUntilGame,
        home: homeStarter ? { name: name(homeStarter), svPct: homeStarter.savePctg, gaa: homeStarter.goalsAgainstAverage } : null,
        away: awayStarter ? { name: name(awayStarter), svPct: awayStarter.savePctg, gaa: awayStarter.goalsAgainstAverage } : null,
        source: "nhl-gamecenter-candidates",
        note: "Goalie comparison lists candidates/leaders; verify the official starter before betting.",
      });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // ── GET /api/health ──────────────────────────────────────────────────────
  app.get("/api/mlb/advanced/:gamePk", async (req, res) => {
    try {
      const pk = req.params.gamePk;
      const data = await withCache(`mlb-adv-${pk}`, async () => {
        // FIX doubleheader: usar feed/live (bug MLB API en /schedule con gamePk)
        const game: any = await getGameMeta(parseInt(pk));
        if (!game) return { error: "Game not found" };

        const venue = game.venue || {};
        const weather = game.weather || {};
        const homeP = game.teams?.home?.probablePitcher;
        const awayP = game.teams?.away?.probablePitcher;

        let roof: "open" | "retractable" | "dome" = "open";
        try {
          const v = await (await fetch(`https://statsapi.mlb.com/api/v1/venues/${venue.id}?hydrate=fieldInfo`)).json();
          const rt = (v.venues?.[0]?.fieldInfo?.roofType || "Open").toLowerCase();
          if (rt.includes("dome") || rt.includes("indoor")) roof = "dome";
          else if (rt.includes("retract")) roof = "retractable";
        } catch { /* default open */ }

        const fetchPitcherStats = async (id?: number) => {
          if (!id) return null;
          try {
            const r = await (await fetch(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=season&group=pitching&season=${MLB_SEASON_CURRENT}`)).json();
            return r.stats?.[0]?.splits?.[0]?.stat || null;
          } catch { return null; }
        };
        const [homeStats, awayStats] = await Promise.all([
          fetchPitcherStats(homeP?.id),
          fetchPitcherStats(awayP?.id),
        ]);

        return { venue, weather, homeP, awayP, homeStats, awayStats, roof };
      }) as any;

      if (data.error) return res.json({ success: false, error: data.error });

      const park = getParkFactor(data.venue?.id, data.venue?.name);
      const weather = computeWeatherImpact(
        data.weather?.temp, data.weather?.wind, data.weather?.condition, data.roof
      );
      const homeOpener = analyzeOpener(
        data.homeStats?.gamesStarted, data.homeStats?.gamesPlayed, data.homeStats?.inningsPitched
      );
      const awayOpener = analyzeOpener(
        data.awayStats?.gamesStarted, data.awayStats?.gamesPlayed, data.awayStats?.inningsPitched
      );

      const parkAdj = park ? ((park.runs - 100) / 100) * 4.5 : 0;
      const totalAdj = parkAdj + weather.tempAdj + weather.windAdj + homeOpener.runAdj + awayOpener.runAdj;

      res.json({
        success: true,
        park,
        weather,
        homePitcher: { name: data.homeP?.fullName, ...homeOpener },
        awayPitcher: { name: data.awayP?.fullName, ...awayOpener },
        totalAdjustment: Math.round(totalAdj * 10) / 10,
        breakdown: {
          park: Math.round(parkAdj * 10) / 10,
          temp: weather.tempAdj,
          wind: weather.windAdj,
          homePitcher: homeOpener.runAdj,
          awayPitcher: awayOpener.runAdj,
        },
      });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // ── GET /api/sharp/:sport/:gameKey ── Sharp signals for a specific game ──
  app.get("/api/sharp/:sport/:gameKey", (req, res) => {
    try {
      const { sport, gameKey } = req.params;
      const history = getHistoryForGame(sport.toLowerCase(), decodeURIComponent(gameKey));
      if (history.length === 0) {
        return res.json({
          success: true,
          snapshots: 0,
          movements: [],
          steam: [],
          rlm: [],
          note: "Aún no hay historial — consulta cuotas varias veces para detectar movimientos",
        });
      }
      const movements = analyzeLineMovement(history);
      const steam = detectSteamMoves(history);
      const rlm = detectReverseLineMovement(movements);
      res.json({
        success: true,
        snapshots: history.length,
        earliestTs: Math.min(...history.map(h => h.ts)),
        latestTs: Math.max(...history.map(h => h.ts)),
        booksTracked: Array.from(new Set(history.map(h => h.book))),
        movements,
        steam,
        rlm,
      });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // ── GET /api/sharp/summary/:sport ── All games with movements today ─────
  app.get("/api/sharp/summary/:sport", (req, res) => {
    try {
      const sport = req.params.sport.toLowerCase();
      const keys = getAllGameKeys(sport);
      const summary = keys.map((k) => {
        const h = getHistoryForGame(sport, k);
        const movs = analyzeLineMovement(h);
        const steam = detectSteamMoves(h);
        return {
          gameKey: k,
          snapshots: h.length,
          moderateOrBig: movs.filter((m) => m.magnitude === "moderate" || m.magnitude === "big").length,
          steamMoves: steam.length,
          movements: movs,
          steam,
        };
      }).filter(s => s.moderateOrBig > 0 || s.steamMoves > 0);
      res.json({ success: true, games: summary });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // ── POST /api/clv ── Compute CLV given betting odds and closing odds ────
  app.post("/api/clv", (req, res) => {
    try {
      const { bettingOdds, closingOdds, pickId, market } = req.body || {};
      if (typeof bettingOdds !== "number" || typeof closingOdds !== "number") {
        return res.json({ success: false, error: "bettingOdds and closingOdds required" });
      }
      const clv = computeCLV(bettingOdds, closingOdds, pickId || "", market || "");
      res.json({ success: true, ...clv });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // ── GET /api/nba/context ── Contextual signals (revenge/look-ahead/b2b/load) ─
  app.get("/api/nba/context", async (req, res) => {
    try {
      const homeTri = String(req.query.home || "").toUpperCase();
      const awayTri = String(req.query.away || "").toUpperCase();
      const gameDate = String(req.query.date || ""); // MM/DD/YYYY
      if (!homeTri || !awayTri || !gameDate) {
        return res.json({ success: false, error: "home, away, date params required" });
      }

      const sched = await withCache("nba-league-schedule", async () => {
        const r = await fetch("https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json", {
          headers: { "Referer": "https://www.nba.com/", "User-Agent": "Mozilla/5.0" },
        });
        return r.json();
      }) as any;

      const gameDates = sched?.leagueSchedule?.gameDates || [];
      // Parse our target date to Date
      const [mm, dd, yyyy] = gameDate.split("/");
      const targetTs = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`).getTime();

      // Flatten
      const parseTs = (s: string) => {
        const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (!m) return 0;
        return new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`).getTime();
      };

      const allGames: any[] = [];
      for (const gd of gameDates) {
        for (const g of gd.games || []) {
          allGames.push({
            date: gd.gameDate,
            homeTri: g.homeTeam?.teamTricode,
            awayTri: g.awayTeam?.teamTricode,
            homeScore: g.homeTeam?.score || 0,
            awayScore: g.awayTeam?.score || 0,
            status: g.gameStatus,
            gameLabel: g.gameLabel || "",
            seriesGameNumber: g.seriesGameNumber || "",
            seriesText: g.seriesText || "",
          });
        }
      }

      // Determine if CURRENT game is a playoff/play-in game
      let currentIsPlayoff = false;
      for (const g of allGames) {
        if (parseTs(g.date) !== targetTs) continue;
        const isMatch = (g.homeTri === homeTri && g.awayTri === awayTri) ||
                        (g.homeTri === awayTri && g.awayTri === homeTri);
        if (!isMatch) continue;
        const lbl = (g.gameLabel || "").toLowerCase();
        if (g.seriesGameNumber || lbl.includes("playoff") || lbl.includes("round") ||
            lbl.includes("semifinal") || lbl.includes("conf final") ||
            lbl.includes("finals") || lbl.includes("play-in") || lbl.includes("play in")) {
          currentIsPlayoff = true;
        }
        break;
      }


      // Recent games (last 20 days completed) and next games (next 5 days) for each team
      const recentHome: any[] = [], recentAway: any[] = [];
      const nextHome: any[] = [], nextAway: any[] = [];
      for (const g of allGames) {
        const ts = parseTs(g.date);
        const involvesHome = g.homeTri === homeTri || g.awayTri === homeTri;
        const involvesAway = g.homeTri === awayTri || g.awayTri === awayTri;
        if (!involvesHome && !involvesAway) continue;

        const isPast = ts < targetTs && g.status === 3;
        const isFuture = ts > targetTs;

        if (isPast && (targetTs - ts) <= 20 * 24 * 3600 * 1000) {
          if (involvesHome) recentHome.push(g);
          if (involvesAway) recentAway.push(g);
        }
        if (isFuture && (ts - targetTs) <= 5 * 24 * 3600 * 1000) {
          if (involvesHome) nextHome.push(g);
          if (involvesAway) nextAway.push(g);
        }
      }

      // Compute win rates from full season schedule
      const teamWinRates: Record<string, number> = {};
      const teamRecords: Record<string, { w: number; l: number }> = {};
      for (const g of allGames) {
        if (g.status !== 3) continue;
        const hWon = g.homeScore > g.awayScore;
        for (const tri of [g.homeTri, g.awayTri]) {
          if (!tri) continue;
          if (!teamRecords[tri]) teamRecords[tri] = { w: 0, l: 0 };
        }
        if (g.homeTri) teamRecords[g.homeTri][hWon ? "w" : "l"]++;
        if (g.awayTri) teamRecords[g.awayTri][hWon ? "l" : "w"]++;
      }
      for (const [tri, r] of Object.entries(teamRecords)) {
        const total = r.w + r.l;
        if (total > 0) teamWinRates[tri] = r.w / total;
      }

      // Determine if away team is on B2B (played yesterday) and where
      const dayMs = 24 * 3600 * 1000;
      let awayB2B = false;
      let awayPrevTri: string | null = null;
      for (const g of recentAway) {
        const ts = parseTs(g.date);
        if (targetTs - ts >= 1 * dayMs && targetTs - ts < 1.5 * dayMs) {
          awayB2B = true;
          // Where did they play? home arena of that game
          awayPrevTri = g.homeTri;
          break;
        }
      }

      // Games in last 5 days for each team
      const countGamesIn5 = (games: any[]) => games.filter(g => (targetTs - parseTs(g.date)) <= 5 * dayMs && (targetTs - parseTs(g.date)) > 0).length;
      const homeGamesIn5Days = countGamesIn5(recentHome);
      const awayGamesIn5Days = countGamesIn5(recentAway);

      const context = computeContextual(homeTri, awayTri, gameDate, {
        recentGamesHome: recentHome,
        recentGamesAway: recentAway,
        nextGamesHome: nextHome,
        nextGamesAway: nextAway,
        teamWinRates,
        awayB2B,
        awayPrevTri,
        homeGamesIn5Days,
        awayGamesIn5Days,
        currentIsPlayoff,
      });

      res.json({ success: true, ...context, debug: { awayB2B, awayPrevTri, homeGamesIn5Days, awayGamesIn5Days, currentIsPlayoff } });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  // ── GET /api/mlb/context ── MLB contextual signals (series, divisional, rivalry) ──
  app.get("/api/mlb/context", async (req, res) => {
    try {
      const homeTri = String(req.query.home || "").toUpperCase();
      const awayTri = String(req.query.away || "").toUpperCase();
      const date = String(req.query.date || ""); // YYYY-MM-DD
      if (!homeTri || !awayTri || !date) {
        return res.json({ success: false, error: "home, away, date params required" });
      }

      // Pull last 7 days of MLB games to find series
      const targetTs = new Date(date).getTime();
      const sevenDaysAgo = new Date(targetTs - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const sched = await withCache(`mlb-recent-${date}`, async () => {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${sevenDaysAgo}&endDate=${date}`);
        return r.json();
      }) as any;

      // Map team IDs to tricodes via teams endpoint (cached)
      const teamsRes = await withCache("mlb-teams", async () => {
        const r = await fetch(`https://statsapi.mlb.com/api/v1/teams?sportId=1`);
        return r.json();
      }) as any;
      const idToTri: Record<number, string> = {};
      for (const t of (teamsRes.teams || [])) {
        idToTri[t.id] = t.abbreviation;
      }

      const recentGames: any[] = [];
      for (const dt of (sched.dates || [])) {
        for (const g of dt.games || []) {
          const status = g.status?.abstractGameState;
          if (status !== "Final") continue;
          const home = g.teams?.home;
          const away = g.teams?.away;
          if (!home || !away) continue;
          recentGames.push({
            date: dt.date,
            homeTeam: idToTri[home.team?.id] || home.team?.abbreviation || "",
            awayTeam: idToTri[away.team?.id] || away.team?.abbreviation || "",
            homeScore: home.score || 0,
            awayScore: away.score || 0,
            status: "Final",
          });
        }
      }

      const ctx = computeMLBContextual(homeTri, awayTri, date, recentGames);
      res.json({ success: true, ...ctx });
    } catch (e: any) {
      res.json({ success: false, error: e.message });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });}
