import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-savant-vintage-consistency-probe.v1" as const;
const STATUS = "SAVANT_XWOBA_VINTAGE_CONSISTENCY_PROBE_ONLY_NOT_PARITY_CERTIFICATION" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Savant-Vintage/1.0)";
const SEASON = 2022;
const CURRENT_LEADERBOARD = "https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2022&position=&team=&min=q";

const ARCHIVE_ANCHORS = [
  { label: "IN_SEASON_PA_ALIGNED_REFERENCE", timestamp: "20220523220701", archiveDate: "2022-05-23" },
  { label: "POST_REGULAR_SEASON_VINTAGE_REFERENCE", timestamp: "20221023221946", archiveDate: "2022-10-23" },
] as const;

type CdxRow = {
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
};

type LeaderRow = {
  playerId: number;
  pa: number | null;
  xwoba: number | null;
  xera: number | null;
};

type CsvRow = Record<string, string>;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function fetchText(url: string, accept = "application/json,text/html,text/csv;q=0.9,*/*;q=0.8") {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: accept, "User-Agent": UA },
        signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}:${text.slice(0, 180)}`);
      return { ok: true, status: response.status, text, error: null as string | null };
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return { ok: false, status: null as number | null, text: "", error: String(last) };
}

function parseCdx(text: string): CdxRow[] {
  const parsed = JSON.parse(text) as string[][];
  if (!Array.isArray(parsed) || parsed.length < 1) return [];
  const [headers, ...rows] = parsed;
  const ix = (name: string) => headers.indexOf(name);
  for (const required of ["timestamp", "original", "mimetype", "statuscode", "digest", "length"]) {
    if (ix(required) < 0) throw new Error(`CDX_SCHEMA_MISSING:${required}`);
  }
  return rows.map((row) => ({
    timestamp: row[ix("timestamp")] ?? "",
    original: row[ix("original")] ?? "",
    mimetype: row[ix("mimetype")] ?? "",
    statuscode: row[ix("statuscode")] ?? "",
    digest: row[ix("digest")] ?? "",
    length: row[ix("length")] ?? "",
  }));
}

function parseOriginal(original: string) {
  try {
    const u = new URL(original);
    return {
      year: Number(u.searchParams.get("year")),
      type: String(u.searchParams.get("type") ?? "").toLowerCase(),
      min: String(u.searchParams.get("min") ?? "").toLowerCase(),
      team: String(u.searchParams.get("team") ?? ""),
      position: String(u.searchParams.get("position") ?? ""),
    };
  } catch {
    return { year: NaN, type: "", min: "", team: "", position: "" };
  }
}

function replayUrl(row: CdxRow): string {
  return `https://web.archive.org/web/${row.timestamp}id_/${row.original}`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function numberProperty(objectText: string, names: readonly string[]): number | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(?:^|[,\\{])\\s*["']?${escaped}["']?\\s*:\\s*["']?(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))["']?(?=\\s*[,}])`,
      "i",
    );
    const match = objectText.match(re);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function extractLeaderboardRows(html: string): LeaderRow[] {
  const decoded = decodeHtmlEntities(html);
  const objectRe = /\{[^{}]{20,9000}\}/g;
  const rows = new Map<number, LeaderRow>();
  for (const match of decoded.matchAll(objectRe)) {
    const objectText = match[0];
    if (!/\best_woba\b/i.test(objectText)) continue;
    const playerId = numberProperty(objectText, ["player_id", "entity_id"]);
    if (playerId == null) continue;
    const row: LeaderRow = {
      playerId,
      pa: numberProperty(objectText, ["pa"]),
      xwoba: numberProperty(objectText, ["est_woba"]),
      xera: numberProperty(objectText, ["xera"]),
    };
    if (row.pa == null || row.xwoba == null) continue;
    rows.set(playerId, row);
  }
  return [...rows.values()].sort((a, b) => a.playerId - b.playerId);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(current);
      current = "";
    } else current += c;
  }
  out.push(current);
  return out;
}

