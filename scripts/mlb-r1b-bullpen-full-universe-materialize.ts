#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getBullpenStatus,
  resetMlbBullpenCachesForTests,
  type BullpenPitcher,
  type BullpenRuntime,
  type BullpenStatus,
} from "../server/mlb-bullpen";

const SOURCE_VERSION = "courtedge-mlb-r1b-bullpen-full-universe.v1";
const CONTRACT_SCHEMA = "courtedge-mlb-r1b-bullpen-full-universe-contract.v1";
const PACK_SCHEMA = "courtedge-mlb-r1b-bullpen-family-pack-row.v1";
const WITNESS_SCHEMA = "courtedge-mlb-r1b-bullpen-full-universe-witness.v1";
const MANIFEST_SCHEMA = "courtedge-mlb-r1b-bullpen-full-universe-season-manifest.v1";
const MLB_V1 = "https://statsapi.mlb.com/api/v1";
const MLB_V11 = "https://statsapi.mlb.com/api/v1.1";
const ALLOWED_ADJUSTMENTS = new Set([0, 0.15, 0.3, 0.5, 0.7]);
const CURRENT_ROLE_STATS_AUTHORITY = "PEOPLE_HYDRATED_BY_DATE_RANGE" as const;

type Json = Record<string, any>;
type Side = "HOME" | "AWAY";
type RosterMode = "DATE_ROSTER" | "T5_ROSTER";
type Identity = {
  officialDate: string;
  gamePk: number;
  side: Side;
  market: "FG_ML" | "F5_ML";
  horizon: "FULL_GAME" | "EARLY_WINDOW";
};
type FrozenSnapshot = {
  gamePk: number;
  officialDate: string;
  requestedTimecode: string;
  sourceMetadataTimecode?: string | null;
  homeTeamId: number;
  awayTeamId: number;
  homeBattingOrder: number[];
  awayBattingOrder: number[];
  complete?: boolean;
  availability?: string;
};
type TargetGame = {
  officialDate: string;
  gamePk: number;
  identities: Identity[];
  snapshot: FrozenSnapshot;
};
type RoleFields = {
  gamesStarted: number;
  gamesPlayed: number;
  inningsPitched: number;
  saves: number;
  holds: number;
};
type SideMaterialization = {
  eligible: boolean;
  reason: string | null;
  runsAdjustment: number | null;
  dateFingerprint: any | null;
  t5Fingerprint: any | null;
  dateRosterPitcherIds: number[];
  t5RosterPitcherIds: number[];
  dateOnlyPitcherIds: number[];
  t5OnlyPitcherIds: number[];
  currentRoleLineIds: number[];
  priorSeasonFallbackIds: number[];
  careerFallbackIds: number[];
  noStatLineIds: number[];
};
type ScheduleGame = {
  gamePk: number;
  officialDate: string;
  homeTeamId: number;
  awayTeamId: number;
  status: any;
};

