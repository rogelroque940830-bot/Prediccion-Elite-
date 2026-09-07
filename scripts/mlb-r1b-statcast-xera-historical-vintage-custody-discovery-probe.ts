import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-historical-vintage-custody-discovery-probe.v1" as const;
const STATUS = "HISTORICAL_SAVANT_XWOBA_VINTAGE_CUSTODY_DISCOVERY_ONLY_NOT_PARITY_CERTIFICATION" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Historical-Vintage-Custody/1.0)";
const SEASON = 2022;
const PRIMARY_HOST = "baseballsavant.mlb.com";
const ARCHIVE_HOST = "web.archive.org";
const TARGET_ANCHOR_DATES = ["2022-05-03", "2022-05-23", "2022-10-23"] as const;

type CdxRow = {
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
};

type PatternEvidence = {
  pattern: string;
  ok: boolean;
  error: string | null;
  rowCount: number;
  uniqueOriginalCount: number;
  rows: CdxRow[];
};

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

function cdxUrl(pattern: string): string {
  const u = new URL(`https://${ARCHIVE_HOST}/cdx/search/cdx`);
  u.searchParams.set("url", pattern);
  u.searchParams.set("output", "json");
  u.searchParams.set("from", String(SEASON));
  u.searchParams.set("to", String(SEASON));
  u.searchParams.append("filter", "statuscode:200");
  u.searchParams.set("collapse", "digest");
  u.searchParams.set("fl", "timestamp,original,mimetype,statuscode,digest,length");
  u.searchParams.set("limit", "5000");
  return u.toString();
}

function replayUrl(row: CdxRow): string {
  return `https://${ARCHIVE_HOST}/web/${row.timestamp}id_/${row.original}`;
}

function timestampToDate(timestamp: string): string | null {
  if (!/^\d{14}$/.test(timestamp)) return null;
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
}

function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round(Math.abs(ta - tb) / 86_400_000);
}

function summarizeQuery(original: string) {
  try {
    const u = new URL(original);
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) params[k] = v;
    return {
      pathname: u.pathname,
      hasSeason2022: [...u.searchParams.values()].some((v) => v.includes("2022")),
      playerType: u.searchParams.get("player_type") ?? u.searchParams.get("type"),
      groupBy: u.searchParams.get("group_by"),
      gameDateGt: u.searchParams.get("game_date_gt"),
      gameDateLt: u.searchParams.get("game_date_lt"),
      chkStatsXwoba: u.searchParams.get("chk_stats_xwoba"),
      sortCol: u.searchParams.get("sort_col") ?? u.searchParams.get("sort"),
      params,
    };
  } catch {
    return null;
  }
}

function looksLikeHistoricalXwobaAggregate(row: CdxRow): boolean {
  const q = summarizeQuery(row.original);
  if (!q) return false;
  const lower = row.original.toLowerCase();
  return q.pathname.includes("statcast_search") &&
    q.hasSeason2022 &&
    (q.playerType === "pitcher" || lower.includes("player_type=pitcher")) &&
    (q.groupBy === "name" || lower.includes("group_by=name")) &&
    (q.chkStatsXwoba === "on" || lower.includes("xwoba"));
}

function looksCsvish(text: string): boolean {
  const first = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return first.includes(",") && /player_id|player_name|xwoba|pa/i.test(first) && !/^\s*</.test(text);
}

function csvHeader(text: string): string[] {
  const first = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return first.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
}

