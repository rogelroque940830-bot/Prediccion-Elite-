import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-expected-statistics-export-custody-probe.v2" as const;
const STATUS = "SAVANT_EXPECTED_STATISTICS_EXPORT_CUSTODY_PROBE_ONLY_NOT_PARITY_CERTIFICATION" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Expected-Stats-Export-Custody/2.0)";
const PRIMARY_HOST = "baseballsavant.mlb.com";
const ARCHIVE_HOST = "web.archive.org";
const SEASON = 2022;
const ANCHORS = ["2022-05-03", "2022-05-23", "2022-10-23"] as const;
const MAX_REPLAYS_PER_ANCHOR = 20;

type CdxRow = {
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
};

type NumericField = { key: string; value: number; decimalDigits: number };

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function fetchText(
  url: string,
  accept = "application/json,text/csv,text/plain,text/html;q=0.8,*/*;q=0.5",
) {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: accept, "User-Agent": UA },
        signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}:${text.slice(0, 180)}`);
      return {
        ok: true,
        status: response.status,
        text,
        contentType: response.headers.get("content-type"),
        error: null as string | null,
      };
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  return {
    ok: false,
    status: null as number | null,
    text: "",
    contentType: null as string | null,
    error: String(last),
  };
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

function replayUrl(row: CdxRow): string {
  return `https://${ARCHIVE_HOST}/web/${row.timestamp}id_/${row.original}`;
}

function captureDate(timestamp: string): string | null {
  return /^\d{14}$/.test(timestamp)
    ? `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`
    : null;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000,
  );
}

function queryInfo(original: string) {
  try {
    const u = new URL(original);
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) params[k] = v;
    return {
      pathname: u.pathname,
      type: u.searchParams.get("type"),
      year: u.searchParams.get("year"),
      min: u.searchParams.get("min"),
      filterType: u.searchParams.get("filterType"),
      csv: u.searchParams.get("csv"),
      team: u.searchParams.get("team"),
      position: u.searchParams.get("position"),
      params,
    };
  } catch {
    return null;
  }
}

function candidateClass(row: CdxRow): "EXPECTED_STATS" | "LEADERBOARD_SERVICE" | "OTHER" {
  const q = queryInfo(row.original);
  const pathname = q?.pathname.toLowerCase() ?? "";
  if (pathname.includes("expected_statistics")) return "EXPECTED_STATS";
  if (pathname.includes("leaderboard/services")) return "LEADERBOARD_SERVICE";
  return "OTHER";
}

function isRelevant2022Candidate(row: CdxRow): boolean {
  const q = queryInfo(row.original);
  const klass = candidateClass(row);
  if (klass === "EXPECTED_STATS") {
    if (q?.year && q.year !== String(SEASON)) return false;
    if (q?.type && q.type !== "pitcher") return false;
    return true;
  }
  if (klass === "LEADERBOARD_SERVICE") {
    if (q?.year && q.year !== String(SEASON)) return false;
    if (q?.type && q.type !== "pitcher") return false;
    return true;
  }
  return false;
}

function relevanceScore(row: CdxRow): number {
  const lower = row.original.toLowerCase();
  const q = queryInfo(row.original);
  let score = 0;
  if (candidateClass(row) === "EXPECTED_STATS") score += 100;
  if (candidateClass(row) === "LEADERBOARD_SERVICE") score += 60;
  if (q?.year === String(SEASON)) score += 25;
  if (q?.type === "pitcher") score += 25;
  if (lower.includes("expected_statistics")) score += 20;
  if (/csv|download|export/.test(lower)) score += 15;
  if (/json|csv|plain/i.test(row.mimetype)) score += 5;
  return score;
}

function csvHeaders(text: string): string[] {
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  return line.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
}