class TransportError extends Error {}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`BULLPEN_FULL_ARG_MISSING:${name}`);
}
function readJson(file: string): any { return JSON.parse(fs.readFileSync(file, "utf8")); }
function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function clean(value: unknown): string { return String(value ?? "").trim(); }
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));
}
function validTimecode(value: string): boolean { return /^\d{8}_\d{6}$/.test(value); }
function shiftDate(value: string, days: number): string {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function timecodeIso(value: string): string {
  if (!validTimecode(value)) throw new Error(`BULLPEN_FULL_BAD_TIMECODE:${value}`);
  return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}.000Z`;
}
function easternDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function canonical(value: any): string { return JSON.stringify(stable(value)); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function parseIP(value: unknown): number {
  const [whole, outs] = String(value ?? "0").split(".");
  return (parseInt(whole || "0", 10) || 0) + (parseInt(outs || "0", 10) || 0) / 3;
}
function n(value: unknown): number { const x = Number(value); return Number.isFinite(x) ? x : 0; }
function roleFields(stat: any): RoleFields | null {
  if (!stat) return null;
  return {
    gamesStarted: Math.trunc(n(stat.gamesStarted)),
    gamesPlayed: Math.trunc(n(stat.gamesPlayed)),
    inningsPitched: Math.round(parseIP(stat.inningsPitched) * 1e6) / 1e6,
    saves: Math.trunc(n(stat.saves)),
    holds: Math.trunc(n(stat.holds)),
  };
}
function sameRoleFields(a: any, b: any): boolean {
  return JSON.stringify(roleFields(a)) === JSON.stringify(roleFields(b));
}
function uniq(values: number[]): number[] { return [...new Set(values)]; }
function setDiff(left: number[], right: number[]): number[] {
  const r = new Set(right);
  return left.filter((x) => !r.has(x));
}
function exactOrder(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
function synthetic(payload: any): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}
function statPayload(stat: any | null): any {
  return stat ? { stats: [{ splits: [{ stat }] }] } : { stats: [] };
}
function statusFinal(status: any): boolean {
  return String(status?.codedGameState ?? "").toUpperCase() === "F"
    || /final|game over|completed early/i.test(String(status?.detailedState ?? ""));
}
function pregameState(feed: any): boolean {
  const coded = String(feed?.gameData?.status?.codedGameState ?? "").toUpperCase();
  const detailed = String(feed?.gameData?.status?.detailedState ?? "");
  if (["I", "F", "O"].includes(coded)) return false;
  if (/in progress|final|game over|completed early/i.test(detailed)) return false;
  return true;
}
function normalizeOrder(raw: any): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map(positiveInt);
  if (ids.some((id) => id == null)) return [];
  return ids as number[];
}
function rosterPitchers(payload: any): any[] {
  const roster = Array.isArray(payload?.roster) ? payload.roster : [];
  return roster.filter((row: any) => String(row?.position?.code ?? "") === "1" && positiveInt(row?.person?.id) != null);
}
function t5PitcherRoster(team: any): any[] {
  const players = team?.players && typeof team.players === "object" ? Object.values(team.players) : [];
  const out: any[] = [];
  const seen = new Set<number>();
  for (const row of players as any[]) {
    const id = positiveInt(row?.person?.id);
    if (!id || String(row?.position?.code ?? "") !== "1" || seen.has(id)) continue;
    seen.add(id);
    out.push({ person: { id, fullName: String(row?.person?.fullName ?? `PITCHER_${id}`) }, position: { code: "1" } });
  }
  return out;
}
function idsFromRoster(roster: any[]): number[] {
  return roster.map((row) => Number(row.person.id)).filter((x) => Number.isInteger(x) && x > 0);
}
function playerIdFromSplit(split: any): number | null {
  return positiveInt(split?.player?.id ?? split?.person?.id);
}
function mapTeamStats(payload: any): Map<number, any> {
  const m = new Map<number, any>();
  for (const block of Array.isArray(payload?.stats) ? payload.stats : []) {
    for (const split of Array.isArray(block?.splits) ? block.splits : []) {
      const id = playerIdFromSplit(split);
      if (id && split?.stat) m.set(id, split.stat);
    }
  }
  return m;
}
function firstStat(person: any): any | null { return person?.stats?.[0]?.splits?.[0]?.stat ?? null; }
function mapPeopleStats(payload: any): Map<number, any> {
  const m = new Map<number, any>();
  for (const person of Array.isArray(payload?.people) ? payload.people : []) {
    const id = positiveInt(person?.id);
    const stat = firstStat(person);
    if (id && stat) m.set(id, stat);
  }
  return m;
}
function pitcherFingerprint(p: BullpenPitcher | null): any {
  if (!p) return null;
  return {
    id: p.id,
    role: p.role,
    saves: p.saves ?? null,
    holds: p.holds ?? null,
    availability: p.availability,
    availabilityProb: p.availabilityProb,
    totalPitchesLast3Days: p.totalPitchesLast3Days,
    consecutiveDays: p.consecutiveDays,
    lastUsed: p.lastUsed ?? null,
  };
}
function decisionFingerprint(status: BullpenStatus): any {
  return {
    closer: pitcherFingerprint(status.closer),
    setupMen: status.setupMen.map(pitcherFingerprint),
    middleRelievers: status.middleRelievers.map(pitcherFingerprint),
    closerAvailable: status.closerAvailable,
    setupAvailable: status.setupAvailable,
    bullpenCompromised: status.bullpenCompromised,
    runsAdjustment: status.runsAdjustment,
  };
}
function identityKey(row: Identity): string {
  return `${row.officialDate}|${row.gamePk}|${row.side}|${row.market}|${row.horizon}`;
}
function parseV16Rowset(file: string): Identity[] {
  const rows: Identity[] = [];
  const seen = new Set<string>();
  for (const [i, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    const gamePk = positiveInt(raw.gamePk);
    const officialDate = clean(raw.officialDate);
    const side = clean(raw.side) as Side;
    const market = clean(raw.market) as Identity["market"];
    const horizon = clean(raw.horizon) as Identity["horizon"];
    if (!gamePk || !validDate(officialDate) || !["HOME","AWAY"].includes(side)
      || !["FG_ML","F5_ML"].includes(market) || !["FULL_GAME","EARLY_WINDOW"].includes(horizon)) {
      throw new Error(`BULLPEN_FULL_BAD_V16_IDENTITY:${i + 1}`);
    }
    const row = { officialDate, gamePk, side, market, horizon } as Identity;
    const k = identityKey(row);
    if (seen.has(k)) throw new Error(`BULLPEN_FULL_DUPLICATE_V16_IDENTITY:${k}`);
    seen.add(k);
    rows.push(row);
  }
  return rows;
}
function validateGameIdentities(rows: Identity[]): void {
  const expected = new Set([
    "HOME|FG_ML|FULL_GAME",
    "AWAY|FG_ML|FULL_GAME",
    "HOME|F5_ML|EARLY_WINDOW",
    "AWAY|F5_ML|EARLY_WINDOW",
  ]);
  const got = new Set(rows.map((r) => `${r.side}|${r.market}|${r.horizon}`));
  if (rows.length !== 4 || got.size !== 4 || [...expected].some((x) => !got.has(x))) {
    throw new Error(`BULLPEN_FULL_V16_GAME_IDENTITY_DRIFT:${rows[0]?.gamePk}`);
  }
  if (new Set(rows.map((r) => r.officialDate)).size !== 1) throw new Error(`BULLPEN_FULL_V16_DATE_DRIFT:${rows[0]?.gamePk}`);
}

const networkMemo = new Map<string, Promise<any>>();
async function fetchJson(url: string, memo = true): Promise<any> {
  const load = async () => {
    let last: unknown = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "CourtEdge-MLB-R1B-Bullpen-Probe/2.0" },
          signal: AbortSignal.timeout(25_000),
        });
        if (response.ok) return await response.json();
        const error = new TransportError(`BULLPEN_FULL_HTTP_${response.status}:${url}`);
        if (![408, 425, 429].includes(response.status) && response.status < 500) throw error;
        last = error;
      } catch (error) {
        last = error;
      }
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 350 * 2 ** (attempt - 1)));
    }
    throw last instanceof Error ? last : new TransportError(`BULLPEN_FULL_FETCH_FAILED:${url}`);
  };
  if (!memo) return load();
  let pending = networkMemo.get(url);
  if (!pending) {
    pending = load();
    networkMemo.set(url, pending);
  }
  return pending;
}

function validateT5Feed(snapshot: FrozenSnapshot, feed: any): void {
  const gamePk = positiveInt(feed?.gamePk ?? feed?.gameData?.game?.pk);
  const officialDate = clean(feed?.gameData?.datetime?.officialDate);
  const homeTeamId = positiveInt(feed?.gameData?.teams?.home?.id);
  const awayTeamId = positiveInt(feed?.gameData?.teams?.away?.id);
  const metadata = clean(feed?.metaData?.timeStamp);
  if (gamePk !== Number(snapshot.gamePk) || officialDate !== snapshot.officialDate
    || homeTeamId !== Number(snapshot.homeTeamId) || awayTeamId !== Number(snapshot.awayTeamId)) {
    throw new Error(`T5_IDENTITY_MISMATCH:${snapshot.gamePk}`);
  }
  if (!validTimecode(metadata) || metadata > snapshot.requestedTimecode) throw new Error(`T5_SOURCE_AFTER_CUTOFF:${snapshot.gamePk}`);
  if (!pregameState(feed)) throw new Error(`T5_NOT_PREGAME:${snapshot.gamePk}`);
  const home = normalizeOrder(feed?.liveData?.boxscore?.teams?.home?.battingOrder);
  const away = normalizeOrder(feed?.liveData?.boxscore?.teams?.away?.battingOrder);
  if (!exactOrder(home, snapshot.homeBattingOrder) || !exactOrder(away, snapshot.awayBattingOrder)) {
    throw new Error(`T5_LINEUP_MISMATCH:${snapshot.gamePk}`);
  }
}

async function loadSeasonSchedule(startDate: string, endDate: string): Promise<ScheduleGame[]> {
  const payload = await fetchJson(`${MLB_V1}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`);
  if (!Array.isArray(payload?.dates)) throw new Error("BULLPEN_FULL_SEASON_SCHEDULE_SHAPE_INVALID");
  const games: ScheduleGame[] = [];
  for (const date of payload.dates) {
    for (const game of Array.isArray(date?.games) ? date.games : []) {
      const gamePk = positiveInt(game?.gamePk);
      const homeTeamId = positiveInt(game?.teams?.home?.team?.id);
      const awayTeamId = positiveInt(game?.teams?.away?.team?.id);
      const officialDate = clean(game?.officialDate ?? date?.date);
      if (!gamePk || !homeTeamId || !awayTeamId || !validDate(officialDate) || !statusFinal(game?.status)) continue;
      games.push({ gamePk, officialDate, homeTeamId, awayTeamId, status: game.status });
    }
  }
  return games;
}

function schedulePayload(index: ScheduleGame[], teamId: number, start: string, end: string): any {
  const byDate = new Map<string, any[]>();
  for (const game of index) {
    if (game.officialDate < start || game.officialDate > end) continue;
    if (game.homeTeamId !== teamId && game.awayTeamId !== teamId) continue;
    const list = byDate.get(game.officialDate) ?? [];
    list.push({ gamePk: game.gamePk, officialDate: game.officialDate, status: game.status });
    byDate.set(game.officialDate, list);
  }
  return {
    dates: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, games]) => ({ date, games })),
  };
}

async function currentRoleBundle(teamId: number, date: string, ids: number[]): Promise<{ current: Map<number, any>; currentIds: number[] }> {
  const prior = shiftDate(date, -1);
  const start = `${date.slice(0,4)}-03-01`;
  const hydrate = `stats(group=[pitching],type=[byDateRange],startDate=${start},endDate=${prior})`;
  const url = `${MLB_V1}/people?personIds=${ids.join(",")}&hydrate=${encodeURIComponent(hydrate)}`;
  const payload = await fetchJson(url);
  const current = mapPeopleStats(payload);
  const currentIds = ids.filter((id) => current.has(id));
  return { current, currentIds };
}

function runtimeFor(params: {
  snapshot: FrozenSnapshot;
  teamId: number;
  roster: any[];
  current: Map<number, any>;
  schedule: ScheduleGame[];
  audits: string[];
  fallbackSources: Map<number, "CURRENT_SEASON" | "PREVIOUS_SEASON" | "CAREER" | "NO_MLB_STAT_LINE">;
}): BullpenRuntime {
  const { snapshot, teamId, roster, current, schedule, audits, fallbackSources } = params;
  const targetYear = Number(snapshot.officialDate.slice(0,4));
  const priorDate = shiftDate(snapshot.officialDate, -1);
  const fetchImpl: NonNullable<BullpenRuntime["fetchImpl"]> = async (input) => {
    const requested = String(input);
    const rosterMatch = requested.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\/teams\/(\d+)\/roster\?rosterType=Active$/);
    if (rosterMatch) {
      if (Number(rosterMatch[1]) !== teamId) throw new Error(`BULLPEN_FULL_RUNTIME_TEAM_DRIFT:${requested}`);
      audits.push("ROSTER_SYNTHETIC");
      return synthetic({ roster });
    }
    const seasonMatch = requested.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\/people\/(\d+)\/stats\?stats=season&group=pitching&season=(\d{4})$/);
    if (seasonMatch) {
      const pitcherId = Number(seasonMatch[1]);
      const year = Number(seasonMatch[2]);
      if (year === targetYear) {
        const stat = current.get(pitcherId) ?? null;
        if (stat) fallbackSources.set(pitcherId, "CURRENT_SEASON");
        audits.push("CURRENT_SEASON_BULK_SYNTHETIC");
        return synthetic(statPayload(stat));
      }
      if (year === targetYear - 1) {
        const payload = await fetchJson(requested);
        const stat = payload?.stats?.[0]?.splits?.[0]?.stat ?? null;
        if (stat) fallbackSources.set(pitcherId, "PREVIOUS_SEASON");
        audits.push("PREVIOUS_SEASON_OFFICIAL");
        return synthetic(payload);
      }
      throw new Error(`BULLPEN_FULL_UNEXPECTED_SEASON_REQUEST:${requested}`);
    }
    const careerMatch = requested.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\/people\/(\d+)\/stats\?stats=career&group=pitching$/);
    if (careerMatch) {
      const pitcherId = Number(careerMatch[1]);
      const resolved = `${MLB_V1}/stats?stats=byDateRange&group=pitching&personId=${pitcherId}&startDate=1900-01-01&endDate=${priorDate}`;
      const payload = await fetchJson(resolved);
      const stat = payload?.stats?.[0]?.splits?.[0]?.stat ?? null;
      fallbackSources.set(pitcherId, stat ? "CAREER" : "NO_MLB_STAT_LINE");
      audits.push("CAREER_RANGE_OFFICIAL");
      return synthetic(payload);
    }
    if (requested.startsWith(`${MLB_V1}/schedule?`)) {
      const u = new URL(requested);
      const requestedTeam = Number(u.searchParams.get("teamId"));
      const start = String(u.searchParams.get("startDate") ?? "");
      if (requestedTeam !== teamId || !validDate(start)) throw new Error(`BULLPEN_FULL_BAD_SCHEDULE_REQUEST:${requested}`);
      audits.push("RECENT_SCHEDULE_PRIOR_SYNTHETIC");
      return synthetic(schedulePayload(schedule, teamId, start, priorDate));
    }
    const feedMatch = requested.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\.1\/game\/(\d+)\/feed\/live$/);
    if (feedMatch) {
      const gamePk = Number(feedMatch[1]);
      if (gamePk === snapshot.gamePk) throw new Error(`BULLPEN_FULL_TARGET_FEED_FORBIDDEN:${gamePk}`);
      const game = schedule.find((g) => g.gamePk === gamePk);
      if (!game || game.officialDate >= snapshot.officialDate) throw new Error(`BULLPEN_FULL_NON_PRIOR_FEED_FORBIDDEN:${gamePk}`);
      const payload = await fetchJson(requested);
      if (!statusFinal(payload?.gameData?.status)) throw new Error(`BULLPEN_FULL_PRIOR_FEED_NOT_FINAL:${gamePk}`);
      audits.push("PRIOR_FINAL_FEED_OFFICIAL");
      return synthetic(payload);
    }
    throw new Error(`BULLPEN_FULL_UNEXPECTED_RUNTIME_URL:${requested}`);
  };
  return { fetchImpl, now: () => new Date(timecodeIso(snapshot.requestedTimecode)) };
}

async function runStatus(params: {
  snapshot: FrozenSnapshot;
  teamId: number;
  roster: any[];
  current: Map<number, any>;
  schedule: ScheduleGame[];
}): Promise<{ status: BullpenStatus; fingerprint: any; audits: string[]; fallbackSources: Map<number, string> }> {
  const audits: string[] = [];
  const fallbackSources = new Map<number, any>();
  resetMlbBullpenCachesForTests();
  const status = await getBullpenStatus(params.teamId, `TEAM_${params.teamId}`, runtimeFor({ ...params, audits, fallbackSources: fallbackSources as any }));
  if (!ALLOWED_ADJUSTMENTS.has(status.runsAdjustment)) throw new Error(`BULLPEN_FULL_ADJUSTMENT_DRIFT:${status.runsAdjustment}`);
  return { status, fingerprint: decisionFingerprint(status), audits, fallbackSources };
}

async function materializeSide(snapshot: FrozenSnapshot, side: Side, t5Feed: any, schedule: ScheduleGame[]): Promise<SideMaterialization> {
  const teamId = side === "HOME" ? Number(snapshot.homeTeamId) : Number(snapshot.awayTeamId);
  const t5Side = side === "HOME" ? "home" : "away";
  const dateRosterPayload = await fetchJson(`${MLB_V1}/teams/${teamId}/roster?rosterType=Active&date=${snapshot.officialDate}&season=${snapshot.officialDate.slice(0,4)}`);
  const dateRoster = rosterPitchers(dateRosterPayload);
  const t5Roster = t5PitcherRoster(t5Feed?.liveData?.boxscore?.teams?.[t5Side]);
  if (!dateRoster.length) throw new Error(`DATE_ROSTER_EMPTY:${snapshot.gamePk}:${side}`);
  if (!t5Roster.length) throw new Error(`T5_ROSTER_EMPTY:${snapshot.gamePk}:${side}`);
  const dateIds = idsFromRoster(dateRoster);
  const t5Ids = idsFromRoster(t5Roster);
  const unionIds = uniq([...dateIds, ...t5Ids]);
  const bundle = await currentRoleBundle(teamId, snapshot.officialDate, unionIds);
  const [dateRun, t5Run] = await Promise.all([
    runStatus({ snapshot, teamId, roster: dateRoster, current: bundle.current, schedule }),
    runStatus({ snapshot, teamId, roster: t5Roster, current: bundle.current, schedule }),
  ]);
  const parity = canonical(dateRun.fingerprint) === canonical(t5Run.fingerprint);
  const allSources = new Map<number, string>();
  for (const [id, source] of [...dateRun.fallbackSources.entries(), ...t5Run.fallbackSources.entries()]) allSources.set(id, source);
  return {
    eligible: parity,
    reason: parity ? null : "ROSTER_MEMBERSHIP_OR_ORDER_DECISION_AMBIGUOUS",
    runsAdjustment: parity ? dateRun.status.runsAdjustment : null,
    dateFingerprint: dateRun.fingerprint,
    t5Fingerprint: t5Run.fingerprint,
    dateRosterPitcherIds: dateIds,
    t5RosterPitcherIds: t5Ids,
    dateOnlyPitcherIds: setDiff(dateIds, t5Ids),
    t5OnlyPitcherIds: setDiff(t5Ids, dateIds),
    currentRoleLineIds: bundle.currentIds.sort((a,b)=>a-b),
    priorSeasonFallbackIds: [...allSources.entries()].filter(([,v])=>v==="PREVIOUS_SEASON").map(([id])=>id).sort((a,b)=>a-b),
    careerFallbackIds: [...allSources.entries()].filter(([,v])=>v==="CAREER").map(([id])=>id).sort((a,b)=>a-b),
    noStatLineIds: [...allSources.entries()].filter(([,v])=>v==="NO_MLB_STAT_LINE").map(([id])=>id).sort((a,b)=>a-b),
  };
}

async function mapConcurrent<T,R>(values: readonly T[], concurrency: number, fn: (value:T)=>Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= values.length) return;
      out[i] = await fn(values[i]);
    }
  }));
  return out;
}

function packRow(identity: Identity, snapshot: FrozenSnapshot, result: SideMaterialization | null): any {
  const early = identity.horizon === "EARLY_WINDOW";
  const eligible = !early && result?.eligible === true;
  return {
    schemaVersion: PACK_SCHEMA,
    officialDate: identity.officialDate,
    gamePk: identity.gamePk,
    side: identity.side,
    market: identity.market,
    horizon: identity.horizon,
    feature: {
      eligible,
      values: eligible ? { runsAdjustment: result!.runsAdjustment } : null,
      sourceVersion: SOURCE_VERSION,
      sourceTimestampOrPriorWindow: snapshot.requestedTimecode,
      inputStage: "PREGAME_T5",
      missingnessReason: early ? "NOT_APPLICABLE_EARLY_HORIZON" : (eligible ? null : (result?.reason ?? "BULLPEN_SOURCE_UNAVAILABLE")),
    },
  };
}

async function main(): Promise<void> {
  const season = arg("season");
  const lineupHistory = arg("lineup-history");
  const v16Rowset = arg("v16-rowset");
  const contractPath = arg("contract", "research/mlb-r1b-bullpen-full-universe-contract.json");
  const outDir = arg("out-dir");
  const concurrency = Math.max(1, Math.min(8, Number(arg("concurrency", "4"))));
  const contract = readJson(contractPath);
  if (contract.schemaVersion !== CONTRACT_SCHEMA || contract.status !== "FROZEN_BEFORE_FULL_UNIVERSE_MATERIALIZATION") {
    throw new Error("BULLPEN_FULL_CONTRACT_INVALID");
  }
  if (contract.roleStatsPolicy?.authoritativeCurrentSeasonRoute !== CURRENT_ROLE_STATS_AUTHORITY
    || contract.roleStatsPolicy?.crossRouteConsensusRequired !== false) {
    throw new Error("BULLPEN_FULL_ROLE_STATS_AUTHORITY_CONTRACT_DRIFT");
  }
  const lineup = readJson(lineupHistory);
  const snapshots: FrozenSnapshot[] = Array.isArray(lineup?.snapshots) ? lineup.snapshots : [];
  const snapshotByPk = new Map<number, FrozenSnapshot>(snapshots.map((row) => [Number(row.gamePk), row]));
  const identities = parseV16Rowset(v16Rowset);
  const byGame = new Map<number, Identity[]>();
  for (const row of identities) {
    const list = byGame.get(row.gamePk) ?? [];
    list.push(row);
    byGame.set(row.gamePk, list);
  }
  const targets: TargetGame[] = [];
  for (const [gamePk, rows] of byGame) {
    validateGameIdentities(rows);
    const snapshot = snapshotByPk.get(gamePk);
    if (!snapshot || snapshot.complete !== true || snapshot.availability !== "COMPLETE") throw new Error(`BULLPEN_FULL_FROZEN_SNAPSHOT_MISSING:${gamePk}`);
    if (snapshot.officialDate !== rows[0].officialDate || !validTimecode(snapshot.requestedTimecode)
      || easternDate(timecodeIso(snapshot.requestedTimecode)) !== snapshot.officialDate) {
      throw new Error(`BULLPEN_FULL_FROZEN_IDENTITY_DRIFT:${gamePk}`);
    }
    targets.push({ officialDate: rows[0].officialDate, gamePk, identities: rows, snapshot });
  }
  targets.sort((a,b)=>a.officialDate.localeCompare(b.officialDate)||a.gamePk-b.gamePk);
  if (!targets.length) throw new Error("BULLPEN_FULL_EMPTY_UNIVERSE");
  const scheduleStart = `${targets[0].officialDate.slice(0,4)}-03-01`;
  const scheduleEnd = shiftDate(targets[targets.length - 1].officialDate, -1);
  const schedule = await loadSeasonSchedule(scheduleStart, scheduleEnd);
  const hardFailures: any[] = [];
  const gameResults = await mapConcurrent(targets, concurrency, async (target) => {
    try {
      const t5Url = `${MLB_V11}/game/${target.gamePk}/feed/live?timecode=${target.snapshot.requestedTimecode}`;
      const t5Feed = await fetchJson(t5Url);
      validateT5Feed(target.snapshot, t5Feed);
      const [home, away] = await Promise.all([
        materializeSide(target.snapshot, "HOME", t5Feed, schedule),
        materializeSide(target.snapshot, "AWAY", t5Feed, schedule),
      ]);
      return { target, home, away, hardFailure: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transport = error instanceof TransportError || /BULLPEN_FULL_HTTP_|FETCH_FAILED|SOURCE_FETCH|SOURCE_HTTP/.test(message);
      if (transport) hardFailures.push({ gamePk: target.gamePk, officialDate: target.officialDate, error: message });
      const structural: SideMaterialization = {
        eligible: false,
        reason: transport ? "TRANSPORT_FAILURE_NOT_CERTIFIABLE" : message.split(":")[0].slice(0,120),
        runsAdjustment: null,
        dateFingerprint: null,
        t5Fingerprint: null,
        dateRosterPitcherIds: [],
        t5RosterPitcherIds: [],
        dateOnlyPitcherIds: [],
        t5OnlyPitcherIds: [],
        currentRoleLineIds: [],
        priorSeasonFallbackIds: [],
        careerFallbackIds: [],
        noStatLineIds: [],
      };
      return { target, home: structural, away: structural, hardFailure: transport ? message : null };
    }
  });

  if (hardFailures.length) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `transport-failures-${season}.json`), `${JSON.stringify(hardFailures, null, 2)}\n`);
    throw new Error(`BULLPEN_FULL_TRANSPORT_FAILURES:${hardFailures.length}`);
  }

  const packRows: any[] = [];
  const witnessRows: any[] = [];
  for (const game of gameResults) {
    const sideMap = { HOME: game.home, AWAY: game.away } as const;
    for (const identity of game.target.identities) packRows.push(packRow(identity, game.target.snapshot, sideMap[identity.side]));
    witnessRows.push({
      schemaVersion: WITNESS_SCHEMA,
      officialDate: game.target.officialDate,
      gamePk: game.target.gamePk,
      requestedTimecode: game.target.snapshot.requestedTimecode,
      home: game.home,
      away: game.away,
    });
  }
  packRows.sort((a,b)=>a.officialDate.localeCompare(b.officialDate)||a.gamePk-b.gamePk||a.side.localeCompare(b.side)||a.market.localeCompare(b.market)||a.horizon.localeCompare(b.horizon));
  witnessRows.sort((a,b)=>a.officialDate.localeCompare(b.officialDate)||a.gamePk-b.gamePk);
  if (packRows.length !== identities.length || new Set(packRows.map((r)=>identityKey(r))).size !== packRows.length) {
    throw new Error("BULLPEN_FULL_OUTPUT_IDENTITY_DRIFT");
  }
  const early = packRows.filter((r)=>r.horizon==="EARLY_WINDOW");
  if (early.some((r)=>r.feature.eligible!==false||r.feature.missingnessReason!=="NOT_APPLICABLE_EARLY_HORIZON")) {
    throw new Error("BULLPEN_FULL_EARLY_HORIZON_DRIFT");
  }
  const fg = packRows.filter((r)=>r.horizon==="FULL_GAME");
  const eligibleFg = fg.filter((r)=>r.feature.eligible===true);
  const missingFg = fg.filter((r)=>r.feature.eligible!==true);
  if (eligibleFg.some((r)=>!ALLOWED_ADJUSTMENTS.has(Number(r.feature.values?.runsAdjustment)))) throw new Error("BULLPEN_FULL_VALUE_DRIFT");

  fs.mkdirSync(outDir, { recursive: true });
  const packText = packRows.map(canonical).join("\n") + "\n";
  const witnessText = witnessRows.map(canonical).join("\n") + "\n";
  const packPath = path.join(outDir, `bullpen-${season}.jsonl`);
  const witnessPath = path.join(outDir, `bullpen-witness-${season}.jsonl`);
  fs.writeFileSync(packPath, packText);
  fs.writeFileSync(witnessPath, witnessText);
  const reasonCounts: Record<string, number> = {};
  for (const row of missingFg) {
    const reason = String(row.feature.missingnessReason);
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    status: "FULL_UNIVERSE_MATERIALIZED_PENDING_INDEPENDENT_VERIFICATION",
    family: "BULLPEN_FULL_GAME",
    season,
    currentRoleStatsAuthority: CURRENT_ROLE_STATS_AUTHORITY,
    roleStatsRouteSelectionEvidence: "research/mlb-r1b-bullpen-bulk-role-stats-probe-evidence.json",
    gameCount: targets.length,
    rowCount: packRows.length,
    fullGameRows: fg.length,
    eligibleFullGameRows: eligibleFg.length,
    missingFullGameRows: missingFg.length,
    earlyWindowRows: early.length,
    duplicateIdentityCount: 0,
    missingnessReasonCounts: reasonCounts,
    packSha256: sha256(packText),
    witnessSha256: sha256(witnessText),
    networkUniqueRequestCount: networkMemo.size,
    priorFinalFeedUniqueRequestCount: [...networkMemo.keys()].filter((u)=>/\/api\/v1\.1\/game\/\d+\/feed\/live$/.test(u)).length,
    t5FeedUniqueRequestCount: [...networkMemo.keys()].filter((u)=>u.includes("/feed/live?timecode=")).length,
    contractSha256: sha256(fs.readFileSync(contractPath)),
    v16IdentityRowsetSha256: sha256(fs.readFileSync(v16Rowset)),
    policy: {
      researchOnly: true,
      sameDateFinalGameReadAllowed: false,
      marketPricesRead: false,
      modelRefit: false,
      newWeightsCreated: false,
      productionChanged: false,
      r1b2Authorized: false,
      automaticBetPlacement: false,
      realFinancialExposure: 0,
    },
  };
  fs.writeFileSync(path.join(outDir, `bullpen-manifest-${season}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});