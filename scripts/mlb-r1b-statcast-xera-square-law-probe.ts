import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-square-law-probe.v2" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Square-Law/2.0)";
const SEASONS = [2022, 2023, 2024, 2025, 2026] as const;
const PRODUCTION_MIN_PA = 50;
const DISPLAY_XWOBA_HALF_STEP = 0.0005;
const DISPLAY_XERA_HALF_STEP = 0.005;
const EPS = 1e-12;

type CsvRow = Record<string, string>;
type Point = {
  playerId: number;
  pa: number;
  xwoba: number;
  xwobaRaw: string;
  xera: number;
};

type IntervalPoint = {
  playerId: number;
  x: number;
  y: number;
  xLo: number;
  xHi: number;
  yLo: number;
  yHi: number;
  zLo: number;
  zHi: number;
};

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(cell);
      cell = "";
    } else {
      cell += c;
    }
  }
  out.push(cell);
  return out;
}

function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
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

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function expectedStatisticsUrl(season: number, min: "1" | "q"): string {
  const url = new URL("https://baseballsavant.mlb.com/leaderboard/expected_statistics");
  url.searchParams.set("type", "pitcher");
  url.searchParams.set("year", String(season));
  url.searchParams.set("position", "");
  url.searchParams.set("team", "");
  url.searchParams.set("min", min);
  url.searchParams.set("csv", "true");
  return url.toString();
}

async function fetchText(url: string): Promise<string> {
  let lastError: unknown = null;
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
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(`FETCH_FAILED:${url}:${String(lastError)}`);
}

function toPoints(rows: readonly CsvRow[]): Point[] {
  const points: Point[] = [];
  for (const row of rows) {
    const playerId = num(row.player_id);
    const pa = num(row.pa);
    const xwoba = num(row.est_woba);
    const xera = num(row.xera);
    if (playerId == null || pa == null || xwoba == null || xera == null) continue;
    points.push({ playerId, pa, xwoba, xwobaRaw: String(row.est_woba).trim(), xera });
  }
  return points;
}

function uniqueDisplayedMapping(points: readonly Point[]): Point[] {
  const byX = new Map<string, Point>();
  const valuesByX = new Map<string, Set<string>>();
  for (const point of points) {
    const values = valuesByX.get(point.xwobaRaw) ?? new Set<string>();
    values.add(point.xera.toFixed(2));
    valuesByX.set(point.xwobaRaw, values);
    if (!byX.has(point.xwobaRaw)) byX.set(point.xwobaRaw, point);
  }
  const collision = [...valuesByX.entries()].find(([, values]) => values.size > 1);
  if (collision) {
    throw new Error(`XERA_SQUARE_LAW_DISPLAY_MAPPING_COLLISION:${collision[0]}:${[...collision[1]].join("|")}`);
  }
  return [...byX.values()].sort((a, b) => a.xwoba - b.xwoba);
}

function intervals(points: readonly Point[]): IntervalPoint[] {
  return points.map((point) => {
    const xLo = Math.max(0, point.xwoba - DISPLAY_XWOBA_HALF_STEP);
    const xHi = point.xwoba + DISPLAY_XWOBA_HALF_STEP;
    return {
      playerId: point.playerId,
      x: point.xwoba,
      y: point.xera,
      xLo,
      xHi,
      yLo: point.xera - DISPLAY_XERA_HALF_STEP,
      yHi: point.xera + DISPLAY_XERA_HALF_STEP,
      zLo: xLo * xLo,
      zHi: xHi * xHi,
    };
  });
}

function evaluateModel(
  points: readonly Point[],
  family: string,
  parameters: Record<string, number>,
  predict: (x: number) => number,
) {
  const residuals = points.map((point) => {
    const predicted = predict(point.xwoba);
    return {
      playerId: point.playerId,
      xwoba: point.xwoba,
      xera: point.xera,
      predicted,
      absResidual: Math.abs(point.xera - predicted),
      exactAfterRound2: round2(predicted) === point.xera,
    };
  });
  return {
    family,
    parameters,
    total: points.length,
    exactAfterRound2: residuals.filter((item) => item.exactAfterRound2).length,
    allExactAfterRound2: residuals.every((item) => item.exactAfterRound2),
    meanAbsResidual: residuals.reduce((sum, item) => sum + item.absResidual, 0) / residuals.length,
    maxAbsResidual: Math.max(...residuals.map((item) => item.absResidual)),
    mismatchExamples: residuals
      .filter((item) => !item.exactAfterRound2)
      .sort((a, b) => b.absResidual - a.absResidual)
      .slice(0, 20),
  };
}

