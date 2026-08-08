import { createHash } from "node:crypto";
import { buildStatcastMatchupCoverageReport } from "./mlb-statcast-matchup-coverage";
import { recomputeStatcastRunsDelta } from "./mlb-statcast-matchup-vsteam-identity";

export const MLB_STATCAST_MATCHUP_CERTIFICATION_SCHEMA = "courtedge-mlb-statcast-matchup-certification.v1" as const;

const LEAGUE_XWOBA = 0.310;
const CERT_CACHE_TTL_MS = 5 * 60 * 1000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type MomentumTier = "HOT" | "WARM" | "NEUTRAL" | "COOL" | "COLD" | "UNKNOWN";

export interface StrictPitch {
  type: string;
  name: string;
  usage: number;
  wobaAgainst: number;
  whiff: number;
}

export interface StrictBatterPitchRow {
  playerId: number;
  team: string;
  pitchType: string;
  pitches: number;
  pa: number;
  xwoba: number;
  whiff: number;
  runValue100: number;
}

export interface StrictRecentStats {
  ops: number;
  pa: number;
  tier: MomentumTier;
}

export interface StrictVsPitcherStats {
  pa: number;
  ops: number;
  hr: number;
  k: number;
}

export interface StrictBullpenPitcher {
  pitcherId: number;
  pitcherName: string;
  role: "Closer" | "Setup" | "Middle";
}

export interface StrictStatcastEvidenceProvider {
  getPitcherArsenalMap(season: number): Promise<Record<number, StrictPitch[]>>;
  getBatterPitchRows(season: number): Promise<StrictBatterPitchRow[]>;
  getRecentBatterStats(batterId: number, endDate: string): Promise<StrictRecentStats>;
  getProjectedBullpen(teamId: number, season: number): Promise<StrictBullpenPitcher[]>;
  getVsPitcherCareer(batterId: number, pitcherId: number): Promise<StrictVsPitcherStats | null>;
  oldestObservedAt(): string | null;
}

export interface StatcastMatchupCertificationReport {
  sourceStatus: "CERTIFIED" | "DEGRADED";
  generatedAt: string | null;
  provenance: {
    schemaVersion: typeof MLB_STATCAST_MATCHUP_CERTIFICATION_SCHEMA;
    status: "CERTIFIED" | "DEGRADED";
    generatedAt: string | null;
    verifiedAt: string;
    certificationScope: "READINESS_COMBINED_RUN_DELTAS_AND_STARTER_ROWS";
    resultFingerprint: string;
    cacheMaxAgeSeconds: 300;
    cacheHit: boolean;
    cacheAgeSeconds: number;
    currentLineupsConfirmed: boolean;
    visibleCoverageComplete: boolean;
    currentSeasonPitcherArsenalsReproduced: boolean;
    bullpenRosterAndStatsComplete: boolean;
    recentBatterStatsComplete: boolean;
    starterRowsReproduced: boolean;
    bullpenDeltasReproduced: boolean;
    combinedRunDeltasReproduced: boolean;
    sources: {
      pitcherArsenal: "BASEBALL_SAVANT_CURRENT_SEASON";
      batterPitchTypes: "BASEBALL_SAVANT_CURRENT_AND_PREVIOUS_SEASON";
      bullpenSelection: "MLB_ACTIVE_ROSTER_AND_SEASON_STATS";
      recentBatting: "MLB_STATS_BY_DATE_RANGE";
      directCareerMatchup: "MLB_STATS_VS_PLAYER_TOTAL_WHEN_REQUIRED";
      historyIdentity: "MLB_STATS_VS_TEAM_NUMERIC_IDENTITY_SAFE";
    };
    blockers: string[];
    failureDisposition: "DEGRADE_NOT_CERTIFY";
    safety: {
      modelFormulaChanged: false;
      runDeltaMutatedByCertifier: false;
      probabilityChanged: false;
      economicThresholdChanged: false;
      actionabilityAllowed: false;
      automaticPromotionAllowed: false;
    };
  };
}

interface ProviderRuntime {
  fetchImpl?: FetchLike;
  now?: () => Date;
}

interface StrictLineupRow {
  batterId: number;
  dataQuality: "DIRECT" | "TEAM_PROXY" | "LEAGUE";
  expectedXwoba: number;
}

interface StrictLineupResult {
  rows: StrictLineupRow[];
  expectedTeamRunsDelta: number;
}

interface TeamPitchAggregate {
  pa: number;
  xwoba: number;
  whiff: number;
}

interface BaseBatterResult {
  expectedXwoba: number;
  dataQuality: "DIRECT" | "TEAM_PROXY" | "LEAGUE";
  strengthsCount: number;
}

const certificationCache = new Map<number, { ts: number; fingerprint: string; report: StatcastMatchupCertificationReport }>();

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      cur += '"';
      index++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += char;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => { row[header] = values[index] ?? ""; });
    return row;
  });
}

