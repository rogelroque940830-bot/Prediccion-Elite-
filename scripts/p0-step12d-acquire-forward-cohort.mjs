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

const lineup = await fetchMlbHistoricalPregameLineups({
  startDate,
  endDate,
  cutoffSecondsBeforeScheduledStart: FROZEN_LINEUP_CUTOFF_SECONDS,
  concurrency,
});
const lineupArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history.json"), lineup);
if (lineup.failures.length > 0) throw new Error(`STEP12D_LINEUP_ACQUISITION_INCOMPLETE:${lineup.failures.length}`);
if (lineup.scheduleGames !== dataset.regularSeasonFinalGames || lineup.snapshotsFetched !== dataset.regularSeasonFinalGames) {
  throw new Error(`STEP12D_LINEUP_COHORT_COUNT_MISMATCH:${lineup.scheduleGames}:${lineup.snapshotsFetched}:${dataset.regularSeasonFinalGames}`);
}

const officialGamePks = sortedGamePks(official.games.map((game) => game.gamePk));
const starterGamePks = sortedGamePks(starter.games.map((game) => game.gamePk));
const lineupGamePks = sortedGamePks(lineup.snapshots.map((snapshot) => snapshot.gamePk));
const completeLineupGamePks = sortedGamePks(lineup.snapshots.filter((snapshot) => snapshot.complete).map((snapshot) => snapshot.gamePk));
if (JSON.stringify(officialGamePks) !== JSON.stringify(starterGamePks) || JSON.stringify(officialGamePks) !== JSON.stringify(lineupGamePks)) {
  throw new Error("STEP12D_COHORT_GAME_IDENTITY_MISMATCH");
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
    lineupSnapshotsFetched: lineup.snapshotsFetched,
    completeLineupGames: lineup.completeLineupGames,
    completeLineupCoveragePct: dataset.regularSeasonFinalGames > 0 ? 100 * lineup.completeLineupGames / dataset.regularSeasonFinalGames : 0,
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
    lineupSourceVersion: lineup.sourceVersion,
    lineupHistoryDigest: lineup.lineupHistoryDigest,
    lineupSourceProvenanceDigest: lineup.sourceProvenanceDigest,
  },
  artifacts: [officialArtifact, datasetArtifact, starterArtifact, lineupArtifact],
  policy: {
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
  completeLineupGames: manifest.cohort.completeLineupGames,
  completeLineupCoveragePct: manifest.cohort.completeLineupCoveragePct,
  outcomeDigest: manifest.provenance.outcomeDigest,
  starterHistoryDigest: manifest.provenance.starterHistoryDigest,
  lineupHistoryDigest: manifest.provenance.lineupHistoryDigest,
  manifestArtifact,
  researchOnly: true,
}, null, 2));
