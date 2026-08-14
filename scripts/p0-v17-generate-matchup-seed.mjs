#!/usr/bin/env node
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const EXPECTED = Object.freeze({
  v9Schema: "courtedge-p0-step12v9-game-team-hand-aggregates.v1",
  v12Schema: "courtedge-p0-step12v12-game-pitchmix-summary.v1",
  seedThroughDate: "2026-08-10",
  supportedTargetDateGte: "2026-08-11",
  supportedTargetDateLte: "2027-03-25",
  v9RunId: 31666803576,
  v9ArtifactId: 9168238661,
  v9Digest: "sha256:2dacb88229524aecc9ebcd7d90b84e0327be360618eafe1b35ecab890e888f48",
  v12RunId: 31669146698,
  v12_2025ArtifactId: 9169102385,
  v12_2025Digest: "sha256:eca343e9c88bb4fd3ea1d4b14cc10144a4604e681d25f0140c39de9b47cebaf2",
  v12_2026ArtifactId: 9169078788,
  v12_2026Digest: "sha256:3fe195aec739bd9a6558fbc36fbd6a32deb4d6666910ee3be8022add910be8f7",
});

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`MISSING_ARG:${name}`);
  return process.argv[index + 1];
}

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertPack(pack, schema, season) {
  if (pack?.schemaVersion !== schema) throw new Error(`PACK_SCHEMA_INVALID:${season}`);
  if (pack?.season !== season) throw new Error(`PACK_SEASON_INVALID:${season}`);
  if (!Array.isArray(pack?.games) || pack.games.length === 0) throw new Error(`PACK_GAMES_EMPTY:${season}`);
  if (Array.isArray(pack?.failures) && pack.failures.length > 0) throw new Error(`PACK_FAILURES:${season}`);
}

function add(map, key, values) {
  const current = map.get(key) ?? Array(values.length).fill(0);
  values.forEach((value, index) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error(`NON_FINITE_AGGREGATE:${key}:${index}`);
    current[index] += n;
  });
  map.set(key, current);
}

function aggregatePitchGames(games) {
  const pitchers = new Map();
  const teams = new Map();
  for (const game of games) {
    for (const row of game.pitcherTotals ?? []) {
      add(pitchers, String(Number(row.pitcherId)), [
        row.allPitches,
        row.categorizedPitches,
        row.FASTBALL,
        row.BREAKING,
        row.OFFSPEED,
      ]);
    }
    for (const row of game.teamPitchFamilyTotals ?? []) {
      add(teams, `${Number(row.teamId)}:${row.pitchFamily}`, [
        row.swings,
        row.whiffs,
        row.contacts,
        row.terminalPa,
        row.tb,
        row.hr,
      ]);
    }
  }
  return {
    pitchers: [...pitchers.entries()]
      .map(([id, values]) => [Number(id), ...values])
      .sort((a, b) => a[0] - b[0]),
    teams: [...teams.entries()]
      .map(([key, values]) => {
        const [teamId, family] = key.split(":");
        return [Number(teamId), family, ...values];
      })
      .sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1]))),
  };
}

function aggregateHandGames(games) {
  const teams = new Map();
  for (const game of games) {
    for (const row of game.teamHandTotals ?? []) {
      add(teams, `${Number(row.teamId)}:${row.vsHand}`, [row.pa, row.ab, row.tb]);
    }
  }
  return [...teams.entries()]
    .map(([key, values]) => {
      const [teamId, hand] = key.split(":");
      return [Number(teamId), hand, ...values];
    })
    .sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])));
}

const v9Path = arg("--v9-2026");
const v12_2025Path = arg("--v12-2025");
const v12_2026Path = arg("--v12-2026");
const outPath = arg("--out");
const v9 = load(v9Path);
const v12_2025 = load(v12_2025Path);
const v12_2026 = load(v12_2026Path);

assertPack(v9, EXPECTED.v9Schema, "2026_YTD");
assertPack(v12_2025, EXPECTED.v12Schema, "2025");
assertPack(v12_2026, EXPECTED.v12Schema, "2026_YTD");
for (const [label, pack] of [["V9_2026", v9], ["V12_2026", v12_2026]]) {
  const latest = [...pack.games].map((g) => g.officialDate).sort().at(-1);
  if (latest !== EXPECTED.seedThroughDate) throw new Error(`${label}_SEED_THROUGH_DRIFT:${latest}`);
}

