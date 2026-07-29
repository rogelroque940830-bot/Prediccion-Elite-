import type { Express } from "express";
import {
  NBA_HEADERS,
  SEASON,
  SELF_URL,
  idx,
  isoToNBA,
  nbaFetch,
  nbaToISO,
  todayNBA,
  withCache,
} from "./route-runtime";

/** NBA shared-data routes retained with their existing response contracts. */
export function registerNbaDataRoutes(app: Express): void {
  // ── GET /api/nba/teams ───────────────────────────────────────────────────
  // Returns BLENDED advanced stats: 60% season + 40% L10 for ratings
  // Also returns raw season + L10 separately for transparency
  app.get("/api/nba/teams", async (req, res) => {
    try {
      const data = await withCache("teams-advanced-blended", async () => {
        const [seasonJson, l10Json] = await Promise.all([
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=10&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
        ]);
        const sH: string[] = seasonJson.resultSets[0].headers;
        const sR: unknown[][] = seasonJson.resultSets[0].rowSet;
        const lH: string[] = l10Json.resultSets[0].headers;
        const lR: unknown[][] = l10Json.resultSets[0].rowSet;
        
        // Build L10 map by teamId
        const l10Map: Record<number, any> = {};
        for (const row of lR) {
          l10Map[row[idx(lH, "TEAM_ID")] as number] = {
            netRtg: row[idx(lH, "NET_RATING")] as number,
            offRtg: row[idx(lH, "OFF_RATING")] as number,
            defRtg: row[idx(lH, "DEF_RATING")] as number,
            pace:   row[idx(lH, "PACE")] as number,
          };
        }
        
        // Blend: 60% season + 40% L10 for a balanced view
        return sR.map((row) => {
          const tid = row[idx(sH, "TEAM_ID")] as number;
          const sOff = row[idx(sH, "OFF_RATING")] as number;
          const sDef = row[idx(sH, "DEF_RATING")] as number;
          const sNet = row[idx(sH, "NET_RATING")] as number;
          const sPace = row[idx(sH, "PACE")] as number;
          const l = l10Map[tid];
          
          // Blend 60% season + 40% L10
          const offRtg = l ? Math.round((sOff * 0.6 + l.offRtg * 0.4) * 10) / 10 : sOff;
          const defRtg = l ? Math.round((sDef * 0.6 + l.defRtg * 0.4) * 10) / 10 : sDef;
          const netRtg = Math.round((offRtg - defRtg) * 10) / 10;
          const pace   = l ? Math.round((sPace * 0.6 + l.pace * 0.4) * 10) / 10 : sPace;
          
          return {
            teamId: tid,
            teamName: row[idx(sH, "TEAM_NAME")],
            netRtg,
            offRtg,
            defRtg,
            pace,
            // Raw values for transparency
            seasonNetRtg: sNet,
            seasonOffRtg: sOff,
            seasonDefRtg: sDef,
            l10NetRtg: l?.netRtg,
            l10OffRtg: l?.offRtg,
            l10DefRtg: l?.defRtg,
          };
        });
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("teams error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener stats avanzadas" });
    }
  });

  // ── GET /api/nba/winrate ─────────────────────────────────────────────────
  // Returns W/L record and PPG for last 10 games
  app.get("/api/nba/winrate", async (req, res) => {
    try {
      const data = await withCache("teams-base-v2", async () => {
        const [seasonJson, l10Json] = await Promise.all([
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=10&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
        ]);
        const sH: string[] = seasonJson.resultSets[0].headers;
        const sR: unknown[][] = seasonJson.resultSets[0].rowSet;
        const lH: string[] = l10Json.resultSets[0].headers;
        const lR: unknown[][] = l10Json.resultSets[0].rowSet;
        // Build L10 map
        const l10Map: Record<number, { ppg: number; l10WinPct: number }> = {};
        for (const row of lR) {
          l10Map[row[idx(lH, "TEAM_ID")] as number] = {
            ppg: row[idx(lH, "PTS")] as number,
            l10WinPct: row[idx(lH, "W_PCT")] as number,
          };
        }
        return sR.map((row) => {
          const tid = row[idx(sH, "TEAM_ID")] as number;
          const l10 = l10Map[tid];
          return {
            teamId:  tid,
            wins:    row[idx(sH, "W")] as number,
            losses:  row[idx(sH, "L")] as number,
            winPct:  row[idx(sH, "W_PCT")] as number,  // SEASON win%
            ppg:     l10 ? l10.ppg : row[idx(sH, "PTS")] as number,  // keep L10 PPG for Poisson
            l10WinPct: l10?.l10WinPct,
          };
        });
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("winrate error", e);
      res.status(500).json({ success: false, error: "No se pudo obtener el Win Rate" });
    }
  });

  // ── GET /api/nba/schedule ────────────────────────────────────────────────
  // Returns today's (or a given date's) games
  app.get("/api/nba/schedule", async (req, res) => {
    try {
      const date = (req.query.date as string) || todayNBA();
      const cacheKey = `schedule-${date}`;
      const data = await withCache(cacheKey, async () => {
        const encoded = encodeURIComponent(date);
        const url = `https://stats.nba.com/stats/scoreboardV3?LeagueID=00&gameDate=${encoded}&DayOffset=0`;
        const json = await nbaFetch(url);
        const games: unknown[] = json.scoreboard?.games ?? [];
        return (games as any[]).map((g) => ({
          gameId: g.gameId,
          gameTimeUTC: g.gameTimeUTC,
          homeTeam: {
            id:       g.homeTeam.teamId,
            name:     `${g.homeTeam.teamCity} ${g.homeTeam.teamName}`,
            tricode:  g.homeTeam.teamTricode,
          },
          awayTeam: {
            id:       g.awayTeam.teamId,
            name:     `${g.awayTeam.teamCity} ${g.awayTeam.teamName}`,
            tricode:  g.awayTeam.teamTricode,
          },
        }));
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("schedule error", e);
      res.status(500).json({ success: false, error: "No se pudo obtener el schedule de hoy" });
    }
  });

  // ── GET /api/nba/recent5 ───────────────────────────────────────────────
  // Returns stats for last 5 games (Pace + PPG)
  app.get("/api/nba/recent5", async (req, res) => {
    try {
      const data = await withCache("teams-recent5", async () => {
        const [advJson, baseJson] = await Promise.all([
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=5&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=5&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
        ]);
        const aH: string[] = advJson.resultSets[0].headers;
        const aR: unknown[][] = advJson.resultSets[0].rowSet;
        const bH: string[] = baseJson.resultSets[0].headers;
        const bR: unknown[][] = baseJson.resultSets[0].rowSet;

        const baseMap: Record<number, { ppg5: number }> = {};
        for (const row of bR) {
          baseMap[row[idx(bH, "TEAM_ID")] as number] = {
            ppg5: row[idx(bH, "PTS")] as number,
          };
        }

        return aR.map((row) => {
          const teamId = row[idx(aH, "TEAM_ID")] as number;
          return {
            teamId,
            pace5:  row[idx(aH, "PACE")],
            ppg5:   baseMap[teamId]?.ppg5 ?? 0,
          };
        });
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("recent5 error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener stats de ultimos 5" });
    }
  });

  // ── GET /api/nba/sos ─────────────────────────────────────────────────
  // SOS v2: Uses BLENDED (60% L10 + 40% season) stats of opponents
  // Returns opponent list with names and NetRtg for UI context
  app.get("/api/nba/sos", async (req, res) => {
    try {
      const data = await withCache("teams-sos-v2", async () => {
        // Fetch season + L10 advanced stats + game log in parallel
        const [advSeasonJson, advL10Json, logJson] = await Promise.all([
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=10&LeagueID=00&Location=&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`),
          nbaFetch(`https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=00&PlayerOrTeam=T&Season=${SEASON}&SeasonType=Regular+Season&Sorter=DATE`),
        ]);

        const sH: string[] = advSeasonJson.resultSets[0].headers;
        const sR: unknown[][] = advSeasonJson.resultSets[0].rowSet;
        const seasonById: Record<number, { offRtg: number; defRtg: number; netRtg: number; name: string }> = {};
        for (const r of sR) {
          const tid = r[idx(sH, "TEAM_ID")] as number;
          seasonById[tid] = {
            offRtg: r[idx(sH, "OFF_RATING")] as number,
            defRtg: r[idx(sH, "DEF_RATING")] as number,
            netRtg: r[idx(sH, "NET_RATING")] as number,
            name: r[idx(sH, "TEAM_NAME")] as string,
          };
        }

        const l10H: string[] = advL10Json.resultSets[0].headers;
        const l10R: unknown[][] = advL10Json.resultSets[0].rowSet;
        const l10ById: Record<number, { offRtg: number; defRtg: number; netRtg: number }> = {};
        for (const r of l10R) {
          const tid = r[idx(l10H, "TEAM_ID")] as number;
          l10ById[tid] = {
            offRtg: r[idx(l10H, "OFF_RATING")] as number,
            defRtg: r[idx(l10H, "DEF_RATING")] as number,
            netRtg: r[idx(l10H, "NET_RATING")] as number,
          };
        }

        const lH: string[] = logJson.resultSets[0].headers;
        const lR: unknown[][] = logJson.resultSets[0].rowSet;
        const abbrToId: Record<string, number> = {};
        const abbrI = lH.indexOf("TEAM_ABBREVIATION");
        if (abbrI >= 0) {
          for (const row of lR) {
            const abbr = row[abbrI] as string;
            const tid = row[idx(lH, "TEAM_ID")] as number;
            if (abbr && !abbrToId[abbr]) abbrToId[abbr] = tid;
          }
        }

        const teamGames: Record<number, string[]> = {};
        for (const row of lR) {
          const tid = row[idx(lH, "TEAM_ID")] as number;
          if (!teamGames[tid]) teamGames[tid] = [];
          if (teamGames[tid].length < 10) {
            const matchup = row[idx(lH, "MATCHUP")] as string;
            const parts = matchup.includes("vs.") ? matchup.split(" vs. ") : matchup.split(" @ ");
            if (parts.length === 2) teamGames[tid].push(parts[1].trim());
          }
        }

        // Compute SOS using BLENDED opponent ratings (60% L10 + 40% season)
        const result: any[] = [];
        for (const [tidStr, opps] of Object.entries(teamGames)) {
          const tid = Number(tidStr);
          let sumOff = 0, sumDef = 0, sumNet = 0, count = 0;
          const oppDetails: { name: string; netRtg: number; l10NetRtg: number; blended: number }[] = [];

          for (const oppAbbr of opps) {
            const oppId = abbrToId[oppAbbr];
            if (!oppId || !seasonById[oppId]) continue;
            const s = seasonById[oppId];
            const l = l10ById[oppId];
            const blendOff = l ? s.offRtg * 0.4 + l.offRtg * 0.6 : s.offRtg;
            const blendDef = l ? s.defRtg * 0.4 + l.defRtg * 0.6 : s.defRtg;
            const blendNet = blendOff - blendDef;
            sumOff += blendOff; sumDef += blendDef; sumNet += blendNet; count++;
            oppDetails.push({
              name: s.name,
              netRtg: Math.round(s.netRtg * 10) / 10,
              l10NetRtg: l ? Math.round(l.netRtg * 10) / 10 : Math.round(s.netRtg * 10) / 10,
              blended: Math.round(blendNet * 10) / 10,
            });
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
              oppAvgOffRtg: Math.round((sumOff / count) * 10) / 10,
              oppAvgDefRtg: Math.round((sumDef / count) * 10) / 10,
              oppAvgNetRtg: Math.round(avgNet * 10) / 10,
              sosLabel,
              opponents: oppDetails,
            });
          }
        }
        return result;
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("sos error", e);
      res.status(500).json({ success: false, error: "No se pudo calcular SOS" });
    }
  });


  // ── GET /api/nba/form ──────────────────────────────────────────────────
  // Returns streak, B2B status, and days rest for each team
  app.get("/api/nba/form", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || todayNBA();
      const cacheKey = `form-${dateParam}`;
      const data = await withCache(cacheKey, async () => {
        // Parse target date
        const [mm, dd, yyyy] = dateParam.split("/").map(Number);
        const targetDate = new Date(yyyy, mm - 1, dd);

        // Get game log — BOTH Regular Season AND Playoffs
        // (en playoffs el modelo necesita los partidos recientes de la postemporada)
        const baseLogUrl = (st: string) => `https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=00&PlayerOrTeam=T&Season=${SEASON}&SeasonType=${st}&Sorter=DATE`;
        const [regJson, poJson, pinJson] = await Promise.all([
          nbaFetch(baseLogUrl("Regular+Season")),
          nbaFetch(baseLogUrl("Playoffs")).catch(() => ({ resultSets: [{ headers: [], rowSet: [] }] })),
          nbaFetch(baseLogUrl("PlayIn")).catch(() => ({ resultSets: [{ headers: [], rowSet: [] }] })),
        ]);

        const lH: string[] = regJson.resultSets[0].headers;
        const lR_reg: unknown[][] = regJson.resultSets[0].rowSet;
        const lR_po: unknown[][] = poJson.resultSets?.[0]?.rowSet || [];
        const lR_pin: unknown[][] = pinJson.resultSets?.[0]?.rowSet || [];
        // Merge all rows
        const lR: unknown[][] = [...lR_po, ...lR_pin, ...lR_reg];

        const tidI = lH.indexOf("TEAM_ID");
        const dateI = lH.indexOf("GAME_DATE");
        const wlI = lH.indexOf("WL");

        // Group games by team, sort by date DESC
        const teamGames: Record<number, { date: string; wl: string; ts: number }[]> = {};
        for (const row of lR) {
          const tid = row[tidI] as number;
          const dStr = row[dateI] as string;
          const ts = new Date(dStr).getTime();
          if (isNaN(ts)) continue;
          if (!teamGames[tid]) teamGames[tid] = [];
          teamGames[tid].push({
            date: dStr,
            wl: row[wlI] as string,
            ts,
          });
        }
        // Sort each team's games by date desc and trim to 15
        for (const tid in teamGames) {
          teamGames[tid].sort((a, b) => b.ts - a.ts);
          teamGames[tid] = teamGames[tid].slice(0, 15);
        }

        const results: { teamId: number; streak: number; isB2B: boolean; daysRest: number; gamesLast7Days: number }[] = [];
        for (const [tidStr, games] of Object.entries(teamGames)) {
          if (games.length === 0) continue;

          // Streak: count consecutive same result from most recent
          let streak = 0;
          const firstResult = games[0].wl;
          for (const g of games) {
            if (g.wl === firstResult) streak++;
            else break;
          }
          if (firstResult === "L") streak = -streak;

          // Days rest: target date - last game date - 1
          let lastGameDate: Date | null = null;
          try {
            const dStr = games[0].date;
            lastGameDate = new Date(dStr);
          } catch {}

          let daysRest = 1;
          let isB2B = false;
          if (lastGameDate && !isNaN(lastGameDate.getTime())) {
            const diffMs = targetDate.getTime() - lastGameDate.getTime();
            const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
            daysRest = Math.max(0, diffDays - 1);
            isB2B = diffDays <= 1;
          }

          // Games in last 7 days (fatigue indicator)
          let gamesLast7Days = 0;
          const sevenDaysAgo = new Date(targetDate.getTime() - 7 * 24 * 60 * 60 * 1000);
          for (const g of games) {
            try {
              const gDate = new Date(g.date);
              if (gDate >= sevenDaysAgo && gDate <= targetDate) gamesLast7Days++;
            } catch {}
          }

          results.push({
            teamId: Number(tidStr),
            streak,
            isB2B,
            daysRest,
            gamesLast7Days,
          });
        }
        return results;
      });
      res.json({ success: true, data });
    } catch (e) {
      console.error("form error", e);
      res.status(500).json({ success: false, error: "No se pudo calcular forma" });
    }
  });

  // ── GET /api/nba/all ─────────────────────────────────────────────────────
  // Returns combined stats for all teams in one request (schedule + adv + base)
  app.get("/api/nba/all", async (req, res) => {
    try {
      const date = (req.query.date as string) || todayNBA();
      const [schedRes, advRes, baseRes, r5Res, sosRes, formRes] = await Promise.all([
        fetch(`${SELF_URL}/api/nba/schedule?date=${encodeURIComponent(date)}`).then(r => r.json()),
        fetch(`${SELF_URL}/api/nba/teams`).then(r => r.json()),
        fetch(`${SELF_URL}/api/nba/winrate`).then(r => r.json()),
        fetch(`${SELF_URL}/api/nba/recent5`).then(r => r.json()).catch(() => ({ success: false, data: [] })),
        fetch(`${SELF_URL}/api/nba/sos`).then(r => r.json()).catch(() => ({ success: false, data: [] })),
        fetch(`${SELF_URL}/api/nba/form?date=${encodeURIComponent(date)}`).then(r => r.json()).catch(() => ({ success: false, data: [] })),
      ]);

      if (!schedRes.success || !advRes.success || !baseRes.success) {
        throw new Error("One or more endpoints failed");
      }

      // Fetch Four Factors (season + L10) for advanced NBA analytics
      let ffSeason: any[] = [];
      let ffL10: any[] = [];
      try {
        const [ffSeasonJson, ffL10Json] = await Promise.all([
          withCache("nba-ff-season", () => {
            const url = `https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Four+Factors&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
            return nbaFetch(url);
          }),
          withCache("nba-ff-l10", () => {
            const url = `https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=10&LeagueID=00&Location=&MeasureType=Four+Factors&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`;
            return nbaFetch(url);
          }),
        ]);
        const ffH = ffSeasonJson.resultSets[0].headers as string[];
        ffSeason = (ffSeasonJson.resultSets[0].rowSet as any[]).map((r: any) => ({
          teamId: r[ffH.indexOf("TEAM_ID")],
          eFGPct: r[ffH.indexOf("EFG_PCT")],
          ftRate: r[ffH.indexOf("FTA_RATE")],
          tovPct: r[ffH.indexOf("TM_TOV_PCT")],
          orebPct: r[ffH.indexOf("OREB_PCT")],
          oppEFGPct: r[ffH.indexOf("OPP_EFG_PCT")],
          oppFTRate: r[ffH.indexOf("OPP_FTA_RATE")],
          oppTovPct: r[ffH.indexOf("OPP_TOV_PCT")],
          oppOrebPct: r[ffH.indexOf("OPP_OREB_PCT")],
          gp: r[ffH.indexOf("GP")],
        }));
        const ffH2 = ffL10Json.resultSets[0].headers as string[];
        ffL10 = (ffL10Json.resultSets[0].rowSet as any[]).map((r: any) => ({
          teamId: r[ffH2.indexOf("TEAM_ID")],
          l10eFGPct: r[ffH2.indexOf("EFG_PCT")],
          l10FTRate: r[ffH2.indexOf("FTA_RATE")],
          l10TovPct: r[ffH2.indexOf("TM_TOV_PCT")],
          l10OrebPct: r[ffH2.indexOf("OREB_PCT")],
          l10OppEFGPct: r[ffH2.indexOf("OPP_EFG_PCT")],
          l10OppFTRate: r[ffH2.indexOf("OPP_FTA_RATE")],
          l10OppTovPct: r[ffH2.indexOf("OPP_TOV_PCT")],
          l10OppOrebPct: r[ffH2.indexOf("OPP_OREB_PCT")],
        }));
        console.log(`NBA Four Factors loaded: ${ffSeason.length} season, ${ffL10.length} L10`);
      } catch (e) {
        console.error("Four Factors fetch error (non-critical)", e);
      }

      // Fetch Home/Away rating splits
      let homeSplits: any[] = [];
      let awaySplits: any[] = [];
      try {
        const [homeJson, awayJson] = await Promise.all([
          withCache("nba-home-splits", () =>
            nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=Home&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`)
          ),
          withCache("nba-away-splits", () =>
            nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=Road&MeasureType=Advanced&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`)
          ),
        ]);
        const hH = homeJson.resultSets[0].headers as string[];
        homeSplits = (homeJson.resultSets[0].rowSet as any[]).map((r: any) => ({
          teamId: r[hH.indexOf("TEAM_ID")],
          homeOffRtg: r[hH.indexOf("OFF_RATING")],
          homeDefRtg: r[hH.indexOf("DEF_RATING")],
          homeNetRtg: r[hH.indexOf("NET_RATING")],
          homeW: r[hH.indexOf("W")],
          homeL: r[hH.indexOf("L")],
        }));
        const aH = awayJson.resultSets[0].headers as string[];
        awaySplits = (awayJson.resultSets[0].rowSet as any[]).map((r: any) => ({
          teamId: r[aH.indexOf("TEAM_ID")],
          awayOffRtg: r[aH.indexOf("OFF_RATING")],
          awayDefRtg: r[aH.indexOf("DEF_RATING")],
          awayNetRtg: r[aH.indexOf("NET_RATING")],
          awayW: r[aH.indexOf("W")],
          awayL: r[aH.indexOf("L")],
        }));
        console.log(`NBA Home/Away splits loaded: ${homeSplits.length} + ${awaySplits.length}`);
      } catch (e) {
        console.error("Home/Away splits error (non-critical)", e);
      }

      // Build a teamId → stats map
      const statsMap: Record<number, any> = {};
      for (const t of advRes.data) {
        statsMap[t.teamId] = { ...t };
      }
      for (const t of baseRes.data) {
        if (statsMap[t.teamId]) {
          statsMap[t.teamId] = { ...statsMap[t.teamId], ...t };
        }
      }
      // Merge recent 5 stats
      if (r5Res.success) {
        for (const t of r5Res.data) {
          if (statsMap[t.teamId]) {
            statsMap[t.teamId].pace5 = t.pace5;
            statsMap[t.teamId].ppg5 = t.ppg5;
          }
        }
      }
      // Merge SOS v2 (blended L10+season opponent ratings)
      if (sosRes.success) {
        for (const t of sosRes.data) {
          if (statsMap[t.teamId]) {
            statsMap[t.teamId].oppAvgOffRtg = t.oppAvgOffRtg;
            statsMap[t.teamId].oppAvgDefRtg = t.oppAvgDefRtg;
            statsMap[t.teamId].oppAvgNetRtg = t.oppAvgNetRtg;
            statsMap[t.teamId].sosLabel = t.sosLabel;
            statsMap[t.teamId].opponents = t.opponents;
          }
        }
      }
      // Merge form (streak, B2B, days rest)
      if (formRes.success) {
        for (const t of formRes.data) {
          if (statsMap[t.teamId]) {
            statsMap[t.teamId].streak = t.streak;
            statsMap[t.teamId].isB2B = t.isB2B;
            statsMap[t.teamId].daysRest = t.daysRest;
            statsMap[t.teamId].gamesLast7Days = t.gamesLast7Days;
          }
        }
      }
      // Fetch all player stats for rosters (one API call for all 582 players)
      let allPlayerStats: any[] = [];
      try {
        const pJson = await withCache("nba-all-player-stats", () =>
          nbaFetch(`https://stats.nba.com/stats/leaguedashplayerstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`)
        );
        const pH = pJson.resultSets[0].headers as string[];
        const pRows = pJson.resultSets[0].rowSet as any[];
        const pI = (n: string) => pH.indexOf(n);
        allPlayerStats = pRows.map((r: any) => ({
          playerId: r[pI("PLAYER_ID")],
          name: r[pI("PLAYER_NAME")],
          teamId: r[pI("TEAM_ID")],
          teamAbbr: r[pI("TEAM_ABBREVIATION")],
          gp: r[pI("GP")],
          ppg: Math.round(r[pI("PTS")] * 10) / 10,
          rpg: Math.round(r[pI("REB")] * 10) / 10,
          apg: Math.round(r[pI("AST")] * 10) / 10,
          mpg: Math.round(r[pI("MIN")] * 10) / 10,
        }));
        console.log(`NBA players loaded: ${allPlayerStats.length}`);
      } catch (e) {
        console.error("Player stats fetch error (non-critical)", e);
      }

      // Build roster map by teamId (sorted by MPG desc, top 10)
      const rosterMap: Record<number, any[]> = {};
      for (const p of allPlayerStats) {
        if (!rosterMap[p.teamId]) rosterMap[p.teamId] = [];
        rosterMap[p.teamId].push(p);
      }
      for (const teamId of Object.keys(rosterMap)) {
        rosterMap[Number(teamId)].sort((a: any, b: any) => b.mpg - a.mpg);
        rosterMap[Number(teamId)] = rosterMap[Number(teamId)].slice(0, 15);
      }

      // Merge Four Factors (season)
      for (const t of ffSeason) {
        if (statsMap[t.teamId]) {
          statsMap[t.teamId] = { ...statsMap[t.teamId], ...t };
        }
      }
      // Merge Four Factors (L10)
      for (const t of ffL10) {
        if (statsMap[t.teamId]) {
          statsMap[t.teamId] = { ...statsMap[t.teamId], ...t };
        }
      }

      // Merge Home/Away splits
      for (const t of homeSplits) {
        if (statsMap[t.teamId]) {
          statsMap[t.teamId].homeOffRtg = t.homeOffRtg;
          statsMap[t.teamId].homeDefRtg = t.homeDefRtg;
          statsMap[t.teamId].homeNetRtg = t.homeNetRtg;
          statsMap[t.teamId].homeRecord = `${t.homeW}-${t.homeL}`;
        }
      }
      for (const t of awaySplits) {
        if (statsMap[t.teamId]) {
          statsMap[t.teamId].awayOffRtg = t.awayOffRtg;
          statsMap[t.teamId].awayDefRtg = t.awayDefRtg;
          statsMap[t.teamId].awayNetRtg = t.awayNetRtg;
          statsMap[t.teamId].awayRecord = `${t.awayW}-${t.awayL}`;
        }
      }

      // ── SOS-aware re-blend: adjust OffRtg/DefRtg/NetRtg based on schedule difficulty ──
      // Teams with easy L10 schedules (oppAvgNetRtg < -2) get L10 weight reduced
      // Teams with tough L10 schedules (oppAvgNetRtg > +2) get L10 weight increased
      for (const [id, t] of Object.entries(statsMap) as [string, any][]) {
        if (t.seasonOffRtg !== undefined && t.l10OffRtg !== undefined && t.oppAvgNetRtg !== undefined) {
          // Base: 40% L10. Adjust by schedule difficulty.
          // oppAvgNetRtg = 0 → neutral → 40% L10
          // oppAvgNetRtg = -5 → easy → 20% L10
          // oppAvgNetRtg = +5 → tough → 55% L10
          const sosShift = Math.max(-20, Math.min(15, t.oppAvgNetRtg * 4)); // -20 to +15 shift in L10 %
          const l10Pct = Math.max(0.15, Math.min(0.55, 0.40 + sosShift / 100));
          const sPct = 1 - l10Pct;
          t.offRtg = Math.round((t.seasonOffRtg * sPct + t.l10OffRtg * l10Pct) * 10) / 10;
          t.defRtg = Math.round((t.seasonDefRtg * sPct + t.l10DefRtg * l10Pct) * 10) / 10;
          t.netRtg = Math.round((t.offRtg - t.defRtg) * 10) / 10;
        }
      }

      // Detect Play-In/Playoff via scoreboard
      let gameTypes: Record<string, string> = {};
      try {
        const sbRes = await fetch("https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json");
        const sbJson = await sbRes.json();
        for (const sg of sbJson.scoreboard?.games || []) {
          const key = `${sg.awayTeam?.teamTricode}_${sg.homeTeam?.teamTricode}`;
          gameTypes[key] = sg.seriesText || "Regular Season";
        }
      } catch {}

      // ── H2H season series for each game pair ──
      const h2hMap: Record<string, { homeWins: number; awayWins: number }> = {};
      try {
        // Use NBA game log endpoint to get FULL season results (regular + playoffs + play-in)
        const buildLogUrl = (st: string) => `https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=ASC&LeagueID=00&PlayerOrTeam=T&Season=${SEASON}&SeasonType=${st}&Sorter=DATE`;
        const [glReg, glPo, glPin] = await Promise.all([
          withCache("nba-gamelog-season-reg", () => nbaFetch(buildLogUrl("Regular+Season"))),
          withCache("nba-gamelog-season-po", () => nbaFetch(buildLogUrl("Playoffs"))).catch(() => ({ resultSets: [{ headers: [], rowSet: [] }] })),
          withCache("nba-gamelog-season-pin", () => nbaFetch(buildLogUrl("PlayIn"))).catch(() => ({ resultSets: [{ headers: [], rowSet: [] }] })),
        ]);
        const glHeaders = glReg.resultSets?.[0]?.headers as string[] || [];
        const glRows: any[][] = [
          ...(glReg.resultSets?.[0]?.rowSet || []),
          ...(glPo.resultSets?.[0]?.rowSet || []),
          ...(glPin.resultSets?.[0]?.rowSet || []),
        ];
        const tidIdx = glHeaders.indexOf("TEAM_ID");
        const matchIdx = glHeaders.indexOf("MATCHUP");
        const wlIdx = glHeaders.indexOf("WL");
        if (tidIdx >= 0 && matchIdx >= 0 && wlIdx >= 0) {
          // Build tricode→id map from statsMap
          const idToTri: Record<number, string> = {};
          for (const [id, s] of Object.entries(statsMap)) {
            const name = (s as any).teamName || "";
            // Find tricode from schedule games
            for (const sg of schedRes.data) {
              if (sg.homeTeam.id === Number(id)) idToTri[Number(id)] = sg.homeTeam.tricode;
              if (sg.awayTeam.id === Number(id)) idToTri[Number(id)] = sg.awayTeam.tricode;
            }
          }
          // Parse each game log row
          for (const row of glRows) {
            const teamId = row[tidIdx];
            const matchup = row[matchIdx] as string; // e.g. "PHX vs. POR" or "PHX @ POR"
            const wl = row[wlIdx] as string;
            // Extract opponent tricode
            const parts = matchup.split(/ vs\. | @ /);
            if (parts.length === 2) {
              const myTri = parts[0].trim();
              const oppTri = parts[1].trim();
              // Create canonical key (sorted alphabetically)
              const sortedKey = [myTri, oppTri].sort().join("_");
              if (!h2hMap[sortedKey]) h2hMap[sortedKey] = { homeWins: 0, awayWins: 0 };
              // For today's games, we store from HOME team perspective
              // So we need to know which is home in today's game — handle below
              // For now, store raw wins per tricode
              const triKey = `${sortedKey}_${myTri}`;
              if (!(h2hMap as any)[triKey]) (h2hMap as any)[triKey] = 0;
              if (wl === "W") (h2hMap as any)[triKey]++;
            }
          }
        }
        console.log("H2H game log parsed", Object.keys(h2hMap).length, "matchup pairs");
      } catch (e) {
        console.error("H2H fetch error (non-critical)", e);
      }

      // Attach stats + roster (with games missed) to each game
      const games = schedRes.data.map((g: any) => {
        const homeGP = statsMap[g.homeTeam.id]?.gp ?? 82;
        const awayGP = statsMap[g.awayTeam.id]?.gp ?? 82;
        const homeRost = (rosterMap[g.homeTeam.id] ?? []).map((p: any) => ({
          ...p,
          gamesMissed: Math.max(0, homeGP - p.gp),
        }));
        const awayRost = (rosterMap[g.awayTeam.id] ?? []).map((p: any) => ({
          ...p,
          gamesMissed: Math.max(0, awayGP - p.gp),
        }));
        const gameTypeKey = `${g.awayTeam.tricode}_${g.homeTeam.tricode}`;

        // H2H record (from home team perspective)
        const homeTri = g.homeTeam.tricode;
        const awayTri = g.awayTeam.tricode;
        const sortedH2H = [homeTri, awayTri].sort().join("_");
        const homeH2HWins = (h2hMap as any)[`${sortedH2H}_${homeTri}`] || 0;
        const awayH2HWins = (h2hMap as any)[`${sortedH2H}_${awayTri}`] || 0;
        const h2hTotal = homeH2HWins + awayH2HWins;

        return {
          ...g,
          homeStats: statsMap[g.homeTeam.id] ?? null,
          awayStats: statsMap[g.awayTeam.id] ?? null,
          homeRoster: homeRost,
          awayRoster: awayRost,
          gameType: gameTypes[gameTypeKey] || "Regular Season",
          h2h: h2hTotal > 0 ? `${homeTri} ${homeH2HWins}-${awayH2HWins} ${awayTri}` : "",
          h2hHomeWins: homeH2HWins,
          h2hAwayWins: awayH2HWins,
        };
      });

      res.json({ success: true, games, date });
    } catch (e) {
      console.error("all error", e);
      res.status(500).json({ success: false, error: "Error al cargar datos de NBA" });
    }
  });

  // ── GET /api/nba/player-impact ────────────────────────────────────────────
  // Busca un jugador por nombre y calcula su impacto en el equipo
  app.get("/api/nba/player-impact", async (req, res) => {
    try {
      const name = (req.query.name as string || "").trim();
      if (!name || name.length < 3) {
        return res.json({ success: false, error: "Nombre muy corto" });
      }

      // 1. Buscar jugador
      const allPlayersJson = await withCache("nba-all-players", () =>
        nbaFetch(`https://stats.nba.com/stats/commonallplayers?LeagueID=00&Season=${SEASON}&IsOnlyCurrentSeason=1`)
      );
      const ph = allPlayersJson.resultSets[0].headers as string[];
      const pr = allPlayersJson.resultSets[0].rowSet as unknown[][];
      const nameI = ph.indexOf("DISPLAY_FIRST_LAST");
      const pidI = ph.indexOf("PERSON_ID");
      const teamI = ph.indexOf("TEAM_ID");

      const searchLower = name.toLowerCase();
      const matches = pr.filter((r) => (r[nameI] as string)?.toLowerCase().includes(searchLower));
      if (matches.length === 0) {
        return res.json({ success: false, error: "Jugador no encontrado" });
      }

      const player = matches[0];
      const playerId = player[pidI] as number;
      const playerName = player[nameI] as string;
      const playerTeamId = player[teamI] as number;

      // 2. Fetch player stats + game log + team stats IN PARALLEL (faster)
      const [profileJson, logJson, teamStatsJson] = await Promise.all([
        withCache(`nba-player-${playerId}`, () =>
          nbaFetch(`https://stats.nba.com/stats/playerprofilev2?PlayerID=${playerId}&PerMode=PerGame&LeagueID=00`)
        ),
        withCache(`nba-playerlog-${playerId}`, () =>
          nbaFetch(`https://stats.nba.com/stats/playergamelog?PlayerID=${playerId}&Season=${SEASON}&SeasonType=Regular+Season`)
        ),
        withCache("nba-team-base-stats", () =>
          nbaFetch(`https://stats.nba.com/stats/leaguedashteamstats?Conference=&DateFrom=&DateTo=&Division=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=${SEASON}&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=`)
        ),
      ]);

      const seasonSet = profileJson.resultSets?.find((rs: any) => rs.name === "SeasonTotalsRegularSeason");
      const sh = seasonSet?.headers as string[] || [];
      const rows = seasonSet?.rowSet as unknown[][] || [];
      const currentSeason = rows[rows.length - 1];

      let ppg = 0, rpg = 0, apg = 0, mpg = 0, gp = 0;
      if (currentSeason) {
        ppg = currentSeason[sh.indexOf("PTS")] as number || 0;
        rpg = currentSeason[sh.indexOf("REB")] as number || 0;
        apg = currentSeason[sh.indexOf("AST")] as number || 0;
        mpg = currentSeason[sh.indexOf("MIN")] as number || 0;
        gp = currentSeason[sh.indexOf("GP")] as number || 0;
      }

      const lh = logJson.resultSets[0].headers as string[];
      const lr = logJson.resultSets[0].rowSet as unknown[][];
      const lastGameDate = lr.length > 0 ? lr[0][lh.indexOf("GAME_DATE")] as string : null;

      const th2 = teamStatsJson.resultSets[0].headers as string[];
      const tr2 = teamStatsJson.resultSets[0].rowSet as unknown[][];
      const teamRow = tr2.find((r) => r[th2.indexOf("TEAM_ID")] === playerTeamId);
      const teamGP = teamRow ? teamRow[th2.indexOf("GP")] as number : 82;
      const teamName = teamRow ? teamRow[th2.indexOf("TEAM_NAME")] as string : "Equipo";
      const gamesMissed = teamGP - gp;

      // 5. Calcular impacto
      let category = "";
      let suggestedAdj = 0;
      if (ppg >= 25 || (ppg >= 20 && mpg >= 33)) {
        category = "Superestrella / MVP";
        suggestedAdj = -8;
      } else if (ppg >= 18 || (ppg >= 15 && mpg >= 30)) {
        category = "Estrella titular";
        suggestedAdj = -7;
      } else if (ppg >= 13 || (ppg >= 10 && mpg >= 25)) {
        category = "Jugador clave / 2do titular";
        suggestedAdj = -5;
      } else if (ppg >= 8 || mpg >= 20) {
        category = "Rol importante / 6to hombre";
        suggestedAdj = -3;
      } else {
        category = "Rol menor / rotacion";
        suggestedAdj = -1;
      }

      // Si lleva 10+ partidos fuera, stats ya lo reflejan
      const alreadyReflected = gamesMissed >= 10;
      const effectiveAdj = alreadyReflected ? 0 : suggestedAdj;

      // Dias desde ultimo partido
      let daysSinceLastGame = 0;
      if (lastGameDate) {
        const last = new Date(lastGameDate);
        const now = new Date();
        daysSinceLastGame = Math.round((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
      }

      res.json({
        success: true,
        player: {
          name: playerName,
          teamName,
          ppg: Math.round(ppg * 10) / 10,
          rpg: Math.round(rpg * 10) / 10,
          apg: Math.round(apg * 10) / 10,
          mpg: Math.round(mpg * 10) / 10,
          gamesPlayed: gp,
          teamGamesPlayed: teamGP,
          gamesMissed,
          lastGameDate,
          daysSinceLastGame,
          category,
          suggestedAdj,
          effectiveAdj,
          alreadyReflected,
        },
      });
    } catch (e) {
      console.error("player-impact error", e);
      res.status(500).json({ success: false, error: "Error al buscar jugador" });
    }
  });

}