function recentTier(ops: number, pa: number): MomentumTier {
  if (pa < 15) return "UNKNOWN";
  if (ops >= 0.900) return "HOT";
  if (ops >= 0.800) return "WARM";
  if (ops >= 0.680) return "NEUTRAL";
  if (ops >= 0.580) return "COOL";
  return "COLD";
}

export function createStrictStatcastEvidenceProvider(runtime: ProviderRuntime = {}): StrictStatcastEvidenceProvider {
  const fetchImpl = runtime.fetchImpl ?? fetch;
  const now = runtime.now ?? (() => new Date());
  const observed: number[] = [];
  const pitcherMaps = new Map<number, Promise<Record<number, StrictPitch[]>>>();
  const batterRows = new Map<number, Promise<StrictBatterPitchRow[]>>();
  const recent = new Map<string, Promise<StrictRecentStats>>();
  const bullpens = new Map<string, Promise<StrictBullpenPitcher[]>>();
  const vsPitcher = new Map<string, Promise<StrictVsPitcherStats | null>>();

  const observe = () => observed.push(now().getTime());

  async function json(url: string, label: string, timeoutMs = 5000): Promise<any> {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    } catch (error: any) {
      throw new Error(`STATCAST_CERT_SOURCE_FETCH_FAILED:${label}:${clean(error?.message || error || "UNKNOWN")}`);
    }
    if (!response.ok) throw new Error(`STATCAST_CERT_SOURCE_HTTP_${response.status}:${label}`);
    let payload: any;
    try { payload = await response.json(); }
    catch { throw new Error(`STATCAST_CERT_SOURCE_INVALID_JSON:${label}`); }
    observe();
    return payload;
  }

  async function csv(url: string, label: string): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://baseballsavant.mlb.com/" },
      });
    } catch (error: any) {
      throw new Error(`STATCAST_CERT_SOURCE_FETCH_FAILED:${label}:${clean(error?.message || error || "UNKNOWN")}`);
    }
    if (!response.ok) throw new Error(`STATCAST_CERT_SOURCE_HTTP_${response.status}:${label}`);
    const text = await response.text();
    observe();
    if (!text.trim()) throw new Error(`STATCAST_CERT_SOURCE_EMPTY:${label}`);
    return text;
  }

  function getPitcherArsenalMap(season: number): Promise<Record<number, StrictPitch[]>> {
    if (!pitcherMaps.has(season)) {
      pitcherMaps.set(season, (async () => {
        const text = await csv(
          `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitch_type=ALL&min_pa=q&min_pitches=q&year=${season}&team=&csv=true`,
          `SAVANT_PITCHER_ARSENAL_${season}`,
        );
        const map: Record<number, StrictPitch[]> = {};
        for (const row of parseCsv(text)) {
          const playerId = positiveInt(row["player_id"]);
          if (!playerId) continue;
          const type = clean(row["pitch_type"]);
          const usage = finite(row["pitch_usage"]);
          if (!type || usage <= 0) continue;
          if (!map[playerId]) map[playerId] = [];
          map[playerId].push({
            type,
            name: clean(row["pitch_name"]),
            usage,
            wobaAgainst: finite(row["woba"]),
            whiff: finite(row["whiff_percent"]),
          });
        }
        if (!Object.keys(map).length) throw new Error(`STATCAST_CERT_PITCHER_ARSENAL_MAP_EMPTY:${season}`);
        return map;
      })());
    }
    return pitcherMaps.get(season)!;
  }

  function getBatterPitchRows(season: number): Promise<StrictBatterPitchRow[]> {
    if (!batterRows.has(season)) {
      batterRows.set(season, (async () => {
        const text = await csv(
          `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitch_type=ALL&min_pa=q&min_pitches=q&year=${season}&team=&csv=true`,
          `SAVANT_BATTER_ARSENAL_${season}`,
        );
        const rows: StrictBatterPitchRow[] = [];
        for (const row of parseCsv(text)) {
          const playerId = positiveInt(row["player_id"]);
          const pitchType = clean(row["pitch_type"]);
          if (!playerId || !pitchType) continue;
          rows.push({
            playerId,
            team: clean(row["team_name_alt"]),
            pitchType,
            pitches: Math.max(0, Math.trunc(finite(row["pitches"]))),
            pa: Math.max(0, Math.trunc(finite(row["pa"]))),
            xwoba: finite(row["est_woba"], finite(row["woba"])),
            whiff: finite(row["whiff_percent"]),
            runValue100: finite(row["run_value_per_100"]),
          });
        }
        if (!rows.length) throw new Error(`STATCAST_CERT_BATTER_ARSENAL_ROWS_EMPTY:${season}`);
        return rows;
      })());
    }
    return batterRows.get(season)!;
  }

  function getRecentBatterStats(batterId: number, endDate: string): Promise<StrictRecentStats> {
    const key = `${batterId}:${endDate}`;
    if (!recent.has(key)) {
      recent.set(key, (async () => {
        const end = endDate.slice(0, 10);
        const startDate = new Date(new Date(end).getTime() - 15 * 86_400_000).toISOString().slice(0, 10);
        const payload = await json(
          `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=byDateRange&group=hitting&startDate=${startDate}&endDate=${end}&sportId=1`,
          `RECENT_BATTER_${batterId}`,
        );
        const stat = payload?.stats?.[0]?.splits?.[0]?.stat;
        if (!stat) return { ops: 0, pa: 0, tier: "UNKNOWN" as const };
        const ops = finite(stat.ops);
        const pa = Math.max(0, Math.trunc(finite(stat.plateAppearances)));
        return { ops, pa, tier: recentTier(ops, pa) };
      })());
    }
    return recent.get(key)!;
  }

  function getProjectedBullpen(teamId: number, season: number): Promise<StrictBullpenPitcher[]> {
    const key = `${teamId}:${season}`;
    if (!bullpens.has(key)) {
      bullpens.set(key, (async () => {
        const roster = await json(
          `https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=active&hydrate=person`,
          `ACTIVE_ROSTER_${teamId}`,
          8000,
        );
        const pitchers = (Array.isArray(roster?.roster) ? roster.roster : [])
          .filter((entry: any) => entry?.position?.code === "1" && positiveInt(entry?.person?.id));
        if (!pitchers.length) throw new Error(`STATCAST_CERT_ACTIVE_PITCHERS_EMPTY:${teamId}`);

        const stats = await Promise.all(pitchers.map(async (entry: any) => {
          const pitcherId = positiveInt(entry?.person?.id)!;
          const payload = await json(
            `https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=season&group=pitching&season=${season}&sportId=1`,
            `BULLPEN_SEASON_${pitcherId}`,
          );
          const stat = payload?.stats?.[0]?.splits?.[0]?.stat;
          if (!stat) return null;
          const games = Math.max(0, Math.trunc(finite(stat.gamesPlayed)));
          const starts = Math.max(0, Math.trunc(finite(stat.gamesStarted)));
          const saves = Math.max(0, Math.trunc(finite(stat.saves)));
          const holds = Math.max(0, Math.trunc(finite(stat.holds)));
          const innings = Math.max(0, finite(stat.inningsPitched));
          if (starts > games * 0.3 || games < 5) return null;
          return {
            pitcherId,
            pitcherName: clean(entry?.person?.fullName),
            score: saves * 4 + holds * 2 + innings * 0.5,
          };
        }));

        const valid = stats.filter((row): row is { pitcherId: number; pitcherName: string; score: number } => row != null)
          .sort((a, b) => b.score - a.score)
          .slice(0, 4);
        if (!valid.length) throw new Error(`STATCAST_CERT_BULLPEN_NO_ELIGIBLE_RELIEVERS:${teamId}`);
        return valid.map((row, index) => ({
          pitcherId: row.pitcherId,
          pitcherName: row.pitcherName,
          role: index === 0 ? "Closer" : index === 1 ? "Setup" : "Middle",
        }));
      })());
    }
    return bullpens.get(key)!;
  }

  function getVsPitcherCareer(batterId: number, pitcherId: number): Promise<StrictVsPitcherStats | null> {
    const key = `${batterId}:${pitcherId}`;
    if (!vsPitcher.has(key)) {
      vsPitcher.set(key, (async () => {
        const payload = await json(
          `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`,
          `VS_PITCHER_${batterId}_${pitcherId}`,
        );
        const stat = payload?.stats?.[0]?.splits?.[0]?.stat;
        const pa = Math.max(0, Math.trunc(finite(stat?.plateAppearances)));
        if (!stat || pa <= 0) return null;
        return {
          pa,
          ops: finite(stat.ops),
          hr: Math.max(0, Math.trunc(finite(stat.homeRuns))),
          k: Math.max(0, Math.trunc(finite(stat.strikeOuts))),
        };
      })());
    }
    return vsPitcher.get(key)!;
  }

  return {
    getPitcherArsenalMap,
    getBatterPitchRows,
    getRecentBatterStats,
    getProjectedBullpen,
    getVsPitcherCareer,
    oldestObservedAt() {
      if (!observed.length) return null;
      return new Date(Math.min(...observed)).toISOString();
    },
  };
}

