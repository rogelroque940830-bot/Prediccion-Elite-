import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-wayback-mapping-stability-probe.v1" as const;
const STATUS = "WAYBACK_PRIMARY_XERA_MAPPING_STABILITY_PROBE_ONLY_NOT_PARITY_CERTIFICATION" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Wayback-Mapping/1.0)";
const SEASONS = [2022, 2023, 2024, 2025, 2026] as const;

type CdxRow = {
  timestamp: string;
  original: string;
  mimetype: string;
  statuscode: string;
  digest: string;
  length: string;
};

type Point = {
  playerId: number;
  pa: number | null;
  xwoba: number;
  xera: number;
};

type Interval = { lo: number; hi: number };

type QuantizationSpec = {
  id: string;
  xMode: "NEAREST_3DP" | "TRUNCATE_DOWN_3DP" | "TRUNCATE_UP_3DP" | "WIDE_3DP";
  yMode: "NEAREST_2DP" | "TRUNCATE_DOWN_2DP" | "TRUNCATE_UP_2DP" | "WIDE_2DP";
};

const X_MODES: QuantizationSpec["xMode"][] = [
  "NEAREST_3DP",
  "TRUNCATE_DOWN_3DP",
  "TRUNCATE_UP_3DP",
  "WIDE_3DP",
];
const Y_MODES: QuantizationSpec["yMode"][] = [
  "NEAREST_2DP",
  "TRUNCATE_DOWN_2DP",
  "TRUNCATE_UP_2DP",
  "WIDE_2DP",
];
const QUANTIZATION_SPECS: QuantizationSpec[] = X_MODES.flatMap((xMode) =>
  Y_MODES.map((yMode) => ({ id: `${xMode}__${yMode}`, xMode, yMode })),
);

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function fetchText(
  url: string,
): Promise<{ ok: boolean; status: number | null; text: string; error: string | null }> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
          "User-Agent": UA,
        },
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

function extractPoints(html: string): Point[] {
  const decoded = decodeHtmlEntities(html);
  const objectRe = /\{[^{}]{20,9000}\}/g;
  const rows = new Map<number, Point>();
  for (const match of decoded.matchAll(objectRe)) {
    const objectText = match[0];
    if (!/\bxera\b/i.test(objectText) || !/\best_woba\b/i.test(objectText)) continue;
    const playerId = numberProperty(objectText, ["player_id", "entity_id"]);
    const xwoba = numberProperty(objectText, ["est_woba"]);
    const xera = numberProperty(objectText, ["xera"]);
    if (playerId == null || xwoba == null || xera == null || !(xwoba > 0) || !(xera > 0)) continue;
    rows.set(playerId, {
      playerId,
      pa: numberProperty(objectText, ["pa"]),
      xwoba,
      xera,
    });
  }
  return [...rows.values()].sort((a, b) => a.playerId - b.playerId);
}

function pickRepresentatives(rows: readonly CdxRow[]): CdxRow[] {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const indexes = [
    0,
    Math.floor((sorted.length - 1) / 3),
    Math.floor((2 * (sorted.length - 1)) / 3),
    sorted.length - 1,
  ];
  return [...new Set(indexes)].map((index) => sorted[index]);
}

function xInterval(value: number, mode: QuantizationSpec["xMode"]): Interval {
  if (mode === "NEAREST_3DP") return { lo: Math.max(Number.EPSILON, value - 0.0005), hi: value + 0.0005 };
  if (mode === "TRUNCATE_DOWN_3DP") return { lo: Math.max(Number.EPSILON, value), hi: value + 0.001 };
  if (mode === "TRUNCATE_UP_3DP") return { lo: Math.max(Number.EPSILON, value - 0.001), hi: value };
  return { lo: Math.max(Number.EPSILON, value - 0.001), hi: value + 0.001 };
}

function yInterval(value: number, mode: QuantizationSpec["yMode"]): Interval {
  if (mode === "NEAREST_2DP") return { lo: Math.max(0, value - 0.005), hi: value + 0.005 };
  if (mode === "TRUNCATE_DOWN_2DP") return { lo: Math.max(0, value), hi: value + 0.01 };
  if (mode === "TRUNCATE_UP_2DP") return { lo: Math.max(0, value - 0.01), hi: value };
  return { lo: Math.max(0, value - 0.01), hi: value + 0.01 };
}

