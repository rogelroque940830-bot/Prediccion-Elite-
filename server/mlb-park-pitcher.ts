// Park-Pitcher Splits System (MLB)
// Calcula cómo le va a CADA pitcher en CADA estadio específico (últimos 2 años)
// Las casas usan park factor general — no park-pitcher granular. Aquí está nuestro edge.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";

export type ParkBucket = "PITCHER" | "NEUTRAL" | "HITTER";
export type ParkDataSource = "DIRECT" | "BUCKET_PROXY" | "NONE";

export interface ParkPitcherSplit {
  pitcherId: number;
  pitcherName: string;
  venueId: number;
  venueName: string;
  venueTeamId: number;     // team que juega en este estadio
  venueTeamName: string;
  // Stats acumulados en este parque
  starts: number;
  totalIP: number;
  totalER: number;
  totalHR: number;
  totalK: number;
  totalBB: number;
  era: number;             // ERA en este parque (o proxy del bucket)
  whip: number;
  hr9: number;
  k9: number;
  // Comparación con season ERA general
  seasonEra: number;
  eraDelta: number;        // negativo = mejor, positivo = peor
  significantSample: boolean;
  signal: string;
  // Nuevo: trazabilidad de la fuente
  dataSource: ParkDataSource;
  bucket: ParkBucket;
  bucketStarts?: number;   // cuando dataSource=BUCKET_PROXY
}

// Clasificación de estadios por arquetipo (Park Factor 3 años, Baseball Savant/FanGraphs)
// PITCHER: PF <96 (suprime ofensiva). NEUTRAL: 96-104. HITTER: >104.
const VENUE_BUCKET: Record<number, ParkBucket> = {
  // PITCHER-friendly
  3289: "PITCHER",   // Citi Field (NYM)
  2680: "PITCHER",   // Petco Park (SD)
  2395: "PITCHER",   // Oracle Park (SF)
  680:  "PITCHER",   // T-Mobile Park (SEA)
  4169: "PITCHER",   // loanDepot park (MIA)
  2394: "PITCHER",   // Comerica Park (DET)
  12:   "PITCHER",   // Steinbrenner Field (TB '25)
  10:   "PITCHER",   // Sutter Health (OAK)
  // NEUTRAL
  22:   "NEUTRAL",   // Dodger Stadium
  17:   "NEUTRAL",   // Wrigley Field
  31:   "NEUTRAL",   // PNC Park
  4705: "NEUTRAL",   // Truist Park
  2681: "NEUTRAL",   // Citizens Bank Park
  3312: "NEUTRAL",   // Target Field
  32:   "NEUTRAL",   // Busch / American Family
  3309: "NEUTRAL",   // Nationals Park
  5:    "NEUTRAL",   // Progressive Field
  1:    "NEUTRAL",   // Angel Stadium
  15:   "NEUTRAL",   // Chase Field
  4:    "NEUTRAL",   // Guaranteed Rate Field
  7:    "NEUTRAL",   // Kauffman Stadium
  2392: "NEUTRAL",   // Daikin Park (HOU)
  // HITTER-friendly
  19:   "HITTER",    // Coors Field (COL)
  2602: "HITTER",    // Great American Ball Park (CIN)
  3:    "HITTER",    // Fenway Park (BOS)
  13:   "HITTER",    // Globe Life Field (TEX)
  3313: "HITTER",    // Yankee Stadium
  2:    "HITTER",    // Camden Yards (BAL)
  14:   "HITTER",    // Rogers Centre (TOR)
};

function getBucket(venueId: number): ParkBucket {
  return VENUE_BUCKET[venueId] ?? "NEUTRAL";
}

