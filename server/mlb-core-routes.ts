import type { Express } from "express";
import { getParkFactor, computeWeatherImpact, analyzeOpener } from "./mlb-advanced";
import { buildMlbPeopleSearchUrl } from "./mlb-injury-identity";
import {
  classifyMlbInjuryShadow,
  fetchOfficialMlbInjurySnapshot,
  summarizeMlbInjuryShadow,
} from "./mlb-injury-shadow";
import { buildMlbInjuryPhaseBPlan } from "./mlb-injury-phase-b";
import { FL_TZ, requireSecret, todayISO, withCache } from "./route-runtime";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";

/** MLB metadata, injury, pitcher, matchup, lineup and aggregate routes. */
export function registerMlbCoreRoutes(app: Express): void {
  const MLB_BASE = "https://statsapi.mlb.com/api/v1";
  const MLB_BASE_V11 = "https://statsapi.mlb.com/api/v1.1";
  // Constantes de temporada — dinámicas (auto-cambian cada año)
  const MLB_SEASON_CURRENT = String(new Date().getFullYear());      // ej. "2026"
  const MLB_SEASON_PREVIOUS = String(new Date().getFullYear() - 1); // ej. "2025"

  // ── Helper: getGameMeta ────────────────────────────────────────────────────
  // BUG conocido en MLB Stats API: /schedule?gamePk=X devuelve probable pitchers
  // INCORRECTOS en doubleheaders (mezcla con el otro juego). Usar /game/X/feed/live
  // que sí devuelve los datos correctos por gamePk.
  // Retorna estructura compatible con `game.teams.home/away.probablePitcher` para
  // que los endpoints existentes no requieran cambios mayores.
  async function getGameMeta(gamePk: number): Promise<any | null> {
    try {
      const r = await fetch(`${MLB_BASE_V11}/game/${gamePk}/feed/live`);
      if (!r.ok) return null;
      const j: any = await r.json();
      const gd = j.gameData;
      if (!gd) return null;
      const homeTeam = gd.teams?.home || {};
      const awayTeam = gd.teams?.away || {};
      const probHome = gd.probablePitchers?.home;
      const probAway = gd.probablePitchers?.away;
      // Players index para enriquecer probablePitcher con datos completos
      const playerKey = (id: number) => `ID${id}`;
      const enrich = (p: any) => {
        if (!p?.id) return undefined;
        const full = gd.players?.[playerKey(p.id)];
        return {
          id: p.id,
          fullName: full?.fullName ?? p.fullName,
          pitchHand: full?.pitchHand,
          primaryNumber: full?.primaryNumber,
        };
      };
      return {
        gamePk,
        gameDate: gd.datetime?.dateTime || gd.datetime?.originalDate,
        venue: gd.venue,
        weather: gd.weather,
        teams: {
          home: { team: homeTeam, probablePitcher: enrich(probHome) },
          away: { team: awayTeam, probablePitcher: enrich(probAway) },
        },
        lineups: {
          // Enriquecemos con fullName + position del index gameData.players (clave "ID<id>")
          homePlayers: (j.liveData?.boxscore?.teams?.home?.battingOrder ?? []).map((id: number) => {
            const p = gd.players?.[`ID${id}`];
            return {
              id,
              fullName: p?.fullName,
              primaryPosition: p?.primaryPosition,
              batSide: p?.batSide,
            };
          }),
          awayPlayers: (j.liveData?.boxscore?.teams?.away?.battingOrder ?? []).map((id: number) => {
            const p = gd.players?.[`ID${id}`];
            return {
              id,
              fullName: p?.fullName,
              primaryPosition: p?.primaryPosition,
              batSide: p?.batSide,
            };
          }),
        },
      };
    } catch {
      return null;
    }
  }
  const BDL_BASE = "https://api.balldontlie.io";
  // Provider credential is required at runtime; no source-code fallback.
  const BDL_KEY = requireSecret("BDL_API_KEY");

  // Mapeo de team abbreviations BALLDONTLIE → MLB Stats team IDs
  const BDL_MLB_TEAM_TO_ID: Record<string, number> = {
    ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CHW: 145, CIN: 113,
    CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
    MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133,
    PHI: 143, PIT: 134, SD: 135, SEA: 136, SF: 137, STL: 138, TB: 139,
    TEX: 140, TOR: 141, WSH: 120, WAS: 120,
  };

  type MlbInjuryFeedStatus = "VERIFIED" | "PARTIAL" | "SOURCE_UNAVAILABLE";
  interface MlbInjuryFeed {
    status: MlbInjuryFeedStatus;
    source: "BALLDONTLIE";
    fetchedAt: string;
    stale: boolean;
    sourceErrors: string[];
    totalRecords: number;
    activeRecords: number;
    byTeam: Record<number, any[]>;
  }

  const MLB_INJURY_TTL_MS = 5 * 60 * 1000;
  const MLB_MAX_TRUSTED_INJURIES_PER_TEAM = 18;
  let mlbInjuryCache: { ts: number; feed: MlbInjuryFeed } | null = null;

  function isActiveMlbInjuryRecord(injury: any): boolean {
    const text = [
      injury?.status,
      injury?.type,
      injury?.detail,
      injury?.description,
      injury?.short_comment,
    ].filter(Boolean).join(" ").toLowerCase();

    if (!text) return false;
    if (/\b(reinstated|activated|available|healthy|returned|cleared|probable)\b/.test(text)) return false;
    return /\b(out|injured list|day[- ]to[- ]day|dtd|doubtful|questionable|suspended|bereavement|paternity|restricted list)\b/.test(text)
      || /\b(10|15|60)[- ]day il\b/.test(text)
      || /\bil\b/.test(text);
  }

  function dedupeMlbInjuries(records: any[]): any[] {
    const seen = new Set<string>();
    const result: any[] = [];
    for (const injury of records) {
      const player = injury?.player ?? {};
      const key = String(player.id || player.player_id || player.full_name || `${player.first_name || ""}-${player.last_name || ""}`).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(injury);
    }
    return result;
  }

  async function getMLBInjuriesFromBDL(): Promise<MlbInjuryFeed> {
    const now = Date.now();
    if (mlbInjuryCache && now - mlbInjuryCache.ts < MLB_INJURY_TTL_MS) {
      return mlbInjuryCache.feed;
    }

    const previous = mlbInjuryCache?.feed;
    const byTeam: Record<number, any[]> = {};
    let totalRecords = 0;
    let activeRecords = 0;
    const sourceErrors: string[] = [];

    try {
      let cursor: number | null = null;
      let pages = 0;
      while (pages < 10) {
        const url: string = `${BDL_BASE}/mlb/v1/player_injuries?per_page=100${cursor ? `&cursor=${cursor}` : ""}`;
        const r = await fetch(url, { headers: { Authorization: BDL_KEY, Accept: "application/json" } });
        if (!r.ok) throw new Error(`BALLDONTLIE injuries HTTP ${r.status}`);
        const j: any = await r.json();
        const data: any[] = Array.isArray(j.data) ? j.data : [];
        totalRecords += data.length;

        for (const injury of data) {
          if (!isActiveMlbInjuryRecord(injury)) continue;
          const abbr = (injury.player?.team?.abbreviation || "").toUpperCase();
          const mlbTeamId = BDL_MLB_TEAM_TO_ID[abbr];
          if (!mlbTeamId) continue;
          if (!byTeam[mlbTeamId]) byTeam[mlbTeamId] = [];
          byTeam[mlbTeamId].push(injury);
          activeRecords++;
        }

        pages++;
        cursor = j.meta?.next_cursor ?? null;
        if (!cursor) break;
      }

      for (const teamId of Object.keys(byTeam).map(Number)) {
        byTeam[teamId] = dedupeMlbInjuries(byTeam[teamId]);
      }

      const feed: MlbInjuryFeed = {
        status: "VERIFIED",
        source: "BALLDONTLIE",
        fetchedAt: new Date(now).toISOString(),
        stale: false,
        sourceErrors,
        totalRecords,
        activeRecords,
        byTeam,
      };
      mlbInjuryCache = { ts: now, feed };
      return feed;
    } catch (error: any) {
      const message = String(error?.message || error || "Unknown injury-source failure");
      sourceErrors.push(message);
      console.error("BDL MLB injuries fetch failed:", error);

      if (previous && Object.keys(previous.byTeam).length > 0) {
        const feed: MlbInjuryFeed = {
          ...previous,
          status: "PARTIAL",
          stale: true,
          sourceErrors: [...previous.sourceErrors, ...sourceErrors],
        };
        mlbInjuryCache = { ts: now, feed };
        return feed;
      }

      const feed: MlbInjuryFeed = {
        status: "SOURCE_UNAVAILABLE",
        source: "BALLDONTLIE",
        fetchedAt: new Date(now).toISOString(),
        stale: false,
        sourceErrors,
        totalRecords: 0,
        activeRecords: 0,
        byTeam: {},
      };
      mlbInjuryCache = { ts: now, feed };
      return feed;
    }
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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
      // FIX doubleheader: usar feed/live (v1.1) en vez de schedule?gamePk (que tiene bug en MLB API)
      const game: any = await getGameMeta(gamePk);
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

      // FIX doubleheader: usar feed/live en vez de schedule?gamePk (bug MLB API mezcla pitchers)
      const game: any = await getGameMeta(gamePk);
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
        const probablePitcherByTeam: Record<number, number | null> = {};
        for (const g of rawGames) {
          const homeTeamId = g.teams.home.team.id;
          const awayTeamId = g.teams.away.team.id;
          teamIds.add(homeTeamId);
          teamIds.add(awayTeamId);
          probablePitcherByTeam[homeTeamId] = g.teams.home.probablePitcher?.id ?? null;
          probablePitcherByTeam[awayTeamId] = g.teams.away.probablePitcher?.id ?? null;
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

            // Recent ERA from LAST 3 starts (most recent).
            // BUG FIX: MLB API devuelve splits en orden cronológico ASCENDENTE
            // (más viejo primero). Hay que ordenar por fecha desc y tomar los 3 más recientes.
            // Antes: slice(0, 3) tomaba los PRIMEROS 3 (los más VIEJOS),
            // por eso daysRest salía 52+ días (era el primer partido de la temporada).
            // BUG FIX 2026-05-22: filtrar SOLO starts COMPLETOS y NO el del día actual.
            // Bugs encontrados:
            //   - gameLog incluye relief appearances (gamesStarted=0)
            //   - gameLog incluye el start del día actual con IP=1 si está en vivo
            //     → daysRest salía 0 cuando debería ser 5-7
            // Solución: filtrar gamesStarted>=1 Y excluir el día actual Y IP mínimo 3
            const todayStr = dateParam; // formato YYYY-MM-DD
            const allLogs = (gameLog?.splits ?? [])
              .filter((s: any) => {
                const gs = parseInt(s.stat?.gamesStarted) || 0;
                if (gs < 1) return false;
                // Excluir partido en curso del día actual
                if (s.date === todayStr) return false;
                // Excluir starts incompletos (cancelados, suspendidos): mínimo 3 IP
                const ip = parseFloat(s.stat?.inningsPitched || "0");
                if (ip < 3) return false;
                return true;
              })
              .slice()
              .sort((a: any, b: any) => {
                const da = new Date(a.date || 0).getTime();
                const db = new Date(b.date || 0).getTime();
                return db - da; // más reciente primero
              });
            const logs = allLogs.slice(0, 3); // los 3 starts COMPLETOS más recientes

            let recentEra: number | undefined;
            if (logs.length >= 2) {
              let totalER = 0, totalIP = 0;
              for (const lg of logs) {
                totalER += parseInt(lg.stat?.earnedRuns) || 0;
                totalIP += parseIP(lg.stat?.inningsPitched || "0");
              }
              if (totalIP > 0) recentEra = Math.round((totalER / totalIP) * 9 * 100) / 100;
            }

            // Days rest: Último start (más reciente) vs fecha de hoy.
            let daysRest = 5;
            if (logs.length > 0 && logs[0].date) {
              const lastDate = new Date(logs[0].date);
              const today = new Date(dateParam);
              const diffDays = Math.round((today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
              // Cap defensivo: descanso real MLB normal 3-7 días. >15 indica error de datos.
              daysRest = Math.max(0, Math.min(15, diffDays));
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

        // 5a. Fetch injuries from BALLDONTLIE with explicit source quality.
        const injuryFeed = await getMLBInjuriesFromBDL();
        const bdlInjuriesByTeam = injuryFeed.byTeam;
        const injuryMap: Record<number, any[]> = {};
        const injuryMetaMap: Record<number, any> = {};
        const officialInjurySnapshots: Record<number, Awaited<ReturnType<typeof fetchOfficialMlbInjurySnapshot>>> = {};
        await Promise.all([...teamIds].map(async (tid) => {
          officialInjurySnapshots[tid] = await fetchOfficialMlbInjurySnapshot(tid, dateParam);
        }));
        const injuryPromises = [...teamIds].map(async (tid) => {
          const rawBdlList = bdlInjuriesByTeam[tid] ?? [];
          const anomalous = rawBdlList.length > MLB_MAX_TRUSTED_INJURIES_PER_TEAM;
          const teamStatus = anomalous ? "ANOMALOUS" : injuryFeed.status;
          const officialSnapshot = officialInjurySnapshots[tid];
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            validationSource: officialSnapshot?.source ?? "MLB_STATS",
            status: teamStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: [...(injuryFeed.sourceErrors ?? []), ...(officialSnapshot?.errors ?? [])],
            officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
            officialFetchedAt: officialSnapshot?.fetchedAt,
            count: rawBdlList.length,
            autoApplyAllowed: false,
            shadowMode: true,
            note: anomalous
              ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
              : teamStatus === "SOURCE_UNAVAILABLE"
                ? "Fuente de lesiones no disponible"
                : teamStatus === "PARTIAL"
                  ? "Datos de lesiones en caché/degradados; clasificación conservadora"
                  : rawBdlList.length === 0
                    ? "BALLDONTLIE no reporta ausencias; MLB se usa para comprobar cobertura"
                    : "Ausencias detectadas por BALLDONTLIE y enviadas a validación MLB",
          };

          const bdlList = anomalous ? [] : rawBdlList;
          if (bdlList.length === 0) {
            const officialIlEntries = Object.values(officialSnapshot?.rosterByPlayerId ?? {})
              .filter((entry: any) => /^D\d+$/i.test(String(entry.statusCode || "")) || /injured/i.test(String(entry.statusDescription || "")));
            const officialOnly = anomalous ? 0 : officialIlEntries.length;
            const sourcesVerified = !anomalous
              && injuryFeed.status === "VERIFIED"
              && officialSnapshot?.status === "VERIFIED";
            const phaseB = buildMlbInjuryPhaseBPlan({
              sourceStatus: injuryFeed.status,
              officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
              stale: injuryFeed.stale,
              anomalous,
              rejectedCount: 0,
              officialOnly,
              players: [],
            });
            injuryMap[tid] = [];
            injuryMetaMap[tid] = {
              ...injuryMetaMap[tid],
              status: anomalous ? "ANOMALOUS" : sourcesVerified && officialOnly === 0 ? "VERIFIED" : "PARTIAL",
              autoApplyAllowed: phaseB.autoApplyAllowed,
              phaseB,
              shadowSummary: {
                total: 0, applyCandidates: 0, alreadyReflected: 0,
                ignored: 0, conflicts: 0, pending: 0,
                highConfidence: 0, officialOnly, mode: "SHADOW",
              },
              note: anomalous
                ? `Lista anormal (${rawBdlList.length}); ajuste automático bloqueado`
                : officialOnly > 0
                  ? `BALLDONTLIE no reportó ${officialOnly} jugador(es) que MLB mantiene en lista de lesionados; cobertura en revisión`
                  : "Ambas fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
            };
            return;
          }
          const teamGP = teamStatsMap[tid]?.gamesPlayed ?? 0;
          // Buscar player_id en MLB Stats API por nombre y traer stats
          const list = await Promise.all(bdlList.map(async (inj: any) => {
            const player = inj.player ?? {};
            const name = player.full_name || `${player.first_name} ${player.last_name}`.trim();
            const pos = player.position || "";
            const status = inj.status || "";
            const normalizedPos = String(pos).trim().toUpperCase();
            const isPitcher = /pitcher/i.test(String(pos)) || ["P", "SP", "RP", "LHP", "RHP"].includes(normalizedPos);
            const detailParts = [inj.type, inj.detail, inj.side].filter(Boolean).join(" ");
            const fullStatus = detailParts ? `${status} · ${detailParts}` : status;
            const returnDate = inj.return_date || null;
            const shortComment = inj.short_comment || null;
            // Buscar player en MLB Stats API por nombre
            try {
              const lookupUrl = buildMlbPeopleSearchUrl(MLB_BASE, name, MLB_SEASON_CURRENT);
              const lookupJson = await (await fetch(lookupUrl)).json();
              const people = lookupJson.people ?? [];
              // Verificación estricta: mismo nombre normalizado Y equipo MLB actual.
              // Nunca usar el primer resultado como fallback: eso mezclaba jugadores de otros clubes.
              const normalizePersonName = (value: string) => String(value || "")
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^a-z0-9]/gi, "")
                .toLowerCase();
              const targetName = normalizePersonName(name);
              const match = people.find((p: any) =>
                p.currentTeam?.id === tid && normalizePersonName(p.fullName) === targetName
              );
              const pid = match?.id;
              const positionAbbr = match?.primaryPosition?.abbreviation || (isPitcher ? "P" : pos.split(" ").map((w: string) => w[0]).join("").toUpperCase());
              if (!pid) return null;
              if (isPitcher) {
                const sJ = await (await fetch(`${MLB_BASE}/people/${pid}/stats?stats=season&group=pitching&season=${MLB_SEASON_CURRENT}`)).json();
                const s = sJ.stats?.[0]?.splits?.[0]?.stat ?? {};
                let st = s;
                if (!s.era) {
                  const fb = await (await fetch(`${MLB_BASE}/people/${pid}/stats?stats=season&group=pitching&season=${MLB_SEASON_PREVIOUS}`)).json();
                  st = fb.stats?.[0]?.splits?.[0]?.stat ?? s;
                }
                const playerGP = parseInt(st.gamesPlayed) || 0;
                // No inferir juegos perdidos con teamGP-playerGP: banca, menores, trades y descansos lo vuelven inválido.
                const gamesMissed = 0;
                // Bullpen leverage data — saves/holds/games finished diferencian closer real vs setup vs middle
                const ipPitcher = parseIP(st.inningsPitched || "0");
                return {
                  playerId: pid, name, position: positionAbbr, status: fullStatus,
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
                // No inferir juegos perdidos con teamGP-playerGP: banca, menores, trades y descansos lo vuelven inválido.
                const gamesMissed = 0;
                // Star Power: slugging y composición para proxy de WAR
                const slg = parseFloat(st.slg) || 0;
                const obp = parseFloat(st.obp) || 0;
                const ops = parseFloat(st.ops) || 0;
                const iso = slg > 0 && parseFloat(st.avg) > 0 ? Math.round((slg - parseFloat(st.avg)) * 1000) / 1000 : null;
                return {
                  playerId: pid, name, position: positionAbbr, status: fullStatus,
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
              // Una búsqueda o enriquecimiento fallido no puede convertirse en una ausencia verificada.
              return null;
            }
          }));
          const verifiedList = list.filter(Boolean) as any[];
          const rejectedCount = rawBdlList.length - verifiedList.length;
          const probablePitcherId = probablePitcherByTeam[tid] ?? null;
          const shadowList = verifiedList.map((player: any) => {
            const rosterEvidence = officialSnapshot?.rosterByPlayerId?.[player.playerId];
            const transactionEvidence = officialSnapshot?.latestTransactionByPlayerId?.[player.playerId] ?? null;
            const shadow = classifyMlbInjuryShadow({
              playerId: player.playerId,
              name: player.name,
              isPitcher: player.isPitcher,
              position: player.position,
              rosterStatusCode: rosterEvidence?.statusCode ?? null,
              rosterStatusDescription: rosterEvidence?.statusDescription ?? null,
              latestTransaction: transactionEvidence,
              probablePitcherId,
              gamesStarted: player.gamesStarted,
              saves: player.saves,
              holds: player.holds,
              gamesFinished: player.gamesFinished,
              inningsPitched: player.inningsPitched,
              plateAppearances: player.plateAppearances,
              ops: player.ops,
              obp: player.obp,
              slg: player.slg,
              asOfDate: dateParam,
            });
            return {
              ...player,
              officialStatusCode: rosterEvidence?.statusCode ?? null,
              officialStatus: rosterEvidence?.statusDescription ?? null,
              officialTransaction: transactionEvidence,
              shadow,
            };
          });
          const bdlPlayerIds = new Set(shadowList.map((player: any) => Number(player.playerId)));
          const officialOnly = Object.values(officialSnapshot?.rosterByPlayerId ?? {})
            .filter((entry: any) => /^D\d+$/i.test(String(entry.statusCode || "")) || /injured/i.test(String(entry.statusDescription || "")))
            .filter((entry: any) => !bdlPlayerIds.has(Number(entry.playerId)))
            .length;
          const shadowSummary = {
            ...summarizeMlbInjuryShadow(shadowList.map((player: any) => player.shadow)),
            officialOnly,
          };
          const phaseB = buildMlbInjuryPhaseBPlan({
            sourceStatus: injuryFeed.status,
            officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
            stale: injuryFeed.stale,
            anomalous,
            rejectedCount,
            officialOnly,
            players: shadowList.map((player: any) => ({
              playerId: Number(player.playerId),
              name: String(player.name),
              isPitcher: Boolean(player.isPitcher),
              shadow: player.shadow,
            })),
          });
          injuryMap[tid] = shadowList;

          // Fase B: candidatos de alta confianza pasan a una segunda reconciliación con Bullpen Status.
          const identityComplete = injuryFeed.status === "VERIFIED"
            && officialSnapshot?.status === "VERIFIED"
            && rejectedCount === 0
            && officialOnly === 0;
          const safeStatus = identityComplete ? "VERIFIED" : "PARTIAL";
          injuryMetaMap[tid] = {
            source: injuryFeed.source,
            validationSource: officialSnapshot?.source ?? "MLB_STATS",
            status: safeStatus,
            fetchedAt: injuryFeed.fetchedAt,
            stale: injuryFeed.stale,
            sourceErrors: [...(injuryFeed.sourceErrors ?? []), ...(officialSnapshot?.errors ?? [])],
            officialValidationStatus: officialSnapshot?.status ?? "PARTIAL",
            officialFetchedAt: officialSnapshot?.fetchedAt,
            count: shadowList.length,
            rejectedCount,
            autoApplyAllowed: phaseB.autoApplyAllowed,
            shadowMode: true,
            shadowSummary,
            phaseB,
            note: phaseB.autoApplyAllowed
              ? `${phaseB.eligiblePlayerNames.length} relevista(s) superaron la Fase B; falta reconciliación final con Bullpen Status`
              : rejectedCount > 0
                ? `${rejectedCount} registro(s) descartado(s); los candidatos restantes no superaron todas las barreras de activación`
                : shadowList.length > 0
                  ? "BALLDONTLIE detecta y MLB valida; la Fase B se abstiene cuando falta certeza o existe riesgo de doble conteo"
                  : "Fuentes verificadas: no hay ausencias activas confirmadas para este equipo",
          };
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
            // FIX: incluir id de pitcher para que el frontend pueda llamar a TESI/Savant.
            // gamePk también agregado para que TESI pueda obtener lineup confirmado.
            gamePk: g.gamePk,
            homePitcher: homePid ? { id: homePid, ...(pitcherStatsMap[homePid] ?? {}) } : null,
            awayPitcher: awayPid ? { id: awayPid, ...(pitcherStatsMap[awayPid] ?? {}) } : null,
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
            homeInjuryData: injuryMetaMap[homeId] ?? {
              source: injuryFeed.source,
              status: injuryFeed.status,
              fetchedAt: injuryFeed.fetchedAt,
              stale: injuryFeed.stale,
              sourceErrors: injuryFeed.sourceErrors,
              count: 0,
              autoApplyAllowed: false,
              shadowMode: true,
              shadowSummary: {
                total: 0, applyCandidates: 0, alreadyReflected: 0,
                ignored: 0, conflicts: 0, pending: 0,
                highConfidence: 0, mode: "SHADOW",
              },
            },
            awayInjuryData: injuryMetaMap[awayId] ?? {
              source: injuryFeed.source,
              status: injuryFeed.status,
              fetchedAt: injuryFeed.fetchedAt,
              stale: injuryFeed.stale,
              sourceErrors: injuryFeed.sourceErrors,
              count: 0,
              autoApplyAllowed: false,
              shadowMode: true,
              shadowSummary: {
                total: 0, applyCandidates: 0, alreadyReflected: 0,
                ignored: 0, conflicts: 0, pending: 0,
                highConfidence: 0, mode: "SHADOW",
              },
            },
          };
        });
      });

      res.json({ success: true, games: data, date: dateParam });
    } catch (e) {
      console.error("mlb all error", e);
      res.status(500).json({ success: false, error: "No se pudieron obtener datos MLB" });
    }
  });

}