function coefficientIntersection(points: readonly Point[], spec: QuantizationSpec) {
  let lower = 0;
  let upper = Number.POSITIVE_INFINITY;
  let lowerWitness: unknown = null;
  let upperWitness: unknown = null;

  for (const point of points) {
    const xi = xInterval(point.xwoba, spec.xMode);
    const yi = yInterval(point.xera, spec.yMode);
    const candidateLower = yi.lo / (xi.hi * xi.hi);
    const candidateUpper = yi.hi / (xi.lo * xi.lo);
    if (candidateLower > lower) {
      lower = candidateLower;
      lowerWitness = { playerId: point.playerId, pa: point.pa, xwoba: point.xwoba, xera: point.xera, candidateLower };
    }
    if (candidateUpper < upper) {
      upper = candidateUpper;
      upperWitness = { playerId: point.playerId, pa: point.pa, xwoba: point.xwoba, xera: point.xera, candidateUpper };
    }
  }

  return {
    specId: spec.id,
    rows: points.length,
    coefficientRange: { lower, upper },
    feasible: lower <= upper + 1e-12,
    gapIfInfeasible: lower > upper ? lower - upper : 0,
    lowerWitness,
    upperWitness,
  };
}

function snapshotSquareEvidence(points: readonly Point[]) {
  const modes = QUANTIZATION_SPECS.map((spec) => coefficientIntersection(points, spec));
  return {
    rows: points.length,
    combinationsTested: modes.length,
    feasibleModes: modes.filter((mode) => mode.feasible).map((mode) => mode.specId),
    anyFeasibleMode: modes.some((mode) => mode.feasible),
    nearestMode: modes.find((mode) => mode.specId === "NEAREST_3DP__NEAREST_2DP"),
    wideMode: modes.find((mode) => mode.specId === "WIDE_3DP__WIDE_2DP"),
  };
}

function displayedMapping(points: readonly Point[]) {
  const map = new Map<string, Set<string>>();
  for (const point of points) {
    const xKey = point.xwoba.toFixed(3);
    const yKey = point.xera.toFixed(2);
    const values = map.get(xKey) ?? new Set<string>();
    values.add(yKey);
    map.set(xKey, values);
  }
  const collisionExamples: unknown[] = [];
  let collisionGroups = 0;
  for (const [xwoba, xeras] of map) {
    if (xeras.size <= 1) continue;
    collisionGroups++;
    if (collisionExamples.length < 15) collisionExamples.push({ xwoba, xeras: [...xeras].sort() });
  }
  return {
    uniqueDisplayedXwobaValues: map.size,
    collisionGroups,
    collisionExamples,
    map,
  };
}

function compareDisplayedMappings(
  left: { timestamp: string; points: Point[] },
  right: { timestamp: string; points: Point[] },
) {
  const leftMapping = displayedMapping(left.points);
  const rightMapping = displayedMapping(right.points);
  const common = [...leftMapping.map.keys()].filter((key) => rightMapping.map.has(key));
  let comparableUniqueMappings = 0;
  let changedUniqueMappings = 0;
  const changedExamples: unknown[] = [];

  for (const key of common) {
    const l = leftMapping.map.get(key)!;
    const r = rightMapping.map.get(key)!;
    if (l.size !== 1 || r.size !== 1) continue;
    comparableUniqueMappings++;
    const leftXera = [...l][0];
    const rightXera = [...r][0];
    if (leftXera !== rightXera) {
      changedUniqueMappings++;
      if (changedExamples.length < 20) {
        changedExamples.push({ xwoba: key, leftXera, rightXera });
      }
    }
  }

  return {
    leftTimestamp: left.timestamp,
    rightTimestamp: right.timestamp,
    commonDisplayedXwobaValues: common.length,
    comparableUniqueMappings,
    changedUniqueMappings,
    unchangedUniqueMappings: comparableUniqueMappings - changedUniqueMappings,
    timeVaryingDisplayedMappingObserved: changedUniqueMappings > 0,
    changedExamples,
  };
}

