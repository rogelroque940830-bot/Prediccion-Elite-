import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-normalized-square-quantization-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Normalized-Square/1.0)";
const SEASONS = [2022, 2023, 2024, 2025, 2026] as const;
const PRODUCTION_EVALUATE_MIN_PA = 50;

type CsvRow = Record<string, string>;
type Point = { playerId: number; pa: number; xwoba: number; xera: number };
type Interval = { lo: number; hi: number };
type QuantizationSpec = {
  id: string;
  xMode: "NEAREST_3DP" | "TRUNCATE_DOWN_3DP" | "TRUNCATE_UP_3DP" | "WIDE_3DP";
  yMode: "NEAREST_2DP" | "TRUNCATE_DOWN_2DP" | "TRUNCATE_UP_2DP" | "WIDE_2DP";
};

const X_MODES: QuantizationSpec["xMode"][] = ["NEAREST_3DP", "TRUNCATE_DOWN_3DP", "TRUNCATE_UP_3DP", "WIDE_3DP"];
const Y_MODES: QuantizationSpec["yMode"][] = ["NEAREST_2DP", "TRUNCATE_DOWN_2DP", "TRUNCATE_UP_2DP", "WIDE_2DP"];
const QUANTIZATION_SPECS: QuantizationSpec[] = X_MODES.flatMap((xMode) =>
  Y_MODES.map((yMode) => ({ id: `${xMode}__${yMode}`, xMode, yMode })),
);

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { out.push(cell); cell = ""; }
    else cell += c;
  }
  out.push(cell);
  return out;
}

function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
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

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function expectedStatisticsUrl(season: number, min: "1" | "q"): string {
  const url = new URL("https://baseballsavant.mlb.com/leaderboard/expected_statistics");
  url.searchParams.set("type", "pitcher");
  url.searchParams.set("year", String(season));
  url.searchParams.set("min", min);
  url.searchParams.set("csv", "true");
  return url.toString();
}