function thresholdFor(now: Date): { minPitches: number; minTeamPa: number } {
  const month = now.getUTCMonth() + 1;
  if (month >= 3 && month <= 5) return { minPitches: 20, minTeamPa: 35 };
  if (month === 10) return { minPitches: 50, minTeamPa: 80 };
  return { minPitches: 30, minTeamPa: 50 };
}

function rowsByPlayer(rows: StrictBatterPitchRow[]): Map<number, StrictBatterPitchRow[]> {
  const map = new Map<number, StrictBatterPitchRow[]>();
  for (const row of rows) {
    if (!map.has(row.playerId)) map.set(row.playerId, []);
    map.get(row.playerId)!.push(row);
  }
  return map;
}

function aggregateTeamRows(rows: StrictBatterPitchRow[]): Record<string, Record<string, TeamPitchAggregate>> {
  const temporary: Record<string, Record<string, TeamPitchAggregate & { xsum: number; wsum: number }>> = {};
  for (const row of rows) {
    if (row.pa < 30 || !row.team) continue;
    if (!temporary[row.team]) temporary[row.team] = {};
    if (!temporary[row.team][row.pitchType]) {
      temporary[row.team][row.pitchType] = { pa: 0, xwoba: 0, whiff: 0, xsum: 0, wsum: 0 };
    }
    const target = temporary[row.team][row.pitchType];
    target.pa += row.pa;
    target.xsum += row.xwoba * row.pa;
    target.wsum += row.whiff * row.pa;
  }
  const result: Record<string, Record<string, TeamPitchAggregate>> = {};
  for (const [team, pitches] of Object.entries(temporary)) {
    result[team] = {};
    for (const [pitchType, aggregate] of Object.entries(pitches)) {
      result[team][pitchType] = {
        pa: aggregate.pa,
        xwoba: aggregate.pa > 0 ? aggregate.xsum / aggregate.pa : LEAGUE_XWOBA,
        whiff: aggregate.pa > 0 ? aggregate.wsum / aggregate.pa : 22,
      };
    }
  }
  return result;
}

