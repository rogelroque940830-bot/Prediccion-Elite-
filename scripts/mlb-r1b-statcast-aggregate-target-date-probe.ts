import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA = "courtedge-mlb-r1b-statcast-aggregate-target-date-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Statcast-Aggregate/1.0)";

type Row = Record<string, string>;

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
    headers.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function num(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function first(row: Row, candidates: readonly string[]): string | undefined {
  for (const key of candidates) if (row[key] != null && row[key] !== "") return row[key];
  return undefined;
}

function normName(value: string | undefined): string {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

async function fetchText(url: string): Promise<string> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8", "User-Agent": UA },
        signal: AbortSignal.timeout(90_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP_${res.status}:${body.slice(0, 160)}`);
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

function aggregateUrl(season: number, cutoff: string | null): string {
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
    chk_stats_pa: "on",
    chk_stats_woba: "on",
    chk_stats_xwoba: "on",
    chk_stats_hardhit_percent: "on",
    chk_stats_barrels_total: "on",
    chk_stats_barrels_per_bbe_percent: "on",
    chk_stats_barrels_per_pa_percent: "on",
  };
  // Deliberately omit type=details. The preceding probe proved that variant silently
  // returned pitch-level rows, making semantic comparison impossible.
  return queryUrl("https://baseballsavant.mlb.com/statcast_search/csv", params);
}

const ID_FIELDS = ["player_id", "pitcher", "playerid"] as const;
const NAME_FIELDS = ["player_name", "name", "last_name, first_name"] as const;
const AGGREGATE_FIELDS = ["pa", "woba", "xwoba", "hardhit_percent", "barrels_per_bbe_percent"] as const;
const DETAIL_MARKERS = ["pitch_type", "game_date", "release_speed", "game_pk", "at_bat_number"] as const;

function aggregateContract(parsed: { headers: string[]; rows: Row[] }) {
  const headerSet = new Set(parsed.headers);
  const aggregateFieldsPresent = AGGREGATE_FIELDS.filter((field) => headerSet.has(field));
  const detailMarkersPresent = DETAIL_MARKERS.filter((field) => headerSet.has(field));
  return {
    detected: aggregateFieldsPresent.length >= 4 && detailMarkersPresent.length === 0,
    aggregateFieldsPresent,
    detailMarkersPresent,
    rowCount: parsed.rows.length,
  };
}

function rowMaps(rows: Row[]) {
  const byId = new Map<number, Row>();
  const byName = new Map<string, Row>();
  for (const row of rows) {
    const id = num(first(row, ID_FIELDS));
    if (id != null && !byId.has(id)) byId.set(id, row);
    const name = normName(first(row, NAME_FIELDS));
    if (name && !byName.has(name)) byName.set(name, row);
  }
  return { byId, byName };
}

function matchRow(source: Row, maps: ReturnType<typeof rowMaps>): { row: Row; route: "ID" | "NAME" } | null {
  const id = num(first(source, ["player_id"]));
  if (id != null && maps.byId.has(id)) return { row: maps.byId.get(id)!, route: "ID" };
  const name = normName(first(source, ["last_name, first_name"]));
  if (name && maps.byName.has(name)) return { row: maps.byName.get(name)!, route: "NAME" };
  return null;
}

function diffStats(values: number[]) {
  if (!values.length) return { n: 0, exact: 0, within0005: 0, within005: 0, meanAbs: null, maxAbs: null };
  return {
    n: values.length,
    exact: values.filter((v) => v === 0).length,
    within0005: values.filter((v) => v <= 0.0005 + 1e-12).length,
    within005: values.filter((v) => v <= 0.005 + 1e-12).length,
    meanAbs: values.reduce((sum, value) => sum + value, 0) / values.length,
    maxAbs: Math.max(...values),
  };
}

function compareFullSeason(expected: Row[], quality: Row[], aggregate: Row[]) {
  const aggregateMaps = rowMaps(aggregate);
  const qualityById = new Map<number, Row>();
  for (const row of quality) {
    const id = num(row.player_id);
    if (id != null) qualityById.set(id, row);
  }
  const diffs = { pa: [] as number[], woba: [] as number[], xwoba: [] as number[], hardHitPct: [] as number[], barrelPct: [] as number[] };
  let matched = 0;
  let byId = 0;
  let byName = 0;
  for (const source of expected) {
    const matchedRow = matchRow(source, aggregateMaps);
    if (!matchedRow) continue;
    matched++;
    if (matchedRow.route === "ID") byId++; else byName++;
    const agg = matchedRow.row;
    const id = num(source.player_id);
    const q = id == null ? undefined : qualityById.get(id);
    const pairs: Array<[keyof typeof diffs, number | null, number | null]> = [
      ["pa", num(source.pa), num(first(agg, ["pa"]))],
      ["woba", num(source.woba), num(first(agg, ["woba"]))],
      ["xwoba", num(source.est_woba), num(first(agg, ["xwoba", "est_woba"]))],
      ["hardHitPct", num(q?.ev95percent), num(first(agg, ["hardhit_percent", "hard_hit_percent"]))],
      ["barrelPct", num(q?.brl_percent), num(first(agg, ["barrels_per_bbe_percent", "brl_percent"]))],
    ];
    for (const [key, left, right] of pairs) if (left != null && right != null) diffs[key].push(Math.abs(left - right));
  }
  return {
    matched,
    byId,
    byName,
    fieldParity: {
      pa: diffStats(diffs.pa),
      woba: diffStats(diffs.woba),
      xwoba: diffStats(diffs.xwoba),
      hardHitPct: diffStats(diffs.hardHitPct),
      barrelPct: diffStats(diffs.barrelPct),
    },
  };
}

function cutoffActivity(fullRows: Row[], cutoffRows: Row[], fullText: string, cutoffText: string) {
  const full = rowMaps(fullRows);
  const cutoff = rowMaps(cutoffRows);
  let common = 0;
  let changed = 0;
  for (const [id, row] of cutoff.byId) {
    const fullRow = full.byId.get(id);
    if (!fullRow) continue;
    common++;
    const keys = ["pa", "woba", "xwoba", "hardhit_percent", "barrels_per_bbe_percent"];
    if (keys.some((key) => String(row[key] ?? "") !== String(fullRow[key] ?? ""))) changed++;
  }
  return {
    payloadDifferent: sha256(fullText) !== sha256(cutoffText),
    fullRows: fullRows.length,
    cutoffRows: cutoffRows.length,
    commonPlayersById: common,
    commonPlayersWithChangedAggregate: changed,
    cutoffDemonstrablyActive: sha256(fullText) !== sha256(cutoffText) && changed > 0,
  };
}

async function main() {
  const season = 2025;
  const targetCutoff = "2025-05-31";
  const expectedUrl = queryUrl("https://baseballsavant.mlb.com/leaderboard/expected_statistics", {
    type: "pitcher", year: String(season), min: "1", csv: "true",
  });
  const qualityUrl = queryUrl("https://baseballsavant.mlb.com/leaderboard/statcast", {
    type: "pitcher", year: String(season), min: "1", csv: "true",
  });
  const fullAggregateUrl = aggregateUrl(season, null);
  const cutoffAggregateUrl = aggregateUrl(season, targetCutoff);

  const [expectedText, qualityText, fullText, cutoffText] = await Promise.all([
    fetchText(expectedUrl), fetchText(qualityUrl), fetchText(fullAggregateUrl), fetchText(cutoffAggregateUrl),
  ]);
  const expected = parseCsv(expectedText);
  const quality = parseCsv(qualityText);
  const fullAggregate = parseCsv(fullText);
  const cutoffAggregate = parseCsv(cutoffText);
  const fullContract = aggregateContract(fullAggregate);
  const cutoffContract = aggregateContract(cutoffAggregate);
  const fullSeasonParity = fullContract.detected
    ? compareFullSeason(expected.rows, quality.rows, fullAggregate.rows)
    : null;
  const cutoff = fullContract.detected && cutoffContract.detected
    ? cutoffActivity(fullAggregate.rows, cutoffAggregate.rows, fullText, cutoffText)
    : null;

  const evidence = {
    schemaVersion: SCHEMA,
    status: "AGGREGATE_TARGET_DATE_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    season,
    targetCutoff,
    priorProbeFinding: {
      workflowRunId: 33775500551,
      artifactId: 9901486806,
      artifactDigest: "sha256:2ca88ca933395dcd8b5a60aead1849b6503e5593322f0392df6a3856e7df5416",
      defect: "type=details returned pitch-level rows; all requested aggregate field comparisons had n=0",
    },
    scientificBoundary: {
      researchOnly: true,
      productionChanged: false,
      weightsChanged: false,
      marketPricesRead: false,
      targetOutcomeReadForModeling: false,
      r1b2Authorized: false,
      statcastQualityParityCertifiedByThisProbe: false,
    },
    source: {
      expectedStatistics: { url: expectedUrl, sha256: sha256(expectedText), rows: expected.rows.length, headers: expected.headers },
      statcastLeaderboard: { url: qualityUrl, sha256: sha256(qualityText), rows: quality.rows.length, headers: quality.headers },
      fullAggregate: { url: fullAggregateUrl, sha256: sha256(fullText), rows: fullAggregate.rows.length, headers: fullAggregate.headers },
      cutoffAggregate: { url: cutoffAggregateUrl, sha256: sha256(cutoffText), rows: cutoffAggregate.rows.length, headers: cutoffAggregate.headers },
    },
    aggregateContract: { fullSeason: fullContract, targetDate: cutoffContract },
    fullSeasonParity,
    targetDateCutoff: cutoff,
    xeraBoundary: {
      aggregateSearchDirectlyEmitsXera: fullAggregate.headers.includes("xera"),
      aggregateSearchDirectlyEmitsEra: fullAggregate.headers.includes("era"),
      officialDefinition: "xERA is a 1:1 translation of xwOBA converted to the ERA scale",
      exactConversionFormulaProvenByThisProbe: false,
      exactTargetDateEraMinusXeraReconstructionProvenByThisProbe: false,
    },
    decision: {
      familyClassificationBefore: "PARTIAL_PARITY",
      familyClassificationAfter: "PARTIAL_PARITY",
      familyPromotionAuthorized: false,
      nextGate: fullContract.detected && cutoff?.cutoffDemonstrablyActive
        ? "PROVE_EXACT_XERA_ERA_SCALE_CONVERSION_AND_TARGET_DATE_ERA_MINUS_XERA_THEN_FULL_UNIVERSE_REPLAY"
        : "RESOLVE_AGGREGATE_STATCAST_SEARCH_CONTRACT_BEFORE_XERA_BRIDGE_RESEARCH",
    },
  };

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-aggregate-target-date-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({
    aggregateFull: fullContract,
    aggregateCutoff: cutoffContract,
    fullSeasonParity,
    cutoff,
    nextGate: evidence.decision.nextGate,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