async function fetchText(url: string): Promise<string> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8", "User-Agent": UA },
        signal: AbortSignal.timeout(90_000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}:${body.slice(0, 180)}`);
      if (/^\s*</.test(body)) throw new Error(`HTML_RESPONSE:${body.slice(0, 140)}`);
      return body;
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(`FETCH_FAILED:${url}:${String(last)}`);
}

function toPoints(rows: readonly CsvRow[]): Point[] {
  const out: Point[] = [];
  for (const row of rows) {
    const playerId = num(row.player_id);
    const pa = num(row.pa);
    const xwoba = num(row.est_woba);
    const xera = num(row.xera);
    if (playerId == null || pa == null || xwoba == null || xera == null) continue;
    if (!(xwoba > 0) || !(xera > 0)) continue;
    out.push({ playerId, pa, xwoba, xera });
  }
  return out;
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

/**
 * Exact coefficient-range intersection for the primary-source conceptual family
 *   xERA = C_t * xwOBA^2
 * where C_t is allowed to vary by season/snapshot. No coefficient is fitted.
 * Each published value is treated only as an interval under an explicit display
 * quantization hypothesis. A non-empty intersection is necessary, not sufficient,
 * evidence for an exact Savant implementation.
 */
function coefficientIntersection(points: readonly Point[], spec: QuantizationSpec) {
  let lower = 0;
  let upper = Number.POSITIVE_INFINITY;
  let lowerWitness: unknown = null;
  let upperWitness: unknown = null;
  let invalid = 0;

  for (const point of points) {
    const xi = xInterval(point.xwoba, spec.xMode);
    const yi = yInterval(point.xera, spec.yMode);
    const denominatorLo = xi.lo * xi.lo;
    const denominatorHi = xi.hi * xi.hi;
    if (!(denominatorLo > 0) || !(denominatorHi > 0)) { invalid++; continue; }
    const candidateLower = yi.lo / denominatorHi;
    const candidateUpper = yi.hi / denominatorLo;
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
    spec,
    rows: points.length,
    invalidRows: invalid,
    coefficientRange: { lower, upper },
    feasible: lower <= upper + 1e-12,
    gapIfInfeasible: lower > upper ? lower - upper : 0,
    lowerWitness,
    upperWitness,
  };
}

function domainEvidence(points: readonly Point[]) {
  const modes = QUANTIZATION_SPECS.map((spec) => coefficientIntersection(points, spec));
  return {
    rows: points.length,
    modes,
    feasibleModes: modes.filter((item) => item.feasible).map((item) => item.spec.id),
    anyFeasibleMode: modes.some((item) => item.feasible),
    canonicalNearestMode: modes.find((item) => item.spec.id === "NEAREST_3DP__NEAREST_2DP"),
    mostPermissiveWideMode: modes.find((item) => item.spec.id === "WIDE_3DP__WIDE_2DP"),
  };
}

async function main() {
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outputPath = outArg?.slice("--out=".length) || "artifacts/mlb-r1b-statcast-xera-normalized-square-quantization-probe/evidence.json";
  const seasons: unknown[] = [];

  for (const season of SEASONS) {
    const min1Url = expectedStatisticsUrl(season, "1");
    const minQUrl = expectedStatisticsUrl(season, "q");
    const [min1Text, minQText] = await Promise.all([fetchText(min1Url), fetchText(minQUrl)]);
    const min1Csv = parseCsv(min1Text);
    const minQCsv = parseCsv(minQText);
    for (const required of ["player_id", "pa", "est_woba", "xera"]) {
      if (!min1Csv.headers.includes(required) || !minQCsv.headers.includes(required)) {
        throw new Error(`XERA_NORMALIZED_SQUARE_SCHEMA_DRIFT:${season}:${required}`);
      }
    }
    const allMin1 = toPoints(min1Csv.rows);
    const productionPaDomain = allMin1.filter((point) => point.pa >= PRODUCTION_EVALUATE_MIN_PA);
    const qualified = toPoints(minQCsv.rows);
    if (productionPaDomain.length < 100 || qualified.length < 100) {
      throw new Error(`XERA_NORMALIZED_SQUARE_INSUFFICIENT_DATA:${season}`);
    }

    seasons.push({
      season,
      sources: {
        min1: { url: min1Url, sha256: sha256(min1Text), rows: min1Csv.rows.length },
        qualified: { url: minQUrl, sha256: sha256(minQText), rows: minQCsv.rows.length },
      },
      productionPaGte50: domainEvidence(productionPaDomain),
      productionSourceQualifiedMinQ: domainEvidence(qualified),
    });
  }

  const evidence = {
    schemaVersion: SCHEMA,
    status: "XERA_NORMALIZED_SQUARE_QUANTIZATION_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    sourceAuthority: {
      mlbGlossary: "https://www.mlb.com/glossary/statcast/expected-era",
      tangoStatcastLab: "https://tangotiger.com/index.php/site/comments/statcast-lab-xera",
      tangoNormalizedRunsDiscussion: "https://www.reddit.com/r/Sabermetrics/comments/4pi2o3/converting_woba_into_runs_per_9/",
      conceptualMechanism: "MLB defines xERA as xwOBA translated to ERA scale. Tango describes xERA as proportionate to xwOBA squared and separately describes a normalized squared wOBA-to-runs relationship. These sources do not publish Savant's exact time-varying production parameter series.",
      exactSavantProductionParameterSeriesPublishedByTheseSources: false,
    },
    theoryUnderTest: {
      family: "NORMALIZED_SQUARE",
      form: "xERA = C_t * xwOBA^2",
      coefficientMeaning: "C_t is an unconstrained positive season/snapshot normalization constant; allowing it to vary makes this test less restrictive than assuming one cross-season coefficient.",
      inferenceRule: "A non-empty coefficient intersection is necessary but not sufficient for exact production authority. An empty intersection rejects that public-display quantization hypothesis for the simple normalized-square family.",
      noRegressionFitUsedForDecision: true,
    },
    quantizationHypotheses: {
      xwoba: {
        NEAREST_3DP: "[display-0.0005, display+0.0005]",
        TRUNCATE_DOWN_3DP: "[display, display+0.001]",
        TRUNCATE_UP_3DP: "[display-0.001, display]",
        WIDE_3DP: "[display-0.001, display+0.001]",
      },
      xera: {
        NEAREST_2DP: "[display-0.005, display+0.005]",
        TRUNCATE_DOWN_2DP: "[display, display+0.01]",
        TRUNCATE_UP_2DP: "[display-0.01, display]",
        WIDE_2DP: "[display-0.01, display+0.01]",
      },
      combinationsTested: QUANTIZATION_SPECS.length,
    },
    productionSemanticContext: {
      expectedStatisticsProductionMin: "q",
      evaluatePitcherMinimumPa: PRODUCTION_EVALUATE_MIN_PA,
      bothDomainsTested: ["MIN1_FILTERED_PA_GTE_50", "PRODUCTION_SOURCE_MIN_Q"],
    },
    seasonEvidence: seasons,
    scientificConclusion: {
      anySeasonQualifiedHasFeasibleQuantizationMode: (seasons as any[]).some((season) => season.productionSourceQualifiedMinQ.anyFeasibleMode),
      everySeasonQualifiedHasAtLeastOneFeasibleQuantizationMode: (seasons as any[]).every((season) => season.productionSourceQualifiedMinQ.anyFeasibleMode),
      everySeasonQualifiedRejectsAllTestedQuantizationModes: (seasons as any[]).every((season) => !season.productionSourceQualifiedMinQ.anyFeasibleMode),
      everySeasonPaGte50RejectsAllTestedQuantizationModes: (seasons as any[]).every((season) => !season.productionPaGte50.anyFeasibleMode),
      primaryAsOfXeraCustodyProven: false,
      exactSavantProductionConversionProven: false,
      familyPromotionAuthorized: false,
      nextGate: "IF_ALL_QUANTIZATION_MODES_FAIL, PUBLIC_DISPLAY_ROUNDING/TRUNCATION_CANNOT_RESCUE_THE_SIMPLE_NORMALIZED_SQUARE_RECONSTRUCTION; OBTAIN PRIMARY_ASOF_XERA_OR_UNDOCUMENTED_INTERNAL_SAVANT_TRANSFORMATION/PARAMETERS. IF_ANY_MODE_PASSES, PROVE ACTUAL_SAVANT_DISPLAY_SEMANTICS_AND_TIME_VARYING_C_t_BEFORE FURTHER USE.",
    },
    interpretationPolicy: {
      conceptualPrimarySourceMechanismIsNotExactParameterAuthority: true,
      empiricalCoefficientFittingForbidden: true,
      finalSeasonMappingRetroactiveUseForbidden: true,
      thirdPartyMirrorValuesForbiddenAsHistoricalAuthority: true,
      feasibleDisplayEnvelopeWouldNotAuthorizePromotion: true,
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

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: evidence.status,
    qualifiedSummary: (seasons as any[]).map((season) => ({
      season: season.season,
      rows: season.productionSourceQualifiedMinQ.rows,
      feasibleModes: season.productionSourceQualifiedMinQ.feasibleModes,
      nearest: season.productionSourceQualifiedMinQ.canonicalNearestMode?.coefficientRange,
      wide: season.productionSourceQualifiedMinQ.mostPermissiveWideMode?.coefficientRange,
    })),
    scientificConclusion: evidence.scientificConclusion,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