async function main() {
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
  const cdxRows = parseCdx(cdx.text);

  const seasonEvidence: unknown[] = [];
  let parsedCaptureCount = 0;
  let parsedRowCount = 0;
  let withinSnapshotCollisionGroupCount = 0;
  let mappingComparisonCount = 0;
  let mappingComparisonWithChangeCount = 0;
  let snapshotSquareTestCount = 0;
  let snapshotWithAnyFeasibleSquareModeCount = 0;

  for (const season of SEASONS) {
    const strictSameYear = cdxRows
      .filter((row) => {
        const parsed = parseOriginal(row.original);
        return parsed.season === season && parsed.strictQualifiedAllPitchers && row.timestamp.startsWith(String(season));
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const representatives = pickRepresentatives(strictSameYear);
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
      parsedRows: number;
      displayedMapping: Omit<ReturnType<typeof displayedMapping>, "map">;
      normalizedSquare: ReturnType<typeof snapshotSquareEvidence> | null;
      pointExamples: Point[];
      points: Point[];
    }> = [];

    for (const row of representatives) {
      const replay = await fetchText(replayUrl(row));
      const points = replay.ok ? extractPoints(replay.text) : [];
      const mapping = displayedMapping(points);
      const normalizedSquare = points.length >= 25 ? snapshotSquareEvidence(points) : null;

      if (points.length > 0) parsedCaptureCount++;
      parsedRowCount += points.length;
      withinSnapshotCollisionGroupCount += mapping.collisionGroups;
      if (normalizedSquare) {
        snapshotSquareTestCount++;
        if (normalizedSquare.anyFeasibleMode) snapshotWithAnyFeasibleSquareModeCount++;
      }

      const { map: _map, ...mappingPublic } = mapping;
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
        parsedRows: points.length,
        displayedMapping: mappingPublic,
        normalizedSquare,
        pointExamples: points.slice(0, 8),
        points,
      });
    }

    const mappingComparisons = [] as ReturnType<typeof compareDisplayedMappings>[];
    for (let index = 1; index < captures.length; index++) {
      if (!captures[index - 1].points.length || !captures[index].points.length) continue;
      const comparison = compareDisplayedMappings(captures[index - 1], captures[index]);
      mappingComparisons.push(comparison);
      mappingComparisonCount++;
      if (comparison.timeVaryingDisplayedMappingObserved) mappingComparisonWithChangeCount++;
    }

    seasonEvidence.push({
      season,
      strictSameCalendarYearCaptureCount: strictSameYear.length,
      representativeCaptureCount: captures.length,
      representativeCaptures: captures.map(({ points: _points, ...capture }) => capture),
      mappingComparisons,
      seasonFinding: {
        anyWithinSnapshotDisplayedMappingCollision: captures.some((capture) => capture.displayedMapping.collisionGroups > 0),
        anyBetweenSnapshotDisplayedMappingChange: mappingComparisons.some((comparison) => comparison.timeVaryingDisplayedMappingObserved),
        everyTestedSnapshotRejectsAllNormalizedSquareQuantizationModes:
          captures.filter((capture) => capture.normalizedSquare != null).length > 0 &&
          captures.filter((capture) => capture.normalizedSquare != null).every((capture) => !capture.normalizedSquare!.anyFeasibleMode),
      },
    });
  }

  const primaryPublisherTimeVaryingDisplayedMappingObserved = mappingComparisonWithChangeCount > 0;
  const everyTestedSnapshotRejectsAllNormalizedSquareQuantizationModes =
    snapshotSquareTestCount > 0 && snapshotWithAnyFeasibleSquareModeCount === 0;

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
      authorityUse: "EXACT_PRIMARY_PUBLISHER_TRUTH_ANCHOR_AT_CAPTURED_STATE_ONLY",
      completeDailyPregameCoverageClaimed: false,
      interpolationBetweenArchiveCapturesAllowed: false,
    },
    theoryUnderTest: {
      primaryQuestion: "Does the official Savant displayed xwOBA->xERA mapping vary across immutable captured states within a season?",
      secondaryQuestion: "At a single immutable captured state, can any of the 16 previously frozen public-display quantization envelopes support xERA=C_t*xwOBA^2 with one positive snapshot coefficient?",
      normalizedSquareForm: "xERA = C_t * xwOBA^2",
      regressionUsedForDecision: false,
      empiricalCoefficientFitUsedForDecision: false,
      coefficientRecoveredOrPublishedByThisProbe: false,
    },
    quantizationHypotheses: {
      xwobaModes: X_MODES,
      xeraModes: Y_MODES,
      combinationsPerSnapshot: QUANTIZATION_SPECS.length,
    },
    cdx: {
      url: cdxUrl.toString(),
      rawSha256: sha256(cdx.text),
      rows: cdxRows.length,
    },
    summary: {
      parsedCaptureCount,
      parsedRowCount,
      withinSnapshotCollisionGroupCount,
      mappingComparisonCount,
      mappingComparisonWithChangeCount,
      primaryPublisherWithinSnapshotDisplayedMappingCollisionObserved: withinSnapshotCollisionGroupCount > 0,
      primaryPublisherTimeVaryingDisplayedMappingObserved,
      snapshotSquareTestCount,
      snapshotWithAnyFeasibleSquareModeCount,
      everyTestedSnapshotRejectsAllNormalizedSquareQuantizationModes,
      exactTargetDateXeraCustodyForFullUniverseProven: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
    },
    seasonEvidence,
    scientificConclusion: {
      primaryPublisherTruthAnchorsUsed: parsedCaptureCount > 0,
      primaryPublisherTimeVaryingDisplayedMappingObserved,
      displayedXwobaAloneSufficientToIdentifyXeraAtEveryCapturedState: withinSnapshotCollisionGroupCount === 0,
      everyTestedSnapshotRejectsAllNormalizedSquareQuantizationModes,
      exactSavantProductionConversionProven: false,
      primaryAsOfXeraFullUniverseCustodyProven: false,
      familyPromotionAuthorized: false,
      nextGate:
        primaryPublisherTimeVaryingDisplayedMappingObserved && everyTestedSnapshotRejectsAllNormalizedSquareQuantizationModes
          ? "PRIMARY_ARCHIVE_PROVES_TEMPORAL_DISPLAYED_MAPPING_CHANGE_AND_SIMPLE_SNAPSHOT_NORMALIZED_SQUARE_REMAINS_INSUFFICIENT; ALIGN EXACT ARCHIVE STATES TO DATE-BOUNDED STATCAST PA/XWOBA STATES AND TEST THE PUBLISHER-SUPPORTED HIDDEN-PRECISION_OR_AGGREGATION_SEMANTICS WITHOUT INTERPOLATION_OR_EMPIRICAL_FITTING"
          : primaryPublisherTimeVaryingDisplayedMappingObserved
            ? "ALIGN ARCHIVE STATES TO DATE-BOUNDED STATCAST PA/XWOBA STATES; FOR ANY FEASIBLE SNAPSHOT MODE, REQUIRE AUTHORITATIVE DISPLAY/PARAMETER PROVENANCE BEFORE USE"
            : "DO_NOT_ASSUME_TEMPORAL_STABILITY; EXPAND PRIMARY ARCHIVE CAPTURE COMPARISONS OR LOCATE ANOTHER PRIMARY IMMUTABLE/ASOF XERA SOURCE BEFORE ANY HISTORICAL AUTHORITY",
    },
    interpretationPolicy: {
      archiveCaptureEqualsTruthOnlyAtCapturedState: true,
      archiveCaptureDoesNotEqualCompleteDailyCustody: true,
      noInterpolationBetweenArchiveSnapshots: true,
      finalSeasonMappingRetroactiveUseForbidden: true,
      thirdPartyMirrorValuesForbiddenAsHistoricalAuthority: true,
      empiricalPolynomialOrSquareLawFitForbidden: true,
      displayedValueCollisionDoesNotAuthorizeGuessingHiddenPrecision: true,
      feasibleQuantizationEnvelopeWouldNotAuthorizePromotion: true,
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
  const outPath = path.resolve(
    outArg
      ? outArg.slice("--out=".length)
      : "artifacts/mlb-r1b-statcast-xera-wayback-mapping-stability-probe/evidence.json",
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        status: evidence.status,
        summary: evidence.summary,
        seasons: (seasonEvidence as any[]).map((season) => ({
          season: season.season,
          representativeCaptureCount: season.representativeCaptureCount,
          seasonFinding: season.seasonFinding,
          mappingComparisons: season.mappingComparisons.map((comparison: any) => ({
            leftTimestamp: comparison.leftTimestamp,
            rightTimestamp: comparison.rightTimestamp,
            comparableUniqueMappings: comparison.comparableUniqueMappings,
            changedUniqueMappings: comparison.changedUniqueMappings,
          })),
        })),
        scientificConclusion: evidence.scientificConclusion,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
