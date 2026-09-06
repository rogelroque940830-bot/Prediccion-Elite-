import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-wayback-state-alignment-probe.v1" as const;
const STATUS = "WAYBACK_PRIMARY_XERA_TO_DATE_BOUNDED_STATCAST_STATE_ALIGNMENT_PROBE_ONLY_NOT_PARITY_CERTIFICATION" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-State-Alignment/1.0)";
const SEASON = 2022;

const ANCHORS = [
  { timestamp: "20220503231003", archiveDate: "2022-05-03" },
  { timestamp: "20220523220701", archiveDate: "2022-05-23" },
] as const;

type CdxRow = {
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
};

type SnapshotRow = {
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

function extractSnapshotRows(html: string): SnapshotRow[] {
  const decoded = decodeHtmlEntities(html);
  const objectRe = /\{[^{}]{20,9000}\}/g;
  const rows = new Map<number, SnapshotRow>();
  for (const match of decoded.matchAll(objectRe)) {
    const objectText = match[0];
    if (!/\bxera\b/i.test(objectText) || !/\best_woba\b/i.test(objectText)) continue;
    const playerId = numberProperty(objectText, ["player_id", "entity_id"]);
    if (playerId == null) continue;
    rows.set(playerId, {
      playerId,
      pa: numberProperty(objectText, ["pa"]),
      xwoba: numberProperty(objectText, ["est_woba"]),
      xera: numberProperty(objectText, ["xera"]),
    });
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

function aggregateUrl(cutoff: string): string {
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
    game_date_lt: cutoff,
    chk_stats_pa: "on",
    chk_stats_woba: "on",
    chk_stats_xwoba: "on",
  });
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function aggregateByPlayer(rows: readonly CsvRow[]): Map<number, { playerId: number; pa: number | null; xwoba: number | null }> {
  const out = new Map<number, { playerId: number; pa: number | null; xwoba: number | null }>();
  for (const row of rows) {
    const playerId = num(row.player_id ?? row.pitcher ?? row.playerid);
    if (playerId == null || out.has(playerId)) continue;
    out.set(playerId, {
      playerId,
      pa: num(row.pa),
      xwoba: num(row.xwoba),
    });
  }
  return out;
}

function display3(value: number | null): string | null {
  return value == null ? null : value.toFixed(3);
}

function compareState(snapshotRows: readonly SnapshotRow[], aggregateRows: readonly CsvRow[]) {
  const aggregate = aggregateByPlayer(aggregateRows);
  const comparable = snapshotRows.filter((row) => row.pa != null && row.xwoba != null);
  let commonPlayers = 0;
  let exactPa = 0;
  let exactDisplayedXwoba = 0;
  let exactJoint = 0;
  const mismatchExamples: unknown[] = [];

  for (const snap of comparable) {
    const found = aggregate.get(snap.playerId);
    if (!found) {
      if (mismatchExamples.length < 20) mismatchExamples.push({ playerId: snap.playerId, reason: "MISSING_PLAYER" });
      continue;
    }
    commonPlayers++;
    const paMatch = snap.pa === found.pa;
    const xwobaMatch = display3(snap.xwoba) === display3(found.xwoba);
    if (paMatch) exactPa++;
    if (xwobaMatch) exactDisplayedXwoba++;
    if (paMatch && xwobaMatch) exactJoint++;
    else if (mismatchExamples.length < 20) {
      mismatchExamples.push({
        playerId: snap.playerId,
        snapshotPa: snap.pa,
        aggregatePa: found.pa,
        snapshotXwoba: display3(snap.xwoba),
        aggregateXwoba: display3(found.xwoba),
      });
    }
  }

  const snapshotComparableRows = comparable.length;
  const exactStateMatch = snapshotComparableRows > 0 &&
    commonPlayers === snapshotComparableRows &&
    exactJoint === snapshotComparableRows;

  return {
    snapshotComparableRows,
    aggregateRows: aggregateRows.length,
    aggregateUniquePlayers: aggregate.size,
    commonPlayers,
    exactPa,
    exactDisplayedXwoba,
    exactJoint,
    exactPaRate: snapshotComparableRows ? exactPa / snapshotComparableRows : 0,
    exactDisplayedXwobaRate: snapshotComparableRows ? exactDisplayedXwoba / snapshotComparableRows : 0,
    exactJointRate: snapshotComparableRows ? exactJoint / snapshotComparableRows : 0,
    exactStateMatch,
    mismatchExamples,
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

  const anchorEvidence: unknown[] = [];
  let anchorsParsed = 0;
  let totalSnapshotRows = 0;
  let totalComparableRows = 0;
  let exactCandidateCount = 0;
  let uniquelyAlignedAnchorCount = 0;

  for (const anchor of ANCHORS) {
    const candidates = cdxRows.filter((row) => {
      if (row.timestamp !== anchor.timestamp) return false;
      const p = parseOriginal(row.original);
      return p.year === SEASON && p.type === "pitcher" && p.min === "q" && p.team === "" && p.position === "";
    });
    if (candidates.length !== 1) throw new Error(`ANCHOR_CDX_NOT_UNIQUE:${anchor.timestamp}:${candidates.length}`);
    const cdxRow = candidates[0];
    const replay = await fetchText(replayUrl(cdxRow), "text/html,*/*;q=0.8");
    if (!replay.ok) throw new Error(`ANCHOR_REPLAY_FAILED:${anchor.timestamp}:${replay.error}`);
    const snapshotRows = extractSnapshotRows(replay.text);
    if (!snapshotRows.length) throw new Error(`ANCHOR_ROWS_EMPTY:${anchor.timestamp}`);
    anchorsParsed++;
    totalSnapshotRows += snapshotRows.length;

    const cutoffDates = [shiftDate(anchor.archiveDate, -1), anchor.archiveDate, shiftDate(anchor.archiveDate, 1)];
    const cutoffEvidence: unknown[] = [];
    let localExactCandidates = 0;

    for (const cutoff of cutoffDates) {
      const url = aggregateUrl(cutoff);
      const fetched = await fetchText(url, "text/csv,text/plain;q=0.9,*/*;q=0.8");
      if (!fetched.ok) throw new Error(`AGGREGATE_FETCH_FAILED:${cutoff}:${fetched.error}`);
      if (/^\s*</.test(fetched.text)) throw new Error(`AGGREGATE_HTML_RESPONSE:${cutoff}`);
      const csv = parseCsv(fetched.text);
      for (const required of ["player_id", "pa", "xwoba"]) {
        if (!csv.headers.includes(required)) throw new Error(`AGGREGATE_SCHEMA_DRIFT:${cutoff}:${required}`);
      }
      const comparison = compareState(snapshotRows, csv.rows);
      if (comparison.exactStateMatch) {
        localExactCandidates++;
        exactCandidateCount++;
      }
      cutoffEvidence.push({
        cutoff,
        semantics: `Statcast game_date_lt=${cutoff} (exclusive upper date bound)`,
        url,
        bodySha256: sha256(fetched.text),
        headers: csv.headers,
        comparison,
      });
    }

    const snapshotComparableRows = snapshotRows.filter((row) => row.pa != null && row.xwoba != null).length;
    totalComparableRows += snapshotComparableRows;
    const uniqueAlignmentProven = localExactCandidates === 1;
    if (uniqueAlignmentProven) uniquelyAlignedAnchorCount++;

    anchorEvidence.push({
      timestamp: anchor.timestamp,
      archiveDate: anchor.archiveDate,
      original: cdxRow.original,
      cdxDigest: cdxRow.digest,
      replayUrl: replayUrl(cdxRow),
      replaySha256: sha256(replay.text),
      snapshotRows: snapshotRows.length,
      snapshotComparableRows,
      snapshotRowsWithXera: snapshotRows.filter((row) => row.xera != null).length,
      cutoffCandidateWindow: cutoffDates,
      cutoffSelectionUsesXera: false,
      cutoffEvidence,
      exactStateCandidateCount: localExactCandidates,
      uniqueAlignmentProven,
    });
  }

  const everyAnchorUniquelyAligned = uniquelyAlignedAnchorCount === ANCHORS.length;
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
      dateBoundedAggregateHost: "baseballsavant.mlb.com",
    },
    researchQuestion: "Can exact official archived Savant leaderboard states be aligned to a date-bounded primary Statcast aggregate state using player identity, PA and displayed xwOBA only, without using xERA to choose the cutoff?",
    alignmentPolicy: {
      playerIdentityRequired: true,
      paExactRequired: true,
      displayedXwobaThreeDecimalExactRequired: true,
      xeraExcludedFromCutoffSelection: true,
      candidateWindowRelativeToArchiveDate: ["D-1", "D", "D+1"],
      uniqueExactCandidateRequiredForCutoffSemantics: true,
      noInterpolationBetweenArchiveSnapshots: true,
      noEmpiricalXeraFitAuthorized: true,
      approximationForbidden: true,
    },
    anchors: anchorEvidence,
    summary: {
      anchorsRequested: ANCHORS.length,
      anchorsParsed,
      totalSnapshotRows,
      totalComparableRows,
      exactStateCandidateCount: exactCandidateCount,
      uniquelyAlignedAnchorCount,
      everyAnchorUniquelyAligned,
      exactSavantProductionConversionProven: false,
      exactTargetDateXeraCustodyForFullUniverseProven: false,
      familyPromotionAuthorized: false,
    },
    scientificConclusion: {
      primaryArchiveTruthAnchorsUsed: anchorsParsed === ANCHORS.length,
      archiveToDateBoundedStatcastStateAlignmentUniquelyProvenForTestedAnchors: everyAnchorUniquelyAligned,
      xeraUsedToSelectCutoff: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
      nextGate: everyAnchorUniquelyAligned
        ? "WITH EXACT PRIMARY STATE ALIGNMENT ESTABLISHED FOR THE TESTED ANCHORS, PROBE THE SAME ALIGNED STATES FOR PUBLISHER-SUPPORTED HIDDEN_XWOBA_PRECISION_AND_AGGREGATION_OR_RUN_ENVIRONMENT_SEMANTICS; DO NOT FIT xERA EMPIRICALLY."
        : "STATE ALIGNMENT IS NOT UNIQUELY PROVEN FOR EVERY TESTED ANCHOR; RESOLVE DATE/GAME-BOUNDARY OR FIELD-SEMANTIC AMBIGUITY USING PRIMARY STATCAST STATE FIELDS ONLY, WITHOUT USING xERA OR INTERPOLATION.",
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

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-xera-wayback-state-alignment-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({
    status: evidence.status,
    summary: evidence.summary,
    scientificConclusion: evidence.scientificConclusion,
    anchors: (anchorEvidence as any[]).map((anchor) => ({
      timestamp: anchor.timestamp,
      archiveDate: anchor.archiveDate,
      snapshotRows: anchor.snapshotRows,
      snapshotComparableRows: anchor.snapshotComparableRows,
      exactStateCandidateCount: anchor.exactStateCandidateCount,
      uniqueAlignmentProven: anchor.uniqueAlignmentProven,
      cutoffEvidence: anchor.cutoffEvidence.map((item: any) => ({
        cutoff: item.cutoff,
        comparison: item.comparison,
      })),
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