// Mapeo de venue ID a teamId (necesario para mapear opponent.team → venue cuando isHome=false)
const VENUE_BY_TEAM: Record<number, { venueId: number; venueName: string }> = {
  108: { venueId: 1,  venueName: "Angel Stadium" },
  109: { venueId: 15, venueName: "Chase Field" },
  110: { venueId: 2,  venueName: "Oriole Park at Camden Yards" },
  111: { venueId: 3,  venueName: "Fenway Park" },
  112: { venueId: 17, venueName: "Wrigley Field" },
  113: { venueId: 2602, venueName: "Great American Ball Park" },
  114: { venueId: 5,  venueName: "Progressive Field" },
  115: { venueId: 19, venueName: "Coors Field" },
  116: { venueId: 2394, venueName: "Comerica Park" },
  117: { venueId: 2392, venueName: "Daikin Park" },
  118: { venueId: 7,  venueName: "Kauffman Stadium" },
  119: { venueId: 22, venueName: "Dodger Stadium" },
  121: { venueId: 3289, venueName: "Citi Field" },
  133: { venueId: 10, venueName: "Sutter Health Park" }, // Athletics in Sacramento
  134: { venueId: 31, venueName: "PNC Park" },
  135: { venueId: 2680, venueName: "Petco Park" },
  136: { venueId: 680, venueName: "T-Mobile Park" },
  137: { venueId: 2395, venueName: "Oracle Park" },
  138: { venueId: 32, venueName: "Busch Stadium" },
  139: { venueId: 12, venueName: "George M. Steinbrenner Field" }, // Rays at Steinbrenner 2025
  140: { venueId: 13, venueName: "Globe Life Field" },
  141: { venueId: 14, venueName: "Rogers Centre" },
  142: { venueId: 3312, venueName: "Target Field" },
  143: { venueId: 2681, venueName: "Citizens Bank Park" },
  144: { venueId: 4705, venueName: "Truist Park" },
  145: { venueId: 4, venueName: "Guaranteed Rate Field" },
  146: { venueId: 4169, venueName: "loanDepot park" },
  147: { venueId: 3313, venueName: "Yankee Stadium" },
  158: { venueId: 32, venueName: "American Family Field" },
  120: { venueId: 3309, venueName: "Nationals Park" },
};

// Caches
const splitsCache: Record<string, { ts: number; data: ParkPitcherSplit | null }> = {};
const seasonStatsCache: Record<number, { ts: number; era: number; ip: number }> = {};

function parseIP(ip: string | undefined): number {
  if (!ip) return 0;
  const parts = String(ip).split(".");
  return parseInt(parts[0]) + (parseInt(parts[1] || "0") / 3);
}

async function getSeasonERA(pitcherId: number): Promise<{ era: number; ip: number }> {
  const cached = seasonStatsCache[pitcherId];
  if (cached && Date.now() - cached.ts < 6 * 3600 * 1000) return { era: cached.era, ip: cached.ip };
  try {
    let stats: any = null;
    const j2026: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=2026`)).json();
    stats = j2026.stats?.[0]?.splits?.[0]?.stat;
    if (!stats || !stats.era) {
      const j2025: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=2025`)).json();
      stats = j2025.stats?.[0]?.splits?.[0]?.stat ?? stats;
    }
    const era = parseFloat(stats?.era ?? "4.50") || 4.50;
    const ip = parseIP(stats?.inningsPitched);
    seasonStatsCache[pitcherId] = { ts: Date.now(), era, ip };
    return { era, ip };
  } catch {
    return { era: 4.50, ip: 0 };
  }
}

