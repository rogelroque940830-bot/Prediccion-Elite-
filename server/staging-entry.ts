import express from "express";
import { app } from "./index";

type Confidence = "FULL" | "PARTIAL" | "LOW" | "UNKNOWN";
type AnalysisStage = "PROVISIONAL" | "FINAL";

interface SourceSummary {
  home: string;
  away: string;
}

interface CountSummary {
  direct: number;
  proxy: number;
}

const deployedCommit =
  process.env.RAILWAY_GIT_COMMIT_SHA ??
  process.env.GIT_COMMIT_SHA ??
  "unknown";

function normalizeConfidence(value: unknown): Confidence {
  return value === "FULL" || value === "PARTIAL" || value === "LOW"
    ? value
    : "UNKNOWN";
}

function lowestConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = {
    FULL: 3,
    PARTIAL: 2,
    LOW: 1,
    UNKNOWN: 0,
  };
  return rank[a] <= rank[b] ? a : b;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildStatcastStatus(body: any) {
  const home = body?.homeLineupVsAwaySP ?? {};
  const away = body?.awayLineupVsHomeSP ?? {};
  const sources: SourceSummary = {
    home: home.lineupSource ?? "UNKNOWN",
    away: away.lineupSource ?? "UNKNOWN",
  };
  const bothConfirmed = sources.home === "CONFIRMED" && sources.away === "CONFIRMED";
  const stage: AnalysisStage = bothConfirmed ? "FINAL" : "PROVISIONAL";
  const homeConfidence = normalizeConfidence(home.dataConfidence);
  const awayConfidence = normalizeConfidence(away.dataConfidence);

  return {
    stage,
    calculationsApplied: true,
    lineupsConfirmed: bothConfirmed,
    lineupSources: sources,
    dataConfidence: lowestConfidence(homeConfidence, awayConfidence),
    directVsProxy: {
      home: {
        direct: asCount(home.directCount),
        proxy: asCount(home.proxyCount),
      } satisfies CountSummary,
      away: {
        direct: asCount(away.directCount),
        proxy: asCount(away.proxyCount),
      } satisfies CountSummary,
    },
    requiresRecalculation: !bothConfirmed,
    note: bothConfirmed
      ? "Lineups oficiales confirmados. Lectura final disponible."
      : "Lectura temprana con lineups proyectados. Los cálculos se conservan y deben recalcularse cuando MLB publique ambos lineups oficiales.",
  };
}

function buildLineupStatus(body: any) {
  const homeConfirmed = body?.homeLineup?.confirmed === true;
  const awayConfirmed = body?.awayLineup?.confirmed === true;
  const bothConfirmed = homeConfirmed && awayConfirmed;
  const stage: AnalysisStage = bothConfirmed ? "FINAL" : "PROVISIONAL";

  return {
    stage,
    calculationsApplied: true,
    lineupsConfirmed: bothConfirmed,
    lineupSources: {
      home: homeConfirmed ? "CONFIRMED" : "PROJECTED",
      away: awayConfirmed ? "CONFIRMED" : "PROJECTED",
    },
    dataConfidence: bothConfirmed ? "FULL" : "PARTIAL",
    requiresRecalculation: !bothConfirmed,
    note: bothConfirmed
      ? "Lineups oficiales confirmados. Lectura final disponible."
      : "Lectura temprana para anticipar el juego. Se mantiene el cálculo proyectado hasta que estén disponibles los lineups oficiales.",
  };
}

function buildCatcherStatus(body: any) {
  const bothConfirmed = body?.bothLineupsConfirmed === true;
  const stage: AnalysisStage = bothConfirmed ? "FINAL" : "PROVISIONAL";

  return {
    stage,
    calculationsApplied: true,
    lineupsConfirmed: bothConfirmed,
    catcherSources: {
      home: body?.homeCatcher?.source ?? "UNKNOWN",
      away: body?.awayCatcher?.source ?? "UNKNOWN",
    },
    dataConfidence: bothConfirmed ? "FULL" : "PARTIAL",
    requiresRecalculation: !bothConfirmed,
    note: bothConfirmed
      ? "Catchers confirmados. El impacto de framing corresponde a la lectura final."
      : "Catchers proyectados. El impacto se conserva como escenario temprano y debe verificarse cuando se confirmen los lineups.",
  };
}

function addAnalysisStatus(path: string, body: any): any {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.analysisStatus) {
    return body;
  }

  if (/^\/api\/mlb\/statcast-matchup\/\d+$/.test(path)) {
    return { ...body, analysisStatus: buildStatcastStatus(body) };
  }

  if (/^\/api\/mlb\/lineup-matchup\/\d+$/.test(path)) {
    return { ...body, analysisStatus: buildLineupStatus(body) };
  }

  if (/^\/api\/mlb\/catcher-framing\/\d+$/.test(path)) {
    return { ...body, analysisStatus: buildCatcherStatus(body) };
  }

  return body;
}

const responsePrototype = express.response as any;
const originalJson = responsePrototype.json;

responsePrototype.json = function stagingJson(body: any) {
  const requestPath = this.req?.path ?? "";
  this.setHeader?.("X-Staging-Commit", deployedCommit);
  return originalJson.call(this, addAnalysisStatus(requestPath, body));
};

// Endpoint exclusivo de staging. Reutiliza exactamente el objeto weather ya
// calculado por /api/mlb/all para evitar dos implementaciones divergentes.
app.get("/api/mlb/weather/:gamePk", async (req, res) => {
  const gamePk = Number(req.params.gamePk);
  if (!Number.isInteger(gamePk) || gamePk <= 0) {
    return res.status(400).json({ success: false, error: "Invalid gamePk" });
  }

  const date = typeof req.query.date === "string" ? req.query.date.trim() : "";
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  const selfUrl = `http://127.0.0.1:${process.env.PORT || 5000}`;

  try {
    const upstream = await fetch(`${selfUrl}/api/mlb/all${query}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
    const text = await upstream.text();
    let payload: any;

    try {
      payload = JSON.parse(text);
    } catch {
      return res.status(502).json({
        success: false,
        error: "MLB all endpoint returned non-JSON content",
      });
    }

    if (!upstream.ok || payload?.success !== true) {
      return res.status(502).json({
        success: false,
        error: "Unable to load MLB game weather",
        upstreamStatus: upstream.status,
      });
    }

    const games = Array.isArray(payload.games) ? payload.games : [];
    const game = games.find(
      (candidate: any) => Number(candidate?.gamePk ?? candidate?.gameId) === gamePk,
    );

    if (!game) {
      return res.status(404).json({
        success: false,
        error: "Game not found in requested MLB slate",
        gamePk,
        date: date || null,
        hint: "Use ?date=YYYY-MM-DD when requesting a game outside today's slate.",
      });
    }

    if (!game.weather || typeof game.weather !== "object") {
      return res.status(404).json({
        success: false,
        error: "Weather not available for this game",
        gamePk,
      });
    }

    return res.json({
      success: true,
      gamePk,
      date: date || null,
      gameTime: game.gameTime ?? game.gameDate ?? null,
      venue: game.venue ?? null,
      homeTeam: game.homeTeam ?? null,
      awayTeam: game.awayTeam ?? null,
      weather: game.weather,
      source: "/api/mlb/all",
      note: "Mismos datos meteorológicos usados por el predictor principal.",
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error?.message || "Weather endpoint failed",
    });
  }
});