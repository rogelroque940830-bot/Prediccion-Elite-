import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA = "courtedge-mlb-r1b-statcast-full-season-semantic-bridge-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Statcast-Bridge/1.0)";

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

function first(row: Row, candidates: string[]): string | undefined {
  for (const key of candidates) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  return undefined;
}

function normName(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP_${res.status}:${body.slice(0, 200)}`);
      if (/^\s*</.test(body)) throw new Error(`HTML_RESPONSE:${body.slice(0, 120)}`);
      return body;
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error(`FETCH_FAILED:${url}:${String(last)}`);
}

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function fitAffine(points: Array<{ x: number; y: number }>) {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  const sxx = points.reduce((s, p) => s + (p.x - meanX) ** 2, 0);
  const sxy = points.reduce((s, p) => s + (p.x - meanX) * (p.y - meanY), 0);
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residuals = points.map((p) => p.y - (intercept + slope * p.x));
  const abs = residuals.map(Math.abs);
  const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
  return {
    intercept,
    slope,
    rmse,
    maxAbsResidual: Math.max(...abs),
    meanAbsResidual: abs.reduce((s, v) => s + v, 0) / n,
  };
}

function evaluateRunsDelta(eraGap: number, xwobaGap: number, hardHitPct: number): number {
  const raw = (-eraGap * 0.30) + (xwobaGap * 5.0) + (((hardHitPct - 38) / 100) * 0.8);
  const capped = Math.max(-0.45, Math.min(0.45, raw));
  return Math.round(capped * 100) / 100;
}

async function main() {
  const season = 2025;
  const expectedUrl = queryUrl("https://baseballsavant.mlb.com/leaderboard/expected_statistics", {
    type: "pitcher", year: String(season), min: "1", csv: "true",
  });
  const qualityUrl = queryUrl("https://baseballsavant.mlb.com/leaderboard/statcast", {
    type: "pitcher", year: String(season), min: "1", csv: "true",
  });
  const groupedUrl = queryUrl("https://baseballsavant.mlb.com/statcast_search/csv", {
    all: "true",
    type: "details",
    hfGT: "R|",
    hfSea: `${season}|`,
    player_type: "pitcher",
    group_by: "name",
    min_pitches: "0",
    min_results: "0",
    min_pas: "0",
    sort_col: "pitches",
    sort_order: "desc",
    chk_stats_pa: "on",
    chk_stats_woba: "on",
    chk_stats_xwoba: "on",
    chk_stats_hardhit_percent: "on",
    chk_stats_barrels_total: "on",
    chk_stats_barrels_per_bbe_percent: "on",
    chk_stats_barrels_per_pa_percent: "on",
  });

  const [expectedText, qualityText, groupedText] = await Promise.all([
    fetchText(expectedUrl), fetchText(qualityUrl), fetchText(groupedUrl),
  ]);
  const expected = parseCsv(expectedText);
  const quality = parseCsv(qualityText);
  const grouped = parseCsv(groupedText);

  const qualityById = new Map<number, Row>();
  for (const row of quality.rows) {
    const id = num(first(row, ["player_id", "pitcher"]));
    if (id != null) qualityById.set(id, row);
  }

  const groupedById = new Map<number, Row>();
  const groupedByName = new Map<string, Row>();
  for (const row of grouped.rows) {
    const id = num(first(row, ["player_id", "pitcher", "playerid"]));
    if (id != null) groupedById.set(id, row);
    const name = normName(first(row, ["player_name", "name", "last_name, first_name"]));
    if (name) groupedByName.set(name, row);
  }

  const matches: Array<{
    playerId: number;
    name: string;
    expectedPa: number | null;
    expectedEra: number;
    expectedXera: number;
    expectedEraGap: number;
    expectedWoba: number;
    expectedXwoba: number;
    expectedXwobaGap: number;
    expectedHardHit: number | null;
    expectedBarrel: number | null;
    groupedPa: number | null;
    groupedWoba: number | null;
    groupedXwoba: number | null;
    groupedHardHit: number | null;
    groupedBarrel: number | null;
    matchRoute: "ID" | "NAME";
  }> = [];

  for (const row of expected.rows) {
    const playerId = num(row["player_id"]);
    const expectedEra = num(row["era"]);
    const expectedXera = num(row["xera"]);
    const expectedEraGap = num(row["era_minus_xera_diff"]);
    const expectedWoba = num(row["woba"]);
    const expectedXwoba = num(row["est_woba"]);
    const expectedXwobaGap = num(row["est_woba_minus_woba_diff"]);
    if (playerId == null || expectedEra == null || expectedXera == null || expectedEraGap == null || expectedWoba == null || expectedXwoba == null || expectedXwobaGap == null) continue;
    const name = row["last_name, first_name"] ?? "";
    const q = qualityById.get(playerId);
    const expectedHardHit = num(q?.["ev95percent"]);
    const expectedBarrel = num(q?.["brl_percent"]);

    let g = groupedById.get(playerId);
    let route: "ID" | "NAME" = "ID";
    if (!g) { g = groupedByName.get(normName(name)); route = "NAME"; }
    if (!g) continue;

    const groupedXwoba = num(first(g, ["xwoba", "est_woba", "estimated_woba"]));
    const groupedWoba = num(first(g, ["woba"]));
    const groupedHardHit = num(first(g, ["hardhit_percent", "hard_hit_percent", "hardhit_pct"]));
    const groupedBarrel = num(first(g, ["barrels_per_bbe_percent", "brl_percent", "barrel_batted_rate"]));
    const groupedPa = num(first(g, ["pa", "plate_appearances"]));

    matches.push({
      playerId,
      name,
      expectedPa: num(row["pa"]),
      expectedEra,
      expectedXera,
      expectedEraGap,
      expectedWoba,
      expectedXwoba,
      expectedXwobaGap,
      expectedHardHit,
      expectedBarrel,
      groupedPa,
      groupedWoba,
      groupedXwoba,
      groupedHardHit,
      groupedBarrel,
      matchRoute: route,
    });
  }

  const affinePoints = matches.filter((m) => m.groupedXwoba != null).map((m) => ({ x: m.groupedXwoba!, y: m.expectedXera }));
  const expectedAffinePoints = matches.map((m) => ({ x: m.expectedXwoba, y: m.expectedXera }));
  const fitGrouped = affinePoints.length >= 2 ? fitAffine(affinePoints) : null;
  const fitExpected = expectedAffinePoints.length >= 2 ? fitAffine(expectedAffinePoints) : null;

  function diffs(keyA: keyof typeof matches[number], keyB: keyof typeof matches[number]) {
    const vals = matches.flatMap((m) => {
      const a = m[keyA]; const b = m[keyB];
      return typeof a === "number" && typeof b === "number" ? [Math.abs(a - b)] : [];
    });
    return vals.length ? {
      n: vals.length,
      exact: vals.filter((v) => v === 0).length,
      within0005: vals.filter((v) => v <= 0.0005 + 1e-12).length,
      within005: vals.filter((v) => v <= 0.005 + 1e-12).length,
      meanAbs: vals.reduce((s, v) => s + v, 0) / vals.length,
      maxAbs: Math.max(...vals),
    } : { n: 0, exact: 0, within0005: 0, within005: 0, meanAbs: null, maxAbs: null };
  }

  const xwobaDiff = diffs("expectedXwoba", "groupedXwoba");
  const wobaDiff = diffs("expectedWoba", "groupedWoba");
  const hardHitDiff = diffs("expectedHardHit", "groupedHardHit");
  const barrelDiff = diffs("expectedBarrel", "groupedBarrel");
  const paDiff = diffs("expectedPa", "groupedPa");

  const reconstructedRuns: Array<{ expected: number; reconstructed: number; absDiff: number }> = [];
  if (fitExpected) {
    for (const m of matches) {
      if (m.groupedXwoba == null || m.groupedWoba == null || m.groupedHardHit == null) continue;
      const reconstructedXera = fitExpected.intercept + fitExpected.slope * m.groupedXwoba;
      const reconstructedEraGap = m.expectedEra - reconstructedXera;
      const reconstructedXwobaGap = m.groupedXwoba - m.groupedWoba;
      const reconstructed = evaluateRunsDelta(reconstructedEraGap, reconstructedXwobaGap, m.groupedHardHit);
      const expectedRuns = evaluateRunsDelta(m.expectedEraGap, m.expectedXwobaGap, m.expectedHardHit ?? 0);
      reconstructedRuns.push({ expected: expectedRuns, reconstructed, absDiff: Math.abs(expectedRuns - reconstructed) });
    }
  }

  const runDiffs = reconstructedRuns.map((r) => r.absDiff);
  const evidence = {
    schemaVersion: SCHEMA,
    status: "FULL_SEASON_BRIDGE_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    season,
    scientificBoundary: {
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
      groupedStatcastSearch: { url: groupedUrl, sha256: sha256(groupedText), rows: grouped.rows.length, headers: grouped.headers, sample: grouped.rows.slice(0, 3) },
    },
    identity: {
      expectedRowsMatchedToGroupedSearch: matches.length,
      byId: matches.filter((m) => m.matchRoute === "ID").length,
      byName: matches.filter((m) => m.matchRoute === "NAME").length,
    },
    fieldParity: {
      pa: paDiff,
      woba: wobaDiff,
      xwoba: xwobaDiff,
      hardHitPct: hardHitDiff,
      barrelPct: barrelDiff,
    },
    xeraAffineAgainstExpectedLeaderboardXwoba: fitExpected,
    xeraAffineAgainstGroupedStatcastSearchXwoba: fitGrouped,
    runsDeltaBridgeDiagnostic: {
      n: reconstructedRuns.length,
      exactRoundedRunsDelta: reconstructedRuns.filter((r) => r.absDiff === 0).length,
      mismatchRoundedRunsDelta: reconstructedRuns.filter((r) => r.absDiff !== 0).length,
      maxAbsRoundedRunsDeltaDiff: runDiffs.length ? Math.max(...runDiffs) : null,
      meanAbsRoundedRunsDeltaDiff: runDiffs.length ? runDiffs.reduce((s, v) => s + v, 0) / runDiffs.length : null,
    },
    interpretationPolicy: {
      thirdPartyAffineConstantsAreNotAuthority: true,
      fittedFullSeasonAffineRelationshipDoesNotByItselfProveTargetDateMapping: true,
      groupedStatcastSearchMustMatchCanonicalLeaderboardFieldsBeforeHistoricalUse: true,
      onlyRoundedRunsDeltaEquivalenceCanSupportFurtherBridgeResearch: true,
      promotionRequiresTargetDateFullUniverseAndIndependentVerification: true,
    },
  };

  const outArg = process.argv.find((a) => a.startsWith("--out="));
  const out = outArg ? outArg.slice(6) : "artifacts/mlb-r1b-statcast-full-season-semantic-bridge-probe/evidence.json";
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    status: evidence.status,
    identity: evidence.identity,
    fieldParity: evidence.fieldParity,
    xeraAffineAgainstExpectedLeaderboardXwoba: evidence.xeraAffineAgainstExpectedLeaderboardXwoba,
    runsDeltaBridgeDiagnostic: evidence.runsDeltaBridgeDiagnostic,
    out,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
