import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA = "courtedge-mlb-r1b-statcast-contact-quality-semantic-probe.v1" as const;
const UA = "Mozilla/5.0 (compatible; CourtEdge-MLB-R1B-Statcast-Contact-Quality/1.0)";
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
function sha256(text: string): string { return crypto.createHash("sha256").update(text).digest("hex"); }
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
function same(left: number | null, right: number | null, tolerance = 1e-12): boolean {
  return left != null && right != null && Math.abs(left - right) <= tolerance;
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

function aggregateUrl(season: number): string {
  return queryUrl("https://baseballsavant.mlb.com/statcast_search/csv", {
    all: "true",
    hfGT: "R|",
    hfSea: `${season}|`,
    player_type: "pitcher",
    group_by: "name",
    min_pitches: "0",
    min_results: "0",
    min_pas: "0",
    sort_col: "hardhit_percent",
    sort_order: "desc",
    chk_stats_pa: "on",
    chk_stats_bip: "on",
    chk_stats_hardhit_percent: "on",
    chk_stats_barrels_total: "on",
    chk_stats_barrels_per_bbe_percent: "on",
    chk_stats_barrels_per_pa_percent: "on",
  });
}

type Pair = {
  playerId: number;
  playerName: string;
  leaderboard: {
    attempts: number | null;
    ev95plus: number | null;
    ev95percent: number | null;
    barrels: number | null;
    brlPercent: number | null;
    brlPa: number | null;
  };
  aggregate: {
    pa: number | null;
    bip: number | null;
    hardHitPercent: number | null;
    barrelsTotal: number | null;
    barrelsPerBbePercent: number | null;
    barrelsPerPaPercent: number | null;
  };
};

function formulaStats(pairs: readonly Pair[]) {
  const stats = {
    attemptsEqualsBip: { n: 0, exact: 0, maxAbs: 0 },
    barrelsEqualsBarrelsTotal: { n: 0, exact: 0, maxAbs: 0 },
    leaderboardHardHitInternalRound1: { n: 0, exact: 0, maxAbs: 0 },
    leaderboardBarrelInternalRound1: { n: 0, exact: 0, maxAbs: 0 },
    aggregateHardHitRounded1EqualsLeaderboard: { n: 0, exact: 0, maxAbs: 0 },
    aggregateBarrelRounded1EqualsLeaderboard: { n: 0, exact: 0, maxAbs: 0 },
    aggregateBarrelPaRounded1EqualsLeaderboard: { n: 0, exact: 0, maxAbs: 0 },
    aggregateBarrelInternalUsingBip: { n: 0, exact: 0, maxAbs: 0 },
    aggregateBarrelPaInternalUsingPa: { n: 0, exact: 0, maxAbs: 0 },
    inferredAggregateBbeDenominatorEqualsLeaderboardAttempts: { n: 0, exactWithin001: 0, meanAbs: null as number | null, maxAbs: 0 },
  };
  const inferredDiffs: number[] = [];
  const test = (target: { n: number; exact: number; maxAbs: number }, left: number | null, right: number | null) => {
    if (left == null || right == null) return;
    target.n++;
    const d = Math.abs(left - right);
    if (d <= 1e-12) target.exact++;
    target.maxAbs = Math.max(target.maxAbs, d);
  };
  for (const pair of pairs) {
    const l = pair.leaderboard;
    const a = pair.aggregate;
    test(stats.attemptsEqualsBip, l.attempts, a.bip);
    test(stats.barrelsEqualsBarrelsTotal, l.barrels, a.barrelsTotal);
    const hardHitInternal = l.attempts && l.ev95plus != null ? round((100 * l.ev95plus) / l.attempts, 1) : null;
    const barrelInternal = l.attempts && l.barrels != null ? round((100 * l.barrels) / l.attempts, 1) : null;
    const aggBarrelInternal = a.bip && a.barrelsTotal != null ? (100 * a.barrelsTotal) / a.bip : null;
    const aggBarrelPaInternal = a.pa && a.barrelsTotal != null ? (100 * a.barrelsTotal) / a.pa : null;
    test(stats.leaderboardHardHitInternalRound1, l.ev95percent, hardHitInternal);
    test(stats.leaderboardBarrelInternalRound1, l.brlPercent, barrelInternal);
    test(stats.aggregateHardHitRounded1EqualsLeaderboard, l.ev95percent, a.hardHitPercent == null ? null : round(a.hardHitPercent, 1));
    test(stats.aggregateBarrelRounded1EqualsLeaderboard, l.brlPercent, a.barrelsPerBbePercent == null ? null : round(a.barrelsPerBbePercent, 1));
    test(stats.aggregateBarrelPaRounded1EqualsLeaderboard, l.brlPa, a.barrelsPerPaPercent == null ? null : round(a.barrelsPerPaPercent, 1));
    test(stats.aggregateBarrelInternalUsingBip, a.barrelsPerBbePercent, aggBarrelInternal);
    test(stats.aggregateBarrelPaInternalUsingPa, a.barrelsPerPaPercent, aggBarrelPaInternal);
    if (a.barrelsTotal != null && a.barrelsTotal > 0 && a.barrelsPerBbePercent != null && a.barrelsPerBbePercent > 0 && l.attempts != null) {
      const inferred = (100 * a.barrelsTotal) / a.barrelsPerBbePercent;
      const d = Math.abs(inferred - l.attempts);
      stats.inferredAggregateBbeDenominatorEqualsLeaderboardAttempts.n++;
      if (d <= 0.01) stats.inferredAggregateBbeDenominatorEqualsLeaderboardAttempts.exactWithin001++;
      stats.inferredAggregateBbeDenominatorEqualsLeaderboardAttempts.maxAbs = Math.max(stats.inferredAggregateBbeDenominatorEqualsLeaderboardAttempts.maxAbs, d);
      inferredDiffs.push(d);
    }
  }
  stats.inferredAggregateBbeDenominatorEqualsLeaderboardAttempts.meanAbs = inferredDiffs.length
    ? inferredDiffs.reduce((s, d) => s + d, 0) / inferredDiffs.length
    : null;
  return stats;
}

function topMismatches(pairs: readonly Pair[]) {
  return [...pairs].map((pair) => ({
    playerId: pair.playerId,
    playerName: pair.playerName,
    attempts: pair.leaderboard.attempts,
    bip: pair.aggregate.bip,
    ev95plus: pair.leaderboard.ev95plus,
    ev95percent: pair.leaderboard.ev95percent,
    aggregateHardHitPercent: pair.aggregate.hardHitPercent,
    hardHitAbsDiff: pair.leaderboard.ev95percent != null && pair.aggregate.hardHitPercent != null
      ? Math.abs(pair.leaderboard.ev95percent - pair.aggregate.hardHitPercent) : null,
    barrels: pair.leaderboard.barrels,
    barrelsTotal: pair.aggregate.barrelsTotal,
    brlPercent: pair.leaderboard.brlPercent,
    aggregateBarrelsPerBbePercent: pair.aggregate.barrelsPerBbePercent,
    barrelAbsDiff: pair.leaderboard.brlPercent != null && pair.aggregate.barrelsPerBbePercent != null
      ? Math.abs(pair.leaderboard.brlPercent - pair.aggregate.barrelsPerBbePercent) : null,
  })).sort((left, right) =>
    (right.hardHitAbsDiff ?? -1) - (left.hardHitAbsDiff ?? -1)
    || (right.barrelAbsDiff ?? -1) - (left.barrelAbsDiff ?? -1)
    || left.playerId - right.playerId,
  ).slice(0, 25);
}

async function main() {
  const season = 2025;
  const leaderboardUrl = queryUrl("https://baseballsavant.mlb.com/leaderboard/statcast", {
    type: "pitcher", year: String(season), min: "1", csv: "true",
  });
  const groupedUrl = aggregateUrl(season);
  const [leaderboardText, groupedText] = await Promise.all([fetchText(leaderboardUrl), fetchText(groupedUrl)]);
  const leaderboard = parseCsv(leaderboardText);
  const grouped = parseCsv(groupedText);
  const groupedById = new Map<number, Row>();
  for (const row of grouped.rows) {
    const id = num(row.player_id);
    if (id != null) groupedById.set(id, row);
  }
  const pairs: Pair[] = [];
  for (const row of leaderboard.rows) {
    const playerId = num(row.player_id);
    if (playerId == null) continue;
    const aggregate = groupedById.get(playerId);
    if (!aggregate) continue;
    pairs.push({
      playerId,
      playerName: row["last_name, first_name"] ?? aggregate.player_name ?? "",
      leaderboard: {
        attempts: num(row.attempts),
        ev95plus: num(row.ev95plus),
        ev95percent: num(row.ev95percent),
        barrels: num(row.barrels),
        brlPercent: num(row.brl_percent),
        brlPa: num(row.brl_pa),
      },
      aggregate: {
        pa: num(aggregate.pa),
        bip: num(aggregate.bip),
        hardHitPercent: num(aggregate.hardhit_percent),
        barrelsTotal: num(aggregate.barrels_total),
        barrelsPerBbePercent: num(aggregate.barrels_per_bbe_percent),
        barrelsPerPaPercent: num(aggregate.barrels_per_pa_percent),
      },
    });
  }
  const formulas = formulaStats(pairs);
  const evidence = {
    schemaVersion: SCHEMA,
    status: "CONTACT_QUALITY_SEMANTIC_PROBE_ONLY_NOT_PARITY_CERTIFICATION",
    generatedAt: new Date().toISOString(),
    season,
    source: {
      statcastLeaderboard: { url: leaderboardUrl, sha256: sha256(leaderboardText), rows: leaderboard.rows.length, headers: leaderboard.headers },
      statcastSearchAggregate: { url: groupedUrl, sha256: sha256(groupedText), rows: grouped.rows.length, headers: grouped.headers },
    },
    identity: {
      leaderboardRows: leaderboard.rows.length,
      aggregateRows: grouped.rows.length,
      matchedByPlayerId: pairs.length,
    },
    formulas,
    topMismatches: topMismatches(pairs),
    scientificBoundary: {
      researchOnly: true,
      productionChanged: false,
      weightsChanged: false,
      marketPricesRead: false,
      targetOutcomeReadForModeling: false,
      r1b2Authorized: false,
      statcastQualityParityCertifiedByThisProbe: false,
    },
    decision: {
      familyClassificationBefore: "PARTIAL_PARITY",
      familyClassificationAfter: "PARTIAL_PARITY",
      familyPromotionAuthorized: false,
      exactContactQualityBridgeProven: false,
      nextGate: "INTERPRET_COUNT_DENOMINATOR_AND_ROUNDING_RESULTS; IF NEEDED RECONSTRUCT EV95PLUS/ATTEMPTS/BARRELS FROM DATE_BOUNDED_RAW_BBE_ROWS",
    },
  };
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = path.resolve(outArg ? outArg.slice("--out=".length) : "artifacts/mlb-r1b-statcast-contact-quality-semantic-probe/evidence.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ identity: evidence.identity, formulas, topMismatches: evidence.topMismatches.slice(0, 5) }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
