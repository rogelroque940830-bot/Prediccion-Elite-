// ── MLB Matchup Signal ─────────────────────────────────────────────────────
// Convierte el output pitch-by-pitch de mlb-statcast-matchup.ts en señales
// agregadas que pueden alimentar predicciones (NRFI/YRFI, F5, ERE).
//
// FASE 1: solo expone top-4 expected xwOBA vs arsenal SP rival (para NRFI/YRFI).
// FASES futuras: añadir fullGame, f5, top-3 inning 1-2-3.
//
// Si el matchup módulo devuelve PARTIAL/LOW, la señal sigue sirviendo pero el
// caller debería atenuar su peso (la confianza se propaga via dataConfidence).
// ───────────────────────────────────────────────────────────────────────────

import { getStatcastMatchupCombined } from "./mlb-statcast-matchup.js";

const MLB_BASE_V11 = "https://statsapi.mlb.com/api/v1.1";

// Lightweight version of routes.ts getGameMeta: fetch feed/live para obtener
// probable pitchers + team IDs + abbreviations. Necesario porque getGameMeta
// es un closure local en routes.ts (no exportado).
async function fetchGameMetaLite(gamePk: number): Promise<any | null> {
  try {
    const r = await fetch(`${MLB_BASE_V11}/game/${gamePk}/feed/live`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const gd = j.gameData;
    if (!gd) return null;
    const homeTeam = gd.teams?.home || {};
    const awayTeam = gd.teams?.away || {};
    const probHome = gd.probablePitchers?.home;
    const probAway = gd.probablePitchers?.away;
    const enrich = (p: any) => {
      if (!p?.id) return undefined;
      const full = gd.players?.[`ID${p.id}`];
      return { id: p.id, fullName: full?.fullName ?? p.fullName };
    };
    return {
      teams: {
        home: { team: homeTeam, probablePitcher: enrich(probHome) },
        away: { team: awayTeam, probablePitcher: enrich(probAway) },
      },
    };
  } catch {
    return null;
  }
}

export interface MatchupSignal {
  // Top-4 bateadores HOME vs arsenal del SP AWAY (esperado xwOBA en 1er inning)
  homeTop4ExpectedXwoba: number | null;
  // Top-4 bateadores AWAY vs arsenal del SP HOME
  awayTop4ExpectedXwoba: number | null;
  // Full lineup HOME vs arsenal del SP AWAY (para F5/full game — todos los bateadores)
  homeLineupAvgXwoba: number | null;
  // Full lineup AWAY vs arsenal del SP HOME
  awayLineupAvgXwoba: number | null;
  // Confianza mínima de los dos lados (NONE/LOW/PARTIAL/FULL)
  dataConfidence: "FULL" | "PARTIAL" | "LOW" | "NONE";
  // Razón debug
  reason?: string;
}

const SLOT_WEIGHTS = [1.15, 1.10, 1.05, 1.00]; // mismo weighting que top4LineupWoba

function aggregateTop4(side: any): number | null {
  if (!side || !Array.isArray(side.perBatter) || side.perBatter.length === 0) return null;
  // perBatter ya viene ordenado por slot 1..N
  const top4 = side.perBatter.slice(0, 4);
  if (top4.length === 0) return null;
  let sum = 0, weightSum = 0;
  top4.forEach((b: any, i: number) => {
    // Buscar el campo de xwOBA esperado (los nombres pueden variar)
    const xw = b.expectedXwoba ?? b.expectedXwOBA ?? b.xwobaExpected ?? null;
    if (xw === null || xw === undefined || !isFinite(xw)) return;
    const w = SLOT_WEIGHTS[i] ?? 1.0;
    sum += xw * w;
    weightSum += w;
  });
  return weightSum > 0 ? sum / weightSum : null;
}

function confidenceRank(c: string | undefined): number {
  const order = ["NONE", "LOW", "PARTIAL", "FULL"];
  const idx = order.indexOf((c || "NONE").toUpperCase());
  return idx >= 0 ? idx : 0;
}

export async function computeMatchupSignal(
  gamePk: number,
  season: number,
): Promise<MatchupSignal> {
  try {
    // Metadata del juego: probable pitchers + team IDs + abbreviations
    const game: any = await fetchGameMetaLite(gamePk);
    if (!game || !game.teams?.home || !game.teams?.away) {
      return { homeTop4ExpectedXwoba: null, awayTop4ExpectedXwoba: null, dataConfidence: "NONE", reason: "game meta missing" };
    }
    const homeT = game.teams.home;
    const awayT = game.teams.away;
    const homePitcherId = homeT.probablePitcher?.id ?? 0;
    const awayPitcherId = awayT.probablePitcher?.id ?? 0;
    if (!homePitcherId && !awayPitcherId) {
      return { homeTop4ExpectedXwoba: null, awayTop4ExpectedXwoba: null, dataConfidence: "NONE", reason: "no probable pitchers" };
    }

    const combined: any = await getStatcastMatchupCombined(
      gamePk,
      homeT.team.id, awayT.team.id,
      homePitcherId, homeT.probablePitcher?.fullName ?? "",
      awayPitcherId, awayT.probablePitcher?.fullName ?? "",
      homeT.team.abbreviation ?? "", awayT.team.abbreviation ?? "",
      season,
    );
    if (!combined) {
      return { homeTop4ExpectedXwoba: null, awayTop4ExpectedXwoba: null, dataConfidence: "NONE", reason: "combined null" };
    }

    const homeSide = combined.homeLineupVsAwaySP ?? null;
    const awaySide = combined.awayLineupVsHomeSP ?? null;

    const homeTop4Xw = aggregateTop4(homeSide);
    const awayTop4Xw = aggregateTop4(awaySide);
    // Full lineup xwOBA: el matchup module ya provee averageExpectedXwoba
    const homeLineupXw = (homeSide?.averageExpectedXwoba && isFinite(homeSide.averageExpectedXwoba)) ? homeSide.averageExpectedXwoba : null;
    const awayLineupXw = (awaySide?.averageExpectedXwoba && isFinite(awaySide.averageExpectedXwoba)) ? awaySide.averageExpectedXwoba : null;

    // Confianza = mínimo de ambos lados
    const hRank = confidenceRank(homeSide?.dataConfidence);
    const aRank = confidenceRank(awaySide?.dataConfidence);
    const minRank = Math.min(hRank, aRank);
    const order = ["NONE", "LOW", "PARTIAL", "FULL"] as const;
    const dataConfidence = order[minRank];

    return {
      homeTop4ExpectedXwoba: homeTop4Xw,
      awayTop4ExpectedXwoba: awayTop4Xw,
      homeLineupAvgXwoba: homeLineupXw,
      awayLineupAvgXwoba: awayLineupXw,
      dataConfidence,
      reason: dataConfidence === "NONE" ? `home=${homeSide?.signal} away=${awaySide?.signal}` : undefined,
    };
  } catch (e: any) {
    return {
      homeTop4ExpectedXwoba: null,
      awayTop4ExpectedXwoba: null,
      homeLineupAvgXwoba: null,
      awayLineupAvgXwoba: null,
      dataConfidence: "NONE",
      reason: `error: ${String(e?.message || e).slice(0, 100)}`,
    };
  }
}
