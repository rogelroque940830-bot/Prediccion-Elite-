import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchMlbHistoricalOfficialGames } from "../server/mlb-market-historical-source.ts";
import { buildMlbHistoricalDataset } from "../server/mlb-market-historical-dataset.ts";
import { fetchMlbHistoricalPregameLineups } from "../server/mlb-market-pregame-lineup-history.ts";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? ""));
}

async function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(file, text, "utf8");
  return { file: path.basename(file), sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

function sortedGamePks(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function diffGamePks(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((gamePk) => !actualSet.has(gamePk)),
    extra: actual.filter((gamePk) => !expectedSet.has(gamePk)),
  };
}

const baselinePath = arg("--baseline") ?? "evidence/p1-m6a3b1/2025-official-baseline.json";
const outputRoot = arg("--out") ?? "artifacts/p1-m6a3b2c1-2025-pregame-lineup-coverage";
const cutoffSeconds = Number(arg("--cutoff-seconds") ?? 300);
const concurrency = Number(arg("--concurrency") ?? 4);
const baselineEvidence = JSON.parse(await fs.readFile(baselinePath, "utf8"));
const startDate = arg("--start") ?? baselineEvidence?.source?.startDate;
const endDate = arg("--end") ?? baselineEvidence?.source?.endDate;
const expectedGames = Number(baselineEvidence?.integrity?.regularSeasonFinalGames);
const expectedOutcomeDigest = baselineEvidence?.integrity?.outcomeDigest;
const generatedAt = new Date().toISOString();

if (
  startDate !== baselineEvidence?.source?.startDate
  || endDate !== baselineEvidence?.source?.endDate
  || expectedGames !== 2430
  || !isSha256(expectedOutcomeDigest)
  || !Number.isInteger(cutoffSeconds) || cutoffSeconds !== 300
) {
  throw new Error("P1_M6A3B2C1_FROZEN_BASELINE_CONTRACT_INVALID");
}

await fs.mkdir(outputRoot, { recursive: true });

const official = await fetchMlbHistoricalOfficialGames({ startDate, endDate, concurrency });
if (official.failures.length > 0) {
  throw new Error(`P1_M6A3B2C1_B1_REPRODUCTION_ACQUISITION_FAILED:${official.failures.length}`);
}
if (official.officialFinalGames !== expectedGames) {
  throw new Error(`P1_M6A3B2C1_B1_REPRODUCTION_GAME_COUNT_MISMATCH:${official.officialFinalGames}`);
}
const dataset = buildMlbHistoricalDataset(official.games, { generatedAt });
if (dataset.outcomeDigest !== expectedOutcomeDigest) {
  throw new Error(`P1_M6A3B2C1_FROZEN_OUTCOME_DIGEST_MISMATCH:${dataset.outcomeDigest}`);
}

const lineup = await fetchMlbHistoricalPregameLineups({
  startDate,
  endDate,
  cutoffSecondsBeforeScheduledStart: cutoffSeconds,
  concurrency,
});
if (lineup.failures.length > 0) {
  throw new Error(`P1_M6A3B2C1_LINEUP_ACQUISITION_INCOMPLETE:${lineup.failures.length}`);
}
if (lineup.scheduleGames !== expectedGames || lineup.snapshotsFetched !== expectedGames) {
  throw new Error(`P1_M6A3B2C1_LINEUP_GAME_COUNT_MISMATCH:${lineup.scheduleGames}:${lineup.snapshotsFetched}`);
}

const b1GamePks = sortedGamePks(official.games.map((game) => game.gamePk));
const lineupGamePks = sortedGamePks(lineup.snapshots.map((snapshot) => snapshot.gamePk));
const cohortDiff = diffGamePks(b1GamePks, lineupGamePks);
if (cohortDiff.missing.length || cohortDiff.extra.length || b1GamePks.length !== expectedGames || lineupGamePks.length !== expectedGames) {
  throw new Error(`P1_M6A3B2C1_GAMEPK_COHORT_MISMATCH:${cohortDiff.missing.length}:${cohortDiff.extra.length}`);
}

const completeGamePks = sortedGamePks(lineup.snapshots.filter((snapshot) => snapshot.complete).map((snapshot) => snapshot.gamePk));
const coveragePct = Number(((lineup.completeLineupGames / expectedGames) * 100).toFixed(6));
const sourceIntegrity = {
  schemaVersion: "courtedge-p1-m6a3b2c1-2025-source-integrity.v2",
  generatedAt,
  frozenB1: {
    outcomeDigest: expectedOutcomeDigest,
    reproducedOutcomeDigest: dataset.outcomeDigest,
    digestMatches: dataset.outcomeDigest === expectedOutcomeDigest,
    expectedGames,
    reproducedGames: official.officialFinalGames,
  },
  lineupCohort: {
    sourceVersion: lineup.sourceVersion,
    scheduleGames: lineup.scheduleGames,
    scheduleResolutionCounts: lineup.scheduleResolutionCounts,
    snapshotsFetched: lineup.snapshotsFetched,
    gamePkSetMatchesFrozenB1: true,
    missingGamePks: cohortDiff.missing,
    extraGamePks: cohortDiff.extra,
    cutoffSecondsBeforeScheduledStart: cutoffSeconds,
    completeLineupGames: lineup.completeLineupGames,
    completeCoveragePct: coveragePct,
    availabilityCounts: lineup.availabilityCounts,
    lineupHistoryDigest: lineup.lineupHistoryDigest,
    sourceProvenanceDigest: lineup.sourceProvenanceDigest,
    completeGamePksDigest: sha256(JSON.stringify(completeGamePks)),
  },
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
};
const sourceIntegrityArtifact = await writeJson(path.join(outputRoot, "source-integrity.json"), sourceIntegrity);
const lineupArtifact = await writeJson(path.join(outputRoot, "pregame-lineup-history.json"), lineup);

const manifest = {
  schemaVersion: "courtedge-p1-m6a3b2c1-2025-lineup-coverage-manifest.v2",
  generatedAt,
  source: {
    provider: "MLB_STATS_API_OFFICIAL_TIMECODE",
    sourceVersion: lineup.sourceVersion,
    startDate,
    endDate,
    cutoffSecondsBeforeScheduledStart: cutoffSeconds,
  },
  frozenB1OutcomeDigest: expectedOutcomeDigest,
  reproducedB1OutcomeDigest: dataset.outcomeDigest,
  games: expectedGames,
  scheduleResolutionCounts: lineup.scheduleResolutionCounts,
  completeLineupGames: lineup.completeLineupGames,
  completeCoveragePct: coveragePct,
  availabilityCounts: lineup.availabilityCounts,
  lineupHistoryDigest: lineup.lineupHistoryDigest,
  sourceProvenanceDigest: lineup.sourceProvenanceDigest,
  artifacts: [sourceIntegrityArtifact, lineupArtifact],
  researchDecision: "MEASURE_COVERAGE_ONLY",
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
  blockers: [
    "P1_M6A3B2C1_SOURCE_COVERAGE_REVIEW_REQUIRED",
    "P1_M6A3B2C2_LINEUP_INCREMENTAL_MODEL_NOT_BUILT",
    "NO_AUTOMATIC_PROMOTION"
  ]
};
await writeJson(path.join(outputRoot, "manifest.json"), manifest);

console.log("P1_M6A3B2C1_2025_PREGAME_LINEUP_COVERAGE_SUMMARY");
console.log(JSON.stringify({
  b1OutcomeDigestMatches: true,
  gamePkSetMatchesFrozenB1: true,
  games: expectedGames,
  sourceVersion: lineup.sourceVersion,
  scheduleResolutionCounts: lineup.scheduleResolutionCounts,
  cutoffSecondsBeforeScheduledStart: cutoffSeconds,
  completeLineupGames: lineup.completeLineupGames,
  completeCoveragePct: coveragePct,
  availabilityCounts: lineup.availabilityCounts,
  lineupHistoryDigest: lineup.lineupHistoryDigest,
  sourceProvenanceDigest: lineup.sourceProvenanceDigest,
  actionabilityAllowed: false,
  automaticModelSelectionAllowed: false,
  automaticPromotionAllowed: false,
}, null, 2));