function mergedTeamRows(current: StrictBatterPitchRow[], previous: StrictBatterPitchRow[]): Record<string, Record<string, TeamPitchAggregate>> {
  const currentAgg = aggregateTeamRows(current);
  const previousAgg = aggregateTeamRows(previous);
  const merged: Record<string, Record<string, TeamPitchAggregate>> = {};
  for (const [team, pitches] of Object.entries(currentAgg)) {
    merged[team] = { ...pitches };
  }
  for (const [team, pitches] of Object.entries(previousAgg)) {
    if (!merged[team]) merged[team] = {};
    for (const [pitchType, prior] of Object.entries(pitches)) {
      const existing = merged[team][pitchType];
      if (!existing || existing.pa < 80) merged[team][pitchType] = prior;
    }
  }
  return merged;
}

function analyzeBaseBatter(input: {
  arsenal: StrictPitch[];
  batterRows: StrictBatterPitchRow[];
  teamFallback: Record<string, TeamPitchAggregate> | null;
  now: Date;
}): BaseBatterResult {
  const thresholds = thresholdFor(input.now);
  const byPitch = new Map(input.batterRows.map((row) => [row.pitchType, row]));
  let weightedXwoba = 0;
  let totalUsage = 0;
  let directMatches = 0;
  let proxyMatches = 0;
  let strengthsCount = 0;

  for (const pitch of input.arsenal) {
    const batter = byPitch.get(pitch.type);
    if (batter && batter.pitches >= thresholds.minPitches) {
      weightedXwoba += batter.xwoba * (pitch.usage / 100);
      totalUsage += pitch.usage / 100;
      directMatches++;
      if (batter.xwoba > 0.360) strengthsCount++;
    } else {
      const proxy = input.teamFallback?.[pitch.type];
      if (proxy && proxy.pa >= thresholds.minTeamPa) {
        weightedXwoba += proxy.xwoba * (pitch.usage / 100);
        totalUsage += pitch.usage / 100;
        proxyMatches++;
        if (proxy.xwoba > 0.350) strengthsCount++;
      }
    }
  }

  const expectedXwoba = totalUsage > 0 ? weightedXwoba / totalUsage : LEAGUE_XWOBA;
  const dataQuality: BaseBatterResult["dataQuality"] =
    directMatches >= input.arsenal.length * 0.6 ? "DIRECT"
      : directMatches + proxyMatches >= input.arsenal.length * 0.6 ? "TEAM_PROXY"
        : "LEAGUE";
  return { expectedXwoba, dataQuality, strengthsCount };
}

function finalBatterXwoba(base: BaseBatterResult, recent: StrictRecentStats, career: StrictVsPitcherStats | null): number {
  let value: number;
  if (recent.tier !== "UNKNOWN" && recent.pa >= 15) {
    const recentProxy = Math.max(0.200, Math.min(0.500, recent.ops * 0.42));
    value = recentProxy * 0.50 + base.expectedXwoba * 0.30 + LEAGUE_XWOBA * 0.20;
  } else {
    value = base.expectedXwoba * 0.70 + LEAGUE_XWOBA * 0.30;
  }

  if (career && career.pa >= 8) {
    const careerProxy = Math.max(0.200, Math.min(0.500, career.ops * 0.42));
    value = value * 0.70 + careerProxy * 0.30;
  }

  const cold = recent.tier === "COOL" || recent.tier === "COLD";
  if (base.strengthsCount >= 2 && cold && recent.pa >= 15) {
    value = value * 0.85 + LEAGUE_XWOBA * 0.15;
  }
  const warmOrHot = recent.tier === "HOT" || recent.tier === "WARM";
  if (warmOrHot && base.strengthsCount === 0 && recent.pa >= 20) {
    value += recent.tier === "HOT" ? 0.040 : 0.020;
  }
  return round(value, 3);
}

