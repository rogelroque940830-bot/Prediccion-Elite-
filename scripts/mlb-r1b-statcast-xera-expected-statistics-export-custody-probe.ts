import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-expected-statistics-export-custody-probe.v1" as const;
const STATUS = "SAVANT_EXPECTED_STATISTICS_EXPORT_CUSTODY_PROBE_ONLY_NOT_PARITY_CERTIFICATION" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Expected-Stats-Export-Custody/1.0)";
const PRIMARY_HOST = "baseballsavant.mlb.com";
const ARCHIVE_HOST = "web.archive.org";
const SEASON = 2022;
const ANCHORS = ["2022-05-03", "2022-05-23", "2022-10-23"] as const;

type CdxRow = { timestamp: string; original: string; mimetype: string; statuscode: string; digest: string; length: string };

function sha256(text: string): string { return crypto.createHash("sha256").update(text).digest("hex"); }

async function fetchText(url: string, accept = "application/json,text/csv,text/plain,text/html;q=0.8,*/*;q=0.5") {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: accept, "User-Agent": UA }, signal: AbortSignal.timeout(90_000) });
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

function replayUrl(row: CdxRow): string { return `https://${ARCHIVE_HOST}/web/${row.timestamp}id_/${row.original}`; }
function captureDate(timestamp: string): string | null { return /^\d{14}$/.test(timestamp) ? `${timestamp.slice(0,4)}-${timestamp.slice(4,6)}-${timestamp.slice(6,8)}` : null; }
function daysBetween(a: string, b: string): number { return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000); }

function queryInfo(original: string) {
  try {
    const u = new URL(original);
    const p: Record<string,string> = {};
    for (const [k,v] of u.searchParams.entries()) p[k] = v;
    return {
      pathname: u.pathname,
      type: u.searchParams.get("type"),
      year: u.searchParams.get("year"),
      min: u.searchParams.get("min"),
      filterType: u.searchParams.get("filterType"),
      csv: u.searchParams.get("csv"),
      team: u.searchParams.get("team"),
      position: u.searchParams.get("position"),
      params: p,
    };
  } catch { return null; }
}

function is2022PitcherExpectedStats(row: CdxRow): boolean {
  const q = queryInfo(row.original);
  if (!q) return false;
  return q.year === "2022" && q.type === "pitcher" && q.pathname.includes("expected_statistics");
}

function isCsvRequested(row: CdxRow): boolean {
  const q = queryInfo(row.original);
  return q?.csv?.toLowerCase() === "true";
}

function csvHeaders(text: string): string[] {
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/,1)[0] ?? "";
  return line.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
}

function csvLooksExpectedStats(text: string): boolean {
  if (/^\s*</.test(text)) return false;
  const h = csvHeaders(text).map((x) => x.toLowerCase());
  const joined = h.join("|");
  return h.length > 5 && /player|entity|id/.test(joined) && /xwoba|est_woba/.test(joined);
}

