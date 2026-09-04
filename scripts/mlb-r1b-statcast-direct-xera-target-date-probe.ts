import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-direct-xera-target-date-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Direct-xERA/1.0)";
const SEASON = 2025;
const CUTOFF = "2025-05-31";

type Row = Record<string, string>;

type Variant = {
  name: string;
  requested: readonly string[];
};

const VARIANTS: readonly Variant[] = [
  { name: "KNOWN_BASELINE", requested: ["pa", "woba", "xwoba"] },
  { name: "XERA_ONLY", requested: ["pa", "woba", "xwoba", "xera"] },
  { name: "ERA_ONLY", requested: ["pa", "woba", "xwoba", "era"] },
  { name: "XERA_ERA_GAP", requested: ["pa", "woba", "xwoba", "xera", "era", "era_minus_xera_diff"] },
  { name: "EXPECTED_ERA_ALIASES", requested: ["pa", "woba", "xwoba", "expected_era", "expected_era_diff", "era"] },
] as const;

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += c;
    }
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

async function fetchText(url: string): Promise<string> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8",
          "User-Agent": UA,
        },
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

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function expectedUrl(season: number): string {
  return queryUrl("https://baseballsavant.mlb.com/leaderboard/expected_statistics", {
    type: "pitcher",
    year: String(season),
    min: "1",
    csv: "true",
  });
}

