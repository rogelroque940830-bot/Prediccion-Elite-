import express from "express";
import "./index";

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
  return originalJson.call(this, addAnalysisStatus(requestPath, body));
};