function csvRows(text: string, maxRows = 500): string[][] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1, maxRows + 1)
    .map((line) => line.split(",").map((x) => x.replace(/^"|"$/g, "").trim()));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function keySignals(keys: string[]) {
  const normalized = keys.map(normalizeKey);
  const hasXwoba = normalized.some((k) => k === "xwoba" || k === "est_woba" || k.includes("expected_woba"));
  const hasXera = normalized.some((k) => k === "xera" || k === "x_era" || k.includes("expected_era"));
  const hasActualWoba = normalized.some(
    (k) => (k === "woba" || k === "actual_woba" || k === "woba_value") && !k.includes("xwoba"),
  );
  const hasWobaDiff = normalized.some((k) => k === "x_woba_diff" || k === "xwoba_diff" || k === "woba_diff");
  const hasPa = normalized.some((k) => k === "pa" || k === "plate_appearances" || k === "plateappearances");
  return { hasXwoba, hasXera, hasActualWoba, hasWobaDiff, hasPa };
}

function decimalDigits(raw: string): number {
  const match = String(raw).trim().match(/^-?\d+\.(\d+)$/);
  return match ? match[1].length : 0;
}

function inspectCsv(text: string) {
  const headers = csvHeaders(text);
  const normalized = headers.map(normalizeKey);
  const signals = keySignals(headers);
  const rows = csvRows(text);
  const numericFields: NumericField[] = [];
  for (const key of ["woba", "actual_woba", "xwoba", "est_woba", "x_woba_diff", "xera", "x_era", "pa"]) {
    const ix = normalized.indexOf(key);
    if (ix < 0) continue;
    for (const row of rows.slice(0, 50)) {
      const raw = row[ix] ?? "";
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      numericFields.push({ key, value, decimalDigits: decimalDigits(raw) });
    }
  }
  return {
    headers,
    signals,
    rowCountSampled: rows.length,
    maxActualWobaDecimalDigits: Math.max(
      0,
      ...numericFields
        .filter((f) => f.key === "woba" || f.key === "actual_woba")
        .map((f) => f.decimalDigits),
    ),
    maxXwobaDecimalDigits: Math.max(
      0,
      ...numericFields
        .filter((f) => f.key === "xwoba" || f.key === "est_woba")
        .map((f) => f.decimalDigits),
    ),
    numericFieldSample: numericFields.slice(0, 40),
  };
}

function collectJsonKeysAndNumbers(value: unknown, depth = 0, outKeys = new Set<string>(), outNumbers: NumericField[] = []) {
  if (depth > 8 || value == null) return { keys: outKeys, numbers: outNumbers };
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) collectJsonKeysAndNumbers(item, depth + 1, outKeys, outNumbers);
    return { keys: outKeys, numbers: outNumbers };
  }
  if (typeof value !== "object") return { keys: outKeys, numbers: outNumbers };
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    outKeys.add(key);
    if (typeof child === "number" && Number.isFinite(child)) {
      outNumbers.push({ key: normalizeKey(key), value: child, decimalDigits: decimalDigits(String(child)) });
    } else if (typeof child === "string" && /^-?\d+(?:\.\d+)?$/.test(child.trim())) {
      outNumbers.push({ key: normalizeKey(key), value: Number(child), decimalDigits: decimalDigits(child) });
    }
    collectJsonKeysAndNumbers(child, depth + 1, outKeys, outNumbers);
  }
  return { keys: outKeys, numbers: outNumbers };
}

function inspectJson(text: string) {
  try {
    const parsed = JSON.parse(text) as unknown;
    const collected = collectJsonKeysAndNumbers(parsed);
    const keys = [...collected.keys];
    const signals = keySignals(keys);
    return {
      parseOk: true,
      keys: keys.slice(0, 300),
      signals,
      maxActualWobaDecimalDigits: Math.max(
        0,
        ...collected.numbers
          .filter((f) => f.key === "woba" || f.key === "actual_woba")
          .map((f) => f.decimalDigits),
      ),
      maxXwobaDecimalDigits: Math.max(
        0,
        ...collected.numbers
          .filter((f) => f.key === "xwoba" || f.key === "est_woba")
          .map((f) => f.decimalDigits),
      ),
      numericFieldSample: collected.numbers
        .filter((f) => /woba|era|plate|^pa$/.test(f.key))
        .slice(0, 60),
    };
  } catch {
    return {
      parseOk: false,
      keys: [] as string[],
      signals: keySignals([]),
      maxActualWobaDecimalDigits: 0,
      maxXwobaDecimalDigits: 0,
      numericFieldSample: [] as NumericField[],
    };
  }
}

