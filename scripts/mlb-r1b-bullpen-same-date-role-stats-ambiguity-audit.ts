#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-bullpen-same-date-role-stats-ambiguity.v1";
const MLB_V1 = "https://statsapi.mlb.com/api/v1";

type Side = "HOME" | "AWAY";
type Identity = { officialDate: string; gamePk: number; side: Side; market: string; horizon: string };
type Snapshot = {
  gamePk: number;
  officialDate: string;
  requestedTimecode: string;
  homeTeamId: number;
  awayTeamId: number;
};
type ScheduledGame = {
  gamePk: number;
  officialDate: string;
  scheduledStart: string;
  homeTeamId: number;
  awayTeamId: number;
};

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`BULLPEN_SAMEDATE_ARG_MISSING:${name}`);
  return process.argv[i + 1];
}
function positiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));
}
function timecodeIso(value: string): string {
  if (!/^\d{8}_\d{6}$/.test(value)) throw new Error(`BULLPEN_SAMEDATE_BAD_TIMECODE:${value}`);
  return `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}.000Z`;
}
async function fetchJson(url: string): Promise<any> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "CourtEdge-R1B-Bullpen-SameDate-Audit/1.0" },
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok) return response.json();
      last = new Error(`BULLPEN_SAMEDATE_HTTP_${response.status}`);
      if (![408,425,429].includes(response.status) && response.status < 500) throw last;
    } catch (error) {
      last = error;
    }
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** (attempt - 1)));
  }
  throw last instanceof Error ? last : new Error("BULLPEN_SAMEDATE_FETCH_FAILED");
}
function readV16(file: string): Identity[] {
  const rows: Identity[] = [];
  const seen = new Set<string>();
  for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    const gamePk = positiveInt(raw.gamePk);
    const officialDate = String(raw.officialDate ?? "");
    const side = String(raw.side ?? "") as Side;
    const market = String(raw.market ?? "");
    const horizon = String(raw.horizon ?? "");
    if (!gamePk || !validDate(officialDate) || !["HOME","AWAY"].includes(side)) {
      throw new Error(`BULLPEN_SAMEDATE_BAD_V16_IDENTITY:${index + 1}`);
    }
    const key = `${officialDate}|${gamePk}|${side}|${market}|${horizon}`;
    if (seen.has(key)) throw new Error(`BULLPEN_SAMEDATE_DUPLICATE_V16_IDENTITY:${key}`);
    seen.add(key);
    rows.push({ officialDate, gamePk, side, market, horizon });
  }
  return rows;
}
function extractSchedule(payload: any): ScheduledGame[] {
  const out: ScheduledGame[] = [];
  for (const dateEntry of Array.isArray(payload?.dates) ? payload.dates : []) {
    for (const game of Array.isArray(dateEntry?.games) ? dateEntry.games : []) {
      if (String(game?.gameType ?? "R") !== "R") continue;
      const gamePk = positiveInt(game?.gamePk);
      const homeTeamId = positiveInt(game?.teams?.home?.team?.id);
      const awayTeamId = positiveInt(game?.teams?.away?.team?.id);
      const officialDate = String(game?.officialDate ?? dateEntry?.date ?? "").slice(0,10);
      const scheduledStart = String(game?.gameDate ?? "");
      if (!gamePk || !homeTeamId || !awayTeamId || !validDate(officialDate) || !Number.isFinite(Date.parse(scheduledStart))) continue;
      out.push({ gamePk, officialDate, scheduledStart: new Date(scheduledStart).toISOString(), homeTeamId, awayTeamId });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const season = arg("season");
  const lineupFile = arg("lineup-history");
  const v16File = arg("v16-rowset");
  const outFile = arg("out");
  const lineup = JSON.parse(fs.readFileSync(lineupFile, "utf8"));
  const snapshots: Snapshot[] = Array.isArray(lineup?.snapshots) ? lineup.snapshots : [];
  const snapshotByPk = new Map<number, Snapshot>(snapshots.map((x) => [Number(x.gamePk), x]));
  const rows = readV16(v16File);
  const byGame = new Map<number, Identity[]>();
  for (const row of rows) {
    const list = byGame.get(row.gamePk) ?? [];
    list.push(row);
    byGame.set(row.gamePk, list);
  }
  for (const [gamePk, gameRows] of byGame) {
    if (gameRows.length !== 4) throw new Error(`BULLPEN_SAMEDATE_V16_GAME_ROW_COUNT:${gamePk}:${gameRows.length}`);
  }
  const targetDates = [...new Set(rows.map((r) => r.officialDate))].sort();
  const startDate = targetDates[0];
  const endDate = targetDates.at(-1);
  if (!startDate || !endDate) throw new Error("BULLPEN_SAMEDATE_EMPTY_UNIVERSE");
  const schedulePayload = await fetchJson(`${MLB_V1}/schedule?sportId=1&gameType=R&startDate=${startDate}&endDate=${endDate}`);
  const schedule = extractSchedule(schedulePayload);

  const affectedSides: any[] = [];
  for (const [gamePk, gameRows] of [...byGame.entries()].sort((a,b)=>a[0]-b[0])) {
    const snapshot = snapshotByPk.get(gamePk);
    if (!snapshot || snapshot.officialDate !== gameRows[0].officialDate) throw new Error(`BULLPEN_SAMEDATE_SNAPSHOT_MISSING:${gamePk}`);
    const cutoffMs = Date.parse(timecodeIso(snapshot.requestedTimecode));
    for (const side of ["HOME","AWAY"] as const) {
      const teamId = side === "HOME" ? Number(snapshot.homeTeamId) : Number(snapshot.awayTeamId);
      const priorScheduled = schedule
        .filter((g) => g.gamePk !== gamePk && g.officialDate === snapshot.officialDate
          && (g.homeTeamId === teamId || g.awayTeamId === teamId)
          && Date.parse(g.scheduledStart) < cutoffMs)
        .sort((a,b)=>a.scheduledStart.localeCompare(b.scheduledStart)||a.gamePk-b.gamePk)
        .map((g) => ({ gamePk: g.gamePk, scheduledStart: g.scheduledStart }));
      if (priorScheduled.length) {
        affectedSides.push({
          officialDate: snapshot.officialDate,
          gamePk,
          side,
          teamId,
          requestedTimecode: snapshot.requestedTimecode,
          reason: "SAME_DATE_ROLE_STATS_CACHE_AMBIGUOUS",
          priorScheduledGames: priorScheduled,
        });
      }
    }
  }

  affectedSides.sort((a,b)=>a.officialDate.localeCompare(b.officialDate)||a.gamePk-b.gamePk||a.side.localeCompare(b.side));
  const affectedGameKeys = new Set(affectedSides.map((x)=>`${x.officialDate}|${x.gamePk}`));
  const report = {
    schemaVersion: SCHEMA,
    status: affectedSides.length ? "SAME_DATE_ROLE_STATS_AMBIGUITY_PRESENT" : "NO_SAME_DATE_ROLE_STATS_AMBIGUITY_DETECTED",
    season,
    universe: {
      v16Rows: rows.length,
      games: byGame.size,
      scheduleGamesObserved: schedule.length,
    },
    finding: {
      affectedFullGameSides: affectedSides.length,
      affectedGames: affectedGameKeys.size,
      requiredDisposition: "EXPLICIT_MISSINGNESS_BEFORE_BULLPEN_PARITY_CERTIFICATION",
      missingnessReason: "SAME_DATE_ROLE_STATS_CACHE_AMBIGUOUS",
      rationale: "Production current-season role stats can reflect a prior same-date game or a 24h cached pre-game state; D-1 replay cannot deterministically infer that runtime state. Any target with another same-date team game scheduled before target T-5 is therefore withheld fail-closed without reading same-date game results.",
    },
    affectedSides,
    policy: {
      researchOnly: true,
      scheduleMetadataOnly: true,
      sameDateFinalGameRead: false,
      gameFeedRead: false,
      targetResultRead: false,
      marketPricesRead: false,
      modelRefit: false,
      newWeightsCreated: false,
      productionChanged: false,
      r1b2Authorized: false,
      favorableResultRequired: false,
    },
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ season, status: report.status, games: byGame.size, affectedGames: affectedGameKeys.size, affectedFullGameSides: affectedSides.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
