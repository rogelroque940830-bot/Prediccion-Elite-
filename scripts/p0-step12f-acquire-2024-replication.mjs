import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalStartingPitcherHistory } from "../server/mlb-market-starting-pitcher-history.ts";
import { fetchMlbHistoricalPregameLineups } from "../server/mlb-market-pregame-lineup-history.ts";

const FROZEN_START_DATE = "2024-03-01";
const FROZEN_END_DATE = "2024-09-30";
const FROZEN_LINEUP_CUTOFF_SECONDS = 300;
const COHORT_SCHEMA = "courtedge-p0-step12f-2024-replication-cohort.v1";

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
const outputRoot = arg("--out") ?? "artifacts/p0-step12f/cohort-2024-replication";
const concurrency = Number(arg("--concurrency") ?? 6);

if (startDate !== FROZEN_START_DATE || endDate !== FROZEN_END_DATE) {
  throw new Error(`STEP12F_REPLICATION_COHORT_DATE_MUTATION_FORBIDDEN:${startDate}:${endDate}`);
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) {
  throw new Error("STEP12F_INVALID_CONCURRENCY");
}

await fs.mkdir(outputRoot, { recursive: true });
const generatedAt = new Date().toISOString();

const official = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
const officialArtifact = await writeJson(path.join(outputRoot, "official-acquisition.json"), official);
if (official.failures.length > 0) throw new Error(`STEP12F_OFFICIAL_ACQUISITION_INCOMPLETE:${official.failures.length}`);
if (official.officialFinalGames <= 0) throw new Error("STEP12F_NO_OFFICIAL_FINAL_GAMES");

const dataset = buildMlbHistoricalDataset(official.games, { generatedAt });
const datasetArtifact = await writeJson(path.join(outputRoot, "dataset.json"), dataset);
if (dataset.regularSeasonFinalGames !== official.officialFinalGames) {
  throw new Error(`STEP12F_DATASET_GAME_COUNT_MISMATCH:${dataset.regularSeasonFinalGames}:${official.officialFinalGames}`);
}

const starter = await fetchMlbHistoricalStartingPitcherHistory({ startDate, endDate, concurrency });
const starterArtifact = await writeJson(path.join(outputRoot, "starting-pitcher-history.json"), starter);
if (starter.failures.length > 0) throw new Error(`STEP12F_STARTER_ACQUISITION_INCOMPLETE:${starter.failures.length}`);
if (starter.officialGamesReceived !== dataset.regularSeasonFinalGames || starter.gamesWithBothStarters !== dataset.regularSeasonFinalGames) {
  throw new Error(`STEP12F_STARTER_COVERAGE_INCOMPLETE:${starter.gamesWithBothStarters}:${dataset.regularSeasonFinalGames}`);
}

const lineupSource = await fetchMlbHistoricalPregameLineups({
  startDate,
  endDate,
  cutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
  concurrency,
});
const lineupSourceArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history-source.json"), lineupSource);
if (lineupSource.failures.length > 0) throw new Error(`STEP12F_LINEUP_ACQUISITION_INCOMPLETE:${lineupSource.failures.length}`);

const officialGamePks = sortedGamePks(official.games.map((game) => game.gamePk));
const officialGamePkSet = new Set(officialGamePks);
const starterGamePks = sortedGamePks(starter.games.map((game) => game.gamePk));
const cohortSnapshots = lineupSource.snapshots
  .filter((snapshot) => officialGamePkSet.has(Number(snapshot.gamePk)))
  .sort((a, b) => String(a.officialDate).localeCompare(String(b.officialDate)) || Number(a.gamePk) - Number(b.gamePk));
const excludedSnapshots = lineupSource.snapshots
  .filter((snapshot) => !officialGamePkSet.has(Number(snapshot.gamePk)))
  .map((snapshot) => ({ gamePk: Number(snapshot.gamePk), officialDate: snapshot.officialDate, scheduledStart: snapshot.scheduledStart ?? null }));
const lineupGamePks = sortedGamePks(cohortSnapshots.map((snapshot) => snapshot.gamePk));
if (JSON.stringify(officialGamePks) !== JSON.stringify(starterGamePks)) throw new Error("STEP12F_STARTER_GAME_IDENTITY_MISMATCH");
if (JSON.stringify(officialGamePks) !== JSON.stringify(lineupGamePks)) throw new Error("STEP12F_LINEUP_GAME_IDENTITY_MISMATCH");

