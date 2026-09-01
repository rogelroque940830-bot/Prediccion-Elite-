#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  getBullpenStatus,
  resetMlbBullpenCachesForTests,
  type BullpenRuntime,
  type BullpenStatus,
} from "../server/mlb-bullpen";

const SCHEMA = "courtedge-mlb-r1b-bullpen-historical-source-probe.v1";
const MLB_V1 = "https://statsapi.mlb.com/api/v1";
const MLB_V11 = "https://statsapi.mlb.com/api/v1.1";

type Side = "home" | "away";

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
  kind: "ROSTER_DATE" | "CURRENT_SEASON_RANGE" | "CAREER_RANGE" | "RECENT_SCHEDULE_PRIOR_ONLY" | "PASS_THROUGH";
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
    .filter((row) => {
      const requestedIso = isoFromTimecode(String(row.requestedTimecode));
      return easternDate(requestedIso) === String(row.officialDate);
    })
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
    headers: { Accept: "application/json", "User-Agent": "CourtEdge-MLB-R1B-Bullpen-Probe/1.0" },
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

function pitcherIdsFromT5Players(team: any): number[] {
  const players = team?.players && typeof team.players === "object" ? Object.values(team.players) : [];
  return uniqueSorted(players
    .filter((row: any) => String(row?.position?.code ?? "") === "1")
    .map((row: any) => positiveId(row?.person?.id))
    .filter((id: number | null): id is number => id != null));
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
  // The production helper reads payload.stats[0].splits[0].stat. The global
  // /stats endpoint uses that same outer shape, so no numeric transformation
  // is introduced here.
  return payload;
}

function historicalRuntime(snapshot: FrozenSnapshot, audit: FetchAudit[]): BullpenRuntime {
  const requestedIso = isoFromTimecode(snapshot.requestedTimecode);
  const targetDate = snapshot.officialDate;
  const priorDate = shiftDate(targetDate, -1);
  const targetYear = Number(targetDate.slice(0, 4));

  const fetchImpl: NonNullable<BullpenRuntime["fetchImpl"]> = async (input, init) => {
    const requestedUrl = String(input);
    let resolvedUrl = requestedUrl;
    let kind: FetchAudit["kind"] = "PASS_THROUGH";

    const rosterMatch = requestedUrl.match(/^https:\/\/statsapi\.mlb\.com\/api\/v1\/teams\/(\d+)\/roster\?rosterType=Active$/);
    if (rosterMatch) {
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
      return new Response(JSON.stringify(statsShapeFromGlobal(payload)), {
        status: response.status,
        statusText: response.statusText,
        headers: { "content-type": "application/json" },
      });
    }
    return response;
  };

  return { fetchImpl, now: () => new Date(requestedIso) };
}