function proportionalSquareFit(points: readonly Point[]) {
  const z = points.map((point) => point.xwoba ** 2);
  const denominator = z.reduce((sum, value) => sum + value * value, 0);
  const k = z.reduce((sum, value, index) => sum + value * points[index].xera, 0) / denominator;
  return evaluateModel(points, "PROPORTIONAL_XWOBA_SQUARED", { k }, (x) => k * x * x);
}

function affineSquareFit(points: readonly Point[]) {
  const z = points.map((point) => point.xwoba ** 2);
  const meanZ = z.reduce((sum, value) => sum + value, 0) / z.length;
  const meanY = points.reduce((sum, point) => sum + point.xera, 0) / points.length;
  const denominator = z.reduce((sum, value) => sum + (value - meanZ) ** 2, 0);
  const b = z.reduce((sum, value, index) => sum + (value - meanZ) * (points[index].xera - meanY), 0) / denominator;
  const a = meanY - b * meanZ;
  return evaluateModel(points, "AFFINE_XWOBA_SQUARED", { a, b }, (x) => a + b * x * x);
}

function linearXwobaFit(points: readonly Point[]) {
  const meanX = points.reduce((sum, point) => sum + point.xwoba, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.xera, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.xwoba - meanX) ** 2, 0);
  const b = points.reduce((sum, point) => sum + (point.xwoba - meanX) * (point.xera - meanY), 0) / denominator;
  const a = meanY - b * meanX;
  return evaluateModel(points, "AFFINE_XWOBA_UNSQUARED_CONTROL", { a, b }, (x) => a + b * x);
}

/**
 * Exact interval-feasibility test for y = k*x^2 when both published xwOBA and xERA
 * may be rounded display values. This does not fit a coefficient; it intersects every
 * coefficient interval that could produce the displayed pair from latent precision.
 */
function proportionalLatentPrecisionFeasibility(points: readonly Point[]) {
  const iv = intervals(points);
  let lower = 0;
  let upper = Number.POSITIVE_INFINITY;
  let lowerWitness: unknown = null;
  let upperWitness: unknown = null;
  for (const point of iv) {
    const candidateLower = point.yLo / point.zHi;
    const candidateUpper = point.yHi / point.zLo;
    if (candidateLower > lower) {
      lower = candidateLower;
      lowerWitness = { playerId: point.playerId, xwoba: point.x, xera: point.y, candidateLower };
    }
    if (candidateUpper < upper) {
      upper = candidateUpper;
      upperWitness = { playerId: point.playerId, xwoba: point.x, xera: point.y, candidateUpper };
    }
  }
  const feasible = lower <= upper + EPS;
  return {
    family: "PROPORTIONAL_XWOBA_SQUARED_LATENT_PRECISION_FEASIBILITY",
    feasible,
    kRange: { lower, upper },
    lowerWitness,
    upperWitness,
    assumptions: {
      xwobaDisplayRoundingHalfStep: DISPLAY_XWOBA_HALF_STEP,
      xeraDisplayRoundingHalfStep: DISPLAY_XERA_HALF_STEP,
      positiveCoefficientOnly: true,
    },
    authority: "FEASIBILITY_ONLY_NOT_PARAMETER_PROVENANCE",
  };
}

/**
 * Exact pairwise inequality reduction for existence of y = a + b*x^2, b>=0,
 * with one latent x and y inside each published display interval.
 *
 * For fixed b, each point admits an intercept interval:
 *   a >= yLo - b*zHi
 *   a <= yHi - b*zLo
 * A global solution exists iff every lower bound is <= every upper bound. Each pair
 * is linear in b, so intersecting the resulting b inequalities is exact up to normal
 * floating-point arithmetic; no regression fit is used to decide feasibility.
 */