const completeLineupGamePks = sortedGamePks(cohortSnapshots.filter((snapshot) => snapshot.complete).map((snapshot) => snapshot.gamePk));
const lineupCohort = {
  schemaVersion: "courtedge-p0-step12f-cohort-pregame-lineups.v1",
  cohortDefinition: "OFFICIAL_FINAL_GAME_PK_INTERSECTION",
  startDate: FROZEN_START_DATE,
  endDate: FROZEN_END_DATE,
  cutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
  officialFinalGames: officialGamePks.length,
  snapshotsFetched: cohortSnapshots.length,
  completeLineupGames: completeLineupGamePks.length,
  completeLineupCoveragePct: officialGamePks.length ? 100 * completeLineupGamePks.length / officialGamePks.length : 0,
  snapshots: cohortSnapshots,
  upstreamSchedule: {
    scheduleGames: lineupSource.scheduleGames,
    snapshotsFetched: lineupSource.snapshotsFetched,
    excludedSnapshots,
  },
};
const lineupArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history.json"), lineupCohort);

const manifest = {
  schemaVersion: COHORT_SCHEMA,
  generatedAt,
  temporalRole: "UNTOUCHED_SECONDARY_SEASON_REPLICATION",
  frozenRange: { startDate: FROZEN_START_DATE, endDate: FROZEN_END_DATE },
  cohort: {
    regularSeasonFinalGames: dataset.regularSeasonFinalGames,
    observationsByHorizon: dataset.observationsByHorizon,
    starterGames: starter.gamesWithBothStarters,
    lineupSnapshotsFetched: lineupCohort.snapshotsFetched,
    completeLineupGames: lineupCohort.completeLineupGames,
    completeLineupCoveragePct: lineupCohort.completeLineupCoveragePct,
    excludedNonCohortLineupScheduleSnapshots: excludedSnapshots.length,
    officialGamePksDigest: sha256(JSON.stringify(officialGamePks)),
    starterGamePksDigest: sha256(JSON.stringify(starterGamePks)),
    lineupGamePksDigest: sha256(JSON.stringify(lineupGamePks)),
  },
  provenance: {
    outcomeSourceVersion: official.sourceVersion,
    outcomeDigest: dataset.outcomeDigest,
    outcomeSourceProvenanceDigest: dataset.sourceProvenanceDigest,
    starterSource: starter.source,
    starterHistoryDigest: starter.starterHistoryDigest,
    starterBoxscoreProvenanceDigest: starter.boxscoreProvenanceDigest,
    lineupSourceVersion: lineupSource.sourceVersion,
    lineupHistoryDigest: lineupSource.lineupHistoryDigest,
    lineupSourceProvenanceDigest: lineupSource.sourceProvenanceDigest,
  },
  artifacts: [officialArtifact, datasetArtifact, starterArtifact, lineupSourceArtifact, lineupArtifact],
  policy: {
    usedFor2025CandidateDiscovery: false,
    usedFor2026LeaderSelection: false,
    inspectedBeforeLeaderAndCriteriaFreeze: false,
    thresholdTuningAllowed: false,
    atomMutationAllowed: false,
    leaderReplacementAllowed: false,
    historicalPricesUsed: false,
    historicalEvClaimAllowed: false,
    livePickFiltersChanged: false,
    step11cCapturePopulationChanged: false,
    betEliteLabelProduced: false,
    automaticBetPlacement: false,
    lineupScheduleExtrasAreExcludedByOfficialFinalGamePk: true,
    officialFinalLineupSnapshotCoverageMustBeComplete: true,
  },
};
const manifestArtifact = await writeJson(path.join(outputRoot, "cohort-manifest.json"), manifest);

console.log(JSON.stringify({
  ok: true,
  range: manifest.frozenRange,
  games: manifest.cohort.regularSeasonFinalGames,
  lineupSnapshotsFetched: manifest.cohort.lineupSnapshotsFetched,
  excludedNonCohortLineupScheduleSnapshots: manifest.cohort.excludedNonCohortLineupScheduleSnapshots,
  completeLineupGames: manifest.cohort.completeLineupGames,
  completeLineupCoveragePct: manifest.cohort.completeLineupCoveragePct,
  outcomeDigest: manifest.provenance.outcomeDigest,
  starterHistoryDigest: manifest.provenance.starterHistoryDigest,
  manifestArtifact,
  researchOnly: true,
}, null, 2));