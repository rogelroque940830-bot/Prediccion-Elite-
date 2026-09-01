#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  getBullpenStatus,
  resetMlbBullpenCachesForTests,
  type BullpenPitcher,
  type BullpenRuntime,
  type BullpenStatus,
} from "../server/mlb-bullpen";

const SCHEMA = "courtedge-mlb-r1b-bullpen-historical-source-probe.v2";
const MLB_V1 = "https://statsapi.mlb.com/api/v1";
const MLB_V11 = "https://statsapi.mlb.com/api/v1.1";

type Side = "home" | "away";
type RosterMode = "DATE_ROSTER" | "T5_ROSTER";

type Args = {
  season: string;
  lineupHistory: string;
  out: string;
};

type FrozenSnapshot = {
  gamePk: number;
  officialDate: string;
  requestedTimecode: string;
  sourceMetadataTimecode?: string | null;
  homeTeamId: number;
  awayTeamId: number;
  complete?: boolean;
  availability?: string;
};

type FetchAudit = {
  requestedUrl: string;
  resolvedUrl: string;
  kind:
    | "ROSTER_DATE"
    | "T5_ROSTER_INJECTED"
    | "CURRENT_SEASON_RANGE"
    | "CAREER_RANGE"
    | "RECENT_SCHEDULE_PRIOR_ONLY"
    | "PASS_THROUGH";
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw new Error(`BULLPEN_PROBE_BAD_ARG:${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`BULLPEN_PROBE_MISSING_ARG:${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }
  const season = values.get("season");
  const lineupHistory = values.get("lineup-history");
  const out = values.get("out");
  if (!season || !lineupHistory || !out) throw new Error("BULLPEN_PROBE_REQUIRED_ARGS_MISSING");
  return { season, lineupHistory, out };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isoFromTimecode(value: string): string {
  if (!/^\d{8}_\d{6}$/.test(value)) throw new Error(`BULLPEN_PROBE_BAD_TIMECODE:${value}`);
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
  if (!Number.isFinite(Date.parse(iso))) throw new Error(`BULLPEN_PROBE_BAD_TIMECODE:${value}`);
  return iso;
}

function easternDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function yearStart(date: string): string {
  return `${date.slice(0, 4)}-03-01`;
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function chooseSnapshot(payload: any, season: string): FrozenSnapshot {
  const rows: FrozenSnapshot[] = Array.isArray(payload?.snapshots)
    ? payload.snapshots
    : Array.isArray(payload?.rows)
      ? payload.rows
      : [];
  const calendarYear = season === "2026_YTD" ? "2026" : season;
  const floor = `${calendarYear}-06-15`;
  const candidates = rows
    .filter((row) => row && row.complete === true && row.availability === "COMPLETE")
    .filter((row) => String(row.officialDate ?? "") >= floor)
    .filter((row) => /^\d{8}_\d{6}$/.test(String(row.requestedTimecode ?? "")))
    .filter((row) => easternDate(isoFromTimecode(String(row.requestedTimecode))) === String(row.officialDate))
    .sort((a, b) => String(a.officialDate).localeCompare(String(b.officialDate)) || Number(a.gamePk) - Number(b.gamePk));
  const selected = candidates[0];
  if (!selected) throw new Error(`BULLPEN_PROBE_NO_SAMPLE:${season}`);
  for (const key of ["gamePk", "homeTeamId", "awayTeamId"] as const) {
    if (!positiveId(selected[key])) throw new Error(`BULLPEN_PROBE_BAD_SAMPLE_ID:${key}`);
  }
  return selected;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "CourtEdge-MLB-R1B-Bullpen-Probe/2.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`BULLPEN_PROBE_HTTP_${response.status}:${url}`);
  return response.json();
}

function pitcherIdsFromActiveRoster(payload: any): number[] {
  const roster = Array.isArray(payload?.roster) ? payload.roster : [];
  return uniqueSorted(roster
    .filter((row: any) => String(row?.position?.code ?? "") === "1")
    .map((row: any) => positiveId(row?.person?.id))
    .filter((id: number | null): id is number => id != null));
}

function t5PitcherRoster(team: any): any[] {
  const players = team?.players && typeof team.players === "object" ? Object.values(team.players) : [];
  const pitchers = players
    .filter((row: any) => String(row?.position?.code ?? "") === "1" && positiveId(row?.person?.id) != null)
    .map((row: any) => ({
      person: {
        id: Number(row.person.id),
        fullName: String(row?.person?.fullName ?? `PITCHER_${row.person.id}`),
      },
      position: { code: "1" },
    }));
  const seen = new Set<number>();
  return pitchers.filter((row: any) => {
    const id = Number(row.person.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function pitcherIdsFromT5Players(team: any): number[] {
  return uniqueSorted(t5PitcherRoster(team).map((row: any) => Number(row.person.id)));
}

function listedPitcherIds(team: any): number[] {
  return uniqueSorted((Array.isArray(team?.pitchers) ? team.pitchers : [])
    .map(positiveId)
    .filter((id: number | null): id is number => id != null));
}

function setDiff(left: number[], right: number[]): number[] {
  const r = new Set(right);
  return left.filter((value) => !r.has(value));
}

function statsShapeFromGlobal(payload: any): any {
  return payload;
}

function syntheticJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function historicalRuntime(
  snapshot: FrozenSnapshot,
  audit: FetchAudit[],
  rosterMode: RosterMode,
  t5Team: any,
): BullpenRuntime {
  const requestedIso = isoFromTimecode(snapshot.requestedTimecode);
  const targetDate = snapshot.officialDate;
  const priorDate = shiftDate(targetDate, -1);
  const targetYear = Number(targetDate.slice(0, 4));
  const frozenT5Roster = t5PitcherRoster(t5Team);
  if (!frozenT5Roster.length) throw new Error(`BULLPEN_PROBE_T5_ROSTER_EMPTY:${snapshot.gamePk}`);

  const fetchImpl: NonNullable<BullpenRuntime["fetchImpl"]> = async (input, init) => {
    const requestedUrl = String(input);
    let resolvedUrl = requestedUrl;
    let kind: FetchAudit["kind"] = "PASS_THROUGH";

    const rosterMatch = requestedUrl.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\/teams\/(\d+)\/roster\?rosterType=Active$/);
    if (rosterMatch) {
      if (rosterMode === "T5_ROSTER") {
        kind = "T5_ROSTER_INJECTED";
        resolvedUrl = `frozen-t5://game/${snapshot.gamePk}/team/${rosterMatch[1]}/pitchers`;
        audit.push({ requestedUrl, resolvedUrl, kind });
        return syntheticJsonResponse({ roster: frozenT5Roster });
      }
      resolvedUrl = `${requestedUrl}&date=${targetDate}&season=${targetYear}`;
      kind = "ROSTER_DATE";
    }

    const seasonMatch = requestedUrl.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\/people\/(\d+)\/stats\?stats=season&group=pitching&season=(\d{4})$/);
    if (seasonMatch && Number(seasonMatch[2]) === targetYear) {
      resolvedUrl = `${MLB_V1}/stats?stats=byDateRange&group=pitching&personId=${seasonMatch[1]}&startDate=${yearStart(targetDate)}&endDate=${priorDate}`;
      kind = "CURRENT_SEASON_RANGE";
    }

    const careerMatch = requestedUrl.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\/people\/(\d+)\/stats\?stats=career&group=pitching$/);
    if (careerMatch) {
      resolvedUrl = `${MLB_V1}/stats?stats=byDateRange&group=pitching&personId=${careerMatch[1]}&startDate=1900-01-01&endDate=${priorDate}`;
      kind = "CAREER_RANGE";
    }

    if (requestedUrl.startsWith(`${MLB_V1}/schedule?`) && requestedUrl.includes(`endDate=${targetDate}`)) {
      resolvedUrl = requestedUrl.replace(`endDate=${targetDate}`, `endDate=${priorDate}`);
      kind = "RECENT_SCHEDULE_PRIOR_ONLY";
    }

    audit.push({ requestedUrl, resolvedUrl, kind });
    const response = await fetch(resolvedUrl, init);
    if (!response.ok) return response;

    if (kind === "CURRENT_SEASON_RANGE" || kind === "CAREER_RANGE") {
      const payload = await response.json();
      return syntheticJsonResponse(statsShapeFromGlobal(payload));
    }
    return response;
  };

  return { fetchImpl, now: () => new Date(requestedIso) };
}

function pitcherFingerprint(pitcher: BullpenPitcher | null): any {
  if (!pitcher) return null;
  return {
    id: pitcher.id,
    role: pitcher.role,
    saves: pitcher.saves ?? null,
    holds: pitcher.holds ?? null,
    era: pitcher.era ?? null,
    whip: pitcher.whip ?? null,
    k9: pitcher.k9 ?? null,
    availability: pitcher.availability,
    availabilityProb: pitcher.availabilityProb,
    totalPitchesLast3Days: pitcher.totalPitchesLast3Days,
    consecutiveDays: pitcher.consecutiveDays,
    lastUsed: pitcher.lastUsed ?? null,
  };
}

function sportingFingerprint(status: BullpenStatus): any {
  return {
    closer: pitcherFingerprint(status.closer),
    setupMen: status.setupMen.map(pitcherFingerprint),
    middleRelievers: status.middleRelievers.map(pitcherFingerprint),
    closerAvailable: status.closerAvailable,
    setupAvailable: status.setupAvailable,
    bullpenCompromised: status.bullpenCompromised,
    predictedCloser: pitcherFingerprint(status.predictedCloser),
    runsAdjustment: status.runsAdjustment,
  };
}

function outputIds(fingerprint: any): number[] {
  const ids: number[] = [];
  const add = (value: any) => {
    const id = positiveId(value?.id);
    if (id) ids.push(id);
  };
  add(fingerprint?.closer);
  for (const row of fingerprint?.setupMen ?? []) add(row);
  for (const row of fingerprint?.middleRelievers ?? []) add(row);
  add(fingerprint?.predictedCloser);
  return uniqueSorted(ids);
}

function auditSummary(snapshot: FrozenSnapshot, rosterMode: RosterMode, audit: FetchAudit[]): any {
  const targetFeedRead = audit.some((row) => row.resolvedUrl.includes(`/game/${snapshot.gamePk}/feed/live`));
  const sameDateScheduleRead = audit.some((row) => row.resolvedUrl.includes(`endDate=${snapshot.officialDate}`));
  const rosterDateRequests = audit.filter((row) => row.kind === "ROSTER_DATE").length;
  const t5RosterInjections = audit.filter((row) => row.kind === "T5_ROSTER_INJECTED").length;
  const seasonRangeRequests = audit.filter((row) => row.kind === "CURRENT_SEASON_RANGE").length;
  const careerRangeRequests = audit.filter((row) => row.kind === "CAREER_RANGE").length;
  const recentPriorOnlyRequests = audit.filter((row) => row.kind === "RECENT_SCHEDULE_PRIOR_ONLY").length;

  if (targetFeedRead) throw new Error(`BULLPEN_PROBE_TARGET_FEED_READ:${snapshot.gamePk}:${rosterMode}`);
  if (sameDateScheduleRead) throw new Error(`BULLPEN_PROBE_SAME_DATE_SCHEDULE_NOT_REWRITTEN:${snapshot.gamePk}:${rosterMode}`);
  if (rosterMode === "DATE_ROSTER" && rosterDateRequests !== 1) {
    throw new Error(`BULLPEN_PROBE_DATE_ROSTER_REWRITE_COUNT:${snapshot.gamePk}:${rosterDateRequests}`);
  }
  if (rosterMode === "T5_ROSTER" && t5RosterInjections !== 1) {
    throw new Error(`BULLPEN_PROBE_T5_ROSTER_INJECTION_COUNT:${snapshot.gamePk}:${t5RosterInjections}`);
  }
  if (recentPriorOnlyRequests !== 1) {
    throw new Error(`BULLPEN_PROBE_SCHEDULE_REWRITE_COUNT:${snapshot.gamePk}:${rosterMode}:${recentPriorOnlyRequests}`);
  }

  return {
    targetFeedRead,
    sameDateScheduleRead,
    rosterDateRequests,
    t5RosterInjections,
    seasonRangeRequests,
    careerRangeRequests,
    recentPriorOnlyRequests,
    totalFetches: audit.length,
  };
}

async function runProductionStatus(
  snapshot: FrozenSnapshot,
  teamId: number,
  t5Team: any,
  rosterMode: RosterMode,
): Promise<{ status: BullpenStatus; fingerprint: any; audit: any }> {
  const audit: FetchAudit[] = [];
  resetMlbBullpenCachesForTests();
  const status = await getBullpenStatus(teamId, `TEAM_${teamId}`, historicalRuntime(snapshot, audit, rosterMode, t5Team));
  return { status, fingerprint: sportingFingerprint(status), audit: auditSummary(snapshot, rosterMode, audit) };
}

async function inspectSide(snapshot: FrozenSnapshot, side: Side, t5Feed: any): Promise<any> {
  const teamId = side === "home" ? snapshot.homeTeamId : snapshot.awayTeamId;
  const activeRosterPayload = await fetchJson(`${MLB_V1}/teams/${teamId}/roster?rosterType=Active&date=${snapshot.officialDate}&season=${snapshot.officialDate.slice(0, 4)}`);
  const activePitchers = pitcherIdsFromActiveRoster(activeRosterPayload);
  if (!activePitchers.length) throw new Error(`BULLPEN_PROBE_ACTIVE_ROSTER_EMPTY:${snapshot.gamePk}:${side}`);

  const t5Team = t5Feed?.liveData?.boxscore?.teams?.[side];
  const t5PlayerPitchers = pitcherIdsFromT5Players(t5Team);
  const t5ListedPitchers = listedPitcherIds(t5Team);
  if (!t5PlayerPitchers.length) throw new Error(`BULLPEN_PROBE_T5_PLAYER_PITCHERS_EMPTY:${snapshot.gamePk}:${side}`);

  const dateRun = await runProductionStatus(snapshot, teamId, t5Team, "DATE_ROSTER");
  const t5Run = await runProductionStatus(snapshot, teamId, t5Team, "T5_ROSTER");
  const exactT5PlayerSetMatch = JSON.stringify(activePitchers) === JSON.stringify(t5PlayerPitchers);
  const effectiveOutputParity = JSON.stringify(dateRun.fingerprint) === JSON.stringify(t5Run.fingerprint);
  const t5Only = setDiff(t5PlayerPitchers, activePitchers);
  const dateOnly = setDiff(activePitchers, t5PlayerPitchers);
  const dateOutputIds = outputIds(dateRun.fingerprint);
  const t5OutputIds = outputIds(t5Run.fingerprint);

  return {
    side,
    teamId,
    rosterComparison: {
      historicalActivePitcherCount: activePitchers.length,
      t5BoxscorePlayerPitcherCount: t5PlayerPitchers.length,
      t5ListedPitcherCount: t5ListedPitchers.length,
      exactT5PlayerSetMatch,
      activeNotInT5Players: dateOnly,
      t5PlayersNotActive: t5Only,
      activeNotInT5ListedPitchers: setDiff(activePitchers, t5ListedPitchers),
      t5ListedPitchersNotActive: setDiff(t5ListedPitchers, activePitchers),
    },
    effectiveComparison: {
      exactSportingOutputParity: effectiveOutputParity,
      dateRosterOutputIds: dateOutputIds,
      t5RosterOutputIds: t5OutputIds,
      dateOnlyRosterIdsVisibleInDateOutput: dateOnly.filter((id) => dateOutputIds.includes(id)),
      t5OnlyRosterIdsVisibleInT5Output: t5Only.filter((id) => t5OutputIds.includes(id)),
      runsAdjustmentParity: dateRun.status.runsAdjustment === t5Run.status.runsAdjustment,
      dateRunsAdjustment: dateRun.status.runsAdjustment,
      t5RunsAdjustment: t5Run.status.runsAdjustment,
    },
    productionStatus: {
      closerId: dateRun.status.closer?.id ?? null,
      setupIds: dateRun.status.setupMen.map((pitcher) => pitcher.id),
      closerAvailable: dateRun.status.closerAvailable,
      setupAvailable: dateRun.status.setupAvailable,
      bullpenCompromised: dateRun.status.bullpenCompromised,
      runsAdjustment: dateRun.status.runsAdjustment,
      sourceStatus: dateRun.status.sourceStatus,
      provenance: dateRun.status.provenance,
    },
    t5ProductionStatus: {
      closerId: t5Run.status.closer?.id ?? null,
      setupIds: t5Run.status.setupMen.map((pitcher) => pitcher.id),
      closerAvailable: t5Run.status.closerAvailable,
      setupAvailable: t5Run.status.setupAvailable,
      bullpenCompromised: t5Run.status.bullpenCompromised,
      runsAdjustment: t5Run.status.runsAdjustment,
      sourceStatus: t5Run.status.sourceStatus,
      provenance: t5Run.status.provenance,
    },
    sportingFingerprints: {
      dateRoster: dateRun.fingerprint,
      t5Roster: t5Run.fingerprint,
    },
    historicalAdapterAudit: dateRun.audit,
    t5HistoricalAdapterAudit: t5Run.audit,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const source = readJson(args.lineupHistory);
  const snapshot = chooseSnapshot(source, args.season);
  const requestedIso = isoFromTimecode(snapshot.requestedTimecode);
  if (snapshot.sourceMetadataTimecode && snapshot.sourceMetadataTimecode > snapshot.requestedTimecode) {
    throw new Error(`BULLPEN_PROBE_SOURCE_AFTER_REQUESTED:${snapshot.gamePk}`);
  }

  const t5Url = `${MLB_V11}/game/${snapshot.gamePk}/feed/live?timecode=${snapshot.requestedTimecode}`;
  const t5Feed = await fetchJson(t5Url);
  const sourceTimecode = String(t5Feed?.metaData?.timeStamp ?? "");
  if (!/^\d{8}_\d{6}$/.test(sourceTimecode) || sourceTimecode > snapshot.requestedTimecode) {
    throw new Error(`BULLPEN_PROBE_T5_TIMECODE_INVALID:${snapshot.gamePk}:${sourceTimecode}`);
  }
  if (Number(t5Feed?.gamePk) !== Number(snapshot.gamePk)) throw new Error(`BULLPEN_PROBE_T5_GAME_IDENTITY:${snapshot.gamePk}`);
  if (Number(t5Feed?.gameData?.teams?.home?.id) !== Number(snapshot.homeTeamId)) throw new Error(`BULLPEN_PROBE_T5_HOME_IDENTITY:${snapshot.gamePk}`);
  if (Number(t5Feed?.gameData?.teams?.away?.id) !== Number(snapshot.awayTeamId)) throw new Error(`BULLPEN_PROBE_T5_AWAY_IDENTITY:${snapshot.gamePk}`);

  const home = await inspectSide(snapshot, "home", t5Feed);
  const away = await inspectSide(snapshot, "away", t5Feed);
  const exactT5RosterParityBothSides = home.rosterComparison.exactT5PlayerSetMatch && away.rosterComparison.exactT5PlayerSetMatch;
  const effectiveSportingOutputParityBothSides = home.effectiveComparison.exactSportingOutputParity && away.effectiveComparison.exactSportingOutputParity;
  const runsAdjustmentParityBothSides = home.effectiveComparison.runsAdjustmentParity && away.effectiveComparison.runsAdjustmentParity;
  const noTargetOutcomeRead = !home.historicalAdapterAudit.targetFeedRead
    && !away.historicalAdapterAudit.targetFeedRead
    && !home.t5HistoricalAdapterAudit.targetFeedRead
    && !away.t5HistoricalAdapterAudit.targetFeedRead;
  const currentSeasonRangeUsed = home.historicalAdapterAudit.seasonRangeRequests > 0
    && away.historicalAdapterAudit.seasonRangeRequests > 0
    && home.t5HistoricalAdapterAudit.seasonRangeRequests > 0
    && away.t5HistoricalAdapterAudit.seasonRangeRequests > 0;

  const report = {
    schemaVersion: SCHEMA,
    season: args.season,
    classification: effectiveSportingOutputParityBothSides
      ? "DATE_AND_T5_ROSTER_EFFECTIVE_BULLPEN_OUTPUT_PARITY_ON_SAMPLE"
      : "DATE_AND_T5_ROSTER_EFFECTIVE_BULLPEN_OUTPUT_MISMATCH_ON_SAMPLE",
    sample: {
      gamePk: snapshot.gamePk,
      officialDate: snapshot.officialDate,
      requestedTimecode: snapshot.requestedTimecode,
      requestedIso,
      sourceMetadataTimecode: sourceTimecode,
      homeTeamId: snapshot.homeTeamId,
      awayTeamId: snapshot.awayTeamId,
    },
    home,
    away,
    findings: {
      productionGetBullpenStatusReused: true,
      historicalRosterDateEndpointUsable: true,
      t5BoxscorePlayersRosterInjectionUsable: true,
      exactT5RosterParityBothSides,
      effectiveSportingOutputParityBothSides,
      runsAdjustmentParityBothSides,
      currentSeasonStatsClosedAtPriorDate: currentSeasonRangeUsed,
      recentScheduleClosedAtPriorDate: true,
      noTargetOutcomeRead,
      marketPricesRead: false,
      v66UsedAsExactSubstitute: false,
      rawRosterParityRequiredForProbeSuccess: false,
      effectiveOutputParityRequiredForProbeSuccess: false,
      sampleOnlyNotFullUniverseCertification: true,
    },
    policy: {
      researchOnly: true,
      t5SourceMustBeAtOrBeforeRequestedTimecode: true,
      targetOutcomeFieldsAllowed: false,
      sameDateFinalGameReadAllowed: false,
      futureSeasonAggregateAllowed: false,
      marketPricesAllowed: false,
      modelRefitAllowed: false,
      newWeightsAllowed: false,
      productionChangeAllowed: false,
      r1b2AuthorizationChanged: false,
    },
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    season: report.season,
    classification: report.classification,
    gamePk: report.sample.gamePk,
    rawRosterParityBothSides: exactT5RosterParityBothSides,
    effectiveSportingOutputParityBothSides,
    runsAdjustmentParityBothSides,
    homeRawRosterParity: home.rosterComparison.exactT5PlayerSetMatch,
    awayRawRosterParity: away.rosterComparison.exactT5PlayerSetMatch,
    homeDateRunsAdjustment: home.effectiveComparison.dateRunsAdjustment,
    homeT5RunsAdjustment: home.effectiveComparison.t5RunsAdjustment,
    awayDateRunsAdjustment: away.effectiveComparison.dateRunsAdjustment,
    awayT5RunsAdjustment: away.effectiveComparison.t5RunsAdjustment,
    noTargetOutcomeRead,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
