#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-bullpen-t5-seasonstats-probe.v1";
const MLB_V1 = "https://statsapi.mlb.com/api/v1";
const MLB_V11 = "https://statsapi.mlb.com/api/v1.1";

type Args = { season: string; lineupHistory: string; out: string };
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

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`BULLPEN_T5_STATS_BAD_ARG:${key}`);
    values.set(key.slice(2), value);
  }
  const season = values.get("season");
  const lineupHistory = values.get("lineup-history");
  const out = values.get("out");
  if (!season || !lineupHistory || !out) throw new Error("BULLPEN_T5_STATS_REQUIRED_ARGS_MISSING");
  return { season, lineupHistory, out };
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isoFromTimecode(value: string): string {
  if (!/^\d{8}_\d{6}$/.test(value)) throw new Error(`BULLPEN_T5_STATS_BAD_TIMECODE:${value}`);
  return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}.000Z`;
}

function easternDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function chooseSnapshot(payload: any, season: string): FrozenSnapshot {
  const rows: FrozenSnapshot[] = Array.isArray(payload?.snapshots) ? payload.snapshots : Array.isArray(payload?.rows) ? payload.rows : [];
  const year = season === "2026_YTD" ? "2026" : season;
  const floor = `${year}-06-15`;
  const candidates = rows
    .filter((row) => row?.complete === true && row?.availability === "COMPLETE")
    .filter((row) => String(row.officialDate ?? "") >= floor)
    .filter((row) => /^\d{8}_\d{6}$/.test(String(row.requestedTimecode ?? "")))
    .filter((row) => easternDate(isoFromTimecode(String(row.requestedTimecode))) === String(row.officialDate))
    .sort((a, b) => String(a.officialDate).localeCompare(String(b.officialDate)) || Number(a.gamePk) - Number(b.gamePk));
  const selected = candidates[0];
  if (!selected) throw new Error(`BULLPEN_T5_STATS_NO_SAMPLE:${season}`);
  return selected;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "CourtEdge-MLB-R1B-Bullpen-T5-Stats-Probe/1.0" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`BULLPEN_T5_STATS_HTTP_${response.status}:${url}`);
  return response.json();
}

function statLine(payload: any): any | null {
  return payload?.stats?.[0]?.splits?.[0]?.stat ?? null;
}

function parseIP(value: unknown): number {
  const text = String(value ?? "0");
  const [whole, outs] = text.split(".");
  return (parseInt(whole || "0", 10) || 0) + (parseInt(outs || "0", 10) || 0) / 3;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRoleFields(stat: any): any {
  if (!stat) return null;
  return {
    gamesStarted: Math.trunc(num(stat.gamesStarted)),
    gamesPlayed: Math.trunc(num(stat.gamesPlayed)),
    inningsPitched: Math.round(parseIP(stat.inningsPitched) * 1_000_000) / 1_000_000,
    saves: Math.trunc(num(stat.saves)),
    holds: Math.trunc(num(stat.holds)),
  };
}

function normalizeQualityFields(stat: any): any {
  if (!stat) return null;
  const maybe = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 1_000_000) / 1_000_000 : null;
  };
  return {
    era: maybe(stat.era),
    whip: maybe(stat.whip),
    strikeoutsPer9Inn: maybe(stat.strikeoutsPer9Inn),
  };
}

function pitcherRows(team: any): any[] {
  const players = team?.players && typeof team.players === "object" ? Object.values(team.players) : [];
  return players
    .filter((row: any) => String(row?.position?.code ?? "") === "1" && Number.isInteger(Number(row?.person?.id)))
    .sort((a: any, b: any) => Number(a.person.id) - Number(b.person.id));
}

async function inspectSide(snapshot: FrozenSnapshot, side: "home" | "away", feed: any): Promise<any> {
  const team = feed?.liveData?.boxscore?.teams?.[side];
  if (!team) throw new Error(`BULLPEN_T5_STATS_TEAM_MISSING:${snapshot.gamePk}:${side}`);
  const rows = pitcherRows(team);
  if (!rows.length) throw new Error(`BULLPEN_T5_STATS_PITCHERS_MISSING:${snapshot.gamePk}:${side}`);
  const priorDate = shiftDate(snapshot.officialDate, -1);
  const yearStart = `${snapshot.officialDate.slice(0,4)}-03-01`;
  const comparisons: any[] = [];
  for (const row of rows) {
    const pitcherId = Number(row.person.id);
    const t5Stat = row?.seasonStats?.pitching ?? null;
    const range = await fetchJson(`${MLB_V1}/stats?stats=byDateRange&group=pitching&personId=${pitcherId}&startDate=${yearStart}&endDate=${priorDate}`);
    const rangeStat = statLine(range);
    const t5Role = normalizeRoleFields(t5Stat);
    const rangeRole = normalizeRoleFields(rangeStat);
    const t5Quality = normalizeQualityFields(t5Stat);
    const rangeQuality = normalizeQualityFields(rangeStat);
    comparisons.push({
      pitcherId,
      t5SeasonStatsPresent: t5Stat != null,
      byDateRangePresent: rangeStat != null,
      roleFieldsExact: JSON.stringify(t5Role) === JSON.stringify(rangeRole),
      qualityFieldsExact: JSON.stringify(t5Quality) === JSON.stringify(rangeQuality),
      t5Role,
      rangeRole,
      t5Quality,
      rangeQuality,
    });
  }
  const present = comparisons.filter((row) => row.t5SeasonStatsPresent).length;
  const roleExact = comparisons.filter((row) => row.roleFieldsExact).length;
  const qualityExact = comparisons.filter((row) => row.qualityFieldsExact).length;
  return {
    pitcherCount: comparisons.length,
    t5SeasonStatsPresentCount: present,
    t5SeasonStatsCoverage: present / comparisons.length,
    roleFieldsExactCount: roleExact,
    roleFieldsExactShare: roleExact / comparisons.length,
    qualityFieldsExactCount: qualityExact,
    qualityFieldsExactShare: qualityExact / comparisons.length,
    comparisons,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const history = readJson(args.lineupHistory);
  const snapshot = chooseSnapshot(history, args.season);
  const t5Url = `${MLB_V11}/game/${snapshot.gamePk}/feed/live?timecode=${snapshot.requestedTimecode}`;
  const feed = await fetchJson(t5Url);
  if (Number(feed?.gamePk) !== Number(snapshot.gamePk)) throw new Error("BULLPEN_T5_STATS_GAME_IDENTITY_MISMATCH");
  const sourceTime = String(feed?.metaData?.timeStamp ?? "");
  if (!/^\d{8}_\d{6}$/.test(sourceTime) || sourceTime > snapshot.requestedTimecode) throw new Error("BULLPEN_T5_STATS_SOURCE_TIME_AFTER_REQUEST");
  if (Number(feed?.gameData?.teams?.home?.id) !== Number(snapshot.homeTeamId) || Number(feed?.gameData?.teams?.away?.id) !== Number(snapshot.awayTeamId)) {
    throw new Error("BULLPEN_T5_STATS_TEAM_IDENTITY_MISMATCH");
  }
  const home = await inspectSide(snapshot, "home", feed);
  const away = await inspectSide(snapshot, "away", feed);
  const all = [...home.comparisons, ...away.comparisons];
  const roleExactAll = all.length > 0 && all.every((row) => row.roleFieldsExact);
  const t5PresentAll = all.length > 0 && all.every((row) => row.t5SeasonStatsPresent);
  const classification = t5PresentAll && roleExactAll
    ? "T5_SEASON_STATS_ROLE_FIELDS_EXACT_ON_SAMPLE"
    : t5PresentAll
      ? "T5_SEASON_STATS_PRESENT_ROLE_FIELDS_DIFFER_ON_SAMPLE"
      : "T5_SEASON_STATS_INCOMPLETE_ON_SAMPLE";
  const report = {
    schemaVersion: SCHEMA,
    season: args.season,
    classification,
    sample: {
      gamePk: snapshot.gamePk,
      officialDate: snapshot.officialDate,
      requestedTimecode: snapshot.requestedTimecode,
      sourceMetadataTimecode: sourceTime,
      homeTeamId: snapshot.homeTeamId,
      awayTeamId: snapshot.awayTeamId,
    },
    home,
    away,
    findings: {
      t5FeedCarriesAllPitcherSeasonStatsOnSample: t5PresentAll,
      t5RoleCriticalFieldsMatchPriorDateRangeOnSample: roleExactAll,
      qualityFieldsAllExactOnSample: all.length > 0 && all.every((row) => row.qualityFieldsExact),
      sampleOnlyNotFullUniverseCertification: true,
      noTargetOutcomeRead: true,
      marketPricesRead: false,
    },
    policy: {
      researchOnly: true,
      targetOutcomeFieldsAllowed: false,
      marketPricesAllowed: false,
      modelRefitAllowed: false,
      newWeightsAllowed: false,
      productionChangeAllowed: false,
      r1b2AuthorizationChanged: false,
      favorableResultRequiredForWorkflowSuccess: false,
    },
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    season: report.season,
    classification: report.classification,
    gamePk: report.sample.gamePk,
    homeCoverage: home.t5SeasonStatsCoverage,
    awayCoverage: away.t5SeasonStatsCoverage,
    homeRoleExactShare: home.roleFieldsExactShare,
    awayRoleExactShare: away.roleFieldsExactShare,
    roleExactAll,
    noTargetOutcomeRead: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