async function main() {
  const patterns = [
    `${PRIMARY_HOST}/statcast_search/csv*`,
    `${PRIMARY_HOST}/statcast_search*`,
    `${PRIMARY_HOST}/leaderboard/expected_statistics*`,
    `${PRIMARY_HOST}/expected_statistics*`,
    `${PRIMARY_HOST}/leaderboard/services*`,
  ];

  const patternEvidence: PatternEvidence[] = [];
  for (const pattern of patterns) {
    const url = cdxUrl(pattern);
    const fetched = await fetchText(url, "application/json,*/*;q=0.8");
    if (!fetched.ok) {
      patternEvidence.push({ pattern, ok: false, error: fetched.error, rowCount: 0, uniqueOriginalCount: 0, rows: [] });
      continue;
    }
    const rows = parseCdx(fetched.text);
    patternEvidence.push({
      pattern,
      ok: true,
      error: null,
      rowCount: rows.length,
      uniqueOriginalCount: new Set(rows.map((r) => r.original)).size,
      rows,
    });
  }

  const allRows = patternEvidence.flatMap((p) => p.rows);
  const uniqueByStampOriginal = new Map<string, CdxRow>();
  for (const row of allRows) uniqueByStampOriginal.set(`${row.timestamp}\n${row.original}`, row);
  const uniqueRows = [...uniqueByStampOriginal.values()];

  const statcastCsvRows = uniqueRows.filter((row) => {
    try { return new URL(row.original).pathname.includes("/statcast_search/csv"); }
    catch { return false; }
  });
  const historicalAggregateCandidates = statcastCsvRows.filter(looksLikeHistoricalXwobaAggregate);

  const nearestCandidates = TARGET_ANCHOR_DATES.map((anchorDate) => {
    const ranked = historicalAggregateCandidates
      .map((row) => ({ row, captureDate: timestampToDate(row.timestamp) }))
      .filter((x): x is { row: CdxRow; captureDate: string } => x.captureDate != null)
      .map((x) => ({ ...x, distanceDays: daysBetween(anchorDate, x.captureDate) }))
      .sort((a, b) => a.distanceDays - b.distanceDays || a.row.timestamp.localeCompare(b.row.timestamp))
      .slice(0, 10);
    return {
      anchorDate,
      nearest: ranked.map(({ row, captureDate, distanceDays }) => ({
        timestamp: row.timestamp,
        captureDate,
        distanceDays,
        original: row.original,
        mimetype: row.mimetype,
        digest: row.digest,
        query: summarizeQuery(row.original),
      })),
    };
  });

  const replaySampleRows = [...historicalAggregateCandidates]
    .sort((a, b) => {
      const da = Math.min(...TARGET_ANCHOR_DATES.map((d) => daysBetween(d, timestampToDate(a.timestamp) ?? "1900-01-01")));
      const db = Math.min(...TARGET_ANCHOR_DATES.map((d) => daysBetween(d, timestampToDate(b.timestamp) ?? "1900-01-01")));
      return da - db || a.timestamp.localeCompare(b.timestamp);
    })
    .slice(0, 20);

  const replayEvidence: unknown[] = [];
  let replayedCsvWithXwobaCount = 0;
  let replayedCsvWithPaAndXwobaCount = 0;
  for (const row of replaySampleRows) {
    const replay = await fetchText(replayUrl(row), "text/csv,text/plain;q=0.9,*/*;q=0.8");
    const csvish = replay.ok && looksCsvish(replay.text);
    const headers = csvish ? csvHeader(replay.text) : [];
    const hasXwoba = headers.includes("xwoba");
    const hasPa = headers.includes("pa");
    if (csvish && hasXwoba) replayedCsvWithXwobaCount++;
    if (csvish && hasXwoba && hasPa) replayedCsvWithPaAndXwobaCount++;
    replayEvidence.push({
      timestamp: row.timestamp,
      captureDate: timestampToDate(row.timestamp),
      original: row.original,
      replayUrl: replayUrl(row),
      cdxDigest: row.digest,
      cdxMimetype: row.mimetype,
      replayOk: replay.ok,
      replayStatus: replay.status,
      replayError: replay.error,
      replayBodySha256: replay.ok ? sha256(replay.text) : null,
      bodyBytes: replay.ok ? Buffer.byteLength(replay.text) : 0,
      csvish,
      headers,
      hasPa,
      hasXwoba,
      query: summarizeQuery(row.original),
    });
  }

  const expectedPageRows = uniqueRows.filter((row) => {
    try {
      const p = new URL(row.original).pathname;
      return p.includes("expected_statistics");
    } catch { return false; }
  });

  const archiveDatesWithHistoricalAggregateCandidates = [...new Set(
    historicalAggregateCandidates.map((r) => timestampToDate(r.timestamp)).filter((x): x is string => x != null),
  )].sort();

  const candidateCoverageByAnchor = TARGET_ANCHOR_DATES.map((anchorDate) => ({
    anchorDate,
    exactCaptureDateCandidateCount: historicalAggregateCandidates.filter((r) => timestampToDate(r.timestamp) === anchorDate).length,
    withinOneDayCandidateCount: historicalAggregateCandidates.filter((r) => {
      const d = timestampToDate(r.timestamp);
      return d != null && daysBetween(anchorDate, d) <= 1;
    }).length,
    withinSevenDaysCandidateCount: historicalAggregateCandidates.filter((r) => {
      const d = timestampToDate(r.timestamp);
      return d != null && daysBetween(anchorDate, d) <= 7;
    }).length,
  }));

  const evidence = {
    schemaVersion: SCHEMA,
    status: STATUS,
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    sourceAuthority: {
      canonicalPublisherHost: PRIMARY_HOST,
      archiveTransportHost: ARCHIVE_HOST,
      archiveTransportIsPublisher: false,
      archivedPayloadMayServeAsPublisherTruthOnlyWhenReplayIsPrimaryPublisherContent: true,
    },
    researchQuestion: "Does Wayback preserve primary Baseball Savant historical Statcast Search or equivalent expected-stat input surfaces that can retain the historical xwOBA vintage needed to reproduce archived xERA without substituting today's revised xwOBA values?",
    discoveryPolicy: {
      primaryPublisherUrlsOnly: true,
      noThirdPartyMirrors: true,
      noInterpolationBetweenSnapshots: true,
      noEmpiricalFitAuthorized: true,
      approximationForbidden: true,
      xeraNotUsedToSelectOrRankCustodyCandidates: true,
      archiveCaptureExistenceDoesNotEqualCompleteDailyCustody: true,
    },
    cdxPatterns: patternEvidence.map((p) => ({
      pattern: p.pattern,
      ok: p.ok,
      error: p.error,
      rowCount: p.rowCount,
      uniqueOriginalCount: p.uniqueOriginalCount,
    })),
    discoverySummary: {
      uniqueRowsAcrossPatterns: uniqueRows.length,
      statcastSearchCsvCaptureRows: statcastCsvRows.length,
      historical2022PitcherNameAggregateXwobaCandidateRows: historicalAggregateCandidates.length,
      historicalAggregateCandidateCaptureDateCount: archiveDatesWithHistoricalAggregateCandidates.length,
      firstHistoricalAggregateCandidateCaptureDate: archiveDatesWithHistoricalAggregateCandidates[0] ?? null,
      lastHistoricalAggregateCandidateCaptureDate: archiveDatesWithHistoricalAggregateCandidates.at(-1) ?? null,
      expectedStatisticsPageCaptureRows: expectedPageRows.length,
      replaySampleCount: replayEvidence.length,
      replayedCsvWithXwobaCount,
      replayedCsvWithPaAndXwobaCount,
    },
    candidateCoverageByAnchor,
    nearestCandidates,
    replayEvidence,
    scientificConclusion: {
      archivedPrimaryStatcastSearchXwobaSurfaceObserved: replayedCsvWithXwobaCount > 0,
      archivedPrimaryStatcastSearchPaAndXwobaSurfaceObserved: replayedCsvWithPaAndXwobaCount > 0,
      completeDailyHistoricalXwobaVintageCustodyProven: false,
      exactTargetDateXeraCustodyForFullUniverseProven: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
      nextGate: replayedCsvWithPaAndXwobaCount > 0
        ? "VALIDATE REPLAYED PRIMARY STATCAST-SEARCH xwOBA AGAINST SAME-VINTAGE ARCHIVED EXPECTED-STAT LEADERBOARD AT SHARED PLAYER/PA STATES; THEN MEASURE DATE COVERAGE WITHOUT INTERPOLATION."
        : "NO REPLAYED PRIMARY STATCAST-SEARCH PA+xwOBA CUSTODY WAS PROVEN IN THE TESTED DISCOVERY SAMPLE; EXPAND PRIMARY-PUBLISHER ARCHIVAL ENDPOINT DISCOVERY (INCLUDING SAVANT LEADERBOARD SERVICE/DOWNLOAD SURFACES) WITHOUT USING THIRD-PARTY MIRRORS OR EMPIRICAL RECONSTRUCTION.",
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
  const outPath = arg?.slice("--out=".length) || "artifacts/mlb-r1b-statcast-xera-historical-vintage-custody-discovery-probe/evidence.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