async function computeStrictLineup(input: {
  lineup: number[];
  pitcherId: number;
  arsenal: StrictPitch[];
  currentRows: Map<number, StrictBatterPitchRow[]>;
  teamFallback: Record<string, TeamPitchAggregate> | null;
  recent: Map<number, StrictRecentStats>;
  provider: StrictStatcastEvidenceProvider;
  now: Date;
  includeCareer: boolean;
}): Promise<StrictLineupResult> {
  const careers = input.includeCareer
    ? await Promise.all(input.lineup.map((batterId) => input.provider.getVsPitcherCareer(batterId, input.pitcherId)))
    : input.lineup.map(() => null);

  const rows = input.lineup.map((batterId, index) => {
    const base = analyzeBaseBatter({
      arsenal: input.arsenal,
      batterRows: input.currentRows.get(batterId) ?? [],
      teamFallback: input.teamFallback,
      now: input.now,
    });
    return {
      batterId,
      dataQuality: base.dataQuality,
      expectedXwoba: finalBatterXwoba(base, input.recent.get(batterId) ?? { ops: 0, pa: 0, tier: "UNKNOWN" }, careers[index]),
    };
  });
  const average = rows.length ? rows.reduce((sum, row) => sum + row.expectedXwoba, 0) / rows.length : LEAGUE_XWOBA;
  return { rows, expectedTeamRunsDelta: round((average - LEAGUE_XWOBA) * 11, 2) };
}

function canonicalArsenal(value: any): string {
  const pitches = Array.isArray(value) ? value : [];
  return JSON.stringify(pitches.map((pitch: any) => ({
    type: clean(pitch?.type),
    usage: round(finite(pitch?.usage), 6),
    wobaAgainst: round(finite(pitch?.wobaAgainst), 6),
    whiff: round(finite(pitch?.whiff), 6),
  })).sort((a, b) => a.type.localeCompare(b.type)));
}