function aggregateUrl(season: number, cutoff: string | null, requested: readonly string[]): string {
  const params: Record<string, string> = {
    all: "true",
    hfGT: "R|",
    hfSea: `${season}|`,
    player_type: "pitcher",
    group_by: "name",
    min_pitches: "0",
    min_results: "0",
    min_pas: "0",
    sort_col: "xwoba",
    sort_order: "desc",
    game_date_gt: "",
    game_date_lt: cutoff ?? "",
  };
  for (const stat of requested) params[`chk_stats_${stat}`] = "on";
  return queryUrl("https://baseballsavant.mlb.com/statcast_search/csv", params);
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function findHeader(headers: readonly string[], candidates: readonly string[]): string | null {
  const wanted = new Set(candidates.map(normalizeHeader));
  return headers.find((header) => wanted.has(normalizeHeader(header))) ?? null;
}

function interestingHeaders(headers: readonly string[]): string[] {
  return headers.filter((header) => {
    const normalized = normalizeHeader(header);
    return normalized.includes("era") || normalized.includes("xera") || normalized.includes("expected");
  });
}

function byPlayerId(rows: readonly Row[]): Map<number, Row> {
  const out = new Map<number, Row>();
  for (const row of rows) {
    const id = num(row.player_id ?? row.pitcher ?? row.playerid);
    if (id != null && !out.has(id)) out.set(id, row);
  }
  return out;
}

function exactFieldComparison(
  canonicalRows: readonly Row[],
  candidateRows: readonly Row[],
  canonicalField: string,
  candidateField: string | null,
) {
  if (!candidateField) return { emitted: false, n: 0, exact: 0, mismatchCount: 0, mismatchExamples: [] as unknown[] };
  const candidate = byPlayerId(candidateRows);
  let n = 0;
  let exact = 0;
  const mismatchExamples: unknown[] = [];
  for (const row of canonicalRows) {
    const id = num(row.player_id);
    const expected = num(row[canonicalField]);
    const found = id == null ? undefined : candidate.get(id);
    const actual = found ? num(found[candidateField]) : null;
    if (id == null || expected == null || actual == null) continue;
    n++;
    if (expected === actual) exact++;
    else if (mismatchExamples.length < 25) {
      mismatchExamples.push({ playerId: id, expected, actual, absDiff: Math.abs(expected - actual) });
    }
  }
  return {
    emitted: true,
    n,
    exact,
    mismatchCount: n - exact,
    mismatchExamples,
  };
}

function cutoffActivity(fullRows: readonly Row[], cutoffRows: readonly Row[]) {
  const full = byPlayerId(fullRows);
  const cutoff = byPlayerId(cutoffRows);
  let common = 0;
  let changed = 0;
  const changedExamples: unknown[] = [];
  for (const [id, cutoffRow] of cutoff) {
    const fullRow = full.get(id);
    if (!fullRow) continue;
    common++;
    const fields = ["pa", "woba", "xwoba", "hardhit_percent", "barrels_per_bbe_percent"];
    const changedFields = fields.filter((field) => String(cutoffRow[field] ?? "") !== String(fullRow[field] ?? ""));
    if (changedFields.length) {
      changed++;
      if (changedExamples.length < 20) changedExamples.push({ playerId: id, changedFields });
    }
  }
  return {
    fullRows: fullRows.length,
    cutoffRows: cutoffRows.length,
    commonPlayersById: common,
    changedPlayers: changed,
    cutoffDemonstrablyActive: changed > 0 && cutoffRows.length !== 0,
    changedExamples,
  };
}

async function main() {
  const canonicalUrl = expectedUrl(SEASON);
  const canonicalText = await fetchText(canonicalUrl);
  const canonical = parseCsv(canonicalText);
  for (const required of ["player_id", "pa", "era", "xera", "era_minus_xera_diff", "woba", "est_woba"]) {
    if (!canonical.headers.includes(required)) throw new Error(`DIRECT_XERA_CANONICAL_SCHEMA_DRIFT:${required}`);
  }

  const variants = [] as unknown[];
  let anyDirectXeraEmitted = false;
  let anyDirectEraEmitted = false;
  let anyDirectGapEmitted = false;
  let anyExactFullSeasonXeraRoute = false;
  let anyExactFullSeasonEraRoute = false;
  let anyExactFullSeasonGapRoute = false;
  let anyCutoffActive = false;

  for (const variant of VARIANTS) {
    const fullUrl = aggregateUrl(SEASON, null, variant.requested);
    const cutoffUrl = aggregateUrl(SEASON, CUTOFF, variant.requested);
    const [fullText, cutoffText] = await Promise.all([fetchText(fullUrl), fetchText(cutoffUrl)]);
    const full = parseCsv(fullText);
    const cutoff = parseCsv(cutoffText);

    const xeraHeader = findHeader(full.headers, ["xera", "expected_era"]);
    const eraHeader = findHeader(full.headers, ["era"]);
    const gapHeader = findHeader(full.headers, ["era_minus_xera_diff", "era_xera_diff", "era_minus_expected_era"]);
    const xera = exactFieldComparison(canonical.rows, full.rows, "xera", xeraHeader);
    const era = exactFieldComparison(canonical.rows, full.rows, "era", eraHeader);
    const gap = exactFieldComparison(canonical.rows, full.rows, "era_minus_xera_diff", gapHeader);
    const cutoffCheck = cutoffActivity(full.rows, cutoff.rows);

    anyDirectXeraEmitted ||= xera.emitted;
    anyDirectEraEmitted ||= era.emitted;
    anyDirectGapEmitted ||= gap.emitted;
    anyExactFullSeasonXeraRoute ||= xera.emitted && xera.n === canonical.rows.length && xera.exact === xera.n;
    anyExactFullSeasonEraRoute ||= era.emitted && era.n === canonical.rows.length && era.exact === era.n;
    anyExactFullSeasonGapRoute ||= gap.emitted && gap.n === canonical.rows.length && gap.exact === gap.n;
    anyCutoffActive ||= cutoffCheck.cutoffDemonstrablyActive;

    variants.push({
      name: variant.name,
      requested: variant.requested,
      source: {
        full: { url: fullUrl, sha256: sha256(fullText), rows: full.rows.length, headers: full.headers },
        cutoff: { url: cutoffUrl, sha256: sha256(cutoffText), rows: cutoff.rows.length, headers: cutoff.headers },
      },
      interestingHeaders: {
        full: interestingHeaders(full.headers),
        cutoff: interestingHeaders(cutoff.headers),
      },
      detected: { xeraHeader, eraHeader, gapHeader },
      fullSeasonCanonicalParity: { xera, era, eraMinusXeraDiff: gap },
      cutoffActivity: cutoffCheck,
    });
  }

  const directXeraTargetDateRouteCandidate = anyDirectXeraEmitted && anyExactFullSeasonXeraRoute && anyCutoffActive;
  const evidence = {
    schemaVersion: SCHEMA,
    status: "DIRECT_XERA_TARGET_DATE_SOURCE_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    season: SEASON,
    cutoff: CUTOFF,
    canonical: {
      expectedStatisticsUrl: canonicalUrl,
      sha256: sha256(canonicalText),
      rows: canonical.rows.length,
      headers: canonical.headers,
    },
    variants,
    finding: {
      anyDirectXeraEmitted,
      anyDirectEraEmitted,
      anyDirectEraMinusXeraDiffEmitted: anyDirectGapEmitted,
      anyExactFullSeasonXeraRoute,
      anyExactFullSeasonEraRoute,
      anyExactFullSeasonEraMinusXeraDiffRoute: anyExactFullSeasonGapRoute,
      targetDateCutoffDemonstrablyActive: anyCutoffActive,
      directXeraTargetDateRouteCandidate,
    },
    interpretationPolicy: {
      unknownCheckboxesMayBeIgnoredBySavant: true,
      headerPresenceRequiredBeforeTreatingARequestedStatAsEmitted: true,
      fullSeasonExactParityRequiredBeforeTargetDateUse: true,
      cutoffMustBeDemonstrablyActive: true,
      directTargetDateFieldWouldStillRequireQualifierAsOfValidation: true,
      approximationForbidden: true,
      absenceOfDirectFieldDoesNotAuthorizeEmpiricalCurveFit: true,
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
    decision: {
      familyClassificationBefore: "PARTIAL_PARITY",
      familyClassificationAfter: "PARTIAL_PARITY",
      familyPromotionAuthorized: false,
      authoritativeExactXeraTargetDateSemanticsProvenByThisProbe: false,
      nextGate: directXeraTargetDateRouteCandidate
        ? "VALIDATE_DIRECT_TARGET_DATE_XERA_ERA_GAP_AND_MIN_Q_ASOF_SEMANTICS_ACROSS_2022_2026_YTD"
        : anyDirectXeraEmitted
          ? "STOP_AND_RESOLVE_DIRECT_XERA_FULL_SEASON_PARITY_BEFORE_ANY_TARGET_DATE_USE"
          : "DIRECT_XERA_NOT_EMITTED_BY_AGGREGATE_SEARCH; PROBE_AUTHORITATIVE_ASOF_XERA_SNAPSHOT_OR_MAPPING_SOURCE_WITHOUT_EMPIRICAL_APPROXIMATION",
    },
  };

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-direct-xera-target-date-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({
    status: evidence.status,
    finding: evidence.finding,
    variants: (variants as any[]).map((variant) => ({
      name: variant.name,
      interestingHeaders: variant.interestingHeaders,
      detected: variant.detected,
      fullSeasonCanonicalParity: variant.fullSeasonCanonicalParity,
      cutoffActivity: variant.cutoffActivity,
    })),
    decision: evidence.decision,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