function affineLatentPrecisionFeasibility(points: readonly Point[]) {
  const iv = intervals(points);
  let bLower = 0;
  let bUpper = Number.POSITIVE_INFINITY;
  let lowerWitness: unknown = null;
  let upperWitness: unknown = null;
  let impossibleConstantPair: unknown = null;

  for (const left of iv) {
    for (const right of iv) {
      const c = right.zLo - left.zHi;
      const d = right.yHi - left.yLo;
      if (Math.abs(c) <= EPS) {
        if (d < -EPS) {
          impossibleConstantPair = {
            left: { playerId: left.playerId, xwoba: left.x, xera: left.y },
            right: { playerId: right.playerId, xwoba: right.x, xera: right.y },
            c,
            d,
          };
          break;
        }
        continue;
      }
      const bound = d / c;
      if (c > 0) {
        if (bound < bUpper) {
          bUpper = bound;
          upperWitness = {
            left: { playerId: left.playerId, xwoba: left.x, xera: left.y },
            right: { playerId: right.playerId, xwoba: right.x, xera: right.y },
            bound,
          };
        }
      } else if (bound > bLower) {
        bLower = bound;
        lowerWitness = {
          left: { playerId: left.playerId, xwoba: left.x, xera: left.y },
          right: { playerId: right.playerId, xwoba: right.x, xera: right.y },
          bound,
        };
      }
    }
    if (impossibleConstantPair) break;
  }

  bLower = Math.max(0, bLower);
  const feasibleB = impossibleConstantPair == null && bLower <= bUpper + EPS && bUpper >= -EPS;
  let witness: null | { a: number; b: number; aRange: { lower: number; upper: number } } = null;
  if (feasibleB) {
    const b = Number.isFinite(bUpper) ? Math.max(0, (bLower + bUpper) / 2) : bLower;
    const aLower = Math.max(...iv.map((point) => point.yLo - b * point.zHi));
    const aUpper = Math.min(...iv.map((point) => point.yHi - b * point.zLo));
    if (aLower <= aUpper + 1e-10) {
      witness = { a: (aLower + aUpper) / 2, b, aRange: { lower: aLower, upper: aUpper } };
    }
  }

  return {
    family: "AFFINE_XWOBA_SQUARED_LATENT_PRECISION_FEASIBILITY",
    feasible: feasibleB && witness != null,
    bRange: { lower: bLower, upper: bUpper },
    witness,
    lowerWitness,
    upperWitness,
    impossibleConstantPair,
    assumptions: {
      xwobaDisplayRoundingHalfStep: DISPLAY_XWOBA_HALF_STEP,
      xeraDisplayRoundingHalfStep: DISPLAY_XERA_HALF_STEP,
      nonNegativeSlope: true,
    },
    authority: "EXACT_INTERVAL_FEASIBILITY_ONLY_NOT_SAVANT_PARAMETER_PROVENANCE_OR_TARGET_DATE_CUSTODY",
  };
}

function displayedRoundingCompatibility(
  points: readonly Point[],
  parameters: { a: number; b: number },
) {
  const incompatible: unknown[] = [];
  for (const point of intervals(points)) {
    const predictedMin = parameters.a + parameters.b * point.zLo;
    const predictedMax = parameters.a + parameters.b * point.zHi;
    const overlaps = predictedMax >= point.yLo && predictedMin <= point.yHi;
    if (!overlaps) {
      incompatible.push({
        playerId: point.playerId,
        xwoba: point.x,
        xera: point.y,
        predictedMin,
        predictedMax,
        displayMin: point.yLo,
        displayMax: point.yHi,
      });
    }
  }
  return {
    assumption: "CENTER_VALUE_LEAST_SQUARES_COEFFICIENTS_WITH_DISPLAY_ROUNDING_INTERVALS",
    total: points.length,
    compatible: points.length - incompatible.length,
    incompatible: incompatible.length,
    allCompatible: incompatible.length === 0,
    incompatibleExamples: incompatible.slice(0, 20),
    authority: "DIAGNOSTIC_ONLY_FITTED_COEFFICIENTS_DO_NOT_PROVE_SAVANT_FORMULA_OR_TARGET_DATE_CUSTODY",
  };
}

function compareQualified(min1: readonly Point[], qualified: readonly Point[]) {
  const byId = new Map(min1.map((point) => [point.playerId, point]));
  let matched = 0;
  let exactXwoba = 0;
  let exactXera = 0;
  const mismatches: unknown[] = [];
  for (const point of qualified) {
    const base = byId.get(point.playerId);
    if (!base) continue;
    matched++;
    if (base.xwobaRaw === point.xwobaRaw) exactXwoba++;
    if (base.xera === point.xera) exactXera++;
    if (base.xwobaRaw !== point.xwobaRaw || base.xera !== point.xera) {
      mismatches.push({
        playerId: point.playerId,
        min1: { xwoba: base.xwobaRaw, xera: base.xera },
        qualified: { xwoba: point.xwobaRaw, xera: point.xera },
      });
    }
  }
  return {
    qualifiedRows: qualified.length,
    matched,
    exactXwoba,
    exactXera,
    mismatchCount: mismatches.length,
    mismatchExamples: mismatches.slice(0, 20),
  };
}