function resultFingerprint(result: any): string {
  const side = (matchup: any) => ({
    pitcherId: positiveInt(matchup?.pitcherId),
    lineupSource: matchup?.lineupSource ?? null,
    lineupSize: finite(matchup?.lineupSize),
    arsenal: Array.isArray(matchup?.arsenal) ? matchup.arsenal : [],
    rows: (Array.isArray(matchup?.perBatter) ? matchup.perBatter : []).map((row: any) => ({
      batterId: positiveInt(row?.batterId),
      expectedXwoba: finite(row?.expectedXwoba),
      dataQuality: row?.dataQuality ?? null,
    })),
    bullpen: (Array.isArray(matchup?.bullpenMatchup) ? matchup.bullpenMatchup : []).map((row: any) => ({
      pitcherId: positiveInt(row?.pitcherId), role: row?.role ?? null, expectedRunsDelta: finite(row?.expectedRunsDelta),
    })),
    expectedTeamRunsDelta: finite(matchup?.expectedTeamRunsDelta),
  });
  const payload = {
    home: side(result?.homeLineupVsAwaySP),
    away: side(result?.awayLineupVsHomeSP),
    homeHistory: { ops: finite(result?.homeLineupVsAwayTeam?.teamOpsVsOpp), identity: result?.homeLineupVsAwayTeam?.identity ?? null },
    awayHistory: { ops: finite(result?.awayLineupVsHomeTeam?.teamOpsVsOpp), identity: result?.awayLineupVsHomeTeam?.identity ?? null },
    homeRunsDelta: finite(result?.homeRunsDelta),
    awayRunsDelta: finite(result?.awayRunsDelta),
    identityCorrection: result?.identityCorrection ?? null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function feedSide(feed: any, side: "home" | "away"): { teamId: number | null; abbreviation: string; pitcherId: number | null; lineup: number[] } {
  const team = feed?.gameData?.teams?.[side] ?? {};
  const probable = feed?.gameData?.probablePitchers?.[side] ?? team?.probablePitcher ?? {};
  const order = feed?.liveData?.boxscore?.teams?.[side]?.battingOrder;
  return {
    teamId: positiveInt(team?.id),
    abbreviation: clean(team?.abbreviation),
    pitcherId: positiveInt(probable?.id),
    lineup: Array.isArray(order) ? order.map(positiveInt).filter((id): id is number => id != null) : [],
  };
}

function sameNumber(actual: unknown, expected: number): boolean {
  return Math.abs(finite(actual, Number.NaN) - expected) < 1e-9;
}

function degraded(input: {
  fingerprint: string;
  verifiedAt: string;
  blockers: string[];
  visibleCoverageComplete: boolean;
}): StatcastMatchupCertificationReport {
  return {
    sourceStatus: "DEGRADED",
    generatedAt: null,
    provenance: {
      schemaVersion: MLB_STATCAST_MATCHUP_CERTIFICATION_SCHEMA,
      status: "DEGRADED",
      generatedAt: null,
      verifiedAt: input.verifiedAt,
      certificationScope: "READINESS_COMBINED_RUN_DELTAS_AND_STARTER_ROWS",
      resultFingerprint: input.fingerprint,
      cacheMaxAgeSeconds: 300,
      cacheHit: false,
      cacheAgeSeconds: 0,
      currentLineupsConfirmed: false,
      visibleCoverageComplete: input.visibleCoverageComplete,
      currentSeasonPitcherArsenalsReproduced: false,
      bullpenRosterAndStatsComplete: false,
      recentBatterStatsComplete: false,
      starterRowsReproduced: false,
      bullpenDeltasReproduced: false,
      combinedRunDeltasReproduced: false,
      sources: {
        pitcherArsenal: "BASEBALL_SAVANT_CURRENT_SEASON",
        batterPitchTypes: "BASEBALL_SAVANT_CURRENT_AND_PREVIOUS_SEASON",
        bullpenSelection: "MLB_ACTIVE_ROSTER_AND_SEASON_STATS",
        recentBatting: "MLB_STATS_BY_DATE_RANGE",
        directCareerMatchup: "MLB_STATS_VS_PLAYER_TOTAL_WHEN_REQUIRED",
        historyIdentity: "MLB_STATS_VS_TEAM_NUMERIC_IDENTITY_SAFE",
      },
      blockers: Array.from(new Set(input.blockers)),
      failureDisposition: "DEGRADE_NOT_CERTIFY",
      safety: {
        modelFormulaChanged: false,
        runDeltaMutatedByCertifier: false,
        probabilityChanged: false,
        economicThresholdChanged: false,
        actionabilityAllowed: false,
        automaticPromotionAllowed: false,
      },
    },
  };
}

function strictPitcher(map: Record<number, StrictPitch[]>, pitcherId: number): StrictPitch[] {
  const arsenal = map[pitcherId] ?? [];
  if (arsenal.length < 3) throw new Error(`STATCAST_CERT_CURRENT_SAVANT_ARSENAL_REQUIRED:${pitcherId}`);
  return arsenal;
}

function compareStarter(input: {
  result: any;
  strict: StrictLineupResult;
  arsenal: StrictPitch[];
  lineup: number[];
  label: string;
}): void {
  if (input.result?.lineupSource !== "CONFIRMED") throw new Error(`STATCAST_CERT_STARTER_LINEUP_NOT_CONFIRMED:${input.label}`);
  if (Number(input.result?.lineupSize) !== 9 || input.lineup.length !== 9) throw new Error(`STATCAST_CERT_STARTER_LINEUP_SIZE_MISMATCH:${input.label}`);
  if (canonicalArsenal(input.result?.arsenal) !== canonicalArsenal(input.arsenal)) {
    throw new Error(`STATCAST_CERT_STARTER_ARSENAL_MISMATCH:${input.label}`);
  }
  const actualRows = Array.isArray(input.result?.perBatter) ? input.result.perBatter : [];
  if (actualRows.length !== input.strict.rows.length) throw new Error(`STATCAST_CERT_STARTER_ROW_COUNT_MISMATCH:${input.label}`);
  for (let index = 0; index < input.strict.rows.length; index++) {
    const expected = input.strict.rows[index];
    const actual = actualRows[index];
    if (positiveInt(actual?.batterId) !== expected.batterId) throw new Error(`STATCAST_CERT_STARTER_BATTER_ID_MISMATCH:${input.label}:${index}`);
    if (clean(actual?.dataQuality).toUpperCase() !== expected.dataQuality) throw new Error(`STATCAST_CERT_STARTER_DATA_QUALITY_MISMATCH:${input.label}:${expected.batterId}`);
    if (!sameNumber(actual?.expectedXwoba, expected.expectedXwoba)) throw new Error(`STATCAST_CERT_STARTER_XWOBA_MISMATCH:${input.label}:${expected.batterId}`);
  }
  if (!sameNumber(input.result?.expectedTeamRunsDelta, input.strict.expectedTeamRunsDelta)) {
    throw new Error(`STATCAST_CERT_STARTER_RUN_DELTA_MISMATCH:${input.label}`);
  }
}

function compareBullpenIdentity(actual: any[], expected: StrictBullpenPitcher[], label: string): void {
  if (actual.length !== expected.length) throw new Error(`STATCAST_CERT_BULLPEN_COUNT_MISMATCH:${label}`);
  for (let index = 0; index < expected.length; index++) {
    if (positiveInt(actual[index]?.pitcherId) !== expected[index].pitcherId || clean(actual[index]?.role) !== expected[index].role) {
      throw new Error(`STATCAST_CERT_BULLPEN_IDENTITY_MISMATCH:${label}:${index}`);
    }
  }
}

export async function certifyStatcastMatchupReadiness(input: {
  gamePk: number;
  result: any;
  feed: any;
  season: number;
  requestStartedAt: string;
  fetchImpl?: FetchLike;
  provider?: StrictStatcastEvidenceProvider;
  now?: () => Date;
}): Promise<StatcastMatchupCertificationReport> {
  const now = input.now ?? (() => new Date());
  const verifiedAt = now().toISOString();
  const fingerprint = resultFingerprint(input.result);
  const cached = certificationCache.get(input.gamePk);
  if (!input.provider && cached && cached.fingerprint === fingerprint && now().getTime() - cached.ts < CERT_CACHE_TTL_MS) {
    const age = Math.max(0, Math.round((now().getTime() - cached.ts) / 1000));
    return {
      ...cached.report,
      provenance: { ...cached.report.provenance, cacheHit: true, cacheAgeSeconds: age },
    };
  }

  const home = feedSide(input.feed, "home");
  const away = feedSide(input.feed, "away");
  const coverage = buildStatcastMatchupCoverageReport({
    identitySafeResult: input.result,
    homeCurrentLineupConfirmed: home.lineup.length === 9,
    awayCurrentLineupConfirmed: away.lineup.length === 9,
  });
  if (!coverage.visibleCoverageComplete) {
    return degraded({ fingerprint, verifiedAt, blockers: coverage.blockers, visibleCoverageComplete: false });
  }
  if (!home.teamId || !away.teamId || !home.pitcherId || !away.pitcherId || !home.abbreviation || !away.abbreviation) {
    return degraded({ fingerprint, verifiedAt, blockers: ["STATCAST_CERT_OFFICIAL_IDENTITY_INCOMPLETE"], visibleCoverageComplete: true });
  }

  const provider = input.provider ?? createStrictStatcastEvidenceProvider({ fetchImpl: input.fetchImpl, now });
  try {
    const endDate = now().toISOString().slice(0, 10);
    const allBatters = Array.from(new Set([...home.lineup, ...away.lineup]));
    const [pitcherMap, currentBatterRows, previousBatterRows, homeBullpen, awayBullpen, recentPairs] = await Promise.all([
      provider.getPitcherArsenalMap(input.season),
      provider.getBatterPitchRows(input.season),
      provider.getBatterPitchRows(input.season - 1),
      provider.getProjectedBullpen(home.teamId, input.season),
      provider.getProjectedBullpen(away.teamId, input.season),
      Promise.all(allBatters.map(async (batterId) => [batterId, await provider.getRecentBatterStats(batterId, endDate)] as const)),
    ]);
    const recent = new Map<number, StrictRecentStats>(recentPairs);
    const currentRows = rowsByPlayer(currentBatterRows);
    const teamFallbacks = mergedTeamRows(currentBatterRows, previousBatterRows);

    const awayStarterArsenal = strictPitcher(pitcherMap, away.pitcherId);
    const homeStarterArsenal = strictPitcher(pitcherMap, home.pitcherId);
    const [strictHomeStarter, strictAwayStarter] = await Promise.all([
      computeStrictLineup({
        lineup: home.lineup,
        pitcherId: away.pitcherId,
        arsenal: awayStarterArsenal,
        currentRows,
        teamFallback: teamFallbacks[home.abbreviation] ?? null,
        recent,
        provider,
        now: now(),
        includeCareer: true,
      }),
      computeStrictLineup({
        lineup: away.lineup,
        pitcherId: home.pitcherId,
        arsenal: homeStarterArsenal,
        currentRows,
        teamFallback: teamFallbacks[away.abbreviation] ?? null,
        recent,
        provider,
        now: now(),
        includeCareer: true,
      }),
    ]);

    compareStarter({ result: input.result?.homeLineupVsAwaySP, strict: strictHomeStarter, arsenal: awayStarterArsenal, lineup: home.lineup, label: "HOME_OFFENSE" });
    compareStarter({ result: input.result?.awayLineupVsHomeSP, strict: strictAwayStarter, arsenal: homeStarterArsenal, lineup: away.lineup, label: "AWAY_OFFENSE" });

    const actualHomeBullpen = Array.isArray(input.result?.homeLineupVsAwaySP?.bullpenMatchup) ? input.result.homeLineupVsAwaySP.bullpenMatchup : [];
    const actualAwayBullpen = Array.isArray(input.result?.awayLineupVsHomeSP?.bullpenMatchup) ? input.result.awayLineupVsHomeSP.bullpenMatchup : [];
    compareBullpenIdentity(actualHomeBullpen, awayBullpen, "AWAY_BULLPEN_VS_HOME");
    compareBullpenIdentity(actualAwayBullpen, homeBullpen, "HOME_BULLPEN_VS_AWAY");

    async function reproduceBullpen(actual: any[], expected: StrictBullpenPitcher[], lineup: number[], teamAbbrev: string, label: string): Promise<number[]> {
      const deltas: number[] = [];
      for (let index = 0; index < expected.length; index++) {
        const pitcher = expected[index];
        const arsenal = strictPitcher(pitcherMap, pitcher.pitcherId);
        let strict = await computeStrictLineup({
          lineup,
          pitcherId: pitcher.pitcherId,
          arsenal,
          currentRows,
          teamFallback: teamFallbacks[teamAbbrev] ?? null,
          recent,
          provider,
          now: now(),
          includeCareer: false,
        });
        if (!sameNumber(actual[index]?.expectedRunsDelta, strict.expectedTeamRunsDelta)) {
          strict = await computeStrictLineup({
            lineup,
            pitcherId: pitcher.pitcherId,
            arsenal,
            currentRows,
            teamFallback: teamFallbacks[teamAbbrev] ?? null,
            recent,
            provider,
            now: now(),
            includeCareer: true,
          });
        }
        if (!sameNumber(actual[index]?.expectedRunsDelta, strict.expectedTeamRunsDelta)) {
          throw new Error(`STATCAST_CERT_BULLPEN_RUN_DELTA_MISMATCH:${label}:${pitcher.pitcherId}`);
        }
        deltas.push(strict.expectedTeamRunsDelta);
      }
      return deltas;
    }

    const [strictHomeBullpenDeltas, strictAwayBullpenDeltas] = await Promise.all([
      reproduceBullpen(actualHomeBullpen, awayBullpen, home.lineup, home.abbreviation, "HOME_OFFENSE"),
      reproduceBullpen(actualAwayBullpen, homeBullpen, away.lineup, away.abbreviation, "AWAY_OFFENSE"),
    ]);
    const homeBullpenAverage = strictHomeBullpenDeltas.reduce((sum, value) => sum + value, 0) / strictHomeBullpenDeltas.length;
    const awayBullpenAverage = strictAwayBullpenDeltas.reduce((sum, value) => sum + value, 0) / strictAwayBullpenDeltas.length;
    const strictHomeCombined = recomputeStatcastRunsDelta({
      starterRunsDelta: strictHomeStarter.expectedTeamRunsDelta,
      bullpenRunsDelta: homeBullpenAverage,
      teamOpsVsOpp: finite(input.result?.homeLineupVsAwayTeam?.teamOpsVsOpp, 0.720),
    });
    const strictAwayCombined = recomputeStatcastRunsDelta({
      starterRunsDelta: strictAwayStarter.expectedTeamRunsDelta,
      bullpenRunsDelta: awayBullpenAverage,
      teamOpsVsOpp: finite(input.result?.awayLineupVsHomeTeam?.teamOpsVsOpp, 0.720),
    });
    if (!sameNumber(input.result?.homeRunsDelta, strictHomeCombined) || !sameNumber(input.result?.awayRunsDelta, strictAwayCombined)) {
      throw new Error("STATCAST_CERT_COMBINED_RUN_DELTA_MISMATCH");
    }

    const sourceObservedAt = provider.oldestObservedAt();
    if (!sourceObservedAt) throw new Error("STATCAST_CERT_SOURCE_OBSERVATION_TIME_MISSING");
    const startedMs = Date.parse(input.requestStartedAt);
    const sourceMs = Date.parse(sourceObservedAt);
    const generatedAt = new Date(Math.min(Number.isFinite(startedMs) ? startedMs : sourceMs, sourceMs)).toISOString();
    const report: StatcastMatchupCertificationReport = {
      sourceStatus: "CERTIFIED",
      generatedAt,
      provenance: {
        schemaVersion: MLB_STATCAST_MATCHUP_CERTIFICATION_SCHEMA,
        status: "CERTIFIED",
        generatedAt,
        verifiedAt: now().toISOString(),
        certificationScope: "READINESS_COMBINED_RUN_DELTAS_AND_STARTER_ROWS",
        resultFingerprint: fingerprint,
        cacheMaxAgeSeconds: 300,
        cacheHit: false,
        cacheAgeSeconds: 0,
        currentLineupsConfirmed: true,
        visibleCoverageComplete: true,
        currentSeasonPitcherArsenalsReproduced: true,
        bullpenRosterAndStatsComplete: true,
        recentBatterStatsComplete: true,
        starterRowsReproduced: true,
        bullpenDeltasReproduced: true,
        combinedRunDeltasReproduced: true,
        sources: {
          pitcherArsenal: "BASEBALL_SAVANT_CURRENT_SEASON",
          batterPitchTypes: "BASEBALL_SAVANT_CURRENT_AND_PREVIOUS_SEASON",
          bullpenSelection: "MLB_ACTIVE_ROSTER_AND_SEASON_STATS",
          recentBatting: "MLB_STATS_BY_DATE_RANGE",
          directCareerMatchup: "MLB_STATS_VS_PLAYER_TOTAL_WHEN_REQUIRED",
          historyIdentity: "MLB_STATS_VS_TEAM_NUMERIC_IDENTITY_SAFE",
        },
        blockers: [],
        failureDisposition: "DEGRADE_NOT_CERTIFY",
        safety: {
          modelFormulaChanged: false,
          runDeltaMutatedByCertifier: false,
          probabilityChanged: false,
          economicThresholdChanged: false,
          actionabilityAllowed: false,
          automaticPromotionAllowed: false,
        },
      },
    };
    if (!input.provider) certificationCache.set(input.gamePk, { ts: now().getTime(), fingerprint, report });
    return report;
  } catch (error: any) {
    return degraded({
      fingerprint,
      verifiedAt: now().toISOString(),
      blockers: [clean(error?.message || error || "STATCAST_CERT_UNKNOWN_FAILURE")],
      visibleCoverageComplete: true,
    });
  }
}

export function resetStatcastMatchupCertificationCacheForTests(): void {
  certificationCache.clear();
}
