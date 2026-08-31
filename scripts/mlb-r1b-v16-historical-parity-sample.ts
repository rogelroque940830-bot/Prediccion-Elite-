import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { C4_FEATURE_NAMES } from "../server/mlb-c4-live-feature-builder";
import { materializeR1bV16HistoricalTarget } from "../server/mlb-r1b-v16-historical-target-bridge";

const TABLE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1";
const LINEUP_SCHEMA = "courtedge-p0-step12m-cohort-pregame-lineups.v1";
const STARTER_SCHEMA = "courtedge-p0-step12v60-pregame-starter-hands.v1";
const REPORT_SCHEMA = "courtedge-mlb-r1b-v16-historical-parity-sample.v1";
const TOLERANCE = 1e-12;

type Json = Record<string, any>;

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`MLB_R1B_V16_SAMPLE_ARG_MISSING:${name}`);
}

function load(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sameIdentity(row: Json, lineup: Json, starter: Json): boolean {
  return Number(row.gamePk) === Number(lineup.gamePk)
    && Number(row.gamePk) === Number(starter.gamePk)
    && String(row.officialDate) === String(lineup.officialDate)
    && String(row.officialDate) === String(starter.officialDate)
    && Number(row.homeTeamId) === Number(lineup.homeTeamId)
    && Number(row.homeTeamId) === Number(starter.homeTeamId)
    && Number(row.awayTeamId) === Number(lineup.awayTeamId)
    && Number(row.awayTeamId) === Number(starter.awayTeamId)
    && String(lineup.requestedTimecode) === String(starter.requestedTimecode)
    && Number(row.t5HomeProbablePitcherId) === Number(starter.homePitcherId)
    && Number(row.t5AwayProbablePitcherId) === Number(starter.awayPitcherId);
}

function writeReport(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const season = arg("season");
  const root = arg("root", "artifacts/v16-sample");
  const out = arg("out", join(root, `v16-historical-parity-sample-${season}.json`));
  const year = season.slice(0, 4);
  if (!/^20\d{2}$/.test(year)) throw new Error(`MLB_R1B_V16_SAMPLE_SEASON_INVALID:${season}`);
  const minimumDate = `${year}-06-15`;

  const lineupPath = join(root, "step12v3", season, "cohort", "pregame-lineup-history.json");
  const tablePath = join(root, "step12v3", season, "game-anatomy-feature-table.json");
  const starterPath = join(root, "v60", `pregame-hands-${season}.json`);

  const lineupDoc = load(lineupPath);
  const tableDoc = load(tablePath);
  const starterDoc = load(starterPath);
  if (lineupDoc.schemaVersion !== LINEUP_SCHEMA) throw new Error("MLB_R1B_V16_SAMPLE_LINEUP_SCHEMA_INVALID");
  if (tableDoc.schemaVersion !== TABLE_SCHEMA) throw new Error("MLB_R1B_V16_SAMPLE_TABLE_SCHEMA_INVALID");
  if (starterDoc.schemaVersion !== STARTER_SCHEMA) throw new Error("MLB_R1B_V16_SAMPLE_STARTER_SCHEMA_INVALID");

  const lineupByPk = new Map<number, Json>((lineupDoc.snapshots ?? []).map((row: Json) => [Number(row.gamePk), row]));
  const starterByPk = new Map<number, Json>((starterDoc.snapshots ?? []).map((row: Json) => [Number(row.gamePk), row]));
  const candidates = (tableDoc.rows ?? [])
    .filter((row: Json) => String(row.officialDate) >= minimumDate)
    .filter((row: Json) => row.t5PregameValid === true && row.t5BothProbablesKnown === true && row.t5LineupComplete === true)
    .filter((row: Json) => C4_FEATURE_NAMES.every((name) => finite(row.features?.[name])))
    .filter((row: Json) => {
      const lineup = lineupByPk.get(Number(row.gamePk));
      const starter = starterByPk.get(Number(row.gamePk));
      return Boolean(lineup && starter
        && lineup.complete === true
        && lineup.availability === "COMPLETE"
        && starter.usable === true
        && starter.reason === null
        && sameIdentity(row, lineup, starter));
    })
    .sort((a: Json, b: Json) => String(a.officialDate).localeCompare(String(b.officialDate)) || Number(a.gamePk) - Number(b.gamePk));

  if (candidates.length === 0) throw new Error(`MLB_R1B_V16_SAMPLE_NO_ELIGIBLE_TARGET:${season}`);
  const row = candidates[0];
  const lineup = lineupByPk.get(Number(row.gamePk))!;
  const starter = starterByPk.get(Number(row.gamePk))!;
  const lineupArtifactSha256 = sha256(lineupPath);
  const starterArtifactSha256 = sha256(starterPath);

  const baseReport = {
    schemaVersion: REPORT_SCHEMA,
    season,
    minimumDate,
    candidateCount: candidates.length,
    target: {
      gamePk: Number(row.gamePk),
      officialDate: String(row.officialDate),
      homeTeamId: Number(row.homeTeamId),
      awayTeamId: Number(row.awayTeamId),
      requestedTimecode: String(lineup.requestedTimecode),
    },
    custody: {
      step12v3RunId: 31659518059,
      step12v3ArtifactId: 9166442982,
      step12v3ArtifactDigest: "sha256:6d834dfd699dbb9f1ee4b50a557b6613ac0791dff41fadbd5521e189c9fc5f26",
      lineupArtifactSha256,
      v60RunId: 31919873754,
      starterArtifactSha256,
    },
    policy: {
      targetIdentityFromFrozenT5Only: true,
      sameDateHistoryAllowed: false,
      marketPricesRead: false,
      targetOutcomeUsedAsFeature: false,
      modelRefit: false,
      newWeightsCreated: false,
      productionChanged: false,
    },
  };

  try {
    const materialized = await materializeR1bV16HistoricalTarget({
      frozen: {
        lineupArtifactSchema: LINEUP_SCHEMA,
        lineupArtifactSha256,
        starterArtifactSchema: STARTER_SCHEMA,
        starterArtifactSha256,
        lineup,
        starter,
      },
      fetchImpl: fetch,
      maxConcurrency: 18,
      timeoutMs: 20_000,
    });

    const tableVector = Object.fromEntries(C4_FEATURE_NAMES.map((name) => [name, Number(row.features[name])]));
    const bridgeVector = materialized.assessment.featureVector;
    const deltas = Object.fromEntries(C4_FEATURE_NAMES.map((name) => {
      const bridgeValue = bridgeVector[name];
      if (!finite(bridgeValue)) throw new Error(`MLB_R1B_V16_SAMPLE_BRIDGE_FEATURE_NONFINITE:${name}`);
      return [name, Math.abs(bridgeValue - tableVector[name])];
    }));
    const maxAbsDelta = Math.max(...Object.values(deltas) as number[]);
    const parity = maxAbsDelta <= TOLERANCE;

    const report = {
      ...baseReport,
      status: parity ? "PARITY" : "MISMATCH",
      tolerance: TOLERANCE,
      tableVector,
      bridgeVector,
      deltas,
      maxAbsDelta,
      diagnostics: materialized.assessment.diagnostics,
      baselineRows: materialized.rows,
      bridgeProvenance: materialized.provenance,
    };
    writeReport(out, report);
    console.log(JSON.stringify(report, null, 2));
    if (!parity) throw new Error(`MLB_R1B_V16_SAMPLE_PARITY_MISMATCH:${season}:${row.gamePk}:${maxAbsDelta}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!readFileSync) throw error;
    try {
      const existing = load(out);
      if (existing.status === "MISMATCH") throw error;
    } catch {
      writeReport(out, { ...baseReport, status: "ERROR", error: message });
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