function weightedMean(points: readonly Point[], select: (point: Point) => number): number {
  const totalWeight = points.reduce((sum, point) => sum + point.pa, 0);
  return points.reduce((sum, point) => sum + point.pa * select(point), 0) / totalWeight;
}

function ratioDiagnostics(points: readonly Point[]) {
  const ratios = points.map((point) => point.xera / (point.xwoba ** 2));
  const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
  const variance = ratios.reduce((sum, value) => sum + (value - mean) ** 2, 0) / ratios.length;
  return {
    n: ratios.length,
    min: Math.min(...ratios),
    max: Math.max(...ratios),
    mean,
    standardDeviation: Math.sqrt(variance),
    constantRatioExact: new Set(ratios.map((value) => value.toFixed(12))).size === 1,
  };
}

async function main() {
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outputPath = outArg?.slice("--out=".length) || "artifacts/mlb-r1b-statcast-xera-square-law-probe/evidence.json";
  const seasonEvidence: Array<any> = [];

  for (const season of SEASONS) {
    const min1Url = expectedStatisticsUrl(season, "1");
    const qualifiedUrl = expectedStatisticsUrl(season, "q");
    const [min1Text, qualifiedText] = await Promise.all([fetchText(min1Url), fetchText(qualifiedUrl)]);
    const min1Csv = parseCsv(min1Text);
    const qualifiedCsv = parseCsv(qualifiedText);
    for (const header of ["player_id", "pa", "est_woba", "xera"]) {
      if (!min1Csv.headers.includes(header) || !qualifiedCsv.headers.includes(header)) {
        throw new Error(`XERA_SQUARE_LAW_SCHEMA_DRIFT:${season}:${header}`);
      }
    }

    const min1 = toPoints(min1Csv.rows);
    const qualified = toPoints(qualifiedCsv.rows);
    const productionDomain = min1.filter((point) => point.pa >= PRODUCTION_MIN_PA);
    if (productionDomain.length < 100 || qualified.length < 100) {
      throw new Error(`XERA_SQUARE_LAW_INSUFFICIENT_DATA:${season}`);
    }
    const unique = uniqueDisplayedMapping(productionDomain);
    const proportional = proportionalSquareFit(unique);
    const affineSquare = affineSquareFit(unique);
    const linearControl = linearXwobaFit(unique);
    const fittedParams = affineSquare.parameters as { a: number; b: number };
    const proportionalLatent = proportionalLatentPrecisionFeasibility(unique);
    const affineLatent = affineLatentPrecisionFeasibility(unique);

    seasonEvidence.push({
      season,
      sources: {
        min1: { url: min1Url, sha256: sha256(min1Text), rows: min1Csv.rows.length },
        qualified: { url: qualifiedUrl, sha256: sha256(qualifiedText), rows: qualifiedCsv.rows.length },
      },
      rowCounts: {
        min1Usable: min1.length,
        productionDomainPaGte50: productionDomain.length,
        qualifiedUsable: qualified.length,
        uniqueDisplayedXwobaValuesInProductionDomain: unique.length,
      },
      qualifiedVsMin1: compareQualified(min1, qualified),
      leagueDiagnosticsFromPitcherPaWeighting: {
        paWeightedXwoba: weightedMean(min1, (point) => point.xwoba),
        paWeightedXera: weightedMean(min1, (point) => point.xera),
        authority: "DIAGNOSTIC_ONLY_NOT_A_SUBSTITUTE_FOR_AN_AUTHORITATIVE_LEAGUE_RUN_ENVIRONMENT_SERIES",
      },
      squareLawDiagnostics: {
        proportional,
        affineSquare,
        unsquaredLinearControl: linearControl,
        xeraOverXwobaSquaredRatio: ratioDiagnostics(unique),
        displayedRoundingIntervalCompatibility: displayedRoundingCompatibility(unique, fittedParams),
        latentPrecisionFeasibility: {
          proportional: proportionalLatent,
          affine: affineLatent,
        },
      },
    });
  }

  const evidence = {
    schemaVersion: SCHEMA,
    status: "XERA_SQUARE_LAW_MECHANISM_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    family: "STATCAST_QUALITY",
    generatedAt: new Date().toISOString(),
    sourceAuthorityContext: {
      mlbGlossary: {
        url: "https://www.mlb.com/glossary/statcast/expected-era",
        statement: "xERA is a simple 1:1 translation of xwOBA, converted to the ERA scale.",
        linksToTangotigerAsMoreAboutXera: true,
      },
      tangotigerStatcastLab: {
        url: "https://tangotiger.com/index.php/site/comments/statcast-lab-xera",
        published: "2020-03-13",
        mechanismStatements: [
          "If you square xwOBA, the curved xwOBA-to-xERA relationship becomes a straight line.",
          "Create an xERA that is proportionate to xwOBA squared.",
          "The page notes the data are shown after every game.",
        ],
      },
      evidencePolicy: "Official MLB defines the translation and links the Tangotiger Statcast Lab explanation. The statements motivate a square-law feasibility test but do not by themselves publish the exact time-varying coefficient/intercept series used by production Savant.",
    },
    productionSemanticContext: {
      evaluatePitcherMinimumPa: PRODUCTION_MIN_PA,
      productionExpectedStatisticsMin: "q",
      productionNeedsExactXera: true,
      productionNeedsExactEraMinusXeraDiff: true,
    },
    seasonEvidence,
    crossSeasonCoefficientDiagnostics: seasonEvidence.map((season) => ({
      season: season.season,
      affineSquareA: season.squareLawDiagnostics.affineSquare.parameters.a,
      affineSquareB: season.squareLawDiagnostics.affineSquare.parameters.b,
      affineSquareExactAfterRound2: season.squareLawDiagnostics.affineSquare.exactAfterRound2,
      affineSquareTotal: season.squareLawDiagnostics.affineSquare.total,
      roundingIntervalAllCompatible: season.squareLawDiagnostics.displayedRoundingIntervalCompatibility.allCompatible,
      proportionalLatentPrecisionFeasible: season.squareLawDiagnostics.latentPrecisionFeasibility.proportional.feasible,
      affineLatentPrecisionFeasible: season.squareLawDiagnostics.latentPrecisionFeasibility.affine.feasible,
      affineLatentBRange: season.squareLawDiagnostics.latentPrecisionFeasibility.affine.bRange,
      affineLatentWitness: season.squareLawDiagnostics.latentPrecisionFeasibility.affine.witness,
    })),
    scientificConclusion: {
      exactProportionalSquareLawOnDisplayedValuesEverySeason: seasonEvidence.every((season) => season.squareLawDiagnostics.proportional.allExactAfterRound2 === true),
      exactAffineSquareLawOnDisplayedValuesEverySeason: seasonEvidence.every((season) => season.squareLawDiagnostics.affineSquare.allExactAfterRound2 === true),
      fittedAffineSquareRoundingIntervalsCompatibleEverySeason: seasonEvidence.every((season) => season.squareLawDiagnostics.displayedRoundingIntervalCompatibility.allCompatible === true),
      proportionalSquareLawLatentPrecisionFeasibleEverySeason: seasonEvidence.every((season) => season.squareLawDiagnostics.latentPrecisionFeasibility.proportional.feasible === true),
      affineSquareLawLatentPrecisionFeasibleEverySeason: seasonEvidence.every((season) => season.squareLawDiagnostics.latentPrecisionFeasibility.affine.feasible === true),
      currentQualifiedSurfaceValueParityWithMin1EverySeason: seasonEvidence.every((season) => season.qualifiedVsMin1.mismatchCount === 0),
      authoritativeExactFormulaProven: false,
      authoritativeTargetDateRunEnvironmentProven: false,
      targetDateXeraCustodyProven: false,
      familyPromotionAuthorized: false,
      nextGate: "USE_EXACT_LATENT_PRECISION_FEASIBILITY_TO_CLASSIFY_THE_DOCUMENTED_SQUARE_LAW; IF_FEASIBLE, IDENTIFY_AUTHORITATIVE_TIME_VARYING_PARAMETERS_OR_IMMUTABLE_PRIMARY_ASOF_XERA; IF_INFEASIBLE, RECORD_THAT_THE_PUBLIC_DESCRIPTION_IS_INSUFFICIENT_FOR_EXACT_RECONSTRUCTION",
    },
    interpretationPolicy: {
      fittedCoefficientsAreDiagnosticOnly: true,
      displayedRoundingCompatibilityIsNotFormulaAuthority: true,
      latentPrecisionFeasibilityIsNotParameterProvenance: true,
      exactEmpiricalFitWouldStillRequireAuthoritativeProvenance: true,
      finalSeasonCoefficientsMayNotBeAppliedRetroactively: true,
      paWeightedLeagueDiagnosticsAreNotAuthoritativeRunEnvironment: true,
      approximationForbidden: true,
      noFamilyPromotionFromThisProbeAlone: true,
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
    crossSeasonCoefficientDiagnostics: evidence.crossSeasonCoefficientDiagnostics,
    scientificConclusion: evidence.scientificConclusion,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
