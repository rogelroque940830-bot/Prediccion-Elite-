import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = "courtedge-mlb-r1b-statcast-xera-immutable-mirror-stability-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-xERA-Mirror-Stability/1.0)";

const SNAPSHOTS = [
  { capturedAt: "2026-07-16T13:33:36Z", commit: "497dd93f8b2605ca615e34a626400064b7e9eccf" },
  { capturedAt: "2026-07-23T14:04:23Z", commit: "34b13ec60660a552ef02aeca8836b6ad8d0a5749" },
  { capturedAt: "2026-08-02T15:04:17Z", commit: "f4adfe6ec584f4cfe52839e49a49b995d2f20c35" },
  { capturedAt: "2026-08-03T10:26:58Z", commit: "7d3e562806564a69a1f41d074c34ed77c4ab33f6" },
  { capturedAt: "2026-08-21T15:02:44Z", commit: "9693a72ff930e637bedf70652ceb6b1a7842b3af" },
  { capturedAt: "2026-08-27T15:01:48Z", commit: "c29671f00458e8abbcad59f3d8c3006925bf8465" },
] as const;

const MIRROR_REPO = "IDBach16/Fantasy_MLB";
const MIRROR_PATH = "data/cache/savant_pit_xstats_2026.csv";

type Row = Record<string, string>;
type Mapping = Map<string, number>;

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
    } else cell += c;
  }
  out.push(cell);
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

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function num(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchText(url: string): Promise<string> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/plain,text/csv;q=0.9,*/*;q=0.8", "User-Agent": UA },
        signal: AbortSignal.timeout(90_000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP_${response.status}:${body.slice(0, 160)}`);
      if (/^\s*</.test(body)) throw new Error(`HTML_RESPONSE:${body.slice(0, 120)}`);
      return body;
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  throw new Error(`FETCH_FAILED:${url}:${String(last)}`);
}

function rawUrl(commit: string): string {
  return `https://raw.githubusercontent.com/${MIRROR_REPO}/${commit}/${MIRROR_PATH}`;
}

function buildMapping(rows: readonly Row[]): { mapping: Mapping; conflicts: unknown[]; usableRows: number } {
  const mapping = new Map<string, number>();
  const conflicts: unknown[] = [];
  let usableRows = 0;
  for (const row of rows) {
    const season = num(row.year);
    const xwobaRaw = String(row.est_woba ?? "").trim();
    const xera = num(row.xera);
    if (season !== 2026 || !xwobaRaw || xera == null) continue;
    usableRows++;
    const existing = mapping.get(xwobaRaw);
    if (existing == null) mapping.set(xwobaRaw, xera);
    else if (existing !== xera) conflicts.push({ xwoba: xwobaRaw, firstXera: existing, secondXera: xera });
  }
  return { mapping, conflicts, usableRows };
}

function compareMappings(left: Mapping, right: Mapping) {
  const common = [...left.keys()].filter((key) => right.has(key)).sort((a, b) => Number(a) - Number(b));
  const changed = common.flatMap((xwoba) => {
    const before = left.get(xwoba)!;
    const after = right.get(xwoba)!;
    return before === after ? [] : [{ xwoba, before, after, delta: after - before }];
  });
  return {
    commonDisplayedXwobaValues: common.length,
    unchanged: common.length - changed.length,
    changed: changed.length,
    anyMappingChange: changed.length > 0,
    maxAbsoluteChange: changed.length ? Math.max(...changed.map((item) => Math.abs(item.delta))) : 0,
    changeExamples: changed.slice(0, 30),
  };
}

async function main() {
  const snapshots: Array<{
    capturedAt: string;
    commit: string;
    url: string;
    sha256: string;
    rows: number;
    usableRows: number;
    mapping: Mapping;
  }> = [];

  for (const spec of SNAPSHOTS) {
    const url = rawUrl(spec.commit);
    const text = await fetchText(url);
    const parsed = parseCsv(text);
    for (const required of ["player_id", "year", "pa", "est_woba", "xera", "era", "era_minus_xera_diff"]) {
      if (!parsed.headers.includes(required)) throw new Error(`MIRROR_SCHEMA_DRIFT:${spec.commit}:${required}`);
    }
    const built = buildMapping(parsed.rows);
    if (built.conflicts.length) throw new Error(`MIRROR_MAPPING_COLLISION:${spec.commit}:${JSON.stringify(built.conflicts.slice(0, 5))}`);
    if (built.mapping.size < 50) throw new Error(`MIRROR_MAPPING_TOO_SMALL:${spec.commit}:${built.mapping.size}`);
    snapshots.push({
      capturedAt: spec.capturedAt,
      commit: spec.commit,
      url,
      sha256: sha256(text),
      rows: parsed.rows.length,
      usableRows: built.usableRows,
      mapping: built.mapping,
    });
  }

  const adjacent = snapshots.slice(1).map((right, index) => {
    const left = snapshots[index];
    return {
      leftCapturedAt: left.capturedAt,
      leftCommit: left.commit,
      rightCapturedAt: right.capturedAt,
      rightCommit: right.commit,
      comparison: compareMappings(left.mapping, right.mapping),
    };
  });
  const firstVsLast = compareMappings(snapshots[0].mapping, snapshots[snapshots.length - 1].mapping);

  const evidence = {
    schemaVersion: SCHEMA,
    status: "IMMUTABLE_THIRD_PARTY_MIRROR_STABILITY_PROBE_ONLY_NOT_SOURCE_AUTHORITY",
    family: "STATCAST_QUALITY",
    generatedAt: new Date().toISOString(),
    subjectSeason: 2026,
    mirror: {
      repository: MIRROR_REPO,
      path: MIRROR_PATH,
      immutableGitCommits: true,
      primarySourceAuthority: false,
      usePolicy: "INDEPENDENT_TIMESTAMPED_DIAGNOSTIC_ONLY; mirror data cannot replace Baseball Savant as canonical source authority.",
    },
    snapshots: snapshots.map(({ mapping, ...snapshot }) => ({
      ...snapshot,
      uniqueDisplayedXwobaValues: mapping.size,
    })),
    adjacentComparisons: adjacent,
    firstVsLast,
    scientificConclusion: {
      observedSameSeasonDisplayedXwobaToXeraMappingChangedAcrossImmutableSnapshots: firstVsLast.anyMappingChange || adjacent.some((item) => item.comparison.anyMappingChange),
      firstVsLastMappingChanged: firstVsLast.anyMappingChange,
      finalSeasonMappingRetroactiveUseSupportedByThisProbe: false,
      primaryAuthoritativeAsOfCustodyProven: false,
      familyPromotionAuthorized: false,
      nextGate: "OBTAIN_PRIMARY_AUTHORITATIVE_ASOF_XERA_CUSTODY_OR_EXACT_TIME_VARYING_CONVERSION_PARAMETERS; DO_NOT_APPLY_FINAL_SEASON_MAPPING_RETROACTIVELY",
    },
    interpretationPolicy: {
      thirdPartyMirrorCannotCertifySourceAuthority: true,
      immutableCommitTimestampIsEvidenceOfMirrorStateNotMLBPublicationTime: true,
      mappingChangeMayBeUsedToReject_STABILITY_ASSUMPTION_butNotToAuthorizeHistoricalFeatureValues: true,
      finalSeasonLookupRetroactiveUseForbidden: true,
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
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-xera-immutable-mirror-stability-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: evidence.status,
    snapshots: evidence.snapshots,
    adjacentComparisons: adjacent.map((item) => ({
      leftCapturedAt: item.leftCapturedAt,
      rightCapturedAt: item.rightCapturedAt,
      comparison: item.comparison,
    })),
    firstVsLast,
    scientificConclusion: evidence.scientificConclusion,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
