import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-custom-leaderboard-xera-asof-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Custom-xERA/1.0)";
const SEASON = 2025;
const START = "2025-03-01";
const CUTOFF = "2025-05-31";

type Row = Record<string, string>;
type Variant = { name: string; extra: Record<string, string> };

const VARIANTS: readonly Variant[] = [
  { name: "BASELINE_FULL_SEASON", extra: {} },
  { name: "GAME_DATE_BOUNDARY", extra: { game_date_gt: START, game_date_lt: CUTOFF } },
  { name: "DATE_START_END_CAMEL_PREFIX", extra: { dateStart: START, dateEnd: CUTOFF } },
  { name: "START_END_DATE_CAMEL_SUFFIX", extra: { startDate: START, endDate: CUTOFF } },
  { name: "START_END_DATE_SNAKE", extra: { start_date: START, end_date: CUTOFF } },
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

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findHeader(headers: readonly string[], aliases: readonly string[]): string | null {
  const wanted = new Set(aliases.map(normalize));
  return headers.find((header) => wanted.has(normalize(header))) ?? null;
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

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function expectedUrl(): string {
  return queryUrl("https://baseballsavant.mlb.com/leaderboard/expected_statistics", {
    type: "pitcher", year: String(SEASON), min: "1", csv: "true",
  });
}

function customUrl(extra: Record<string, string>): string {
  return queryUrl("https://baseballsavant.mlb.com/leaderboard/custom", {
    year: String(SEASON),
    type: "pitcher",
    filter: "",
    min: "1",
    selections: "pa,xwoba,xera,p_era",
    chart: "false",
    x: "xwoba",
    y: "xera",
    r: "no",
    chartType: "beeswarm",
    sort: "xera",
    sortDir: "asc",
    csv: "true",
    ...extra,
  });
}

function byId(rows: readonly Row[], idHeader: string | null): Map<number, Row> {
  const out = new Map<number, Row>();
  if (!idHeader) return out;
  for (const row of rows) {
    const id = num(row[idHeader]);
    if (id != null && !out.has(id)) out.set(id, row);
  }
  return out;
}

function canonicalParity(canonical: { headers: string[]; rows: Row[] }, custom: { headers: string[]; rows: Row[] }) {
  const idHeader = findHeader(custom.headers, ["player_id", "playerid"]);
  const paHeader = findHeader(custom.headers, ["pa", "bf"]);
  const xwobaHeader = findHeader(custom.headers, ["xwoba", "est_woba"]);
  const xeraHeader = findHeader(custom.headers, ["xera", "expected_era"]);
  const eraHeader = findHeader(custom.headers, ["era", "p_era"]);
  const map = byId(custom.rows, idHeader);
  const stats = {
    matched: 0,
    pa: { n: 0, exact: 0 },
    xwoba: { n: 0, exact: 0 },
    xera: { n: 0, exact: 0 },
    era: { n: 0, exact: 0 },
  };
  const mismatches: unknown[] = [];
  for (const row of canonical.rows) {
    const id = num(row.player_id);
    if (id == null) continue;
    const found = map.get(id);
    if (!found) continue;
    stats.matched++;
    const checks: Array<["pa" | "xwoba" | "xera" | "era", number | null, number | null]> = [
      ["pa", num(row.pa), paHeader ? num(found[paHeader]) : null],
      ["xwoba", num(row.est_woba), xwobaHeader ? num(found[xwobaHeader]) : null],
      ["xera", num(row.xera), xeraHeader ? num(found[xeraHeader]) : null],
      ["era", num(row.era), eraHeader ? num(found[eraHeader]) : null],
    ];
    for (const [key, expected, actual] of checks) {
      if (expected == null || actual == null) continue;
      stats[key].n++;
      if (expected === actual) stats[key].exact++;
      else if (mismatches.length < 25) mismatches.push({ playerId: id, field: key, expected, actual });
    }
  }
  return {
    detectedHeaders: { idHeader, paHeader, xwobaHeader, xeraHeader, eraHeader },
    ...stats,
    xeraExactFullSeason: xeraHeader != null && stats.xera.n === canonical.rows.length && stats.xera.exact === stats.xera.n,
    eraExactFullSeason: eraHeader != null && stats.era.n === canonical.rows.length && stats.era.exact === stats.era.n,
    mismatchExamples: mismatches,
  };
}

function activity(
  baselineText: string,
  baseline: { headers: string[]; rows: Row[] },
  candidateText: string,
  candidate: { headers: string[]; rows: Row[] },
) {
  const idBase = findHeader(baseline.headers, ["player_id", "playerid"]);
  const idCandidate = findHeader(candidate.headers, ["player_id", "playerid"]);
  const baseMap = byId(baseline.rows, idBase);
  const candidateMap = byId(candidate.rows, idCandidate);
  const metricAliases: Array<readonly string[]> = [
    ["pa", "bf"], ["xwoba", "est_woba"], ["xera", "expected_era"], ["era", "p_era"],
  ];
  let common = 0;
  let changed = 0;
  const examples: unknown[] = [];
  for (const [id, row] of candidateMap) {
    const base = baseMap.get(id);
    if (!base) continue;
    common++;
    const changedFields: string[] = [];
    for (const aliases of metricAliases) {
      const baseHeader = findHeader(baseline.headers, aliases);
      const candidateHeader = findHeader(candidate.headers, aliases);
      if (!baseHeader || !candidateHeader) continue;
      if (String(base[baseHeader] ?? "") !== String(row[candidateHeader] ?? "")) changedFields.push(aliases[0]);
    }
    if (changedFields.length) {
      changed++;
      if (examples.length < 20) examples.push({ playerId: id, changedFields });
    }
  }
  return {
    payloadShaDifferent: sha256(baselineText) !== sha256(candidateText),
    baselineRows: baseline.rows.length,
    candidateRows: candidate.rows.length,
    commonPlayers: common,
    changedPlayers: changed,
    cutoffSemanticallyActive: candidate.rows.length !== baseline.rows.length || changed > 0,
    examples,
  };
}

async function main() {
  const canonicalText = await fetchText(expectedUrl());
  const canonical = parseCsv(canonicalText);
  for (const field of ["player_id", "pa", "est_woba", "xera", "era"]) {
    if (!canonical.headers.includes(field)) throw new Error(`CUSTOM_XERA_CANONICAL_SCHEMA_DRIFT:${field}`);
  }

  const fetched: Array<{ variant: Variant; url: string; text: string; parsed: ReturnType<typeof parseCsv> }> = [];
  for (const variant of VARIANTS) {
    const url = customUrl(variant.extra);
    const text = await fetchText(url);
    fetched.push({ variant, url, text, parsed: parseCsv(text) });
  }
  const baseline = fetched[0];
  const baselineParity = canonicalParity(canonical, baseline.parsed);
  const diagnostics = fetched.map((item, index) => ({
    name: item.variant.name,
    requestedBoundaryParams: item.variant.extra,
    source: { url: item.url, sha256: sha256(item.text), rows: item.parsed.rows.length, headers: item.parsed.headers },
    canonicalParity: index === 0 ? baselineParity : canonicalParity(canonical, item.parsed),
    versusBaseline: index === 0 ? null : activity(baseline.text, baseline.parsed, item.text, item.parsed),
  }));

  const activeVariants = diagnostics.slice(1).filter((item) => item.versusBaseline?.cutoffSemanticallyActive);
  const exactDirectXeraSurface = baselineParity.xeraExactFullSeason;
  const authoritativeAsOfCandidate = exactDirectXeraSurface && activeVariants.length > 0;

  const evidence = {
    schemaVersion: SCHEMA,
    status: "CUSTOM_LEADERBOARD_XERA_ASOF_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    family: "STATCAST_QUALITY",
    season: SEASON,
    targetWindow: { startExclusiveOrInclusiveUnknown: START, cutoff: CUTOFF },
    sourceDiscoveryContext: {
      customLeaderboardKnownToExposePitcherXera: true,
      customLeaderboardDocumentedAsSeasonScoped: true,
      purpose: "Test whether common date-boundary parameters are semantically honored rather than assumed from URL acceptance.",
    },
    canonical: { url: expectedUrl(), sha256: sha256(canonicalText), rows: canonical.rows.length, headers: canonical.headers },
    baselineParity,
    variants: diagnostics,
    finding: {
      customLeaderboardDirectlyEmitsXera: baselineParity.detectedHeaders.xeraHeader != null,
      customLeaderboardDirectlyEmitsEra: baselineParity.detectedHeaders.eraHeader != null,
      customLeaderboardXeraExactAgainstExpectedStatisticsFullSeason: baselineParity.xeraExactFullSeason,
      customLeaderboardEraExactAgainstExpectedStatisticsFullSeason: baselineParity.eraExactFullSeason,
      testedDateBoundaryVariantCount: VARIANTS.length - 1,
      semanticallyActiveDateBoundaryVariants: activeVariants.map((item) => item.name),
      authoritativeAsOfCandidate,
    },
    interpretationPolicy: {
      acceptedQueryParameterIsNotEvidenceOfSemanticActivity: true,
      payloadOrMetricChangeRequiredForDateBoundaryClaim: true,
      fullSeasonExactXeraParityRequiredBeforeAsOfUse: true,
      empiricalApproximationForbidden: true,
      seasonFinalXeraMayNotBeAppliedRetroactively: true,
      negativeResultDoesNotProveNoOtherAuthoritativeAsOfSourceExists: true,
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
      authoritativeExactXeraAsOfSemanticsProvenByThisProbe: false,
      nextGate: authoritativeAsOfCandidate
        ? "VALIDATE_ACTIVE_CUSTOM_LEADERBOARD_DATE_BOUNDARY_ACROSS_MULTIPLE_TARGET_DATES_AND_2022_2026_YTD_THEN_MIN_Q_ASOF"
        : exactDirectXeraSurface
          ? "CUSTOM_LEADERBOARD_CONFIRMS_EXACT_XERA_SURFACE_BUT_TESTED_DATE_BOUNDARIES_ARE_INACTIVE; CONTINUE_AUTHORITATIVE_ASOF_SNAPSHOT_OR_MAPPING_SOURCE SEARCH"
          : "CUSTOM_LEADERBOARD_NOT_AN_EXACT_CANONICAL_XERA_SURFACE; STOP_THIS_ROUTE_AND_CONTINUE_AUTHORITATIVE_ASOF_SOURCE SEARCH",
    },
  };

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-custom-leaderboard-xera-asof-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ baselineParity, finding: evidence.finding, variants: diagnostics.map((item) => ({ name: item.name, rows: item.source.rows, headers: item.source.headers, versusBaseline: item.versusBaseline })), decision: evidence.decision }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
