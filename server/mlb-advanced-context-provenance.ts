import { analyzeOpener, computeWeatherImpact, getParkFactor, type ParkFactor } from "./mlb-advanced";

const MLB_BASE = "https://statsapi.mlb.com/api";
const CACHE_MAX_AGE_SECONDS = 21_600;

export const MLB_ADVANCED_CONTEXT_EVIDENCE_SCHEMA = "courtedge-mlb-advanced-context-evidence.v1" as const;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdvancedContextRuntime {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface AdvancedContextCertifiedSnapshot {
  sourceStatus: "CERTIFIED";
  generatedAt: string;
  park: ParkFactor;
  weather: ReturnType<typeof computeWeatherImpact>;
  homePitcher: ReturnType<typeof analyzeOpener> & { id: number; name: string };
  awayPitcher: ReturnType<typeof analyzeOpener> & { id: number; name: string };
  totalAdjustment: number;
  breakdown: {
    park: number;
    temp: number;
    wind: number;
    homePitcher: number;
    awayPitcher: number;
  };
  provenance: {
    schemaVersion: typeof MLB_ADVANCED_CONTEXT_EVIDENCE_SCHEMA;
    status: "CERTIFIED";
    generatedAt: string;
    gamePk: number;
    venueId: number;
    venueName: string;
    venueIdentityVerified: true;
    roofResolution: "OPEN" | "DOME";
    homePitcherSampleStatus: "AVAILABLE" | "NO_SEASON_SAMPLE";
    awayPitcherSampleStatus: "AVAILABLE" | "NO_SEASON_SAMPLE";
    cacheMaxAgeSeconds: 21_600;
    failureDisposition: "THROW_FAIL_CLOSED";
  };
}

function runtimeNow(runtime: AdvancedContextRuntime): Date {
  return runtime.now ? runtime.now() : new Date();
}

function runtimeFetch(runtime: AdvancedContextRuntime): FetchLike {
  return runtime.fetchImpl ?? ((input, init) => fetch(input, init));
}

async function fetchJson(url: string, source: string, runtime: AdvancedContextRuntime): Promise<any> {
  let response: Response;
  try {
    response = await runtimeFetch(runtime)(url, { headers: { accept: "application/json" } });
  } catch (error: any) {
    throw new Error(`ADVANCED_CONTEXT_SOURCE_FETCH_FAILED:${source}:${String(error?.message || error || "UNKNOWN")}`);
  }
  if (!response.ok) throw new Error(`ADVANCED_CONTEXT_SOURCE_HTTP_${response.status}:${source}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`ADVANCED_CONTEXT_SOURCE_INVALID_JSON:${source}`);
  }
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizedName(value: unknown): string {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameVenueName(a: unknown, b: unknown): boolean {
  const left = normalizedName(a);
  const right = normalizedName(b);
  return Boolean(left && right && left === right);
}

const PARK_NAME_OVERRIDES: Record<string, ParkFactor> = {
  dodgerstadium: {
    venueId: 22,
    name: "Dodger Stadium",
    runs: 99,
    hrLHB: 100,
    hrRHB: 102,
    roof: "open",
    elevation: 340,
  },
  daikinpark: {
    venueId: 32,
    name: "Daikin Park",
    runs: 101,
    hrLHB: 105,
    hrRHB: 107,
    roof: "retractable",
    elevation: 22,
    notes: "ex-Minute Maid, Crawford Boxes",
  },
};

const PARK_NAME_ALIASES: Record<string, string> = {
  ratefield: "Guaranteed Rate Fld",
  guaranteedratefield: "Guaranteed Rate Fld",
  greatamericanballpark: "Great American Ball",
  americanfamilyfield: "American Family Fld",
};

export function resolveCertifiedParkFactor(venueName: string): ParkFactor | null {
  const key = normalizedName(venueName);
  if (!key) return null;
  const override = PARK_NAME_OVERRIDES[key];
  if (override) return override;
  const direct = getParkFactor(undefined, venueName);
  if (direct) return direct;
  const alias = PARK_NAME_ALIASES[key];
  return alias ? getParkFactor(undefined, alias) : null;
}

function resolveCurrentRoof(roofType: unknown, condition: unknown): "open" | "dome" {
  const type = clean(roofType).toLowerCase();
  const weather = clean(condition).toLowerCase();
  if (type.includes("indoor") || type.includes("dome")) return "dome";
  if (type.includes("open")) return "open";
  if (type.includes("retract")) {
    if (/roof\s*closed|closed\s*roof|indoor/.test(weather)) return "dome";
    if (/roof\s*open|open\s*roof|outdoor/.test(weather)) return "open";
    throw new Error("ADVANCED_CONTEXT_RETRACTABLE_ROOF_STATUS_UNVERIFIED");
  }
  throw new Error(`ADVANCED_CONTEXT_ROOF_TYPE_UNSUPPORTED:${clean(roofType) || "MISSING"}`);
}

interface PitcherSource {
  id: number;
  name: string;
  stats: any | null;
  sampleStatus: "AVAILABLE" | "NO_SEASON_SAMPLE";
}

async function loadPitcher(
  id: number,
  name: string,
  season: number,
  side: "HOME" | "AWAY",
  runtime: AdvancedContextRuntime,
): Promise<PitcherSource> {
  if (!Number.isInteger(id) || id <= 0) throw new Error(`ADVANCED_CONTEXT_${side}_PITCHER_ID_REQUIRED`);
  const payload = await fetchJson(
    `${MLB_BASE}/v1/people/${id}/stats?stats=season&group=pitching&season=${season}`,
    `${side}_PITCHER_SEASON`,
    runtime,
  );
  if (!Array.isArray(payload?.stats)) throw new Error(`ADVANCED_CONTEXT_${side}_PITCHER_STATS_SHAPE_INVALID`);
  const stats = payload.stats?.[0]?.splits?.[0]?.stat ?? null;
  return { id, name, stats, sampleStatus: stats ? "AVAILABLE" : "NO_SEASON_SAMPLE" };
}

function probablePitcher(feed: any, side: "home" | "away"): { id: number; name: string } | null {
  const value = feed?.gameData?.probablePitchers?.[side]
    ?? feed?.gameData?.teams?.[side]?.probablePitcher
    ?? null;
  const id = Number(value?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { id, name: clean(value?.fullName ?? value?.name) || `Pitcher ${id}` };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export async function getAdvancedContextCertifiedSnapshot(
  gamePk: number,
  runtime: AdvancedContextRuntime = {},
): Promise<AdvancedContextCertifiedSnapshot> {
  if (!Number.isInteger(Number(gamePk)) || Number(gamePk) <= 0) throw new Error("ADVANCED_CONTEXT_GAME_PK_REQUIRED");
  const now = runtimeNow(runtime);
  const feed = await fetchJson(`${MLB_BASE}/v1.1/game/${gamePk}/feed/live`, "GAME_FEED", runtime);
  const venueId = Number(feed?.gameData?.venue?.id);
  const venueName = clean(feed?.gameData?.venue?.name);
  if (!Number.isInteger(venueId) || venueId <= 0 || !venueName) throw new Error("ADVANCED_CONTEXT_VENUE_IDENTITY_MISSING");

  const venuePayload = await fetchJson(`${MLB_BASE}/v1/venues/${venueId}?hydrate=fieldInfo`, "VENUE", runtime);
  const venue = Array.isArray(venuePayload?.venues) ? venuePayload.venues[0] : null;
  if (!venue || Number(venue.id) !== venueId || !sameVenueName(venue.name, venueName)) {
    throw new Error("ADVANCED_CONTEXT_VENUE_IDENTITY_CONFLICT");
  }

  const park = resolveCertifiedParkFactor(venueName);
  if (!park) throw new Error(`ADVANCED_CONTEXT_PARK_FACTOR_UNMAPPED:${venueName}`);

  const weatherData = feed?.gameData?.weather ?? {};
  const roof = resolveCurrentRoof(venue?.fieldInfo?.roofType, weatherData?.condition);
  if (roof !== "dome") {
    if (!clean(weatherData?.temp)) throw new Error("ADVANCED_CONTEXT_WEATHER_TEMP_MISSING");
    if (!clean(weatherData?.wind)) throw new Error("ADVANCED_CONTEXT_WEATHER_WIND_MISSING");
  }

  const homeProbable = probablePitcher(feed, "home");
  const awayProbable = probablePitcher(feed, "away");
  if (!homeProbable) throw new Error("ADVANCED_CONTEXT_HOME_PITCHER_ID_REQUIRED");
  if (!awayProbable) throw new Error("ADVANCED_CONTEXT_AWAY_PITCHER_ID_REQUIRED");

  const [home, away] = await Promise.all([
    loadPitcher(homeProbable.id, homeProbable.name, now.getFullYear(), "HOME", runtime),
    loadPitcher(awayProbable.id, awayProbable.name, now.getFullYear(), "AWAY", runtime),
  ]);

  const weather = computeWeatherImpact(weatherData?.temp, weatherData?.wind, weatherData?.condition, roof);
  const homeOpener = analyzeOpener(home.stats?.gamesStarted, home.stats?.gamesPlayed, home.stats?.inningsPitched);
  const awayOpener = analyzeOpener(away.stats?.gamesStarted, away.stats?.gamesPlayed, away.stats?.inningsPitched);
  const parkAdj = ((park.runs - 100) / 100) * 4.5;
  const totalAdj = parkAdj + weather.tempAdj + weather.windAdj + homeOpener.runAdj + awayOpener.runAdj;
  const generatedAt = now.toISOString();

  return {
    sourceStatus: "CERTIFIED",
    generatedAt,
    park,
    weather,
    homePitcher: { id: home.id, name: home.name, ...homeOpener },
    awayPitcher: { id: away.id, name: away.name, ...awayOpener },
    totalAdjustment: round1(totalAdj),
    breakdown: {
      park: round1(parkAdj),
      temp: weather.tempAdj,
      wind: weather.windAdj,
      homePitcher: homeOpener.runAdj,
      awayPitcher: awayOpener.runAdj,
    },
    provenance: {
      schemaVersion: MLB_ADVANCED_CONTEXT_EVIDENCE_SCHEMA,
      status: "CERTIFIED",
      generatedAt,
      gamePk: Number(gamePk),
      venueId,
      venueName,
      venueIdentityVerified: true,
      roofResolution: roof === "dome" ? "DOME" : "OPEN",
      homePitcherSampleStatus: home.sampleStatus,
      awayPitcherSampleStatus: away.sampleStatus,
      cacheMaxAgeSeconds: CACHE_MAX_AGE_SECONDS,
      failureDisposition: "THROW_FAIL_CLOSED",
    },
  };
}