// Trae todos los game logs de un pitcher (últimas 3 temporadas, dinámico) y filtra por venue
async function getPitcherGameLogs(pitcherId: number): Promise<any[]> {
  const all: any[] = [];
  const yr = new Date().getFullYear();
  const seasons = [String(yr - 2), String(yr - 1), String(yr)];
  for (const season of seasons) {
    try {
      const j: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${season}`)).json();
      const splits = j.stats?.[0]?.splits ?? [];
      all.push(...splits);
    } catch {}
  }
  return all;
}

// MAIN: para un pitcher y un venue específico, agregar todos sus starts allí
export async function getParkPitcherSplit(
  pitcherId: number,
  pitcherName: string,
  venueId: number,
  venueName: string,
  venueTeamId: number,
  venueTeamName: string,
): Promise<ParkPitcherSplit | null> {
  const cacheKey = `${pitcherId}::${venueId}`;
  const cached = splitsCache[cacheKey];
  if (cached && Date.now() - cached.ts < 12 * 3600 * 1000) return cached.data;

  const [logs, season] = await Promise.all([
    getPitcherGameLogs(pitcherId),
    getSeasonERA(pitcherId),
  ]);

  // Filtrar logs donde el venue coincide
  // Si isHome=true → venue es el del equipo del pitcher (puede no coincidir con venueTeamId)
  // Si isHome=false → venue es el del opponent
  // Para nuestro caso: estamos analizando "este pitcher en venue X". Como no tenemos venueId directo,
  // usamos: cuando opponent.id === venueTeamId Y isHome=false, ese es un start en venueX
  // Y cuando team.id === venueTeamId Y isHome=true, ese también
  const filtered = logs.filter((s: any) => {
    const oppId = s.opponent?.id;
    const ownTeamId = s.team?.id;
    const isHome = s.isHome === true;
    if (!isHome && oppId === venueTeamId) return true;
    if (isHome && ownTeamId === venueTeamId) return true;
    return false;
  });

  const bucket = getBucket(venueId);

  // ── PROXY POR ARQUETIPO: si no hay starts directos en este parque,
  // buscar starts en parques del MISMO bucket (PITCHER/NEUTRAL/HITTER)
  if (filtered.length < 3) {
    const sameBucketLogs = logs.filter((s: any) => {
      const oppId = s.opponent?.id;
      const ownTeamId = s.team?.id;
      const isHome = s.isHome === true;
      const otherTeamId = isHome ? ownTeamId : oppId;
      if (!otherTeamId) return false;
      const otherVenue = VENUE_BY_TEAM[otherTeamId];
      if (!otherVenue) return false;
      if (otherVenue.venueId === venueId) return false; // excluir el venue exacto (ya está en filtered)
      return getBucket(otherVenue.venueId) === bucket;
    });

    if (filtered.length === 0 && sameBucketLogs.length < 3) {
      // Ni directo ni proxy suficiente
      splitsCache[cacheKey] = { ts: Date.now(), data: null };
      return null;
    }

    if (filtered.length < 3 && sameBucketLogs.length >= 3) {
      // Construir proxy a partir del bucket
      let pIP = 0, pER = 0, pHR = 0, pK = 0, pBB = 0, pH = 0;
      for (const s of sameBucketLogs) {
        const st = s.stat ?? {};
        pIP += parseIP(st.inningsPitched);
        pER += parseInt(st.earnedRuns ?? "0") || 0;
        pHR += parseInt(st.homeRuns ?? "0") || 0;
        pK += parseInt(st.strikeOuts ?? "0") || 0;
        pBB += parseInt(st.baseOnBalls ?? "0") || 0;
        pH += parseInt(st.hits ?? "0") || 0;
      }
      const pEra = pIP > 0 ? (pER * 9) / pIP : 0;
      const pWhip = pIP > 0 ? (pBB + pH) / pIP : 0;
      const pHr9 = pIP > 0 ? (pHR * 9) / pIP : 0;
      const pK9 = pIP > 0 ? (pK * 9) / pIP : 0;
      const pDelta = pEra - season.era;
      const bucketLabel = bucket === "PITCHER" ? "pitcher-friendly" : bucket === "HITTER" ? "hitter-friendly" : "neutrales";

      let proxySignal = "";
      // Confianza degradada si muestra es 3-4 starts (mínimo aceptado pero no robusto)
      const lowSample = sameBucketLogs.length < 5;
      const confLabel = lowSample ? "BAJA" : "MEDIA";
      if (Math.abs(pDelta) >= 0.50) {
        if (pDelta < 0) {
          proxySignal = `📊 Proxy por arquetipo: ${pitcherName} en parques ${bucketLabel} (n=${sameBucketLogs.length}) → ERA ${pEra.toFixed(2)} vs season ${season.era.toFixed(2)} (${pDelta.toFixed(2)}). Sin historial directo en ${venueName} — confianza ${confLabel}.`;
        } else {
          proxySignal = `📊 Proxy por arquetipo: ${pitcherName} en parques ${bucketLabel} (n=${sameBucketLogs.length}) → ERA ${pEra.toFixed(2)} vs season ${season.era.toFixed(2)} (+${pDelta.toFixed(2)}). Sin historial directo en ${venueName} — confianza ${confLabel}.`;
        }
      } else {
        proxySignal = `📊 Proxy por arquetipo: ${pitcherName} en parques ${bucketLabel} (n=${sameBucketLogs.length}) ERA ${pEra.toFixed(2)}, similar a season ${season.era.toFixed(2)}. Sin historial directo en ${venueName} — confianza ${confLabel}.`;
      }

      const proxyResult: ParkPitcherSplit = {
        pitcherId, pitcherName, venueId, venueName, venueTeamId, venueTeamName,
        starts: sameBucketLogs.length,
        totalIP: pIP, totalER: pER, totalHR: pHR, totalK: pK, totalBB: pBB,
        era: Math.round(pEra * 100) / 100,
        whip: Math.round(pWhip * 100) / 100,
        hr9: Math.round(pHr9 * 100) / 100,
        k9: Math.round(pK9 * 100) / 100,
        seasonEra: season.era,
        eraDelta: Math.round(pDelta * 100) / 100,
        significantSample: false, // proxy = no significativo en este parque
        signal: proxySignal,
        dataSource: "BUCKET_PROXY",
        bucket,
        bucketStarts: sameBucketLogs.length,
      };
      splitsCache[cacheKey] = { ts: Date.now(), data: proxyResult };
      return proxyResult;
    }
  }

  if (filtered.length === 0) {
    splitsCache[cacheKey] = { ts: Date.now(), data: null };
    return null;
  }

  // Agregar stats
  let totalIP = 0, totalER = 0, totalHR = 0, totalK = 0, totalBB = 0, totalH = 0;
  for (const s of filtered) {
    const st = s.stat ?? {};
    totalIP += parseIP(st.inningsPitched);
    totalER += parseInt(st.earnedRuns ?? "0") || 0;
    totalHR += parseInt(st.homeRuns ?? "0") || 0;
    totalK += parseInt(st.strikeOuts ?? "0") || 0;
    totalBB += parseInt(st.baseOnBalls ?? "0") || 0;
    totalH += parseInt(st.hits ?? "0") || 0;
  }

  const era = totalIP > 0 ? (totalER * 9) / totalIP : 0;
  const whip = totalIP > 0 ? (totalBB + totalH) / totalIP : 0;
  const hr9 = totalIP > 0 ? (totalHR * 9) / totalIP : 0;
  const k9 = totalIP > 0 ? (totalK * 9) / totalIP : 0;
  const eraDelta = era - season.era;
  const significantSample = filtered.length >= 3;

  // Pisos absolutos de calidad — evita decir "domina" si el park-ERA sigue siendo malo
  // League avg ≈ 4.00 ERA. Élite: <3.20. Bueno: <3.80. Promedio: 3.80-4.40. Malo: 4.40-5.00. Pésimo: >5.00.
  const LEAGUE_AVG_ERA = 4.00;
  const ELITE_ERA = 3.20;
  const GOOD_ERA = 3.80;
  const BAD_ERA = 5.00;

  let signal = "";
  if (filtered.length < 2) {
    signal = `${pitcherName} solo tiene ${filtered.length} start en ${venueName} \u2014 muestra insuficiente`;
  } else if (filtered.length >= 5 && Math.abs(eraDelta) >= 0.80) {
    // ESCENARIO POSITIVO (eraDelta negativo = mejora en este parque)
    if (eraDelta < 0) {
      if (era <= ELITE_ERA) {
        signal = `\u2b50 ${pitcherName} DOMINA en ${venueName}: ERA \u00e9lite ${era.toFixed(2)} en ${filtered.length} starts (vs ${season.era.toFixed(2)} season)`;
      } else if (era <= GOOD_ERA) {
        signal = `\u2b50 ${pitcherName} pitchea muy bien en ${venueName}: ERA ${era.toFixed(2)} en ${filtered.length} starts (vs ${season.era.toFixed(2)} season)`;
      } else if (era <= LEAGUE_AVG_ERA + 0.40) {
        signal = `${pitcherName} mejora en ${venueName} pero sigue promedio: ERA ${era.toFixed(2)} en ${filtered.length} starts (vs ${season.era.toFixed(2)} season)`;
      } else if (era <= BAD_ERA) {
        signal = `\u26a0\ufe0f ${pitcherName} "mejora" en ${venueName} pero sigue mediocre: ERA ${era.toFixed(2)} en ${filtered.length} starts \u2014 NO es dominante`;
      } else {
        signal = `\u26a0\ufe0f ${pitcherName} mejora en ${venueName} pero sigue MUY MALO: ERA ${era.toFixed(2)} en ${filtered.length} starts \u2014 ignorar el delta`;
      }
    } else {
      // eraDelta positivo (sufre más en este parque)
      if (era >= BAD_ERA) {
        signal = `\u26d4 ${pitcherName} ES UN DESASTRE en ${venueName}: ERA ${era.toFixed(2)} en ${filtered.length} starts (+${eraDelta.toFixed(2)} vs season ${season.era.toFixed(2)})`;
      } else {
        signal = `\u26a0\ufe0f ${pitcherName} sufre en ${venueName}: ERA ${era.toFixed(2)} en ${filtered.length} starts (+${eraDelta.toFixed(2)} vs season ${season.era.toFixed(2)})`;
      }
    }
  } else if (filtered.length >= 3 && Math.abs(eraDelta) >= 0.50) {
    const tag = era <= GOOD_ERA ? "\u2728" : era >= BAD_ERA ? "\u26a0\ufe0f" : "";
    signal = `${tag} ${pitcherName} en ${venueName}: ERA ${era.toFixed(2)} (${filtered.length} starts) vs ${season.era.toFixed(2)} season (${eraDelta > 0 ? "+" : ""}${eraDelta.toFixed(2)})`.trim();
  } else {
    signal = `${pitcherName} en ${venueName}: ERA ${era.toFixed(2)} en ${filtered.length} starts (similar a season ${season.era.toFixed(2)})`;
  }

  const result: ParkPitcherSplit = {
    pitcherId, pitcherName, venueId, venueName, venueTeamId, venueTeamName,
    starts: filtered.length,
    totalIP, totalER, totalHR, totalK, totalBB,
    era: Math.round(era * 100) / 100,
    whip: Math.round(whip * 100) / 100,
    hr9: Math.round(hr9 * 100) / 100,
    k9: Math.round(k9 * 100) / 100,
    seasonEra: season.era,
    eraDelta: Math.round(eraDelta * 100) / 100,
    significantSample,
    signal,
    dataSource: "DIRECT",
    bucket,
  };

  splitsCache[cacheKey] = { ts: Date.now(), data: result };
  return result;
}

// Helper: para un partido, devuelve los splits de ambos pitchers en el venue del partido
export async function analyzeParkPitcherMatchup(
  homeTeamId: number,
  homeTeamName: string,
  homePitcherId: number | undefined,
  homePitcherName: string,
  awayPitcherId: number | undefined,
  awayPitcherName: string,
): Promise<{ homeSplit: ParkPitcherSplit | null; awaySplit: ParkPitcherSplit | null; venueName: string }> {
  const venue = VENUE_BY_TEAM[homeTeamId];
  if (!venue) {
    return { homeSplit: null, awaySplit: null, venueName: "Unknown" };
  }
  const [homeSplit, awaySplit] = await Promise.all([
    homePitcherId ? getParkPitcherSplit(homePitcherId, homePitcherName, venue.venueId, venue.venueName, homeTeamId, homeTeamName) : Promise.resolve(null),
    awayPitcherId ? getParkPitcherSplit(awayPitcherId, awayPitcherName, venue.venueId, venue.venueName, homeTeamId, homeTeamName) : Promise.resolve(null),
  ]);
  return { homeSplit, awaySplit, venueName: venue.venueName };
}
