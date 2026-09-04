import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-wayback-primary-custody-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Wayback/1.0)";
const SEASONS = [2022, 2023, 2024, 2025, 2026] as const;
const SAVANT_PATH = "baseballsavant.mlb.com/leaderboard/expected_statistics*";

type CdxRow = {
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number | null; text: string; error: string | null }> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json,text/csv,text/html;q=0.9,*/*;q=0.8", "User-Agent": UA },
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}:${text.slice(0, 160)}`);
      return { ok: true, status: response.status, text, error: null };
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return { ok: false, status: null, text: "", error: String(last) };
}

function parseCdx(text: string): CdxRow[] {
  const parsed = JSON.parse(text) as string[][];
  if (!Array.isArray(parsed) || parsed.length < 1) return [];
  const [headers, ...rows] = parsed;
  const idx = (name: string) => headers.indexOf(name);
  for (const required of ["timestamp", "original", "mimetype", "statuscode", "digest", "length"]) {
    if (idx(required) < 0) throw new Error(`CDX_SCHEMA_MISSING:${required}`);
  }
  return rows.map((row) => ({
    timestamp: row[idx("timestamp")] ?? "",
    original: row[idx("original")] ?? "",
    mimetype: row[idx("mimetype")] ?? "",
    statuscode: row[idx("statuscode")] ?? "",
    digest: row[idx("digest")] ?? "",
    length: row[idx("length")] ?? "",
  }));
}

function seasonFromUrl(original: string): number | null {
  try {
    const url = new URL(original);
    const raw = url.searchParams.get("year");
    const year = raw == null ? NaN : Number(raw);
    return SEASONS.includes(year as (typeof SEASONS)[number]) ? year : null;
  } catch {
    return null;
  }
}

function isPitcherUrl(original: string): boolean {
  try {
    const url = new URL(original);
    return url.searchParams.get("type") === "pitcher";
  } catch {
    return false;
  }
}

function isCsvUrl(original: string): boolean {
  try {
    const url = new URL(original);
    return String(url.searchParams.get("csv") ?? "").toLowerCase() === "true";
  } catch {
    return false;
  }
}

function replayUrl(row: CdxRow): string {
  return `https://web.archive.org/web/${row.timestamp}id_/${row.original}`;
}

function chooseReplayCandidates(rows: CdxRow[]): CdxRow[] {
  const bySeason = new Map<number, CdxRow[]>();
  for (const row of rows) {
    const season = seasonFromUrl(row.original);
    if (season == null || !isPitcherUrl(row.original)) continue;
    const list = bySeason.get(season) ?? [];
    list.push(row);
    bySeason.set(season, list);
  }

  const chosen: CdxRow[] = [];
  for (const season of SEASONS) {
    const rowsForSeason = (bySeason.get(season) ?? []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const csv = rowsForSeason.filter((row) => isCsvUrl(row.original) || row.mimetype.includes("csv"));
    const source = csv.length ? csv : rowsForSeason;
    if (!source.length) continue;
    const indices = [...new Set([0, Math.floor((source.length - 1) / 2), source.length - 1])];
    for (const index of indices) chosen.push(source[index]);
  }
  return chosen;
}

async function main() {
  const cdxUrl = new URL("https://web.archive.org/cdx/search/cdx");
  cdxUrl.searchParams.set("url", SAVANT_PATH);
  cdxUrl.searchParams.set("output", "json");
  cdxUrl.searchParams.set("from", "2022");
  cdxUrl.searchParams.set("to", "2026");
  cdxUrl.searchParams.append("filter", "statuscode:200");
  cdxUrl.searchParams.set("collapse", "digest");
  cdxUrl.searchParams.set("fl", "timestamp,original,mimetype,statuscode,digest,length");
  cdxUrl.searchParams.set("limit", "5000");

  const cdx = await fetchText(cdxUrl.toString());
  let rows: CdxRow[] = [];
  let parseError: string | null = null;
  if (cdx.ok) {
    try { rows = parseCdx(cdx.text); }
    catch (error) { parseError = String(error); }
  }

  const pitcherRows = rows.filter((row) => isPitcherUrl(row.original));
  const csvRows = pitcherRows.filter((row) => isCsvUrl(row.original) || row.mimetype.includes("csv"));
  const seasonInventory = SEASONS.map((season) => {
    const all = pitcherRows.filter((row) => seasonFromUrl(row.original) === season);
    const csv = all.filter((row) => isCsvUrl(row.original) || row.mimetype.includes("csv"));
    return {
      season,
      captures: all.length,
      csvCaptures: csv.length,
      firstTimestamp: all[0]?.timestamp ?? null,
      lastTimestamp: all.at(-1)?.timestamp ?? null,
      sampleOriginals: [...new Set(all.slice(0, 5).map((row) => row.original))],
    };
  });

  const replayEvidence: unknown[] = [];
  for (const row of chooseReplayCandidates(rows).slice(0, 15)) {
    const replay = await fetchText(replayUrl(row));
    const body = replay.text;
    const lower = body.toLowerCase();
    replayEvidence.push({
      timestamp: row.timestamp,
      original: row.original,
      season: seasonFromUrl(row.original),
      cdxMimetype: row.mimetype,
      cdxDigest: row.digest,
      cdxLength: row.length,
      replayOk: replay.ok,
      replayStatus: replay.status,
      replayError: replay.error,
      replayBytes: Buffer.byteLength(body),
      replaySha256: replay.ok ? sha256(body) : null,
      looksCsv: replay.ok && !/^\s*</.test(body),
      hasXeraToken: replay.ok && /(^|[\s,"'>])xera([\s,"'<]|$)/i.test(body),
      hasExpectedStatsFields: replay.ok && lower.includes("est_woba") && lower.includes("pa"),
      replayUrl: replayUrl(row),
    });
  }

  const anyOfficialSavantCapture = pitcherRows.length > 0;
  const anyOfficialCsvCapture = csvRows.length > 0;
  const anyReplayWithXera = replayEvidence.some((item: any) => item.replayOk && item.hasXeraToken);

  const evidence = {
    schemaVersion: SCHEMA,
    status: "WAYBACK_PRIMARY_CONTENT_CUSTODY_AVAILABILITY_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    sourceModel: {
      canonicalPublisherHost: "baseballsavant.mlb.com",
      archiveTransport: "Internet Archive Wayback Machine",
      archiveTransportIsPublisher: false,
      authorityPolicy: "Only replayed captures whose original URL is Baseball Savant may be considered preserved primary-publisher content. Archive timestamps prove archive capture time, not MLB publication guarantees or completeness.",
    },
    cdx: {
      url: cdxUrl.toString(),
      ok: cdx.ok,
      status: cdx.status,
      error: cdx.error,
      parseError,
      rawSha256: cdx.ok ? sha256(cdx.text) : null,
      totalRows: rows.length,
      pitcherRows: pitcherRows.length,
      csvRows: csvRows.length,
    },
    seasonInventory,
    replayEvidence,
    scientificConclusion: {
      anyOfficialSavantCapture,
      anyOfficialCsvCapture,
      anyReplayWithXera,
      primaryAsOfXeraCustodyProven: false,
      captureCompletenessForPregameReplayProven: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
      nextGate: anyReplayWithXera
        ? "VALIDATE_REPLAYED_OFFICIAL_SAVANT_CAPTURE_CONTENT_AND_TEMPORAL_COVERAGE; THEN TEST WHETHER CAPTURES CAN SUPPLY OR IDENTIFY EXACT_TARGET_DATE_XERA_WITHOUT_INTERPOLATION"
        : "WAYBACK_DID_NOT_YET_PROVE_USABLE_OFFICIAL_XERA_CUSTODY; CONTINUE PRIMARY_SOURCE_CUSTODY_OR_EXACT_INTERNAL_CONVERSION_PARAMETER_RESEARCH",
    },
    interpretationPolicy: {
      archiveCaptureDoesNotEqualCompleteDailyCustody: true,
      noInterpolationBetweenSnapshots: true,
      noThirdPartyComputedXeraAsAuthority: true,
      noFinalSeasonMappingRetroactiveUse: true,
      approximationForbidden: true,
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
  const out = outArg?.slice("--out=".length) ?? "artifacts/mlb-r1b-statcast-xera-wayback-primary-custody-probe/evidence.json";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    status: evidence.status,
    cdx: evidence.cdx,
    seasonInventory: evidence.seasonInventory,
    scientificConclusion: evidence.scientificConclusion,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
