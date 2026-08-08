// SOS — Strength of Schedule del bateo reciente
// Para cada equipo, mira sus últimos 10 juegos y calcula la calidad PROMEDIO
// del pitcheo enfrentado (SP ERA + bullpen ERA del rival).
// Detecta rachas falsas: equipo .800 OPS vs Rockies/White Sox → inflado.
// Detecta rachas reales: equipo .700 OPS vs Dodgers/Mets → real.

const MLB_BASE = "https://statsapi.mlb.com/api/v1";
const LEAGUE_AVG_ERA = 4.20;       // ERA promedio MLB (referencia)
const LEAGUE_AVG_BP_ERA = 4.15;    // bullpen ERA promedio MLB

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface CacheEntry<T> { ts: number; data: T; }
const CACHE_TTL = 60 * 60 * 1000; // 1h
const cache: Record<string, CacheEntry<TeamSos | null>> = {};

export const MLB_SOS_EVIDENCE_SCHEMA = "courtedge-mlb-sos-evidence.v1" as const;

export interface SosRuntime {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface TeamSos {
  teamId: number;
  teamName: string;
  games: number;
  avgSpEraFaced: number;          // ERA promedio del SP rival enfrentado
  avgBullpenEraFaced: number;     // ERA promedio del bullpen rival enfrentado
  combinedEraFaced: number;       // promedio ponderado (60% SP, 40% bullpen)
  leagueDelta: number;            // combinedEra - liga; negativo = enfrentó pitcheo TOP
  sosFactor: number;              // multiplicador para corregir RPG/wOBA reciente
  recentRpg: number;
  adjustedRpg: number;            // recentRpg × sosFactor
  tier: "INFLATED" | "REAL" | "DEFLATED";
  signal: string;
}

export interface SosEvidenceProvenance {
  schemaVersion: typeof MLB_SOS_EVIDENCE_SCHEMA;
  status: "CERTIFIED";
  generatedAt: string;
  sampleStatus: "AVAILABLE" | "INSUFFICIENT_GAMES";
  selectedFinalGames: number;
  pitcherErasVerified: number;
  opponentStaffErasVerified: number;
  uniqueOpponents: number;
  cacheMaxAgeSeconds: 3600;
  cacheHit: boolean;
  cacheAgeSeconds: number;
  failureDisposition: "THROW_FAIL_CLOSED";
}

export interface TeamSosCertifiedSnapshot {
  sourceStatus: "CERTIFIED";
  generatedAt: string;
  teamSos: TeamSos | null;
  provenance: SosEvidenceProvenance;
}

interface CertifiedSosCacheValue {
  teamSos: TeamSos | null;
  sampleStatus: SosEvidenceProvenance["sampleStatus"];
  selectedFinalGames: number;
  pitcherErasVerified: number;
  opponentStaffErasVerified: number;
  uniqueOpponents: number;
}

const certifiedCache: Record<string, CacheEntry<CertifiedSosCacheValue>> = {};

function runtimeNow(runtime: SosRuntime): Date {
  return runtime.now ? runtime.now() : new Date();
}

function runtimeFetch(runtime: SosRuntime): FetchLike {
  return runtime.fetchImpl ?? ((input, init) => fetch(input, init));
}

async function fetchTeamSchedule(teamId: number): Promise<any[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 días
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const url = `${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startStr}&endDate=${endStr}&hydrate=probablePitcher,linescore`;
  try {
    const j: any = await (await fetch(url)).json();
    const games: any[] = [];
    for (const d of j.dates ?? []) {
      for (const g of d.games ?? []) {
        if (g.status?.abstractGameState === "Final") games.push(g);
      }
    }
    return games.slice(-15); // últimos 15 finales (filtraremos a 10)
  } catch (e) {
    return [];
  }
}

async function fetchPitcherSeasonEra(pitcherId: number, season: string): Promise<number | null> {
  if (!pitcherId) return null;
  try {
    const j: any = await (await fetch(`${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`)).json();
    const split = j.stats?.[0]?.splits?.[0]?.stat;
    if (!split?.era) return null;
    const era = parseFloat(split.era);
    return isNaN(era) ? null : era;
  } catch {
    return null;
  }
}

async function fetchTeamSeasonBullpenEra(teamId: number, season: string): Promise<number | null> {
  if (!teamId) return null;
  try {
    const j: any = await (await fetch(`${MLB_BASE}/teams/${teamId}/stats?season=${season}&stats=season&group=pitching&gameType=R`)).json();
    // bullpen ERA aproximada = team ERA (no hay split bullpen vs starter en API básica)
    // → usaremos team pitching ERA como proxy general del staff rival
    const split = j.stats?.[0]?.splits?.[0]?.stat;
    if (!split?.era) return null;
    const era = parseFloat(split.era);
    return isNaN(era) ? null : era;
  } catch {
    return null;
  }
}

function finalizeTeamSos(input: {
  teamId: number;
  teamName: string;
  countedGames: number;
  totalSpEra: number;
  spCount: number;
  totalBpEra: number;
  bpCount: number;
  totalRunsScored: number;
}): TeamSos | null {
  if (input.countedGames === 0 || input.spCount === 0) return null;

  const avgSpEraFaced = input.totalSpEra / input.spCount;
  const avgBullpenEraFaced = input.bpCount > 0 ? input.totalBpEra / input.bpCount : LEAGUE_AVG_BP_ERA;
  const combinedEraFaced = avgSpEraFaced * 0.60 + avgBullpenEraFaced * 0.40;
  const leagueRef = LEAGUE_AVG_ERA * 0.60 + LEAGUE_AVG_BP_ERA * 0.40;
  const leagueDelta = combinedEraFaced - leagueRef;
  const recentRpg = input.totalRunsScored / input.countedGames;

  // sosFactor: si leagueDelta > 0 → enfrentó pitcheo MALO → RPG inflado → factor <1
  //            si leagueDelta < 0 → enfrentó pitcheo BUENO → RPG deflactado → factor >1
  // Cap: ±20% adjustment. 1 ERA delta ≈ 12% adjustment.
  let sosFactor = 1.0 - (leagueDelta * 0.12);
  sosFactor = Math.max(0.80, Math.min(1.20, sosFactor));
  sosFactor = Math.round(sosFactor * 1000) / 1000;

  const adjustedRpg = Math.round(recentRpg * sosFactor * 10) / 10;

  let tier: TeamSos["tier"] = "REAL";
  let signal = "";
  if (leagueDelta >= 0.30) {
    tier = "INFLATED";
    signal = `⚠️ ${input.teamName} enfrentó pitcheo FLOJO (ERA ${combinedEraFaced.toFixed(2)} vs liga ${leagueRef.toFixed(2)}). RPG reciente ${recentRpg.toFixed(1)} probablemente inflado → ajuste ${adjustedRpg.toFixed(1)} (factor ${sosFactor}).`;
  } else if (leagueDelta <= -0.30) {
    tier = "DEFLATED";
    signal = `🔥 ${input.teamName} enfrentó pitcheo TOP (ERA ${combinedEraFaced.toFixed(2)} vs liga ${leagueRef.toFixed(2)}). RPG reciente ${recentRpg.toFixed(1)} es REAL → ajuste al alza ${adjustedRpg.toFixed(1)} (factor ${sosFactor}).`;
  } else {
    signal = `${input.teamName} enfrentó pitcheo similar a liga (ERA ${combinedEraFaced.toFixed(2)}). RPG reciente ${recentRpg.toFixed(1)} sin ajuste material.`;
  }

  return {
    teamId: input.teamId,
    teamName: input.teamName,
    games: input.countedGames,
    avgSpEraFaced: Math.round(avgSpEraFaced * 100) / 100,
    avgBullpenEraFaced: Math.round(avgBullpenEraFaced * 100) / 100,
    combinedEraFaced: Math.round(combinedEraFaced * 100) / 100,
    leagueDelta: Math.round(leagueDelta * 100) / 100,
    sosFactor,
    recentRpg: Math.round(recentRpg * 10) / 10,
    adjustedRpg,
    tier,
    signal,
  };
}

export async function getTeamSos(teamId: number, teamName: string): Promise<TeamSos | null> {
  const key = `${teamId}`;
  const cached = cache[key];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const season = String(new Date().getFullYear());
  const games = await fetchTeamSchedule(teamId);
  if (games.length < 5) {
    cache[key] = { ts: Date.now(), data: null };
    return null;
  }

  let totalSpEra = 0;
  let spCount = 0;
  let totalBpEra = 0;
  let bpCount = 0;
  let totalRunsScored = 0;
  let countedGames = 0;
  const opponentTeamIds = new Set<number>();

  // Para cada juego, identificar lado del rival y stats
  for (const g of games.slice(-10)) {
    const isHome = g.teams?.home?.team?.id === teamId;
    const ownSide = isHome ? g.teams.home : g.teams.away;
    const oppSide = isHome ? g.teams.away : g.teams.home;
    if (!oppSide?.team?.id) continue;

    opponentTeamIds.add(oppSide.team.id);
    const runs = ownSide.score ?? 0;
    totalRunsScored += runs;
    countedGames++;

    const oppSpId = oppSide.probablePitcher?.id;
    if (oppSpId) {
      const era = await fetchPitcherSeasonEra(oppSpId, season);
      if (era !== null && era > 0 && era < 15) {
        totalSpEra += era;
        spCount++;
      }
    }
  }

  // Para cada team rival único, traer su staff ERA general (proxy de bullpen)
  for (const oppId of opponentTeamIds) {
    const era = await fetchTeamSeasonBullpenEra(oppId, season);
    if (era !== null && era > 0 && era < 8) {
      totalBpEra += era;
      bpCount++;
    }
  }

  const result = finalizeTeamSos({
    teamId,
    teamName,
    countedGames,
    totalSpEra,
    spCount,
    totalBpEra,
    bpCount,
    totalRunsScored,
  });
  cache[key] = { ts: Date.now(), data: result };
  return result;
}

async function fetchJsonCertified(url: string, source: string, runtime: SosRuntime): Promise<any> {
  let response: Response;
  try {
    response = await runtimeFetch(runtime)(url, { headers: { accept: "application/json" } });
  } catch (error: any) {
    throw new Error(`SOS_SOURCE_FETCH_FAILED:${source}:${String(error?.message || error || "UNKNOWN")}`);
  }
  if (!response.ok) throw new Error(`SOS_SOURCE_HTTP_${response.status}:${source}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`SOS_SOURCE_INVALID_JSON:${source}`);
  }
}

async function fetchTeamScheduleCertified(teamId: number, runtime: SosRuntime): Promise<any[]> {
  const end = runtimeNow(runtime);
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const url = `${MLB_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${start.toISOString().slice(0, 10)}&endDate=${end.toISOString().slice(0, 10)}&hydrate=probablePitcher,linescore`;
  const payload = await fetchJsonCertified(url, "SCHEDULE", runtime);
  if (!Array.isArray(payload?.dates)) throw new Error(`SOS_SCHEDULE_SHAPE_INVALID:${teamId}`);
  const games: any[] = [];
  for (const date of payload.dates) {
    if (!Array.isArray(date?.games)) throw new Error(`SOS_SCHEDULE_DATE_GAMES_INVALID:${teamId}`);
    for (const game of date.games) {
      if (game?.status?.abstractGameState === "Final") games.push(game);
    }
  }
  return games.slice(-15);
}

async function fetchPitcherSeasonEraCertified(pitcherId: number, season: string, runtime: SosRuntime): Promise<number> {
  const payload = await fetchJsonCertified(
    `${MLB_BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}`,
    "PITCHER_ERA",
    runtime,
  );
  if (!Array.isArray(payload?.stats)) throw new Error(`SOS_PITCHER_STATS_SHAPE_INVALID:${pitcherId}`);
  const era = parseFloat(payload.stats?.[0]?.splits?.[0]?.stat?.era ?? "");
  if (!Number.isFinite(era) || era <= 0 || era >= 15) throw new Error(`SOS_PITCHER_ERA_MISSING:${pitcherId}`);
  return era;
}

async function fetchTeamSeasonBullpenEraCertified(teamId: number, season: string, runtime: SosRuntime): Promise<number> {
  const payload = await fetchJsonCertified(
    `${MLB_BASE}/teams/${teamId}/stats?season=${season}&stats=season&group=pitching&gameType=R`,
    "TEAM_STAFF_ERA",
    runtime,
  );
  if (!Array.isArray(payload?.stats)) throw new Error(`SOS_TEAM_STATS_SHAPE_INVALID:${teamId}`);
  const era = parseFloat(payload.stats?.[0]?.splits?.[0]?.stat?.era ?? "");
  if (!Number.isFinite(era) || era <= 0 || era >= 8) throw new Error(`SOS_TEAM_STAFF_ERA_MISSING:${teamId}`);
  return era;
}

function certifiedSnapshotFromCache(
  entry: CacheEntry<CertifiedSosCacheValue>,
  nowMs: number,
): TeamSosCertifiedSnapshot {
  const generatedAt = new Date(entry.ts).toISOString();
  return {
    sourceStatus: "CERTIFIED",
    generatedAt,
    teamSos: entry.data.teamSos,
    provenance: {
      schemaVersion: MLB_SOS_EVIDENCE_SCHEMA,
      status: "CERTIFIED",
      generatedAt,
      sampleStatus: entry.data.sampleStatus,
      selectedFinalGames: entry.data.selectedFinalGames,
      pitcherErasVerified: entry.data.pitcherErasVerified,
      opponentStaffErasVerified: entry.data.opponentStaffErasVerified,
      uniqueOpponents: entry.data.uniqueOpponents,
      cacheMaxAgeSeconds: 3600,
      cacheHit: true,
      cacheAgeSeconds: Math.max(0, Math.round((nowMs - entry.ts) / 1000)),
      failureDisposition: "THROW_FAIL_CLOSED",
    },
  };
}

export async function getTeamSosCertifiedSnapshot(
  teamId: number,
  teamName: string,
  runtime: SosRuntime = {},
): Promise<TeamSosCertifiedSnapshot> {
  if (!Number.isInteger(Number(teamId)) || Number(teamId) <= 0) throw new Error("SOS_TEAM_ID_REQUIRED");
  const now = runtimeNow(runtime);
  const nowMs = now.getTime();
  const key = `${teamId}`;
  const cached = certifiedCache[key];
  if (cached && nowMs - cached.ts < CACHE_TTL) return certifiedSnapshotFromCache(cached, nowMs);

  const season = String(now.getFullYear());
  const games = await fetchTeamScheduleCertified(teamId, runtime);
  const selectedGames = games.slice(-10);
  if (selectedGames.length < 5) {
    const value: CertifiedSosCacheValue = {
      teamSos: null,
      sampleStatus: "INSUFFICIENT_GAMES",
      selectedFinalGames: selectedGames.length,
      pitcherErasVerified: 0,
      opponentStaffErasVerified: 0,
      uniqueOpponents: 0,
    };
    certifiedCache[key] = { ts: nowMs, data: value };
    return {
      ...certifiedSnapshotFromCache(certifiedCache[key], nowMs),
      provenance: {
        ...certifiedSnapshotFromCache(certifiedCache[key], nowMs).provenance,
        cacheHit: false,
        cacheAgeSeconds: 0,
      },
    };
  }

  let totalSpEra = 0;
  let totalBpEra = 0;
  let totalRunsScored = 0;
  const opponentTeamIds = new Set<number>();

  for (const game of selectedGames) {
    const isHome = game?.teams?.home?.team?.id === teamId;
    const ownSide = isHome ? game?.teams?.home : game?.teams?.away;
    const oppSide = isHome ? game?.teams?.away : game?.teams?.home;
    const opponentId = Number(oppSide?.team?.id);
    if (!Number.isInteger(opponentId) || opponentId <= 0) throw new Error(`SOS_OPPONENT_ID_MISSING:${game?.gamePk ?? "UNKNOWN"}`);
    opponentTeamIds.add(opponentId);

    const runs = Number(ownSide?.score);
    if (!Number.isFinite(runs) || runs < 0) throw new Error(`SOS_FINAL_SCORE_MISSING:${game?.gamePk ?? "UNKNOWN"}`);
    totalRunsScored += runs;

    const pitcherId = Number(oppSide?.probablePitcher?.id);
    if (!Number.isInteger(pitcherId) || pitcherId <= 0) throw new Error(`SOS_PROBABLE_PITCHER_MISSING:${game?.gamePk ?? "UNKNOWN"}`);
    totalSpEra += await fetchPitcherSeasonEraCertified(pitcherId, season, runtime);
  }

  for (const opponentId of opponentTeamIds) {
    totalBpEra += await fetchTeamSeasonBullpenEraCertified(opponentId, season, runtime);
  }

  const result = finalizeTeamSos({
    teamId,
    teamName,
    countedGames: selectedGames.length,
    totalSpEra,
    spCount: selectedGames.length,
    totalBpEra,
    bpCount: opponentTeamIds.size,
    totalRunsScored,
  });
  if (!result) throw new Error(`SOS_CERTIFIED_RESULT_UNAVAILABLE:${teamId}`);

  const value: CertifiedSosCacheValue = {
    teamSos: result,
    sampleStatus: "AVAILABLE",
    selectedFinalGames: selectedGames.length,
    pitcherErasVerified: selectedGames.length,
    opponentStaffErasVerified: opponentTeamIds.size,
    uniqueOpponents: opponentTeamIds.size,
  };
  certifiedCache[key] = { ts: nowMs, data: value };
  const snapshot = certifiedSnapshotFromCache(certifiedCache[key], nowMs);
  return {
    ...snapshot,
    provenance: {
      ...snapshot.provenance,
      cacheHit: false,
      cacheAgeSeconds: 0,
    },
  };
}

export function resetSosCertifiedCacheForTests(): void {
  for (const key of Object.keys(certifiedCache)) delete certifiedCache[key];
}
