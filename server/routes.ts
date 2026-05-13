import type { Express } from "express";
import type { Server } from "http";
import fs from "fs";
import path from "path";
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

// ── NBA Stats API Headers ────────────────────────────────────────────────────
const NBA_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://www.nba.com/",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  "Origin": "https://www.nba.com",
  "Connection": "keep-alive",
};

const SEASON = "2025-26";

// ── In-memory cache (30 min TTL) ─────────────────────────────────────────────
const cache: Record<string, { data: unknown; ts: number }> = {};
const TTL = 30 * 60 * 1000;

async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < TTL) {
    return cache[key].data as T;
  }
  const data = await fn();
  cache[key] = { data, ts: now };
  return data;
}

async function nbaFetch(url: string) {
  const res = await fetch(url, { headers: NBA_HEADERS });
  if (!res.ok) throw new Error(`NBA API ${res.status}: ${url}`);
  return res.json();
}

function idx(headers: string[], name: string) {
  return headers.indexOf(name);
}

// ── Helper: today's date in Florida timezone (America/New_York) ─────────────
const FL_TZ = "America/New_York";

// Returns { y, m, d } for today (or offset days) in Florida timezone
function floridaParts(offsetDays = 0): { y: string; m: string; d: string } {
  const now = new Date();
  if (offsetDays) now.setUTCDate(now.getUTCDate() + offsetDays);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: FL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return { y: parts.year, m: parts.month, d: parts.day };
}

