import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalStartingPitcherHistory } from "../server/mlb-market-starting-pitcher-history.ts";
import { fetchMlbHistoricalPregameLineups } from "../server/mlb-market-pregame-lineup-history.ts";

const FROZEN_START_DATE = "2026-03-01";
const FROZEN_END_DATE = "2026-08-10";
const FROZEN_LINEUP_CUTOFF_SECONDS = 300;
const COHORT_SCHEMA = "courtedge-p0-step12d-forward-cohort.v1";
const COHORT_LINEUP_SCHEMA = "courtedge-p0-step12d-cohort-pregame-lineups.v1";

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

function countAvailability(snapshots, availabilityKeys) {
  const counts = Object.fromEntries(availabilityKeys.map((key) => [key, 0]));
  for (const snapshot of snapshots) {
    const key = String(snapshot.availability ?? "");
    if (!(key in counts)) counts[key] = 0;
    counts[key] += 1;
  }
  return counts;
}

const startDate = arg("--start") ?? FROZEN_START_DATE;
const endDate = arg("--end") ?? FROZEN_END_DATE;
const outputRoot = arg("--out") ?? "artifacts/p0-step12d/cohort-2026-forward";
const concurrency = Number(arg("--concurrency") ?? 6);

if (startDate !== FROZEN_START_DATE || endDate !== FROZEN_END_DATE) {
  throw new Error(`STEP12D_FORWARD_COHORT_DATE_MUTATION_FORBIDDEN:${startDate}:${endDate}`);
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw new Error("STEP12D_INVALID_CONCURRENCY");

await fs.mkdir(outputRoot, { recursive: true });
const generatedAt = new Date().toISOString();

const official = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
const officialArtifact = await writeJson(path.join(outputRoot, "official-acquisition.json"), official);
if (official.failures.length > 0) throw new Error(`STEP12D_OFFICIAL_ACQUISITION_INCOMPLETE:${official.failures.length}`);
if (official.officialFinalGames <= 0) throw new Error("STEP12D_NO_OFFICIAL_FINAL_GAMES");

const dataset = buildMlbHistoricalDataset(official.games, { generatedAt });
const datasetArtifact = await writeJson(path.join(outputRoot, "dataset.json"), dataset);
if (dataset.regularSeasonFinalGames !== official.officialFinalGames) {
  throw new Error(`STEP12D_DATASET_GAME_COUNT_MISMATCH:${dataset.regularSeasonFinalGames}:${official.officialFinalGames}`);
}

const starter = await fetchMlbHistoricalStartingPitcherHistory({ startDate, endDate, concurrency });
const starterArtifact = await writeJson(path.join(outputRoot, "starting-pitcher-history.json"), starter);
if (starter.failures.length > 0) throw new Error(`STEP12D_STARTER_ACQUISITION_INCOMPLETE:${starter.failures.length}`);
if (starter.officialGamesReceived !== dataset.regularSeasonFinalGames || starter.gamesWithBothStarters !== dataset.regularSeasonFinalGames) {
  throw new Error(`STEP12D_STARTER_COVERAGE_INCOMPLETE:${starter.gamesWithBothStarters}:${dataset.regularSeasonFinalGames}`);
}

const lineupSource = await fetchMlbHistoricalPregameLineups({
  startDate,
  endDate,
  cutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
  concurrency,
});
const lineupSourceArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history-source.json"), lineupSource);
if (lineupSource.failures.length > 0) throw new Error(`STEP12D_LINEUP_ACQUISITION_INCOMPLETE:${lineupSource.failures.length}`);

const officialGamePks = sortedGamePks(official.games.map((game) => game.gamePk));
const starterGamePks = sortedGamePks(starter.games.map((game) => game.gamePk));
if (JSON.stringify(officialGamePks) !== JSON.stringify(starterGamePks)) {
  throw new Error("STEP12D_STARTER_GAME_IDENTITY_MISMATCH");
}

const officialGamePkSet = new Set(officialGamePks);
const lineupByGamePk = new Map();
for (const snapshot of lineupSource.snapshots) {
  if (lineupByGamePk.has(snapshot.gamePk)) throw new Error(`STEP12D_DUPLICATE_LINEUP_GAME_PK:${snapshot.gamePk}`);
  lineupByGamePk.set(snapshot.gamePk, snapshot);
}
const missingOfficialLineupGamePks = officialGamePks.filter((gamePk) => !lineupByGamePk.has(gamePk));
if (missingOfficialLineupGamePks.length > 0) {
  throw new Error(`STEP12D_OFFICIAL_LINEUP_SNAPSHOTS_MISSING:${missingOfficialLineupGamePks.join(",")}`);
}

const cohortLineupSnapshots = officialGamePks.map((gamePk) => lineupByGamePk.get(gamePk));
const excludedScheduleSnapshots = lineupSource.snapshots
  .filter((snapshot) => !officialGamePkSet.has(snapshot.gamePk))
  .map((snapshot) => ({
    gamePk: snapshot.gamePk,
    officialDate: snapshot.officialDate,
    scheduledStart: snapshot.scheduledStart,
    availability: snapshot.availability,
    complete: snapshot.complete,
    scheduleResolution: snapshot.scheduleResolution,
  }))
  .sort((a, b) => a.officialDate.localeCompare(b.officialDate) || a.gamePk - b.gamePk);
const availabilityKeys = Object.keys(lineupSource.availabilityCounts ?? {}).sort();
const cohortAvailabilityCounts = countAvailability(cohortLineupSnapshots, availabilityKeys);
const completeLineupGamePks = sortedGamePks(cohortLineupSnapshots.filter((snapshot) => snapshot.complete).map((snapshot) => snapshot.gamePk));
const cohortLineup = {
  schemaVersion: COHORT_LINEUP_SCHEMA,
  sourceVersion: lineupSource.sourceVersion,
  generatedAt,
  startDate: FROZEN_START_DATE,
  endDate: FROZEN_END_DATE,
  cutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
  cohortDefinition: "OFFICIAL_FINAL_GAME_PK_INTERSECTION",
  officialFinalGames: officialGamePks.length,
  snapshotsFetched: cohortLineupSnapshots.length,
  completeLineupGames: completeLineupGamePks.length,
  availabilityCounts: cohortAvailabilityCounts,
  snapshots: cohortLineupSnapshots,
  upstreamSchedule: {
    scheduleGames: lineupSource.scheduleGames,
    snapshotsFetched: lineupSource.snapshotsFetched,
    excludedNonCohortSnapshots: excludedScheduleSnapshots.length,
    excludedSnapshots: excludedScheduleSnapshots,
    lineupHistoryDigest: lineupSource.lineupHistoryDigest,
    sourceProvenanceDigest: lineupSource.sourceProvenanceDigest,
  },
  researchOnly: true,
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
};
const lineupArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history.json"), cohortLineup);

const lineupGamePks = sortedGamePks(cohortLineup.snapshots.map((snapshot) => snapshot.gamePk));
if (JSON.stringify(officialGamePks) !== JSON.stringify(lineupGamePks)) {
  throw new Error("STEP12D_LINEUP_GAME_IDENTITY_MISMATCH");
}

const manifest = {
  schemaVersion: COHORT_SCHEMA,
  generatedAt,
  temporalRole: "CHRONOLOGICALLY_FORWARD_UNTOUCHED_REPLICATION",
  frozenRange: { startDate: FROZEN_START_DATE, endDate: FROZEN_END_DATE },
  cutoffPolicy: {
    currentDayExcluded: true,
    latestIncludedOfficialDate: FROZEN_END_DATE,
    lineupCutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
    rangeMutationAllowed: false,
  },
  cohort: {
    regularSeasonFinalGames: dataset.regularSeasonFinalGames,
    observationsByHorizon: dataset.observationsByHorizon,
    starterGames: starter.gamesWithBothStarters,
    lineupSnapshotsFetched: cohortLineup.snapshotsFetched,
    completeLineupGames: cohortLineup.completeLineupGames,
    completeLineupCoveragePct: dataset.regularSeasonFinalGames > 0 ? 100 * cohortLineup.completeLineupGames / dataset.regularSeasonFinalGames : 0,
    excludedNonCohortLineupScheduleSnapshots: excludedScheduleSnapshots.length,
    officialGamePksDigest: sha256(JSON.stringify(officialGamePks)),
    starterGamePksDigest: sha256(JSON.stringify(starterGamePks)),
    lineupGamePksDigest: sha256(JSON.stringify(lineupGamePks)),
    completeLineupGamePksDigest: sha256(JSON.stringify(completeLineupGamePks)),
  },
  provenance: {
    outcomeSourceVersion: official.sourceVersion,
    outcomeDigest: dataset.outcomeDigest,
    outcomeSourceProvenanceDigest: dataset.sourceProvenanceDigest,
    starterSource: starter.source,
    starterHistoryDigest: starter.starterHistoryDigest,
    starterBoxscoreProvenanceDigest: starter.boxscoreProvenanceDigest,
    lineupSourceVersion: lineupSource.sourceVersion,
    lineupUpstreamScheduleHistoryDigest: lineupSource.lineupHistoryDigest,
    lineupUpstreamSourceProvenanceDigest: lineupSource.sourceProvenanceDigest,
    cohortLineupArtifactSha256: lineupArtifact.sha256,
  },
  artifacts: [officialArtifact, datasetArtifact, starterArtifact, lineupSourceArtifact, lineupArtifact],
  policy: {
    lineupScheduleExtrasAreExcludedByOfficialFinalGamePk: true,
    officialFinalLineupSnapshotCoverageMustBeComplete: true,
    usedFor2025CandidateDiscovery: false,
    externalThresholdTuningAllowed: false,
    candidateMutationAllowed: false,
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
  range: manifest.frozenRange,
  games: manifest.cohort.regularSeasonFinalGames,
  lineupSnapshotsFetched: manifest.cohort.lineupSnapshotsFetched,
  excludedNonCohortLineupScheduleSnapshots: manifest.cohort.excludedNonCohortLineupScheduleSnapshots,
  completeLineupGames: manifest.cohort.completeLineupGames,
  completeLineupCoveragePct: manifest.cohort.completeLineupCoveragePct,
  outcomeDigest: manifest.provenance.outcomeDigest,
  starterHistoryDigest: manifest.provenance.starterHistoryDigest,
  cohortLineupArtifactSha256: manifest.provenance.cohortLineupArtifactSha256,
  manifestArtifact,
  researchOnly: true,
}, null, 2));
