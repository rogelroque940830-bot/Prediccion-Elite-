import type { Express } from "express";
import { computeMlbTesi } from "./mlb-tesi.js";
import { computeMlbEre } from "./mlb-ere.js";
import { computeEarlyMarkets } from "./mlb-early-markets.js";
import { computeF5Unified, type PitcherRecentForm, type UmpireData } from "./mlb-f5-unified.js";
import { computeMatchupSignal } from "./mlb-matchup-signal.js";
import { computeUncertainty } from "./mlb-uncertainty.js";
import { resolveMlbAnalysisDate } from "./mlb-route-runtime";

export function registerMlbEarlyRoutes(app: Express): void {
  // ── Early Markets MLB ──────────────────────────────────
  // F5 ML, F5 O/U, NRFI/YRFI, 1ª-2ª-3ª inning ML
  // POST body: { homeEreInput, awayEreInput, market lines (opcional) }
  app.post("/api/mlb/early-markets", async (req, res) => {
    try {
      const { home, away, lines } = req.body || {};
      if (!home?.teamId || !away?.teamId) {
        return res.status(400).json({ success: false, error: "home y away requieren teamId" });
      }

      // Calcular ERE para ambos equipos + matchup signal en paralelo
      const sharedGamePk = home.gamePk || away.gamePk;
      const analysisDateIso = await resolveMlbAnalysisDate(req.body?.gameDate, sharedGamePk);
      const currentSeason = Number(analysisDateIso.slice(0, 4));
      // FASE 1 — toggle para A/B testing del matchup signal
      const disableMatchup = req.body?.disableMatchup === true || req.query?.disableMatchup === "1";
      const [homeEre, awayEre, matchupSignal] = await Promise.all([
        computeMlbEre({
          teamId: home.teamId, teamName: home.teamName || "",
          gamePk: home.gamePk, opposingPitcherId: home.opposingPitcherId,
          opposingPitcherHand: home.opposingPitcherHand,
          venue: home.venue, tempF: home.tempF, windMph: home.windMph,
          windDirOut: home.windDirOut, gameDate: analysisDateIso,
        }),
        computeMlbEre({
          teamId: away.teamId, teamName: away.teamName || "",
          gamePk: away.gamePk, opposingPitcherId: away.opposingPitcherId,
          opposingPitcherHand: away.opposingPitcherHand,
          venue: away.venue, tempF: away.tempF, windMph: away.windMph,
          windDirOut: away.windDirOut, gameDate: analysisDateIso,
        }),
        // FASE 1 — matchup pitch-by-pitch para refinar NRFI/YRFI top-4
        (sharedGamePk && !disableMatchup)
          ? computeMatchupSignal(sharedGamePk, currentSeason).catch(() => null)
          : Promise.resolve(null),
      ]);

      // BOOST signals — Fase 2 backtest 10 jul (n=522).
      // Llamadas paralelas a servicios internos (usan cache) para detectar señales
      // ganadoras que suben hit rate del F5_ML PREMIUM. NO afecta filtros; solo
      // agrega badges al finalRecommendation.
      // homeProbPitcher (pitcher DEL HOME team) = away.opposingPitcherId (el que enfrenta el AWAY lineup)
      // awayProbPitcher (pitcher DEL AWAY team) = home.opposingPitcherId
      const homeProbPid = away.opposingPitcherId as number | undefined;
      const awayProbPid = home.opposingPitcherId as number | undefined;
      let boostSignalsInput:
        | { home: Array<{ type: any; label: string }>; away: Array<{ type: any; label: string }> }
        | undefined = undefined;
      try {
        const gameDateIso = analysisDateIso;
        const [{ getPitcherRecentCombined }, { analyzePitcherVsTeamMatchup }, { getTeamSos }, { getPitcherQualityMap }] = await Promise.all([
          import("./mlb-pitcher-recent"),
          import("./mlb-pitcher-vs-team"),
          import("./mlb-sos"),
          import("./mlb-statcast-quality"),
        ]);
        const [recent, pvt, sosHome, sosAway, qualityMap] = await Promise.all([
          (homeProbPid || awayProbPid)
            ? getPitcherRecentCombined(homeProbPid ?? null, "?", awayProbPid ?? null, "?", gameDateIso).catch(() => null)
            : Promise.resolve(null),
          (homeProbPid && awayProbPid)
            ? analyzePitcherVsTeamMatchup(
                home.teamId, home.teamName || "", homeProbPid, "?",
                away.teamId, away.teamName || "", awayProbPid, "?"
              ).catch(() => null)
            : Promise.resolve(null),
          getTeamSos(home.teamId, home.teamName || "").catch(() => null),
          getTeamSos(away.teamId, away.teamName || "").catch(() => null),
          getPitcherQualityMap().catch(() => ({} as Record<number, any>)),
        ]);

        // Construir boost signals para cada lado del pick
        // Cuando pick=HOME: rival pitcher es awayProbPid, se evalúan sus stats
        // Cuando pick=AWAY: rival pitcher es homeProbPid, se evalúan sus stats
        const buildBoosts = (pickSide: "HOME" | "AWAY"): Array<{ type: any; label: string }> => {
          const boosts: Array<{ type: any; label: string }> = [];
          const rivalRecent = pickSide === "HOME" ? recent?.away : recent?.home;
          const rivalPid = pickSide === "HOME" ? awayProbPid : homeProbPid;
          const rivalPvt = pickSide === "HOME" ? pvt?.awayVsHome : pvt?.homeVsAway;
          const sosPick = pickSide === "HOME" ? sosHome : sosAway;
          const rivalQual = rivalPid ? qualityMap[rivalPid] : null;

          // BOOST 1: IMPLOSION — rival pitcher en últimas 5 aperturas muy malas
          if (rivalRecent?.trend === "IMPLOSION") {
            boosts.push({ type: "IMPLOSION", label: `Rival IMPLOSION (ERA ${rivalRecent.recentEra?.toFixed(2)})` });
          }
          // BOOST 2: ERA_DECLINE — rival empeorando (recent > season)
          if (rivalRecent?.recencyEraDelta && rivalRecent.recencyEraDelta >= 0.3) {
            boosts.push({ type: "ERA_DECLINE", label: `Rival ERA +${rivalRecent.recencyEraDelta.toFixed(2)} recent` });
          }
          // BOOST 3: QUALITY_BAD — Statcast xERA malo (>=5)
          if (rivalQual?.xera && rivalQual.xera >= 5) {
            boosts.push({ type: "QUALITY_BAD", label: `Rival xERA=${rivalQual.xera.toFixed(2)} elite malo` });
          }
          // BOOST 4: H2H_STRUGGLE — rival sufre H2H vs equipo pick
          if (rivalPvt && rivalPvt.significantSample && rivalPvt.era !== null && rivalPvt.era >= 5) {
            boosts.push({ type: "H2H_STRUGGLE", label: `Rival ERA H2H=${rivalPvt.era.toFixed(2)} (${rivalPvt.totalStarts} starts)` });
          }
          // BOOST 5: SOS_INFLATED — pick team viene de calendario duro
          if (sosPick?.tier === "INFLATED") {
            boosts.push({ type: "SOS_INFLATED", label: `Ofensiva reprimida (SOS INFLATED)` });
          }
          return boosts;
        };

        boostSignalsInput = {
          home: buildBoosts("HOME"),
          away: buildBoosts("AWAY"),
        };
      } catch (err) {
        // Boost signals opcionales — si fallan, el flujo continúa sin ellos
        boostSignalsInput = undefined;
      }

      const markets = computeEarlyMarkets({
        homeEre, awayEre,
        f5OverLine: lines?.f5OverLine,
        f5OverOddsAmerican: lines?.f5OverOdds,
        f5UnderOddsAmerican: lines?.f5UnderOdds,
        f5HomeMlOddsAmerican: lines?.f5HomeMlOdds,
        f5AwayMlOddsAmerican: lines?.f5AwayMlOdds,
        nrfiOddsAmerican: lines?.nrfiOdds,
        yrfiOddsAmerican: lines?.yrfiOdds,
        matchupSignal: matchupSignal ?? undefined,
        boostSignals: boostSignalsInput,
      });

      // F5 unificado: ERE core + capas internas (pitcher form, umpire)
      // El frontend pasa opcionalmente homePitcherForm/awayPitcherForm/umpire.
      const f5Unified = computeF5Unified({
        homeEre, awayEre,
        homePitcherForm: req.body?.homePitcherForm as PitcherRecentForm | undefined,
        awayPitcherForm: req.body?.awayPitcherForm as PitcherRecentForm | undefined,
        umpire: req.body?.umpire as UmpireData | undefined,
        // FASE 1 — matchup pitch-by-pitch signal (lineup completo vs SP arsenal)
        matchupSignal: matchupSignal ? {
          homeLineupAvgXwoba: matchupSignal.homeLineupAvgXwoba,
          awayLineupAvgXwoba: matchupSignal.awayLineupAvgXwoba,
          dataConfidence: matchupSignal.dataConfidence,
        } : undefined,
      });

      // Uncertainty assessment (overlay informativo, no afecta predicción)
      const uncertainty = await computeUncertainty(
        home.teamId,
        away.teamId,
        homeEre,
        awayEre,
        matchupSignal,
      ).catch(() => null);

      res.json({ success: true, data: { homeEre, awayEre, markets, f5Unified, matchupSignal: matchupSignal ?? null, matchupDisabled: disableMatchup, uncertainty: uncertainty ?? null } });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // ── Early Run Environment (ERE) MLB v3 ──────────────────────
  // Composite 0-100 score con 16 variables (8 offense + 8 pitcher)
  // GET /api/mlb/ere/:teamId?name=X&gamePk=Y&pitcherId=Z&hand=R&venue=X&tempF=Y&windMph=Z&windOut=true

  // ── Rotowire daily lineups (FUENTE 2) ────────────────────────────────────
  app.get("/api/mlb/rotowire/lineup/:gamePk", async (req, res) => {
    try {
      const gamePk = parseInt(req.params.gamePk, 10);
      if (isNaN(gamePk)) return res.status(400).json({ success: false, error: "gamePk inválido" });
      const { getRotowireLineupForGame } = await import("./mlb-rotowire-lineups.js");
      const data = await getRotowireLineupForGame(gamePk);
      if (!data) return res.json({ success: true, data: null, error: "No lineup en Rotowire para ese gamePk" });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/mlb/rotowire/all", async (_req, res) => {
    try {
      const { fetchAllRotowireGames } = await import("./mlb-rotowire-lineups.js");
      const games = await fetchAllRotowireGames();
      res.json({ success: true, data: games, count: games.length });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  app.get("/api/mlb/ere/:teamId", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId, 10);
      if (isNaN(teamId)) return res.status(400).json({ success: false, error: "teamId inválido" });
      const teamName = String(req.query.name || "");
      const gamePk = req.query.gamePk ? parseInt(String(req.query.gamePk), 10) : undefined;
      const opposingPitcherId = req.query.pitcherId ? parseInt(String(req.query.pitcherId), 10) : undefined;
      const handStr = String(req.query.hand || "").toUpperCase();
      const opposingPitcherHand: "R" | "L" | undefined = handStr === "R" || handStr === "L" ? (handStr as "R" | "L") : undefined;
      const venue = req.query.venue ? String(req.query.venue) : undefined;
      const tempF = req.query.tempF ? parseFloat(String(req.query.tempF)) : undefined;
      const windMph = req.query.windMph ? parseFloat(String(req.query.windMph)) : undefined;
      const windDirOut = String(req.query.windOut || "false").toLowerCase() === "true";
      const gameDate = await resolveMlbAnalysisDate(req.query.date, gamePk);

      const data = await computeMlbEre({
        teamId, teamName,
        gamePk: isNaN(gamePk as any) ? undefined : gamePk,
        opposingPitcherId: isNaN(opposingPitcherId as any) ? undefined : opposingPitcherId,
        opposingPitcherHand,
        venue,
        tempF: isNaN(tempF as any) ? undefined : tempF,
        windMph: isNaN(windMph as any) ? undefined : windMph,
        windDirOut,
        gameDate,
      });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

  // ── Team Early Scoring Index (TESI v2) MLB ──────────────────────
  // GET /api/mlb/tesi/:teamId?name=X&gamePk=Y&pitcherId=Z&hand=R
  app.get("/api/mlb/tesi/:teamId", async (req, res) => {
    try {
      const teamId = parseInt(req.params.teamId, 10);
      if (isNaN(teamId)) return res.status(400).json({ success: false, error: "teamId inválido" });
      const teamName = String(req.query.name || "");
      const gamePk = req.query.gamePk ? parseInt(String(req.query.gamePk), 10) : undefined;
      const opposingPitcherId = req.query.pitcherId ? parseInt(String(req.query.pitcherId), 10) : undefined;
      const handStr = String(req.query.hand || "").toUpperCase();
      const opposingPitcherHand: "R" | "L" | undefined = handStr === "R" || handStr === "L" ? (handStr as "R" | "L") : undefined;
      const gameDate = await resolveMlbAnalysisDate(req.query.date, gamePk);

      const data = await computeMlbTesi({
        teamId, teamName, gamePk: isNaN(gamePk as any) ? undefined : gamePk,
        opposingPitcherId: isNaN(opposingPitcherId as any) ? undefined : opposingPitcherId,
        opposingPitcherHand,
        gameDate,
      });
      res.json({ success: true, data });
    } catch (e: any) {
      res.status(500).json({ success: false, error: String(e?.message || e) });
    }
  });

}