function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((x) => x.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((header, index) => { row[header] = cells[index] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function num(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function statcastAggregateUrl(cutoff?: string): string {
  return queryUrl("https://baseballsavant.mlb.com/statcast_search/csv", {
    all: "true",
    hfGT: "R|",
    hfSea: `${SEASON}|`,
    player_type: "pitcher",
    group_by: "name",
    min_pitches: "0",
    min_results: "0",
    min_pas: "0",
    sort_col: "xwoba",
    sort_order: "desc",
    game_date_gt: "",
    game_date_lt: cutoff ?? "",
    chk_stats_pa: "on",
    chk_stats_woba: "on",
    chk_stats_xwoba: "on",
  });
}

function csvMap(rows: readonly CsvRow[]) {
  const out = new Map<number, { playerId: number; pa: number | null; xwoba: number | null }>();
  for (const row of rows) {
    const playerId = num(row.player_id ?? row.pitcher ?? row.playerid);
    if (playerId == null || out.has(playerId)) continue;
    out.set(playerId, { playerId, pa: num(row.pa), xwoba: num(row.xwoba) });
  }
  return out;
}

function display3(value: number | null): string | null {
  return value == null ? null : value.toFixed(3);
}

function display2(value: number | null): string | null {
  return value == null ? null : value.toFixed(2);
}

function compareLeaderboards(reference: readonly LeaderRow[], candidate: readonly LeaderRow[]) {
  const cMap = new Map(candidate.map((row) => [row.playerId, row]));
  let commonPlayers = 0;
  let exactPa = 0;
  let exactXwoba = 0;
  let exactXera = 0;
  let exactPaAndXwoba = 0;
  let exactPaAndXera = 0;
  let exactPaWithXwobaDrift = 0;
  let exactPaWithXeraDrift = 0;
  const driftExamples: unknown[] = [];

  for (const ref of reference) {
    const cand = cMap.get(ref.playerId);
    if (!cand) continue;
    commonPlayers++;
    const paMatch = ref.pa === cand.pa;
    const xwobaMatch = display3(ref.xwoba) === display3(cand.xwoba);
    const xeraComparable = ref.xera != null && cand.xera != null;
    const xeraMatch = xeraComparable && display2(ref.xera) === display2(cand.xera);
    if (paMatch) exactPa++;
    if (xwobaMatch) exactXwoba++;
    if (xeraMatch) exactXera++;
    if (paMatch && xwobaMatch) exactPaAndXwoba++;
    if (paMatch && xeraMatch) exactPaAndXera++;
    if (paMatch && !xwobaMatch) exactPaWithXwobaDrift++;
    if (paMatch && xeraComparable && !xeraMatch) exactPaWithXeraDrift++;
    if (paMatch && (!xwobaMatch || (xeraComparable && !xeraMatch)) && driftExamples.length < 25) {
      driftExamples.push({
        playerId: ref.playerId,
        pa: ref.pa,
        referenceXwoba: display3(ref.xwoba),
        candidateXwoba: display3(cand.xwoba),
        referenceXera: display2(ref.xera),
        candidateXera: display2(cand.xera),
      });
    }
  }

  return {
    referenceRows: reference.length,
    candidateRows: candidate.length,
    commonPlayers,
    exactPa,
    exactXwoba,
    exactXera,
    exactPaAndXwoba,
    exactPaAndXera,
    exactPaWithXwobaDrift,
    exactPaWithXeraDrift,
    exactPaRate: commonPlayers ? exactPa / commonPlayers : 0,
    exactPaXwobaIdentityRate: exactPa ? exactPaAndXwoba / exactPa : 0,
    exactPaXeraIdentityRate: exactPa ? exactPaAndXera / exactPa : 0,
    samePaXwobaValueDriftObserved: exactPaWithXwobaDrift > 0,
    samePaXeraValueDriftObserved: exactPaWithXeraDrift > 0,
    driftExamples,
  };
}

function compareLeaderboardToCsv(reference: readonly LeaderRow[], csvRows: readonly CsvRow[]) {
  const cMap = csvMap(csvRows);
  let commonPlayers = 0;
  let exactPa = 0;
  let exactXwoba = 0;
  let exactPaAndXwoba = 0;
  let exactPaWithXwobaDrift = 0;
  const driftExamples: unknown[] = [];

  for (const ref of reference) {
    const cand = cMap.get(ref.playerId);
    if (!cand) continue;
    commonPlayers++;
    const paMatch = ref.pa === cand.pa;
    const xwobaMatch = display3(ref.xwoba) === display3(cand.xwoba);
    if (paMatch) exactPa++;
    if (xwobaMatch) exactXwoba++;
    if (paMatch && xwobaMatch) exactPaAndXwoba++;
    if (paMatch && !xwobaMatch) {
      exactPaWithXwobaDrift++;
      if (driftExamples.length < 25) {
        driftExamples.push({
          playerId: ref.playerId,
          pa: ref.pa,
          leaderboardXwoba: display3(ref.xwoba),
          statcastSearchXwoba: display3(cand.xwoba),
        });
      }
    }
  }

  return {
    referenceRows: reference.length,
    aggregateRows: csvRows.length,
    aggregateUniquePlayers: cMap.size,
    commonPlayers,
    exactPa,
    exactXwoba,
    exactPaAndXwoba,
    exactPaWithXwobaDrift,
    exactPaRate: commonPlayers ? exactPa / commonPlayers : 0,
    exactPaXwobaIdentityRate: exactPa ? exactPaAndXwoba / exactPa : 0,
    samePaXwobaValueDriftObserved: exactPaWithXwobaDrift > 0,
    driftExamples,
  };
}

async function main() {
  const cdxUrl = new URL("https://web.archive.org/cdx/search/cdx");
  cdxUrl.searchParams.set("url", "baseballsavant.mlb.com/leaderboard/expected_statistics*");
  cdxUrl.searchParams.set("output", "json");
  cdxUrl.searchParams.set("from", String(SEASON));
  cdxUrl.searchParams.set("to", String(SEASON));
  cdxUrl.searchParams.append("filter", "statuscode:200");
  cdxUrl.searchParams.set("collapse", "digest");
  cdxUrl.searchParams.set("fl", "timestamp,original,mimetype,statuscode,digest,length");
  cdxUrl.searchParams.set("limit", "5000");

  const cdx = await fetchText(cdxUrl.toString());
  if (!cdx.ok) throw new Error(`CDX_FETCH_FAILED:${cdx.error}`);
  const cdxRows = parseCdx(cdx.text);

  const archivedRowsByTimestamp = new Map<string, LeaderRow[]>();
  const archiveEvidence: unknown[] = [];
  for (const anchor of ARCHIVE_ANCHORS) {
    const matches = cdxRows.filter((row) => {
      if (row.timestamp !== anchor.timestamp) return false;
      const p = parseOriginal(row.original);
      return p.year === SEASON && p.type === "pitcher" && p.min === "q" && p.team === "" && p.position === "";
    });
    if (matches.length !== 1) throw new Error(`ARCHIVE_ANCHOR_NOT_UNIQUE:${anchor.timestamp}:${matches.length}`);
    const row = matches[0];
    const replay = await fetchText(replayUrl(row), "text/html,*/*;q=0.8");
    if (!replay.ok) throw new Error(`ARCHIVE_REPLAY_FAILED:${anchor.timestamp}:${replay.error}`);
    const parsed = extractLeaderboardRows(replay.text);
    if (!parsed.length) throw new Error(`ARCHIVE_ROWS_EMPTY:${anchor.timestamp}`);
    archivedRowsByTimestamp.set(anchor.timestamp, parsed);
    archiveEvidence.push({
      label: anchor.label,
      timestamp: anchor.timestamp,
      archiveDate: anchor.archiveDate,
      original: row.original,
      replayUrl: replayUrl(row),
      cdxDigest: row.digest,
      replaySha256: sha256(replay.text),
      parsedRows: parsed.length,
      rowsWithXera: parsed.filter((x) => x.xera != null).length,
    });
  }

  const currentLeaderboardFetch = await fetchText(CURRENT_LEADERBOARD, "text/html,*/*;q=0.8");
  if (!currentLeaderboardFetch.ok) throw new Error(`CURRENT_LEADERBOARD_FETCH_FAILED:${currentLeaderboardFetch.error}`);
  const currentLeaderboardRows = extractLeaderboardRows(currentLeaderboardFetch.text);
  if (!currentLeaderboardRows.length) throw new Error("CURRENT_LEADERBOARD_ROWS_EMPTY");

  const currentFullUrl = statcastAggregateUrl();
  const currentFullFetch = await fetchText(currentFullUrl, "text/csv,text/plain;q=0.9,*/*;q=0.8");
  if (!currentFullFetch.ok) throw new Error(`CURRENT_FULL_STATCAST_FETCH_FAILED:${currentFullFetch.error}`);
  if (/^\s*</.test(currentFullFetch.text)) throw new Error("CURRENT_FULL_STATCAST_HTML_RESPONSE");
  const currentFullCsv = parseCsv(currentFullFetch.text);
  for (const required of ["player_id", "pa", "xwoba"]) {
    if (!currentFullCsv.headers.includes(required)) throw new Error(`CURRENT_FULL_STATCAST_SCHEMA_DRIFT:${required}`);
  }

  const inSeasonCutoff = "2022-05-22";
  const inSeasonUrl = statcastAggregateUrl(inSeasonCutoff);
  const inSeasonFetch = await fetchText(inSeasonUrl, "text/csv,text/plain;q=0.9,*/*;q=0.8");
  if (!inSeasonFetch.ok) throw new Error(`IN_SEASON_STATCAST_FETCH_FAILED:${inSeasonFetch.error}`);
  if (/^\s*</.test(inSeasonFetch.text)) throw new Error("IN_SEASON_STATCAST_HTML_RESPONSE");
  const inSeasonCsv = parseCsv(inSeasonFetch.text);
  for (const required of ["player_id", "pa", "xwoba"]) {
    if (!inSeasonCsv.headers.includes(required)) throw new Error(`IN_SEASON_STATCAST_SCHEMA_DRIFT:${required}`);
  }

  const archivedInSeason = archivedRowsByTimestamp.get("20220523220701")!;
  const archivedEnd = archivedRowsByTimestamp.get("20221023221946")!;

  const archivedEndVsCurrentLeaderboard = compareLeaderboards(archivedEnd, currentLeaderboardRows);
  const currentLeaderboardVsCurrentRaw = compareLeaderboardToCsv(currentLeaderboardRows, currentFullCsv.rows);
  const archivedInSeasonVsCurrentDateBoundedRaw = compareLeaderboardToCsv(archivedInSeason, inSeasonCsv.rows);

  const sameSeasonSamePaArchivedVsCurrentValueDriftObserved =
    archivedEndVsCurrentLeaderboard.samePaXwobaValueDriftObserved ||
    archivedEndVsCurrentLeaderboard.samePaXeraValueDriftObserved;

  const currentPublisherSurfacesExactXwobaIdentityProven =
    currentLeaderboardVsCurrentRaw.exactPa > 0 &&
    currentLeaderboardVsCurrentRaw.exactPaWithXwobaDrift === 0;

  const evidence = {
    schemaVersion: SCHEMA,
    status: STATUS,
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    sourceAuthority: {
      canonicalPublisherHost: "baseballsavant.mlb.com",
      archiveTransportHost: "web.archive.org",
      archiveTransportIsPublisher: false,
      archivedPayloadIsReplayOfPrimaryPublisherSurface: true,
      currentLeaderboardHost: "baseballsavant.mlb.com",
      currentAggregateHost: "baseballsavant.mlb.com",
    },
    researchQuestion: "Do archived official Savant xwOBA/xERA values remain identical to current Savant values when player identity and PA are held equal, and does current Statcast Search xwOBA equal the current Expected Statistics leaderboard xwOBA?",
    scientificPolicy: {
      compareOnlyPublisherValuesAtSharedPlayerIdentity: true,
      paUsedAsStateControl: true,
      noXeraUsedToSelectHistoricalCutoff: true,
      noInterpolationBetweenArchiveSnapshots: true,
      noEmpiricalFitAuthorized: true,
      approximationForbidden: true,
      observedValueDriftIsNotAssignedACauseWithoutFurtherPrimaryEvidence: true,
    },
    archiveEvidence,
    currentLeaderboard: {
      url: CURRENT_LEADERBOARD,
      bodySha256: sha256(currentLeaderboardFetch.text),
      parsedRows: currentLeaderboardRows.length,
      rowsWithXera: currentLeaderboardRows.filter((x) => x.xera != null).length,
    },
    currentFullSeasonStatcastSearch: {
      url: currentFullUrl,
      bodySha256: sha256(currentFullFetch.text),
      headers: currentFullCsv.headers,
      rows: currentFullCsv.rows.length,
    },
    inSeasonDateBoundedStatcastSearch: {
      cutoffParameterValue: inSeasonCutoff,
      cutoffChosenFromPriorNonXeraPaAlignment: true,
      xeraUsedToChooseCutoff: false,
      url: inSeasonUrl,
      bodySha256: sha256(inSeasonFetch.text),
      rows: inSeasonCsv.rows.length,
    },
    comparisons: {
      archivedPostRegularSeason2022VsCurrent2022Leaderboard: archivedEndVsCurrentLeaderboard,
      current2022LeaderboardVsCurrent2022StatcastSearch: currentLeaderboardVsCurrentRaw,
      archived20220523LeaderboardVsCurrentDateBoundedStatcastSearch: archivedInSeasonVsCurrentDateBoundedRaw,
    },
    summary: {
      sameSeasonSamePaArchivedVsCurrentValueDriftObserved,
      currentPublisherSurfacesExactXwobaIdentityProven,
      historicalArchivedLeaderboardToCurrentDateBoundedRawExactXwobaIdentityProven:
        archivedInSeasonVsCurrentDateBoundedRaw.exactPa > 0 && archivedInSeasonVsCurrentDateBoundedRaw.exactPaWithXwobaDrift === 0,
      exactSavantProductionConversionProven: false,
      exactTargetDateXeraCustodyForFullUniverseProven: false,
      familyPromotionAuthorized: false,
    },
    scientificConclusion: {
      publisherValueRevisionOrVintageDifferenceObserved: sameSeasonSamePaArchivedVsCurrentValueDriftObserved,
      causeOfAnyObservedRevisionOrVintageDifferenceProven: false,
      currentRawCanBeAssumedToReconstructHistoricalArchivedXwobaExactly: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
      nextGate: sameSeasonSamePaArchivedVsCurrentValueDriftObserved
        ? "ARCHIVED OFFICIAL SAVANT VALUES DRIFT FROM CURRENT PUBLISHER VALUES AT SHARED PA; SEARCH PRIMARY-PUBLISHER ARCHIVAL CUSTODY FOR THE HISTORICAL EXPECTED-STAT INPUT/VINTAGE (INCLUDING ARCHIVED STATCAST-SEARCH OR EQUIVALENT PRIMARY DATA) BEFORE ANY RECONSTRUCTION."
        : "NO SAME-PA ARCHIVED/CURRENT VALUE DRIFT OBSERVED IN THIS PROBE; CONTINUE FIELD-SEMANTIC ALIGNMENT WITHOUT USING xERA OR EMPIRICAL FITTING.",
    },
    scientificBoundary: {
      researchOnly: true,
      productionChanged: false,
      weightsChanged: false,
      routingChanged: false,
      stakingChanged: false,
      betEliteChanged: false,
      marketPricesRead: false,
      targetOutcomeReadForModeling: false,
      automaticBetPlacementAllowed: false,
      realFinancialExposure: 0,
      r1b2Authorized: false,
    },
  };

  const arg = process.argv.find((value) => value.startsWith("--out="));
  const outPath = arg?.slice("--out=".length) || "artifacts/mlb-r1b-statcast-xera-savant-vintage-consistency-probe/evidence.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
