import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA = "courtedge-mlb-r1b-statcast-raw-bbe-count-parity-probe.v3" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Raw-BBE-V3/1.0)";
const BBE_FLAG = "is\\.\\.hit\\.\\.into\\.\\.play|";
type Row = Record<string, string>;
type Counts = { bipRows: number; launchSpeedRows: number; ev95plus: number; barrels: number };

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
function sha256(text: string): string { return crypto.createHash("sha256").update(text).digest("hex"); }
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

async function fetchText(url: string): Promise<string> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8", "User-Agent": UA },
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP_${res.status}:${body.slice(0, 160)}`);
      if (/^\s*</.test(body)) throw new Error(`HTML_RESPONSE:${body.slice(0, 120)}`);
      return body;
    } catch (error) {
      last = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
  throw new Error(`FETCH_FAILED:${url}:${String(last)}`);
}

function queryUrl(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function rawBbeUrl(season: number, gt: string, lt: string): string {
  return queryUrl("https://baseballsavant.mlb.com/statcast_search/csv", {
    all: "true",
    type: "details",
    hfGT: "R|",
    hfSea: `${season}|`,
    player_type: "pitcher",
    hfFlag: BBE_FLAG,
    "chk_is..hit..into..play": "on",
    game_date_gt: gt,
    game_date_lt: lt,
    min_pitches: "0",
    min_results: "0",
    min_pas: "0",
    sort_col: "pitches",
    sort_order: "desc",
  });
}

function rawIdentity(row: Row): string | null {
  const gamePk = String(row.game_pk ?? "").trim();
  const atBat = String(row.at_bat_number ?? "").trim();
  const pitch = String(row.pitch_number ?? "").trim();
  const pitcher = String(row.pitcher ?? "").trim();
  if (!gamePk || !atBat || !pitch || !pitcher) return null;
  return `${gamePk}:${atBat}:${pitch}:${pitcher}`;
}

function stat() { return { n: 0, exact: 0, diffs: [] as number[] }; }
function add(s: ReturnType<typeof stat>, expected: number | null, actual: number | null) {
  if (expected == null || actual == null) return;
  const d = Math.abs(expected - actual);
  s.n++;
  if (d === 0) s.exact++;
  s.diffs.push(d);
}
function finish(s: ReturnType<typeof stat>) {
  return {
    n: s.n,
    exact: s.exact,
    meanAbs: s.diffs.length ? s.diffs.reduce((a, b) => a + b, 0) / s.diffs.length : null,
    maxAbs: s.diffs.length ? Math.max(...s.diffs) : null,
  };
}

async function main() {
  const season = 2025;
  const leaderboardUrl = queryUrl("https://baseballsavant.mlb.com/leaderboard/statcast", {
    type: "pitcher", year: String(season), min: "1", csv: "true",
  });

  // v2 proved the corrected flag was serialized, but two-month chunks still hit Savant's 25k CSV cap.
  // Monthly-ish windows keep each response below the cap; one-day overlaps are deduplicated by pitch identity.
  const windows = [
    ["2025-03-01", "2025-04-02"],
    ["2025-04-01", "2025-05-02"],
    ["2025-05-01", "2025-06-02"],
    ["2025-06-01", "2025-07-02"],
    ["2025-07-01", "2025-08-02"],
    ["2025-08-01", "2025-09-02"],
    ["2025-09-01", "2025-10-15"],
  ] as const;
  const urls = windows.map(([gt, lt]) => rawBbeUrl(season, gt, lt));
  const serializedFlags = urls.map((url) => new URL(url).searchParams.get("hfFlag"));
  if (!serializedFlags.every((value) => value === BBE_FLAG)) {
    throw new Error(`BBE_FILTER_SERIALIZATION_MISMATCH:${JSON.stringify(serializedFlags)}`);
  }

  const [leaderboardText, ...rawTexts] = await Promise.all([fetchText(leaderboardUrl), ...urls.map(fetchText)]);
  const leaderboard = parseCsv(leaderboardText);
  const parsedChunks = rawTexts.map(parseCsv);

  const unique = new Map<string, Row>();
  let rowsWithoutIdentity = 0;
  const nonHitIntoPlayExamples: Array<{ description: string; events: string; gamePk: string; pitcher: string }> = [];
  let nonHitIntoPlayDescriptions = 0;
  for (const chunk of parsedChunks) {
    for (const row of chunk.rows) {
      const id = rawIdentity(row);
      if (!id) { rowsWithoutIdentity++; continue; }
      if (!String(row.description ?? "").includes("hit_into_play")) {
        nonHitIntoPlayDescriptions++;
        if (nonHitIntoPlayExamples.length < 20) {
          nonHitIntoPlayExamples.push({
            description: String(row.description ?? ""),
            events: String(row.events ?? ""),
            gamePk: String(row.game_pk ?? ""),
            pitcher: String(row.pitcher ?? ""),
          });
        }
      }
      unique.set(id, row);
    }
  }

  const byPitcher = new Map<number, Counts>();
  for (const row of unique.values()) {
    const pitcher = num(row.pitcher);
    if (pitcher == null) continue;
    const counts = byPitcher.get(pitcher) ?? { bipRows: 0, launchSpeedRows: 0, ev95plus: 0, barrels: 0 };
    counts.bipRows++;
    const ev = num(row.launch_speed);
    if (ev != null) {
      counts.launchSpeedRows++;
      if (ev >= 95) counts.ev95plus++;
    }
    if (num(row.launch_speed_angle) === 6) counts.barrels++;
    byPitcher.set(pitcher, counts);
  }

  const attempts = stat();
  const ev95plus = stat();
  const barrels = stat();
  const hardHitPct = stat();
  const leaderboardInternalHardHitPct = stat();
  const mismatches: unknown[] = [];
  let matchedPitchers = 0;

  for (const row of leaderboard.rows) {
    const playerId = num(row.player_id);
    if (playerId == null) continue;
    const raw = byPitcher.get(playerId);
    if (!raw) continue;
    matchedPitchers++;
    const expectedAttempts = num(row.attempts);
    const expectedEv95plus = num(row.ev95plus);
    const expectedEv95pct = num(row.ev95percent);
    const expectedBarrels = num(row.barrels);
    const rawPct = raw.bipRows > 0 ? round((100 * raw.ev95plus) / raw.bipRows, 1) : null;
    const internalPct = expectedAttempts && expectedEv95plus != null
      ? round((100 * expectedEv95plus) / expectedAttempts, 1)
      : null;
    add(attempts, expectedAttempts, raw.bipRows);
    add(ev95plus, expectedEv95plus, raw.ev95plus);
    add(barrels, expectedBarrels, raw.barrels);
    add(hardHitPct, expectedEv95pct, rawPct);
    add(leaderboardInternalHardHitPct, expectedEv95pct, internalPct);
    if (expectedAttempts !== raw.bipRows || expectedEv95plus !== raw.ev95plus || expectedBarrels !== raw.barrels || expectedEv95pct !== rawPct) {
      mismatches.push({
        playerId,
        playerName: row["last_name, first_name"] ?? "",
        leaderboard: { attempts: expectedAttempts, ev95plus: expectedEv95plus, ev95percent: expectedEv95pct, barrels: expectedBarrels },
        raw: { ...raw, hardHitPctFromRawCounts: rawPct },
      });
    }
  }

  const chunkDiagnostics = parsedChunks.map((chunk, index) => ({
    gt: windows[index][0],
    lt: windows[index][1],
    rows: chunk.rows.length,
    hitCsvSafetyCap: chunk.rows.length >= 25_000,
    sha256: sha256(rawTexts[index]),
  }));
  const everyChunkBelowCsvSafetyCap = chunkDiagnostics.every((chunk) => !chunk.hitCsvSafetyCap);
  const bbeDescriptionPurity = unique.size > 0 ? (unique.size - nonHitIntoPlayDescriptions) / unique.size : 0;
  const filterAccepted = everyChunkBelowCsvSafetyCap && bbeDescriptionPurity >= 0.9999;

  const comparison = {
    attempts: finish(attempts),
    ev95plus: finish(ev95plus),
    barrels: finish(barrels),
    hardHitPctFromRawCounts: finish(hardHitPct),
    leaderboardHardHitInternalFormula: finish(leaderboardInternalHardHitPct),
  };
  const exactCountBridge = comparison.attempts.n === leaderboard.rows.length
    && comparison.attempts.exact === comparison.attempts.n
    && comparison.ev95plus.exact === comparison.ev95plus.n
    && comparison.barrels.exact === comparison.barrels.n;

  const evidence = {
    schemaVersion: SCHEMA,
    status: "RAW_BBE_FILTER_AND_WINDOWING_CORRECTED_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    season,
    filterContract: {
      hfFlagDecoded: BBE_FLAG,
      eachLiteralDotEscaped: true,
      serializationVerifiedBeforeFetch: true,
      bbeDescriptionPurity,
      filterAccepted,
    },
    source: {
      statcastLeaderboard: { url: leaderboardUrl, sha256: sha256(leaderboardText), rows: leaderboard.rows.length, headers: leaderboard.headers },
      rawWindows: urls.map((url, index) => ({ url, ...chunkDiagnostics[index] })),
    },
    rawCustody: {
      downloadedRowsBeforeDedupe: parsedChunks.reduce((sum, chunk) => sum + chunk.rows.length, 0),
      uniqueTerminalPitchIdentities: unique.size,
      rowsWithoutIdentity,
      nonHitIntoPlayDescriptions,
      nonHitIntoPlayExamples,
      everyChunkBelowCsvSafetyCap,
    },
    identity: { leaderboardRows: leaderboard.rows.length, matchedPitchers },
    comparison,
    exactCountBridge,
    mismatchCount: mismatches.length,
    mismatchExamples: mismatches.slice(0, 30),
    scientificBoundary: {
      researchOnly: true,
      productionChanged: false,
      weightsChanged: false,
      marketPricesRead: false,
      targetOutcomeReadForModeling: false,
      rawRowsUsedOnlyToReconstructFrozenStatcastContactMetrics: true,
      r1b2Authorized: false,
      statcastQualityParityCertifiedByThisProbe: false,
    },
    decision: {
      familyClassificationBefore: "PARTIAL_PARITY",
      familyClassificationAfter: "PARTIAL_PARITY",
      familyPromotionAuthorized: false,
      bbeFilterCorrectionProven: filterAccepted,
      contactQualityCountBridgeProven: exactCountBridge,
      nextGate: !filterAccepted
        ? "STOP_AND_RESOLVE_BBE_FILTER_OR_WINDOWING"
        : exactCountBridge
          ? "FREEZE_DATE_BOUNDED_CONTACT_QUALITY_ADAPTER_THEN_XERA_ERA_SCALE"
          : "ISOLATE_REMAINING_RAW_BBE_VS_LEADERBOARD_SEMANTIC_DIFFERENCES_BEFORE_XERA_RESEARCH",
    },
  };

  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-raw-bbe-count-parity-probe-v3/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ filterContract: evidence.filterContract, rawCustody: evidence.rawCustody, identity: evidence.identity, comparison, exactCountBridge, mismatchCount: mismatches.length, mismatchExamples: mismatches.slice(0, 10) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
