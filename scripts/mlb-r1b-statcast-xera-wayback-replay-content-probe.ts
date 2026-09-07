import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-wayback-replay-content-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Wayback-Content/1.0)";
const SEASONS = [2022, 2023, 2024, 2025, 2026] as const;

type CdxRow = { timestamp: string; original: string; mimetype: string; statuscode: string; digest: string; length: string };
type ParsedRow = {
  playerId: number;
  pa: number | null;
  estWoba: number | null;
  era: number | null;
  xera: number;
  eraMinusXeraDiff: number | null;
};

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number | null; text: string; error: string | null }> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json,text/html;q=0.9,*/*;q=0.8", "User-Agent": UA },
        signal: AbortSignal.timeout(75_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}:${text.slice(0, 180)}`);
      return { ok: true, status: response.status, text, error: null };
    } catch (error) {
      last = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
    }
  }
  return { ok: false, status: null, text: "", error: String(last) };
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

function parseOriginal(original: string): { season: number | null; strictQualifiedAllPitchers: boolean } {
  try {
    const u = new URL(original);
    const rawYear = Number(u.searchParams.get("year"));
    const season = SEASONS.includes(rawYear as (typeof SEASONS)[number]) ? rawYear : null;
    const type = String(u.searchParams.get("type") ?? "").toLowerCase();
    const min = String(u.searchParams.get("min") ?? "").toLowerCase();
    const team = String(u.searchParams.get("team") ?? "");
    const position = String(u.searchParams.get("position") ?? "");
    return {
      season,
      strictQualifiedAllPitchers: season != null && type === "pitcher" && min === "q" && team === "" && position === "",
    };
  } catch {
    return { season: null, strictQualifiedAllPitchers: false };
  }
}

function archiveDate(timestamp: string): string | null {
  if (!/^\d{14}$/.test(timestamp)) return null;
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
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

function assertNumberPropertyParser(): void {
  const sample = '{"player_id":657277,"pa":314,"est_woba":".324","xera":"4.26","era":"3.10","era_minus_xera_diff":"-1.16"}';
  const expected: Array<[readonly string[], number]> = [
    [["player_id", "entity_id"], 657277],
    [["pa"], 314],
    [["est_woba"], 0.324],
    [["xera"], 4.26],
    [["era"], 3.1],
    [["era_minus_xera_diff"], -1.16],
  ];
  for (const [names, value] of expected) {
    const parsed = numberProperty(sample, names);
    if (parsed !== value) throw new Error(`PROPERTY_PARSER_SELF_TEST_FAILED:${names.join("|")}:${String(parsed)}:${value}`);
  }
}

function extractFlatExpectedRows(html: string): { rows: ParsedRow[]; candidateObjects: number; xeraSnippets: string[] } {
  const decoded = decodeHtmlEntities(html);
  const objectRe = /\{[^{}]{20,9000}\}/g;
  const rows = new Map<number, ParsedRow>();
  let candidateObjects = 0;
  for (const match of decoded.matchAll(objectRe)) {
    const objectText = match[0];
    if (!/\bxera\b/i.test(objectText) || !/\best_woba\b/i.test(objectText)) continue;
    candidateObjects++;
    const playerId = numberProperty(objectText, ["player_id", "entity_id"]);
    const xera = numberProperty(objectText, ["xera"]);
    if (playerId == null || xera == null) continue;
    rows.set(playerId, {
      playerId,
      pa: numberProperty(objectText, ["pa"]),
      estWoba: numberProperty(objectText, ["est_woba"]),
      era: numberProperty(objectText, ["era"]),
      xera,
      eraMinusXeraDiff: numberProperty(objectText, ["era_minus_xera_diff"]),
    });
  }

  const snippets: string[] = [];
  const lower = decoded.toLowerCase();
  let cursor = 0;
  while (snippets.length < 8) {
    const found = lower.indexOf("xera", cursor);
    if (found < 0) break;
    const start = Math.max(0, found - 220);
    const end = Math.min(decoded.length, found + 420);
    snippets.push(decoded.slice(start, end).replace(/\s+/g, " ").slice(0, 700));
    cursor = found + 4;
  }

  return { rows: [...rows.values()].sort((a, b) => a.playerId - b.playerId), candidateObjects, xeraSnippets: snippets };
}

function pickRepresentatives(rows: readonly CdxRow[]): CdxRow[] {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const idx = [...new Set([0, Math.floor((sorted.length - 1) / 3), Math.floor((2 * (sorted.length - 1)) / 3), sorted.length - 1])];
  return idx.map((i) => sorted[i]);
}

function dayGap(left: string, right: string): number | null {
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : null;
}

function compareCaptures(captures: readonly { timestamp: string; rows: ParsedRow[] }[]) {
  const out: unknown[] = [];
  for (let i = 1; i < captures.length; i++) {
    const left = captures[i - 1];
    const right = captures[i];
    const l = new Map(left.rows.map((row) => [row.playerId, row]));
    const r = new Map(right.rows.map((row) => [row.playerId, row]));
    const common = [...l.keys()].filter((id) => r.has(id));
    const changedPa = common.filter((id) => l.get(id)?.pa !== r.get(id)?.pa).length;
    const changedXwoba = common.filter((id) => l.get(id)?.estWoba !== r.get(id)?.estWoba).length;
    const changedXera = common.filter((id) => l.get(id)?.xera !== r.get(id)?.xera).length;
    out.push({ left: left.timestamp, right: right.timestamp, commonPlayers: common.length, changedPa, changedXwoba, changedXera });
  }
  return out;
}

async function main() {
  assertNumberPropertyParser();

  const cdxUrl = new URL("https://web.archive.org/cdx/search/cdx");
  cdxUrl.searchParams.set("url", "baseballsavant.mlb.com/leaderboard/expected_statistics*");
  cdxUrl.searchParams.set("output", "json");
  cdxUrl.searchParams.set("from", "2022");
  cdxUrl.searchParams.set("to", "2026");
  cdxUrl.searchParams.append("filter", "statuscode:200");
  cdxUrl.searchParams.set("collapse", "digest");
  cdxUrl.searchParams.set("fl", "timestamp,original,mimetype,statuscode,digest,length");
  cdxUrl.searchParams.set("limit", "5000");

  const cdx = await fetchText(cdxUrl.toString());
  if (!cdx.ok) throw new Error(`CDX_FETCH_FAILED:${cdx.error}`);
  const rows = parseCdx(cdx.text);

  const seasonEvidence: unknown[] = [];
  let parsedCaptureCount = 0;
  let parsedRowCount = 0;
  let productionTupleRowCount = 0;
  let parserIntegrityCheckedRowCount = 0;
  let parserIntegrityMismatchCount = 0;
  let temporalChangeObserved = false;

  for (const season of SEASONS) {
    const strict = rows
      .filter((row) => {
        const parsed = parseOriginal(row.original);
        return parsed.season === season && parsed.strictQualifiedAllPitchers;
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const sameYear = strict.filter((row) => row.timestamp.startsWith(String(season)));
    const sameYearDates = [...new Set(sameYear.map((row) => archiveDate(row.timestamp)).filter((x): x is string => x != null))].sort();
    const gaps = sameYearDates.slice(1).map((date, index) => dayGap(sameYearDates[index], date)).filter((x): x is number => x != null);
    const representatives = pickRepresentatives(sameYear);
    const captures: Array<{
      timestamp: string;
      archiveDate: string | null;
      original: string;
      cdxDigest: string;
      replayOk: boolean;
      replayStatus: number | null;
      replayError: string | null;
      bodyBytes: number;
      bodySha256: string | null;
      candidateObjects: number;
      parsedRows: number;
      rowsWithPa: number;
      rowsWithXwoba: number;
      rowsWithEra: number;
      rowsWithEraMinusXeraDiff: number;
      rowsWithProductionExpectedTuple: number;
      arithmeticDiffCheckedRows: number;
      arithmeticDiffMismatchCount: number;
      rowExamples: ParsedRow[];
      xeraSnippets: string[];
      rows: ParsedRow[];
    }> = [];

    for (const row of representatives) {
      const replay = await fetchText(replayUrl(row));
      const extracted = replay.ok ? extractFlatExpectedRows(replay.text) : { rows: [], candidateObjects: 0, xeraSnippets: [] };
      const arithmeticChecked = extracted.rows.filter((item) => item.era != null && item.eraMinusXeraDiff != null);
      const arithmeticMismatch = arithmeticChecked.filter((item) => Math.abs((item.era! - item.xera) - item.eraMinusXeraDiff!) > 0.011).length;
      const productionTuple = extracted.rows.filter(
        (item) => item.pa != null && item.estWoba != null && item.eraMinusXeraDiff != null,
      ).length;

      parsedCaptureCount += extracted.rows.length > 0 ? 1 : 0;
      parsedRowCount += extracted.rows.length;
      productionTupleRowCount += productionTuple;
      parserIntegrityCheckedRowCount += arithmeticChecked.length;
      parserIntegrityMismatchCount += arithmeticMismatch;

      captures.push({
        timestamp: row.timestamp,
        archiveDate: archiveDate(row.timestamp),
        original: row.original,
        cdxDigest: row.digest,
        replayOk: replay.ok,
        replayStatus: replay.status,
        replayError: replay.error,
        bodyBytes: Buffer.byteLength(replay.text),
        bodySha256: replay.ok ? sha256(replay.text) : null,
        candidateObjects: extracted.candidateObjects,
        parsedRows: extracted.rows.length,
        rowsWithPa: extracted.rows.filter((item) => item.pa != null).length,
        rowsWithXwoba: extracted.rows.filter((item) => item.estWoba != null).length,
        rowsWithEra: extracted.rows.filter((item) => item.era != null).length,
        rowsWithEraMinusXeraDiff: extracted.rows.filter((item) => item.eraMinusXeraDiff != null).length,
        rowsWithProductionExpectedTuple: productionTuple,
        arithmeticDiffCheckedRows: arithmeticChecked.length,
        arithmeticDiffMismatchCount: arithmeticMismatch,
        rowExamples: extracted.rows.slice(0, 8),
        xeraSnippets: extracted.xeraSnippets,
        rows: extracted.rows,
      });
    }

    const temporalComparisons = compareCaptures(captures);
    if (temporalComparisons.some((item: any) => item.changedXera > 0 || item.changedXwoba > 0 || item.changedPa > 0)) temporalChangeObserved = true;

    seasonEvidence.push({
      season,
      strictQualifiedAllPitcherCapturesAllArchiveYears: strict.length,
      sameCalendarYearCaptureCount: sameYear.length,
      sameCalendarYearUniqueCaptureDates: sameYearDates.length,
      firstSameYearCaptureDate: sameYearDates[0] ?? null,
      lastSameYearCaptureDate: sameYearDates.at(-1) ?? null,
      maxGapDaysBetweenSameYearCaptureDates: gaps.length ? Math.max(...gaps) : null,
      captureDates: sameYearDates,
      representativeCaptures: captures.map(({ rows: _rows, ...rest }) => rest),
      temporalComparisons,
    });
  }

  const parserIntegritySupported = parserIntegrityCheckedRowCount > 0 && parserIntegrityMismatchCount === 0;
  const truthAnchorSupported = productionTupleRowCount > 0 && parserIntegritySupported;

  const evidence = {
    schemaVersion: SCHEMA,
    status: "WAYBACK_REPLAY_CONTENT_AND_TEMPORAL_COVERAGE_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    sourceAuthority: {
      publisherHost: "baseballsavant.mlb.com",
      preservationTransport: "Internet Archive Wayback Machine",
      archiveIsPublisher: false,
      preservedPagePolicy: "Replayed body is preserved content from an original Baseball Savant URL. Archive timestamp establishes archive capture time only; it does not establish complete daily MLB custody or publication timing guarantees.",
    },
    cdx: { url: cdxUrl.toString(), rawSha256: sha256(cdx.text), totalRows: rows.length },
    seasonEvidence,
    summary: {
      parsedCaptureCount,
      parsedRowCount,
      productionTupleRowCount,
      parserIntegrityCheckedRowCount,
      parserIntegrityMismatchCount,
      parserIntegritySupported,
      temporalChangeObserved,
      completeDailyPregameCoverageProven: false,
      exactTargetDateXeraCustodyForFullUniverseProven: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
    },
    scientificConclusion: {
      replayedOfficialSavantRowsParsed: parsedRowCount > 0,
      archivedProductionExpectedTupleRowsParsed: productionTupleRowCount > 0,
      parserIntegritySupported,
      archivedValuesChangeAcrossSeasonSnapshots: temporalChangeObserved,
      archiveCanServeAsPrimaryPublisherTruthAnchorAtCapturedStates: truthAnchorSupported,
      archiveCanServeAsCompletePregameHistoricalSource: false,
      familyPromotionAuthorized: false,
      nextGate: truthAnchorSupported
        ? "USE REPLAYED OFFICIAL SAVANT SNAPSHOTS ONLY AS EXACT TRUTH ANCHORS; VALIDATE DATE-BOUNDED RAW-STATCAST RECONSTRUCTION AGAINST THOSE ANCHORS AND IDENTIFY THE MISSING xERA TRANSFORMATION SEMANTICS. DO NOT INTERPOLATE BETWEEN ARCHIVE CAPTURES."
        : "PARSER_OR_FIELD_INTEGRITY_DID_NOT_SUPPORT_TRUTH_ANCHOR_USE; REFINE PRIMARY-CONTENT EXTRACTION WITHOUT EMPIRICAL xERA RECONSTRUCTION",
    },
    interpretationPolicy: {
      exactPropertyBoundaryRequired: true,
      leadingDecimalNumericValuesSupported: true,
      noInterpolationBetweenArchiveSnapshots: true,
      sparseArchiveCoverageCannotAuthorizeFullReplay: true,
      archivedPrimaryPublisherContentMayBeUsedAsVerificationAnchor: truthAnchorSupported,
      noThirdPartyComputedXeraAsAuthority: true,
      noEmpiricalXeraFitAuthorized: true,
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
  const out = outArg?.slice("--out=".length) ?? "artifacts/mlb-r1b-statcast-xera-wayback-replay-content-probe/evidence.json";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    status: evidence.status,
    summary: evidence.summary,
    scientificConclusion: evidence.scientificConclusion,
    seasonEvidence: seasonEvidence.map((item: any) => ({
      season: item.season,
      strict: item.strictQualifiedAllPitcherCapturesAllArchiveYears,
      sameYear: item.sameCalendarYearCaptureCount,
      uniqueDates: item.sameCalendarYearUniqueCaptureDates,
      first: item.firstSameYearCaptureDate,
      last: item.lastSameYearCaptureDate,
      maxGapDays: item.maxGapDaysBetweenSameYearCaptureDates,
      representativeParsedRows: item.representativeCaptures.map((capture: any) => capture.parsedRows),
      representativeProductionTupleRows: item.representativeCaptures.map((capture: any) => capture.rowsWithProductionExpectedTuple),
      representativeArithmeticMismatchCounts: item.representativeCaptures.map((capture: any) => capture.arithmeticDiffMismatchCount),
      temporalComparisons: item.temporalComparisons,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
