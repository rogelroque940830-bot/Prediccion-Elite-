import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-production-domain-mechanism-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Mechanism/1.0)";
const SEASONS = [2022, 2023, 2024, 2025, 2026] as const;
const PRODUCTION_EVALUATE_MIN_PA = 50;

type Row = Record<string, string>;
type Point = { playerId: number; pa: number; x: number; xRaw: string; y: number };

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { out.push(current); current = ""; }
    else current += c;
  }
  out.push(current);
  return out;
}

function parseCsv(text: string): { headers: string[]; rows: Row[] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Row = {};
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

function queryUrl(year: number, min: string): string {
  const url = new URL("https://baseballsavant.mlb.com/leaderboard/expected_statistics");
  url.searchParams.set("type", "pitcher");
  url.searchParams.set("year", String(year));
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
      if (!response.ok) throw new Error(`HTTP_${response.status}:${body.slice(0, 160)}`);
      if (/^\s*</.test(body)) throw new Error(`HTML_RESPONSE:${body.slice(0, 120)}`);
      return body;
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error(`FETCH_FAILED:${url}:${String(last)}`);
}

function points(rows: readonly Row[]): Point[] {
  const out: Point[] = [];
  for (const row of rows) {
    const playerId = num(row.player_id);
    const pa = num(row.pa);
    const x = num(row.est_woba);
    const y = num(row.xera);
    if (playerId == null || pa == null || x == null || y == null) continue;
    out.push({ playerId, pa, x, xRaw: String(row.est_woba).trim(), y });
  }
  return out;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-14) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function evaluateFit(source: readonly Point[], predict: (x: number) => number, parameters: unknown) {
  const residuals = source.map((point) => {
    const predicted = predict(point.x);
    return { abs: Math.abs(point.y - predicted), exact: round2(predicted) === point.y };
  });
  return {
    parameters,
    total: source.length,
    exactAfterRound2: residuals.filter((item) => item.exact).length,
    allExactAfterRound2: residuals.every((item) => item.exact),
    meanAbsResidual: residuals.length ? residuals.reduce((sum, item) => sum + item.abs, 0) / residuals.length : null,
    maxAbsResidual: residuals.length ? Math.max(...residuals.map((item) => item.abs)) : null,
  };
}

function polynomialFit(source: readonly Point[], degree: number) {
  const size = degree + 1;
  const matrix = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const vector = Array<number>(size).fill(0);
  for (const point of source) {
    const powers = Array<number>(2 * degree + 1).fill(1);
    for (let p = 1; p < powers.length; p++) powers[p] = powers[p - 1] * point.x;
    for (let row = 0; row < size; row++) {
      vector[row] += point.y * powers[row];
      for (let col = 0; col < size; col++) matrix[row][col] += powers[row + col];
    }
  }
  const coefficients = solveLinearSystem(matrix, vector);
  if (!coefficients) return null;
  return { family: `POLYNOMIAL_DEGREE_${degree}`, ...evaluateFit(source, (x) => coefficients.reduce((sum, coefficient, power) => sum + coefficient * (x ** power), 0), { coefficients }) };
}

function affineTransformedFit(source: readonly Point[], family: string, transform: (x: number) => number) {
  const transformed = source.map((point) => ({ t: transform(point.x), y: point.y }));
  if (transformed.some((point) => !Number.isFinite(point.t))) return null;
  const n = transformed.length;
  const meanT = transformed.reduce((sum, point) => sum + point.t, 0) / n;
  const meanY = transformed.reduce((sum, point) => sum + point.y, 0) / n;
  const sxx = transformed.reduce((sum, point) => sum + ((point.t - meanT) ** 2), 0);
  if (sxx <= 1e-18) return null;
  const slope = transformed.reduce((sum, point) => sum + ((point.t - meanT) * (point.y - meanY)), 0) / sxx;
  const intercept = meanY - slope * meanT;
  return { family, ...evaluateFit(source, (x) => intercept + slope * transform(x), { intercept, slope }) };
}

function mappingDeterminism(source: readonly Point[]) {
  const byX = new Map<string, Set<string>>();
  for (const point of source) {
    const values = byX.get(point.xRaw) ?? new Set<string>();
    values.add(point.y.toFixed(2));
    byX.set(point.xRaw, values);
  }
  const collisions = [...byX.entries()].filter(([, values]) => values.size > 1);
  return {
    uniqueDisplayedXwobaValues: byX.size,
    collisionGroups: collisions.length,
    collisionExamples: collisions.slice(0, 20).map(([xwoba, values]) => ({ xwoba, xeras: [...values].sort() })),
  };
}

function compareQualifiedToMin1(min1: readonly Point[], qualified: readonly Point[]) {
  const byPlayer = new Map(min1.map((point) => [point.playerId, point]));
  let matched = 0;
  let exactXwoba = 0;
  let exactXera = 0;
  const mismatches: unknown[] = [];
  for (const point of qualified) {
    const prior = byPlayer.get(point.playerId);
    if (!prior) continue;
    matched++;
    if (prior.xRaw === point.xRaw) exactXwoba++;
    if (prior.y === point.y) exactXera++;
    if (prior.xRaw !== point.xRaw || prior.y !== point.y) {
      mismatches.push({ playerId: point.playerId, min1: { xwoba: prior.xRaw, xera: prior.y }, qualified: { xwoba: point.xRaw, xera: point.y } });
    }
  }
  return { qualifiedRows: qualified.length, matched, exactXwoba, exactXera, mismatchCount: mismatches.length, mismatchExamples: mismatches.slice(0, 20) };
}

function crossSeasonAffine(base: readonly Point[], target: readonly Point[]) {
  const baseByX = new Map<string, number>();
  for (const point of base) if (!baseByX.has(point.xRaw)) baseByX.set(point.xRaw, point.y);
  const pairs = target.flatMap((point) => {
    const baseY = baseByX.get(point.xRaw);
    return baseY == null ? [] : [{ x: baseY, y: point.y }];
  });
  if (pairs.length < 3) return null;
  const meanX = pairs.reduce((sum, point) => sum + point.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, point) => sum + point.y, 0) / pairs.length;
  const sxx = pairs.reduce((sum, point) => sum + ((point.x - meanX) ** 2), 0);
  const slope = pairs.reduce((sum, point) => sum + ((point.x - meanX) * (point.y - meanY)), 0) / sxx;
  const intercept = meanY - slope * meanX;
  const residuals = pairs.map((point) => ({ abs: Math.abs(point.y - (intercept + slope * point.x)), exact: round2(intercept + slope * point.x) === point.y }));
  return {
    commonDisplayedXwobaValues: pairs.length,
    intercept,
    slope,
    exactAfterRound2: residuals.filter((item) => item.exact).length,
    allExactAfterRound2: residuals.every((item) => item.exact),
    meanAbsResidual: residuals.reduce((sum, item) => sum + item.abs, 0) / residuals.length,
    maxAbsResidual: Math.max(...residuals.map((item) => item.abs)),
  };
}