const tailByDate = new Map();
for (const game of v12_2025.games) {
  if (game.officialDate < "2025-08-11" || game.officialDate > "2025-09-28") continue;
  const rows = tailByDate.get(game.officialDate) ?? [];
  rows.push(game);
  tailByDate.set(game.officialDate, rows);
}
if (tailByDate.size !== 49) throw new Error(`V12_2025_TAIL_DATE_COUNT_DRIFT:${tailByDate.size}`);

const pitchmix2025TailByDate = [...tailByDate.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([date, games]) => {
    const aggregate = aggregatePitchGames(games);
    return [date, aggregate.pitchers, aggregate.teams];
  });
const pitchmix2026 = aggregatePitchGames(v12_2026.games);
const handSplits2026 = aggregateHandGames(v9.games);

const seed = {
  schemaVersion: "courtedge-p0-v17-frozen-matchup-canonical-seed.v1",
  seedThroughDate: EXPECTED.seedThroughDate,
  supportedTargetDateGte: EXPECTED.supportedTargetDateGte,
  supportedTargetDateLte: EXPECTED.supportedTargetDateLte,
  supportRationale: "Exact V12 2025 rolling-window tail plus one cumulative 2026 seed remains algebraically exact through 2027-03-25; later targets fail closed before 2026-03-25 would need to expire from the cumulative seed.",
  sourceCustody: {
    v9_2026_YTD: { workflowRunId: EXPECTED.v9RunId, artifactId: EXPECTED.v9ArtifactId, artifactDigest: EXPECTED.v9Digest },
    v12_2025: { workflowRunId: EXPECTED.v12RunId, artifactId: EXPECTED.v12_2025ArtifactId, artifactDigest: EXPECTED.v12_2025Digest },
    v12_2026_YTD: { workflowRunId: EXPECTED.v12RunId, artifactId: EXPECTED.v12_2026ArtifactId, artifactDigest: EXPECTED.v12_2026Digest },
  },
  compressionContract: {
    pitcherColumns: ["pitcherId", "allPitches", "categorizedPitches", "FASTBALL", "BREAKING", "OFFSPEED"],
    teamPitchColumns: ["teamId", "pitchFamily", "swings", "whiffs", "contacts", "terminalPa", "tb", "hr"],
    teamHandColumns: ["teamId", "vsHand", "pa", "ab", "tb"],
  },
  pitchmix2025TailByDate,
  pitchmix2026CumulativeThroughSeed: [pitchmix2026.pitchers, pitchmix2026.teams],
  handSplits2026CumulativeThroughSeed: handSplits2026,
  policy: { priceIndependent: true, sameDateOutcomeLeakageAllowed: false, seedIsFrozenHistoricalAggregateOnly: true },
};

const raw = Buffer.from(JSON.stringify(seed));
const rawSha256 = createHash("sha256").update(raw).digest("hex");
const compressed = brotliCompressSync(raw, {
  params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
});
const base64 = compressed.toString("base64");
const generated = `// GENERATED by scripts/p0-v17-generate-matchup-seed.mjs. Do not hand edit.\n` +
  `export const MLB_FROZEN_MATCHUP_CANONICAL_SEED_RAW_SHA256 = ${JSON.stringify(rawSha256)} as const;\n` +
  `export const MLB_FROZEN_MATCHUP_CANONICAL_SEED_THROUGH_DATE = ${JSON.stringify(EXPECTED.seedThroughDate)} as const;\n` +
  `export const MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_GTE = ${JSON.stringify(EXPECTED.supportedTargetDateGte)} as const;\n` +
  `export const MLB_FROZEN_MATCHUP_CANONICAL_SEED_SUPPORTED_TARGET_DATE_LTE = ${JSON.stringify(EXPECTED.supportedTargetDateLte)} as const;\n` +
  `export const MLB_FROZEN_MATCHUP_CANONICAL_SEED_BROTLI_BASE64 = ${JSON.stringify(base64)} as const;\n`;
writeFileSync(outPath, generated);
console.log(JSON.stringify({
  ok: true,
  rawBytes: raw.length,
  compressedBytes: compressed.length,
  base64Bytes: base64.length,
  rawSha256,
  tailDates: pitchmix2025TailByDate.length,
  pitchmix2026Pitchers: pitchmix2026.pitchers.length,
  pitchmix2026TeamFamilies: pitchmix2026.teams.length,
  handSplit2026TeamHands: handSplits2026.length,
  outPath,
}, null, 2));
