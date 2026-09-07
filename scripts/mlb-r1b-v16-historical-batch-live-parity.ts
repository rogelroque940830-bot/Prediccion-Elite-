import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { materializeR1bV16HistoricalBatch } from "../server/mlb-r1b-v16-historical-batch-materializer";
import { materializeR1bV16HistoricalTarget } from "../server/mlb-r1b-v16-historical-target-bridge";

const TABLE_SCHEMA = "courtedge-p0-step12v-game-anatomy-feature-table.v1";
const LINEUP_SCHEMA = "courtedge-p0-step12m-cohort-pregame-lineups.v1";
const STARTER_SCHEMA = "courtedge-p0-step12v60-pregame-starter-hands.v1";
const REPORT_SCHEMA = "courtedge-mlb-r1b-v16-historical-batch-live-parity.v1";
const TOLERANCE = 1e-12;

type Json = Record<string, any>;

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`MLB_R1B_V16_BATCH_LIVE_ARG_MISSING:${name}`);
}

function load(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function rowKey(row: any): string {
  return `${row.side}:${row.market}:${row.horizon}`;
}

async function main(): Promise<void> {
  const seasonLabel = arg("season");
  const root = arg("root", "artifacts/v16-batch-live");
  const out = arg("out", join(root, `report-${seasonLabel}.json`));
  const year = Number(seasonLabel.slice(0, 4));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`MLB_R1B_V16_BATCH_LIVE_SEASON_INVALID:${seasonLabel}`);
  }
  const minimumDate = `${year}-06-15`;

  const lineupPath = join(root, "step12v3", seasonLabel, "cohort", "pregame-lineup-history.json");
  const tablePath = join(root, "step12v3", seasonLabel, "game-anatomy-feature-table.json");
  const starterPath = join(root, "v60", `pregame-hands-${seasonLabel}.json`);
  const lineupDoc = load(lineupPath);
  const tableDoc = load(tablePath);
  const starterDoc = load(starterPath);
  if (lineupDoc.schemaVersion !== LINEUP_SCHEMA) throw new Error("MLB_R1B_V16_BATCH_LIVE_LINEUP_SCHEMA_INVALID");
  if (tableDoc.schemaVersion !== TABLE_SCHEMA) throw new Error("MLB_R1B_V16_BATCH_LIVE_TABLE_SCHEMA_INVALID");
  if (starterDoc.schemaVersion !== STARTER_SCHEMA) throw new Error("MLB_R1B_V16_BATCH_LIVE_STARTER_SCHEMA_INVALID");

  const lineupByPk = new Map<number, Json>((lineupDoc.snapshots ?? []).map((row: Json) => [Number(row.gamePk), row]));
  const starterByPk = new Map<number, Json>((starterDoc.snapshots ?? []).map((row: Json) => [Number(row.gamePk), row]));
  const candidates = (tableDoc.rows ?? [])
    .filter((row: Json) => String(row.officialDate) >= minimumDate)
    .filter((row: Json) => row.t5PregameValid === true && row.t5BothProbablesKnown === true && row.t5LineupComplete === true)
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
  if (candidates.length === 0) throw new Error(`MLB_R1B_V16_BATCH_LIVE_NO_TARGET:${seasonLabel}`);

  const identity = candidates[0];
  const lineup = lineupByPk.get(Number(identity.gamePk))!;
  const starter = starterByPk.get(Number(identity.gamePk))!;
  const frozen = {
    lineupArtifactSchema: LINEUP_SCHEMA as const,
    lineupArtifactSha256: sha256(lineupPath),
    starterArtifactSchema: STARTER_SCHEMA as const,
    starterArtifactSha256: sha256(starterPath),
    lineup,
    starter,
  };

  const batchFetchCounts = new Map<string, number>();
  const countedFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    batchFetchCounts.set(input, (batchFetchCounts.get(input) ?? 0) + 1);
    return fetch(input, init);
  };
  const batch = await materializeR1bV16HistoricalBatch({
    season: year,
    targets: [frozen],
    fetchImpl: countedFetch,
    maxConcurrency: 18,
    timeoutMs: 20_000,
  });
  const bridge = await materializeR1bV16HistoricalTarget({
    frozen,
    fetchImpl: fetch,
    maxConcurrency: 18,
    timeoutMs: 20_000,
  });

  const batchTarget = batch.targets[0];
  const featureDeltas = Object.fromEntries(Object.keys(batchTarget.assessment.featureVector).map((name) => {
    const left = Number((batchTarget.assessment.featureVector as any)[name]);
    const right = Number((bridge.assessment.featureVector as any)[name]);
    return [name, Math.abs(left - right)];
  }));
  const bridgeRows = new Map(bridge.rows.map((row) => [rowKey(row), row]));
  const probabilityDeltas = Object.fromEntries(batchTarget.rows.map((row) => {
    const other = bridgeRows.get(rowKey(row));
    if (!other) throw new Error(`MLB_R1B_V16_BATCH_LIVE_BRIDGE_ROW_MISSING:${rowKey(row)}`);
    return [rowKey(row), Math.max(Math.abs(row.probability - other.probability), Math.abs(row.pushProbability - other.pushProbability))];
  }));
  const maxFeatureDelta = Math.max(...Object.values(featureDeltas) as number[]);
  const maxProbabilityDelta = Math.max(...Object.values(probabilityDeltas) as number[]);

  const scheduleUrls = [...batchFetchCounts.keys()].filter((url) => new URL(url).pathname.endsWith("/v1/schedule"));
  const feedEntries = [...batchFetchCounts.entries()].filter(([url]) => /\/v1\.1\/game\/\d+\/feed\/live$/.test(new URL(url).pathname));
  const duplicatePriorFeedFetches = feedEntries.filter(([, count]) => count !== 1).map(([url, count]) => ({ url, count }));
  const targetFeedExternallyRead = feedEntries.some(([url]) => url.includes(`/game/${identity.gamePk}/feed/live`));
  const parity = maxFeatureDelta <= TOLERANCE
    && maxProbabilityDelta <= TOLERANCE
    && scheduleUrls.length === 1
    && duplicatePriorFeedFetches.length === 0
    && targetFeedExternallyRead === false;

  const report = {
    schemaVersion: REPORT_SCHEMA,
    season: seasonLabel,
    candidateCount: candidates.length,
    target: {
      gamePk: Number(identity.gamePk),
      officialDate: String(identity.officialDate),
      homeTeamId: Number(identity.homeTeamId),
      awayTeamId: Number(identity.awayTeamId),
      requestedTimecode: String(lineup.requestedTimecode),
    },
    status: parity ? "PARITY" : "MISMATCH",
    tolerance: TOLERANCE,
    maxFeatureDelta,
    maxProbabilityDelta,
    featureDeltas,
    probabilityDeltas,
    batchSource: batch.source,
    batchFetchAudit: {
      scheduleFetchCount: scheduleUrls.length,
      priorFeedUrlCount: feedEntries.length,
      duplicatePriorFeedFetches,
      targetFeedExternallyRead,
    },
    batchVector: batchTarget.assessment.featureVector,
    bridgeVector: bridge.assessment.featureVector,
    batchRows: batchTarget.rows,
    bridgeRows: bridge.rows,
    policy: {
      targetIdentityFromFrozenT5Only: true,
      sameDateHistoryAllowed: false,
      targetOutcomeUsedAsFeature: false,
      marketPricesRead: false,
      modelRefit: false,
      newWeightsCreated: false,
      productionChanged: false,
    },
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
  if (!parity) {
    throw new Error(`MLB_R1B_V16_BATCH_LIVE_PARITY_MISMATCH:${seasonLabel}:${identity.gamePk}:${maxFeatureDelta}:${maxProbabilityDelta}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