async function main() {
  const seasons: Array<{
    season: number;
    min1: Point[];
    productionDomain: Point[];
    qualified: Point[];
    evidence: Record<string, unknown>;
  }> = [];

  for (const season of SEASONS) {
    const min1Url = queryUrl(season, "1");
    const qualifiedUrl = queryUrl(season, "q");
    const [min1Text, qualifiedText] = await Promise.all([fetchText(min1Url), fetchText(qualifiedUrl)]);
    const min1Csv = parseCsv(min1Text);
    const qualifiedCsv = parseCsv(qualifiedText);
    for (const required of ["player_id", "pa", "est_woba", "xera"]) {
      if (!min1Csv.headers.includes(required) || !qualifiedCsv.headers.includes(required)) {
        throw new Error(`XERA_MECHANISM_SCHEMA_DRIFT:${season}:${required}`);
      }
    }
    const all = points(min1Csv.rows);
    const productionDomain = all.filter((point) => point.pa >= PRODUCTION_EVALUATE_MIN_PA);
    const qualified = points(qualifiedCsv.rows);
    if (!productionDomain.length || !qualified.length) throw new Error(`XERA_MECHANISM_EMPTY:${season}`);

    const candidateFits = [
      ...[1, 2, 3, 4, 5, 6].map((degree) => polynomialFit(productionDomain, degree)).filter(Boolean),
      affineTransformedFit(productionDomain, "AFFINE_X_OVER_ONE_MINUS_X", (x) => x / (1 - x)),
      affineTransformedFit(productionDomain, "AFFINE_LOGIT_X", (x) => Math.log(x / (1 - x))),
      affineTransformedFit(productionDomain, "AFFINE_NEG_LOG_ONE_MINUS_X", (x) => -Math.log(1 - x)),
      affineTransformedFit(productionDomain, "AFFINE_RECIPROCAL_ONE_MINUS_X", (x) => 1 / (1 - x)),
    ].filter(Boolean);

    seasons.push({
      season,
      min1: all,
      productionDomain,
      qualified,
      evidence: {
        source: {
          min1: { url: min1Url, sha256: sha256(min1Text), rows: min1Csv.rows.length },
          qualified: { url: qualifiedUrl, sha256: sha256(qualifiedText), rows: qualifiedCsv.rows.length },
        },
        rowCounts: { min1Usable: all.length, productionDomainPaGte50: productionDomain.length, qualifiedUsable: qualified.length },
        productionDomainMapping: mappingDeterminism(productionDomain),
        qualifiedMapping: mappingDeterminism(qualified),
        qualifiedVsMin1: compareQualifiedToMin1(all, qualified),
        candidateFits,
        anyCandidateExactAfterRound2: candidateFits.some((fit) => fit?.allExactAfterRound2 === true),
      },
    });
  }

  const base = seasons.find((item) => item.season === 2022)!;
  const crossSeason = seasons.map((item) => ({
    baseSeason: 2022,
    targetSeason: item.season,
    affineOnCommonDisplayedXwoba: crossSeasonAffine(base.productionDomain, item.productionDomain),
  }));

  const evidence = {
    schemaVersion: SCHEMA,
    status: "XERA_PRODUCTION_DOMAIN_MECHANISM_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    productionSemanticContext: {
      productionExpectedStatisticsMin: "q",
      evaluatePitcherMinimumPa: PRODUCTION_EVALUATE_MIN_PA,
      reasonForDomainProbe: "The prior min=1 diagnostic included tiny-sample extreme xERA rows. This probe isolates the actual evaluatePitcher PA domain and separately checks the production min=q surface without granting historical qualifier authority.",
    },
    seasonEvidence: seasons.map((item) => ({ season: item.season, ...item.evidence })),
    crossSeason,
    interpretationPolicy: {
      candidateFormulaFitsAreDiagnosticOnly: true,
      exactEmpiricalFitWouldStillRequireAuthoritativeProvenance: true,
      minQCurrentSeasonSurfaceDoesNotProveHistoricalAsOfQualifierSemantics: true,
      finalOrCurrentSeasonMappingMayNotBeAppliedRetroactivelyToTargetDatesWithoutStabilityProof: true,
      approximationForbidden: true,
    },
    decision: {
      familyClassificationBefore: "PARTIAL_PARITY",
      familyClassificationAfter: "PARTIAL_PARITY",
      familyPromotionAuthorized: false,
      authoritativeExactXeraMechanismProvenByThisProbe: false,
      nextGate: "IF_A_SIMPLE_CANDIDATE_IS_EXACT_LOCATE_AUTHORITATIVE_SAVANT_PROVENANCE; OTHERWISE_TREAT_MAPPING_AS_LOOKUP_OR_HIGHER_COMPLEXITY_AND_PROBE_AUTHORITATIVE_ASOF_SOURCE",
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
      statcastQualityParityCertifiedByThisProbe: false,
    },
  };

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-xera-production-domain-mechanism-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({
    status: evidence.status,
    seasonEvidence: evidence.seasonEvidence.map((item) => ({
      season: item.season,
      rowCounts: item.rowCounts,
      productionDomainMapping: item.productionDomainMapping,
      qualifiedVsMin1: item.qualifiedVsMin1,
      exactCandidates: (item.candidateFits as Array<{ family: string; allExactAfterRound2: boolean; exactAfterRound2: number; total: number }>).filter((fit) => fit.allExactAfterRound2).map((fit) => fit.family),
      bestCandidates: [...(item.candidateFits as Array<{ family: string; allExactAfterRound2: boolean; exactAfterRound2: number; total: number; meanAbsResidual: number | null; maxAbsResidual: number | null }>)]
        .sort((left, right) => (left.meanAbsResidual ?? Infinity) - (right.meanAbsResidual ?? Infinity))
        .slice(0, 3),
    })),
    crossSeason,
    decision: evidence.decision,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
