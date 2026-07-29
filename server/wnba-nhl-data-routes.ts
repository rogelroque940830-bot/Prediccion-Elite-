import type { Express } from "express";
import {
  FL_TZ,
  NBA_HEADERS,
  WNBA_HEADERS,
  idx,
  nbaFetch,
  todayISO,
  withCache,
  wnbaFetch,
} from "./route-runtime";

/** WNBA and NHL provider aggregation routes. */
export function registerWnbaNhlDataRoutes(app: Express): void {
  // ════════════════════════════════════════════════════════════════════════════
  // WNBA ROUTES (same NBA API with LeagueID=10)
  // ════════════════════════════════════════════════════════════════════════════

  app.get("/api/wnba/all", async (req, res) => {
    try {
      const data = await withCache("wnba-all-v2", async () => {
        // WNBA uses same NBA stats API with LeagueID=10, Season format is just year "2025"
        // Pedimos ambos: season completa (LastNGames=0) y últimos 10 (LastNGames=10)
        // para poder hacer blend recent/season en el frontend.
        const buildUrl = (lastN: number, measureType: "Advanced" | "Base") =>
          `https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=${lastN}&LeagueID=10&Location=&MeasureType=${measureType}&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2026&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
        const [advSeasonJson, baseSeasonJson, advL10Json, baseL10Json] = await Promise.all([
          wnbaFetch(buildUrl(0, "Advanced")),
          wnbaFetch(buildUrl(0, "Base")),
          wnbaFetch(buildUrl(10, "Advanced")),
          wnbaFetch(buildUrl(10, "Base")),
        ]);
        const parseAdv = (json: any) => {
          const H: string[] = json.resultSets[0].headers;
          const R: unknown[][] = json.resultSets[0].rowSet;
          const out: Record<number, any> = {};
          for (const r of R) {
            const tid = r[idx(H, "TEAM_ID")] as number;
            out[tid] = {
              teamId: tid,
              teamName: r[idx(H, "TEAM_NAME")],
              netRtg: r[idx(H, "NET_RATING")],
              offRtg: r[idx(H, "OFF_RATING")],
              defRtg: r[idx(H, "DEF_RATING")],
              pace: r[idx(H, "PACE")],
            };
          }
          return out;
        };
        const parseBase = (json: any) => {
          const H: string[] = json.resultSets[0].headers;
          const R: unknown[][] = json.resultSets[0].rowSet;
          const out: Record<number, { w: number; l: number; gp: number; ppg: number; winPct: number }> = {};
          for (const r of R) {
            const tid = r[idx(H, "TEAM_ID")] as number;
            const w = (r[idx(H, "W")] as number) || 0;
            const l = (r[idx(H, "L")] as number) || 0;
            const gp = w + l;
            out[tid] = {
              w, l, gp,
              ppg: r[idx(H, "PTS")] as number,
              winPct: gp > 0 ? Math.round((w / gp) * 100) / 100 : 0.5,
            };
          }
          return out;
        };

        const advS = parseAdv(advSeasonJson);
        const baseS = parseBase(baseSeasonJson);
        const advL = parseAdv(advL10Json);
        const baseL = parseBase(baseL10Json);

        const teams: any[] = [];
        for (const tid of Object.keys(advS).map(Number)) {
          const a = advS[tid]; const b = baseS[tid] ?? { w: 0, l: 0, gp: 0, ppg: a.offRtg, winPct: 0.5 };
          const aL = advL[tid] ?? a; const bL = baseL[tid] ?? b;
          teams.push({
            teamId: tid,
            teamName: a.teamName,
            // Season completa (más estable)
            netRtg: a.netRtg, offRtg: a.offRtg, defRtg: a.defRtg, pace: a.pace,
            winPct: b.winPct, ppg: b.ppg, gamesPlayed: b.gp, wins: b.w, losses: b.l,
            // Últimos 10 (forma reciente)
            recentNetRtg: aL.netRtg, recentOffRtg: aL.offRtg, recentDefRtg: aL.defRtg,
            recentPace: aL.pace, recentPpg: bL.ppg, recentWinPct: bL.winPct,
          });
        }
        return teams;
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("wnba direct source error", e);
      try {
        const fallbackUrl = (process.env.WNBA_READONLY_FALLBACK_URL || "https://web-production-7067b.up.railway.app/api/wnba/all").trim();
        const currentHost = (req.get("host") || "").toLowerCase();
        if (currentHost && fallbackUrl.toLowerCase().includes(currentHost)) {
          throw new Error("Refusing recursive WNBA fallback");
        }

        const fallbackData = await withCache("wnba-all-production-fallback-v1", async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            const fallbackRes = await fetch(fallbackUrl, {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            if (!fallbackRes.ok) {
              throw new Error(`WNBA fallback HTTP ${fallbackRes.status}`);
            }
            const payload: any = await fallbackRes.json();
            if (!payload?.success || !Array.isArray(payload.data) || payload.data.length === 0) {
              throw new Error("WNBA fallback returned invalid or empty data");
            }
            return payload.data;
          } finally {
            clearTimeout(timer);
          }
        });

        return res.json({
          success: true,
          data: fallbackData,
          source: "production-readonly-fallback",
        });
      } catch (fallbackError) {
        console.error("wnba production fallback error", fallbackError);
        return res.status(500).json({ success: false, error: "No se pudieron obtener datos WNBA" });
      }
    }
  });

  // ── GET /api/wnba/games ── Schedule del día (LeagueID=10)
  app.get("/api/wnba/games", async (req, res) => {
    try {
      const date = (req.query.date as string) || todayNBA();
      const cacheKey = `wnba-schedule-${date}`;
      const data = await withCache(cacheKey, async () => {
        const encoded = encodeURIComponent(date);
        const url = `https://stats.nba.com/stats/scoreboardV3?LeagueID=10&gameDate=${encoded}&DayOffset=0`;
        const json = await wnbaFetch(url);
        const games: unknown[] = json.scoreboard?.games ?? [];
        return (games as any[]).map((g) => ({
          gameId: g.gameId,
          gameTimeUTC: g.gameTimeUTC,
          homeTeam: { id: g.homeTeam.teamId, name: `${g.homeTeam.teamCity} ${g.homeTeam.teamName}`, tricode: g.homeTeam.teamTricode },
          awayTeam: { id: g.awayTeam.teamId, name: `${g.awayTeam.teamCity} ${g.awayTeam.teamName}`, tricode: g.awayTeam.teamTricode },
        }));
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("wnba schedule error", e);
      res.status(500).json({ success: false, error: "No se pudo obtener el calendario WNBA" });
    }
  });

  // ── GET /api/wnba/sos ── Strength of Schedule últimos 10 juegos
  // Igual que NBA pero LeagueID=10 y solo últimos 10 oponentes
  app.get("/api/wnba/sos", async (req, res) => {
    try {
      const data = await withCache("wnba-sos-v1", async () => {
        const buildUrl = (lastN: number) =>
          `https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&LastNGames=${lastN}&LeagueID=10&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2026&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
        const [advSeasonJson, advL10Json, logJson] = await Promise.all([
          wnbaFetch(buildUrl(0)),
          wnbaFetch(buildUrl(10)),
          wnbaFetch(`https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=10&PlayerOrTeam=T&Season=2026&SeasonType=Regular+Season&Sorter=DATE`),
        ]);

        const sH: string[] = advSeasonJson.resultSets[0].headers;
        const seasonById: Record<number, { offRtg: number; defRtg: number; netRtg: number; name: string }> = {};
        for (const r of advSeasonJson.resultSets[0].rowSet as unknown[][]) {
          const tid = r[idx(sH, "TEAM_ID")] as number;
          seasonById[tid] = {
            offRtg: r[idx(sH, "OFF_RATING")] as number,
            defRtg: r[idx(sH, "DEF_RATING")] as number,
            netRtg: r[idx(sH, "NET_RATING")] as number,
            name: r[idx(sH, "TEAM_NAME")] as string,
          };
        }

        const lH: string[] = advL10Json.resultSets[0].headers;
        const l10ById: Record<number, { offRtg: number; defRtg: number; netRtg: number }> = {};
        for (const r of advL10Json.resultSets[0].rowSet as unknown[][]) {
          const tid = r[idx(lH, "TEAM_ID")] as number;
          l10ById[tid] = {
            offRtg: r[idx(lH, "OFF_RATING")] as number,
            defRtg: r[idx(lH, "DEF_RATING")] as number,
            netRtg: r[idx(lH, "NET_RATING")] as number,
          };
        }

        const gH: string[] = logJson.resultSets[0].headers;
        const gR: unknown[][] = logJson.resultSets[0].rowSet;
        const abbrToId: Record<string, number> = {};
        for (const row of gR) {
          const abbr = row[idx(gH, "TEAM_ABBREVIATION")] as string;
          const tid = row[idx(gH, "TEAM_ID")] as number;
          if (abbr && !abbrToId[abbr]) abbrToId[abbr] = tid;
        }

        const teamGames: Record<number, string[]> = {};
        for (const row of gR) {
          const tid = row[idx(gH, "TEAM_ID")] as number;
          if (!teamGames[tid]) teamGames[tid] = [];
          if (teamGames[tid].length < 10) {
            const matchup = row[idx(gH, "MATCHUP")] as string;
            const parts = matchup.includes("vs.") ? matchup.split(" vs. ") : matchup.split(" @ ");
            if (parts.length === 2) teamGames[tid].push(parts[1].trim());
          }
        }

        const result: any[] = [];
        for (const [tidStr, opps] of Object.entries(teamGames)) {
          const tid = Number(tidStr);
          let sumOff = 0, sumDef = 0, sumNet = 0, count = 0;
          for (const oppAbbr of opps) {
            const oppId = abbrToId[oppAbbr];
            if (!oppId || !seasonById[oppId]) continue;
            const s = seasonById[oppId];
            const l = l10ById[oppId];
            const blendOff = l ? s.offRtg * 0.4 + l.offRtg * 0.6 : s.offRtg;
            const blendDef = l ? s.defRtg * 0.4 + l.defRtg * 0.6 : s.defRtg;
            sumOff += blendOff; sumDef += blendDef; sumNet += (blendOff - blendDef); count++;
          }
          if (count > 0) {
            const avgNet = sumNet / count;
            let sosLabel = "";
            if (avgNet > 4) sosLabel = "Agenda MUY dificil";
            else if (avgNet > 1.5) sosLabel = "Agenda dificil";
            else if (avgNet > -1.5) sosLabel = "Agenda promedio";
            else if (avgNet > -4) sosLabel = "Agenda facil";
            else sosLabel = "Agenda MUY facil";
            result.push({
              teamId: tid,
              oppAvgNetRtg: Math.round(avgNet * 10) / 10,
              oppAvgOffRtg: Math.round((sumOff / count) * 10) / 10,
              oppAvgDefRtg: Math.round((sumDef / count) * 10) / 10,
              sosLabel,
            });
          }
        }
        return result;
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("wnba sos error", e);
      res.status(500).json({ success: false, error: "No se pudo calcular SOS WNBA" });
    }
  });

  // ── GET /api/wnba/fatigue ── B2B granular + games in last 7 days + streak
  app.get("/api/wnba/fatigue", async (req, res) => {
    try {
      const data = await withCache("wnba-fatigue-v1", async () => {
        const url = `https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=10&PlayerOrTeam=T&Season=2026&SeasonType=Regular+Season&Sorter=DATE`;
        const json = await wnbaFetch(url);
        const H: string[] = json.resultSets[0].headers;
        const R: unknown[][] = json.resultSets[0].rowSet;
        // Por equipo: lista [{date, isHome, opponent, win}]
        const teamGames: Record<number, { date: string; isHome: boolean; wl: string }[]> = {};
        for (const row of R) {
          const tid = row[idx(H, "TEAM_ID")] as number;
          const matchup = row[idx(H, "MATCHUP")] as string;
          const date = row[idx(H, "GAME_DATE")] as string;
          const wl = row[idx(H, "WL")] as string;
          if (!teamGames[tid]) teamGames[tid] = [];
          teamGames[tid].push({ date, isHome: matchup.includes("vs."), wl });
        }
        const results: any[] = [];
        const today = new Date();
        for (const [tidStr, games] of Object.entries(teamGames)) {
          const tid = Number(tidStr);
          if (games.length === 0) continue;
          const last = games[0];
          const lastDate = new Date(last.date);
          const daysSinceLast = Math.max(0, Math.floor((today.getTime() - lastDate.getTime()) / 86400000));
          // ¿Hubo otro juego un día antes del último? → B2B detectado
          let isB2B = false;
          let b2bWasRoad = false;
          if (games.length >= 2) {
            const prevDate = new Date(games[1].date);
            const diff = Math.floor((lastDate.getTime() - prevDate.getTime()) / 86400000);
            isB2B = diff <= 1;
            b2bWasRoad = isB2B && !games[1].isHome;
          }
          // Juegos en los últimos 7 días (carga reciente)
          const sevenDaysAgo = new Date(today.getTime() - 7 * 86400000);
          const gamesLast7 = games.filter(g => new Date(g.date) >= sevenDaysAgo).length;
          // Streak (últimos 5 con mismo W/L)
          let streak = 0;
          if (games.length > 0) {
            const direction = games[0].wl === "W" ? 1 : -1;
            for (const g of games) {
              if ((g.wl === "W" ? 1 : -1) === direction) streak += direction;
              else break;
            }
          }
          results.push({
            teamId: tid,
            daysRest: daysSinceLast,
            isB2B,
            b2bWasRoad,
            gamesLast7Days: gamesLast7,
            streak,
          });
        }
        return results;
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("wnba fatigue direct source error", e);
      try {
        const fallbackUrl = (process.env.WNBA_READONLY_FATIGUE_FALLBACK_URL || "https://web-production-7067b.up.railway.app/api/wnba/fatigue").trim();
        const currentHost = (req.get("host") || "").toLowerCase();
        if (currentHost && fallbackUrl.toLowerCase().includes(currentHost)) {
          throw new Error("Refusing recursive WNBA fatigue fallback");
        }

        const fallbackData = await withCache("wnba-fatigue-production-fallback-v1", async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            const fallbackRes = await fetch(fallbackUrl, {
              headers: { Accept: "application/json" },
              signal: controller.signal,
            });
            if (!fallbackRes.ok) {
              throw new Error(`WNBA fatigue fallback HTTP ${fallbackRes.status}`);
            }
            const payload: any = await fallbackRes.json();
            if (!payload?.success || !Array.isArray(payload.data) || payload.data.length === 0) {
              throw new Error("WNBA fatigue fallback returned invalid or empty data");
            }
            return payload.data;
          } finally {
            clearTimeout(timer);
          }
        });

        return res.json({
          success: true,
          data: fallbackData,
          source: "production-readonly-fallback",
        });
      } catch (fallbackError) {
        console.error("wnba fatigue production fallback error", fallbackError);
        return res.status(500).json({ success: false, error: "No se pudo calcular fatigue WNBA" });
      }
    }
  });

  // ── WNBA Player Stats ── Top jugadores por equipo para Star Power Index
  // GET /api/wnba/injuries — Auto-fill desde ESPN HTML payload
  app.get("/api/wnba/injuries", async (req, res) => {
    try {
      const { fetchWNBAInjuries } = await import("./wnba-injuries");
      const data = await fetchWNBAInjuries();
      res.json({ success: true, data, cached: true });
    } catch (e: any) {
      console.error("wnba/injuries error:", e);
      res.status(500).json({ success: false, error: e.message || "Failed" });
    }
  });

  // GET /api/wnba/shot-profile/:espnTeamId — Shot tendencies por equipo
  app.get("/api/wnba/shot-profile/:espnTeamId", async (req, res) => {
    try {
      const { fetchTeamShotProfile } = await import("./wnba-shot-profile");
      const id = parseInt(req.params.espnTeamId);
      if (!id) return res.status(400).json({ success: false, error: "Invalid team id" });
      const teamName = (req.query.teamName as string) || "";
      const data = await fetchTeamShotProfile(id, teamName);
      if (!data) return res.json({ success: false, error: "No data available" });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || "Failed" });
    }
  });

  // GET /api/wnba/h2h?home=X&away=Y — H2H 2 años
  app.get("/api/wnba/h2h", async (req, res) => {
    try {
      const { getH2H } = await import("./wnba-shot-profile");
      const home = parseInt(req.query.home as string);
      const away = parseInt(req.query.away as string);
      if (!home || !away) return res.status(400).json({ success: false, error: "home & away team IDs required" });
      const data = await getH2H(home, away);
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || "Failed" });
    }
  });

  app.get("/api/wnba/players", async (req, res) => {
    try {
      const data = await withCache("wnba-players-v1", async () => {
        const url = `https://stats.nba.com/stats/leaguedashplayerstats?College=&Conference=&Country=&DateFrom=&DateTo=&Division=&DraftPick=&DraftYear=&GameScope=&GameSegment=&Height=&LastNGames=0&LeagueID=10&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2026&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=&Weight=`;
        const json = await wnbaFetch(url);
        const H: string[] = json.resultSets[0].headers;
        const R: unknown[][] = json.resultSets[0].rowSet;
        const players: Record<number, any[]> = {};
        for (const r of R) {
          const tid = r[idx(H, "TEAM_ID")] as number;
          const gp = (r[idx(H, "GP")] as number) || 0;
          const min = (r[idx(H, "MIN")] as number) || 0;
          if (gp < 5 || min < 5) continue;
          const p = {
            playerId: r[idx(H, "PLAYER_ID")] as number,
            name: r[idx(H, "PLAYER_NAME")] as string,
            teamId: tid,
            teamAbbr: r[idx(H, "TEAM_ABBREVIATION")] as string,
            gp, min,
            ppg: (r[idx(H, "PTS")] as number) || 0,
            apg: (r[idx(H, "AST")] as number) || 0,
            rpg: (r[idx(H, "REB")] as number) || 0,
            spg: (r[idx(H, "STL")] as number) || 0,
            bpg: (r[idx(H, "BLK")] as number) || 0,
            fgPct: (r[idx(H, "FG_PCT")] as number) || 0,
          };
          if (!players[tid]) players[tid] = [];
          players[tid].push(p);
        }
        for (const tid of Object.keys(players).map(Number)) {
          players[tid].sort((a, b) => b.min - a.min);
        }
        return players;
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("wnba players error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener jugadores WNBA" });
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // NHL ROUTES
  // ════════════════════════════════════════════════════════════════════════════

  function nhlSeasonContext(dateIso: string): { seasonId: string; moneyPuckYear: string } {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(dateIso)
      ? new Date(`${dateIso}T12:00:00Z`)
      : new Date();
    const year = parsed.getUTCFullYear();
    const month = parsed.getUTCMonth() + 1;
    // NHL/MoneyPuck season folders use the year in which the season starts.
    // During the summer offseason we keep the completed season until August.
    const startYear = month >= 8 ? year : year - 1;
    return { seasonId: `${startYear}${startYear + 1}`, moneyPuckYear: String(startYear) };
  }

  app.get("/api/nhl/all", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || todayISO();
      const { seasonId: nhlSeasonId, moneyPuckYear: nhlMoneyPuckYear } = nhlSeasonContext(dateParam);
      const cacheKey = `nhl-all-v10-${nhlSeasonId}-${dateParam}`;

      const data = await withCache(cacheKey, async () => {
        // 1. Schedule
        const schedJson = await (await fetch(`https://api-web.nhle.com/v1/schedule/${dateParam}`)).json();
        const rawGames: any[] = schedJson.gameWeek?.[0]?.games ?? [];

        // 2. Standings (has GF, GA, W, L, streaks)
        const standJson = await (await fetch("https://api-web.nhle.com/v1/standings/now")).json();
        const standings: any[] = standJson.standings ?? [];

        const teamMap: Record<string, any> = {};
        for (const t of standings) {
          const abbr = t.teamAbbrev?.default;
          if (!abbr) continue;
          const gp = t.gamesPlayed || 1;
          const l10GP = t.l10GamesPlayed || 10;
          teamMap[abbr] = {
            name: t.teamName?.default || abbr,
            abbr,
            goalsFor: Math.round((t.goalFor / gp) * 100) / 100,
            goalsAgainst: Math.round((t.goalAgainst / gp) * 100) / 100,
            wins: t.wins,
            losses: t.losses,
            otLosses: t.otLosses,
            gamesPlayed: gp,
            // WinRate treats OT/SO losses as half-wins (ties), per MoneyPuck methodology
            // Points %: (W*2 + OTL*1) / (GP*2) — same as NHL standings points %
            winRate: Math.round(((t.wins * 2 + (t.otLosses || 0)) / Math.max(1, gp * 2)) * 100) / 100,
            streak: t.streakCode === "W" ? (t.streakCount || 0) : -(t.streakCount || 0),
            // Last 10 games stats
            l10GF: t.l10GoalsFor ? Math.round((t.l10GoalsFor / l10GP) * 100) / 100 : undefined,
            l10GA: t.l10GoalsAgainst ? Math.round((t.l10GoalsAgainst / l10GP) * 100) / 100 : undefined,
            l10Wins: t.l10Wins || 0,
            l10Losses: (t.l10Losses || 0) + (t.l10OtLosses || 0),
          };
        }

        // 3. Compute SOS from standings — for each team in a game, 
        // the SOS is based on the OPPONENT'S overall GF/game relative to league average.
        // Higher SOS = team has been facing strong offensive opponents
        // We compute league avg GF from all teams in standings
        const allTeamGFs = Object.values(teamMap).map((t: any) => t.goalsFor).filter(Boolean);
        const leagueAvgGF = allTeamGFs.length > 0 
          ? allTeamGFs.reduce((s: number, g: number) => s + g, 0) / allTeamGFs.length 
          : 3.10;

        // 4. Fetch team detailed stats (PP%, PK%, Shots, Corsi)
        const teamDetailMap: Record<string, any> = {};
        try {
          const summJson = await (await fetch(`https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=${nhlSeasonId}`)).json();
          for (const t of summJson.data ?? []) {
            // Find matching team by name
            const abbr = Object.entries(teamMap).find(([_, v]) => (v as any).name === t.teamFullName)?.[0];
            if (abbr) {
              teamDetailMap[abbr as string] = {
                ppPct: Math.round((t.powerPlayPct || 0) * 1000) / 10,
                pkPct: Math.round((t.penaltyKillPct || 0) * 1000) / 10,
                shotsFor: Math.round((t.shotsForPerGame || 30) * 10) / 10,
                shotsAgainst: Math.round((t.shotsAgainstPerGame || 30) * 10) / 10,
              };
            }
          }
        } catch (e) {
          console.error("NHL team details error", e);
        }

        // 4b. Fetch MoneyPuck advanced stats (xG, Corsi 5v5, SH%, HD chances, GSAx)
        const mpTeamMap: Record<string, any> = {};
        const mpGoalieMap: Record<string, any> = {};
        try {
          const [mpTeamRes, mpGRes] = await Promise.all([
            fetch(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${nhlMoneyPuckYear}/regular/teams.csv`),
            fetch(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${nhlMoneyPuckYear}/regular/goalies.csv`),
          ]);
          
          // Parse team CSV
          const mpTeamCsv = await mpTeamRes.text();
          const mpTeamRows = mpTeamCsv.split("\n").map(r => r.split(","));
          const mpTH = mpTeamRows[0];
          const tI = (n: string) => mpTH.indexOf(n);
          
          for (let i = 1; i < mpTeamRows.length; i++) {
            const r = mpTeamRows[i];
            if (r.length < 10) continue;
            const abbr = r[tI("team")];
            const sit = r[tI("situation")];
            const gp = parseFloat(r[tI("games_played")]) || 1;
            if (!mpTeamMap[abbr]) mpTeamMap[abbr] = {};
            
            if (sit === "5on5") {
              mpTeamMap[abbr].xGF = Math.round((parseFloat(r[tI("xGoalsFor")]) / gp) * 100) / 100;
              mpTeamMap[abbr].xGA = Math.round((parseFloat(r[tI("xGoalsAgainst")]) / gp) * 100) / 100;
              // Score-venue adjusted xG (accounts for score-state effects)
              const saXGF = parseFloat(r[tI("scoreVenueAdjustedxGoalsFor")]);
              const saXGA = parseFloat(r[tI("scoreVenueAdjustedxGoalsAgainst")]);
              if (saXGF) mpTeamMap[abbr].scoreAdjXGF = Math.round((saXGF / gp) * 100) / 100;
              if (saXGA) mpTeamMap[abbr].scoreAdjXGA = Math.round((saXGA / gp) * 100) / 100;
              mpTeamMap[abbr].cf5v5 = Math.round(parseFloat(r[tI("corsiPercentage")]) * 1000) / 10;
              const sogF = parseFloat(r[tI("shotsOnGoalFor")]) || 1;
              const gfR = parseFloat(r[tI("goalsFor")]) || 0;
              mpTeamMap[abbr].shPct = Math.round((gfR / sogF) * 1000) / 10;
              mpTeamMap[abbr].hdCF = Math.round((parseFloat(r[tI("highDangerShotsFor")]) / gp) * 100) / 100;
              mpTeamMap[abbr].hdCA = Math.round((parseFloat(r[tI("highDangerShotsAgainst")]) / gp) * 100) / 100;
            } else if (sit === "5on4") {
              mpTeamMap[abbr].ppGF = Math.round((parseFloat(r[tI("goalsFor")]) / gp) * 100) / 100;
            } else if (sit === "4on5") {
              mpTeamMap[abbr].pkGA = Math.round((parseFloat(r[tI("goalsAgainst")]) / gp) * 100) / 100;
            }
          }
          
          // Parse goalie CSV
          const mpGCsv = await mpGRes.text();
          const mpGRows = mpGCsv.split("\n").map(r => r.split(","));
          const mpGH = mpGRows[0];
          const gI = (n: string) => mpGH.indexOf(n);
          
          for (let i = 1; i < mpGRows.length; i++) {
            const r = mpGRows[i];
            if (r.length < 10 || r[gI("situation")] !== "all") continue;
            const gName = r[gI("name")];
            const gTeam = r[gI("team")];
            const gp = parseFloat(r[gI("games_played")]) || 1;
            const xGoals = parseFloat(r[gI("xGoals")]) || 0;
            const goals = parseFloat(r[gI("goals")]) || 0;
            const gsax = xGoals - goals;
            if (!mpGoalieMap[gTeam]) mpGoalieMap[gTeam] = {};
            mpGoalieMap[gTeam][gName] = {
              gsax: Math.round((gsax / gp) * 100) / 100,
              gsaxTotal: Math.round(gsax * 10) / 10,
              gp,
            };
          }
          // Parse skater data for top players per team (injury impact)
          const mpSkaterMap: Record<string, { name: string; pos: string; gp: number; gameScore: number }[]> = {};
          try {
            const mpSRes = await fetch(`https://moneypuck.com/moneypuck/playerData/seasonSummary/${nhlMoneyPuckYear}/regular/skaters.csv`);
            const mpSCsv = await mpSRes.text();
            const mpSRows = mpSCsv.split("\n").map(r => r.split(","));
            const mpSH = mpSRows[0];
            const sI = (n: string) => mpSH.indexOf(n);
            
            for (let i = 1; i < mpSRows.length; i++) {
              const r = mpSRows[i];
              if (r.length < 10 || r[sI("situation")] !== "all") continue;
              const sTeam = r[sI("team")];
              const sName = r[sI("name")];
              const sPos = r[sI("position")];
              const sGP = parseInt(r[sI("games_played")]) || 0;
              const sGS = parseFloat(r[sI("gameScore")]) || 0;
              if (!mpSkaterMap[sTeam]) mpSkaterMap[sTeam] = [];
              mpSkaterMap[sTeam].push({ name: sName, pos: sPos, gp: sGP, gameScore: Math.round(sGS * 10) / 10 });
            }
            // Sort each team by gameScore descending, keep top 6
            for (const team of Object.keys(mpSkaterMap)) {
              mpSkaterMap[team].sort((a, b) => b.gameScore - a.gameScore);
              mpSkaterMap[team] = mpSkaterMap[team].slice(0, 6);
            }
          } catch {}
          // Add top players to teamMap
          for (const [abbr, players] of Object.entries(mpSkaterMap)) {
            if (teamMap[abbr]) {
              (teamMap[abbr] as any).topPlayers = players;
            }
          }

          console.log(`MoneyPuck loaded: ${Object.keys(mpTeamMap).length} teams, ${Object.values(mpGoalieMap).reduce((s, m) => s + Object.keys(m).length, 0)} goalies, ${Object.keys(mpSkaterMap).length} team rosters`);
        } catch (e) {
          console.error("MoneyPuck fetch error (non-critical)", e);
        }

        // 4c. Fetch probable goalies from DailyFaceoff (most accurate source)
        //    DailyFaceoff has confirmed/expected starters with name + season stats
        //    NHL gamecenter only lists ALL goalies without indicating who starts
        const goalieMap: Record<string, any> = {};
        
        // Map team full names to abbreviations for DailyFaceoff matching
        const nameToAbbr: Record<string, string> = {};
        for (const [abbr, t] of Object.entries(teamMap)) {
          nameToAbbr[(t as any).name] = abbr;
        }

        // Step A: Get probable starters from DailyFaceoff + RotoWire (cross-reference)
        //   DailyFaceoff sometimes lags behind; we also try RotoWire as secondary
        const dfGoalieMap: Record<string, { name: string; svPct?: number; gaa?: number; wins: number; losses: number; otl: number; status: string }> = {};

        // A1: DailyFaceoff
        try {
          const dfRes = await fetch(`https://www.dailyfaceoff.com/starting-goalies/${dateParam}`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
          });
          const dfHtml = await dfRes.text();
          const dfMatch = dfHtml.match(/"props":\{"pageProps":\{"data":(\[.*?\])/);
          if (dfMatch) {
            const dfData = JSON.parse(dfMatch[1]);
            for (const dg of dfData) {
              // Home goalie
              const homeTeamName = dg.homeTeamName || "";
              const homeAbbr = Object.entries(nameToAbbr).find(([name]) => 
                name === homeTeamName || homeTeamName.includes(name) || name.includes(homeTeamName.split(' ').pop() || '')
              )?.[1];
              if (homeAbbr && dg.homeGoalieName) {
                dfGoalieMap[homeAbbr] = {
                  name: dg.homeGoalieName,
                  svPct: dg.homeGoalieSavePercentage !== "" && dg.homeGoalieSavePercentage != null && Number.isFinite(Number(dg.homeGoalieSavePercentage)) && Number(dg.homeGoalieSavePercentage) > 0 && Number(dg.homeGoalieSavePercentage) <= 1 ? Math.round(Number(dg.homeGoalieSavePercentage) * 1000) / 1000 : undefined,
                  gaa: dg.homeGoalieGoalsAgainstAvg !== "" && dg.homeGoalieGoalsAgainstAvg != null && Number.isFinite(Number(dg.homeGoalieGoalsAgainstAvg)) && Number(dg.homeGoalieGoalsAgainstAvg) >= 0 ? Math.round(Number(dg.homeGoalieGoalsAgainstAvg) * 100) / 100 : undefined,
                  wins: dg.homeGoalieWins || 0,
                  losses: dg.homeGoalieLosses || 0,
                  otl: dg.homeGoalieOvertimeLosses || 0,
                  status: dg.homeNewsStrengthName || "Expected",
                };
              }
              // Away goalie
              const awayTeamName = dg.awayTeamName || "";
              const awayAbbr = Object.entries(nameToAbbr).find(([name]) => 
                name === awayTeamName || awayTeamName.includes(name) || name.includes(awayTeamName.split(' ').pop() || '')
              )?.[1];
              if (awayAbbr && dg.awayGoalieName) {
                dfGoalieMap[awayAbbr] = {
                  name: dg.awayGoalieName,
                  svPct: dg.awayGoalieSavePercentage !== "" && dg.awayGoalieSavePercentage != null && Number.isFinite(Number(dg.awayGoalieSavePercentage)) && Number(dg.awayGoalieSavePercentage) > 0 && Number(dg.awayGoalieSavePercentage) <= 1 ? Math.round(Number(dg.awayGoalieSavePercentage) * 1000) / 1000 : undefined,
                  gaa: dg.awayGoalieGoalsAgainstAvg !== "" && dg.awayGoalieGoalsAgainstAvg != null && Number.isFinite(Number(dg.awayGoalieGoalsAgainstAvg)) && Number(dg.awayGoalieGoalsAgainstAvg) >= 0 ? Math.round(Number(dg.awayGoalieGoalsAgainstAvg) * 100) / 100 : undefined,
                  wins: dg.awayGoalieWins || 0,
                  losses: dg.awayGoalieLosses || 0,
                  otl: dg.awayGoalieOvertimeLosses || 0,
                  status: dg.awayNewsStrengthName || "Expected",
                };
              }
            }
          }
        } catch (e) {
          console.error("DailyFaceoff fetch error", e);
        }

        // Note: RotoWire is fully JS-rendered and cannot be fetched server-side.
        // DailyFaceoff is the most reliable server-fetchable source for probable goalies.
        // NHL.com game-day previews update after morning skate and can confirm starters.

        // Step B: Get NHL gamecenter data for player IDs (needed for game logs)
        //         AND as fallback if DailyFaceoff fails
        const nhlGoalieIdMap: Record<string, { playerId: number; name: string; svPct: number; gaa: number; record: string; gp: number }[]> = {};
        const gcPromises = rawGames.map(async (g: any) => {
          try {
            const gcJson = await (await fetch(`https://api-web.nhle.com/v1/gamecenter/${g.id}/landing`)).json();
            const gc = gcJson.matchup?.goalieComparison;
            if (!gc) return;
            for (const side of ["homeTeam", "awayTeam"] as const) {
              const abbr = g[side]?.abbrev;
              const leaders = gc[side]?.leaders;
              if (!abbr || !leaders) continue;
              nhlGoalieIdMap[abbr] = leaders.flatMap((l: any) => {
                const goalieName = ((l.firstName?.default || "") + " " + (l.lastName?.default || "")).trim();
                const rawSvPct = Number(l.savePctg);
                const rawGaa = Number(l.gaa ?? l.goalsAgainstAverage);
                if (!goalieName || !Number.isFinite(rawSvPct) || rawSvPct <= 0 || rawSvPct > 1 || !Number.isFinite(rawGaa) || rawGaa < 0) {
                  return [];
                }
                return [{
                  playerId: l.playerId,
                  name: goalieName,
                  svPct: Math.round(rawSvPct * 1000) / 1000,
                  gaa: Math.round(rawGaa * 100) / 100,
                  record: typeof l.record === "string" ? l.record : "",
                  gp: l.gamesPlayed || 0,
                }];
              });
            }
          } catch {}
        });
        await Promise.all(gcPromises);

        // Step C: For each team, find the probable starter and fetch their game log
        const allAbbrs = new Set<string>();
        for (const g of rawGames) {
          if (g.homeTeam?.abbrev) allAbbrs.add(g.homeTeam.abbrev);
          if (g.awayTeam?.abbrev) allAbbrs.add(g.awayTeam.abbrev);
        }

        const goalieLogPromises = Array.from(allAbbrs).map(async (abbr) => {
          const dfGoalie = dfGoalieMap[abbr];
          const nhlGoalies = nhlGoalieIdMap[abbr] || [];

          // Find the correct goalie: prefer DailyFaceoff name, match to NHL ID
          let starterName = dfGoalie?.name || "";
          let starterSvPct: number | undefined = dfGoalie?.svPct;
          let starterGaa: number | undefined = dfGoalie?.gaa;
          let starterRecord = dfGoalie ? `${dfGoalie.wins}-${dfGoalie.losses}-${dfGoalie.otl}` : "";
          let starterGP = 0;
          let starterPlayerId: number | null = null;
          let confirmStatus = dfGoalie?.status || "UNCONFIRMED";

          if (dfGoalie && nhlGoalies.length > 0) {
            // Match DailyFaceoff name to NHL player ID (fuzzy: last name match)
            const dfLastName = dfGoalie.name.split(" ").pop()?.toLowerCase() || "";
            const matched = nhlGoalies.find(g => g.name.toLowerCase().includes(dfLastName));
            if (matched) {
              starterPlayerId = matched.playerId;
              starterGP = matched.gp;
              // Use NHL stats (more precise) but keep DailyFaceoff name
              starterSvPct = matched.svPct;
              starterGaa = matched.gaa;
              starterRecord = matched.record;
            }
          } else if (!dfGoalie && nhlGoalies.length > 0) {
            // NHL goalieComparison contains team leaders/candidates, not a confirmed starter.
            // Keep them only in goalieOptions; never promote the highest-GP goalie automatically.
            confirmStatus = "UNCONFIRMED";
          }

          // Fetch recent game log (last 5 starts) for the probable starter
          let recentGAA: number | undefined;
          let recentSvPct: number | undefined;
          let last5Record = "";
          if (starterPlayerId) {
            try {
              const glRes = await fetch(`https://api-web.nhle.com/v1/player/${starterPlayerId}/game-log/${nhlSeasonId}/2`);
              const glJson = await glRes.json();
              const glGames: any[] = (glJson.gameLog ?? []).slice(0, 5);
              if (glGames.length >= 3) {
                const totalGA = glGames.reduce((s: number, gg: any) => s + (gg.goalsAgainst || 0), 0);
                recentGAA = Math.round((totalGA / glGames.length) * 100) / 100;
                const totalSvP = glGames.reduce((s: number, gg: any) => s + (gg.savePctg || 0), 0);
                recentSvPct = Math.round((totalSvP / glGames.length) * 1000) / 1000;
                const recentW = glGames.filter((gg: any) => gg.decision === "W").length;
                const recentL = glGames.length - recentW;
                last5Record = recentW + "-" + recentL;
              }
            } catch {}
          }

          // Attach MoneyPuck GSAx if available
          const mpGTeam = mpGoalieMap[abbr] || {};
          let gsax: number | undefined;
          if (starterName) {
            // Try exact match first, then fuzzy by last name
            const mpG = mpGTeam[starterName] || 
              Object.entries(mpGTeam).find(([n]) => {
                const lastName = starterName.split(" ").pop()?.toLowerCase() || "";
                return n.toLowerCase().includes(lastName);
              })?.[1] as any;
            if (mpG) gsax = mpG.gsax;
          }

          if (starterName && Number.isFinite(starterSvPct) && Number.isFinite(starterGaa)) {
            const normalizedStatus = String(confirmStatus || "UNCONFIRMED").toUpperCase();
            goalieMap[abbr] = {
              name: starterName,
              savePct: starterSvPct,
              gaa: starterGaa,
              record: starterRecord,
              gamesPlayed: starterGP,
              recentGAA,
              recentSvPct,
              last5Record,
              confirmStatus,
              confirmed: normalizedStatus.includes("CONFIRMED") && !normalizedStatus.includes("UNCONFIRMED"),
              source: "dailyfaceoff",
              gsax,
            };
          }
        });
        await Promise.all(goalieLogPromises);

        // Merge detail stats + MoneyPuck advanced stats into teamMap
        for (const [abbr, detail] of Object.entries(teamDetailMap)) {
          if (teamMap[abbr]) {
            teamMap[abbr] = { ...teamMap[abbr], ...detail };
          }
        }
        for (const [abbr, mp] of Object.entries(mpTeamMap)) {
          if (teamMap[abbr]) {
            teamMap[abbr] = { ...teamMap[abbr], ...mp };
          }
        }

        // 5b. Fetch rosters for each team in today's games (for injury/lineup system)
        const rosterMap: Record<string, any[]> = {};
        const rosterAbbrs = new Set<string>();
        for (const g of rawGames) {
          if (g.homeTeam?.abbrev) rosterAbbrs.add(g.homeTeam.abbrev);
          if (g.awayTeam?.abbrev) rosterAbbrs.add(g.awayTeam.abbrev);
        }
        const rosterPromises = Array.from(rosterAbbrs).map(async (tricode) => {
          try {
            const rosterData = await withCache(`nhl-roster-${tricode}`, async () => {
              const rRes = await fetch(`https://api-web.nhle.com/v1/club-stats/${tricode}/${nhlSeasonId}/2`);
              if (!rRes.ok) return null;
              return rRes.json();
            });
            if (!rosterData) return;

            const skaters: any[] = rosterData.skaters ?? [];
            const goalies: any[] = rosterData.goalies ?? [];

            // Determine teamGP as max GP among all players
            const allGPs = [
              ...skaters.map((s: any) => s.gamesPlayed || 0),
              ...goalies.map((g: any) => g.gamesPlayed || 0),
            ];
            const teamGP = allGPs.length > 0 ? Math.max(...allGPs) : 0;

            const roster: any[] = [];

            // Skaters: sorted by points DESC
            const sortedSkaters = [...skaters].sort((a: any, b: any) => (b.points || 0) - (a.points || 0));
            for (const s of sortedSkaters) {
              const name = ((s.firstName?.default || "") + " " + (s.lastName?.default || "")).trim();
              const gp = s.gamesPlayed || 0;
              roster.push({
                name,
                position: s.positionCode || "C",
                gp,
                goals: s.goals || 0,
                assists: s.assists || 0,
                points: s.points || 0,
                toi: s.avgTimeOnIcePerGame || 0,
                plusMinus: s.plusMinus || 0,
                gamesMissed: teamGP - gp,
                sweaterNumber: s.sweaterNumber || 0,
              });
            }

            // Goalies: add with position "G", goals/assists/points = 0
            for (const g of goalies) {
              const name = ((g.firstName?.default || "") + " " + (g.lastName?.default || "")).trim();
              const gp = g.gamesPlayed || 0;
              roster.push({
                name,
                position: "G",
                gp,
                goals: 0,
                assists: 0,
                points: 0,
                toi: 0,
                plusMinus: 0,
                gamesMissed: teamGP - gp,
                sweaterNumber: g.sweaterNumber || 0,
              });
            }

            rosterMap[tricode] = roster;
          } catch (e) {
            console.error(`Roster fetch error for ${tricode}`, e);
          }
        });
        await Promise.all(rosterPromises);

        // 5b. Fetch recent opponents (L10) for each team
        const recentOppsMap: Record<string, { opp: string; result: string; score: string; venue: string }[]> = {};
        const oppsPromises = Array.from(rosterAbbrs).map(async (tricode) => {
          try {
            const schedData = await withCache(`nhl-sched-${tricode}`, () =>
              fetch(`https://api-web.nhle.com/v1/club-schedule-season/${tricode}/${nhlSeasonId}`).then(r => r.json())
            );
            const completed = (schedData.games || []).filter((sg: any) =>
              sg.gameState === "OFF" || sg.gameState === "FINAL"
            );
            const last10 = completed.slice(-10);
            recentOppsMap[tricode] = last10.map((sg: any) => {
              const hAbbr = sg.homeTeam?.abbrev;
              const aAbbr = sg.awayTeam?.abbrev;
              const isHome = hAbbr === tricode;
              const opp = isHome ? aAbbr : hAbbr;
              const hs = sg.homeTeam?.score ?? 0;
              const as_ = sg.awayTeam?.score ?? 0;
              const won = isHome ? hs > as_ : as_ > hs;
              return {
                opp,
                result: won ? "W" : "L",
                score: isHome ? `${hs}-${as_}` : `${as_}-${hs}`,
                venue: isHome ? "vs" : "@",
              };
            });
          } catch {}
        });
        await Promise.all(oppsPromises);

        // 5c. Compute Home/Away splits from season schedule
        const splitsMap: Record<string, { homeGF: number; homeGA: number; awayGF: number; awayGA: number; homeW: number; homeL: number; awayW: number; awayL: number }> = {};
        for (const tricode of Array.from(rosterAbbrs)) {
          try {
            const schedData = await withCache(`nhl-sched-${tricode}`, () =>
              fetch(`https://api-web.nhle.com/v1/club-schedule-season/${tricode}/${nhlSeasonId}`).then(r => r.json())
            );
            const completed = (schedData.games || []).filter((sg: any) =>
              sg.gameState === "OFF" || sg.gameState === "FINAL"
            );
            let hGF = 0, hGA = 0, hGP = 0, aGF = 0, aGA = 0, aGP = 0;
            let hW = 0, hL = 0, aW = 0, aL = 0;
            for (const sg of completed) {
              const hAbbr = sg.homeTeam?.abbrev;
              const aAbbr = sg.awayTeam?.abbrev;
              const hs = sg.homeTeam?.score ?? 0;
              const as_ = sg.awayTeam?.score ?? 0;
              if (hAbbr === tricode) {
                hGF += hs; hGA += as_; hGP++;
                if (hs > as_) hW++; else hL++;
              } else if (aAbbr === tricode) {
                aGF += as_; aGA += hs; aGP++;
                if (as_ > hs) aW++; else aL++;
              }
            }
            splitsMap[tricode] = {
              homeGF: hGP > 0 ? Math.round((hGF / hGP) * 100) / 100 : 0,
              homeGA: hGP > 0 ? Math.round((hGA / hGP) * 100) / 100 : 0,
              awayGF: aGP > 0 ? Math.round((aGF / aGP) * 100) / 100 : 0,
              awayGA: aGP > 0 ? Math.round((aGA / aGP) * 100) / 100 : 0,
              homeW: hW, homeL: hL, awayW: aW, awayL: aL,
            };
          } catch (e) { console.error(`Splits error ${tricode}:`, e); }
        }

        // 5d. Pre-compute H2H for each game pair from cached schedule data
        const h2hMap: Record<string, { homeWins: number; awayWins: number; label: string }> = {};
        for (const g of rawGames.filter((g: any) => g.gameType === 2 || g.gameType === 3)) {
          const hA = g.homeTeam?.abbrev;
          const aA = g.awayTeam?.abbrev;
          if (!hA || !aA) continue;
          const key = `${hA}-${aA}`;
          if (h2hMap[key]) continue;
          let hWins = 0, aWins = 0;
          try {
            const schedData = await withCache(`nhl-sched-${hA}`, () =>
              fetch(`https://api-web.nhle.com/v1/club-schedule-season/${hA}/${nhlSeasonId}`).then(r => r.json())
            );
            const completed = (schedData.games || []).filter((sg: any) =>
              sg.gameState === "OFF" || sg.gameState === "FINAL"
            );
            for (const sg of completed) {
              const sgH = sg.homeTeam?.abbrev;
              const sgA = sg.awayTeam?.abbrev;
              if (!((sgH === hA && sgA === aA) || (sgH === aA && sgA === hA))) continue;
              const hs = sg.homeTeam?.score ?? 0;
              const as_ = sg.awayTeam?.score ?? 0;
              if (sgH === hA) { if (hs > as_) hWins++; else aWins++; }
              else { if (as_ > hs) hWins++; else aWins++; }
            }
          } catch {}
          h2hMap[key] = {
            homeWins: hWins,
            awayWins: aWins,
            label: (hWins + aWins > 0) ? `${hA} ${hWins}-${aWins} ${aA}` : "",
          };
        }

        // 6. Assemble games — compute SOS per matchup
        return rawGames.filter((g: any) => g.gameType === 2 || g.gameType === 3).map((g: any) => {
          const homeAbbr = g.homeTeam?.abbrev;
          const awayAbbr = g.awayTeam?.abbrev;
          const homeData = teamMap[homeAbbr] || null;
          const awayData = teamMap[awayAbbr] || null;
          
          // SOS for home: based on away team's offensive strength (the opponent they face)
          // But conceptually SOS should reflect the quality of opponents in RECENT games.
          // Since we have l10GF/l10GA for the team, we estimate SOS from their opponents:
          // If a team has low GA in L10 but faced high-GF opponents, SOS is high.
          // Simplification: SOS = opponent's GF / league avg GF
          let homeSOS: number | undefined;
          let awaySOS: number | undefined;
          
          if (awayData?.goalsFor) {
            homeSOS = Math.round((awayData.goalsFor / leagueAvgGF) * 100) / 100;
          }
          if (homeData?.goalsFor) {
            awaySOS = Math.round((homeData.goalsFor / leagueAvgGF) * 100) / 100;
          }
          
          // Add sosScore to team stats for auto-fill
          if (homeData) homeData.sosScore = homeSOS;
          if (awayData) awayData.sosScore = awaySOS;

          // H2H from pre-computed map
          const h2hKey = `${homeAbbr}-${awayAbbr}`;
          const h2hData = h2hMap[h2hKey] || { homeWins: 0, awayWins: 0, label: "" };

          // Add splits to stats objects
          const homeSplits = splitsMap[homeAbbr];
          const awaySplits = splitsMap[awayAbbr];
          if (homeData && homeSplits) {
            homeData.homeGF = homeSplits.homeGF;
            homeData.homeGA = homeSplits.homeGA;
            homeData.awayGF = homeSplits.awayGF;
            homeData.awayGA = homeSplits.awayGA;
            homeData.homeRecord = `${homeSplits.homeW}-${homeSplits.homeL}`;
            homeData.awayRecord = `${homeSplits.awayW}-${homeSplits.awayL}`;
          }
          if (awayData && awaySplits) {
            awayData.homeGF = awaySplits.homeGF;
            awayData.homeGA = awaySplits.homeGA;
            awayData.awayGF = awaySplits.awayGF;
            awayData.awayGA = awaySplits.awayGA;
            awayData.homeRecord = `${awaySplits.homeW}-${awaySplits.homeL}`;
            awayData.awayRecord = `${awaySplits.awayW}-${awaySplits.awayL}`;
          }

          return {
            gameId: g.id,
            gameTime: g.startTimeUTC,
            homeTeam: { name: homeData?.name || homeAbbr, abbr: homeAbbr },
            awayTeam: { name: awayData?.name || awayAbbr, abbr: awayAbbr },
            // Include ALL goalies from NHL API so user can pick the right one (with GSAx)
            homeGoalieOptions: (nhlGoalieIdMap[homeAbbr] || []).map(g => {
              const mpG = (mpGoalieMap[homeAbbr] || {})[g.name] ||
                Object.entries(mpGoalieMap[homeAbbr] || {}).find(([n]) => n.toLowerCase().includes(g.name.split(" ").pop()?.toLowerCase() || ""))?.[1] as any;
              return { name: g.name, svPct: g.svPct, gaa: g.gaa, record: g.record, gp: g.gp, gsax: mpG?.gsax };
            }),
            awayGoalieOptions: (nhlGoalieIdMap[awayAbbr] || []).map(g => {
              const mpG = (mpGoalieMap[awayAbbr] || {})[g.name] ||
                Object.entries(mpGoalieMap[awayAbbr] || {}).find(([n]) => n.toLowerCase().includes(g.name.split(" ").pop()?.toLowerCase() || ""))?.[1] as any;
              return { name: g.name, svPct: g.svPct, gaa: g.gaa, record: g.record, gp: g.gp, gsax: mpG?.gsax };
            }),
            homeStats: homeData,
            awayStats: awayData,
            homeGoalie: goalieMap[homeAbbr] || null,
            awayGoalie: goalieMap[awayAbbr] || null,
            homeRoster: rosterMap[homeAbbr] || [],
            awayRoster: rosterMap[awayAbbr] || [],
            h2h: h2hData.label,
            h2hHomeWins: h2hData.homeWins,
            h2hAwayWins: h2hData.awayWins,
            homeSOS,
            awaySOS,
            homeRecentOpps: recentOppsMap[homeAbbr] || [],
            awayRecentOpps: recentOppsMap[awayAbbr] || [],
            isPlayoffs: g.gameType === 3,
          };
        });
      });

      res.json({ success: true, games: data, date: dateParam, seasonId: nhlSeasonId, asOf: new Date().toISOString() });
    } catch (e) {
      console.error("nhl error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener datos NHL" });
    }
  });

}
