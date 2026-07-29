import type { Express } from "express";
import type { Server } from "http";
import {
  getNBARefImpact,
  getMLBUmpireImpact,
  type NBARefImpact,
  type MLBUmpireImpact,
} from "./referee-data";
import {
  getParkFactor,
  computeWeatherImpact,
  analyzeOpener,
} from "./mlb-advanced";
import {
  recordSnapshot,
  getAllSnapshots,
  getHistoryForGame,
  getAllGameKeys,
  analyzeLineMovement,
  detectSteamMoves,
  detectReverseLineMovement,
  computeCLV,
  type LineSnapshot,
} from "./sharp-signals";
import { computeContextual } from "./nba-contextual";
import { computeMLBContextual } from "./mlb-contextual";
import { registerNbaManualRoutes } from "./nba-manual-routes";
import { registerIndependentNbaRoutes } from "./nba-independent-routes";
import { registerNhlManualRoutes } from "./nhl-manual-routes";
import { registerIndependentWnbaRoutes } from "./wnba-independent-routes";
import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";
import {
  classifyMlbInjuryShadow,
  fetchOfficialMlbInjurySnapshot,
  summarizeMlbInjuryShadow,
} from "./mlb-injury-shadow";
import { buildMlbInjuryPhaseBPlan } from "./mlb-injury-phase-b";
import {
  FL_TZ,
  NBA_HEADERS,
  SEASON,
  SELF_URL,
  WNBA_HEADERS,
  floridaParts,
  idx,
  isoToNBA,
  nbaFetch,
  nbaToISO,
  requireSecret,
  todayISO,
  todayNBA,
  withCache,
  wnbaFetch,
} from "./route-runtime";
import { loadPicks, savePicks, type SavedPick } from "./legacy-picks-store";
import { registerLegacyPicksCompatibilityRoutes } from "./legacy-picks-routes";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";
import { registerMlbEarlyRoutes } from "./mlb-early-routes";
import { registerMlbCoreRoutes } from "./mlb-core-routes";
import { registerLegacyPicksV2Routes } from "./legacy-picks-v2-routes";

import { computeMlbTesi } from "./mlb-tesi.js";
import { computeMlbEre } from "./mlb-ere.js";
import { computeEarlyMarkets } from "./mlb-early-markets.js";
import { computeF5Unified, type PitcherRecentForm, type UmpireData } from "./mlb-f5-unified.js";
import { computeMatchupSignal } from "./mlb-matchup-signal.js";
import { computeUncertainty } from "./mlb-uncertainty.js";

export function registerRoutes(httpServer: Server, app: Express): void {
  registerIndependentNbaRoutes(app);
  registerNbaManualRoutes(app);
  registerNhlManualRoutes(app);
  registerIndependentWnbaRoutes(app);


  registerMlbEarlyRoutes(app);

  registerLegacyPicksV2Routes(app);

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

  // ════════════════════════════════════════════════════════════════════════════
  // MLB ROUTES
  // ════════════════════════════════════════════════════════════════════════════

  registerMlbCoreRoutes(app);

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

  registerLegacyPicksCompatibilityRoutes(app);

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
      if (e?.noCache) { try { delete (cache as any)[`odds-v2-${req.params.sport.toLowerCase()}`]; } catch {} }
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
      if (e?.noCache) { try { delete (cache as any)["mlb-f5-events-v1"]; } catch {} }
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
  });
}
