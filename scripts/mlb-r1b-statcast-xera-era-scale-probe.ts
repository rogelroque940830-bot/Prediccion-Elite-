import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-era-scale-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Probe/1.0)";
const SEASONS = [2022, 2023, 2024, 2025, 2026] as const;

type Row = Record<string, string>;
type Point = { playerId: number; xwobaRaw: string; xwoba: number; xera: number; era: number | null; pa: number | null };

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
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
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

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
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
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(`FETCH_FAILED:${url}:${String(last)}`);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const augmented = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
    }
    if (Math.abs(augmented[pivot][col]) < 1e-14) return null;
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    const divisor = augmented[col][col];
    for (let j = col; j <= n; j++) augmented[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = col; j <= n; j++) augmented[row][j] -= factor * augmented[col][j];
    }
  }
  return augmented.map((row) => row[n]);
}

function polynomialFit(points: readonly Point[], degree: number) {
  const size = degree + 1;
  const matrix = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const vector = Array<number>(size).fill(0);
  for (const point of points) {
    const powers = Array<number>(2 * degree + 1).fill(1);
    for (let p = 1; p < powers.length; p++) powers[p] = powers[p - 1] * point.xwoba;
    for (let row = 0; row < size; row++) {
      vector[row] += point.xera * powers[row];
      for (let col = 0; col < size; col++) matrix[row][col] += powers[row + col];
    }
  }
  const coefficients = solveLinearSystem(matrix, vector);
  if (!coefficients) return null;
  const residuals = points.map((point) => {
    const prediction = coefficients.reduce((sum, coefficient, power) => sum + coefficient * (point.xwoba ** power), 0);
    return {
      raw: point.xera - prediction,
      roundedExact: round2(prediction) === point.xera,
    };
  });
  const abs = residuals.map((item) => Math.abs(item.raw));
  return {
    degree,
    coefficients,
    exactAfterRound2: residuals.filter((item) => item.roundedExact).length,
    total: points.length,
    allExactAfterRound2: residuals.every((item) => item.roundedExact),
    meanAbsResidual: abs.length ? abs.reduce((sum, value) => sum + value, 0) / abs.length : null,
    maxAbsResidual: abs.length ? Math.max(...abs) : null,
  };
}

function mappingCollisions(points: readonly Point[]) {
  const byDisplayedXwoba = new Map<string, Set<string>>();
  for (const point of points) {
    const key = point.xwobaRaw.trim();
    const values = byDisplayedXwoba.get(key) ?? new Set<string>();
    values.add(point.xera.toFixed(2));
    byDisplayedXwoba.set(key, values);
  }
  const collisions = [...byDisplayedXwoba.entries()]
    .filter(([, xeras]) => xeras.size > 1)
    .map(([xwoba, xeras]) => ({ xwoba, xeras: [...xeras].sort() }))
    .sort((left, right) => Number(left.xwoba) - Number(right.xwoba));
  return {
    uniqueDisplayedXwobaValues: byDisplayedXwoba.size,
    sameDisplayedXwobaDifferentXeraGroups: collisions.length,
    examples: collisions.slice(0, 30),
  };
}

function monotonicity(points: readonly Point[]) {
  const sorted = [...points].sort((a, b) => a.xwoba - b.xwoba || a.xera - b.xera || a.playerId - b.playerId);
  let inversions = 0;
  let previousMax = -Infinity;
  for (const point of sorted) {
    if (point.xera + 1e-12 < previousMax) inversions++;
    previousMax = Math.max(previousMax, point.xera);
  }
  return { observations: sorted.length, inversions };
}