async function main() {
  const patterns = [
    `${PRIMARY_HOST}/expected_statistics*`,
    `${PRIMARY_HOST}/leaderboard/expected_statistics*`,
  ];

  const patternEvidence: unknown[] = [];
  const allRows: CdxRow[] = [];
  for (const pattern of patterns) {
    const u = cdxUrl(pattern);
    const fetched = await fetchText(u, "application/json,*/*;q=0.8");
    if (!fetched.ok) {
      patternEvidence.push({ pattern, ok: false, error: fetched.error, rows: 0 });
      continue;
    }
    const rows = parseCdx(fetched.text);
    allRows.push(...rows);
    patternEvidence.push({ pattern, ok: true, error: null, rows: rows.length, uniqueOriginals: new Set(rows.map((r)=>r.original)).size });
  }

  const uniqueMap = new Map<string,CdxRow>();
  for (const row of allRows) uniqueMap.set(`${row.timestamp}\n${row.original}`, row);
  const uniqueRows = [...uniqueMap.values()];
  const pitcher2022 = uniqueRows.filter(is2022PitcherExpectedStats);
  const explicitCsv = pitcher2022.filter(isCsvRequested);
  const csvMimetype = pitcher2022.filter((r) => /csv/i.test(r.mimetype));
  const replayCandidatesMap = new Map<string,CdxRow>();
  for (const row of [...explicitCsv, ...csvMimetype]) replayCandidatesMap.set(`${row.timestamp}\n${row.original}`, row);
  const replayCandidates = [...replayCandidatesMap.values()];

  const nearestByAnchor = ANCHORS.map((anchor) => ({
    anchor,
    nearest: replayCandidates
      .map((row) => ({ row, date: captureDate(row.timestamp) }))
      .filter((x): x is {row:CdxRow;date:string} => x.date != null)
      .map((x) => ({ ...x, distanceDays: daysBetween(anchor, x.date) }))
      .sort((a,b) => a.distanceDays-b.distanceDays || a.row.timestamp.localeCompare(b.row.timestamp))
      .slice(0,10)
      .map(({row,date,distanceDays}) => ({ timestamp: row.timestamp, captureDate: date, distanceDays, original: row.original, mimetype: row.mimetype, digest: row.digest, query: queryInfo(row.original) })),
  }));

  const replaySample = replayCandidates
    .map((row) => ({ row, d: captureDate(row.timestamp) }))
    .filter((x): x is {row:CdxRow;d:string} => x.d != null)
    .sort((a,b) => Math.min(...ANCHORS.map((d)=>daysBetween(d,a.d))) - Math.min(...ANCHORS.map((d)=>daysBetween(d,b.d))))
    .slice(0,30)
    .map((x)=>x.row);

  const replays: unknown[] = [];
  let csvPayloadCount = 0;
  let expectedStatsCsvPayloadCount = 0;
  let payloadWithXeraCount = 0;
  for (const row of replaySample) {
    const replay = await fetchText(replayUrl(row), "text/csv,text/plain;q=0.9,text/html;q=0.5,*/*;q=0.2");
    const headers = replay.ok && !/^\s*</.test(replay.text) ? csvHeaders(replay.text) : [];
    const lower = headers.map((x)=>x.toLowerCase());
    const csvish = replay.ok && headers.length > 5 && !/^\s*</.test(replay.text);
    const expectedCsv = replay.ok && csvLooksExpectedStats(replay.text);
    const hasXera = lower.includes("xera");
    if (csvish) csvPayloadCount++;
    if (expectedCsv) expectedStatsCsvPayloadCount++;
    if (expectedCsv && hasXera) payloadWithXeraCount++;
    replays.push({
      timestamp: row.timestamp,
      captureDate: captureDate(row.timestamp),
      original: row.original,
      replayUrl: replayUrl(row),
      cdxMimetype: row.mimetype,
      cdxDigest: row.digest,
      query: queryInfo(row.original),
      replayOk: replay.ok,
      replayStatus: replay.status,
      replayError: replay.error,
      bodySha256: replay.ok ? sha256(replay.text) : null,
      bodyBytes: replay.ok ? Buffer.byteLength(replay.text) : 0,
      csvish,
      expectedStatsCsv: expectedCsv,
      headers,
      hasXera,
    });
  }

  const dates = [...new Set(replayCandidates.map((r)=>captureDate(r.timestamp)).filter((x):x is string=>x!=null))].sort();
  const coverage = ANCHORS.map((anchor) => ({
    anchor,
    exactDateCaptureCandidates: replayCandidates.filter((r)=>captureDate(r.timestamp)===anchor).length,
    withinOneDayCaptureCandidates: replayCandidates.filter((r)=>{const d=captureDate(r.timestamp); return d!=null && daysBetween(anchor,d)<=1;}).length,
    withinSevenDaysCaptureCandidates: replayCandidates.filter((r)=>{const d=captureDate(r.timestamp); return d!=null && daysBetween(anchor,d)<=7;}).length,
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
      onlyReplayedPrimaryPublisherPayloadCanServeAsTruthAnchor: true,
    },
    researchQuestion: "Did Wayback preserve official Baseball Savant Expected Statistics CSV/export payloads for 2022 pitcher states that can provide same-vintage xwOBA/xERA custody?",
    scientificPolicy: {
      primaryPublisherOnly: true,
      noThirdPartyDataAuthority: true,
      noInterpolationBetweenSnapshots: true,
      noEmpiricalFitAuthorized: true,
      approximationForbidden: true,
      xeraNotUsedToRankArchiveCandidates: true,
      captureExistenceDoesNotEqualCompletePregameCoverage: true,
    },
    patternEvidence,
    inventory: {
      uniqueRowsAcrossPatterns: uniqueRows.length,
      pitcher2022ExpectedStatsRows: pitcher2022.length,
      explicitCsvTrueRows: explicitCsv.length,
      csvMimetypeRows: csvMimetype.length,
      replayCandidateRows: replayCandidates.length,
      replayCandidateCaptureDates: dates.length,
      firstReplayCandidateDate: dates[0] ?? null,
      lastReplayCandidateDate: dates.at(-1) ?? null,
      replaySampleCount: replaySample.length,
      csvPayloadCount,
      expectedStatsCsvPayloadCount,
      expectedStatsCsvWithXeraCount: payloadWithXeraCount,
    },
    coverage,
    nearestByAnchor,
    replays,
    scientificConclusion: {
      archivedOfficialExpectedStatsCsvObserved: expectedStatsCsvPayloadCount > 0,
      archivedOfficialExpectedStatsCsvWithXeraObserved: payloadWithXeraCount > 0,
      completeDailyPregameHistoricalCustodyProven: false,
      exactTargetDateXeraCustodyForFullUniverseProven: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
      nextGate: expectedStatsCsvPayloadCount > 0
        ? "VALIDATE SAME-VINTAGE EXPECTED-STATS CSV PAYLOAD AGAINST ARCHIVED HTML LEADERBOARD AT MATCHED CAPTURE STATES; THEN QUANTIFY TEMPORAL COVERAGE WITHOUT INTERPOLATION."
        : "NO ARCHIVED OFFICIAL EXPECTED-STATS CSV PAYLOAD WAS PROVEN IN THE TESTED CDX/REPLAY SET; CONTINUE PRIMARY SAVANT SERVICE/DOWNLOAD ENDPOINT DISCOVERY WITHOUT THIRD-PARTY DATA OR EMPIRICAL RECONSTRUCTION.",
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

  const arg = process.argv.find((value)=>value.startsWith("--out="));
  const outPath = arg?.slice(6) || "artifacts/mlb-r1b-statcast-xera-expected-statistics-export-custody-probe/evidence.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence,null,2)}\n`, "utf8");
  console.log(JSON.stringify(evidence,null,2));
}

main().catch((error)=>{ console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); });