// NBA format MM/DD/YYYY in Florida timezone
// NBA Stats API ahora requiere formato ISO YYYY-MM-DD (cambio de la API — antes aceptaba MM/DD/YYYY)
function todayNBA(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

// ISO format YYYY-MM-DD in Florida timezone (NHL/MLB)
function todayISO(offsetDays = 0): string {
  const { y, m, d } = floridaParts(offsetDays);
  return `${y}-${m}-${d}`;
}

// Convert ISO YYYY-MM-DD → NBA format
// NBA Stats API ahora acepta ISO directamente. Mantenemos la función por compatibilidad.
function isoToNBA(iso: string): string {
  return iso;
}

// Convert NBA MM/DD/YYYY → ISO YYYY-MM-DD
function nbaToISO(nba: string): string {
  const m = nba.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return nba;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

// URL del propio servicio (para sub-fetches internos)
// En Railway el puerto cambia (8080), por eso usamos process.env.PORT.
const SELF_URL = `http://localhost:${process.env.PORT || 5000}`;

export function registerRoutes(httpServer: Server, app: Express): void {

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

  const MLB_BASE = "https://statsapi.mlb.com/api/v1";
  // Constantes de temporada — dinámicas (auto-cambian cada año)
  const MLB_SEASON_CURRENT = String(new Date().getFullYear());      // ej. "2026"
  const MLB_SEASON_PREVIOUS = String(new Date().getFullYear() - 1); // ej. "2025"
  const BDL_BASE = "https://api.balldontlie.io";
  const BDL_KEY = process.env.BDL_API_KEY || "d94f53fd-aedc-4da1-952c-5975f51cf732";

  // Mapeo de team abbreviations BALLDONTLIE → MLB Stats team IDs
  const BDL_MLB_TEAM_TO_ID: Record<string, number> = {
    ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113,
    CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
    MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133,
    PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
    TEX: 140, TOR: 141, WSH: 120, WAS: 120,
  };

  // Cache global de lesionados MLB (se refresca cada 30 min)
  let mlbInjuryCache: { ts: number; byTeam: Record<number, any[]> } = { ts: 0, byTeam: {} };
  async function getMLBInjuriesFromBDL(): Promise<Record<number, any[]>> {
    const now = Date.now();
    if (now - mlbInjuryCache.ts < 30 * 60 * 1000 && Object.keys(mlbInjuryCache.byTeam).length > 0) {
      return mlbInjuryCache.byTeam;
    }
    const byTeam: Record<number, any[]> = {};
    try {
      let cursor: number | null = null;
      let pages = 0;
      while (pages < 10) {
        const url: string = `${BDL_BASE}/mlb/v1/player_injuries?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
        const r = await fetch(url, { headers: { Authorization: BDL_KEY } });
        if (!r.ok) break;
        const j: any = await r.json();
        const data: any[] = j.data ?? [];
        for (const inj of data) {
          const abbr = (inj.player?.team?.abbreviation || "").toUpperCase();
          const mlbTeamId = BDL_MLB_TEAM_TO_ID[abbr];
          if (!mlbTeamId) continue;
          if (!byTeam[mlbTeamId]) byTeam[mlbTeamId] = [];
          byTeam[mlbTeamId].push(inj);
        }
        cursor = j.meta?.next_cursor ?? null;
        if (!cursor) break;
        pages++;
      }
      mlbInjuryCache = { ts: now, byTeam };
    } catch (e) {
      console.error("BDL MLB injuries fetch failed:", e);
    }
    return byTeam;
  }

  function parseIP(ip: string): number {
    const parts = ip.split(".");
    return parseInt(parts[0]) + (parseInt(parts[1] || "0") / 3);
  }

  // Cache global de splits por bateador (vs L / vs R) — refrescar cada 12h
  // Estrategia: temporada actual primero, fallback a previa si muestra <30 PA
  const batterSplitsCache: Record<number, { ts: number; vsL?: any; vsR?: any; seasonUsed: "current" | "previous" | "none" }> = {};
  // Usamos constantes top-level MLB_SEASON_CURRENT / MLB_SEASON_PREVIOUS
  async function getBatterSplits(playerId: number): Promise<{ vsL?: any; vsR?: any; seasonUsed: "current" | "previous" | "none" }> {
    const now = Date.now();
    const cached = batterSplitsCache[playerId];
    if (cached && now - cached.ts < 12 * 3600 * 1000) {
      return { vsL: cached.vsL, vsR: cached.vsR, seasonUsed: cached.seasonUsed };
    }
    try {
      // 1. Intentar temporada actual
      const j: any = await (await fetch(`${MLB_BASE}/people/${playerId}/stats?stats=statSplits&group=hitting&season=${MLB_SEASON_CURRENT}&sitCodes=vl,vr`)).json();
      const splits = j.stats?.[0]?.splits ?? [];
      let vsL = splits.find((s: any) => s.split?.code === "vl")?.stat;
      let vsR = splits.find((s: any) => s.split?.code === "vr")?.stat;
      const paL = parseInt(vsL?.plateAppearances ?? "0") || 0;
      const paR = parseInt(vsR?.plateAppearances ?? "0") || 0;
      // Si la muestra es muy chica en ambos splits, usar previa temporada
      let seasonUsed: "current" | "previous" | "none" = "current";
      if (paL < 30 && paR < 30) {
        try {
          const jPrev: any = await (await fetch(`${MLB_BASE}/people/${playerId}/stats?stats=statSplits&group=hitting&season=${MLB_SEASON_PREVIOUS}&sitCodes=vl,vr`)).json();
          const splitsPrev = jPrev.stats?.[0]?.splits ?? [];
          const vsLPrev = splitsPrev.find((s: any) => s.split?.code === "vl")?.stat;
          const vsRPrev = splitsPrev.find((s: any) => s.split?.code === "vr")?.stat;
          const paLPrev = parseInt(vsLPrev?.plateAppearances ?? "0") || 0;
          const paRPrev = parseInt(vsRPrev?.plateAppearances ?? "0") || 0;
          if (paLPrev >= 30 || paRPrev >= 30) {
            vsL = vsLPrev; vsR = vsRPrev; seasonUsed = "previous";
          } else {
            seasonUsed = "none";
          }
        } catch {}
      }
      batterSplitsCache[playerId] = { ts: now, vsL, vsR, seasonUsed };
      return { vsL, vsR, seasonUsed };
    } catch {
      return { seasonUsed: "none" };
    }
  }

  // GET /api/mlb/lineup-matchup/:gamePk
  // Devuelve el matchup hombre-por-hombre del lineup vs el pitcher rival
  // GET /api/mlb/rookie-pitcher/:gamePk
  // Detecta pitchers rookies / poco experiencia / bullpen games
  app.get("/api/mlb/rookie-pitcher/:gamePk", async (req, res) => {
    try {
      const { analyzeBothPitchersExperience } = await import("./mlb-rookie-pitcher");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const result = await analyzeBothPitchersExperience(
        home.probablePitcher?.id, home.probablePitcher?.fullName ?? "?",
        away.probablePitcher?.id, away.probablePitcher?.fullName ?? "?",
      );
      res.json(result);
    } catch (e: any) {
      console.error("rookie-pitcher error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/statcast-matchup/:gamePk
  // ⚡ EL MOTOR REAL: pitch-by-pitch + batter-vs-team
  app.get("/api/mlb/statcast-matchup/:gamePk", async (req, res) => {
    try {
      const { getStatcastMatchupCombined } = await import("./mlb-statcast-matchup");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home; const away = game.teams?.away;
      const season = new Date(game.gameDate).getFullYear();
      const result = await getStatcastMatchupCombined(
        gamePk,
        home.team.id, away.team.id,
        home.probablePitcher?.id ?? 0, home.probablePitcher?.fullName ?? "",
        away.probablePitcher?.id ?? 0, away.probablePitcher?.fullName ?? "",
        home.team.abbreviation ?? "", away.team.abbreviation ?? "",
        season,
      );
      res.json(result);
    } catch (e: any) {
      console.error("statcast-matchup error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/pitcher-form/:gamePk
  // Hueco #1 + #2: Días de descanso del SP + splits home/road del pitcher
  app.get("/api/mlb/pitcher-form/:gamePk", async (req, res) => {
    try {
      const { getPitcherFormCombined } = await import("./mlb-pitcher-form");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home; const away = game.teams?.away;
      const season = new Date(game.gameDate).getFullYear();
      const result = await getPitcherFormCombined(
        home.probablePitcher?.id ?? null, home.probablePitcher?.fullName ?? "?",
        away.probablePitcher?.id ?? null, away.probablePitcher?.fullName ?? "?",
        game.gameDate, season,
      );
      res.json(result);
    } catch (e: any) {
      console.error("pitcher-form error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/pitcher-recent/:gamePk
  // Post-mortem fix #1+#2+#4: forma reciente del SP, splits H/R recientes, early-exit risk
  app.get("/api/mlb/pitcher-recent/:gamePk", async (req, res) => {
    try {
      const { getPitcherRecentCombined } = await import("./mlb-pitcher-recent");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home; const away = game.teams?.away;
      const season = new Date(game.gameDate).getFullYear();
      const result = await getPitcherRecentCombined(
        home.probablePitcher?.id ?? null, home.probablePitcher?.fullName ?? "?",
        away.probablePitcher?.id ?? null, away.probablePitcher?.fullName ?? "?",
        game.gameDate, season,
      );
      res.json(result);
    } catch (e: any) {
      console.error("pitcher-recent error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/team-fatigue/:gamePk
  // Hueco #3: Day-after-night, travel, schedule stretch
  app.get("/api/mlb/team-fatigue/:gamePk", async (req, res) => {
    try {
      const { getTeamFatigueCombined } = await import("./mlb-team-fatigue");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=team,venue`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const result = await getTeamFatigueCombined(
        game.teams?.home?.team?.id, game.teams?.home?.team?.name,
        game.teams?.away?.team?.id, game.teams?.away?.team?.name,
        game.gameDate, game?.venue?.name ?? "",
      );
      res.json(result);
    } catch (e: any) {
      console.error("team-fatigue error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/catcher-framing/:gamePk
  // Catcher Framing — cuánto valor genera el catcher robando strikes en zonas borde
  app.get("/api/mlb/catcher-framing/:gamePk", async (req, res) => {
    try {
      const { analyzeCatcherFramingMatchup } = await import("./mlb-catcher-framing");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const result = await analyzeCatcherFramingMatchup(game.teams?.home?.team?.id, game.teams?.away?.team?.id, gamePk);
      res.json(result);
    } catch (e: any) {
      console.error("catcher-framing error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/pitcher-vs-team/:gamePk
  // Últimos 5 starts del pitcher vs ESTE equipo — detecta dominance/struggles
  app.get("/api/mlb/pitcher-vs-team/:gamePk", async (req, res) => {
    try {
      const { analyzePitcherVsTeamMatchup } = await import("./mlb-pitcher-vs-team");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const result = await analyzePitcherVsTeamMatchup(
        home.team.id, home.team.name,
        home.probablePitcher?.id, home.probablePitcher?.fullName ?? "?",
        away.team.id, away.team.name,
        away.probablePitcher?.id, away.probablePitcher?.fullName ?? "?",
      );
      res.json(result);
    } catch (e: any) {
      console.error("pitcher-vs-team error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/wind-park/:gamePk
  // Wind + Park combinado: ajuste de runs y HR factor por viento + estadio específico
  app.get("/api/mlb/wind-park/:gamePk", async (req, res) => {
    try {
      const { analyzeWindPark } = await import("./mlb-wind-park");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=weather,venue`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const venueName = game.venue?.name ?? "Unknown";
      const weather = game.weather;
      const result = analyzeWindPark(venueName, weather);
      res.json(result ?? { venueName, runsAdjustment: 0, signal: "Sin datos de clima" });
    } catch (e: any) {
      console.error("wind-park error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/park-pitcher/:gamePk
  // Park-Pitcher Splits — cómo le va a este pitcher en este estadio específico (últimos 3 años)
  app.get("/api/mlb/park-pitcher/:gamePk", async (req, res) => {
    try {
      const { analyzeParkPitcherMatchup } = await import("./mlb-park-pitcher");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const result = await analyzeParkPitcherMatchup(
        home.team.id, home.team.name,
        home.probablePitcher?.id, home.probablePitcher?.fullName ?? "?",
        away.probablePitcher?.id, away.probablePitcher?.fullName ?? "?",
      );
      res.json(result);
    } catch (e: any) {
      console.error("park-pitcher error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/discipline-speed/:gamePk — Tier B: strikePct (proxy CSW) + Sprint Speed
  app.get("/api/mlb/discipline-speed/:gamePk", async (req, res) => {
    try {
      const { getDisciplineSpeedForGame } = await import("./mlb-discipline-speed");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team,lineups`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const collectLineup = (side: string): number[] => {
        const lu = game.lineups?.[side === "home" ? "homePlayers" : "awayPlayers"];
        return Array.isArray(lu) ? lu.map((p: any) => p?.id).filter(Boolean) : [];
      };
      const result = await getDisciplineSpeedForGame(
        home.probablePitcher?.id, home.probablePitcher?.fullName ?? "?",
        away.probablePitcher?.id, away.probablePitcher?.fullName ?? "?",
        collectLineup("home"), collectLineup("away"),
      );
      res.json({ success: true, ...result });
    } catch (e: any) {
      console.error("discipline-speed error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/sos/:gamePk — Strength of Schedule del bateo reciente (últimos 10 juegos)
  app.get("/api/mlb/sos/:gamePk", async (req, res) => {
    try {
      const { getTeamSos } = await import("./mlb-sos");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const [homeSos, awaySos] = await Promise.all([
        getTeamSos(home.team.id, home.team.name),
        getTeamSos(away.team.id, away.team.name),
      ]);
      res.json({ success: true, home: homeSos, away: awaySos });
    } catch (e: any) {
      console.error("sos error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/quality/:gamePk — xwOBA-allowed + HardHit% (Tier A Savant)
  app.get("/api/mlb/quality/:gamePk", async (req, res) => {
    try {
      const { getPitcherQualityMap, getBatterQualityMap, evaluatePitcher, evaluateBatter } = await import("./mlb-statcast-quality");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team,lineups`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const [pMap, bMap] = await Promise.all([getPitcherQualityMap(), getBatterQualityMap()]);

      const homeSP = evaluatePitcher(pMap[home?.probablePitcher?.id]);
      const awaySP = evaluatePitcher(pMap[away?.probablePitcher?.id]);

      // Lineups (confirmed o usar players del team)
      const collectLineup = (side: any): number[] => {
        const arr: number[] = [];
        const lu = game.lineups?.[side === "home" ? "homePlayers" : "awayPlayers"];
        if (Array.isArray(lu)) for (const p of lu) if (p?.id) arr.push(p.id);
        return arr;
      };
      const homeIds = collectLineup("home");
      const awayIds = collectLineup("away");
      const homeBatters = homeIds.map(id => evaluateBatter(bMap[id])).filter(Boolean);
      const awayBatters = awayIds.map(id => evaluateBatter(bMap[id])).filter(Boolean);

      res.json({ success: true, homeSP, awaySP, homeBatters, awayBatters });
    } catch (e: any) {
      console.error("quality error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/bullpen-status/:gamePk
  // Bullpen Availability — cálculo de cansancio + predicción de quien cerrará hoy
  app.get("/api/mlb/bullpen-status/:gamePk", async (req, res) => {
    try {
      const { getBullpenStatus } = await import("./mlb-bullpen");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const [homeBullpen, awayBullpen] = await Promise.all([
        getBullpenStatus(home.team.id, home.team.name),
        getBullpenStatus(away.team.id, away.team.name),
      ]);
      res.json({ home: homeBullpen, away: awayBullpen });
    } catch (e: any) {
      console.error("bullpen-status error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // GET /api/mlb/archetype-matchup/:gamePk
  // Devuelve el matchup por arquetipo de pitcher — lo que las casas no procesan bien
  app.get("/api/mlb/archetype-matchup/:gamePk", async (req, res) => {
    try {
      const { analyzeMatchup } = await import("./mlb-archetypes");
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });
      const sJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=probablePitcher,team`)).json();
      const game = sJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? sJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });
      const home = game.teams?.home;
      const away = game.teams?.away;
      const result = await analyzeMatchup(
        home.team.id, home.team.name,
        away.team.id, away.team.name,
        home.probablePitcher?.id, home.probablePitcher?.fullName ?? "?",
        away.probablePitcher?.id, away.probablePitcher?.fullName ?? "?",
      );
      res.json(result);
    } catch (e: any) {
      console.error("archetype-matchup error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  app.get("/api/mlb/lineup-matchup/:gamePk", async (req, res) => {
    try {
      const gamePk = parseInt(req.params.gamePk);
      if (!gamePk) return res.status(400).json({ error: "Invalid gamePk" });

      const schedJson: any = await (await fetch(`${MLB_BASE}/schedule?sportId=1&gamePk=${gamePk}&hydrate=lineups,probablePitcher,team`)).json();
      const game = schedJson.dates?.[0]?.games?.find((g: any) => g.gamePk === gamePk) ?? schedJson.dates?.[0]?.games?.[0];
      if (!game) return res.status(404).json({ error: "Game not found" });

      const homePitcher = game.teams?.home?.probablePitcher;
      const awayPitcher = game.teams?.away?.probablePitcher;
      const homeTeamId = game.teams?.home?.team?.id;
      const awayTeamId = game.teams?.away?.team?.id;
      const lineups = game.lineups ?? {};

      async function getPitcherHand(pid: number | undefined): Promise<"L" | "R" | undefined> {
        if (!pid) return undefined;
        try {
          const j: any = await (await fetch(`${MLB_BASE}/people/${pid}`)).json();
          return j.people?.[0]?.pitchHand?.code as "L" | "R" | undefined;
        } catch { return undefined; }
      }
      const [homePitcherHand, awayPitcherHand] = await Promise.all([
        getPitcherHand(homePitcher?.id),
        getPitcherHand(awayPitcher?.id),
      ]);

      async function projectLineup(teamId: number): Promise<any[]> {
        try {
          const r: any = await (await fetch(`${MLB_BASE}/teams/${teamId}/roster?rosterType=Active`)).json();
          const players = (r.roster ?? []).filter((p: any) => p.position?.code && p.position.code !== "1");
          const withOps = await Promise.all(players.slice(0, 18).map(async (p: any) => {
            try {
              const sJ: any = await (await fetch(`${MLB_BASE}/people/${p.person.id}/stats?stats=season&group=hitting&season=${MLB_SEASON_CURRENT}`)).json();
              let st = sJ.stats?.[0]?.splits?.[0]?.stat;
              if (!st?.ops) {
                const fb: any = await (await fetch(`${MLB_BASE}/people/${p.person.id}/stats?stats=season&group=hitting&season=${MLB_SEASON_PREVIOUS}`)).json();
                st = fb.stats?.[0]?.splits?.[0]?.stat;
              }
              return { ...p.person, primaryPosition: p.position, ops: parseFloat(st?.ops ?? "0") || 0, ab: parseInt(st?.atBats ?? "0") || 0 };
            } catch { return null; }
          }));
          // Threshold más bajo en abril/mayo cuando hay poca muestra 2026
          const month = new Date().getMonth() + 1;
          const minAb = month >= 3 && month <= 5 ? 20 : 50;
          return withOps.filter(Boolean).filter((p: any) => p.ab >= minAb).sort((a: any, b: any) => b.ops - a.ops).slice(0, 9);
        } catch { return []; }
      }

      let homeLineup = lineups.homePlayers ?? [];
      let awayLineup = lineups.awayPlayers ?? [];
      const homeIsConfirmed = homeLineup.length >= 8;
      const awayIsConfirmed = awayLineup.length >= 8;
      if (!homeIsConfirmed) homeLineup = await projectLineup(homeTeamId);
      if (!awayIsConfirmed) awayLineup = await projectLineup(awayTeamId);

      // ── wOBA real desde componentes (FanGraphs formula, weights 2024) ──
      // Estrictamente más predictivo que OPS porque pondera correctamente cada tipo de hit
      // y excluye intentional walks. Liga 2024 avg ≈ .310.
      function computeWOBA(s: any): number {
        if (!s) return 0;
        const ab = parseInt(s.atBats ?? "0") || 0;
        const bb = parseInt(s.baseOnBalls ?? "0") || 0;
        const ibb = parseInt(s.intentionalWalks ?? "0") || 0;
        const hbp = parseInt(s.hitByPitch ?? "0") || 0;
        const sf = parseInt(s.sacFlies ?? "0") || 0;
        const hits = parseInt(s.hits ?? "0") || 0;
        const doubles = parseInt(s.doubles ?? "0") || 0;
        const triples = parseInt(s.triples ?? "0") || 0;
        const hr = parseInt(s.homeRuns ?? "0") || 0;
        const singles = hits - doubles - triples - hr;
        const denom = ab + bb - ibb + sf + hbp;
        if (denom <= 0) return 0;
        const ubb = bb - ibb; // unintentional walks
        return (0.69 * ubb + 0.72 * hbp + 0.89 * singles + 1.27 * doubles + 1.62 * triples + 2.10 * hr) / denom;
      }

      // ── Slot weight: PA proyectadas por turno en la alineación ──
      // Slot 3-4 (cleanup) ~ 4.8 PA/juego vs Slot 8-9 ~ 3.6 PA/juego → cleanup pesa 33% más
      function slotWeight(slot: number): number {
        if (slot === 3 || slot === 4) return 1.25;
        if (slot === 1 || slot === 2) return 1.10;
        if (slot === 5) return 1.05;
        if (slot === 6 || slot === 7) return 0.95;
        return 0.75; // 8-9
      }

      // ── BABIP regression: si BABIP >.330 o <.270, regresar OPS hacia la media ──
      // Bateadores con suerte alta/baja en bolas en juego ven OPS distorsionado
      function babipAdjust(woba: number, babip: number, pa: number): number {
        if (pa < 80 || babip <= 0) return woba; // muestra insuficiente o sin dato
        const leagueBABIP = 0.295;
        const deviation = babip - leagueBABIP;
        if (Math.abs(deviation) < 0.040) return woba; // dentro de rango normal
        // Regresar 30% hacia la media si está muy fuera
        const regressFactor = Math.min(0.30, Math.abs(deviation) * 2);
        const regressedBABIP = babip - (deviation * regressFactor);
        // wOBA scaling: BABIP cambio de 0.030 ≈ ~0.020 wOBA cambio
        const wobaDelta = (regressedBABIP - babip) * 0.67;
        return woba + wobaDelta;
      }

      async function buildMatchup(lineup: any[], opposingHand: "L" | "R" | undefined) {
        if (!opposingHand || lineup.length === 0) return { players: [], avgOps: null, avgWoba: null, avgWeightedWoba: null, seasonUsed: "none" as const };
        const players = await Promise.all(lineup.slice(0, 9).map(async (b: any, idx: number) => {
          const pid = b.id ?? b.person?.id;
          if (!pid) return null;
          const splits = await getBatterSplits(pid);
          const split = opposingHand === "L" ? splits.vsL : splits.vsR;
          if (!split) return null;

          // Componentes básicos del split
          const ops = parseFloat(split.ops ?? "0") || 0;
          const avg = parseFloat(split.avg ?? "0") || 0;
          const obp = parseFloat(split.obp ?? "0") || 0;
          const slg = parseFloat(split.slg ?? "0") || 0;
          const pa = parseInt(split.plateAppearances ?? "0") || 0;
          const ab = parseInt(split.atBats ?? "0") || 0;
          const k = parseInt(split.strikeOuts ?? "0") || 0;
          const bb = parseInt(split.baseOnBalls ?? "0") || 0;
          const babip = parseFloat(split.babip ?? "0") || 0;

          // Métricas avanzadas
          const woba = computeWOBA(split);
          const iso = slg - avg;
          const kPct = pa > 0 ? k / pa : 0.22;
          const bbPct = pa > 0 ? bb / pa : 0.085;

          // Regresión por BABIP (atenaú OPS suerte/mala suerte)
          const wobaAdjusted = babipAdjust(woba, babip, pa);

          // Slot de bateo (idx 0-8 = slot 1-9)
          const slot = idx + 1;
          const slotWt = slotWeight(slot);

          // ── NIVEL DE CONTACTO ──
          // K% bajo + ISO alto = bateador peligroso (Soto, Judge)
          // K% alto + ISO bajo = bateador limitado (free-swinger sin poder)
          let contactQuality: "ELITE" | "BUENO" | "PROMEDIO" | "LIMITADO" = "PROMEDIO";
          if (kPct <= 0.18 && iso >= 0.180) contactQuality = "ELITE";
          else if (kPct <= 0.22 && iso >= 0.150) contactQuality = "BUENO";
          else if (kPct >= 0.30 && iso < 0.150) contactQuality = "LIMITADO";

          return {
            id: pid,
            name: b.fullName ?? b.person?.fullName,
            position: b.primaryPosition?.abbreviation ?? b.position?.abbreviation,
            slot,
            slotWt,
            ops, avg, obp, slg, pa,
            woba: Math.round(woba * 1000) / 1000,
            wobaAdjusted: Math.round(wobaAdjusted * 1000) / 1000,
            iso: Math.round(iso * 1000) / 1000,
            kPct: Math.round(kPct * 1000) / 1000,
            bbPct: Math.round(bbPct * 1000) / 1000,
            babip: babip > 0 ? Math.round(babip * 1000) / 1000 : null,
            contactQuality,
            vs: opposingHand === "L" ? "vs LHP" : "vs RHP",
            seasonUsed: splits.seasonUsed,
          };
        }));
        const valid = players.filter((p: any) => p && p.ops && p.pa >= 30);
        if (valid.length === 0) return { players: players.filter(Boolean), avgOps: null, avgWoba: null, avgWeightedWoba: null, seasonUsed: "none" as const };

        // ── wOBA promedio plano (sin slot weighting) para retrocompatibilidad UI ──
        const avgOps = valid.reduce((s: number, p: any) => s + p.ops, 0) / valid.length;
        const avgWoba = valid.reduce((s: number, p: any) => s + p.wobaAdjusted, 0) / valid.length;

        // ── wOBA PONDERADO por slot ──
        // Éste es el que entra al cálculo final de runs (más preciso que OPS plano)
        const totalWt = valid.reduce((s: number, p: any) => s + p.slotWt, 0);
        const avgWeightedWoba = totalWt > 0
          ? valid.reduce((s: number, p: any) => s + p.wobaAdjusted * p.slotWt, 0) / totalWt
          : avgWoba;

        // Determinar qué temporada domina en el lineup
        const curCount = valid.filter((p: any) => p.seasonUsed === "current").length;
        const prevCount = valid.filter((p: any) => p.seasonUsed === "previous").length;
        const dominantSeason: "current" | "previous" | "mixed" | "none" =
          valid.length === 0 ? "none" :
          curCount > prevCount * 2 ? "current" :
          prevCount > curCount * 2 ? "previous" : "mixed";

        return {
          players: players.filter(Boolean),
          avgOps: Math.round(avgOps * 1000) / 1000,
          avgWoba: Math.round(avgWoba * 1000) / 1000,
          avgWeightedWoba: Math.round(avgWeightedWoba * 1000) / 1000,
          seasonUsed: dominantSeason,
        };
      }

      const [homeMatchup, awayMatchup] = await Promise.all([
        buildMatchup(homeLineup, awayPitcherHand),
        buildMatchup(awayLineup, homePitcherHand),
      ]);

      // ── CÁLCULO DE RUNS ──
      // Nuevo método: usa wOBA PONDERADO por slot de bateo + ajuste BABIP
      // wOBA league avg ≈ .315 vs RHP / .320 vs LHP
      // ΔwOBA × 12 ≈ Δruns/game (relación sabermetric estandar)
      const leagueWoba = (hand?: string) => hand === "L" ? 0.320 : 0.315;
      const homeWobaDelta = homeMatchup.avgWeightedWoba ? homeMatchup.avgWeightedWoba - leagueWoba(awayPitcherHand) : 0;
      const awayWobaDelta = awayMatchup.avgWeightedWoba ? awayMatchup.avgWeightedWoba - leagueWoba(homePitcherHand) : 0;
      const homeRunsDelta = homeWobaDelta * 12;
      const awayRunsDelta = awayWobaDelta * 12;

      // Mantener compat con UI antigua — cálculo OPS lado a lado
      const leagueOps = (hand?: string) => hand === "L" ? 0.735 : 0.720;
      const homeOpsDelta = homeMatchup.avgOps ? homeMatchup.avgOps - leagueOps(awayPitcherHand) : 0;
      const awayOpsDelta = awayMatchup.avgOps ? awayMatchup.avgOps - leagueOps(homePitcherHand) : 0;

      res.json({
        gamePk,
        homePitcher: homePitcher ? { ...homePitcher, hand: homePitcherHand } : null,
        awayPitcher: awayPitcher ? { ...awayPitcher, hand: awayPitcherHand } : null,
        homeLineup: { confirmed: homeIsConfirmed, ...homeMatchup },
        awayLineup: { confirmed: awayIsConfirmed, ...awayMatchup },
        adjustment: {
          homeOpsDelta: Math.round(homeOpsDelta * 1000) / 1000,
          awayOpsDelta: Math.round(awayOpsDelta * 1000) / 1000,
          homeRunsDelta: Math.round(homeRunsDelta * 100) / 100,
          awayRunsDelta: Math.round(awayRunsDelta * 100) / 100,
        },
      });
    } catch (e: any) {
      console.error("lineup-matchup error:", e);
      res.status(500).json({ error: e.message || "Failed" });
    }
  });

  // ── GET /api/mlb/all ──────────────────────────────────────────────────────
  app.get("/api/mlb/all", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || todayISO();
      const cacheKey = `mlb-all-${dateParam}`;

      const data = await withCache(cacheKey, async () => {
        // 1. Schedule with probable pitchers
        const schedJson = await (await fetch(`${MLB_BASE}/schedule?sportId=1&date=${dateParam}&hydrate=probablePitcher,weather`)).json();
        const rawGames: any[] = schedJson.dates?.[0]?.games ?? [];

        // 1b. Fallback ESPN — detecta pitchers que MLB.com no publicó aún (bullpen games, anuncios tardíos)
        // Mapeo de team name (como aparece en MLB schedule) → abbreviation ESPN
        const MLB_NAME_TO_ESPN_ABBR: Record<string, string> = {
          "Arizona Diamondbacks": "ARI", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
          "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CHW",
          "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
          "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
          "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
          "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM",
          "New York Yankees": "NYY", "Oakland Athletics": "ATH", "Athletics": "ATH",
          "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD",
          "San Francisco Giants": "SF", "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL",
          "Tampa Bay Rays": "TB", "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR",
          "Washington Nationals": "WSH",
        };
        const espnPitchersByAbbr: Record<string, string> = {};
        try {
          const espnDate = dateParam.replace(/-/g, "");
          const espnJson: any = await (await fetch(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${espnDate}`)).json();
          for (const ev of espnJson.events ?? []) {
            for (const c of ev.competitions?.[0]?.competitors ?? []) {
              const abbr = c.team?.abbreviation;
              const probables = c.probables ?? [];
              const name = probables[0]?.athlete?.displayName;
              if (abbr && name) espnPitchersByAbbr[abbr] = name;
            }
          }
        } catch (e) {
          console.error("ESPN fallback failed:", e);
        }

        // 1c. Para cada juego, si MLB no tiene probablePitcher, intenta resolver de ESPN
        let fallbackCount = 0;
        const espnFallbackLookups: Promise<void>[] = [];
        for (const g of rawGames) {
          for (const side of ["home", "away"] as const) {
            const t = g.teams[side];
            if (t.probablePitcher?.id) continue;
            const abbr = MLB_NAME_TO_ESPN_ABBR[t.team.name];
            const tid = t.team.id;
            const pitcherName = abbr ? espnPitchersByAbbr[abbr] : undefined;
            if (!pitcherName) continue;
            espnFallbackLookups.push((async () => {
              try {
                const lookup = await (await fetch(`${MLB_BASE}/people/search?names=${encodeURIComponent(pitcherName)}`)).json();
                const people: any[] = lookup.people ?? [];
                // Preferir match exacto en el equipo y posición pitcher
                const match = people.find((p: any) => p.currentTeam?.id === tid && p.primaryPosition?.code === "1")
                  ?? people.find((p: any) => p.primaryPosition?.code === "1")
                  ?? people[0];
                if (match?.id) {
                  t.probablePitcher = { id: match.id, fullName: match.fullName };
                  fallbackCount++;
                  console.log(`[ESPN fallback] ${t.team.name} → ${match.fullName} (${match.id})`);
                }
              } catch (e) {
                console.error(`ESPN lookup failed for ${pitcherName}:`, e);
              }
            })());
          }
        }
        await Promise.all(espnFallbackLookups);
        if (fallbackCount > 0) console.log(`[ESPN fallback] Resolved ${fallbackCount} pitchers MLB API didn't have`);

        // 2. Collect unique team IDs and pitcher IDs
        const teamIds = new Set<number>();
        const pitcherIds = new Set<number>();
        for (const g of rawGames) {
          teamIds.add(g.teams.home.team.id);
          teamIds.add(g.teams.away.team.id);
          if (g.teams.home.probablePitcher?.id) pitcherIds.add(g.teams.home.probablePitcher.id);
          if (g.teams.away.probablePitcher?.id) pitcherIds.add(g.teams.away.probablePitcher.id);
        }

        // 3. Fetch all team stats and splits in parallel
        const teamStatsMap: Record<number, any> = {};
        const teamPromises = [...teamIds].map(async (tid) => {
          try {
            const [hitJson, pitJson, splitJson, logJson] = await Promise.all([
              fetch(`${MLB_BASE}/teams/${tid}/stats?stats=season&group=hitting&season=${MLB_SEASON_CURRENT}`).then(r => r.json()),
              fetch(`${MLB_BASE}/teams/${tid}/stats?stats=season&group=pitching&season=${MLB_SEASON_CURRENT}`).then(r => r.json()),
              fetch(`${MLB_BASE}/teams/${tid}/stats?stats=statSplits&group=hitting&season=${MLB_SEASON_CURRENT}&sitCodes=vl,vr`).then(r => r.json()),
              fetch(`${MLB_BASE}/teams/${tid}/stats?stats=season&group=hitting&season=${MLB_SEASON_CURRENT}&gameType=R&startDate=2026-01-01&endDate=${dateParam}&stats=lastXGames&limit=10`).then(r => r.json()).catch(() => null),
            ]);

            const hit = hitJson.stats?.[0]?.splits?.[0]?.stat ?? {};
            const pit = pitJson.stats?.[0]?.splits?.[0]?.stat ?? {};
            const gp = parseInt(hit.gamesPlayed) || 1;
            const rpg = Math.round(((parseInt(hit.runs) || 0) / gp) * 10) / 10;

            // VS LHP / RHP
            let opsVsL = 0.720, opsVsR = 0.720;
            const splits = splitJson.stats?.[0]?.splits ?? [];
            for (const sp of splits) {
              if (sp.split?.description?.includes("Left")) opsVsL = parseFloat(sp.stat?.ops) || 0.720;
              if (sp.split?.description?.includes("Right")) opsVsR = parseFloat(sp.stat?.ops) || 0.720;
            }

            // Bullpen approximation: team pitching minus rough starter contribution
            const teamEra = parseFloat(pit.era) || 4.00;
            const teamWhip = parseFloat(pit.whip) || 1.28;
            // Bullpen ERA is usually slightly higher than team ERA
            const bullpenEra = Math.round((teamEra * 1.05) * 100) / 100;
            const bullpenWhip = Math.round((teamWhip * 1.03) * 100) / 100;

            // ── Bullpen últimos 14 días (mucho más predictivo que season) ──
            // Mezclamos team ERA en byDateRange (últimos 14 días) y aproximamos bullpen.
            let bullpenEra14d: number | undefined;
            let bullpenIp48h: number | undefined;
            try {
              const end = new Date(dateParam);
              const start14 = new Date(end); start14.setDate(end.getDate() - 14);
              const start2 = new Date(end); start2.setDate(end.getDate() - 2);
              const fmt = (d: Date) => d.toISOString().slice(0, 10);
              const [recent14Json, recent2Json] = await Promise.all([
                fetch(`${MLB_BASE}/teams/${tid}/stats?stats=byDateRange&group=pitching&season=${MLB_SEASON_CURRENT}&startDate=${fmt(start14)}&endDate=${fmt(end)}`).then(r => r.json()).catch(() => null),
                fetch(`${MLB_BASE}/teams/${tid}/stats?stats=byDateRange&group=pitching&season=${MLB_SEASON_CURRENT}&startDate=${fmt(start2)}&endDate=${fmt(end)}`).then(r => r.json()).catch(() => null),
              ]);
              const r14 = recent14Json?.stats?.[0]?.splits?.[0]?.stat;
              if (r14?.era) {
                const teamEra14 = parseFloat(r14.era);
                if (Number.isFinite(teamEra14) && teamEra14 > 0) {
                  // bullpen ≈ team * 1.05 (mismo factor que season)
                  bullpenEra14d = Math.round(teamEra14 * 1.05 * 100) / 100;
                }
              }
              const r2 = recent2Json?.stats?.[0]?.splits?.[0]?.stat;
              if (r2?.inningsPitched) {
                // IP del equipo últimas 48h — si SP tiró 6+ IP por juego, restamos eso
                const teamIp48 = parseIP(r2.inningsPitched);
                const games48 = parseInt(r2.gamesPlayed) || 1;
                const estStarterIp = games48 * 5.5; // promedio MLB ~5.5 IP por SP
                bullpenIp48h = Math.max(0, Math.round((teamIp48 - estStarterIp) * 10) / 10);
              }
            } catch (e) { /* fallback silencioso */ }

            // Win rate from record
            const wins = parseInt(hit.gamesPlayed && pit.wins) || parseInt(hit.runs) > parseInt(hit.runsAllowed || "999") ? Math.ceil(gp * 0.55) : Math.floor(gp * 0.45);

            // Calculate wOBA from raw components (more predictive than OPS)
            // wOBA = (0.69*BB + 0.72*HBP + 0.89*1B + 1.27*2B + 1.62*3B + 2.10*HR) / (AB + BB + SF + HBP)
            const ab = parseInt(hit.atBats) || 1;
            const bb = parseInt(hit.baseOnBalls) || 0;
            const hbp = parseInt(hit.hitByPitch) || 0;
            const singles = (parseInt(hit.hits) || 0) - (parseInt(hit.doubles) || 0) - (parseInt(hit.triples) || 0) - (parseInt(hit.homeRuns) || 0);
            const doubles = parseInt(hit.doubles) || 0;
            const triples = parseInt(hit.triples) || 0;
            const hr = parseInt(hit.homeRuns) || 0;
            const sf = parseInt(hit.sacFlies) || 0;
            const wOBADenom = ab + bb + sf + hbp;
            const wOBA = wOBADenom > 0
              ? Math.round(((0.69 * bb + 0.72 * hbp + 0.89 * singles + 1.27 * doubles + 1.62 * triples + 2.10 * hr) / wOBADenom) * 1000) / 1000
              : 0.320;

            // ISO (Isolated Power) = SLG - AVG — measures pure power
            const slg = parseFloat(hit.slg) || 0.400;
            const avg = parseFloat(hit.avg) || 0.250;
            const iso = Math.round((slg - avg) * 1000) / 1000;

            // BABIP — luck indicator
            const babip = parseFloat(hit.babip) || 0.300;

            teamStatsMap[tid] = {
              ops: parseFloat(hit.ops) || 0.720,
              avg,
              obp: parseFloat(hit.obp) || 0.320,
              rpg,
              opsVsL,
              opsVsR,
              wOBA,
              iso,
              babip,
              bullpenEra,
              bullpenWhip,
              bullpenEra14d,
              bullpenIp48h,
              gamesPlayed: gp,
            };
          } catch (e) {
            console.error("MLB team stats error for", tid, e);
          }
        });
        await Promise.all(teamPromises);

        // 4. Fetch all pitcher stats in parallel
        const pitcherStatsMap: Record<number, any> = {};
        const pitcherPromises = [...pitcherIds].map(async (pid) => {
          try {
            const hydrate = encodeURIComponent(`stats(group=[pitching],type=[season,gameLog],season=${MLB_SEASON_CURRENT})`);
            const pJson = await (await fetch(`${MLB_BASE}/people/${pid}?hydrate=${hydrate}`)).json();
            const person = pJson.people?.[0];
            if (!person) return;

            const season = person.stats?.find((s: any) => s.type?.displayName === "season");
            const gameLog = person.stats?.find((s: any) => s.type?.displayName === "gameLog");
            const ss = season?.splits?.[0]?.stat ?? {};

            const ip = parseIP(ss.inningsPitched || "0");
            const k9 = ip > 0 ? Math.round(((parseInt(ss.strikeOuts) || 0) / ip) * 9 * 10) / 10 : 8.5;
            const bb9 = ip > 0 ? Math.round(((parseInt(ss.baseOnBalls) || 0) / ip) * 9 * 10) / 10 : 3.2;

            // ── K% / BB% / SIERA simplificado ──
            // K% y BB% son más estables y predictivos que K/9 y BB/9 (no dependen de IP).
            // SIERA simplificado captura lo que el pitcher controla (sin defensa/BABIP).
            const battersFaced = parseInt(ss.battersFaced) || 0;
            const so = parseInt(ss.strikeOuts) || 0;
            const bb = parseInt(ss.baseOnBalls) || 0;
            const hrAllowed = parseInt(ss.homeRuns) || 0;
            const kPct = battersFaced > 0 ? Math.round((so / battersFaced) * 1000) / 1000 : 0.225;
            const bbPct = battersFaced > 0 ? Math.round((bb / battersFaced) * 1000) / 1000 : 0.085;
            const hrPerPA = battersFaced > 0 ? hrAllowed / battersFaced : 0.030;
            // SIERA simplificado (FanGraphs-style aproximación cuando no hay GB%):
            //   league avg ≈ 3.10  cuando K%=22.5%, BB%=8.5%, HR/PA=3.0%
            //   castiga BBs y HRs, premia Ks
            const sieraApprox = battersFaced >= 30
              ? Math.round((3.10 + (bbPct - 0.085) * 25 - (kPct - 0.225) * 18 + (hrPerPA - 0.030) * 35) * 100) / 100
              : undefined; // sin muestra suficiente, el modelo regresa a FIP solo

            // Recent ERA from last 3 starts
            let recentEra: number | undefined;
            const logs = gameLog?.splits?.slice(0, 3) ?? [];
            if (logs.length >= 2) {
              let totalER = 0, totalIP = 0;
              for (const lg of logs) {
                totalER += parseInt(lg.stat?.earnedRuns) || 0;
                totalIP += parseIP(lg.stat?.inningsPitched || "0");
              }
              if (totalIP > 0) recentEra = Math.round((totalER / totalIP) * 9 * 100) / 100;
            }

            // Days rest: last game date vs today
            let daysRest = 5;
            if (logs.length > 0 && logs[0].date) {
              const lastDate = new Date(logs[0].date);
              const today = new Date(dateParam);
              daysRest = Math.round((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
            }

            const homeRuns = parseInt(ss.homeRuns) || 0;
            const walks = parseInt(ss.baseOnBalls) || 0;
            const strikeouts = parseInt(ss.strikeOuts) || 0;
            const gamesStarted = parseInt(ss.gamesStarted) || 0;

            pitcherStatsMap[pid] = {
              name: person.fullName,
              hand: person.pitchHand?.code || "R",
              era: parseFloat(ss.era) || 4.00,
              whip: parseFloat(ss.whip) || 1.28,
              fip: parseFloat(ss.era) || 4.00, // Will be calculated client-side from components
              k9,
              bb9,
              kPct,
              bbPct,
              siera: sieraApprox,
              battersFaced,
              record: (ss.wins || 0) + "-" + (ss.losses || 0),
              daysRest,
              recentEra,
              inningsPitched: ip,
              homeRuns,
              walks,
              strikeouts,
              gamesStarted,
            };
          } catch (e) {
            console.error("MLB pitcher stats error for", pid, e);
          }
        });
        await Promise.all(pitcherPromises);

        // 5a. Fetch injuries from BALLDONTLIE (incluye Day-To-Day + IL)
        const bdlInjuriesByTeam = await getMLBInjuriesFromBDL();
        const injuryMap: Record<number, any[]> = {};
        const injuryPromises = [...teamIds].map(async (tid) => {
          const bdlList = bdlInjuriesByTeam[tid] ?? [];
          if (bdlList.length === 0) {
            injuryMap[tid] = [];
            return;
          }
          const teamGP = teamStatsMap[tid]?.gamesPlayed ?? 0;
          // Buscar player_id en MLB Stats API por nombre y traer stats
          const list = await Promise.all(bdlList.map(async (inj: any) => {
            const player = inj.player ?? {};
            const name = player.full_name || `${player.first_name} ${player.last_name}`.trim();
            const pos = player.position || "";
            const status = inj.status || "";
            const isPitcher = /pitcher/i.test(pos);
            const detailParts = [inj.type, inj.detail, inj.side].filter(Boolean).join(" ");
            const fullStatus = detailParts ? `${status} · ${detailParts}` : status;
            const returnDate = inj.return_date || null;
            const shortComment = inj.short_comment || null;
            // Buscar player en MLB Stats API por nombre
            try {
              const lookupUrl = `${MLB_BASE}/people/search?names=${encodeURIComponent(name)}&season=${MLB_SEASON_CURRENT}`;
              const lookupJson = await (await fetch(lookupUrl)).json();
              const people = lookupJson.people ?? [];
              // Filtrar por equipo correcto
              const match = people.find((p: any) => p.currentTeam?.id === tid) ?? people[0];
              const pid = match?.id;
              const positionAbbr = match?.primaryPosition?.abbreviation || (isPitcher ? "P" : pos.split(" ").map((w: string) => w[0]).join("").toUpperCase());
              if (!pid) {
                return {
                  name, position: positionAbbr, status: fullStatus, isPitcher,
                  returnDate, shortComment,
                  source: "BDL",
                };
              }
              if (isPitcher) {
                const sJ = await (await fetch(`${MLB_BASE}/people/${pid}/stats?stats=season&group=pitching&season=${MLB_SEASON_CURRENT}`)).json();
                const s = sJ.stats?.[0]?.splits?.[0]?.stat ?? {};
                let st = s;
                if (!s.era) {
                  const fb = await (await fetch(`${MLB_BASE}/people/${pid}/stats?stats=season&group=pitching&season=${MLB_SEASON_PREVIOUS}`)).json();
                  st = fb.stats?.[0]?.splits?.[0]?.stat ?? s;
                }
                const playerGP = parseInt(st.gamesPlayed) || 0;
                const gamesMissed = Math.max(0, teamGP - playerGP);
                // Bullpen leverage data — saves/holds/games finished diferencian closer real vs setup vs middle
                const ipPitcher = parseIP(st.inningsPitched || "0");
                return {
                  name, position: positionAbbr, status: fullStatus,
                  era: parseFloat(st.era) || null,
                  whip: parseFloat(st.whip) || null,
                  k9: parseFloat(st.strikeoutsPer9Inn) || null,
                  inningsPitched: ipPitcher,
                  wins: parseInt(st.wins) || 0,
                  losses: parseInt(st.losses) || 0,
                  gamesStarted: parseInt(st.gamesStarted) || 0,
                  saves: parseInt(st.saves) || 0,
                  holds: parseInt(st.holds) || 0,
                  gamesFinished: parseInt(st.gamesFinished) || 0,
                  ipPerStart: parseInt(st.gamesStarted) > 0 ? Math.round((ipPitcher / parseInt(st.gamesStarted)) * 10) / 10 : null,
                  battersFaced: parseInt(st.battersFaced) || 0,
                  strikeoutsK: parseInt(st.strikeOuts) || 0,
                  gamesPlayed: playerGP,
                  gamesMissed,
                  teamGP,
                  isPitcher: true,
                  returnDate, shortComment,
                  source: "BDL",
                };
              } else {
                const sJ = await (await fetch(`${MLB_BASE}/people/${pid}/stats?stats=season&group=hitting&season=${MLB_SEASON_CURRENT}`)).json();
                let st = sJ.stats?.[0]?.splits?.[0]?.stat ?? {};
                if (!st.ops) {
                  const fb = await (await fetch(`${MLB_BASE}/people/${pid}/stats?stats=season&group=hitting&season=${MLB_SEASON_PREVIOUS}`)).json();
                  st = fb.stats?.[0]?.splits?.[0]?.stat ?? st;
                }
                const playerGP = parseInt(st.gamesPlayed) || 0;
                const gamesMissed = Math.max(0, teamGP - playerGP);
                // Star Power: slugging y composición para proxy de WAR
                const slg = parseFloat(st.slg) || 0;
                const obp = parseFloat(st.obp) || 0;
                const ops = parseFloat(st.ops) || 0;
                const iso = slg > 0 && parseFloat(st.avg) > 0 ? Math.round((slg - parseFloat(st.avg)) * 1000) / 1000 : null;
                return {
                  name, position: positionAbbr, status: fullStatus,
                  ops: ops || null,
                  avg: parseFloat(st.avg) || null,
                  obp: obp || null,
                  slg: slg || null,
                  iso,
                  homeRuns: parseInt(st.homeRuns) || 0,
                  doubles: parseInt(st.doubles) || 0,
                  triples: parseInt(st.triples) || 0,
                  stolenBases: parseInt(st.stolenBases) || 0,
                  rbi: parseInt(st.rbi) || 0,
                  atBats: parseInt(st.atBats) || 0,
                  plateAppearances: parseInt(st.plateAppearances) || 0,
                  gamesPlayed: playerGP,
                  gamesMissed,
                  teamGP,
                  isPitcher: false,
                  returnDate, shortComment,
                  source: "BDL",
                };
              }
            } catch {
              return { name, position: pos, status: fullStatus, isPitcher, returnDate, shortComment, source: "BDL" };
            }
          }));
          injuryMap[tid] = list;
        });
        await Promise.all(injuryPromises);

        // 5. Check yesterday's bullpen usage for each team
        const bullpenInfo: Record<number, { bullpenIP: number; bullpenTired: boolean }> = {};
        try {
          const yesterday = new Date(dateParam);
          yesterday.setDate(yesterday.getDate() - 1);
          const yDateStr = yesterday.toISOString().split("T")[0];
          const ySchedJson = await (await fetch(`${MLB_BASE}/schedule?sportId=1&date=${yDateStr}&gameType=R`)).json();
          const yGames: any[] = ySchedJson.dates?.[0]?.games ?? [];

          const boxPromises = yGames
            .filter((g: any) => g.status?.abstractGameState === "Final")
            .map(async (g: any) => {
              try {
                const boxJson = await (await fetch(`${MLB_BASE}/game/${g.gamePk}/boxscore`)).json();
                for (const side of ["home", "away"] as const) {
                  const tid = g.teams[side].team.id;
                  const pitchers: number[] = boxJson.teams?.[side]?.pitchers ?? [];
                  const players = boxJson.teams?.[side]?.players ?? {};
                  let bpIP = 0;
                  let isFirst = true;
                  for (const pid of pitchers) {
                    const p = players["ID" + pid];
                    const ip = parseFloat(p?.stats?.pitching?.inningsPitched ?? "0");
                    if (isFirst) { isFirst = false; continue; } // skip starter
                    bpIP += ip;
                  }
                  bullpenInfo[tid] = { bullpenIP: bpIP, bullpenTired: bpIP >= 4 };
                }
              } catch {}
            });
          await Promise.all(boxPromises);
        } catch (e) {
          console.error("bullpen check error", e);
        }

        // 6. Calculate streak, win rate, splits, SOS/L10 from season schedule
        interface TeamForm {
          streak: number;
          winRate: number;
          seasonWinRate: number;
          homeRPG: number; homeERA: number; homeRecord: string;
          awayRPG: number; awayERA: number; awayRecord: string;
          recentGames: { opp: string; oppAbbr: string; won: boolean; score: string; venue: string }[];
        }
        const streakMap: Record<number, TeamForm> = {};
        const allTeamIds = [...teamIds];
        const streakPromises = allTeamIds.map(async (tid) => {
          try {
            // Fetch full season schedule
            const endDate = dateParam;
            const schedUrl = `${MLB_BASE}/schedule?sportId=1&teamId=${tid}&startDate=2026-03-01&endDate=${endDate}&gameType=R&hydrate=linescore`;
            const schedJson = await (await fetch(schedUrl)).json();
            const games: { date: string; won: boolean; isHome: boolean; runsScored: number; runsAllowed: number; opp: string; oppAbbr: string; score: string }[] = [];
            for (const d of schedJson.dates ?? []) {
              for (const gm of d.games ?? []) {
                if (gm.status?.abstractGameState === "Final") {
                  const isHome = gm.teams.home.team.id === tid;
                  const homeScore = gm.teams.home.score ?? 0;
                  const awayScore = gm.teams.away.score ?? 0;
                  const won = isHome ? homeScore > awayScore : awayScore > homeScore;
                  const runsScored = isHome ? homeScore : awayScore;
                  const runsAllowed = isHome ? awayScore : homeScore;
                  const oppTeam = isHome ? gm.teams.away.team : gm.teams.home.team;
                  games.push({
                    date: d.date, won, isHome, runsScored, runsAllowed,
                    opp: oppTeam.name ?? "", oppAbbr: oppTeam.abbreviation ?? oppTeam.name?.slice(0, 3) ?? "",
                    score: `${runsScored}-${runsAllowed}`,
                  });
                }
              }
            }
            games.sort((a, b) => b.date.localeCompare(a.date));

            // Streak
            let streak = 0;
            if (games.length > 0) {
              const firstWon = games[0].won;
              for (const gm of games) {
                if (gm.won === firstWon) streak++;
                else break;
              }
              if (!firstWon) streak = -streak;
            }

            // Win rate last 10
            const last10 = games.slice(0, 10);
            const l10Wins = last10.filter(g => g.won).length;
            const winRate = last10.length > 0 ? Math.round((l10Wins / last10.length) * 100) / 100 : 0.50;

            // Season win rate
            const totalWins = games.filter(g => g.won).length;
            const seasonWinRate = games.length > 0 ? Math.round((totalWins / games.length) * 100) / 100 : 0.50;

            // Home/Away splits
            const homeGames = games.filter(g => g.isHome);
            const awayGames = games.filter(g => !g.isHome);
            const homeRPG = homeGames.length > 0 ? Math.round((homeGames.reduce((s, g) => s + g.runsScored, 0) / homeGames.length) * 10) / 10 : 4.5;
            const homeERA = homeGames.length > 0 ? Math.round((homeGames.reduce((s, g) => s + g.runsAllowed, 0) / homeGames.length) * 10) / 10 : 4.0;
            const awayRPG = awayGames.length > 0 ? Math.round((awayGames.reduce((s, g) => s + g.runsScored, 0) / awayGames.length) * 10) / 10 : 4.5;
            const awayERA = awayGames.length > 0 ? Math.round((awayGames.reduce((s, g) => s + g.runsAllowed, 0) / awayGames.length) * 10) / 10 : 4.0;
            const homeW = homeGames.filter(g => g.won).length;
            const awayW = awayGames.filter(g => g.won).length;
            const homeRecord = `${homeW}-${homeGames.length - homeW}`;
            const awayRecord = `${awayW}-${awayGames.length - awayW}`;

            // L10 recent opponents
            const recentGames = last10.map(g => ({
              opp: g.opp, oppAbbr: g.oppAbbr, won: g.won, score: g.score,
              venue: g.isHome ? "vs" : "at",
            }));

            streakMap[tid] = { streak, winRate, seasonWinRate, homeRPG, homeERA, homeRecord, awayRPG, awayERA, awayRecord, recentGames };
          } catch (e) {
            // silently fail
          }
        });
        await Promise.all(streakPromises);

        // 6b. Pre-compute H2H for each game matchup
        const h2hMap: Record<string, { homeWins: number; awayWins: number; label: string }> = {};
        for (const g of rawGames) {
          const homeId = g.teams.home.team.id;
          const awayId = g.teams.away.team.id;
          const key = `${homeId}-${awayId}`;
          try {
            const h2hUrl = `${MLB_BASE}/schedule?sportId=1&teamId=${homeId}&startDate=2026-03-01&endDate=${dateParam}&season=${MLB_SEASON_CURRENT}&opponentId=${awayId}&gameType=R`;
            const h2hJson = await (await fetch(h2hUrl)).json();
            let homeWins = 0, awayWins = 0;
            for (const d of h2hJson.dates ?? []) {
              for (const gm of d.games ?? []) {
                if (gm.status?.abstractGameState === "Final") {
                  const hScore = gm.teams.home.score ?? 0;
                  const aScore = gm.teams.away.score ?? 0;
                  if (hScore > aScore) {
                    if (gm.teams.home.team.id === homeId) homeWins++;
                    else awayWins++;
                  } else {
                    if (gm.teams.away.team.id === homeId) homeWins++;
                    else awayWins++;
                  }
                }
              }
            }
            const total = homeWins + awayWins;
            const homeName = g.teams.home.team.abbreviation ?? g.teams.home.team.name?.slice(0, 3) ?? "HOME";
            const awayName = g.teams.away.team.abbreviation ?? g.teams.away.team.name?.slice(0, 3) ?? "AWAY";
            const label = total > 0 ? `${homeName} ${homeWins}-${awayWins} ${awayName}` : "";
            h2hMap[key] = { homeWins, awayWins, label };
          } catch {
            h2hMap[key] = { homeWins: 0, awayWins: 0, label: "" };
          }
        }

        // 7. Assemble games
        return rawGames.map((g: any) => {
          const homeId = g.teams.home.team.id;
          const awayId = g.teams.away.team.id;
          const homePid = g.teams.home.probablePitcher?.id;
          const awayPid = g.teams.away.probablePitcher?.id;

          const homeForm = streakMap[homeId];
          const awayForm = streakMap[awayId];
          const h2hKey = `${homeId}-${awayId}`;
          const h2h = h2hMap[h2hKey];

          // Weather parsing
          const wind = (g.weather?.wind ?? "") as string;
          const windFavorable = wind.toLowerCase().includes("out");
          const tempF = parseInt(g.weather?.temp ?? "72") || 72;
          const isNight = g.dayNight === "night";

          // Bullpen status
          const homeBpTired = bullpenInfo[homeId]?.bullpenTired ?? false;
          const awayBpTired = bullpenInfo[awayId]?.bullpenTired ?? false;

          return {
            gameId: g.gamePk,
            gameTime: g.gameDate,
            homeTeam: { id: homeId, name: g.teams.home.team.name },
            awayTeam: { id: awayId, name: g.teams.away.team.name },
            homeStats: teamStatsMap[homeId] ? {
              ...teamStatsMap[homeId],
              streak: homeForm?.streak ?? 0,
              winRate: homeForm?.winRate ?? 0.50,
              seasonWinRate: homeForm?.seasonWinRate ?? 0.50,
              bullpenTired: homeBpTired,
              homeRPG: homeForm?.homeRPG ?? 4.5,
              homeERA: homeForm?.homeERA ?? 4.0,
              homeRecord: homeForm?.homeRecord ?? "",
              awayRPG: homeForm?.awayRPG ?? 4.5,
              awayERA: homeForm?.awayERA ?? 4.0,
              awayRecord: homeForm?.awayRecord ?? "",
              recentGames: homeForm?.recentGames ?? [],
            } : null,
            awayStats: teamStatsMap[awayId] ? {
              ...teamStatsMap[awayId],
              streak: awayForm?.streak ?? 0,
              winRate: awayForm?.winRate ?? 0.50,
              seasonWinRate: awayForm?.seasonWinRate ?? 0.50,
              bullpenTired: awayBpTired,
              homeRPG: awayForm?.homeRPG ?? 4.5,
              homeERA: awayForm?.homeERA ?? 4.0,
              homeRecord: awayForm?.homeRecord ?? "",
              awayRPG: awayForm?.awayRPG ?? 4.5,
              awayERA: awayForm?.awayERA ?? 4.0,
              awayRecord: awayForm?.awayRecord ?? "",
              recentGames: awayForm?.recentGames ?? [],
            } : null,
            homePitcher: homePid ? pitcherStatsMap[homePid] ?? null : null,
            awayPitcher: awayPid ? pitcherStatsMap[awayPid] ?? null : null,
            venue: g.venue?.name ?? "",
            weather: { tempF, wind: g.weather?.wind ?? "", windFavorable, condition: g.weather?.condition ?? "" },
            isNight,
            homeBullpenTired: homeBpTired,
            awayBullpenTired: awayBpTired,
            h2h: h2h?.label ?? "",
            h2hHomeWins: h2h?.homeWins ?? 0,
            h2hAwayWins: h2h?.awayWins ?? 0,
            homeInjuries: injuryMap[homeId] ?? [],
            awayInjuries: injuryMap[awayId] ?? [],
          };
        });
      });

      res.json({ success: true, games: data, date: dateParam });
    } catch (e) {
      console.error("mlb all error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener datos MLB" });
    }
  });

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
          nbaFetch(buildUrl(0, "Advanced")),
          nbaFetch(buildUrl(0, "Base")),
          nbaFetch(buildUrl(10, "Advanced")),
          nbaFetch(buildUrl(10, "Base")),
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
      console.error("wnba error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener datos WNBA" });
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
        const json = await nbaFetch(url);
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
          nbaFetch(buildUrl(0)),
          nbaFetch(buildUrl(10)),
          nbaFetch(`https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=10&PlayerOrTeam=T&Season=2026&SeasonType=Regular+Season&Sorter=DATE`),
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
        const json = await nbaFetch(url);
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
      console.error("wnba fatigue error", e);
      res.status(500).json({ success: false, error: "No se pudo calcular fatigue WNBA" });
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
        const json = await nbaFetch(url);
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

  app.get("/api/nhl/all", async (req, res) => {
    try {
      const dateParam = (req.query.date as string) || todayISO();
      const cacheKey = `nhl-all-v9-${dateParam}`;

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
          const summJson = await (await fetch("https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId=20252026")).json();
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
            fetch("https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/teams.csv"),
            fetch("https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/goalies.csv"),
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
            const mpSRes = await fetch("https://moneypuck.com/moneypuck/playerData/seasonSummary/2025/regular/skaters.csv");
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
        const dfGoalieMap: Record<string, { name: string; svPct: number; gaa: number; wins: number; losses: number; otl: number; status: string }> = {};

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
                  svPct: dg.homeGoalieSavePercentage ? Math.round(dg.homeGoalieSavePercentage * 1000) / 1000 : 0.900,
                  gaa: dg.homeGoalieGoalsAgainstAvg ? Math.round(dg.homeGoalieGoalsAgainstAvg * 100) / 100 : 3.00,
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
                  svPct: dg.awayGoalieSavePercentage ? Math.round(dg.awayGoalieSavePercentage * 1000) / 1000 : 0.900,
                  gaa: dg.awayGoalieGoalsAgainstAvg ? Math.round(dg.awayGoalieGoalsAgainstAvg * 100) / 100 : 3.00,
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
              nhlGoalieIdMap[abbr] = leaders.map((l: any) => ({
                playerId: l.playerId,
                name: ((l.firstName?.default || "") + " " + (l.lastName?.default || "")).trim(),
                svPct: l.savePctg ? Math.round(l.savePctg * 1000) / 1000 : 0.900,
                gaa: l.gaa ? Math.round(l.gaa * 100) / 100 : 3.00,
                record: l.record || "0-0",
                gp: l.gamesPlayed || 0,
              }));
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
          let starterSvPct = dfGoalie?.svPct || 0.900;
          let starterGaa = dfGoalie?.gaa || 3.00;
          let starterRecord = dfGoalie ? `${dfGoalie.wins}-${dfGoalie.losses}-${dfGoalie.otl}` : "0-0";
          let starterGP = 0;
          let starterPlayerId: number | null = null;
          let confirmStatus = dfGoalie?.status || "Unknown";

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
            // Fallback: pick goalie with most GP from NHL data
            const best = nhlGoalies.reduce((a, b) => a.gp > b.gp ? a : b);
            starterName = best.name;
            starterSvPct = best.svPct;
            starterGaa = best.gaa;
            starterRecord = best.record;
            starterGP = best.gp;
            starterPlayerId = best.playerId;
            confirmStatus = "Fallback";
          }

          // Fetch recent game log (last 5 starts) for the probable starter
          let recentGAA: number | undefined;
          let recentSvPct: number | undefined;
          let last5Record = "";
          if (starterPlayerId) {
            try {
              const glRes = await fetch(`https://api-web.nhle.com/v1/player/${starterPlayerId}/game-log/20252026/2`);
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
            gsax,
          };
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
              const rRes = await fetch(`https://api-web.nhle.com/v1/club-stats/${tricode}/20252026/2`);
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
              fetch(`https://api-web.nhle.com/v1/club-schedule-season/${tricode}/20252026`).then(r => r.json())
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
              fetch(`https://api-web.nhle.com/v1/club-schedule-season/${tricode}/20252026`).then(r => r.json())
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
              fetch(`https://api-web.nhle.com/v1/club-schedule-season/${hA}/20252026`).then(r => r.json())
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

      res.json({ success: true, games: data, date: dateParam });
    } catch (e) {
      console.error("nhl error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener datos NHL" });
    }
  });

  // ── PICKS PERSISTENCE ──────────────────────────────────────────────────
  // File-based storage — survives server restarts and deployments
  const PICKS_FILE = path.join(process.cwd(), "picks-data.json");
  const DEFAULT_PICKS = { picks: [], mlbPicks: [], wnbaPicks: [], nhlPicks: [], bankroll: 1000, nextId: 1 };

  // Load from disk on startup
  let picksState: any = null;
  try {
    if (fs.existsSync(PICKS_FILE)) {
      picksState = JSON.parse(fs.readFileSync(PICKS_FILE, "utf-8"));
      console.log(`Picks loaded from disk: ${(picksState.picks?.length || 0) + (picksState.mlbPicks?.length || 0) + (picksState.nhlPicks?.length || 0)} total picks`);
    }
  } catch (e) {
    console.error("Error loading picks from disk:", e);
  }

  app.get("/api/picks", (_req, res) => {
    if (picksState) {
      res.json({ success: true, ...picksState });
    } else {
      res.json({ success: true, ...DEFAULT_PICKS });
    }
  });

  app.post("/api/picks/sync", (req, res) => {
    picksState = req.body;
    // Save to disk asynchronously
    try {
      fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState));
    } catch (e) {
      console.error("Error saving picks to disk:", e);
    }
    res.json({ success: true });
  });

  // ── CLV AUTO-COMPUTE ───────────────────────────────────────
  // Para cada pick sin closingOdds, busca el snapshot más cercano al commence_time del partido
  // y calcula CLV. Llamar periódicamente o desde el cliente al cargar el dashboard.
  function americanToDecimal(american: number): number {
    return american > 0 ? american / 100 + 1 : -100 / american + 1;
  }
  function americanToProbCLV(american: number): number {
    return american > 0 ? 100 / (american + 100) : -american / (-american + 100);
  }

  // Mapeo de team names entre el sistema de picks y el de The Odds API
  const NAME_ALIASES: Record<string, string[]> = {
    "Athletics": ["Athletics", "Oakland Athletics"],
    "Oakland Athletics": ["Athletics", "Oakland Athletics"],
  };

  function normalizeTeam(name: string): string {
    return (name || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  }

  function teamMatch(a: string, b: string): boolean {
    const na = normalizeTeam(a);
    const nb = normalizeTeam(b);
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    const aliasesA = NAME_ALIASES[a]?.map(normalizeTeam) ?? [];
    const aliasesB = NAME_ALIASES[b]?.map(normalizeTeam) ?? [];
    return aliasesA.includes(nb) || aliasesB.includes(na);
  }

  // Para una fecha YYYY-MM-DD, devuelve closing odds por gameKey y mercado
  // closing = snapshot más cercano (pero antes) del commence_time, preferentemente Hard Rock
  function getClosingSnapshots(): Record<string, any> {
    const result: Record<string, any> = {};
    const allHistory = getAllSnapshots();
    const nowTs = Date.now();
    // Group all snapshots by gameKey
    const allKeys = new Set<string>();
    allHistory.forEach(s => allKeys.add(`${s.sport}::${s.gameKey}`));
    for (const key of allKeys) {
      const [sport, gameKey] = key.split("::");
      const snaps = allHistory.filter(s => s.sport === sport && s.gameKey === gameKey);
      if (snaps.length === 0) continue;
      // commence_time es la 3ra parte del gameKey: "away@home@iso"
      const parts = gameKey.split("@");
      const commenceIso = parts[parts.length - 1];
      const commenceTs = new Date(commenceIso).getTime();
      if (!commenceTs || Number.isNaN(commenceTs)) continue;
      // CRÍTICO: solo calcular closing si el partido YA empezó (con margen de 10 min de gracia)
      // Antes de que empiece, no existe "cuota de cierre" — las cuotas aún se están moviendo
      if (nowTs < commenceTs - 5 * 60 * 1000) continue;
      // Filtrar snapshots ANTES del commence (cierre = último antes del partido)
      const beforeStart = snaps.filter(s => s.ts <= commenceTs);
      if (beforeStart.length === 0) continue;
      // Tomar el snapshot más tardío, preferiblemente Hard Rock
      const latestTs = Math.max(...beforeStart.map(s => s.ts));
      // El snapshot más reciente debe estar a máximo 3 h del commence (cuota "casi de cierre")
      // Antes era 60 min — eso descartaba la mayoría de juegos cuando nadie abría la app
      // a tiempo. Con 180 min recuperamos los históricos sin perder precisión significativa.
      if (commenceTs - latestTs > 180 * 60 * 1000) continue;
      // Tolerancia: snapshots dentro de los últimos 120 min antes del cierre disponible
      const closingWindow = beforeStart.filter(s => latestTs - s.ts < 120 * 60 * 1000);
      // Preferir Hard Rock
      const bookPriority = ["hardrockbet_fl", "hardrockbet", "hardrockbet_az", "draftkings", "fanduel", "betmgm"];
      let closing: any = null;
      for (const book of bookPriority) {
        const bsnap = closingWindow.find(s => s.book === book);
        if (bsnap) { closing = bsnap; break; }
      }
      if (!closing) closing = closingWindow.sort((a, b) => b.ts - a.ts)[0];
      result[key] = { sport, gameKey, commenceTs, closing, away: parts[0], home: parts[1] };
    }
    return result;
  }

  // Match un pick con un closing snapshot y calcula CLV
  function computeCLVForPick(pick: any, closingMap: Record<string, any>): { closingOdds?: number; closingImpliedProb?: number; clvPercent?: number } | null {
    const sport = (pick.sport || "").toLowerCase();
    const pickTeam = pick.team || "";
    const opp = pick.opponent || "";
    const pickDate = pick.date || "";
    if (!pickTeam || !pickDate) return null;

    // Buscar el gameKey que coincida con team + opponent + date
    const candidates = Object.values(closingMap).filter((c: any) => {
      if (c.sport !== sport) return false;
      // commence date in FL
      const dStr = new Date(c.commenceTs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      if (dStr !== pickDate) return false;
      const matchesAway = teamMatch(c.away, pickTeam) || teamMatch(c.away, opp);
      const matchesHome = teamMatch(c.home, pickTeam) || teamMatch(c.home, opp);
      return matchesAway && matchesHome;
    });

    if (candidates.length === 0) return null;
    const { closing, away, home } = candidates[0] as any;

    // Determinar mercado y lado
    const market = (pick.market || "").toUpperCase();
    const pickIsHome = teamMatch(pickTeam, home);

    let closingOdds: number | undefined;

    if (market === "ML" || market === "F5") {
      // ML del juego completo (F5 no está en odds API — usar ML como aprox)
      if (closing.ml) {
        closingOdds = pickIsHome ? closing.ml.home : closing.ml.away;
      }
    } else if (market.includes("RUN LINE") || market.includes("PUCK") || market.includes("SPREAD")) {
      if (closing.spread) {
        closingOdds = pickIsHome ? closing.spread.homeOdds : closing.spread.awayOdds;
      }
    } else if (market.includes("OVER") || market.includes("UNDER") || market.includes("TOTAL")) {
      // Inferir over vs under desde pick.pick
      const pickStr = (pick.pick || "").toUpperCase();
      if (closing.total) {
        closingOdds = pickStr.includes("OVER") ? closing.total.overOdds : closing.total.underOdds;
      }
    }

    if (!closingOdds) return null;

    const closingImpliedProb = americanToProbCLV(closingOdds);
    const decimalOpen = americanToDecimal(pick.odds);
    const decimalClose = americanToDecimal(closingOdds);
    const clvPercent = ((decimalOpen - decimalClose) / decimalClose) * 100;

    return {
      closingOdds,
      closingImpliedProb: Math.round(closingImpliedProb * 1000) / 1000,
      clvPercent: Math.round(clvPercent * 100) / 100,
    };
  }

  // Endpoint: limpiar CLVs incorrectos (calculados antes del fix de timing)
  app.post("/api/clv/reset", async (_req, res) => {
    if (!picksState) return res.json({ success: false, error: "No picks state" });
    let cleared = 0;
    const arrays = ["picks", "mlbPicks", "nhlPicks", "wnbaPicks"] as const;
    for (const arrName of arrays) {
      const arr = picksState[arrName] ?? [];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].clvPercent !== undefined || arr[i].closingOdds !== undefined) {
          const { clvPercent, closingOdds, closingImpliedProb, ...rest } = arr[i];
          arr[i] = rest;
          cleared++;
        }
      }
      picksState[arrName] = arr;
    }
    try { fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState)); } catch {}
    res.json({ success: true, cleared });
  });

  // Endpoint: refresca CLV de TODOS los picks con commence_time pasado
  app.post("/api/clv/refresh", async (_req, res) => {
    if (!picksState) return res.json({ success: false, error: "No picks state" });
    const closingMap = getClosingSnapshots();
    let updated = 0;
    let totalProcessed = 0;
    let alreadyComputed = 0;
    let noCommenceYet = 0;
    let noMatch = 0;
    const arrays = ["picks", "mlbPicks", "nhlPicks", "wnbaPicks"] as const;
    const nowTs = Date.now();
    for (const arrName of arrays) {
      const arr = picksState[arrName] ?? [];
      for (let i = 0; i < arr.length; i++) {
        const pick = arr[i];
        totalProcessed++;
        if (pick.clvPercent !== undefined && pick.clvPercent !== null && pick.closingOdds) {
          alreadyComputed++;
          continue;
        }
        const result = computeCLVForPick(pick, closingMap);
        if (!result) {
          noMatch++;
          continue;
        }
        arr[i] = { ...pick, ...result };
        updated++;
      }
      picksState[arrName] = arr;
    }
    // Persist
    try { fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState)); } catch {}
    res.json({ success: true, updated, totalProcessed, alreadyComputed, noMatch, noCommenceYet, snapshotsAvailable: Object.keys(closingMap).length });
  });

  // ── BACKGROUND ODDS POLLER ──────────────────────────────────────────────
  // Cada 15 min refresca odds para MLB/NHL/NBA y guarda snapshots automáticamente.
  // Así el CLV no depende de que el usuario abra la app a tiempo — antes era el
  // problema #1: si nadie cargaba odds en los últimos 60 min antes de un juego,
  // ese partido se perdía para siempre.
  const ODDS_API_KEY_BG = "b6bab898f7a8879e95adf2290aac4184";
  const SPORT_MAP_BG: Record<string, string> = {
    nba: "basketball_nba", nhl: "icehockey_nhl", mlb: "baseball_mlb",
  };
  async function pollOddsForSport(sport: string) {
    try {
      const apiSport = SPORT_MAP_BG[sport]; if (!apiSport) return 0;
      const url = `https://api.the-odds-api.com/v4/sports/${apiSport}/odds/?apiKey=${ODDS_API_KEY_BG}&regions=us,us2&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=hardrockbet_fl,hardrockbet,hardrockbet_az,draftkings,fanduel,betmgm`;
      const resp = await fetch(url);
      const data: any = await resp.json();
      if (!Array.isArray(data)) return 0;
      const nowTs = Date.now();
      let saved = 0;
      for (const g of data) {
        const gameKey = `${g.away_team}@${g.home_team}@${g.commence_time}`;
        for (const book of (g.bookmakers || [])) {
          const mkts: any = {};
          for (const mkt of (book.markets || [])) {
            mkts[mkt.key] = {};
            for (const o of (mkt.outcomes || [])) {
              mkts[mkt.key][o.name] = { price: o.price, point: o.point };
            }
          }
          const h = mkts.h2h || {}, s = mkts.spreads || {}, t = mkts.totals || {};
          recordSnapshot({
            ts: nowTs, sport, gameKey, book: book.key,
            ml: (h[g.home_team] && h[g.away_team]) ? { home: h[g.home_team].price, away: h[g.away_team].price } : null,
            spread: (s[g.home_team] && s[g.away_team]) ? { line: s[g.home_team].point, homeOdds: s[g.home_team].price, awayOdds: s[g.away_team].price } : null,
            total: (t["Over"] && t["Under"]) ? { line: t["Over"].point, overOdds: t["Over"].price, underOdds: t["Under"].price } : null,
          });
          saved++;
        }
      }
      return saved;
    } catch (e) { console.error(`[odds-poll ${sport}] error:`, e); return 0; }
  }
  // First poll 30 s after boot, then every 15 min
  setTimeout(async () => {
    const a = await pollOddsForSport("mlb");
    const b = await pollOddsForSport("nhl");
    const c = await pollOddsForSport("nba");
    console.log(`[odds-poll boot] mlb=${a} nhl=${b} nba=${c} snapshots`);
  }, 30 * 1000);
  setInterval(async () => {
    const a = await pollOddsForSport("mlb");
    const b = await pollOddsForSport("nhl");
    const c = await pollOddsForSport("nba");
    if (a + b + c > 0) console.log(`[odds-poll] mlb=${a} nhl=${b} nba=${c} snapshots`);
  }, 15 * 60 * 1000);

  // Auto-refresh CLV every 30 minutes (background)
  setInterval(async () => {
    try {
      if (!picksState) return;
      const closingMap = getClosingSnapshots();
      const arrays = ["picks", "mlbPicks", "nhlPicks", "wnbaPicks"] as const;
      let updated = 0;
      for (const arrName of arrays) {
        const arr = picksState[arrName] ?? [];
        for (let i = 0; i < arr.length; i++) {
          const pick = arr[i];
          if (pick.clvPercent !== undefined && pick.clvPercent !== null && pick.closingOdds) continue;
          const result = computeCLVForPick(pick, closingMap);
          if (result) {
            arr[i] = { ...pick, ...result };
            updated++;
          }
        }
        picksState[arrName] = arr;
      }
      if (updated > 0) {
        try { fs.writeFileSync(PICKS_FILE, JSON.stringify(picksState)); } catch {}
        console.log(`[CLV auto-refresh] Updated ${updated} picks`);
      }
    } catch (e) {
      console.error("[CLV auto-refresh] error:", e);
    }
  }, 30 * 60 * 1000);

  // ── GET /api/odds/:sport ───────────────────────────────────────────────
  // Fetches odds from The Odds API (DraftKings = same platform as Hard Rock)
  const ODDS_API_KEY = "b6bab898f7a8879e95adf2290aac4184";
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
      const confirmed = !!(homeStarter && awayStarter);
      const minutesUntilGame = data?.startTimeUTC ? (new Date(data.startTimeUTC).getTime() - Date.now()) / 60000 : null;
      const name = (p: any) => p ? `${p.firstName?.default || p.firstName || ""} ${p.lastName?.default || p.lastName || ""}`.trim() : null;
      res.json({
        success: true,
        confirmed,
        minutesUntilGame,
        home: homeStarter ? { name: name(homeStarter), svPct: homeStarter.savePctg, gaa: homeStarter.goalsAgainstAverage } : null,
        away: awayStarter ? { name: name(awayStarter), svPct: awayStarter.savePctg, gaa: awayStarter.goalsAgainstAverage } : null,
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
        const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=${pk}&hydrate=weather,venue,probablePitcher`;
        const schedJson = await (await fetch(schedUrl)).json();
        const game = schedJson.dates?.[0]?.games?.find((g: any) => g.gamePk == pk) || schedJson.dates?.[0]?.games?.[0];
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