async function inspectSide(snapshot: FrozenSnapshot, side: Side, t5Feed: any): Promise<any> {
  const teamId = side === "home" ? snapshot.homeTeamId : snapshot.awayTeamId;
  const activeRosterPayload = await fetchJson(`${MLB_V1}/teams/${teamId}/roster?rosterType=Active&date=${snapshot.officialDate}&season=${snapshot.officialDate.slice(0, 4)}`);
  const activePitchers = pitcherIdsFromActiveRoster(activeRosterPayload);
  if (!activePitchers.length) throw new Error(`BULLPEN_PROBE_ACTIVE_ROSTER_EMPTY:${snapshot.gamePk}:${side}`);

  const t5Team = t5Feed?.liveData?.boxscore?.teams?.[side];
  const t5PlayerPitchers = pitcherIdsFromT5Players(t5Team);
  const t5ListedPitchers = listedPitcherIds(t5Team);

  const audit: FetchAudit[] = [];
  resetMlbBullpenCachesForTests();
  const status: BullpenStatus = await getBullpenStatus(teamId, `TEAM_${teamId}`, historicalRuntime(snapshot, audit));

  const targetFeedRead = audit.some((row) => row.resolvedUrl.includes(`/game/${snapshot.gamePk}/feed/live`));
  const sameDateScheduleRead = audit.some((row) => row.resolvedUrl.includes(`endDate=${snapshot.officialDate}`));
  const seasonRangeRequests = audit.filter((row) => row.kind === "CURRENT_SEASON_RANGE").length;
  const careerRangeRequests = audit.filter((row) => row.kind === "CAREER_RANGE").length;
  const rosterDateRequests = audit.filter((row) => row.kind === "ROSTER_DATE").length;
  const recentPriorOnlyRequests = audit.filter((row) => row.kind === "RECENT_SCHEDULE_PRIOR_ONLY").length;

  if (targetFeedRead) throw new Error(`BULLPEN_PROBE_TARGET_FEED_READ:${snapshot.gamePk}:${side}`);
  if (sameDateScheduleRead) throw new Error(`BULLPEN_PROBE_SAME_DATE_SCHEDULE_NOT_REWRITTEN:${snapshot.gamePk}:${side}`);
  if (rosterDateRequests !== 1) throw new Error(`BULLPEN_PROBE_ROSTER_REWRITE_COUNT:${snapshot.gamePk}:${side}:${rosterDateRequests}`);
  if (recentPriorOnlyRequests !== 1) throw new Error(`BULLPEN_PROBE_SCHEDULE_REWRITE_COUNT:${snapshot.gamePk}:${side}:${recentPriorOnlyRequests}`);

  const exactT5PlayerSetMatch = JSON.stringify(activePitchers) === JSON.stringify(t5PlayerPitchers);
  return {
    side,
    teamId,
    rosterComparison: {
      historicalActivePitcherCount: activePitchers.length,
      t5BoxscorePlayerPitcherCount: t5PlayerPitchers.length,
      t5ListedPitcherCount: t5ListedPitchers.length,
      exactT5PlayerSetMatch,
      activeNotInT5Players: setDiff(activePitchers, t5PlayerPitchers),
      t5PlayersNotActive: setDiff(t5PlayerPitchers, activePitchers),
      activeNotInT5ListedPitchers: setDiff(activePitchers, t5ListedPitchers),
      t5ListedPitchersNotActive: setDiff(t5ListedPitchers, activePitchers),
    },
    productionStatus: {
      closerId: status.closer?.id ?? null,
      setupIds: status.setupMen.map((pitcher) => pitcher.id),
      closerAvailable: status.closerAvailable,
      setupAvailable: status.setupAvailable,
      bullpenCompromised: status.bullpenCompromised,
      runsAdjustment: status.runsAdjustment,
      sourceStatus: status.sourceStatus,
      provenance: status.provenance,
    },
    historicalAdapterAudit: {
      targetFeedRead,
      sameDateScheduleRead,
      rosterDateRequests,
      seasonRangeRequests,
      careerRangeRequests,
      recentPriorOnlyRequests,
      totalFetches: audit.length,
    },
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

  const [home, away] = await Promise.all([
    inspectSide(snapshot, "home", t5Feed),
    inspectSide(snapshot, "away", t5Feed),
  ]);
  const exactT5RosterParityBothSides = home.rosterComparison.exactT5PlayerSetMatch && away.rosterComparison.exactT5PlayerSetMatch;
  const noTargetOutcomeRead = !home.historicalAdapterAudit.targetFeedRead && !away.historicalAdapterAudit.targetFeedRead;
  const currentSeasonRangeUsed = home.historicalAdapterAudit.seasonRangeRequests > 0 && away.historicalAdapterAudit.seasonRangeRequests > 0;

  const report = {
    schemaVersion: SCHEMA,
    season: args.season,
    classification: exactT5RosterParityBothSides
      ? "T5_BOXSCORE_PITCHERS_MATCH_HISTORICAL_ACTIVE_ROSTER_ON_SAMPLE"
      : "T5_BOXSCORE_PITCHERS_DO_NOT_EXACTLY_MATCH_HISTORICAL_ACTIVE_ROSTER_ON_SAMPLE",
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
      exactT5RosterParityBothSides,
      historicalRosterDateEndpointUsable: true,
      currentSeasonRangeUsed,
      currentSeasonStatsClosedAtPriorDate: true,
      recentScheduleClosedAtPriorDate: true,
      noTargetOutcomeRead,
      marketPricesRead: false,
      v66UsedAsExactSubstitute: false,
    },
    policy: {
      researchOnly: true,
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

  if (!noTargetOutcomeRead) throw new Error(`BULLPEN_PROBE_TARGET_OUTCOME_BOUNDARY:${snapshot.gamePk}`);
  if (!currentSeasonRangeUsed) throw new Error(`BULLPEN_PROBE_CURRENT_RANGE_NOT_USED:${snapshot.gamePk}`);
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    season: report.season,
    classification: report.classification,
    gamePk: snapshot.gamePk,
    exactT5RosterParityBothSides,
    homeRunsAdjustment: home.productionStatus.runsAdjustment,
    awayRunsAdjustment: away.productionStatus.runsAdjustment,
    noTargetOutcomeRead,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