function routeHints(text: string): string[] {
  const matches = text.match(/(?:https?:\/\/baseballsavant\.mlb\.com)?\/[A-Za-z0-9_?=&.%/+:-]*(?:csv|download|export|leaderboard\/services|expected_statistics)[A-Za-z0-9_?=&.%/+:-]*/gi) ?? [];
  return [...new Set(matches)].slice(0, 50);
}

async function main() {
  const patterns = [
    `${PRIMARY_HOST}/expected_statistics*`,
    `${PRIMARY_HOST}/leaderboard/expected_statistics*`,
    `${PRIMARY_HOST}/leaderboard/services*`,
  ];

  const patternEvidence: unknown[] = [];
  const allRows: CdxRow[] = [];
  for (const pattern of patterns) {
    const url = cdxUrl(pattern);
    const fetched = await fetchText(url, "application/json,*/*;q=0.8");
    if (!fetched.ok) {
      patternEvidence.push({ pattern, ok: false, error: fetched.error, rows: 0 });
      continue;
    }
    const rows = parseCdx(fetched.text);
    allRows.push(...rows);
    patternEvidence.push({
      pattern,
      ok: true,
      error: null,
      rows: rows.length,
      uniqueOriginals: new Set(rows.map((r) => r.original)).size,
    });
  }

  const uniqueMap = new Map<string, CdxRow>();
  for (const row of allRows) uniqueMap.set(`${row.timestamp}\n${row.original}`, row);
  const uniqueRows = [...uniqueMap.values()];
  const relevant = uniqueRows.filter(isRelevant2022Candidate);

  const nearestByAnchor = ANCHORS.map((anchor) => ({
    anchor,
    nearest: relevant
      .map((row) => ({ row, date: captureDate(row.timestamp) }))
      .filter((x): x is { row: CdxRow; date: string } => x.date != null)
      .map((x) => ({
        ...x,
        distanceDays: daysBetween(anchor, x.date),
        relevanceScore: relevanceScore(x.row),
      }))
      .sort(
        (a, b) =>
          a.distanceDays - b.distanceDays ||
          b.relevanceScore - a.relevanceScore ||
          a.row.timestamp.localeCompare(b.row.timestamp),
      )
      .slice(0, MAX_REPLAYS_PER_ANCHOR)
      .map(({ row, date, distanceDays, relevanceScore: score }) => ({
        timestamp: row.timestamp,
        captureDate: date,
        distanceDays,
        relevanceScore: score,
        candidateClass: candidateClass(row),
        original: row.original,
        mimetype: row.mimetype,
        digest: row.digest,
        query: queryInfo(row.original),
      })),
  }));

  const replayMap = new Map<string, CdxRow>();
  for (const group of nearestByAnchor) {
    for (const item of group.nearest) {
      const row = relevant.find((r) => r.timestamp === item.timestamp && r.original === item.original);
      if (row) replayMap.set(`${row.timestamp}\n${row.original}`, row);
    }
  }
  const replaySample = [...replayMap.values()];

  const replays: unknown[] = [];
  let structuredPayloadCount = 0;
  let payloadWithXwobaCount = 0;
  let payloadWithXeraCount = 0;
  let payloadWithActualWobaCount = 0;
  let payloadWithActualWobaAndXwobaCount = 0;
  let payloadWithWobaDiffCount = 0;
  let payloadWithHighPrecisionActualWobaCount = 0;
  let payloadWithRouteHintsCount = 0;

  for (const row of replaySample) {
    const replay = await fetchText(
      replayUrl(row),
      "application/json,text/csv,text/plain;q=0.9,text/html;q=0.6,*/*;q=0.2",
    );
    const trimmed = replay.text.trimStart();
    const isHtml = replay.ok && /^</.test(trimmed);
    const json = replay.ok && !isHtml ? inspectJson(replay.text) : inspectJson("");
    const csv = replay.ok && !isHtml && !json.parseOk ? inspectCsv(replay.text) : null;
    const signals = json.parseOk ? json.signals : csv?.signals ?? keySignals([]);
    const structured = replay.ok && (json.parseOk || (csv != null && csv.headers.length > 5));
    const maxActualWobaDecimalDigits = json.parseOk
      ? json.maxActualWobaDecimalDigits
      : csv?.maxActualWobaDecimalDigits ?? 0;
    const maxXwobaDecimalDigits = json.parseOk
      ? json.maxXwobaDecimalDigits
      : csv?.maxXwobaDecimalDigits ?? 0;
    const hints = replay.ok ? routeHints(replay.text) : [];

    if (structured) structuredPayloadCount++;
    if (signals.hasXwoba) payloadWithXwobaCount++;
    if (signals.hasXera) payloadWithXeraCount++;
    if (signals.hasActualWoba) payloadWithActualWobaCount++;
    if (signals.hasActualWoba && signals.hasXwoba) payloadWithActualWobaAndXwobaCount++;
    if (signals.hasWobaDiff) payloadWithWobaDiffCount++;
    if (signals.hasActualWoba && maxActualWobaDecimalDigits > 3) payloadWithHighPrecisionActualWobaCount++;
    if (hints.length > 0) payloadWithRouteHintsCount++;

    replays.push({
      timestamp: row.timestamp,
      captureDate: captureDate(row.timestamp),
      original: row.original,
      candidateClass: candidateClass(row),
      relevanceScore: relevanceScore(row),
      replayUrl: replayUrl(row),
      cdxMimetype: row.mimetype,
      cdxDigest: row.digest,
      query: queryInfo(row.original),
      replayOk: replay.ok,
      replayStatus: replay.status,
      replayContentType: replay.contentType,
      replayError: replay.error,
      bodySha256: replay.ok ? sha256(replay.text) : null,
      bodyBytes: replay.ok ? Buffer.byteLength(replay.text) : 0,
      isHtml,
      structured,
      format: json.parseOk ? "json" : csv && csv.headers.length > 5 ? "csvish" : isHtml ? "html" : "unknown",
      signals,
      maxActualWobaDecimalDigits,
      maxXwobaDecimalDigits,
      csvHeaders: csv?.headers ?? [],
      jsonKeys: json.keys,
      numericFieldSample: json.parseOk ? json.numericFieldSample : csv?.numericFieldSample ?? [],
      routeHints: hints,
    });
  }

  const dates = [...new Set(relevant.map((r) => captureDate(r.timestamp)).filter((x): x is string => x != null))].sort();
  const coverage = ANCHORS.map((anchor) => ({
    anchor,
    exactDateRelevantCandidates: relevant.filter((r) => captureDate(r.timestamp) === anchor).length,
    withinOneDayRelevantCandidates: relevant.filter((r) => {
      const d = captureDate(r.timestamp);
      return d != null && daysBetween(anchor, d) <= 1;
    }).length,
    withinSevenDaysRelevantCandidates: relevant.filter((r) => {
      const d = captureDate(r.timestamp);
      return d != null && daysBetween(anchor, d) <= 7;
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
      onlyReplayedPrimaryPublisherPayloadCanServeAsTruthAnchor: true,
    },
    researchQuestion:
      "Can archived primary Baseball Savant Expected Statistics or leaderboard-service payloads recover same-vintage historical actual wOBA/xwOBA at sufficient precision to unlock the xwOBA-to-xERA authority gate?",
    scientificPolicy: {
      primaryPublisherOnly: true,
      noThirdPartyDataAuthority: true,
      noInterpolationBetweenSnapshots: true,
      noEmpiricalFitAuthorized: true,
      approximationForbidden: true,
      xeraNotUsedToRankArchiveCandidates: true,
      captureExistenceDoesNotEqualCompletePregameCoverage: true,
      currentPublisherRecalculationCannotSubstituteForHistoricalVintage: true,
    },
    patternEvidence,
    inventory: {
      uniqueRowsAcrossPatterns: uniqueRows.length,
      relevant2022Rows: relevant.length,
      expectedStatsRows: relevant.filter((r) => candidateClass(r) === "EXPECTED_STATS").length,
      leaderboardServiceRows: relevant.filter((r) => candidateClass(r) === "LEADERBOARD_SERVICE").length,
      relevantCaptureDates: dates.length,
      firstRelevantCaptureDate: dates[0] ?? null,
      lastRelevantCaptureDate: dates.at(-1) ?? null,
      replaySampleCount: replaySample.length,
      structuredPayloadCount,
      payloadWithXwobaCount,
      payloadWithXeraCount,
      payloadWithActualWobaCount,
      payloadWithActualWobaAndXwobaCount,
      payloadWithWobaDiffCount,
      payloadWithHighPrecisionActualWobaCount,
      payloadWithRouteHintsCount,
    },
    coverage,
    nearestByAnchor,
    replays,
    scientificConclusion: {
      archivedPrimaryStructuredPayloadObserved: structuredPayloadCount > 0,
      archivedPrimaryPayloadWithXwobaObserved: payloadWithXwobaCount > 0,
      archivedPrimaryPayloadWithXeraObserved: payloadWithXeraCount > 0,
      archivedPrimaryPayloadWithActualWobaObserved: payloadWithActualWobaCount > 0,
      archivedPrimaryPayloadWithActualWobaAndXwobaObserved: payloadWithActualWobaAndXwobaCount > 0,
      archivedPrimaryPayloadWithWobaDiffObserved: payloadWithWobaDiffCount > 0,
      archivedPrimaryHighPrecisionActualWobaObserved: payloadWithHighPrecisionActualWobaCount > 0,
      completeDailyPregameHistoricalCustodyProven: false,
      exactTargetDateXeraCustodyForFullUniverseProven: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
      nextGate:
        payloadWithHighPrecisionActualWobaCount > 0 && payloadWithXwobaCount > 0
          ? "VALIDATE SAME-VINTAGE PRIMARY PAYLOAD VALUES AGAINST ARCHIVED EXPECTED-STATISTICS HTML AT MATCHED PLAYER/PA STATES; IF EXACT, RECOVER HIDDEN xwOBA WITHOUT FITTING AND ENTER xwOBA-TO-xERA AUTHORITY VALIDATION."
          : payloadWithRouteHintsCount > 0
            ? "FOLLOW ONLY THE DISCOVERED PRIMARY SAVANT DOWNLOAD/SERVICE ROUTE HINTS THROUGH ARCHIVAL CUSTODY; DO NOT SUBSTITUTE CURRENT-VINTAGE VALUES OR FIT A CONVERSION."
            : "ARCHIVED PRIMARY EXPECTED-STATS/SERVICE PAYLOADS TESTED HERE DO NOT YET PROVE HIGH-PRECISION HISTORICAL ACTUAL wOBA + xwOBA CUSTODY; KEEP STATCAST_QUALITY PARTIAL AND CONTINUE PRIMARY-PUBLISHER ARCHIVAL ENDPOINT DISCOVERY ONLY.",
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
  const outPath =
    arg?.slice(6) ||
    "artifacts/mlb-r1b-statcast-xera-expected-statistics-export-custody-probe/evidence.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
