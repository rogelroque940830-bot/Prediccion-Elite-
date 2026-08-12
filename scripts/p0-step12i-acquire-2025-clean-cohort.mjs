import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalStartingPitcherHistory } from "../server/mlb-market-starting-pitcher-history.ts";
import { fetchMlbHistoricalPregameLineups } from "../server/mlb-market-pregame-lineup-history.ts";

const FROZEN_START_DATE = "2025-03-01";
const FROZEN_END_DATE = "2025-10-01";
const FROZEN_LINEUP_CUTOFF_SECONDS = 300;
const COHORT_SCHEMA = "courtedge-p0-step12i-2025-clean-cohort.v1";
const COHORT_LINEUP_SCHEMA = "courtedge-p0-step12i-cohort-pregame-lineups.v1";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(file, text, "utf8");
  return { file: path.basename(file), sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

function sortedGamePks(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

const startDate = arg("--start") ?? FROZEN_START_DATE;
const endDate = arg("--end") ?? FROZEN_END_DATE;
const outputRoot = arg("--out") ?? "artifacts/p0-step12i/cohort-2025-clean";
const concurrency = Number(arg("--concurrency") ?? 6);
if (startDate !== FROZEN_START_DATE || endDate !== FROZEN_END_DATE) {
  throw new Error(`STEP12I_COHORT_DATE_MUTATION_FORBIDDEN:${startDate}:${endDate}`);
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
  throw new Error("STEP12I_INVALID_CONCURRENCY");
}

await fs.mkdir(outputRoot, { recursive: true });
const generatedAt = new Date().toISOString();

const official = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
if (official.failures.length > 0) throw new Error(`STEP12I_OFFICIAL_ACQUISITION_INCOMPLETE:${official.failures.length}`);
const officialArtifact = await writeJson(path.join(outputRoot, "official-acquisition.json"), official);

const dataset = buildMlbHistoricalDataset(official.games, { generatedAt });
if (dataset.regularSeasonFinalGames !== official.officialFinalGames) {
  throw new Error(`STEP12I_DATASET_GAME_COUNT_MISMATCH:${dataset.regularSeasonFinalGames}:${official.officialFinalGames}`);
}
const datasetArtifact = await writeJson(path.join(outputRoot, "dataset.json"), dataset);

const starter = await fetchMlbHistoricalStartingPitcherHistory({ startDate, endDate, concurrency });
if (starter.failures.length > 0) throw new Error(`STEP12I_STARTER_ACQUISITION_INCOMPLETE:${starter.failures.length}`);
if (starter.gamesWithBothStarters !== dataset.regularSeasonFinalGames) {
  throw new Error(`STEP12I_STARTER_COVERAGE_INCOMPLETE:${starter.gamesWithBothStarters}:${dataset.regularSeasonFinalGames}`);
}
const starterArtifact = await writeJson(path.join(outputRoot, "starting-pitcher-history.json"), starter);

const lineupSource = await fetchMlbHistoricalPregameLineups({
  startDate,
  endDate,
  cutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
  concurrency,
});
if (lineupSource.failures.length > 0) throw new Error(`STEP12I_LINEUP_ACQUISITION_INCOMPLETE:${lineupSource.failures.length}`);
const lineupSourceArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history-source.json"), lineupSource);

const officialGamePks = sortedGamePks(official.games.map((game) => game.gamePk));
const starterGamePks = sortedGamePks(starter.games.map((game) => game.gamePk));
if (JSON.stringify(officialGamePks) !== JSON.stringify(starterGamePks)) {
  throw new Error("STEP12I_STARTER_GAME_IDENTITY_MISMATCH");
}
const officialSet = new Set(officialGamePks);
const snapshotByGamePk = new Map();
for (const snapshot of lineupSource.snapshots) {
  if (snapshotByGamePk.has(snapshot.gamePk)) throw new Error(`STEP12I_DUPLICATE_LINEUP_GAME:${snapshot.gamePk}`);
  snapshotByGamePk.set(snapshot.gamePk, snapshot);
}
const missing = officialGamePks.filter((gamePk) => !snapshotByGamePk.has(gamePk));
if (missing.length) throw new Error(`STEP12I_OFFICIAL_LINEUP_SNAPSHOT_MISSING:${missing.join(",")}`);
const cohortSnapshots = officialGamePks.map((gamePk) => snapshotByGamePk.get(gamePk));
const excludedSnapshots = lineupSource.snapshots.filter((snapshot) => !officialSet.has(snapshot.gamePk));
const completeLineupGamePks = sortedGamePks(cohortSnapshots.filter((snapshot) => snapshot.complete).map((snapshot) => snapshot.gamePk));
const lineupCohort = {
  schemaVersion: COHORT_LINEUP_SCHEMA,
  sourceVersion: lineupSource.sourceVersion,
  generatedAt,
  startDate,
  endDate,
  cutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
  cohortDefinition: "OFFICIAL_FINAL_GAME_PK_INTERSECTION",
  officialFinalGames: officialGamePks.length,
  snapshotsFetched: cohortSnapshots.length,
  completeLineupGames: completeLineupGamePks.length,
  completeLineupCoveragePct: officialGamePks.length ? 100 * completeLineupGamePks.length / officialGamePks.length : 0,
  snapshots: cohortSnapshots,
  upstreamSchedule: {
    scheduleGames: lineupSource.scheduleGames,
    snapshotsFetched: lineupSource.snapshotsFetched,
    excludedNonCohortSnapshots: excludedSnapshots.length,
  },
  researchOnly: true,
};
const lineupArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history.json"), lineupCohort);

const lineupGamePks = sortedGamePks(cohortSnapshots.map((snapshot) => snapshot.gamePk));
if (JSON.stringify(officialGamePks) !== JSON.stringify(lineupGamePks)) {
  throw new Error("STEP12I_LINEUP_GAME_IDENTITY_MISMATCH");
}

const manifest = {
  schemaVersion: COHORT_SCHEMA,
  generatedAt,
  temporalRole: "DEVELOPMENT_COHORT_CLEAN_T5_REBUILD",
  frozenRange: { startDate, endDate },
  cohort: {
    regularSeasonFinalGames: dataset.regularSeasonFinalGames,
    starterGames: starter.gamesWithBothStarters,
    lineupSnapshotsFetched: cohortSnapshots.length,
    completeLineupGames: completeLineupGamePks.length,
    completeLineupCoveragePct: lineupCohort.completeLineupCoveragePct,
    excludedNonCohortLineupScheduleSnapshots: excludedSnapshots.length,
    officialGamePksDigest: sha256(JSON.stringify(officialGamePks)),
    starterGamePksDigest: sha256(JSON.stringify(starterGamePks)),
    lineupGamePksDigest: sha256(JSON.stringify(lineupGamePks)),
  },
  provenance: {
    outcomeSourceVersion: official.sourceVersion,
    outcomeDigest: dataset.outcomeDigest,
    starterSource: starter.source,
    starterHistoryDigest: starter.starterHistoryDigest,
    lineupSourceVersion: lineupSource.sourceVersion,
    lineupHistoryDigest: lineupSource.lineupHistoryDigest,
  },
  artifacts: [officialArtifact, datasetArtifact, starterArtifact, lineupSourceArtifact, lineupArtifact],
  policy: {
    developmentOnly: true,
    thresholdSearchAllowedInAcquisition: false,
    candidateSearchAllowedInAcquisition: false,
    historicalPricesUsed: false,
    historicalEvClaimAllowed: false,
    livePickFiltersChanged: false,
    step11cCapturePopulationChanged: false,
    betEliteLabelProduced: false,
    automaticBetPlacement: false,
  },
};
const manifestArtifact = await writeJson(path.join(outputRoot, "cohort-manifest.json"), manifest);

console.log(JSON.stringify({
  ok: true,
  games: dataset.regularSeasonFinalGames,
  completeLineupGames: completeLineupGamePks.length,
  completeLineupCoveragePct: lineupCohort.completeLineupCoveragePct,
  manifestArtifact,
  researchOnly: true,
}, null, 2));