async function main() {
  const seasonEvidence = [] as Array<Record<string, unknown>>;
  const globalPoints: Array<Point & { season: number }> = [];

  for (const season of SEASONS) {
    const url = queryUrl("https://baseballsavant.mlb.com/leaderboard/expected_statistics", {
      type: "pitcher",
      year: String(season),
      min: "1",
      csv: "true",
    });
    const text = await fetchText(url);
    const parsed = parseCsv(text);
    const requiredHeaders = ["player_id", "pa", "est_woba", "era", "xera", "era_minus_xera_diff"];
    const missingHeaders = requiredHeaders.filter((header) => !parsed.headers.includes(header));
    if (missingHeaders.length) {
      throw new Error(`XERA_SOURCE_SCHEMA_DRIFT:${season}:${missingHeaders.join(",")}`);
    }

    const points: Point[] = [];
    for (const row of parsed.rows) {
      const playerId = num(row.player_id);
      const xwoba = num(row.est_woba);
      const xera = num(row.xera);
      if (playerId == null || xwoba == null || xera == null) continue;
      points.push({
        playerId,
        xwobaRaw: row.est_woba,
        xwoba,
        xera,
        era: num(row.era),
        pa: num(row.pa),
      });
      globalPoints.push({
        season,
        playerId,
        xwobaRaw: row.est_woba,
        xwoba,
        xera,
        era: num(row.era),
        pa: num(row.pa),
      });
    }
    if (!points.length) throw new Error(`XERA_SOURCE_EMPTY:${season}`);

    const fits = [1, 2, 3, 4].map((degree) => polynomialFit(points, degree)).filter(Boolean);
    seasonEvidence.push({
      season,
      source: { url, sha256: sha256(text), rows: parsed.rows.length, headers: parsed.headers },
      usableRows: points.length,
      displayedMapping: mappingCollisions(points),
      monotonicity: monotonicity(points),
      polynomialDiagnostics: fits,
      anyPolynomialDegree1To4ExactAfterRound2: fits.some((fit) => fit?.allExactAfterRound2 === true),
    });
  }

  const globalByDisplayedXwoba = new Map<string, Set<string>>();
  for (const point of globalPoints) {
    const key = point.xwobaRaw.trim();
    const values = globalByDisplayedXwoba.get(key) ?? new Set<string>();
    values.add(`${point.season}:${point.xera.toFixed(2)}`);
    globalByDisplayedXwoba.set(key, values);
  }
  const crossSeasonExamples = [...globalByDisplayedXwoba.entries()]
    .filter(([, values]) => new Set([...values].map((value) => value.split(":")[1])).size > 1)
    .slice(0, 30)
    .map(([xwoba, observations]) => ({ xwoba, observations: [...observations].sort() }));

  const evidence = {
    schemaVersion: SCHEMA,
    status: "XERA_ERA_SCALE_IDENTIFIABILITY_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    seasons: SEASONS,
    officialSemanticBoundary: {
      definition: "xERA is a 1:1 translation of xwOBA converted to the ERA scale.",
      exactPublicConversionConstantsOrAlgorithmPinnedInRepository: false,
      expectedStatisticsLeaderboardDirectlyEmitsXera: true,
      expectedStatisticsLeaderboardTargetDateCutoffPreviouslyProvenInactive: true,
      dateBoundedAggregateStatcastSearchDirectlyEmitsXera: false,
    },
    seasonEvidence,
    crossSeasonDisplayedXwoba: {
      uniqueDisplayedXwobaValues: globalByDisplayedXwoba.size,
      sameDisplayedXwobaCanMapToDifferentXeraAcrossSeasons: crossSeasonExamples.length > 0,
      examples: crossSeasonExamples,
    },
    interpretationPolicy: {
      regressionOrPolynomialFitIsDiagnosticOnly: true,
      empiricalFitMayNotBeUsedAsProductionOrHistoricalAuthority: true,
      roundedLeaderboardXwobaMayHidePrecisionUsedBySavant: true,
      exactTargetDateXeraRequiresAuthoritativeFormulaOrExactReplayableSource: true,
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
      statcastQualityParityCertifiedByThisProbe: false,
    },
    decision: {
      familyClassificationBefore: "PARTIAL_PARITY",
      familyClassificationAfter: "PARTIAL_PARITY",
      familyPromotionAuthorized: false,
      exactXeraEraScaleReconstructionProvenByThisProbe: false,
      nextGate: "USE_DIAGNOSTICS_TO_TEST_AUTHORITATIVE_OR_RAW-PRECISION_XERA_RECONSTRUCTION; DO_NOT ADOPT A FITTED APPROXIMATION",
    },
  };

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-xera-era-scale-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({
    status: evidence.status,
    seasons: seasonEvidence.map((item) => ({
      season: item.season,
      usableRows: item.usableRows,
      displayedMapping: item.displayedMapping,
      polynomialDiagnostics: item.polynomialDiagnostics,
    })),
    crossSeasonDisplayedXwoba: evidence.crossSeasonDisplayedXwoba,
    decision: evidence.decision,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
